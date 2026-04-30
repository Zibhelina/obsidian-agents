import { Component, Notice, setIcon } from "obsidian";
import { ChatMessage, LayoutBlock } from "../../types";
import { ThinkingTrace } from "./ThinkingTrace";
import { LayoutEngine } from "./LayoutEngine";
import { getSkill } from "../../features/commands";

export class MessageBubble extends Component {
  private wrapper: HTMLElement;
  private bubble: HTMLElement;
  private message: ChatMessage;
  private plugin: any;
  private streamingEl: HTMLElement | null = null;
  private contentEl: HTMLElement | null = null;
  private trace: ThinkingTrace | null = null;
  private traceTickerId: number | null = null;
  private streamStart = Date.now();
  private isStreaming = false;

  constructor(container: HTMLElement, message: ChatMessage, plugin: any) {
    super();
    this.message = message;
    this.plugin = plugin;

    this.wrapper = container.createDiv({
      cls: `obsidian-agents-message-wrapper ${
        message.role === "user" ? "obsidian-agents-message-wrapper-user" : "obsidian-agents-message-wrapper-agent"
      }`,
    });

    this.bubble = this.wrapper.createDiv({
      cls: `obsidian-agents-message-bubble ${
        message.role === "user" ? "obsidian-agents-message-bubble-user" : "obsidian-agents-message-bubble-agent"
      }`,
    });

    this.render();
  }

  private render(): void {
    // Full wrapper rebuild — prior attempts stacked duplicate trace panels and
    // action rows on every streaming token because we only cleared the bubble.
    this.wrapper.empty();
    this.trace = null;

    const isUser = this.message.role === "user";

    // Trace panel (above the content, for agent messages).
    if (!isUser) {
      const meta = this.message.metadata || {};
      const thinking = meta.thinking || "";
      const traceHost = this.wrapper.createDiv();
      this.trace = new ThinkingTrace(
        traceHost,
        meta,
        thinking,
        this.isStreaming,
        this.streamStart
      );
      this.addChild(this.trace);
    }

    // If slash skills were active on a user message, render a chip row
    // OUTSIDE the bubble (right above it) so the chips aren't crammed
    // inside the same pill as the text.
    if (isUser) {
      const skillIds = this.message.skillIds ?? [];
      if (skillIds.length > 0) {
        const chipRow = this.wrapper.createDiv({
          cls: "obsidian-agents-message-skill-chips",
        });
        for (const id of skillIds) {
          const skill = getSkill(id);
          const chip = chipRow.createSpan({
            cls: "obsidian-agents-message-skill-chip",
            attr: skill ? { title: skill.description } : {},
          });
          const iconEl = chip.createSpan({ cls: "obsidian-agents-message-skill-chip-icon" });
          setIcon(iconEl, skill?.icon ?? "sparkles");
          chip.createSpan({
            cls: "obsidian-agents-message-skill-chip-label",
            text: skill?.label ?? id.replace(/^\//, ""),
          });
        }
      }

      // Mention chips — parse @[name](path) tokens from the stored content
      // and surface them as pill chips above the bubble, matching the
      // composer chip styling so the user can verify what they attached.
      const mentions = this.parseMentions(this.message.content);
      if (mentions.length > 0) {
        const chipRow = this.wrapper.createDiv({
          cls: "obsidian-agents-mention-chips obsidian-agents-message-mention-chips",
        });
        for (const m of mentions) {
          const chip = chipRow.createDiv({ cls: "obsidian-agents-mention-chip" });
          const iconEl = chip.createSpan({ cls: "obsidian-agents-mention-chip-icon" });
          setIcon(iconEl, "file-text");
          chip.createSpan({
            cls: "obsidian-agents-mention-chip-label",
            text: m.name,
            attr: { title: m.path },
          });
        }
      }
    }

    // Recreate bubble
    this.bubble = this.wrapper.createDiv({
      cls: `obsidian-agents-message-bubble ${
        isUser ? "obsidian-agents-message-bubble-user" : "obsidian-agents-message-bubble-agent"
      }`,
    });

    // Tool calls are displayed in the Thinking drawer only (ChatGPT-style
    // Activity panel). Keeping them inline was double-surfacing the same
    // information, so the bubble now only carries the visible reply.
    this.contentEl = this.bubble.createDiv();

    if (isUser) {
      // Strip @[name](path) mention tokens — show only the user's prose.
      const displayText = this.message.content
        .replace(/@\[[^\]]*\]\([^)]*\)/g, "")
        .trim();
      LayoutEngine.render(
        this.contentEl,
        displayText || this.message.content,
        [],
        this.plugin.app,
        this,
        ""
      );
    } else {
      const blocks: LayoutBlock[] = [];
      if (this.message.attachments) {
        for (const att of this.message.attachments) {
          blocks.push({
            type: att.type === "image" ? "image" : "applet",
            content: att.dataUrl || att.path,
            position: "below",
          });
        }
      }
      LayoutEngine.render(
        this.contentEl,
        this.message.content,
        blocks,
        this.plugin.app,
        this,
        ""
      );
    }

    // User attachments rendered ABOVE the bubble, outside of it.
    if (isUser && this.message.attachments?.length) {
      const images = this.message.attachments.filter((a) => a.type === "image" && a.dataUrl);
      const files = this.message.attachments.filter((a) => a.type !== "image" || !a.dataUrl);

      if (images.length > 0) {
        const imgContainer = document.createElement("div");
        imgContainer.className = "obsidian-agents-user-attachments obsidian-agents-user-attachments-images";
        // Insert before the bubble so images sit above the text bubble
        this.wrapper.insertBefore(imgContainer, this.bubble);

        for (const att of images) {
          const img = imgContainer.createEl("img", { cls: "obsidian-agents-user-attachment-img" });
          img.src = att.dataUrl!;
          img.alt = att.name;
          img.style.cursor = "zoom-in";
          img.addEventListener("click", () => this.openLightbox(att.dataUrl!, att.name));
        }
      }

      if (files.length > 0) {
        // Non-image files still sit inside/below the bubble text
        const fileContainer = this.bubble.createDiv({ cls: "obsidian-agents-user-attachments" });
        for (const att of files) {
          const fileEl = fileContainer.createDiv({ cls: "obsidian-agents-user-attachment-file" });
          fileEl.setText(`📄 ${att.name}`);
        }
      }
    }

    // Re-attach the streaming indicator if we're still streaming
    if (this.isStreaming) {
      this.streamingEl = this.bubble.createDiv({ cls: "obsidian-agents-streaming-indicator" });
      this.streamingEl.createDiv({ cls: "obsidian-agents-streaming-dot" });
      this.streamingEl.createDiv({ cls: "obsidian-agents-streaming-dot" });
      this.streamingEl.createDiv({ cls: "obsidian-agents-streaming-dot" });
    } else {
      this.streamingEl = null;
    }

    // Message action row (copy / reply) shown under the bubble on hover.
    // Hide during streaming so we don't clutter the placeholder.
    if (!this.isStreaming) {
      this.renderActions();
    }
  }

  private renderActions(): void {
    const row = this.wrapper.createDiv({ cls: "obsidian-agents-message-actions" });
    const copyBtn = row.createEl("button", {
      cls: "obsidian-agents-message-action-btn",
      attr: { "aria-label": "Copy" },
    });
    setIcon(copyBtn, "copy");
    copyBtn.addEventListener("click", async (e) => {
      e.preventDefault();
      e.stopPropagation();
      try {
        await navigator.clipboard.writeText(this.message.content);
        new Notice("Copied");
      } catch {
        new Notice("Copy failed");
      }
    });

    if (this.message.role === "agent") {
      const replyBtn = row.createEl("button", {
        cls: "obsidian-agents-message-action-btn",
        attr: { "aria-label": "Reply" },
      });
      setIcon(replyBtn, "reply");
      replyBtn.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        const sel = window.getSelection()?.toString().trim();
        const quote = sel || this.message.content;
        this.wrapper.dispatchEvent(
          new CustomEvent("obsidian-agents:reply", { detail: quote, bubbles: true })
        );
      });
    }
  }

  private parseMentions(content: string): { name: string; path: string }[] {
    const out: { name: string; path: string }[] = [];
    const seen = new Set<string>();
    const re = /@\[([^\]]*)\]\(([^)]*)\)/g;
    let match: RegExpExecArray | null;
    while ((match = re.exec(content)) !== null) {
      const path = match[2];
      if (seen.has(path)) continue;
      seen.add(path);
      out.push({ name: match[1] || path, path });
    }
    return out;
  }

  private openLightbox(src: string, name: string): void {
    const overlay = document.body.createDiv({ cls: "obsidian-agents-lightbox" });
    overlay.setAttribute("role", "dialog");
    overlay.setAttribute("aria-label", `Preview ${name}`);
    const img = overlay.createEl("img", { cls: "obsidian-agents-lightbox-img" });
    img.src = src;
    img.alt = name;
    const close = overlay.createEl("button", {
      cls: "obsidian-agents-lightbox-close",
      attr: { "aria-label": "Close preview" },
    });
    setIcon(close, "x");

    const dismiss = () => {
      overlay.remove();
      document.removeEventListener("keydown", onKey);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") dismiss();
    };
    overlay.addEventListener("click", (e) => {
      if (e.target === overlay || (e.target as HTMLElement).closest(".obsidian-agents-lightbox-close")) {
        dismiss();
      }
    });
    document.addEventListener("keydown", onKey);
  }

  update(message: ChatMessage): void {
    this.message = message;
    this.render();
  }

  getId(): string {
    return this.message.id;
  }

  getMessage(): ChatMessage {
    return this.message;
  }

  setMessage(msg: ChatMessage): void {
    this.message = msg;
    this.render();
  }

  setStreaming(isStreaming: boolean, knownStartTime?: number): void {
    const changed = this.isStreaming !== isStreaming;
    this.isStreaming = isStreaming;
    if (isStreaming) {
      // If a known start time is provided (e.g. when reconstructing after a
      // session switch) use it; otherwise fall back to the message timestamp
      // so the timer doesn't reset to zero on navigation.
      this.streamStart = knownStartTime ?? this.message.timestamp ?? Date.now();
      if (changed) {
        this.render();
        this.startTicker();
        this.wrapper.scrollIntoView({ behavior: "smooth", block: "end" });
      }
    } else {
      this.stopTicker();
      if (changed) this.render();
    }
  }

  private startTicker(): void {
    this.stopTicker();
    this.traceTickerId = window.setInterval(() => {
      this.trace?.tickElapsed();
    }, 500);
  }

  private stopTicker(): void {
    if (this.traceTickerId != null) {
      window.clearInterval(this.traceTickerId);
      this.traceTickerId = null;
    }
  }

  onunload(): void {
    this.stopTicker();
  }

  detach(): void {
    this.wrapper.remove();
  }

  updateMeta(): void {
    // Called after metadata/thinking updates — re-render trace panel
    this.render();
  }
}
