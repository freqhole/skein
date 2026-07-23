import type { DocumentId, Repo } from "@automerge/automerge-repo";
import { CanvasStore } from "../canvas/canvas-store";

// well-known singleton widget IDs — must match the singletonId in each factory's metadata
export const SOCIAL_WIDGET_ID = "skein-social";
export const MESSAGEZ_WIDGET_ID = "skein-messagez";

/**
 * creates a fresh narthex canvas document and seeds it with the default set of
 * widgets: a decorative label, social, and messagez.
 *
 * returns the CanvasStore so the caller can grab the documentId and persist it.
 */
export function createNarthexWithSeed(repo: Repo): CanvasStore {
  const store = CanvasStore.create(repo);

  // seed with a big pink cursive "narthex" title label in the center
  store.addWidget({
    id: crypto.randomUUID(),
    type: "label",
    title: "narthex",
    x: 80,
    y: 30,
    width: 650,
    height: 150,
    zIndex: 0,
    props: {
      text: "narthex",
      textColor: 0xd946ef,
      bgColor: -1,
      borderColor: -1,
      fontFamily: "Silkscreen",
    },
    collapsed: false,
    docId: null,
    parentId: null,
  });

  // seed with a welcome markdown widget below the label
  store.addWidget({
    id: crypto.randomUUID(),
    type: "markdown",
    x: 80,
    y: 210,
    width: 650,
    height: 680,
    zIndex: 1,
    props: {
      text: "# welcome to skein 🧶\n\nthis is the **narthex**, where you can see all of yr own stuff.\n\n## getting started\n\n- **create a new canvas**: double-click any empty space or use the `+` button in the top right to add new widgetz\n- **drag and drop** widgetz to rearrange things however you like; put them in a bin to keep it tidy (or not, nobody will ever know how messy you are).\n- **double-click** this widget to edit its text\n\n## connect with frenz\n\nset up yr **identity** in the social widget to enable peer-to-peer sharing. generate an identity, then share yr **node id** (a 64-character string) with frenz so you can share with each other.\n\nonce connected, you can **share and collaborate** together. remember: this is peer-to-peer, so frenz need to be online to sync changes. you will see incoming canvas invitez in the message widget above.\n\n## what is a canvas?\n\na canvas is an empty space where you can add doodles, text, images, video, audio, PDFz, files, etc. everyone invited to a canvas can see and contribute to it.\n\n## what is a widget?\n\na widget can be a image, or a file, or bin of other widgetz!\n\n**for example:** *double-click to edit the text in this widget, or drag it to the trash bin to remove it.*\n\n## what is a hub?\n\na hub (`tumulus`) is a headless command-line app that will sync canvases that you share with it. this makes async collaboration a bit easier if, for example, you run a hub on a machine (like a raspberry pi!) that's always online.\n\n---\n\nmade with <3 in NYC [github.com/freqhole/skein](https://github.com/freqhole/skein)",
    },
    collapsed: false,
    docId: null,
    parentId: null,
  });

  return store;
}

/**
 * opens an existing narthex document and re-seeds any singleton widgets that
 * are missing. this handles cases where widgets were lost due to a bug or
 * schema migration.
 */
export async function ensureSingletonWidgets(
  _repo: Repo,
  _narthexDocId: DocumentId
): Promise<void> {
  // social and messagez are no longer seeded as canvas widgets;
  // they are accessed via toolbar overlay panels instead.
}
