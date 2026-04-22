import { App, Component, setIcon } from "obsidian";
import { Attachment, MentionItem } from "../../types";
import { MentionPopover, TextInputLike } from "./MentionPopover";
import { getSkillRegistry } from "../../features/commands";
import type { Skill } from "../../skills";
import { generateId } from "../../lib/id";
import { LivePreviewEditor } from "./LivePreviewEditor";

const EXPAND_THRESHOLD = 80;

/**
 * Composer: attach + reply quote + mention chips + CM6 live-preview editor + send.
 *
 * The text input is a CodeMirror 6 editor configured to render markdown
 * (headings, bold/italic, code fences, inline code, blockquote, lists) in
 * place on any line the cursor isn't currently on — a pragmatic clone of
 * Obsidian's native Live Preview for use inside a composer.
 */
export class Composer extends Component {
  containerEl: HTMLElement;
  private editor: LivePreviewEditor;
  private chipsEl: HTMLElement;
  private quoteEl: HTMLElement;
  private attachmentsEl: HTMLElement;
  private attachments: Attachment[] = [];
  private mentions: MentionItem[] = [];
  private replyQuote: string | null = null;
  private onSend: (text: string, attachments: Attachment[], skillId?: string | null) => void;
  private onAbort: (() => void) | null = null;
  private streaming = false;
  private mentionPopover: MentionPopover | null = null;
  private commandPopoverEl: HTMLElement | null = null;
  private commandQuery = "";
  private commandStartIndex = -1;
  private commandItems: Skill[] = [];
  private commandSelectedIndex = 0;
  private activeSkill: Skill | null = null;
  private skillPillEl: HTMLElement | null = null;
  private editorHostEl: HTMLElement | null = null;
  private skills = getSkillRegistry();
  private sendBtn: HTMLButtonElement;
  private expandBtn: HTMLButtonElement;
  private expanded = false;
  private app: App | null = null;

  // Event subscribers registered via the TextInputLike adapter.
  private inputListeners = new Set<() => void>();
  private keydownListeners = new Set<(e: KeyboardEvent) => void>();

  constructor(
    container: HTMLElement,
    onSend: (text: string, attachments: Attachment[], skillId?: string | null) => void,
    onAbort?: () => void
  ) {
    super();
    this.onSend = onSend;
    this.onAbort = onAbort ?? null;

    this.containerEl = container.createDiv({ cls: "obsidian-agents-composer" });

    this.attachmentsEl = this.containerEl.createDiv({ cls: "obsidian-agents-attachment-list" });
    this.attachmentsEl.style.display = "none";

    const inputWrap = this.containerEl.createDiv({ cls: "obsidian-agents-composer-input-wrap" });

    this.quoteEl = inputWrap.createDiv({ cls: "obsidian-agents-reply-quote" });
    this.quoteEl.style.display = "none";

    this.chipsEl = inputWrap.createDiv({ cls: "obsidian-agents-mention-chips" });
    this.chipsEl.style.display = "none";

    const inputRow = inputWrap.createDiv({ cls: "obsidian-agents-composer-input-row" });

    const attachBtn = inputRow.createEl("button", {
      cls: "obsidian-agents-composer-attach-btn",
      attr: { "aria-label": "Attach file" },
    });
    setIcon(attachBtn, "plus");
    this.registerDomEvent(attachBtn, "click", () => {
      const input = document.createElement("input");
      input.type = "file";
      input.multiple = true;
      input.onchange = () => {
        const files = input.files;
        if (!files) return;
        for (const f of Array.from(files)) this.handleFile(f);
      };
      input.click();
    });

    const editorHost = inputRow.createDiv({ cls: "obsidian-agents-composer-editor-host" });
    this.editorHostEl = editorHost;

    // Skill pill slot — lives inside the editor host, absolutely positioned
    // at its top-left. Active state drives a first-line text-indent on CM6
    // so the prompt flows around the pill like regular inline text. Empty
    // by default.
    this.skillPillEl = editorHost.createDiv({ cls: "obsidian-agents-composer-skill-pill-slot" });
    this.skillPillEl.style.display = "none";

    this.editor = new LivePreviewEditor(editorHost, {
      placeholder: "Ask anything",
      onChange: () => {
        this.autoResize();
        this.handleInput();
        this.updateSendButton();
        this.fireInput();
        // Direct call — guaranteed to fire even if the Set adapter has issues.
        this.mentionPopover?.onEditorChange();
      },
      onSubmit: () => this.send(),
      onKeyDown: (evt) => this.handleEditorKeyDown(evt),
      onPaste: (evt) => this.handlePaste(evt),
    });

    this.sendBtn = inputRow.createEl("button", {
      cls: "obsidian-agents-composer-send-btn",
      attr: { "aria-label": "Send message" },
    });
    setIcon(this.sendBtn, "arrow-up");
    this.updateSendButton();

    this.expandBtn = inputWrap.createEl("button", {
      cls: "obsidian-agents-composer-expand-btn",
      attr: { "aria-label": "Expand editor" },
    });
    this.renderExpandIcon(false);
    this.expandBtn.style.display = "none";
    this.registerDomEvent(this.expandBtn, "click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      this.setExpanded(!this.expanded);
    });

    this.registerDomEvent(this.sendBtn, "click", () => {
      if (this.streaming) {
        this.onAbort?.();
      } else {
        this.send();
      }
    });
  }

  setStreaming(streaming: boolean): void {
    this.streaming = streaming;
    this.updateSendButton();
  }

  private renderExpandIcon(expanded: boolean): void {
    // Use an inline SVG so the icon renders reliably regardless of whether
    // Obsidian's lucide sprite is loaded. Matches the "dot" bug where
    // setIcon would sometimes leave a zero-sized svg behind.
    const maximize =
      '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 3 21 3 21 9"/><polyline points="9 21 3 21 3 15"/><line x1="21" y1="3" x2="14" y2="10"/><line x1="3" y1="21" x2="10" y2="14"/></svg>';
    const close =
      '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>';
    this.expandBtn.innerHTML = expanded ? close : maximize;
  }

  setApp(app: App): void {
    this.app = app;
    void this.app;
  }

  /**
   * Adapter that exposes a textarea-like surface over the CM6 editor so
   * MentionPopover can attach to it unchanged.
   */
  getTextInput(): TextInputLike {
    const self = this;
    return {
      getValue: () => self.editor.getValue(),
      setValue: (v) => self.editor.setValue(v),
      getCursor: () => self.editor.getCursor(),
      setCursor: (p) => self.editor.setCursor(p),
      replaceRange: (from, to, insert) => self.editor.replaceRange(from, to, insert),
      focus: () => self.editor.focus(),
      addEventListener: (type, handler, _opts) => {
        if (type === "input" || type === "keyup" || type === "click") {
          self.inputListeners.add(handler as () => void);
        } else if (type === "keydown") {
          self.keydownListeners.add(handler as (e: KeyboardEvent) => void);
        }
      },
      removeEventListener: (type, handler, _opts) => {
        if (type === "input" || type === "keyup" || type === "click") {
          self.inputListeners.delete(handler as () => void);
        } else if (type === "keydown") {
          self.keydownListeners.delete(handler as (e: KeyboardEvent) => void);
        }
      },
    };
  }

  private fireInput(): void {
    for (const fn of this.inputListeners) fn();
  }

  private handleEditorKeyDown(evt: KeyboardEvent): boolean {
    // Command popover gets priority.
    if (this.commandPopoverEl && this.commandPopoverEl.style.display !== "none") {
      if (evt.key === "ArrowDown") {
        this.commandSelectedIndex = (this.commandSelectedIndex + 1) % this.commandItems.length;
        this.renderCommandItems();
        return true;
      } else if (evt.key === "ArrowUp") {
        this.commandSelectedIndex =
          (this.commandSelectedIndex - 1 + this.commandItems.length) % this.commandItems.length;
        this.renderCommandItems();
        return true;
      } else if (evt.key === "Enter" || evt.key === "Tab") {
        this.selectCommand(this.commandItems[this.commandSelectedIndex]);
        return true;
      } else if (evt.key === "Escape") {
        this.hideCommandPopover();
        return true;
      }
    }

    // Forward to mention popover listeners (capture phase).
    for (const fn of this.keydownListeners) fn(evt);
    if (evt.defaultPrevented) return true;

    if (evt.key === "Backspace") {
      const cursor = this.editor.getCursor();
      const sel = this.editor.getSelectionRange();
      const atStart = cursor === 0 && sel.from === 0 && sel.to === 0;
      if (atStart) {
        // Backspace at position 0 peels off items in visual order:
        // mention chips first (right of pill), then the skill pill.
        if (this.mentions.length > 0) {
          this.mentions.pop();
          this.renderChips();
          return true;
        }
        if (this.activeSkill) {
          this.clearSkill();
          return true;
        }
      }
    }
    return false;
  }

  private handlePaste(evt: ClipboardEvent): void {
    const items = evt.clipboardData?.items;
    if (!items) return;
    for (const item of Array.from(items)) {
      if (item.kind === "file") {
        const file = item.getAsFile();
        if (file) this.handleFile(file);
      }
    }
  }

  setMentionPopover(popover: MentionPopover): void {
    this.mentionPopover = popover;
    const inputWrap = this.containerEl.querySelector(
      ".obsidian-agents-composer-input-wrap"
    ) as HTMLElement;
    if (inputWrap) {
      this.mentionPopover.mount(inputWrap, this.getTextInput(), (item) =>
        this.addMention(item)
      );
    }
  }

  setReplyQuote(quote: string): void {
    this.replyQuote = quote.trim();
    this.renderQuote();
    this.editor.focus();
    this.updateSendButton();
  }

  private renderQuote(): void {
    this.quoteEl.empty();
    if (!this.replyQuote) {
      this.quoteEl.style.display = "none";
      return;
    }
    this.quoteEl.style.display = "flex";

    const bar = this.quoteEl.createDiv({ cls: "obsidian-agents-reply-quote-bar" });
    bar.setText("");

    const body = this.quoteEl.createDiv({ cls: "obsidian-agents-reply-quote-body" });
    const label = body.createDiv({ cls: "obsidian-agents-reply-quote-label" });
    label.setText("Replying to");
    const snippet = body.createDiv({ cls: "obsidian-agents-reply-quote-text" });
    const preview =
      this.replyQuote.length > 200 ? this.replyQuote.slice(0, 200) + "…" : this.replyQuote;
    snippet.setText(preview);

    const close = this.quoteEl.createEl("button", {
      cls: "obsidian-agents-reply-quote-remove",
      attr: { "aria-label": "Cancel reply" },
    });
    setIcon(close, "x");
    close.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      this.replyQuote = null;
      this.renderQuote();
      this.updateSendButton();
      this.editor.focus();
    });
  }

  private addMention(item: MentionItem): void {
    if (!this.mentions.some((m) => m.path === item.path)) {
      this.mentions.push(item);
      this.renderChips();
    }
    this.editor.focus();
    this.autoResize();
    this.updateSendButton();
  }

  private renderChips(): void {
    this.chipsEl.empty();
    if (this.mentions.length === 0) {
      this.chipsEl.style.display = "none";
      return;
    }
    this.chipsEl.style.display = "flex";
    for (const m of this.mentions) {
      const chip = this.chipsEl.createDiv({ cls: "obsidian-agents-mention-chip" });
      const icon = chip.createSpan({ cls: "obsidian-agents-mention-chip-icon" });
      setIcon(icon, m.type === "folder" ? "folder" : "file-text");
      chip.createSpan({ cls: "obsidian-agents-mention-chip-label", text: m.displayName });
      const remove = chip.createEl("button", {
        cls: "obsidian-agents-mention-chip-remove",
        attr: { "aria-label": `Remove ${m.displayName}` },
      });
      setIcon(remove, "x");
      remove.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        this.mentions = this.mentions.filter((x) => x.path !== m.path);
        this.renderChips();
        this.updateSendButton();
        this.editor.focus();
      });
    }
  }

  private autoResize(): void {
    const value = this.editor.getValue();
    const multiLine = value.includes("\n");
    const showExpand =
      this.expanded || multiLine || value.length >= EXPAND_THRESHOLD;
    this.expandBtn.style.display = showExpand ? "inline-flex" : "none";
  }

  setExpanded(expanded: boolean): void {
    this.expanded = expanded;
    this.containerEl.toggleClass("obsidian-agents-composer-expanded", expanded);
    this.renderExpandIcon(expanded);
    this.expandBtn.setAttribute(
      "aria-label",
      expanded ? "Close expanded editor" : "Expand editor"
    );
    this.autoResize();
    this.containerEl.dispatchEvent(
      new CustomEvent("obsidian-agents:composer-expanded", {
        detail: expanded,
        bubbles: true,
      })
    );
    if (expanded) this.editor.focus();
  }

  private updateSendButton(): void {
    if (this.streaming) {
      setIcon(this.sendBtn, "square");
      this.sendBtn.setAttribute("aria-label", "Stop generation");
      this.sendBtn.classList.add("obsidian-agents-composer-send-btn-stop");
      this.sendBtn.disabled = false;
      return;
    }
    this.sendBtn.classList.remove("obsidian-agents-composer-send-btn-stop");
    setIcon(this.sendBtn, "arrow-up");
    this.sendBtn.setAttribute("aria-label", "Send message");
    const hasContent =
      this.editor.getValue().trim().length > 0 ||
      this.attachments.length > 0 ||
      this.mentions.length > 0 ||
      this.replyQuote != null;
    this.sendBtn.disabled = !hasContent;
  }

  private handleInput(): void {
    // One skill at a time — don't try to stack commands. If a skill is
    // already active, typing "/" just enters literal text.
    if (this.activeSkill) {
      this.hideCommandPopover();
      return;
    }

    const cursor = this.editor.getCursor();
    const text = this.editor.getValue();
    const beforeCursor = text.slice(0, cursor);

    // Only trigger at the very start of the composer (position 0) — matches
    // the screenshot UX where the slash command becomes a pill at the head
    // of the input, not mid-sentence.
    if (beforeCursor.startsWith("/") && !beforeCursor.includes(" ") && !beforeCursor.includes("\n")) {
      this.commandQuery = beforeCursor.slice(1);
      this.commandStartIndex = 0;
      this.commandItems = this.skills.filter(this.commandQuery);
      this.commandSelectedIndex = 0;
      this.showCommandPopover();
    } else {
      this.hideCommandPopover();
    }
  }

  private showCommandPopover(): void {
    if (!this.commandPopoverEl) {
      const inputWrap = this.containerEl.querySelector(
        ".obsidian-agents-composer-input-wrap"
      ) as HTMLElement;
      this.commandPopoverEl = (inputWrap || this.containerEl).createDiv({
        cls: "obsidian-agents-command-popover",
      });
    }
    this.renderCommandItems();
  }

  private renderCommandItems(): void {
    if (!this.commandPopoverEl) return;
    this.commandPopoverEl.empty();

    if (this.commandItems.length === 0) {
      this.commandPopoverEl.style.display = "none";
      return;
    }

    this.commandPopoverEl.style.display = "block";
    for (let i = 0; i < this.commandItems.length; i++) {
      const skill = this.commandItems[i];
      const row = this.commandPopoverEl.createDiv({ cls: "obsidian-agents-command-item" });

      const main = row.createDiv({ cls: "obsidian-agents-command-item-main" });
      main.createSpan({
        cls: "obsidian-agents-command-item-id",
        text: "/" + skill.id.replace(/^\//, ""),
      });
      main.createSpan({ cls: "obsidian-agents-command-item-label", text: skill.label });
      row.createDiv({ cls: "obsidian-agents-command-item-desc", text: skill.description });

      if (i === this.commandSelectedIndex) {
        row.addClass("selected");
      }
      row.addEventListener("mouseenter", () => {
        this.commandSelectedIndex = i;
        this.commandPopoverEl?.querySelectorAll(".obsidian-agents-command-item.selected").forEach(
          (e) => e.removeClass("selected")
        );
        row.addClass("selected");
      });
      row.addEventListener("mousedown", (e) => {
        e.preventDefault();
        this.selectCommand(skill);
      });
    }
  }

  private selectCommand(skill: Skill): void {
    // Strip the typed "/query" from the editor and promote the skill into a
    // visual pill at the start of the composer. The user's prompt text now
    // starts on a clean slate.
    if (this.commandStartIndex >= 0) {
      const cursor = this.editor.getCursor();
      this.editor.replaceRange(this.commandStartIndex, cursor, "");
    }
    this.activeSkill = skill;
    this.renderSkillPill();
    this.editor.focus();
    this.hideCommandPopover();
    this.updateSendButton();
  }

  private hideCommandPopover(): void {
    if (this.commandPopoverEl) {
      this.commandPopoverEl.style.display = "none";
    }
    this.commandQuery = "";
    this.commandItems = [];
  }

  private renderSkillPill(): void {
    if (!this.skillPillEl) return;
    this.skillPillEl.empty();

    if (!this.activeSkill) {
      this.skillPillEl.style.display = "none";
      this.skillPillEl.style.removeProperty("top");
      this.skillPillEl.style.removeProperty("height");
      if (this.editorHostEl) {
        this.editorHostEl.removeAttribute("data-skill-active");
        this.editorHostEl.style.removeProperty("--skill-pill-width");
      }
      return;
    }

    this.skillPillEl.style.display = "inline-flex";
    const pill = this.skillPillEl.createSpan({
      cls: "obsidian-agents-composer-skill-pill",
      attr: { title: this.activeSkill.description },
    });
    pill.createSpan({
      cls: "obsidian-agents-composer-skill-pill-slash",
      text: "/",
    });
    pill.createSpan({
      cls: "obsidian-agents-composer-skill-pill-name",
      text: this.activeSkill.id.replace(/^\//, ""),
    });

    // After layout settles: (a) publish the pill's width as a CSS var so
    // the editor's first line can text-indent by that amount; (b) align the
    // pill's vertical offset to CM6's first text line so the baseline
    // matches the placeholder/cursor. CM6's content padding isn't fixed
    // (themes vary), so measure instead of hardcoding.
    if (this.editorHostEl) {
      this.editorHostEl.setAttribute("data-skill-active", "true");
      const host = this.editorHostEl;
      const slot = this.skillPillEl;
      requestAnimationFrame(() => {
        const w = slot.offsetWidth;
        if (w > 0) host.style.setProperty("--skill-pill-width", `${w + 6}px`);

        const firstLine = host.querySelector(".cm-content > .cm-line") as HTMLElement | null;
        if (firstLine) {
          const hostRect = host.getBoundingClientRect();
          const lineRect = firstLine.getBoundingClientRect();
          // Vertically center the pill on the first line's text baseline
          // by matching the line's top within the host, then nudging down
          // to account for the font's internal leading so the `/` aligns
          // with a typical lowercase x-height.
          slot.style.top = `${Math.max(0, lineRect.top - hostRect.top)}px`;
          slot.style.height = `${lineRect.height}px`;
        }
      });
    }
  }

  private clearSkill(): void {
    this.activeSkill = null;
    this.renderSkillPill();
    this.updateSendButton();
  }

  private handleFile(file: File): void {
    const reader = new FileReader();
    reader.onload = () => {
      const dataUrl = reader.result as string;
      const type: Attachment["type"] = file.type.startsWith("image/")
        ? "image"
        : file.type === "application/pdf"
        ? "pdf"
        : "file";

      const attachment: Attachment = {
        id: generateId(),
        type,
        name: file.name,
        path: file.name,
        dataUrl,
      };
      this.attachments.push(attachment);
      this.renderAttachments();
      this.updateSendButton();
    };
    reader.readAsDataURL(file);
  }

  private renderAttachments(): void {
    this.attachmentsEl.empty();
    if (this.attachments.length === 0) {
      this.attachmentsEl.style.display = "none";
      return;
    }
    this.attachmentsEl.style.display = "flex";

    for (const att of this.attachments) {
      const isImage = att.type === "image" && !!att.dataUrl;
      const chip = this.attachmentsEl.createDiv({
        cls: `obsidian-agents-attachment-chip${isImage ? " obsidian-agents-attachment-chip-image" : ""}`,
      });

      if (isImage) {
        const thumb = chip.createEl("img", { cls: "obsidian-agents-attachment-thumb" });
        thumb.src = att.dataUrl!;
        thumb.alt = att.name;
        chip.setAttribute("role", "button");
        chip.setAttribute("aria-label", `Preview ${att.name}`);
        chip.addEventListener("click", (e) => {
          if ((e.target as HTMLElement).closest(".obsidian-agents-attachment-remove")) return;
          this.openImageLightbox(att.dataUrl!, att.name);
        });
      } else {
        const label = chip.createSpan();
        label.setText(att.name);
      }

      const removeBtn = chip.createEl("button", { cls: "obsidian-agents-attachment-remove" });
      setIcon(removeBtn, "x");
      removeBtn.setAttribute("aria-label", `Remove ${att.name}`);
      removeBtn.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        this.attachments = this.attachments.filter((a) => a.id !== att.id);
        this.renderAttachments();
        this.updateSendButton();
      });
    }
  }

  private openImageLightbox(src: string, name: string): void {
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

  private send(): void {
    const text = this.editor.getValue().trim();
    if (!text && this.attachments.length === 0 && this.mentions.length === 0) return;

    const mentionPrefix = this.mentions
      .map((m) => `@[${m.displayName}](${m.path})`)
      .join(" ");

    const quotePrefix = this.replyQuote
      ? this.replyQuote
          .split("\n")
          .map((line) => `> ${line}`)
          .join("\n") + "\n\n"
      : "";

    const bodyText = mentionPrefix
      ? `${mentionPrefix}${text ? " " : ""}${text}`
      : text;
    const fullText = `${quotePrefix}${bodyText}`;

    const skillId = this.activeSkill?.id ?? null;
    this.onSend(fullText, [...this.attachments], skillId);
    this.editor.setValue("");
    this.attachments = [];
    this.mentions = [];
    this.replyQuote = null;
    this.activeSkill = null;
    this.renderAttachments();
    this.renderChips();
    this.renderQuote();
    this.renderSkillPill();
    this.hideCommandPopover();
    this.updateSendButton();
    if (this.expanded) this.setExpanded(false);
    this.expandBtn.style.display = "none";
  }

  onunload(): void {
    this.editor.destroy();
  }
}
