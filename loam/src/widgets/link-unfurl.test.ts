import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchUnfurl, parseHtmlMeta } from "./link-unfurl";

// mock the tauri transport boundary — controls isTauriMode() + intercepts
// dispatch() calls, same precedent as file-utils.test.ts.
const mockIsTauriMode = vi.fn<() => boolean>();
const mockDispatch = vi.fn<(action: string, payload?: Record<string, unknown>) => Promise<any>>();
vi.mock("../p2p/tauri-transport", () => ({
  isTauriMode: (...args: any[]) => mockIsTauriMode(...args),
  dispatch: (...args: any[]) => mockDispatch(...args),
}));


describe("parseHtmlMeta", () => {
  it("extracts full opengraph tags in normal order", () => {
    const html = `<html><head>
      <title>fallback title</title>
      <meta property="og:title" content="og title here">
      <meta property="og:description" content="a great description">
      <meta property="og:image" content="https://example.com/preview.png">
    </head></html>`;
    const result = parseHtmlMeta(html);
    expect(result.title).toBe("og title here");
    expect(result.description).toBe("a great description");
    expect(result.imageUrl).toBe("https://example.com/preview.png");
  });

  it("falls back to <title> and meta name=description when og tags are missing", () => {
    const html = `<html><head>
      <title>plain title</title>
      <meta name="description" content="plain description">
    </head></html>`;
    const result = parseHtmlMeta(html);
    expect(result.title).toBe("plain title");
    expect(result.description).toBe("plain description");
    expect(result.imageUrl).toBe("");
  });

  it("tolerates attribute order variations (content before property)", () => {
    const html = `<meta content="reordered description" property="og:description" />`;
    const result = parseHtmlMeta(html);
    expect(result.description).toBe("reordered description");
  });

  it("handles single-quoted attributes and a missing <title>", () => {
    const html = `<meta property='og:image' content='https://example.com/img.jpg'>`;
    const result = parseHtmlMeta(html);
    expect(result.title).toBe("");
    expect(result.imageUrl).toBe("https://example.com/img.jpg");
  });

  it("decodes common HTML entities without double-decoding &amp;", () => {
    const html = `<title>Tom &amp; Jerry &lt;classic&gt;</title>`;
    const result = parseHtmlMeta(html);
    expect(result.title).toBe("Tom & Jerry <classic>");
  });

  it("decodes numeric HTML entities (decimal and hex)", () => {
    const html = `<title>Tom &#38; Jerry &#x26; friends</title>`;
    const result = parseHtmlMeta(html);
    expect(result.title).toBe("Tom & Jerry & friends");
  });

  it("leaves malformed numeric entities (no terminating semicolon) untouched", () => {
    const html = `<title>no semicolon &#38 here</title>`;
    const result = parseHtmlMeta(html);
    expect(result.title).toBe("no semicolon &#38 here");
  });

  it("handles malformed/partial meta tags gracefully", () => {
    const html = `<meta property="og:title"><meta content="no key here">`;
    const result = parseHtmlMeta(html);
    expect(result.title).toBe("");
    expect(result.description).toBe("");
    expect(result.imageUrl).toBe("");
  });

  it("returns all-empty result for a document with no relevant tags", () => {
    const result = parseHtmlMeta("<html><body>hello</body></html>");
    expect(result).toEqual({ title: "", description: "", imageUrl: "" });
  });
});

describe("fetchUnfurl", () => {
  afterEach(() => {
    mockIsTauriMode.mockReset();
    mockDispatch.mockReset();
    vi.unstubAllGlobals();
  });

  it("browser mode: parses a successful same-origin/CORS-allowed fetch", async () => {
    mockIsTauriMode.mockReturnValue(false);
    const mockFetch = vi.fn(async () => ({
      ok: true,
      status: 200,
      text: async () =>
        `<meta property="og:title" content="hi"><meta property="og:description" content="desc">`,
    }));
    vi.stubGlobal("fetch", mockFetch);

    const result = await fetchUnfurl("https://example.com");
    expect(result.title).toBe("hi");
    expect(result.description).toBe("desc");
  });

  it("browser mode: throws on a non-ok response (caller falls back to manual display)", async () => {
    mockIsTauriMode.mockReturnValue(false);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: false, status: 403, text: async () => "" }))
    );

    await expect(fetchUnfurl("https://example.com")).rejects.toThrow();
  });

  it("tauri mode: routes through the link_unfurl dispatch action and maps image_url -> imageUrl", async () => {
    mockIsTauriMode.mockReturnValue(true);
    mockDispatch.mockResolvedValue({
      title: "rust title",
      description: "rust description",
      image_url: "https://example.com/rust.png",
    });

    const result = await fetchUnfurl("https://example.com");
    expect(mockDispatch).toHaveBeenCalledWith("link_unfurl", { url: "https://example.com" });
    expect(result).toEqual({
      title: "rust title",
      description: "rust description",
      imageUrl: "https://example.com/rust.png",
    });
  });
});
