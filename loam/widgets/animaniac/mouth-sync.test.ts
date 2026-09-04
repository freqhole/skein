import { describe, expect, it } from "vitest";
import { opennessAtElapsed } from "./mouth-sync";

describe("opennessAtElapsed", () => {
  it("returns 0 for an empty envelope", () => {
    expect(opennessAtElapsed(new Float32Array(0), 1)).toBe(0);
  });

  it("indexes the nearest bucket at the given elapsed time and hz", () => {
    // at 10hz, bucket 5 covers t=[0.5, 0.6)
    const envelope = new Float32Array([0, 0, 0, 0, 0, 0.5, 0, 0, 0, 0]);
    const opennessAtQuiet = opennessAtElapsed(envelope, 0.0, 10);
    const opennessAtLoud = opennessAtElapsed(envelope, 0.55, 10);
    expect(opennessAtLoud).toBeGreaterThan(opennessAtQuiet);
  });

  it("clamps to the last bucket once elapsed exceeds the envelope's length", () => {
    const envelope = new Float32Array([0.1, 0.9]);
    expect(opennessAtElapsed(envelope, 999, 10)).toBe(opennessAtElapsed(envelope, 0.15, 10));
  });

  it("clamps to the first bucket for a negative elapsed time", () => {
    const envelope = new Float32Array([0.3, 0.9]);
    expect(opennessAtElapsed(envelope, -5, 10)).toBe(opennessAtElapsed(envelope, 0, 10));
  });
});
