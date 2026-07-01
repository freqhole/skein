# skein runtime api — architecture and testing plan

## the core insight

the skein app is two mostly-independent things stacked together:

1. **the runtime** — automerge repo, P2P transport, canvas/social documents,
   identity, presence, file/blob handling, ACL. pure data and networking.
   no rendering, no PixiJS, no DOM (beyond IDB).

2. **the presentation** — PixiJS, widget renders, toolbar, overlays, input
   routing. a view over the runtime's state.

right now these are coupled in `initCanvas()`, which creates the automerge
repo, the iroh adapter, AND the PixiJS app in one call. the test bootstraps
(`p2p-test-bootstrap.ts`, `test-bootstrap.ts`) already try to work around this
by passing a pre-built repo into `initCanvas` — but they still instantiate the
full PixiJS app, which is slow, visually noisy, and irrelevant to most business
logic tests.

the presentation layer is also the most volatile part of the codebase. widgets
get redesigned, layouts change, overlays get moved around. tests that assert
against the presentation are expensive to maintain.

**most of what we actually want to test lives entirely in the runtime layer.**

---

## what the runtime layer covers

these are the things that matter and that will be stable across UI changes:

| domain | examples |
|---|---|
| automerge sync | widget add/delete/move on peer A appears on peer B |
| ACL | only owners can add peers; invited-only canvases reject unauthorised adds |
| identity | generate, persist, restore across reload; export/import bundle |
| file / blob transfer | upload on peer A, download on peer B via iroh blob protocol |
| image processing | resize, WebP encode, crop — deterministic output for given input |
| social | friend request flow, accept/reject, canvas share invite lifecycle |
| presence | peer comes online/offline, last-seen timestamps |
| canvas metadata | title/description/color sync, canvas-card auto-populate from social |
| widget documents | per-widget automerge docs created lazily, survive reload |
| hub / reliquary | server-side access control sync, invite grant/revoke |

none of these need PixiJS.

---

## proposed: `SkeinRuntime`

extract the runtime into a first-class construct that can be instantiated
without any presentation wiring:

```ts
// src/runtime/skein-runtime.ts

interface SkeinRuntimeOptions {
  /** network adapters — defaults to BroadcastChannel only */
  network?: "broadcast" | "iroh" | "both";
  /** seed an existing canvas doc instead of creating a fresh one */
  canvasDocId?: string;
  /** use a shared Repo (for multi-peer in the same browser context) */
  repo?: Repo;
}

interface SkeinRuntime {
  readonly repo: Repo;
  readonly store: CanvasStore;          // the canvas automerge doc
  readonly socialStore: SocialStore;    // social doc (profile, friends, etc.)
  readonly presence: PresenceManager;
  readonly identity: IdentityService;   // ensureIdentity, getStored, delete...
  readonly blobs: BlobService;          // upload, fetch, transfer between peers
  readonly iroh: IrohNetworkAdapter | null;  // null for broadcast-only
  destroy(): Promise<void>;
}

export async function createSkeinRuntime(
  opts: SkeinRuntimeOptions = {}
): Promise<SkeinRuntime> { ... }
```

the presentation layer then becomes a thin shell that receives a `SkeinRuntime`
and renders against it:

```ts
// initCanvas gets runtime instead of creating it
const runtime = await createSkeinRuntime({ network: "both" });
const canvas = await initCanvas({ mountElement, runtime, registry });
// canvas is purely the PixiJS + widget layer
```

---

## multi-peer testing without PixiJS

with a `SkeinRuntime` that can be instantiated in isolation, we can spin up
multiple peers inside a single browser page. BroadcastChannel syncs them at
near-native automerge speed (microseconds).

```ts
// tests/runtime/sync.test.ts

test("widget add on peer A syncs to peer B", async ({ page }) => {
  const { peerA, peerB } = await page.evaluate(async () => {
    // both peers share the same BroadcastChannel origin
    const a = await createSkeinRuntime({ network: "broadcast" });
    const b = await createSkeinRuntime({
      network: "broadcast",
      canvasDocId: a.store.handle.documentId,
    });
    // give automerge a tick to sync the initial doc
    await new Promise(r => setTimeout(r, 50));
    return { docId: a.store.handle.documentId };
  });

  // peerA adds a widget
  await page.evaluate(() => {
    window.__peers.a.store.addWidget({
      id: "w1", type: "label",
      x: 100, y: 100, width: 200, height: 50,
      props: { text: "hello" }, ...defaults
    });
  });

  // assert peerB received it without any fixed wait
  await page.waitForFunction(
    () => !!window.__peers.b.store.doc().widgets["w1"],
    { timeout: 2_000 }
  );
});
```

for real iroh P2P (cross-browser / cross-origin), we still use the existing
`p2pPage` fixture which spawns separate browser pages — that layer is correct,
just needs the PixiJS requirement removed from the bootstrap.

---

## test layers (revised)

| layer | instances | transport | speed | what it tests |
|---|---|---|---|---|
| unit | 1 (vitest, no browser) | none | <10ms | pure fns: schema validation, doc mutations, image processing |
| runtime (single peer) | 1 in-page | none | <100ms | store mutations, identity, IDB persistence, doc lifecycle |
| runtime (multi-peer broadcast) | 2–5 in-page | BroadcastChannel | <500ms | sync, conflict resolution, ACL, social flows |
| runtime (real iroh) | 2–3 browser pages | iroh QUIC | 5–60s | transport correctness, relay fallback, actual blob transfer |
| smoke (full app) | 1 | broadcast | ~5s | boot, narthex, basic canvas create/navigate — stable sanity check |

the expensive "full app" smoke tests are for catching regressions in boot and
navigation. the bulk of coverage should live in the fast runtime layers.

---

## what `SkeinRuntime` exposes for test assertions

the goal is that most assertions look like this — no `page.evaluate` gymnastics,
just reading typed state:

```ts
// a typed in-page bridge (populated by createSkeinRuntime in test mode)
interface SkeinRuntimeTestApi {
  store: {
    doc(): CanvasDocument;
    widgetCount(): number;
    getWidget(id: string): WidgetEntry | null;
    addWidget(entry: Partial<WidgetEntry>): string; // returns widget id
    removeWidget(id: string): void;
    setPeer(nodeId: string): void;
    peers(): string[];
  };
  social: {
    getProfile(): SocialProfile;
    setUsername(name: string): void;
    getNodeId(): string | null;
  };
  identity: {
    ensure(): Promise<string>;       // returns nodeId
    get(): P2PIdentity | null;
    delete(): Promise<void>;
  };
  blobs: {
    upload(data: Uint8Array, mimeType: string): Promise<string>;  // returns hash
    fetch(hash: string): Promise<Uint8Array>;
  };
  iroh: {
    nodeId(): string;
    state(): EndpointState;
    addPeer(nodeId: string): Promise<void>;
    waitForOnline(ms?: number): Promise<void>;
  } | null;
}
```

from playwright tests, `skein-bridge.ts` wraps these into typed async helpers
so test files never touch `(window as any).*` directly.

---

## the window.__skeinTest question

with `SkeinRuntime`, the window exposure question becomes cleaner:

- **in test harness pages** (`test-harness.html`, `test-harness-p2p.html`),
  `createSkeinRuntime` is called explicitly. the result is stored in
  `window.__skeinTest` as part of the bootstrap. no production code is touched.

- **in the full app** (`index.html`), `createSkeinRuntime` would be called by
  `boot.ts`. in dev builds (`import.meta.env.DEV`), the runtime is additionally
  exposed on `window.__skeinTest`. in production builds it is not.

- the `window.__skein` alias (currently `SkeinCanvas`) could be removed from
  the full app boot over time — tests that need canvas state would use
  test harness pages instead.

this eliminates the "test code leaking into production source files" problem
entirely for harness-based tests, and makes it minimal and guarded for the
full-app tests that genuinely need a real boot.

---

## migration path

### phase 1 — immediate (clean up current mess)

1. revert the scattered `window.__skeinFoo` properties added to `boot.ts` and
   `profile-tab.ts` in the recent image-and-profile work.

2. move everything into a `SkeinTestBridgeSocial` interface under
   `window.__skeinTest.social` — populated in `boot.ts` behind
   `import.meta.env.DEV`.

3. add typed helpers to `skein-bridge.ts` and update
   `image-and-profile.test.ts` to use them. no more `(window as any).*` in
   test files.

### phase 2 — extract SkeinRuntime

4. pull the non-UI construction out of `initCanvas` into
   `createSkeinRuntime()`.

5. update `initCanvas` to accept a `SkeinRuntime` (passes a pre-built repo and
   stores). existing test bootstraps become simpler.

6. update `p2p-test-bootstrap.ts` and `test-bootstrap.ts` to call
   `createSkeinRuntime` — no `initCanvas` needed for non-UI tests.

### phase 3 — expand runtime test coverage

7. write multi-peer BroadcastChannel tests (2–5 peers, single browser page)
   for sync, ACL, and social flows.

8. write real iroh tests for blob transfer and relay correctness.

9. add identity and image processing unit tests (vitest, no browser needed).

---

## open questions

- **CanvasStore vs SocialStore** — should the social doc be part of the runtime
  from the start, or introduced separately? right now social state is managed
  by boot.ts as a side-effect of the router. extracting it into the runtime
  would clarify ownership.

- **ACL implementation** — the access control layer (reliquary hub sync,
  invite grant/revoke) is the most important correctness property to test and
  currently has almost no coverage. what is the exact ACL model? who can do
  what? this should be specified before writing tests, not inferred from bugs.

- **blob service interface** — file/blob transfer between peers is a core
  feature. what does the current blob service look like? is there a
  `BlobService` already or is it ad-hoc? this needs to be a first-class part
  of `SkeinRuntime`.

- **multi-instance IDB isolation** — running 3 `SkeinRuntime` instances in the
  same browser page means 3 `IndexedDBStorageAdapter` instances all writing to
  the same origin's IDB. they'll use the same database name and stomp on each
  other. `SkeinRuntime` needs an `idbNamespace` option to isolate storage.
