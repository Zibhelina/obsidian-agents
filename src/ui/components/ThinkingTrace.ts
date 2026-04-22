import { Component, setIcon } from "obsidian";
import { MessageMetadata, ToolCall } from "../../types";

/**
 * Modern ChatGPT-style thinking trace.
 *
 * The message bubble only shows a subtle "Thought for 1m 13s >" line. Clicking
 * it opens a right-side drawer (shared across messages — reused, not stacked)
 * that displays the full reasoning trace. Close the drawer with the X or by
 * clicking outside.
 */
export class ThinkingTrace extends Component {
  containerEl: HTMLElement;
  private headerEl!: HTMLElement;
  private labelEl!: HTMLElement;
  private caretEl!: HTMLElement;
  private metadata: MessageMetadata;
  private thinking: string;
  private streaming: boolean;
  private streamStart: number;

  constructor(
    container: HTMLElement,
    metadata: MessageMetadata,
    thinking: string,
    streaming: boolean,
    streamStart: number
  ) {
    super();
    this.metadata = metadata;
    this.thinking = thinking;
    this.streaming = streaming;
    this.streamStart = streamStart;
    this.containerEl = container.createDiv({ cls: "obsidian-agents-thinking-trace" });
    this.build();
  }

  private build(): void {
    this.headerEl = this.containerEl.createDiv({
      cls: "obsidian-agents-thinking-pill",
      attr: { role: "button", tabindex: "0" },
    });

    this.labelEl = this.headerEl.createSpan({ cls: "obsidian-agents-thinking-label" });
    this.caretEl = this.headerEl.createSpan({ cls: "obsidian-agents-thinking-caret" });
    setIcon(this.caretEl, "chevron-right");

    this.renderLabel();

    const open = () => this.openDrawer();
    this.registerDomEvent(this.headerEl, "click", open);
    this.registerDomEvent(this.headerEl, "keydown", (evt: KeyboardEvent) => {
      if (evt.key === "Enter" || evt.key === " ") {
        evt.preventDefault();
        open();
      }
    });
  }

  private renderLabel(): void {
    // While streaming we show a live "Thinking..." + elapsed timer.
    // Once done we show "Thought for 1m 13s" — matching the ChatGPT pattern.
    const elapsedMs = this.streaming
      ? Date.now() - this.streamStart
      : this.metadata.durationMs;

    const timeText = elapsedMs != null ? this.formatDuration(elapsedMs) : null;
    const toolCount = this.metadata.toolCalls?.length ?? 0;
    const toolSuffix = toolCount > 0
      ? ` · ${toolCount} tool${toolCount > 1 ? "s" : ""}`
      : "";

    if (this.streaming) {
      const base = timeText ? `Thinking ${timeText}` : "Thinking…";
      this.labelEl.setText(base + toolSuffix);
      this.headerEl.addClass("obsidian-agents-thinking-pill-streaming");
    } else {
      this.headerEl.removeClass("obsidian-agents-thinking-pill-streaming");
      const base = timeText ? `Thought for ${timeText}` : "Reasoning";
      this.labelEl.setText(base + toolSuffix);
    }
  }

  private formatDuration(ms: number): string {
    const s = ms / 1000;
    if (s < 60) return `${s.toFixed(1)}s`;
    const m = Math.floor(s / 60);
    const rem = Math.round(s - m * 60);
    return rem > 0 ? `${m}m ${rem}s` : `${m}m`;
  }

  private openDrawer(): void {
    // Host the drawer inside the chat view so it participates in the flex
    // layout (split view) rather than floating above the chat.
    const viewRoot = this.containerEl.closest(".obsidian-agents-view") as HTMLElement | null;
    const host: HTMLElement = viewRoot ?? document.body;

    // One drawer at a time — reuse any existing instance and swap contents.
    const existing = host.querySelector(":scope > .obsidian-agents-thinking-drawer");
    if (existing) existing.remove();

    const drawer = host.createDiv({ cls: "obsidian-agents-thinking-drawer" });

    // Resize handle on the left edge. Dragging past the snap threshold makes
    // the drawer fill the entire view (chat hidden).
    const resizer = drawer.createDiv({ cls: "obsidian-agents-thinking-drawer-resizer" });
    this.wireResizer(resizer, drawer, host);

    const header = drawer.createDiv({ cls: "obsidian-agents-thinking-drawer-header" });

    const title = header.createDiv({ cls: "obsidian-agents-thinking-drawer-title" });
    title.setText("Activity");

    const elapsedMs = this.streaming
      ? Date.now() - this.streamStart
      : this.metadata.durationMs;
    if (elapsedMs != null) {
      const dot = header.createSpan({ cls: "obsidian-agents-thinking-drawer-sep", text: "·" });
      void dot;
      const time = header.createDiv({ cls: "obsidian-agents-thinking-drawer-time" });
      time.setText(this.formatDuration(elapsedMs));
    }

    const meta = header.createDiv({ cls: "obsidian-agents-thinking-drawer-meta" });
    const parts: string[] = [];
    if (this.metadata.model) parts.push(this.metadata.model);
    if (this.metadata.tokensUsed != null) {
      const used = this.metadata.tokensUsed;
      const usedStr = used >= 1000 ? `${(used / 1000).toFixed(1)}k` : `${used}`;
      parts.push(`${usedStr} tokens`);
    }
    meta.setText(parts.join(" · "));

    const closeBtn = header.createEl("button", {
      cls: "obsidian-agents-thinking-drawer-close",
      attr: { "aria-label": "Close" },
    });
    closeBtn.innerHTML =
      '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>';

    const body = drawer.createDiv({ cls: "obsidian-agents-thinking-drawer-body" });
    const toolCalls = this.metadata.toolCalls ?? [];

    if (toolCalls.length === 0 && !this.thinking) {
      body.createDiv({
        cls: "obsidian-agents-thinking-empty",
        text: "No reasoning was emitted for this message.",
      });
    } else {
      body.createDiv({
        cls: "obsidian-agents-thinking-drawer-section-heading",
        text: "Thinking",
      });
      const timeline = body.createDiv({ cls: "obsidian-agents-thinking-timeline" });

      // Interleave reasoning paragraphs (dot rows) with tool calls (icon rows),
      // mirroring the ChatGPT Activity panel pattern.
      const reasoningChunks = this.splitReasoning(this.thinking);
      const toolCount = toolCalls.length;
      const chunkCount = reasoningChunks.length;
      const total = Math.max(toolCount, chunkCount);

      // Alternate: reasoning chunk, then tool call, repeating. This is a heuristic
      // since the upstream gateway doesn't interleave the streams — best we can do
      // without per-event timestamps is show them paired.
      for (let i = 0; i < total; i++) {
        if (i < chunkCount && reasoningChunks[i]) {
          this.renderReasoningRow(timeline, reasoningChunks[i]);
        }
        if (i < toolCount) {
          this.renderToolRow(timeline, toolCalls[i]);
        }
      }
    }

    const dismiss = () => {
      drawer.remove();
      document.removeEventListener("keydown", onKey);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") dismiss();
    };
    closeBtn.addEventListener("click", dismiss);
    document.addEventListener("keydown", onKey);
  }

  private wireResizer(
    resizer: HTMLElement,
    drawer: HTMLElement,
    host: HTMLElement
  ): void {
    // Resize constraints:
    // - drawer has its own MIN_WIDTH floor
    // - chat has a MIN_CHAT_WIDTH floor; once dragging would make the chat
    //   narrower than that, the drawer snaps to fullscreen. Dragging back
    //   below the snap boundary returns to split view.
    const MIN_WIDTH = 320;
    const MIN_CHAT_WIDTH = 400;

    let dragging = false;

    const onDown = (e: PointerEvent) => {
      dragging = true;
      resizer.setPointerCapture(e.pointerId);
      document.body.classList.add("obsidian-agents-col-resizing");
      e.preventDefault();
    };

    const onMove = (e: PointerEvent) => {
      if (!dragging) return;
      const hostRect = host.getBoundingClientRect();
      const rawWidth = hostRect.right - e.clientX;
      const hostWidth = hostRect.width;
      const snapBoundary = hostWidth - MIN_CHAT_WIDTH;

      if (rawWidth >= snapBoundary) {
        drawer.classList.add("obsidian-agents-thinking-drawer-fullscreen");
        drawer.style.width = "";
      } else {
        drawer.classList.remove("obsidian-agents-thinking-drawer-fullscreen");
        const clamped = Math.max(MIN_WIDTH, rawWidth);
        drawer.style.width = `${clamped}px`;
      }
    };

    const onUp = (e: PointerEvent) => {
      if (!dragging) return;
      dragging = false;
      try { resizer.releasePointerCapture(e.pointerId); } catch { /* no-op */ }
      document.body.classList.remove("obsidian-agents-col-resizing");
    };

    resizer.addEventListener("pointerdown", onDown);
    resizer.addEventListener("pointermove", onMove);
    resizer.addEventListener("pointerup", onUp);
    resizer.addEventListener("pointercancel", onUp);
  }

  private splitReasoning(thinking: string): string[] {
    if (!thinking) return [];
    // Split on double-newline paragraphs; drop empties.
    return thinking
      .split(/\n{2,}/)
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
  }

  private renderReasoningRow(host: HTMLElement, text: string): void {
    const row = host.createDiv({ cls: "obsidian-agents-thinking-tl-row obsidian-agents-thinking-tl-reason" });
    row.createDiv({ cls: "obsidian-agents-thinking-tl-bullet obsidian-agents-thinking-tl-bullet-dot" });
    const body = row.createDiv({ cls: "obsidian-agents-thinking-tl-body" });
    const p = body.createEl("p", { cls: "obsidian-agents-thinking-tl-text" });
    p.setText(text);
  }

  private renderToolRow(host: HTMLElement, call: ToolCall): void {
    const row = host.createDiv({
      cls: `obsidian-agents-thinking-tl-row obsidian-agents-thinking-tl-tool obsidian-agents-thinking-tl-tool-${call.status}`,
    });
    const bullet = row.createDiv({ cls: "obsidian-agents-thinking-tl-bullet obsidian-agents-thinking-tl-bullet-icon" });
    const icon = (call.arguments?.emoji as string) || "⚙";
    bullet.setText(icon);

    const body = row.createDiv({ cls: "obsidian-agents-thinking-tl-body" });
    const rawLabel = (call.arguments?.label as string) || "";
    const name = call.name.replace(/_/g, " ");
    const title = rawLabel && rawLabel !== call.name ? rawLabel : name;
    const titleEl = body.createDiv({ cls: "obsidian-agents-thinking-tl-title" });
    titleEl.setText(title);

    // Surface any URL arguments as site chips (github.com, etc).
    const urls = this.extractUrls(call.arguments);
    if (urls.length > 0) {
      const chips = body.createDiv({ cls: "obsidian-agents-thinking-tl-chips" });
      for (const url of urls) {
        const chip = chips.createEl("a", { cls: "obsidian-agents-thinking-tl-chip" });
        chip.href = url;
        chip.target = "_blank";
        chip.rel = "noopener noreferrer";
        chip.setText(this.hostnameOf(url));
      }
    }
  }

  private extractUrls(args: Record<string, unknown> | undefined): string[] {
    if (!args) return [];
    const out: string[] = [];
    const visit = (v: unknown) => {
      if (typeof v === "string" && /^https?:\/\//i.test(v)) {
        out.push(v);
      } else if (Array.isArray(v)) {
        v.forEach(visit);
      } else if (v && typeof v === "object") {
        Object.values(v).forEach(visit);
      }
    };
    for (const [k, v] of Object.entries(args)) {
      if (k === "emoji" || k === "label") continue;
      visit(v);
    }
    // De-dupe preserving order, cap to 4 chips.
    return Array.from(new Set(out)).slice(0, 4);
  }

  private hostnameOf(url: string): string {
    try {
      return new URL(url).hostname.replace(/^www\./, "");
    } catch {
      return url;
    }
  }

  update(metadata: MessageMetadata, thinking: string, streaming: boolean): void {
    this.metadata = metadata;
    this.thinking = thinking;
    this.streaming = streaming;
    this.renderLabel();
  }


  /** Called every tick while streaming to update elapsed time. */
  tickElapsed(): void {
    if (this.streaming) this.renderLabel();
  }
}
