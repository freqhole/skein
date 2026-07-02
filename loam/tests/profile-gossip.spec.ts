/**
 * profile-doc gossip relay (docs/hub-and-profile-plan.md section 6/11.4).
 *
 * `standalone/friendz-wiring.ts`'s `mergeGossipDigestProfiles()` +
 * `GossipDigestMessage.profiles` (`src/p2p/friends-protocol.ts`), driven
 * over real iroh p2p connections between three browser peers — proves the
 * gossip protocol relays a profile-doc pointer (and, once relayed, the
 * actual doc content via ordinary automerge sync) from a peer's direct
 * friend to a THIRD peer with no direct connection to the profile's owner.
 *
 * `src/dev/test-bridge.ts`'s `buildProfileGossipTestBridge` wires the real
 * production merge logic onto a bare `FriendzProtocol` + dedicated
 * `ProfileStore` in the p2p test harness (`src/dev/p2p-test-bootstrap.ts`),
 * without needing the full narthex/social/messagez setup
 * `initFriendzWiring()` normally requires — same reasoning
 * `knock-flow.spec.ts` documents for `buildKnockTestBridge`.
 *
 * run with: npx playwright test tests/profile-gossip.spec.ts --workers=1
 */

import { test, expect } from "./fixtures/p2p-page";
import {
  addPeer,
  addProfileGossipFriend,
  getKnownProfilePointer,
  getMyProfileDocId,
  getRelayedProfiles,
  readProfileDoc,
  sendProfileGossipDigest,
  setMyProfile,
} from "./helpers/skein-bridge";

test.describe("profile-doc gossip relay", () => {
  test("direct: a friend learns a peer's profile pointer and syncs the real doc content @p2p", async ({
    p2pPage,
  }) => {
    test.setTimeout(60_000);

    const owner = await p2pPage();
    const relay = await p2pPage();

    await setMyProfile(owner.page, "alice", "hello from alice");
    const ownerProfileDocId = await getMyProfileDocId(owner.page);

    // relay already knows about owner as a friend (mirrors a real prior
    // friend-request/accept handshake) — this is where the relayed pointer
    // gets written once the digest arrives.
    await addProfileGossipFriend(relay.page, owner.nodeId);

    await addPeer(relay.page, owner.nodeId);
    await addPeer(owner.page, relay.nodeId);

    await sendProfileGossipDigest(owner.page, relay.nodeId);

    await expect
      .poll(async () => getKnownProfilePointer(relay.page, owner.nodeId), { timeout: 15_000 })
      .toMatchObject({ profileDocId: ownerProfileDocId });

    // the real proof: the actual doc content (not just the pointer) is
    // reachable via ordinary automerge sync now that relay knows the id.
    await expect
      .poll(async () => readProfileDoc(relay.page, ownerProfileDocId), { timeout: 15_000 })
      .toMatchObject({ username: "alice", bio: "hello from alice" });
  });

  test("relay: a third peer with no direct connection to the owner learns their profile via a mutual friend @p2p", async ({
    p2pPage,
  }) => {
    test.setTimeout(60_000);

    const owner = await p2pPage();
    const relay = await p2pPage();

    await setMyProfile(owner.page, "bob", "hello from bob");
    const ownerProfileDocId = await getMyProfileDocId(owner.page);

    // hop 1: owner <-> relay, direct digest (same as the "direct" test
    // above) — relay ends up holding both the pointer and the real doc.
    // stranger isn't created until after this hop settles, to avoid a
    // third simultaneous real iroh endpoint adding contention during the
    // exact moment relay's first-ever sync of a brand-new doc is racing to
    // complete (matches this codebase's general pattern of minimizing
    // concurrent real-network peers during a timing-sensitive step).
    await addProfileGossipFriend(relay.page, owner.nodeId);
    await addPeer(relay.page, owner.nodeId);
    await addPeer(owner.page, relay.nodeId);
    await sendProfileGossipDigest(owner.page, relay.nodeId);
    await expect
      .poll(async () => getKnownProfilePointer(relay.page, owner.nodeId), { timeout: 15_000 })
      .toMatchObject({ profileDocId: ownerProfileDocId });

    // relay must actually hold the real doc content (not just the pointer)
    // before it can relay anything meaningful onward to stranger below —
    // this mirrors mergeGossipDigestProfiles()'s own repo.find() call, and
    // confirms it genuinely succeeded rather than silently failing.
    await expect
      .poll(async () => readProfileDoc(relay.page, ownerProfileDocId), { timeout: 30_000 })
      .toMatchObject({ username: "bob", bio: "hello from bob" });

    const stranger = await p2pPage();

    // stranger never dials owner at all — only relay. stranger already
    // knows about owner as a (mutual) friend, same seeding reasoning as
    // above, just with no pointer yet — that's exactly what the relay hop
    // below should fill in.
    await addProfileGossipFriend(stranger.page, owner.nodeId);
    await addPeer(stranger.page, relay.nodeId);
    await addPeer(relay.page, stranger.nodeId);

    // sanity check: stranger genuinely has no path to owner directly —
    // confirms the later assertions prove the relay hop specifically, not
    // some other route.
    const preRelayPointer = await getKnownProfilePointer(stranger.page, owner.nodeId);
    expect(preRelayPointer).toBeNull();

    // hop 2: relay -> stranger, relaying every pointer relay itself knows
    // about (including owner's, learned in hop 1).
    await sendProfileGossipDigest(relay.page, stranger.nodeId);

    await expect
      .poll(async () => getKnownProfilePointer(stranger.page, owner.nodeId), { timeout: 15_000 })
      .toMatchObject({ profileDocId: ownerProfileDocId });

    await expect
      .poll(async () => getRelayedProfiles(stranger.page), { timeout: 15_000 })
      .toContainEqual({
        peerNodeId: owner.nodeId,
        profileDocId: ownerProfileDocId,
        relayedBy: relay.nodeId,
      });

    // the real proof, same as the direct test: stranger can now sync the
    // actual doc content (from relay, over automerge — stranger never
    // connected to owner at all).
    await expect
      .poll(async () => readProfileDoc(stranger.page, ownerProfileDocId), { timeout: 30_000 })
      .toMatchObject({ username: "bob", bio: "hello from bob" });
  });
});
