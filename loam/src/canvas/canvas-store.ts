import type { DocHandle, DocumentId, PeerId, Repo } from "@automerge/automerge-repo";
import type {
  CanvasDocument,
  CanvasPeer,
  CanvasRole,
  InvitableRole,
  KnockDecision,
  PendingCanvasInvite,
  PendingCanvasKnock,
  WidgetEntry,
} from "./canvas-doc";
import { canvasRoleSchema, emptyCanvasDoc } from "./canvas-doc";
import { resolveDocReady } from "../p2p/doc-ready";

/**
 * default bound for `CanvasStore.open()` when a caller passes no
 * `opts.timeoutMs` at all — matches automerge-repo's own historical
 * internal `whenReady()` default (~60s) so migrating `open()` onto
 * `resolveDocReady()` doesn't silently change how long ordinary in-app
 * navigation waits before giving up.
 */
const DEFAULT_OPEN_TIMEOUT_MS = 60_000;

/** handler signature for ephemeral message listeners */
export type EphemeralHandler = (senderId: string, data: Uint8Array) => void;

/**
 * wraps the canvas automerge document with typed mutation methods.
 * this is the primary interface for reading and modifying the canvas layout.
 */
export class CanvasStore {
  /** the underlying automerge document handle. exposed for initCanvas and sync. */
  readonly handle: DocHandle<CanvasDocument>;
  /** the automerge repo this document belongs to. */
  readonly repo: Repo;

  private _peerOnlineChecker: ((nodeId: string) => boolean) | null = null;

  private _localNodeId: string = "";

  /** set the local peer's node ID so local edits can be attributed. */
  setLocalNodeId(id: string): void {
    this._localNodeId = id;
  }

  /** the local peer's node ID. used for attribution on edits and deletions. */
  get localNodeId(): string {
    return this._localNodeId;
  }

  private constructor(repo: Repo, handle: DocHandle<CanvasDocument>) {
    this.repo = repo;
    this.handle = handle;

    // re-evaluate automerge-repo's own sync eligibility (`repo.shareConfig`,
    // see canvas-scoped-share-policy.ts) every time this canvas doc changes
    // — local or remote-synced. this closes a plausible race in the
    // per-widget "no .acl of its own, inherit the owning canvas's" policy:
    // a widget doc's docSynchronizer is set up (and first announce/access-
    // checked) essentially the instant its doc is created, which could run
    // *before* this canvas doc's own `.widgets[id].docId` link has
    // propagated to a remote peer (they're two independent automerge docs
    // with no ordering guarantee between their sync messages over a real,
    // non-loopback network) — the very first check could then deny it, and
    // nothing would ever re-ask once the owning link *did* arrive. cheap to
    // call on every change (createCanvasScopedSharePolicy's own short-TTL
    // per-peer/per-doc cache absorbs repeat calls), so this is included as
    // a real hardening even though a dedicated e2e test for it
    // (blob-acl.spec.ts's "widget added AFTER a peer already joined") did
    // not reproduce a failure without it on fast loopback iroh connections
    // — see /memories/session/canvas-scoped-share-policy-regression.md.
    handle.on("change", () => {
      void repo.synchronizer.reevaluateDocumentShare();
    });
  }

  /**
   * create a new canvas with an empty document.
   */
  static create(repo: Repo): CanvasStore {
    const handle = repo.create<CanvasDocument>(emptyCanvasDoc());
    return new CanvasStore(repo, handle);
  }

  /**
   * open an existing canvas document by ID.
   *
   * doesn't let a transient "unavailable" verdict be the final word. a
   * peer opening a canvas newly shared with them can legitimately hit
   * "unavailable" on the very first attempt — the sharing peer's own
   * `access`/`announce` decision for a brand-new invite can race a hair
   * behind the invite message itself (see
   * `canvas-scoped-share-policy.ts`'s module doc comment for the full
   * story) — and automerge-repo's default `repo.find()` treats that as
   * terminal, throwing immediately and uncaught (a real, user-reported
   * production crash, 2026-07-03: "Document ... is unavailable" took the
   * whole app down). automerge-repo's own `DocHandle` state machine
   * already models the real recovery path event-drivenly: an
   * "unavailable" handle still transitions to "ready" the moment real
   * content actually arrives, so this is built on `resolveDocReady()` (see
   * `p2p/doc-ready.ts`) rather than a one-off `repo.find()`/`whenReady()`
   * pair — it keeps listening for the same handle to flip to "ready" for
   * the rest of the bound below, instead of throwing immediately the way
   * automerge-repo's own default `repo.find()` behavior would.
   *
   * `opts.timeoutMs`, when given, bounds the wait instead of the default
   * ~60s (`DEFAULT_OPEN_TIMEOUT_MS`, matching automerge-repo's own
   * historical internal default so this refactor doesn't silently change
   * how long ordinary in-app navigation waits before giving up) — pass an
   * explicit shorter bound for a cold open with no known peer to dial at
   * all (a bare canvas-id URL with no prior session), where waiting out
   * the full default is pointless: the doc either resolves fast (already
   * local, or a peer responds quickly) or it never will from this entry
   * point.
   *
   * `opts.signal`, when given, lets a caller cancel the wait on demand —
   * e.g. a user clicking a "cancel" button on a loading screen while this
   * is still in flight. combined with the timeout (whichever fires first
   * wins), rather than replacing it.
   */
  static async open(
    repo: Repo,
    docId: DocumentId,
    opts?: { timeoutMs?: number; signal?: AbortSignal }
  ): Promise<CanvasStore> {
    const timeoutMs = opts?.timeoutMs ?? DEFAULT_OPEN_TIMEOUT_MS;
    const handle = await resolveDocReady<CanvasDocument>(repo, docId, {
      timeoutMs,
      signal: opts?.signal,
    });
    if (!handle) {
      throw new Error(`canvas doc ${docId} did not become ready within ${timeoutMs}ms`);
    }
    return new CanvasStore(repo, handle);
  }

  /** get the current document state. */
  doc(): CanvasDocument {
    return this.handle.doc() ?? emptyCanvasDoc();
  }

  /** get a widget entry by ID. returns null if not found. */
  getWidget(id: string): WidgetEntry | null {
    return this.doc().widgets[id] ?? null;
  }

  /** return the number of widgets in the document. */
  widgetCount(): number {
    return Object.keys(this.doc().widgets).length;
  }

  /** return all widget entries. */
  allWidgets(): WidgetEntry[] {
    return Object.values(this.doc().widgets);
  }

  // -- peer tracking ---------------------------------------------------------

  /** get all known peers for this canvas. */
  peers(): Record<string, CanvasPeer> {
    return this.doc().peers ?? {};
  }

  /** register a peer's node ID in the canvas document for reconnection on reload. */
  addPeer(nodeId: string): void {
    this.handle.change((doc) => {
      if (!doc.peers) doc.peers = {} as Record<string, CanvasPeer>;
      if (!doc.peers[nodeId]) {
        doc.peers[nodeId] = { nodeId, joinedAt: new Date().toISOString() };
      }
    });
  }

  /**
   * remove a peer from the canvas document. used to revoke access from the
   * share dialog — also clears their `.acl` entry (if any), not just their
   * `.peers` reconnect-list entry, so a revoked peer's effective role
   * actually goes away rather than lingering. anything keyed off `.acl`
   * (role-gated UI, the blob allow-list sync in `p2p/blob-acl-sync.ts`)
   * needs this to see the peer's access end here, not just their presence.
   */
  removePeer(nodeId: string): void {
    this.handle.change((doc) => {
      if (doc.peers && doc.peers[nodeId]) {
        delete doc.peers[nodeId];
      }
      if (doc.acl && doc.acl[nodeId]) {
        delete doc.acl[nodeId];
      }
    });
  }

  /** stamp our own lastSeenAt in the peers record.
   *  each peer only writes their own entry so there are no conflicts. */
  stampLastSeen(): void {
    if (!this._localNodeId) return;
    this.handle.change((doc) => {
      if (!doc.peers) doc.peers = {} as Record<string, CanvasPeer>;
      const entry = doc.peers[this._localNodeId];
      if (entry) {
        entry.lastSeenAt = new Date().toISOString();
      }
    });
  }

  /** get all pending invites for this canvas. */
  pendingInvites(): Record<string, PendingCanvasInvite> {
    return this.doc().pendingInvites ?? {};
  }

  /** write a pending invite into the canvas doc for gossip relay. */
  addPendingInvite(targetNodeId: string, invite: PendingCanvasInvite): void {
    this.handle.change((doc) => {
      if (!doc.pendingInvites) doc.pendingInvites = {} as Record<string, PendingCanvasInvite>;
      doc.pendingInvites[targetNodeId] = invite;
    });
  }

  /** remove a pending invite (e.g. after the target joined or declined). */
  removePendingInvite(targetNodeId: string): void {
    this.handle.change((doc) => {
      if (doc.pendingInvites && doc.pendingInvites[targetNodeId]) {
        delete doc.pendingInvites[targetNodeId];
      }
    });
  }

  /**
   * mark a pending invite as accepted (the owner received an accept
   * message) without removing it — the target hasn't necessarily connected
   * yet. the entry is removed later, once the target actually shows up in
   * `peers` (see boot.ts's join/navigate flow), not at accept time. see
   * `PendingCanvasInvite` for the full lifecycle rationale.
   */
  markInviteAccepted(targetNodeId: string): void {
    this.handle.change((doc) => {
      const invite = doc.pendingInvites?.[targetNodeId];
      if (invite) {
        invite.accepted = true;
        invite.acceptedAt = new Date().toISOString();
      }
    });
  }

  // -- knock requests ---------------------------------------------------------

  /**
   * record a knock from `requesterNodeId`, or return the existing one.
   *
   * mirrors tomb's UNIQUE(node_id) + idempotent-retry + silent-rejection
   * behavior, adapted to an automerge map instead of a SQL constraint:
   * - no existing entry: insert a fresh one, `decisions: []`.
   * - existing entry still fully pending (no decisions yet): return it
   *   unchanged — this is a legitimate retry (e.g. the first knock message
   *   never actually reached a peer who could record it), not a new knock.
   * - existing entry already resolved (approved or declined): return it
   *   as-is — do not create a fresh pending entry or reset `decisions`.
   *   per tomb's silent-rejection policy, a declined knock is handed back
   *   the same way an approved one is; callers must not use this method's
   *   return value alone to distinguish "declined" from "still pending" in
   *   requester-facing UI — use `resolveKnockDecision()` for the real
   *   state (see docs/knock-and-hub-relay-plan.md section 3.2 for the full
   *   reasoning).
   */
  recordKnock(
    requesterNodeId: string,
    requesterUsername: string,
    message: string,
    knockId?: string
  ): PendingCanvasKnock {
    this.handle.change((doc) => {
      if (!doc.pendingKnocks) doc.pendingKnocks = {} as Record<string, PendingCanvasKnock>;
      if (!doc.pendingKnocks[requesterNodeId]) {
        doc.pendingKnocks[requesterNodeId] = {
          knockId: knockId ?? crypto.randomUUID(),
          requesterNodeId,
          requesterUsername,
          message,
          knockedAt: new Date().toISOString(),
          decisions: [],
        };
      }
    });
    return this.doc().pendingKnocks![requesterNodeId];
  }

  /**
   * pure function over a knock's decision log — resolves the *first*
   * decision (by insertion order into `decisions`, not wall-clock time) as
   * authoritative. see `PendingCanvasKnock.decisions`'s doc comment for why
   * this reads a log instead of a single mutable status field: two admins
   * can decide concurrently before either has synced the other's decision,
   * and this function is what makes the outcome deterministic once both
   * have synced to a given peer's view of the doc.
   *
   * a later decision (a late admin approving/declining after the first
   * decision already resolved things) is never dropped from the log — see
   * `addKnockDecision()` — it just doesn't change the outcome here. the UI
   * is expected to surface this as a small warning next to the late
   * decision ("this request was already approved/declined by ...") rather
   * than an error (see docs/knock-and-hub-relay-plan.md section 5.3).
   */
  resolveKnockDecision(knock: PendingCanvasKnock): {
    outcome: "pending" | "approved" | "declined";
    decidedBy?: string;
    role?: InvitableRole;
  } {
    const first = knock.decisions[0];
    if (!first) {
      return { outcome: "pending" };
    }
    return {
      outcome: first.decision === "approve" ? "approved" : "declined",
      decidedBy: first.byNodeId,
      role: first.role,
    };
  }

  /**
   * append a decision to `pendingKnocks[requesterNodeId].decisions`.
   * *always* appends — even if the knock is already resolved by an earlier
   * decision (first-decision-wins, see `resolveKnockDecision()`) — so the
   * log stays a complete audit trail; it's `resolveKnockDecision()`'s job
   * to ignore later entries when computing the outcome, not this method's
   * job to refuse to record them. no-op if the knock doesn't exist at all
   * (e.g. it was already cleaned up after a full approval — see
   * `PendingCanvasKnock`'s lifecycle notes).
   */
  addKnockDecision(
    requesterNodeId: string,
    byNodeId: string,
    decision: "approve" | "decline",
    role?: InvitableRole
  ): void {
    this.handle.change((doc) => {
      const knock = doc.pendingKnocks?.[requesterNodeId];
      if (!knock) return;
      // automerge rejects an explicit `undefined` value being assigned/pushed
      // (unlike a plain JS object) — omit `role` entirely rather than setting
      // it to `undefined` when this is a decline (or an approve without a
      // role, which shouldn't happen but isn't this method's job to enforce).
      const entry: KnockDecision =
        role === undefined
          ? { byNodeId, decision, at: new Date().toISOString() }
          : { byNodeId, decision, role, at: new Date().toISOString() };
      knock.decisions.push(entry);
    });
  }

  // -- hub relay ---------------------------------------------------------------

  /** add a node id to `hubNodeIds` — dedupes, a no-op if already present. */
  addHubNodeId(hubNodeId: string): void {
    this.handle.change((doc) => {
      if (!doc.hubNodeIds) doc.hubNodeIds = [];
      if (!doc.hubNodeIds.includes(hubNodeId)) {
        doc.hubNodeIds.push(hubNodeId);
      }
    });
  }

  /** convenience: true if `nodeId` is a recorded reliquary hub for this
   *  canvas (see `CanvasDocument.hubNodeIds`). */
  isHubNode(nodeId: string): boolean {
    return (this.doc().hubNodeIds ?? []).includes(nodeId);
  }

  // -- access control ----------------------------------------------------------

  /**
   * mark a node id as the admin of this canvas. call once, at creation time
   * (see `CanvasStore.create()`). idempotent — a no-op if an admin is
   * already recorded, so it's safe to call defensively.
   *
   * role names (admin/member/viewer) match tomb/'s role model — renamed
   * 2026-07-01 from owner/editor/viewer. admin is the only role that can
   * invite/share (see share-dialog.ts gating).
   */
  stampAdmin(nodeId: string): void {
    this.handle.change((doc) => {
      if (!doc.acl) doc.acl = {};
      const hasAdmin = Object.values(doc.acl).some((entry) => entry.role === "admin");
      if (!hasAdmin) {
        doc.acl[nodeId] = { role: "admin" };
      }
    });
  }

  /**
   * move this canvas's admin stamp from one node id to another.
   *
   * used when a peer that was admin-stamped under a temporary local id
   * (see `p2p/anon-device-id.ts` — used before a real p2p identity
   * exists) later establishes a real identity, so they don't lose
   * ownership of canvases they created before that. a no-op if
   * `oldNodeId` isn't the recorded admin — e.g. already migrated, or the
   * admin is someone else entirely.
   */
  migrateAdminId(oldNodeId: string, newNodeId: string): void {
    if (oldNodeId === newNodeId) return;
    this.handle.change((doc) => {
      if (!doc.acl || doc.acl[oldNodeId]?.role !== "admin") return;
      delete doc.acl[oldNodeId];
      doc.acl[newNodeId] = { role: "admin" };
    });
  }

  /**
   * set (or change) a peer's role on this canvas. used both when an invite
   * is sent (role chosen at invite time) and later, to change an
   * already-invited peer's role.
   *
   * does not touch an admin's own entry — callers should not be able to
   * demote an admin via this path (there is currently exactly one admin
   * per canvas, stamped once via `stampAdmin()`).
   */
  setRole(nodeId: string, role: InvitableRole): void {
    this.handle.change((doc) => {
      if (!doc.acl) doc.acl = {};
      if (doc.acl[nodeId]?.role === "admin") return;
      doc.acl[nodeId] = { role };
    });
  }

  /**
   * effective role for a node id on this canvas.
   *
   * a peer without an explicit `.acl` entry has no assumed write access -
   * `"viewer"` (read-only) is the safe floor for a node id that hasn't
   * been granted a role, whether it's simply unrecorded or the entry on
   * the doc is invalid/garbage. the local node querying its own
   * unrecorded role is treated the same way; there is no implicit
   * "stranger" state at this layer — that's gated separately by
   * `sharePolicy` / invite flow, not by `.acl`.
   *
   * **validates the raw value through `canvasRoleSchema` before trusting
   * it** — `.acl` is regular automerge doc data, synced from other peers
   * with no server-side validation. a buggy or malicious peer could write
   * an unrecognized role string; this falls back to the safe default
   * rather than propagating garbage as if it were a valid role. see
   * canvas-doc.ts's centralized role schemas for why this matters — this
   * is the one place in the ACL model that reads untrusted synced data as
   * a security-relevant value.
   */
  getRole(nodeId: string): CanvasRole {
    const raw = this.doc().acl?.[nodeId]?.role;
    const parsed = canvasRoleSchema.safeParse(raw);
    return parsed.success ? parsed.data : "viewer";
  }

  /** convenience: true if `nodeId` has view-only access to this canvas. */
  isViewer(nodeId: string): boolean {
    return this.getRole(nodeId) === "viewer";
  }

  /** convenience: true if `nodeId` is an admin on this canvas — only admins
   *  can invite/share (see share-dialog.ts gating). */
  isAdmin(nodeId: string): boolean {
    return this.getRole(nodeId) === "admin";
  }

  /**
   * effective role for the local peer (via `setLocalNodeId()`). returns
   * `"viewer"` if the local node id hasn't been set yet — same default as
   * `getRole()` for an unrecorded node, so callers don't need a separate
   * "not ready yet" branch.
   */
  localRole(): CanvasRole {
    return this.getRole(this._localNodeId);
  }

  /** convenience: true if the local peer has view-only access to this
   *  canvas — the UI-gating chokepoint for toolbar/property-tray/widget-manager. */
  isLocalViewer(): boolean {
    return this.localRole() === "viewer";
  }

  /** convenience: true if the local peer is an admin on this canvas — the
   *  UI-gating chokepoint for the share dialog (only admins can invite/share). */
  isLocalAdmin(): boolean {
    return this.localRole() === "admin";
  }

  /**
   * true if the local peer may interact with `widgetId`'s "click to add"
   * initial step (upload a file/image/pdf, start a recording, etc).
   *
   * widgets without a recorded `createdBy` (created before this field
   * existed, or missing entirely) are unrestricted — everyone passes. once a
   * widget has a `createdBy`, only that peer passes; this does NOT gate
   * ongoing interaction with content that already exists (playback, viewing,
   * etc) — only the initial "set this widget's content up" step, so callers
   * should combine this with `isLocalViewer()` rather than use it alone for
   * anything beyond that first step.
   */
  isLocalWidgetCreator(widgetId: string): boolean {
    const entry = this.getWidget(widgetId);
    if (!entry?.createdBy) return true;
    return entry.createdBy === this._localNodeId;
  }

  // -- metadata --------------------------------------------------------------

  /** get the canvas metadata (title, description, timestamps, color, preview). */
  metadata(): {
    title: string;
    description: string;
    createdAt: string;
    lastModified: string;
    lastModifiedBy: string;
    color: number;
    previewUrl: string;
    deleted?: boolean;
    deletedAt?: string;
    deletedBy?: string;
    deleteMode?: "soft" | "purge";
  } {
    const doc = this.doc();
    return {
      title: doc.title ?? "",
      description: doc.description ?? "",
      createdAt: doc.createdAt ?? "",
      lastModified: doc.lastModified ?? "",
      lastModifiedBy: doc.lastModifiedBy ?? "",
      color: doc.color ?? 0,
      previewUrl: doc.previewUrl ?? "",
      deleted: doc.deleted,
      deletedAt: doc.deletedAt,
      deletedBy: doc.deletedBy,
      deleteMode: doc.deleteMode,
    };
  }

  /** set the canvas title. */
  setTitle(title: string): void {
    this.handle.change((doc) => {
      doc.title = title;
      doc.lastModified = new Date().toISOString();
    });
  }

  /** set the canvas description. */
  setDescription(description: string): void {
    this.handle.change((doc) => {
      doc.description = description;
      doc.lastModified = new Date().toISOString();
    });
  }

  /** set both createdAt and lastModified (used on initial creation). */
  setCreatedAt(isoDate: string): void {
    this.handle.change((doc) => {
      doc.createdAt = isoDate;
      doc.lastModified = isoDate;
    });
  }

  /** set the canvas tag color. */
  setColor(color: number): void {
    this.handle.change((doc) => {
      doc.color = color;
      doc.lastModified = new Date().toISOString();
    });
  }

  /** set the canvas preview image (data URL). */
  setPreviewUrl(url: string): void {
    this.handle.change((doc) => {
      doc.previewUrl = url;
      doc.lastModified = new Date().toISOString();
    });
  }

  /**
   * add a widget to the canvas. returns the widget's ID.
   * the entry must include an `id` field.
   *
   * stamps `createdBy` from the local node id unless the caller already set
   * one (e.g. narthex-seed.ts constructing widgets before a local node id
   * is known) — see `isLocalWidgetCreator()`.
   */
  addWidget(entry: WidgetEntry): string {
    const createdBy = entry.createdBy || this._localNodeId || undefined;
    this.handle.change((doc) => {
      doc.widgets[entry.id] = { ...entry };
      // only set the key when there's a real value — automerge drafts
      // don't need (and shouldn't get) an explicit `undefined` property.
      if (createdBy) {
        doc.widgets[entry.id].createdBy = createdBy;
      }
      this.touchModified(doc);
    });
    return entry.id;
  }

  /** remove a widget by ID. no-op if the widget doesn't exist. */
  removeWidget(id: string): void {
    this.handle.change((doc) => {
      delete doc.widgets[id];
      this.touchModified(doc);
    });
  }

  /**
   * merge a partial props patch into an existing widget. no-op if the
   * widget doesn't exist.
   *
   * a mounted widget's *live* state lives in its own per-widget automerge
   * document (`entry.docId`, see `WidgetManager.mountWidget()`) — the
   * `entry.props` seeded here on this canvas doc are only ever read once,
   * to seed that per-widget doc's *initial* content the first time it's
   * created (`entry.docId` still unset). so once a widget has been
   * mounted at least once (the overwhelmingly common case), patching
   * `entry.props` alone is a silent no-op as far as anything the user
   * actually sees is concerned — this method writes to whichever one is
   * actually live: the per-widget doc if `entry.docId` is already set,
   * or `entry.props` (so it seeds correctly on first mount) otherwise.
   */
  async updateWidgetProps(id: string, patch: Record<string, unknown>): Promise<void> {
    const entry = this.getWidget(id);
    if (!entry) return;

    if (entry.docId) {
      try {
        const widgetHandle = await this.repo.find<Record<string, unknown>>(
          entry.docId as DocumentId
        );
        await widgetHandle.whenReady();
        widgetHandle.change((draft) => {
          Object.assign(draft, patch);
        });
      } catch {
        // best-effort — the per-widget doc may not be reachable right now
      }
      return;
    }

    this.handle.change((doc) => {
      const widget = doc.widgets[id];
      if (widget) {
        Object.assign(widget.props as Record<string, unknown>, patch);
        this.touchModified(doc);
      }
    });
  }

  /** move a widget to a new position. */
  moveWidget(id: string, x: number, y: number): void {
    this.handle.change((doc) => {
      const widget = doc.widgets[id];
      if (widget) {
        widget.x = x;
        widget.y = y;
        this.touchModified(doc);
      }
    });
  }

  /** resize a widget. */
  resizeWidget(id: string, width: number, height: number): void {
    this.handle.change((doc) => {
      const widget = doc.widgets[id];
      if (widget) {
        widget.width = width;
        widget.height = height;
        this.touchModified(doc);
      }
    });
  }

  /** update the z-index of a widget. */
  setZIndex(id: string, zIndex: number): void {
    this.handle.change((doc) => {
      const widget = doc.widgets[id];
      if (widget) {
        widget.zIndex = zIndex;
      }
    });
  }

  /** toggle the collapsed state of a widget. */
  setCollapsed(id: string, collapsed: boolean): void {
    this.handle.change((doc) => {
      const widget = doc.widgets[id];
      if (widget) {
        widget.collapsed = collapsed;
      }
    });
  }

  /** bring a widget to the front of all others */
  bringToFront(id: string): void {
    this.handle.change((doc) => {
      if (!doc.widgets[id]) return;
      const order = this.sortedWidgetIds(doc);
      const idx = order.indexOf(id);
      if (idx === -1 || idx === order.length - 1) return;
      order.splice(idx, 1);
      order.push(id);
      this.applyZOrder(doc, order);
    });
  }

  /** move a widget one layer forward (swap with the one above) */
  bringForward(id: string): void {
    this.handle.change((doc) => {
      if (!doc.widgets[id]) return;
      const order = this.sortedWidgetIds(doc);
      const idx = order.indexOf(id);
      if (idx === -1 || idx === order.length - 1) return;
      [order[idx], order[idx + 1]] = [order[idx + 1], order[idx]];
      this.applyZOrder(doc, order);
    });
  }

  /** move a widget one layer backward (swap with the one below) */
  sendBackward(id: string): void {
    this.handle.change((doc) => {
      if (!doc.widgets[id]) return;
      const order = this.sortedWidgetIds(doc);
      const idx = order.indexOf(id);
      if (idx <= 0) return;
      [order[idx], order[idx - 1]] = [order[idx - 1], order[idx]];
      this.applyZOrder(doc, order);
    });
  }

  /** send a widget to the back (behind all others) */
  sendToBack(id: string): void {
    this.handle.change((doc) => {
      if (!doc.widgets[id]) return;
      const order = this.sortedWidgetIds(doc);
      const idx = order.indexOf(id);
      if (idx <= 0) return;
      order.splice(idx, 1);
      order.unshift(id);
      this.applyZOrder(doc, order);
    });
  }

  /**
   * get the z-order position (0-based, ascending) of a widget and the total count.
   * returns { position: 0, total: 0 } if the widget doesn't exist.
   */
  getLayerInfo(id: string): { position: number; total: number } {
    const doc = this.doc();
    const order = this.sortedWidgetIdsFromDoc(doc);
    const total = order.length;
    const position = order.indexOf(id);
    return { position: position === -1 ? 0 : position, total };
  }

  /** return widget ids sorted ascending by zIndex, with id as stable tiebreaker */
  private sortedWidgetIds(doc: CanvasDocument): string[] {
    return Object.values(doc.widgets)
      .sort((a, b) => {
        const zA = a.zIndex || 0;
        const zB = b.zIndex || 0;
        if (zA !== zB) return zA - zB;
        return a.id < b.id ? -1 : 1;
      })
      .map((w) => w.id);
  }

  /** same as sortedWidgetIds but works on a plain (non-draft) doc for getLayerInfo */
  private sortedWidgetIdsFromDoc(doc: CanvasDocument): string[] {
    return Object.values(doc.widgets)
      .sort((a, b) => {
        const zA = a.zIndex || 0;
        const zB = b.zIndex || 0;
        if (zA !== zB) return zA - zB;
        return a.id < b.id ? -1 : 1;
      })
      .map((w) => w.id);
  }

  /** update the lastModified timestamp on the document. */
  private touchModified(doc: CanvasDocument): void {
    doc.lastModified = new Date().toISOString();
    if (this._localNodeId) {
      doc.lastModifiedBy = this._localNodeId;
    }
  }

  /** reassign zIndexes 0, 1, 2, ... according to the given id order */
  private applyZOrder(doc: CanvasDocument, orderedIds: string[]): void {
    for (let i = 0; i < orderedIds.length; i++) {
      const widget = doc.widgets[orderedIds[i]];
      if (widget) widget.zIndex = i;
    }
  }

  /** set the docId for a widget's per-widget automerge document. */
  setDocId(widgetId: string, docId: string): void {
    this.handle.change((doc) => {
      const widget = doc.widgets[widgetId];
      if (widget) {
        widget.docId = docId;
      }
    });
  }

  /** set the display title for a widget. stored on the canvas entry, not the per-widget doc. */
  setWidgetTitle(widgetId: string, title: string): void {
    this.handle.change((doc) => {
      const widget = doc.widgets[widgetId];
      if (widget) {
        widget.title = title;
        this.touchModified(doc);
      }
    });
  }

  /** set the parentId for a widget (nest it inside a bin). pass null to un-nest. */
  setParentId(widgetId: string, parentId: string | null): void {
    this.handle.change((doc) => {
      const widget = doc.widgets[widgetId];
      if (widget) {
        widget.parentId = parentId;
        this.touchModified(doc);
      }
    });
  }

  /** un-nest a widget and move it in a single atomic change.
   *  avoids the race where setParentId triggers reconcile before moveWidget runs. */
  unparentAndMove(widgetId: string, x: number, y: number): void {
    this.handle.change((doc) => {
      const widget = doc.widgets[widgetId];
      if (widget) {
        widget.parentId = null;
        widget.x = x;
        widget.y = y;
        this.touchModified(doc);
      }
    });
  }

  /** get all widget entries that are children of the given parent. */
  getChildren(parentId: string): WidgetEntry[] {
    return Object.values(this.doc().widgets).filter((w) => w.parentId === parentId);
  }

  // -- deletion --------------------------------------------------------------

  /** whether this canvas has been marked as deleted. */
  get isDeleted(): boolean {
    return this.doc().deleted === true;
  }

  /** mark this canvas as deleted with the given mode.
   *  writes tombstone fields into the document so all peers see the deletion. */
  deleteCanvas(mode: "soft" | "purge"): void {
    this.handle.change((doc) => {
      doc.deleted = true;
      doc.deletedAt = new Date().toISOString();
      doc.deletedBy = this._localNodeId;
      doc.deleteMode = mode;
      this.touchModified(doc);
    });
  }

  /** clear all tombstone fields to un-delete this canvas.
   *  the canvas watchers will detect the un-deletion and clear
   *  the card's tombstone mirror fields automatically. */
  restoreCanvas(): void {
    this.handle.change((doc) => {
      doc.deleted = false;
      doc.deletedAt = "";
      doc.deletedBy = "";
      // deleteMode is typed as "soft" | "purge" — use any cast to clear with ""
      (doc as any).deleteMode = "";
      this.touchModified(doc);
    });
  }

  /** subscribe to document changes. returns an unsubscribe function. */
  onChange(handler: (doc: CanvasDocument) => void): () => void {
    const listener = () => {
      handler(this.doc());
    };
    this.handle.on("change", listener);
    return () => {
      this.handle.off("change", listener);
    };
  }

  /**
   * broadcast an ephemeral message to all connected peers.
   * used by the presence manager for cursors, locks, and online status.
   * ephemeral messages are not persisted — they exist only in transit.
   */
  broadcastEphemeral(data: Uint8Array): void {
    this.handle.broadcast(data);
  }

  /**
   * subscribe to ephemeral messages from other peers.
   * the senderId is the automerge-repo peerId of the sender.
   * returns an unsubscribe function.
   */
  onEphemeral(handler: EphemeralHandler): () => void {
    const listener = (event: { senderId: PeerId; message: unknown }) => {
      handler(event.senderId as string, event.message as Uint8Array);
    };
    this.handle.on("ephemeral-message", listener);
    return () => {
      this.handle.off("ephemeral-message", listener);
    };
  }

  /** set a callback that checks whether a peer nodeId is currently connected.
   *  used by widgets to sort peers online-first for snatch operations. */
  setPeerOnlineChecker(checker: (nodeId: string) => boolean): void {
    this._peerOnlineChecker = checker;
  }

  /** check whether a peer is currently connected at the transport level.
   *  returns false if no checker is configured or the peer is offline. */
  isPeerOnline(nodeId: string): boolean {
    return this._peerOnlineChecker?.(nodeId) ?? false;
  }
}
