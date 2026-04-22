import { App, Component, setIcon } from "obsidian";
import { Attachment, MentionItem } from "../../types";
import { MentionPopover, TextInputLike } from "./MentionPopover";
import { getSkillRegistry } from "../../features/commands";
import type { Skill } from "../../skills";
import { generateId } from "../../lib/id";
import { LivePreviewEditor } from "./LivePreviewEditor";

const EXPAND_THRESHOLD = 80;
const MAX_ACTIVE_SKILLS = 3;

/**
 * Composer: attach + reply quote + mention chips + skill chips + CM6 editor + send.
 *
 * The `+` button opens a ChatGPT-style popup with "Attach file" and the list
 * of opt-in skills. Selected skills show as chips in a row below the editor,
 * stacking horizontally (max 3). The editor's placeholder reflects the last
 * activated skill when the input is empty.
 */
export class Composer extends Component {
  containerEl: HTMLElement;
  private editor: LivePreviewEditor;
  private chipsEl: HTMLElement;
  private skillChipsEl: HTMLElement;
  private quoteEl: HTMLElement;
  private attachmentsEl: HTMLElement;
  private attachments: Attachment[] = [];
  private mentions: MentionItem[] = [];
  private activeSkills: Skill[] = [];
  private replyQuote: string | null = null;
  private onSend: (text: string, attachments: Attachment[], skillIds?: string[]) => void;
  private onAbort: (() => void) | null = null;
  private streaming = false;
  private mentionPopover: MentionPopover | null = null;
  private addMenuEl: HTMLElement | null = null;
  private addBtn: HTMLButtonElement;
  private skills = getSkillRegistry();

  // Inline slash-autocomplete popover — triggered by typing "/" anywhere the
  // editor is empty of meaningful content. Lets power users skip the + menu.
  private slashPopoverEl: HTMLElement | null = null;
  private slashItems: Skill[] = [];
  private slashSelectedIndex = 0;
  private slashStartIndex = -1;
  private slashQuery = "";
  private sendBtn: HTMLButtonElement;
  private expandBtn: HTMLButtonElement;
  private expanded = false;
  private app: App | null = null;

  // Event subscribers registered via the TextInputLike adapter.
  private inputListeners = new Set<() => void>();
  private keydownListeners = new Set<(e: KeyboardEvent) => void>();

  constructor(
    container: HTMLElement,
    onSend: (text: string, attachments: Attachment[], skillIds?: string[]) => void,
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

    // The prompt sits on its own row above; + / skill-chips / expand / send
    // share the bottom row so chips live inline with the action buttons.
    const editorHost = inputWrap.createDiv({ cls: "obsidian-agents-composer-editor-host" });

    this.editor = new LivePreviewEditor(editorHost, {
      placeholder: "Ask anything",
      onChange: () => {
        this.autoResize();
        this.updatePlaceholder();
        this.updateSendButton();
        this.fireInput();
        this.mentionPopover?.onEditorChange();
        this.handleSlashInput();
      },
      onSubmit: () => this.send(),
      onKeyDown: (evt) => this.handleEditorKeyDown(evt),
      onPaste: (evt) => this.handlePaste(evt),
    });

    const bottomBar = inputWrap.createDiv({ cls: "obsidian-agents-composer-bottom-bar" });

    this.addBtn = bottomBar.createEl("button", {
      cls: "obsidian-agents-composer-attach-btn",
      attr: { "aria-label": "Attach or add skill" },
    });
    setIcon(this.addBtn, "plus");
    this.registerDomEvent(this.addBtn, "click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      this.toggleAddMenu();
    });

    // Inline skill chip row, sharing the bottom bar with the action buttons.
    this.skillChipsEl = bottomBar.createDiv({
      cls: "obsidian-agents-composer-skill-chips obsidian-agents-composer-skill-chips-empty",
    });

    // Spacer pushes send to the right edge regardless of chip count.
    bottomBar.createDiv({ cls: "obsidian-agents-composer-bottom-spacer" });

    // Expand button lives on the input-wrap itself (not inside bottom-bar)
    // so it can be absolutely anchored to the top-right corner AND survive
    // when bottom-bar is hidden in the expanded state (where it becomes
    // the close X).
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

    this.sendBtn = bottomBar.createEl("button", {
      cls: "obsidian-agents-composer-send-btn",
      attr: { "aria-label": "Send message" },
    });
    setIcon(this.sendBtn, "arrow-up");
    this.updateSendButton();

    this.registerDomEvent(this.sendBtn, "click", () => {
      if (this.streaming) {
        this.onAbort?.();
      } else {
        this.send();
      }
    });

    this.autoResize();

    // Dismiss the add-menu when clicking elsewhere.
    this.registerDomEvent(document, "click", (e) => {
      if (!this.addMenuEl) return;
      const target = e.target as Node;
      if (this.addMenuEl.contains(target) || this.addBtn.contains(target)) return;
      this.hideAddMenu();
    });
  }

  setStreaming(streaming: boolean): void {
    this.streaming = streaming;
    this.updateSendButton();
  }

  private renderExpandIcon(expanded: boolean): void {
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
    // Slash-popover owns navigation keys while it's open.
    if (this.slashPopoverEl && this.slashPopoverEl.style.display !== "none") {
      if (evt.key === "ArrowDown") {
        this.slashSelectedIndex = (this.slashSelectedIndex + 1) % this.slashItems.length;
        this.renderSlashItems();
        return true;
      } else if (evt.key === "ArrowUp") {
        this.slashSelectedIndex =
          (this.slashSelectedIndex - 1 + this.slashItems.length) % this.slashItems.length;
        this.renderSlashItems();
        return true;
      } else if (evt.key === "Enter" || evt.key === "Tab") {
        const picked = this.slashItems[this.slashSelectedIndex];
        if (picked) {
          evt.preventDefault();
          this.pickSlashSkill(picked);
        }
        return true;
      } else if (evt.key === "Escape") {
        this.hideSlashPopover();
        return true;
      }
    }

    for (const fn of this.keydownListeners) fn(evt);
    if (evt.defaultPrevented) return true;

    if (evt.key === "Escape" && this.addMenuEl) {
      this.hideAddMenu();
      return true;
    }

    if (evt.key === "Backspace") {
      const cursor = this.editor.getCursor();
      const sel = this.editor.getSelectionRange();
      const atStart = cursor === 0 && sel.from === 0 && sel.to === 0;
      if (atStart) {
        if (this.mentions.length > 0) {
          this.mentions.pop();
          this.renderChips();
          return true;
        }
        if (this.activeSkills.length > 0) {
          this.activeSkills.pop();
          this.renderSkillChips();
          this.updatePlaceholder();
          this.updateSendButton();
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
    this.autoResize();
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
    this.autoResize();
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

  private renderSkillChips(): void {
    this.autoResize();
    this.skillChipsEl.empty();
    // Toggle a class instead of flipping `display` so CSS transitions
    // on the chip row's opacity / max-height can actually run.
    this.skillChipsEl.toggleClass(
      "obsidian-agents-composer-skill-chips-empty",
      this.activeSkills.length === 0
    );
    if (this.activeSkills.length === 0) return;
    for (const skill of this.activeSkills) {
      const chip = this.skillChipsEl.createDiv({
        cls: "obsidian-agents-composer-skill-chip",
        attr: { title: skill.description },
      });
      const iconEl = chip.createSpan({ cls: "obsidian-agents-composer-skill-chip-icon" });
      setIcon(iconEl, skill.icon ?? "sparkles");
      chip.createSpan({
        cls: "obsidian-agents-composer-skill-chip-label",
        text: skill.label,
      });
      const remove = chip.createEl("button", {
        cls: "obsidian-agents-composer-skill-chip-remove",
        attr: { "aria-label": `Remove ${skill.label}` },
      });
      setIcon(remove, "x");
      remove.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        this.activeSkills = this.activeSkills.filter((s) => s.id !== skill.id);
        this.renderSkillChips();
        this.updatePlaceholder();
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
    // Compact (single-row, pill-shaped) mode: no skills + no multi-line.
    // Anything richer collapses back to the stacked box layout.
    const compact =
      !this.expanded &&
      !multiLine &&
      this.activeSkills.length === 0 &&
      this.attachments.length === 0 &&
      this.mentions.length === 0 &&
      this.replyQuote == null;
    this.containerEl.toggleClass("obsidian-agents-composer-compact", compact);
  }

  /**
   * When a skill is active and the editor is empty, surface the skill's
   * custom placeholder ("Search the web", "Learn something new", …). As
   * soon as the user types, CM6 hides its placeholder automatically.
   */
  private updatePlaceholder(): void {
    const last = this.activeSkills[this.activeSkills.length - 1];
    const placeholder = last?.placeholder ?? "Ask anything";
    this.editor.setPlaceholder(placeholder);
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
      this.activeSkills.length > 0 ||
      this.replyQuote != null;
    this.sendBtn.disabled = !hasContent;
  }

  // --- Slash autocomplete ---------------------------------------------

  /**
   * Triggered from the editor's onChange. If the current text starts with a
   * "/" followed by non-space/non-newline characters and no other content
   * precedes it, we show a filtered skill list. Mirrors ChatGPT's power-user
   * shortcut for the + menu.
   */
  private handleSlashInput(): void {
    const text = this.editor.getValue();
    const cursor = this.editor.getCursor();
    const before = text.slice(0, cursor);

    // Only trigger when "/" is the very first character of the doc and the
    // user hasn't pressed space yet — keeps the popover out of the way
    // during normal typing.
    const match = /^\/([\w-]*)$/.exec(before);
    if (!match) {
      this.hideSlashPopover();
      return;
    }

    this.slashStartIndex = 0;
    this.slashQuery = match[1];
    const available = this.skills
      .filter(this.slashQuery)
      .filter((s) => !this.activeSkills.some((a) => a.id === s.id));

    if (available.length === 0) {
      this.hideSlashPopover();
      return;
    }
    this.slashItems = available;
    this.slashSelectedIndex = 0;
    this.showSlashPopover();
  }

  private showSlashPopover(): void {
    if (!this.slashPopoverEl) {
      const inputWrap = this.containerEl.querySelector(
        ".obsidian-agents-composer-input-wrap"
      ) as HTMLElement;
      this.slashPopoverEl = (inputWrap || this.containerEl).createDiv({
        cls: "obsidian-agents-slash-popover",
      });
    }
    this.slashPopoverEl.style.display = "block";
    this.renderSlashItems();
  }

  private hideSlashPopover(): void {
    if (this.slashPopoverEl) this.slashPopoverEl.style.display = "none";
    this.slashItems = [];
    this.slashQuery = "";
    this.slashStartIndex = -1;
  }

  private renderSlashItems(): void {
    if (!this.slashPopoverEl) return;
    this.slashPopoverEl.empty();
    for (let i = 0; i < this.slashItems.length; i++) {
      const skill = this.slashItems[i];
      const row = this.slashPopoverEl.createDiv({
        cls:
          "obsidian-agents-slash-item" +
          (i === this.slashSelectedIndex ? " selected" : ""),
        attr: { title: skill.description },
      });
      const icon = row.createSpan({ cls: "obsidian-agents-slash-item-icon" });
      setIcon(icon, skill.icon ?? "sparkles");
      const main = row.createDiv({ cls: "obsidian-agents-slash-item-main" });
      main.createSpan({
        cls: "obsidian-agents-slash-item-id",
        text: "/" + skill.id.replace(/^\//, ""),
      });
      main.createSpan({ cls: "obsidian-agents-slash-item-label", text: skill.label });
      row.createDiv({ cls: "obsidian-agents-slash-item-desc", text: skill.description });

      row.addEventListener("mouseenter", () => {
        this.slashSelectedIndex = i;
        this.slashPopoverEl
          ?.querySelectorAll(".obsidian-agents-slash-item.selected")
          .forEach((e) => e.removeClass("selected"));
        row.addClass("selected");
      });
      row.addEventListener("mousedown", (e) => {
        e.preventDefault();
        this.pickSlashSkill(skill);
      });
    }
  }

  private pickSlashSkill(skill: Skill): void {
    if (this.activeSkills.length >= MAX_ACTIVE_SKILLS) {
      this.hideSlashPopover();
      return;
    }
    // Remove the typed "/query" from the editor before promoting to a chip.
    if (this.slashStartIndex >= 0) {
      const cursor = this.editor.getCursor();
      this.editor.replaceRange(this.slashStartIndex, cursor, "");
    }
    if (!this.activeSkills.some((s) => s.id === skill.id)) {
      this.activeSkills.push(skill);
    }
    this.hideSlashPopover();
    this.renderSkillChips();
    this.updatePlaceholder();
    this.updateSendButton();
    this.editor.focus();
  }

  // --- Add menu (attach + skills) -------------------------------------

  private toggleAddMenu(): void {
    if (this.addMenuEl && this.addMenuEl.style.display !== "none") {
      this.hideAddMenu();
    } else {
      this.showAddMenu();
    }
  }

  private showAddMenu(): void {
    if (!this.addMenuEl) {
      const inputWrap = this.containerEl.querySelector(
        ".obsidian-agents-composer-input-wrap"
      ) as HTMLElement;
      this.addMenuEl = (inputWrap || this.containerEl).createDiv({
        cls: "obsidian-agents-add-menu",
      });
    }
    this.renderAddMenu();
    this.addMenuEl.style.display = "block";
    this.positionAddMenu();
  }

  /**
   * Open whichever direction has more viewport room. In an active chat the
   * composer is pinned to the bottom so "above" wins; in the empty state
   * it's centered and "below" usually wins. Either way, cap max-height to
   * the available space minus a margin so the popover never clips
   * off-screen and the user scrolls inside it for overflow.
   */
  private positionAddMenu(): void {
    if (!this.addMenuEl) return;
    const menu = this.addMenuEl;
    menu.style.maxHeight = "";
    menu.style.bottom = "";
    menu.style.top = "";
    const anchor = this.addBtn.getBoundingClientRect();
    const margin = 16;
    const gap = 8;
    const spaceAbove = Math.max(0, anchor.top - margin - gap);
    const spaceBelow = Math.max(0, window.innerHeight - anchor.bottom - margin - gap);
    const flipBelow = spaceBelow > spaceAbove;
    const available = flipBelow ? spaceBelow : spaceAbove;
    menu.style.maxHeight = `${Math.max(160, available)}px`;
    if (flipBelow) {
      menu.style.bottom = "auto";
      menu.style.top = "calc(100% + 8px)";
    }
  }

  private hideAddMenu(): void {
    if (this.addMenuEl) this.addMenuEl.style.display = "none";
  }

  private renderAddMenu(): void {
    if (!this.addMenuEl) return;
    this.addMenuEl.empty();

    // Attach file row — always first.
    const attachRow = this.addMenuEl.createDiv({ cls: "obsidian-agents-add-menu-item" });
    const attachIcon = attachRow.createSpan({ cls: "obsidian-agents-add-menu-item-icon" });
    setIcon(attachIcon, "paperclip");
    attachRow.createSpan({ cls: "obsidian-agents-add-menu-item-label", text: "Attach file" });
    attachRow.addEventListener("mousedown", (e) => {
      e.preventDefault();
      this.hideAddMenu();
      this.openFilePicker();
    });

    const skills = this.skills.list();
    if (skills.length > 0) {
      const core = skills.filter((s) => (s.kind ?? "core") === "core");
      const custom = skills.filter((s) => s.kind === "custom");
      const atCap = this.activeSkills.length >= MAX_ACTIVE_SKILLS;

      const renderSection = (title: string, list: Skill[]) => {
        if (list.length === 0) return;
        this.addMenuEl!.createDiv({ cls: "obsidian-agents-add-menu-sep" });
        const heading = this.addMenuEl!.createDiv({ cls: "obsidian-agents-add-menu-heading" });
        heading.setText(title);
        for (const skill of list) {
          const active = this.activeSkills.some((s) => s.id === skill.id);
          const disabled = !active && atCap;
          const row = this.addMenuEl!.createDiv({
            cls: "obsidian-agents-add-menu-item obsidian-agents-add-menu-item-skill" +
              (active ? " active" : "") +
              (disabled ? " disabled" : ""),
            attr: { title: skill.description },
          });
          const icon = row.createSpan({ cls: "obsidian-agents-add-menu-item-icon" });
          setIcon(icon, skill.icon ?? "sparkles");
          row.createSpan({
            cls: "obsidian-agents-add-menu-item-label",
            text: skill.label,
          });
          if (active) {
            const check = row.createSpan({ cls: "obsidian-agents-add-menu-item-check" });
            setIcon(check, "check");
          }
          row.addEventListener("mousedown", (e) => {
            e.preventDefault();
            if (disabled) return;
            this.toggleSkill(skill);
          });
        }
      };

      renderSection("Core skills", core);
      renderSection("Custom skills", custom);

      if (atCap) {
        const note = this.addMenuEl.createDiv({ cls: "obsidian-agents-add-menu-note" });
        note.setText(`Up to ${MAX_ACTIVE_SKILLS} skills per request.`);
      }
    }
  }

  private toggleSkill(skill: Skill): void {
    const idx = this.activeSkills.findIndex((s) => s.id === skill.id);
    if (idx >= 0) {
      this.activeSkills.splice(idx, 1);
    } else {
      if (this.activeSkills.length >= MAX_ACTIVE_SKILLS) return;
      this.activeSkills.push(skill);
    }
    this.renderSkillChips();
    this.updatePlaceholder();
    this.updateSendButton();
    this.renderAddMenu();
    this.editor.focus();
  }

  private openFilePicker(): void {
    const input = document.createElement("input");
    input.type = "file";
    input.multiple = true;
    input.onchange = () => {
      const files = input.files;
      if (!files) return;
      for (const f of Array.from(files)) this.handleFile(f);
    };
    input.click();
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
    this.autoResize();
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
    if (
      !text &&
      this.attachments.length === 0 &&
      this.mentions.length === 0 &&
      this.activeSkills.length === 0
    ) {
      return;
    }

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

    const skillIds = this.activeSkills.map((s) => s.id);
    this.onSend(fullText, [...this.attachments], skillIds);
    this.editor.setValue("");
    this.attachments = [];
    this.mentions = [];
    this.replyQuote = null;
    this.activeSkills = [];
    this.renderAttachments();
    this.renderChips();
    this.renderQuote();
    this.renderSkillChips();
    this.updatePlaceholder();
    this.hideAddMenu();
    this.hideSlashPopover();
    this.updateSendButton();
    if (this.expanded) this.setExpanded(false);
    this.expandBtn.style.display = "none";
  }

  onunload(): void {
    this.editor.destroy();
  }
}
