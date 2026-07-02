import type { FriendEntry, FriendGroup } from "./schema";

// ---------------------------------------------------------------------------
// visual constants used by helpers
// ---------------------------------------------------------------------------

const COLOR_PALETTE = [
  0xd946ef, 0x6366f1, 0x06b6d4, 0x10b981, 0xeab308, 0xf97316, 0xef4444, 0x8b5cf6,
];

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

/** simple hash to pick a palette color from a string. */
export function colorForName(name: string, index: number): number {
  if (!name) return COLOR_PALETTE[index % COLOR_PALETTE.length];
  let hash = 0;
  for (let i = 0; i < name.length; i++) {
    hash = (hash * 31 + name.charCodeAt(i)) | 0;
  }
  return COLOR_PALETTE[Math.abs(hash) % COLOR_PALETTE.length];
}

/** truncate a string with an ellipsis if it exceeds maxChars. */
export function truncate(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value;
  return value.slice(0, maxChars - 1).trimEnd() + "\u2026";
}

/**
 * check if a string looks like a valid iroh node ID.
 * iroh node IDs are 64-character lowercase hex strings (32-byte ed25519 public key).
 */
export function isValidNodeId(value: string): boolean {
  return /^[a-f0-9]{64}$/.test(value);
}

/**
 * resolve the best display name for a friend.
 * priority: username > alias > truncated first nodeId > "unknown"
 */
export function friendDisplayName(friend: FriendEntry): string {
  if (friend.username) return friend.username;
  if (friend.alias) return friend.alias;
  if (friend.nodeIds.length > 0 && friend.nodeIds[0].nodeId) {
    const id = friend.nodeIds[0].nodeId;
    return id.slice(0, 8) + "..." + id.slice(-8);
  }
  return "unknown";
}

/**
 * format the display name with alias annotation.
 * if both username and alias exist: "username (alias)"
 * otherwise: just the display name (username > alias > nodeId > "unknown")
 */
export function friendDisplayNameFull(friend: FriendEntry): string {
  if (friend.alias && friend.username) {
    return `${friend.username} (${friend.alias})`;
  }
  return friendDisplayName(friend);
}

/**
 * resolve the best bio string for a friend.
 * picks the first non-empty bio from the friend's node profiles,
 * preferring the most recently seen node.
 */
export function bestBio(friend: FriendEntry): string {
  // sort nodes by lastSeenAt descending so we prefer the freshest profile
  const sorted = [...friend.nodeIds].sort((a, b) =>
    (b.lastSeenAt || "").localeCompare(a.lastSeenAt || "")
  );
  for (const node of sorted) {
    if (node.bio) return node.bio;
  }
  return "";
}

/**
 * generate a unique auto-incrementing group name like "group 1", "group 2", etc.
 */
export function generateUniqueGroupName(groups: FriendGroup[]): string {
  const existing = new Set(groups.map((g) => g.name));
  let i = 1;
  while (existing.has(`group ${i}`)) i++;
  return `group ${i}`;
}

// ---------------------------------------------------------------------------
// reserved "hub nodes" section (docs/hub-and-profile-plan.md section 4)
//
// hub friends (`FriendEntry.isHub === true`) get their own always-last
// section in friends-tab.ts's list, using the same header/collapse mechanic
// as a real user group — but it's reserved: non-renameable, non-deletable,
// and not a drag-and-drop target. the leading NUL byte can't appear in a
// real user-typed group name (group names come from a plain text input,
// trimmed as-is with no NUL-stripping of its own), so this key can never
// collide with a real group's identity, unlike matching the literal display
// string "hub nodes" (which a user absolutely could type as a group name).
// ---------------------------------------------------------------------------

export const HUB_GROUP_KEY = "\u0000hub-nodes";
export const HUB_GROUP_LABEL = "hub nodes";

/** a single row to render in the friends-tab list — either a group header
 *  or a friend row. see `buildFriendRowItems()`. */
export type FriendRowItem =
  | { type: "header"; group: string; count: number }
  | { type: "friend"; friend: FriendEntry };

/**
 * build the ordered list of header/friend rows for the friends-tab list —
 * pure data logic, no pixi/rendering, so the grouping/sort-order/hub-section
 * behavior is directly unit-testable. see `friends-tab.ts`'s `rebuildRows()`
 * for the pixi rendering that consumes this.
 *
 * ordering: real (user-named) groups sorted alphabetically, each followed
 * by its members (unless its name is in `collapsedGroups`) -> ungrouped
 * friends (no header of their own) -> the reserved hub-nodes section (own
 * header, always last), populated by every `isHub` friend regardless of
 * their `group` field. a hub friend never appears in the normal
 * grouped/ungrouped listing, even if it has a stray `group` value — its
 * `group` field itself is left untouched, just skipped here.
 */
export function buildFriendRowItems(
  friends: FriendEntry[],
  collapsedGroups: ReadonlySet<string>
): FriendRowItem[] {
  const grouped = new Map<string, FriendEntry[]>();
  const ungrouped: FriendEntry[] = [];
  const hubFriends: FriendEntry[] = [];

  for (const friend of friends) {
    if (friend.isHub) {
      hubFriends.push(friend);
      continue;
    }
    if (friend.group) {
      const existing = grouped.get(friend.group);
      if (existing) {
        existing.push(friend);
      } else {
        grouped.set(friend.group, [friend]);
      }
    } else {
      ungrouped.push(friend);
    }
  }

  const sortedGroupNames = [...grouped.keys()].sort((a, b) => a.localeCompare(b));

  const items: FriendRowItem[] = [];

  for (const groupName of sortedGroupNames) {
    const groupFriends = grouped.get(groupName)!;
    items.push({ type: "header", group: groupName, count: groupFriends.length });
    if (!collapsedGroups.has(groupName)) {
      for (const friend of groupFriends) {
        items.push({ type: "friend", friend });
      }
    }
  }

  for (const friend of ungrouped) {
    items.push({ type: "friend", friend });
  }

  if (hubFriends.length > 0) {
    items.push({ type: "header", group: HUB_GROUP_KEY, count: hubFriends.length });
    if (!collapsedGroups.has(HUB_GROUP_KEY)) {
      for (const friend of hubFriends) {
        items.push({ type: "friend", friend });
      }
    }
  }

  return items;
}
