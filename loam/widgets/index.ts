import { WidgetRegistry } from "../src/widgets/widget-registry";
import { registerBinWidget } from "./bin/index";
import { audioRecordingWidget } from "./audio-recording";
import { voiceRecordingWidget } from "./voice-recording";
import { canvasInfoWidget } from "./canvas-info";
import { canvasLinkPickerWidget } from "./canvas-link-picker";
import { doodleWidget } from "./doodle";
import { fileWidget } from "./file";
import { imageWidget } from "./image";
import { labelWidget } from "./label";
import { linkWidget } from "./link";
import { markdownWidget } from "./markdown";
import { notepadWidget } from "./notepad";
import { peedeeeffWidget } from "./peedeeeff/index";
import { canvasCardWidget } from "./narthex/canvas-card";
import { canvasWizardWidget } from "./narthex/canvas-wizard";

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
  registry.register(voiceRecordingWidget);
  registry.register(canvasInfoWidget);
  registry.register(doodleWidget);
  registry.register(fileWidget);
  registry.register(imageWidget);
  registry.register(labelWidget);
  registry.register(linkWidget);
  registry.register(markdownWidget);
  registry.register(notepadWidget);
  registry.register(peedeeeffWidget);
  // canvas-card (see widgets/narthex/canvas-card.ts) is registered here too
  // (not just the narthex registry) so a "link to canvas" card placed on a
  // REGULAR canvas can actually be rendered by widget-manager.ts — its own
  // `metadata.hidden: true` already keeps it out of this registry's palette
  // flyout, same as on the narthex; it's only ever added programmatically
  // (see canvas-link-picker.ts / boot.ts's `linkCanvasToCurrent()`).
  registry.register(canvasCardWidget);
  // canvas-wizard ( "create a new canvas") and canvas-link-picker ("link to
  // an existing canvas") are both placeable from any writable regular
  // canvas, not just the narthex — see docs/narthex-widgets-and-file-
  // transfer-plan.md section 4.
  registry.register(canvasWizardWidget);
  registry.register(canvasLinkPickerWidget);
  registerBinWidget(registry);
  return registry;
}
