// e2e tests for viewer-role (read-only) UI-level gating.
//
// the core `isLocalViewer()` chokepoint (widget-frame.ts's drag/resize gate,
// property-tray.ts's full-hide, toolbar.ts's applyRoleGating()) is already
// covered indirectly by unit tests in canvas-store.test.ts, but until now
// there was zero UI-level coverage driving real pixi pointer interactions —
// tests/acl-enforcement.spec.ts only exercises the network-boundary
// enforcement (a viewer's direct store mutation never syncing to peers),
// not the "does the UI actually stop the gesture" question this file covers.
//
// runs against the lighter test-harness.html bootstrap (src/dev/test-bootstrap.ts)
// via the canvasPage fixture — the same harness edit-mode.test.ts and
// canvas-store.test.ts already use, since toolbar/property-tray/widget-manager
// are all mounted there (unlike the messagez/social overlays, which only
// exist on the full production app — see knock-ui.test.ts's own comment).
//
// run with: npx playwright test tests/viewer-role-ui.test.ts --workers=1

import { expect, test, type Page } from "./fixtures/canvas-page";

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

async function addNotepad(page: Page, id: string, x = 100, y = 100): Promise<void> {
  await page.evaluate(
    ([wid, wx, wy]) => {
      (window as any).__skein.store.addWidget({
        id: wid,
        type: "notepad",
        x: wx,
        y: wy,
        width: 240,
        height: 160,
        zIndex: 0,
        props: {},
        collapsed: false,
        docId: null,
        parentId: null,
      });
    },
    [id, x, y] as const
  );
  await page.waitForFunction(
    (wid) => (window as any).__skein.widgetManager.getLiveWidgets().has(wid),
    id,
    { timeout: 5000 }
  );
}

/** set the local peer's role on the currently-open canvas — same
 *  setRole()/setLocalNodeId() pattern canvas-store.test.ts's
 *  "localRole/isLocalViewer/isLocalAdmin reflect the local peer's role"
 *  test already uses. */
async function setLocalRole(page: Page, role: "member" | "viewer"): Promise<void> {
  await page.evaluate((r) => {
    const store = (window as any).__skein.store;
    const nodeId = "test-local-peer";
    store.setRole(nodeId, r);
    store.setLocalNodeId(nodeId);
  }, role);
  // give the toolbar's store.onChange()-driven applyRoleGating() a tick to run
  await page.waitForTimeout(100);
}

async function getWidgetPos(page: Page, id: string): Promise<{ x: number; y: number }> {
  return page.evaluate((wid) => {
    const entry = (window as any).__skein.store.getWidget(wid);
    return { x: entry.x, y: entry.y };
  }, id);
}

/** drag a widget's header by (dx, dy) via real mouse events, using the
 *  frame's actual on-screen position — same getGlobalPosition()-based
 *  coordinate convention pan-zoom.test.ts and knock-ui.test.ts already use
 *  for real pointer interaction. headerBg is TS-private but runtime
 *  accessible, same established precedent as toolbar.deleteBtn. */
async function dragWidgetHeader(page: Page, id: string, dx: number, dy: number): Promise<void> {
  const start = await page.evaluate((wid) => {
    const live = (window as any).__skein.widgetManager.getLiveWidgets().get(wid);
    const p = live.frame.headerBg.getGlobalPosition();
    return { x: p.x + 20, y: p.y + 10 };
  }, id);

  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  await page.mouse.move(start.x + dx, start.y + dy, { steps: 5 });
  await page.mouse.up();
}

async function selectWidget(page: Page, id: string): Promise<void> {
  await page.evaluate((wid) => {
    (window as any).__skein.inputRouter.selectWidget(wid);
  }, id);
  await page.waitForTimeout(50);
}

async function deselect(page: Page): Promise<void> {
  await page.keyboard.press("Escape");
  await page.waitForTimeout(50);
}

async function propertyTrayVisible(page: Page): Promise<boolean> {
  return page.evaluate(() => (window as any).__skein.propertyTray.root.visible);
}

async function toolbarButtonsVisible(page: Page): Promise<{ add: boolean; delete: boolean }> {
  return page.evaluate(() => {
    const toolbar = (window as any).__skein.toolbar;
    return { add: toolbar.addBtn.visible, delete: toolbar.deleteBtn.visible };
  });
}

/** simulate a double-click at a notepad's own body — notepad.ts implements
 *  double-click-to-edit manually (a `pointertap` timestamp check within a
 *  400ms window, not a native browser `dblclick`), and dispatches it on an
 *  inner `Graphics` child (`bg`), not the widget's outer frame. real
 *  `page.mouse.click()`-driven pointer events (which work reliably for
 *  frame-level chrome like `headerBg`/toolbar buttons elsewhere in this
 *  file) were confirmed NOT to reach arbitrary widget-internal content in
 *  this lighter test harness (verified directly: emitting `pointertap` on
 *  `bg` fires the handler correctly and proves the read-only guard itself
 *  works, while a real simulated mouse click at the exact same on-screen
 *  coordinates never reaches it at all) — so this drives the same
 *  `pointertap` event pixi would dispatch, twice in quick succession,
 *  directly on the widget's own content, same "invoke the real internal
 *  handler when real pointer simulation isn't practical" precedent
 *  `hub-profile-panel.spec.ts` already established for this codebase. */
async function doubleClickWidgetBody(page: Page, id: string): Promise<void> {
  await page.evaluate((wid) => {
    const live = (window as any).__skein.widgetManager.getLiveWidgets().get(wid);
    const bg = live.ctrl.container.children[0];
    bg.emit("pointertap", {});
    bg.emit("pointertap", {});
  }, id);
}

/** count real edit-overlay textareas (`dom-overlay.ts`'s `position: fixed`
 *  inline-editing overlay) — NOT the one always-present, permanently
 *  hidden `<textarea>` `keyboard-driver.ts` creates for IME/mobile-keyboard
 *  targeting (`position: absolute`, 1x1px, `opacity: 0`), which exists on
 *  every page load regardless of whether anything is being edited. a naive
 *  `document.querySelectorAll("textarea").length` always returns at least
 *  1 for that reason — this filters it out so the count actually reflects
 *  "is a notepad edit overlay open right now". */
async function textareaCount(page: Page): Promise<number> {
  return page.evaluate(
    () =>
      Array.from(document.querySelectorAll("textarea")).filter(
        (el) => el.style.position === "fixed"
      ).length
  );
}

// ---------------------------------------------------------------------------
// widget-frame drag gating
// ---------------------------------------------------------------------------

test("a viewer cannot start a drag gesture on a widget frame; a member can (regression)", async ({
  canvasPage,
}) => {
  const { page } = await canvasPage();
  await addNotepad(page, "drag-w", 100, 100);

  await setLocalRole(page, "viewer");
  const before = await getWidgetPos(page, "drag-w");
  await dragWidgetHeader(page, "drag-w", 80, 60);
  const afterViewer = await getWidgetPos(page, "drag-w");
  expect(afterViewer).toEqual(before);

  await setLocalRole(page, "member");
  await dragWidgetHeader(page, "drag-w", 80, 60);
  const afterMember = await getWidgetPos(page, "drag-w");
  expect(afterMember.x).not.toBe(before.x);
  expect(afterMember.y).not.toBe(before.y);
});

// ---------------------------------------------------------------------------
// property tray gating
// ---------------------------------------------------------------------------

test("a viewer cannot open the property tray; a member can (regression)", async ({
  canvasPage,
}) => {
  const { page } = await canvasPage();
  await addNotepad(page, "tray-w", 100, 100);

  await setLocalRole(page, "viewer");
  await selectWidget(page, "tray-w");
  expect(await propertyTrayVisible(page)).toBe(false);

  await deselect(page);
  await setLocalRole(page, "member");
  await selectWidget(page, "tray-w");
  expect(await propertyTrayVisible(page)).toBe(true);
});

// ---------------------------------------------------------------------------
// toolbar button gating
// ---------------------------------------------------------------------------

test("toolbar add-widget and delete buttons are hidden for a viewer; visible for a member (regression)", async ({
  canvasPage,
}) => {
  const { page } = await canvasPage();
  await addNotepad(page, "toolbar-w", 100, 100);

  await setLocalRole(page, "viewer");
  await selectWidget(page, "toolbar-w");
  const viewerButtons = await toolbarButtonsVisible(page);
  expect(viewerButtons.add).toBe(false);
  expect(viewerButtons.delete).toBe(false);

  await deselect(page);
  await setLocalRole(page, "member");
  await selectWidget(page, "toolbar-w");
  const memberButtons = await toolbarButtonsVisible(page);
  expect(memberButtons.add).toBe(true);
  expect(memberButtons.delete).toBe(true);
});

// ---------------------------------------------------------------------------
// notepad content gating (representative widget-internal interaction)
// ---------------------------------------------------------------------------

test("a viewer cannot start editing a notepad's text; a member can (regression)", async ({
  canvasPage,
}) => {
  const { page } = await canvasPage();
  await addNotepad(page, "note-w", 100, 100);

  await setLocalRole(page, "viewer");
  await doubleClickWidgetBody(page, "note-w");
  await page.waitForTimeout(150);
  expect(await textareaCount(page)).toBe(0);

  await setLocalRole(page, "member");
  await doubleClickWidgetBody(page, "note-w");
  await page.waitForTimeout(150);
  expect(await textareaCount(page)).toBe(1);
});
