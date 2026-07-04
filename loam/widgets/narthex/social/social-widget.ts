// ---------------------------------------------------------------------------
// social widget — combined card with tabbed sub-views
// ---------------------------------------------------------------------------

import { Container, Graphics, Text } from "pixi.js";
// note: Text is still used for tab labels
import type {
  WidgetController,
  WidgetFactory,
  WidgetMountContext,
} from "../../../src/widgets/widget-types";
import {
  ACCENT,
  BG,
  BORDER,
  CARD_RADIUS,
  FONT,
  PADDING_X,
  PADDING_Y,
  RESOLUTION,
  TAB_ACTIVE_COLOR,
  TAB_FONT_SIZE,
  TAB_HEIGHT,
  TAB_INACTIVE_COLOR,
} from "./constants";
import { createFriendsTab } from "./friends-tab";
import { createProfileTab } from "./profile-tab";
import { createRequestsTab } from "./requests-tab";
import { socialSchema } from "./schema";
import { createSettingsTab } from "./settings-tab";
import type { TabContext, TabController } from "./types";

// ---------------------------------------------------------------------------
// tab identifiers
// ---------------------------------------------------------------------------

type TabName = "friends" | "requests" | "profile" | "settings";

const TAB_NAMES: readonly TabName[] = ["friends", "requests", "profile", "settings"] as const;

// ---------------------------------------------------------------------------
// widget factory
// ---------------------------------------------------------------------------

export const socialWidget: WidgetFactory<typeof socialSchema> = {
  type: "social",
  metadata: {
    name: "social",
    description: "profile, friends, and social settings",
    version: "0.1.0",
    category: "narthex",
    hidden: true,
    singleton: true,
    singletonId: "skein-social",
    defaultWidth: 280,
    defaultHeight: 500,
  },
  schema: socialSchema,
  editableProps: [],

  create(ctx: WidgetMountContext<typeof socialSchema>): WidgetController {
    const container = new Container();
    container.eventMode = "static";

    let currentWidth = ctx.width;
    let currentHeight = ctx.height;
    let activeTab: TabName = "friends";
    // true only while activeTab has been force-set to "profile" because no
    // identity exists yet (not while a user has genuinely clicked "profile"
    // themselves) — lets us snap back to "friends" the moment identity
    // appears, instead of leaving the user stranded on "profile" forever.
    // real bug this fixes: without it, every OTHER tab's own currentWidth/
    // currentHeight (each tab tracks these independently, initialized to 0)
    // never receives a real layout() call until the user manually clicks
    // that tab — since "friends" was never the active tab during the
    // (however brief) no-identity window, anything relying on friends-tab's
    // own real dimensions (e.g. a sub-view's rendered positions) would see
    // stale zeros until a manual tab click happened to trigger one.
    let forcedProfileForNoIdentity = false;

    // -----------------------------------------------------------------------
    // card background
    // -----------------------------------------------------------------------

    const cardBg = new Graphics();
    container.addChild(cardBg);

    const drawCard = (w: number, h: number) => {
      cardBg.clear();
      cardBg.roundRect(0, 0, w, h, CARD_RADIUS);
      cardBg.fill({ color: BG });
      cardBg.stroke({ color: BORDER, width: 1 });
    };

    // -----------------------------------------------------------------------
    // tab bar
    // -----------------------------------------------------------------------

    const tabTexts: Record<TabName, Text> = {} as Record<TabName, Text>;
    for (const name of TAB_NAMES) {
      const t = new Text({
        text: name,
        style: { fontFamily: FONT, fontSize: TAB_FONT_SIZE, fill: TAB_INACTIVE_COLOR },
        resolution: RESOLUTION,
      });
      t.eventMode = "static";
      t.cursor = "pointer";
      container.addChild(t);

      const tabName = name;
      t.on("pointertap", (e) => {
        e.stopPropagation();
        if (activeTab !== tabName) {
          activeTab = tabName;
          // a real, deliberate user click always overrides the no-identity
          // auto-forcing behavior above.
          forcedProfileForNoIdentity = false;
          layout(currentWidth, currentHeight);
        }
      });

      tabTexts[name] = t;
    }

    const tabUnderline = new Graphics();
    container.addChild(tabUnderline);

    // -----------------------------------------------------------------------
    // tab controllers
    // -----------------------------------------------------------------------

    const tabCtx: TabContext = {
      doc: ctx.doc as any,
      canvasElement: ctx.canvasElement,
      keyboard: ctx.keyboard,
      widgetId: ctx.widgetId,
      canvasStore: ctx.canvasStore,
      profileStore: ctx.profileStore,
      narthexDocId: ctx.narthexDocId,
      narthexStore: ctx.narthexStore,
    };

    const tabs: Record<TabName, TabController> = {
      friends: createFriendsTab(tabCtx),
      requests: createRequestsTab(tabCtx),
      profile: createProfileTab(tabCtx),
      settings: createSettingsTab(tabCtx),
    };

    // tab content container — all tab containers live here
    const tabContent = new Container();
    container.addChild(tabContent);

    for (const tab of Object.values(tabs)) {
      tabContent.addChild(tab.container);
    }

    // -----------------------------------------------------------------------
    // layout
    // -----------------------------------------------------------------------

    const layout = (w: number, h: number) => {
      const state = ctx.doc.current;
      const contentW = w - PADDING_X * 2;
      let y = PADDING_Y;

      // card background
      drawCard(w, h);

      // -- identity check ----------------------------------------------------

      const hasIdentity = !!state.profile.nodeId;

      // when there's no identity, force the profile tab and hide all tab
      // labels. once identity appears, snap back to "friends" — but only if
      // we're the ones who forced "profile" in the first place; a user who
      // genuinely chose to view "profile" (or any other tab) themselves
      // keeps their own choice.
      if (!hasIdentity) {
        activeTab = "profile";
        forcedProfileForNoIdentity = true;
      } else if (forcedProfileForNoIdentity) {
        activeTab = "friends";
        forcedProfileForNoIdentity = false;
      }

      // -- tab bar ----------------------------------------------------------

      // compute pending request count for the requests tab label
      const pendingCount =
        (state.pendingRequests ?? []).filter((r: any) => r.status === "pending").length +
        (state.outboundRequests ?? []).filter((r: any) => r.status === "pending").length;

      tabTexts.requests.text = pendingCount > 0 ? `requests (${pendingCount})` : "requests";

      if (hasIdentity) {
        // update tab text colors
        for (const name of TAB_NAMES) {
          tabTexts[name].style.fill = name === activeTab ? TAB_ACTIVE_COLOR : TAB_INACTIVE_COLOR;
        }

        // position tab labels left-to-right
        const tabGap = 16;
        let tx = PADDING_X;
        for (const name of TAB_NAMES) {
          const t = tabTexts[name];
          t.x = tx;
          t.y = y + (TAB_HEIGHT - TAB_FONT_SIZE) / 2;
          t.visible = true;
          tx += t.width + tabGap;
        }

        // accent underline under the active tab
        tabUnderline.clear();
        const activeText = tabTexts[activeTab];
        tabUnderline.moveTo(activeText.x, y + TAB_HEIGHT - 2);
        tabUnderline.lineTo(activeText.x + activeText.width, y + TAB_HEIGHT - 2);
        tabUnderline.stroke({ color: ACCENT, width: 2 });
        tabUnderline.visible = true;

        y += TAB_HEIGHT + 4;
      } else {
        // no identity — hide all tab labels and the underline
        for (const name of TAB_NAMES) {
          tabTexts[name].visible = false;
        }
        tabUnderline.clear();
        tabUnderline.visible = false;
      }

      // -- content area ------------------------------------------------------

      const contentY = y;
      const contentH = Math.max(0, h - contentY - PADDING_Y);

      tabContent.x = PADDING_X;
      tabContent.y = contentY;

      // show only the active tab, hide the rest
      for (const name of TAB_NAMES) {
        tabs[name].container.visible = name === activeTab;
      }

      // layout the active tab within the available bounds
      tabs[activeTab].layout(contentW, contentH);
    };

    // -----------------------------------------------------------------------
    // subscribe to doc changes so the tab bar re-renders (e.g. pending count)
    // -----------------------------------------------------------------------

    const unsub = ctx.doc.on("change", () => {
      layout(currentWidth, currentHeight);
    });

    // initial layout
    layout(currentWidth, currentHeight);

    // -----------------------------------------------------------------------
    // controller
    // -----------------------------------------------------------------------

    return {
      container,
      destroy() {
        unsub();
        for (const tab of Object.values(tabs)) {
          tab.destroy();
        }
        container.destroy({ children: true });
      },
      resize(w: number, h: number) {
        currentWidth = w;
        currentHeight = h;
        layout(w, h);
      },
    };
  },
};
