// lightweight logger with level + tag filtering.
// level order: trace < debug < info < warn < error
//
// build-time config (vite env vars):
//   VITE_LOG_LEVEL  - "trace" | "debug" | "info" | "warn" | "error"
//                     default: "debug" in dev, "warn" in prod
//   VITE_LOG_FILTER - comma-separated tag prefixes, e.g. "p2p,audio"  (default: all tags)
//
// runtime override via devtools (no rebuild needed):
//   localStorage.logLevel = "trace";
//   localStorage.logFilter = "automerge.repo,idb.docindex";
//   location.reload();
//
// trace is off by default even in dev - enable it explicitly when needed.
// it's useful for detailed call-by-call tracing of services without adding
// noise to normal debug output.
//
// tags use dotted namespaces, e.g. "p2p.transfer", "audio.player", "idb.service".
// filter prefix matching: "p2p" matches "p2p", "p2p.transfer", "p2p.knock", etc.
//
// usage:
//   import { log } from "../utils/log.js";
//   log.warn("share.panel", "could not build share link:", err);
//   log.debug("playlist.sync", "syncPlaylists #", syncId, "entries:", entries.length);
//   log.trace("automerge.repo", "findPlaylistDoc call #", n, docId);

type LogLevel = "trace" | "debug" | "info" | "warn" | "error";

const LEVEL_NUM: Record<LogLevel, number> = {
  trace: -1,
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

function resolveLevel(): number {
  const override =
    typeof localStorage !== "undefined" && typeof localStorage.getItem === "function"
      ? (localStorage.getItem("logLevel") as LogLevel | null)
      : null;
  // VITE_LOG_LEVEL is injected at build time; fall back to debug in dev, warn in prod
  const env = import.meta.env.VITE_LOG_LEVEL as LogLevel | undefined;
  // trace is never on by default - must be explicitly requested
  const raw = override ?? env ?? (import.meta.env.DEV ? "debug" : "warn");
  return LEVEL_NUM[raw as LogLevel] ?? LEVEL_NUM.warn;
}

function resolveFilter(): string[] {
  const override =
    typeof localStorage !== "undefined" && typeof localStorage.getItem === "function"
      ? localStorage.getItem("logFilter")
      : null;
  const env = import.meta.env.VITE_LOG_FILTER as string | undefined;
  const raw = override ?? env ?? "";
  return raw
    ? raw
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean)
    : [];
}

function allowed(tag: string): boolean {
  const filter = resolveFilter();
  if (filter.length === 0) return true;
  return filter.some((prefix) => tag === prefix || tag.startsWith(prefix + "."));
}

function emit(level: LogLevel, tag: string, msg: string, ...args: unknown[]): void {
  if (LEVEL_NUM[level] < resolveLevel()) return;
  if (!allowed(tag)) return;
  const prefix = `[${tag}]`;
  if (level === "error") console.error(prefix, msg, ...args);
  else if (level === "warn") console.warn(prefix, msg, ...args);
  // eslint-disable-next-line no-console -- this IS the logger implementation
  else console.log(prefix, msg, ...args);
}

export const log = {
  trace: (tag: string, msg: string, ...args: unknown[]): void => emit("trace", tag, msg, ...args),
  debug: (tag: string, msg: string, ...args: unknown[]): void => emit("debug", tag, msg, ...args),
  info: (tag: string, msg: string, ...args: unknown[]): void => emit("info", tag, msg, ...args),
  warn: (tag: string, msg: string, ...args: unknown[]): void => emit("warn", tag, msg, ...args),
  error: (tag: string, msg: string, ...args: unknown[]): void => emit("error", tag, msg, ...args),
};
