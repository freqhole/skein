import { expect, test } from "./fixtures/canvas-page";
import { setLocalRole } from "./helpers/roles";

test("property tray is present on the skein canvas handle", async ({ canvasPage }) => {
  const { page } = await canvasPage();

  const result = await page.evaluate(() => {
    const skein = (window as any).__skein;
    return {
      hasPropertyTray: skein.propertyTray != null,
      hasRoot: skein.propertyTray?.root != null,
    };
  });

  expect(result.hasPropertyTray).toBe(true);
  expect(result.hasRoot).toBe(true);
});

test("property tray is hidden by default", async ({ canvasPage }) => {
  const { page } = await canvasPage();

  const visible = await page.evaluate(() => {
    return (window as any).__skein.propertyTray.root.visible;
  });

  expect(visible).toBe(false);
});

test("property tray appears when a widget with editableProps is selected", async ({
  canvasPage,
}) => {
  const { page } = await canvasPage();
  await setLocalRole(page, "member");

  await page.evaluate(() => {
    const skein = (window as any).__skein;
    skein.store.addWidget({
      id: "w1",
      type: "label",
      x: 50,
      y: 50,
      width: 200,
      height: 100,
      zIndex: 1,
      props: {},
      collapsed: false,
      docId: null,
      parentId: null,
    });
  });
  await page.waitForTimeout(300);

  await page.evaluate(() => {
    (window as any).__skein.inputRouter.selectWidget("w1");
  });
  await page.waitForTimeout(100);

  const visible = await page.evaluate(() => {
    return (window as any).__skein.propertyTray.root.visible;
  });

  expect(visible).toBe(true);
});

test("property tray hides when widget is deselected", async ({ canvasPage }) => {
  const { page } = await canvasPage();
  await setLocalRole(page, "member");

  await page.evaluate(() => {
    const skein = (window as any).__skein;
    skein.store.addWidget({
      id: "w1",
      type: "label",
      x: 50,
      y: 50,
      width: 200,
      height: 100,
      zIndex: 1,
      props: {},
      collapsed: false,
      docId: null,
      parentId: null,
    });
  });
  await page.waitForTimeout(300);

  // select → tray visible
  await page.evaluate(() => {
    (window as any).__skein.inputRouter.selectWidget("w1");
  });
  await page.waitForTimeout(100);

  const visibleBefore = await page.evaluate(() => {
    return (window as any).__skein.propertyTray.root.visible;
  });
  expect(visibleBefore).toBe(true);

  // deselect → tray hidden
  await page.evaluate(() => {
    (window as any).__skein.inputRouter.selectWidget(null);
  });
  await page.waitForTimeout(100);

  const visibleAfter = await page.evaluate(() => {
    return (window as any).__skein.propertyTray.root.visible;
  });
  expect(visibleAfter).toBe(false);
});

test("property tray shows only the title control for stateless widgets (canvas-info)", async ({
  canvasPage,
}) => {
  const { page } = await canvasPage();
  await setLocalRole(page, "member");

  // canvas-info is a real registered widget with no editableProps (see
  // widgets/canvas-info.test.ts: "has no editableProps"). a previous version
  // of this test used a bogus "hello-world" type, which isn't registered in
  // createTestRegistry() at all — it mounted as a crashed placeholder, which
  // intentionally *does* get a minimal property tray (title + delete button,
  // see property-tray.ts), so the old assertion (tray fully hidden) was
  // testing the wrong thing. the tray's title field is always shown for any
  // selected, registered widget — only widget-specific prop controls are
  // conditional on `factory.editableProps`.
  await page.evaluate(() => {
    const skein = (window as any).__skein;
    skein.store.addWidget({
      id: "ci1",
      type: "canvas-info",
      x: 50,
      y: 50,
      width: 200,
      height: 100,
      zIndex: 1,
      props: { activeTab: "details" },
      collapsed: false,
      docId: null,
      parentId: null,
    });
  });
  await page.waitForTimeout(300);

  await page.evaluate(() => {
    (window as any).__skein.inputRouter.selectWidget("ci1");
  });
  await page.waitForTimeout(100);

  const result = await page.evaluate(() => {
    const propertyTray = (window as any).__skein.propertyTray;
    return {
      visible: propertyTray.root.visible,
      controlCount: propertyTray.controls.length,
    };
  });

  expect(result.visible).toBe(true);
  expect(result.controlCount).toBe(0);
});

test("property tray is positioned to the right of the selected widget", async ({ canvasPage }) => {
  const { page } = await canvasPage();
  await setLocalRole(page, "member");

  await page.evaluate(() => {
    const skein = (window as any).__skein;
    skein.store.addWidget({
      id: "w1",
      type: "label",
      x: 100,
      y: 80,
      width: 200,
      height: 120,
      zIndex: 1,
      props: {},
      collapsed: false,
      docId: null,
      parentId: null,
    });
  });
  await page.waitForTimeout(300);

  await page.evaluate(() => {
    (window as any).__skein.inputRouter.selectWidget("w1");
  });
  await page.waitForTimeout(100);

  const pos = await page.evaluate(() => {
    const skein = (window as any).__skein;
    const tray = skein.propertyTray.root;
    return { x: tray.x, y: tray.y };
  });

  // tray should be to the right of the widget (x=100 + width=200 + gap=8 = 308)
  expect(pos.x).toBe(308);
  // tray y should be widget y minus frameHeaderHeight (80 - 28 = 52)
  expect(pos.y).toBe(52);
});

test("property tray stays a constant on-screen size when the viewport zooms", async ({
  canvasPage,
}) => {
  const { page } = await canvasPage();
  await setLocalRole(page, "member");

  await page.evaluate(() => {
    const skein = (window as any).__skein;
    skein.store.addWidget({
      id: "w1",
      type: "label",
      x: 100,
      y: 80,
      width: 200,
      height: 120,
      zIndex: 1,
      props: {},
      collapsed: false,
      docId: null,
      parentId: null,
    });
  });
  await page.waitForTimeout(300);

  await page.evaluate(() => {
    (window as any).__skein.inputRouter.selectWidget("w1");
  });
  await page.waitForTimeout(100);

  const before = await page.evaluate(() => {
    const skein = (window as any).__skein;
    const tray = skein.propertyTray.root;
    return { scaleX: tray.scale.x, x: tray.x, y: tray.y };
  });
  expect(before.scaleX).toBe(1);

  const after = await page.evaluate(() => {
    const skein = (window as any).__skein;
    skein.viewport.zoomTo(0.5);
    const tray = skein.propertyTray.root;
    return {
      scaleX: tray.scale.x,
      x: tray.x,
      y: tray.y,
      worldScale: skein.world.scale.x,
    };
  });

  expect(after.worldScale).toBeCloseTo(0.5, 2);
  // tray root scale cancels out the world's zoom, so its own content always
  // renders at a constant on-screen size regardless of viewport zoom.
  expect(after.scaleX).toBeCloseTo(2, 5);
  // position offsets (gap=8, frameHeaderHeight=28) are constant *screen*
  // pixels, so at 0.5x zoom they double in world units:
  // x = 100 + 200 + 8*2 = 316, y = 80 - 28*2 = 24
  expect(before.x).toBe(308);
  expect(before.y).toBe(52);
  expect(after.x).toBe(316);
  expect(after.y).toBe(24);
});

test("property tray repositions when widget is moved", async ({ canvasPage }) => {
  const { page } = await canvasPage();
  await setLocalRole(page, "member");

  await page.evaluate(() => {
    const skein = (window as any).__skein;
    skein.store.addWidget({
      id: "w1",
      type: "label",
      x: 100,
      y: 80,
      width: 200,
      height: 120,
      zIndex: 1,
      props: {},
      collapsed: false,
      docId: null,
      parentId: null,
    });
  });
  await page.waitForTimeout(300);

  await page.evaluate(() => {
    (window as any).__skein.inputRouter.selectWidget("w1");
  });
  await page.waitForTimeout(100);

  // move the widget
  await page.evaluate(() => {
    (window as any).__skein.store.moveWidget("w1", 300, 200);
  });
  await page.waitForTimeout(100);

  const pos = await page.evaluate(() => {
    const tray = (window as any).__skein.propertyTray.root;
    return { x: tray.x, y: tray.y };
  });

  // 300 + 200 (width) + 8 (gap) = 508
  expect(pos.x).toBe(508);
  // 200 - 28 (frameHeaderHeight) = 172
  expect(pos.y).toBe(172);
});

test("property tray shows the widget name in the header", async ({ canvasPage }) => {
  const { page } = await canvasPage();
  await setLocalRole(page, "member");

  await page.evaluate(() => {
    const skein = (window as any).__skein;
    skein.store.addWidget({
      id: "w1",
      type: "label",
      x: 50,
      y: 50,
      width: 200,
      height: 100,
      zIndex: 1,
      props: {},
      collapsed: false,
      docId: null,
      parentId: null,
    });
  });
  await page.waitForTimeout(300);

  await page.evaluate(() => {
    (window as any).__skein.inputRouter.selectWidget("w1");
  });
  await page.waitForTimeout(100);

  const headerText = await page.evaluate(() => {
    const tray = (window as any).__skein.propertyTray;
    // header is the second child of root (after bg)
    const header = tray.root.children[1];
    return header?.text ?? null;
  });

  expect(headerText).toBe("label");
});

test("property tray renders controls for each editable prop", async ({ canvasPage }) => {
  const { page } = await canvasPage();
  await setLocalRole(page, "member");

  // "notepad" has 5 editableProps (bgColor, textColor, borderColor, fontSize,
  // fontFamily) plus the always-shown title control and a delete button = 7 total.
  //
  // a previous version of this test used a "counter" widget type that no
  // longer exists in the registry (removed from
  // client/skein/widgets/counter.ts during a later refactor). since it's
  // unregistered, it mounts as a *crashed* placeholder, whose tray always
  // has exactly 2 children (title + delete button, see `showCrashed` in
  // property-tray.ts) — which coincidentally matched this test's expected
  // count of 2, making it a false-positive pass that wasn't actually
  // testing editableProps rendering at all.
  await page.evaluate(() => {
    const skein = (window as any).__skein;
    skein.store.addWidget({
      id: "n1",
      type: "notepad",
      x: 50,
      y: 50,
      width: 200,
      height: 150,
      zIndex: 1,
      props: {},
      collapsed: false,
      docId: null,
      parentId: null,
    });
  });
  await page.waitForTimeout(300);

  await page.evaluate(() => {
    (window as any).__skein.inputRouter.selectWidget("n1");
  });
  await page.waitForTimeout(100);

  const result = await page.evaluate(() => {
    const tray = (window as any).__skein.propertyTray;
    // contentContainer is the third child of root (bg, header, contentContainer)
    const content = tray.root.children[2];
    return {
      visible: tray.root.visible,
      controlCount: content?.children?.length ?? 0,
    };
  });

  expect(result.visible).toBe(true);
  // title control + 5 editableProps (bgColor, textColor, borderColor, fontSize, fontFamily) + delete button
  expect(result.controlCount).toBe(7);
});

test("property tray switches when selecting a different widget", async ({ canvasPage }) => {
  const { page } = await canvasPage();
  await setLocalRole(page, "member");

  await page.evaluate(() => {
    const skein = (window as any).__skein;
    skein.store.addWidget({
      id: "w1",
      type: "label",
      x: 50,
      y: 50,
      width: 200,
      height: 100,
      zIndex: 1,
      props: {},
      collapsed: false,
      docId: null,
      parentId: null,
    });
    skein.store.addWidget({
      id: "c1",
      type: "counter",
      x: 350,
      y: 50,
      width: 200,
      height: 150,
      zIndex: 2,
      props: {},
      collapsed: false,
      docId: null,
      parentId: null,
    });
  });
  await page.waitForTimeout(300);

  // select label
  await page.evaluate(() => {
    (window as any).__skein.inputRouter.selectWidget("w1");
  });
  await page.waitForTimeout(100);

  const headerForLabel = await page.evaluate(() => {
    const tray = (window as any).__skein.propertyTray;
    return tray.root.children[1]?.text ?? null;
  });
  expect(headerForLabel).toBe("label");

  // select counter
  await page.evaluate(() => {
    (window as any).__skein.inputRouter.selectWidget("c1");
  });
  await page.waitForTimeout(100);

  const headerForCounter = await page.evaluate(() => {
    const tray = (window as any).__skein.propertyTray;
    return tray.root.children[1]?.text ?? null;
  });
  expect(headerForCounter).toBe("counter");
});

test("property tray hides when the selected widget is removed", async ({ canvasPage }) => {
  const { page } = await canvasPage();
  await setLocalRole(page, "member");

  await page.evaluate(() => {
    const skein = (window as any).__skein;
    skein.store.addWidget({
      id: "w1",
      type: "label",
      x: 50,
      y: 50,
      width: 200,
      height: 100,
      zIndex: 1,
      props: {},
      collapsed: false,
      docId: null,
      parentId: null,
    });
  });
  await page.waitForTimeout(300);

  await page.evaluate(() => {
    (window as any).__skein.inputRouter.selectWidget("w1");
  });
  await page.waitForTimeout(100);

  expect(await page.evaluate(() => (window as any).__skein.propertyTray.root.visible)).toBe(true);

  // remove the widget
  await page.evaluate(() => {
    (window as any).__skein.inputRouter.selectWidget(null);
    (window as any).__skein.store.removeWidget("w1");
  });
  await page.waitForTimeout(100);

  expect(await page.evaluate(() => (window as any).__skein.propertyTray.root.visible)).toBe(false);
});

test("number control +/- buttons change the widget doc value", async ({ canvasPage }) => {
  const { page } = await canvasPage();
  await setLocalRole(page, "member");

  // "notepad" is a real registered widget with a plain (non-conditional,
  // static-default) numeric editableProp ("fontSize", default 13). a previous
  // version of this test used a "counter" widget type that no longer exists
  // in the registry (removed from client/skein/widgets/counter.ts during a
  // later refactor without updating this test), so widgetDoc was always null.
  // note: "label" widget's borderWidth looks similar but its zod default is
  // randomized (see widgets/label.ts: `getCachedRandom().borderWidth`), so
  // it's not usable for a deterministic initial-value assertion.
  await page.evaluate(() => {
    const skein = (window as any).__skein;
    skein.store.addWidget({
      id: "n1",
      type: "notepad",
      x: 50,
      y: 50,
      width: 200,
      height: 150,
      zIndex: 1,
      props: {},
      collapsed: false,
      docId: null,
      parentId: null,
    });
  });
  await page.waitForTimeout(300);

  await page.evaluate(() => {
    (window as any).__skein.inputRouter.selectWidget("n1");
  });
  await page.waitForTimeout(100);

  // read the initial fontSize value from the widget doc
  const initialFontSize = await page.evaluate(() => {
    const live = (window as any).__skein.widgetManager.getLiveWidgets().get("n1");
    return live?.widgetDoc?.current?.fontSize ?? null;
  });
  expect(initialFontSize).toBe(13);

  // find the fontSize control's plus button and click it.
  // contentContainer children (see editableProps order in widgets/notepad.ts):
  // [0] title, [1] bgColor, [2] textColor, [3] borderColor, [4] fontSize.
  // each number control's own children are [label, minusBtn, plusBtn, input]
  // (see createNumberControl in property-tray.ts) — plusBtn is index 2, not
  // the last child (the editable input field is added after the buttons).
  await page.evaluate(() => {
    const tray = (window as any).__skein.propertyTray;
    const content = tray.root.children[2]; // contentContainer
    const fontSizeControl = content.children[4];
    const plusBtn = fontSizeControl.children[2];
    // simulate a pointerdown event
    plusBtn.emit("pointerdown", { stopPropagation: () => {} });
  });
  await page.waitForTimeout(100);

  const newFontSize = await page.evaluate(() => {
    const live = (window as any).__skein.widgetManager.getLiveWidgets().get("n1");
    return live?.widgetDoc?.current?.fontSize ?? null;
  });
  expect(newFontSize).toBe(14);
});

test("property tray has very high zIndex in the world container", async ({ canvasPage }) => {
  const { page } = await canvasPage();

  const zIndex = await page.evaluate(() => {
    return (window as any).__skein.propertyTray.root.zIndex;
  });

  expect(zIndex).toBeGreaterThanOrEqual(99999);
});

test("property tray survives canvas destroy without errors", async ({ canvasPage }) => {
  const { page } = await canvasPage();
  await setLocalRole(page, "member");

  // add a widget and select it so the tray is visible
  await page.evaluate(() => {
    const skein = (window as any).__skein;
    skein.store.addWidget({
      id: "w1",
      type: "label",
      x: 50,
      y: 50,
      width: 200,
      height: 100,
      zIndex: 1,
      props: {},
      collapsed: false,
      docId: null,
      parentId: null,
    });
  });
  await page.waitForTimeout(300);

  await page.evaluate(() => {
    (window as any).__skein.inputRouter.selectWidget("w1");
  });
  await page.waitForTimeout(100);

  const error = await page.evaluate(() => {
    try {
      (window as any).__skein.destroy();
      return null;
    } catch (err: any) {
      return err.message ?? String(err);
    }
  });

  expect(error).toBeNull();
});

test("property tray repositions when widget is resized", async ({ canvasPage }) => {
  const { page } = await canvasPage();
  await setLocalRole(page, "member");

  await page.evaluate(() => {
    const skein = (window as any).__skein;
    skein.store.addWidget({
      id: "w1",
      type: "label",
      x: 100,
      y: 80,
      width: 200,
      height: 120,
      zIndex: 1,
      props: {},
      collapsed: false,
      docId: null,
      parentId: null,
    });
  });
  await page.waitForTimeout(300);

  await page.evaluate(() => {
    (window as any).__skein.inputRouter.selectWidget("w1");
  });
  await page.waitForTimeout(100);

  // initial position: 100 + 200 + 8 = 308
  const posBefore = await page.evaluate(() => {
    return (window as any).__skein.propertyTray.root.x;
  });
  expect(posBefore).toBe(308);

  // resize the widget wider
  await page.evaluate(() => {
    (window as any).__skein.store.resizeWidget("w1", 400, 120);
  });
  await page.waitForTimeout(100);

  // new position: 100 + 400 + 8 = 508
  const posAfter = await page.evaluate(() => {
    return (window as any).__skein.propertyTray.root.x;
  });
  expect(posAfter).toBe(508);
});
