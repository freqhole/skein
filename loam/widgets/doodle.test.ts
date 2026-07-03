import { describe, expect, it } from "vitest";
import { doodleSchema, doodleWidget } from "./doodle";

describe("doodleSchema", () => {
  it("parses empty object with defaults", () => {
    const result = doodleSchema.parse({});
    expect(result.strokes).toEqual([]);
    expect(result.activeTool).toBe("pen");
    expect(result.locked).toBe(false);
  });

  it("defaults locked to false when omitted", () => {
    const result = doodleSchema.parse({});
    expect(result.locked).toBe(false);
  });

  it("accepts an explicit locked: true", () => {
    const result = doodleSchema.parse({ locked: true });
    expect(result.locked).toBe(true);
  });

  it("rejects a non-boolean locked value", () => {
    expect(() => doodleSchema.parse({ locked: "yes" })).toThrow();
  });
});

describe("doodleWidget", () => {
  it("has correct type", () => {
    expect(doodleWidget.type).toBe("doodle");
  });

  it("has a schema", () => {
    expect(doodleWidget.schema).toBe(doodleSchema);
  });

  it("exposes a locked toggle in editableProps (side tools / property tray)", () => {
    const lockedProp = doodleWidget.editableProps!.find((p) => p.key === "locked");
    expect(lockedProp).toBeDefined();
    expect(lockedProp!.type).toBe("boolean");
    expect(lockedProp!.default).toBe(false);
  });
});
