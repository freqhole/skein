import { WidgetRegistry } from "../../src/widgets/widget-registry";
import { registerBinWidget } from "../bin/index";
import { labelWidget } from "../label";
import { markdownWidget } from "../markdown";

import { canvasCardWidget } from "./canvas-card";
import { canvasWizardWidget } from "./canvas-wizard";
import { friendCanvasBinWidget } from "./friend-canvas-bin";
import { joinCanvasWidget } from "./join-canvas";
import { messagezWidget } from "./messagez-widget";
import { socialWidget } from "./social/social-widget";
import { registerTrashWidget } from "./trash-widget";

/**
 * a registry pre-loaded with the narthex (home screen) widgets.
 * the narthex uses the same canvas system but with a limited set
 * of widgets — just canvas cards for navigation and labels for grouping.
 *
 * this is the only export from this file — import individual widgets'
 * schemas/types/factories directly from their own files (e.g.
 * `import { socialWidget } from "./social/social-widget"`) rather than
 * through a re-export here. see docs/skein-runtime-plan.md § "barrel
 * re-export pattern needs reconsideration": every symbol this file used to
 * re-export already has real consumers that import it directly (confirmed
 * via a grep audit), so the re-exports were dead-code surface.
 */
export function createNarthexRegistry(): WidgetRegistry {
  const registry = new WidgetRegistry();
  registry.register(canvasCardWidget);
  registry.register(canvasWizardWidget);
  registry.register(joinCanvasWidget);
  registry.register(friendCanvasBinWidget);
  registry.register(socialWidget);
  registry.register(messagezWidget);
  registry.register(labelWidget);
  registry.register(markdownWidget);
  registerBinWidget(registry);
  registerTrashWidget(registry);
  return registry;
}
