// ---------------------------------------------------------------------------
// unit tests for AclFilteringNetworkAdapter
// ---------------------------------------------------------------------------

import { beforeEach, describe, expect, it, vi } from "vitest";
import * as Automerge from "@automerge/automerge";
import { NetworkAdapter, type DocumentId, type Message, type PeerId } from "@automerge/automerge-repo";

import { AclFilteringNetworkAdapter, createRepoRoleResolver, type RoleResolver } from "./acl-filtering-network-adapter";

// ---------------------------------------------------------------------------
// mock: a minimal NetworkAdapter we can drive by hand and spy on.
// ---------------------------------------------------------------------------

class MockAdapter extends NetworkAdapter {
  isReady = vi.fn(() => true);
  whenReady = vi.fn(async () => {});
  connect = vi.fn();
  send = vi.fn();
  disconnect = vi.fn();
}

// ---------------------------------------------------------------------------
// helpers: build real automerge sync messages so decode/encode round-trips
// through genuine wasm data, not synthetic garbage bytes (which can hang the
// wasm decoder instead of throwing).
// ---------------------------------------------------------------------------

const DOC_ID = "doc-1" as DocumentId;
const VIEWER_ID = "viewer-peer" as PeerId;
const MEMBER_ID = "member-peer" as PeerId;
const LOCAL_ID = "local-peer" as PeerId;

/**
 * run a two-doc sync handshake far enough that the final message from doc1
 * to doc2 actually carries a change (automerge's first couple of sync
 * messages are just heads/have/need — the change payload only shows up
 * once both sides have exchanged state at least once).
 */
function buildSyncMessageWithChange(): Uint8Array {
  let doc1 = Automerge.from({ foo: "bar" });
  let doc2 = Automerge.init<{ foo: string }>();
  let s1 = Automerge.initSyncState();
  let s2 = Automerge.initSyncState();

  const [ns1, msg1] = Automerge.generateSyncMessage(doc1, s1);
  s1 = ns1;
  [doc2, s2] = Automerge.receiveSyncMessage(doc2, s2, msg1!);

  const [ns2, msg2] = Automerge.generateSyncMessage(doc2, s2);
  s2 = ns2;
  [doc1, s1] = Automerge.receiveSyncMessage(doc1, s1, msg2!);

  const [, msg3] = Automerge.generateSyncMessage(doc1, s1);
  return msg3!;
}

function buildSyncMessageWithoutChange(): Uint8Array {
  const doc1 = Automerge.from({ foo: "bar" });
  const s1 = Automerge.initSyncState();
  const [, msg1] = Automerge.generateSyncMessage(doc1, s1);
  return msg1!;
}

function makeSyncMessage(data: Uint8Array, senderId: PeerId, type: "sync" | "request" = "sync"): Message {
  return {
    type,
    senderId,
    targetId: LOCAL_ID,
    documentId: DOC_ID,
    data,
  } as Message;
}

describe("AclFilteringNetworkAdapter", () => {
  let wrapped: MockAdapter;
  let roleResolver: RoleResolver;
  let adapter: AclFilteringNetworkAdapter;

  beforeEach(() => {
    wrapped = new MockAdapter();
    roleResolver = vi.fn(() => "member" as const);
    adapter = new AclFilteringNetworkAdapter(wrapped, roleResolver);
  });

  // -----------------------------------------------------------------------
  // lifecycle proxying
  // -----------------------------------------------------------------------

  describe("lifecycle proxying", () => {
    it("proxies connect() to the wrapped adapter", () => {
      const meta = { isEphemeral: false };
      adapter.connect(LOCAL_ID, meta);

      expect(wrapped.connect).toHaveBeenCalledWith(LOCAL_ID, meta);
      expect(adapter.peerId).toBe(LOCAL_ID);
      expect(adapter.peerMetadata).toBe(meta);
    });

    it("proxies send() to the wrapped adapter unchanged", () => {
      const message = makeSyncMessage(new Uint8Array([1, 2, 3]), MEMBER_ID);
      adapter.send(message);

      expect(wrapped.send).toHaveBeenCalledWith(message);
    });

    it("proxies disconnect() to the wrapped adapter", () => {
      adapter.disconnect();
      expect(wrapped.disconnect).toHaveBeenCalled();
    });

    it("proxies isReady() and whenReady() to the wrapped adapter", async () => {
      wrapped.isReady.mockReturnValue(false);
      expect(adapter.isReady()).toBe(false);

      wrapped.isReady.mockReturnValue(true);
      expect(adapter.isReady()).toBe(true);

      await adapter.whenReady();
      expect(wrapped.whenReady).toHaveBeenCalled();
    });
  });

  // -----------------------------------------------------------------------
  // event re-emission
  // -----------------------------------------------------------------------

  describe("event re-emission", () => {
    it("re-emits peer-candidate from the wrapped adapter unchanged", () => {
      const listener = vi.fn();
      adapter.on("peer-candidate", listener);

      const payload = { peerId: MEMBER_ID, peerMetadata: {} };
      wrapped.emit("peer-candidate", payload);

      expect(listener).toHaveBeenCalledWith(payload);
    });

    it("re-emits peer-disconnected from the wrapped adapter unchanged", () => {
      const listener = vi.fn();
      adapter.on("peer-disconnected", listener);

      const payload = { peerId: MEMBER_ID };
      wrapped.emit("peer-disconnected", payload);

      expect(listener).toHaveBeenCalledWith(payload);
    });

    it("re-emits close from the wrapped adapter", () => {
      const listener = vi.fn();
      adapter.on("close", listener);

      wrapped.emit("close");

      expect(listener).toHaveBeenCalled();
    });
  });

  // -----------------------------------------------------------------------
  // message filtering
  // -----------------------------------------------------------------------

  describe("message filtering", () => {
    it("passes non-sync/request message types through completely unchanged", () => {
      roleResolver = vi.fn(() => "viewer" as const);
      adapter = new AclFilteringNetworkAdapter(wrapped, roleResolver);

      const listener = vi.fn();
      adapter.on("message", listener);

      const ephemeralMessage = {
        type: "ephemeral",
        senderId: VIEWER_ID,
        targetId: LOCAL_ID,
        documentId: DOC_ID,
        data: new Uint8Array([9, 9, 9]),
      } as unknown as Message;

      wrapped.emit("message", ephemeralMessage);

      expect(listener).toHaveBeenCalledWith(ephemeralMessage);
      expect(roleResolver).not.toHaveBeenCalled();
    });

    it("passes sync messages through unchanged for a member sender", () => {
      roleResolver = vi.fn(() => "member" as const);
      adapter = new AclFilteringNetworkAdapter(wrapped, roleResolver);

      const listener = vi.fn();
      adapter.on("message", listener);

      const message = makeSyncMessage(buildSyncMessageWithChange(), MEMBER_ID);
      wrapped.emit("message", message);

      expect(listener).toHaveBeenCalledWith(message);
    });

    it("passes sync messages through unchanged for an admin sender", () => {
      roleResolver = vi.fn(() => "admin" as const);
      adapter = new AclFilteringNetworkAdapter(wrapped, roleResolver);

      const listener = vi.fn();
      adapter.on("message", listener);

      const message = makeSyncMessage(buildSyncMessageWithChange(), MEMBER_ID);
      wrapped.emit("message", message);

      expect(listener).toHaveBeenCalledWith(message);
    });

    it("strips changes from a viewer sender's sync message, preserving heads/need/have", () => {
      roleResolver = vi.fn(() => "viewer" as const);
      adapter = new AclFilteringNetworkAdapter(wrapped, roleResolver);

      const listener = vi.fn();
      adapter.on("message", listener);

      const rawData = buildSyncMessageWithChange();
      const originalDecoded = Automerge.decodeSyncMessage(rawData);
      expect(originalDecoded.changes.length).toBeGreaterThan(0);

      const message = makeSyncMessage(rawData, VIEWER_ID);
      wrapped.emit("message", message);

      expect(listener).toHaveBeenCalledTimes(1);
      const emitted = listener.mock.calls[0][0] as Message;

      // not the same object/bytes as the original — it was re-encoded.
      expect(emitted).not.toBe(message);
      expect(emitted.data).not.toBe(rawData);

      const filteredDecoded = Automerge.decodeSyncMessage(emitted.data!);
      expect(filteredDecoded.changes).toHaveLength(0);
      expect(filteredDecoded.heads).toEqual(originalDecoded.heads);
      expect(filteredDecoded.need).toEqual(originalDecoded.need);
      expect(filteredDecoded.have).toEqual(originalDecoded.have);
    });

    it("strips changes from a viewer sender's request message the same way as sync", () => {
      roleResolver = vi.fn(() => "viewer" as const);
      adapter = new AclFilteringNetworkAdapter(wrapped, roleResolver);

      const listener = vi.fn();
      adapter.on("message", listener);

      const rawData = buildSyncMessageWithChange();
      const message = makeSyncMessage(rawData, VIEWER_ID, "request");
      wrapped.emit("message", message);

      const emitted = listener.mock.calls[0][0] as Message;
      expect(Automerge.decodeSyncMessage(emitted.data!).changes).toHaveLength(0);
    });

    it("passes a viewer's sync message through unchanged when it carries no changes", () => {
      roleResolver = vi.fn(() => "viewer" as const);
      adapter = new AclFilteringNetworkAdapter(wrapped, roleResolver);

      const listener = vi.fn();
      adapter.on("message", listener);

      const message = makeSyncMessage(buildSyncMessageWithoutChange(), VIEWER_ID);
      wrapped.emit("message", message);

      expect(listener).toHaveBeenCalledWith(message);
    });

    it("passes messages through unchanged when documentId or data is missing", () => {
      const listener = vi.fn();
      adapter.on("message", listener);

      const message = {
        type: "sync",
        senderId: VIEWER_ID,
        targetId: LOCAL_ID,
      } as unknown as Message;

      wrapped.emit("message", message);

      expect(listener).toHaveBeenCalledWith(message);
      expect(roleResolver).not.toHaveBeenCalled();
    });

    it("calls the roleResolver with the message's documentId and senderId", () => {
      const message = makeSyncMessage(buildSyncMessageWithChange(), MEMBER_ID);
      wrapped.emit("message", message);

      expect(roleResolver).toHaveBeenCalledWith(DOC_ID, MEMBER_ID);
    });
  });
});

// ---------------------------------------------------------------------------
// createRepoRoleResolver
// ---------------------------------------------------------------------------

describe("createRepoRoleResolver", () => {
  function makeFakeRepo(handles: Record<string, { isReady: () => boolean; doc: () => unknown }>) {
    return { handles } as unknown as import("@automerge/automerge-repo").Repo;
  }

  it("defaults to member when the repo has no cached handle for the document", () => {
    const repo = makeFakeRepo({});
    const resolver = createRepoRoleResolver(repo);

    expect(resolver(DOC_ID, MEMBER_ID)).toBe("member");
  });

  it("defaults to member when the cached handle isn't ready yet", () => {
    const repo = makeFakeRepo({
      [DOC_ID]: { isReady: () => false, doc: () => ({}) },
    });
    const resolver = createRepoRoleResolver(repo);

    expect(resolver(DOC_ID, MEMBER_ID)).toBe("member");
  });

  it("reads the role out of the cached doc's acl", () => {
    const repo = makeFakeRepo({
      [DOC_ID]: {
        isReady: () => true,
        doc: () => ({ acl: { [VIEWER_ID]: { role: "viewer" } } }),
      },
    });
    const resolver = createRepoRoleResolver(repo);

    expect(resolver(DOC_ID, VIEWER_ID)).toBe("viewer");
  });

  it("defaults to member for a peer with no acl entry", () => {
    const repo = makeFakeRepo({
      [DOC_ID]: {
        isReady: () => true,
        doc: () => ({ acl: { [VIEWER_ID]: { role: "viewer" } } }),
      },
    });
    const resolver = createRepoRoleResolver(repo);

    expect(resolver(DOC_ID, MEMBER_ID)).toBe("member");
  });

  it("defaults to member for an invalid/garbage role value", () => {
    const repo = makeFakeRepo({
      [DOC_ID]: {
        isReady: () => true,
        doc: () => ({ acl: { [MEMBER_ID]: { role: "super-admin" } } }),
      },
    });
    const resolver = createRepoRoleResolver(repo);

    expect(resolver(DOC_ID, MEMBER_ID)).toBe("member");
  });
});
