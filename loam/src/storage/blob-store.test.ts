// integration test for skein's blob store wrapper: exercises the real
// createBlobStore() from @freqhole/reliquary/blobs (metadata layer + bytes
// layer), the domain-into-metadata translation, and the getBlobDomain
// read-back path - the exact flow the file widget's upload handler uses
// (see widgets/upload.ts's uploadFile()). the worker (hashing + the
// OPFS write path) is mocked, matching the pattern reliquary's own
// blobs/store.test.ts uses - no real Worker or bundled midden module
// exists in this test environment.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fakeIdbHarness } from "@freqhole/reliquary/testing";

class FakeWritable {
  constructor(private readonly file: FakeFileHandle) {}
  async write(data: ArrayBuffer | ArrayBufferView): Promise<void> {
    this.file.bytes =
      data instanceof ArrayBuffer ? new Uint8Array(data) : new Uint8Array(data.buffer as ArrayBuffer);
  }
  async close(): Promise<void> {
    // matches the real FileSystemWritableFileStream API - nothing to flush.
  }
}

class FakeFileHandle {
  bytes = new Uint8Array(0);
  async getFile(): Promise<{ arrayBuffer(): Promise<ArrayBuffer> }> {
    const bytes = this.bytes;
    return { arrayBuffer: async () => bytes.buffer as ArrayBuffer };
  }
  async createWritable(): Promise<FakeWritable> {
    return new FakeWritable(this);
  }
}

class FakeDirHandle {
  files = new Map<string, FakeFileHandle>();
  async getFileHandle(name: string, opts?: { create?: boolean }): Promise<FakeFileHandle> {
    let handle = this.files.get(name);
    if (!handle) {
      if (!opts?.create) throw new Error(`not found: ${name}`);
      handle = new FakeFileHandle();
      this.files.set(name, handle);
    }
    return handle;
  }
  async getDirectoryHandle(_name: string, opts?: { create?: boolean }): Promise<FakeDirHandle> {
    void opts;
    return this;
  }
}

let opfsRoot: FakeDirHandle;

function installFakeOpfs(): void {
  opfsRoot = new FakeDirHandle();
  vi.stubGlobal("navigator", {
    storage: {
      getDirectory: async () => opfsRoot,
    },
  });
}

async function fakeSha256Hex(data: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

vi.mock("@freqhole/reliquary/worker", () => ({
  BLOB_OPFS_DIR: "skein-blobs",
  writeBlobToOpfs: vi.fn(async (id: string, data: ArrayBuffer) => {
    const root = await navigator.storage.getDirectory();
    const dir = await root.getDirectoryHandle("skein-blobs", { create: true });
    const file = await dir.getFileHandle(id, { create: true });
    const writable = await file.createWritable();
    await writable.write(data);
    await writable.close();
  }),
  // a real blake3 digest is unavailable in this test environment - derive a
  // distinct, deterministic stand-in from the sha256 digest, matching
  // reliquary's own test convention for this exact situation.
  hashBlake3: vi.fn(async (data: Uint8Array) => {
    const sha256 = await fakeSha256Hex(
      data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer
    );
    return `b3-${sha256}`;
  }),
  hashSha256: vi.fn(async (data: ArrayBuffer) => fakeSha256Hex(data)),
  streamFileToOpfs: vi.fn(async (file: File) => {
    const buffer = await file.arrayBuffer();
    const sha256 = await fakeSha256Hex(buffer);
    return { blake3: `b3-${sha256}`, size: buffer.byteLength };
  }),
}));

beforeEach(() => {
  fakeIdbHarness();
  installFakeOpfs();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});

function pngFile(name = "photo.png"): File {
  const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);
  return new File([bytes], name, { type: "image/png" });
}

describe("blob-store domain classification", () => {
  it("classifies image/video/audio/pdf/other mime types into the expected domain", async () => {
    const { classifyDomain } = await import("./blob-store.js");
    expect(classifyDomain("image/png")).toBe("photo");
    expect(classifyDomain("video/mp4")).toBe("video");
    expect(classifyDomain("audio/mpeg")).toBe("audio");
    expect(classifyDomain("application/pdf")).toBe("document");
    expect(classifyDomain("application/zip")).toBe("file");
  });

  it("stores a png upload's domain in metadata and reads it back as photo, not video", async () => {
    const { classifyDomain, getBlobDomain, storeBlobFromFile } = await import("./blob-store.js");

    const file = pngFile();
    const domain = classifyDomain(file.type);
    expect(domain).toBe("photo");

    // exactly the call shape widgets/upload.ts's uploadFile() uses in
    // browser mode: only `metadata.domain` is passed, filename/mime are
    // inferred from the File object itself.
    const record = await storeBlobFromFile(file, { metadata: { domain } });

    expect(record.mime).toBe("image/png");
    expect(record.metadata?.domain).toBe("photo");
    expect(getBlobDomain(record)).toBe("photo");
    expect(getBlobDomain(record)).not.toBe("video");
  });

  it("still classifies correctly for a record whose metadata predates the domain field", async () => {
    const { classifyDomain, getBlobDomain } = await import("./blob-store.js");
    const record = {
      blob_id: "abc",
      blake3: "abc",
      filename: "old.png",
      mime: "image/png",
      size: 4,
      blob_type: "original" as const,
      created_at: 0,
      // no metadata at all - simulates a record written before this field existed.
    };
    expect(getBlobDomain(record)).toBe("photo");
    expect(getBlobDomain(record)).toBe(classifyDomain(record.mime));
  });

  it("a record survives a simulated page reload (fresh module import, same fake idb/opfs)", async () => {
    const { classifyDomain, storeBlobFromFile } = await import("./blob-store.js");
    const file = pngFile();
    const stored = await storeBlobFromFile(file, { metadata: { domain: classifyDomain(file.type) } });

    // simulate a page reload: re-import the module fresh (a real reload
    // re-runs top-level module code, re-creating the store's closure) while
    // keeping the same fake indexeddb/opfs backing data intact, matching a
    // real reload's persistent-storage behavior.
    vi.resetModules();
    const reloaded = await import("./blob-store.js");

    const record = await reloaded.getBlobRecord(stored.blob_id);
    expect(record).not.toBeNull();
    expect(record?.mime).toBe("image/png");
    expect(reloaded.getBlobDomain(record!)).toBe("photo");

    const bytes = await reloaded.getBlobData(stored.blob_id);
    expect(bytes).not.toBeNull();
    expect(new Uint8Array(bytes!).length).toBeGreaterThan(0);
  });
});
