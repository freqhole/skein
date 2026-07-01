import { WidgetRegistry } from "../src/widgets/widget-registry";
import { registerBinWidget } from "./bin/index";
import { audioRecordingWidget } from "./audio-recording";
import { canvasInfoWidget } from "./canvas-info";
import { doodleWidget } from "./doodle";
import { fileWidget } from "./file";
import { imageWidget } from "./image";
import { labelWidget } from "./label";
import { markdownWidget } from "./markdown";
import { notepadWidget } from "./notepad";
import { peedeeeffWidget } from "./peedeeeff/index";

/**
 * a registry pre-loaded with the built-in example widgets.
 * used by the test harness and as a starting point for apps.
 *
 * this is the only export from this file — import individual widgets'
 * schemas/types/factories directly from their own files (e.g.
 * `import { labelSchema } from "../widgets/label"`) rather than through a
 * re-export here. see docs/skein-runtime-plan.md § "barrel re-export
 * pattern needs reconsideration" for why: every symbol this file used to
 * re-export already has real consumers that import it directly, so the
 * re-exports were pure dead-code surface (confirmed via `ts-prune` plus a
 * grep audit — nothing in the codebase actually imported through this
 * barrel except this registry function).
 */
export function createTestRegistry(): WidgetRegistry {
  const registry = new WidgetRegistry();
  registry.register(audioRecordingWidget);
  registry.register(canvasInfoWidget);
  registry.register(doodleWidget);
  registry.register(fileWidget);
  registry.register(imageWidget);
  registry.register(labelWidget);
  registry.register(markdownWidget);
  registry.register(notepadWidget);
  registry.register(peedeeeffWidget);
  registerBinWidget(registry);
  return registry;
}
