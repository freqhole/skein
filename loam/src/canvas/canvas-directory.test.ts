import { describe, expect, it } from "vitest";
import { filterCanvasCardCandidates } from "./canvas-directory";
import type { WidgetEntry } from "./canvas-doc";

function makeWidget(id: string, type: string, props: Record<string, unknown>): WidgetEntry {
  return {
    id,
    type,
    x: 0,
    y: 0,
    width: 280,
    height: 200,
    zIndex: 0,
    props,
    collapsed: false,
    docId: null,
    parentId: null,
  };
}

function makeCard(id: string, props: Record<string, unknown>): WidgetEntry {
  return makeWidget(id, "canvas-card", props);
}

describe("filterCanvasCardCandidates", () => {
  it("returns a candidate for a valid canvas-card widget", () => {
    const widgets = [
      makeCard("a", {
        canvasDocId: "doc-a",
        title: "alpha",
        description: "first canvas",
        previewUrl: "",
        color: 0x111111,
      }),
    ];

    expect(filterCanvasCardCandidates(widgets)).toEqual([
      { canvasDocId: "doc-a", title: "alpha", description: "first canvas", previewUrl: "", color: 0x111111 },
    ]);
  });

  it("excludes widgets that aren't canvas-card type", () => {
    const widgets = [makeWidget("x", "label", { canvasDocId: "doc-a" })];
    expect(filterCanvasCardCandidates(widgets)).toEqual([]);
  });

  it("excludes soft-deleted canvas cards", () => {
    const widgets = [makeCard("a", { canvasDocId: "doc-a", isDeleted: true })];
    expect(filterCanvasCardCandidates(widgets)).toEqual([]);
  });

  it("excludes cards with no canvasDocId", () => {
    const widgets = [makeCard("a", {})];
    expect(filterCanvasCardCandidates(widgets)).toEqual([]);
  });

  it("excludes the current canvas from its own candidate list", () => {
    const widgets = [
      makeCard("a", { canvasDocId: "doc-a", title: "alpha" }),
      makeCard("b", { canvasDocId: "doc-b", title: "beta" }),
    ];
    const result = filterCanvasCardCandidates(widgets, "doc-a");
    expect(result.map((c) => c.canvasDocId)).toEqual(["doc-b"]);
  });

  it("ignores malformed props rather than throwing", () => {
    const widgets = [makeCard("a", { canvasDocId: 123 })];
    expect(filterCanvasCardCandidates(widgets)).toEqual([]);
  });

  it("returns multiple candidates preserving order", () => {
    const widgets = [
      makeCard("a", { canvasDocId: "doc-a", title: "alpha" }),
      makeCard("b", { canvasDocId: "doc-b", title: "beta" }),
      makeCard("c", { canvasDocId: "doc-c", title: "gamma" }),
    ];
    const result = filterCanvasCardCandidates(widgets);
    expect(result.map((c) => c.canvasDocId)).toEqual(["doc-a", "doc-b", "doc-c"]);
  });
});
