import { describe, expect, it } from "vitest";
import { createNarthexRegistry } from "./index";

describe("createNarthexRegistry", () => {
  it("registers canvas-card, canvas-wizard, social, label, and join-canvas", () => {
    const registry = createNarthexRegistry();
    expect(registry.has("canvas-card")).toBe(true);
    expect(registry.has("canvas-wizard")).toBe(true);
    expect(registry.has("social")).toBe(true);
    expect(registry.has("label")).toBe(true);
    expect(registry.has("join-canvas")).toBe(true);
  });

  it("has exactly 9 widget types", () => {
    const registry = createNarthexRegistry();
    expect(registry.types().length).toBe(9);
  });

  it("canvas-card is hidden", () => {
    const registry = createNarthexRegistry();
    expect(registry.get("canvas-card")!.metadata.hidden).toBe(true);
  });

  it("social is a singleton", () => {
    const registry = createNarthexRegistry();
    expect(registry.get("social")!.metadata.singleton).toBe(true);
    expect(registry.get("social")!.metadata.singletonId).toBe("skein-social");
  });

  it("canvas-wizard is not hidden", () => {
    const registry = createNarthexRegistry();
    expect(registry.get("canvas-wizard")!.metadata.hidden).toBeFalsy();
  });

  it("label is not hidden", () => {
    const registry = createNarthexRegistry();
    expect(registry.get("label")!.metadata.hidden).toBeFalsy();
  });

  it("social is hidden (accessed via toolbar avatar button)", () => {
    const registry = createNarthexRegistry();
    expect(registry.get("social")!.metadata.hidden).toBe(true);
  });

  it("join-canvas is not hidden", () => {
    const registry = createNarthexRegistry();
    expect(registry.get("join-canvas")!.metadata.hidden).toBeFalsy();
  });

  it("registers messagez", () => {
    const registry = createNarthexRegistry();
    expect(registry.has("messagez")).toBe(true);
  });

  it("messagez is a singleton", () => {
    const registry = createNarthexRegistry();
    expect(registry.get("messagez")!.metadata.singleton).toBe(true);
    expect(registry.get("messagez")!.metadata.singletonId).toBe("skein-messagez");
  });

  it("messagez is hidden (accessed via toolbar messages button)", () => {
    const registry = createNarthexRegistry();
    expect(registry.get("messagez")!.metadata.hidden).toBe(true);
  });

  it("non-hidden widgets for palette", () => {
    const registry = createNarthexRegistry();
    const visible = registry.all().filter((f) => !f.metadata.hidden);
    expect(visible.length).toBe(6);
    const types = visible.map((f) => f.type);
    expect(types).toContain("canvas-wizard");
    expect(types).toContain("label");
    expect(types).toContain("join-canvas");
    expect(types).toContain("bin");
    expect(types).toContain("markdown");
    expect(types).toContain("trash");
    // social + messagez are hidden — they live in the toolbar as icon buttons
    expect(types).not.toContain("social");
    expect(types).not.toContain("messagez");
  });
});
