import { Repo, type DocHandle, type DocumentId } from "@automerge/automerge-repo";
import { registerEndpointAdapter } from "../p2p/endpoint-control";
import { resolveDocReadyCached } from "../p2p/doc-ready";
import { createTestRegistry } from "../../widgets/index";
import { createNarthexRegistry } from "../../widgets/narthex/index";
import { findTrashWidget } from "../../widgets/narthex/trash-widget";
import type { SocialDoc } from "../../widgets/narthex/social/types";
import type { CanvasDocument, InvitableRole } from "../canvas/canvas-doc";
import { registerPeerName } from "../canvas/peer-names";
import { CanvasStore } from "../canvas/canvas-store";
import type { ConnectionStateSource } from "../canvas/connection-status";
import { initCanvas, type SkeinCanvas } from "../canvas/init";
import type { BreadcrumbItem } from "../canvas/toolbar";
import { findEmptySpot } from "../canvas/layout-placement";
import { ensureMyProfileDoc, type ProfileStore } from "../canvas/profile-doc";
import { showShareDialog, type FriendInfo, type ShareDialogOptions } from "../canvas/share-dialog";
import { registerSocialBridge } from "../dev/test-bridge-registry";
import { buildP2PBridge } from "../dev/test-bridge";
import type { SkeinTestBridgeSocial, ShareTestHooks } from "../dev/test-bridge";
import { sharedBlobAclRegistry } from "../canvas/blob-acl-registry";
import { preloadFonts } from "../fonts/font-loader";
import { handleSkeinStream, createSkeinEnsureBlobHandler } from "../p2p/skein-handler";
import { DEFAULT_ENSURE_ALPN } from "@freqhole/reliquary/ensure";
import type { FriendzProtocol } from "../p2p/friends-protocol";
import {
  destroyBridge,
  getFriendInfo,
  gossipFriendRequestsNow,
  initKnockSocialDocBridge,
  isFriend,
  markManuallyRetried,
  recordHubAck,
  recordKnockAck,
  recordKnockRelay,
  recordKnownHubNodeIds,
  requestProfile,
  sendAclChange,
  sendCanvasInvite,
  sendFriendRequest,
  setOutboundRequestHook,
  wasManuallyRetried,
} from "../p2p/friendz-bridge";

import { ensureIdentity, getMiddenNode, getStoredIdentity, onIdentityChange } from "../p2p/identity";
import { getOrCreateAnonDeviceId } from "../p2p/anon-device-id";
import { IrohNetworkAdapter, restrictBlobToPeers, getActiveTransfers, type MiddenStreamNode } from "../p2p/iroh-network-adapter";
import { setBrowserTransferSource } from "../p2p/transfer-progress";
import { createAclFilteringAdapter, createRepoRoleResolver } from "../p2p/acl-filtering-network-adapter";
import type { RoleResolver } from "../p2p/acl-filtering-network-adapter";
import { createCanvasScopedSharePolicy } from "../p2p/canvas-scoped-share-policy";
import { buildShareUrl, decodeShareString, encodeShareString } from "../p2p/share-string";
import { resolveFriendDisplay, SqliteSocialDoc } from "../p2p/sqlite-social-doc";
import { dispatch, isTauriMode, TauriStreamNode } from "../p2p/tauri-transport";
import {
  setPandocFormatsAvailable,
  freeUpLocalBlobCopy,
  pauseSnatchDownload,
  checkBlobLocality,
  getBlobCanvasRefs,
  removeBlobCanvasRef,
  removeAllBlobCanvasRefs,
} from "../widgets/file-utils";
import { getMetaValue, setMetaValue } from "../storage/meta-db";
import { createSkeinHarness, type SkeinHarnessNoStore } from "../harness/skein-harness";
import { syncCanvasMetadataToCards, watchCanvasDocsForUpdates } from "./canvas-watchers";
import {
  initFriendzWiring,
  docHandleAsSocialDoc,
  wireFriendHandlers,
  wireKnockHandlers,
} from "./friendz-wiring";
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
import { peedeeeffWidget } from "../../widgets/peedeeeff/index";
import {
  WidgetOverlay,
  SOCIAL_OVERLAY_W,
  SOCIAL_OVERLAY_H,
  MESSAGES_OVERLAY_W,
  MESSAGES_OVERLAY_H,
  CANVAS_INFO_OVERLAY_W,
  CANVAS_INFO_OVERLAY_H,
} from "../canvas/widget-overlay";
import type {
  OtherCanvasKnockEntry,
  OtherCanvasKnocksSource,
  WidgetDoc,
  WidgetMountContext,
} from "../widgets/widget-types";
import { configureLogging, log, type LogLevel } from "@freqhole/reliquary/utils";

// configure logging as early as possible - this module is the app's entry
// point (see index.html), so every other module's log calls run after this.
// localStorage overrides still take priority over these build-time defaults.
configureLogging({
  level:
    (import.meta.env.VITE_LOG_LEVEL as LogLevel | undefined) ??
    (import.meta.env.DEV ? "debug" : "warn"),
  filter: (import.meta.env.VITE_LOG_FILTER as string | undefined)
    ?.split(",")
    .map((s) => s.trim())
    .filter(Boolean),
});

// indexeddb key for the well-known narthex document id
const NARTHEX_DOC_KEY = "skein-narthex-doc-id";
const MESSAGEZ_DOC_KEY = "skein-messagez-doc-id";
/** meta-db key for the standalone (browser-mode) social doc id — exported so
 *  other modules that need best-effort, read-only access to the local
 *  peer's own friend list can look it up without duplicating the key
 *  string or depending on this whole class. */
export const SOCIAL_DOC_KEY = "skein-social-doc-id"; // browser mode only
const TAG = "skein.boot";
/** cold-open fast-fail bound (see `isInitialNavigation`'s doc comment) — a
 *  doc that's already locally known resolves from storage near-instantly,
 *  so this bound is really only ever "spent" waiting on the network.
 *
 *  originally 3000ms, on the assumption that a reachable peer replies
 *  quickly. that assumption doesn't hold for the single most important
 *  cold-open case: the very first time a just-approved canvas-access
 *  requester opens the canvas (e.g. clicking the notification right
 *  after their knock got approved). that path needs a REAL first-time
 *  iroh discovery/relay handshake, then a multi-hop protocol exchange
 *  (friend-request -> ack -> knock -> ack -> approve) before the
 *  automerge-repo sync connection even starts - confirmed via real logs
 *  to routinely take several seconds with retries even when the owner is
 *  online and everything is working correctly (see
 *  /memories/iroh-gotchas.md — "first-connection discovery + handshake
 *  overhead routinely exceeds 200ms"). 3000ms was cutting this off before
 *  sync could ever complete, bouncing the requester back to narthex over
 *  and over with no way to ever succeed. 15s gives real first-contact
 *  syncs a fair chance while still failing reasonably fast for a
 *  genuinely dead link. */
const COLD_OPEN_TIMEOUT_MS = 15_000;
/** delay before retrying still-unacknowledged outbound canvas knocks/friend
 *  requests left over from a previous session (see
 *  `retryUnacknowledgedOutboundOnBoot()`) — deliberately NOT run inline
 *  during boot()/initFriendzProtocol() itself: a batch of real network
 *  dials has no business competing with initial render/interaction, so
 *  it's pushed a short while past it instead. */
const BOOT_RETRY_DELAY_MS = 8000;

/**
 * mirrors messagez-widget.ts's (non-exported) `getDismissedKnocks()` — same
 * localStorage key format (`skein.dismissedKnocks.<canvasDocId>`), same
 * client-only/non-synced "ignore" semantics. duplicated rather than
 * imported to avoid the app shell depending on a narthex widget module;
 * used by `wireBadges()` so a knock the admin already dismissed in the
 * messagez widget doesn't keep the top-nav badge lit forever.
 */
function getDismissedKnockIds(canvasDocId: string): Set<string> {
  try {
    const raw = localStorage.getItem(`skein.dismissedKnocks.${canvasDocId}`);
    if (!raw) return new Set();
    const parsed = JSON.parse(raw);
    return new Set(Array.isArray(parsed) ? parsed : []);
  } catch {
    return new Set();
  }
}

/**
 * best-effort cleanup for a file widget that's being permanently removed
 * (either directly, or as part of a whole canvas-card cascade delete) —
 * stops any in-flight snatch for its blob and purges the local copy, so a
 * deleted widget doesn't leave a download running in the background or a
 * local copy sitting on disk with nothing left referencing it.
 *
 * called from `beforeRemoveHook`, so the widget's own doc still exists
 * (its blobId/blake3 are readable) even though the widget instance itself
 * has already been torn down (`WidgetController.destroy()` already ran —
 * see widget-manager.ts's `unmountWidget`) and its in-memory
 * `activeSnatchBlake3`/`snatchDownloadId` closure state is gone. re-reads
 * blake3 straight from the persisted doc instead.
 *
 * a 0-byte local copy (the concurrent-download corruption bug this fixes
 * elsewhere) is always purged unconditionally — it's already useless, so
 * there's no other-widget reference worth protecting. otherwise, this
 * widget's own ref is dropped from the blob<->canvas index (`file.ts`'s
 * `checkLocality`/blobId-write sites are what populate it) and purging
 * (plus cancelling the transfer) is skipped when any OTHER canvas still
 * has a ref recorded for the same blob — a fast indexed lookup instead of
 * scanning every known canvas, per the storage layer's own reference
 * index (see reliquary/ts's `blobs/db.ts` and reliquary/rust's
 * `blobz_canvas_refs` table). `canvasDocId` is the canvas this widget
 * lived on (the narthex itself, or a regular canvas).
 */
async function cleanUpFileWidgetBlob(
  docId: string,
  repo: Repo,
  canvasDocId: string
): Promise<void> {
  try {
    const handle = await resolveDocReadyCached<{ blobId?: string; blake3?: string }>(
      repo,
      docId as DocumentId
    );
    const doc = handle?.doc();
    const blobId = doc?.blobId;
    if (!blobId) return;
    const blake3 = doc?.blake3 || blobId;

    const locality = await checkBlobLocality(blobId, blake3);
    const isZeroByte = locality.locality === "local" && locality.metadata?.size === 0;

    await removeBlobCanvasRef(blobId, blake3, canvasDocId).catch(() => {
      // best-effort — index unavailable, fall through to the size check
    });

    if (!isZeroByte) {
      const remainingRefs = await getBlobCanvasRefs(blobId, blake3).catch(() => [] as string[]);
      if (remainingRefs.length > 0) {
        log.debug(
          TAG,
          "skipping blob cleanup — still referenced by another canvas:",
          blobId.slice(0, 12) + "...",
          remainingRefs
        );
        return;
      }
    }

    await pauseSnatchDownload({ blake3 }).catch(() => {
      // best-effort — no in-flight download to cancel, or not tauri mode
    });
    await freeUpLocalBlobCopy(blobId, blake3);
  } catch (err) {
    log.warn(TAG, "failed to clean up blob for deleted file widget:", err);
  }
}

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
  // a navigateToNarthex that arrived while another navigation was in flight.
  // without this, tapping home right after creating a canvas silently drops
  // the nav (the guard returned early and navigateToCanvas's replaceState
  // put the canvas hash back) — the confirmed root cause of the flaky
  // narthex reload e2e AND a real ux bug.
  private pendingNavToNarthex = false;
  /** cross-canvas navigation history (narthex excluded — narthex always
   *  resets this to empty via navigateToNarthex()), used to build the
   *  toolbar's ancestor breadcrumbs (see widget-manager.ts's
   *  `setAncestorCrumbs()`). pushed to in `navigateToCanvas()` right before
   *  tearing down the outgoing canvas, EXCEPT when the navigation was
   *  triggered by clicking an ancestor crumb itself (see
   *  `suppressNextHistoryPush`/`navigateToAncestorCrumb()`) — clicking a
   *  crumb means "go back to this point", not "go deeper". a canvas can be
   *  reached via more than one path (narthex, a canvas-card embedded on
   *  any other canvas via widgets/canvas-link-picker.ts, a share link) —
   *  all of them funnel through `window.location.hash = docId` and this
   *  single `navigateToCanvas()`, so this is the one place that needs
   *  instrumenting. capped to a modest length as a safety net against
   *  unbounded growth in a very long session; the toolbar only ever
   *  displays the last entry anyway (see `buildAncestorCrumbs()`). */
  private navHistory: Array<{ docId: string; title: string }> = [];
  /** max entries retained in `navHistory` — a generous safety cap, not a
   *  user-visible limit (the toolbar only ever shows the last one). */
  private static readonly MAX_NAV_HISTORY = 20;
  /** set by `navigateToAncestorCrumb()` right before it changes the hash,
   *  so the very next `navigateToCanvas()` run knows not to push the
   *  (now-leaving) canvas back onto `navHistory` — that would immediately
   *  re-grow the history it was just told to rewind. consumed (cleared) the
   *  moment `navigateToCanvas()` reads it. */
  private suppressNextHistoryPush = false;
  /** stashed by joinCanvasFromNarthex so navigateToCanvas can write it into the doc */
  private pendingPeerNodeId: string | null = null;
  /** the docId `joinCanvasFromNarthex()` is about to navigate to via
   *  `window.location.hash = ...`, stashed so `onHashChange()` can
   *  recognize this specific upcoming navigation as a fresh join (not
   *  necessarily the session's first navigation — the user may already be
   *  deep in the app when they open a share link) and treat it exactly
   *  like a cold open: short fast-fail timeout, and an access-request
   *  offer on failure (see `navigateToCanvas()`'s `coldOpen` handling and
   *  a real reported bug: joining a canvas we don't have ACL access to yet
   *  mid-session used the library's full ~60s default wait instead of the
   *  15s cold-open bound, AND never offered the "request access" pill on
   *  timeout, because `coldOpen` was only ever true for the very first
   *  navigation of the page load). consumed (cleared) the moment
   *  `onHashChange()` reads it, so it never affects a later, unrelated
   *  navigation to the same hash. */
  private pendingFreshJoinDocId: string | null = null;
  /** true only for the very first navigation resolved since boot (a cold
   *  page load) — flipped false the first time `onHashChange()` runs. a
   *  bare-hash navigation (no share/invite context) only gets the short
   *  fast-fail timeout (see `navigateToCanvas()`) while this is still true;
   *  in-app navigation (clicking a canvas card, going home and back) always
   *  gets the library's ordinary, much longer wait, since a real, slower
   *  sync over the network shouldn't get cut off early just because the
   *  user happens to be a few clicks into the app. */
  private isInitialNavigation = true;

  /** the docId of the most recent canvas navigation that failed to open
   *  (see `navigateToCanvas()`) — checked by `handleKnockApproved()` so a
   *  knock approval that arrives for exactly this canvas can retry opening
   *  it automatically instead of leaving the user to notice and manually
   *  retry. cleared on the next successful navigation to any canvas. */
  private lastFailedCanvasDocId: string | null = null;

  /** the loading-overlay element shown for the duration of a canvas
   *  navigation's async work (see `showNavSpinner()`/`hideNavSpinner()`) —
   *  without it, the mount element sits fully blank while automerge-repo's
   *  own sync wait runs, which reads to the user as the app being frozen
   *  rather than just loading. */
  private navSpinnerEl: HTMLDivElement | null = null;

  private friendzProtocol: FriendzProtocol | null = null;
  private friendzDocUnsubs: Array<() => void> = [];
  private socialDoc: SocialDoc | null = null;
  private messagezDocHandle: DocHandle<any> | null = null;
  /** the local peer's own profile doc (docs/hub-and-profile-plan.md section 6).
   *  created/opened once in boot() via ensureMyProfileDoc(); threaded into the
   *  social overlay's mount context so profile-tab.ts can manage the profile's
   *  curated canvas list. */
  private profileStore: ProfileStore | null = null;
  /** the narthex's own `CanvasStore`, resolved once (eagerly) in boot() —
   *  threaded into the social overlay's mount context so profile-tab.ts can
   *  add/remove widgets on the narthex directly, even while the overlay is
   *  mounted on top of some OTHER (non-narthex) canvas (see
   *  docs/narthex-widgets-and-file-transfer-plan.md section 1's "own
   *  canvas bin" auto-show wiring). safe to hold alongside whatever
   *  `CanvasStore` `navigateToNarthex()` separately constructs for the
   *  currently-open narthex view — both wrap the same underlying
   *  automerge `DocHandle` (repo.find()/CanvasStore.open() dedupe by
   *  documentId), so reads/writes through either stay consistent; this
   *  mirrors the existing "open narthex store on demand, distinct from
   *  `this.currentCanvas.store`" pattern already used by
   *  `acceptCanvasInvite()`/`initFriendzProtocol()`. */
  private narthexStore: CanvasStore | null = null;

  /** opened `CanvasStore`s for OTHER admin canvases, discovered while
   *  building `otherCanvasKnocks` sources (see
   *  `buildOtherCanvasKnocksSource()`) — keyed by canvasDocId. reading
   *  `pendingKnocks`/`.acl` for a canvas requires its doc to actually be
   *  synced first (`repo.handles[docId]` is only populated for a doc this
   *  peer has previously `repo.find()`'d/opened — e.g. by visiting it), so
   *  a passive check of `repo.handles` alone silently sees nothing for any
   *  admin canvas that hasn't been opened yet this session (a real
   *  reported bug: cross-canvas knocks only showed up after actually
   *  viewing that canvas first). shared across every `wireBadges()`/
   *  `mountMessagesOverlay()` call so the same canvas doesn't get opened
   *  redundantly by both. never evicted — a modest, bounded set (one entry
   *  per admin canvas), and automerge-repo already keeps the underlying
   *  `DocHandle` alive/cached for the app's lifetime regardless. */
  private otherCanvasStores = new Map<string, CanvasStore>();
  /** canvasDocIds currently being opened via `CanvasStore.open()` — guards
   *  against kicking off a duplicate open for the same doc from multiple
   *  concurrent `list()`/`onChange()` calls before the first resolves. */
  private otherCanvasOpenInFlight = new Set<string>();

  private transportPresenceUnsubs: Array<() => void> = [];
  private canvasWatcherUnsubs: Array<() => void> = [];
  private localNodeId: string = "";
  /** stable per-installation fallback id (see p2p/anon-device-id.ts), used
   *  in place of localNodeId for canvas ACL purposes when no real p2p
   *  identity exists yet — resolved once in boot(). */
  private anonDeviceId: string = "";
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

    // browser-mode outgoing-transfer-progress source (see
    // p2p/transfer-progress.ts's header comment) — a no-op in tauri mode
    // (getActiveTransfers() duck-types to `[]` there, same as
    // restrictBlobToPeers above), so this is safe to wire unconditionally.
    setBrowserTransferSource(() => getActiveTransfers(this.irohAdapter));

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
      if (!repoBox.repo) return "viewer";
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
      wrapNetworkAdapter: (iroh) => createAclFilteringAdapter(iroh, roleResolver),
    });
    repoBox.repo = harness.repo;

    return new SkeinRouter(mountElement, harness);
  }

  /** initial boot — resolve narthex doc id then navigate to the right place */
  async boot(): Promise<void> {
    // resolve local node ID early so hasIdentity is available at canvas init
    // time, and so effectiveLocalNodeId() is ready before narthex/canvas
    // creation below. uses getStoredIdentity() in BOTH modes — a cheap,
    // side-effect-free check that never generates a keypair or binds the
    // iroh endpoint, so simply booting the app never creates a P2P identity
    // on its own.
    if (!this.localNodeId) {
      try {
        const identity = await getStoredIdentity();
        this.localNodeId = identity?.node_id ?? "";
      } catch {
        // identity not ready yet
      }
    }
    this.anonDeviceId = await getOrCreateAnonDeviceId();

    // peedeeeff (document viewer) needs the rust-side `magick` binary to
    // render pages locally — hide it from the flyout entirely when it's
    // missing in tauri mode, rather than letting users add a widget that
    // can never render anything on its own. browser peers can still add it
    // — they ask a hub/tauri peer to render on their behalf over the
    // skein/1 proxy protocol (see peedeeeff/index.ts's handleUpload /
    // resumeProcessingIfNeeded) — so this check doesn't apply to them.
    // best-effort: a dispatch failure here must not block boot, so
    // peedeeeff just stays visible and fails per-widget instead.
    if (isTauriMode()) {
      try {
        const result = await dispatch("pdf_check_available");
        if (!result?.available) {
          peedeeeffWidget.metadata.hidden = true;
        }
      } catch (err) {
        log.debug(TAG, "pdf_check_available dispatch failed (non-fatal):", err);
      }

      // additional-formats probe (epub/docx/odt/rtf/md/html) — purely
      // additive, doesn't affect the hard pdf/ps/txt gate above. browser
      // mode always offers the broader list (see file-utils.ts's default),
      // since rendering there is delegated to a peer regardless.
      try {
        const result = await dispatch("pandoc_check_available");
        setPandocFormatsAvailable(!!result?.available);
      } catch (err) {
        log.debug(TAG, "pandoc_check_available dispatch failed (non-fatal):", err);
      }
    }


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

    // self-heal every canvas this peer owns (narthex included) that's
    // missing an admin stamp, or still stamped under the anonymous device
    // id after a real identity has since been established — covers both
    // this fix's own gap and canvases created before it existed. runs in
    // the background; doesn't block boot.
    this.healOwnedCanvases().catch((err) => {
      log.warn(TAG, "failed to heal owned canvases:", err);
    });

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

    // resolve the narthex's own CanvasStore once, eagerly \u2014 so any UI
    // wired through the social overlay (mounted on any canvas, not just
    // the narthex) can reach the narthex directly without a network
    // round-trip mid-interaction. see this field's own doc comment above
    // for why holding a second CanvasStore instance alongside whatever
    // navigateToNarthex() separately constructs is safe.
    if (!this.narthexStore) {
      try {
        this.narthexStore = await CanvasStore.open(this.repo, this.narthexDocId as DocumentId);
      } catch (err) {
        log.warn(TAG, "failed to open narthex store:", err);
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
        // migrate admin off the anonymous device id, for every canvas this
        // peer owns, onto the real identity that just became available —
        // otherwise canvases created before this identity existed would be
        // permanently stuck admin-stamped under the now-unused anon id.
        this.healOwnedCanvases().catch((err) => {
          log.warn(TAG, "failed to heal owned canvases after identity change:", err);
        });
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

    // register ALPN handlers early so the browser can serve blobs
    // to peers regardless of friendz protocol initialization state.
    // (friendz-wiring.ts also registers these, but that happens later and
    // only when navigating to the narthex with a valid identity.)
    if (!isTauriMode()) {
      this.irohAdapter.registerAlpnHandler("skein/1", handleSkeinStream);
      this.irohAdapter.registerAlpnHandler(DEFAULT_ENSURE_ALPN, createSkeinEnsureBlobHandler());
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

    // listen for the link-canvas event dispatched from the canvas-link-picker
    // widget (widgets/canvas-link-picker.ts) — adds a canvas-card widget
    // pointing at an already-known canvas to whatever canvas is currently open.
    window.addEventListener("skein:link-canvas", ((e: CustomEvent) => {
      this.linkCanvasToCurrent(e.detail);
    }) as EventListener);

    // listen for accept-canvas-invite event dispatched from the inbox widget
    window.addEventListener("skein:accept-canvas-invite", ((e: CustomEvent) => {
      this.acceptCanvasInvite(e.detail).catch((err) => {
        log.warn(TAG, "failed to accept canvas invite:", err);
      });
    }) as EventListener);

    // listen for the request-canvas-access event dispatched from a
    // narthex canvas-card's "request access" pill (widgets/narthex/canvas-card.ts)
    window.addEventListener("skein:request-canvas-access", ((e: CustomEvent) => {
      const { canvasDocId, ownerNodeId, hubNodeIds } = e.detail ?? {};
      if (typeof canvasDocId === "string" && typeof ownerNodeId === "string") {
        this.requestCanvasAccess(
          canvasDocId,
          ownerNodeId,
          Array.isArray(hubNodeIds) ? hubNodeIds : []
        ).catch((err) => {
          log.warn(TAG, "failed to request canvas access:", err);
        });
      }
    }) as EventListener);

    // listen for the canvas-card-trashed event dispatched from
    // trashCanvasCard() (widgets/narthex/trash-widget.ts) once a narthex
    // canvas card has been soft-deleted — clears any now-stale outbox
    // entries for that canvas.
    window.addEventListener("skein:canvas-card-trashed", ((e: CustomEvent) => {
      const { canvasDocId } = e.detail ?? {};
      if (typeof canvasDocId === "string") {
        this.clearOutboxForCanvas(canvasDocId);
      }
    }) as EventListener);

    // listen for the retry-canvas-access-request event dispatched from
    // either the canvas-card pill or the messagez outbox's "resend" button
    // (widgets/narthex/messagez-widget.ts) for a not-yet-acked pending
    // access request.
    window.addEventListener("skein:retry-canvas-access-request", ((e: CustomEvent) => {
      const { canvasDocId } = e.detail ?? {};
      if (typeof canvasDocId === "string") {
        this.retryCanvasAccessRequest(canvasDocId).catch((err) => {
          log.warn(TAG, "failed to retry canvas access request:", err);
        });
      }
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
    const isColdOpen = this.isInitialNavigation;
    this.isInitialNavigation = false;

    if (!hash || hash === this.narthexDocId) {
      // empty hash or explicit narthex hash → go to narthex
      await this.navigateToNarthex();
      // only on the very first navigation of this page load — see
      // maybeAutoOpenSocialForNewUser()'s doc comment for why this never
      // re-triggers on a later manual visit back to the narthex.
      if (isColdOpen) this.maybeAutoOpenSocialForNewUser();
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
        // same cold-open-only auto-open as the bare-hash branch above — see
        // maybeAutoOpenSocialForNewUser()'s doc comment. called BEFORE
        // joinCanvasFromNarthex() so its "does the user already have any
        // canvases" check runs against the pre-join state, not the pending
        // placeholder card joinCanvasFromNarthex() is about to plant.
        if (isColdOpen) this.maybeAutoOpenSocialForNewUser();
        await this.joinCanvasFromNarthex({ shareString: hash });
      } else {
        log.warn(TAG, "invalid share URL:", hash.slice(0, 32) + "...");
        await this.navigateToNarthex();
      }
    } else {
      // non-empty hash → open that canvas. fail fast (rather than waiting
      // out automerge-repo's full ~60-120s default) whenever this is a cold
      // open (see isInitialNavigation's doc comment), a fresh share-link
      // join (see `pendingFreshJoinDocId`'s doc comment — we may not have
      // ACL access to this canvas yet at all), OR there's no local
      // identity at all — with no identity there's no p2p endpoint
      // running, so a canvas that isn't already stored locally can never
      // arrive no matter how long we wait. a canvas already known locally
      // (e.g. one the user created) still resolves near-instantly
      // regardless of this timeout, so this never affects opening one's
      // own canvases.
      const identity = await getStoredIdentity();
      const isFreshJoin = this.pendingFreshJoinDocId === hash;
      this.pendingFreshJoinDocId = null;
      await this.navigateToCanvas(hash, { coldOpen: isColdOpen || isFreshJoin || !identity });
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
      const narthexHandle = await resolveDocReadyCached<CanvasDocument>(
        this.repo,
        this.narthexDocId as DocumentId
      );
      if (!narthexHandle) return;
      const narthexDoc = narthexHandle.doc();
      if (!narthexDoc?.widgets) return;

      for (const entry of Object.values(narthexDoc.widgets)) {
        if (
          entry.type === "canvas-card" &&
          (entry.props as any)?.canvasDocId === currentHash &&
          entry.docId
        ) {
          const cardHandle = await resolveDocReadyCached<any>(this.repo, entry.docId as DocumentId);
          if (!cardHandle) break;
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

  /**
   * show a lightweight loading overlay in the mount element for the
   * duration of a canvas navigation's async work — reuses the boot
   * spinner's own css (`.spinner-ring`/`@keyframes boot-spin`, defined in
   * index.html) rather than defining a second copy. without this, the
   * mount element sits fully blank (no pixi canvas painted yet) for as
   * long as automerge-repo's own sync wait takes — which can legitimately
   * be a while for a real, slower sync (see `isInitialNavigation`'s doc
   * comment on why in-app navigation deliberately doesn't get a short
   * fast-fail timeout) — and reads to the user as the app being frozen
   * rather than just loading.
   */
  /**
   * @param onCancel when given, renders a "cancel" button below the spinner
   *   that invokes it — used by `navigateToCanvas()` to let the user bail
   *   out of a stuck/slow open and return to the narthex instead of waiting
   *   out the full sync timeout (which can legitimately be a while, see
   *   `isInitialNavigation`'s doc comment).
   */
  private showNavSpinner(onCancel?: () => void): void {
    if (this.navSpinnerEl) return;
    // on a cold open straight to a canvas hash (e.g. a page reload while
    // viewing a canvas), the css-only boot spinner (index.html) is still
    // showing at this point — `initCanvas()`'s own removal of it doesn't
    // run until well after this, once the pixi canvas actually mounts. both
    // overlays share the same centered, transparent-background layout, so
    // leaving the boot spinner in place here would visually overlap this
    // one instead of being cleanly replaced by it. safe to call
    // unconditionally: a no-op once the element is already gone.
    document.getElementById("boot-spinner")?.remove();
    const el = document.createElement("div");
    el.id = "canvas-nav-spinner";
    el.style.cssText =
      "position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;" +
      "justify-content:center;gap:12px;color:#666678;font-family:system-ui,sans-serif;" +
      "font-size:13px;z-index:1000;";
    const ring = document.createElement("div");
    ring.className = "spinner-ring";
    const label = document.createElement("div");
    label.textContent = "loading canvas…";
    el.appendChild(ring);
    el.appendChild(label);
    if (onCancel) {
      const cancelBtn = document.createElement("button");
      cancelBtn.textContent = "cancel";
      cancelBtn.style.cssText =
        "margin-top:4px;padding:6px 16px;border-radius:6px;border:1px solid #444458;" +
        "background:transparent;color:#a0a0b8;font-family:system-ui,sans-serif;" +
        "font-size:13px;cursor:pointer;";
      cancelBtn.addEventListener("click", onCancel);
      el.appendChild(cancelBtn);
    }
    this.mountElement.appendChild(el);
    this.navSpinnerEl = el;
  }

  /** remove the loading overlay shown by `showNavSpinner()`, if present. */
  private hideNavSpinner(): void {
    this.navSpinnerEl?.remove();
    this.navSpinnerEl = null;
  }

  /**
   * the node id to use for local ACL purposes on any canvas — a real p2p
   * identity if one exists, else the persisted anonymous device id (see
   * p2p/anon-device-id.ts). always non-empty once boot() has resolved
   * both, so `CanvasStore.stampAdmin()`/`setLocalNodeId()` always have a
   * usable id even for a peer that hasn't set up a real identity yet.
   */
  private effectiveLocalNodeId(): string {
    return this.localNodeId || this.anonDeviceId;
  }

  /**
   * self-heal every canvas this peer created themselves: stamp an admin
   * if none is recorded yet, and migrate an existing admin stamp off the
   * anonymous device id onto a real identity once one exists.
   *
   * safe to run unconditionally because sharing/joining a canvas requires
   * a real p2p identity (see registerAndReconnectPeers()'s identity
   * guard) — so every canvas this peer's own narthex links to with
   * `isRemote !== true` was, by construction, created locally by this
   * same peer (see linkCanvasToCurrent()'s doc comment on isRemote), and
   * the narthex itself is a private, per-install singleton never synced
   * to any other peer. `stampAdmin()`/`migrateAdminId()` are both no-ops
   * when there's nothing to change, so this is safe to call repeatedly
   * (every boot, and again whenever a real identity is established) —
   * this doubles as the retroactive fix for canvases created under the
   * older, buggy version of this code that skipped stamping an admin for
   * an anonymous creator.
   */
  private async healOwnedCanvases(): Promise<void> {
    if (!this.narthexDocId) return;
    const effectiveId = this.effectiveLocalNodeId();

    const narthexHandle = await resolveDocReadyCached<CanvasDocument>(
      this.repo,
      this.narthexDocId as DocumentId
    );
    if (!narthexHandle) return;

    const narthexStore = await CanvasStore.open(this.repo, this.narthexDocId as DocumentId);
    narthexStore.stampAdmin(effectiveId);
    if (this.localNodeId) {
      narthexStore.migrateAdminId(this.anonDeviceId, this.localNodeId);
    }

    const narthexDoc = narthexHandle.doc();
    if (!narthexDoc?.widgets) return;

    for (const entry of Object.values(narthexDoc.widgets)) {
      if (entry.type !== "canvas-card") continue;
      const props = entry.props as { canvasDocId?: string; isRemote?: boolean } | undefined;
      if (!props?.canvasDocId || props.isRemote === true) continue;
      try {
        const store = await CanvasStore.open(this.repo, props.canvasDocId as DocumentId);
        store.stampAdmin(effectiveId);
        if (this.localNodeId) {
          store.migrateAdminId(this.anonDeviceId, this.localNodeId);
        }
      } catch (err) {
        log.warn(TAG, "failed to heal owned canvas:", props.canvasDocId, err);
      }
    }
  }

  /** navigate to the narthex */
  private async navigateToNarthex(): Promise<void> {
    if (this.navigating) {
      // queue it — the in-flight navigation's finally block re-fires it
      this.pendingNavToNarthex = true;
      return;
    }
    this.navigating = true;
    this.pendingNavToNarthex = false;

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

      // landing on the narthex resets cross-canvas navigation history —
      // whatever the user does next starts a fresh breadcrumb trail.
      this.navHistory = [];

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
      canvas.store.setLocalNodeId(this.effectiveLocalNodeId());
      // the narthex is a private, per-install singleton never synced to
      // any other peer, so it's always safe to self-heal its admin stamp
      // here — idempotent no-op once a real admin is already recorded
      // (see healOwnedCanvases(), which covers the same ground on boot).
      canvas.store.stampAdmin(this.effectiveLocalNodeId());
      if (this.localNodeId) {
        canvas.presenceManager.setLocalNodeId(this.localNodeId);
      }
      canvas.toolbar.refreshRoleGating();
      (window as any).__skein = canvas;

      // when a canvas-card is deleted from the narthex, clean up the linked
      // canvas document and all its per-widget docs from IndexedDB.
      canvas.widgetManager.setBeforeRemoveHook(async (entry, repo) => {
        if (entry.type === "file" && entry.docId && this.narthexDocId) {
          await cleanUpFileWidgetBlob(entry.docId, repo, this.narthexDocId);
        }
        if (entry.type !== "canvas-card" || !entry.docId) return;
        try {
          const cardHandle = await resolveDocReadyCached<Record<string, unknown>>(
            repo,
            entry.docId as DocumentId
          );
          if (!cardHandle) return;
          const cardDoc = cardHandle.doc();
          const canvasDocId = cardDoc?.canvasDocId;
          if (!canvasDocId || typeof canvasDocId !== "string") return;

          // open the linked canvas and delete all its widget docs
          const canvasHandle = await resolveDocReadyCached<CanvasDocument>(
            repo,
            canvasDocId as DocumentId
          );
          if (!canvasHandle) return;
          const canvasDoc = canvasHandle.doc();
          if (canvasDoc?.widgets) {
            for (const w of Object.values(canvasDoc.widgets)) {
              if (w.type === "file" && w.docId) {
                await cleanUpFileWidgetBlob(w.docId, repo, canvasDocId);
              }
              if (w.docId) {
                try {
                  repo.delete(w.docId as DocumentId);
                } catch {
                  // best-effort
                }
              }
            }
          }

          // safety net: cleanUpFileWidgetBlob above already drops each
          // widget's own ref, but a bulk sweep for the whole canvas doc id
          // catches anything that failed mid-loop (best-effort try/catch
          // per widget above) rather than leaving orphaned index rows.
          await removeAllBlobCanvasRefs(canvasDocId).catch(() => {
            // best-effort — index unavailable
          });

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
      // a home-tap queued while already navigating home is satisfied by
      // this navigation — consume it
      this.pendingNavToNarthex = false;
    }
  }

  /**
   * on a brand new install — no identity generated yet, and no *owned*
   * canvases created yet — auto-opens the social panel on the narthex so
   * setting up a profile and generating an identity is the first thing a
   * new user sees, rather than an empty narthex with no obvious next
   * step. only ever called from the initial cold-boot navigation (see
   * `isColdOpen`/`isInitialNavigation` in `onHashChange()`) — closing the
   * panel afterward, or navigating away and back to the narthex, never
   * reopens it on its own, even if the user still hasn't finished setup.
   * called from both the bare-hash and the `#share/...` cold-open
   * branches — a brand-new user arriving via a share link needs this
   * just as much as one arriving at a bare `skein.freqhole.net`.
   *
   * only counts cards where `isRemote` is falsy — a pending placeholder
   * card planted by `joinCanvasFromNarthex()` (share-link join, possibly
   * before an identity even exists) is exactly the "no obvious next
   * step" case this exists to help with, not evidence the user is past
   * needing it. an owned canvas-card (created by the user themselves) is
   * the only thing that should count as "not a brand new user".
   */
  private maybeAutoOpenSocialForNewUser(): void {
    if (this.localNodeId) return; // identity already generated
    if (!this.currentSocialOverlay || this.currentSocialOverlay.isOpen) return;
    const hasOwnedCanvases = this.currentCanvas?.store
      .allWidgets()
      .some((w) => w.type === "canvas-card" && !(w.props as Record<string, unknown>)?.isRemote);
    if (hasOwnedCanvases) return;
    const sw = window.visualViewport?.width ?? window.innerWidth;
    this.currentMessagesOverlay?.close();
    this.currentSocialOverlay.toggle(sw);
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
      narthexDocId: this.narthexDocId ?? undefined,
      messagezHandle: this.messagezDocHandle,
      sDoc: this.socialDoc ?? undefined,
      onKnockRelayed: (info) => recordKnockRelay(info),
      onKnockAcked: (info) => recordKnockAck(info),
      onKnockApproved: (info) => {
        this.handleKnockApproved(info).catch((err) => {
          log.warn(TAG, "failed to handle knock approval:", err);
        });
      },
    });

    // same idea, but for `protocol.onFriendAccept` — re-registers it with
    // `onFriendAccepted` wired in so a friend-accept from a share-link hub
    // can be correlated against a pending canvas access-request's
    // `hubNodeIds` and recorded as a "hub ack" (see
    // `requestCanvasAccess()`'s doc comment above for why a hub
    // friend-accept counts as an ack at all).
    if (this.socialDoc) {
      wireFriendHandlers({
        protocol: result.protocol,
        sDoc: this.socialDoc,
        profileStore: this.profileStore ?? undefined,
        onFriendAccepted: (fromNodeId) => {
          if (!this.messagezDocHandle) return;
          const ackedCanvasIds: string[] = [];
          this.messagezDocHandle.change((draft: any) => {
            for (const req of draft.accessRequests ?? []) {
              if (req.status === "cancelled" || req.hubAcked) continue;
              if (!Array.isArray(req.hubNodeIds) || !req.hubNodeIds.includes(fromNodeId)) continue;
              req.hubAcked = true;
              req.hubAckedNodeId = fromNodeId;
              req.hubAckedAt = new Date().toISOString();
              ackedCanvasIds.push(req.canvasDocId);
            }
          });
          for (const canvasDocId of ackedCanvasIds) {
            recordHubAck({ canvasDocId, hubNodeId: fromNodeId });
            log.debug(TAG, "hub ack recorded via friend-accept from:", fromNodeId.slice(0, 16) + "...");
          }
        },
      });
    }

    // backfill the session-only ack/hub-id bridge state (friendz-bridge.ts)
    // from what's already persisted in the messagez doc — without this, a
    // reload would make an already-delivered/hub-acked request look
    // unresolved again (the bridge's `knockAckedCanvasIds`/`hubAckedCanvasIds`
    // sets start empty every session) until a fresh ack happened to arrive.
    for (const req of (this.messagezDocHandle?.doc()?.accessRequests ?? []) as Array<{
      knockId: string;
      canvasDocId: string;
      delivered?: boolean;
      ackerNodeId?: string;
      hubAcked?: boolean;
      hubAckedNodeId?: string;
      hubNodeIds?: string[];
    }>) {
      if (req.delivered) {
        recordKnockAck({
          knockId: req.knockId,
          canvasDocId: req.canvasDocId,
          ackerNodeId: req.ackerNodeId ?? "",
        });
      }
      if (req.hubAcked) {
        recordHubAck({ canvasDocId: req.canvasDocId, hubNodeId: req.hubAckedNodeId ?? "" });
      }
      if (req.hubNodeIds?.length) recordKnownHubNodeIds(req.hubNodeIds);
    }

    // best-effort re-delivery, a short while from now (not inline here —
    // see `BOOT_RETRY_DELAY_MS`'s doc comment), for anything still
    // unacknowledged from a previous session. `initFriendzProtocol()` only
    // ever runs this far once per successful init (the early-return guard
    // at the top of this method), so this can't stack multiple timers.
    setTimeout(() => {
      this.retryUnacknowledgedOutboundOnBoot().catch((err) => {
        log.warn(TAG, "boot-time unacknowledged-outbound retry failed:", err);
      });
    }, BOOT_RETRY_DELAY_MS);
  }

  /**
   * re-attempt delivery for anything still sitting unacknowledged from a
   * previous session:
   *  - a canvas access-request (knock) that hasn't been delivered or
   *    hub-acked yet — retried via `requestCanvasAccess()`, which already
   *    reuses the same knockId/outbox entry rather than minting a new one
   *    (see its own doc comment), and also re-sends a friend request to
   *    the owner/hub(s) along the way.
   *  - any OTHER outbound friend request still `status: "pending"` in the
   *    social doc (`outboundRequests`) not already covered by the above —
   *    e.g. a plain friend request with no associated canvas knock at all.
   *
   * this deliberately does not go through `retryCanvasAccessRequest()`'s
   * manual-resend path (its `wasManuallyRetried()` one-shot-per-session
   * guard is meant for the messagez outbox's user-facing "resend" button,
   * not this automatic startup sweep) or `markManuallyRetried()` (doing so
   * would leave that button looking already-used the first time a user
   * actually clicks it this session).
   */
  private async retryUnacknowledgedOutboundOnBoot(): Promise<void> {
    if (!this.friendzProtocol) return;

    // node ids already given a fresh friend-request attempt via the knock
    // retry loop below — skipped in the plain-friend-request loop after it
    // so a peer that's both a canvas owner/hub AND has a bare pending
    // friend request doesn't get dialed twice in the same sweep.
    const attemptedNodeIds = new Set<string>();

    const pendingAccessRequests = (
      (this.messagezDocHandle?.doc()?.accessRequests ?? []) as Array<{
        canvasDocId: string;
        ownerNodeId: string;
        hubNodeIds?: string[];
        delivered?: boolean;
        hubAcked?: boolean;
        status?: string;
      }>
    ).filter((r) => !r.delivered && !r.hubAcked && r.status !== "cancelled" && r.status !== "expired");

    for (const req of pendingAccessRequests) {
      attemptedNodeIds.add(req.ownerNodeId);
      for (const hubNodeId of req.hubNodeIds ?? []) attemptedNodeIds.add(hubNodeId);
      try {
        await this.requestCanvasAccess(req.canvasDocId, req.ownerNodeId, req.hubNodeIds ?? []);
      } catch (err) {
        log.debug(TAG, "boot-time knock retry failed for:", req.canvasDocId, err);
      }
    }

    const pendingFriendRequests = (
      (this.socialDoc?.current.outboundRequests ?? []) as Array<{
        toNodeId: string;
        toUsername?: string;
        status?: string;
      }>
    ).filter((r) => r.status === "pending" && !attemptedNodeIds.has(r.toNodeId));

    for (const req of pendingFriendRequests) {
      try {
        await sendFriendRequest(req.toNodeId, req.toUsername || undefined);
      } catch (err) {
        log.debug(TAG, "boot-time friend-request retry failed for:", req.toNodeId, err);
      }
    }

    if (pendingAccessRequests.length || pendingFriendRequests.length) {
      log.debug(
        TAG,
        "boot-time retry: resent",
        pendingAccessRequests.length,
        "access request(s) and",
        pendingFriendRequests.length,
        "plain friend request(s)"
      );
    }
  }

  /**
   * react to a `canvas-knock-approve` notification: clear the narthex
   * card's access-pending pill now that access was actually granted, and
   * if the user is currently sitting on the narthex having just failed to
   * open exactly this canvas (see `lastFailedCanvasDocId`), retry opening
   * it automatically instead of leaving them to notice and manually
   * retry. deliberately does NOT yank the user away from some other
   * canvas they're actively using, even if it happens to also have a
   * stale access-pending pill — only the narthex-and-just-failed case
   * auto-navigates.
   */
  private async handleKnockApproved(info: { canvasDocId: string; role: InvitableRole }): Promise<void> {
    if (this.narthexDocId) {
      try {
        const narthexStore = await CanvasStore.open(this.repo, this.narthexDocId as DocumentId);
        for (const entry of narthexStore.allWidgets()) {
          if (entry.type !== "canvas-card") continue;
          const props = entry.props as { canvasDocId?: string; accessPending?: boolean } | undefined;
          if (props?.canvasDocId !== info.canvasDocId || !props.accessPending) continue;
          await narthexStore.updateWidgetProps(entry.id, {
            accessPending: false,
            accessRequestedAt: "",
          });
          break;
        }
      } catch (err) {
        log.warn(TAG, "failed to clear access-pending pill after knock approval:", err);
      }
    }

    const onNarthex = this.currentCanvas?.store.handle.documentId === this.narthexDocId;
    if (onNarthex && this.lastFailedCanvasDocId === info.canvasDocId) {
      log.debug(TAG, "access granted for previously-failed canvas, retrying:", info.canvasDocId);
      this.lastFailedCanvasDocId = null;
      await this.navigateToCanvas(info.canvasDocId);
    }
  }

  /** build the toolbar's ancestor breadcrumbs from `navHistory` — bounded
   *  to at most one clickable crumb (the immediate parent canvas) plus a
   *  leading non-clickable "..." whenever there's deeper history, per the
   *  "narthex + last 2 canvases max" spec (narthex crumb + this one +
   *  the current canvas's own title crumb, both rendered separately by
   *  widget-manager.ts's `updateBreadcrumbs()`). */
  private buildAncestorCrumbs(): BreadcrumbItem[] {
    if (this.navHistory.length === 0) return [];

    const crumbs: BreadcrumbItem[] = [];
    if (this.navHistory.length > 1) {
      crumbs.push({ label: "..." });
    }
    const parent = this.navHistory[this.navHistory.length - 1];
    crumbs.push({
      label: parent.title,
      onClick: () => this.navigateToAncestorCrumb(parent.docId),
    });
    return crumbs;
  }

  /** clicking an ancestor crumb means "go back to this point" — rewind
   *  `navHistory` to just before that ancestor (dropping it and anything
   *  deeper, since those are all now the outgoing side of the upcoming
   *  navigation, not history), then change the hash to trigger the normal
   *  onHashChange() -> navigateToCanvas() path. */
  private navigateToAncestorCrumb(docId: string): void {
    const idx = this.navHistory.findIndex((entry) => entry.docId === docId);
    if (idx === -1) return;
    this.navHistory = this.navHistory.slice(0, idx);
    this.suppressNextHistoryPush = true;
    window.location.hash = docId;
  }

  /** navigate to a specific canvas by document id */
  private async navigateToCanvas(docId: string, opts?: { coldOpen?: boolean }): Promise<void> {
    if (this.navigating) return;
    this.navigating = true;

    // a genuine failure to open the requested canvas (e.g. it's truly
    // unreachable/never arrives — see CanvasStore.open()'s doc comment for
    // the recoverable cases this no longer treats as terminal) must not
    // propagate as an uncaught rejection: `destroyCurrent()` below already
    // tore down whatever was previously mounted by the time `initCanvas()`
    // could throw, so an uncaught failure here leaves the app with *nothing*
    // mounted at all — a real, user-reported crash ("everything turns black").
    // caught below and recovered by falling back to the narthex, same as
    // clicking the home button would.
    let failure: unknown = null;
    // true only when the failure above is the user clicking "cancel" on the
    // nav spinner (see showNavSpinner's onCancel below), not a genuine
    // open failure — suppresses the error log and the unreachable-canvas
    // access-request offer, both of which would be misleading here.
    let cancelledByUser = false;

    try {
      // stamp lastVisitedAt before tearing down so own edits aren't flagged
      await this.stampLastVisitedOnCurrentCanvas();

      // flush pending canvas update notifications to peers before leaving
      this.flushCanvasUpdates?.();

      // push the outgoing canvas onto the cross-canvas nav history before
      // tearing it down — unless this navigation is itself the result of
      // clicking an ancestor crumb (that path already rewound history to
      // where it needs to be; pushing here would immediately re-grow it).
      if (!this.suppressNextHistoryPush && this.currentCanvas) {
        const outgoingDocId = this.currentCanvas.store.handle.documentId;
        const isOutgoingNarthex = outgoingDocId === this.narthexDocId;
        if (!isOutgoingNarthex && outgoingDocId !== docId) {
          const outgoingTitle = this.currentCanvas.store.metadata().title || "untitled canvas";
          this.navHistory.push({ docId: outgoingDocId, title: outgoingTitle });
          if (this.navHistory.length > SkeinRouter.MAX_NAV_HISTORY) {
            this.navHistory.shift();
          }
        }
      }
      this.suppressNextHistoryPush = false;

      this.destroyCurrent();

      // ensure the hash is set (for reload persistence)
      if (window.location.hash.slice(1) !== docId) {
        history.replaceState(null, "", `#${docId}`);
      }

      log.debug(TAG, "navigating to canvas:", docId);

      const abortController = new AbortController();
      this.showNavSpinner(() => {
        cancelledByUser = true;
        abortController.abort();
      });

      const canvas = await initCanvas({
        mountElement: this.mountElement,
        canvasDocId: docId,
        registry: createTestRegistry(),
        repo: this.repo,
        connectionStateSource: this.connectionStateSource,
        openTimeoutMs: opts?.coldOpen ? COLD_OPEN_TIMEOUT_MS : undefined,
        openAbortSignal: abortController.signal,
        restrictBlobToPeers: (blake3Hash, peerNodeIds) =>
          restrictBlobToPeers(this.irohAdapter, blake3Hash, peerNodeIds),
        onNavigateHome: () => {
          log.debug(TAG, "home button clicked, navigating to narthex");
          window.location.hash = "";
        },
        ancestorCrumbs: this.buildAncestorCrumbs(),
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

          // persists across dialog rebuilds (see `rebuild()` below) so
          // flipping the toggle doesn't reset itself the next time the
          // canvas doc changes. default true: a canvas explicitly shared
          // with a hub includes it in the link unless the sharer opts out.
          let includeHubsInLink = true;

          // recomputes the full options object fresh from current doc state
          // each time it's called — see the onChange subscriptions below
          // `showShareDialog()`'s call site, which call this again (and
          // rebuild the dialog) whenever the canvas doc or messagez outbox
          // changes, instead of leaving the dialog showing a stale snapshot
          // until the user manually closes and reopens it (a real reported
          // bug: pending-invite/role/accepted-state changes never showed up
          // in an already-open share dialog).
          const buildShareOptions = (): ShareDialogOptions => {
          // self-heal canvases where a hub friend ended up as a peer
          // through any path other than the manual "invite friend" button
          // (auto-accepted reciprocal request, friend-accept message,
          // profile-response correcting isHub, or just already being a
          // synced peer) — see `CanvasStore.reconcileHubNodeIds()`'s doc
          // comment. cheap/no-op when there's nothing to backfill, so
          // safe to run on every dialog (re)build.
          this.currentCanvas!.store.reconcileHubNodeIds(this.socialDoc?.current?.friends ?? []);
          // hub node ids this canvas has been explicitly shared with (see
          // canvas-doc.ts's `hubNodeIds`) — recomputed fresh each rebuild so
          // the link picks up a hub invited *after* the dialog was opened,
          // even while that invite is still pending (delivery to the hub is
          // best-effort/gossip-relayed, same as any other invite).
          const canvasHubNodeIds = this.currentCanvas!.store.doc().hubNodeIds ?? [];
          const shareUrl = buildShareUrl(
            identity.node_id,
            docId,
            this.currentCanvas!.store.doc().title,
            includeHubsInLink ? canvasHubNodeIds : undefined,
            this.friendzProtocol?.getLocalUsername() ?? undefined
          );

          // build peer list from canvas doc (exclude self)
          const peersRecord = this.currentCanvas!.store.peers();
          log.debug(
            TAG,
            "share dialog: raw peers map from canvas doc",
            "docId=" + docId,
            "self=" + identity.node_id,
            "keys=" + JSON.stringify(Object.keys(peersRecord)),
            "hubNodeIds=" + JSON.stringify(this.currentCanvas!.store.doc().hubNodeIds ?? [])
          );
          // known friends by nodeId, for avatar/online lookups on already-
          // joined peers below (a peer may or may not be a confirmed friend)
          const friendByNodeId = new Map<
            string,
            { username?: string; avatarDataUrl?: string; bio?: string }
          >();
          if (this.socialDoc?.current?.friends) {
            for (const friend of this.socialDoc.current.friends) {
              for (const n of friend.nodeIds ?? []) {
                if (!n.nodeId) continue;
                friendByNodeId.set(n.nodeId, {
                  username: friend.alias || n.username || friend.username,
                  avatarDataUrl: n.avatarDataUrl,
                  bio: n.bio,
                });
              }
            }
          }
          const peerList = Object.values(peersRecord)
            .filter((p) => {
              // `store.peers()` normalizes nodeId to a plain string (see
              // `automerge-values.ts` — this guard used to silently DROP
              // any peer whose nodeId came back as an automerge
              // `ImmutableString` instance instead of a plain string,
              // which is exactly what happened to every hub-authored peer
              // entry and was the root cause of the hub disappearing from
              // this dialog). kept only as a defensive last-resort log in
              // case normalization is ever bypassed — no longer drops the
              // entry.
              if (typeof p.nodeId !== "string") {
                log.warn(
                  TAG,
                  "share dialog: peer entry has non-string nodeId (should not happen after normalizeCanvasDoc):",
                  typeof p.nodeId,
                  JSON.stringify(p)
                );
              }
              return String(p.nodeId) !== identity.node_id;
            })
            .map((p) => ({
              nodeId: String(p.nodeId),
              joinedAt: String(p.joinedAt ?? ""),
              role: this.currentCanvas!.store.getRole(String(p.nodeId)),
              avatarDataUrl: friendByNodeId.get(String(p.nodeId))?.avatarDataUrl,
              isOnline: this.friendzProtocol?.isOnline(String(p.nodeId)) ?? false,
              bio: friendByNodeId.get(String(p.nodeId))?.bio,
            }));
          log.debug(
            TAG,
            "share dialog: final peerList after filtering self/non-string nodeIds",
            "count=" + peerList.length,
            "nodeIds=" + JSON.stringify(peerList.map((p) => p.nodeId))
          );

          // build friends list for invite picker — exclude already shared
          const peerNodeIds = new Set(peerList.map((p) => p.nodeId));
          const friendsForInvite: FriendInfo[] = [];

          if (this.socialDoc) {
            const friendsState = this.socialDoc.current;

            // get already-invited node IDs from messagez outbox.
            // excludes declined shares — a friend who declined should be
            // re-invitable, not permanently stuck off the invite list.
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
                    bio: n.bio,
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
                  avatarDataUrl: req.fromAvatarDataUrl,
                  bio: req.fromBio,
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
            hubNodeIds: canvasHubNodeIds,
            includeHubsInLink,
            onToggleIncludeHubs: (include: boolean) => {
              includeHubsInLink = include;
              rebuild();
            },
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
                  const narthexHandle = await resolveDocReadyCached<CanvasDocument>(
                    this.repo,
                    this.narthexDocId as DocumentId
                  );
                  const narthexDoc = narthexHandle?.doc();
                  if (narthexDoc?.widgets) {
                    for (const entry of Object.values(narthexDoc.widgets)) {
                      if (
                        entry.type === "canvas-card" &&
                        (entry.props as any)?.canvasDocId === docId &&
                        entry.docId
                      ) {
                        const cardHandle = await resolveDocReadyCached<Record<string, unknown>>(
                          this.repo,
                          entry.docId as DocumentId
                        );
                        const cardDoc = cardHandle?.doc();
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
                    toAvatarDataUrl: friend.avatarDataUrl ?? "",
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
                // a friend invited from the "hub nodes" section is a known
                // reliquary hub — record it in the canvas's `hubNodeIds` too
                // so the share-link "include hub(s) in link" toggle actually
                // has something to include (previously nothing in the app
                // ever called `addHubNodeId()`, so this list stayed
                // permanently empty no matter how many hubs were invited).
                if (friend.isHub) {
                  this.currentCanvas.store.addHubNodeId(friend.nodeId);
                }
              }

              // attempt direct send — best effort, gossip relay handles offline peers
              try {
                const localProfile = this.friendzProtocol?.getLocalProfileSnapshot();
                await sendCanvasInvite(friend.nodeId, {
                  inviteId,
                  canvasDocId: docId,
                  canvasTitle,
                  canvasDescription,
                  canvasColor,
                  canvasPreviewUrl,
                  originNodeId: localIdentity.node_id,
                  originUsername: this.friendzProtocol?.getLocalUsername() ?? "",
                  originBio: localProfile?.bio,
                  originAvatarDataUrl: localProfile?.avatarDataUrl,
                  originAccentColor: localProfile?.accentColor,
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
          // the dialog destructures onClose AT CALL TIME, so it must be set
          // BEFORE showShareDialog — assigning it after (as this code once
          // did) left the FIRST dialog instance with no close handler:
          // closing it never tore down the store subscriptions, and the next
          // canvas-store change (e.g. selecting a widget) "randomly"
          // reopened the dialog via rebuild(). the arrow indirection is safe:
          // teardownSubscriptions is declared below but only ever called
          // after it exists (on user close).
          shareOptions.onClose = () => teardownSubscriptions();
          let shareHandle = showShareDialog(shareOptions);

          // a friend's `isHub` flag is only ever set from an incoming
          // friend-request/profile-response message (see friendz-wiring.ts's
          // onProfileResponse comment: "sticky hub flag ... only ever set
          // true, never reset") - if that peer became a hub (or the
          // handshake message was simply missed) AFTER the friendship was
          // already established, the persisted flag stays stale/false
          // forever with nothing to correct it. mirrors friends-tab.ts's
          // on-demand "live profile refresh" for the friend-detail view:
          // ask each online candidate directly, once per dialog session: a
          // response lands in onProfileResponse, which corrects
          // friend.isHub on the social doc, and the socialListener below
          // rebuilds this dialog to reflect it.
          const hubProfileRefreshRequestedFor = new Set<string>();
          const refreshStaleHubFlags = (opts: ShareDialogOptions): void => {
            const candidates = new Set<string>();
            for (const p of opts.peers ?? []) candidates.add(p.nodeId);
            for (const f of opts.friends ?? []) candidates.add(f.nodeId);
            for (const nodeId of candidates) {
              if (hubProfileRefreshRequestedFor.has(nodeId)) continue;
              if (!(this.friendzProtocol?.isOnline(nodeId) ?? false)) continue;
              hubProfileRefreshRequestedFor.add(nodeId);
              requestProfile(nodeId).catch((err) => {
                log.warn(
                  TAG,
                  "share dialog: live profile refresh failed for",
                  nodeId.slice(0, 16) + "...",
                  err
                );
              });
            }
          };
          refreshStaleHubFlags(shareOptions);

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
              refreshStaleHubFlags(shareOptions);
              log.debug(TAG, "share dialog: rebuilt", "docId=" + docId);
            });
          };

          const unsubStore = this.currentCanvas.store.onChange(() => {
            log.debug(TAG, "share dialog: canvas store onChange fired, queueing rebuild");
            rebuild();
          });
          const messagezListener = () => {
            log.debug(TAG, "share dialog: messagez doc change fired, queueing rebuild");
            rebuild();
          };
          this.messagezDocHandle?.on("change", messagezListener);
          // the social doc is where friend.isHub (and username/avatar/bio)
          // actually lives - without this subscription, an isHub flag fixed
          // up by refreshStaleHubFlags()'s requestProfile() above (or any
          // other friend-info change) would silently never reach an
          // already-open dialog until the user manually closed and
          // reopened it, same bug class messagezListener/unsubStore already
          // fix for canvas/messagez state.
          const socialListener = () => {
            log.debug(TAG, "share dialog: social doc change fired, queueing rebuild");
            rebuild();
          };
          const unsubSocial = this.socialDoc?.on("change", socialListener);

          const teardownSubscriptions = (): void => {
            if (isRebuilding) return;
            shareActive = false;
            unsubStore();
            this.messagezDocHandle?.off("change", messagezListener);
            unsubSocial?.();
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
      canvas.store.setLocalNodeId(this.effectiveLocalNodeId());
      // self-heal a canvas this peer created while still anonymous — safe
      // ONLY while still anonymous (this.localNodeId falsy): sharing/
      // joining a canvas requires a real p2p identity (see
      // registerAndReconnectPeers()'s identity guard), so an anonymous
      // peer's local repo can only contain canvases it created itself.
      // once a real identity exists, healOwnedCanvases() (run at boot and
      // on identity creation) is the one that migrates admin over, rather
      // than stamping unconditionally here — a canvas received from
      // another peer might just not have synced its real admin down yet.
      if (!this.localNodeId) {
        canvas.store.stampAdmin(this.anonDeviceId);
      }
      if (this.localNodeId) {
        canvas.presenceManager.setLocalNodeId(this.localNodeId);
      }
      canvas.toolbar.refreshRoleGating();

      // clean up a file widget's blob (cancel in-flight snatch, drop the
      // canvas ref, purge the local copy if nothing else needs it) whenever
      // one is deleted directly from this (regular, non-narthex) canvas —
      // mirrors the narthex's own registration above; canvas-card cascade
      // delete only applies from the narthex, so this only needs the
      // direct-file-removal case.
      canvas.widgetManager.setBeforeRemoveHook(async (entry, repo) => {
        if (entry.type === "file" && entry.docId) {
          await cleanUpFileWidgetBlob(entry.docId, repo, docId);
        }
      });

      // update lastVisitedAt on the canvas card
      if (this.narthexDocId) {
        try {
          const narthexHandle = await resolveDocReadyCached<CanvasDocument>(
            this.repo,
            this.narthexDocId as DocumentId
          );
          const narthexDoc = narthexHandle?.doc();
          if (narthexDoc?.widgets) {
            for (const entry of Object.values(narthexDoc.widgets)) {
              if (
                entry.type === "canvas-card" &&
                (entry.props as any)?.canvasDocId === docId &&
                entry.docId
              ) {
                const cardHandle = await resolveDocReadyCached<any>(
                  this.repo,
                  entry.docId as DocumentId
                );
                if (!cardHandle) break;
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
        const ownerUsername = this.friendzProtocol?.getLocalUsername() ?? undefined;
        const shareStr = encodeShareString(
          identity.node_id,
          docId,
          canvas.store.doc().title,
          undefined,
          ownerUsername
        );
        try {
          await navigator.clipboard.writeText(shareStr);
          log.debug(TAG, "share string copied to clipboard:", shareStr);
        } catch {
          log.debug(TAG, "share string (copy manually):", shareStr);
        }
        log.debug(
          TAG,
          "share URL:",
          buildShareUrl(identity.node_id, docId, canvas.store.doc().title, undefined, ownerUsername)
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
      this.hideNavSpinner();
    }

    if (failure) {
      if (cancelledByUser) {
        log.debug(TAG, "canvas navigation cancelled by user:", docId);
      } else {
        log.error(TAG, "failed to open canvas, falling back to narthex:", docId, failure);
        this.lastFailedCanvasDocId = docId;
        if (opts?.coldOpen) {
          await this.offerAccessRequestForUnreachableCanvas(docId);
        }
      }
      await this.navigateToNarthex();
    } else {
      this.lastFailedCanvasDocId = null;
      if (this.pendingNavToNarthex) {
        // a nav-home arrived while this canvas navigation was in flight —
        // honor it now instead of silently dropping it
        log.debug(TAG, "executing queued narthex navigation");
        await this.navigateToNarthex();
      }
    }
  }

  /**
   * called when a canvas navigation fails to reach a canvas that has a
   * known narthex card - either a genuine cold open (see
   * `isInitialNavigation`) or a navigation with no local identity, which
   * can never succeed over the network either (see `onHashChange`). marks
   * the card as access-pending so its "request access" pill shows up in
   * the narthex - the user decides from there whether to actually send a
   * request, rather than being interrupted with a blocking prompt here.
   */
  private async offerAccessRequestForUnreachableCanvas(docId: string): Promise<void> {
    if (!this.narthexDocId) return;
    try {
      const narthexHandle = await resolveDocReadyCached<CanvasDocument>(
        this.repo,
        this.narthexDocId as DocumentId
      );
      if (!narthexHandle) return;
      const narthexDoc = narthexHandle.doc();
      if (!narthexDoc?.widgets) return;

      for (const entry of Object.values(narthexDoc.widgets)) {
        const props = entry.props as
          | { canvasDocId?: string; isRemote?: boolean; accessRevoked?: boolean; ownerNodeId?: string }
          | undefined;
        if (entry.type !== "canvas-card" || props?.canvasDocId !== docId) continue;
        if (!props.isRemote || props.accessRevoked) return;

        const narthexStore = await CanvasStore.open(this.repo, this.narthexDocId as DocumentId);
        await narthexStore.updateWidgetProps(entry.id, { accessPending: true });

        // mark it access-pending and stop there — the card's own "request
        // access" pill (canvas-card.ts) already surfaces this, so there's
        // no need to interrupt the user with a blocking confirm() dialog.
        return;
      }
    } catch (err) {
      log.warn(TAG, "failed to offer access request for unreachable canvas:", docId, err);
    }
  }

  /**
   * remove/cancel outbox entries referencing a canvas that's just been
   * trashed via a narthex canvas-card (see the `skein:canvas-card-trashed`
   * listener above). a sent invite (`shares`) for a canvas that no longer
   * exists (or is at least gone from this device) has nothing left to
   * track, so those are removed outright. a sent access request
   * (`accessRequests`) is different: the pending card being deleted is
   * exactly what should stop the owner/hub from being knocked/friend-
   * requested any further (see friendz-wiring.ts's onPeerBecameOnline
   * retry loop and its `status === "cancelled"` check) — but the request
   * is marked `status: "cancelled"` rather than deleted, so the outbox
   * keeps a log of it and reopening the same share link (see
   * `joinCanvasFromNarthex()`) can start a fresh request rather than the
   * old one silently vanishing. friend requests (`outboundRequests`,
   * social doc) are untouched here on purpose — see the caller's doc
   * comment.
   *
   * mutates `draft.shares` in place via `splice()` rather than reassigning
   * a `.filter()`'d copy — automerge throws `RangeError: Cannot create a
   * reference to an existing document object` if a change handler
   * reassigns a document array to a new array built from that same
   * array's (still document-owned) elements.
   */
  private clearOutboxForCanvas(canvasDocId: string): void {
    if (!this.messagezDocHandle) return;
    this.messagezDocHandle.change((draft: any) => {
      if (draft.shares) {
        for (let i = draft.shares.length - 1; i >= 0; i--) {
          if (draft.shares[i].canvasDocId === canvasDocId) draft.shares.splice(i, 1);
        }
      }
      if (draft.accessRequests) {
        const cancelledAt = new Date().toISOString();
        for (const req of draft.accessRequests) {
          if (req.canvasDocId !== canvasDocId) continue;
          if (req.status === "cancelled") continue;
          req.status = "cancelled";
          req.cancelledAt = cancelledAt;
        }
      }
    });
  }

  /**
   * send a `canvas-knock` directly to a canvas's owner asking to be let
   * in, and a friend request too if the owner isn't already a friend.
   * used by the narthex card's "request access" pill (`canvas-card.ts`).
   *
   * the knock is persisted to the messagez doc's `accessRequests` outbox
   * BEFORE any send attempt — a durable record that survives a failed
   * send, a reload, or the app being closed entirely, mirroring the
   * canvas-invite outbox pattern (`draft.shares`) above. `friendzProtocol`
   * itself already retries a still-`pending` outbound friend request the
   * next time that peer is seen online (`friendz-wiring.ts`'s
   * `onPeerBecameOnline`); `onPeerBecameOnline` does the same for this
   * outbox's undelivered knocks, so a single click here is enough —
   * delivery doesn't depend on the owner being reachable at click time.
   *
   * the actual `canvas-knock` message still only ever goes directly to the
   * owner — relaying the knock itself through a hub would bypass the
   * friends-only gossip network (see docs/knock-and-hub-relay-plan.md's
   * relay design). but a real friend request (not just a transport-level
   * connect) IS also sent to any hub named on this card (`hubNodeIds`,
   * from the share link — see `canvas-card.ts`'s `hubNodeIds` prop), for a
   * concrete reason: `hub::messages::handle_core_message`'s `FriendRequest`
   * handler (tumulus-side) auto-accepts immediately if this requester is
   * already "canvas-vouched" — named in the acl/pendingInvites of a canvas
   * doc the hub holds. once that friendship is mutually accepted, this
   * peer is on the hub's friends-only gossip network, so the *owner*-
   * directed friend request queued above (in `outboundRequests`) rides
   * along on the very next gossip digest exchanged with the hub and gets
   * relayed onward toward the owner — see `computeAndSendGossipDigest`/
   * `onGossipDigest` in friendz-wiring.ts. this is what actually delivers
   * a request to the owner while they're offline; a bare `addPeer` connect
   * (no friend request) would only let the hub notice this peer online,
   * without ever admitting it to the gossip network. if this requester
   * was never actually vouched-for (a cold knock, not a prior invite), the
   * hub's friend request just sits pending — same as it always did — no
   * worse off than before.
   */
  private async requestCanvasAccess(
    canvasDocId: string,
    ownerNodeId: string,
    hubNodeIds: string[] = []
  ): Promise<void> {
    if (!this.friendzProtocol) {
      log.warn(TAG, "cannot send canvas knock — friendz protocol not ready");
      return;
    }
    const identity = await getStoredIdentity();
    if (!identity) {
      log.debug(TAG, "no identity — generate one first (profile widget)");
      return;
    }

    if (hubNodeIds.length > 0) recordKnownHubNodeIds(hubNodeIds);

    // a friendly title for the outbox row (messagez-widget.ts) — looked up
    // from the narthex card itself rather than threaded through this
    // function's own params, since the card already has it and every
    // caller (the pill's click handler, retryCanvasAccessRequest below)
    // already knows canvasDocId.
    let canvasTitle = "";
    let ownerUsernameHint = "";
    try {
      const cardWidget = this.currentCanvas?.store
        .allWidgets()
        .find((w) => w.type === "canvas-card" && (w.props as any)?.canvasDocId === canvasDocId);
      canvasTitle = (cardWidget?.props as any)?.title ?? "";
      ownerUsernameHint = (cardWidget?.props as any)?.ownerUsername ?? "";
    } catch {
      // best-effort only
    }

    // reuse an existing, not-yet-delivered, not-cancelled outbox entry for
    // this canvas (e.g. a retry after the click handler's own debounce
    // somehow didn't prevent a second dispatch) rather than minting a
    // fresh knockId every time — keeps `CanvasStore.recordKnock()`'s
    // idempotent-retry rule (docs/knock-and-hub-relay-plan.md section 3.2)
    // meaningful from the requester's side too. a *cancelled* entry (the
    // pending card was trashed, see `clearOutboxForCanvas()`) is
    // deliberately excluded here — reopening the same share link should
    // start a brand-new request, not resurrect a cancelled one.
    const existingRequests = (this.messagezDocHandle?.doc()?.accessRequests ?? []) as Array<{
      knockId: string;
      canvasDocId: string;
      delivered: boolean;
      status?: string;
    }>;
    const existing = existingRequests.find(
      (r) => r.canvasDocId === canvasDocId && !r.delivered && r.status !== "cancelled"
    );
    const knockId = existing?.knockId ?? crypto.randomUUID();

    // write the outbox entry FIRST — durable record that survives a failed
    // send below, same as the canvas-invite outbox (`draft.shares`).
    if (this.messagezDocHandle && !existing) {
      this.messagezDocHandle.change((draft: any) => {
        if (!draft.accessRequests) draft.accessRequests = [];
        draft.accessRequests.push({
          knockId,
          canvasDocId,
          canvasTitle,
          ownerNodeId,
          hubNodeIds,
          sentAt: new Date().toISOString(),
          delivered: false,
          hubAcked: false,
          status: "pending",
        });
      });
    }

    // asking to access someone's canvas is also a natural moment to ask to
    // be their friend, if not already — a knock alone doesn't establish a
    // friend relationship, and other gating elsewhere (e.g. the
    // friend-only blob-fetch gate) depends on one existing. `sendFriendRequest()`
    // (friendz-bridge.ts) already persists this into the social doc's
    // `outboundRequests` outbox and gets retried on peer-online — no
    // separate durable tracking needed here.
    if (!isFriend(ownerNodeId)) {
      try {
        await sendFriendRequest(ownerNodeId, ownerUsernameHint || undefined);
        log.debug(TAG, "sent friend request to canvas owner:", ownerNodeId.slice(0, 16) + "...");
      } catch (err) {
        log.warn(TAG, "failed to send friend request to canvas owner:", err);
      }
    }

    // best-effort: also send a real friend request to any hub(s) this
    // card was shared via (see this function's doc comment above for why
    // this — not just a transport connect — is what's needed for the
    // owner-directed request to actually reach the owner via gossip while
    // they're offline). this deliberately runs BEFORE the owner
    // connect/knock attempt below, not after: `irohAdapter.addPeer()` can
    // block for a long time (real discovery/relay timeout) when the owner
    // is offline, and since every step here is awaited sequentially, a
    // hub loop placed after it would sit stuck behind that same delay —
    // exactly the "hub request only shows up minutes later" symptom this
    // ordering avoids. the hub connection doesn't depend on the owner's
    // reachability at all, so there's no reason to make it wait.
    for (const hubNodeId of hubNodeIds) {
      if (isFriend(hubNodeId)) continue;
      try {
        await sendFriendRequest(hubNodeId);
        log.debug(TAG, "sent friend request to share-link hub:", hubNodeId.slice(0, 16) + "...");
      } catch (err) {
        log.debug(TAG, "failed to send friend request to share-link hub:", hubNodeId.slice(0, 16) + "...", err);
      }
    }

    // a prior join/invite attempt against this same peer may have left a
    // stale, already-open stream that the adapter would otherwise
    // silently reuse (see IrohNetworkAdapter.addPeer()'s doc comment) —
    // forget it first so this actually attempts a fresh connection.
    this.irohAdapter.forgetPeer(ownerNodeId);
    let connectedToOwner = false;
    try {
      await this.irohAdapter.addPeer(ownerNodeId);
      connectedToOwner = true;
    } catch (err) {
      log.warn(TAG, "failed to connect for knock:", ownerNodeId.slice(0, 16) + "...", err);
    }

    if (connectedToOwner) {
      try {
        await this.friendzProtocol.sendCanvasKnock(ownerNodeId, {
          knockId,
          canvasDocId,
          requesterNodeId: identity.node_id,
          requesterUsername: this.friendzProtocol.getLocalUsername() ?? "",
          message: "",
        });
        log.debug(TAG, "sent canvas knock to:", ownerNodeId.slice(0, 16) + "...");
      } catch (err) {
        log.warn(TAG, "failed to send canvas knock to:", ownerNodeId.slice(0, 16) + "...", err);
      }
    }
  }

  /**
   * manually re-send a pending canvas access-request — the messagez
   * outbox's/canvas-card's "resend" action (see
   * `skein:retry-canvas-access-request`, listener below). a one-shot
   * spam guard (`markManuallyRetried()`/`wasManuallyRetried()`,
   * friendz-bridge.ts) disables this until the next page reload, since
   * automatic retry-on-peer-online (friendz-wiring.ts's
   * `onPeerBecameOnline`) already covers the common case of "the owner
   * or hub just came online" without any user action.
   */
  private async retryCanvasAccessRequest(canvasDocId: string): Promise<void> {
    if (wasManuallyRetried(canvasDocId)) {
      log.debug(TAG, "manual retry already used this session for:", canvasDocId.slice(0, 16) + "...");
      return;
    }
    // find the most recent entry for this canvas, regardless of status —
    // a *cancelled* entry is deliberately included here (unlike
    // requestCanvasAccess()'s own dedup-reuse lookup, which excludes
    // cancelled entries to always mint a fresh knockId): the messagez
    // outbox widget's "resend" button on a cancelled row calls this same
    // method, and needs it to find that row's ownerNodeId/hubNodeIds to
    // pass along to requestCanvasAccess() below.
    const entries = (this.messagezDocHandle?.doc()?.accessRequests ?? []) as Array<{
      canvasDocId: string;
      ownerNodeId: string;
      hubNodeIds?: string[];
      status?: string;
    }>;
    const entry = entries.filter((r) => r.canvasDocId === canvasDocId).at(-1);
    if (!entry) {
      log.debug(TAG, "no outstanding access-request to retry for:", canvasDocId.slice(0, 16) + "...");
      return;
    }

    markManuallyRetried(canvasDocId);
    await this.requestCanvasAccess(canvasDocId, entry.ownerNodeId, entry.hubNodeIds ?? []);
    // in case we have other friends online (but not the owner/hub
    // themselves), nudge them for a fresh gossip digest right away rather
    // than waiting for their own periodic exchange — see
    // `gossipFriendRequestsNow()`'s doc comment (friendz-bridge.ts).
    gossipFriendRequestsNow();
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
    fromAvatarDataUrl?: string;
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

    // never generate an identity as a side effect of accepting an invite —
    // the inbox widget already checks this before dispatching, this is
    // just a safety net so we never silently create one here either.
    const identity = await getStoredIdentity();
    if (!identity) {
      log.debug(TAG, "cannot accept canvas invite — no identity set up yet");
      return;
    }

    // connect to the inviter's peer via the iroh adapter. if that fails
    // and this invite was relayed through a hub, also try the hub directly
    // — the hub already holds a synced copy of the canvas doc (that's how
    // it was able to relay the invite at all), so it's a reachable source
    // for the doc write below even while the original inviter stays
    // offline. without this fallback, a hub-relayed invite's accept could
    // never be recorded anywhere: the direct dial to a still-offline
    // inviter fails, and there was no other way to reach the doc.
    //
    // force a genuine disconnect + reconnect rather than a bare addPeer():
    // this accept can follow an earlier, denied join attempt against the
    // same peer whose underlying connection never actually dropped (a
    // sync-level access denial isn't a transport-level disconnect) — a
    // bare addPeer() against an already-open stream is a no-op (see
    // IrohNetworkAdapter.addPeer's `streams.has` guard) and never gives
    // automerge-repo's synchronizer a fresh peer event, so it never
    // re-evaluates whether this doc can now be shared. forgetPeer() always
    // emits peer-disconnected (even with no live stream), guaranteeing the
    // repo's synchronizer clears its stale per-peer bookkeeping for this
    // doc and re-requests it from scratch on the reconnect.
    // bound each dial attempt well below the messagez widget's own 15s
    // accept timeout: `IrohNetworkAdapter.addPeer()` -> `openBiWithRetry()`
    // retries a failed dial up to 4x with a 750ms gap, and each individual
    // attempt gets its own ~10s `DEFAULT_CONNECT_TIMEOUT` (midden/src/lib.rs)
    // before failing over to the next attempt - worst case ~40s just for
    // the direct dial to `fromNodeId` alone. when `fromNodeId` (the
    // original inviter) is genuinely offline - exactly the case a
    // hub-relayed invite exists to handle - that whole retry loop has to
    // run to completion and reject before this function's `catch` below
    // ever gets a chance to try `relayedBy`, guaranteeing the widget's own
    // 15s timeout fires first and the hub fallback never even starts. race
    // each dial against a short local timeout instead: if the direct dial
    // hasn't succeeded quickly, move on to the hub without waiting for
    // iroh's own much longer internal retry/timeout budget to expire (the
    // abandoned dial keeps running in the background and is still handled
    // via `.then` below, so it can't produce an unhandled rejection).
    const withTimeout = <T>(promise: Promise<T>, ms: number): Promise<T> =>
      new Promise<T>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`dial timed out after ${ms}ms`)), ms);
        promise.then(
          (value) => {
            clearTimeout(timer);
            resolve(value);
          },
          (err) => {
            clearTimeout(timer);
            reject(err);
          }
        );
      });

    let connected = false;
    try {
      this.irohAdapter.forgetPeer(detail.fromNodeId);
      await withTimeout(this.irohAdapter.addPeer(detail.fromNodeId), 4000);
      connected = true;
    } catch (err) {
      log.error(TAG, "failed to connect to invite peer:", err);
      // continue anyway — the peer might become reachable later
    }
    if (!connected && detail.relayedBy && detail.relayedBy !== detail.fromNodeId) {
      try {
        this.irohAdapter.forgetPeer(detail.relayedBy);
        await withTimeout(this.irohAdapter.addPeer(detail.relayedBy), 5000);
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
    // that case too. bounded with `CanvasStore.open()`'s own `timeoutMs`
    // option (an `AbortSignal` that actually cancels the internal wait)
    // rather than an external `Promise.race` — racing against a bare
    // `CanvasStore.open()` call abandons it running in the background once
    // the race's own timer wins, and it can still reject on its own, much
    // later, unhandled (its own default ~60s bound) — a confirmed source of
    // stray "uncaught (in promise) TimeoutError" console spam completely
    // disconnected from whatever the user is doing by the time it fires.
    if (identity) {
      try {
        const canvasStore = await CanvasStore.open(this.repo, detail.canvasDocId as DocumentId, {
          timeoutMs: 5000,
        });
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

    // the relaying hub's node id (if any), carried onto the canvas-card as
    // informational card data (see canvasCardSchema's `hubNodeIds` doc
    // comment) — no client-initiated friend request is sent for it. the
    // hub itself proactively sends this peer a friend request once it
    // notices them online and finds them vouched for by this canvas's acl
    // (see tumulus's `HubPeerService::maybe_send_proactive_friend_request`),
    // so there's nothing for the client to initiate here.
    const hubNodeIds = detail.relayedBy ? [detail.relayedBy] : [];

    if (narthexStore) {
      const existing = narthexStore.allWidgets();
      const alreadyExists = existing.some((w) => {
        if (w.type !== "canvas-card") return false;
        return (w.props as Record<string, unknown>)?.canvasDocId === detail.canvasDocId;
      });

      if (alreadyExists) {
        // a canvas-card for this doc already exists — most commonly a
        // "syncing..." placeholder left behind by joinCanvasFromNarthex()
        // after an earlier, denied join attempt. refresh its display
        // fields to reflect this (now-permitted) invite instead of leaving
        // stale placeholder props forever: the card's local props never
        // updated on their own since the earlier join never actually
        // finished, and the user has no other visible sign the invite did
        // anything.
        const existingCard = existing.find((w) => {
          if (w.type !== "canvas-card") return false;
          return (w.props as Record<string, unknown>)?.canvasDocId === detail.canvasDocId;
        });
        if (existingCard) {
          await narthexStore.updateWidgetProps(existingCard.id, {
            title: detail.canvasTitle || "shared canvas",
            description: detail.canvasDescription || "",
            color: detail.canvasColor || 0x06b6d4,
            previewUrl: detail.canvasPreviewUrl || "",
            modifiedAt: new Date().toISOString(),
            isRemote: true,
            ownerNodeId: detail.fromNodeId,
            ownerUsername: detail.fromUsername || "",
            ownerAvatarDataUrl: detail.fromAvatarDataUrl || "",
            role: detail.role ?? "member",
            accessRevoked: false,
            accessPending: false,
            // see `hubNodeIds` const above.
            hubNodeIds,
          });
        }
      } else {
        // add a remote canvas-card widget to the narthex — placed in the
        // first empty spot found (layout-placement.ts's findEmptySpot()),
        // not a naive count-based stagger that ignores actual occupied
        // space (see docs/narthex-widgets-and-file-transfer-plan.md
        // section 2).
        const existingCount = narthexStore.widgetCount();
        const shortDate = new Date().toISOString().slice(0, 10);
        const cardWidth = 280;
        const cardHeight = 200;
        const { x: cardX, y: cardY } = findEmptySpot(narthexStore.allWidgets(), cardWidth, cardHeight);

        narthexStore.addWidget({
          id: crypto.randomUUID(),
          type: "canvas-card",
          x: cardX,
          y: cardY,
          width: cardWidth,
          height: cardHeight,
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
            ownerAvatarDataUrl: detail.fromAvatarDataUrl || "",
            // see `hubNodeIds` const above.
            hubNodeIds,
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

    if (decoded.hubNodeIds?.length) recordKnownHubNodeIds(decoded.hubNodeIds);

    // never generate an identity as a side effect of joining — the join
    // wizard already checks this before dispatching, this is just a
    // safety net (also covers the cold-open share-link path in
    // onHashChange, which has no wizard UI to have checked it first).
    // with no identity there's no p2p endpoint running at all, so there's
    // nothing to dial below — but we still fall through to plant a
    // pending canvas-card (see the card-creation block further down)
    // rather than bailing out silently: a share link shouldn't be a dead
    // end just because the user hasn't set up an identity yet. once they
    // do (e.g. via the social widget onHashChange's share/ branch
    // auto-opens), the card's "request access" pill is already there.
    const identity = await getStoredIdentity();

    // a canvas's sync eligibility is gated to friends only (see
    // canvas-scoped-share-policy.ts's `createCanvasScopedSharePolicy`) — if
    // the share link's owner isn't already a friend, actually opening the
    // canvas is doomed: the owner's side will simply never sync the doc to
    // an unrecognized peer, so navigating in would just hang on the
    // "loading canvas" spinner until `CanvasStore.open()`'s own default
    // ~60s bound (or COLD_OPEN_TIMEOUT_MS on a cold open) elapses.
    // `isFriend()` is a synchronous, no-network lookup against the local
    // social doc, so checking it here costs nothing and tells us instantly
    // — skip the peer connect attempt and the canvas navigation entirely
    // below, and stay on the narthex with an access-pending card instead.
    // the user can send a friend + canvas-access request from that card's
    // "request access" pill (dispatches skein:request-canvas-access,
    // handled by requestCanvasAccess()).
    // no identity at all means we can't be anyone's friend yet either —
    // and there's no p2p endpoint to dial with regardless (see above).
    const isKnownFriend = identity ? isFriend(decoded.nodeId) : false;

    if (isKnownFriend) {
      // connect to the peer via the iroh adapter
      try {
        await this.irohAdapter.addPeer(decoded.nodeId);
      } catch (err) {
        log.error(TAG, "failed to connect to peer:", err);
        // continue anyway — the peer might become reachable later
      }
    } else if (identity) {
      log.debug(
        TAG,
        "share link owner isn't a friend yet — staying on narthex:",
        decoded.nodeId.slice(0, 16) + "..."
      );

      // best-effort fallback: dial any hub(s) the share link named (see
      // share-string.ts's `hubNodeIds`), even though we're not opening the
      // canvas yet. this is what lets a hub ever notice this peer is
      // online and reachable in the first place — the hub's own
      // `FriendzEvent::PeerOnline` handler only fires once it *receives*
      // something from us (see tumulus's `mark_online_if_new`), so simply
      // knowing the hub's node id is useless until we actually connect to
      // it at least once. no friend request is sent from here: if the
      // canvas owner already invited this exact node id (named in the
      // canvas's acl/pendingInvites, which is how a real invite — as
      // opposed to a generic share link nobody in particular was granted
      // — gets recorded), the hub proactively sends a friend request of
      // its own the moment it notices us (see tumulus's
      // `HubPeerService::maybe_send_proactive_friend_request`); if we were
      // never actually invited, this dial harmlessly does nothing further.
      for (const hubNodeId of decoded.hubNodeIds ?? []) {
        try {
          await this.irohAdapter.addPeer(hubNodeId);
        } catch (err) {
          log.debug(TAG, "failed to connect to share-link hub:", hubNodeId.slice(0, 16) + "...", err);
        }
      }
    } else {
      log.debug(
        TAG,
        "no identity yet — planting pending canvas-card, staying on narthex:",
        decoded.nodeId.slice(0, 16) + "..."
      );
    }

    // remove the join wizard widget if it was used
    if (detail.wizardWidgetId && this.currentCanvas) {
      this.currentCanvas.store.removeWidget(detail.wizardWidgetId);
    }

    // check if a canvas-card already exists for this docId
    if (this.currentCanvas) {
      const existing = this.currentCanvas.store.allWidgets();
      const existingCard = existing.find((w) => {
        if (w.type !== "canvas-card") return false;
        // check if the card's props have this docId
        return (w.props as Record<string, unknown>)?.canvasDocId === decoded.docId;
      });

      // a card matching this canvas exists but was trashed (reparented
      // into the trash widget — see moveCardToTrash(), trashing doesn't
      // remove a card from allWidgets(), only reparents it) — this was
      // the "reopening the same share link does nothing" bug: the dedup
      // check below used to treat a trashed card as "already exists"
      // forever, silently no-oping every subsequent attempt to rejoin.
      // purge it outright and fall through to plant a brand-new card: a
      // cancelled pending-access request (see clearOutboxForCanvas()) has
      // no real canvas content worth restoring, and requestCanvasAccess()
      // already mints a fresh knockId once the old outbox entry is
      // cancelled, so this is a genuine restart of the join process.
      const trash = findTrashWidget(this.currentCanvas.store);
      const existingIsTrashed =
        !!existingCard && !!trash && existingCard.parentId === trash.id;
      if (existingIsTrashed) {
        log.debug(TAG, "purging trashed pending card before rejoining:", decoded.docId);
        this.currentCanvas.store.removeWidget(existingCard!.id);
      }

      const alreadyExists = !existingIsTrashed && !!existingCard;

      if (!alreadyExists) {
        // add a canvas-card widget to the narthex — placed in the first
        // empty spot found, not a naive count-based stagger.
        const existingCount = this.currentCanvas.store.widgetCount();
        const shortDate = new Date().toISOString().slice(0, 10);
        const cardWidth = 280;
        const cardHeight = 200;
        const { x: cardX, y: cardY } = findEmptySpot(
          this.currentCanvas.store.allWidgets(),
          cardWidth,
          cardHeight
        );

        // a known friend's username/avatar are already in the local
        // social doc — use them right away instead of leaving the card's
        // owner badge blank (falling back to a bare node id + no avatar)
        // until some later event happens to refresh it.
        const friendInfo = isKnownFriend ? getFriendInfo(decoded.nodeId) : null;

        this.currentCanvas.store.addWidget({
          id: crypto.randomUUID(),
          type: "canvas-card",
          x: cardX,
          y: cardY,
          width: cardWidth,
          height: cardHeight,
          zIndex: existingCount + 1,
          props: {
            canvasDocId: decoded.docId,
            title: decoded.canvasTitle || "syncing...",
            description: isKnownFriend
              ? "connecting to peer"
              : "not a friend yet — use \"request access\" below",
            authorName: "",
            color: 0x06b6d4, // cyan accent for remote canvases
            previewUrl: "",
            createdAt: shortDate,
            modifiedAt: new Date().toISOString(),
            // remote card fields — joining via share string
            isRemote: true,
            ownerNodeId: decoded.nodeId,
            // a known friend's real profile always wins; otherwise fall
            // back to the share link's own embedded `ownerUsername` (see
            // share-string.ts) so the card doesn't show a bare node id
            // for a brand-new invitee who isn't friends with the owner
            // yet — this is also the hint requestCanvasAccess() below
            // passes along when sending the owner a friend request.
            ownerUsername: friendInfo?.username || decoded.ownerUsername || "",
            ownerAvatarDataUrl: friendInfo?.avatarDataUrl || "",
            role: "viewer", // share-string joiners default to viewer
            accessRevoked: false,
            accessPending: true,
            accessRequestedAt: "",
            lastVisitedAt: "",
            // hub node ids from the share link, if any — offered as a
            // "connect via hub" pill (see canvas-card.ts) so a brand-new
            // invitee can befriend a hub and receive this canvas via
            // gossip even if the owner is offline right now.
            hubNodeIds: decoded.hubNodeIds ?? [],
          },
          collapsed: false,
          docId: null,
          parentId: null,
        });
      } else if (isKnownFriend) {
        // a placeholder card already exists (e.g. left behind by an
        // earlier join attempt made before this peer was a friend, or
        // before their profile had an avatar set) — refresh its owner
        // badge fields now that we have current friend info, rather than
        // leaving a stale blank avatar/username forever.
        const friendInfo = getFriendInfo(decoded.nodeId);
        if (friendInfo?.username || friendInfo?.avatarDataUrl) {
          const existingCard = existing.find((w) => {
            if (w.type !== "canvas-card") return false;
            return (w.props as Record<string, unknown>)?.canvasDocId === decoded.docId;
          });
          if (existingCard) {
            await this.currentCanvas.store.updateWidgetProps(existingCard.id, {
              ownerUsername: friendInfo.username || "",
              ownerAvatarDataUrl: friendInfo.avatarDataUrl || "",
            });
          }
        }
      }
    }

    if (!isKnownFriend) {
      // bail out here — no point navigating into a canvas we already know
      // we can't sync yet (including the no-identity case). the card
      // created above already shows the "request access" pill for the
      // user to act on instead, once an identity exists.
      return;
    }

    // stash the remote peer's nodeId so navigateToCanvas can write it
    // into the canvas doc reliably (no RAF race).
    this.pendingPeerNodeId = decoded.nodeId;
    // this is a fresh join (we may not have ACL access synced yet, or
    // ever, until an admin approves) — see `pendingFreshJoinDocId`'s doc
    // comment for why this must NOT wait out the library's full default
    // timeout the way an ordinary in-app navigation would.
    this.pendingFreshJoinDocId = decoded.docId;

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
    // migrate admin off the anonymous device id onto this real identity,
    // in case this canvas was created before the identity existed and
    // healOwnedCanvases() hasn't caught up yet — a no-op otherwise.
    canvas.store.migrateAdminId(this.anonDeviceId, identity.node_id);
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

    // record the creator as admin in the canvas's ACL (see canvas-store.ts's
    // access control section) — uses the anonymous device id as a stable
    // fallback when no real identity exists yet, so an anonymous creator
    // still has admin access to their own canvas (see effectiveLocalNodeId()
    // and p2p/anon-device-id.ts).
    newStore.stampAdmin(this.effectiveLocalNodeId());

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
    // automerge doc is created (see widget-manager.ts mountWidget). placed
    // in the first empty spot found, not a naive count-based stagger.
    const shortDate = now.slice(0, 10);
    const cardId = crypto.randomUUID();
    const existingCount = this.currentCanvas.store.widgetCount();
    const cardWidth = 280;
    const cardHeight = 200;
    const { x: cardX, y: cardY } = findEmptySpot(
      this.currentCanvas.store.allWidgets(),
      cardWidth,
      cardHeight
    );

    this.currentCanvas.store.addWidget({
      id: cardId,
      type: "canvas-card",
      x: cardX,
      y: cardY,
      width: cardWidth,
      height: cardHeight,
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

  /**
   * add a `canvas-card`-shaped widget linking to an already-known canvas
   * (picked via widgets/canvas-link-picker.ts) to whatever canvas is
   * CURRENTLY open — unlike `createCanvasFromNarthex()`, this never creates
   * a new canvas doc or navigates away; it just links two existing canvases.
   *
   * this is a same-peer, non-remote link (the target canvas is one THIS
   * peer already knows about, via their own narthex) — `isRemote`/
   * `ownerNodeId`/`ownerUsername`/`role` are left at their schema defaults
   * (`isRemote: false`, `role: "admin"`), matching how
   * `createCanvasFromNarthex()` seeds a freshly-created LOCAL canvas's own
   * card above (only `joinCanvasFromNarthex()`'s share-string path sets
   * `isRemote: true`, since that's the one genuinely cross-peer case).
   *
   * "never link a canvas to itself" is enforced twice: the picker's own
   * candidate list already excludes the current canvas doc id (see
   * `src/canvas/canvas-directory.ts`'s `filterCanvasCardCandidates()`), and
   * again here, defensively, in case this handler is ever invoked some
   * other way.
   */
  private linkCanvasToCurrent(detail: {
    canvasDocId?: string;
    title?: string;
    description?: string;
    previewUrl?: string;
    color?: number;
    wizardWidgetId?: string;
  }): void {
    if (!this.currentCanvas || !detail?.canvasDocId) return;

    if (detail.wizardWidgetId) {
      this.currentCanvas.store.removeWidget(detail.wizardWidgetId);
    }

    // defensive guard — never let a canvas link to itself, even if this
    // handler is somehow reached some other way than the picker widget.
    if (detail.canvasDocId === this.currentCanvas.store.handle.documentId) {
      log.warn(TAG, "refusing to link a canvas to itself:", detail.canvasDocId);
      return;
    }

    // viewers can't write to the canvas doc — the picker widget already
    // hides itself for viewers (see canvas-link-picker.ts's `isReadOnly`
    // gate) and the toolbar's "+" flyout is hidden entirely for viewers,
    // but this guard covers any other path that might reach this handler.
    if (this.currentCanvas.store.isLocalViewer()) return;

    const now = new Date().toISOString();
    const shortDate = now.slice(0, 10);
    const existingCount = this.currentCanvas.store.widgetCount();

    this.currentCanvas.store.addWidget({
      id: crypto.randomUUID(),
      type: "canvas-card",
      x: 60 + (existingCount % 4) * 300,
      y: 60 + Math.floor(existingCount / 4) * 220,
      width: 280,
      height: 200,
      zIndex: existingCount + 1,
      props: {
        canvasDocId: detail.canvasDocId,
        title: detail.title || "untitled canvas",
        description: detail.description || "",
        previewUrl: detail.previewUrl || "",
        color: detail.color ?? 0xd946ef,
        createdAt: shortDate,
        modifiedAt: now,
      },
      collapsed: false,
      docId: null,
      parentId: null,
    });
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
      narthexStore: this.narthexStore,
    };

    try {
      const ctrl = socialWidget.create(ctx);
      return new WidgetOverlay(canvas.app, ctrl, SOCIAL_OVERLAY_W, SOCIAL_OVERLAY_H, canvas.theme);
    } catch (err) {
      log.warn(TAG, "failed to mount social overlay:", err);
      return null;
    }
  }

  /**
   * kicks off (if not already opened/opening) actually syncing `canvasDocId`
   * via `CanvasStore.open()` so its `.acl`/`.pendingKnocks` become readable
   * — see `otherCanvasStores`'s doc comment for why this can't just check
   * `repo.handles` passively. calls `onReady()` once the store resolves
   * (fire-and-forget; callers re-derive state from `otherCanvasStores`
   * afterward rather than awaiting this directly).
   */
  private ensureOtherCanvasOpen(canvasDocId: string, onReady: () => void): void {
    if (this.otherCanvasStores.has(canvasDocId) || this.otherCanvasOpenInFlight.has(canvasDocId)) {
      return;
    }
    this.otherCanvasOpenInFlight.add(canvasDocId);
    CanvasStore.open(this.repo, canvasDocId as DocumentId)
      .then((store) => {
        this.otherCanvasStores.set(canvasDocId, store);
        onReady();
      })
      .catch((err) => {
        log.debug(TAG, "failed to open canvas for cross-canvas knock scan:", canvasDocId, err);
      })
      .finally(() => {
        this.otherCanvasOpenInFlight.delete(canvasDocId);
      });
  }

  /**
   * builds an `OtherCanvasKnocksSource` (see widget-types.ts's doc comment)
   * scoped to every canvas the local peer admins EXCEPT `currentCanvasDocId`
   * — used by `mountMessagesOverlay()` so the messagez widget can show and
   * act on a knock regardless of which canvas (or narthex) is currently
   * open, per a real user request ("i want to see these knock access
   * requests on the narthex or any canvas, not just when i have that
   * canvas open").
   */
  private buildOtherCanvasKnocksSource(currentCanvasDocId: string | undefined): OtherCanvasKnocksSource {
    // every canvasDocId listed on a narthex canvas-card, regardless of
    // whether it's been opened/synced yet — `ensureOtherCanvasOpen()` is
    // what actually fetches each one.
    const candidateCanvasDocIds = (): string[] => {
      const narthexHandle = this.narthexDocId
        ? this.repo.handles[this.narthexDocId as DocumentId]
        : undefined;
      const narthexDoc = narthexHandle?.isReady()
        ? (narthexHandle.doc() as CanvasDocument | undefined)
        : undefined;
      if (!narthexDoc?.widgets) return [];
      const ids: string[] = [];
      for (const card of Object.values(narthexDoc.widgets)) {
        if (card.type !== "canvas-card") continue;
        const canvasDocId = (card.props as any)?.canvasDocId;
        if (!canvasDocId || canvasDocId === currentCanvasDocId) continue;
        ids.push(canvasDocId);
      }
      return ids;
    };

    // only the subset of candidates that are BOTH opened AND actually
    // admin — this is where `ensureOtherCanvasOpen()` gets triggered for
    // any candidate not opened yet, so repeated calls to `list()`/
    // `onChange()`'s `rewire()` (e.g. on every render) progressively
    // discover newly-synced canvases rather than requiring a page reload.
    const adminCanvasDocIds = (onNewlyOpened: () => void): string[] => {
      const localNodeId = this.localNodeId;
      if (!localNodeId) return [];
      const ids: string[] = [];
      for (const canvasDocId of candidateCanvasDocIds()) {
        this.ensureOtherCanvasOpen(canvasDocId, onNewlyOpened);
        const store = this.otherCanvasStores.get(canvasDocId);
        if (store?.isAdmin(localNodeId)) ids.push(canvasDocId);
      }
      return ids;
    };

    return {
      list: (): OtherCanvasKnockEntry[] => {
        const entries: OtherCanvasKnockEntry[] = [];
        for (const canvasDocId of adminCanvasDocIds(() => {})) {
          const store = this.otherCanvasStores.get(canvasDocId);
          if (!store) continue;
          const doc = store.doc();
          const dismissed = getDismissedKnockIds(canvasDocId);
          for (const knock of Object.values(doc.pendingKnocks ?? {})) {
            if (dismissed.has(knock.requesterNodeId)) continue;
            if (knock.decisions?.length) continue;
            entries.push({ canvasDocId, canvasTitle: doc.title || "untitled", knock });
          }
        }
        return entries;
      },
      getStore: (canvasDocId: string): CanvasStore | undefined => {
        return this.otherCanvasStores.get(canvasDocId);
      },
      onChange: (handler: () => void): (() => void) => {
        let canvasSubUnsubs: Array<() => void> = [];
        const rewire = () => {
          for (const unsub of canvasSubUnsubs) unsub();
          // when a candidate canvas's `CanvasStore.open()` resolves AFTER
          // this pass (the common case the very first time a canvas is
          // discovered — see `otherCanvasStores`'s doc comment), re-`rewire()`
          // so its handle's own "change" event gets subscribed too, not just
          // fire `handler()` once for this one event — otherwise later
          // knock decisions/arrivals on that specific canvas would have no
          // listener attached at all.
          canvasSubUnsubs = adminCanvasDocIds(() => {
            rewire();
            handler();
          }).map((canvasDocId) => {
            const canvasHandle = this.repo.handles[canvasDocId as DocumentId];
            canvasHandle?.on("change", handler);
            return () => canvasHandle?.off("change", handler);
          });
        };
        const narthexHandle = this.narthexDocId
          ? this.repo.handles[this.narthexDocId as DocumentId]
          : undefined;
        const onNarthexChange = () => {
          rewire();
          handler();
        };
        narthexHandle?.on("change", onNarthexChange);
        rewire();
        return () => {
          narthexHandle?.off("change", onNarthexChange);
          for (const unsub of canvasSubUnsubs) unsub();
          canvasSubUnsubs = [];
        };
      },
    };
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
      // lets the widget also show/act on knocks from every OTHER canvas
      // we admin, regardless of which canvas (or narthex) is currently
      // open — see buildOtherCanvasKnocksSource()'s doc comment.
      otherCanvasKnocks: this.buildOtherCanvasKnocksSource(canvas.store?.handle.documentId),
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
      connectionState: this.connectionStateSource,
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
        // feed the session peer-name registry (used by widgets to display
        // human names for node ids, e.g. the file tray's who-has-it rows)
        const state = this.socialDoc?.current;
        if (state?.profile?.username && this.localNodeId) {
          registerPeerName(this.localNodeId, state.profile.username);
        }
        for (const friend of state?.friends ?? []) {
          for (const n of friend.nodeIds ?? []) {
            if (!n.nodeId) continue;
            const name = friend.alias || n.username || friend.username || "";
            registerPeerName(n.nodeId, name);
          }
        }
      };
      const unsub = this.socialDoc.on("change", updateSocial);
      this.badgeUnsubs.push(unsub);
      updateSocial();
    }

    // messages badge: pending invites + unread deletion notifications +
    // pending knock (access-request) count from this canvas AND every
    // other canvas we admin. previously this badge only ever counted
    // invites/deletions from the messagez doc — an incoming knock never
    // moved it at all (a real reported bug). pendingKnocks lives on each
    // canvas's OWN document, not the messagez doc (see
    // docs/knock-and-hub-relay-plan.md section 1's table). the
    // cross-canvas count reuses `otherCanvasKnocksSource` (also passed to
    // the messagez widget itself via `mountMessagesOverlay()`) rather than
    // a separate scan, on purpose: an earlier version of this badge
    // aggregated cross-canvas knocks WITHOUT the widget being able to
    // show/act on them, lighting the badge for something the open inbox
    // couldn't display or dismiss (a real reported bug: "badge showing 1
    // but my inbox is empty, so i can't dismiss it") — now that the
    // widget itself can also see/act on other canvases' knocks (per a
    // real user request), badge and inbox agree again by construction.
    if (this.messagezDocHandle) {
      const otherCanvasKnocksSource = this.buildOtherCanvasKnocksSource(
        canvas.store?.handle.documentId
      );

      const updateMessages = () => {
        const doc = this.messagezDocHandle?.isReady()
          ? (this.messagezDocHandle.doc() as any)
          : undefined;
        const invites = (doc?.invites ?? []).filter((i: any) => i.status === "pending").length;
        const deletions = (doc?.deletions ?? []).filter((d: any) => d.status === "unread").length;

        // handle.doc() throws (not returns undefined) on a not-yet-ready
        // handle, so this must check isReady() first — a real crash
        // found in testing (the canvas doc isn't guaranteed ready yet
        // when this first runs, e.g. right after navigation before the
        // initial sync completes).
        let pendingKnocks = 0;
        const canvasStore = canvas.store;
        if (canvasStore?.handle.isReady()) {
          const canvasDocId = canvasStore.handle.documentId;
          const dismissed = getDismissedKnockIds(canvasDocId);
          for (const knock of Object.values(canvasStore.doc().pendingKnocks ?? {})) {
            if (dismissed.has(knock.requesterNodeId)) continue;
            if (canvasStore.resolveKnockDecision(knock).outcome === "pending") pendingKnocks++;
          }
        }
        const otherPendingKnocks = otherCanvasKnocksSource.list().length;

        canvas.toolbar.updateMessagesBadge(invites + deletions + pendingKnocks + otherPendingKnocks);
      };

      this.messagezDocHandle.on("change", updateMessages);
      this.badgeUnsubs.push(() => this.messagezDocHandle?.off("change", updateMessages));

      // an incoming knock is written straight to the OWNING canvas's own
      // doc, never touching the messagez doc above — without these, the
      // badge would only refresh whenever some unrelated messagez-doc
      // change next happened to fire, which could be much later or never.
      const canvasHandle = canvas.store?.handle;
      if (canvasHandle) {
        canvasHandle.on("change", updateMessages);
        this.badgeUnsubs.push(() => canvasHandle.off("change", updateMessages));
      }
      const unsubOtherKnocks = otherCanvasKnocksSource.onChange(updateMessages);
      this.badgeUnsubs.push(unsubOtherKnocks);

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
