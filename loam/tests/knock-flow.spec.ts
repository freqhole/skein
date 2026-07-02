/**
 * knock (access-request) protocol + p2p gossip relay.
 *
 * phase 2 of docs/knock-and-hub-relay-plan.md (section 10, step 2) — the
 * `canvas-knock*` message types (`src/p2p/friends-protocol.ts`) and the
 * `wireKnockHandlers`/`approveKnock`/`declineKnock`/`mergeGossipDigestKnocks`
 * exports (`src/standalone/friendz-wiring.ts`), driven over real iroh p2p
 * connections between browser peers.
 *
 * `src/dev/test-bridge.ts`'s `buildKnockTestBridge` wires the exact
 * production knock plumbing onto a bare `FriendzProtocol` instance in the
 * p2p test harness (`src/dev/p2p-test-bootstrap.ts`), without needing the
 * full narthex/social/messagez setup `initFriendzWiring()` normally
 * requires — same reasoning `friendz-hub.spec.ts` documents for
 * `buildFriendzTestBridge`.
 *
 * run with: npx playwright test tests/knock-flow.spec.ts --workers=1
 */

import type { Page } from "@playwright/test";
import { test, expect } from "./fixtures/p2p-page";
import {
  addPeer,
  approveKnock,
  declineKnock,
  forgetPeer,
  getCanvasAcl,
  getCanvasDoc,
  getReceivedKnockAcks,
  getRelayedKnocks,
  joinCanvas,
  sendKnock,
  sendKnocksGossipDigest,
} from "./helpers/skein-bridge";

/** matches the exact placeholder copy already decided in ROADMAP.md /
 *  docs/knock-and-hub-relay-plan.md section 3.1 (reused verbatim from
 *  playlistz). */
const KNOCK_MESSAGE =
  "say who you are and mention something only the admin would know (but no passwords or secrets!)";

interface KnockPayload {
  knockId: string;
  canvasDocId: string;
  requesterUsername: string;
  message: string;
}

/**
 * send a knock with a short retry loop for the initial dial.
 *
 * `FriendzProtocol.sendCanvasKnock` opens a fresh iroh stream on demand
 * (`midden.open_bi`) with no retry of its own — same relay-discovery-lag
 * reasoning as `friendz-hub.spec.ts`'s `sendFriendRequestWithRetry`.
 */
async function sendKnockWithRetry(
  page: Page,
  peerNodeId: string,
  knock: KnockPayload,
  maxAttempts = 4,
  delayMs = 750
): Promise<void> {
  let lastErr: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      await sendKnock(page, peerNodeId, knock);
      return;
    } catch (err) {
      lastErr = err;
      if (attempt < maxAttempts) {
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
    }
  }
  throw lastErr;
}

test.describe("knock flow", () => {
  test("direct knock: admin approves, requester gets ACL access via real sync", async ({
    p2pPage,
  }) => {
    test.setTimeout(60_000);

    const admin = await p2pPage();
    const requester = await p2pPage();

    await addPeer(requester.page, admin.nodeId);
    await addPeer(admin.page, requester.nodeId);

    await sendKnockWithRetry(requester.page, admin.nodeId, {
      knockId: "knock-direct-1",
      canvasDocId: admin.canvasDocId,
      requesterUsername: "alice",
      message: KNOCK_MESSAGE,
    });

    // the admin recorded the knock into pendingKnocks (keyed by requester
    // node id) — this is the real CanvasStore.recordKnock() call, reached
    // through the actual wire message, not a direct method call.
    await expect
      .poll(
        async () => {
          const doc = (await getCanvasDoc(admin.page)) as any;
          return doc.pendingKnocks?.[requester.nodeId]?.requesterUsername ?? null;
        },
        { timeout: 15_000 }
      )
      .toBe("alice");

    await approveKnock(admin.page, requester.nodeId, "member");

    // the real grant: the admin's own CanvasStore.setRole() call syncs to
    // the requester via normal automerge sync — the requester never grants
    // itself access. getCanvasAcl() opens/syncs the doc from the
    // requester's own repo, proving this reaches them for real.
    await expect
      .poll(async () => getCanvasAcl(requester.page, admin.canvasDocId, requester.nodeId), {
        timeout: 20_000,
      })
      .toBe("member");

    const adminDoc = (await getCanvasDoc(admin.page)) as any;
    const knock = adminDoc.pendingKnocks?.[requester.nodeId];
    expect(knock?.decisions).toHaveLength(1);
    expect(knock.decisions[0]).toMatchObject({ decision: "approve", role: "member" });
  });

  test("offline relay: a third peer relays a knock to the admin via gossip digest", async ({
    p2pPage,
  }) => {
    test.setTimeout(60_000);

    const admin = await p2pPage();
    const relay = await p2pPage();
    const requester = await p2pPage();

    // relay is "already on the canvas" — it holds its own synced copy of
    // the admin's canvas doc.
    await addPeer(relay.page, admin.nodeId);
    await joinCanvas(relay.page, admin.canvasDocId);

    // sever the automerge-repo-level connection between relay and admin
    // right after joining: relay keeps its own local cached copy of the
    // canvas doc (repo/storage state is unaffected by forgetPeer, only the
    // live network stream is), but the two peers no longer have a
    // repo-level sync channel between them at all. without this, relay's
    // later `recordKnock()` write would propagate to admin through plain
    // automerge CRDT sync over the *already-connected* repo link left over
    // from `joinCanvas()` above — which would make the doc-level poll below
    // pass regardless of whether the gossip-digest message (sent
    // separately, over the independent skein-friendz/1 protocol) ever
    // reaches or gets processed by admin at all. severing this link is what
    // makes the later assertions unambiguous proof of the gossip-digest
    // relay path specifically.
    await forgetPeer(relay.page, admin.nodeId);

    // the admin is "offline": the requester never dials the admin at all,
    // only the relay peer.
    await addPeer(requester.page, relay.nodeId);
    await sendKnockWithRetry(requester.page, relay.nodeId, {
      knockId: "knock-relay-1",
      canvasDocId: admin.canvasDocId,
      requesterUsername: "bob",
      message: KNOCK_MESSAGE,
    });

    await expect
      .poll(
        async () => {
          const doc = (await getCanvasDoc(relay.page)) as any;
          return doc.pendingKnocks?.[requester.nodeId]?.requesterUsername ?? null;
        },
        { timeout: 15_000 }
      )
      .toBe("bob");

    // sanity check: with the repo-level link severed above, ordinary
    // automerge sync genuinely cannot have delivered anything to admin yet
    // — confirms the isolation actually holds before trusting the
    // gossip-digest assertions below.
    const preDigestAdminDoc = (await getCanvasDoc(admin.page)) as any;
    expect(preDigestAdminDoc.pendingKnocks?.[requester.nodeId]).toBeUndefined();

    // the admin "comes online" and gossip-digests with the relay peer —
    // this is the skein-friendz/1-level relay path, a completely separate
    // protocol/connection from automerge-repo's own sync mechanism (see the
    // forgetPeer() call above), so a successful merge here proves the
    // gossip-digest extension itself works.
    await sendKnocksGossipDigest(relay.page, admin.nodeId, admin.canvasDocId);

    await expect
      .poll(
        async () => {
          const doc = (await getCanvasDoc(admin.page)) as any;
          return doc.pendingKnocks?.[requester.nodeId]?.requesterUsername ?? null;
        },
        { timeout: 15_000 }
      )
      .toBe("bob");

    // relay attribution: PendingCanvasKnock has no persisted relayedBy
    // field (phase 1 deliberately kept it minimal — see
    // docs/knock-and-hub-relay-plan.md's "known, deliberately-deferred
    // gap" note), so this is the "equivalent" signal — an explicit,
    // observable callback fired by mergeGossipDigestKnocks() at the exact
    // moment it merges a relayed knock. polled (not a single read) since
    // this fires asynchronously, after admin's read loop actually receives
    // and decodes the message over its own fresh connection to relay.
    await expect
      .poll(async () => getRelayedKnocks(admin.page), { timeout: 15_000 })
      .toContainEqual({
        canvasDocId: admin.canvasDocId,
        requesterNodeId: requester.nodeId,
        relayedBy: relay.nodeId,
      });
  });

  test("decline: requester never gets ACL access", async ({ p2pPage }) => {
    test.setTimeout(60_000);


    const admin = await p2pPage();
    const requester = await p2pPage();

    await addPeer(requester.page, admin.nodeId);
    await addPeer(admin.page, requester.nodeId);

    await sendKnockWithRetry(requester.page, admin.nodeId, {
      knockId: "knock-decline-1",
      canvasDocId: admin.canvasDocId,
      requesterUsername: "eve",
      message: KNOCK_MESSAGE,
    });

    await expect
      .poll(
        async () => {
          const doc = (await getCanvasDoc(admin.page)) as any;
          return doc.pendingKnocks?.[requester.nodeId]?.requesterUsername ?? null;
        },
        { timeout: 15_000 }
      )
      .toBe("eve");

    await declineKnock(admin.page, requester.nodeId);

    await expect
      .poll(
        async () => {
          const doc = (await getCanvasDoc(admin.page)) as any;
          return doc.pendingKnocks?.[requester.nodeId]?.decisions?.[0]?.decision ?? null;
        },
        { timeout: 15_000 }
      )
      .toBe("decline");

    // no canvas-knock-approve was ever sent, so the requester never even
    // attempts to open the admin's doc — access was never established.
    const adminDoc = (await getCanvasDoc(admin.page)) as any;
    expect(adminDoc.acl?.[requester.nodeId]).toBeUndefined();
  });

  test("idempotent retry: a duplicate knock does not create a second pending entry", async ({
    p2pPage,
  }) => {
    test.setTimeout(60_000);

    const admin = await p2pPage();
    const requester = await p2pPage();

    await addPeer(requester.page, admin.nodeId);
    await addPeer(admin.page, requester.nodeId);

    await sendKnockWithRetry(requester.page, admin.nodeId, {
      knockId: "knock-retry-1",
      canvasDocId: admin.canvasDocId,
      requesterUsername: "carol",
      message: "first attempt",
    });

    await expect
      .poll(
        async () => {
          const doc = (await getCanvasDoc(admin.page)) as any;
          return doc.pendingKnocks?.[requester.nodeId]?.message ?? null;
        },
        { timeout: 15_000 }
      )
      .toBe("first attempt");

    // simulate a retry after a timeout — same requester node id, a fresh
    // knockId (a real client wouldn't reuse one), different message text —
    // recordKnock() dedup happens on requesterNodeId, not knockId.
    await sendKnockWithRetry(requester.page, admin.nodeId, {
      knockId: "knock-retry-2",
      canvasDocId: admin.canvasDocId,
      requesterUsername: "carol",
      message: "second attempt",
    });

    // wait for a deterministic signal that the SECOND knock was actually
    // processed (its ack), rather than an arbitrary delay — see
    // getReceivedKnockAcks()'s doc comment.
    await expect
      .poll(
        async () => {
          const acks = await getReceivedKnockAcks(requester.page);
          return acks.some((a) => a.knockId === "knock-retry-2");
        },
        { timeout: 15_000 }
      )
      .toBe(true);

    const doc = (await getCanvasDoc(admin.page)) as any;
    const pendingKnocks = doc.pendingKnocks ?? {};
    expect(Object.keys(pendingKnocks)).toEqual([requester.nodeId]);
    // the original entry's content wins — recordKnock() returns the
    // existing entry unchanged for a still-pending knock, it does not
    // overwrite requesterUsername/message on a second call.
    expect(pendingKnocks[requester.nodeId].message).toBe("first attempt");
    expect(pendingKnocks[requester.nodeId].decisions).toHaveLength(0);
  });
});
