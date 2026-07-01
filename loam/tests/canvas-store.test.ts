import { expect, test } from "./fixtures/canvas-page";

// ---------------------------------------------------------------------------
// helper — add a widget to the store with a known id
// ---------------------------------------------------------------------------

async function addW(
  page: import("@playwright/test").Page,
  id: string,
  overrides: Partial<{ x: number; y: number; zIndex: number; type: string }> = {}
): Promise<void> {
  await page.evaluate(
    ([wid, ov]) => {
      (window as any).__skein.store.addWidget({
        id: wid,
        type: ov.type ?? "hello-world",
        x: ov.x ?? 100,
        y: ov.y ?? 100,
        width: 200,
        height: 100,
        zIndex: ov.zIndex ?? 0,
        props: {},
        collapsed: false,
        docId: null,
        parentId: null,
      });
    },
    [id, overrides] as const
  );
}

// ---------------------------------------------------------------------------
// layer ordering
// ---------------------------------------------------------------------------

test("getLayerInfo returns position and total for each widget", async ({ canvasPage }) => {
  const { page } = await canvasPage();

  await addW(page, "w-a", { zIndex: 0 });
  await addW(page, "w-b", { zIndex: 1 });
  await addW(page, "w-c", { zIndex: 2 });

  const infoA = await page.evaluate(() => (window as any).__skein.store.getLayerInfo("w-a"));
  const infoC = await page.evaluate(() => (window as any).__skein.store.getLayerInfo("w-c"));

  expect(infoA.position).toBe(0);
  expect(infoA.total).toBe(3);
  expect(infoC.position).toBe(2);
  expect(infoC.total).toBe(3);
});

test("bringToFront moves the widget to the highest layer", async ({ canvasPage }) => {
  const { page } = await canvasPage();

  await addW(page, "w-a", { zIndex: 0 });
  await addW(page, "w-b", { zIndex: 1 });
  await addW(page, "w-c", { zIndex: 2 });

  await page.evaluate(() => (window as any).__skein.store.bringToFront("w-a"));

  const info = await page.evaluate(() => (window as any).__skein.store.getLayerInfo("w-a"));
  expect(info.position).toBe(2);
});

test("sendToBack moves the widget to position 0", async ({ canvasPage }) => {
  const { page } = await canvasPage();

  await addW(page, "w-a", { zIndex: 0 });
  await addW(page, "w-b", { zIndex: 1 });
  await addW(page, "w-c", { zIndex: 2 });

  await page.evaluate(() => (window as any).__skein.store.sendToBack("w-c"));

  const info = await page.evaluate(() => (window as any).__skein.store.getLayerInfo("w-c"));
  expect(info.position).toBe(0);
});

test("bringForward swaps widget with the one above", async ({ canvasPage }) => {
  const { page } = await canvasPage();

  await addW(page, "w-a", { zIndex: 0 });
  await addW(page, "w-b", { zIndex: 1 });
  await addW(page, "w-c", { zIndex: 2 });

  // w-a starts at position 0; after bringForward it should be at 1
  await page.evaluate(() => (window as any).__skein.store.bringForward("w-a"));

  const info = await page.evaluate(() => (window as any).__skein.store.getLayerInfo("w-a"));
  expect(info.position).toBe(1);
});

test("sendBackward swaps widget with the one below", async ({ canvasPage }) => {
  const { page } = await canvasPage();

  await addW(page, "w-a", { zIndex: 0 });
  await addW(page, "w-b", { zIndex: 1 });
  await addW(page, "w-c", { zIndex: 2 });

  // w-c starts at position 2; after sendBackward it should be at 1
  await page.evaluate(() => (window as any).__skein.store.sendBackward("w-c"));

  const info = await page.evaluate(() => (window as any).__skein.store.getLayerInfo("w-c"));
  expect(info.position).toBe(1);
});

test("bringToFront is a no-op on the already top widget", async ({ canvasPage }) => {
  const { page } = await canvasPage();

  await addW(page, "w-a", { zIndex: 0 });
  await addW(page, "w-b", { zIndex: 1 });

  await page.evaluate(() => (window as any).__skein.store.bringToFront("w-b"));

  const info = await page.evaluate(() => (window as any).__skein.store.getLayerInfo("w-b"));
  expect(info.position).toBe(1); // still at top
});

// ---------------------------------------------------------------------------
// canvas metadata
// ---------------------------------------------------------------------------

test("setTitle updates the canvas title", async ({ canvasPage }) => {
  const { page } = await canvasPage();

  await page.evaluate(() => (window as any).__skein.store.setTitle("my test canvas"));

  const meta = await page.evaluate(() => (window as any).__skein.store.metadata());
  expect(meta.title).toBe("my test canvas");
  expect(meta.lastModified).toBeTruthy();
});

test("setDescription updates the canvas description", async ({ canvasPage }) => {
  const { page } = await canvasPage();

  await page.evaluate(() => (window as any).__skein.store.setDescription("a description"));

  const meta = await page.evaluate(() => (window as any).__skein.store.metadata());
  expect(meta.description).toBe("a description");
});

test("setColor stores a numeric color value", async ({ canvasPage }) => {
  const { page } = await canvasPage();

  await page.evaluate(() => (window as any).__skein.store.setColor(0xd946ef));

  const meta = await page.evaluate(() => (window as any).__skein.store.metadata());
  expect(meta.color).toBe(0xd946ef);
});

test("setPreviewUrl stores a url string", async ({ canvasPage }) => {
  const { page } = await canvasPage();

  await page.evaluate(() =>
    (window as any).__skein.store.setPreviewUrl("data:image/png;base64,abc")
  );

  const meta = await page.evaluate(() => (window as any).__skein.store.metadata());
  expect(meta.previewUrl).toBe("data:image/png;base64,abc");
});

test("setCreatedAt stamps createdAt and lastModified", async ({ canvasPage }) => {
  const { page } = await canvasPage();

  await page.evaluate(() =>
    (window as any).__skein.store.setCreatedAt("2024-06-01T00:00:00.000Z")
  );

  const meta = await page.evaluate(() => (window as any).__skein.store.metadata());
  expect(meta.createdAt).toBe("2024-06-01T00:00:00.000Z");
  expect(meta.lastModified).toBe("2024-06-01T00:00:00.000Z");
});

// ---------------------------------------------------------------------------
// widget properties
// ---------------------------------------------------------------------------

test("setCollapsed sets the collapsed flag", async ({ canvasPage }) => {
  const { page } = await canvasPage();

  await addW(page, "collapsible");

  await page.evaluate(() => (window as any).__skein.store.setCollapsed("collapsible", true));

  const w = await page.evaluate(() => (window as any).__skein.store.getWidget("collapsible"));
  expect(w.collapsed).toBe(true);

  await page.evaluate(() => (window as any).__skein.store.setCollapsed("collapsible", false));
  const w2 = await page.evaluate(() => (window as any).__skein.store.getWidget("collapsible"));
  expect(w2.collapsed).toBe(false);
});

test("setWidgetTitle updates the display title", async ({ canvasPage }) => {
  const { page } = await canvasPage();

  await addW(page, "titled-widget");

  await page.evaluate(() =>
    (window as any).__skein.store.setWidgetTitle("titled-widget", "my title")
  );

  const w = await page.evaluate(() => (window as any).__skein.store.getWidget("titled-widget"));
  expect(w.title).toBe("my title");
});

test("setDocId links a per-widget automerge doc", async ({ canvasPage }) => {
  const { page } = await canvasPage();

  await addW(page, "doc-linked");

  await page.evaluate(() =>
    (window as any).__skein.store.setDocId("doc-linked", "abc123docid")
  );

  const w = await page.evaluate(() => (window as any).__skein.store.getWidget("doc-linked"));
  expect(w.docId).toBe("abc123docid");
});

test("allWidgets returns all widget entries as an array", async ({ canvasPage }) => {
  const { page } = await canvasPage();

  await addW(page, "all-1");
  await addW(page, "all-2");
  await addW(page, "all-3");

  const all = await page.evaluate(() => (window as any).__skein.store.allWidgets());
  expect(all).toHaveLength(3);
  const ids = all.map((w: any) => w.id).sort();
  expect(ids).toEqual(["all-1", "all-2", "all-3"]);
});

// ---------------------------------------------------------------------------
// parent / nesting
// ---------------------------------------------------------------------------

test("setParentId nests a widget under a parent", async ({ canvasPage }) => {
  const { page } = await canvasPage();

  await addW(page, "parent-widget");
  await addW(page, "child-widget");

  await page.evaluate(() =>
    (window as any).__skein.store.setParentId("child-widget", "parent-widget")
  );

  const children = await page.evaluate(() =>
    (window as any).__skein.store.getChildren("parent-widget")
  );
  expect(children).toHaveLength(1);
  expect(children[0].id).toBe("child-widget");
});

test("setParentId with null un-nests a widget", async ({ canvasPage }) => {
  const { page } = await canvasPage();

  await addW(page, "p-w");
  await addW(page, "c-w");

  // nest then un-nest
  await page.evaluate(() => (window as any).__skein.store.setParentId("c-w", "p-w"));
  await page.evaluate(() => (window as any).__skein.store.setParentId("c-w", null));

  const children = await page.evaluate(() =>
    (window as any).__skein.store.getChildren("p-w")
  );
  expect(children).toHaveLength(0);
});

test("unparentAndMove clears parent and updates position atomically", async ({ canvasPage }) => {
  const { page } = await canvasPage();

  await addW(page, "container");
  await addW(page, "item");

  await page.evaluate(() => (window as any).__skein.store.setParentId("item", "container"));
  await page.evaluate(() =>
    (window as any).__skein.store.unparentAndMove("item", 500, 600)
  );

  const w = await page.evaluate(() => (window as any).__skein.store.getWidget("item"));
  expect(w.parentId).toBeNull();
  expect(w.x).toBe(500);
  expect(w.y).toBe(600);
});

test("getChildren returns empty array for widget with no children", async ({ canvasPage }) => {
  const { page } = await canvasPage();

  await addW(page, "lonely");

  const children = await page.evaluate(() =>
    (window as any).__skein.store.getChildren("lonely")
  );
  expect(children).toHaveLength(0);
});

// ---------------------------------------------------------------------------
// peer tracking
// ---------------------------------------------------------------------------

test("addPeer registers a node ID in the canvas document", async ({ canvasPage }) => {
  const { page } = await canvasPage();

  await page.evaluate(() => (window as any).__skein.store.addPeer("peer-node-abc"));

  const peers = await page.evaluate(() => (window as any).__skein.store.peers());
  expect(peers["peer-node-abc"]).toBeDefined();
  expect(peers["peer-node-abc"].nodeId).toBe("peer-node-abc");
  expect(peers["peer-node-abc"].joinedAt).toBeTruthy();
});

test("addPeer is idempotent — second call is a no-op", async ({ canvasPage }) => {
  const { page } = await canvasPage();

  await page.evaluate(() => (window as any).__skein.store.addPeer("dup-peer"));
  await page.evaluate(() => (window as any).__skein.store.addPeer("dup-peer"));

  const peers = await page.evaluate(() => (window as any).__skein.store.peers());
  const keys = Object.keys(peers).filter((k) => k === "dup-peer");
  expect(keys).toHaveLength(1);
});

test("removePeer removes the entry from peers", async ({ canvasPage }) => {
  const { page } = await canvasPage();

  await page.evaluate(() => (window as any).__skein.store.addPeer("to-remove-peer"));
  await page.evaluate(() => (window as any).__skein.store.removePeer("to-remove-peer"));

  const peers = await page.evaluate(() => (window as any).__skein.store.peers());
  expect(peers["to-remove-peer"]).toBeUndefined();
});

test("stampLastSeen updates the lastSeenAt timestamp for local node", async ({ canvasPage }) => {
  const { page } = await canvasPage();

  // register local node ID and add the peer entry first
  await page.evaluate(() => {
    const store = (window as any).__skein.store;
    store.setLocalNodeId("local-node-id");
    store.addPeer("local-node-id");
  });

  const before = await page.evaluate(() => {
    return (window as any).__skein.store.peers()["local-node-id"]?.lastSeenAt ?? null;
  });
  expect(before).toBeNull(); // not set yet

  await page.evaluate(() => (window as any).__skein.store.stampLastSeen());

  const after = await page.evaluate(() => {
    return (window as any).__skein.store.peers()["local-node-id"]?.lastSeenAt ?? null;
  });
  expect(after).toBeTruthy();
});

// ---------------------------------------------------------------------------
// pending invites
// ---------------------------------------------------------------------------

test("addPendingInvite writes invite into the document", async ({ canvasPage }) => {
  const { page } = await canvasPage();

  await page.evaluate(() => {
    (window as any).__skein.store.addPendingInvite("target-node-id", {
      invitedBy: "owner-node-id",
      invitedByUsername: "alice",
      role: "member",
      invitedAt: "2024-06-01T00:00:00.000Z",
    });
  });

  const invites = await page.evaluate(() => (window as any).__skein.store.pendingInvites());
  expect(invites["target-node-id"]).toBeDefined();
  expect(invites["target-node-id"].role).toBe("member");
  expect(invites["target-node-id"].invitedByUsername).toBe("alice");
});

test("removePendingInvite removes the entry", async ({ canvasPage }) => {
  const { page } = await canvasPage();

  await page.evaluate(() => {
    (window as any).__skein.store.addPendingInvite("invite-target", {
      invitedBy: "owner",
      invitedByUsername: "bob",
      role: "viewer",
      invitedAt: "2024-06-01T00:00:00.000Z",
    });
  });

  await page.evaluate(() => (window as any).__skein.store.removePendingInvite("invite-target"));

  const invites = await page.evaluate(() => (window as any).__skein.store.pendingInvites());
  expect(invites["invite-target"]).toBeUndefined();
});

test("markInviteAccepted sets accepted + acceptedAt without removing the entry", async ({
  canvasPage,
}) => {
  const { page } = await canvasPage();

  await page.evaluate(() => {
    (window as any).__skein.store.addPendingInvite("accepter-node", {
      invitedBy: "owner",
      invitedByUsername: "bob",
      role: "member",
      invitedAt: "2024-06-01T00:00:00.000Z",
    });
  });

  await page.evaluate(() => (window as any).__skein.store.markInviteAccepted("accepter-node"));

  const invite = await page.evaluate(
    () => (window as any).__skein.store.pendingInvites()["accepter-node"]
  );
  expect(invite).toBeDefined();
  expect(invite.accepted).toBe(true);
  expect(invite.acceptedAt).toBeTruthy();
});

test("markInviteAccepted is a no-op for a nonexistent invite", async ({ canvasPage }) => {
  const { page } = await canvasPage();

  await page.evaluate(() => (window as any).__skein.store.markInviteAccepted("no-such-node"));

  const invites = await page.evaluate(() => (window as any).__skein.store.pendingInvites());
  expect(invites["no-such-node"]).toBeUndefined();
});

test("pendingInvites returns empty object on a fresh canvas", async ({ canvasPage }) => {
  const { page } = await canvasPage();

  const invites = await page.evaluate(() => (window as any).__skein.store.pendingInvites());
  expect(invites).toEqual({});
});

// ---------------------------------------------------------------------------
// access control (ACL)
// ---------------------------------------------------------------------------

test("getRole defaults to member when no acl entry exists", async ({ canvasPage }) => {
  const { page } = await canvasPage();

  const role = await page.evaluate(() => (window as any).__skein.store.getRole("unknown-node"));
  expect(role).toBe("member");
});

test("stampAdmin records the admin role", async ({ canvasPage }) => {
  const { page } = await canvasPage();

  await page.evaluate(() => (window as any).__skein.store.stampAdmin("admin-node"));

  const role = await page.evaluate(() => (window as any).__skein.store.getRole("admin-node"));
  expect(role).toBe("admin");
});

test("stampAdmin is a no-op if an admin is already recorded", async ({ canvasPage }) => {
  const { page } = await canvasPage();

  await page.evaluate(() => (window as any).__skein.store.stampAdmin("first-admin"));
  await page.evaluate(() => (window as any).__skein.store.stampAdmin("second-admin"));

  const roles = await page.evaluate(() => {
    const store = (window as any).__skein.store;
    return { first: store.getRole("first-admin"), second: store.getRole("second-admin") };
  });
  expect(roles.first).toBe("admin");
  expect(roles.second).toBe("member"); // unaffected — default, no acl entry written
});

test("setRole assigns member or viewer to a peer", async ({ canvasPage }) => {
  const { page } = await canvasPage();

  await page.evaluate(() => (window as any).__skein.store.setRole("peer-1", "viewer"));
  await page.evaluate(() => (window as any).__skein.store.setRole("peer-2", "member"));

  const roles = await page.evaluate(() => {
    const store = (window as any).__skein.store;
    return { peer1: store.getRole("peer-1"), peer2: store.getRole("peer-2") };
  });
  expect(roles.peer1).toBe("viewer");
  expect(roles.peer2).toBe("member");
});

test("setRole can change an already-assigned peer's role", async ({ canvasPage }) => {
  const { page } = await canvasPage();

  await page.evaluate(() => (window as any).__skein.store.setRole("peer-1", "member"));
  await page.evaluate(() => (window as any).__skein.store.setRole("peer-1", "viewer"));

  const role = await page.evaluate(() => (window as any).__skein.store.getRole("peer-1"));
  expect(role).toBe("viewer");
});

test("setRole cannot demote an admin", async ({ canvasPage }) => {
  const { page } = await canvasPage();

  await page.evaluate(() => (window as any).__skein.store.stampAdmin("admin-node"));
  await page.evaluate(() => (window as any).__skein.store.setRole("admin-node", "viewer"));

  const role = await page.evaluate(() => (window as any).__skein.store.getRole("admin-node"));
  expect(role).toBe("admin");
});

test("isViewer reflects the viewer role", async ({ canvasPage }) => {
  const { page } = await canvasPage();

  await page.evaluate(() => (window as any).__skein.store.setRole("viewer-node", "viewer"));

  const results = await page.evaluate(() => {
    const store = (window as any).__skein.store;
    return {
      viewer: store.isViewer("viewer-node"),
      unknown: store.isViewer("unknown-node"),
    };
  });
  expect(results.viewer).toBe(true);
  expect(results.unknown).toBe(false); // defaults to member, not viewer
});

test("isAdmin reflects the admin role", async ({ canvasPage }) => {
  const { page } = await canvasPage();

  await page.evaluate(() => (window as any).__skein.store.stampAdmin("admin-node"));

  const results = await page.evaluate(() => {
    const store = (window as any).__skein.store;
    return {
      admin: store.isAdmin("admin-node"),
      unknown: store.isAdmin("unknown-node"),
    };
  });
  expect(results.admin).toBe(true);
  expect(results.unknown).toBe(false); // defaults to member, not admin
});

test("localRole/isLocalViewer/isLocalAdmin reflect the local peer's role", async ({
  canvasPage,
}) => {
  const { page } = await canvasPage();

  await page.evaluate(() => {
    const store = (window as any).__skein.store;
    store.stampAdmin("local-node-id");
    store.setLocalNodeId("local-node-id");
  });

  const asAdmin = await page.evaluate(() => {
    const store = (window as any).__skein.store;
    return {
      role: store.localRole(),
      isViewer: store.isLocalViewer(),
      isAdmin: store.isLocalAdmin(),
    };
  });
  expect(asAdmin).toEqual({ role: "admin", isViewer: false, isAdmin: true });

  await page.evaluate(() => {
    const store = (window as any).__skein.store;
    store.setRole("viewer-node-id", "viewer");
    store.setLocalNodeId("viewer-node-id");
  });

  const asViewer = await page.evaluate(() => {
    const store = (window as any).__skein.store;
    return {
      role: store.localRole(),
      isViewer: store.isLocalViewer(),
      isAdmin: store.isLocalAdmin(),
    };
  });
  expect(asViewer).toEqual({ role: "viewer", isViewer: true, isAdmin: false });
});

test("getRole safely falls back to member for an invalid/corrupted role value", async ({
  canvasPage,
}) => {
  const { page } = await canvasPage();

  // simulate a stale peer (pre-rename code) or corrupted sync data writing
  // an unrecognized role string directly into the doc, bypassing setRole()'s
  // normal guards — getRole() must not trust this blindly (see the security
  // note on getRole() in canvas-store.ts).
  await page.evaluate(() => {
    (window as any).__skein.store.handle.change((doc: any) => {
      doc.acl = { "bad-node": { role: "hacker" } };
    });
  });

  const role = await page.evaluate(() => (window as any).__skein.store.getRole("bad-node"));
  expect(role).toBe("member");
});

// ---------------------------------------------------------------------------
// canvas deletion lifecycle
// ---------------------------------------------------------------------------

test("canvas is not deleted by default", async ({ canvasPage }) => {
  const { page } = await canvasPage();

  const deleted = await page.evaluate(() => (window as any).__skein.store.isDeleted);
  expect(deleted).toBe(false);
});

test("deleteCanvas sets the deleted tombstone (soft)", async ({ canvasPage }) => {
  const { page } = await canvasPage();

  await page.evaluate(() => (window as any).__skein.store.deleteCanvas("soft"));

  const meta = await page.evaluate(() => (window as any).__skein.store.metadata());
  expect(meta.deleted).toBe(true);
  expect(meta.deleteMode).toBe("soft");
  expect(meta.deletedAt).toBeTruthy();

  const isDeleted = await page.evaluate(() => (window as any).__skein.store.isDeleted);
  expect(isDeleted).toBe(true);
});

test("deleteCanvas sets the deleted tombstone (purge)", async ({ canvasPage }) => {
  const { page } = await canvasPage();

  await page.evaluate(() => (window as any).__skein.store.deleteCanvas("purge"));

  const meta = await page.evaluate(() => (window as any).__skein.store.metadata());
  expect(meta.deleteMode).toBe("purge");
});

test("restoreCanvas clears the deletion tombstone", async ({ canvasPage }) => {
  const { page } = await canvasPage();

  await page.evaluate(() => (window as any).__skein.store.deleteCanvas("soft"));
  await page.evaluate(() => (window as any).__skein.store.restoreCanvas());

  const meta = await page.evaluate(() => (window as any).__skein.store.metadata());
  expect(meta.deleted).toBe(false);

  const isDeleted = await page.evaluate(() => (window as any).__skein.store.isDeleted);
  expect(isDeleted).toBe(false);
});

// ---------------------------------------------------------------------------
// ephemeral messaging
// ---------------------------------------------------------------------------

test("onEphemeral receives broadcast messages from the same peer", async ({ canvasPage }) => {
  // two peers share a canvas; peerA sends an ephemeral, peerB receives it
  const peerA = await canvasPage();
  const peerB = await canvasPage({ canvasDocId: peerA.canvasDocId, context: peerA.context });

  // peerB sets up a listener
  await peerB.page.evaluate(() => {
    (window as any).__lastEphemeral = null;
    (window as any).__skein.store.onEphemeral((_senderId: string, data: Uint8Array) => {
      (window as any).__lastEphemeral = Array.from(data);
    });
  });

  // peerA broadcasts a message
  await peerA.page.evaluate(() => {
    (window as any).__skein.store.broadcastEphemeral(new Uint8Array([1, 2, 3]));
  });

  // wait for peerB to receive it
  await expect
    .poll(() => peerB.page.evaluate(() => (window as any).__lastEphemeral), { timeout: 5000 })
    .toEqual([1, 2, 3]);
});
