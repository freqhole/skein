import {
  CanvasTextMetrics,
  Container,
  Graphics,
  HTMLText,
  Text,
  TextStyle,
  type TextStyleFontWeight,
} from "pixi.js";
import { z } from "zod";
import { FONT_OPTIONS } from "../src/fonts/font-loader";
import { createDomOverlay, type DomOverlayHandle } from "../src/widgets/dom-overlay";
import { colorToCss } from "../src/widgets/format";
import {
  isTransparent,
  safeColor,
  type CompactInfo,
  type WidgetController,
  type WidgetFactory,
  type WidgetMountContext,
} from "../src/widgets/widget-types";

const PADDING = 12;
const BORDER_EDITING_COLOR = 0xd946ef;

// extra padding inside each rendered Text/HTMLText object so descenders
// (g, q, p, y) aren't clipped against the object's own bounds, and a
// line-height ratio so wrapped rows within a paragraph have breathing room
const TEXT_PADDING = 4;
const LINE_HEIGHT_RATIO = 1.35;

export const markdownSchema = z.object({
  text: z
    .string()
    .default(
      "# hello\n\nthis is a **markdown** widget.\n\n- item one\n- item two\n\n---\n\n*italic text* and `code text` and regular text."
    ),
  bgColor: z.number().default(0x0f0f1a),
  textColor: z.number().default(0xd4d4e0),
  headingColor: z.number().default(0xf0f0ff),
  accentColor: z.number().default(0xd946ef),
  codeColor: z.number().default(0xe0e0e8),
  codeBgColor: z.number().default(0x2a2a3a),
  fontFamily: z.string().default("system-ui, sans-serif"),
  fontSize: z.number().default(13),
  borderWidth: z.number().default(1),
});

export type MarkdownState = z.infer<typeof markdownSchema>;

// ---------------------------------------------------------------------------
// markdown inline syntax → pixi tag conversion
//
// converts markdown inline markers to XML-style tags that pixi's
// HTMLText tagStyles + cssOverrides can render with distinct styles:
//   **bold**   → <b>bold</b>
//   *italic*   → <i>italic</i>
//   `code`     → <code>code</code>
//
// order matters — bold (**) must be matched before italic (*) to avoid
// partial matches. literal angle brackets in the source are replaced
// with placeholders before tag conversion, then resolved to the correct
// escape form (HTML entities for HTMLText, zero-width spaces for Text).
// ---------------------------------------------------------------------------

// unique placeholders that won't appear in user text
const PH_AMP = "\x00AMP\x00";
const PH_LT = "\x00LT\x00";
const PH_GT = "\x00GT\x00";

function markdownToTagged(line: string): string {
  // replace literal &, <, > with placeholders so they don't interfere
  // with the tag syntax we're about to introduce
  let out = line.replace(/&/g, PH_AMP).replace(/</g, PH_LT).replace(/>/g, PH_GT);

  // bold: **text** → <b>text</b>  (must come before italic)
  out = out.replace(/\*\*(.+?)\*\*/g, "<b>$1</b>");

  // italic: *text* → <i>text</i>
  out = out.replace(/(?<!\*)\*(?!\*)(.+?)(?<!\*)\*(?!\*)/g, "<i>$1</i>");

  // inline code: `text` → <code>text</code>
  out = out.replace(/`(.+?)`/g, "<code>$1</code>");

  return out;
}

/** resolve placeholders for HTMLText (uses HTML entities) */
function resolveForHtml(tagged: string): string {
  return tagged
    .replace(/\x00AMP\x00/g, "&amp;")
    .replace(/\x00LT\x00/g, "&lt;")
    .replace(/\x00GT\x00/g, "&gt;");
}

/** resolve placeholders for regular Text (uses zero-width spaces to break tag parsing) */
function resolveForText(tagged: string): string {
  return tagged
    .replace(/\x00AMP\x00/g, "&")
    .replace(/\x00LT\x00/g, "\u200B<\u200B")
    .replace(/\x00GT\x00/g, "\u200B>\u200B");
}

// convert a numeric color (0xRRGGBB) to a CSS hex string (#rrggbb)
function colorToHex(color: number): string {
  if (color < 0) return "transparent";
  return "#" + (color & 0xffffff).toString(16).padStart(6, "0");
}

// ---------------------------------------------------------------------------
// widget factory
// ---------------------------------------------------------------------------

export const markdownWidget: WidgetFactory<typeof markdownSchema> = {
  type: "markdown",
  metadata: {
    name: "markdown",
    description: "a markdown text renderer with inline editing",
    version: "0.3.0",
    category: "text",
  },
  schema: markdownSchema,
  editableProps: [
    { key: "bgColor", label: "background", type: "color" as const, default: 0x0f0f1a },
    { key: "textColor", label: "text color", type: "color" as const, default: 0xd4d4e0 },
    { key: "headingColor", label: "heading color", type: "color" as const, default: 0xf0f0ff },
    { key: "accentColor", label: "accent color", type: "color" as const, default: 0xd946ef },
    { key: "codeColor", label: "code color", type: "color" as const, default: 0xe0e0e8 },
    { key: "codeBgColor", label: "code bg", type: "color" as const, default: 0x2a2a3a },
    { key: "fontSize", label: "font size", type: "number" as const, default: 13 },
    { key: "borderWidth", label: "border width", type: "number" as const, min: 0, default: 1 },
    {
      key: "fontFamily",
      label: "font",
      type: "select" as const,
      options: FONT_OPTIONS,
      default: "system-ui, sans-serif",
    },
  ],

  getCompactInfo: (state: MarkdownState): CompactInfo => ({
    label:
      state.text
        .split("\n")
        .find((l) => l.trim() !== "")
        ?.replace(/^#+\s*/, "")
        .trim() || "markdown",
  }),

  create(ctx: WidgetMountContext<typeof markdownSchema>): WidgetController {
    const container = new Container();
    let editing = false;
    let currentWidth = ctx.width;
    let currentHeight = ctx.height;

    // background
    const bg = new Graphics();
    const drawBg = (w: number, h: number, isEditing: boolean) => {
      const state = ctx.doc.current;
      bg.clear();
      bg.roundRect(0, 0, w, h, 6);
      bg.fill(state.bgColor === -1 ? { color: 0, alpha: 0 } : { color: state.bgColor });
      const bw = isEditing ? 3 : state.borderWidth;
      if (bw > 0) {
        bg.stroke({
          color: isEditing ? BORDER_EDITING_COLOR : 0x2a2a3a,
          width: bw,
        });
      }
    };
    drawBg(currentWidth, currentHeight, false);
    container.addChild(bg);

    // content container — holds rendered elements and gets clipped
    const content = new Container();
    content.x = PADDING;
    content.y = PADDING;
    container.addChild(content);

    // clip mask to prevent overflow
    const clipMask = new Graphics();
    const drawClipMask = (w: number, h: number) => {
      clipMask.clear();
      clipMask.rect(PADDING, PADDING, w - PADDING * 2, h - PADDING * 2);
      clipMask.fill({ color: 0xffffff });
    };
    drawClipMask(currentWidth, currentHeight);
    container.addChild(clipMask);
    content.mask = clipMask;

    const contentWidth = () => Math.max(currentWidth - PADDING * 2, 1);

    // rendered elements for the parsed markdown output.
    // lines with inline code use HTMLText; plain lines use Text.
    let renderedElements: (Text | HTMLText | Graphics)[] = [];

    // build CSS overrides for HTMLText code styling
    function buildCodeCssOverrides(state: MarkdownState): string[] {
      const codeBg = colorToHex(state.codeBgColor);
      const codeColor = colorToHex(state.codeColor);
      return [
        `code { background-color: ${codeBg}; color: ${codeColor}; font-family: "Courier New", monospace; border-radius: 3px; padding: 1px 5px; font-size: ${Math.round(state.fontSize * 0.9)}px; }`,
      ];
    }

    // check if a line's tagged output contains a <code> tag
    function hasCodeTag(tagged: string): boolean {
      return tagged.includes("<code>");
    }

    // -------------------------------------------------------------------
    // link-aware line layout
    //
    // a line containing a markdown link ([label](url)) is rendered as
    // several small Text objects instead of one tagged block, so only
    // the link substring is interactive and links wrap correctly across
    // rows. lines without a link keep the simpler single-object path
    // above.
    // -------------------------------------------------------------------

    interface LineRun {
      text: string;
      bold?: boolean;
      italic?: boolean;
      code?: boolean;
      link?: string;
    }

    interface RunStyleParams {
      fontFamily: string;
      fontSize: number;
      fontWeight: TextStyleFontWeight;
      baseFill: number;
      accentColor: number;
      codeColor: number;
    }

    interface LinePlacement {
      text: string;
      run: LineRun;
      x: number;
      y: number;
    }

    const LINK_RE = /\[([^\]]+)\]\((\S+?)\)/g;
    const INLINE_RE = /\*\*(.+?)\*\*|(?<!\*)\*(?!\*)(.+?)(?<!\*)\*(?!\*)|`(.+?)`/g;

    function hasLink(text: string): boolean {
      LINK_RE.lastIndex = 0;
      return LINK_RE.test(text);
    }

    // parse inline bold/italic/code markers (no links) into runs
    function parseInlineRuns(text: string): LineRun[] {
      const runs: LineRun[] = [];
      INLINE_RE.lastIndex = 0;
      let lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = INLINE_RE.exec(text))) {
        if (m.index > lastIndex) runs.push({ text: text.slice(lastIndex, m.index) });
        if (m[1] !== undefined) runs.push({ text: m[1], bold: true });
        else if (m[2] !== undefined) runs.push({ text: m[2], italic: true });
        else if (m[3] !== undefined) runs.push({ text: m[3], code: true });
        lastIndex = INLINE_RE.lastIndex;
      }
      if (lastIndex < text.length) runs.push({ text: text.slice(lastIndex) });
      return runs;
    }

    // parse a line (already stripped of heading/list markers) into an
    // ordered list of runs: split on links first, then bold/italic/code
    // within each non-link segment
    function parseLineToRuns(line: string): LineRun[] {
      const runs: LineRun[] = [];
      LINK_RE.lastIndex = 0;
      let lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = LINK_RE.exec(line))) {
        if (m.index > lastIndex) runs.push(...parseInlineRuns(line.slice(lastIndex, m.index)));
        runs.push({ text: m[1], link: m[2] });
        lastIndex = LINK_RE.lastIndex;
      }
      if (lastIndex < line.length) runs.push(...parseInlineRuns(line.slice(lastIndex)));
      return runs.filter((r) => r.text.length > 0);
    }

    function styleForRun(run: LineRun, params: RunStyleParams) {
      return {
        fontFamily: run.code ? "Courier New, monospace" : params.fontFamily,
        fontSize: params.fontSize,
        fontWeight: run.bold ? ("bold" as TextStyleFontWeight) : params.fontWeight,
        fontStyle: run.italic ? ("italic" as const) : ("normal" as const),
        fill: safeColor(
          run.link ? params.accentColor : run.code ? params.codeColor : params.baseFill
        ),
      };
    }

    // manually word-wrap a line's runs, measuring each word with pixi's own
    // public text metrics so wrapping matches real glyph widths. groups
    // consecutive words of the same run on the same row into one placement
    // so a plain sentence stays a small handful of objects, not one per word.
    function layoutRuns(
      runs: LineRun[],
      params: RunStyleParams,
      cw: number,
      lineHeight: number
    ): { placements: LinePlacement[]; height: number } {
      const placements: LinePlacement[] = [];
      let x = 0;
      let y = 0;
      let rowHasWord = false;
      let pieceRunIndex = -1;
      let pieceText = "";
      let pieceX = 0;

      const flush = () => {
        if (pieceText.length > 0) {
          placements.push({ text: pieceText, run: runs[pieceRunIndex], x: pieceX, y });
        }
        pieceText = "";
      };

      for (let ri = 0; ri < runs.length; ri++) {
        const run = runs[ri];
        const words = run.text.split(/\s+/).filter((w) => w.length > 0);
        const style = new TextStyle(styleForRun(run, params));
        const spaceWidth = CanvasTextMetrics.measureText(" ", style).width;

        for (const word of words) {
          const wordWidth = CanvasTextMetrics.measureText(word, style).width;
          const gap = rowHasWord ? spaceWidth : 0;

          // an unbreakably long word/link on an otherwise-empty row is left
          // to overflow rather than wrapped, avoiding an infinite loop
          if (rowHasWord && x + gap + wordWidth > cw) {
            flush();
            pieceRunIndex = -1;
            x = 0;
            y += lineHeight;
            rowHasWord = false;
          } else if (rowHasWord) {
            x += gap;
          }

          if (ri !== pieceRunIndex) {
            flush();
            pieceRunIndex = ri;
            pieceX = x;
          } else {
            pieceText += " ";
          }

          pieceText += word;
          x += wordWidth;
          rowHasWord = true;
        }
      }
      flush();

      return { placements, height: y + lineHeight };
    }

    // parse and render markdown source into PixiJS display objects
    function renderMarkdown(source: string, state: MarkdownState) {
      // clear existing rendered elements
      for (const el of renderedElements) {
        content.removeChild(el);
        el.destroy();
      }
      renderedElements = [];

      const lines = source.split("\n");
      let y = 0;
      const cw = contentWidth();
      const cssOverrides = buildCodeCssOverrides(state);

      for (const line of lines) {
        // blank line — paragraph spacing
        if (line.trim() === "") {
          y += state.fontSize * 0.6;
          continue;
        }

        // horizontal rule
        if (line.trim() === "---") {
          const rule = new Graphics();
          rule.rect(0, y + state.fontSize * 0.3, cw, 1);
          rule.fill(
            isTransparent(state.accentColor) ? { color: 0, alpha: 0 } : { color: state.accentColor }
          );
          content.addChild(rule);
          renderedElements.push(rule);
          y += state.fontSize * 0.8;
          continue;
        }

        let lineBody: string;
        let fontSize: number;
        let fontWeight: TextStyleFontWeight = "normal";
        let fill: number;
        let bulletPrefix = "";

        if (line.startsWith("### ")) {
          lineBody = line.slice(4);
          fontSize = state.fontSize * 1.1;
          fontWeight = "bold";
          fill = state.headingColor;
        } else if (line.startsWith("## ")) {
          lineBody = line.slice(3);
          fontSize = state.fontSize * 1.3;
          fontWeight = "bold";
          fill = state.headingColor;
        } else if (line.startsWith("# ")) {
          lineBody = line.slice(2);
          fontSize = state.fontSize * 1.6;
          fontWeight = "bold";
          fill = state.headingColor;
        } else if (line.startsWith("- ")) {
          bulletPrefix = "\u2022 ";
          lineBody = line.slice(2);
          fontSize = state.fontSize;
          fill = state.textColor;
        } else {
          lineBody = line;
          fontSize = state.fontSize;
          fill = state.textColor;
        }

        const lineHeight = Math.round(fontSize * LINE_HEIGHT_RATIO);

        // lines with a markdown link get manual run-based layout instead
        // of the single tagged Text/HTMLText object below
        if (hasLink(lineBody)) {
          const runs = parseLineToRuns(lineBody);
          if (bulletPrefix) runs.unshift({ text: bulletPrefix });

          const runParams: RunStyleParams = {
            fontFamily: state.fontFamily,
            fontSize,
            fontWeight,
            baseFill: fill,
            accentColor: state.accentColor,
            codeColor: state.codeColor,
          };
          const { placements, height } = layoutRuns(runs, runParams, cw, lineHeight);

          for (const p of placements) {
            const runStyle = styleForRun(p.run, runParams);
            const piece = new Text({
              text: p.text,
              resolution: 2,
              style: { ...runStyle, padding: TEXT_PADDING, lineHeight },
            });
            piece.x = p.x;
            piece.y = y + p.y;
            piece.alpha = isTransparent(runStyle.fill) ? 0 : 1;
            if (p.run.link) {
              const url = p.run.link;
              piece.eventMode = "static";
              piece.cursor = "pointer";
              piece.on("pointertap", () => {
                window.open(url, "_blank", "noopener,noreferrer");
              });
            }
            content.addChild(piece);
            renderedElements.push(piece);
          }
          y += height + state.fontSize * 0.25;
          continue;
        }

        const taggedText = bulletPrefix + markdownToTagged(lineBody);

        // use HTMLText for lines that contain <code> tags so we get CSS
        // background + border-radius. use regular Text for everything
        // else (faster rendering, no SVG overhead).
        const useHtml = hasCodeTag(taggedText);

        // resolve placeholders to the correct escape form for the chosen renderer
        const resolvedText = useHtml ? resolveForHtml(taggedText) : resolveForText(taggedText);

        const textObj = useHtml
          ? new HTMLText({
              text: resolvedText,
              resolution: 2,
              style: {
                fontFamily: state.fontFamily,
                fontSize,
                fontWeight,
                fill: safeColor(fill),
                wordWrap: true,
                wordWrapWidth: cw,
                padding: TEXT_PADDING,
                lineHeight,
                tagStyles: {
                  b: { fontWeight: "bold" },
                  i: { fontStyle: "italic" },
                  code: {
                    // font/color handled by cssOverrides for background support,
                    // but tagStyles ensures fill inherits properly
                    fill: safeColor(state.codeColor),
                    fontFamily: "Courier New, monospace",
                  },
                },
                cssOverrides,
              },
            })
          : new Text({
              text: resolvedText,
              resolution: 2,
              style: {
                fontFamily: state.fontFamily,
                fontSize,
                fontWeight,
                fill: safeColor(fill),
                wordWrap: true,
                wordWrapWidth: cw,
                padding: TEXT_PADDING,
                lineHeight,
                tagStyles: {
                  b: { fontWeight: "bold" as TextStyleFontWeight },
                  i: { fontStyle: "italic" as const },
                  code: {
                    fontFamily: "Courier New, monospace",
                    fill: safeColor(state.codeColor),
                  },
                },
              },
            });

        textObj.alpha = isTransparent(fill) ? 0 : 1;
        textObj.y = y;
        content.addChild(textObj);
        renderedElements.push(textObj);
        y += textObj.height + state.fontSize * 0.25;
      }
    }

    // initial render
    renderMarkdown(ctx.doc.current.text, ctx.doc.current);

    // DOM overlay for inline editing
    let activeOverlay: DomOverlayHandle | null = null;

    const startEditing = () => {
      if (editing) return;
      if (ctx.canvasStore?.isLocalViewer()) return;
      editing = true;
      drawBg(currentWidth, currentHeight, true);

      // hide rendered markdown elements while editing
      for (const el of renderedElements) {
        el.visible = false;
      }

      const state = ctx.doc.current;

      activeOverlay = createDomOverlay({
        container,
        canvasElement: ctx.canvasElement,
        width: currentWidth,
        height: currentHeight,
        multiline: true,
        value: state.text,
        enterCommits: false, // Enter inserts newlines in markdown
        onCommit: (value: string) => {
          editing = false;
          activeOverlay = null;
          if (value !== ctx.doc.current.text) {
            ctx.doc.change((draft) => {
              draft.text = value;
            });
          }
          renderMarkdown(ctx.doc.current.text, ctx.doc.current);
          drawBg(currentWidth, currentHeight, false);
        },
        onRevert: () => {
          editing = false;
          activeOverlay = null;
          renderMarkdown(ctx.doc.current.text, ctx.doc.current);
          drawBg(currentWidth, currentHeight, false);
        },
        css: {
          fontFamily: state.fontFamily,
          fontSize: `${state.fontSize}px`,
          color: colorToCss(state.textColor),
          padding: `${PADDING}px`,
          overflow: "auto",
          lineHeight: "1.4",
          whiteSpace: "pre-wrap",
          wordWrap: "break-word",
        },
      });
    };

    // double-click to enter edit mode
    let lastTapTime = 0;
    bg.eventMode = "static";
    bg.cursor = "default";
    bg.on("pointertap", () => {
      if (editing) return;
      const now = Date.now();
      if (now - lastTapTime < 400) {
        startEditing();
        lastTapTime = 0;
      } else {
        lastTapTime = now;
      }
    });

    // subscribe to remote doc changes
    const unsub = ctx.doc.on("change", (state) => {
      if (!editing) {
        renderMarkdown(state.text, state);
      }
      drawBg(currentWidth, currentHeight, editing);
    });

    return {
      container,

      onReposition() {
        activeOverlay?.reposition();
      },

      destroy() {
        if (activeOverlay) {
          activeOverlay.remove();
          activeOverlay = null;
        }
        unsub();
        container.destroy({ children: true });
      },

      resize(width: number, height: number) {
        if (editing && activeOverlay) {
          activeOverlay.element.blur();
        }
        currentWidth = width;
        currentHeight = height;
        drawBg(width, height, false);
        drawClipMask(width, height);
        renderMarkdown(ctx.doc.current.text, ctx.doc.current);
      },
    };
  },
};
