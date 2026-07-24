import { describe, expect, it, vi } from "vitest";
import { buildShareUrl, decodeShareString, encodeShareString, shareFragment } from "./share-string";

describe("encodeShareString", () => {
  it("produces a base64 string", () => {
    const result = encodeShareString("a".repeat(64), "doc-123");
    expect(result).toBeTruthy();
    // should be valid base64
    expect(() => atob(result)).not.toThrow();
  });

  it("round-trips with decodeShareString", () => {
    const nodeId = "a".repeat(64);
    const docId = "some-doc-id-abc";
    const encoded = encodeShareString(nodeId, docId);
    const decoded = decodeShareString(encoded);
    expect(decoded).toEqual({ nodeId, docId });
  });

  it("embeds the canvas title when given", () => {
    const nodeId = "a".repeat(64);
    const docId = "doc-with-title";
    const encoded = encodeShareString(nodeId, docId, "my cool canvas");
    const decoded = decodeShareString(encoded);
    expect(decoded).toEqual({ nodeId, docId, canvasTitle: "my cool canvas" });
  });

  it("truncates a long canvas title", () => {
    const nodeId = "a".repeat(64);
    const docId = "doc-long-title";
    const longTitle = "x".repeat(80);
    const encoded = encodeShareString(nodeId, docId, longTitle);
    const decoded = decodeShareString(encoded);
    expect(decoded?.canvasTitle?.length).toBeLessThan(longTitle.length);
    expect(decoded?.canvasTitle?.endsWith("\u2026")).toBe(true);
  });

  it("omits the title field entirely when given an empty/whitespace title", () => {
    const nodeId = "a".repeat(64);
    const docId = "doc-empty-title";
    const encoded = encodeShareString(nodeId, docId, "   ");
    const decoded = decodeShareString(encoded);
    expect(decoded).toEqual({ nodeId, docId });
  });

  it("embeds hub node ids when given", () => {
    const nodeId = "a".repeat(64);
    const docId = "doc-with-hubs";
    const hubNodeIds = ["k".repeat(64), "l".repeat(64)];
    const encoded = encodeShareString(nodeId, docId, undefined, hubNodeIds);
    const decoded = decodeShareString(encoded);
    expect(decoded).toEqual({ nodeId, docId, hubNodeIds });
  });

  it("omits the hub field entirely when given an empty array", () => {
    const nodeId = "a".repeat(64);
    const docId = "doc-no-hubs";
    const encoded = encodeShareString(nodeId, docId, undefined, []);
    const decoded = decodeShareString(encoded);
    expect(decoded).toEqual({ nodeId, docId });
  });

});

describe("decodeShareString", () => {
  it("decodes a valid base64 share string", () => {
    const payload = btoa(JSON.stringify({ n: "b".repeat(64), d: "doc-456" }));
    const result = decodeShareString(payload);
    expect(result).toEqual({ nodeId: "b".repeat(64), docId: "doc-456" });
  });

  it("strips #share/ prefix", () => {
    const payload = btoa(JSON.stringify({ n: "c".repeat(64), d: "doc-789" }));
    const result = decodeShareString(`#share/${payload}`);
    expect(result).toEqual({ nodeId: "c".repeat(64), docId: "doc-789" });
  });

  it("strips share/ prefix without hash", () => {
    const payload = btoa(JSON.stringify({ n: "d".repeat(64), d: "doc-000" }));
    const result = decodeShareString(`share/${payload}`);
    expect(result).toEqual({ nodeId: "d".repeat(64), docId: "doc-000" });
  });

  it("returns null for invalid base64", () => {
    expect(decodeShareString("not-valid-base64!!!")).toBeNull();
  });

  it("returns null for valid base64 but invalid JSON", () => {
    expect(decodeShareString(btoa("not json"))).toBeNull();
  });

  it("returns null for missing nodeId", () => {
    expect(decodeShareString(btoa(JSON.stringify({ d: "doc" })))).toBeNull();
  });

  it("returns null for missing docId", () => {
    expect(decodeShareString(btoa(JSON.stringify({ n: "node" })))).toBeNull();
  });

  it("returns null for empty nodeId", () => {
    expect(decodeShareString(btoa(JSON.stringify({ n: "", d: "doc" })))).toBeNull();
  });

  it("returns null for empty docId", () => {
    expect(decodeShareString(btoa(JSON.stringify({ n: "node", d: "" })))).toBeNull();
  });

  it("trims whitespace", () => {
    const payload = btoa(JSON.stringify({ n: "e".repeat(64), d: "doc-ws" }));
    const result = decodeShareString(`  ${payload}  `);
    expect(result).toEqual({ nodeId: "e".repeat(64), docId: "doc-ws" });
  });

  it("accepts a full share URL with scheme + host", () => {
    const payload = btoa(JSON.stringify({ n: "g".repeat(64), d: "doc-url" }));
    const result = decodeShareString(`https://skein.freqhole.net/#share/${payload}`);
    expect(result).toEqual({ nodeId: "g".repeat(64), docId: "doc-url" });
  });

  it("accepts a full share URL from a local dev server", () => {
    const payload = btoa(JSON.stringify({ n: "h".repeat(64), d: "doc-dev" }));
    const result = decodeShareString(`http://localhost:5173/#share/${payload}`);
    expect(result).toEqual({ nodeId: "h".repeat(64), docId: "doc-dev" });
  });

  it("returns null for a bare canvas doc id URL (not a share link)", () => {
    expect(decodeShareString("https://skein.freqhole.net/#3rK6y8mZRiTPWeCzy6khb18pcnn7")).toBeNull();
  });

  it("decodes an h field into hubNodeIds", () => {
    const hubNodeId = "k".repeat(64);
    const payload = btoa(
      JSON.stringify({ n: "m".repeat(64), d: "doc-with-hubs", h: [hubNodeId] })
    );
    const result = decodeShareString(payload);
    expect(result).toEqual({
      nodeId: "m".repeat(64),
      docId: "doc-with-hubs",
      hubNodeIds: [hubNodeId],
    });
  });

  it("ignores a malformed h field (not an array of strings)", () => {
    const payload = btoa(
      JSON.stringify({ n: "n".repeat(64), d: "doc-bad-hubs", h: [123, "ok"] })
    );
    const result = decodeShareString(payload);
    expect(result).toEqual({ nodeId: "n".repeat(64), docId: "doc-bad-hubs" });
  });

  it("ignores an empty h array", () => {
    const payload = btoa(JSON.stringify({ n: "p".repeat(64), d: "doc-empty-hubs", h: [] }));
    const result = decodeShareString(payload);
    expect(result).toEqual({ nodeId: "p".repeat(64), docId: "doc-empty-hubs" });
  });
});

describe("shareFragment", () => {
  it("returns a hash fragment with share/ prefix", () => {
    const result = shareFragment("f".repeat(64), "doc-frag");
    expect(result).toMatch(/^#share\//);
  });

  it("round-trips through decodeShareString", () => {
    const frag = shareFragment("f".repeat(64), "doc-frag");
    const decoded = decodeShareString(frag);
    expect(decoded).toEqual({ nodeId: "f".repeat(64), docId: "doc-frag" });
  });

  it("round-trips hub node ids through decodeShareString", () => {
    const hubNodeIds = ["q".repeat(64)];
    const frag = shareFragment("f".repeat(64), "doc-frag-hubs", undefined, hubNodeIds);
    const decoded = decodeShareString(frag);
    expect(decoded).toEqual({ nodeId: "f".repeat(64), docId: "doc-frag-hubs", hubNodeIds });
  });
});

describe("buildShareUrl", () => {
  it("uses the real browser origin + pathname outside tauri mode", () => {
    vi.stubGlobal("window", {
      location: { origin: "http://localhost:5173", pathname: "/" },
    });
    const url = buildShareUrl("i".repeat(64), "doc-browser");
    expect(url.startsWith("http://localhost:5173/#share/")).toBe(true);
    vi.unstubAllGlobals();
  });

  it("uses the production origin in tauri mode instead of tauri://localhost", () => {
    vi.stubGlobal("window", {
      location: { origin: "tauri://localhost", pathname: "/" },
      __TAURI_INTERNALS__: { invoke: () => Promise.resolve() },
    });
    const url = buildShareUrl("j".repeat(64), "doc-tauri");
    expect(url.startsWith("https://skein.freqhole.net/#share/")).toBe(true);
    vi.unstubAllGlobals();
  });
});
