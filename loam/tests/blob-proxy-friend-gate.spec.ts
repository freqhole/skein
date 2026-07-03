/**
 * skein/1 friend-gate e2e coverage.
 *
 * background: reliquary's `skein/1` ALPN (blob-proxy / `ensure_blob`,
 * `reliquary/src/protocol/blob_proxy.rs`) used to have **zero access
 * control of any kind** — any peer who could dial it could probe for a
 * blake3 hash's existence and trigger a local `FsStore` import-by-reference
 * (an existence-leak + import-trigger, though it never leaked actual bytes
 * on its own — that's the separately-gated `iroh-blobs/*` ALPN, see
 * `blob_acl.rs`). `BlobProxyHandler::accept()` now rejects a non-friend
 * peer up front, before the bidirectional stream loop even starts (see
 * `docs/widget-blob-acl-plan.md` section 3.5).
 *
 * `blob-sync.spec.ts` already proves the *positive* case end-to-end (a
 * friended peer's hub successfully snatches a blob over `skein/1` via the
 * real `BlobSnatcher` pipeline) — every hub e2e test always calls
 * `hub.friendAllow(peer.nodeId)` before doing anything, so none of them
 * exercise the *rejection* path. this file is specifically about that gap.
 *
 * approach chosen (direct dial, not hub-initiates-a-snatch): dial `skein/1`
 * directly via midden's `download_verified_with_ensure` (already exposed
 * as `bridge.p2p.fetchBlob()`, the same test-only bridge method
 * `blob-acl.spec.ts` uses) rather than reproducing the full
 * "hub-initiates-a-snatch" pipeline (real canvas, real widget, waiting out
 * `BlobSnatcher`'s poll interval). `download_verified_with_ensure` always
 * calls `ensure_blob()` internally, which dials the target peer's `skein/1`
 * ALPN directly (`connect_to_peer` in `midden/src/lib.rs` always connects
 * with `SKEIN_ALPN`) — completely independent of automerge-repo sync or
 * canvas membership. investigated both angles; this one is simpler, more
 * reliable (no polling interval to wait out, no canvas/widget setup at
 * all), and needed zero new production or test-bridge code, since
 * `fetchBlob()` already dials exactly the ALPN under test.
 *
 * the blake3 hash used below is a fake, non-existent one on purpose — the
 * friend gate rejects the connection *before* any blob lookup happens, so
 * a real blob isn't needed to prove rejection. for the companion "friended
 * peer" case, the same fake hash lets us prove the request genuinely
 * reached the hub's `ensure_blob` handler (a real, deterministic
 * "blob ... not available on peer" application-level error) rather than
 * being rejected at the connection level — a clean way to distinguish "got
 * past the friend gate" from "actually has the blob", without needing a
 * full blob-transfer round trip (already covered by blob-sync.spec.ts).
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
 * dial `peerNodeId`'s `skein/1` ALPN directly (via midden's
 * `download_verified_with_ensure`, exposed as `bridge.p2p.fetchBlob()`) and
 * return the final caught error's message. retries a handful of times to
 * absorb the same cold-dial relay-discovery lag documented on
 * `IrohNetworkAdapter.openBiWithRetry()` / `blob-acl.spec.ts`'s
 * `fetchBlobWithRetry` — `ensure_blob`'s own `connect_to_peer` has no retry
 * of its own. throws if the call unexpectedly succeeds (it never should in
 * either test below — the fake hash doesn't exist, so a friended peer
 * still gets an application-level "not available" error, and a non-friend
 * gets rejected before any lookup happens).
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

test.describe("reliquary skein/1 friend gate @hub", () => {
  let hub: ReliquaryHubHandle | undefined;

  test.afterEach(async () => {
    await hub?.stop();
    hub = undefined;
  });

  test("hub rejects a non-friend peer's skein/1 request before any blob lookup @hub", async ({
    p2pPage,
  }) => {
    test.setTimeout(90_000);

    hub = await startReliquaryHub();
    const peer = await p2pPage();

    // deliberately skip hub.friendAllow() — this peer is unknown to the hub.
    const errorMessage = await dialSkeinAlpn(peer.page, hub.nodeId, FAKE_BLAKE3_HASH);

    // rejected at the connection level, not the "blob not found"
    // application-level error a friended peer gets (see the companion test
    // below) — proves the gate fires before any blob lookup.
    expect(errorMessage.length).toBeGreaterThan(0);
    expect(errorMessage).not.toMatch(/not available on peer/);

    // the deterministic, server-side signal.
    await expect
      .poll(() => hub!.getLog(), { timeout: 15_000 })
      .toContain("skein/1: rejecting non-friend peer");
    expect(hub.getLog()).not.toContain("skein/1: accepted connection");
  });

  test("hub accepts a friended peer's skein/1 connection (still real access control, not a bypass) @hub", async ({
    p2pPage,
  }) => {
    test.setTimeout(90_000);

    hub = await startReliquaryHub();
    const peer = await p2pPage();

    await hub.friendAllow(peer.nodeId);

    // the request genuinely reaches the hub's `ensure_blob` handler this
    // time — it fails only because the (fake) hash doesn't exist, a
    // completely different, application-level error from the non-friend
    // case above.
    const errorMessage = await dialSkeinAlpn(peer.page, hub.nodeId, FAKE_BLAKE3_HASH);
    expect(errorMessage).toMatch(/not available on peer/);

    await expect
      .poll(() => hub!.getLog(), { timeout: 15_000 })
      .toContain("skein/1: accepted connection");
    expect(hub.getLog()).not.toContain("skein/1: rejecting non-friend peer");
  });
});
