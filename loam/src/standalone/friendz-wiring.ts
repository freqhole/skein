import type { DocHandle, DocumentId, Repo } from "@automerge/automerge-repo";
import type { CanvasDocument, InvitableRole } from "../canvas/canvas-doc";
import { CanvasStore } from "../canvas/canvas-store";
import type { ProfileStore } from "../canvas/profile-doc";
import {
  FriendzProtocol,
  type BlobSeekMessage,
  type CanvasActivityEntry,
  type GossipDigestMessage,
  type GossipDigestProfileEntry,
} from "../p2p/friends-protocol";
import { initBridge, setOutboundRequestHook } from "../p2p/friendz-bridge";
import { getMiddenNode, getStoredIdentity } from "../p2p/identity";
import { trashCanvasCard } from "../../widgets/narthex/trash-widget";
import {
  FRIENDZ_ALPN,
  type IrohNetworkAdapter,
  type MiddenStreamNode,
} from "../p2p/iroh-network-adapter";

import type { SocialState } from "../../widgets/narthex/social/schema";
import type { SocialDoc } from "../../widgets/narthex/social/types";
import { handleSkeinStream } from "../p2p/skein-handler";
import { isTauriMode, TauriStreamNode } from "../p2p/tauri-transport";
import { log } from "../utils/log";
import { getBlobRecordByBlake3 } from "../storage/skein-blob-store";

export interface FriendzWiringDeps {
  repo: Repo;
  irohAdapter: IrohNetworkAdapter;
  store: CanvasStore;
  narthexDocId: string;
  socialWidgetId: string;
  messagezWidgetId: string;
  socialDoc?: SocialDoc;
  /** optional pre-resolved messagez doc handle — when provided, skips the store lookup */
  messagezDocHandle?: import("@automerge/automerge-repo").DocHandle<any>;
  /** optional \u2014 when provided, our own profile-doc pointer (id +
   *  updatedAt) is included in outgoing profile-response replies and
   *  gossip digests (docs/hub-and-profile-plan.md section 6). omitted
   *  entirely (not "no profile") when not provided, e.g. contexts with no
   *  profile doc wired up yet. */
  profileStore?: ProfileStore;
}

export interface FriendzWiringResult {
  protocol: FriendzProtocol;
  socialDoc: SocialDoc;
  messagezDocHandle: DocHandle<any> | null;
  unsubs: Array<() => void>;
  flushCanvasUpdates: () => void;
}

const TAG = "friendz.wiring";

/** wrap an automerge DocHandle as a SocialDoc (for browser/standalone mode) */
export function docHandleAsSocialDoc(handle: DocHandle<any>): SocialDoc {
  return {
    get current(): SocialState {
      return (handle.doc() ?? {}) as SocialState;
    },
    change(fn: (draft: SocialState) => void) {
      handle.change(fn as any);
    },
    on(_event: "change", handler: (state: SocialState) => void): () => void {
      const cb = () => handler((handle.doc() ?? {}) as SocialState);
      handle.on("change", cb);
      return () => handle.off("change", cb);
    },
  };
}

/**
 * initialize the friends protocol and wire all event callbacks.
 * returns null if identity or social doc is not ready yet.
 */
export async function initFriendzWiring(
  deps: FriendzWiringDeps
): Promise<FriendzWiringResult | null> {
  const { repo, irohAdapter, store, narthexDocId, socialWidgetId, messagezWidgetId, profileStore } =
    deps;

  // in tauri mode, identity comes from the running iroh endpoint
  // in standalone mode, identity is stored in IndexedDB
  //
  // both branches use the same cheap, side-effect-free getStoredIdentity()
  // check and abort if no identity exists yet — this function is called
  // unconditionally on every boot (see boot.ts's initFriendzProtocol()), so
  // it must never be what causes a P2P identity to be generated. once the
  // user does generate one (ensureIdentity(), triggered by an explicit
  // action elsewhere), boot.ts's onIdentityChange retry logic calls this
  // again and it proceeds normally.
  const identity = await getStoredIdentity();
  if (!identity) {
    log.warn(TAG, "aborting: no stored identity yet");
    return null;
  }
  const localNodeId = identity.node_id;

  let sDoc: SocialDoc;

  if (deps.socialDoc) {
    sDoc = deps.socialDoc;
  } else {
    const socialEntry = store.getWidget(socialWidgetId);
    if (!socialEntry) {
      log.warn(
        TAG,
        "aborting: socialWidgetId not found in store, FRIENDZ_ALPN handler will NOT be registered",
        { socialWidgetId }
      );
      return null;
    }

    const socialHandle = await repo.find<any>(socialEntry.docId as DocumentId);
    sDoc = docHandleAsSocialDoc(socialHandle);
  }

  let messagezHandle: DocHandle<any> | null = null;

  if (deps.messagezDocHandle) {
    messagezHandle = deps.messagezDocHandle;
  } else {
    const messagezEntry = store.getWidget(messagezWidgetId);
    if (messagezEntry?.docId) {
      messagezHandle = await repo.find<any>(messagezEntry.docId as DocumentId);
    }
  }

  const profileVisibility = sDoc.current.profileVisibility ?? "friends";
  const friendRequestsFrom = sDoc.current.friendRequestsFrom ?? "everyone";

  const messagezDoc = messagezHandle?.doc();
  const canvasInvitesFrom = messagezDoc?.canvasInvitesFrom ?? "everyone";

  const getMidden = isTauriMode()
    ? async () => (await TauriStreamNode.create()) as MiddenStreamNode
    : async () => (await getMiddenNode()) as unknown as MiddenStreamNode;

  const protocol = new FriendzProtocol({
    getMidden,
    localNodeId,
    localUsername: sDoc.current.profile?.username ?? "anonymous",
    getLocalProfile: () => {
      const p = sDoc.current.profile;
      const base = {
        username: p?.username ?? "anonymous",
        bio: p?.bio ?? "",
        avatarDataUrl: p?.avatarDataUrl ?? "",
        ...(p?.accentColor !== undefined ? { accentColor: p.accentColor } : {}),
      };
      if (!profileStore) return base;
      const updatedAt = profileStore.updatedAt();
      return {
        ...base,
        profileDocId: profileStore.handle.documentId,
        ...(updatedAt ? { profileUpdatedAt: updatedAt } : {}),
      };
    },
    isFriend: (nodeId: string) => {
      const friends = sDoc.current.friends ?? [];
      return friends.some((f: any) => f.nodeIds?.some((n: any) => n.nodeId === nodeId));
    },
    profileVisibility,
    friendRequestsFrom,
    canvasInvitesFrom,
    getCanvasActivity: () => {
      try {
        const narthexHandle = repo.handles[narthexDocId as DocumentId];
        const narthexDoc = narthexHandle?.doc();
        if (!narthexDoc) return [];

        const entries: CanvasActivityEntry[] = [];

        for (const [_cardId, card] of Object.entries(narthexDoc.widgets ?? {}) as any[]) {
          if (card.type !== "canvas-card") continue;
          const canvasDocId = (card.props as any)?.canvasDocId;
          if (!canvasDocId) continue;

          let lastMod: string | null = null;

          try {
            const canvasHandle = repo.handles[canvasDocId as DocumentId];
            const canvasDoc = canvasHandle?.doc() as CanvasDocument | undefined;

            if (canvasDoc) {
              let widgetCount = 0;
              for (const [_wid, widget] of Object.entries(canvasDoc.widgets ?? {}) as any[]) {
                widgetCount++;
                if (!lastMod || (widget.lastModifiedAt && widget.lastModifiedAt > lastMod)) {
                  lastMod = widget.lastModifiedAt ?? null;
                }
              }

              // also check card-level metadata
              try {
                const cardHandle = repo.handles[card.docId as DocumentId];
                const cardDoc = cardHandle?.doc();
                if (cardDoc?.lastVisitedAt && (!lastMod || cardDoc.lastVisitedAt > lastMod)) {
                  lastMod = cardDoc.lastVisitedAt;
                }
              } catch {
                // ignore
              }

              entries.push({
                canvasDocId,
                lastModifiedAt: lastMod ?? "",
                widgetCount,
              });
            }
          } catch {
            // canvas doc not yet synced — skip
          }
        }

        return entries;
      } catch {
        return [];
      }
    },
  });

  // register ALPN handler for incoming friendz streams
  log.debug(
    TAG,
    "registering FRIENDZ_ALPN handler on irohAdapter, localNodeId:",
    localNodeId.slice(0, 16) + "..."
  );
  irohAdapter.registerAlpnHandler(FRIENDZ_ALPN, (stream) => {
    log.debug(
      TAG,
      "FRIENDZ_ALPN callback fired, peer:",
      stream.peer_node_id().slice(0, 16) + "...",
      "-> handing to protocol.handleStream"
    );
    protocol.handleStream(stream);
  });

  // register ALPN handler for incoming skein/1 streams (blob serving, proxy requests)
  log.debug(TAG, "registering skein/1 handler on irohAdapter");
  irohAdapter.registerAlpnHandler("skein/1", handleSkeinStream);

  // collect unsub callbacks so the caller can tear everything down
  const unsubs: Array<() => void> = [];

  // --- wire event callbacks ---

  // extracted (mirrors wireKnockHandlers below) so the friend-entry-recording
  // logic — including the sticky hub-flag merge — is directly unit-testable
  // without the rest of initFriendzWiring's heavier setup (identity, midden,
  // narthex doc lookups, etc).
  wireFriendHandlers({ protocol, sDoc, profileStore });

  // incoming friend reject -> update outbound request status
  protocol.onFriendReject = (_msg, fromNodeId) => {
    sDoc.change((draft: any) => {
      if (draft.outboundRequests) {
        for (const req of draft.outboundRequests) {
          if (req.toNodeId === fromNodeId && req.status === "pending") {
            req.status = "rejected";
          }
        }
      }
    });
  };

  // incoming profile response -> update friend's profile data
  protocol.onProfileResponse = (msg, fromNodeId) => {
    sDoc.change((draft: any) => {
      if (!draft.friends) return;
      for (const friend of draft.friends) {
        if (!friend.nodeIds) continue;
        let matched = false;
        for (const n of friend.nodeIds) {
          if (n.nodeId === fromNodeId) {
            matched = true;
            if (msg.username) n.username = msg.username;
            if (msg.bio !== undefined) n.bio = msg.bio;
            if (msg.avatarDataUrl !== undefined) n.avatarDataUrl = msg.avatarDataUrl;
            if (msg.accentColor !== undefined) n.accentColor = msg.accentColor;
            n.lastSeenAt = new Date().toISOString();
            // profile-doc pointer (docs/hub-and-profile-plan.md section 6)
            // — only overwrite if strictly newer, or the current entry has
            // no id yet at all, so a stale/incomplete late arrival can't
            // clobber a more recent value learned via gossip relay.
            if (
              msg.profileDocId &&
              (!n.profileDocId || (msg.profileUpdatedAt ?? "") > (n.profileUpdatedAt ?? ""))
            ) {
              n.profileDocId = msg.profileDocId;
              n.profileUpdatedAt = msg.profileUpdatedAt ?? "";
            }
          }
        }
        // also update the top-level friend.username so the display name
        // resolves correctly (friendDisplayName checks friend.username first).
        // alias is left alone — it's a user-controlled local label.
        if (matched && msg.username) {
          friend.username = msg.username;
        }
      }
    });
  };

  // incoming heartbeat -> update last seen
  protocol.onHeartbeat = (_msg, fromNodeId) => {
    sDoc.change((draft: any) => {
      if (!draft.friends) return;
      for (const friend of draft.friends) {
        if (!friend.nodeIds) continue;
        for (const n of friend.nodeIds) {
          if (n.nodeId === fromNodeId) {
            n.lastSeenAt = new Date().toISOString();
          }
        }
      }
    });
  };

  // canvas invite handling
  protocol.onCanvasInvite = (msg, fromNodeId) => {
    log.debug(
      TAG,
      "received canvas invite from:",
      fromNodeId.slice(0, 16) + "...",
      "canvas:",
      msg.canvasDocId.slice(0, 16) + "...",
      "origin:",
      msg.originNodeId.slice(0, 16) + "...",
      "title:",
      msg.canvasTitle,
      "messagezHandle?",
      !!messagezHandle
    );

    if (!messagezHandle) {
      log.warn(TAG, "no messagez handle — cannot write invite to inbox");
      return;
    }

    messagezHandle.change((draft: any) => {
      if (!draft.invites) draft.invites = [];

      // check for existing invite for same canvas from same origin
      const currentInbox = (draft.invites ?? []) as any[];
      const alreadyHave = currentInbox.some(
        (inv: any) => inv.canvasDocId === msg.canvasDocId && inv.fromNodeId === msg.originNodeId
      );

      if (alreadyHave) {
        log.debug(TAG, "duplicate invite — already in inbox, skipping");
        return;
      }

      const inviteRecord = {
        id: crypto.randomUUID(),
        canvasDocId: msg.canvasDocId,
        canvasTitle: msg.canvasTitle ?? "",
        canvasDescription: msg.canvasDescription ?? "",
        canvasColor: typeof msg.canvasColor === "number" ? msg.canvasColor : 0,
        canvasPreviewUrl: msg.canvasPreviewUrl ?? "",
        fromNodeId: msg.originNodeId,
        fromUsername: msg.originUsername ?? "unknown",
        relayedBy: fromNodeId !== msg.originNodeId ? fromNodeId : "",
        role: msg.role,
        receivedAt: new Date().toISOString(),
        status: "pending" as const,
      };

      draft.invites.push(inviteRecord);
      log.debug(
        TAG,
        "wrote invite to inbox — total invites:",
        draft.invites.length,
        "record:",
        JSON.stringify(inviteRecord)
      );
    });

    // send ACK back to the sender
    protocol
      .sendCanvasInviteAck(fromNodeId, {
        inviteId: msg.inviteId,
        canvasDocId: msg.canvasDocId,
        ackerNodeId: localNodeId,
      })
      .catch((err) => {
        log.warn(TAG, "failed to send invite ACK:", err);
      });
  };

  protocol.onCanvasInviteAck = (msg, fromNodeId) => {
    log.debug(
      TAG,
      "received invite ACK from:",
      fromNodeId.slice(0, 16) + "...",
      "canvas:",
      msg.canvasDocId.slice(0, 16) + "..."
    );
    if (!messagezHandle) return;

    messagezHandle.change((draft: any) => {
      if (!draft.sentInviteAcks) draft.sentInviteAcks = [];
      draft.sentInviteAcks.push({
        inviteId: msg.inviteId,
        canvasDocId: msg.canvasDocId,
        ackerNodeId: fromNodeId,
      });
    });

    // update outbox: mark matching share as delivered
    messagezHandle.change((draft: any) => {
      if (!draft.shares) return;
      for (const share of draft.shares) {
        if (
          share.canvasDocId === msg.canvasDocId &&
          share.toNodeId === (msg.ackerNodeId || fromNodeId)
        ) {
          share.delivered = true;
        }
      }
    });
  };

  protocol.onCanvasInviteAccept = (msg, fromNodeId) => {
    log.debug(
      TAG,
      "received invite ACCEPT from:",
      fromNodeId.slice(0, 16) + "...",
      "canvas:",
      msg.canvasDocId.slice(0, 16) + "..."
    );
    if (!messagezHandle) return;

    messagezHandle.change((draft: any) => {
      if (!draft.shares) return;
      for (const share of draft.shares) {
        if (
          share.canvasDocId === msg.canvasDocId &&
          share.toNodeId === (msg.accepterNodeId || fromNodeId)
        ) {
          share.accepted = true;
          share.delivered = true; // accepting implies delivery
        }
      }
    });

    // mark the pending invite as accepted — do NOT remove it here. the
    // accepter hasn't necessarily connected yet (they still need to dial in
    // via iroh and write themselves into the canvas doc's `peers` map); if
    // we delete the invite now, it vanishes from the share dialog with no
    // "accepted, connecting…" state to show in the meantime. it gets
    // removed for real once the accepter shows up in `peers` (see
    // boot.ts's join/navigate flow, which already does this cleanup).
    try {
      const accepterId = msg.accepterNodeId || fromNodeId;
      const canvasHandle = repo.handles[msg.canvasDocId as any];
      if (canvasHandle) {
        canvasHandle.change((draft: any) => {
          const invite = draft.pendingInvites?.[accepterId];
          if (invite) {
            invite.accepted = true;
            invite.acceptedAt = new Date().toISOString();
          }
        });
      }
    } catch {
      // best effort
    }

    // establish automerge sync connection to the accepting peer so they can
    // pull the canvas doc. without this, the accepter has no way to get the doc
    // because they don't yet appear in the canvas peers map.
    const syncTargetId = msg.accepterNodeId || fromNodeId;
    irohAdapter.addPeer(syncTargetId).catch((err) => {
      log.warn(
        TAG,
        "failed to connect to accepting peer for sync:",
        syncTargetId.slice(0, 16) + "...",
        err
      );
    });
    log.debug(
      TAG,
      "initiated sync connection to accepting peer:",
      syncTargetId.slice(0, 16) + "..."
    );
  };

  protocol.onCanvasInviteDecline = (msg, fromNodeId) => {
    log.debug(
      TAG,
      "received invite DECLINE from:",
      fromNodeId.slice(0, 16) + "...",
      "canvas:",
      msg.canvasDocId.slice(0, 16) + "..."
    );
    if (!messagezHandle) return;

    messagezHandle.change((draft: any) => {
      if (!draft.shares) return;
      for (const share of draft.shares) {
        if (
          share.canvasDocId === msg.canvasDocId &&
          share.toNodeId === (msg.declinerNodeId || fromNodeId)
        ) {
          share.declined = true;
          share.delivered = true; // declining implies delivery
        }
      }
    });

    // clean up pendingInvites on the canvas doc — this peer declined
    try {
      const declinerId = msg.declinerNodeId || fromNodeId;
      const canvasHandle = repo.handles[msg.canvasDocId as any];
      if (canvasHandle) {
        canvasHandle.change((draft: any) => {
          if (draft.pendingInvites?.[declinerId]) {
            delete draft.pendingInvites[declinerId];
          }
        });
      }
    } catch {
      // best effort
    }
  };

  // ACL-change (role update / access revocation) handling — exported as a
  // standalone function (mirrors `wireKnockHandlers`/`wireFriendHandlers`
  // below) so it can be exercised directly in tests without the full
  // narthex/social/messagez setup this function requires.
  wireAclChangeHandlers({ protocol, repo, narthexDocId });

  // knock (access request) handling — mirrors the canvas-invite handlers
  // above; see `wireKnockHandlers()`'s doc comment for the full behavior.
  // exported as a standalone function (rather than inlined here) so it can
  // also be exercised directly in tests without needing the full narthex/
  // social/messagez setup this function requires.
  wireKnockHandlers({ protocol, repo, irohAdapter, localNodeId });


  // wire outbound requests through the bridge
  initBridge(protocol);

  // hook outbound request side-effects: track sent friend requests in social doc
  setOutboundRequestHook((targetNodeId: string) => {
    sDoc.change((draft: any) => {
      if (!draft.outboundRequests) draft.outboundRequests = [];
      const exists = draft.outboundRequests.some((r: any) => r.toNodeId === targetNodeId);
      if (!exists) {
        draft.outboundRequests.push({
          toNodeId: targetNodeId,
          toUsername: "unknown",
          sentAt: new Date().toISOString(),
          status: "pending",
        });
      }
    });
  });

  // --- canvas update federation (phase 2): send side ---
  // track which canvas docs we're already watching (by per-widget docId)
  const watchedCanvasWidgets = new Set<string>();
  // canvases with changes since last heartbeat flush
  const dirtyCanvases = new Map<
    string,
    { canvasDocId: string; lastModified: string; widgetCount: number }
  >();

  /** attach a change listener to the canvas doc behind a canvas-card widget. */
  function watchCanvasForFederation(widgetDocId: string): void {
    if (watchedCanvasWidgets.has(widgetDocId)) return;
    watchedCanvasWidgets.add(widgetDocId);

    // resolve canvas doc id from the per-widget doc (async, fire-and-forget)
    (async () => {
      try {
        const cardHandle = await repo.find<any>(widgetDocId as DocumentId);
        await cardHandle.whenReady();
        const cardDoc = cardHandle.doc() as Record<string, unknown> | undefined;
        const canvasDocId = cardDoc?.canvasDocId as string | undefined;
        if (!canvasDocId) return;

        let canvasHandle: DocHandle<any>;
        try {
          canvasHandle = await repo.find<CanvasDocument>(canvasDocId as DocumentId);
        } catch {
          return; // canvas not available
        }

        const onChange = () => {
          const canvasDoc = canvasHandle.doc() as CanvasDocument | undefined;
          if (!canvasDoc) return;

          // only gossip our own edits — prevents amplification of remote syncs
          if (canvasDoc.lastModifiedBy && canvasDoc.lastModifiedBy !== localNodeId) return;

          // count widgets and find latest modification timestamp
          let widgetCount = 0;
          let lastMod = canvasDoc.lastModified ?? "";
          for (const [, w] of Object.entries(canvasDoc.widgets ?? {}) as any[]) {
            widgetCount++;
            if (w.lastModifiedAt && w.lastModifiedAt > lastMod) {
              lastMod = w.lastModifiedAt;
            }
          }

          dirtyCanvases.set(canvasDocId, {
            canvasDocId,
            lastModified: lastMod,
            widgetCount,
          });
        };

        canvasHandle.on("change", onChange);
        unsubs.push(() => canvasHandle.off("change", onChange));
      } catch (err) {
        log.warn(TAG, "failed to watch canvas for federation:", err);
      }
    })();
  }

  // attach watchers to existing canvas-card widgets
  const widgets = store.handle.doc()?.widgets ?? {};
  for (const [_id, widget] of Object.entries(widgets) as any[]) {
    if (!widget?.docId) continue;
    if (widget.type !== "canvas-card") continue;
    watchCanvasForFederation(widget.docId);
  }

  // watch for new canvas cards being added
  store.handle.on("change", () => {
    const doc = store.handle.doc();
    if (!doc) return;

    for (const [_id, widget] of Object.entries(doc.widgets ?? {}) as any[]) {
      if (!widget?.docId) continue;
      if (widget.type !== "canvas-card") continue;
      watchCanvasForFederation(widget.docId);
    }
  });

  // narthex doc metadata sync
  {
    const narthexHandle = await repo.find<any>(narthexDocId as DocumentId);
    const narthexDoc = narthexHandle.doc();

    if (narthexDoc) {
      // sync card props from canvas docs into narthex card metadata
      for (const [_cardId, card] of Object.entries(narthexDoc.widgets ?? {}) as any[]) {
        if (!card?.docId) continue;

        try {
          const cardHandle = await repo.find<any>(card.docId as DocumentId);
          const cardDoc = cardHandle.doc();

          if (cardDoc) {
            const lastVisited = cardDoc.lastVisitedAt as string | undefined;
            const currentKnown = card.lastVisitedAt;
            if (lastVisited && (!currentKnown || lastVisited > currentKnown)) {
              narthexHandle.change((draft: any) => {
                if (draft.widgets?.[_cardId]) {
                  draft.widgets[_cardId].lastVisitedAt = lastVisited;
                }
              });
            }
          }
        } catch {
          // canvas not synced yet
        }
      }
    }
  }

  // watch for social doc changes (to update protocol settings)
  const onSocialChange = (state: SocialState) => {
    const pv = state.profileVisibility ?? "friends";
    const frf = state.friendRequestsFrom ?? "everyone";
    protocol.setProfileVisibility(pv);
    protocol.setFriendRequestsFrom(frf);
  };
  const unsubSocial = sDoc.on("change", onSocialChange);
  unsubs.push(unsubSocial);

  // watch for messagez doc changes
  if (messagezHandle) {
    const onMessagezChange = () => {
      const doc = messagezHandle!.doc();
      if (!doc) return;
      const cif = doc.canvasInvitesFrom ?? "everyone";
      protocol.setCanvasInvitesFrom(cif);
    };
    messagezHandle.on("change", onMessagezChange);
    unsubs.push(() => messagezHandle!.off("change", onMessagezChange));
  }

  // auto-connect to friends' node IDs
  const friends = sDoc.current.friends ?? [];
  for (const friend of friends as any[]) {
    const nodeIds = friend.nodeIds ?? [];
    for (const n of nodeIds) {
      if (n.nodeId && n.nodeId !== localNodeId) {
        irohAdapter.addPeer(n.nodeId).catch(() => {
          // silent — peer may be offline
        });
      }
    }
  }

  /** flush pending dirty canvas update notifications to online peers.
   *  called from onAfterHeartbeatTick and also exposed for manual flush on navigation/close. */
  function flushDirtyCanvasUpdates(): void {
    if (dirtyCanvases.size === 0) return;

    const localUsername = sDoc.current.profile?.username ?? "anonymous";
    const onlinePeers = protocol.getOnlinePeers();

    for (const [, info] of dirtyCanvases) {
      try {
        const canvasHandle = repo.handles[info.canvasDocId as any];
        const canvasDoc = canvasHandle?.doc() as CanvasDocument | undefined;
        const peers = canvasDoc?.peers ?? {};

        // if the canvas was just deleted by us, send canvas-deleted instead of canvas-update
        if ((canvasDoc as any)?.deleted && (canvasDoc as any)?.deletedBy === localNodeId) {
          for (const peerNodeId of Object.keys(peers)) {
            if (peerNodeId === localNodeId) continue;
            if (!onlinePeers.includes(peerNodeId)) continue;

            protocol
              .sendCanvasDeleted(peerNodeId, {
                canvasDocId: info.canvasDocId,
                canvasTitle: (canvasDoc as any)?.title ?? "",
                deletedBy: localNodeId,
                deletedByUsername: localUsername,
                deleteMode: (canvasDoc as any)?.deleteMode ?? "soft",
                deletedAt: (canvasDoc as any)?.deletedAt ?? new Date().toISOString(),
              })
              .catch((err) => {
                log.warn(
                  TAG,
                  "canvas-deleted send failed for:",
                  peerNodeId.slice(0, 16) + "...",
                  err
                );
              });
          }
          continue; // skip the normal CanvasUpdate send
        }

        for (const peerNodeId of Object.keys(peers)) {
          if (peerNodeId === localNodeId) continue;
          if (!onlinePeers.includes(peerNodeId)) continue;

          protocol
            .sendCanvasUpdate(peerNodeId, {
              canvasDocId: info.canvasDocId,
              lastModifiedAt: info.lastModified,
              widgetCount: info.widgetCount,
              modifiedByNodeId: localNodeId,
              modifiedByUsername: localUsername,
            })
            .catch((err) => {
              log.warn(TAG, "canvas update send failed for:", peerNodeId.slice(0, 16) + "...", err);
            });
        }
      } catch (err) {
        log.warn(TAG, "failed to flush canvas update:", info.canvasDocId.slice(0, 16) + "...", err);
      }
    }

    dirtyCanvases.clear();
  }

  protocol.onAfterHeartbeatTick = (_friendNodeIds: string[]) => {
    flushDirtyCanvasUpdates();
  };

  /** compute and send a gossip digest to a peer that just came online.
   *  scans local canvas docs for shared canvases with updates and pending invites. */
  async function computeAndSendGossipDigest(peerNodeId: string): Promise<void> {
    const canvasUpdates: GossipDigestMessage["canvasUpdates"] = [];
    const pendingInvites: GossipDigestMessage["pendingInvites"] = [];
    const pendingKnocks: GossipDigestMessage["pendingKnocks"] = [];
    const profiles: GossipDigestMessage["profiles"] = [];
    const sharedCanvasIds: string[] = [];

    // our own profile-doc pointer (docs/hub-and-profile-plan.md section 6)
    // — sent directly here too (not just via profile-request/response) so
    // a friend who comes online learns about profile updates without
    // needing to separately re-request our profile.
    if (profileStore) {
      const updatedAt = profileStore.updatedAt();
      profiles.push({
        peerNodeId: localNodeId,
        profileDocId: profileStore.handle.documentId,
        updatedAt,
      });
    }

    // relay every OTHER friend's profile-doc pointer we already know about
    // (learned via an earlier direct profile-response or an earlier relay)
    // — this is what lets profile info reach a peer with no direct
    // connection to the profile's actual owner, same "gossip everything
    // relevant, let the receiver dedupe/ignore stale" pattern as
    // pendingInvites/pendingKnocks above.
    for (const friend of sDoc.current.friends ?? []) {
      for (const n of friend.nodeIds ?? []) {
        if (!n.profileDocId) continue;
        if (n.nodeId === peerNodeId) continue; // no point telling them about themselves
        profiles.push({
          peerNodeId: n.nodeId,
          profileDocId: n.profileDocId,
          updatedAt: n.profileUpdatedAt ?? "",
        });
      }
    }

    const narthexHandle = repo.handles[narthexDocId as any];
    const narthexDoc = narthexHandle?.doc();
    // note: canvas-update/invite/knock gathering below all depend on the
    // narthex doc being ready — but a profile-only digest (nothing to do
    // with canvases at all) shouldn't be discarded just because the
    // narthex doc happens to not be synced yet, so this is a guarded block
    // rather than an early `return`.
    if (narthexDoc?.widgets) {
      for (const [_cardId, card] of Object.entries(narthexDoc.widgets) as any[]) {
        if (card.type !== "canvas-card") continue;
      const canvasDocId = (card.props as any)?.canvasDocId;
      if (!canvasDocId) continue;

      try {
        const canvasHandle = repo.handles[canvasDocId as any];
        const canvasDoc = canvasHandle?.doc() as CanvasDocument | undefined;
        if (!canvasDoc) continue;

        // include deletion info in gossip for tombstoned canvases
        if ((canvasDoc as any).deleted) {
          const peerIsParticipant =
            !!canvasDoc.peers?.[peerNodeId] || !!canvasDoc.pendingInvites?.[peerNodeId];
          if (peerIsParticipant) {
            canvasUpdates.push({
              canvasDocId,
              lastModifiedAt: canvasDoc.lastModified ?? "",
              lastModifiedBy: canvasDoc.lastModifiedBy ?? "",
              deleted: true,
            });
          }
          continue; // skip normal gossip processing for deleted canvas
        }

        // only include in sharedCanvasIds if the peer is on this canvas
        // (in peers or pendingInvites) — don't leak canvas IDs to unrelated peers
        const peerIsParticipant =
          !!canvasDoc.peers?.[peerNodeId] || !!canvasDoc.pendingInvites?.[peerNodeId];
        if (peerIsParticipant) {
          sharedCanvasIds.push(canvasDocId);
        }

        // check for canvas updates: peer is on this canvas and has stale state
        const peerEntry = canvasDoc.peers?.[peerNodeId];
        if (peerEntry) {
          const peerLastSeen = peerEntry.lastSeenAt ?? "";
          if (canvasDoc.lastModified && canvasDoc.lastModified > peerLastSeen) {
            canvasUpdates.push({
              canvasDocId,
              lastModifiedAt: canvasDoc.lastModified,
              lastModifiedBy: canvasDoc.lastModifiedBy ?? "",
            });
          }
        }

        // check for pending invites targeting this peer
        const pendingInvite = canvasDoc.pendingInvites?.[peerNodeId];
        if (pendingInvite && !canvasDoc.peers?.[peerNodeId]) {
          pendingInvites.push({
            canvasDocId,
            canvasTitle: canvasDoc.title ?? "",
            canvasDescription: canvasDoc.description ?? "",
            canvasColor: canvasDoc.color ?? 0,
            canvasPreviewUrl: canvasDoc.previewUrl ?? "",
            invitedBy: pendingInvite.invitedBy,
            invitedByUsername: pendingInvite.invitedByUsername ?? "",
            role: pendingInvite.role,
            invitedAt: pendingInvite.invitedAt,
          });
        }

        // check for pending knocks this peer can see and potentially relay
        // onward. unlike pendingInvites (keyed by the invite's target),
        // pendingKnocks is keyed by the *requester*'s node id — so "is this
        // entry for peerNodeId" doesn't apply here. instead, gossip every
        // open knock on canvases the peer already fully participates in
        // (only full members/admins are in a position to act on or relay a
        // knock further).
        if (canvasDoc.peers?.[peerNodeId]) {
          for (const knock of Object.values(canvasDoc.pendingKnocks ?? {})) {
            if (knock.requesterNodeId === peerNodeId) continue;
            pendingKnocks.push({
              canvasDocId,
              requesterNodeId: knock.requesterNodeId,
              requesterUsername: knock.requesterUsername,
              message: knock.message,
              knockedAt: knock.knockedAt,
            });
          }
        }
      } catch {
        // canvas doc not synced yet — skip
      }
      }
    }

    if (
      canvasUpdates.length === 0 &&
      pendingInvites.length === 0 &&
      pendingKnocks.length === 0 &&
      profiles.length === 0 &&
      sharedCanvasIds.length === 0
    )
      return;

    log.debug(
      TAG,
      "sending gossip digest to:",
      peerNodeId.slice(0, 16) + "...",
      "updates:",
      canvasUpdates.length,
      "invites:",
      pendingInvites.length,
      "knocks:",
      pendingKnocks.length,
      "profiles:",
      profiles.length,
      "canvases:",
      sharedCanvasIds.length
    );

    await protocol.sendGossipDigest(peerNodeId, {
      canvasUpdates,
      pendingInvites,
      pendingKnocks,
      ...(sharedCanvasIds.length > 0 ? { sharedCanvasIds } : {}),
      ...(profiles.length > 0 ? { profiles } : {}),
    });
  }

  // send a gossip digest when a friend peer transitions to online.
  // this fires on BOTH sides of the heartbeat handshake, making the exchange
  // bidirectional — each peer tells the other about canvas updates and pending invites.
  //
  // also: take this chance to retry anything that may have been lost when
  // the prior connection died (e.g. the browser-WASM iroh transport drops
  // outbound streams under nat conditions). edge cases handled here:
  //   1. pending outbound friend-request to this peer: resend (idempotent on
  //      receiver side because reciprocal auto-accept now dedupes)
  //   2. peer is in our friends list but we have no profile data yet: ask
  //      again so bio/avatar populate after the first reachable round-trip
  protocol.onPeerBecameOnline = (peerNodeId: string) => {
    const friends = sDoc.current.friends ?? [];
    const friendEntry = friends.find((f: any) =>
      f.nodeIds?.some((n: any) => n.nodeId === peerNodeId)
    );
    const isFriend = !!friendEntry;

    // (1) retry pending outbound friend-request to this peer
    const outbound = sDoc.current.outboundRequests ?? [];
    const stillPending = outbound.find(
      (r: any) => r.toNodeId === peerNodeId && r.status === "pending"
    );
    if (stillPending) {
      log.debug(
        TAG,
        "retrying pending outbound friend-request to:",
        peerNodeId.slice(0, 16) + "..."
      );
      protocol.sendFriendRequest(peerNodeId).catch((err) => {
        log.warn(TAG, "retry sendFriendRequest failed for", peerNodeId.slice(0, 16) + "...", err);
      });
    }

    // (2) retry profile-request if friend's nodeId entry has no display data
    if (isFriend) {
      const node = friendEntry.nodeIds?.find((n: any) => n.nodeId === peerNodeId);
      const hasProfile = !!(node?.username || node?.bio || node?.avatarDataUrl);
      if (!hasProfile) {
        log.debug(TAG, "retrying profile-request to:", peerNodeId.slice(0, 16) + "...");
        protocol.requestProfile(peerNodeId).catch((err) => {
          log.warn(TAG, "retry requestProfile failed for", peerNodeId.slice(0, 16) + "...", err);
        });
      }
    }

    if (!isFriend) return;

    computeAndSendGossipDigest(peerNodeId).catch((err) => {
      log.warn(TAG, "gossip digest failed for:", peerNodeId.slice(0, 16) + "...", err);
    });
  };

  // handle incoming canvas update notifications
  protocol.onCanvasUpdate = (msg, _fromNodeId) => {
    // filter out our own updates (we already see them locally)
    if (msg.modifiedByNodeId === localNodeId) return;

    // check if we're currently viewing this canvas — if so, suppress
    const currentHash = window.location.hash.replace(/^#/, "");
    if (currentHash === msg.canvasDocId) return;

    // find the canvas card in the narthex and mark hasUpdates
    try {
      const narthexHandle = repo.handles[narthexDocId as any];
      const narthexDoc = narthexHandle?.doc();
      if (!narthexDoc?.widgets) return;

      for (const [_cardId, card] of Object.entries(narthexDoc.widgets) as any[]) {
        if (card?.props?.canvasDocId === msg.canvasDocId && card.docId) {
          // update the per-widget doc (where the canvas-card reads hasUpdates from)
          const cardHandle = repo.handles[card.docId as any];
          if (cardHandle) {
            cardHandle.change((draft: any) => {
              draft.hasUpdates = true;
              draft.lastKnownModifiedAt = msg.lastModifiedAt;
              draft.lastModifiedBy = msg.modifiedByNodeId;
            });
          }
          break;
        }
      }
    } catch (err) {
      log.warn(TAG, "failed to mark canvas update:", err);
    }
  };

  // handle incoming canvas-deleted notifications
  protocol.onCanvasDeleted = (msg, fromNodeId) => {
    log.debug(
      TAG,
      "received canvas-deleted from:",
      fromNodeId.slice(0, 16) + "...",
      "canvas:",
      msg.canvasDocId.slice(0, 16) + "...",
      "mode:",
      msg.deleteMode
    );

    // write deletion notification to messagez doc
    if (messagezHandle) {
      messagezHandle.change((draft: any) => {
        if (!draft.deletions) draft.deletions = [];

        // dedup by canvasDocId
        const existing = (draft.deletions as any[]).some(
          (d: any) => d.canvasDocId === msg.canvasDocId
        );
        if (existing) {
          log.debug(TAG, "duplicate deletion notification — skipping");
          return;
        }

        draft.deletions.push({
          id: crypto.randomUUID(),
          canvasDocId: msg.canvasDocId,
          canvasTitle: msg.canvasTitle ?? "",
          canvasColor: 0,
          deletedBy: msg.deletedBy,
          deletedByUsername: msg.deletedByUsername ?? "",
          deleteMode: msg.deleteMode ?? "soft",
          deletedAt: msg.deletedAt ?? new Date().toISOString(),
          status: "unread",
        });

        log.debug(TAG, "wrote deletion notification to inbox — total:", draft.deletions.length);
      });
    }

    // sync deletion state to the canvas card doc so it reflects immediately
    // (the automerge sync will eventually catch up, but the friendz message
    // arrives faster than doc sync in most cases)
    try {
      const narthexHandle = repo.handles[narthexDocId as any];
      const narthexDoc = narthexHandle?.doc();
      if (narthexDoc?.widgets) {
        for (const [_cardId, card] of Object.entries(narthexDoc.widgets) as any[]) {
          if (card?.type === "canvas-card" && card.docId) {
            const cardHandle = repo.handles[card.docId as any];
            const cardDoc = cardHandle?.doc() as Record<string, unknown> | undefined;
            if (cardDoc?.canvasDocId === msg.canvasDocId) {
              cardHandle.change((draft: any) => {
                draft.isDeleted = true;
                draft.deletedAt = msg.deletedAt ?? "";
                draft.deletedBy = msg.deletedBy ?? "";
                draft.deleteMode = msg.deleteMode ?? "soft";
              });
              log.debug(
                TAG,
                "synced deletion state to canvas card:",
                msg.canvasDocId.slice(0, 16) + "..."
              );
              break;
            }
          }
        }
      }
    } catch (err) {
      log.warn(TAG, "failed to sync card metadata after deletion:", err);
    }
  };

  // handle incoming gossip digests from peers that just came online
  protocol.onGossipDigest = (msg, fromNodeId) => {
    // defensive: normalize every array field up front. a digest
    // constructed by a peer running mismatched code (e.g. reliquary's
    // hub-constructed GossipDigest messages omitted `pendingKnocks`
    // entirely before that field was added to the Rust wire struct) must
    // degrade to "nothing to do for that field", not throw and abort
    // processing of the OTHER fields in the same digest.
    if (!Array.isArray(msg.canvasUpdates)) msg.canvasUpdates = [];
    if (!Array.isArray(msg.pendingInvites)) msg.pendingInvites = [];
    if (!Array.isArray(msg.pendingKnocks)) msg.pendingKnocks = [];
    if (!Array.isArray(msg.profiles)) msg.profiles = [];

    // process canvas update notifications
    for (const update of msg.canvasUpdates) {
      // skip our own edits
      if (update.lastModifiedBy === localNodeId) continue;

      // skip if currently viewing this canvas
      const currentHash = window.location.hash.replace(/^#/, "");
      if (currentHash === update.canvasDocId) continue;

      // check if this is a deletion notification via gossip
      if (update.deleted) {
        log.debug(TAG, "gossip: canvas deleted:", update.canvasDocId.slice(0, 16) + "...");

        // write deletion notification to messagez (dedup)
        if (messagezHandle) {
          messagezHandle.change((draft: any) => {
            if (!draft.deletions) draft.deletions = [];
            const existing = (draft.deletions as any[]).some(
              (d: any) => d.canvasDocId === update.canvasDocId
            );
            if (existing) return;

            draft.deletions.push({
              id: crypto.randomUUID(),
              canvasDocId: update.canvasDocId,
              canvasTitle: "",
              canvasColor: 0,
              deletedBy: update.lastModifiedBy,
              deletedByUsername: "",
              deleteMode: "soft",
              deletedAt: update.lastModifiedAt,
              status: "unread",
            });
          });
        }

        // sync deletion state to canvas card
        try {
          const narthexHandle = repo.handles[narthexDocId as any];
          const narthexDoc = narthexHandle?.doc();
          if (narthexDoc?.widgets) {
            for (const [_cardId, card] of Object.entries(narthexDoc.widgets) as any[]) {
              if (card?.props?.canvasDocId === update.canvasDocId && card.docId) {
                const cardHandle = repo.handles[card.docId as any];
                if (cardHandle) {
                  cardHandle.change((draft: any) => {
                    draft.isDeleted = true;
                    draft.deletedAt = update.lastModifiedAt ?? "";
                    draft.deletedBy = update.lastModifiedBy ?? "";
                    draft.deleteMode = "soft";
                  });
                }
                break;
              }
            }
          }
        } catch {
          // best effort
        }

        continue; // skip normal hasUpdates processing
      }

      // find the narthex card and mark hasUpdates
      try {
        const narthexHandle = repo.handles[narthexDocId as any];
        const narthexDoc = narthexHandle?.doc();
        if (!narthexDoc?.widgets) continue;

        for (const [_cardId, card] of Object.entries(narthexDoc.widgets) as any[]) {
          if (card?.props?.canvasDocId === update.canvasDocId && card.docId) {
            const cardHandle = repo.handles[card.docId as any];
            if (cardHandle) {
              cardHandle.change((draft: any) => {
                draft.hasUpdates = true;
                draft.lastKnownModifiedAt = update.lastModifiedAt;
                draft.lastModifiedBy = update.lastModifiedBy;
              });
            }
            break;
          }
        }
      } catch {
        // best effort
      }
    }

    // process pending invite notifications
    for (const invite of msg.pendingInvites) {
      if (!messagezHandle) continue;

      // write to inbox (same logic as onCanvasInvite but from digest data)
      messagezHandle.change((draft: any) => {
        if (!draft.invites) draft.invites = [];

        const currentInbox = (draft.invites ?? []) as any[];
        const alreadyHave = currentInbox.some(
          (inv: any) =>
            inv.canvasDocId === invite.canvasDocId && inv.fromNodeId === invite.invitedBy
        );
        if (alreadyHave) return;

        draft.invites.push({
          id: crypto.randomUUID(),
          canvasDocId: invite.canvasDocId,
          canvasTitle: invite.canvasTitle ?? "",
          canvasDescription: invite.canvasDescription ?? "",
          canvasColor: typeof invite.canvasColor === "number" ? invite.canvasColor : 0,
          canvasPreviewUrl: invite.canvasPreviewUrl ?? "",
          fromNodeId: invite.invitedBy,
          fromUsername: invite.invitedByUsername ?? "unknown",
          relayedBy: fromNodeId,
          role: invite.role,
          receivedAt: new Date().toISOString(),
          status: "pending" as const,
        });

        log.debug(
          TAG,
          "gossip digest: wrote invite to inbox for canvas:",
          invite.canvasDocId.slice(0, 16) + "..."
        );
      });
    }

    // process pending knock notifications — merges directly into the
    // referenced canvas doc's own `pendingKnocks` map (canvas-doc state
    // every admin needs a synced copy of), not a messagez inbox record like
    // pendingInvites above. best-effort per canvas: silently skipped if we
    // don't hold that canvas doc at all.
    mergeGossipDigestKnocks(repo, msg, fromNodeId).catch((err) => {
      log.warn(TAG, "failed to merge gossip-relayed knocks:", err);
    });

    // process relayed profile-doc pointers (docs/hub-and-profile-plan.md
    // section 6) — merges into the social doc's matching friend nodeIds
    // and best-effort syncs the actual doc content.
    mergeGossipDigestProfiles(repo, sDoc, msg, fromNodeId).catch((err) => {
      log.warn(TAG, "failed to merge gossip-relayed profiles:", err);
    });
  };

  // handle incoming blob-seek queries from the hub — check local blob
  // availability and respond with blob-offer listing available hashes.
  protocol.onBlobSeek = async (msg: BlobSeekMessage, fromNodeId: string) => {
    if (!msg.needed || msg.needed.length === 0) return;

    log.debug(
      TAG,
      "received blob-seek from:",
      fromNodeId.slice(0, 16) + "...",
      "needed:",
      msg.needed.length
    );

    try {
      const available: string[] = [];

      for (const blake3Hash of msg.needed) {
        try {
          const record = await getBlobRecordByBlake3(blake3Hash);
          if (record) {
            available.push(blake3Hash);
          }
        } catch {
          // skip this hash on error
        }
      }

      log.debug(TAG, "blob-seek response:", available.length, "of", msg.needed.length, "available");

      if (available.length > 0) {
        await protocol.sendBlobOffer(fromNodeId, { available });
      }
    } catch (err) {
      log.warn(TAG, "blob-seek handler failed:", err);
    }
  };

  // start heartbeat (which sends presence + profile to connected peers)
  protocol.startHeartbeat(() => {
    const fs = sDoc.current.friends ?? [];
    const ids: string[] = [];
    for (const f of fs as any[]) {
      for (const n of f.nodeIds ?? []) {
        if (n.nodeId && n.nodeId !== localNodeId) ids.push(n.nodeId);
      }
    }
    return ids;
  });

  // when a friend connects at the transport level, probe them immediately
  // so we don't have to wait for the next heartbeat tick to discover them.
  const unsubPeerConnect = irohAdapter.onPeerConnect((peerId: string) => {
    // check if this peer is a known friend
    const currentFriends = sDoc.current.friends ?? [];
    const isFriendPeer = currentFriends.some((f: any) =>
      f.nodeIds?.some((n: any) => n.nodeId === peerId)
    );
    // also probe if we have a pending outbound request to this peer — they
    // may have just come back online and we need to deliver the request.
    const outbound = sDoc.current.outboundRequests ?? [];
    const hasPendingOutbound = outbound.some(
      (r: any) => r.toNodeId === peerId && r.status === "pending"
    );
    if (!isFriendPeer && !hasPendingOutbound) {
      log.debug(
        TAG,
        "peer connected but not a friend / no pending outbound, skipping probe:",
        peerId.slice(0, 16) + "..."
      );
      return;
    }

    // only probe if they're not already online (avoid redundant heartbeats)
    if (protocol.isOnline(peerId)) {
      log.debug(
        TAG,
        "peer connected but already online, skipping probe:",
        peerId.slice(0, 16) + "..."
      );
      return;
    }

    log.debug(TAG, "peer connected at transport, probing:", peerId.slice(0, 16) + "...");
    protocol.probePeer(peerId).catch(() => {
      // silent — probe is best-effort
    });
  });
  unsubs.push(unsubPeerConnect);

  // sent friend request tracking is handled by setOutboundRequestHook above

  // request profiles from connected friends on social doc change
  const friendsForProfiles = sDoc.current.friends ?? [];
  for (const friend of friendsForProfiles as any[]) {
    const nodeIds = friend.nodeIds ?? [];
    for (const n of nodeIds) {
      if (n.nodeId && n.nodeId !== localNodeId) {
        protocol.requestProfile(n.nodeId).catch(() => {
          // silent
        });
      }
    }
  }

  // periodically retry failed peer connections
  const unsubReconnect = irohAdapter.onConnectionStateChange(() => {
    // just trigger a re-render — the connection status widget reads live state
  });
  unsubs.push(unsubReconnect);

  // add protocol destroy to unsubs
  unsubs.push(() => protocol.destroy());

  return {
    protocol,
    socialDoc: sDoc,
    messagezDocHandle: messagezHandle,
    unsubs,
    flushCanvasUpdates: flushDirtyCanvasUpdates,
  };
}

// ---------------------------------------------------------------------------
// friend-request / friend-accept handling
//
// exported as a standalone function (rather than inlined into
// `initFriendzWiring()` above, mirroring how `wireKnockHandlers` below is
// factored out) so the friend-entry-recording logic — including the sticky
// hub-flag merge (docs/hub-and-profile-plan.md section 3.3) — can be
// exercised directly in tests without the full narthex/social/messagez setup
// `initFriendzWiring()` requires.
// ---------------------------------------------------------------------------

export interface AclChangeHandlersDeps {
  protocol: FriendzProtocol;
  repo: Repo;
  narthexDocId: string;
}

/**
 * wire the `acl-change` message handler onto `protocol` — an admin changed
 * our role (or revoked access entirely) on a canvas.
 *
 * `sendAclChange`/`onAclChange` (friends-protocol.ts) already existed fully
 * built and tested before this function, but were never actually wired
 * into production. the underlying permission enforcement doesn't depend on
 * this message at all — `.acl` is regular canvas-doc data, so ordinary
 * automerge sync already carries a role change to any peer connected to
 * that doc. this is purely a live UI notification so our own narthex
 * canvas-card's role pill / revoked-overlay updates immediately, instead of
 * staying stale until we happen to reconnect to that specific canvas doc
 * directly (a real reported bug: a demoted peer kept seeing their old
 * "member" pill on the narthex indefinitely).
 *
 * a "removed" role change also auto-trashes the card if the peer's
 * previous role was "viewer" (see the auto-trash block below) — a real
 * user-reported request, 2026-07-02: a viewer never had write access to
 * lose, so there's nothing to gain from leaving them stuck looking at a
 * permanent "revoked" overlay instead of just moving the card to the trash
 * bin (still fully recoverable from there like any other soft-delete). a
 * demoted member/admin is left alone — they might want to keep the card
 * around to request access again, so only the "revoked" overlay applies
 * to them.
 *
 * exported as a standalone function (mirrors `wireFriendHandlers`/
 * `wireKnockHandlers`) so it can be exercised directly in tests without the
 * full narthex/social/messagez setup `initFriendzWiring()` requires.
 */
export function wireAclChangeHandlers(deps: AclChangeHandlersDeps): void {
  const { protocol, repo, narthexDocId } = deps;

  protocol.onAclChange = (msg, fromNodeId) => {
    log.debug(
      TAG,
      "received ACL change from:",
      fromNodeId.slice(0, 16) + "...",
      "canvas:",
      msg.canvasDocId.slice(0, 16) + "...",
      "newRole:",
      msg.newRole
    );

    try {
      const narthexHandle = repo.handles[narthexDocId as any];
      const narthexDoc = narthexHandle?.doc();
      if (!narthexDoc?.widgets) return;

      for (const [cardId, card] of Object.entries(narthexDoc.widgets) as any[]) {
        if (card?.type !== "canvas-card") continue;
        if ((card.props as any)?.canvasDocId !== msg.canvasDocId) continue;
        if (!card.docId) continue;

        const cardHandle = repo.handles[card.docId as any];
        if (!cardHandle) continue;

        // capture the role we're about to overwrite — needed below to
        // decide whether this removal should auto-trash the card (viewer
        // role only, see wireAclChangeHandlers' doc comment).
        const cardDocBefore = cardHandle.doc() as { role?: string } | undefined;
        const wasViewer = cardDocBefore?.role === "viewer";

        cardHandle.change((draft: any) => {
          if (msg.newRole === "removed") {
            draft.accessRevoked = true;
          } else {
            draft.role = msg.newRole;
            draft.accessRevoked = false;
          }
        });

        // a viewer-role peer removed from a canvas has nothing to lose by
        // an immediate auto-trash (they never had write access to begin
        // with, unlike a demoted member/admin who might want to keep the
        // card around to request access again) — soft-delete + move to
        // the trash bin right away rather than just showing the "revoked"
        // overlay indefinitely (a real user-reported request, 2026-07-02:
        // "if the peer is viewer role we can just trash it"). still
        // fully recoverable from the trash bin like any other soft-delete.
        if (msg.newRole === "removed" && wasViewer) {
          void (async () => {
            try {
              const narthexStore = await CanvasStore.open(repo, narthexDocId as DocumentId);
              const identity = await getStoredIdentity();
              if (identity) narthexStore.setLocalNodeId(identity.node_id);
              await trashCanvasCard(repo, narthexStore, cardId);
            } catch (err) {
              log.warn(TAG, "failed to auto-trash canvas card after viewer removal:", err);
            }
          })();
        }
        break;
      }
    } catch (err) {
      log.warn(TAG, "failed to apply ACL change to local canvas card:", err);
    }
  };
}

export interface FriendHandlersDeps {
  protocol: FriendzProtocol;
  sDoc: SocialDoc;
  /**
   * granted viewer access on our own profile doc whenever a friendship is
   * confirmed from this side (either by receiving an accept, or by
   * auto-accepting a reciprocal request) — optional so existing unit tests
   * that don't care about profile-doc sync can omit it.
   */
  profileStore?: ProfileStore;
}

/**
 * wire the `friend-request`/`friend-accept` message handlers onto `protocol`.
 */
export function wireFriendHandlers(deps: FriendHandlersDeps): void {
  const { protocol, sDoc, profileStore } = deps;

  // incoming friend request -> write to social doc.
  // edge cases handled here:
  //   1. duplicate request from same peer: skip the push
  //   2. sender is already in our friends list (reciprocal add): auto-accept
  //   3. we have a still-pending outbound request to this peer: auto-accept
  //      (their request races our request — both sides add each other)
  protocol.onFriendRequest = (msg, fromNodeId) => {
    const friends = sDoc.current.friends ?? [];
    const isAlreadyFriend = friends.some((f: any) =>
      f.nodeIds?.some((n: any) => n.nodeId === fromNodeId)
    );
    const outbound = sDoc.current.outboundRequests ?? [];
    const hasPendingOutbound = outbound.some(
      (r: any) => r.toNodeId === fromNodeId && r.status === "pending"
    );
    const reciprocal = isAlreadyFriend || hasPendingOutbound;

    let didAdd = false;
    sDoc.change((draft: any) => {
      if (!draft.pendingRequests) draft.pendingRequests = [];
      const idx = draft.pendingRequests.findIndex((r: any) => r.fromNodeId === fromNodeId);
      if (idx === -1) {
        draft.pendingRequests.push({
          fromNodeId,
          fromUsername: msg.fromUsername ?? "unknown",
          receivedAt: new Date().toISOString(),
          status: reciprocal ? "accepted" : "pending",
        });
        didAdd = true;
      } else if (reciprocal && draft.pendingRequests[idx].status === "pending") {
        // upgrade an existing pending entry to accepted on reciprocal match
        draft.pendingRequests[idx].status = "accepted";
      }
      // mirror status on outbound request if present
      if (reciprocal && draft.outboundRequests) {
        for (const r of draft.outboundRequests) {
          if (r.toNodeId === fromNodeId && r.status === "pending") {
            r.status = "accepted";
          }
        }
      }
      // sticky hub flag (section 3.3): a duplicate/retried request from an
      // already-known friend can still be the first message that reveals
      // they're a hub — update it in place. never reset to false/undefined
      // on a later message that simply omits the flag.
      if (msg.isHub === true) {
        const existing = draft.friends?.find((f: any) =>
          f.nodeIds?.some((n: any) => n.nodeId === fromNodeId)
        );
        if (existing && existing.isHub !== true) existing.isHub = true;
      }
    });
    const pendingCount = (sDoc.current.pendingRequests ?? []).filter(
      (r: any) => r.status === "pending"
    ).length;
    log.debug(
      TAG,
      `onFriendRequest from ${fromNodeId.slice(0, 16)}... didAdd=${didAdd} reciprocal=${reciprocal} pending-count=${pendingCount}`
    );

    if (reciprocal) {
      // auto-accept: tell the peer we accept and add them to friends if needed
      protocol.sendFriendAccept(fromNodeId).catch((err) => {
        log.warn(
          TAG,
          "auto-accept friend-request failed for",
          fromNodeId.slice(0, 16) + "...",
          err
        );
      });
      if (!isAlreadyFriend) {
        sDoc.change((draft: any) => {
          if (!draft.friends) draft.friends = [];
          draft.friends.push({
            id: crypto.randomUUID(),
            alias: "",
            username: msg.fromUsername ?? "",
            group: "default",
            nodeIds: [
              {
                nodeId: fromNodeId,
                addedAt: new Date().toISOString(),
                lastSeenAt: new Date().toISOString(),
                username: msg.fromUsername ?? "",
                bio: "",
                avatarDataUrl: "",
              },
            ],
            createdAt: new Date().toISOString(),
            isHub: msg.isHub === true,
          });
        });
      }
      // friendship is now mutually confirmed on this side too (we just sent
      // our own accept back) — grant them access to our profile doc. this
      // is the ONLY place `grantViewerRole` gets called for this direction
      // of friend-establishment; without it, a profile doc's `.acl` never
      // gains an entry and (under canvas-scoped-share-policy.ts's rule 1,
      // which profile docs share) can never sync to anyone, ever — a real
      // regression confirmed 2026-07-03 ("can't get 'manage hub' after
      // adding as friend": that panel needs the hub's own profile doc).
      profileStore?.grantViewerRole(fromNodeId);
    }
  };

  // incoming friend accept -> add to friends list
  protocol.onFriendAccept = (msg, fromNodeId) => {
    sDoc.change((draft: any) => {
      if (!draft.friends) draft.friends = [];

      // find existing friend entry by node ID
      const existingFriend = draft.friends.find((f: any) =>
        f.nodeIds?.some((n: any) => n.nodeId === fromNodeId)
      );
      if (!existingFriend) {
        draft.friends.push({
          id: crypto.randomUUID(),
          alias: "",
          username: msg.fromUsername ?? "",
          group: "default",
          nodeIds: [
            {
              nodeId: fromNodeId,
              addedAt: new Date().toISOString(),
              lastSeenAt: new Date().toISOString(),
              username: msg.fromUsername ?? "",
              bio: "",
              avatarDataUrl: "",
            },
          ],
          createdAt: new Date().toISOString(),
          isHub: msg.isHub === true,
        });
      } else {
        // friend entry was pre-created (e.g. by the add-friend UI) with
        // empty username — backfill from the accept message.
        // alias is intentionally left alone (user-controlled local label).
        const acceptName = msg.fromUsername ?? "";
        if (acceptName) {
          if (!existingFriend.username) existingFriend.username = acceptName;
          // also update the matching node-level username
          for (const n of existingFriend.nodeIds ?? []) {
            if (n.nodeId === fromNodeId && !n.username) {
              n.username = acceptName;
            }
          }
        }
        // sticky hub flag (section 3.3): once true, never unset by a later
        // message that omits the flag — only ever flips false -> true here.
        if (msg.isHub === true && existingFriend.isHub !== true) {
          existingFriend.isHub = true;
        }
      }

      // update pending request status
      if (draft.pendingRequests) {
        for (const req of draft.pendingRequests) {
          if (req.fromNodeId === fromNodeId && req.status === "pending") {
            req.status = "accepted";
          }
        }
      }

      // update outbound request status
      if (draft.outboundRequests) {
        for (const req of draft.outboundRequests) {
          if (req.toNodeId === fromNodeId && req.status === "pending") {
            req.status = "accepted";
          }
        }
      }
    });

    // request the accepted peer's profile so bio/avatar arrive immediately
    // (without this, profile data only populates on next init / page reload)
    protocol.requestProfile(fromNodeId).catch(() => {});

    // friendship is now mutually confirmed on this side (we just received
    // their accept) — grant them access to our profile doc. see the other
    // call site (onFriendRequest's reciprocal branch) for why this call
    // matters at all: without it, no peer's profile doc `.acl` ever gains
    // an entry, so it can never sync to anyone.
    profileStore?.grantViewerRole(fromNodeId);
  };
}

// ---------------------------------------------------------------------------
// knock (access request) handling — docs/knock-and-hub-relay-plan.md
//
// exported as standalone functions (rather than inlined into
// `initFriendzWiring()` above) so they can be exercised directly in tests
// without needing the full narthex/social/messagez setup that function
// requires, and so a later UI task can call `approveKnock()`/`declineKnock()`
// directly once a messagez inbox row exists for knocks.
// ---------------------------------------------------------------------------

/**
 * relay-attribution info for a knock that was recorded on this peer as a
 * result of someone else's action — either a directly-received
 * `canvas-knock` message whose sender isn't the requester themselves, or a
 * knock merged in from a gossip digest (which is *always* relayed, by
 * construction — the digest sender is never the requester). `PendingCanvasKnock`
 * (canvas-doc.ts, phase 1) deliberately has no persisted `relayedBy` field,
 * so this is surfaced as an optional callback instead — good enough for a
 * future hub-relay UI (or, today, tests) to observe attribution without
 * needing a bigger identity/attribution model yet (see the plan doc's
 * "known, deliberately-deferred gap" note on multi-device identity).
 */
export interface KnockRelayInfo {
  canvasDocId: string;
  requesterNodeId: string;
  /** node id that actually delivered this knock to us. */
  relayedBy: string;
}

export interface KnockHandlersDeps {
  protocol: FriendzProtocol;
  repo: Repo;
  irohAdapter: IrohNetworkAdapter;
  localNodeId: string;
  /** see `KnockRelayInfo`'s doc comment. only fires for the *direct*
   *  `canvas-knock` relay case (sender != requester); gossip-digest-merged
   *  knocks fire it via `mergeGossipDigestKnocks()`'s own parameter instead,
   *  since that's a separate entry point not wired through here (see
   *  `initFriendzWiring()`'s `onGossipDigest` handler). */
  onKnockRelayed?: (info: KnockRelayInfo) => void;
  /** fires on the requester's side when a `canvas-knock-ack` arrives — the
   *  delivery confirmation `CanvasKnockAckMessage` exists for (section 4).
   *  no persisted UI state to update yet (section 7.1 is a later phase),
   *  so this is the only way to observe it today — useful for tests that
   *  need a deterministic "the knock was actually processed" signal
   *  instead of an arbitrary wait. */
  onKnockAcked?: (info: { knockId: string; canvasDocId: string; ackerNodeId: string }) => void;
}

/**
 * wire the four `canvas-knock*` message handlers onto `protocol`. mirrors
 * the existing `onCanvasInvite`/`onCanvasInviteAccept`/`onCanvasInviteDecline`
 * handlers in `initFriendzWiring()` above — see docs/knock-and-hub-relay-plan.md
 * sections 4-6 for the full message/behavior spec.
 */
export function wireKnockHandlers(deps: KnockHandlersDeps): void {
  const { protocol, repo, irohAdapter, localNodeId, onKnockRelayed, onKnockAcked } = deps;

  // admin (or relay peer)'s side: record the knock into whichever canvas
  // doc it refers to, then ack whoever actually sent us this message — that
  // may be a relay hop, not the original requester, since that's who we
  // have a live stream to right now.
  protocol.onCanvasKnock = (msg, fromNodeId) => {
    (async () => {
      log.debug(
        TAG,
        "received canvas knock from:",
        fromNodeId.slice(0, 16) + "...",
        "requester:",
        msg.requesterNodeId.slice(0, 16) + "...",
        "canvas:",
        msg.canvasDocId.slice(0, 16) + "..."
      );

      let store: CanvasStore;
      try {
        store = await CanvasStore.open(repo, msg.canvasDocId as DocumentId);
      } catch (err) {
        log.warn(
          TAG,
          "cannot open canvas doc for knock, dropping:",
          msg.canvasDocId.slice(0, 16) + "...",
          err
        );
        return;
      }

      store.recordKnock(msg.requesterNodeId, msg.requesterUsername, msg.message);

      if (fromNodeId !== msg.requesterNodeId) {
        onKnockRelayed?.({
          canvasDocId: msg.canvasDocId,
          requesterNodeId: msg.requesterNodeId,
          relayedBy: fromNodeId,
        });
      }

      protocol
        .sendCanvasKnockAck(fromNodeId, {
          knockId: msg.knockId,
          canvasDocId: msg.canvasDocId,
          ackerNodeId: localNodeId,
        })
        .catch((err) => {
          log.warn(TAG, "failed to send knock ack:", err);
        });
    })();
  };

  // requester's side: a delivery confirmation. no UI to update yet (see
  // section 7.1 — the requester's status view is a later phase), so this
  // just logs for now.
  protocol.onCanvasKnockAck = (msg, fromNodeId) => {
    log.debug(
      TAG,
      "received knock ack from:",
      fromNodeId.slice(0, 16) + "...",
      "acker:",
      msg.ackerNodeId.slice(0, 16) + "...",
      "canvas:",
      msg.canvasDocId.slice(0, 16) + "..."
    );
    onKnockAcked?.({ knockId: msg.knockId, canvasDocId: msg.canvasDocId, ackerNodeId: msg.ackerNodeId });
  };

  // requester's side: a notification, NOT a grant. the approving admin
  // already wrote our new role into *their* copy of the canvas doc via
  // `CanvasStore.setRole()` (see `approveKnock()` below) — that's the real
  // grant, and it reaches us via normal automerge sync, never by acting on
  // this message's contents (granting ourselves access here would mean
  // trusting our own unverified claim, exactly what this design avoids —
  // see docs/knock-and-hub-relay-plan.md section 6). all this handler does
  // is make sure we're connected to whoever can give us the doc, so that
  // sync actually has a path to deliver the real `.acl` change.
  protocol.onCanvasKnockApprove = (msg, fromNodeId) => {
    log.debug(
      TAG,
      "received knock approve from:",
      fromNodeId.slice(0, 16) + "...",
      "canvas:",
      msg.canvasDocId.slice(0, 16) + "...",
      "role:",
      msg.role
    );

    irohAdapter.addPeer(fromNodeId).catch(() => {
      // best effort — the requester may not be able to dial back yet
    });
    if (msg.approverNodeId && msg.approverNodeId !== fromNodeId) {
      irohAdapter.addPeer(msg.approverNodeId).catch(() => {
        // best effort
      });
    }
    repo.find(msg.canvasDocId as DocumentId).catch(() => {
      // best effort — sync will catch up once a connection lands
    });
  };

  // requester's side: per tomb's silent-rejection policy (section 3.2/7.1),
  // the requester's UI deliberately does not distinguish "declined" from
  // "still pending" — so there's nothing to write here yet. this handler
  // exists so a future UI task has somewhere to hook a (privacy-preserving)
  // status update.
  protocol.onCanvasKnockDecline = (msg, fromNodeId) => {
    log.debug(
      TAG,
      "received knock decline from:",
      fromNodeId.slice(0, 16) + "...",
      "canvas:",
      msg.canvasDocId.slice(0, 16) + "..."
    );
  };
}

/**
 * merge a gossip digest's pending-knock entries into our own local copies
 * of the referenced canvas docs. best-effort per entry — silently skips any
 * canvas we don't hold (mirrors the try/catch-per-canvas pattern used
 * throughout `computeAndSendGossipDigest`/`onGossipDigest` above). safe to
 * call repeatedly with overlapping entries: `CanvasStore.recordKnock()` is
 * itself idempotent on the requester's node id.
 *
 * exported (not just inlined into `initFriendzWiring()`'s `onGossipDigest`
 * handler) so it can be exercised directly in tests without needing the
 * full narthex/social/messagez setup that function requires.
 */
export async function mergeGossipDigestKnocks(
  repo: Repo,
  msg: Pick<GossipDigestMessage, "pendingKnocks">,
  fromNodeId: string,
  onKnockRelayed?: (info: KnockRelayInfo) => void
): Promise<void> {
  // defensive: a digest missing this field entirely (rather than an empty
  // array) should degrade to "nothing to merge", not crash — this exact
  // gap (reliquary's hub-constructed GossipDigest messages omitted
  // `pendingKnocks` until it was added to that Rust struct) used to throw
  // "msg.pendingKnocks is not iterable" here and abort the whole digest,
  // even the parts (canvasUpdates/pendingInvites/profiles) that were fine.
  if (!Array.isArray(msg.pendingKnocks)) {
    log.warn(TAG, "gossip digest: pendingKnocks missing or not an array, skipping knock merge");
    return;
  }
  for (const knock of msg.pendingKnocks) {
    try {
      const store = await CanvasStore.open(repo, knock.canvasDocId as DocumentId);
      store.recordKnock(knock.requesterNodeId, knock.requesterUsername, knock.message);
      log.debug(
        TAG,
        "gossip digest: merged pending knock for canvas:",
        knock.canvasDocId.slice(0, 16) + "...",
        "requester:",
        knock.requesterNodeId.slice(0, 16) + "...",
        "relayed via:",
        fromNodeId.slice(0, 16) + "..."
      );
      onKnockRelayed?.({
        canvasDocId: knock.canvasDocId,
        requesterNodeId: knock.requesterNodeId,
        relayedBy: fromNodeId,
      });
    } catch (err) {
      log.warn(TAG, "failed to merge gossip-relayed knock:", err);
    }
  }
}

/** fired once per profile-doc pointer merged via {@link mergeGossipDigestProfiles}. */
export interface ProfileRelayInfo {
  peerNodeId: string;
  profileDocId: string;
  relayedBy: string;
}

/**
 * merge a gossip digest's profile-doc pointer entries
 * (docs/hub-and-profile-plan.md section 6's "hub gossip of profile docs")
 * into our own social doc's matching friend `nodeIds` entries, then
 * best-effort kick off an automerge sync for each newly-learned doc id so
 * the actual profile content (not just the pointer) arrives via ordinary
 * CRDT sync from whichever connected peer holds it.
 *
 * only updates a friend we already know about — an entry for a peer we
 * have no `nodeIds` match for is silently skipped (nowhere to record it;
 * this also naturally filters out a stray entry about ourselves, since we
 * don't keep our own node id in our own friends list). sticky/newer-wins,
 * same rule `onProfileResponse` uses for a direct response: only
 * overwrites when the incoming entry is strictly newer, or the existing
 * entry has no doc id yet at all.
 *
 * exported (not just inlined into `initFriendzWiring()`'s `onGossipDigest`
 * handler) so it can be exercised directly in tests, same pattern as
 * `mergeGossipDigestKnocks` above.
 */
export async function mergeGossipDigestProfiles(
  repo: Repo,
  sDoc: SocialDoc,
  msg: { profiles?: GossipDigestProfileEntry[] },
  fromNodeId: string,
  onProfileRelayed?: (info: ProfileRelayInfo) => void
): Promise<void> {
  const entries = msg.profiles ?? [];
  if (entries.length === 0) return;

  const toSync: string[] = [];

  sDoc.change((draft: any) => {
    if (!draft.friends) return;
    for (const entry of entries) {
      for (const friend of draft.friends) {
        if (!friend.nodeIds) continue;
        for (const n of friend.nodeIds) {
          if (n.nodeId !== entry.peerNodeId) continue;
          const isNewer = !n.profileDocId || entry.updatedAt > (n.profileUpdatedAt ?? "");
          if (!isNewer) continue;
          n.profileDocId = entry.profileDocId;
          n.profileUpdatedAt = entry.updatedAt;
          toSync.push(entry.profileDocId);
          onProfileRelayed?.({
            peerNodeId: entry.peerNodeId,
            profileDocId: entry.profileDocId,
            relayedBy: fromNodeId,
          });
        }
      }
    }
  });

  for (const docId of toSync) {
    // brand-new-doc sync-request round-trips can need a moment even after
    // the underlying connection is up (same relay-discovery-lag class of
    // flake documented elsewhere in this codebase — mirrors
    // `p2p-test-bootstrap.ts`'s `joinCanvasForTest()` retry loop: 5
    // attempts, 1s delay) — retry rather than giving up after a single
    // attempt, since this is production code (a real friend relaying a
    // real profile pointer), not just a test-only path.
    let synced = false;
    for (let attempt = 1; attempt <= 8 && !synced; attempt++) {
      try {
        await repo.find(docId as DocumentId);
        synced = true;
        log.debug(
          TAG,
          "gossip digest: synced relayed profile doc:",
          docId.slice(0, 16) + "...",
          "relayed via:",
          fromNodeId.slice(0, 16) + "...",
          "attempt:",
          attempt
        );
      } catch (err) {
        if (attempt === 8) {
          // best effort — sync will catch up once a connection path exists
          log.warn(TAG, "failed to sync gossip-relayed profile doc:", err);
        } else {
          await new Promise((resolve) => setTimeout(resolve, 1000));
        }
      }
    }
  }
}

export interface ApproveKnockDeps {
  protocol: FriendzProtocol;
  store: CanvasStore;
  socialDoc: SocialDoc;
  localNodeId: string;
}

/**
 * approve a pending knock: grants canvas access, records the decision, and
 * establishes a friend relationship with the requester — "approving a knock
 * does two things at once" (docs/knock-and-hub-relay-plan.md section 6).
 *
 * exported for a later UI task to call directly (e.g. a messagez inbox
 * "approve" button, not built yet) — nothing calls this yet.
 *
 * - `store.setRole()` grants access on *our own* copy of the doc; the
 *   requester's side receives it via normal automerge sync, not by acting
 *   on the `canvas-knock-approve` message this sends (see
 *   `onCanvasKnockApprove` above — that's a notification, not a grant).
 * - the friend relationship reuses the existing `friend-accept` message and
 *   handler (`protocol.onFriendAccept`, already wired for ordinary friend
 *   requests) rather than inventing a knock-specific mechanism, per section
 *   6's guidance. we add the requester to our own friends list directly
 *   (mirrors what `onFriendAccept` does for the *other* side of a normal
 *   handshake, since we're not reacting to an incoming accept here) and
 *   send them a `friend-accept` — their existing `onFriendAccept` handler
 *   adds us back, with no knock-specific code needed on their side.
 * - sends `canvas-knock-approve` to the requester best-effort (direct if
 *   reachable; otherwise it just doesn't land yet and relies on the normal
 *   gossip-relay path, same as invite accept/decline notifications) — the
 *   real grant already happened in step 1 and doesn't depend on this
 *   message landing.
 */
export async function approveKnock(
  deps: ApproveKnockDeps,
  requesterNodeId: string,
  role: InvitableRole
): Promise<void> {
  const { protocol, store, socialDoc, localNodeId } = deps;

  // only an admin may decide a knock — previously unenforced anywhere
  // (any peer viewing the canvas, including a mere viewer, could grant
  // access to a stranger). defense in depth: the messagez widget's own
  // approve/reject/ignore buttons are also hidden for non-admins (see
  // `messagez-widget.ts`), but this is the real chokepoint since it's the
  // function that actually grants the role.
  if (!store.isAdmin(localNodeId)) {
    throw new Error(TAG + " approveKnock: local peer is not an admin on this canvas");
  }

  const knock = store.doc().pendingKnocks?.[requesterNodeId];

  store.setRole(requesterNodeId, role);
  store.addKnockDecision(requesterNodeId, localNodeId, "approve", role);

  const alreadyFriend = (socialDoc.current.friends ?? []).some((f) =>
    f.nodeIds?.some((n) => n.nodeId === requesterNodeId)
  );
  if (!alreadyFriend) {
    const requesterUsername = knock?.requesterUsername ?? "";
    socialDoc.change((draft) => {
      if (!draft.friends) draft.friends = [];
      draft.friends.push({
        id: crypto.randomUUID(),
        alias: "",
        username: requesterUsername,
        group: "default",
        nodeIds: [
          {
            nodeId: requesterNodeId,
            addedAt: new Date().toISOString(),
            lastSeenAt: new Date().toISOString(),
            username: requesterUsername,
            bio: "",
            avatarDataUrl: "",
            profileDocId: "",
            profileUpdatedAt: "",
          },
        ],
        createdAt: new Date().toISOString(),
        // a knock requester being approved here isn't (as far as this code
        // knows) a hub — hub status only ever arrives via the isHub flag on
        // a friend-request/friend-accept message (see wireFriendHandlers()).
        isHub: false,
      });
    });
  }

  await protocol.sendFriendAccept(requesterNodeId).catch((err) => {
    log.warn(
      TAG,
      "approveKnock: sendFriendAccept failed for",
      requesterNodeId.slice(0, 16) + "...",
      err
    );
  });

  await protocol
    .sendCanvasKnockApprove(requesterNodeId, {
      knockId: crypto.randomUUID(),
      canvasDocId: store.handle.documentId,
      approverNodeId: localNodeId,
      role,
    })
    .catch((err) => {
      log.warn(
        TAG,
        "approveKnock: sendCanvasKnockApprove failed for",
        requesterNodeId.slice(0, 16) + "...",
        err
      );
    });
}

export interface DeclineKnockDeps {
  protocol: FriendzProtocol;
  store: CanvasStore;
  localNodeId: string;
}

/**
 * decline a pending knock: records a real, deliberate "reject" (section
 * 3.1a — distinct from the client-local "ignore" dismissal, which isn't
 * built in this pass at all) and notifies the requester.
 *
 * exported for a later UI task to call directly — nothing calls this yet.
 */
export async function declineKnock(
  deps: DeclineKnockDeps,
  requesterNodeId: string
): Promise<void> {
  const { protocol, store, localNodeId } = deps;

  // same admin-only gate as approveKnock() above.
  if (!store.isAdmin(localNodeId)) {
    throw new Error(TAG + " declineKnock: local peer is not an admin on this canvas");
  }

  store.addKnockDecision(requesterNodeId, localNodeId, "decline");

  await protocol
    .sendCanvasKnockDecline(requesterNodeId, {
      knockId: crypto.randomUUID(),
      canvasDocId: store.handle.documentId,
      declinerNodeId: localNodeId,
    })
    .catch((err) => {
      log.warn(
        TAG,
        "declineKnock: sendCanvasKnockDecline failed for",
        requesterNodeId.slice(0, 16) + "...",
        err
      );
    });
}
