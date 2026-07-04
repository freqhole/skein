import type { Container } from "pixi.js";
import type { z } from "zod";
import type { CanvasStore } from "../../../src/canvas/canvas-store";
import type { ProfileStore } from "../../../src/canvas/profile-doc";
import type { KeyboardDriver } from "../../../src/widgets/keyboard-driver";
import type { socialSchema } from "./schema";

// ---------------------------------------------------------------------------
// social widget doc type
// ---------------------------------------------------------------------------

export type SocialState = z.infer<typeof socialSchema>;

/**
 * minimal typed facade over the social widget's automerge doc.
 * mirrors WidgetDoc but typed to socialSchema specifically.
 */
export interface SocialDoc {
  readonly current: SocialState;
  change(fn: (draft: SocialState) => void): void;
  on(event: "change", handler: (state: SocialState) => void): () => void;
}

// ---------------------------------------------------------------------------
// tab system
// ---------------------------------------------------------------------------

/**
 * shared context passed to every tab factory.
 * contains everything a tab needs to render and interact.
 */
export interface TabContext {
  /** typed social doc facade */
  doc: SocialDoc;
  /** the canvas DOM element — needed for DOM overlays (e.g. text input) */
  canvasElement: HTMLCanvasElement;
  /** keyboard driver for text input / IME */
  keyboard: KeyboardDriver;
  /** the widget's unique ID in the canvas store */
  widgetId: string;
  /** the currently-open canvas's store (the canvas the social overlay is
   *  mounted on top of — narthex included). used by profile-tab.ts to read
   *  title/description/color for "add current canvas to profile". may be
   *  undefined in contexts that don't thread it through (e.g. some test
   *  harnesses). */
  canvasStore?: CanvasStore;
  /** the local peer's own profile doc store (docs/hub-and-profile-plan.md
   *  section 6). used by profile-tab.ts to manage the profile's curated
   *  canvas list. undefined until boot.ts has resolved it. */
  profileStore?: ProfileStore;
  /** the narthex's own document id \u2014 lets profile-tab.ts tell whether
   *  `canvasStore` above IS the narthex meta-canvas (rather than a real
   *  canvas), since the narthex should never be offered for "add to
   *  profile" (it's a private per-user index, not something to publish or
   *  share). undefined in contexts that don't thread it through. */
  narthexDocId?: string;
  /** the narthex's own `CanvasStore` \u2014 lets profile-tab.ts add/remove
   *  widgets on the narthex directly, even while the social overlay is
   *  mounted on top of some OTHER (non-narthex) canvas. used by
   *  `addCurrentCanvasToProfile()`'s "auto-show the own-canvas-bin widget
   *  the first time a canvas is added to the profile" wiring. `null` means
   *  boot.ts tried and failed to resolve it; `undefined` means it was
   *  never threaded through at all (e.g. some test harnesses). */
  narthexStore?: CanvasStore | null;
}

/**
 * returned by each tab factory. the main social widget manages
 * visibility and positioning; the tab handles its own internals.
 */
export interface TabController {
  /** root pixi container for this tab's content */
  container: Container;
  /** re-layout within the given content bounds (width × height). */
  layout(width: number, height: number): void;
  /** tear down all resources (event listeners, textures, input handles). */
  destroy(): void;
}

/**
 * factory function signature for creating a tab.
 */
export type TabFactory = (ctx: TabContext) => TabController;
