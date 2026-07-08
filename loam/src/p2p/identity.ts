// ---------------------------------------------------------------------------
// p2p identity management for skein.
//
// manages the iroh keypair used for peer-to-peer connectivity. the identity
// is persisted in the skein-meta IndexedDB store so it survives page reloads.
//
// the midden WASM endpoint is lazily initialized — it only starts when
// something explicitly needs it (sharing a canvas, joining one, or the
// user clicking "generate" in the profile widget).
// ---------------------------------------------------------------------------

import { deleteMetaRecord, getMetaRecord, setMetaRecord } from "../storage/meta-db";
import { checkTauriIdentityStatus, isTauriMode, TauriStreamNode } from "./tauri-transport";
import { MiddenNode } from "@freqhole/midden";
import { WorkerMiddenNode } from "../workers/midden-worker-client";
import { log } from "../utils/log";

// ---------------------------------------------------------------------------
// types
// ---------------------------------------------------------------------------

/** the stored identity shape persisted in IndexedDB. */
export interface P2PIdentity {
  /** 32-byte iroh secret key. */
  secret_key: Uint8Array;
  /** public node_id (iroh public key as string). */
  node_id: string;
  /** unix epoch millis when the identity was first created. */
  created_at: number;
}

/**
 * minimal interface matching the subset of the midden WASM API we rely on.
 * kept local so skein doesn't need a build-time dependency on the full
 * midden type definitions.
 */
export interface MiddenNodeLike {
  node_id(): string;
  secret_key(): Uint8Array;
  // raw stream APIs (added for phase B — P2P sync)
  open_bi?(peer_addr: string, alpn: string): Promise<unknown>;
  accept?(): Promise<unknown>;
}

// ---------------------------------------------------------------------------
// constants
// ---------------------------------------------------------------------------

/** key used to store the identity record in the skein-meta IndexedDB. */
const IDENTITY_KEY = "p2p_identity";

/** console log prefix for this module. */
const TAG = "p2p.identity";

// ---------------------------------------------------------------------------
// module-level singleton state
// ---------------------------------------------------------------------------

let middenNode: MiddenNodeLike | null = null;
let middenNodePromise: Promise<MiddenNodeLike> | null = null;

/**
 * browser mode hosts the node in a dedicated worker by default (required
 * for the OPFS blob store — see docs/midden-worker-design.md). set
 * VITE_MIDDEN_MAIN_THREAD=1 to keep the old in-thread wasm node for
 * debugging.
 */
function useMainThreadNode(): boolean {
  return (import.meta as any).env?.VITE_MIDDEN_MAIN_THREAD === "1";
}

/** create the browser node: worker-hosted by default, in-thread behind the
 *  escape hatch. `secretKey` null means "generate a fresh identity". */
async function createBrowserNode(secretKey: Uint8Array | null): Promise<MiddenNodeLike> {
  if (useMainThreadNode()) {
    log.warn(TAG, "VITE_MIDDEN_MAIN_THREAD=1 — using in-thread midden node");
    return secretKey ? MiddenNode.create_from_key(secretKey) : MiddenNode.create();
  }
  return WorkerMiddenNode.create(secretKey);
}

/** tear down the current node, terminating its worker when applicable. */
function teardownNode(): void {
  if (middenNode instanceof WorkerMiddenNode) {
    middenNode.terminate();
  }
  middenNode = null;
  middenNodePromise = null;
}

// ---------------------------------------------------------------------------
// change subscription
// ---------------------------------------------------------------------------

type IdentityChangeCallback = (identity: P2PIdentity | null) => void;

const changeListeners = new Set<IdentityChangeCallback>();

/** notify all registered listeners of an identity change. */
function notifyListeners(identity: P2PIdentity | null): void {
  for (const cb of changeListeners) {
    try {
      cb(identity);
    } catch (err) {
      log.error(TAG, "identity change listener threw:", err);
    }
  }
}

/**
 * subscribe to identity changes (created or deleted).
 *
 * the callback fires whenever `ensureIdentity` creates a new identity or
 * `deleteIdentity` removes one. returns an unsubscribe function.
 */
export function onIdentityChange(callback: IdentityChangeCallback): () => void {
  changeListeners.add(callback);
  return () => {
    changeListeners.delete(callback);
  };
}

// ---------------------------------------------------------------------------
// read-only access (cheap, no midden startup)
// ---------------------------------------------------------------------------

/**
 * read the stored identity from IndexedDB (browser mode) or check the
 * Rust backend's identity status (tauri mode).
 *
 * returns `null` if no identity has been created yet. this is a cheap,
 * side-effect-free read — it does NOT start the midden WASM endpoint, and
 * in tauri mode it does NOT bind the iroh endpoint or generate a keypair
 * (see `checkTauriIdentityStatus()`) — so it is safe to call on boot (e.g.
 * to display the node_id in a profile widget, or gate identity-dependent
 * UI) without side effects.
 */
export async function getStoredIdentity(): Promise<P2PIdentity | null> {
  if (isTauriMode()) {
    try {
      const nodeId = await checkTauriIdentityStatus();
      if (!nodeId) return null; // no identity yet — deliberately not created here
      return {
        secret_key: new Uint8Array(), // not exposed in tauri mode
        node_id: nodeId,
        created_at: 0,
      };
    } catch {
      return null; // P2P endpoint not ready yet
    }
  }
  return getMetaRecord<P2PIdentity>(IDENTITY_KEY);
}

// ---------------------------------------------------------------------------
// midden singleton (lazy)
// ---------------------------------------------------------------------------

/**
 * get or create the midden node singleton.
 *
 * lazy — the midden WASM module is only imported and the endpoint is only
 * started on the first call. if a persisted identity exists in IndexedDB it
 * is restored; otherwise a fresh keypair is generated, persisted, and the
 * change listeners are notified.
 *
 * concurrent callers share the same in-flight promise so the endpoint is
 * never initialized twice.
 */
export async function getMiddenNode(): Promise<MiddenNodeLike> {
  // in tauri mode, return a TauriStreamNode backed by the rust endpoint
  if (isTauriMode()) {
    if (!middenNode) {
      const tauriNode = await TauriStreamNode.create();
      middenNode = tauriNode as unknown as MiddenNodeLike;
      log.debug(TAG, "using tauri transport, node_id:", tauriNode.node_id().slice(0, 16) + "...");
    }
    return middenNode;
  }

  // fast path: already running
  if (middenNode) {
    return middenNode;
  }

  // dedup: return the in-flight promise if another caller is already
  // initializing the node
  if (middenNodePromise) {
    return middenNodePromise;
  }

  middenNodePromise = (async (): Promise<MiddenNodeLike> => {
    const existing = await getStoredIdentity();

    let node: MiddenNodeLike;

    if (existing) {
      // restore from the persisted secret key
      const truncated = existing.node_id.slice(0, 16) + "...";
      log.debug(TAG, "restoring identity from IndexedDB:", truncated);
      node = await createBrowserNode(existing.secret_key);
    } else {
      // generate a brand-new identity
      node = await createBrowserNode(null);
      const identity: P2PIdentity = {
        secret_key: node.secret_key(),
        node_id: node.node_id(),
        created_at: Date.now(),
      };
      await setMetaRecord<P2PIdentity>(IDENTITY_KEY, identity);

      const truncated = identity.node_id.slice(0, 16) + "...";
      log.debug(TAG, "created new identity:", truncated);

      notifyListeners(identity);
    }

    middenNode = node;
    log.debug(TAG, "node ready, node_id:", node.node_id().slice(0, 16) + "...");
    return node;
  })();

  // if initialization fails, clear the promise so a subsequent call can
  // retry instead of forever returning a rejected promise.
  middenNodePromise.catch(() => {
    middenNodePromise = null;
  });

  return middenNodePromise;
}

// ---------------------------------------------------------------------------
// ensure identity exists
// ---------------------------------------------------------------------------

/**
 * ensure an identity exists, generating one if needed.
 *
 * if a persisted identity is already present (IndexedDB in browser mode,
 * the Rust backend's keypair file in tauri mode) this simply returns it.
 * otherwise it triggers identity generation as a side effect (starting
 * midden in browser mode; binding the Rust iroh endpoint in tauri mode)
 * and returns the new identity. only call this in response to something
 * the user actually asked for (sharing/joining a canvas, starting the hub,
 * clicking "generate identity") — never merely on boot.
 */
export async function ensureIdentity(): Promise<P2PIdentity> {
  // in tauri mode, a cheap status check first avoids binding the iroh
  // endpoint when an identity already exists; `TauriStreamNode.create()`
  // is the actual "ensure" call on the Rust side (generates one if this is
  // genuinely the first time).
  if (isTauriMode()) {
    const identity = await getStoredIdentity();
    if (identity) return identity;
    const node = await TauriStreamNode.create();
    const created: P2PIdentity = {
      secret_key: new Uint8Array(),
      node_id: node.node_id(),
      created_at: 0,
    };
    // notify listeners (e.g. `IrohNetworkAdapter.checkIdentityAndStart()`,
    // which subscribed instead of starting immediately when it found no
    // identity yet) the same way the browser-mode path below does.
    notifyListeners(created);
    return created;
  }

  // cheap check first — avoids starting midden when we already have one
  const existing = await getStoredIdentity();
  if (existing) {
    return existing;
  }

  // no identity yet — starting midden will create and persist one
  await getMiddenNode();

  // the identity was just written by getMiddenNode, read it back
  const created = await getStoredIdentity();
  if (!created) {
    // should be unreachable — getMiddenNode always persists an identity
    throw new Error(TAG + " identity was not persisted after midden init");
  }
  return created;
}

// ---------------------------------------------------------------------------
// identity bundle serialization
// ---------------------------------------------------------------------------

/** convert a Uint8Array to a base64 string. */
function uint8ToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

/** convert a base64 string back to a Uint8Array. */
function base64ToUint8(b64: string): Uint8Array {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

/** the shape of a decoded identity bundle. */
export interface IdentityBundle {
  secretKey: Uint8Array;
  friendNodeIds: string[];
  username?: string;
  bio?: string;
}

/**
 * encode an identity bundle as a compact string.
 * format: "skein1:" + base64(JSON({ sk: base64(secretKey), f: [nodeId, ...] }))
 */
export function encodeIdentityBundle(
  secretKey: Uint8Array,
  friendNodeIds: string[],
  profile?: { username?: string; bio?: string }
): string {
  const payload: Record<string, unknown> = {
    sk: uint8ToBase64(secretKey),
    f: friendNodeIds,
  };
  if (profile?.username) payload.u = profile.username;
  if (profile?.bio) payload.b = profile.bio;
  return "skein1:" + btoa(JSON.stringify(payload));
}

/**
 * decode an identity bundle string back into its components.
 * throws if the format is invalid.
 */
export function decodeIdentityBundle(bundle: string): IdentityBundle {
  if (!bundle.startsWith("skein1:")) {
    throw new Error("invalid identity bundle — expected 'skein1:' prefix");
  }
  const payloadStr = atob(bundle.slice("skein1:".length));
  const payload = JSON.parse(payloadStr);

  if (!payload.sk || typeof payload.sk !== "string") {
    throw new Error("invalid identity bundle — missing secret key");
  }

  return {
    secretKey: base64ToUint8(payload.sk),
    friendNodeIds: Array.isArray(payload.f) ? payload.f : [],
    username: typeof payload.u === "string" ? payload.u : undefined,
    bio: typeof payload.b === "string" ? payload.b : undefined,
  };
}

/**
 * export the current identity and friend list as a compact bundle string.
 * the bundle includes the secret key and all friend node IDs so the user
 * can restore their identity and friend list on another device.
 */
export async function exportIdentityBundle(
  friendNodeIds: string[],
  profile?: { username?: string; bio?: string }
): Promise<string> {
  const identity = await getStoredIdentity();
  if (!identity) throw new Error(TAG + " no identity to export");
  if (!identity.secret_key || identity.secret_key.length === 0) {
    throw new Error(TAG + " secret key not available (tauri mode?)");
  }
  return encodeIdentityBundle(identity.secret_key, friendNodeIds, profile);
}

/**
 * import an identity from a raw secret key. tears down any existing midden
 * node, creates a new one from the provided key, persists the identity, and
 * notifies listeners.
 *
 * returns the full P2PIdentity with the derived node_id.
 */
export async function importIdentity(secretKey: Uint8Array): Promise<P2PIdentity> {
  if (isTauriMode()) {
    throw new Error(TAG + " identity import not supported in tauri mode");
  }

  // tear down existing node (terminates its worker when applicable)
  teardownNode();

  // start a new node from the provided key
  const node = await createBrowserNode(secretKey);

  const identity: P2PIdentity = {
    secret_key: secretKey,
    node_id: node.node_id(),
    created_at: Date.now(),
  };

  await setMetaRecord<P2PIdentity>(IDENTITY_KEY, identity);
  middenNode = node;

  log.debug(TAG, "imported identity:", identity.node_id.slice(0, 16) + "...");
  notifyListeners(identity);

  return identity;
}

/**
 * import an identity from a bundle string (as produced by exportIdentityBundle).
 * restores the secret key and returns the friend node IDs so the caller can
 * re-add them to the social doc.
 */
export async function importIdentityFromBundle(
  bundle: string
): Promise<{ identity: P2PIdentity; friendNodeIds: string[]; username?: string; bio?: string }> {
  const decoded = decodeIdentityBundle(bundle);
  const identity = await importIdentity(decoded.secretKey);
  return {
    identity,
    friendNodeIds: decoded.friendNodeIds,
    username: decoded.username,
    bio: decoded.bio,
  };
}

// ---------------------------------------------------------------------------
// deletion / reset
// ---------------------------------------------------------------------------

/**
 * delete the stored identity and tear down the midden node if running.
 *
 * after this call, `getStoredIdentity()` returns `null` and the midden
 * endpoint is stopped. a subsequent call to `getMiddenNode()` or
 * `ensureIdentity()` will generate a fresh identity.
 */
export async function deleteIdentity(): Promise<void> {
  // tear down the running node if any (terminates its worker)
  teardownNode();

  await deleteMetaRecord(IDENTITY_KEY);

  log.debug(TAG, "identity deleted");
  notifyListeners(null);
}
