import { EditorState, RangeSetBuilder, Compartment } from "@codemirror/state";
import {
  EditorView,
  ViewUpdate,
  Decoration,
  DecorationSet,
  ViewPlugin,
  WidgetType,
  keymap,
  placeholder,
} from "@codemirror/view";
import { renderMath, finishRenderMath, loadMathJax } from "obsidian";

// Kick off MathJax loading eagerly — the first render completes once
// `loadMathJax()` resolves. Safe to call multiple times.
loadMathJax().catch(() => {
  /* ignore */
});

/**
 * Lightweight Obsidian-style "Live Preview" editor for the composer input.
 *
 * Embeds a CodeMirror 6 EditorView and decorates markdown syntax so that,
 * on lines the cursor is NOT on, markers (#, **, `, etc.) are hidden and
 * the surrounding text is styled. On the cursor line we fall back to raw
 * source so editing stays predictable.
 *
 * This is a pragmatic approximation of Obsidian's native Live Preview; it
 * doesn't reuse Obsidian's private markdown extensions (not safe to import
 * from a plugin), but covers the common cases: headings, bold/italic,
 * inline code, fenced code, blockquotes, list bullets.
 */

const HEADING_RE = /^(#{1,6})\s+(.*)$/;
const FENCE_RE = /^```(\w*)\s*$/;
const LIST_RE = /^(\s*)([-*+])\s+(.*)$/;
const ORDERED_LIST_RE = /^(\s*)(\d+\.)\s+(.*)$/;
const BLOCKQUOTE_RE = /^(>\s?)(.*)$/;

interface InlineSpan {
  markerStart: number;
  markerEnd: number;
  contentEnd: number;
  closeEnd: number;
  cls: string;
}

interface MathSpan {
  from: number;
  to: number;
  src: string;
}

function collectInlineMath(lineText: string, lineFrom: number): MathSpan[] {
  // Accepts $...$ but not $$ (those are block math, handled separately).
  // Rejects currency-like "$5" by requiring the char after the opening $ to
  // not be a digit/space, and the char before to not be a digit/letter.
  const out: MathSpan[] = [];
  const re = /(?<![\\$])\$(?!\s)([^\n$]+?)(?<!\s)\$(?!\$)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(lineText)) != null) {
    const from = lineFrom + m.index;
    const to = from + m[0].length;
    out.push({ from, to, src: m[1] });
  }
  return out;
}

function collectInlineSpans(lineText: string, lineFrom: number): InlineSpan[] {
  const spans: InlineSpan[] = [];
  const patterns: Array<{ re: RegExp; markerLen: number; cls: string }> = [
    { re: /\*\*([^*\n]+?)\*\*/g, markerLen: 2, cls: "cm-acb-strong" },
    { re: /__([^_\n]+?)__/g, markerLen: 2, cls: "cm-acb-strong" },
    { re: /(?<![*`\w])\*([^*\n]+?)\*(?![*`\w])/g, markerLen: 1, cls: "cm-acb-em" },
    { re: /(?<![_`\w])_([^_\n]+?)_(?![_`\w])/g, markerLen: 1, cls: "cm-acb-em" },
    { re: /~~([^~\n]+?)~~/g, markerLen: 2, cls: "cm-acb-strike" },
    { re: /`([^`\n]+?)`/g, markerLen: 1, cls: "cm-acb-inline-code" },
  ];
  for (const { re, markerLen, cls } of patterns) {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(lineText)) != null) {
      const start = lineFrom + m.index;
      spans.push({
        markerStart: start,
        markerEnd: start + markerLen,
        contentEnd: start + m[0].length - markerLen,
        closeEnd: start + m[0].length,
        cls,
      });
    }
  }
  return spans;
}

class FenceLabelWidget extends WidgetType {
  constructor(readonly lang: string) {
    super();
  }
  eq(other: FenceLabelWidget): boolean {
    return other.lang === this.lang;
  }
  toDOM(): HTMLElement {
    const el = document.createElement("span");
    el.className = "cm-acb-fence-label";
    el.textContent = this.lang ? `code · ${this.lang}` : "code";
    return el;
  }
  ignoreEvent(): boolean {
    return false;
  }
}

class BulletWidget extends WidgetType {
  toDOM(): HTMLElement {
    const el = document.createElement("span");
    el.className = "cm-acb-bullet";
    el.textContent = "•";
    return el;
  }
  eq(): boolean {
    return true;
  }
  ignoreEvent(): boolean {
    return false;
  }
}

class OrderedMarkerWidget extends WidgetType {
  constructor(readonly num: string) {
    super();
  }
  eq(other: OrderedMarkerWidget): boolean {
    return other.num === this.num;
  }
  toDOM(): HTMLElement {
    const el = document.createElement("span");
    el.className = "cm-acb-bullet cm-acb-bullet-ordered";
    el.textContent = this.num;
    return el;
  }
  ignoreEvent(): boolean {
    return false;
  }
}

class MathWidget extends WidgetType {
  constructor(readonly src: string, readonly display: boolean) {
    super();
  }
  eq(other: MathWidget): boolean {
    return other.src === this.src && other.display === this.display;
  }
  toDOM(): HTMLElement {
    const wrap = document.createElement("span");
    wrap.className = this.display ? "cm-acb-math cm-acb-math-block" : "cm-acb-math";
    try {
      const rendered = renderMath(this.src, this.display);
      wrap.appendChild(rendered);
      finishRenderMath();
    } catch {
      wrap.textContent = this.src;
    }
    return wrap;
  }
  ignoreEvent(): boolean {
    return false;
  }
}

function buildDecorations(view: EditorView): DecorationSet {
  const builder = new RangeSetBuilder<Decoration>();
  const doc = view.state.doc;
  const sel = view.state.selection.main;
  const cursorLine = doc.lineAt(sel.head).number;

  let inFence = false;
  let fenceLang = "";

  for (const { from, to } of view.visibleRanges) {
    let pos = from;
    while (pos <= to) {
      const line = doc.lineAt(pos);
      const text = line.text;
      const lineIsCursorLine = line.number === cursorLine;
      const selTouchesLine =
        sel.from <= line.to && sel.to >= line.from && sel.from !== sel.to;
      const raw = lineIsCursorLine || selTouchesLine;

      const fenceMatch = text.match(FENCE_RE);
      if (fenceMatch) {
        if (!inFence) {
          inFence = true;
          fenceLang = fenceMatch[1] || "";
          builder.add(
            line.from,
            line.from,
            Decoration.line({ class: "cm-acb-fence-open cm-acb-code-line" })
          );
          if (!raw && line.to > line.from) {
            builder.add(
              line.from,
              line.to,
              Decoration.replace({ widget: new FenceLabelWidget(fenceLang) })
            );
          }
        } else {
          inFence = false;
          fenceLang = "";
          builder.add(
            line.from,
            line.from,
            Decoration.line({ class: "cm-acb-fence-close cm-acb-code-line" })
          );
          if (!raw && line.to > line.from) {
            builder.add(line.from, line.to, Decoration.replace({}));
          }
        }
        pos = line.to + 1;
        continue;
      }

      if (inFence) {
        builder.add(
          line.from,
          line.from,
          Decoration.line({ class: "cm-acb-code-line" })
        );
        pos = line.to + 1;
        continue;
      }

      const headingMatch = text.match(HEADING_RE);
      if (headingMatch) {
        const level = headingMatch[1].length;
        builder.add(
          line.from,
          line.from,
          Decoration.line({ class: `cm-acb-heading cm-acb-h${level}` })
        );
        if (!raw) {
          builder.add(
            line.from,
            line.from + headingMatch[1].length + 1,
            Decoration.replace({})
          );
        } else {
          builder.add(
            line.from,
            line.from + headingMatch[1].length,
            Decoration.mark({ class: "cm-acb-marker" })
          );
        }
        pos = line.to + 1;
        continue;
      }

      const bqMatch = text.match(BLOCKQUOTE_RE);
      if (bqMatch) {
        builder.add(
          line.from,
          line.from,
          Decoration.line({ class: "cm-acb-blockquote" })
        );
        if (!raw) {
          builder.add(
            line.from,
            line.from + bqMatch[1].length,
            Decoration.replace({})
          );
        } else {
          builder.add(
            line.from,
            line.from + bqMatch[1].length,
            Decoration.mark({ class: "cm-acb-marker" })
          );
        }
        pos = line.to + 1;
        continue;
      }

      const listMatch = text.match(LIST_RE);
      const orderedMatch = text.match(ORDERED_LIST_RE);
      if (listMatch) {
        builder.add(
          line.from,
          line.from,
          Decoration.line({ class: "cm-acb-list" })
        );
        const indentLen = listMatch[1].length;
        const markerStart = line.from + indentLen;
        const markerEnd = markerStart + 1; // one char: -, *, or +
        const spaceEnd = markerEnd + 1; // trailing space
        if (!raw) {
          builder.add(
            markerStart,
            spaceEnd,
            Decoration.replace({ widget: new BulletWidget() })
          );
        }
      } else if (orderedMatch) {
        builder.add(
          line.from,
          line.from,
          Decoration.line({ class: "cm-acb-list" })
        );
        const indentLen = orderedMatch[1].length;
        const markerStart = line.from + indentLen;
        const markerEnd = markerStart + orderedMatch[2].length; // e.g. "1."
        const spaceEnd = markerEnd + 1;
        if (!raw) {
          builder.add(
            markerStart,
            spaceEnd,
            Decoration.replace({ widget: new OrderedMarkerWidget(orderedMatch[2]) })
          );
        }
      }

      // Collect inline math + markdown spans and emit them in order of
      // position. RangeSetBuilder requires strictly non-decreasing `from`.
      const mathSpans = collectInlineMath(text, line.from);
      const inlineSpans = collectInlineSpans(text, line.from).filter(
        (s) => !mathSpans.some((m) => s.markerStart >= m.from && s.closeEnd <= m.to)
      );

      type Entry = { from: number; emit: () => void };
      const entries: Entry[] = [];
      for (const m of mathSpans) {
        entries.push({
          from: m.from,
          emit: () => {
            if (!raw) {
              builder.add(
                m.from,
                m.to,
                Decoration.replace({ widget: new MathWidget(m.src, false) })
              );
            } else {
              builder.add(
                m.from,
                m.to,
                Decoration.mark({ class: "cm-acb-math-raw" })
              );
            }
          },
        });
      }
      for (const s of inlineSpans) {
        entries.push({
          from: s.markerStart,
          emit: () => {
            if (raw) {
              builder.add(
                s.markerStart,
                s.markerEnd,
                Decoration.mark({ class: "cm-acb-marker" })
              );
              builder.add(
                s.markerEnd,
                s.contentEnd,
                Decoration.mark({ class: s.cls })
              );
              builder.add(
                s.contentEnd,
                s.closeEnd,
                Decoration.mark({ class: "cm-acb-marker" })
              );
            } else {
              builder.add(s.markerStart, s.markerEnd, Decoration.replace({}));
              builder.add(
                s.markerEnd,
                s.contentEnd,
                Decoration.mark({ class: s.cls })
              );
              builder.add(s.contentEnd, s.closeEnd, Decoration.replace({}));
            }
          },
        });
      }
      entries.sort((a, b) => a.from - b.from);
      for (const e of entries) e.emit();

      pos = line.to + 1;
    }
  }
  return builder.finish();
}

function safeBuild(view: EditorView): DecorationSet {
  try {
    return buildDecorations(view);
  } catch (err) {
    console.warn("[obsidian-agents] live-preview decoration build failed", err);
    return Decoration.none;
  }
}

const livePreviewPlugin = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    constructor(view: EditorView) {
      this.decorations = safeBuild(view);
    }
    update(u: ViewUpdate) {
      if (u.docChanged || u.selectionSet || u.viewportChanged) {
        this.decorations = safeBuild(u.view);
      }
    }
  },
  { decorations: (v) => v.decorations }
);

export interface LivePreviewEditorOptions {
  placeholder?: string;
  initialValue?: string;
  onChange?: (value: string) => void;
  onSubmit?: () => void;
  onKeyDown?: (e: KeyboardEvent) => boolean;
  onPaste?: (e: ClipboardEvent) => void;
}

export class LivePreviewEditor {
  readonly dom: HTMLElement;
  private view: EditorView;
  private onChange?: (value: string) => void;
  private placeholderCompartment = new Compartment();

  constructor(parent: HTMLElement, opts: LivePreviewEditorOptions = {}) {
    this.dom = parent.createDiv({ cls: "obsidian-agents-composer-cm" });
    this.onChange = opts.onChange;

    const updateListener = EditorView.updateListener.of((u) => {
      if (u.docChanged && this.onChange) {
        this.onChange(u.state.doc.toString());
      }
    });

    const keyHandler = keymap.of([
      {
        key: "Mod-Enter",
        run: () => {
          opts.onSubmit?.();
          return true;
        },
      },
    ]);

    const state = EditorState.create({
      doc: opts.initialValue || "",
      extensions: [
        EditorView.lineWrapping,
        this.placeholderCompartment.of(placeholder(opts.placeholder || "Ask anything")),
        livePreviewPlugin,
        updateListener,
        keyHandler,
        EditorView.theme({
          "&": {
            fontFamily: "var(--font-interface)",
            fontSize: "16px",
            color: "var(--text-normal)",
            background: "transparent",
          },
          ".cm-content": {
            caretColor: "var(--text-normal)",
            padding: "10px 4px 8px 4px",
          },
          "&.cm-focused": { outline: "none" },
          ".cm-line": { padding: "0 4px" },
          ".cm-scroller": { fontFamily: "inherit" },
        }),
      ],
    });

    this.view = new EditorView({ state, parent: this.dom });

    if (opts.onKeyDown) {
      this.view.dom.addEventListener(
        "keydown",
        (e) => {
          if (opts.onKeyDown!(e)) {
            e.preventDefault();
          }
        },
        true
      );
    }
    if (opts.onPaste) {
      this.view.dom.addEventListener("paste", (e) => opts.onPaste!(e));
    }
  }

  getValue(): string {
    return this.view.state.doc.toString();
  }

  setValue(value: string): void {
    this.view.dispatch({
      changes: { from: 0, to: this.view.state.doc.length, insert: value },
    });
  }

  insertAtCursor(text: string): void {
    const pos = this.view.state.selection.main.head;
    this.view.dispatch({
      changes: { from: pos, insert: text },
      selection: { anchor: pos + text.length },
    });
  }

  getCursor(): number {
    return this.view.state.selection.main.head;
  }

  getSelectionRange(): { from: number; to: number } {
    const s = this.view.state.selection.main;
    return { from: s.from, to: s.to };
  }

  setCursor(pos: number): void {
    this.view.dispatch({ selection: { anchor: pos } });
  }

  replaceRange(from: number, to: number, insert: string): void {
    this.view.dispatch({
      changes: { from, to, insert },
      selection: { anchor: from + insert.length },
    });
  }

  focus(): void {
    this.view.focus();
  }

  setPlaceholder(text: string): void {
    this.view.dispatch({
      effects: this.placeholderCompartment.reconfigure(placeholder(text)),
    });
  }

  getEditorView(): EditorView {
    return this.view;
  }

  destroy(): void {
    this.view.destroy();
  }
}
