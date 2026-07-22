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
      payload: { node_id: "node-3", alias: "hub-friend" },
    });
    expect(invokeMock).toHaveBeenCalledWith("skein_dispatch", {
      action: "social_mark_friend_as_hub",
      payload: { node_id: "node-3" },
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
});
