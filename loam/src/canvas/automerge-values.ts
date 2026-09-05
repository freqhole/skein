import { isImmutableString } from "@automerge/automerge";
import { log } from "@freqhole/reliquary/utils";
import type { CanvasDocument, CanvasRole } from "./canvas-doc";

const TAG = "skein.automerge-values";
let warnedOnce = false;

/**
 * normalize an automerge scalar-string field to a plain js string.
 *
 * background: a plain js string assigned to an automerge doc field from
 * *this* library (`doc.field = "hello"`) is written as a "text" object,
 * which reads back as a plain js string. but a string written by rust's
 * `automerge` crate via `Transactable::put(obj, key, "hello")` is written
 * as a scalar "str" value — the js proxy layer (`valueAt()` in
 * `@automerge/automerge`) reads *every* scalar "str" back as an
 * `ImmutableString` *instance* (`typeof === "object"`), not a plain
 * string. this is a real, confirmed cross-language interop gap, not a
 * one-off bug: any doc field ever written by tumulus's rust code (peer
 * nodeId/joinedAt/lastSeenAt, acl role, knock requesterNodeId/message/etc)
 * comes back this way, and silently breaks `typeof x === "string"`
 * checks, strict `===`/`!==` comparisons, `array.includes(x)`, and zod
 * `z.string()`/`z.enum()` validation against it — each of those treats
 * the value as "not a string" even though `String(x)`/`x.toString()`
 * gives the right content. use this helper (or `unwrapAmStringArray`
 * below) at every read site for a field rust code might have written,
 * rather than a bare `typeof`/`===` check.
 */
export function unwrapAmString(value: unknown): string {
  if (typeof value === "string") return value;
  if (isImmutableString(value)) {
    // log once per session, not once per call — this is expected to fire
    // constantly (every rust-written field, every read) once a canvas has
    // any hub-authored peer/acl/knock entry, so a per-call log would just
    // be noise. this first hit is enough to confirm the coercion is live.
    if (!warnedOnce) {
      warnedOnce = true;
      log.debug(
        TAG,
        "coerced an ImmutableString (rust-authored automerge field) to a plain string:",
        value.toString()
      );
    }
    return value.toString();
  }
  return String(value ?? "");
}

/** same as `unwrapAmString`, but for an array of automerge string values
 *  (e.g. `hubNodeIds`) — see `unwrapAmString`'s doc comment for why this
 *  is needed for anything a rust writer might have populated. */
export function unwrapAmStringArray(values: readonly unknown[] | undefined): string[] {
  return (values ?? []).map(unwrapAmString);
}

/**
 * recursively walk an arbitrary value (typically a whole automerge doc, or
 * a subtree of one) and coerce every `ImmutableString` instance found —
 * at any depth, in plain objects and arrays alike — into a plain js
 * string. see `unwrapAmString`'s doc comment for the underlying
 * cross-language interop gap this works around.
 *
 * unlike `normalizeCanvasDoc` (which only touches the specific
 * `peers`/`acl`/`pendingKnocks` subtrees of a `CanvasDocument`), this is
 * shape-agnostic — safe to run over any widget doc, including ones this
 * module has no static type for (see `widget-doc.ts`'s `createWidgetDoc`,
 * which every widget's per-widget document goes through and which a rust
 * hub can write into directly, e.g. stamping `snatchedBy` after a P2P
 * snatch).
 */
export function deepUnwrapAmStrings<T>(value: T): T {
  if (isImmutableString(value)) {
    return (value as { toString(): string }).toString() as unknown as T;
  }
  if (Array.isArray(value)) {
    return value.map((item) => deepUnwrapAmStrings(item)) as unknown as T;
  }
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      out[key] = deepUnwrapAmStrings(entry);
    }
    return out as T;
  }
  return value;
}

/** true if `value` (typically a whole automerge doc) contains an
 *  `ImmutableString` instance anywhere, at any depth — lets a caller skip
 *  writing back an unaffected doc entirely (e.g. `fix-immutable-strings.ts`'s
 *  one-shot migration, which should be a no-op for a doc no rust writer has
 *  ever touched). short-circuits on the first hit. */
export function containsImmutableString(value: unknown): boolean {
  if (isImmutableString(value)) return true;
  if (Array.isArray(value)) return value.some(containsImmutableString);
  if (value && typeof value === "object") {
    return Object.values(value as Record<string, unknown>).some(containsImmutableString);
  }
  return false;
}

/**
 * normalize the subtrees of a `CanvasDocument` that tumulus's rust code is
 * known to write into directly: `peers`, `acl[x].role`, and `pendingKnocks`
 * (including each knock's `decisions` log). see `unwrapAmString`'s doc
 * comment for why this is necessary — without it, e.g. `getRole()`/the
 * share dialog's peer list/knock approval-outcome checks silently treat a
 * hub-authored value as missing/invalid.
 *
 * called from `CanvasStore.doc()`, so every reader (including ones that
 * read `store.doc().pendingKnocks`/`.acl` directly, bypassing
 * `CanvasStore`'s own getters) gets normalized data for free. only
 * shallow-copies the touched subtrees (`peers`/`acl`/`pendingKnocks`) —
 * `widgets` and everything else is returned by reference, so this stays
 * cheap even though `doc()` is called very frequently.
 */
export function normalizeCanvasDoc(doc: CanvasDocument): CanvasDocument {
  if (!doc.peers && !doc.acl && !doc.pendingKnocks) return doc;

  const normalized: CanvasDocument = { ...doc };

  if (doc.peers) {
    const peers: CanvasDocument["peers"] = {};
    for (const [key, peer] of Object.entries(doc.peers)) {
      peers[key] = {
        nodeId: unwrapAmString(peer.nodeId),
        joinedAt: unwrapAmString(peer.joinedAt),
        ...(peer.lastSeenAt !== undefined && { lastSeenAt: unwrapAmString(peer.lastSeenAt) }),
      };
    }
    normalized.peers = peers;
  }

  if (doc.acl) {
    const acl: NonNullable<CanvasDocument["acl"]> = {};
    for (const [key, entry] of Object.entries(doc.acl)) {
      acl[key] = { role: unwrapAmString(entry.role) as CanvasRole };
    }
    normalized.acl = acl;
  }

  if (doc.pendingKnocks) {
    const pendingKnocks: NonNullable<CanvasDocument["pendingKnocks"]> = {};
    for (const [key, knock] of Object.entries(doc.pendingKnocks)) {
      pendingKnocks[key] = {
        ...knock,
        knockId: unwrapAmString(knock.knockId),
        requesterNodeId: unwrapAmString(knock.requesterNodeId),
        requesterUsername: unwrapAmString(knock.requesterUsername),
        message: unwrapAmString(knock.message),
        knockedAt: unwrapAmString(knock.knockedAt),
        decisions: (knock.decisions ?? []).map((d) => ({
          ...d,
          byNodeId: unwrapAmString(d.byNodeId),
          decision: unwrapAmString(d.decision) as typeof d.decision,
          at: unwrapAmString(d.at),
        })),
      };
    }
    normalized.pendingKnocks = pendingKnocks;
  }

  return normalized;
}
