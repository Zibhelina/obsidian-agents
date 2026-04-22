import { MarkdownRenderer, Component, Notice, setIcon } from "obsidian";
import { LayoutBlock, LayoutPosition } from "../../types";
import { parseRichLayouts, mountRichLayout, activateTermLinks } from "./rich-layouts";

/**
 * Wrap every rendered <table> in a scroll container with a hover-revealed
 * "Copy" button. Converts the table to TSV on click (columns separated by
 * tabs, rows by newlines) — paste-friendly in Sheets, Excel, Notion, etc.
 */
function enhanceTables(root: HTMLElement): void {
  const tables = root.querySelectorAll("table");
  tables.forEach((table) => {
    const t = table as HTMLTableElement;
    // Guard against double-wrapping on re-renders.
    if (t.parentElement?.classList.contains("obsidian-agents-table-scroll")) return;

    const wrap = document.createElement("div");
    wrap.className = "obsidian-agents-table-wrap";
    const scroll = document.createElement("div");
    scroll.className = "obsidian-agents-table-scroll";
    const btn = document.createElement("button");
    btn.className = "obsidian-agents-table-copy";
    btn.type = "button";
    btn.setAttribute("aria-label", "Copy table");
    btn.title = "Copy table";
    setIcon(btn, "copy");
    btn.addEventListener("click", async (e) => {
      e.preventDefault();
      e.stopPropagation();
      try {
        await navigator.clipboard.writeText(tableToTsv(t));
        // Swap to a checkmark, then fade the button out. Matches ChatGPT's
        // confirm-then-disappear pattern so the user gets feedback without
        // a persistent button sitting in the corner.
        setIcon(btn, "check");
        btn.classList.add("obsidian-agents-table-copy-done");
        // Reset after the fade completes so a second copy works normally.
        window.setTimeout(() => {
          btn.classList.remove("obsidian-agents-table-copy-done");
          setIcon(btn, "copy");
        }, 1400);
      } catch {
        new Notice("Copy failed");
      }
    });

    t.replaceWith(wrap);
    scroll.appendChild(t);
    wrap.appendChild(btn);
    wrap.appendChild(scroll);
  });
}

function tableToTsv(table: HTMLTableElement): string {
  const rows: string[] = [];
  table.querySelectorAll("tr").forEach((tr) => {
    const cells: string[] = [];
    tr.querySelectorAll("th, td").forEach((cell) => {
      // Collapse internal whitespace + strip tabs/newlines so one row = one line.
      const txt = (cell.textContent || "").replace(/\s+/g, " ").trim();
      cells.push(txt);
    });
    rows.push(cells.join("\t"));
  });
  return rows.join("\n");
}

function positionToClass(pos: LayoutPosition): string {
  switch (pos) {
    case "left": return "obsidian-agents-layout-left";
    case "right": return "obsidian-agents-layout-right";
    case "above": return "obsidian-agents-layout-above";
    case "below": return "obsidian-agents-layout-below";
    case "inline": return "obsidian-agents-layout-inline";
    default: return "obsidian-agents-layout-inline";
  }
}

interface ParsedApplet {
  placeholder: string;
  html: string;
  position: LayoutPosition;
  width?: string;
  height?: string;
  kind: "html" | "react";
}

/**
 * Parse ```obsidian-agents-applet ...``` and ```obsidian-agents-react ...``` fenced blocks
 * out of markdown. Each block is replaced by a placeholder token in the text;
 * the block is rendered as an iframe after markdown rendering, at the spot of
 * the placeholder (or floated left/right).
 *
 * Supported attributes on the fence info line:
 *   position=left|right|above|below|inline (default: inline)
 *   width=300px
 *   height=240px
 */
function parseApplets(content: string): { content: string; applets: ParsedApplet[] } {
  const applets: ParsedApplet[] = [];
  // Accept both the current `obsidian-agents-*` fence prefix and the legacy
  // `agentchat-*` prefix — see rich-layouts.ts for why.
  const re = /```(?:obsidian-agents|agentchat)-(applet|react)([^\n]*)\n([\s\S]*?)```/g;
  let idx = 0;
  const out = content.replace(re, (_m, kind: string, attrs: string, body: string) => {
    const id = `obsidian-agents-applet-${idx++}`;
    const pos = (attrs.match(/position=(\w+)/)?.[1] || "inline") as LayoutPosition;
    const width = attrs.match(/width=([^\s]+)/)?.[1];
    const height = attrs.match(/height=([^\s]+)/)?.[1];
    applets.push({
      placeholder: id,
      html: body,
      position: pos,
      width,
      height,
      kind: kind as "html" | "react",
    });
    // Use a unique inline code placeholder — renderer preserves it verbatim.
    return `\n\n<p data-obsidian-agents-applet="${id}"></p>\n\n`;
  });
  return { content: out, applets };
}

function buildAppletDocument(applet: ParsedApplet, themeVars: Record<string, string>): string {
  const varDecls = Object.entries(themeVars)
    .map(([k, v]) => `  --${k}: ${v};`)
    .join("\n");
  const baseStyles = `
    html, body {
      margin: 0;
      padding: 0;
      background: transparent;
      color: var(--text-normal);
      font-family: var(--font-interface);
      font-size: 14px;
      line-height: 1.5;
    }
    body {
      padding: 10px 12px;
    }
    :root {
${varDecls}
    }
    a { color: var(--interactive-accent); }
    button {
      background: var(--interactive-accent);
      color: var(--text-on-accent);
      border: none;
      border-radius: 6px;
      padding: 6px 12px;
      cursor: pointer;
      font: inherit;
    }
    button:hover { filter: brightness(1.1); }
    input, textarea, select {
      background: var(--background-secondary);
      color: var(--text-normal);
      border: 1px solid var(--background-modifier-border);
      border-radius: 6px;
      padding: 6px 8px;
      font: inherit;
    }
  `;
  if (applet.kind === "react") {
    // Wrap agent code so it always renders. Three patterns are supported:
    //   1. Self-contained: code already calls createRoot(...).render(...) — injected as-is.
    //   2. Component expression: code is a function/arrow (possibly starting with
    //      "() =>" or "function") — assigned to App and rendered automatically.
    //   3. Everything else: wrapped in a fragment and rendered as-is.
    const code = applet.html.trim();
    let scriptBody: string;
    if (/createRoot\s*\(/.test(code)) {
      // Agent already calls createRoot — inject as-is.
      scriptBody = code;
    } else if (/(?:^|\n)\s*(?:const|let|var)\s+App\s*=/.test(code) || /(?:^|\n)\s*function\s+App\s*\(/.test(code)) {
      // Agent already defined App — just mount it.
      scriptBody = `${code}\ncreateRoot(document.getElementById('root')).render(React.createElement(App));`;
    } else if (/^(?:\(|async\s*\()[^)]*\)\s*=>|^function\s*\w*\s*\(/.test(code)) {
      // Bare arrow/function expression — assign to App then mount.
      scriptBody = `const App = ${code};\ncreateRoot(document.getElementById('root')).render(React.createElement(App));`;
    } else {
      // Statement block — run it, then mount App if defined.
      scriptBody = `${code}\nif (typeof App !== 'undefined') createRoot(document.getElementById('root')).render(React.createElement(App));`;
    }
    return `<!doctype html><html><head><meta charset="utf-8">
<style>${baseStyles}</style>
</head><body><div id="root"></div>
<script type="module">
import React from "https://esm.sh/react@18";
import { createRoot } from "https://esm.sh/react-dom@18/client";
${scriptBody}
</script></body></html>`;
  }
  return `<!doctype html><html><head><meta charset="utf-8">
<style>${baseStyles}</style>
</head><body>${applet.html}</body></html>`;
}

function readThemeVars(root: HTMLElement | null): Record<string, string> {
  const keys = [
    "background-primary",
    "background-secondary",
    "background-modifier-border",
    "background-modifier-hover",
    "text-normal",
    "text-muted",
    "text-faint",
    "text-on-accent",
    "interactive-accent",
    "interactive-accent-hover",
    "font-interface",
    "font-monospace",
  ];
  const out: Record<string, string> = {};
  const el = root || document.body;
  const cs = getComputedStyle(el);
  for (const k of keys) {
    const v = cs.getPropertyValue(`--${k}`).trim();
    if (v) out[k] = v;
  }
  return out;
}

function buildAppletFrame(
  srcdoc: string,
  widthOverride?: string,
  heightOverride?: string
): { host: HTMLElement; iframe: HTMLIFrameElement } {
  // Host wrapper provides a positioning context for the hover-expand button.
  const host = document.createElement("div");
  host.className = "obsidian-agents-applet-host";
  host.style.position = "relative";

  const iframe = document.createElement("iframe");
  iframe.className = "obsidian-agents-layout-applet";
  iframe.srcdoc = srcdoc;
  iframe.style.width = widthOverride || "100%";
  iframe.style.border = "none";
  iframe.style.borderRadius = "0";
  iframe.style.background = "transparent";
  iframe.style.display = "block";
  iframe.setAttribute("sandbox", "allow-scripts allow-same-origin allow-forms");

  // Size the iframe to fit its content. If the agent gave an explicit height,
  // honor it; otherwise start small and grow as the body's scroll height
  // reports in. We also install a ResizeObserver inside the iframe document
  // so the height tracks dynamic content (charts, canvas widgets, etc.).
  if (heightOverride) {
    iframe.style.height = heightOverride;
  } else {
    iframe.style.height = "80px";
    const fit = () => {
      try {
        const doc = iframe.contentDocument;
        if (!doc) return;
        // Let the body collapse to its natural height, then measure.
        doc.documentElement.style.height = "auto";
        doc.body.style.height = "auto";
        doc.body.style.margin = "0";
        const h = Math.max(
          doc.body.scrollHeight,
          doc.documentElement.scrollHeight
        );
        if (h > 0) iframe.style.height = `${h}px`;
      } catch {
        /* cross-origin frames will throw — ignore */
      }
    };
    iframe.addEventListener("load", () => {
      fit();
      try {
        const doc = iframe.contentDocument;
        if (!doc) return;
        const ro = new ResizeObserver(() => fit());
        ro.observe(doc.body);
        // A few delayed fits catch late async content (fonts, images, canvas).
        window.setTimeout(fit, 120);
        window.setTimeout(fit, 400);
        window.setTimeout(fit, 1000);
      } catch {
        /* ignore */
      }
    });
  }

  host.appendChild(iframe);

  const expandBtn = document.createElement("button");
  expandBtn.type = "button";
  expandBtn.className = "obsidian-agents-applet-expand-btn";
  expandBtn.setAttribute("aria-label", "Open applet full screen");
  expandBtn.innerHTML =
    '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 3 21 3 21 9"/><polyline points="9 21 3 21 3 15"/><line x1="21" y1="3" x2="14" y2="10"/><line x1="3" y1="21" x2="10" y2="14"/></svg>';
  expandBtn.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    openAppletFullScreen(srcdoc);
  });
  host.appendChild(expandBtn);

  return { host, iframe };
}

function openAppletFullScreen(srcdoc: string): void {
  const overlay = document.createElement("div");
  overlay.className = "obsidian-agents-applet-fullscreen";

  const frame = document.createElement("iframe");
  frame.className = "obsidian-agents-applet-fullscreen-frame";
  frame.srcdoc = srcdoc;
  frame.setAttribute("sandbox", "allow-scripts allow-same-origin allow-forms");

  const close = document.createElement("button");
  close.type = "button";
  close.className = "obsidian-agents-applet-fullscreen-close";
  close.setAttribute("aria-label", "Close full-screen applet");
  close.innerHTML =
    '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>';

  const dismiss = () => {
    overlay.remove();
    document.removeEventListener("keydown", onKey);
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === "Escape") dismiss();
  };
  close.addEventListener("click", dismiss);
  overlay.addEventListener("click", (e) => {
    if (e.target === overlay) dismiss();
  });
  document.addEventListener("keydown", onKey);

  overlay.appendChild(frame);
  overlay.appendChild(close);
  document.body.appendChild(overlay);
}

function mountAppletInto(
  target: HTMLElement,
  applet: ParsedApplet,
  themeVars: Record<string, string>
): void {
  const srcdoc = buildAppletDocument(applet, themeVars);
  const { host } = buildAppletFrame(srcdoc, applet.width, applet.height);

  if (applet.position === "left" || applet.position === "right") {
    const wrap = document.createElement("span");
    wrap.className = `obsidian-agents-layout-block ${positionToClass(applet.position)}`;
    wrap.style.cssFloat = applet.position;
    wrap.style.margin = applet.position === "left" ? "4px 12px 8px 0" : "4px 0 8px 12px";
    wrap.style.maxWidth = applet.width || "50%";
    wrap.style.width = applet.width || "50%";
    wrap.appendChild(host);
    target.replaceWith(wrap);
  } else {
    const wrap = document.createElement("div");
    wrap.className = `obsidian-agents-layout-block ${positionToClass(applet.position)}`;
    wrap.style.margin = "12px 0";
    wrap.appendChild(host);
    target.replaceWith(wrap);
  }
}

export class LayoutEngine {
  static render(
    container: HTMLElement,
    content: string,
    blocks: LayoutBlock[],
    app?: any,
    component?: Component,
    sourcePath = ""
  ): HTMLElement {
    const wrapper = container.createDiv({ cls: "obsidian-agents-layout-engine" });
    const textEl = wrapper.createDiv({ cls: "obsidian-agents-layout-text markdown-rendered" });

    // Extract agent-authored applets from markdown
    const parsed = parseApplets(content);
    // Then extract rich layouts (gallery/carousel/hero/map/card-list) from what remains.
    const rich = parseRichLayouts(parsed.content);
    const themeVars = readThemeVars(container.closest(".obsidian-agents-view") as HTMLElement | null);

    const doRender = async () => {
      if (app && component) {
        try {
          await MarkdownRenderer.render(app, rich.content, textEl, sourcePath, component);
        } catch {
          textEl.setText(rich.content);
        }
      } else {
        textEl.setText(rich.content);
      }
      // Replace applet placeholders
      for (const applet of parsed.applets) {
        const ph = textEl.querySelector(
          `[data-obsidian-agents-applet="${applet.placeholder}"]`
        ) as HTMLElement | null;
        if (ph) mountAppletInto(ph, applet, themeVars);
      }
      // Replace rich-layout placeholders. This must run before
      // activateTermLinks so that any `obsidian-agents-terms` blocks have
      // registered their definitions.
      for (const layout of rich.layouts) {
        const ph = textEl.querySelector(
          `[data-obsidian-agents-rich="${layout.placeholder}"]`
        ) as HTMLElement | null;
        if (ph) mountRichLayout(ph, layout, { app, component, sourcePath });
      }
      // Turn [[Label]]{#slug} inline markers into clickable pills. Safe to
      // run even when the message has no terms block — it's a no-op.
      activateTermLinks(textEl);
      enhanceTables(textEl);
    };
    doRender();

    for (const block of blocks) {
      const blockEl = wrapper.createDiv({ cls: `obsidian-agents-layout-block ${positionToClass(block.position)}` });

      if (block.width) {
        blockEl.style.width = block.width;
      }

      if (block.type === "image") {
        const img = blockEl.createEl("img", { cls: "obsidian-agents-layout-image" });
        img.src = block.content;
        img.style.maxWidth = "100%";
      } else if (block.type === "applet") {
        const { host } = buildAppletFrame(block.content);
        blockEl.appendChild(host);
      } else {
        const blockText = blockEl.createDiv({ cls: "markdown-rendered" });
        if (app && component) {
          MarkdownRenderer.render(app, block.content, blockText, sourcePath, component)
            .then(() => enhanceTables(blockText))
            .catch(() => {
              blockText.setText(block.content);
            });
        } else {
          blockText.setText(block.content);
        }
      }

      switch (block.position) {
        case "left":
        case "right":
          blockEl.style.float = block.position;
          blockEl.style.margin = "8px";
          blockEl.style.maxWidth = "50%";
          break;
        case "above":
          wrapper.insertBefore(blockEl, textEl);
          continue;
        case "below":
          wrapper.appendChild(blockEl);
          continue;
        case "inline":
        default:
          textEl.appendChild(blockEl);
          continue;
      }

      textEl.appendChild(blockEl);
    }

    const clearfix = wrapper.createDiv();
    clearfix.style.clear = "both";

    return wrapper;
  }
}
