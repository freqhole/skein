/**
 * `freqhole/1` (ensure_blob) access-gate e2e coverage.
 *
 * background: reliquary's shared `ensure_blob` protocol handler
 * (`freqhole_reliquary::ensure::EnsureBlobHandler`, wired up as the
 * `freqhole/1` ALPN in `tumulus/src/protocol/blob_proxy.rs`) accepts every
 * connection unconditionally — access control is gated per-request instead,
 * inside `ensure()`, via an injected `AccessGate` (skein's `FriendGate`,
 * gating on hub-friend status). a non-friend peer can still open the QUIC
 * connection; every individual `ensure_blob` request over it is still
 * checked and denied before any blob lookup happens.
 *
 * `blob-sync.spec.ts` already proves the *positive* case end-to-end (a
 * friended peer's hub successfully snatches a blob over `freqhole/1` via
 * the real `BlobSnatcher` pipeline) — every hub e2e test always calls
 * `hub.friendAllow(peer.nodeId)` before doing anything, so none of them
 * exercise the *rejection* path. this file is specifically about that gap.
 *
 * approach chosen (direct dial, not hub-initiates-a-snatch): dial
 * `freqhole/1` directly via midden's `download_verified_with_ensure`
 * (already exposed as `bridge.p2p.fetchBlob()`, the same test-only bridge
 * method `blob-acl.spec.ts` uses) rather than reproducing the full
 * "hub-initiates-a-snatch" pipeline (real canvas, real widget, waiting out
 * `BlobSnatcher`'s poll interval). `download_verified_with_ensure` always
 * calls `ensure_blob()` internally, which dials the target peer's
 * `freqhole/1` ALPN directly — completely independent of automerge-repo
 * sync or canvas membership. investigated both angles; this one is
 * simpler, more reliable (no polling interval to wait out, no
 * canvas/widget setup at all), and needed zero new production or
 * test-bridge code, since `fetchBlob()` already dials exactly the ALPN
 * under test.
 *
 * the blake3 hash used below is a fake, non-existent one on purpose — the
 * client-visible error message can't distinguish "denied by the access
 * gate" from "genuinely doesn't have this blob" (midden collapses both
 * into the same "blob ... not available on peer" message), so both tests
 * below assert on the hub's own log output (`ensure: denied by access
 * gate`) rather than the client error text to tell the two cases apart.
 *
 * tag: @hub
 * run with: npx playwright test tests/blob-proxy-friend-gate.spec.ts --workers=1
 */

import { test, expect } from "./fixtures/p2p-page";
import type { Page } from "@playwright/test";
import { startReliquaryHub, type ReliquaryHubHandle } from "./helpers/reliquary-hub";

/** a well-formed-looking but definitely-nonexistent blake3 hex hash. */
const FAKE_BLAKE3_HASH = "0".repeat(64);

/**
 * dial `peerNodeId`'s `freqhole/1` ALPN directly (via midden's
 * `download_verified_with_ensure`, exposed as `bridge.p2p.fetchBlob()`) and
 * return the final caught error's message. retries a handful of times to
 * absorb the same cold-dial relay-discovery lag documented on
 * `IrohNetworkAdapter.openBiWithRetry()` / `blob-acl.spec.ts`'s
 * `fetchBlobWithRetry` — `ensure_blob`'s own connect has no retry of its
 * own. throws if the call unexpectedly succeeds (it never should in either
 * test below — the fake hash doesn't exist, so both a friended and a
 * non-friend peer always get an error, just for different reasons that
 * only the hub's own log can tell apart).
 */
async function dialSkeinAlpn(
  page: Page,
  peerNodeId: string,
  blake3Hash: string,
  attempts = 4,
  delayMs = 1000
): Promise<string> {
  let lastMessage: string | null = null;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      await page.evaluate(
        async ([peerId, hash]) => {
          const bridge = (window as any).__skeinTest;
          await bridge.p2p.fetchBlob(peerId, hash);
        },
        [peerNodeId, blake3Hash] as const
      );
      throw new Error("dialSkeinAlpn unexpectedly succeeded fetching a nonexistent blob");
    } catch (err) {
      lastMessage = err instanceof Error ? err.message : String(err);
      if (lastMessage.startsWith("dialSkeinAlpn unexpectedly succeeded")) {
        throw err;
      }
      if (attempt < attempts) {
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
    }
  }
  return lastMessage ?? "";
}

test.describe("reliquary freqhole/1 ensure_blob access gate @hub", () => {
  let hub: ReliquaryHubHandle | undefined;

  test.afterEach(async () => {
    await hub?.stop();
    hub = undefined;
  });

  test("hub rejects a non-friend peer's ensure_blob request before any blob lookup @hub", async ({
    p2pPage,
  }) => {
    test.setTimeout(90_000);

    hub = await startReliquaryHub();
    const peer = await p2pPage();

    // deliberately skip hub.friendAllow() — this peer is unknown to the hub.
    const errorMessage = await dialSkeinAlpn(peer.page, hub.nodeId, FAKE_BLAKE3_HASH);

    // some error either way (the fake hash doesn't exist regardless of
    // friend status) — the hub's own log is what actually proves the gate
    // fired, since the client-visible message is identical either way.
    expect(errorMessage.length).toBeGreaterThan(0);

    await expect
      .poll(() => hub!.getLog(), { timeout: 15_000 })
      .toContain("ensure: denied by access gate");
  });

  test("hub accepts a friended peer's ensure_blob request past the access gate (still real access control, not a bypass) @hub", async ({
    p2pPage,
  }) => {
    test.setTimeout(90_000);

    hub = await startReliquaryHub();
    const peer = await p2pPage();

    await hub.friendAllow(peer.nodeId);

    // the request genuinely reaches the blob lookup this time — it fails
    // only because the (fake) hash doesn't exist, a completely different,
    // application-level outcome from the non-friend case above (proven via
    // the hub log below, since the client-visible error text is identical
    // either way).
    const errorMessage = await dialSkeinAlpn(peer.page, hub.nodeId, FAKE_BLAKE3_HASH);
    expect(errorMessage).toMatch(/not available on peer/);

    expect(hub.getLog()).not.toContain("ensure: denied by access gate");
  });
});
