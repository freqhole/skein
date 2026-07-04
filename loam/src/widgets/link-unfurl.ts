/**
 * shared "unfurl" support for the link widget — fetches a URL and pulls a
 * small opengraph-ish summary (title, description, preview image) out of
 * its HTML.
 *
 * `parseHtmlMeta()` is a plain, dependency-free HTML meta-tag scanner (not
 * a full parser — just enough to find `<title>` and a handful of
 * well-known `<meta>` tags, tolerant of attribute-order variation). it's
 * used both by the browser-mode fetch path here AND as the reference
 * implementation for what the tauri-side rust extraction
 * (`skein/tauri/src/commands.rs`'s `extract_link_meta`) should produce —
 * keep the two in sync if either changes.
 *
 * `fetchUnfurl()` branches on `isTauriMode()`: in tauri, the fetch happens
 * rust-side (no CORS wall) via the `link_unfurl` dispatch action. in the
 * browser, a plain `fetch(url)` is attempted — this fails for the vast
 * majority of third-party sites (no `Access-Control-Allow-Origin`), which
 * is an accepted, documented v1 limitation, not a bug: callers should
 * catch the rejection and show a "needs the desktop app" hint rather than
 * treating it as an error to fix.
 */

import { dispatch, isTauriMode } from "../p2p/tauri-transport";

export interface UnfurlResult {
  title: string;
  description: string;
  imageUrl: string;
}

const EMPTY_RESULT: UnfurlResult = { title: "", description: "", imageUrl: "" };

/**
 * decode the small set of HTML entities likely to show up in a title or
 * meta description. `&amp;` is decoded last so `&amp;lt;` round-trips to
 * `&lt;` rather than being double-unescaped into `<`.
 */
function decodeEntities(value: string): string {
  return value
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&")
    .trim();
}

/** find the byte index of the `>` that closes a tag opened at `start`, honoring quoted attribute values. */
function findTagClose(html: string, start: number): number {
  let inQuote: string | null = null;
  for (let i = start; i < html.length; i++) {
    const ch = html[i];
    if (inQuote) {
      if (ch === inQuote) inQuote = null;
    } else if (ch === '"' || ch === "'") {
      inQuote = ch;
    } else if (ch === ">") {
      return i;
    }
  }
  return -1;
}

/** find every `<tagLower ...>` slice (opening tag only, including `<` and `>`) in `html`. */
function findTagSlices(html: string, tagLower: string): string[] {
  const slices: string[] = [];
  const lower = html.toLowerCase();
  const needle = `<${tagLower}`;
  let from = 0;
  while (true) {
    const idx = lower.indexOf(needle, from);
    if (idx === -1) break;
    const after = idx + needle.length;
    const boundary = lower[after];
    // require a real tag boundary after the name (whitespace, self-close, or end)
    // so "<metabolic" doesn't get mistaken for a "<meta" tag.
    if (boundary !== undefined && !/[\s/>]/.test(boundary)) {
      from = after;
      continue;
    }
    const closeIdx = findTagClose(html, idx);
    if (closeIdx === -1) break;
    slices.push(html.slice(idx, closeIdx + 1));
    from = closeIdx + 1;
  }
  return slices;
}

/** parse `name="value"` / `name='value'` attribute pairs out of a single tag slice, order-independent. */
function parseAttrs(tag: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  const re = /([a-zA-Z][\w:-]*)\s*=\s*("([^"]*)"|'([^']*)')/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(tag))) {
    const name = match[1].toLowerCase();
    const value = match[3] !== undefined ? match[3] : (match[4] ?? "");
    attrs[name] = value;
  }
  return attrs;
}

/** extract the text content of the first `<tagLower>...</tagLower>` occurrence. */
function extractTagText(html: string, tagLower: string): string {
  const lower = html.toLowerCase();
  const openIdx = lower.indexOf(`<${tagLower}`);
  if (openIdx === -1) return "";
  const gtIdx = lower.indexOf(">", openIdx);
  if (gtIdx === -1) return "";
  const closeIdx = lower.indexOf(`</${tagLower}`, gtIdx);
  if (closeIdx === -1) return "";
  return decodeEntities(html.slice(gtIdx + 1, closeIdx));
}

/**
 * scan an HTML document for `<title>`, `og:title`, `og:description`
 * (falling back to `<meta name="description">`), and `og:image`.
 * any field may come back empty if the page doesn't advertise it.
 */
export function parseHtmlMeta(html: string): UnfurlResult {
  let title = extractTagText(html, "title");
  let description = "";
  let plainDescription = "";
  let imageUrl = "";

  for (const tag of findTagSlices(html, "meta")) {
    const attrs = parseAttrs(tag);
    const key = attrs.property ?? attrs.name;
    const content = attrs.content;
    if (content === undefined) continue;

    if (key === "og:title") {
      title = decodeEntities(content);
    } else if (key === "og:description") {
      description = decodeEntities(content);
    } else if (key === "description") {
      plainDescription = decodeEntities(content);
    } else if ((key === "og:image" || key === "og:image:url") && !imageUrl) {
      imageUrl = decodeEntities(content);
    }
  }

  return {
    title,
    description: description || plainDescription,
    imageUrl,
  };
}

/**
 * fetch a URL and return its unfurled summary.
 *
 * in tauri mode this routes through the `link_unfurl` dispatch action
 * (rust-side HTTP GET, no CORS restriction). in the browser it attempts a
 * plain `fetch()`, which will throw for most cross-origin sites — callers
 * must catch this and fall back to a manual display rather than treating
 * it as a fatal error.
 */
export async function fetchUnfurl(url: string): Promise<UnfurlResult> {
  if (isTauriMode()) {
    const result = await dispatch("link_unfurl", { url });
    return {
      title: typeof result?.title === "string" ? result.title : EMPTY_RESULT.title,
      description:
        typeof result?.description === "string" ? result.description : EMPTY_RESULT.description,
      imageUrl: typeof result?.image_url === "string" ? result.image_url : EMPTY_RESULT.imageUrl,
    };
  }

  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`unfurl fetch failed with status ${response.status}`);
  }
  const html = await response.text();
  return parseHtmlMeta(html);
}
