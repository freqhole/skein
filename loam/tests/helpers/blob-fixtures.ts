import { randomBytes as nodeRandomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// ---------------------------------------------------------------------------
// shared test content for blob-transfer / iroh-blobs e2e coverage.
//
// every blob-related e2e test used to import a tiny `TextEncoder().encode()`
// ascii marker string (e.g. "blob-sync-spec 12345", ~20-30 bytes) as its
// test content. that's enough to prove a hash/transfer round-trips *a*
// value, but it never exercises the actual chunked/BAO-tree verified
// transfer iroh-blobs does for anything past its first chunk group (16KiB
// by default) — every real file a user ever uploads (images, audio
// recordings, arbitrary files) is orders of magnitude bigger than a short
// sentence, so a bug that only shows up past the first chunk (a bad
// chunk-range request, a truncated multi-round download, an off-by-one in
// how `snatch.rs` or `midden`'s BAO export handles the tail chunk, etc.)
// would never be caught by the old marker-string tests.
//
// two flavors of content, matching the two things worth proving:
// - `randomBlobBytes(sizeBytes)`: deterministic-but-realistic pseudo-random
//   bytes, sized to span multiple BAO chunk groups. deterministic (seeded)
//   so a failing test reproduces the same content every run instead of a
//   fresh random failure each time — see `deterministicBytes()`.
// - `loadFixturePng()`: a real, small (~3.5KB) PNG file already checked
//   into `tests/fixtures/freqhole.png` (previously unused by any test) —
//   for the one test that should prove a genuine file format round-trips
//   correctly, not just arbitrary bytes.
// ---------------------------------------------------------------------------

const HERE = dirname(fileURLToPath(import.meta.url));

/** default size for "exercise real chunked transfer" test content — a few
 *  multiples of iroh-blobs' 16KiB chunk-group size, small enough to keep
 *  e2e runtime reasonable (this still transfers effectively instantly over
 *  loopback iroh/QUIC). */
export const DEFAULT_RANDOM_BLOB_SIZE = 96 * 1024; // 96 KiB

/**
 * deterministic pseudo-random bytes (mulberry32 PRNG, seeded) — reproducible
 * across runs (a failing test always fails on the exact same content,
 * instead of a new random blob every run making failures harder to
 * correlate/reproduce), but realistic enough (non-repeating, no long runs
 * of the same byte) to exercise real chunk/BAO-tree code paths the way
 * genuinely random file content would.
 */
export function deterministicBytes(sizeBytes: number, seed = 0xc0ffee): Uint8Array {
  let state = seed >>> 0;
  const next = (): number => {
    state |= 0;
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };

  const bytes = new Uint8Array(sizeBytes);
  for (let i = 0; i < sizeBytes; i++) {
    bytes[i] = Math.floor(next() * 256);
  }
  return bytes;
}

/** genuinely random bytes (node `crypto.randomBytes`) — used where cross-run
 *  reproducibility doesn't matter as much as being sure there's no
 *  accidental structure a bug could hide behind (e.g. verifying a
 *  byte-for-byte disk write independent of any PRNG's own patterns). */
export function randomBlobBytes(sizeBytes: number = DEFAULT_RANDOM_BLOB_SIZE): Uint8Array {
  return new Uint8Array(nodeRandomBytes(sizeBytes));
}

/** load the real sample PNG fixture (`tests/fixtures/freqhole.png`, a
 *  512x512 RGBA image, ~3.5KB) — for proving an actual file format
 *  round-trips, not just arbitrary/random bytes. */
export function loadFixturePng(): Uint8Array {
  return new Uint8Array(readFileSync(join(HERE, "../fixtures/freqhole.png")));
}

/**
 * convert bytes to a plain `number[]` for passing through
 * `page.evaluate()`'s argument — mirrors the existing convention already
 * used for evaluate *return* values in this test suite (e.g.
 * `blob-acl.spec.ts`'s `fetchBlobWithRetry` returning `Array.from(bytes)`),
 * applied symmetrically to inputs too. plain arrays of numbers serialize
 * through Playwright's evaluate boundary reliably; passing a `Uint8Array`
 * directly is not as consistently supported.
 */
export function toEvaluateArray(bytes: Uint8Array): number[] {
  return Array.from(bytes);
}

/** the inverse of `toEvaluateArray` — reconstruct a `Uint8Array` from a
 *  `number[]` that came back out of a `page.evaluate()` call. */
export function fromEvaluateArray(numbers: number[]): Uint8Array {
  return Uint8Array.from(numbers);
}
