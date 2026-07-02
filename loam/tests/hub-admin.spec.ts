/**
 * real remote hub-administration protocol tests.
 *
 * confirms a browser peer with real iroh networking (via midden) can act as
 * a remote admin caller against reliquary's `iroh/skein-hub-admin/1`
 * protocol (`reliquary/src/protocol/hub_admin.rs`): dial the hub directly,
 * send a CBOR-encoded `AdminRequest`, and get back a parsed `AdminResponse`.
 * this is a genuinely different code path from `reliquary-hub.spec.ts` and
 * `friendz-hub.spec.ts` — those exercise `iroh/automerge-repo/1` (doc sync)
 * and `skein-friendz/1` (peer-to-peer friend requests), neither of which
 * touches the hub's `hub_adminz` table or this ALPN at all.
 *
 * the low-level client lives in `SkeinP2PBridge.hubAdminRequest`
 * (`src/dev/test-bridge.ts`): it opens a raw bidirectional stream via
 * midden's `open_bi`, CBOR-encodes the request (matching `ciborium`'s
 * default serde external-tagging shape), writes it and calls `finish()`,
 * then reads the CBOR-encoded response back with `read_to_end()` — the
 * same raw framing convention `skein/1`'s `blob_proxy` handler uses.
 *
 * being in `hub_adminz` is itself only grantable locally (the protocol has
 * no way for a remote caller to grant admin rights to themselves or anyone
 * else, only to *act* as an admin once already granted) — tests use
 * `ReliquaryHubHandle.adminAllow()`, which shells out to
 * `reliquary admin allow <node_id>` the same way `friendAllow()` shells out
 * to `reliquary friend allow <node_id>`.
 *
 * tag: @hub
 * run with: npx playwright test tests/hub-admin.spec.ts --workers=1
 */

import type { Page } from "@playwright/test";
import { test, expect } from "./fixtures/p2p-page";
import { addPeer, waitForPeerCount } from "./helpers/skein-bridge";
import { startReliquaryHub, type ReliquaryHubHandle } from "./helpers/reliquary-hub";
import type { AdminRequest, AdminResponse } from "../src/dev/test-bridge";

/**
 * send a hub admin request with a short retry loop for the initial dial.
 *
 * `hubAdminRequest` opens a fresh iroh stream on demand (`midden.open_bi`)
 * with no retry of its own — same relay-discovery lag documented on
 * `IrohNetworkAdapter.openBiWithRetry()` and already worked around the same
 * way by `friendz-hub.spec.ts`'s `sendFriendRequestWithRetry` and
 * `blob-acl.spec.ts`'s `fetchBlobWithRetry`.
 */
async function hubAdminRequestWithRetry(
  page: Page,
  hubNodeId: string,
  request: AdminRequest,
  attempts = 4,
  delayMs = 750
): Promise<AdminResponse> {
  let lastErr: unknown;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await page.evaluate(
        async ([nodeId, req]) => {
          const bridge = (window as any).__skeinTest;
          return bridge.p2p.hubAdminRequest(nodeId, req);
        },
        [hubNodeId, request] as const
      );
    } catch (err) {
      lastErr = err;
      if (attempt < attempts) {
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
    }
  }
  throw lastErr;
}

test.describe("remote hub admin protocol @hub", () => {
  let hub: ReliquaryHubHandle | undefined;

  test.afterEach(async () => {
    await hub?.stop();
    hub = undefined;
  });

  test("a hub admin can remotely allow a peer into friendz, and that peer then syncs @hub", async ({
    p2pPage,
  }) => {
    test.setTimeout(90_000);

    hub = await startReliquaryHub();

    const admin = await p2pPage();
    const target = await p2pPage();

    // bootstrap: grant `admin` admin rights locally, the only way admin
    // rights can ever be granted (the protocol itself only lets an admin
    // manage friendz, not adminz).
    await hub.adminAllow(admin.nodeId);

    // the real thing under test: `admin` dials the hub over
    // `iroh/skein-hub-admin/1` and asks it to allow `target` into friendz.
    const allowResponse = await hubAdminRequestWithRetry(admin.page, hub.nodeId, {
      kind: "allow",
      nodeId: target.nodeId,
    });
    expect(allowResponse).toEqual({
      kind: "allowed",
      nodeId: target.nodeId,
      status: "allowed",
    });

    // a follow-up `list` request confirms the hub's friendz table really
    // was mutated by the remote call, not just that we got a well-formed
    // reply back.
    const listResponse = await hubAdminRequestWithRetry(admin.page, hub.nodeId, {
      kind: "list",
    });
    expect(listResponse.kind).toBe("list");
    if (listResponse.kind === "list") {
      expect(listResponse.friends.map((f) => f.nodeId)).toContain(target.nodeId);
    }

    // and the end-to-end proof: `target` (previously unknown to the hub) can
    // now actually connect and sync, exactly as if an operator had run
    // `reliquary friend allow` locally. same deterministic hub-log signal
    // `reliquary-hub.spec.ts` uses, since client-side `repo.peers` only
    // reflects the local QUIC dial, not the server's accept/reject decision.
    await addPeer(target.page, hub.nodeId);
    await waitForPeerCount(target.page, 1, 30_000);

    await expect
      .poll(() => hub!.getLog(), { timeout: 15_000 })
      .toContain("created new doc for incoming sync");
  });

  test("a non-admin peer's remote allow request is rejected and friendz stays unaffected @hub", async ({
    p2pPage,
  }) => {
    test.setTimeout(90_000);

    hub = await startReliquaryHub();

    const stranger = await p2pPage();
    const target = await p2pPage();

    // deliberately skip hub.adminAllow() — `stranger` is not in hub_adminz.
    const response = await hubAdminRequestWithRetry(stranger.page, hub.nodeId, {
      kind: "allow",
      nodeId: target.nodeId,
    });
    expect(response).toEqual({ kind: "notAdmin" });

    // the flip side: friendz was never touched, so `target` still can't
    // sync against the hub afterward.
    await addPeer(target.page, hub.nodeId);

    await expect
      .poll(() => hub!.getLog(), { timeout: 15_000 })
      .toContain("rejected unauthorized peer");

    expect(hub.getLog()).not.toContain("created new doc for incoming sync");
  });
});
