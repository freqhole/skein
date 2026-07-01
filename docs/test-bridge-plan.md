# test bridge architecture — planning notes

## the problem

the `image-and-profile.test.ts` tests needed access to social widget state (the
standalone social doc, identity generation, avatar upload). to make those tests
work quickly, i added several top-level window properties from production code:

```ts
// scattered across boot.ts and profile-tab.ts — bad
(window as any).__skeinEnsureIdentity = ensureIdentity;
(window as any).__skeinSocialDoc      = this.socialDoc;
(window as any).__skeinToggleSocial   = () => ...;
(window as any).__skeinPickAvatar     = pickAvatarFile;
```

and the tests access them directly:

```ts
// test file — also bad
await page.evaluate(async () => {
  await (window as any).__skeinSocialDoc.change(...);
});
```

this violates the pattern already established in `tests/helpers/skein-bridge.ts`
and described in `docs/e2e-testing.md`:

> skein uses a single `window.__skeinTest` object as the only window-level test
> hook. it is populated in dev mode only. all access goes through typed helpers.

there are two distinct problems:

1. **scatter** — many top-level `window.__skeinFoo` names instead of one
   structured object with discoverable, typed namespaces.

2. **production leakage** — test code embedded in `boot.ts` and `profile-tab.ts`
   instead of isolated to dev/test harness entry points.

---

## current architecture (how things are supposed to work)

```
index.html / test-harness.html
  └─ boot.ts (production app)     → window.__skein, window.__skeinRouter
  └─ test-bootstrap.ts (dev only) → window.__skeinTest.canvas
                                    window.__skeinTest.p2p

tests/helpers/skein-bridge.ts       wraps every window.__skeinTest.* access
                                    with typed async functions

tests/fixtures/canvas-page.ts       playwright fixture, creates pages using
                                    test-harness.html, calls __initSkeinForTest
```

the key design decisions:
- **test harness pages** load test-specific bootstrap code; `index.html` is clean
- **`window.__skeinTest`** is the ONLY window-level hook; its type is defined in
  typescript so callers get completion and errors
- **`skein-bridge.ts`** is the only place that writes `(window as any).*`; test
  files only import typed helpers

### why `image-and-profile.test.ts` couldn't fit this pattern

the `image-and-profile` tests use `index.html` (via `page.goto("/")`), not the
test harness pages. that's because they need the full boot flow: narthex router,
social overlay, identity lifecycle, real IDB persistence across reloads. the
canvas-page fixture only initialises a canvas — it doesn't boot the full skein
router with all its overlay machinery.

so the social doc, identity helpers, and overlay toggle aren't wired into
`window.__skeinTest` at all. they live in the full router context that only
exists on a real `index.html` boot.

---

## options

### option A — populate `__skeinTest` from `boot.ts` (conditional on mode)

add a `populateTestBridge(router)` call near the end of `boot.ts`, guarded by
`import.meta.env.DEV` or a build flag:

```ts
// boot.ts
if (import.meta.env.DEV) {
  populateTestBridge({
    social: {
      getDoc:        () => router.socialDoc,
      ensureIdentity: ensureIdentity,
      toggleOverlay: () => router.currentSocialOverlay?.toggle(...),
      pickAvatar:    () => router.socialPickAvatarFn?.(),
    },
  });
}
```

`populateTestBridge` merges the passed object into `window.__skeinTest`, which
is already set up by `test-bootstrap.ts` for test-harness pages. for
`index.html` boots, it would create it if absent.

add corresponding typed helpers to `skein-bridge.ts`:

```ts
export async function getSocialProfile(page: Page) { ... }
export async function ensureIdentityBridge(page: Page) { ... }
export async function pickAvatarBridge(page: Page) { ... }
```

**pros:**
- consistent with existing pattern
- tree-shaken from production builds via `import.meta.env.DEV`
- types can be shared between the bridge definition and `skein-bridge.ts`
- no scattered top-level names

**cons:**
- `boot.ts` still needs to know about test bridge population — some coupling
- requires adding accessors (e.g. `socialPickAvatarFn`) to router to expose
  profile-tab internals without importing them directly
- `image-and-profile.test.ts` loads `index.html`, which means it gets the real
  boot (with midden WASM, iroh adapter, etc.) rather than the lightweight
  test-harness version — tests are inherently slow

### option B — a dedicated harness for full-router tests

create `test-harness-full.html` + `src/dev/full-test-bootstrap.ts` that boots
the full skein router (same as `boot.ts`) but with:
- explicit `window.__skeinTest` population
- perhaps a stub or lazy iroh adapter (so tests don't need midden WASM)
- controlled IDB reset between tests via a helper instead of the broken
  "goto + delete while live + goto again" pattern

this is the cleaner long-term architecture but requires more upfront work.

**pros:**
- test harness pages are still the only place with test code
- production `boot.ts` stays clean
- can provide a faster boot path by skipping iroh init until actually needed

**cons:**
- more files to maintain
- need to keep test-harness-full and boot.ts in sync as features are added
- the current `image-and-profile.test.ts` tests DO need real IDB persistence
  across reload — a harness that resets IDB on each test won't help for those

### option C — accept `import.meta.env.DEV` hooks in app code, enforce namespace

accept that some test-facing code lives in app files, but enforce two rules:
1. everything goes under `window.__skeinTest` — never a top-level `window.__foo`
2. app files use a typed `registerTestHook(namespace, api)` helper that
   accumulates into `__skeinTest` and is no-op in production builds

```ts
// src/utils/test-hooks.ts
export function registerTestHook<K extends keyof SkeinTestBridgeExtensions>(
  key: K,
  api: SkeinTestBridgeExtensions[K]
): void {
  if (!import.meta.env.DEV) return;
  const t = (window as any).__skeinTest ?? {};
  t[key] = api;
  (window as any).__skeinTest = t;
}
```

then in `boot.ts`:
```ts
registerTestHook("social", {
  getDoc: () => this.socialDoc,
  ensureIdentity,
  toggleOverlay: () => ...,
});
```

and in `profile-tab.ts`:
```ts
registerTestHook("social.pickAvatar", pickAvatarFile);
```

**pros:**
- minimal refactor from where we are now
- `import.meta.env.DEV` guard means nothing ships in prod builds
- `SkeinTestBridgeExtensions` type provides discoverability and completion
- `skein-bridge.ts` remains the only place tests read from window

**cons:**
- app files still import a test-facing utility
- SkeinTestBridge type definition needs to be kept up to date manually
- "registerTestHook from many files" can get messy to track

---

## recommended next step

**short term (clean up the current mess):**

1. undo the scattered top-level `window.__skeinFoo` properties (from boot.ts
   and profile-tab.ts)
2. create a typed `SkeinTestBridgeSocial` interface
3. populate it in ONE place — a small `populateFullBootTestBridge(router)` call
   at the end of `boot.ts`, guarded by `import.meta.env.DEV`
4. update `tests/helpers/skein-bridge.ts` with `getSocialProfile`,
   `ensureIdentity`, `pickAvatar`, `toggleSocialOverlay` bridge helpers
5. update `image-and-profile.test.ts` to use those helpers instead of
   `(window as any).__skeinFoo` directly

**longer term:**
- explore option B (dedicated full-router test harness) when there's time
- once a full-router harness exists, `index.html` can be production-only and
  all e2e tests load test harness pages

---

## open questions

1. **IDB reset between tests** — the "goto / delete while live / goto" pattern
   is broken (deletions blocked by live connections). the right fix is probably
   to rely on playwright's per-test fresh browser contexts instead of manual
   clearing. but serial tests share a context — does playwright actually give
   fresh contexts there? needs a definitive answer (running a test that asserts
   whether IDB is empty at test start would confirm this).

2. **should `socialDoc` be part of `SkeinCanvas`?** — the social overlay state
   is managed by the router, not the canvas. tests that want to inspect social
   state currently need router-level access. if social doc were surfaced on
   `SkeinCanvas` (as `canvas.socialDoc`), the existing `window.__skein` access
   would be sufficient — no extra test hook needed. worth considering.

3. **midden WASM in tests** — `ensureIdentity()` starts midden, which takes
   several seconds. tests that need identity generation are always slow. is there
   a stub `MiddenNode` that generates a deterministic keypair synchronously,
   without actual WASM? that would let the "generates an identity" test run in
   milliseconds rather than seconds.

4. **polly.js / network mocking** — as mentioned in previous planning, mocking
   the iroh relay traffic would let us write many more multi-peer tests without
   the real QUIC setup. this is orthogonal to the bridge question but worth
   noting here as a test speed lever.
