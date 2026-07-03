import { describe, expect, it } from "vitest";
import { fileSchema, fileWidget } from "./file";

// ---------------------------------------------------------------------------
// schema — snatchedBy correctness (see also audio-recording.test.ts's mirror
// of these). the schema itself doesn't dedup (that's the mutation call
// sites' job, in file.ts's create()), but round-tripping/defaulting must
// stay correct since every snatchedBy mutation reads the current array back
// out of the automerge doc before deciding whether to push.
// ---------------------------------------------------------------------------

describe("fileSchema", () => {
  it("defaults blake3 and snatchedBy for a never-uploaded widget", () => {
    const result = fileSchema.parse({});
    expect(result.blake3).toBe("");
    expect(result.snatchedBy).toEqual([]);
  });

  it("round-trips snatchedBy written after upload/snatch", () => {
    const result = fileSchema.parse({
      blobId: "abc123",
      blake3: "deadbeef",
      snatchedBy: ["node-a", "node-b"],
    });
    expect(result.snatchedBy).toEqual(["node-a", "node-b"]);
  });

  it("does not itself dedup a pre-existing duplicate in stored data (schema is not the guard)", () => {
    // if a duplicate ever got written (e.g. a future regression in the
    // guard logic inside file.ts's create()), the schema alone wouldn't
    // catch or strip it — parsing is not where correctness is enforced.
    const result = fileSchema.parse({ snatchedBy: ["node-a", "node-a"] });
    expect(result.snatchedBy).toEqual(["node-a", "node-a"]);
  });
});

describe("fileWidget metadata", () => {
  it("has correct type", () => {
    expect(fileWidget.type).toBe("file");
  });

  it("has a schema", () => {
    expect(fileWidget.schema).toBe(fileSchema);
  });

  it("compact info surfaces blake3 and snatchedBy for peer-targeted snatch", () => {
    const info = fileWidget.getCompactInfo(
      fileSchema.parse({
        blobId: "abc123",
        filename: "report.pdf",
        blake3: "deadbeef",
        snatchedBy: ["node-a"],
      })
    );
    expect(info.blake3).toBe("deadbeef");
    expect(info.snatchedBy).toEqual(["node-a"]);
  });

  it("compact info omits snatchedBy when the list is empty", () => {
    const info = fileWidget.getCompactInfo(fileSchema.parse({}));
    expect(info.snatchedBy).toBeUndefined();
  });
});
