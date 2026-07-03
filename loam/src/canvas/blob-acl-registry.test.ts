import { describe, expect, it } from "vitest";
import { BlobAclRegistry } from "./blob-acl-registry";

describe("BlobAclRegistry", () => {
  it("unionForHash returns an empty array when nothing has contributed", () => {
    const registry = new BlobAclRegistry();
    expect(registry.unionForHash("deadbeef")).toEqual([]);
  });

  it("setCanvasContribution reports its own peers for a hash", () => {
    const registry = new BlobAclRegistry();
    registry.setCanvasContribution("canvas-a", new Map([["hash1", ["x", "y"]]]));
    expect(registry.unionForHash("hash1").sort()).toEqual(["x", "y"]);
  });

  it("unions contributions from two different canvases for the same hash", () => {
    const registry = new BlobAclRegistry();
    registry.setCanvasContribution("canvas-a", new Map([["hash1", ["x", "y"]]]));
    registry.setCanvasContribution("canvas-b", new Map([["hash1", ["z"]]]));
    expect(registry.unionForHash("hash1").sort()).toEqual(["x", "y", "z"]);
  });

  it("de-duplicates a peer authorized by more than one canvas", () => {
    const registry = new BlobAclRegistry();
    registry.setCanvasContribution("canvas-a", new Map([["hash1", ["x", "y"]]]));
    registry.setCanvasContribution("canvas-b", new Map([["hash1", ["y", "z"]]]));
    expect(registry.unionForHash("hash1").sort()).toEqual(["x", "y", "z"]);
  });

  it("a closed canvas's contribution stays in the union until explicitly cleared", () => {
    const registry = new BlobAclRegistry();
    registry.setCanvasContribution("canvas-a", new Map([["hash1", ["x", "y"]]]));
    // canvas-a "closes" — nothing calls setCanvasContribution/clearCanvas
    // for it again — its peers must still be part of the union.
    registry.setCanvasContribution("canvas-b", new Map([["hash1", ["z"]]]));
    expect(registry.unionForHash("hash1").sort()).toEqual(["x", "y", "z"]);
  });

  it("replacing a canvas's contribution drops hashes it no longer references", () => {
    const registry = new BlobAclRegistry();
    registry.setCanvasContribution("canvas-a", new Map([["hash1", ["x"]]]));
    expect(registry.unionForHash("hash1")).toEqual(["x"]);

    // widget removed / blake3 no longer referenced — canvas-a's next full
    // report simply omits hash1.
    registry.setCanvasContribution("canvas-a", new Map());
    expect(registry.unionForHash("hash1")).toEqual([]);
  });

  it("clearCanvas removes a canvas's contribution entirely", () => {
    const registry = new BlobAclRegistry();
    registry.setCanvasContribution("canvas-a", new Map([["hash1", ["x"]]]));
    registry.setCanvasContribution("canvas-b", new Map([["hash1", ["z"]]]));
    registry.clearCanvas("canvas-a");
    expect(registry.unionForHash("hash1")).toEqual(["z"]);
  });

  it("setCanvasContribution returns every hash affected (previous, new, or both)", () => {
    const registry = new BlobAclRegistry();
    registry.setCanvasContribution("canvas-a", new Map([["hash1", ["x"]]]));
    const affected = registry.setCanvasContribution(
      "canvas-a",
      new Map([["hash2", ["x"]]])
    );
    expect([...affected].sort()).toEqual(["hash1", "hash2"]);
  });

  it("setCanvasContribution with no change still returns the affected set (idempotent content)", () => {
    const registry = new BlobAclRegistry();
    registry.setCanvasContribution("canvas-a", new Map([["hash1", ["x"]]]));
    const affected = registry.setCanvasContribution("canvas-a", new Map([["hash1", ["x"]]]));
    expect([...affected]).toEqual(["hash1"]);
  });

  it("clearCanvas on a canvas with no prior contribution is a harmless no-op", () => {
    const registry = new BlobAclRegistry();
    const affected = registry.clearCanvas("never-contributed");
    expect(affected.size).toBe(0);
  });

  it("allHashes returns every hash across every known canvas", () => {
    const registry = new BlobAclRegistry();
    registry.setCanvasContribution("canvas-a", new Map([["hash1", ["x"]]]));
    registry.setCanvasContribution("canvas-b", new Map([["hash2", ["z"]]]));
    expect([...registry.allHashes()].sort()).toEqual(["hash1", "hash2"]);
  });

  it("a hash unrelated to any contribution is unaffected by other canvases' updates", () => {
    const registry = new BlobAclRegistry();
    registry.setCanvasContribution("canvas-a", new Map([["hash1", ["x"]]]));
    registry.setCanvasContribution("canvas-b", new Map([["hash2", ["z"]]]));
    expect(registry.unionForHash("hash1")).toEqual(["x"]);
    expect(registry.unionForHash("hash2")).toEqual(["z"]);
  });
});
