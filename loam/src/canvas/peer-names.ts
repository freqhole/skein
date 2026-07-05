// peer-names — a tiny session-scoped registry mapping node ids to display
// names (friend alias > per-node username > friend username), fed from the
// social doc by boot.ts whenever it changes.
//
// exists so deep widget code (e.g. the file widget's "who has this file"
// property-tray rows) can show human names without threading the social doc
// through every mount context. read-side consumers must always fall back to
// a short node id — the registry only knows about friends this session.

const names = new Map<string, string>();

/** register (or update) a display name for a node id. empty names are ignored. */
export function registerPeerName(nodeId: string, name: string): void {
  if (!nodeId || !name) return;
  names.set(nodeId, name);
}

/** the display name for a node id, or null when unknown. */
export function peerNameFor(nodeId: string): string | null {
  return names.get(nodeId) ?? null;
}

/** clear the registry (identity switch / teardown). */
export function clearPeerNames(): void {
  names.clear();
}
