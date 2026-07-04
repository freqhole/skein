# browser P2P blob memory + transfer reliability plan (started 2026-07-04)

status: planning / research consolidation, key architectural decisions
made (section 6, 2026-07-04). no implementation started yet. **this doc
is written as a handoff** — the user's intent is to hand this off to a
fresh agent/session to actually implement, so it's written to be
self-contained: read this doc plus
[opfs-blob-store-design.md](opfs-blob-store-design.md) in full before
starting, and you should have everything needed to begin phase A/B work
or scope out phase C's Worker-migration design pass without needing
further chat history.

this doc exists because two rounds of targeted fixes to the "download to
disk" bug (tracked as item 8 in
[narthex-widgets-and-file-transfer-plan.md](narthex-widgets-and-file-transfer-plan.md))
did not resolve the user's repro — the underlying issue is architectural
(full in-memory buffering, `MemStore`'s tiny eviction cap), not a small
logic bug. this doc collects everything currently known, points at the
existing deep-dive design doc for the real fix
([opfs-blob-store-design.md](opfs-blob-store-design.md)), and lays out a
plan going forward that also covers the browser upload path and
browser-to-browser transfer (not just the tauri-source case that item 7
already fixed).

**tl;dr of where this ended up** (see section 6 for full detail): the
user has confirmed all four of the open questions this doc originally
posed — (1) yes, move `MiddenNode` into a dedicated Worker, (2) yes, fix
both upload and download, for both browser peers, with a hard requirement
of zero full-buffer points anywhere in the pipeline plus no 2x-disk-space
double-buffering for "save to disk," (3) prefer real automated tests over
more live-repro debugging, structured to mirror `reliquary`'s
native-testable conventions, and (4) build directly against the
now-locally-checked-out `iroh-blobs` v0.103.0 repo
(`/Users/edward/src/github/n0-computer/iroh-blobs`), with upstreaming
explicitly deferred to "once this is actually working."

## 0. the bug report that started this (verbatim symptoms)

user, downloading a ~250MB file via the file widget's "→ disk" button
(browser mode, source peer possibly tauri or another browser):

- progress goes from 0% to 100%, **twice**, before completing/failing.
- the file that ends up on disk is **0 bytes**.
- confirmed by the user after a first fix attempt: **"no real change,
  still running twice, still ending up with zero byte files."**

## 1. timeline of investigation + fix attempts so far

### round 1 (see item 8 in narthex-widgets-and-file-transfer-plan.md)

hypothesis at the time: strategy 3 (`skein/1` `proxy_request` JSON+base64
fallback in `downloadBlobBytesFromPeer()`, `src/widgets/file-utils.ts`) had
only a 30s timeout vs. strategy 1's 10-minute allowance, and could be
timing out + retrying against another peer for a large file.

fix applied: bumped strategy 2 + 3's timeout to match strategy 1
(`PEER_DOWNLOAD_TIMEOUT_MS = 10 * 60_000`), added a byte-length-mismatch
diagnostic log. **outcome: did not fix the user's repro.** (this timeout
bump is still a legitimate improvement and was left in place — a 30s cap
on a large transfer is a real latent bug regardless — but it wasn't the
cause of this specific report.)

### round 2 (same session, after a live 250MB repro)

deeper code read turned up a **confirmed, real** double-transfer
mechanism: `midden/src/lib.rs`'s `download_verified_with_ensure_progress()`
(called by strategy 1, and indirectly by strategy 2 via
`download_verified_with_ensure`) has a built-in blind retry —

```rust
match self.download_verified_with_progress(peer_addr, blake3_hash, total_size, on_progress).await {
    Ok(data) => return Ok(data),
    Err(_e) => { /* retry with ensure_blob (normal for first download) */ }
}
let available = self.ensure_blob(peer_addr, blake3_hash).await?;
// ... full second download, same progress callback, from scratch
self.download_verified_with_progress(peer_addr, blake3_hash, total_size, on_progress).await
```

and a separate, confirmed bug in `widgets/file.ts`'s `handleSnatchToDisk()`:
`handle.createWritable()` reserves/truncates the destination file **before**
the download starts (so cancelling the native save dialog doesn't leave
anything behind); the failure-path branch of the `catch` block reset UI
state but never called `writable.abort()` — only the user-cancelled branch
did. a genuine download failure left that pre-reserved file sitting on
disk, empty.

fixes applied:

- `midden/src/lib.rs`: log the discarded first-attempt error via
  `tracing::warn!`, explicitly reset `on_progress(0.0)` before the retry.
  wasm package rebuilt (`make build` in `skein/midden`).
- `widgets/file.ts`: `writable.abort()` now runs on every failure path
  (cancelled, destroyed, or genuine failure), not just cancellation.
- `src/widgets/file-utils.ts`: bumped a debug-level failure log to warn so
  it's visible without manually raising the log level.

all verified clean (`cargo build`/`clippy`/`test` in `midden` + rust
crates, `npm run typecheck`/`lint`/`vitest run` in `loam`, 689/689 passing).

**outcome, per the user's fresh repro after this fix: still running
twice, still 0 bytes.** the logging/reset/abort fixes were real
correctness improvements but did not address the actual root cause — see
section 2.

### why round 2's fixes didn't fix it — reassessment

both round-2 fixes treated the double-transfer and the 0-byte file as
independent, first-order bugs. they aren't — they're both **symptoms of
the same deeper architectural fact**: midden's iroh-blobs store is a
**fully in-RAM `MemStore`** with a **3-entry TempTag eviction cap**, not
an OPFS-backed persistent store. see section 2 for the mechanism that
actually (most likely) explains both symptoms.

the logging addition should still be useful for confirming this on the
next repro (the new `tracing::warn!` line will show the _actual_ first-
attempt error reason, e.g. a GC/eviction-related error vs. a genuine
network failure) — that log line has not yet been captured on a fresh
repro since it was added. **worth checking the browser console for that
line specifically before assuming the mechanism below is exactly right.**

## 2. the real, confirmed architectural problem

### 2.1 midden's iroh-blobs store is `MemStore` — fully in RAM

`midden/src/lib.rs` (`create_with_secret_key`, both call sites):

```rust
// setup iroh-blobs with MemStore + GC (blobs served on-demand from OPFS,
// GC reclaims memory after TempTags are dropped)
let mem_store =
    iroh_blobs::store::mem::MemStore::new_with_opts(iroh_blobs::store::mem::Options {
        gc_config: Some(GcConfig {
            interval: std::time::Duration::from_secs(30),
            add_protected: None,
        }),
    });
```

**the comment is stale/misleading** — confirmed via
[opfs-blob-store-design.md](opfs-blob-store-design.md) section 3.1 and
re-confirmed independently in this session: there is no OPFS involvement
in midden's iroh-blobs store at all today. `MemStore` is 100% RAM-backed.
this comment appears to conflate the _unrelated_ `blob-worker.ts`/
`skein-blob-store.ts` OPFS cache (the app's local "imported file" cache
for the file widget's own display — a completely separate system with its
own IndexedDB metadata + OPFS bytes, used for browser-mode uploads and
local persistence, not for P2P transfer at all) with midden's actual P2P
blob store. **this misleading comment should be fixed regardless of what
else happens** — it actively misled this investigation for a while.

### 2.2 every step of a browser-mode transfer fully buffers the blob

confirmed via direct code reading, both directions:

**serving side (`import_blob`, called when a browser peer uploads/shares a
file so peers can fetch it)**:

```rust
pub async fn import_blob(&self, data: &[u8]) -> Result<String, JsError> {
    let hash_bytes = blake3::hash(data);              // 1 — whole-buffer hash
    // ...
    let bytes_data = bytes::Bytes::from(data.to_vec()); // 2 — another full copy
    let tt = self.blobs_store.blobs().add_bytes(bytes_data).temp_tag().await?;
    // ...
}
```

and the JS-side caller (`storeBlobFromFile()`,
`src/storage/skein-blob-store.ts`) already does `await file.arrayBuffer()`
— reading the **entire** `File` into a JS `ArrayBuffer` before any of the
above even runs. so a browser-mode upload is already at least 2 full
copies in JS + 2 more in WASM before the blob is "servable."

**downloading side (`download_verified_with_progress`,
`midden/src/lib.rs`)**:

```rust
let bytes = self.blobs_store.get_bytes(hash).await?; // 1 — read whole blob out of MemStore
let array = Uint8Array::new_with_length(bytes.len() as u32);
array.copy_from(&bytes);                              // 2 — copy into a fresh Uint8Array
Ok(array)
```

then the JS side (`downloadBlobBytesFromPeer()`,
`src/widgets/file-utils.ts`) does `bytes.slice()` before
`writable.write(...)` — a **3rd** full copy, now in JS heap, purely to get
a plain (non-wasm-memory-backed) `Uint8Array` before handing it to the
File System Access API.

for a 250MB file that's on the order of 5 full-size buffers alive at
various points (2 in wasm linear memory for the store's own copy + the
returned array, plus JS-side original/decoded copies) — this is the
memory-pressure profile item 7 already fixed for the **tauri upload**
path (`register_path()`'s streaming rewrite) but is still completely
unaddressed for (a) browser-mode uploads and (b) **all** P2P downloads
(browser-to-browser or browser-from-tauri), regardless of source.

### 2.3 the 3-entry TempTag eviction cap — likely mechanism for "fails late"

```rust
/// the blob stays in the store as long as its TempTag is held in active_tags.
/// call release_blob() to allow GC, or it will be evicted when the map exceeds 3 entries.
pub active_tags: RefCell<IndexMap<Hash, TempTag>>,
```

```rust
// cap at 3 entries — evict oldest before inserting the 4th.
// blobs are served on-demand from OPFS; small cap keeps memory bounded.
// GC (30s interval) reclaims MemStore memory after TempTags are dropped.
if tags.len() >= 3 {
    let evict_key = *tags.keys().next().unwrap();
    tags.shift_remove(&evict_key);
}
```

(same misleading "served on-demand from OPFS" comment repeated here.)

**this is a strong, concrete candidate for why a large transfer "fails
late" on the first attempt** (the behavior that produces the visible
"twice" progress ramp, per round 2's analysis of
`download_verified_with_ensure_progress`'s blind retry): if the _sending_
peer has imported/tagged more than 3 blobs recently (easily possible
during normal canvas use — thumbnails, other file widgets, prior
snatches), the oldest TempTag is evicted, and iroh-blobs' background GC
(30s interval) can reclaim that blob's bytes out from under an
**in-progress** download — including possibly the very blob currently
being streamed to a peer, if 3 other blobs got tagged during the transfer
window (plausible for a 250MB transfer that takes real wall-clock time).
this would explain:

- the first attempt streaming a large fraction of the bytes successfully
  (real progress up to some point) before erroring out (the underlying
  MemStore entry vanished mid-read) — matching "runs to ~100% then fails."
- `ensure_blob()`'s retry re-triggering the sender to re-import/re-tag the
  blob (making it "fresh" again, unlikely to be evicted again
  immediately) — explaining why the **second** attempt often succeeds (or
  at least gets further).
- **not yet confirmed**: whether the _ultimate_ 0-byte-after-retry outcome
  (vs. a successful second attempt) is a _further_ GC race on the retry
  itself, a `get_bytes()` racing a GC sweep on the _receiving_ side's own
  temp storage before `download_verified_with_progress` finishes reading
  it back out, or something else. **this needs the actual
  `tracing::warn!` log line added in round 2 captured from a live repro**
  — it will show the first attempt's real error message, which will
  either confirm or rule out "evicted/GC'd" as the literal error text.

### 2.4 summary: this is not one bug, it's an architecture gap

| symptom                           | proximate cause (confirmed)                                                                    | root cause (architectural)                                        |
| --------------------------------- | ---------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| progress runs 0→100% twice        | `download_verified_with_ensure_progress`'s blind retry-from-scratch on any first-attempt error | first attempt fails late instead of fast — likely GC/eviction     |
| file saved as 0 bytes             | (fixed in round 2 — `writable.abort()` now runs on every failure path)                         | download still ultimately fails after both attempts on this repro |
| large transfers generally fragile | full in-memory buffering at every step (sections 2.1-2.2)                                      | `MemStore`, not an OPFS-backed persistent/streaming store         |

fixing the visible symptoms (rounds 1+2) was worthwhile (real bugs, now
fixed, verified) but doesn't fix the underlying reliability problem for
large files. the user has decided (this doc) to go after the actual
architecture instead of continuing to patch symptoms.

## 3. existing deep-dive research: opfs-blob-store-design.md

a thorough, empirically-verified research pass already exists at
[opfs-blob-store-design.md](opfs-blob-store-design.md) (written
2026-07-03, the day before this doc). **read that doc in full before
starting implementation** — this section is a summary/index, not a
replacement.

key findings from that doc (do not re-derive these, they're verified):

- `iroh_blobs::api::Store` is not a trait — it's a concrete struct wrapping
  an RPC client handle (`irpc::Client<proto::Request>`) talking to a
  background actor over a `Command` protocol (23 variants). `MemStore`/
  `FsStore` are both just actors behind this same handle shape.
- the "obvious" constructor (`Store::from_sender`) is `pub(crate)` —
  **but** a verified, legitimate (non-`unsafe`) workaround exists using
  `ref_cast::RefCast` + the fact that `ApiClient`'s underlying type
  (`irpc::Client<iroh_blobs::api::proto::Request>`) is nameable and
  publicly constructible from outside the crate. confirmed working in a
  minimal two-crate probe.
- `bao-tree`'s `ReadAt`/`WriteAt`/`Outboard` traits (the actual per-blob
  byte/hash-tree storage interface) are **synchronous only** — no async
  variant exists anywhere in the stack.
- `FileSystemSyncAccessHandle` (the only synchronous OPFS file API) is
  **only available inside a dedicated Worker** — not reachable from the
  main thread, where `MiddenNode` currently runs (confirmed: no `new
Worker(...)` wraps it anywhere; `identity.ts`, `friendz-bridge.ts`,
  `friendz-wiring.ts`, `skein-handler.ts`, `iroh-network-adapter.ts` all
  call it directly on the main thread today).
- this produces a hard fork in the road:
  - **stage 1 (small-medium)**: keep `MemStore` as-is, add an async OPFS
    checkpoint/rehydrate side-channel so an in-progress transfer survives
    a page reload (resumable), using iroh-blobs' existing resume
    machinery. **does not reduce peak memory usage** — RAM buffering is
    unchanged, just backed up periodically.
  - **stage 2 (large)**: a real custom `OpfsStore` actor implementing all
    23 commands, backed by real per-blob OPFS files via
    `FileSystemSyncAccessHandle` for genuinely synchronous, streaming
    reads/writes. **this is the one that actually bounds memory** — but it
    requires moving `MiddenNode`'s entire execution model into a dedicated
    Worker first, which the design doc flags as "plausibly as large a task
    as the OPFS store implementation itself" and deserving its own
    separate research pass.
- no existing crate solves this (`iroh-blobs opfs` returns zero hits on
  crates.io). the closest thing is a generic (non-iroh) OPFS binding
  helper (`opfs-project`) that only reduces `web-sys` ceremony, not the
  actual store logic.
- open risks flagged by that doc: the `RefCast` technique isn't a stable
  upstream contract (worth upstreaming a real public constructor —
  section 5 of that doc has a draft rationale); GC/tag/bitfield
  correctness against a foreign async storage layer is a real
  correctness-sensitive area needing adversarial tests, not just a
  happy-path transfer test; OPFS eviction under storage pressure and
  multi-tab contention (`FileSystemSyncAccessHandle` takes an exclusive
  per-file lock) are both unresolved questions.

## 4. scope for this plan: broader than opfs-blob-store-design.md's original framing

the existing design doc was scoped specifically to "OPFS-backed
`iroh-blobs` store for midden." the user's ask this session is broader —
also explicitly calls out:

> "espically between two browser wasm nodes (or even one wasm browser
> side) so that proper file chunk streaming works and there's nowhere e2e
> that needs to buffer the entire file in memory."

this means the following are IN SCOPE for the combined effort, beyond the
existing design doc's stage 1/2:

1. **browser-mode upload streaming** (`storeBlobFromFile()` /
   `skein-blob-store.ts`): currently `file.arrayBuffer()`s the whole
   `File` up front. browsers support `file.stream()` (a `ReadableStream`)
   — this can be piped in fixed-size chunks straight into whatever
   replaces the current OPFS-cache-write path (`writeBlobToOpfs`/
   `processBlobBytes` in `blob-worker.ts`) without ever holding the whole
   file in one JS buffer. this is the browser-mode equivalent of item 7's
   already-shipped tauri-side `register_path()` streaming fix, and is
   independent of the bigger `OpfsStore`-for-iroh-blobs work — **a
   legitimate, smaller, parallelizable stream of work.**
2. **midden's `import_blob`/`get_bytes` full-buffer boundary**: even after
   an `OpfsStore` exists (stage 2 of the design doc), the _public
   `#[wasm_bindgen]` API surface_ (`import_blob(data: &[u8])`,
   `download_verified_with_progress(...) -> Uint8Array`) still hands whole
   buffers across the JS/wasm boundary today. a real fix needs the public
   API itself to move toward a chunked/streamed shape (e.g. an
   `ImportByteStream`-style incremental import fed by `file.stream()`'s
   reader loop, and a download API that writes each verified chunk
   straight to an OPFS `FileSystemWritableFileStream`/sync-access-handle
   as it arrives instead of accumulating a `Uint8Array` and returning it
   whole at the end). this is a genuinely new API design question not
   fully covered by the existing design doc's command-protocol-level
   analysis — flagged here as follow-up work once stage 2's actor exists.
3. **the 3-entry TempTag eviction cap**: independent of OPFS, this cap
   (section 2.3) is a plausible/likely contributor to "fails partway
   through a large transfer" and should be revisited regardless of the
   OPFS work's timeline — either raise the cap, make it configurable, or
   (better, once real persistent storage exists) stop needing an
   RAM-eviction-based cap at all, since a real OPFS-backed store wouldn't
   need to evict blobs to bound memory the way the in-RAM `MemStore` does.
4. **fix the misleading "served on-demand from OPFS" comments** (2
   occurrences in `midden/src/lib.rs`) — small, but actively misleading
   for future debugging (it misled part of round 1/2's investigation
   before this doc's author re-derived that no OPFS involvement exists).

## 5. proposed phasing (combining the existing design doc + the above, revised per section 6's decisions)

this reconciles opfs-blob-store-design.md's stage 0-3 with the additional
scope in section 4. **updated after section 6's decisions — the Worker
migration and both-directions/no-full-buffer requirements are now
confirmed in scope, not proposals.**

- **phase A (quick, low-risk, do anytime, not blocked on anything else)**:
  fix the misleading MemStore/OPFS comments (section 4.4); capture a fresh
  repro with the round-2 `tracing::warn!` log now in place to
  confirm/refute the eviction-race hypothesis in section 2.3 (per section
  6.3's preference for tests over live repros, consider whether a test
  can force the eviction condition deterministically — e.g. import 4+
  blobs and assert the 4th eviction happens exactly as `active_tags`'
  cap logic describes — rather than relying on another manual repro);
  consider (pending confirmation) raising or removing the 3-entry TempTag
  cap as a cheap interim mitigation before the real OPFS store lands.
- **phase B (small-medium, parallelizable with phase C's early steps)**:
  browser-mode upload streaming (section 4.1 / requirement checklist item
  "resumable uploads" partially) — `file.stream()` piped into
  `blob-worker.ts`'s existing chunked-write machinery instead of
  `file.arrayBuffer()`. this alone reduces peak memory for the _upload_
  side of a large browser-mode file, independent of the P2P transfer
  question, and reuses OPFS-writing code that already exists (unlike the
  P2P store, which doesn't). note this only fixes the _local_ OPFS-cache
  upload path (section 2.1's separate system) — it does not by itself fix
  `import_blob`'s whole-slice parameter into midden's `MemStore`/future
  `OpfsStore`, which is phase C's job.
- **phase C (large, the real fix — now confirmed in scope per section
  6.1/6.2, not optional)**:
  1. stage 0 (opfs-blob-store-design.md): de-risk the `RefCast`
     construction technique against the **real** iroh-blobs crate — ideally
     directly against the local 0.103.0 checkout (section 6.4) rather than
     a mock crate, since that checkout is now available to build against
     directly.
  2. a dedicated research/design pass on the Worker migration (section
     6.1) — this is now a confirmed requirement, not a maybe; treat it as
     its own design doc/spike if it turns out as large as
     opfs-blob-store-design.md warns it might be.
  3. the real `OpfsStore` actor (opfs-blob-store-design.md stage 2),
     structured per section 6.3's testability requirement (thin OPFS
     adapter behind a swappable interface, native-testable core logic,
     mirroring `reliquary::blobz::Store`'s conventions).
  4. the public wasm-bindgen API redesign for chunked import/export
     (section 4.2 / requirement checklist's "true end-to-end chunk
     streaming, both directions") — `import_blob`'s whole-`&[u8]`
     parameter and `download_verified_with_progress`'s whole-`Uint8Array`
     return both need chunked replacements.
  5. the "no 2x disk space" requirement (section 7's checklist) — design
     how "download straight to disk" avoids requiring a full durable OPFS
     copy simultaneously with the disk destination copy; this may need its
     own sub-design once the `OpfsStore`'s actual write path is known (e.g.
     can a download be verified and forwarded chunk-by-chunk to a
     `FileSystemWritableFileStream` without every chunk also being
     committed to the OPFS store's own long-term files, for transfers the
     user explicitly wants "saved to disk" rather than "kept in the app"?).
  6. stage 3 verification (opfs-blob-store-design.md): resumability across
     reload (both upload and download, section 6.2/7's checklist),
     memory-bounded transfer confirmed empirically (peak WASM linear
     memory doesn't scale with blob size), adversarial GC/tag tests, plus
     the tauri-as-downloader question flagged in section 6.2 resolved
     (confirm whether it needs the same fix or already streams).
- **phase D (depends on phase C)**: once `OpfsStore` exists and the
  wasm-bindgen API is chunked, revisit whether the 3-entry TempTag
  eviction cap can be removed entirely (a real persistent store shouldn't
  need to evict to bound RAM the way `MemStore` does today); once things
  are working end-to-end in skein, revisit upstreaming per section 6.4
  (currently explicitly deferred).

## 6. decisions (2026-07-04, from the user, answering section 6's original open questions)

these are firm decisions, not proposals — the phasing in section 5 is
revised below to reflect them. **this doc is intended as a handoff to a
fresh agent/session** (the user's words: "my intention is to hand this
off to the new claude fable 5") — so each decision below is written to
stand alone, with enough context to act on without needing to re-derive
anything from chat history.

### 6.1 yes — move `MiddenNode` into a dedicated Worker

> "yes, should be using the worker thread for this stuff so the main ui
> thread is free to do other rendering stuff."

this confirms opfs-blob-store-design.md's stage 2 path (section 3.2/3.3 of
that doc) is in scope, not just stage 1's "resumable but still fully
buffered" compromise. **this is a prerequisite**, not an optional
enhancement — `FileSystemSyncAccessHandle` (the only synchronous OPFS file
API, required to satisfy `bao-tree`'s synchronous `ReadAt`/`WriteAt`/
`Outboard` traits) is only reachable inside a dedicated Worker, per spec.
there is no way to get a real memory-bounded, streaming store on the main
thread.

practical implication: every current main-thread call site of
`getMiddenNode()`/`MiddenNode` needs to go through a message-passing (or
Comlink-style) proxy instead of calling methods directly. confirmed call
sites (from opfs-blob-store-design.md section 3.1, re-verify at
implementation time in case new call sites were added since):
`src/p2p/identity.ts`, `src/p2p/friendz-bridge.ts`,
`src/p2p/friendz-wiring.ts`, `src/p2p/skein-handler.ts`,
`src/p2p/iroh-network-adapter.ts`, plus the p2p test harness. the existing
`blob-worker-client.ts` (Comlink-exposed wrapper around a _different_,
unrelated Worker — see section 2.1's clarification that this is the local
OPFS cache, not the P2P store) is a reasonable _pattern_ precedent for
"how this codebase already bridges to a Worker," but is not itself
reusable — this would be a new, separate Worker hosting the entire
`MiddenNode`/iroh endpoint, not an extension of the existing blob-worker.

opfs-blob-store-design.md's own risk flag stands: "this is plausibly as
large a task as the OPFS store implementation itself" — treat the
Worker migration as its own real sub-phase with its own design pass
(interface: what does the message protocol between main thread and the
Worker look like? does every current synchronous-feeling
`await middenNode.foo()` call become an async round-trip through
`postMessage`? how do the many main-thread files above adapt?), not a
quick wrapper exercise.

### 6.2 yes — both directions, and the actual goal is "never buffer the whole file"

> "yes, it should be, ideally, both ways upload & download; the goal here
> is large file handling and making sure there's no point in the pipeline
> where the entire file is buffered into memory."

this broadens scope beyond "fix the download-to-disk bug" to a full,
symmetric requirement. concretely, **every one of these must become
chunk-streamed, not whole-buffer**, for both browser-mode peers:

- **upload / import** (JS `File` → servable blob): `storeBlobFromFile()`'s
  `file.arrayBuffer()` (section 2.2) and midden's `import_blob(data: &[u8])`
  (whole-slice parameter, whole-buffer `blake3::hash(data)`,
  `bytes::Bytes::from(data.to_vec())`) both need to become chunked —
  `file.stream()`'s `ReadableStream` reader loop feeding fixed-size chunks
  into an incremental import (this is what `iroh-blobs`' own
  `ImportByteStream` command, listed in opfs-blob-store-design.md section
  1.2, exists for — the _protocol_ already supports this; midden's public
  `#[wasm_bindgen]` API surface just doesn't expose it yet).
- **download / export** (P2P transfer → JS bytes): `get_bytes()` (whole
  blob out of the store) → `Uint8Array` copy → JS `.slice()` copy
  (section 2.2) needs to become a real chunked stream — each verified
  BAO-tree leaf written directly to its final destination (OPFS or a
  `FileSystemWritableFileStream` for "save to disk") as it arrives, never
  accumulated into one in-memory buffer first.
- this applies **symmetrically to both midden-WASM peers in a
  browser-to-browser transfer** — i.e. the _sender's_ `import_blob`/serve
  path and the _receiver's_ download path both need to be fixed; a
  transfer is only genuinely memory-bounded end-to-end if neither side
  ever holds the whole blob in one buffer.
- **not yet investigated**: whether tauri-mode, when acting as the
  _downloading_ client (fetching a blob from a peer, as opposed to
  uploading a local file — item 7's already-fixed path), also fully
  buffers. `tauri/src/commands.rs` has no dedicated "download from peer"
  dispatch action (confirmed via grep — only `blob_get_path`/
  `blob_iroh_ensure` exist, both serving-side or local-lookup, not
  fetching-side); this suggests tauri-as-downloader may route through the
  same JS-level `downloadBlobBytesFromPeer()`/strategy-3 `proxy_request`
  path as a browser peer would, via `TauriStreamNode`'s JS-side
  implementation of the `skein/1` protocol client (bridged through
  `open_bi`/`read_message`/`write_message` in `streams.rs`) — but this
  was **not confirmed** in this session; the fable-5 agent picking this up
  should verify this explicitly (grep `iroh-network-adapter.ts`
  / wherever `TauriStreamNode`'s JS wrapper lives for `proxy_request`/
  `download_verified_*`-shaped methods, or their absence) before assuming
  tauri-as-downloader is either already fine or in need of the same fix.
- **also in scope, explicitly called out**: further optimizing so a large
  file doesn't need to be **double-buffered across OPFS and disk at
  once** — i.e. a "save to disk" download shouldn't require holding a full
  copy in the OPFS-backed `iroh-blobs` store AND a full copy at the final
  disk destination simultaneously (2x disk space for the duration of a
  large download). see section 7's dedicated treatment of this — it's a
  distinct requirement from "don't buffer in RAM" and needs its own design
  answer (e.g. can chunks be written to the disk destination directly as
  they're verified, without first landing durably in the OPFS store at
  all, for the "download straight to disk" use case specifically — as
  opposed to "download to keep in the app," which legitimately does want
  an OPFS copy).

### 6.3 tests over live repros — mirror reliquary's testing conventions

> "i'd rather have tests to repro (and test!) this. the reliquary should
> be, hopefully, mostly the same impl as the tauri app."

interpretation: rather than chasing more live browser-console repros
(as rounds 1+2 did), prefer writing real automated tests that reproduce
the bug/requirement and stay green once fixed — the same discipline
already used elsewhere in this codebase this session (e.g.
`reliquary/src/blobz.rs`'s `register_path()` tests, added alongside its
streaming rewrite in item 7, using `tempfile`-backed `tokio::test`s with
zero real browser/OPFS dependency).

concrete implications for the OPFS-store work specifically:

- **structure the new store's core logic to be testable via plain
  `cargo test`, not just `wasm-pack test --headless` / real-browser e2e.**
  this is not just a nice-to-have — it's exactly the pattern the _upstream_
  `iroh-blobs` crate itself already follows: confirmed in the local
  checkout (`iroh-blobs/src/store/mem.rs` line ~758) that `MemStore`'s
  actor code is gated `#[cfg(wasm_browser)]`/`#[cfg(not(wasm_browser))]`
  only around the few commands that generically can't work in a browser
  (e.g. `import_path`, since there's no native filesystem path in a
  browser) — the actor's core command-handling logic is the _same_ code
  for native and `wasm_browser` targets, and (per that crate's own CI —
  `.github/workflows/ci.yaml` has a dedicated "Build & test wasm32" job
  plus presumably native test jobs) is tested both ways upstream.
- concretely: design the OPFS-backed store as **a thin OPFS-specific
  adapter (real `FileSystemSyncAccessHandle` calls) sitting behind a small,
  swappable byte-storage interface**, so the actor/protocol-handling logic
  (the 23-command dispatch loop, the partial-vs-complete state machine,
  tag/GC bookkeeping) can be unit-tested natively against a fake/in-memory
  or `tempfile`-backed implementation of that interface (mirroring
  `reliquary::blobz::Store`'s own `tempfile::tempdir()`-based test
  conventions almost exactly) — reserving real `wasm-pack test`/Playwright
  e2e coverage for (a) the thin OPFS adapter itself and (b) true two-peer
  P2P integration tests that can't be faked away.
- **reliquary as the reference implementation to mirror**: the user's
  framing ("reliquary should be, hopefully, mostly the same impl as the
  tauri app") means: reliquary's `blobz::Store` (real native filesystem,
  streaming via `tokio::fs::File` + fixed-size buffer loop, see item 7's
  already-shipped `register_path()`) and the new OPFS store should end up
  conceptually parallel — same state-machine shape, same
  streaming-chunk-loop discipline, same "test the core logic
  natively, keep the platform-specific I/O adapter thin" structure — even
  though the underlying storage primitive (native file vs.
  `FileSystemSyncAccessHandle`) is necessarily different. this is also
  opfs-blob-store-design.md's own framing (`fs.rs`'s `entry_state.rs`
  state-machine as the conceptual reference, `mem.rs` as the actual
  porting template due to the single-thread/no-real-threads constraint) —
  the two are consistent, restated here for the fable-5 handoff.
- add regression tests for the two confirmed bugs in section 1 (the
  double-progress retry, the writable-not-aborted-on-failure bug) if they
  don't already exist as tests — worth checking `src/widgets/file-utils.test.ts`
  and `widgets/file.ts`'s test coverage (if any) for `handleSnatchToDisk`
  before assuming these need new tests written from scratch.

### 6.4 iroh-blobs has been checked out locally into the workspace — use it as the implementation base

> "yes, i've checked out the iroh-blobs git repo and added to the
> workspace. we can use that in skein to build that out, if it works out
> well, i'd be interested in pushing a PR back to iroh-blobs, but that's
> in the distant future once this is actually working."

confirmed present at `/Users/edward/src/github/n0-computer/iroh-blobs`
(now a top-level folder in this multi-root workspace, alongside
`playlistz`, `tomb`, `skein`).

key facts about this checkout, confirmed this session:

- **version: 0.103.0** (`Cargo.toml`'s `[package].version`). this matches
  the cargo-workspace-root pin used by `reliquary`/`tauri`
  (`iroh-blobs = "0.103.0"`) — **it does NOT match `midden/Cargo.toml`'s
  pin** (`iroh-blobs = { version = "0.99", default-features = false }`,
  with `iroh = "0.97"` vs. this checkout's `iroh = "1.0.0"`). this version
  gap needs a decision before/during phase C: either upgrade midden's
  pins to 0.103.0 to match (aligning tauri, reliquary, and midden on one
  version, probably desirable regardless of the OPFS work, but its own
  chunk of upgrade risk/testing) or build the new store against 0.99
  semantics and defer the version bump. opfs-blob-store-design.md's
  section "versions confirmed" already checked the specific
  `Store::from_sender` `pub(crate)` finding against all three of
  0.99.0/0.100.0/0.103.0 and found it identical — so at least _that_
  specific finding doesn't block picking either version.
- **already has real wasm32 support upstream**: `build.rs` defines
  `wasm_browser` as a cfg alias for `all(target_family = "wasm",
target_os = "unknown")`; `src/store/mem.rs` and `src/store/util.rs`
  already gate a handful of commands behind `#[cfg(wasm_browser)]` /
  `#[cfg(not(wasm_browser))]` (see section 6.3 above); `.cargo/config.toml`
  has a `[target.wasm32-unknown-unknown]` section; CI
  (`.github/workflows/ci.yaml`) has a dedicated "Build & test wasm32" job.
  this means `MemStore` (the thing midden currently uses) is _already_
  upstream's own officially-supported browser-compatible store — the gap
  this whole plan is closing is specifically "swap `MemStore` (RAM) for a
  new OPFS-backed store," not "make iroh-blobs work in a browser at all"
  (that part is already solved upstream).
- **intended use**: build the new OPFS store directly against/inside this
  checkout initially (or a fork of it, TBD at implementation time — the
  user's framing suggests working IN skein first, i.e. probably as a
  patched/vendored dependency or a path-dependency override pointing at
  this checkout, rather than immediately forking on GitHub) so real
  experimentation against the actual crate internals (not just reading
  cached registry sources, as opfs-blob-store-design.md's research pass
  did) is possible.
- **upstreaming is explicitly out of scope for now**: "that's in the
  distant future once this is actually working" — don't spend effort on
  PR-readiness (rebasing cleanly, upstream's own contribution guidelines,
  etc.) until the OPFS store is working end-to-end in skein first. the
  `Store::from_sender` visibility question (opfs-blob-store-design.md
  section 5) is worth keeping in mind for that eventual PR, but is not a
  near-term task.

## 7. explicit requirements checklist (derived from section 6, for the fable-5 handoff)

restating section 6.2's scope as a flat checklist, since this is the
actual definition of "done" for this whole effort:

- [ ] **resumable uploads**: an interrupted browser-mode import/upload can
      resume from where it left off (not restart from byte 0), across a
      page reload.
- [ ] **resumable downloads**: an interrupted browser-mode P2P download
      can resume from where it left off, across a page reload — this is
      iroh-blobs' own existing partial-download/resume mechanism (already
      used today per `ensure_blob`'s doc comments), the OPFS store needs to
      preserve/expose it rather than losing partial state on reload the
      way pure-RAM `MemStore` does today.
- [ ] **true end-to-end chunk streaming, both directions**: no point in
      the full pipeline — JS `File` → import → store → (network transfer)
      → store → export → JS bytes/disk — ever holds a complete copy of a
      large file in one contiguous buffer, in either RAM (JS heap or WASM
      linear memory) at any single point in time.
- [ ] **pause/resume without 2x disk space**: a browser can chunk-stream
      (and pause/resume) a large download without needing double the disk
      space it would take to just store the finished file once — i.e. the
      OPFS-store copy and any "save to disk" copy should not both need to
      exist in full simultaneously for the straightforward "download this
      file to disk" use case.
- [ ] **works for both directions and both peer-type combinations**:
      browser-to-browser (the primary target per section 6.2) and,
      pending the tauri-as-downloader investigation flagged in section
      6.2, tauri-to-browser / browser-to-tauri as well.
- [ ] **testable natively** (section 6.3): the core store/protocol logic
      has real `cargo test` coverage, not only manual/e2e verification.
- [ ] **runs off the main thread** (section 6.1): `MiddenNode` moves into
      a dedicated Worker so large-file transfer work doesn't block UI
      rendering.

## 8. related files

- [narthex-widgets-and-file-transfer-plan.md](narthex-widgets-and-file-transfer-plan.md)
  — item 7 (tauri upload streaming, done) and item 8 (this bug's rounds 1+2
  fix attempts, both landed but insufficient — this doc supersedes item
  8's "done" status as the real fix path going forward).
- [opfs-blob-store-design.md](opfs-blob-store-design.md) — the deep-dive
  research this plan builds on for phase C. **read this in full first.**
- `/Users/edward/src/github/n0-computer/iroh-blobs` — the local checkout
  (v0.103.0) to build the new store against/inside (section 6.4). a
  workspace root alongside `skein`, not a subfolder of it.
- `midden/src/lib.rs` — `MiddenNode`, `MemStore` construction (~line 520),
  `import_blob`/`active_tags` (~line 1272), `download_verified_with_progress`
  (~line 965), `download_verified_with_ensure_progress` (~line 1107).
  `midden/Cargo.toml` — current `iroh`/`iroh-blobs` pins (0.97/0.99,
  vs. the checkout's 1.0.0/0.103.0 — section 6.4).
- `src/storage/skein-blob-store.ts` — `storeBlobFromFile()` (~line 241),
  the browser-mode local OPFS blob cache (separate system from midden's
  P2P store, see section 2.1's clarification).
- `src/workers/blob-worker.ts` / `blob-worker-client.ts` — existing OPFS
  chunked-write machinery for the local cache; the closest existing
  precedent for phase B and (as a reference, not a direct reuse target)
  the Worker-migration/OPFS-adapter work.
- `src/widgets/file-utils.ts` — `downloadBlobBytesFromPeer()`,
  `snatchBlobToDisk()`, the 3-strategy download cascade fixed in rounds 1+2.
- `widgets/file.ts` — `handleSnatchToDisk()`, the `writable.abort()` fix
  from round 2.
- `reliquary/src/blobz.rs` — `register_path()`, the reference streaming
  implementation (native fs, already shipped) that section 6.3 says the
  new OPFS store should mirror in spirit (state-machine shape, streaming
  chunk-loop discipline, native-testable core logic).
- `tauri/src/commands.rs` — `blob_get_path`/`blob_iroh_ensure` (serving
  side, confirmed no dedicated download-from-peer dispatch exists —
  section 6.2's flagged open investigation for tauri-as-downloader).
