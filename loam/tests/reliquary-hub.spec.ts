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
 * note (2026-07-01): `reliquary/src/sync.rs`'s `IrohRepo::accept` now
 * rejects peers that aren't friends (`friendz::Store::is_friend`) before
 * ever accepting the bidirectional stream — see reliquary/src/sync.rs and
 * its unit tests for the server-side authorization check itself. checking
 * `repo.peers` on the *client* side is not a reliable signal for whether
 * the server accepted or rejected the connection, though: automerge-repo's
 * `IrohNetworkAdapter` fires its local `peer-candidate` event as soon as
 * *its own* `open_bi()` call resolves (a QUIC stream opening locally), which
 * happens independently of — and can race — the server's protocol-handler
 * task actually running and deciding to reject. the second test below
 * instead asserts on the hub's own log for a deterministic signal: an
 * authorized peer's connection produces a "created new doc for incoming
 * sync" line (real doc sync happened), an unauthorized peer's does not
 * (and produces a "rejected unauthorized peer" line instead).
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

    // pre-approve the browser peer as a friend before dialing — the
    // intended real-world sequencing, and now load-bearing: an
    // unauthorized peer's connection gets rejected server-side (see file
    // header and the second test below).
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

    // the deterministic, server-side signal: an authorized peer's canvas
    // doc actually gets synced and a doc entry created hub-side.
    await expect
      .poll(() => hub!.getLog(), { timeout: 15_000 })
      .toContain("created new doc for incoming sync");
  });

  test("hub rejects an unauthorized peer's automerge-repo connection @hub", async ({
    p2pPage,
  }) => {
    test.setTimeout(90_000);

    hub = await startReliquaryHub();

    const peer = await p2pPage();

    // deliberately skip hub.friendAllow() — this peer is unknown to the hub.
    await addPeer(peer.page, hub.nodeId);

    // the hub's `IrohRepo::accept` rejects before ever accepting the
    // bidirectional stream, logging this line instead of ever reaching
    // "accepted inbound connection" / doc sync — see reliquary/src/sync.rs.
    await expect
      .poll(() => hub!.getLog(), { timeout: 15_000 })
      .toContain("rejected unauthorized peer");

    // and, the flip side of the authorized-peer test above: no doc sync
    // ever happens for this peer, no matter how long we wait.
    expect(hub.getLog()).not.toContain("created new doc for incoming sync");
  });
});
