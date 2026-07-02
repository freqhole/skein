/**
 * real friend-request round trip against a real reliquary hub.
 *
 * confirms a browser peer can complete the ordinary `skein-friendz/1`
 * friend-request handshake against a real `reliquary serve` process, not
 * just against another browser peer — the existing p2p suites
 * (`friends-protocol.test.ts`, `friendz-bridge.test.ts`) only exercise this
 * protocol between two mocked/browser peers, and `reliquary-hub.spec.ts`
 * only exercises the separate `iroh/automerge-repo/1` sync ALPN against a
 * real hub.
 *
 * wire compatibility: the browser's `FriendzProtocol`
 * (`src/p2p/friends-protocol.ts`) and reliquary's `FriendzHandler`
 * (`reliquary/src/protocol/handler.rs` + `codec.rs`) already speak the same
 * wire format — length-prefixed (4-byte big-endian u32) JSON, kebab-case
 * `type` discriminant, camelCase fields (see `reliquary/src/protocol/messages.rs`
 * header comment). no reliquary-side changes were needed; the only gap was
 * test infrastructure — the p2p e2e harness (`src/dev/p2p-test-bootstrap.ts`)
 * didn't wire up a `FriendzProtocol` instance at all, so there was no way to
 * drive a real friend-request handshake from a playwright test. see
 * `buildFriendzTestBridge` in `src/dev/test-bridge.ts` for the harness-side
 * fix (tracks accepted friends in a plain in-memory set, since the p2p
 * harness has no narthex/social doc for the real production wiring in
 * `standalone/friendz-wiring.ts` to write into).
 *
 * policy under test (`reliquary/src/friendz.rs`'s `FriendStatus` +
 * `reliquary/src/hub/messages.rs`'s `FriendRequest` handler): the hub
 * auto-accepts an inbound friend request only from a peer pre-approved via
 * `reliquary friend allow <node-id>` (status `Allowed`); an unapproved
 * stranger's request is recorded as `Pending` and gets no reply at all.
 *
 * tag: @hub
 * run with: npx playwright test --grep @hub
 */

import type { Page } from "@playwright/test";
import { test, expect } from "./fixtures/p2p-page";
import { isFriend, sendFriendRequest, waitForFriend } from "./helpers/skein-bridge";
import { startReliquaryHub, type ReliquaryHubHandle } from "./helpers/reliquary-hub";

/**
 * send a friend request with a short retry loop for the initial dial.
 *
 * `FriendzProtocol.sendFriendRequest` opens a fresh iroh stream on demand
 * (`midden.open_bi`) with no retry of its own — unlike
 * `IrohNetworkAdapter.addPeer()`, which has a tight retry loop
 * (`openBiWithRetry`) specifically for the relay-discovery lag that can
 * happen when dialing a peer immediately after both endpoints come online
 * (see `src/p2p/iroh-network-adapter.ts`). this mirrors that same
 * test-only retry pattern (also used by `blob-acl.spec.ts`'s
 * `fetchBlobWithRetry`) rather than adding retry logic to production code.
 */
async function sendFriendRequestWithRetry(
  page: Page,
  peerNodeId: string,
  maxAttempts = 4,
  delayMs = 750
): Promise<void> {
  let lastErr: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      await sendFriendRequest(page, peerNodeId);
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

test.describe("friend request round trip against a real reliquary hub @hub", () => {
  let hub: ReliquaryHubHandle | undefined;

  test.afterEach(async () => {
    await hub?.stop();
    hub = undefined;
  });

  test("browser peer sends a friend request and a pre-approved hub auto-accepts @hub", async ({
    p2pPage,
  }) => {
    test.setTimeout(90_000);

    hub = await startReliquaryHub();

    const peer = await p2pPage();

    // pre-approve the browser peer so the hub auto-accepts its friend
    // request (status `Allowed` — see reliquary/src/friendz.rs).
    await hub.friendAllow(peer.nodeId);

    await sendFriendRequestWithRetry(peer.page, hub.nodeId);

    // the hub replies with friend-accept once it promotes the peer to
    // Accepted — this is the real, wire-level round trip, not just a local
    // state assertion.
    await waitForFriend(peer.page, hub.nodeId, 30_000);
    expect(await isFriend(peer.page, hub.nodeId)).toBe(true);

    // deterministic server-side confirmation that the hub actually
    // processed and promoted the request (not e.g. some other unrelated
    // reason the local flag got set).
    expect(hub.getLog()).toContain("promoted to accepted friend");
    expect(hub.getLog()).toContain("friend-accept sent successfully");
  });

  test("hub does not auto-accept an unapproved stranger's friend request @hub", async ({
    p2pPage,
  }) => {
    test.setTimeout(90_000);

    hub = await startReliquaryHub();

    const peer = await p2pPage();

    // deliberately skip hub.friendAllow() — this peer is unknown to the hub.
    await sendFriendRequestWithRetry(peer.page, hub.nodeId);

    // hub records the request as pending and stops — no friend-accept is
    // ever sent back (see reliquary/src/hub/messages.rs's FriendRequest arm).
    await expect
      .poll(() => hub!.getLog(), { timeout: 15_000 })
      .toContain("friend request recorded as pending");

    expect(hub.getLog()).not.toContain("promoted to accepted friend");
    expect(await isFriend(peer.page, hub.nodeId)).toBe(false);
  });
});
