// ---------------------------------------------------------------------------
// dedicated test bootstrap for ACL-enforcement e2e tests.
//
// separate from sync-test-bootstrap.ts on purpose: this is the only
// bootstrap that wraps its BroadcastChannelNetworkAdapter in an
// AclFilteringNetworkAdapter, and that's specific enough to ACL testing
// (and touches a repo that hasn't been created yet at the point the
// resolver needs to be built — see `repoBox` below) that folding it into
// the shared bootstrap felt like the wrong tradeoff. keeping it separate
// means acl-enforcement.spec.ts can't destabilize the many other tests
// that already depend on sync-test-bootstrap.ts's exact behavior.
//
// loads no PixiJS — same rationale as sync-test-bootstrap.ts, these tests
// only need the automerge doc + store, not a rendered canvas.
// ---------------------------------------------------------------------------

import type { DocumentId, Repo } from "@automerge/automerge-repo";
import { BroadcastChannelNetworkAdapter } from "@automerge/automerge-repo-network-broadcastchannel";

import { CanvasStore } from "../canvas/canvas-store";
import { createSkeinHarness } from "../harness/skein-harness";
import { createAclFilteringAdapter, createRepoRoleResolver } from "../p2p/acl-filtering-network-adapter";
import type { RoleResolver } from "../p2p/acl-filtering-network-adapter";

interface AclTestInitOptions {
  canvasDocId?: string | null;
}

interface AclTestInitResult {
  canvasDocId: string;
}

async function initSkeinForTest(options: AclTestInitOptions = {}): Promise<AclTestInitResult> {
  // the roleResolver needs a `Repo` to read cached ACL data from, but the
  // `Repo` doesn't exist until after the network adapter (which needs the
  // roleResolver) is constructed. `repoBox` breaks that cycle: the
  // resolver closure reads `repoBox.repo` lazily.
  //
  // this must be populated *before* a document's own sync traffic can
  // start flowing, not merely before `createSkeinHarness()` returns:
  // building the harness with `skipStore: true` gets us the repo (and
  // therefore lets us fill `repoBox.repo`) without also opening/joining a
  // canvas doc as part of that same call. opening the doc is a separate
  // step below, done only once the resolver already has a real repo to
  // read from. previously this filled `repoBox.repo` only *after*
  // `createSkeinHarness()` resolved - but for a joining peer, that
  // resolution itself waits on `CanvasStore.open()`, which can't complete
  // until the admin's changes actually get applied. with `repoBox.repo`
  // still unset for that entire wait, the resolver had no choice but to
  // return its "viewer" fallback for every inbound message, permanently
  // stripping the admin's changes to nothing - a deadlock a joining peer
  // could never recover from.
  const repoBox: { repo?: Repo } = {};
  const roleResolver: RoleResolver = (documentId, senderId) => {
    if (!repoBox.repo) return "viewer";
    return createRepoRoleResolver(repoBox.repo)(documentId, senderId);
  };

  const aclAdapter = createAclFilteringAdapter(new BroadcastChannelNetworkAdapter(), roleResolver);

  const harness = await createSkeinHarness({
    networkAdapter: aclAdapter,
    // ephemeral storage — mirrors sync-test-bootstrap.ts: these peers
    // always fetch the doc from another peer over BroadcastChannel rather
    // than needing their own IndexedDB copy.
    ephemeralStorage: true,
    skipStore: true,
  });
  repoBox.repo = harness.repo;

  const store = options.canvasDocId
    ? await CanvasStore.open(harness.repo, options.canvasDocId as DocumentId)
    : CanvasStore.create(harness.repo);

  // the harness's CanvasStore.create()/open() never sets a local node id or
  // stamps an admin the way production's real canvas-creation flow does
  // (see standalone/boot.ts) — without this, a freshly created canvas has
  // an empty `.acl`, so its own creator resolves to the same "no recorded
  // role" default as any other peer once its changes reach someone else's
  // network adapter. only the peer that actually creates the canvas
  // (rather than joining one via `options.canvasDocId`) self-stamps here —
  // a peer joining an existing canvas shouldn't claim admin before the
  // real admin's `.acl` entry has synced over.
  store.setLocalNodeId(harness.repo.peerId);
  if (!options.canvasDocId) {
    store.stampAdmin(harness.repo.peerId);
  }

  (window as any).__skein = {
    store,
    repo: harness.repo,
    peerId: harness.repo.peerId,
    widgetManager: null,
    app: null,
  };

  return { canvasDocId: store.handle.documentId };
}

(window as any).__initSkeinForTest = initSkeinForTest;
