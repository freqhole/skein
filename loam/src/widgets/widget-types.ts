import type { Container } from "pixi.js";
import { z } from "zod";
import type { PendingCanvasKnock } from "../canvas/canvas-doc";
import type { CanvasStore } from "../canvas/canvas-store";
import type { ConnectionStateSource } from "../canvas/connection-status";
import type { ProfileStore } from "../canvas/profile-doc";
import type { PeersMap } from "../file-utils/file-shared";
import type { KeyboardDriver } from "./keyboard-driver";

/**
 * sentinel value representing a transparent color in color props.
 * widgets should check for this value and use alpha: 0 when drawing.
 */
export const TRANSPARENT_COLOR = -1;

/**
 * convert a color value to a safe PixiJS-compatible number.
 * returns 0x000000 for the transparent sentinel (-1), otherwise passes through.
 * use this anywhere a color flows into PixiJS Text style `fill` or other APIs
 * that go through the Color class (which rejects -1).
 */
export function safeColor(color: number): number {
  return color === TRANSPARENT_COLOR ? 0x000000 : color;
}

/**
 * check whether a color value represents transparent.
 */
export function isTransparent(color: number): boolean {
  return color === TRANSPARENT_COLOR;
}

/**
 * an action button that a widget exposes in the property tray.
 * unlike header actions (which live in the frame header bar), widget actions
 * appear as buttons in the prop tray flyout when the widget is selected.
 */
export interface WidgetAction {
  /** unique identifier for this action */
  id: string;
  /** display label shown on the button */
  label: string;
  /** click handler */
  onClick: () => void;
}

/**
 * a button or info badge that a widget can inject into the frame header.
 * widgets return these from create() and/or update them dynamically via
 * setHeaderActions() on the mount context.
 */
export interface HeaderAction {
  /** unique identifier for this action (used for diffing / updates) */
  id: string;
  /** display label shown in the header button */
  label: string;
  /** if true, rendered as a non-clickable info badge (e.g. item count) */
  isInfo?: boolean;
  /** when true, the button background is filled with the accent (magenta) color */
  active?: boolean;
  /** when true, the button is dimmed and clicks are ignored (e.g. "snatch
   *  all" once everything in a bin is already local). unlike `isInfo`, the
   *  button still looks/behaves like an action button, just inert. */
  disabled?: boolean;
  /**
   * optional compact label used in the header button when space is tight.
   * the full `label` is still shown in the hamburger overflow flyout.
   * use for icon characters (e.g. "✕" for eraser) where a short glyph is
   * more readable than the full word at small button sizes.
   * ignored when `renderIcon` is provided.
   */
  shortLabel?: string;
  /**
   * optional icon renderer — when provided, the button displays a drawn icon
   * instead of text.  the callback receives a Container to add child Graphics
   * into, the available square size in pixels, and the recommended foreground
   * color (white when active/magenta, theme text color when inactive).
   * using a Container allows separate rotation groups (e.g. a rotated eraser
   * body + non-rotated dashes beneath it).
   */
  renderIcon?: (container: Container, size: number, color: number) => void;
  /**
   * extra space (px) added to the left of this button in the header.
   * use to visually separate button groups (e.g. a gap before the opacity scrubber).
   */
  marginLeft?: number;
  /** click handler — ignored when isInfo is true.
   *  receives the tap's global PixiJS stage position so handlers that need
   *  to open a DOM popup (e.g. a colour picker) can compute screen coords.
   */
  onClick?: (globalPos?: { x: number; y: number }) => void;
  /**
   * optional drag handler — when provided the button becomes a drag scrubber.
   * called on each pointermove while the button is pressed, with the horizontal
   * delta in pixels since the last call. use for continuously-adjustable values
   * like opacity.
   *
   * important: do NOT call setHeaderActions() inside onDrag — that destroys and
   * recreates the button mid-drag, breaking the interaction after a single pixel.
   * use onDragEnd to refresh the header once the drag is complete.
   */
  onDrag?: (deltaX: number) => void;
  /**
   * called once when a drag scrubber gesture ends (pointerup / pointerupoutside).
   * the right place to call setHeaderActions() to update the displayed label.
   */
  onDragEnd?: () => void;
  /**
   * optional live label provider for drag scrubbers.
   * called after each onDrag tick to update the button text in real-time
   * without recreating the button. return the string to display.
   * if omitted, the label stays fixed during the drag and updates only on onDragEnd.
   */
  getLiveLabel?: () => string;
}

/**
 * compact display info returned by a widget factory for rendering
 * inside a bin widget. used to show minimized representations of
 * widgets without mounting them.
 */
export interface CompactInfo {
  /** short display text (filename, title, widget name, etc.) */
  label: string;
  /** small image for the card face. data URL or asset URL. */
  thumbnailUrl?: string;
  /** accent color for spine/border tinting (pixi hex number) */
  accentColor?: number;
  /**
   * solid background fill for the fallback (no-thumbnail) card face. when
   * set, replaces the generic accentColor-tinted-rect fallback with a solid
   * fill + optional border showing the widget's real appearance (e.g. a
   * label widget's card looks like a mini version of the label itself).
   * -1 means transparent, same convention as the widgets' own bg colors.
   */
  bgColor?: number;
  /** text color for the fallback card face's label text (used with bgColor) */
  textColor?: number;
  /** border color for the fallback card face border stroke, or -1 for none */
  borderColor?: number;
  /** border width in px for the fallback card face border stroke */
  borderWidth?: number;
  /** media domain hint for media-aware card rendering (e.g. "audio", "video", "photo") */
  domain?: string;
  /** blob ID for media playback (used by bin media controller) */
  blobId?: string;
  /** MIME type hint */
  mime?: string;
  /** original filename (used by action buttons — distinct from label which may be truncated) */
  filename?: string;
  /** blake3 content hash (needed for verified snatch from peers) */
  blake3?: string;
  /** file size in bytes (needed for snatch progress) */
  size?: number;
  /** node IDs that have snatched this blob (used to target peer downloads) */
  snatchedBy?: string[];
  /**
   * bound closure (state already captured) for building a richer bin-card
   * preview than the generic play/pause raw-media handling — see
   * `WidgetFactory.getBinPreview()`. populated by the bin's compact-info
   * resolution, not by widget factories themselves.
   */
  createBinPreview?: (ctx: BinPreviewContext) => BinPreviewHandle | null;
}

/**
 * everything a widget's `getBinPreview()` needs to mount its own preview
 * media (DOM video/audio elements etc.) inside a bin card — a bin never
 * mounts a child's full `create()` lifecycle, so this is a much smaller
 * surface than `WidgetMountContext`.
 */
export interface BinPreviewContext {
  widgetId: string;
  /** the card's pixi container — preview media (e.g. a DOM video tracker)
   *  positions/sizes itself against this, same as any other bin card. */
  container: Container;
  canvasElement: HTMLCanvasElement;
  getSize: () => { width: number; height: number };
  getPeers: () => PeersMap | undefined;
}

/** returned by `WidgetFactory.getBinPreview()` — the bin's media controller
 *  drives playback through this instead of its generic raw-media handling. */
export interface BinPreviewHandle {
  /** true once media is actively playing (used to keep the card's play/
   *  pause icon in sync after an async `onTap()`/`onDoubleTap()`). */
  isPlaying: () => boolean;
  /** tap on the card face — play if stopped/paused, pause if playing.
   *  builds any underlying media element lazily on first call. */
  onTap: () => Promise<void>;
  /** double-tap on the card face — e.g. request fullscreen. */
  onDoubleTap: () => void;
  /** explicit "stop and clear" — tears down any mounted media element
   *  entirely (so it stops floating over other canvas content), reverting
   *  the card to its poster/thumbnail. `onTap()` can re-create it lazily. */
  onStop: () => void;
  /** full teardown when the card itself is removed from the bin. */
  destroy: () => void;
}

/**
 * a validated, Automerge-backed document facade for widget state.
 * widgets interact with their state exclusively through this interface.
 * they never see Automerge directly.
 */
export interface WidgetDoc<S extends z.ZodType> {
  /** the current validated state (Zod-parsed on every read) */
  readonly current: z.infer<S>;
  /** mutate the underlying Automerge document */
  change(fn: (draft: z.infer<S>) => void): void;
  /** subscribe to state changes. returns an unsubscribe function. */
  on(event: "change", handler: (state: z.infer<S>) => void): () => void;
}

/**
 * a pending knock (canvas access request) on some canvas OTHER than the
 * one a widget is currently mounted on, plus enough context to render and
 * label it — see `OtherCanvasKnocksSource`'s doc comment for why this
 * exists.
 */
export interface OtherCanvasKnockEntry {
  canvasDocId: string;
  /** the owning canvas's title, for labeling a merged cross-canvas row
   *  (e.g. messagez-widget.ts's knock rows) so it's clear which canvas the
   *  request is for. */
  canvasTitle: string;
  knock: PendingCanvasKnock;
}

/**
 * lets a widget mounted on ONE canvas (or narthex, which has no canvas of
 * its own) see and act on pending knocks recorded on every OTHER canvas
 * the local peer admins — without this, a knock notification could only
 * ever be seen/dismissed/approved while that exact canvas happened to be
 * open (a real reported bug/request: "i want to see these knock access
 * requests on the narthex or any canvas, not just when i have that canvas
 * open"). only wired in for the messagez widget's overlay mount
 * (boot.ts); undefined for other widgets and for headless/test contexts.
 */
export interface OtherCanvasKnocksSource {
  /** current snapshot of pending, non-dismissed knocks across every admin
   *  canvas other than the one this widget is mounted on. pull-based —
   *  call again after `onChange()` fires, don't cache the array. */
  list(): OtherCanvasKnockEntry[];
  /** subscribe to "something in the snapshot may have changed, call
   *  list() again and re-render" — fires on narthex card-list changes and
   *  on any admin canvas doc's own changes. returns an unsubscribe
   *  function. */
  onChange(handler: () => void): () => void;
  /** get a `CanvasStore` for `canvasDocId` (one of the ids returned by
   *  `list()`) so the caller can actually approve/decline the knock —
   *  undefined if that canvas's handle isn't ready/known anymore (e.g. it
   *  was removed from narthex between `list()` and this call). */
  getStore(canvasDocId: string): CanvasStore | undefined;
}

/**
 * context passed to a widget factory's create() function.
 * contains everything a widget needs to render and interact with its state.
 */
export interface WidgetMountContext<S extends z.ZodType = z.ZodType> {
  /** the Zod-validated document facade for this widget's state */
  doc: WidgetDoc<S>;
  /** the width allocated by the canvas frame */
  width: number;
  /** the height allocated by the canvas frame */
  height: number;
  /** the keyboard driver for text input / IME. call acquire() to claim focus. */
  keyboard: KeyboardDriver;
  /** the widget's unique ID in the canvas store */
  widgetId: string;
  /** the canvas DOM element — used for positioning DOM overlays (e.g. textarea editing) */
  canvasElement: HTMLCanvasElement;
  /** the canvas store — provides read/write access to canvas-level metadata.
   *  available on regular canvases; may be undefined for headless or test contexts. */
  canvasStore?: CanvasStore;
  /** the local peer's own profile doc store (docs/hub-and-profile-plan.md
   *  section 6) — lets a widget read/edit the profile's curated canvas list.
   *  only wired in for the social widget's overlay mount (boot.ts); undefined
   *  for other widgets and for headless/test contexts. */
  profileStore?: ProfileStore;
  /** the narthex's own document id, so a widget mounted on `canvasStore` can
   *  tell whether the currently-open canvas IS the narthex meta-canvas
   *  (rather than a real user canvas) — the narthex should never be
   *  offered for "add to profile"/sharing affordances (it's a private
   *  per-user index of canvas-card references, not something the profile
   *  system or a remote peer should ever see). only wired in for the social
   *  widget's overlay mount (boot.ts); undefined for other widgets and for
   *  headless/test contexts. */
  narthexDocId?: string;
  /** the narthex's own `CanvasStore` — lets a widget mounted on some OTHER
   *  canvas (`canvasStore` above) still reach/mutate the narthex directly,
   *  e.g. profile-tab.ts's "auto-show the own-canvas-bin widget on the
   *  narthex the first time a canvas is added to the profile" (see
   *  docs/narthex-widgets-and-file-transfer-plan.md section 1). only
   *  wired in for the social widget's overlay mount (boot.ts); undefined
   *  for other widgets and for headless/test contexts. `null` means
   *  boot.ts tried to resolve it and failed (no narthex doc yet, or the
   *  open failed) — distinct from `undefined` (never wired in at all). */
  narthexStore?: CanvasStore | null;
  /** transport-level connection state (peer count, reconnect status) and a
   *  `retryFailed()` escape hatch — lets a widget offer its own reconnect
   *  affordance (e.g. canvas-info's connection banner) instead of relying on
   *  the connection-status pill's click handler, which only opens canvas info
   *  and never triggers a reconnect itself. only wired in for the canvas-info
   *  widget's overlay mount (boot.ts); undefined for other widgets and for
   *  headless/test contexts. */
  connectionState?: ConnectionStateSource | null;
  /** dynamically update the custom header actions shown in the widget frame.
   *  call this whenever the action labels or set of actions changes (e.g. item
   *  count updated, snatch progress). provided by the widget manager at mount time. */
  setHeaderActions?: (actions: HeaderAction[]) => void;
  /** fill the header title text's background from 0 (transparent) to 1 (fully
   *  accent-colored) — e.g. audio/voice-recording widgets use this to show
   *  playback progress right behind the title. pass null to clear it.
   *  provided by the widget manager at mount time. */
  setTitleProgress?: (progress: number | null) => void;
  /** pending knocks on every OTHER admin canvas — see
   *  `OtherCanvasKnocksSource`'s doc comment. only wired in for the
   *  messagez widget's overlay mount (boot.ts); undefined for other
   *  widgets and for headless/test contexts. */
  otherCanvasKnocks?: OtherCanvasKnocksSource;
  /** the pan/zoom-affected world container that hosts every widget frame on
   *  the currently open canvas. an overlay widget (rendered as a stage
   *  sibling of `world`, not a descendant — see `widget-overlay.ts`) can
   *  still convert a drag gesture's global pointer position into world-space
   *  coordinates via `world.toLocal(event.global)`, the same conversion
   *  `bin-drag.ts` uses for in-canvas widget drags, since both live under
   *  the same PixiJS stage. only wired in for the filez widget's overlay
   *  mount (boot.ts), to support dragging a local-files row onto the
   *  canvas; undefined for other widgets and for headless/test contexts. */
  world?: Container;
}

/**
 * handler for widgets that accept drop operations (e.g. bins).
 * the widget manager checks live widgets for this during frame drags
 * and forwards hover/drop events.
 */
export interface DropTargetHandler {
  /** test if a world-space point falls inside this widget's drop zone */
  hitTest(worldX: number, worldY: number): boolean;
  /** called each frame while a dragged widget hovers over this target */
  onHover(worldX: number, worldY: number, draggedWidgetId: string): void;
  /** called when the dragged widget leaves this target's zone */
  onLeave(): void;
  /** called when a widget is dropped on this target. return true if the
   *  drop was consumed (widget will be nested). return false to let the
   *  normal drop flow proceed. */
  onDrop(widgetId: string, worldX: number, worldY: number): boolean;
}

/**
 * the object returned by a widget factory's create() function.
 * the canvas uses this to manage the widget's lifecycle.
 */
export interface WidgetController {
  /** the PixiJS container to add to the stage */
  container: Container;
  /** called when the widget is removed from the canvas */
  destroy: () => void;
  /** called when the canvas frame resizes. optional. */
  resize?: (width: number, height: number) => void;
  /**
   * called on every tick of a live frame drag (own drag or batch-drag as
   * part of a multi-selection) — the frame's pixi container has already
   * moved, but anything anchored via `position: fixed` DOM coordinates
   * (see dom-overlay.ts) doesn't follow on its own. widgets with an active
   * DOM text-input overlay (label/notepad/markdown) implement this to call
   * the overlay's own `reposition()`. optional — most widgets have nothing
   * to do here.
   */
  onReposition?: () => void;
  /**
   * called whenever a `WidgetOverlay`-hosted widget (social/messages/
   * canvas-info panels) is shown or hidden via toggle()/close() — NOT
   * called for ordinary canvas widgets, which are never hidden this way.
   * used by messagez-widget.ts to reset its "keep this just-accepted
   * invite row visible" state once the panel is actually closed, instead
   * of on every re-render.
   */
  onVisibilityChange?: (visible: boolean) => void;
  /** declare input/output ports for dataflow wiring between widgets (future) */
  ports?: () => WidgetPortDeclaration;
  /** optional drop target handler — when present, the widget manager will
   *  check this widget for drop overlap during frame drags. used by bins
   *  to accept widgets being dragged onto them. */
  dropTarget?: DropTargetHandler;
  /** optional: called when the widget enters or leaves maximized (full-viewport) mode.
   *  widgets can use this to render richer UI when they have more space. */
  setMaximized?: (maximized: boolean) => void;
  /** optional initial header actions to inject into the frame header bar.
   *  these are set once at mount time; use ctx.setHeaderActions() for dynamic updates. */
  headerActions?: HeaderAction[];
  /** optional initial title-progress fill (0–1) — see ctx.setTitleProgress(). */
  titleProgress?: number | null;
  /** optional action buttons shown in the property tray when this widget is selected.
   *  used for widget-specific operations like "tidy" in the bin widget. */
  widgetActions?: WidgetAction[];

  /** read-only label/value rows rendered in the property tray above the
   *  widget action buttons (e.g. "who has this file" for file widgets).
   *  called when the tray opens for this widget — values are a snapshot,
   *  not live-updating. */
  widgetInfoRows?: () => Array<{ label: string; value: string }>;
  /**
   * instance-level editable props override. when present, the property tray
   * uses these instead of the factory's static `editableProps`. use this
   * when prop definitions depend on instance state — e.g. a select whose
   * options are populated at runtime (audio device list, etc.).
   */
  editableProps?: WidgetPropDef[];
}

/**
 * metadata about a widget type, used for the palette and registry.
 */
export interface WidgetMetadata {
  name: string;
  description?: string;
  version: string;
  icon?: string;
  category?: string;
  /** hide this widget from the palette (e.g. programmatically-spawned widgets) */
  hidden?: boolean;
  /** when true, this widget type is only available in tauri (desktop) mode.
   *  the flyout hides it for browser-only peers. use for widgets that depend
   *  on native-only capabilities (e.g. peedeeeff requires the rust pdf
   *  rendering pipeline). */
  tauriOnly?: boolean;
  /** singleton widgets have a well-known ID and cannot be deleted via the
   *  frame close button. the flyout hides them when already on the canvas.
   *  use for persistent narthex widgets like profile and friends. */
  singleton?: boolean;
  /** well-known widget ID used when `singleton` is true. the toolbar uses
   *  this instead of a random UUID so the per-widget automerge doc persists
   *  across close/reopen cycles. */
  singletonId?: string;
  /** unique widgets are hidden from the flyout when one is already on the canvas,
   *  but unlike singletons they can still be deleted. use for widgets where only
   *  one instance makes sense (e.g. trash can) but the user may remove and re-add. */
  unique?: boolean;
  /** when true, closing this widget un-parents its children back to the canvas
   *  instead of cascade-deleting them. use for container widgets whose contents
   *  should survive the container being removed (e.g. trash can — cards spill
   *  out onto the narthex instead of being permanently deleted). */
  preserveChildren?: boolean;
  /** default width when placing the widget on the canvas */
  defaultWidth?: number;
  /** default height when placing the widget on the canvas */
  defaultHeight?: number;
  /** whether this widget can be maximized via the frame header button.
   *  defaults to true when omitted. set to false for widgets that should
   *  never fill the canvas (e.g. canvas cards). */
  maximizable?: boolean;
  /** "dismissable" widgets show an "x" close button in the frame header
   *  (between maximize and the layer flyout) that closes them directly,
   *  without going through the property tray's delete action. use for
   *  small utility panels the user expects to be able to quickly dismiss
   *  (e.g. the trash can). defaults to false when omitted. */
  closable?: boolean;
}

/**
 * a widget factory defines a type of widget that can be placed on the canvas.
 * stateless widgets omit the schema field.
 * stateful widgets provide a Zod schema for their internal state.
 */
export interface WidgetFactory<S extends z.ZodType = z.ZodType> {
  /** unique type identifier (e.g., "counter", "hello-world") */
  type: string;
  /** metadata for display in the widget palette */
  metadata: WidgetMetadata;
  /** Zod schema for the widget's internal state. omit for stateless widgets. */
  schema?: S;
  /**
   * one-time repair pass for documents written under an earlier version of
   * `schema` that the current schema no longer accepts (e.g. a renamed enum
   * value) — invoked, via `createWidgetDoc`, only when the initial parse of
   * an existing document fails. mutates the raw automerge doc directly so
   * the fix is permanent and syncs to every peer, instead of being silently
   * re-applied (or discarded to defaults) on every read.
   */
  migrate?: (raw: any) => void;
  /** editable properties shown in the property editor panel when this widget is selected in edit mode */
  editableProps?: WidgetPropDef[];
  /**
   * extract compact display info from the widget's state.
   * used by bin widgets to render children in minimized form.
   * does not require the widget to be mounted — pure function of state.
   */
  getCompactInfo?: (state: z.infer<S>) => CompactInfo;
  /**
   * optional: build a richer bin-card preview than the generic play/pause
   * raw-media handling (e.g. stfu's cut/mute/overlay effects and audio-clip
   * playback) — still without the bin ever mounting this widget's full
   * `create()`/timeline UI. pure function of state + a small preview
   * context; omit to fall back to the bin's generic media handling for
   * this widget's `getCompactInfo().domain`.
   */
  getBinPreview?: (state: z.infer<S>, ctx: BinPreviewContext) => BinPreviewHandle | null;
  /**
   * called when a compact card for this widget is tapped inside a bin.
   * pure function of state — the widget is not mounted when this fires.
   * use for navigation or other side-effects (e.g., canvas-card opens the canvas).
   * if omitted, tapping a compact card does nothing.
   */
  onCompactActivate?: (state: z.infer<S>) => void;
  /**
   * called before a widget is closed via the property tray delete button or
   * frame close. if provided and returns true, the default close behavior
   * (cascade-delete descendants + remove) is skipped — the factory handles
   * the close itself.
   *
   * use for widgets that need custom close semantics, e.g. canvas-card
   * redirects close to soft-delete + move to trash instead of hard-deleting
   * the linked canvas document.
   */
  onBeforeClose?: (widgetId: string, store: CanvasStore) => boolean;
  /** create a widget instance given a mount context */
  create(ctx: WidgetMountContext<S>): WidgetController;
}

/**
 * definition for a single editable property shown in the property editor.
 */
export interface WidgetPropDef {
  key: string;
  label: string;
  type: "string" | "number" | "boolean" | "color" | "select" | "image";
  /**
   * static option list for "select" props.
   * may also be a function — called fresh each time the dropdown opens,
   * so runtime-populated lists (e.g. enumerated audio devices) always reflect
   * the latest state.
   */
  options?: string[] | (() => string[]);
  default?: unknown;
  /** for number props: minimum allowed value (defaults to 1 if omitted) */
  min?: number;
  /** for number props: maximum allowed value (defaults to 100 if omitted) */
  max?: number;
  /** for number props: increment applied by the +/- buttons and used to snap
   *  typed values (defaults to 1 if omitted). use a fractional value (e.g.
   *  0.1) for props like a speech rate multiplier. */
  step?: number;
  /** for image props: maximum output width in pixels */
  imageMaxWidth?: number;
  /** for image props: maximum output height in pixels */
  imageMaxHeight?: number;
  /** for image props: center-crop to square before resizing */
  imageCropSquare?: boolean;
  /** only show this prop when another prop equals a specific value, or (if
   *  an array) one of several values */
  visibleWhen?: { key: string; value: unknown | unknown[] };
}

/**
 * declares the input and output ports for a widget.
 * ports enable dataflow connections between widgets on the canvas.
 */
export interface WidgetPortDeclaration {
  inputs?: PortDef[];
  outputs?: PortDef[];
}

/**
 * definition of a single port on a widget.
 */
export interface PortDef {
  /** unique name within the widget (e.g., "album_list", "query_result") */
  name: string;
  /** human-readable label shown in the UI */
  label: string;
  /** type tag for compatibility checking between connected ports */
  dataType: string;
}
