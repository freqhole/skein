import { describe, expect, it, vi } from "vitest";

const invokeMock = vi.fn();
const listenMock = vi.fn().mockResolvedValue(() => {});

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: (...args: unknown[]) => listenMock(...args),
}));

import { SqliteSocialDoc } from "./sqlite-social-doc";

function baseSnapshot(overrides: Record<string, unknown> = {}) {
  return {
    profile: {
      user_id: "self-1",
      username: "self",
      alias: "",
      bio: "",
      avatar_url: "",
      accent_color: 0,
      node_id: "self-node",
    },
    friends: [],
    groups: [],
    pending_requests: [],
    outbound_requests: [],
    settings: {
      profile_visibility: "friends",
      friend_requests_from: "everyone",
    },
    ...overrides,
  };
}

describe("SqliteSocialDoc", () => {
  it("maps a friend's is_hub column to isHub true", async () => {
    invokeMock.mockResolvedValueOnce(
      baseSnapshot({
        friends: [
          {
            id: "friend-1",
            group_name: "",
            created_at: 0,
            friend_user_id: "friend-1",
            username: "hub-friend",
            alias: "",
            bio: "",
            avatar_url: "",
            accent_color: 0,
            is_hub: true,
            node_ids: [],
          },
        ],
      })
    );

    const doc = await SqliteSocialDoc.create();
    expect(doc.current.friends).toHaveLength(1);
    expect(doc.current.friends[0]?.isHub).toBe(true);
  });

  it("maps a friend's is_hub column to isHub false", async () => {
    invokeMock.mockResolvedValueOnce(
      baseSnapshot({
        friends: [
          {
            id: "friend-2",
            group_name: "",
            created_at: 0,
            friend_user_id: "friend-2",
            username: "ordinary-friend",
            alias: "",
            bio: "",
            avatar_url: "",
            accent_color: 0,
            is_hub: false,
            node_ids: [],
          },
        ],
      })
    );

    const doc = await SqliteSocialDoc.create();
    expect(doc.current.friends[0]?.isHub).toBe(false);
  });

  it("dispatches social_mark_friend_as_hub when a new friend is added with isHub true", async () => {
    invokeMock.mockResolvedValueOnce(baseSnapshot()).mockResolvedValue(undefined);

    const doc = await SqliteSocialDoc.create();
    invokeMock.mockClear();

    doc.change((draft) => {
      draft.friends.push({
        id: "friend-3",
        alias: "",
        username: "hub-friend",
        group: "",
        nodeIds: [{ nodeId: "node-3", addedAt: "", lastSeenAt: "" }],
        createdAt: "",
        isHub: true,
      });
    });

    // let the fire-and-forget diff dispatch settle
    await Promise.resolve();
    await Promise.resolve();

    expect(invokeMock).toHaveBeenCalledWith("skein_dispatch", {
      action: "social_add_friend",
      payload: { node_id: "node-3", alias: undefined },
    });
    expect(invokeMock).toHaveBeenCalledWith("skein_dispatch", {
      action: "social_mark_friend_as_hub",
      payload: { node_id: "node-3" },
    });
  });

  it("does not send a new friend's own username as their alias on social_add_friend", async () => {
    // regression: a brand-new FriendEntry always starts with alias: "" —
    // falling back to f.username here wrote the friend's OWN name into the
    // "local nickname for this friend" column, which then looked like a
    // real, intentionally-set alias.
    invokeMock.mockResolvedValueOnce(baseSnapshot()).mockResolvedValue(undefined);

    const doc = await SqliteSocialDoc.create();
    invokeMock.mockClear();

    doc.change((draft) => {
      draft.friends.push({
        id: "friend-4",
        alias: "",
        username: "their-own-name",
        group: "",
        nodeIds: [{ nodeId: "node-4", addedAt: "", lastSeenAt: "" }],
        createdAt: "",
        isHub: false,
      });
    });

    await Promise.resolve();
    await Promise.resolve();

    expect(invokeMock).toHaveBeenCalledWith("skein_dispatch", {
      action: "social_add_friend",
      payload: { node_id: "node-4", alias: undefined },
    });
  });

  it("dispatches social_mark_friend_as_hub when an existing friend's isHub flips false -> true", async () => {
    invokeMock.mockResolvedValueOnce(
      baseSnapshot({
        friends: [
          {
            id: "friend-4",
            group_name: "",
            created_at: 0,
            friend_user_id: "friend-4",
            username: "ordinary-friend",
            alias: "",
            bio: "",
            avatar_url: "",
            accent_color: 0,
            is_hub: false,
            node_ids: [],
          },
        ],
      })
    );
    invokeMock.mockResolvedValue(undefined);

    const doc = await SqliteSocialDoc.create();
    invokeMock.mockClear();

    doc.change((draft) => {
      const friend = draft.friends.find((f) => f.id === "friend-4");
      if (friend) {
        friend.nodeIds = [{ nodeId: "node-4", addedAt: "", lastSeenAt: "" }];
        friend.isHub = true;
      }
    });

    await Promise.resolve();
    await Promise.resolve();

    expect(invokeMock).toHaveBeenCalledWith("skein_dispatch", {
      action: "social_mark_friend_as_hub",
      payload: { node_id: "node-4" },
    });
  });

  it("does not dispatch social_mark_friend_as_hub when isHub was already true", async () => {
    invokeMock.mockResolvedValueOnce(
      baseSnapshot({
        friends: [
          {
            id: "friend-5",
            group_name: "",
            created_at: 0,
            friend_user_id: "friend-5",
            username: "hub-friend",
            alias: "",
            bio: "",
            avatar_url: "",
            accent_color: 0,
            is_hub: true,
            node_ids: [{ node_id: "node-5", display_name: "", bio: "", avatar_url: "", accent_color: 0, instance_name: null, last_seen_at: null, created_at: 0 }],
          },
        ],
      })
    );
    invokeMock.mockResolvedValue(undefined);

    const doc = await SqliteSocialDoc.create();
    invokeMock.mockClear();

    doc.change((draft) => {
      const friend = draft.friends.find((f) => f.id === "friend-5");
      if (friend) {
        friend.alias = "renamed";
      }
    });

    await Promise.resolve();
    await Promise.resolve();

    const hubCalls = invokeMock.mock.calls.filter(
      (call) => (call[1] as { action?: string })?.action === "social_mark_friend_as_hub"
    );
    expect(hubCalls).toHaveLength(0);
  });

  it("dispatches social_set_friend_alias with friend_user_id + new alias when a friend's alias changes", async () => {
    invokeMock.mockResolvedValueOnce(
      baseSnapshot({
        friends: [
          {
            id: "friend-6",
            group_name: "",
            created_at: 0,
            friend_user_id: "node-6",
            username: "some-friend",
            alias: "old-nickname",
            bio: "",
            avatar_url: "",
            accent_color: 0,
            is_hub: false,
            node_ids: [{ node_id: "node-6", display_name: "", bio: "", avatar_url: "", accent_color: 0, instance_name: null, last_seen_at: null, created_at: 0 }],
          },
        ],
      })
    );
    invokeMock.mockResolvedValue(undefined);

    const doc = await SqliteSocialDoc.create();
    invokeMock.mockClear();

    doc.change((draft) => {
      const friend = draft.friends.find((f) => f.id === "friend-6");
      if (friend) {
        friend.alias = "new-nickname";
      }
    });

    await Promise.resolve();
    await Promise.resolve();

    expect(invokeMock).toHaveBeenCalledWith("skein_dispatch", {
      action: "social_set_friend_alias",
      payload: { friend_user_id: "node-6", alias: "new-nickname" },
    });
  });

  it("maps remote_bio/remote_avatar_url/remote_accent_color into pendingRequests and outboundRequests", async () => {
    invokeMock.mockResolvedValueOnce(
      baseSnapshot({
        pending_requests: [
          {
            id: "req-in-1",
            user_id: "self-1",
            remote_user_id: "peer-in-1",
            direction: "inbound",
            status: "pending",
            created_at: 0,
            updated_at: 0,
            remote_username: "peer-in",
            remote_alias: "",
            remote_node_id: "peer-in-1",
            remote_display_name: "peer-in",
            remote_bio: "hi, i'm peer-in",
            remote_avatar_url: "avatar-in.png",
            remote_accent_color: 0x112233,
          },
        ],
        outbound_requests: [
          {
            id: "req-out-1",
            user_id: "self-1",
            remote_user_id: "peer-out-1",
            direction: "outbound",
            status: "pending",
            created_at: 0,
            updated_at: 0,
            remote_username: "peer-out",
            remote_alias: "",
            remote_node_id: "peer-out-1",
            remote_display_name: "peer-out",
            remote_bio: "hi, i'm peer-out",
            remote_avatar_url: "avatar-out.png",
            remote_accent_color: 0x445566,
          },
        ],
      })
    );

    const doc = await SqliteSocialDoc.create();

    expect(doc.current.pendingRequests[0]).toMatchObject({
      fromBio: "hi, i'm peer-in",
      fromAvatarDataUrl: "avatar-in.png",
      fromAccentColor: 0x112233,
    });
    expect(doc.current.outboundRequests[0]).toMatchObject({
      toBio: "hi, i'm peer-out",
      toAvatarDataUrl: "avatar-out.png",
      toAccentColor: 0x445566,
    });
  });

  it("maps a friend node's accent_color column into accentColor", async () => {
    invokeMock.mockResolvedValueOnce(
      baseSnapshot({
        friends: [
          {
            id: "friend-6",
            group_name: "",
            created_at: 0,
            friend_user_id: "friend-6",
            username: "colorful-friend",
            alias: "",
            bio: "",
            avatar_url: "",
            accent_color: 0x998877,
            is_hub: false,
            node_ids: [
              {
                node_id: "node-6",
                display_name: "colorful-friend",
                bio: "",
                avatar_url: "",
                accent_color: 0x998877,
                instance_name: null,
                last_seen_at: null,
                created_at: 0,
              },
            ],
          },
        ],
      })
    );

    const doc = await SqliteSocialDoc.create();
    expect(doc.current.friends[0]?.nodeIds[0]?.accentColor).toBe(0x998877);
  });

  it("dispatches social_update_node_profile when an outbound request's identity fields are filled in", async () => {
    invokeMock.mockResolvedValueOnce(
      baseSnapshot({
        outbound_requests: [
          {
            id: "req-out-2",
            user_id: "self-1",
            remote_user_id: "peer-out-2",
            direction: "outbound",
            status: "pending",
            created_at: 0,
            updated_at: 0,
            remote_username: "",
            remote_alias: "",
            remote_node_id: "peer-out-2",
            remote_display_name: null,
            remote_bio: null,
            remote_avatar_url: null,
            remote_accent_color: null,
          },
        ],
      })
    );
    invokeMock.mockResolvedValue(undefined);

    const doc = await SqliteSocialDoc.create();
    invokeMock.mockClear();

    doc.change((draft) => {
      const req = draft.outboundRequests.find((r) => r.toNodeId === "peer-out-2");
      if (req) {
        req.toUsername = "peer-out";
        req.toBio = "hi, i'm peer-out";
        req.toAvatarDataUrl = "avatar-out.png";
        req.toAccentColor = 0x445566;
      }
    });

    await Promise.resolve();
    await Promise.resolve();

    expect(invokeMock).toHaveBeenCalledWith("skein_dispatch", {
      action: "social_update_node_profile",
      payload: {
        node_id: "peer-out-2",
        display_name: "peer-out",
        bio: "hi, i'm peer-out",
        avatar_url: "avatar-out.png",
        accent_color: 0x445566,
      },
    });
  });

  it("dispatches social_update_node_profile with accent_color when a friend node's accent color changes", async () => {
    invokeMock.mockResolvedValueOnce(
      baseSnapshot({
        friends: [
          {
            id: "friend-7",
            group_name: "",
            created_at: 0,
            friend_user_id: "friend-7",
            username: "friend-7",
            alias: "",
            bio: "",
            avatar_url: "",
            accent_color: 0,
            is_hub: false,
            node_ids: [
              {
                node_id: "node-7",
                display_name: "friend-7",
                bio: "",
                avatar_url: "",
                accent_color: 0,
                instance_name: null,
                last_seen_at: null,
                created_at: 0,
              },
            ],
          },
        ],
      })
    );
    invokeMock.mockResolvedValue(undefined);

    const doc = await SqliteSocialDoc.create();
    invokeMock.mockClear();

    doc.change((draft) => {
      const friend = draft.friends.find((f) => f.id === "friend-7");
      const node = friend?.nodeIds.find((n) => n.nodeId === "node-7");
      if (node) node.accentColor = 0xaabbcc;
    });

    await Promise.resolve();
    await Promise.resolve();

    expect(invokeMock).toHaveBeenCalledWith("skein_dispatch", {
      action: "social_update_node_profile",
      payload: { node_id: "node-7", accent_color: 0xaabbcc },
    });
  });
});
