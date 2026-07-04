import { Repo, type DocHandle, type DocumentId } from "@automerge/automerge-repo";
import { registerEndpointAdapter } from "../p2p/endpoint-control";
import { createTestRegistry } from "../../widgets/index";
import { createNarthexRegistry } from "../../widgets/narthex/index";
import type { SocialDoc } from "../../widgets/narthex/social/types";
import type { CanvasDocument, InvitableRole } from "../canvas/canvas-doc";
import { CanvasStore } from "../canvas/canvas-store";
import type { ConnectionStateSource } from "../canvas/connection-status";
import { initCanvas, type SkeinCanvas } from "../canvas/init";
import { ensureMyProfileDoc, type ProfileStore } from "../canvas/profile-doc";
import { showShareDialog, type FriendInfo, type ShareDialogOptions } from "../canvas/share-dialog";
import { registerSocialBridge } from "../dev/test-bridge-registry";
import { buildP2PBridge } from "../dev/test-bridge";
import type { SkeinTestBridgeSocial, ShareTestHooks } from "../dev/test-bridge";
import { sharedBlobAclRegistry } from "../canvas/blob-acl-registry";
import { preloadFonts } from "../fonts/font-loader";
import { handleSkeinStream } from "../p2p/skein-handler";
import type { FriendzProtocol } from "../p2p/friends-protocol";
import {
  destroyBridge,
  initKnockSocialDocBridge,
  recordKnockAck,
  recordKnockRelay,
  sendAclChange,
  sendCanvasInvite,
  sendFriendRequest,
  setOutboundRequestHook,
} from "../p2p/friendz-bridge";

import {
  ensureIdentity,
  getMiddenNode,
  getStoredIdentity,
  onIdentityChange,
} from "../p2p/identity";
import { IrohNetworkAdapter, type MiddenStreamNode } from "../p2p/iroh-network-adapter";
import { AclFilteringNetworkAdapter, createRepoRoleResolver } from "../p2p/acl-filtering-network-adapter";
import type { RoleResolver } from "../p2p/acl-filtering-network-adapter";
import { createCanvasScopedSharePolicy } from "../p2p/canvas-scoped-share-policy";
import { decodeShareString, encodeShareString } from "../p2p/share-string";
import { resolveFriendDisplay, SqliteSocialDoc } from "../p2p/sqlite-social-doc";
import { isTauriMode, TauriStreamNode } from "../p2p/tauri-transport";
import { getMetaValue, setMetaValue } from "../storage/meta-db";
import { createSkeinHarness, type SkeinHarnessNoStore } from "../harness/skein-harness";
import { syncCanvasMetadataToCards, watchCanvasDocsForUpdates } from "./canvas-watchers";
import { initFriendzWiring, docHandleAsSocialDoc, wireKnockHandlers } from "./friendz-wiring";
import {
  createNarthexWithSeed,
  ensureSingletonWidgets,
  MESSAGEZ_WIDGET_ID,
  SOCIAL_WIDGET_ID,
} from "./narthex-seed";
import { socialWidget } from "../../widgets/narthex/social/social-widget";
import { socialSchema } from "../../widgets/narthex/social/schema";
import { messagezWidget, messagezSchema } from "../../widgets/narthex/messagez-widget";
import type { MessagezState } from "../../widgets/narthex/messagez-widget";
import { canvasInfoWidget, canvasInfoSchema } from "../../widgets/canvas-info";
import {
  WidgetOverlay,
  SOCIAL_OVERLAY_W,
  SOCIAL_OVERLAY_H,
  MESSAGES_OVERLAY_W,
  MESSAGES_OVERLAY_H,
  CANVAS_INFO_OVERLAY_W,
  CANVAS_INFO_OVERLAY_H,
} from "../canvas/widget-overlay";
import type { WidgetDoc, WidgetMountContext } from "../widgets/widget-types";
import { log } from "../utils/log";

// indexeddb key for the well-known narthex document id
const NARTHEX_DOC_KEY = "skein-narthex-doc-id";
const MESSAGEZ_DOC_KEY = "skein-messagez-doc-id";
/** meta-db key for the standalone (browser-mode) social doc id — exported so
 *  other modules that need best-effort, read-only access to the local
 *  peer's own friend list (e.g. src/canvas/friend-directory.ts's friend
 *  picker for the "friend canvas bin" narthex widget) can look it up
 *  without duplicating the key string or depending on this whole class. */
export const SOCIAL_DOC_KEY = "skein-social-doc-id"; // browser mode only
const TAG = "skein.boot";

// ---------------------------------------------------------------------------
// router — manages navigation between the narthex and individual canvases
// ---------------------------------------------------------------------------

class SkeinRouter {
  private readonly mountElement: HTMLElement;
  private readonly repo: Repo;
  private readonly harness: SkeinHarnessNoStore;
  private readonly irohAdapter: IrohNetworkAdapter;
  private currentCanvas: SkeinCanvas | null = null;
  private narthexDocId: string | null = null;
  private navigating = false;
  /** stashed by joinCanvasFromNarthex so navigateToCanvas can write it into the doc */
  private pendingPeerNodeId: string | null = null;

  private friendzProtocol: FriendzProtocol | null = null;
  private friendzDocUnsubs: Array<() => void> = [];
  private socialDoc: SocialDoc | null = null;
  private messagezDocHandle: DocHandle<any> | null = null;
  /** the local peer's own profile doc (docs/hub-and-profile-plan.md section 6).
   *  created/opened once in boot() via ensureMyProfileDoc(); threaded into the
   *  social overlay's mount context so profile-tab.ts can manage the profile's
   *  curated canvas list. */
  private profileStore: ProfileStore | null = null;

  private transportPresenceUnsubs: Array<() => void> = [];
  private canvasWatcherUnsubs: Array<() => void> = [];
  private localNodeId: string = "";
  private flushCanvasUpdates: (() => void) | null = null;
  private currentSocialOverlay: WidgetOverlay | null = null;
  private currentMessagesOverlay: WidgetOverlay | null = null;
  private currentCanvasInfoOverlay: WidgetOverlay | null = null;
  private badgeUnsubs: Array<() => void> = [];

  /** adapter connection state source for the ConnectionStatus widget */
  private readonly connectionStateSource: ConnectionStateSource;

  constructor(mountElement: HTMLElement, harness: SkeinHarnessNoStore) {
    this.mountElement = mountElement;
    this.harness = harness;
    this.repo = harness.repo;
    // "both" mode always builds an iroh adapter (see `create()` below), so
    // this is never actually null in practice.
    this.irohAdapter = harness.iroh!;

    // register adapter for module-level endpoint toggle (settings tab)
    registerEndpointAdapter(this.irohAdapter);

    // dev/test-only: expose the real production IrohNetworkAdapter's p2p
    // bridge (importBlob/fetchBlob/restrictBlobToPeers/etc — see
    // dev/test-bridge.ts's buildP2PBridge) on window.__skeinTest.p2p. this
    // is the same bridge test-harness-p2p.html already exposes, wired here
    // so e2e tests can drive real blob import/fetch against the actual
    // production app + router (needed for cross-canvas blob-ACL coverage,
    // where the test must navigate between two real canvases via the real
    // SkeinRouter, not the lighter-weight p2p test harness).
    if (import.meta.env.DEV) {
      const bridge: Record<string, unknown> = ((window as any).__skeinTest ??= {});
      bridge.p2p = buildP2PBridge(this.irohAdapter);
    }

    // scope automerge-repo's own sync eligibility — see
    // canvas-scoped-share-policy.ts's module doc comment for the full
    // rules. `isFriend` reads `this.socialDoc` live (a closure over the
    // instance, not a snapshot) since it isn't populated until partway
    // through `boot()`, well after this constructor runs — this mirrors
    // the same "resolve lazily" shape `create()`'s `roleResolver`/`repoBox`
    // already uses for the same reason.
    const isFriend = (nodeId: string): boolean => {
      const friends = this.socialDoc?.current.friends ?? [];
      return friends.some((f) => f.nodeIds?.some((n) => n.nodeId === nodeId));
    };
    const sharePolicy = createCanvasScopedSharePolicy(this.repo, isFriend);
    this.repo.shareConfig = { announce: sharePolicy, access: sharePolicy };

    // wrap the adapter's connection state API for the ConnectionStatus widget
    this.connectionStateSource = {
      getConnectionSummary: () => this.irohAdapter.getConnectionSummary(),
      onStateChange: (handler: () => void) => this.irohAdapter.onConnectionStateChange(handler),
      retryFailed: () => this.irohAdapter.retryFailedPeers(),
    };
  }

  /**
   * build the repo (storage + network), the iroh adapter, and the
   * ACL-filtering wrapper around it, then construct the router.
   *
   * shared automerge repo — one repo for all canvases and the narthex.
   * cross-tab sync via BroadcastChannel, cross-device sync via iroh QUIC.
   * built via `createSkeinHarness()` (see `harness/skein-harness.ts`) rather
   * than hand-rolled here — `skipStore: true` because the router opens/
   * creates canvas docs lazily per-navigation, not one up front, and
   * `skipEnsureIdentity: true` because `IrohNetworkAdapter` already checks
   * for a stored identity lazily and this app should only ever generate one
   * when the user actively shares/joins a canvas.
   */
  static async create(mountElement: HTMLElement): Promise<SkeinRouter> {
    // ACL enforcement: wrap the iroh adapter so viewer-role peers' pushed
    // changes get stripped before automerge-repo ever sees them. the
    // roleResolver needs a `Repo` to read cached ACL data from, but the
    // `Repo` doesn't exist until after the adapter is constructed —
    // `repoBox` breaks that cycle: the resolver closure reads
    // `repoBox.repo` lazily, and it gets filled in right after the harness
    // hands back its `Repo`, before any sync traffic can possibly flow.
    // same pattern as src/dev/acl-test-bootstrap.ts.
    const repoBox: { repo?: Repo } = {};
    const roleResolver: RoleResolver = (documentId, senderId) => {
      if (!repoBox.repo) return "member";
      return createRepoRoleResolver(repoBox.repo)(documentId, senderId);
    };

    // in tauri mode, P2P goes through the rust backend's iroh endpoint.
    // in standalone browser mode, P2P goes through midden WASM.
    const harness = await createSkeinHarness({
      network: "both",
      skipStore: true,
      skipEnsureIdentity: true,
      getMiddenNode: isTauriMode()
        ? async () => (await TauriStreamNode.create()) as MiddenStreamNode
        : async () => (await getMiddenNode()) as unknown as MiddenStreamNode,
      // note: only one Repo is constructed for the whole app — narthex and
      // every canvas document share it. the ACL role model is per-canvas
      // (CanvasDocument.acl), so filtering here also covers narthex/social/
      // messagez docs, but those doc shapes have no `.acl` field at all —
      // createRepoRoleResolver()'s lookup falls through to the "member"
      // default (read/write, same as today's unfiltered behavior) for them,
      // so this is a no-op for non-canvas docs.
      wrapNetworkAdapter: (iroh) => new AclFilteringNetworkAdapter(iroh, roleResolver),
    });
    repoBox.repo = harness.repo;

    return new SkeinRouter(mountElement, harness);
  }

  /** initial boot — resolve narthex doc id then navigate to the right place */
  async boot(): Promise<void> {
    // resolve or create the narthex document id
    this.narthexDocId = await getMetaValue(NARTHEX_DOC_KEY);

    if (!this.narthexDocId) {
      // first boot — create and seed the narthex canvas document
      const narthexStore = createNarthexWithSeed(this.repo);
      this.narthexDocId = narthexStore.handle.documentId;
      await setMetaValue(NARTHEX_DOC_KEY, this.narthexDocId);
      log.debug(TAG, "first boot — created narthex doc:", this.narthexDocId);
    } else {
      log.debug(TAG, "found existing narthex doc:", this.narthexDocId);
      await ensureSingletonWidgets(this.repo, this.narthexDocId as DocumentId);
    }

    // resolve local node ID early so hasIdentity is available at canvas init time.
    // uses getStoredIdentity() in BOTH modes — a cheap, side-effect-free
    // check that never generates a keypair or binds the iroh endpoint, so
    // simply booting the app never creates a P2P identity on its own.
    if (!this.localNodeId) {
      try {
        const identity = await getStoredIdentity();
        this.localNodeId = identity?.node_id ?? "";
      } catch {
        // identity not ready yet
      }
    }

    // create SqliteSocialDoc early (tauri mode) so it's available for overlays
    // on any canvas — not just the narthex
    if (isTauriMode() && !this.socialDoc) {
      try {
        this.socialDoc = await SqliteSocialDoc.create();
      } catch (err) {
        log.warn(TAG, "failed to create SqliteSocialDoc:", err);
      }
    }

    // create or find standalone social doc (browser mode only)
    if (!isTauriMode() && !this.socialDoc) {
      const socialDocId = await getMetaValue(SOCIAL_DOC_KEY);
      if (socialDocId) {
        try {
          const handle = await this.repo.find<any>(socialDocId as DocumentId);
          this.socialDoc = docHandleAsSocialDoc(handle);
        } catch {
          // not available yet — will retry
        }
      }
      if (!this.socialDoc) {
        const handle = this.repo.create<any>({
          profile: { username: "", bio: "", avatarDataUrl: "", accentColor: 0xd946ef, nodeId: "" },
          friends: [],
          groups: [],
          pendingRequests: [],
          outboundRequests: [],
          profileVisibility: "friends",
          friendRequestsFrom: "everyone",
        });
        await setMetaValue(SOCIAL_DOC_KEY, handle.documentId);
        this.socialDoc = docHandleAsSocialDoc(handle);
      }
    }

    // create or find standalone messagez doc
    if (!this.messagezDocHandle) {
      const messagezDocId = await getMetaValue(MESSAGEZ_DOC_KEY);
      if (messagezDocId) {
        try {
          this.messagezDocHandle = await this.repo.find<any>(messagezDocId as DocumentId);
        } catch {
          // not synced yet
        }
      }
      if (!this.messagezDocHandle) {
        this.messagezDocHandle = this.repo.create<any>({
          invites: [],
          shares: [],
          deletions: [],
          canvasInvitesFrom: "everyone",
        });
        await setMetaValue(MESSAGEZ_DOC_KEY, this.messagezDocHandle.documentId);
      }
    }

    // create or find "my own" profile doc (docs/hub-and-profile-plan.md section 6).
    // ensureMyProfileDoc() already handles the create-or-open + meta-key
    // persistence internally (same singleton-doc-id pattern as narthex/social/
    // messagez above), so this is just a thin call + a place to stash the result.
    if (!this.profileStore) {
      try {
        this.profileStore = await ensureMyProfileDoc(this.repo);
      } catch (err) {
        log.warn(TAG, "failed to ensure profile doc:", err);
      }
    }

    // initialize friendz protocol early — works regardless of which canvas is shown.
    // safe to call before navigateToNarthex because initFriendzProtocol now opens
    // the narthex store itself when this.currentCanvas is null.
    this.initFriendzProtocol().catch((err) => {
      log.warn(TAG, "failed to initialize friendz protocol:", err);
    });

    // retry protocol init when the user generates an identity for the first time.
    // this must be global (not per-canvas) so it fires even when the user creates
    // an identity while viewing a non-narthex canvas.
    const unsubIdentity = onIdentityChange((identity) => {
      if (!identity) return;

      // update localNodeId so subsequent canvas inits get the right value
      if (!this.localNodeId) {
        this.localNodeId = identity.node_id;
        // propagate to the current canvas if it's already up
        if (this.currentCanvas) {
          this.currentCanvas.store.setLocalNodeId(identity.node_id);
          this.currentCanvas.presenceManager.setLocalNodeId(identity.node_id);
          this.currentCanvas.toolbar.refreshRoleGating();
        }
        // write nodeId into the standalone social doc so the social widget
        // reflects the correct identity even before the user opens it
        if (!isTauriMode() && this.socialDoc) {
          try {
            const handle = (this.socialDoc as any)._handle;
            if (handle) {
              handle.change((doc: any) => {
                if (doc.profile && !doc.profile.nodeId) {
                  doc.profile.nodeId = identity.node_id;
                }
              });
            }
          } catch {
            // social doc not ready yet — nodeId will be set by the social widget on mount
          }
        }
      }

      if (!this.friendzProtocol) {
        log.debug(TAG, "identity created — retrying protocol init");
        this.initFriendzProtocol().catch((err) => {
          log.warn(TAG, "deferred protocol init failed:", err);
        });
      }
    });
    this.friendzDocUnsubs.push(unsubIdentity);

    // register skein/1 ALPN handler early so the browser can serve blobs
    // to peers regardless of friendz protocol initialization state.
    // (friendz-wiring.ts also registers this, but that happens later and
    // only when navigating to the narthex with a valid identity.)
    if (!isTauriMode()) {
      this.irohAdapter.registerAlpnHandler("skein/1", handleSkeinStream);
    }

    // listen for hash changes (browser back/forward, programmatic navigation)
    window.addEventListener("hashchange", () => {
      this.onHashChange().catch((err) => {
        log.error(TAG, "onHashChange failed:", err);
      });
    });

    // listen for the custom create-canvas event dispatched from the canvas wizard
    window.addEventListener("skein:create-canvas", ((e: CustomEvent) => {
      this.createCanvasFromNarthex(e.detail);
    }) as EventListener);

    // listen for the join-canvas event dispatched from the join-canvas wizard
    window.addEventListener("skein:join-canvas", ((e: CustomEvent) => {
      this.joinCanvasFromNarthex(e.detail).catch((err) => {
        log.error(TAG, "join failed:", err);
      });
    }) as EventListener);

    // listen for accept-canvas-invite event dispatched from the inbox widget
    window.addEventListener("skein:accept-canvas-invite", ((e: CustomEvent) => {
      this.acceptCanvasInvite(e.detail).catch((err) => {
        log.warn(TAG, "failed to accept canvas invite:", err);
      });
    }) as EventListener);

    // listen for widget self-removal (e.g. wizard cancel button)
    window.addEventListener("skein:remove-widget", ((e: CustomEvent) => {
      const widgetId = e.detail?.widgetId;
      if (widgetId && this.currentCanvas) {
        log.debug(TAG, "removing widget:", widgetId);
        this.currentCanvas.store.removeWidget(widgetId);
      }
    }) as EventListener);

    // announce offline to peers on page close
    window.addEventListener("beforeunload", () => {
      if (this.friendzProtocol) {
        this.friendzProtocol.announceOffline();
        this.friendzProtocol.stopHeartbeat();
      }
      // stamp lastSeenAt on the current canvas so peers know when we last saw it
      if (this.currentCanvas) {
        this.currentCanvas.store.stampLastSeen();
      }
      // canvas update flush is best-effort — peer may not receive before close
      this.flushCanvasUpdates?.();
    });

    // initial navigation based on current hash
    log.debug(TAG, "router booted, initial hash:", JSON.stringify(window.location.hash));
    await this.onHashChange();
  }

  /** determine the target from the hash and navigate */
  private async onHashChange(): Promise<void> {
    const hash = window.location.hash.slice(1);

    if (!hash || hash === this.narthexDocId) {
      // empty hash or explicit narthex hash → go to narthex
      await this.navigateToNarthex();
    } else if (hash.startsWith("share/")) {
      // share URL — decode and join
      const decoded = decodeShareString(hash);
      if (decoded) {
        log.debug(
          TAG,
          "share URL detected, joining canvas from:",
          decoded.nodeId.slice(0, 16) + "..."
        );
        // navigate to narthex first, then trigger join
        await this.navigateToNarthex();
        await this.joinCanvasFromNarthex({ shareString: hash });
      } else {
        log.warn(TAG, "invalid share URL:", hash.slice(0, 32) + "...");
        await this.navigateToNarthex();
      }
    } else {
      // non-empty hash → open that canvas
      await this.navigateToCanvas(hash);
    }
  }

  /**
   * stamp lastVisitedAt on the canvas card we're leaving so that own edits
   * don't trigger a false "updated" pill when we return to the narthex.
   * best-effort — failures are silently ignored.
   */
  private async stampLastVisitedOnCurrentCanvas(): Promise<void> {
    if (!this.currentCanvas || !this.narthexDocId) return;
    // figure out which canvas doc we're currently viewing
    const currentHash = window.location.hash.slice(1);
    if (!currentHash || currentHash === this.narthexDocId) return;

    try {
      const narthexHandle = await this.repo.find<CanvasDocument>(this.narthexDocId as DocumentId);
      await narthexHandle.whenReady();
      const narthexDoc = narthexHandle.doc();
      if (!narthexDoc?.widgets) return;

      for (const entry of Object.values(narthexDoc.widgets)) {
        if (
          entry.type === "canvas-card" &&
          (entry.props as any)?.canvasDocId === currentHash &&
          entry.docId
        ) {
          const cardHandle = await this.repo.find<any>(entry.docId as DocumentId);
          await cardHandle.whenReady();
          cardHandle.change((draft: any) => {
            draft.lastVisitedAt = new Date().toISOString();
            draft.hasUpdates = false;
          });
          break;
        }
      }
      // also stamp lastSeenAt on the canvas doc itself for gossip digest computation
      if (this.currentCanvas) {
        this.currentCanvas.store.stampLastSeen();
      }
    } catch {
      // best-effort — don't block navigation
    }
  }

  /** tear down the current canvas if any */
  private destroyCurrent(): void {
    // tear down per-canvas badge subscriptions and overlay panels
    for (const unsub of this.badgeUnsubs) unsub();
    this.badgeUnsubs = [];
    this.currentSocialOverlay?.destroy();
    this.currentSocialOverlay = null;
    this.currentMessagesOverlay?.destroy();
    this.currentMessagesOverlay = null;
    this.currentCanvasInfoOverlay?.destroy();
    this.currentCanvasInfoOverlay = null;
    for (const unsub of this.transportPresenceUnsubs) unsub();
    this.transportPresenceUnsubs = [];
    for (const unsub of this.canvasWatcherUnsubs) unsub();
    this.canvasWatcherUnsubs = [];
    if (this.currentCanvas) {
      this.currentCanvas.destroy();
      this.currentCanvas = null;
    }
  }

  /** navigate to the narthex */
  private async navigateToNarthex(): Promise<void> {
    if (this.navigating) return;
    this.navigating = true;

    try {
      // stamp lastVisitedAt before tearing down so own edits aren't flagged
      await this.stampLastVisitedOnCurrentCanvas();

      // flush pending canvas update notifications to peers before leaving
      this.flushCanvasUpdates?.();

      this.destroyCurrent();

      // clear hash for the narthex (clean URL)
      if (window.location.hash) {
        history.replaceState(null, "", window.location.pathname);
      }

      log.debug(TAG, "navigating to narthex, doc:", this.narthexDocId);

      const canvas = await initCanvas({
        mountElement: this.mountElement,
        canvasDocId: this.narthexDocId,
        registry: createNarthexRegistry(),
        repo: this.repo,
        isNarthex: true,
        hasIdentity: !!this.localNodeId,
        avatarUrl: this.socialDoc?.current.profile?.avatarDataUrl || null,
        endpointStateSource: {
          getState: () => this.irohAdapter.getEndpointState(),
          onStateChange: (h) => this.irohAdapter.onEndpointStateChange(h),
        },
        onToggleSocial: () => {
          const sw = window.visualViewport?.width ?? window.innerWidth;
          this.currentMessagesOverlay?.close();
          this.currentSocialOverlay?.toggle(sw);
        },
        onToggleMessages: () => {
          const sw = window.visualViewport?.width ?? window.innerWidth;
          this.currentSocialOverlay?.close();
          this.currentMessagesOverlay?.toggle(sw);
        },
      });

      this.currentCanvas = canvas;
      // in dev builds, initialise __skeinTest.social BEFORE mounting the social
      // overlay — profile-tab.ts registers pickAvatar onto this object during
      // create(), so the object must exist before mountSocialOverlay() runs.
      // goes through registerSocialBridge() (test-bridge-registry.ts) rather
      // than touching window.__skeinTest directly — see that file for why.
      if (import.meta.env.DEV) {
        // build with arrow functions (not object-literal shorthand methods) so
        // `this` stays lexically bound to the router instance — avoids the
        // `const self = this` alias eslint flags (@typescript-eslint/no-this-alias).
        const social: Record<string, unknown> = {
          ensureIdentity,
          toggleOverlay: () => {
            const sw = window.visualViewport?.width ?? window.innerWidth;
            this.currentSocialOverlay?.toggle(sw);
          },
          // dev/test-only: send a real friend request to a node id through
          // the production app's actual FriendzProtocol instance, exactly
          // as `friends-tab.ts`'s "add friend" flow does — no equivalent
          // existed before (only test-harness-p2p.html's separate,
          // in-memory-only FriendzProtocol bridge did), which made it
          // impossible to drive a real "befriend a hub, then invite it to
          // a canvas" flow against the actual production social doc.
          sendFriendRequestTo: (nodeId: string) => sendFriendRequest(nodeId),
          getMessagezInvites: () =>
            ((this.messagezDocHandle?.doc() as any)?.invites ?? []) as Array<Record<string, unknown>>,
          // pickAvatar is registered by profile-tab.ts during socialWidget.create()
        };
        Object.defineProperty(social, "doc", {
          enumerable: true,
          // configurable: true — navigateToNarthex() re-registers this bridge
          // every time the narthex is re-entered (navigate-back, reload), and
          // registerSocialBridge() merges into the *same* existing social
          // object rather than replacing it. without `configurable: true`,
          // the second registration throws "Cannot redefine property: doc".
          configurable: true,
          get: () => this.socialDoc,
        });
        registerSocialBridge(social as unknown as Partial<SkeinTestBridgeSocial>);
      }
      // mount overlay panels and wire badge counts
      this.currentSocialOverlay = this.mountSocialOverlay(canvas);
      this.currentMessagesOverlay = this.mountMessagesOverlay(canvas);
      this.wireBadges(canvas);
      canvas.store.setLocalNodeId(this.localNodeId);
      if (this.localNodeId) {
        canvas.presenceManager.setLocalNodeId(this.localNodeId);
      }
      canvas.toolbar.refreshRoleGating();
      (window as any).__skein = canvas;

      // when a canvas-card is deleted from the narthex, clean up the linked
      // canvas document and all its per-widget docs from IndexedDB.
      canvas.widgetManager.setBeforeRemoveHook(async (entry, repo) => {
        if (entry.type !== "canvas-card" || !entry.docId) return;
        try {
          const cardHandle = await repo.find(entry.docId as DocumentId);
          await cardHandle.whenReady();
          const cardDoc = cardHandle.doc() as Record<string, unknown> | undefined;
          const canvasDocId = cardDoc?.canvasDocId;
          if (!canvasDocId || typeof canvasDocId !== "string") return;

          // open the linked canvas and delete all its widget docs
          const canvasHandle = await repo.find<CanvasDocument>(canvasDocId as DocumentId);
          await canvasHandle.whenReady();
          const canvasDoc = canvasHandle.doc();
          if (canvasDoc?.widgets) {
            for (const w of Object.values(canvasDoc.widgets)) {
              if (w.docId) {
                try {
                  repo.delete(w.docId as DocumentId);
                } catch {
                  // best-effort
                }
              }
            }
          }

          // delete the canvas document itself
          repo.delete(canvasDocId as DocumentId);

          // a purged canvas is no longer an active sharing context — stop
          // vouching for its peers in the cross-canvas blob-ACL union (see
          // blob-acl-registry.ts). this canvas may not even be the one
          // currently open/mounted, so CanvasBlobAclSync itself has no
          // chance to observe this deletion live — clear it directly here.
          sharedBlobAclRegistry.clearCanvas(canvasDocId);

          log.debug(
            TAG,
            "cleaned up canvas and widget docs for:",
            canvasDocId.slice(0, 16) + "..."
          );
        } catch (err) {
          log.warn(TAG, "failed to clean up linked canvas docs:", err);
        }
      });

      // narthex share helper isn't applicable but clear any stale one
      (window as any).__skein.share = () => {
        log.debug(TAG, "share is only available when viewing a canvas (not the narthex)");
      };

      log.debug(
        TAG,
        "narthex ready — widgets:",
        canvas.store.widgetCount(),
        "| registry:",
        canvas.registry.types().join(", ")
      );

      // sync fresh metadata first, then start real-time watchers.
      // sequential order prevents the watcher from re-setting hasUpdates
      // that sync just cleared (bug: race condition when concurrent).
      // runs asynchronously after the narthex is mounted so it doesn't block render.
      (async () => {
        try {
          await syncCanvasMetadataToCards(this.repo, canvas.store, this.localNodeId);
        } catch (err) {
          log.warn(TAG, "metadata sync failed:", err);
        }
        try {
          const unsubs = await watchCanvasDocsForUpdates(this.repo, canvas.store, this.localNodeId);
          this.canvasWatcherUnsubs.push(...unsubs);
        } catch (err) {
          log.warn(TAG, "canvas watcher setup failed:", err);
        }
      })();
    } finally {
      this.navigating = false;
    }
  }

  /**
   * initialize the friends protocol after the narthex is loaded.
   * reads the friends and profile widget docs to wire up callbacks.
   * safe to call multiple times — no-ops if already initialized.
   */
  private async initFriendzProtocol(): Promise<void> {
    if (this.friendzProtocol) return;
    if (!this.narthexDocId) return;

    // use the current canvas store if on the narthex, otherwise open narthex store directly.
    // this allows initFriendzProtocol to be called from boot() before any canvas is mounted.
    let store = this.currentCanvas?.store;
    if (!store) {
      try {
        store = await CanvasStore.open(this.repo, this.narthexDocId as DocumentId);
      } catch (err) {
        log.warn(TAG, "failed to open narthex store for friendz protocol:", err);
        return;
      }
    }

    const socialDoc = this.socialDoc ?? undefined;

    const result = await initFriendzWiring({
      repo: this.repo,
      irohAdapter: this.irohAdapter,
      store,
      narthexDocId: this.narthexDocId,
      socialWidgetId: SOCIAL_WIDGET_ID,
      messagezWidgetId: MESSAGEZ_WIDGET_ID,
      messagezDocHandle: this.messagezDocHandle ?? undefined,
      socialDoc,
      profileStore: this.profileStore ?? undefined,
    });

    if (!result) return;

    this.friendzProtocol = result.protocol;
    if (result.socialDoc) this.socialDoc = result.socialDoc;
    if (result.messagezDocHandle) this.messagezDocHandle = result.messagezDocHandle;
    this.friendzDocUnsubs.push(...result.unsubs);
    this.flushCanvasUpdates = result.flushCanvasUpdates;

    // let widgets (the messagez knock row) call approveKnock()/declineKnock()
    // (friendz-wiring.ts) directly via the friendz bridge — see
    // friendz-bridge.ts's "knock (access-request) actions" section.
    initKnockSocialDocBridge(this.socialDoc);

    // re-register the knock message handlers with the live-attribution
    // callbacks wired in. `wireKnockHandlers()` is exported specifically to
    // be called directly like this (see its doc comment in
    // friendz-wiring.ts) — this re-assigns the same four
    // `protocol.onCanvasKnock*` handlers `initFriendzWiring()` already set
    // up above, with identical core behavior, just also firing
    // `onKnockRelayed`/`onKnockAcked` so the messagez widget's "via hub"
    // attribution (section 7.3) and requester status view (section 7.1)
    // have live data to read — see `recordKnockRelay()`/`recordKnockAck()`'s
    // doc comments for why this is session-only, not persisted.
    wireKnockHandlers({
      protocol: result.protocol,
      repo: this.repo,
      irohAdapter: this.irohAdapter,
      localNodeId: this.localNodeId,
      onKnockRelayed: (info) => recordKnockRelay(info),
      onKnockAcked: (info) => recordKnockAck(info),
    });
  }

  /** navigate to a specific canvas by document id */
  private async navigateToCanvas(docId: string): Promise<void> {
    if (this.navigating) return;
    this.navigating = true;

    // a genuine failure to open the requested canvas (e.g. it's truly
    // unreachable/never arrives — see CanvasStore.open()'s doc comment for
    // the recoverable cases this no longer treats as terminal) must not
    // propagate as an uncaught rejection: `destroyCurrent()` below already
    // tore down whatever was previously mounted by the time `initCanvas()`
    // could throw, so an uncaught failure here left the app with *nothing*
    // mounted at all — a real, user-reported crash ("everything turns
    // black"), 2026-07-03. caught below and recovered by falling back to
    // the narthex, same as clicking the home button would.
    let failure: unknown = null;

    try {
      // stamp lastVisitedAt before tearing down so own edits aren't flagged
      await this.stampLastVisitedOnCurrentCanvas();

      // flush pending canvas update notifications to peers before leaving
      this.flushCanvasUpdates?.();

      this.destroyCurrent();

      // ensure the hash is set (for reload persistence)
      if (window.location.hash.slice(1) !== docId) {
        history.replaceState(null, "", `#${docId}`);
      }

      log.debug(TAG, "navigating to canvas:", docId);

      const canvas = await initCanvas({
        mountElement: this.mountElement,
        canvasDocId: docId,
        registry: createTestRegistry(),
        repo: this.repo,
        connectionStateSource: this.connectionStateSource,
        restrictBlobToPeers: (blake3Hash, peerNodeIds) =>
          this.irohAdapter.restrictBlobToPeers(blake3Hash, peerNodeIds),
        onNavigateHome: () => {
          log.debug(TAG, "home button clicked, navigating to narthex");
          window.location.hash = "";
        },
        onShare: async () => {
          if (!this.currentCanvas) return;
          // the toolbar itself no longer hides the share button for
          // non-admins (see Toolbar.applyRoleGating()) — everyone can open
          // it, but a non-admin only gets a read-only view (who it's
          // shared with + pending invites, no action controls) built
          // below via `readOnly`/omitted mutating callbacks.
          const isAdmin = this.currentCanvas.store.isLocalAdmin();
          const identity = await getStoredIdentity();
          if (!identity) {
            log.debug(TAG, "no identity — generate one first (profile widget)");
            return;
          }
          const shareStr = encodeShareString(identity.node_id, docId);
          const shareUrl = window.location.origin + window.location.pathname + "#share/" + shareStr;

          // recomputes the full options object fresh from current doc state
          // each time it's called — see the onChange subscriptions below
          // `showShareDialog()`'s call site, which call this again (and
          // rebuild the dialog) whenever the canvas doc or messagez outbox
          // changes, instead of leaving the dialog showing a stale snapshot
          // until the user manually closes and reopens it (a real reported
          // bug: pending-invite/role/accepted-state changes never showed up
          // in an already-open share dialog).
          const buildShareOptions = (): ShareDialogOptions => {
          // build peer list from canvas doc (exclude self)
          const peersRecord = this.currentCanvas!.store.peers();
          const peerList = Object.values(peersRecord)
            .filter((p) => {
              // guard: automerge may return non-string nodeId from Rust-written entries
              if (typeof p.nodeId !== "string") {
                log.warn(
                  TAG,
                  "share dialog: peer entry has non-string nodeId:",
                  typeof p.nodeId,
                  JSON.stringify(p)
                );
                return false;
              }
              return p.nodeId !== identity.node_id;
            })
            .map((p) => ({
              nodeId: String(p.nodeId),
              joinedAt: String(p.joinedAt ?? ""),
              role: this.currentCanvas!.store.getRole(String(p.nodeId)),
            }));

          // build friends list for invite picker — exclude already shared
          const peerNodeIds = new Set(peerList.map((p) => p.nodeId));
          const friendsForInvite: FriendInfo[] = [];

          if (this.socialDoc) {
            const friendsState = this.socialDoc.current;

            // get already-invited node IDs from messagez outbox.
            // excludes declined shares — a friend who declined should be
            // re-invitable, not permanently stuck off the invite list (a
            // real bug: previously this checked canvasDocId only, so a
            // declined invite blocked re-inviting that friend forever, even
            // though the "declined" section below shows them as declined).
            // also excludes cancelled shares (see onCancelInvite below) — a
            // pending invite that the sharer themselves cancels must free
            // the friend back up for re-inviting, same as a decline.
            const alreadyInvited = new Set<string>();
            if (this.messagezDocHandle) {
              const inboxDoc = this.messagezDocHandle.doc() as
                | {
                    shares?: Array<{
                      canvasDocId: string;
                      toNodeId: string;
                      declined?: boolean;
                      cancelled?: boolean;
                    }>;
                  }
                | undefined;
              if (inboxDoc?.shares) {
                for (const share of inboxDoc.shares) {
                  if (share.canvasDocId === docId && !share.declined && !share.cancelled) {
                    alreadyInvited.add(share.toNodeId);
                  }
                }
              }
            }

            if (friendsState?.friends) {
              for (const friend of friendsState.friends) {
                if (!friend.nodeIds) continue;
                for (const n of friend.nodeIds) {
                  if (!n.nodeId) continue;
                  if (peerNodeIds.has(n.nodeId)) continue;
                  if (alreadyInvited.has(n.nodeId)) continue;

                  friendsForInvite.push({
                    friendId: friend.id,
                    username: friend.alias || n.username || friend.username || "",
                    nodeId: n.nodeId,
                    avatarDataUrl: n.avatarDataUrl,
                    isOnline: this.friendzProtocol?.isOnline(n.nodeId) ?? false,
                    isHub: friend.isHub === true,
                  });
                }
              }
            }

            // also include in-progress friend requests (not yet confirmed
            // friends) so someone never just vanishes from the share dialog
            // while a handshake is still pending — see
            // docs/hub-and-profile-plan.md section 10.1. same exclusion
            // filters as above; isHub is unknown until an accept message
            // carrying the flag arrives, so default to false rather than
            // guessing.
            if (friendsState?.pendingRequests) {
              for (const req of friendsState.pendingRequests) {
                if (req.status !== "pending") continue;
                if (!req.fromNodeId) continue;
                if (peerNodeIds.has(req.fromNodeId)) continue;
                if (alreadyInvited.has(req.fromNodeId)) continue;

                friendsForInvite.push({
                  friendId: req.fromNodeId,
                  username: req.fromUsername || "",
                  nodeId: req.fromNodeId,
                  isOnline: this.friendzProtocol?.isOnline(req.fromNodeId) ?? false,
                  isHub: false,
                  isPending: true,
                });
              }
            }
            if (friendsState?.outboundRequests) {
              for (const req of friendsState.outboundRequests) {
                if (req.status !== "pending") continue;
                if (!req.toNodeId) continue;
                if (peerNodeIds.has(req.toNodeId)) continue;
                if (alreadyInvited.has(req.toNodeId)) continue;

                friendsForInvite.push({
                  friendId: req.toNodeId,
                  username: req.toUsername || "",
                  nodeId: req.toNodeId,
                  isOnline: this.friendzProtocol?.isOnline(req.toNodeId) ?? false,
                  isHub: false,
                  isPending: true,
                });
              }
            }
          }

          // build a nodeId -> display name map from friends for the peer list
          const peerDisplayNames = new Map<string, string>();
          // node ids the local peer already considers a friend (any nodeId
          // across any confirmed friend entry) — passed to the dialog so
          // the "friend" button on a peer row is suppressed for someone
          // who's already a friend instead of showing unconditionally
          // whenever onAddFriend is present (a real reported bug).
          const knownFriendNodeIds = new Set<string>();
          if (this.socialDoc) {
            const state = this.socialDoc.current;
            if (state?.friends) {
              for (const friend of state.friends) {
                const name = friend.alias || friend.username || "";
                for (const n of friend.nodeIds) {
                  if (!n.nodeId) continue;
                  if (name) peerDisplayNames.set(n.nodeId, name);
                  knownFriendNodeIds.add(n.nodeId);
                }
              }
            }
          }
          // build pending invites from canvas doc
          const pendingInvitesMap = this.currentCanvas?.store.pendingInvites() ?? {};
          const pendingInvitesList = Object.entries(pendingInvitesMap).map(
            ([targetNodeId, invite]) => ({
              targetNodeId,
              invite,
            })
          );

          // build declined invites from messagez outbox shares
          const declinedInvites: Array<{
            toNodeId: string;
            toUsername: string;
            canvasTitle: string;
            sentAt: string;
          }> = [];
          if (this.messagezDocHandle) {
            const mDoc = this.messagezDocHandle.doc() as any;
            if (mDoc?.shares) {
              for (const share of mDoc.shares) {
                if (share.declined && share.canvasDocId === docId) {
                  declinedInvites.push({
                    toNodeId: share.toNodeId,
                    toUsername: share.toUsername ?? "",
                    canvasTitle: share.canvasTitle ?? "",
                    sentAt: share.sentAt ?? "",
                  });
                }
              }
            }
          }

          // named (not inlined into the showShareDialog() call below) so
          // DEV-only test hooks can capture the exact friends/onInviteFriend/
          // onCancelInvite the real dialog uses \u2014 see ShareTestHooks in
          // src/dev/test-bridge.ts.
          const shareOptions: ShareDialogOptions = {
            app: this.currentCanvas!.app,
            theme: this.currentCanvas!.theme,
            shareUrl,
            peers: peerList,
            peerDisplayNames,
            readOnly: !isAdmin,
            knownFriendNodeIds,
            onRemovePeer: !isAdmin
              ? undefined
              : (nodeId: string) => {
              // remove from canvas doc
              this.currentCanvas?.store.removePeer(nodeId);
              // tell the adapter to stop reconnecting to this peer
              this.irohAdapter.forgetPeer(nodeId);
              // best-effort live notification so the removed peer's own
              // narthex card reflects the revocation immediately, instead
              // of only finding out the next time they happen to sync this
              // canvas doc directly (see onAclChange in friendz-wiring.ts).
              // sendAclChange/onAclChange already existed, fully built and
              // tested, but were never wired into production before this
              // fix — a real gap, not a new mechanism.
              void getStoredIdentity().then((localIdentity) => {
                if (!localIdentity || !this.currentCanvas) return;
                sendAclChange(nodeId, {
                  canvasDocId: docId,
                  canvasTitle: this.currentCanvas.store.metadata().title,
                  targetNodeId: nodeId,
                  newRole: "removed",
                  changedBy: localIdentity.node_id,
                  changedByUsername: this.friendzProtocol?.getLocalUsername() ?? "",
                }).catch((err) => {
                  log.warn(TAG, "failed to send ACL removal notification:", err);
                });
              });
              log.debug(TAG, "revoked access for peer:", nodeId.slice(0, 16) + "...");
            },
            onChangeRole: !isAdmin
              ? undefined
              : (nodeId: string, role: InvitableRole) => {
              this.currentCanvas?.store.setRole(nodeId, role);
              // best-effort live notification (see onRemovePeer above for
              // why this matters — otherwise a peer's own narthex card
              // keeps showing their old role until they happen to
              // reconnect to this specific canvas doc directly).
              void getStoredIdentity().then((localIdentity) => {
                if (!localIdentity || !this.currentCanvas) return;
                sendAclChange(nodeId, {
                  canvasDocId: docId,
                  canvasTitle: this.currentCanvas.store.metadata().title,
                  targetNodeId: nodeId,
                  newRole: role,
                  changedBy: localIdentity.node_id,
                  changedByUsername: this.friendzProtocol?.getLocalUsername() ?? "",
                }).catch((err) => {
                  log.warn(TAG, "failed to send ACL change notification:", err);
                });
              });
              log.debug(TAG, "changed role for peer:", nodeId.slice(0, 16) + "...", "->", role);
            },
            onAddFriend: !isAdmin
              ? undefined
              : async (nodeId: string) => {
                  try {
                    await sendFriendRequest(nodeId);
                    log.debug(TAG, "friend request sent to:", nodeId.slice(0, 16) + "...");
                  } catch (err) {
                    log.warn(TAG, "failed to send friend request:", err);
                  }
                },
            friends: isAdmin ? friendsForInvite : undefined,
            onInviteFriend: !isAdmin
              ? undefined
              : async (friend: FriendInfo, role: InvitableRole) => {
              if (!this.friendzProtocol || !this.currentCanvas) return;
              const localIdentity = await getStoredIdentity();
              if (!localIdentity) return;

              const canvasTitle = this.currentCanvas.store.metadata().title;
              const canvasDescription = this.currentCanvas.store.metadata().description;

              // look up color and previewUrl from the narthex canvas card
              let canvasColor = 0;
              let canvasPreviewUrl = "";
              if (this.narthexDocId) {
                try {
                  const narthexHandle = await this.repo.find<CanvasDocument>(
                    this.narthexDocId as DocumentId
                  );
                  await narthexHandle.whenReady();
                  const narthexDoc = narthexHandle.doc();
                  if (narthexDoc?.widgets) {
                    for (const entry of Object.values(narthexDoc.widgets)) {
                      if (
                        entry.type === "canvas-card" &&
                        (entry.props as any)?.canvasDocId === docId &&
                        entry.docId
                      ) {
                        const cardHandle = await this.repo.find<any>(entry.docId as DocumentId);
                        await cardHandle.whenReady();
                        const cardDoc = cardHandle.doc() as Record<string, unknown> | undefined;
                        canvasColor = (cardDoc?.color as number) ?? 0;
                        canvasPreviewUrl = (cardDoc?.previewUrl as string) ?? "";
                        break;
                      }
                    }
                  }
                } catch {
                  // canvas card lookup is best-effort
                }
              }

              const inviteId = crypto.randomUUID();
              const allTargets = [friend.nodeId];

              // write outbox entry FIRST — durable record that survives failures
              if (this.messagezDocHandle) {
                this.messagezDocHandle.change((draft: any) => {
                  if (!draft.shares) draft.shares = [];
                  draft.shares.push({
                    id: inviteId,
                    canvasDocId: docId,
                    canvasTitle,
                    canvasDescription,
                    canvasColor,
                    canvasPreviewUrl,
                    toNodeId: friend.nodeId,
                    toUsername: friend.username,
                    sentAt: new Date().toISOString(),
                    delivered: false,
                    accepted: false,
                    declined: false,
                  });
                });
              }

              // write pending invite to the canvas doc for gossip relay.
              // Automerge syncs this to all peers on the canvas so any of them
              // can relay the invite when the target comes online.
              if (this.currentCanvas) {
                this.currentCanvas.store.addPendingInvite(friend.nodeId, {
                  invitedBy: localIdentity.node_id,
                  invitedByUsername: this.friendzProtocol?.getLocalUsername() ?? "",
                  role,
                  invitedAt: new Date().toISOString(),
                });
                // record the chosen role in the canvas's ACL immediately —
                // gates UI affordances (and, once AclFilteringNetworkAdapter
                // lands, actual sync enforcement) as soon as this peer
                // connects, independent of whether they've "accepted" yet.
                this.currentCanvas.store.setRole(friend.nodeId, role);
              }

              // attempt direct send — best effort, gossip relay handles offline peers
              try {
                await sendCanvasInvite(friend.nodeId, {
                  inviteId,
                  canvasDocId: docId,
                  canvasTitle,
                  canvasDescription,
                  canvasColor,
                  canvasPreviewUrl,
                  originNodeId: localIdentity.node_id,
                  originUsername: this.friendzProtocol?.getLocalUsername() ?? "",
                  role,
                  targets: allTargets,
                  acked: [],
                });
              } catch (err) {
                log.warn(
                  TAG,
                  "direct invite send failed (gossip relay will retry):",
                  (err as Error)?.message ?? err
                );
              }

              log.debug(TAG, "canvas invite sent to:", friend.nodeId.slice(0, 16) + "...");
            },
            pendingInvites: pendingInvitesList,
            declinedInvites: isAdmin ? declinedInvites : undefined,
            onCancelInvite: !isAdmin
              ? undefined
              : (targetNodeId: string) => {
              this.currentCanvas?.store.removePendingInvite(targetNodeId);
              // also clear the messagez outbox share entry for this canvas/
              // peer pair — that outbox entry (not the canvas-doc pending
              // invite alone) is what gates "already invited" in the friends-
              // to-invite list above, so leaving it untouched permanently
              // blocked re-inviting this friend after a cancel (a real bug:
              // the two invite-tracking pieces of state weren't kept in
              // sync). mark cancelled rather than deleting the entry
              // outright, and rather than reusing `declined` (that field
              // means the *recipient* declined, a different, real event —
              // reusing it here would misrepresent a self-cancel as a
              // decline anywhere `declined` is displayed).
              if (this.messagezDocHandle) {
                this.messagezDocHandle.change((draft: any) => {
                  if (!draft.shares) return;
                  for (const share of draft.shares) {
                    if (share.canvasDocId === docId && share.toNodeId === targetNodeId) {
                      share.cancelled = true;
                    }
                  }
                });
              }
              log.debug(TAG, "cancelled pending invite for:", targetNodeId.slice(0, 16) + "...");
            },
          };
            return shareOptions;
          };

          // live-refresh: rebuild the dialog (and its options snapshot)
          // whenever the canvas doc or messagez outbox changes, instead of
          // leaving a stale snapshot on screen until the user manually
          // closes and reopens it. `shareOptions`/`shareHandle` are mutable
          // so the DEV test bridge below always reads the latest instance.
          let shareActive = true;
          let isRebuilding = false;
          let shareOptions = buildShareOptions();
          let shareHandle = showShareDialog(shareOptions);

          let rebuildQueued = false;
          const rebuild = () => {
            if (!shareActive || rebuildQueued) return;
            rebuildQueued = true;
            queueMicrotask(() => {
              rebuildQueued = false;
              if (!shareActive) return;
              // `shareHandle.remove()` fires the OLD dialog's `onClose`
              // (`teardownSubscriptions`) as a side effect of tearing down
              // its pixi/DOM state — `isRebuilding` tells that handler this
              // is just an internal dialog swap, not the user actually
              // closing the share panel, so it shouldn't unsubscribe.
              isRebuilding = true;
              shareHandle.remove();
              isRebuilding = false;
              shareOptions = buildShareOptions();
              shareOptions.onClose = teardownSubscriptions;
              shareHandle = showShareDialog(shareOptions);
            });
          };

          const unsubStore = this.currentCanvas.store.onChange(() => rebuild());
          const messagezListener = () => rebuild();
          this.messagezDocHandle?.on("change", messagezListener);

          const teardownSubscriptions = (): void => {
            if (isRebuilding) return;
            shareActive = false;
            unsubStore();
            this.messagezDocHandle?.off("change", messagezListener);
          };
          shareOptions.onClose = teardownSubscriptions;

          if (import.meta.env.DEV) {
            const bridge: Record<string, unknown> = ((window as any).__skeinTest ??= {});
            bridge.share = {
              getFriendsForInvite: () => shareOptions.friends ?? [],
              getPendingInvites: () => {
                const map = this.currentCanvas?.store.pendingInvites() ?? {};
                return Object.entries(map).map(([targetNodeId, invite]) => ({
                  targetNodeId,
                  invite: invite as unknown as Record<string, unknown>,
                }));
              },
              getMessagezShares: () =>
                (((this.messagezDocHandle?.doc() as any)?.shares ?? []) as Array<{
                  toNodeId: string;
                  canvasDocId: string;
                  declined?: boolean;
                  cancelled?: boolean;
                }>),
              inviteFriend: async (nodeId: string, role: InvitableRole) => {
                const friend = (shareOptions.friends ?? []).find((f) => f.nodeId === nodeId);
                if (!friend) return;
                await shareOptions.onInviteFriend?.(friend, role);
              },
              cancelInvite: (nodeId: string) => {
                shareOptions.onCancelInvite?.(nodeId);
              },
              closeShareDialog: () => shareHandle.remove(),
              getFriendRowText: (nodeId: string) => shareHandle.getFriendRowText(nodeId),
            } satisfies ShareTestHooks;
          }
        },
        hasIdentity: !!this.localNodeId,
        avatarUrl: this.socialDoc?.current.profile?.avatarDataUrl || null,
        endpointStateSource: {
          getState: () => this.irohAdapter.getEndpointState(),
          onStateChange: (h) => this.irohAdapter.onEndpointStateChange(h),
        },
        onToggleSocial: () => {
          const sw = window.visualViewport?.width ?? window.innerWidth;
          this.currentMessagesOverlay?.close();
          this.currentSocialOverlay?.toggle(sw);
        },
        onToggleMessages: () => {
          const sw = window.visualViewport?.width ?? window.innerWidth;
          this.currentSocialOverlay?.close();
          this.currentMessagesOverlay?.toggle(sw);
        },
        onShowCanvasInfo: () => {
          const vv = window.visualViewport;
          const sw = vv ? vv.width : window.innerWidth;
          const sh = vv ? vv.height : window.innerHeight;
          // open above the connection-status pill (bottom-left, 8px margin)
          // pill is ~26px tall; overlay sits 8px above it
          const margin = 8;
          const pillH = 26;
          const x = margin;
          const y = Math.round(sh - CANVAS_INFO_OVERLAY_H - pillH - margin * 2);
          this.currentCanvasInfoOverlay?.toggle(sw, x, y);
        },
      });

      this.currentCanvas = canvas;
      // mount overlay panels and wire badge counts
      this.currentSocialOverlay = this.mountSocialOverlay(canvas);
      this.currentMessagesOverlay = this.mountMessagesOverlay(canvas);
      this.currentCanvasInfoOverlay = this.mountCanvasInfoOverlay(canvas);
      this.wireBadges(canvas);
      canvas.store.setLocalNodeId(this.localNodeId);
      if (this.localNodeId) {
        canvas.presenceManager.setLocalNodeId(this.localNodeId);
      }
      canvas.toolbar.refreshRoleGating();

      // update lastVisitedAt on the canvas card
      if (this.narthexDocId) {
        try {
          const narthexHandle = await this.repo.find<CanvasDocument>(
            this.narthexDocId as DocumentId
          );
          await narthexHandle.whenReady();
          const narthexDoc = narthexHandle.doc();
          if (narthexDoc?.widgets) {
            for (const entry of Object.values(narthexDoc.widgets)) {
              if (
                entry.type === "canvas-card" &&
                (entry.props as any)?.canvasDocId === docId &&
                entry.docId
              ) {
                const cardHandle = await this.repo.find<any>(entry.docId as DocumentId);
                await cardHandle.whenReady();
                cardHandle.change((draft: any) => {
                  draft.lastVisitedAt = new Date().toISOString();
                  draft.hasUpdates = false;
                });
                break;
              }
            }
          }
        } catch {
          // best-effort — don't block navigation
        }
      }

      // wire transport disconnect → immediate presence offline
      const unsubDisconnect = this.irohAdapter.onPeerDisconnect((nodeId) => {
        this.currentCanvas?.presenceManager.markPeerOffline(nodeId);
      });
      this.transportPresenceUnsubs.push(unsubDisconnect);

      // immediately broadcast presence when a peer reconnects
      const unsubConnect = this.irohAdapter.onPeerConnect(() => {
        this.currentCanvas?.presenceManager.broadcastOnline();
      });
      this.transportPresenceUnsubs.push(unsubConnect);

      // set up name resolver for cursor labels
      if (canvas.presenceRenderer) {
        canvas.presenceRenderer.setNameResolver((peerId: string) => {
          const state = this.socialDoc?.current;
          if (!state?.friends) return null;
          const friend = state.friends.find((f) => f.nodeIds?.some((n) => n.nodeId === peerId));
          if (!friend) return null;
          const display = resolveFriendDisplay(friend);
          return display.name || null;
        });
      }

      // set up avatar resolver for presence cursor images
      if (canvas.presenceRenderer) {
        canvas.presenceRenderer.setAvatarResolver((peerId: string) => {
          const state = this.socialDoc?.current;
          if (!state?.friends) return null;
          for (const friend of state.friends) {
            if (!friend.nodeIds) continue;
            for (const n of friend.nodeIds) {
              if (n.nodeId === peerId && n.avatarDataUrl) {
                return n.avatarDataUrl;
              }
            }
          }
          return null;
        });
      }

      // set up color resolver so presence cursors use a peer's own real
      // profile accent color once it's known (learned via a profile-response
      // message, same as avatarDataUrl above) — falls back to the presence
      // manager's palette-assigned color until then (see
      // presence-renderer.ts's resolveCursorColor()).
      if (canvas.presenceRenderer) {
        canvas.presenceRenderer.setColorResolver((peerId: string) => {
          const state = this.socialDoc?.current;
          if (!state?.friends) return null;
          for (const friend of state.friends) {
            if (!friend.nodeIds) continue;
            for (const n of friend.nodeIds) {
              if (n.nodeId === peerId && n.accentColor !== undefined) {
                return n.accentColor;
              }
            }
          }
          return null;
        });
      }
      (window as any).__skein = canvas;

      // expose a share helper for quick testing via browser console
      (window as any).__skein.share = async () => {
        const identity = await getStoredIdentity();
        if (!identity) {
          log.debug(TAG, "no identity — generate one first (profile widget)");
          return;
        }
        const shareStr = encodeShareString(identity.node_id, docId);
        try {
          await navigator.clipboard.writeText(shareStr);
          log.debug(TAG, "share string copied to clipboard:", shareStr);
        } catch {
          log.debug(TAG, "share string (copy manually):", shareStr);
        }
        log.debug(
          TAG,
          "share URL:",
          window.location.origin + window.location.pathname + "#share/" + shareStr
        );
      };

      log.debug(
        TAG,
        "canvas ready — doc:",
        docId,
        "| widgets:",
        canvas.store.widgetCount(),
        "| registry:",
        canvas.registry.types().join(", ")
      );

      // write self (and any pending join peer) into the canvas doc so
      // connections can be re-established after page reload.
      // then reconnect to all known peers in the doc.
      this.registerAndReconnectPeers(canvas).catch((err) => {
        log.warn(TAG, "peer registration/reconnection failed:", err);
      });
    } catch (err) {
      failure = err;
    } finally {
      this.navigating = false;
    }

    if (failure) {
      log.error(TAG, "failed to open canvas, falling back to narthex:", docId, failure);
      await this.navigateToNarthex();
    }
  }

  /**
   * join a remote canvas via share string.
   * connects to the peer, creates a canvas-card in the narthex, and navigates.
   */
  /**
   * handle an accepted canvas invite from the inbox widget.
   * connects to the inviter's peer node, creates a remote canvas-card
   * on the narthex if one doesn't already exist, and navigates to the canvas.
   */
  private async acceptCanvasInvite(detail: {
    canvasDocId: string;
    fromNodeId: string;
    canvasTitle: string;
    canvasDescription: string;
    canvasColor: number;
    canvasPreviewUrl: string;
    fromUsername: string;
    /** node id of the hub (or other peer) that relayed this invite via
     *  gossip, if any — see `canvasInviteSchema`'s `relayedBy` field.
     *  used as a connection fallback below when `fromNodeId` (the
     *  original inviter) is offline, which is exactly the case a
     *  gossip-relayed invite exists to handle in the first place. */
    relayedBy?: string;
    /** the role actually offered by this invite — see
     *  `canvasInviteSchema`'s `role` field. defaults to "member" only for
     *  backward compatibility with an already-in-flight event that
     *  predates this field, not as an intended default. */
    role?: InvitableRole;
  }): Promise<void> {
    log.debug(
      TAG,
      "accepting canvas invite:",
      detail.canvasDocId,
      "from peer:",
      detail.fromNodeId.slice(0, 16) + "..."
    );

    // ensure we have an identity (generates one if needed, starts midden)
    await ensureIdentity();
    const identity = await getStoredIdentity();

    // connect to the inviter's peer via the iroh adapter. if that fails
    // and this invite was relayed through a hub, also try the hub directly
    // — the hub already holds a synced copy of the canvas doc (that's how
    // it was able to relay the invite at all), so it's a reachable source
    // for the doc write below even while the original inviter stays
    // offline. without this fallback, a hub-relayed invite's accept could
    // never be recorded anywhere: the direct dial to a still-offline
    // inviter fails, and there was no other way to reach the doc.
    let connected = false;
    try {
      await this.irohAdapter.addPeer(detail.fromNodeId);
      connected = true;
    } catch (err) {
      log.error(TAG, "failed to connect to invite peer:", err);
      // continue anyway — the peer might become reachable later
    }
    if (!connected && detail.relayedBy && detail.relayedBy !== detail.fromNodeId) {
      try {
        await this.irohAdapter.addPeer(detail.relayedBy);
        connected = true;
      } catch (err) {
        log.error(TAG, "failed to connect to relaying hub:", err);
      }
    }

    // durably record acceptance on the shared canvas doc itself, not just
    // via a live wire message to the (possibly still-offline) inviter —
    // this is what fixes invites getting stuck "pending" forever: once
    // this write lands, ordinary automerge sync carries it to the inviter,
    // the hub, and any other admin whenever they next connect, regardless
    // of whether the direct accept message above ever got through. NOT
    // gated on `connected` above: an already-locally-known doc (e.g. a
    // canvas this peer already has a copy of) resolves via `repo.find()`
    // from local storage with no network involved at all, so requiring a
    // successful dial first would needlessly skip the durable write in
    // that case too. bounded with a short timeout instead, so a doc that's
    // genuinely unreachable from any known peer can't hang this handler.
    if (identity) {
      try {
        const canvasStore = await Promise.race([
          CanvasStore.open(this.repo, detail.canvasDocId as DocumentId),
          new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error("canvas doc open timed out")), 5000)
          ),
        ]);
        canvasStore.markInviteAccepted(identity.node_id);
      } catch (err) {
        log.warn(TAG, "failed to record invite acceptance on canvas doc:", err);
      }
    }

    // check if a canvas-card already exists for this docId on the narthex.
    //
    // this must always resolve the actual narthex store, never whatever
    // canvas the user happens to be viewing right now — an invite accepted
    // while looking at some OTHER canvas used to silently add the shared
    // canvas-card widget to *that* canvas instead of the narthex (a real
    // bug: the card would then only ever be visible from inside that
    // unrelated canvas, never from the narthex root where it belongs).
    let narthexStore: CanvasStore | null = null;
    if (this.narthexDocId) {
      if (this.currentCanvas?.store.handle.documentId === this.narthexDocId) {
        narthexStore = this.currentCanvas.store;
      } else {
        try {
          narthexStore = await CanvasStore.open(this.repo, this.narthexDocId as DocumentId);
        } catch (err) {
          log.warn(TAG, "failed to open narthex store to accept canvas invite:", err);
        }
      }
    }

    if (narthexStore) {
      const existing = narthexStore.allWidgets();
      const alreadyExists = existing.some((w) => {
        if (w.type !== "canvas-card") return false;
        return (w.props as Record<string, unknown>)?.canvasDocId === detail.canvasDocId;
      });

      if (!alreadyExists) {
        // add a remote canvas-card widget to the narthex
        const existingCount = narthexStore.widgetCount();
        const shortDate = new Date().toISOString().slice(0, 10);

        narthexStore.addWidget({
          id: crypto.randomUUID(),
          type: "canvas-card",
          x: 60 + (existingCount % 4) * 300,
          y: 60 + Math.floor(existingCount / 4) * 220,
          width: 280,
          height: 200,
          zIndex: existingCount + 1,
          props: {
            canvasDocId: detail.canvasDocId,
            title: detail.canvasTitle || "shared canvas",
            description: detail.canvasDescription || "",
            authorName: "",
            color: detail.canvasColor || 0x06b6d4,
            previewUrl: detail.canvasPreviewUrl || "",
            createdAt: shortDate,
            modifiedAt: new Date().toISOString(),
            // remote card fields
            isRemote: true,
            ownerNodeId: detail.fromNodeId,
            ownerUsername: detail.fromUsername || "",
            // NOTE: this is a cosmetic display field on the *local* narthex
            // canvas-card only — it is NOT the actual access control. the
            // real ACL lives in the shared canvas doc's `.acl` map (see
            // CanvasStore.setRole/getRole), which an admin already writes
            // at invite-send time and which syncs to this peer automatically
            // once they join the canvas. now carries the actual role the
            // invite offered (see messagez-widget.ts's `canvasInviteSchema`
            // — used to be hardcoded to "member" regardless of what was
            // actually offered, a real cosmetic bug fixed alongside
            // onAclChange's live role-update wiring, see friendz-wiring.ts).
            role: detail.role ?? "member",
            accessRevoked: false,
            lastVisitedAt: "",
          },
          collapsed: false,
          docId: null,
          parentId: null,
        });
      }
    }

    log.debug(
      TAG,
      "canvas invite accepted — canvas card created on narthex, user can navigate when ready"
    );

    // notify messagez widget that the accept flow completed successfully
    window.dispatchEvent(
      new CustomEvent("skein:accept-canvas-invite-done", {
        detail: { canvasDocId: detail.canvasDocId },
      })
    );
  }

  private async joinCanvasFromNarthex(detail: {
    shareString: string;
    wizardWidgetId?: string;
  }): Promise<void> {
    const decoded = decodeShareString(detail.shareString);
    if (!decoded) {
      log.warn(TAG, "invalid share string");
      return;
    }

    log.debug(
      TAG,
      "joining canvas:",
      decoded.docId,
      "from peer:",
      decoded.nodeId.slice(0, 16) + "..."
    );

    // ensure we have an identity (generates one if needed, starts midden)
    await ensureIdentity();

    // connect to the peer via the iroh adapter
    try {
      await this.irohAdapter.addPeer(decoded.nodeId);
    } catch (err) {
      log.error(TAG, "failed to connect to peer:", err);
      // continue anyway — the peer might become reachable later
    }

    // remove the join wizard widget if it was used
    if (detail.wizardWidgetId && this.currentCanvas) {
      this.currentCanvas.store.removeWidget(detail.wizardWidgetId);
    }

    // check if a canvas-card already exists for this docId
    if (this.currentCanvas) {
      const existing = this.currentCanvas.store.allWidgets();
      const alreadyExists = existing.some((w) => {
        if (w.type !== "canvas-card") return false;
        // check if the card's props have this docId
        return (w.props as Record<string, unknown>)?.canvasDocId === decoded.docId;
      });

      if (!alreadyExists) {
        // add a canvas-card widget to the narthex
        const existingCount = this.currentCanvas.store.widgetCount();
        const shortDate = new Date().toISOString().slice(0, 10);

        this.currentCanvas.store.addWidget({
          id: crypto.randomUUID(),
          type: "canvas-card",
          x: 60 + (existingCount % 4) * 300,
          y: 60 + Math.floor(existingCount / 4) * 220,
          width: 280,
          height: 200,
          zIndex: existingCount + 1,
          props: {
            canvasDocId: decoded.docId,
            title: "syncing...",
            description: "connecting to peer",
            authorName: "",
            color: 0x06b6d4, // cyan accent for remote canvases
            previewUrl: "",
            createdAt: shortDate,
            modifiedAt: new Date().toISOString(),
            // remote card fields — joining via share string
            isRemote: true,
            ownerNodeId: decoded.nodeId,
            ownerUsername: "",
            role: "viewer", // share-string joiners default to viewer
            accessRevoked: false,
            lastVisitedAt: "",
          },
          collapsed: false,
          docId: null,
          parentId: null,
        });
      }
    }

    // stash the remote peer's nodeId so navigateToCanvas can write it
    // into the canvas doc reliably (no RAF race).
    this.pendingPeerNodeId = decoded.nodeId;

    // navigate to the canvas — automerge-repo will sync it from the peer.
    // navigateToCanvas will pick up pendingPeerNodeId and write both
    // self + remote into the canvas doc's peers field.
    window.location.hash = decoded.docId;
  }

  /**
   * write self (and any pending join peer) into the canvas doc, then
   * reconnect to all known peers. this covers:
   * - first open after creating a canvas (writes self)
   * - first open after joining via share string (writes self + remote)
   * - page reload (writes self if missing, reconnects to all known peers)
   */
  private async registerAndReconnectPeers(canvas: SkeinCanvas): Promise<void> {
    const identity = await getStoredIdentity();
    if (!identity) return;

    // always write self — idempotent, ensures we're in the peer list
    canvas.store.addPeer(identity.node_id);

    // stamp our lastSeenAt on the canvas doc — used by gossip digest
    // to determine which canvases have updates since we last saw them
    canvas.store.setLocalNodeId(identity.node_id);
    canvas.store.stampLastSeen();
    canvas.toolbar.refreshRoleGating();

    // wire transport-level connectivity into the canvas store so widgets
    // can check which peers are online for smarter snatch peer selection
    canvas.store.setPeerOnlineChecker((nodeId) => this.irohAdapter.isConnected(nodeId));

    // write the remote peer from a pending join (stashed by joinCanvasFromNarthex)
    if (this.pendingPeerNodeId) {
      canvas.store.addPeer(this.pendingPeerNodeId);
      this.pendingPeerNodeId = null;
    }

    // reconnect to every peer that isn't us
    const peers = canvas.store.peers();
    const peerNodeIds = Object.keys(peers).filter((id) => id !== identity.node_id);

    if (peerNodeIds.length === 0) return;

    log.debug(TAG, "reconnecting to", peerNodeIds.length, "known peer(s)");

    for (const nodeId of peerNodeIds) {
      this.irohAdapter.addPeer(nodeId).catch((err) => {
        log.warn(TAG, "failed to reconnect to peer:", nodeId.slice(0, 16) + "...", err);
      });
    }

    // clean up any pending invite for ourselves on this canvas doc
    const pendingInvites = canvas.store.pendingInvites();
    if (pendingInvites[identity.node_id]) {
      canvas.store.removePendingInvite(identity.node_id);
      log.debug(
        TAG,
        "cleaned up pending invite for self on canvas:",
        canvas.store.handle.documentId
      );
    }
  }

  /**
   * create a new canvas and add a canvas-card widget to the narthex.
   * accepts optional detail from the canvas wizard with pre-filled metadata.
   * then navigate to the newly created canvas.
   */
  private async createCanvasFromNarthex(detail?: {
    title?: string;
    description?: string;
    color?: number;
    previewUrl?: string;
    wizardWidgetId?: string;
  }): Promise<void> {
    if (!this.currentCanvas || !this.narthexDocId) return;

    // read author name from the standalone social doc (always available after boot)
    let authorName = "";
    if (this.socialDoc) {
      authorName = this.socialDoc.current.profile?.username ?? "";
    }

    // create a new empty canvas document in the shared repo
    const newStore = CanvasStore.create(this.repo);
    const newDocId = newStore.handle.documentId;

    // record the creator as owner in the canvas's ACL (see canvas-store.ts's
    // access control section) — skipped if no identity exists yet (anonymous
    // creator); nothing to stamp in that case.
    if (this.localNodeId) {
      newStore.stampAdmin(this.localNodeId);
    }

    const title = detail?.title || "untitled canvas";
    const now = new Date().toISOString();
    log.debug(
      TAG,
      "creating new canvas:",
      JSON.stringify(title),
      "author:",
      JSON.stringify(authorName),
      "doc:",
      newDocId
    );

    // seed the canvas document with metadata so it's available to
    // other peers and for navigate-back sync
    newStore.setTitle(title);
    if (detail?.description) {
      newStore.setDescription(detail.description);
    }
    newStore.setCreatedAt(now);

    // set color on the canvas document (source of truth for metadata)
    if (detail?.color) {
      newStore.setColor(detail.color);
    }

    // set the preview image captured in the create-canvas wizard, if any —
    // this was previously only ever applied to the narthex card's own
    // cosmetic prop copy below, never to the real canvas doc's own
    // `previewUrl` field, so a canvas created with an image picked during
    // the wizard still showed no image anywhere that reads the canvas
    // doc's own previewUrl directly (e.g. profile-tab.ts's "add current
    // canvas to profile" — a real user-reported bug, 2026-07-02).
    if (detail?.previewUrl) {
      newStore.setPreviewUrl(detail.previewUrl);
    }

    // seed a canvas-info widget so every new canvas has one by default.
    // uses the singleton pattern — placed in the top-left corner.
    newStore.addWidget({
      id: "canvas-info",
      type: "canvas-info",
      x: 20,
      y: 20,
      width: 280,
      height: 340,
      zIndex: 0,
      props: {},
      collapsed: false,
      docId: null,
      parentId: null,
    });

    // if the wizard widget is still on the narthex, remove it
    if (detail?.wizardWidgetId) {
      this.currentCanvas.store.removeWidget(detail.wizardWidgetId);
    }

    // add a canvas-card widget to the narthex doc pointing to the new canvas.
    // props are merged into the widget's schema defaults when the per-widget
    // automerge doc is created (see widget-manager.ts mountWidget).
    const shortDate = now.slice(0, 10);
    const cardId = crypto.randomUUID();
    const existingCount = this.currentCanvas.store.widgetCount();

    this.currentCanvas.store.addWidget({
      id: cardId,
      type: "canvas-card",
      x: 60 + (existingCount % 4) * 300,
      y: 60 + Math.floor(existingCount / 4) * 220,
      width: 280,
      height: 200,
      zIndex: existingCount + 1,
      props: {
        canvasDocId: newDocId,
        title,
        description: detail?.description || "",
        previewUrl: detail?.previewUrl || "",
        authorName,
        color: detail?.color ?? 0xd946ef,
        createdAt: shortDate,
        modifiedAt: now,
      },
      collapsed: false,
      docId: null,
      parentId: null,
    });

    // navigate to the new canvas
    window.location.hash = newDocId;
  }

  private mountSocialOverlay(canvas: SkeinCanvas): WidgetOverlay | null {
    if (!this.socialDoc) return null;

    const ctx: WidgetMountContext<typeof socialSchema> = {
      doc: this.socialDoc as any,
      width: SOCIAL_OVERLAY_W,
      height: SOCIAL_OVERLAY_H,
      keyboard: canvas.keyboard,
      widgetId: SOCIAL_WIDGET_ID,
      canvasElement: canvas.app.canvas as HTMLCanvasElement,
      setHeaderActions: () => {}, // header actions not used in overlay context
      // lets profile-tab.ts read the currently-open canvas's title/description/
      // color for "add current canvas to profile", and read/edit the local
      // peer's own profile doc's curated canvas list.
      canvasStore: canvas.store,
      profileStore: this.profileStore ?? undefined,
      narthexDocId: this.narthexDocId ?? undefined,
    };

    try {
      const ctrl = socialWidget.create(ctx);
      return new WidgetOverlay(canvas.app, ctrl, SOCIAL_OVERLAY_W, SOCIAL_OVERLAY_H, canvas.theme);
    } catch (err) {
      log.warn(TAG, "failed to mount social overlay:", err);
      return null;
    }
  }

  private mountMessagesOverlay(canvas: SkeinCanvas): WidgetOverlay | null {
    if (!this.messagezDocHandle) return null;

    const handle = this.messagezDocHandle;
    const doc: WidgetDoc<typeof messagezSchema> = {
      get current(): MessagezState {
        return (handle.doc() ?? {
          invites: [],
          shares: [],
          deletions: [],
          canvasInvitesFrom: "everyone",
        }) as MessagezState;
      },
      change(fn: (draft: MessagezState) => void): void {
        handle.change(fn as any);
      },
      on(_event: "change", handler: (state: MessagezState) => void): () => void {
        const cb = () => {
          handler(
            (handle.doc() ?? {
              invites: [],
              shares: [],
              deletions: [],
              canvasInvitesFrom: "everyone",
            }) as MessagezState
          );
        };
        handle.on("change", cb);
        return () => handle.off("change", cb);
      },
    };

    const ctx: WidgetMountContext<typeof messagezSchema> = {
      doc,
      width: MESSAGES_OVERLAY_W,
      height: MESSAGES_OVERLAY_H,
      keyboard: canvas.keyboard,
      widgetId: MESSAGEZ_WIDGET_ID,
      canvasElement: canvas.app.canvas as HTMLCanvasElement,
      // pendingKnocks lives on the currently-open canvas's own document
      // (canvas-doc.ts), not the messagez doc above — see
      // docs/knock-and-hub-relay-plan.md section 1's table for the
      // asymmetry. the messagez widget reads it straight from here.
      canvasStore: canvas.store,
    };

    try {
      const ctrl = messagezWidget.create(ctx);
      if (import.meta.env.DEV) {
        const bridge: Record<string, unknown> = ((window as any).__skeinTest ??= {});
        bridge.messagez = (ctrl as unknown as { testHooks?: unknown }).testHooks;
      }
      return new WidgetOverlay(
        canvas.app,
        ctrl,
        MESSAGES_OVERLAY_W,
        MESSAGES_OVERLAY_H,
        canvas.theme
      );
    } catch (err) {
      log.warn(TAG, "failed to mount messages overlay:", err);
      return null;
    }
  }

  private mountCanvasInfoOverlay(canvas: SkeinCanvas): WidgetOverlay | null {
    // canvas-info needs a canvasStore — only available on non-narthex canvases
    if (!canvas.store) return null;

    // ephemeral in-memory doc for the canvas-info widget's activeTab state
    let activeTab: "details" | "history" = "details";
    const tabListeners = new Set<(state: { activeTab: "details" | "history" }) => void>();
    const doc: WidgetDoc<typeof canvasInfoSchema> = {
      get current(): { activeTab: "details" | "history" } {
        return { activeTab };
      },
      change(fn: (draft: { activeTab: "details" | "history" }) => void): void {
        const draft = { activeTab };
        fn(draft);
        activeTab = draft.activeTab;
        tabListeners.forEach((h) => h({ activeTab }));
      },
      on(
        _event: "change",
        handler: (state: { activeTab: "details" | "history" }) => void
      ): () => void {
        tabListeners.add(handler);
        return () => tabListeners.delete(handler);
      },
    };

    const ctx: WidgetMountContext<typeof canvasInfoSchema> = {
      doc,
      width: CANVAS_INFO_OVERLAY_W,
      height: CANVAS_INFO_OVERLAY_H,
      keyboard: canvas.keyboard,
      widgetId: "canvas-info-overlay",
      canvasElement: canvas.app.canvas as HTMLCanvasElement,
      canvasStore: canvas.store,
    };

    try {
      const ctrl = canvasInfoWidget.create(ctx);
      return new WidgetOverlay(
        canvas.app,
        ctrl,
        CANVAS_INFO_OVERLAY_W,
        CANVAS_INFO_OVERLAY_H,
        canvas.theme
      );
    } catch (err) {
      log.warn(TAG, "failed to mount canvas-info overlay:", err);
      return null;
    }
  }

  private wireBadges(canvas: SkeinCanvas): void {
    // social badge: count pending friend requests
    // also update avatar URL whenever the profile changes
    if (this.socialDoc) {
      const updateSocial = () => {
        const count = (this.socialDoc?.current.pendingRequests ?? []).filter(
          (r: any) => r.status === "pending"
        ).length;
        canvas.toolbar.updateSocialBadge(count);
        // sync avatar image into the toolbar button
        const avatarUrl = this.socialDoc?.current.profile?.avatarDataUrl ?? null;
        canvas.toolbar.setAvatarUrl(avatarUrl || null);
      };
      const unsub = this.socialDoc.on("change", updateSocial);
      this.badgeUnsubs.push(unsub);
      updateSocial();
    }

    // messages badge: pending invites + unread deletion notifications
    if (this.messagezDocHandle) {
      const updateMessages = () => {
        const doc = this.messagezDocHandle?.doc() as any;
        const invites = (doc?.invites ?? []).filter((i: any) => i.status === "pending").length;
        const deletions = (doc?.deletions ?? []).filter((d: any) => d.status === "unread").length;
        canvas.toolbar.updateMessagesBadge(invites + deletions);
      };
      this.messagezDocHandle.on("change", updateMessages);
      this.badgeUnsubs.push(() => this.messagezDocHandle?.off("change", updateMessages));
      updateMessages();
    }
  }

  /** tear down the router — destroys canvas, friendz protocol, and bridge. */
  destroy(): void {
    this.destroyCurrent();
    this.harness.destroy();
    for (const unsub of this.canvasWatcherUnsubs) unsub();
    this.canvasWatcherUnsubs = [];
    if (
      this.socialDoc &&
      "destroy" in this.socialDoc &&
      typeof (this.socialDoc as any).destroy === "function"
    ) {
      (this.socialDoc as any).destroy();
    }
    this.socialDoc = null;
    this.messagezDocHandle = null;

    for (const unsub of this.friendzDocUnsubs) {
      unsub();
    }
    this.friendzDocUnsubs = [];
    if (this.friendzProtocol) {
      setOutboundRequestHook(null);
      destroyBridge();
      this.friendzProtocol.destroy();
      this.friendzProtocol = null;
    }
    this.flushCanvasUpdates = null;
  }
}

// ---------------------------------------------------------------------------
// entry point
// ---------------------------------------------------------------------------

async function boot(): Promise<void> {
  // preload custom fonts before any PixiJS Text objects are created
  await preloadFonts();

  const mountElement = document.getElementById("canvas-root");
  if (!mountElement) {
    throw new Error("mount element #canvas-root not found");
  }

  const router = await SkeinRouter.create(mountElement);
  (window as any).__skeinRouter = router;
  await router.boot();
}

boot().catch((err) => {
  log.error(TAG, "skein boot failed:", err);
  const root = document.getElementById("canvas-root");
  if (root) {
    root.className = "boot-error";
    root.textContent = `failed to start: ${err instanceof Error ? err.message : String(err)}`;
  }
});
