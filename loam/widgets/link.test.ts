import { describe, expect, it, vi } from "vitest";
import { linkSchema, linkWidget } from "./link";

describe("linkSchema", () => {
  it("parses an empty object with all defaults", () => {
    const result = linkSchema.parse({});
    expect(result).toEqual({
      url: "",
      title: "",
      description: "",
      previewUrl: "",
      unfurlEnabled: false,
    });
  });

  it("defaults unfurlEnabled to false (non-default opt-in)", () => {
    const result = linkSchema.parse({});
    expect(result.unfurlEnabled).toBe(false);
  });

  it("accepts an explicit unfurlEnabled: true", () => {
    const result = linkSchema.parse({ unfurlEnabled: true });
    expect(result.unfurlEnabled).toBe(true);
  });

  it("rejects a non-boolean unfurlEnabled value", () => {
    expect(() => linkSchema.parse({ unfurlEnabled: "yes" })).toThrow();
  });

  it("accepts a full set of fields", () => {
    const result = linkSchema.parse({
      url: "https://example.com",
      title: "example",
      description: "an example site",
      previewUrl: "data:image/png;base64,abc",
      unfurlEnabled: true,
    });
    expect(result.url).toBe("https://example.com");
    expect(result.title).toBe("example");
    expect(result.description).toBe("an example site");
    expect(result.previewUrl).toBe("data:image/png;base64,abc");
    expect(result.unfurlEnabled).toBe(true);
  });
});

describe("linkWidget metadata", () => {
  it("has correct type", () => {
    expect(linkWidget.type).toBe("link");
  });

  it("has a schema", () => {
    expect(linkWidget.schema).toBe(linkSchema);
  });

  it("is in the basics category and not hidden/singleton/unique", () => {
    expect(linkWidget.metadata.category).toBe("basics");
    expect(linkWidget.metadata.hidden).toBeUndefined();
    expect(linkWidget.metadata.singleton).toBeUndefined();
    expect(linkWidget.metadata.unique).toBeUndefined();
  });

  it("has sensible default dimensions", () => {
    expect(linkWidget.metadata.defaultWidth).toBe(280);
    expect(linkWidget.metadata.defaultHeight).toBe(210);
  });

  it("exposes title/description/previewUrl in editableProps (property tray)", () => {
    const keys = linkWidget.editableProps!.map((p) => p.key);
    expect(keys).toEqual(["title", "description", "previewUrl"]);
    const previewProp = linkWidget.editableProps!.find((p) => p.key === "previewUrl");
    expect(previewProp!.type).toBe("image");
  });

  it("does not expose url or unfurlEnabled in editableProps (edited inline / via header+tray actions)", () => {
    const keys = linkWidget.editableProps!.map((p) => p.key);
    expect(keys).not.toContain("url");
    expect(keys).not.toContain("unfurlEnabled");
  });
});

describe("linkWidget.getCompactInfo", () => {
  it("prefers title over url for the label", () => {
    const info = linkWidget.getCompactInfo!(
      linkSchema.parse({ url: "https://example.com", title: "example site" })
    );
    expect(info.label).toBe("example site");
  });

  it("falls back to url when there's no title", () => {
    const info = linkWidget.getCompactInfo!(linkSchema.parse({ url: "https://example.com" }));
    expect(info.label).toBe("https://example.com");
  });

  it("falls back to 'link' when neither title nor url is set", () => {
    const info = linkWidget.getCompactInfo!(linkSchema.parse({}));
    expect(info.label).toBe("link");
  });

  it("surfaces previewUrl as the compact thumbnail", () => {
    const info = linkWidget.getCompactInfo!(
      linkSchema.parse({ previewUrl: "data:image/png;base64,abc" })
    );
    expect(info.thumbnailUrl).toBe("data:image/png;base64,abc");
  });

  it("omits thumbnailUrl when there's no preview image", () => {
    const info = linkWidget.getCompactInfo!(linkSchema.parse({}));
    expect(info.thumbnailUrl).toBeUndefined();
  });
});

describe("linkWidget.onCompactActivate", () => {
  it("opens the url in a new tab when set", () => {
    const mockOpen = vi.fn();
    vi.stubGlobal("window", { open: mockOpen });

    linkWidget.onCompactActivate!(linkSchema.parse({ url: "https://example.com" }));
    expect(mockOpen).toHaveBeenCalledWith("https://example.com", "_blank", "noopener,noreferrer");

    vi.unstubAllGlobals();
  });

  it("does nothing when no url is set", () => {
    const mockOpen = vi.fn();
    vi.stubGlobal("window", { open: mockOpen });

    linkWidget.onCompactActivate!(linkSchema.parse({}));
    expect(mockOpen).not.toHaveBeenCalled();

    vi.unstubAllGlobals();
  });
});
