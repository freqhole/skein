// stub for @freqhole/midden in Tauri builds
// midden WASM isn't needed in skein when building for Tauri
//
// this stub exists so imports of "@freqhole/midden" don't fail during
// dev/build when VITE_TAURI is set. it mirrors the real package's exported
// surface (classes, constructors, and free functions) so every static
// import resolves to a real binding — even though every member throws (or,
// for wasm-only debug helpers, rejects) when actually called.

export class MiddenNode {
  static async create(): Promise<MiddenNode> {
    throw new Error("midden WASM is not available in this build");
  }

  static async create_from_key(_key: Uint8Array): Promise<MiddenNode> {
    throw new Error("midden WASM is not available in this build");
  }

  static async create_with_alpns(_key: Uint8Array, _extra_alpns: string[]): Promise<MiddenNode> {
    throw new Error("midden WASM is not available in this build");
  }

  static async create_with_options(_options: MiddenNodeOptions): Promise<MiddenNode> {
    throw new Error("midden WASM is not available in this build");
  }

  node_id(): string {
    throw new Error("midden WASM is not available in this build");
  }

  secret_key(): Uint8Array {
    throw new Error("midden WASM is not available in this build");
  }

  async open_bi(_peer_addr: string, _alpn: string): Promise<never> {
    throw new Error("midden WASM is not available in this build");
  }

  async accept(): Promise<never> {
    throw new Error("midden WASM is not available in this build");
  }
}

export class MiddenNodeOptions {
  secret_key: Uint8Array | undefined;
  extra_alpns: string[] | undefined;
  opfs_store_dir: string | undefined;
  connect_timeout_ms: number | undefined;
}

export class CancelToken {
  cancel(): void {
    throw new Error("midden WASM is not available in this build");
  }

  clone_token(): CancelToken {
    throw new Error("midden WASM is not available in this build");
  }

  is_cancelled(): boolean {
    throw new Error("midden WASM is not available in this build");
  }

  free(): void {
    // no-op: nothing was allocated
  }
}

export class Blake3Hasher {
  update(_chunk: Uint8Array): void {
    throw new Error("midden WASM is not available in this build");
  }

  finalize(): string {
    throw new Error("midden WASM is not available in this build");
  }

  free(): void {
    // no-op: nothing was allocated
  }
}

export function hash_blake3(_data: Uint8Array): string {
  throw new Error("midden WASM is not available in this build");
}

export async function opfs_store_selftest(): Promise<string> {
  throw new Error("midden WASM is not available in this build");
}

export async function opfs_store_selftest_persistence(): Promise<string> {
  throw new Error("midden WASM is not available in this build");
}
