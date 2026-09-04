import { describe, expect, it } from "vitest";
import { createUndoHistory } from "./undo-history";

describe("createUndoHistory", () => {
  it("starts with nothing to undo or redo", () => {
    const h = createUndoHistory<number>(10, (a, b) => a === b);
    expect(h.canUndo()).toBe(false);
    expect(h.canRedo()).toBe(false);
    expect(h.undo()).toBeNull();
    expect(h.redo()).toBeNull();
  });

  it("reset() seeds a single baseline entry that can't itself be undone", () => {
    const h = createUndoHistory<number>(10, (a, b) => a === b);
    h.reset(0);
    expect(h.canUndo()).toBe(false);
    expect(h.canRedo()).toBe(false);
  });

  it("push() then undo() steps back to the previous entry", () => {
    const h = createUndoHistory<number>(10, (a, b) => a === b);
    h.reset(0);
    h.push(1);
    h.push(2);
    expect(h.canUndo()).toBe(true);
    expect(h.undo()).toBe(1);
    expect(h.undo()).toBe(0);
    expect(h.canUndo()).toBe(false);
    expect(h.undo()).toBeNull();
  });

  it("redo() replays entries undone, up to the most recent push", () => {
    const h = createUndoHistory<number>(10, (a, b) => a === b);
    h.reset(0);
    h.push(1);
    h.push(2);
    h.undo();
    h.undo();
    expect(h.canRedo()).toBe(true);
    expect(h.redo()).toBe(1);
    expect(h.redo()).toBe(2);
    expect(h.canRedo()).toBe(false);
    expect(h.redo()).toBeNull();
  });

  it("a new push() after undo() discards the redo branch", () => {
    const h = createUndoHistory<number>(10, (a, b) => a === b);
    h.reset(0);
    h.push(1);
    h.push(2);
    h.undo();
    h.push(99);
    expect(h.canRedo()).toBe(false);
    expect(h.undo()).toBe(1);
    expect(h.undo()).toBe(0);
  });

  it("dedupes a push() equal to the current top entry", () => {
    const h = createUndoHistory<number>(10, (a, b) => a === b);
    h.reset(0);
    h.push(1);
    h.push(1); // no-op — same as current top
    expect(h.canRedo()).toBe(false);
    expect(h.undo()).toBe(0);
    expect(h.canUndo()).toBe(false); // only one real entry was ever pushed
  });

  it("drops the oldest entry once the limit is exceeded", () => {
    const h = createUndoHistory<number>(2, (a, b) => a === b);
    h.reset(0);
    h.push(1);
    h.push(2); // stack: [0, 1, 2] -> trimmed to [1, 2]
    expect(h.undo()).toBe(1);
    expect(h.canUndo()).toBe(false);
  });
});
