// ---------------------------------------------------------------------------
// unit tests for skein's canvas-role acl-filtering wiring
//
// the message-filtering mechanism itself (strip changes from a read-only
// sender's sync/request messages, preserve heads/need/have, proxy every
// other lifecycle event/method unchanged) is @freqhole/reliquary/automerge's
// AclFilteringNetworkAdapter and is covered by that package's own test
// suite. this file covers only what's specific to skein: reading a peer's
// canvas role out of a document's `.acl` field (readCanvasRole), which
// canvas role is read-only (isReadOnlyCanvasRole), and wiring both into a
// repo-backed role resolver (createRepoRoleResolver).
// ---------------------------------------------------------------------------

import { describe, expect, it } from "vitest";
import type { DocumentId, PeerId } from "@automerge/automerge-repo";

import {
  createRepoRoleResolver,
  isReadOnlyCanvasRole,
  readCanvasRole,
} from "./acl-filtering-network-adapter";

const DOC_ID = "doc-1" as DocumentId;
const VIEWER_ID = "viewer-peer" as PeerId;
const MEMBER_ID = "member-peer" as PeerId;
const ADMIN_ID = "admin-peer" as PeerId;

describe("isReadOnlyCanvasRole", () => {
  it("treats viewer as read-only", () => {
    expect(isReadOnlyCanvasRole("viewer")).toBe(true);
  });

  it("treats member and admin as writable", () => {
    expect(isReadOnlyCanvasRole("member")).toBe(false);
    expect(isReadOnlyCanvasRole("admin")).toBe(false);
  });
});

describe("readCanvasRole", () => {
  it("reads the role out of the doc's acl for a given sender", () => {
    const doc = { acl: { [VIEWER_ID]: { role: "viewer" } } };
    expect(readCanvasRole(doc, VIEWER_ID)).toBe("viewer");
  });

  it("reads admin and member roles the same way", () => {
    const doc = {
      acl: { [ADMIN_ID]: { role: "admin" }, [MEMBER_ID]: { role: "member" } },
    };
    expect(readCanvasRole(doc, ADMIN_ID)).toBe("admin");
    expect(readCanvasRole(doc, MEMBER_ID)).toBe("member");
  });

  it("defaults to viewer for a peer with no acl entry", () => {
    const doc = { acl: { [VIEWER_ID]: { role: "viewer" } } };
    expect(readCanvasRole(doc, MEMBER_ID)).toBe("viewer");
  });

  it("defaults to viewer for an invalid/garbage role value", () => {
    const doc = { acl: { [MEMBER_ID]: { role: "super-admin" } } };
    expect(readCanvasRole(doc, MEMBER_ID)).toBe("viewer");
  });

  it("defaults to viewer when the doc has no acl field at all", () => {
    expect(readCanvasRole({}, MEMBER_ID)).toBe("viewer");
  });

  it("defaults to viewer when the doc itself is undefined", () => {
    expect(readCanvasRole(undefined, MEMBER_ID)).toBe("viewer");
  });
});

describe("createRepoRoleResolver", () => {
  function makeFakeRepo(handles: Record<string, { isReady: () => boolean; doc: () => unknown }>) {
    return { handles } as unknown as import("@automerge/automerge-repo").Repo;
  }

  it("defaults to viewer when the repo has no cached handle for the document", () => {
    const repo = makeFakeRepo({});
    const resolver = createRepoRoleResolver(repo);

    expect(resolver(DOC_ID, MEMBER_ID)).toBe("viewer");
  });

  it("defaults to viewer when the cached handle isn't ready yet", () => {
    const repo = makeFakeRepo({
      [DOC_ID]: { isReady: () => false, doc: () => ({}) },
    });
    const resolver = createRepoRoleResolver(repo);

    expect(resolver(DOC_ID, MEMBER_ID)).toBe("viewer");
  });

  it("reads the role out of the cached doc's acl once the handle is ready", () => {
    const repo = makeFakeRepo({
      [DOC_ID]: {
        isReady: () => true,
        doc: () => ({ acl: { [VIEWER_ID]: { role: "viewer" } } }),
      },
    });
    const resolver = createRepoRoleResolver(repo);

    expect(resolver(DOC_ID, VIEWER_ID)).toBe("viewer");
  });

  it("defaults to viewer for a peer with no acl entry on the cached doc", () => {
    const repo = makeFakeRepo({
      [DOC_ID]: {
        isReady: () => true,
        doc: () => ({ acl: { [VIEWER_ID]: { role: "viewer" } } }),
      },
    });
    const resolver = createRepoRoleResolver(repo);

    expect(resolver(DOC_ID, MEMBER_ID)).toBe("viewer");
  });

  it("defaults to viewer for an invalid/garbage role value on the cached doc", () => {
    const repo = makeFakeRepo({
      [DOC_ID]: {
        isReady: () => true,
        doc: () => ({ acl: { [MEMBER_ID]: { role: "super-admin" } } }),
      },
    });
    const resolver = createRepoRoleResolver(repo);

    expect(resolver(DOC_ID, MEMBER_ID)).toBe("viewer");
  });
});
