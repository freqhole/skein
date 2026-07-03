// ---------------------------------------------------------------------------
// profile tab — avatar, username, bio, accent color, node ID
// ---------------------------------------------------------------------------

import { Assets, Circle, Container, Graphics, Rectangle, Sprite, Text, Texture } from "pixi.js";
import { ensureMyCanvasBinDoc } from "../../../src/canvas/canvas-bin-doc";
import { registerSocialBridge } from "../../../src/dev/test-bridge-registry";
import {
  ensureIdentity,
  getStoredIdentity,
  importIdentityFromBundle,
  onIdentityChange,
} from "../../../src/p2p/identity";
import { pickImageAsDataUrl } from "../../../src/widgets/image-utils";
import { createSkeinInput, type SkeinInputHandle } from "../../../src/widgets/skein-input";
import {
  ACCENT,
  AVATAR_EXPORT_SIZE,
  AVATAR_RADIUS,
  BUTTON_HEIGHT,
  BUTTON_RADIUS,
  COLOR_DOT_GAP,
  COLOR_DOT_RADIUS,
  COLOR_PALETTE,
  COLOR_RING_INSET,
  FIELD_GAP,
  FIELD_HEIGHT,
  FONT,
  LABEL_COLOR,
  LABEL_SIZE,
  MUTED_TEXT,
  PROFILE_CANVAS_ROW_HEIGHT,
  PROFILE_CANVAS_SWATCH_SIZE,
  RESOLUTION,
  ROW_ALT_BG,
  SCROLL_SPEED,
  TEXT_COLOR,
  TEXT_SIZE,
} from "./constants";
import { truncate } from "./helpers";
import type { TabContext, TabController } from "./types";

// ---------------------------------------------------------------------------
// field helper (username / bio)
// ---------------------------------------------------------------------------

interface FieldEntry {
  label: Text;
  handle: SkeinInputHandle;
  profileKey: "username" | "bio";
  layoutAt(x: number, y: number, w: number): void;
}

function createField(
  ctx: TabContext,
  parent: Container,
  labelStr: string,
  profileKey: "username" | "bio",
  placeholder: string,
  currentWidth: number
): FieldEntry {
  const label = new Text({
    text: labelStr,
    style: { fontFamily: FONT, fontSize: LABEL_SIZE, fill: LABEL_COLOR },
    resolution: RESOLUTION,
  });
  label.eventMode = "none";
  parent.addChild(label);

  const handle = createSkeinInput({
    canvasElement: ctx.canvasElement,
    width: currentWidth,
    height: FIELD_HEIGHT,
    placeholder,
    value: ctx.doc.current.profile[profileKey] || "",
    onChange: (value: string) => {
      ctx.doc.change((draft) => {
        draft.profile[profileKey] = value;
      });
    },
  });
  parent.addChild(handle.input);

  const layoutAt = (x: number, y: number, w: number) => {
    label.x = x;
    label.y = y;
    handle.input.x = x;
    handle.input.y = y + LABEL_SIZE + 4;
    handle.setWidth(w);
  };

  return { label, handle, profileKey, layoutAt };
}

// ---------------------------------------------------------------------------
// factory
// ---------------------------------------------------------------------------

export function createProfileTab(ctx: TabContext): TabController {
  const profileInner = new Container();
  profileInner.eventMode = "static";

  // outer scrollable/masked viewport (same pattern friends-tab.ts's list
  // and detail views use) — profile content (avatar, fields, "my
  // canvases" list) can easily exceed the social panel's fixed height,
  // and nothing above this tab provides any scroll/clip of its own (see
  // social-widget.ts, which just calls `tab.layout(w, h)` and trusts the
  // tab to fit or scroll itself) — a real user-reported bug, 2026-07-02.
  const container = new Container();
  container.eventMode = "static";

  const scrollMask = new Graphics();
  container.addChild(scrollMask);

  container.addChild(profileInner);
  profileInner.mask = scrollMask;

  let scrollY = 0;
  let scrollAreaHeight = 0;
  // total content height, tracked manually (never read via
  // `profileInner.height`) — `profileInner` has a `.mask` set, and asking
  // Pixi v8 for `.height`/`.getBounds()` on a masked object makes it walk
  // the mask's matrix relative to a shared root to compute "effective"
  // bounds, which both logs a "Mask bounds, renderable is not inside the
  // root container" warning AND can break rendering outright (a real,
  // serious user-reported bug, 2026-07-02: the whole profile view went
  // blank). `bin/bin-renderer.ts`'s `totalContentHeight` field is the
  // established safe alternative this mirrors — layout() already computes
  // the accumulated `y` as it lays out fields, so that value is stored
  // here instead of re-derived from the (masked) display object itself.
  let contentHeight = 0;

  const clampScroll = () => {
    const maxScroll = Math.max(0, contentHeight - scrollAreaHeight);
    scrollY = Math.max(0, Math.min(scrollY, maxScroll));
    profileInner.y = -scrollY;
  };

  container.on("wheel", (e: WheelEvent) => {
    const canScroll = contentHeight > scrollAreaHeight;
    if (!canScroll) return; // let the event pass through to the canvas viewport

    e.stopPropagation();
    if ((e as any).nativeEvent) (e as any).nativeEvent._skeinWidgetScroll = true;
    scrollY += e.deltaY > 0 ? SCROLL_SPEED : -SCROLL_SPEED;
    clampScroll();
  });

  let currentWidth = 0;
  let currentHeight = 0;

  // -------------------------------------------------------------------------
  // avatar area
  // -------------------------------------------------------------------------

  const avatarContainer = new Container();
  avatarContainer.eventMode = "static";
  avatarContainer.cursor = "pointer";
  profileInner.addChild(avatarContainer);

  // placeholder circle (shown when no avatar image is set)
  const avatarPlaceholder = new Graphics();
  avatarPlaceholder.eventMode = "none";
  avatarContainer.addChild(avatarPlaceholder);

  // placeholder text — first letter of username, or "+"
  const avatarInitial = new Text({
    text: "+",
    style: {
      fontFamily: FONT,
      fontSize: 24,
      fontWeight: "bold",
      fill: 0xffffff,
    },
    resolution: RESOLUTION,
  });
  avatarInitial.eventMode = "none";
  avatarInitial.anchor.set(0.5, 0.5);
  avatarContainer.addChild(avatarInitial);

  // sprite for loaded avatar image
  let avatarSprite: Sprite | null = null;
  const avatarMask = new Graphics();
  avatarMask.eventMode = "none";
  avatarContainer.addChild(avatarMask);

  // "tap to change" hint below avatar
  const avatarHint = new Text({
    text: "tap to change",
    style: { fontFamily: FONT, fontSize: 9, fill: MUTED_TEXT },
    resolution: RESOLUTION,
  });
  avatarHint.eventMode = "none";
  avatarHint.visible = false;
  profileInner.addChild(avatarHint);

  avatarContainer.on("pointerover", () => {
    avatarHint.visible = true;
  });
  avatarContainer.on("pointerout", () => {
    avatarHint.visible = false;
  });

  // track avatar center for layout
  let avatarCx = 0;
  let avatarCy = 0;

  const drawAvatarPlaceholder = () => {
    const profile = ctx.doc.current.profile;
    const color = profile.accentColor;

    avatarPlaceholder.clear();
    avatarPlaceholder.circle(avatarCx, avatarCy, AVATAR_RADIUS);
    avatarPlaceholder.fill({ color });

    const initial = profile.username.trim().charAt(0).toUpperCase() || "+";
    avatarInitial.text = initial;
    avatarInitial.x = avatarCx;
    avatarInitial.y = avatarCy;
  };

  const drawAvatarMask = () => {
    avatarMask.clear();
    avatarMask.circle(avatarCx, avatarCy, AVATAR_RADIUS);
    avatarMask.fill({ color: 0xffffff });
  };

  let lastRequestedAvatarUrl = "";

  const updateAvatarSprite = async (dataUrl: string) => {
    // deduplicate — if we're already loading (or loaded) this exact URL, skip.
    // prevents the double-call that happens when pickAvatarFile writes to the
    // doc (firing the change handler) and then the layout also triggers a load.
    if (dataUrl && lastRequestedAvatarUrl === dataUrl) return;

    lastRequestedAvatarUrl = dataUrl;

    // destroy previous sprite if any — clear the stencil mask BEFORE
    // destroying so PixiJS doesn't try to pop a mask on a dead texture.
    if (avatarSprite) {
      avatarContainer.removeChild(avatarSprite);
      avatarSprite.mask = null;
      avatarSprite.destroy();
      avatarSprite = null;
    }

    if (!dataUrl) {
      // no image — nothing to swap to. do NOT unload the old data: URL
      // texture here either — same reasoning as everywhere else in this
      // file: it may still be referenced by another live consumer
      // (another widget rendering the identical data: URL bytes).
      avatarPlaceholder.visible = true;
      avatarInitial.visible = true;
      return;
    }

    avatarPlaceholder.visible = false;
    avatarInitial.visible = false;

    try {
      const texture = await Assets.load<Texture>(dataUrl);
      // race check — another load may have started while we awaited
      if (lastRequestedAvatarUrl !== dataUrl) return;

      avatarSprite = new Sprite(texture);
      avatarSprite.eventMode = "none";
      avatarSprite.anchor.set(0.5, 0.5);
      avatarSprite.x = avatarCx;
      avatarSprite.y = avatarCy;
      avatarSprite.width = AVATAR_RADIUS * 2;
      avatarSprite.height = AVATAR_RADIUS * 2;
      avatarSprite.mask = avatarMask;
      avatarContainer.addChild(avatarSprite);

      // NOTE: do NOT unload the previous data: URL's texture — it can be
      // shared with other live consumers of the identical data: URL bytes
      // (e.g. this same avatar rendered elsewhere). unloading it out from
      // under them crashes the renderer mid-frame ("alphaMode" null error
      // in StencilMaskPipe) — same root cause already fixed the same way
      // in file.ts/property-tray.ts/canvas-wizard.ts/canvas-card.ts/
      // canvas-info.ts/image.ts.
    } catch {
      // failed to load — fall back to placeholder
      avatarPlaceholder.visible = true;
      avatarInitial.visible = true;
    }
  };

  const repositionAvatarSprite = () => {
    if (!avatarSprite) return;
    avatarSprite.x = avatarCx;
    avatarSprite.y = avatarCy;
  };

  // -------------------------------------------------------------------------
  // avatar file picker
  // -------------------------------------------------------------------------

  const pickAvatarFile = async () => {
    const dataUrl = await pickImageAsDataUrl({
      maxWidth: AVATAR_EXPORT_SIZE,
      maxHeight: AVATAR_EXPORT_SIZE,
      quality: 0.8,
      cropSquare: true,
    });
    if (dataUrl) {
      ctx.doc.change((d) => {
        d.profile.avatarDataUrl = dataUrl;
      });
    }
  };
  // register pickAvatar onto the social test bridge (test-bridge-registry.ts
  // owns the window.__skeinTest shape and DEV guard — this widget doesn't
  // touch `window` directly).
  registerSocialBridge({ pickAvatar: pickAvatarFile });

  // -------------------------------------------------------------------------
  // text fields
  // -------------------------------------------------------------------------

  const usernameField = createField(ctx, profileInner, "username", "username", "your name...", 200);
  const bioField = createField(ctx, profileInner, "bio", "bio", "about you...", 200);
  const fields: FieldEntry[] = [usernameField, bioField];

  // wire up avatar click (defined after fields so we can blur them)
  avatarContainer.on("pointertap", (e) => {
    e.stopPropagation();
    for (const f of fields) f.handle.blur();
    pickAvatarFile();
  });

  // -------------------------------------------------------------------------
  // accent color picker
  // -------------------------------------------------------------------------

  const colorLabel = new Text({
    text: "accent color",
    style: { fontFamily: FONT, fontSize: LABEL_SIZE, fill: LABEL_COLOR },
    resolution: RESOLUTION,
  });
  colorLabel.eventMode = "none";
  profileInner.addChild(colorLabel);

  const colorContainer = new Container();
  colorContainer.eventMode = "static";
  profileInner.addChild(colorContainer);

  const colorDots: Graphics[] = [];
  const colorRing = new Graphics();
  colorRing.eventMode = "none";
  colorContainer.addChild(colorRing);

  for (let i = 0; i < COLOR_PALETTE.length; i++) {
    const dot = new Graphics();
    dot.eventMode = "static";
    dot.cursor = "pointer";
    dot.circle(0, 0, COLOR_DOT_RADIUS);
    dot.fill({ color: COLOR_PALETTE[i] });
    colorContainer.addChild(dot);
    colorDots.push(dot);

    dot.on("pointertap", (e) => {
      e.stopPropagation();
      for (const f of fields) f.handle.blur();
      ctx.doc.change((draft) => {
        draft.profile.accentColor = COLOR_PALETTE[i];
      });
      drawColorRing();
      // redraw avatar placeholder if visible (color changed)
      if (!ctx.doc.current.profile.avatarDataUrl) {
        drawAvatarPlaceholder();
      }
    });
  }

  let colorRowX = 0;
  let colorRowY = 0;

  const layoutColorDots = (x: number, y: number) => {
    colorRowX = x;
    colorRowY = y;
    for (let i = 0; i < colorDots.length; i++) {
      colorDots[i].x = x + COLOR_DOT_RADIUS + i * (COLOR_DOT_RADIUS * 2 + COLOR_DOT_GAP);
      colorDots[i].y = y + COLOR_DOT_RADIUS;
    }
    drawColorRing();
  };

  const drawColorRing = () => {
    colorRing.clear();
    const selectedColor = ctx.doc.current.profile.accentColor;
    const idx = COLOR_PALETTE.indexOf(selectedColor);
    if (idx === -1) return;
    const cx = colorRowX + COLOR_DOT_RADIUS + idx * (COLOR_DOT_RADIUS * 2 + COLOR_DOT_GAP);
    const cy = colorRowY + COLOR_DOT_RADIUS;
    colorRing.circle(cx, cy, COLOR_DOT_RADIUS + 3);
    colorRing.stroke({ color: 0xffffff, width: 2 });
  };

  // -------------------------------------------------------------------------
  // node id display (read-only)
  // -------------------------------------------------------------------------

  const nodeIdLabel = new Text({
    text: "node id",
    style: { fontFamily: FONT, fontSize: LABEL_SIZE, fill: LABEL_COLOR },
    resolution: RESOLUTION,
  });
  nodeIdLabel.eventMode = "none";
  profileInner.addChild(nodeIdLabel);

  const nodeIdText = new Text({
    text: "",
    style: { fontFamily: "monospace", fontSize: 9, fill: MUTED_TEXT },
    resolution: RESOLUTION,
  });
  nodeIdText.eventMode = "none";
  profileInner.addChild(nodeIdText);

  // copy button
  const copyBtn = new Container();
  copyBtn.eventMode = "static";
  copyBtn.cursor = "pointer";
  const copyBg = new Graphics();
  copyBtn.addChild(copyBg);
  const copyLabel = new Text({
    text: "copy",
    style: { fontFamily: FONT, fontSize: 9, fill: ACCENT },
    resolution: RESOLUTION,
  });
  copyLabel.eventMode = "none";
  copyBtn.addChild(copyLabel);
  profileInner.addChild(copyBtn);

  copyBtn.on("pointertap", (e) => {
    e.stopPropagation();
    const nid = ctx.doc.current.profile.nodeId;
    if (nid) {
      navigator.clipboard.writeText(nid).catch(() => {});
      copyLabel.text = "copied!";
      setTimeout(() => {
        copyLabel.text = "copy";
      }, 5000);
    }
  });

  let generating = false;

  // -------------------------------------------------------------------------
  // prominent identity setup section — shown when no identity exists
  // -------------------------------------------------------------------------

  const identitySetupContainer = new Container();
  identitySetupContainer.eventMode = "static";
  identitySetupContainer.visible = false;
  profileInner.addChild(identitySetupContainer);

  const setupDescText = new Text({
    text: "generate an identity to connect with friends, share canvases, and use social features.",
    style: {
      fontFamily: FONT,
      fontSize: 11,
      fill: MUTED_TEXT,
      wordWrap: true,
      wordWrapWidth: 200,
    },
    resolution: RESOLUTION,
  });
  setupDescText.eventMode = "none";
  identitySetupContainer.addChild(setupDescText);

  const setupBtn = new Container();
  setupBtn.eventMode = "static";
  setupBtn.cursor = "pointer";
  const setupBtnBg = new Graphics();
  setupBtn.addChild(setupBtnBg);
  const setupBtnText = new Text({
    text: "generate identity",
    style: { fontFamily: FONT, fontSize: TEXT_SIZE, fontWeight: "bold", fill: 0xffffff },
    resolution: RESOLUTION,
  });
  setupBtnText.eventMode = "none";
  setupBtn.addChild(setupBtnText);
  identitySetupContainer.addChild(setupBtn);

  setupBtn.on("pointertap", (e) => {
    e.stopPropagation();
    if (generating) return;
    generating = true;
    setupBtnText.text = "generating...";
    layout(currentWidth, currentHeight);

    ensureIdentity()
      .then((identity) => {
        syncNodeIdToDoc(identity.node_id);
        layout(currentWidth, currentHeight);
      })
      .catch((err) => {
        console.error("[skein:social:profile] identity generation failed:", err);
        setupBtnText.text = "failed";
        setTimeout(() => {
          setupBtnText.text = "generate identity";
        }, 3000);
      })
      .finally(() => {
        generating = false;
      });
  });

  // -------------------------------------------------------------------------
  // import identity UI — shown when user clicks "import existing identity"
  // -------------------------------------------------------------------------

  let importMode = false;

  const importLinkText = new Text({
    text: "import existing identity",
    style: { fontFamily: FONT, fontSize: 10, fill: ACCENT },
    resolution: RESOLUTION,
  });
  importLinkText.eventMode = "static";
  importLinkText.cursor = "pointer";
  identitySetupContainer.addChild(importLinkText);

  const importContainer = new Container();
  importContainer.eventMode = "static";
  importContainer.visible = false;
  identitySetupContainer.addChild(importContainer);

  const importDescText = new Text({
    text: "paste your identity bundle to restore your identity and friend list.",
    style: {
      fontFamily: FONT,
      fontSize: 10,
      fill: MUTED_TEXT,
      wordWrap: true,
      wordWrapWidth: 200,
    },
    resolution: RESOLUTION,
  });
  importDescText.eventMode = "none";
  importContainer.addChild(importDescText);

  let importInputHandle: SkeinInputHandle | null = null;

  const importConfirmBtn = new Container();
  importConfirmBtn.eventMode = "static";
  importConfirmBtn.cursor = "pointer";
  const importConfirmBg = new Graphics();
  importConfirmBtn.addChild(importConfirmBg);
  const importConfirmText = new Text({
    text: "restore",
    style: { fontFamily: FONT, fontSize: TEXT_SIZE, fontWeight: "bold", fill: 0xffffff },
    resolution: RESOLUTION,
  });
  importConfirmText.eventMode = "none";
  importConfirmBtn.addChild(importConfirmText);
  importContainer.addChild(importConfirmBtn);

  const importCancelBtn = new Container();
  importCancelBtn.eventMode = "static";
  importCancelBtn.cursor = "pointer";
  const importCancelText = new Text({
    text: "cancel",
    style: { fontFamily: FONT, fontSize: 10, fill: MUTED_TEXT },
    resolution: RESOLUTION,
  });
  importCancelText.eventMode = "none";
  importCancelBtn.addChild(importCancelText);
  importContainer.addChild(importCancelBtn);

  const importStatusText = new Text({
    text: "",
    style: { fontFamily: FONT, fontSize: 10, fill: 0xef4444 },
    resolution: RESOLUTION,
  });
  importStatusText.eventMode = "none";
  importStatusText.visible = false;
  importContainer.addChild(importStatusText);

  importLinkText.on("pointertap", (e) => {
    e.stopPropagation();
    importMode = true;
    layout(currentWidth, currentHeight);
  });

  importCancelBtn.on("pointertap", (e) => {
    e.stopPropagation();
    importMode = false;
    importStatusText.visible = false;
    importStatusText.text = "";
    layout(currentWidth, currentHeight);
  });

  importConfirmBtn.on("pointertap", (e) => {
    e.stopPropagation();
    if (generating) return;
    const value = importInputHandle?.value?.trim() ?? "";
    if (!value) {
      importStatusText.text = "paste your identity bundle first";
      importStatusText.style.fill = 0xef4444;
      importStatusText.visible = true;
      layout(currentWidth, currentHeight);
      return;
    }

    generating = true;
    importConfirmText.text = "restoring...";
    layout(currentWidth, currentHeight);

    importIdentityFromBundle(value)
      .then(({ identity, friendNodeIds, username, bio }) => {
        syncNodeIdToDoc(identity.node_id);

        // restore username and bio if present in the bundle
        if (username || bio) {
          ctx.doc.change((draft) => {
            if (username) draft.profile.username = username;
            if (bio) draft.profile.bio = bio;
          });
        }

        // add friend node IDs to the social doc
        if (friendNodeIds.length > 0) {
          ctx.doc.change((draft) => {
            for (const nodeId of friendNodeIds) {
              // skip if already in friends list
              const exists = draft.friends.some((f: any) =>
                f.nodeIds.some((n: any) => n.nodeId === nodeId)
              );
              if (!exists) {
                draft.friends.push({
                  id: crypto.randomUUID(),
                  alias: "",
                  username: "",
                  group: "",
                  nodeIds: [
                    {
                      nodeId,
                      addedAt: new Date().toISOString(),
                      lastSeenAt: "",
                      username: "",
                      bio: "",
                      avatarDataUrl: "",
                      profileDocId: "",
                      profileUpdatedAt: "",
                    },
                  ],
                  createdAt: new Date().toISOString(),
                  // a bundle-imported friend id has no hub info attached —
                  // hub status only ever arrives via the isHub flag on a
                  // friend-request/friend-accept message.
                  isHub: false,
                });
              }
            }
          });
        }

        importMode = false;
        importStatusText.visible = false;
        importStatusText.text = "";
        layout(currentWidth, currentHeight);
      })
      .catch((err) => {
        console.error("[skein:social:profile] identity import failed:", err);
        importConfirmText.text = "restore";
        importStatusText.text = "invalid bundle — check and try again";
        importStatusText.style.fill = 0xef4444;
        importStatusText.visible = true;
        layout(currentWidth, currentHeight);
      })
      .finally(() => {
        generating = false;
      });
  });

  // -------------------------------------------------------------------------
  // "my canvases" — curated canvas list on the profile doc
  // (docs/hub-and-profile-plan.md section 6 / section 8 step 7)
  // -------------------------------------------------------------------------

  const canvasSectionLabel = new Text({
    text: "my canvases",
    style: { fontFamily: FONT, fontSize: LABEL_SIZE, fill: LABEL_COLOR },
    resolution: RESOLUTION,
  });
  canvasSectionLabel.eventMode = "none";
  profileInner.addChild(canvasSectionLabel);

  const addCanvasBtn = new Container();
  addCanvasBtn.eventMode = "static";
  addCanvasBtn.cursor = "pointer";
  const addCanvasBtnBg = new Graphics();
  addCanvasBtn.addChild(addCanvasBtnBg);
  const addCanvasBtnText = new Text({
    text: "+ add current canvas",
    style: { fontFamily: FONT, fontSize: TEXT_SIZE, fontWeight: "bold", fill: 0xffffff },
    resolution: RESOLUTION,
  });
  addCanvasBtnText.eventMode = "none";
  addCanvasBtn.addChild(addCanvasBtnText);
  profileInner.addChild(addCanvasBtn);

  const canvasListContainer = new Container();
  canvasListContainer.eventMode = "static";
  profileInner.addChild(canvasListContainer);

  const canvasEmptyText = new Text({
    text: "no canvases on your profile yet",
    style: { fontFamily: FONT, fontSize: 10, fill: MUTED_TEXT },
    resolution: RESOLUTION,
  });
  canvasEmptyText.eventMode = "none";
  canvasEmptyText.visible = false;
  profileInner.addChild(canvasEmptyText);

  /** titles as actually rendered in the list (post-truncation) — exposed to
   *  tests via the profileTab bridge hook so a UI assertion proves the
   *  render actually reflects the doc, not just that the doc changed. */
  let lastRenderedCanvasTitles: string[] = [];

  // bumped every rebuildCanvasList() call — guards the async preview-image
  // loads below (loadCanvasRowPreview()) against attaching a Sprite to a
  // row container a LATER rebuild has already destroyed (rebuildCanvasList()
  // fully tears down and recreates every row each call). same pattern as
  // canvas-bin.ts's `renderGeneration`.
  let canvasListRenderGeneration = 0;

  // canvasDocIds whose preview-image Sprite has actually finished loading
  // and attached, as of the current rebuild generation — exposed via
  // `getLoadedPreviewCanvasIds()` so a test (or live debugging) can prove
  // an image genuinely rendered, not just that `entry.previewUrl` was
  // non-empty (mirrors canvas-bin.ts's `getLoadedPreviewNodeIds()`).
  let loadedPreviewCanvasIds = new Set<string>();

  /**
   * best-effort: load a canvas entry's preview image into the row's swatch
   * area, replacing the plain color swatch once ready. guarded by
   * `myGeneration` so a load that resolves after a LATER rebuild has
   * already torn this row down never touches a destroyed container.
   *
   * NOTE: never call `Assets.unload()` for `dataUrl` — same reasoning as
   * canvas-bin.ts's `loadEndcapPreview()` (data: URLs can be shared with
   * other live consumers of the same texture).
   */
  function loadCanvasRowPreview(
    canvasDocId: string,
    row: Container,
    dataUrl: string,
    size: number,
    myGeneration: number
  ): void {
    Assets.load<Texture>(dataUrl)
      .then((texture) => {
        if (myGeneration !== canvasListRenderGeneration || row.destroyed) return;

        const sprite = new Sprite(texture);
        sprite.eventMode = "none";
        const scale = Math.max(size / texture.width, size / texture.height);
        sprite.width = texture.width * scale;
        sprite.height = texture.height * scale;
        const swatchY = (PROFILE_CANVAS_ROW_HEIGHT - size) / 2;
        sprite.x = (size - sprite.width) / 2;
        sprite.y = swatchY + (size - sprite.height) / 2;

        const mask = new Graphics();
        mask.roundRect(0, swatchY, size, size, 3).fill({ color: 0xffffff });
        row.addChild(mask);
        sprite.mask = mask;
        row.addChild(sprite);
        loadedPreviewCanvasIds.add(canvasDocId);
      })
      .catch(() => {
        // silently keep the color-swatch fallback already drawn.
      });
  }

  /** true if the "add current canvas" button should be shown: needs both a
   *  canvas + profile store, must NOT be the narthex meta-canvas (a private
   *  per-user index of canvas-card references — never something to publish
   *  to a profile or share with a remote peer), and the current canvas must
   *  not already be on the profile (no point offering to re-add it). shared
   *  between layout() and the profileTab test-bridge hook so both agree on
   *  exactly the same visibility rule. */
  const computeCanAddCurrentCanvas = (): boolean => {
    const canvasStore = ctx.canvasStore;
    const profileStore = ctx.profileStore;
    if (!canvasStore || !profileStore) return false;
    if (ctx.narthexDocId && canvasStore.handle.documentId === ctx.narthexDocId) return false;
    const alreadyOnProfile = profileStore
      .canvases()
      .some((c) => c.canvasDocId === canvasStore.handle.documentId);
    return !alreadyOnProfile;
  };

  const addCurrentCanvasToProfile = () => {
    const canvasStore = ctx.canvasStore;
    const profileStore = ctx.profileStore;
    if (!canvasStore || !profileStore) return;
    // defense in depth: never let the narthex meta-canvas itself get added
    // to a profile, even if this got called from somewhere other than the
    // (already-hidden-on-narthex) button — see computeCanAddCurrentCanvas().
    if (ctx.narthexDocId && canvasStore.handle.documentId === ctx.narthexDocId) return;
    const doc = canvasStore.doc();
    profileStore.addCanvasToProfile({
      canvasDocId: canvasStore.handle.documentId,
      title: doc.title || "untitled canvas",
      description: doc.description || undefined,
      color: doc.color || undefined,
      // carry over a preview image if one was already set on the canvas
      // itself (canvas-info.ts's manual "pick image" -> setPreviewUrl()) —
      // this was previously silently dropped here, so a canvas WITH a real
      // preview image still showed no image anywhere it was curated onto a
      // profile (a real user-reported bug, 2026-07-02). there's no
      // automatic screenshot-capture anywhere in this app — previewUrl is
      // only ever populated by that manual canvas-info.ts flow today.
      previewUrl: doc.previewUrl || undefined,
    });
    layout(currentWidth, currentHeight);
  };

  addCanvasBtn.on("pointertap", (e) => {
    e.stopPropagation();
    addCurrentCanvasToProfile();
  });

  const removeCanvasFromProfile = (canvasDocId: string) => {
    ctx.profileStore?.removeCanvasFromProfile(canvasDocId);
    layout(currentWidth, currentHeight);
  };

  // rebuild the list rows from the profile doc's current canvases. tears down
  // and recreates every row each call — the list is expected to stay small
  // (a curated, manually-managed set), so a full rebuild is simplest and
  // matches requests-tab.ts's own "rebuild on every change" convention.
  const rebuildCanvasList = (w: number): number => {
    while (canvasListContainer.children.length > 0) {
      canvasListContainer.removeChildAt(0).destroy({ children: true });
    }

    canvasListRenderGeneration++;
    const myGeneration = canvasListRenderGeneration;
    loadedPreviewCanvasIds = new Set();

    const entries = ctx.profileStore?.canvases() ?? [];
    canvasEmptyText.visible = entries.length === 0;
    lastRenderedCanvasTitles = [];

    for (let i = 0; i < entries.length; i++) {
      const entry = entries[i];
      const rowY = i * PROFILE_CANVAS_ROW_HEIGHT;

      const row = new Container();
      row.eventMode = "static";
      row.y = rowY;
      canvasListContainer.addChild(row);

      if (i % 2 === 1) {
        const rowBg = new Graphics();
        rowBg.eventMode = "none";
        rowBg.rect(0, 0, w, PROFILE_CANVAS_ROW_HEIGHT);
        rowBg.fill({ color: ROW_ALT_BG, alpha: 0.5 });
        row.addChild(rowBg);
      }

      const swatch = new Graphics();
      swatch.eventMode = "none";
      const swatchY = (PROFILE_CANVAS_ROW_HEIGHT - PROFILE_CANVAS_SWATCH_SIZE) / 2;
      swatch.roundRect(0, swatchY, PROFILE_CANVAS_SWATCH_SIZE, PROFILE_CANVAS_SWATCH_SIZE, 3);
      swatch.fill({ color: entry.color ?? MUTED_TEXT });
      row.addChild(swatch);

      if (entry.previewUrl) {
        loadCanvasRowPreview(
          entry.canvasDocId,
          row,
          entry.previewUrl,
          PROFILE_CANVAS_SWATCH_SIZE,
          myGeneration
        );
      }

      const titleText = truncate(entry.title || "untitled canvas", 28);
      lastRenderedCanvasTitles.push(titleText);

      const title = new Text({
        text: titleText,
        style: { fontFamily: FONT, fontSize: TEXT_SIZE, fill: TEXT_COLOR },
        resolution: RESOLUTION,
      });
      title.eventMode = "none";
      title.x = PROFILE_CANVAS_SWATCH_SIZE + 8;
      title.y = 3;
      row.addChild(title);

      if (entry.description) {
        const desc = new Text({
          text: truncate(entry.description, 40),
          style: { fontFamily: FONT, fontSize: 9, fill: MUTED_TEXT },
          resolution: RESOLUTION,
        });
        desc.eventMode = "none";
        desc.x = PROFILE_CANVAS_SWATCH_SIZE + 8;
        desc.y = 3 + TEXT_SIZE + 2;
        row.addChild(desc);
      }

      const removeBtn = new Text({
        text: "remove",
        style: { fontFamily: FONT, fontSize: 9, fill: 0xef4444 },
        resolution: RESOLUTION,
      });
      removeBtn.eventMode = "static";
      removeBtn.cursor = "pointer";
      removeBtn.x = w - removeBtn.width;
      removeBtn.y = (PROFILE_CANVAS_ROW_HEIGHT - removeBtn.height) / 2;
      removeBtn.hitArea = new Rectangle(-6, -4, removeBtn.width + 12, removeBtn.height + 8);
      removeBtn.on("pointertap", (e) => {
        e.stopPropagation();
        removeCanvasFromProfile(entry.canvasDocId);
      });
      row.addChild(removeBtn);
    }

    return entries.length * PROFILE_CANVAS_ROW_HEIGHT;
  };

  // expose the tab's own handlers on the test bridge — same pattern this
  // file already uses for `pickAvatar` (see registerSocialBridge() call
  // above) and friends-tab.ts uses for `friendsTab`.
  registerSocialBridge({
    profileTab: {
      getCanvasEntries: () => ctx.profileStore?.canvases() ?? [],
      canAddCurrentCanvas: () => computeCanAddCurrentCanvas(),
      addCurrentCanvas: addCurrentCanvasToProfile,
      removeCanvas: removeCanvasFromProfile,
      getRenderedCanvasTitles: () => [...lastRenderedCanvasTitles],
      getLoadedPreviewCanvasIds: () => [...loadedPreviewCanvasIds],
    },
  });

  // -------------------------------------------------------------------------
  // canvas bin — the recursive-folder *display* surface for the profile's
  // curated canvases (docs/hub-and-profile-plan.md section 10.2) is NOT
  // shown here on the owner's own profile view — the "my canvases" list
  // above already covers add/remove management, so showing both here was
  // duplicate UI (a real user-reported issue, 2026-07-02). the underlying
  // `CanvasBinStore` doc still gets created/stamped below regardless,
  // since that's what makes a FRIEND able to discover and view this
  // profile's bin (friends-tab.ts's read-only detail view, and the
  // `friend-canvas-bin` narthex widget) — only the local rendering of it
  // was removed.
  // -------------------------------------------------------------------------

  if (ctx.profileStore) {
    const profileStore = ctx.profileStore;
    ensureMyCanvasBinDoc(profileStore.repo)
      .then((canvasBinStore) => {
        // stamp the canvas-bin doc id onto the profile doc so a friend
        // syncing this profile doc (already reachable via the gossip-relayed
        // profileDocId on their friend entry) can find it too — see
        // profile-doc.ts's `canvasBinDocId` schema field doc comment.
        profileStore.setCanvasBinDocId(canvasBinStore.handle.documentId);
      })
      .catch((err) => {
        console.warn("[skein:social:profile] failed to load canvas-bin doc:", err);
      });
  }

  // -------------------------------------------------------------------------
  // layout
  // -------------------------------------------------------------------------

  const layout = (w: number, h: number) => {
    currentWidth = w;
    currentHeight = h;

    const profile = ctx.doc.current.profile;
    let y = 0;

    // avatar — centered horizontally
    avatarCx = w / 2;
    avatarCy = y + AVATAR_RADIUS;

    avatarContainer.hitArea = new Circle(avatarCx, avatarCy, AVATAR_RADIUS);
    drawAvatarMask();

    if (profile.avatarDataUrl && profile.avatarDataUrl !== lastRequestedAvatarUrl) {
      updateAvatarSprite(profile.avatarDataUrl);
    } else if (profile.avatarDataUrl) {
      avatarPlaceholder.visible = false;
      avatarInitial.visible = false;
      repositionAvatarSprite();
    } else {
      drawAvatarPlaceholder();
      if (avatarSprite) {
        avatarContainer.removeChild(avatarSprite);
        avatarSprite.mask = null;
        avatarSprite.destroy();
        avatarSprite = null;
      }
      avatarPlaceholder.visible = true;
      avatarInitial.visible = true;
    }

    y += AVATAR_RADIUS * 2 + 4;

    // "tap to change" hint
    avatarHint.x = w / 2 - avatarHint.width / 2;
    avatarHint.y = y;
    y += 9 + FIELD_GAP;

    // username field
    usernameField.layoutAt(0, y, w);
    if (!usernameField.handle.isEditing) {
      usernameField.handle.value = profile.username;
    }
    y += LABEL_SIZE + 4 + FIELD_HEIGHT + FIELD_GAP;

    // bio field
    bioField.layoutAt(0, y, w);
    if (!bioField.handle.isEditing) {
      bioField.handle.value = profile.bio;
    }
    y += LABEL_SIZE + 4 + FIELD_HEIGHT + FIELD_GAP;

    // accent color picker
    colorLabel.x = 0;
    colorLabel.y = y;
    y += LABEL_SIZE + 6;
    layoutColorDots(COLOR_RING_INSET, y);

    // node id
    y += COLOR_DOT_RADIUS * 2 + FIELD_GAP;
    nodeIdLabel.x = 0;
    nodeIdLabel.y = y;
    y += LABEL_SIZE + 4;

    const nid = profile.nodeId;
    if (nid.length > 20) {
      nodeIdText.text = nid.slice(0, 8) + "..." + nid.slice(-8);
    } else {
      nodeIdText.text = nid || "(none)";
    }
    nodeIdText.x = 0;
    nodeIdText.y = y;

    // toggle copy button
    if (nid) {
      copyLabel.text = copyLabel.text === "copied!" ? "copied!" : "copy";
      copyBtn.visible = true;
    } else {
      copyBtn.visible = false;
    }

    // position copy button to the right of the node id text
    copyBtn.x = nodeIdText.width + 8;
    copyBtn.y = y;

    // draw subtle hit-area background
    copyBg.clear();
    const cbPad = 4;
    copyBg.roundRect(-cbPad, -1, copyLabel.width + cbPad * 2, copyLabel.height + 2, 2);
    copyBg.fill({ color: ACCENT, alpha: 0.1 });

    // -- prominent identity setup section -----------------------------------

    if (nid) {
      identitySetupContainer.visible = false;
    } else {
      identitySetupContainer.visible = true;

      y += LABEL_SIZE + FIELD_GAP;

      identitySetupContainer.x = 0;
      identitySetupContainer.y = y;

      // word-wrap description to content width
      setupDescText.style.wordWrapWidth = w;
      setupDescText.x = 0;
      setupDescText.y = 0;
      setupDescText.visible = !importMode;

      const btnY = importMode ? 0 : setupDescText.height + 10;

      setupBtnBg.clear();
      setupBtnBg.roundRect(0, 0, w, BUTTON_HEIGHT, BUTTON_RADIUS);
      setupBtnBg.fill({ color: 0x10b981 });
      setupBtn.hitArea = new Rectangle(0, 0, w, BUTTON_HEIGHT);
      setupBtn.x = 0;
      setupBtn.y = btnY;
      setupBtnText.x = (w - setupBtnText.width) / 2;
      setupBtnText.y = (BUTTON_HEIGHT - TEXT_SIZE) / 2;

      // "import existing identity" link or UI — positioned below generate button (or in its place)
      const importY = importMode ? btnY : btnY + BUTTON_HEIGHT + 12;

      if (!importMode) {
        // show just the link
        setupBtn.visible = true;
        importLinkText.visible = true;
        importLinkText.x = (w - importLinkText.width) / 2;
        importLinkText.y = importY;
        importContainer.visible = false;
      } else {
        // show the full import UI — hide the generate button
        setupBtn.visible = false;
        importLinkText.visible = false;
        importContainer.visible = true;
        importContainer.x = 0;
        importContainer.y = importY;

        let iy = 0;
        importDescText.style.wordWrapWidth = w;
        importDescText.x = 0;
        importDescText.y = iy;
        iy += importDescText.height + 8;

        // create or reposition the input field
        if (!importInputHandle) {
          importInputHandle = createSkeinInput({
            canvasElement: ctx.canvasElement,
            width: w,
            height: FIELD_HEIGHT,
            placeholder: "paste skein1:... bundle here",
            value: "",
          });
          importContainer.addChild(importInputHandle.input);
        }
        importInputHandle.setWidth(w);
        importInputHandle.input.x = 0;
        importInputHandle.input.y = iy;
        iy += FIELD_HEIGHT + 8;

        // status text (error messages)
        if (importStatusText.visible) {
          importStatusText.x = 0;
          importStatusText.y = iy;
          iy += importStatusText.height + 8;
        }

        // restore button
        importConfirmBg.clear();
        importConfirmBg.roundRect(0, 0, w, BUTTON_HEIGHT, BUTTON_RADIUS);
        importConfirmBg.fill({ color: ACCENT });
        importConfirmBtn.hitArea = new Rectangle(0, 0, w, BUTTON_HEIGHT);
        importConfirmBtn.x = 0;
        importConfirmBtn.y = iy;
        importConfirmText.x = (w - importConfirmText.width) / 2;
        importConfirmText.y = (BUTTON_HEIGHT - TEXT_SIZE) / 2;
        iy += BUTTON_HEIGHT + 8;

        // cancel link
        importCancelBtn.x = (w - importCancelText.width) / 2;
        importCancelBtn.y = iy;
        importCancelBtn.hitArea = new Rectangle(
          0,
          0,
          importCancelText.width,
          importCancelText.height
        );
      }
    }

    // -- "my canvases" section ----------------------------------------------
    // hidden entirely until an identity exists — there's nothing meaningful
    // to add/show yet, and it's just clutter competing with the identity
    // setup UI above (per user feedback while testing this live).

    canvasSectionLabel.visible = !!nid;
    addCanvasBtn.visible = false;
    canvasListContainer.visible = !!nid;
    canvasEmptyText.visible = false;

    if (nid) {
      y += FIELD_GAP + 4;
      canvasSectionLabel.x = 0;
      canvasSectionLabel.y = y;
      y += LABEL_SIZE + 6;

      const canAddCurrentCanvas = computeCanAddCurrentCanvas();
      addCanvasBtn.visible = canAddCurrentCanvas;
      if (canAddCurrentCanvas) {
        addCanvasBtnBg.clear();
        addCanvasBtnBg.roundRect(0, 0, w, BUTTON_HEIGHT, BUTTON_RADIUS);
        addCanvasBtnBg.fill({ color: ACCENT });
        addCanvasBtn.hitArea = new Rectangle(0, 0, w, BUTTON_HEIGHT);
        addCanvasBtn.x = 0;
        addCanvasBtn.y = y;
        addCanvasBtnText.x = (w - addCanvasBtnText.width) / 2;
        addCanvasBtnText.y = (BUTTON_HEIGHT - TEXT_SIZE) / 2;
        y += BUTTON_HEIGHT + FIELD_GAP;
      }

      canvasListContainer.x = 0;
      canvasListContainer.y = y;
      y += rebuildCanvasList(w);

      canvasEmptyText.x = 0;
      canvasEmptyText.y = y;
      if (canvasEmptyText.visible) {
        y += canvasEmptyText.height + FIELD_GAP;
      }
    }

    // size the scroll mask/viewport to the space this tab was given, then
    // clamp — `y`'s final accumulated value IS the real content height (see
    // `contentHeight`'s doc comment above for why this isn't read back off
    // `profileInner` itself).
    contentHeight = y;
    scrollAreaHeight = h;
    scrollMask.clear();
    scrollMask.rect(0, 0, w, h);
    scrollMask.fill({ color: 0xffffff });
    // explicit hit area so wheel events fire anywhere in the visible
    // region, not just over child content — without this, gaps between
    // fields/rows don't register wheel events at all (see
    // bin/bin-renderer.ts's setupDrawerScroll() for the reference pattern
    // this mirrors; a real bug found live, 2026-07-02: scrolling silently
    // failed because gaps between profile fields have no hit-testable
    // content of their own).
    container.hitArea = new Rectangle(0, 0, w, h);
    clampScroll();
  };

  // -------------------------------------------------------------------------
  // identity sync — load the real iroh node ID from IndexedDB.
  // if one exists, write it into the doc so it displays immediately.
  // if not, the user can click "generate" to create one.
  // -------------------------------------------------------------------------

  let identityUnsub: (() => void) | null = null;

  const syncNodeIdToDoc = (nodeId: string) => {
    if (nodeId && ctx.doc.current.profile.nodeId !== nodeId) {
      ctx.doc.change((d) => {
        d.profile.nodeId = nodeId;
      });
    }
  };

  // check for a persisted identity (cheap IndexedDB read, no midden startup)
  getStoredIdentity()
    .then((identity) => {
      if (identity) {
        syncNodeIdToDoc(identity.node_id);
        layout(currentWidth, currentHeight);
      }
    })
    .catch((err) => {
      console.warn("[skein:social:profile] failed to read stored identity:", err);
    });

  // subscribe to identity changes so the tab updates when the user
  // generates an identity (either from this tab or elsewhere)
  identityUnsub = onIdentityChange((identity) => {
    if (identity) {
      syncNodeIdToDoc(identity.node_id);
    } else {
      // identity was deleted — clear the node ID
      ctx.doc.change((d) => {
        d.profile.nodeId = "";
      });
    }
    layout(currentWidth, currentHeight);
  });

  // subscribe to remote doc changes (automerge sync)
  const docUnsub = ctx.doc.on("change", () => {
    const profile = ctx.doc.current.profile;
    if (profile.avatarDataUrl && profile.avatarDataUrl !== lastRequestedAvatarUrl) {
      updateAvatarSprite(profile.avatarDataUrl);
    }
    layout(currentWidth, currentHeight);
  });

  // subscribe to profile-doc changes (e.g. another tab/device adding or
  // removing a canvas from the profile) so the "my canvases" list re-renders.
  const profileStoreUnsub = ctx.profileStore?.onChange(() => {
    layout(currentWidth, currentHeight);
  });

  // -------------------------------------------------------------------------
  // tab controller
  // -------------------------------------------------------------------------

  return {
    // the outer masked/scrollable wrapper, NOT `profileInner` — `profileInner`
    // is the inner content layer whose `.mask` points at `scrollMask`, a
    // sibling that only exists inside `container`. mounting `profileInner`
    // directly (as this previously did) parents it somewhere that never
    // includes `container`/`scrollMask` at all, so its mask is permanently
    // disconnected from the render tree — pixi then renders nothing for it.
    // a real, serious bug, 2026-07-02: this blanked the entire profile view.
    container,

    layout(width: number, height: number) {
      layout(width, height);
    },

    destroy() {
      for (const f of fields) f.handle.destroy();
      if (importInputHandle) importInputHandle.destroy();
      docUnsub();
      if (identityUnsub) identityUnsub();
      if (profileStoreUnsub) profileStoreUnsub();
      if (avatarSprite) {
        avatarContainer.removeChild(avatarSprite);
        avatarSprite.mask = null;
        avatarSprite.destroy();
        avatarSprite = null;
      }
      container.destroy({ children: true });
    },
  };
}
