import { getMetaValue, setMetaValue } from "../storage/meta-db";

const ANON_DEVICE_ID_KEY = "skein-anon-device-id";

/**
 * get (or create and persist) a stable per-installation id used as the
 * local node id for canvases created before this browser has a real p2p
 * identity.
 *
 * unlike a p2p identity's node id (a 64-character key derived from a
 * generated keypair, only created on demand for actual peer-to-peer
 * sharing — see `p2p/identity.ts`'s `getStoredIdentity()`/`ensureIdentity()`),
 * this is just a random uuid, persisted in the same indexeddb-backed meta
 * store as the narthex doc id (see `storage/meta-db.ts`). it stays stable
 * across reloads for as long as this browser profile's local storage
 * survives, so an anonymous user keeps admin access to their own,
 * purely-local canvases (every canvas needs exactly one recorded admin —
 * see `canvas/canvas-store.ts`'s `stampAdmin()`) even before they ever
 * generate a real identity.
 */
export async function getOrCreateAnonDeviceId(): Promise<string> {
  const existing = await getMetaValue(ANON_DEVICE_ID_KEY);
  if (existing) return existing;
  const id = crypto.randomUUID();
  await setMetaValue(ANON_DEVICE_ID_KEY, id);
  return id;
}
