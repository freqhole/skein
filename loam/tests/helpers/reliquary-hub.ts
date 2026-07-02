import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, rmSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

// ---------------------------------------------------------------------------
// spawns a real `reliquary serve` process for e2e tests against the actual
// hub-peer binary (as opposed to browser-to-browser p2p, which is all the
// existing p2p fixtures cover).
//
// readiness detection: we scan the child's stdout for the
// `"iroh router started"` tracing line (see reliquary/src/hub/mod.rs,
// logged right after `Router::builder(...).accept(...).spawn()` returns).
// this was chosen over polling for the `reliquary-identity.key` file because
// the key file is written *before* the iroh router is registered — a test
// that dials the hub as soon as the key file appears can race the ALPN
// handler registration and get a connection refusal. the "reliquary
// starting" line (logged even earlier, right after the keypair loads) has
// the same problem. waiting for the router-started line guarantees the
// automerge-repo/friendz/blob-proxy ALPN handlers are all live before we
// report the hub as ready.
//
// the node id is parsed from the earlier "reliquary starting" log line
// (which includes `node_id=...`) rather than shelling out to a separate
// `reliquary node-id` invocation — one less process spawn per test, and the
// log line is already guaranteed to appear before the router-ready line we
// wait for anyway.
// ---------------------------------------------------------------------------

const HERE = dirname(fileURLToPath(import.meta.url));

/** path to the compiled reliquary binary, `target/debug/reliquary` at the skein workspace root. */
const RELIQUARY_BIN =
  process.env.RELIQUARY_BIN ?? join(HERE, "../../../target/debug/reliquary");

const READY_LOG_MARKER = "iroh router started";
const NODE_ID_LOG_PATTERN = /reliquary starting.*node_id=([0-9a-f]{64})/;

/**
 * strip ANSI escape codes from a chunk of process output.
 *
 * `tracing_subscriber::fmt()` colorizes its output unconditionally (it
 * doesn't fall back to plain text just because stdout is a pipe rather
 * than a tty), which splits field names from their values with escape
 * sequences -- e.g. `node_id` and `=` and the value each get their own
 * color codes. without stripping these first, a plain substring/regex
 * match against the raw chunk misses matches it should find.
 */
function stripAnsi(text: string): string {
  return text.replace(/\x1b\[[0-9;]*m/g, "");
}

const DEFAULT_READY_TIMEOUT_MS = 30_000;

export interface ReliquaryHubHandle {
  /** this hub's iroh node id (hex public key), parsed from the startup log. */
  nodeId: string;
  /** the temp data dir this instance owns (keypair, sqlite dbs, blob store). */
  dataDir: string;
  /**
   * pre-approve a peer so the hub auto-accepts an inbound friend request
   * from them (`reliquary friend allow <node_id>`). safe to call before or
   * after the hub process has started, since it runs as its own short-lived
   * `reliquary` invocation against the same data dir (sqlite handles
   * concurrent access from a second short-lived process fine).
   *
   * deliberately kept CLI-based rather than switched over to the real
   * remote `iroh/skein-hub-admin/1` protocol (`hubAdminRequest` on
   * `SkeinP2PBridge`, see `src/dev/test-bridge.ts`), even though that
   * protocol now has solid e2e mileage of its own
   * (`tests/hub-admin.spec.ts`, both the admin-success and
   * non-admin-rejected paths). reasoning, reconsidered explicitly for this
   * task rather than just carried over from an earlier note:
   *
   * - every current call site (`reliquary-hub.spec.ts`, `blob-sync.spec.ts`,
   *   `friendz-hub.spec.ts`) has exactly one browser peer in scope at the
   *   point it calls `friendAllow(peer.nodeId)` — that peer is the one
   *   being granted friend status, and none of these tests are *about* the
   *   admin protocol. making this real would mean spinning up a second
   *   "admin" peer in each of them (bootstrapped via `adminAllow()`'s CLI
   *   call anyway, since the protocol has no self-service way to grant
   *   admin rights), purely to relay a call that itself still bottoms out
   *   in the same `reliquary admin allow` CLI invocation one layer up. that
   *   doesn't remove any CLI dependency, it just adds an extra live
   *   iroh dial + CBOR round trip (with its own relay-discovery-lag retry
   *   needs, see `hubAdminRequestWithRetry` in hub-admin.spec.ts) on the
   *   critical path of three otherwise-simple connectivity/protocol smoke
   *   tests, for a proof that already exists elsewhere.
   * - test-overlap cost: `hub-admin.spec.ts` already covers "an admin's
   *   remote allow request mutates friendz and the newly-allowed peer can
   *   then sync" end to end. re-exercising that same wire path inside
   *   every consumer test doesn't add coverage, it adds a second place a
   *   flake in the admin protocol can surface, making it harder to tell
   *   "friendAllow's bootstrap broke" from "the thing under test broke".
   * - CLI-based setup is a legitimate, common test-shortcut pattern (same
   *   category as e.g. directly seeding a database row instead of going
   *   through a full API call to set up fixture state) as long as the
   *   thing it's shortcutting is independently verified elsewhere — which
   *   it now is.
   *
   * if `friendAllow` itself ever needs to prove the real protocol (as
   * opposed to `hub-admin.spec.ts` proving the protocol exists and works),
   * revisit this — but that's a distinct goal from "make existing
   * connectivity/sync/blob tests pass reliably", which is what this helper
   * is for.
   */
  friendAllow: (peerNodeId: string) => Promise<void>;
  /**
   * grant a peer admin rights over this hub's friendz allow-list
   * (`reliquary admin allow <node_id>`), so that peer can subsequently call
   * the real remote `iroh/skein-hub-admin/1` protocol (see
   * `SkeinP2PBridge.hubAdminRequest` in `src/dev/test-bridge.ts`) to manage
   * friendz over the network instead of via local CLI. this bootstrapping
   * step itself is still done locally/operator-side (mirroring how a real
   * operator would grant admin rights) — the protocol has no way for a
   * remote caller to grant themselves (or anyone else) admin rights, only
   * to act as one once already granted.
   */
  adminAllow: (peerNodeId: string) => Promise<void>;
  /**
   * the hub's accumulated stdout/stderr for its entire lifetime (ANSI
   * stripped), useful for debugging why an expected background operation
   * (e.g. a blob snatch) didn't happen.
   */
  getLog: () => string;
  /** kill the child process and remove the temp data dir. */
  stop: () => Promise<void>;
}

/**
 * spawn a `reliquary serve` process against a fresh temp data dir with an
 * ephemeral iroh port, and wait for it to be ready to accept connections.
 */
export async function startReliquaryHub(options?: {
  readyTimeoutMs?: number;
}): Promise<ReliquaryHubHandle> {
  if (!existsSync(RELIQUARY_BIN)) {
    throw new Error(
      `reliquary binary not found at ${RELIQUARY_BIN} — build it first with ` +
        `"cargo build -p reliquary" from the skein workspace root (or set RELIQUARY_BIN).`
    );
  }

  const dataDir = await mkdtemp(join(tmpdir(), `reliquary-hub-${randomUUID()}-`));
  const readyTimeoutMs = options?.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS;

  const child = spawn(RELIQUARY_BIN, ["--data-dir", dataDir, "--port", "0", "serve"], {
    env: { ...process.env, RUST_LOG: "reliquary=debug" },
    stdio: ["ignore", "pipe", "pipe"],
  });

  let nodeId: string | null = null;
  let output = "";

  // accumulate stdout/stderr for the process's entire lifetime (not just
  // until ready) so callers can inspect what the hub did afterward (e.g.
  // whether the blob snatcher ever fired) — the readiness promise below
  // only decides *when* to resolve/reject, it doesn't own log collection.
  const onOutput = (chunk: Buffer) => {
    output += stripAnsi(chunk.toString());
    if (!nodeId) {
      const match = output.match(NODE_ID_LOG_PATTERN);
      if (match) {
        nodeId = match[1];
      }
    }
  };
  child.stdout.on("data", onOutput);
  child.stderr.on("data", onOutput);

  const ready = new Promise<void>((resolve, reject) => {
    const checkReady = () => {
      if (output.includes(READY_LOG_MARKER)) {
        cleanup();
        resolve();
      }
    };

    const onExit = (code: number | null) => {
      cleanup();
      reject(
        new Error(
          `reliquary serve exited before becoming ready (code=${code}). output:\n${output}`
        )
      );
    };

    const timer = setTimeout(() => {
      cleanup();
      reject(
        new Error(
          `reliquary serve did not become ready within ${readyTimeoutMs}ms. output:\n${output}`
        )
      );
    }, readyTimeoutMs);

    const cleanup = () => {
      clearTimeout(timer);
      child.stdout.off("data", checkReady);
      child.stderr.off("data", checkReady);
      child.off("exit", onExit);
    };

    child.stdout.on("data", checkReady);
    child.stderr.on("data", checkReady);
    child.on("exit", onExit);
  });

  try {
    await ready;
  } catch (err) {
    await killChild(child);
    rmSync(dataDir, { recursive: true, force: true });
    throw err;
  }

  if (!nodeId) {
    await killChild(child);
    rmSync(dataDir, { recursive: true, force: true });
    throw new Error(`reliquary serve became ready but no node_id was parsed from its log:\n${output}`);
  }

  const resolvedNodeId: string = nodeId;

  let stopped = false;

  const stop = async () => {
    if (stopped) return;
    stopped = true;
    await killChild(child);
    rmSync(dataDir, { recursive: true, force: true });
  };

  const friendAllow = async (peerNodeId: string): Promise<void> => {
    await runReliquary(["--data-dir", dataDir, "friend", "allow", peerNodeId]);
  };

  const adminAllow = async (peerNodeId: string): Promise<void> => {
    await runReliquary(["--data-dir", dataDir, "admin", "allow", peerNodeId]);
  };

  return {
    nodeId: resolvedNodeId,
    dataDir,
    friendAllow,
    adminAllow,
    getLog: () => output,
    stop,
  };
}

/** run a one-off `reliquary <args>` invocation and wait for it to exit, rejecting on non-zero exit. */
function runReliquary(args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(RELIQUARY_BIN, args, {
      env: { ...process.env, RUST_LOG: "info" },
      stdio: ["ignore", "pipe", "pipe"],
    });

    let output = "";
    child.stdout.on("data", (chunk: Buffer) => (output += chunk.toString()));
    child.stderr.on("data", (chunk: Buffer) => (output += chunk.toString()));

    child.on("exit", (code) => {
      if (code === 0) {
        resolve(output);
      } else {
        reject(new Error(`reliquary ${args.join(" ")} exited with code ${code}:\n${output}`));
      }
    });
    child.on("error", reject);
  });
}

/** kill a child process and wait for it to actually exit (or a short grace period). */
function killChild(child: ChildProcessWithoutNullStreams): Promise<void> {
  return new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      resolve();
      return;
    }
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      resolve();
    }, 3_000);
    child.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
    child.kill("SIGTERM");
  });
}
