/**
 * real reliquary hub connectivity smoke tests.
 *
 * spins up an actual `reliquary serve` child process (the real hub-peer
 * binary, not a browser tab) alongside one real-iroh browser peer, and dials
 * the hub by node id using the same `addPeer()` / `IrohNetworkAdapter` path
 * the existing browser-to-browser p2p tests use. this is the first e2e
 * coverage of loam talking to a real reliquary process — everything under
 * `p2p-sync.spec.ts` / `multi-peer-mesh.spec.ts` only ever connects two
 * browser tabs to each other.
 *
 * tag: @hub
 * run with: npx playwright test --grep @hub
 *
 * important finding (see final report / PROGRESS.md consolidation): the
 * hub's `iroh/automerge-repo/1` ALPN handler (`reliquary/src/sync.rs`,
 * `IrohRepo::accept`) accepts every inbound connection unconditionally —
 * it does not consult the friendz allow-list at all. authorization
 * (`is_friend()`) is only checked in the *separate* `skein-friendz/1`
 * protocol's canvas-invite handler (`reliquary/src/hub/canvas.rs`,
 * `handle_canvas_invite`), which the browser has no client for yet (see
 * `loam/src/p2p/` — there is no `skein-friendz/1` sender). so today,
 * "authorized peer" vs "unauthorized peer" cannot produce a different
 * *connectivity* outcome: both connect at the transport layer. the second
 * test below exercises and documents this directly. building the real
 * "hub syncs only for friends" test needs a browser-side friendz protocol
 * client first (production code change, out of scope here per the task's
 * instructions not to touch loam/src).
 */

import { test, expect } from "./fixtures/p2p-page";
import { addPeer, waitForPeerCount } from "./helpers/skein-bridge";
import { startReliquaryHub, type ReliquaryHubHandle } from "./helpers/reliquary-hub";

test.describe("reliquary hub connectivity @hub", () => {
  let hub: ReliquaryHubHandle | undefined;

  test.afterEach(async () => {
    await hub?.stop();
    hub = undefined;
  });

  test("browser peer can dial a real reliquary hub by node id @hub", async ({ p2pPage }) => {
    test.setTimeout(90_000);

    hub = await startReliquaryHub();

    const peer = await p2pPage();

    // pre-approve the browser peer as a friend before dialing. this doesn't
    // currently change the connectivity outcome (see file header), but it's
    // the intended real-world sequencing and exercises `friendAllow()`.
    await hub.friendAllow(peer.nodeId);

    await addPeer(peer.page, hub.nodeId);

    // repo.peers reflects the automerge-repo NetworkAdapter's local
    // "peer-candidate" event, emitted as soon as the QUIC stream to the
    // hub's automerge-repo ALPN is established — this confirms real
    // transport-level connectivity to the hub process, not just that the
    // dial call didn't throw.
    await waitForPeerCount(peer.page, 1, 30_000);

    const peers: string[] = await peer.page.evaluate(
      () => (window as any).__skeinTest.canvas.repo.peers ?? []
    );
    expect(peers).toContain(hub.nodeId);
  });

  test("hub accepts automerge-repo connections even without friend allow-list approval @hub", async ({
    p2pPage,
  }) => {
    test.setTimeout(90_000);

    hub = await startReliquaryHub();

    const peer = await p2pPage();

    // deliberately skip hub.friendAllow() — this peer is unknown to the hub.
    await addPeer(peer.page, hub.nodeId);

    // the connection still succeeds: the automerge-repo ALPN handler has no
    // authorization check today (see file header comment). this test exists
    // to document that fact so it isn't rediscovered by surprise later —
    // it is not asserting desired behavior, only current behavior.
    await waitForPeerCount(peer.page, 1, 30_000);

    const peers: string[] = await peer.page.evaluate(
      () => (window as any).__skeinTest.canvas.repo.peers ?? []
    );
    expect(peers).toContain(hub.nodeId);
  });
});
