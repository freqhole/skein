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
});
