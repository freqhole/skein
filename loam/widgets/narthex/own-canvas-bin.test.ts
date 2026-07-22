import { describe, expect, it } from "vitest";
import { OWN_CANVAS_BIN_WIDGET_ID, OWN_CANVAS_BIN_WIDGET_TYPE, ownCanvasBinSchema, ownCanvasBinWidget } from "./own-canvas-bin";

describe("ownCanvasBinSchema", () => {
  it("parses an empty object (no per-instance config needed)", () => {
    const result = ownCanvasBinSchema.parse({});
    expect(result).toEqual({});
  });

  it("ignores unknown extra fields rather than throwing", () => {
    expect(() => ownCanvasBinSchema.parse({ foo: "bar" })).not.toThrow();
  });
});

describe("ownCanvasBinWidget", () => {
  it("has correct type", () => {
    expect(ownCanvasBinWidget.type).toBe("own-canvas-bin");
    expect(ownCanvasBinWidget.type).toBe(OWN_CANVAS_BIN_WIDGET_TYPE);
  });

  it("has default dimensions", () => {
    expect(ownCanvasBinWidget.metadata.defaultWidth).toBe(280);
    expect(ownCanvasBinWidget.metadata.defaultHeight).toBe(320);
  });

  it("is a singleton with the well-known widget id", () => {
    expect(ownCanvasBinWidget.metadata.singleton).toBe(true);
    expect(ownCanvasBinWidget.metadata.singletonId).toBe(OWN_CANVAS_BIN_WIDGET_ID);
    expect(ownCanvasBinWidget.metadata.singletonId).toBe("skein-own-canvas-bin");
  });

  it("is visible in the add-widget palette (singletonId hides it once already placed)", () => {
    expect(ownCanvasBinWidget.metadata.hidden).toBeFalsy();
  });
});
