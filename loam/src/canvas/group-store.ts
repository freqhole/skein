import { z } from "zod";
import { shareGroupSchema, type ShareGroup } from "../../widgets/narthex/social/schema";
import type { SocialDoc } from "../../widgets/narthex/social/types";
import type { CanvasStore } from "./canvas-store";
import type { InvitableRole } from "./canvas-doc";

const shareGroupArraySchema = z.array(shareGroupSchema);

/**
 * store-level API for canvas-sharing groups.
 *
 * a group is a named collection of peer node ids, used as a bulk-invite
 * convenience when sharing a canvas — see `shareCanvasWithGroup()` below.
 * a node id can belong to any number of groups at once (many-to-many);
 * there's no single group a peer is filed under.
 *
 * **ownership + storage**: groups are private, per-user data. they live in
 * the local user's own social doc (see `SocialDoc`/`docHandleAsSocialDoc`)
 * — the same doc that already holds `profile`, `friends`, and the
 * friend-list folder `groups`. this means:
 * - a group only syncs across the *creating* user's own devices (their
 *   social doc replicates the same way their profile/friends already do),
 *   never to the peers listed as members. members don't need to see the
 *   group's definition (name, other members) — they only ever end up
 *   invited to whatever canvases get shared with the group.
 * - groups are not a shared/co-owned concept between multiple people
 *   managing the same group. there is exactly one owner (whoever's social
 *   doc it lives in), matching how an address book's contact groups are
 *   private to that address book's owner, not a jointly-edited resource.
 *   this was chosen over a synced/shared-group model because nothing in
 *   the product requires two people to jointly curate one group's
 *   membership, and a private model avoids an entire class of merge-
 *   conflict and permission questions (who can add/remove members? what
 *   happens if the "owner" leaves?) that a shared model would raise for
 *   no concrete benefit.
 *
 * **retroactive membership changes do NOT affect canvases already shared**:
 * `shareCanvasWithGroup()` is a one-time bulk expansion. it resolves the
 * group's *current* member list into individual canvas ACL entries (via
 * `CanvasStore.setRole()`) at the moment of sharing, then forgets the
 * group was ever involved — nothing in `CanvasDocument` references a group
 * id. adding someone to the group afterward does not grant them access to
 * canvases already shared with it; removing someone does not revoke
 * access already granted. this is a deliberate choice, not an oversight:
 * a "live" group-to-canvas link is architecturally awkward given the
 * private-group model above — other peers on the canvas have no way to
 * resolve "what does group X currently contain" since they can't see the
 * sharer's social doc, so any live link could only ever be enforced by the
 * sharer's own client, which is not a meaningful security boundary anyway
 * (see the ACL trust model notes in `canvas-store.ts`/`getRole()`). a
 * plain one-time expansion keeps the mental model identical to inviting
 * each member individually — "share with group" is just a faster way to
 * do that, not a new kind of standing access grant.
 */
export class GroupStore {
  constructor(private readonly socialDoc: SocialDoc) {}

  /**
   * all groups owned by the local user, in creation order.
   *
   * validates the raw array through `shareGroupSchema` before trusting it
   * — defensive parsing here mostly guards against a doc predating this
   * field (where `shareGroups` is simply absent) or a malformed write from
   * a bug, not an adversarial peer (this doc isn't synced to other
   * people's clients — see the class doc comment above).
   */
  allGroups(): ShareGroup[] {
    const raw = this.socialDoc.current.shareGroups ?? [];
    const parsed = shareGroupArraySchema.safeParse(raw);
    return parsed.success ? parsed.data : [];
  }

  /** get a single group by id. returns null if not found. */
  getGroup(id: string): ShareGroup | null {
    return this.allGroups().find((g) => g.id === id) ?? null;
  }

  /** true if any group with this id exists. */
  hasGroup(id: string): boolean {
    return this.getGroup(id) !== null;
  }

  /** create a new group with the given display name. returns the new group's id. */
  createGroup(name: string): string {
    const id = crypto.randomUUID();
    this.socialDoc.change((draft) => {
      if (!draft.shareGroups) draft.shareGroups = [];
      draft.shareGroups.push({
        id,
        name,
        memberNodeIds: [],
        createdAt: new Date().toISOString(),
      });
    });
    return id;
  }

  /** rename an existing group. no-op if the group doesn't exist. */
  renameGroup(id: string, name: string): void {
    this.socialDoc.change((draft) => {
      const group = draft.shareGroups?.find((g) => g.id === id);
      if (group) group.name = name;
    });
  }

  /**
   * delete a group entirely. no-op if it doesn't exist.
   *
   * does not touch any canvas ACL entries previously granted via this
   * group — see the class doc comment's "retroactive membership changes"
   * section. deleting a group has no effect on canvases already shared
   * with it, same as removing a member does not.
   */
  deleteGroup(id: string): void {
    this.socialDoc.change((draft) => {
      if (!draft.shareGroups) return;
      const idx = draft.shareGroups.findIndex((g) => g.id === id);
      if (idx !== -1) draft.shareGroups.splice(idx, 1);
    });
  }

  /** add a peer node id to a group. idempotent — a no-op if already a member
   *  or if the group doesn't exist. */
  addMember(id: string, nodeId: string): void {
    this.socialDoc.change((draft) => {
      const group = draft.shareGroups?.find((g) => g.id === id);
      if (group && !group.memberNodeIds.includes(nodeId)) {
        group.memberNodeIds.push(nodeId);
      }
    });
  }

  /** remove a peer node id from a group. no-op if not a member or the group
   *  doesn't exist. */
  removeMember(id: string, nodeId: string): void {
    this.socialDoc.change((draft) => {
      const group = draft.shareGroups?.find((g) => g.id === id);
      if (!group) return;
      const idx = group.memberNodeIds.indexOf(nodeId);
      if (idx !== -1) group.memberNodeIds.splice(idx, 1);
    });
  }

  /** true if nodeId is currently a member of the given group. */
  isMember(id: string, nodeId: string): boolean {
    return this.getGroup(id)?.memberNodeIds.includes(nodeId) ?? false;
  }

  /** all groups the given node id currently belongs to — the many-to-many
   *  membership query (a peer can be in any number of groups at once). */
  groupsForMember(nodeId: string): ShareGroup[] {
    return this.allGroups().filter((g) => g.memberNodeIds.includes(nodeId));
  }

  /**
   * share a canvas with every current member of a group: grants `role` to
   * each member node id via `CanvasStore.setRole()`.
   *
   * this is a one-time bulk expansion, not an ongoing link between the
   * canvas and the group — see the class doc comment for the full
   * rationale. later changes to the group's membership have no effect on
   * this canvas's ACL.
   *
   * returns the node ids that were granted access (empty if the group
   * doesn't exist or has no members). does not skip the local peer's own
   * node id if it happens to be a group member — `CanvasStore.setRole()`
   * already no-ops for an admin's own entry, which covers the common case
   * of a sharer accidentally including themselves.
   */
  shareCanvasWithGroup(canvasStore: CanvasStore, groupId: string, role: InvitableRole): string[] {
    const group = this.getGroup(groupId);
    if (!group) return [];
    for (const nodeId of group.memberNodeIds) {
      canvasStore.setRole(nodeId, role);
    }
    return [...group.memberNodeIds];
  }
}
