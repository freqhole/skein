// e2e coverage for viewing a FRIEND's profile canvas bin — read-only,
// paginated, grouping preserved (docs/hub-and-profile-plan.md section 10.2's
// follow-on). covers both surfaces that render it:
//   - friends-tab.ts's friend-detail view (window.__skeinTest.social.friendCanvasBin)
//   - the new narthex-placeable "friend-canvas-bin" widget type
//     (window.__skeinTest.widgets[widgetId])
//
// a friend's profile+bin doc pair is seeded directly via
// window.__skein.store.repo.create() (CanvasStore.repo is a public field),
// simulating "this friend's docs have already synced to us" — mirrors this
// repo's established pattern (friends-tab-hub-profile.spec.ts's
// window.__skeinTest.social.doc.change() seeding) rather than spinning up a
// real second connected peer, which this feature's rendering code doesn't
// need in order to be exercised.
//
// run with: npx playwright test tests/friend-canvas-bin.test.ts --workers=1

import { expect, test, type Page } from "@playwright/test";
import { collectPixiWarnings, ensureIdentityBridge, toggleSocialOverlay } from "./helpers/skein-bridge";

async function waitForNarthex(page: Page): Promise<void> {
  await page.waitForFunction(() => (window as any).__skein != null, { timeout: 30_000 });
  await page.waitForFunction(
    () => {
      const skein = (window as any).__skein;
      return skein?.widgetManager?.getLiveWidgets()?.size > 0;
    },
    { timeout: 30_000 }
  );
}

async function waitForFriendsTabHooks(page: Page): Promise<void> {
  await page.waitForFunction(() => (window as any).__skeinTest?.social?.friendsTab != null, {
    timeout: 15_000,
  });
}

/**
 * seed a synthetic friend's profile + canvas-bin doc pair directly, with
 * enough root-level canvas nodes to force more than one page (row height 36
 * + gap 2, profile-canvas-bin's own 220px viewport height / 24px header /
 * 20px pager leaves ~176px -> ~4 rows per page), plus one folder containing
 * two more canvases (to prove folder grouping — nested canvases must NOT
 * appear at root). returns the profile doc id and canvas ids used.
 */
async function seedFriendCanvasBin(page: Page): Promise<{ profileDocId: string; rootCanvasIds: string[]; folderCanvasIds: string[] }> {
  return page.evaluate(() => {
    const repo = (window as any).__skein.store.repo;

    const rootCanvasIds = Array.from({ length: 6 }, () => crypto.randomUUID());
    const folderCanvasIds = Array.from({ length: 2 }, () => crypto.randomUUID());
    const now = new Date().toISOString();

    const canvases = [...rootCanvasIds, ...folderCanvasIds].map((id, i) => ({
      canvasDocId: id,
      title: `friend canvas ${i}`,
      description: "",
      color: 0x6366f1,
      addedAt: now,
    }));

    const binHandle = repo.create({
      mode: "grid",
      slotScale: "m",
      nodes: [
        ...rootCanvasIds.map((id) => ({ kind: "canvas", id: crypto.randomUUID(), canvasDocId: id })),
        {
          kind: "folder",
          id: "folder-1",
          title: "nested stuff",
          children: folderCanvasIds.map((id) => ({
            kind: "canvas",
            id: crypto.randomUUID(),
            canvasDocId: id,
          })),
        },
      ],
    });

    const profileHandle = repo.create({
      username: "friendo",
      bio: "",
      avatarDataUrl: "",
      canvases,
      updatedAt: now,
      canvasBinDocId: binHandle.documentId,
    });

    return {
      profileDocId: profileHandle.documentId as string,
      rootCanvasIds,
      folderCanvasIds,
    };
  });
}

async function seedFriendWithProfile(
  page: Page,
  opts: { nodeId: string; alias: string; profileDocId: string }
): Promise<string> {
  return page.evaluate((o) => {
    const id = crypto.randomUUID();
    (window as any).__skeinTest.social.doc.change((d: any) => {
      d.friends.push({
        id,
        alias: o.alias,
        username: "",
        group: "",
        nodeIds: [
          {
            nodeId: o.nodeId,
            addedAt: new Date().toISOString(),
            lastSeenAt: "",
            username: "",
            bio: "",
            avatarDataUrl: "",
            profileDocId: o.profileDocId,
            profileUpdatedAt: new Date().toISOString(),
          },
        ],
        createdAt: new Date().toISOString(),
        isHub: false,
      });
    });
    return id;
  }, opts);
}

async function getFriendCanvasBinHooks(page: Page) {
  return page.evaluate(() => (window as any).__skeinTest?.social?.friendCanvasBin != null);
}

test.describe("friend canvas bin", () => {
  test.describe.configure({ mode: "serial" });
  test.setTimeout(120_000);

  test("friends-tab shows a friend's read-only, paginated canvas bin with folder grouping preserved", async ({
    page,
  }) => {
    const pixiWarnings = collectPixiWarnings(page);
    await page.goto("/");
    await waitForNarthex(page);
    await ensureIdentityBridge(page);

    const { profileDocId, rootCanvasIds, folderCanvasIds } = await seedFriendCanvasBin(page);
    const friendNodeId = "f".repeat(64);
    const friendId = await seedFriendWithProfile(page, {
      nodeId: friendNodeId,
      alias: "friendo",
      profileDocId,
    });

    await toggleSocialOverlay(page);
    await waitForFriendsTabHooks(page);
    await page.evaluate(
      (id) => (window as any).__skeinTest.social.friendsTab.openFriendDetail(id),
      friendId
    );

    await expect.poll(() => getFriendCanvasBinHooks(page), { timeout: 10_000 }).toBe(true);

    const isReadOnly = await page.evaluate(
      () => (window as any).__skeinTest.social.friendCanvasBin.isReadOnly()
    );
    expect(isReadOnly).toBe(true);

    // root shows the 6 root canvases + the folder — NOT the 2 canvases
    // filed inside the folder (grouping preserved, not flattened).
    const rootNodes = await page.evaluate(
      () => (window as any).__skeinTest.social.friendCanvasBin.getVisibleNodes()
    );
    expect(rootNodes.length).toBe(7);
    const rootCanvasNodeDocIds = rootNodes
      .filter((n: any) => n.kind === "canvas")
      .map((n: any) => n.canvasDocId);
    expect(rootCanvasNodeDocIds.sort()).toEqual([...rootCanvasIds].sort());
    for (const hiddenId of folderCanvasIds) {
      expect(rootCanvasNodeDocIds).not.toContain(hiddenId);
    }
    expect(rootNodes.some((n: any) => n.kind === "folder" && n.title === "nested stuff")).toBe(true);

    // pagination: 7 root items at ~4/page must span more than one page.
    const totalPages = await page.evaluate(
      () => (window as any).__skeinTest.social.friendCanvasBin.getTotalPages()
    );
    expect(totalPages).toBeGreaterThan(1);
    expect(
      await page.evaluate(() => (window as any).__skeinTest.social.friendCanvasBin.getCurrentPage())
    ).toBe(0);

    await page.evaluate(() => (window as any).__skeinTest.social.friendCanvasBin.nextPage());
    expect(
      await page.evaluate(() => (window as any).__skeinTest.social.friendCanvasBin.getCurrentPage())
    ).toBe(1);
    // nextPage() past the last page is a clamped no-op.
    for (let i = 0; i < totalPages + 3; i++) {
      await page.evaluate(() => (window as any).__skeinTest.social.friendCanvasBin.nextPage());
    }
    expect(
      await page.evaluate(() => (window as any).__skeinTest.social.friendCanvasBin.getCurrentPage())
    ).toBe(totalPages - 1);
    await page.evaluate(() => (window as any).__skeinTest.social.friendCanvasBin.prevPage());
    expect(
      await page.evaluate(() => (window as any).__skeinTest.social.friendCanvasBin.getCurrentPage())
    ).toBe(totalPages - 2);

    // folder navigation still works read-only.
    await page.evaluate(() => (window as any).__skeinTest.social.friendCanvasBin.enterFolder("folder-1"));
    const insideFolder = await page.evaluate(
      () => (window as any).__skeinTest.social.friendCanvasBin.getVisibleNodes()
    );
    expect(insideFolder.map((n: any) => n.canvasDocId).sort()).toEqual([...folderCanvasIds].sort());
    await page.evaluate(() => (window as any).__skeinTest.social.friendCanvasBin.goBack());

    // read-only enforcement at the data layer, not just the UI: no
    // add-folder button was wired, and the underlying store calls refuse.
    const addResult = await page.evaluate(() =>
      (window as any).__skeinTest.social.friendCanvasBin.addFolder("nope")
    );
    expect(addResult).toBe("");
    const moveResult = await page.evaluate(() =>
      (window as any).__skeinTest.social.friendCanvasBin.moveNode("folder-1", null)
    );
    expect(moveResult).toBe(false);

    // a masked/scrollable container's `.height` (or `.getBounds()`) must
    // never be read directly in this app — pixi logs this exact warning
    // when it is, and (per a real bug found live, 2026-07-02) rendering
    // can silently break at the same time.
    expect(pixiWarnings).toEqual([]);
  });

  test("a canvas entry with a previewUrl actually loads and attaches its preview image", async ({
    page,
  }) => {
    const pixiWarnings = collectPixiWarnings(page);
    await page.goto("/");
    await waitForNarthex(page);
    await ensureIdentityBridge(page);

    // 1x1 transparent PNG — same fixture used elsewhere in this repo for
    // "does a data: URL preview actually render" coverage.
    const previewUrl =
      "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";

    const { profileDocId, nodeId } = await page.evaluate((previewUrl) => {
      const repo = (window as any).__skein.store.repo;
      const now = new Date().toISOString();
      const canvasDocId = crypto.randomUUID();
      const nodeId = crypto.randomUUID();

      const binHandle = repo.create({
        mode: "grid",
        slotScale: "m",
        nodes: [{ kind: "canvas", id: nodeId, canvasDocId }],
      });

      const profileHandle = repo.create({
        username: "img-friendo",
        bio: "",
        avatarDataUrl: "",
        canvases: [
          {
            canvasDocId,
            title: "img canvas",
            description: "",
            color: 0x6366f1,
            previewUrl,
            addedAt: now,
          },
        ],
        updatedAt: now,
        canvasBinDocId: binHandle.documentId,
      });

      return { profileDocId: profileHandle.documentId as string, nodeId };
    }, previewUrl);

    const friendNodeId = "a".repeat(64);
    const friendId = await seedFriendWithProfile(page, {
      nodeId: friendNodeId,
      alias: "img-friendo",
      profileDocId,
    });

    await toggleSocialOverlay(page);
    await waitForFriendsTabHooks(page);
    await page.evaluate(
      (id) => (window as any).__skeinTest.social.friendsTab.openFriendDetail(id),
      friendId
    );

    await expect.poll(() => getFriendCanvasBinHooks(page), { timeout: 10_000 }).toBe(true);

    await expect
      .poll(
        async () =>
          page.evaluate(
            () => (window as any).__skeinTest.social.friendCanvasBin.getLoadedPreviewNodeIds(),
            undefined
          ),
        { timeout: 10_000 }
      )
      .toContain(nodeId);
    expect(pixiWarnings).toEqual([]);
  });

  test("the friend-canvas-bin narthex widget: unconfigured until a friend is picked, then renders their bin read-only", async ({
    page,
  }) => {
    await page.goto("/");
    await waitForNarthex(page);
    await ensureIdentityBridge(page);

    const { profileDocId, rootCanvasIds } = await seedFriendCanvasBin(page);
    const friendNodeId = "e".repeat(64);
    await seedFriendWithProfile(page, {
      nodeId: friendNodeId,
      alias: "pinned-friendo",
      profileDocId,
    });

    const widgetId = "friend-bin-w";
    await page.evaluate((wid) => {
      (window as any).__skein.store.addWidget({
        id: wid,
        type: "friend-canvas-bin",
        x: 100,
        y: 100,
        width: 260,
        height: 280,
        zIndex: 0,
        props: {},
        collapsed: false,
        docId: null,
        parentId: null,
      });
    }, widgetId);

    await page.waitForFunction(
      (wid) => (window as any).__skeinTest?.widgets?.[wid] != null,
      widgetId,
      { timeout: 10_000 }
    );

    const initialStatus = await page.evaluate(
      (wid) => (window as any).__skeinTest.widgets[wid].getStatus(),
      widgetId
    );
    expect(initialStatus).toBe("unconfigured");

    await expect
      .poll(
        async () =>
          page.evaluate(
            (wid) => (window as any).__skeinTest.widgets[wid].getPickerCandidates().length,
            widgetId
          ),
        { timeout: 10_000 }
      )
      .toBeGreaterThan(0);

    const candidates = await page.evaluate(
      (wid) => (window as any).__skeinTest.widgets[wid].getPickerCandidates(),
      widgetId
    );
    const picked = candidates.find((c: any) => c.displayName === "pinned-friendo");
    expect(picked).toBeDefined();

    await page.evaluate(
      ({ wid, c }) => (window as any).__skeinTest.widgets[wid].selectFriend(c.nodeId, c.profileDocId, c.displayName),
      { wid: widgetId, c: picked }
    );

    await expect
      .poll(async () => page.evaluate((wid) => (window as any).__skeinTest.widgets[wid].getStatus(), widgetId), {
        timeout: 10_000,
      })
      .toBe("ready");

    const binHooks = await page.evaluate(
      (wid) => {
        const hooks = (window as any).__skeinTest.widgets[wid].getBinHooks();
        return { isReadOnly: hooks.isReadOnly(), nodeCount: hooks.getVisibleNodes().length };
      },
      widgetId
    );
    expect(binHooks.isReadOnly).toBe(true);
    expect(binHooks.nodeCount).toBe(rootCanvasIds.length + 1); // 6 canvases + 1 folder

    // "change" clears the selection back to unconfigured.
    await page.evaluate((wid) => (window as any).__skeinTest.widgets[wid].clearSelection(), widgetId);
    expect(
      await page.evaluate((wid) => (window as any).__skeinTest.widgets[wid].getStatus(), widgetId)
    ).toBe("unconfigured");
  });
});
