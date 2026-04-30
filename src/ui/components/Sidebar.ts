import { Component, Menu, setIcon } from "obsidian";
import { ChatSession, SessionFolder } from "../../types";

type MenuItemWithSubmenu = {
  setSubmenu(): Menu;
};

export interface SidebarCallbacks {
  onSelectSession: (id: string) => void;
  onCreateSession: (folderId?: string | null) => void;
  onCreateFolder: (parentId?: string | null) => void;
  onDeleteSession: (id: string) => void;
  onRenameSession: (id: string, name: string) => void;
  onMoveSession: (id: string, folderId: string | null) => void;
  onMoveFolder?: (id: string, parentId: string | null) => void;
  onDeleteFolder: (id: string) => void;
  onRenameFolder: (id: string, name: string) => void;
  onToggleFolderCollapse: (id: string) => void;
  // Optional — Sidebar uses these to decorate items with a streaming spinner
  // or unread-reply dot. Kept optional so tests / stubs don't have to wire
  // them up; when absent the indicator column is simply empty.
  isSessionStreaming?: (id: string) => boolean;
  isSessionUnread?: (id: string) => boolean;
}

type DateGroup = "today" | "yesterday" | "last7days" | "older";

function getDateGroup(timestamp: number): DateGroup {
  const now = Date.now();
  const diff = now - timestamp;
  const day = 86400000;
  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);
  const yesterdayStart = new Date(todayStart.getTime() - day);

  if (timestamp >= todayStart.getTime()) return "today";
  if (timestamp >= yesterdayStart.getTime()) return "yesterday";
  if (diff < 7 * day) return "last7days";
  return "older";
}

const DATE_GROUP_LABELS: Record<DateGroup, string> = {
  today: "Today",
  yesterday: "Yesterday",
  last7days: "Last 7 days",
  older: "Older",
};

const DATE_GROUP_ORDER: DateGroup[] = ["today", "yesterday", "last7days", "older"];

export class Sidebar extends Component {
  containerEl: HTMLElement;
  private callbacks: SidebarCallbacks;
  private sessions: ChatSession[] = [];
  private folders: SessionFolder[] = [];
  private activeSessionId: string | null = null;
  private treeEl!: HTMLElement;
  private panelEl: HTMLElement;
  private expandBtn: HTMLElement;
  private collapsed = false;
  private titleEl!: HTMLElement;
  private agentName: string;


  constructor(
    container: HTMLElement,
    callbacks: SidebarCallbacks,
    agentName = "Agent"
  ) {
    super();
    this.callbacks = callbacks;
    this.agentName = agentName;

    this.panelEl = container.createDiv({ cls: "obsidian-agents-sidebar-panel" });
    this.containerEl = this.panelEl.createDiv({ cls: "obsidian-agents-sidebar" });
    this.buildHeader();
    this.treeEl = this.containerEl.createDiv({ cls: "obsidian-agents-sidebar-tree" });

    this.expandBtn = this.panelEl.createDiv({
      cls: "obsidian-agents-sidebar-expand-btn",
      attr: { "aria-label": "Expand sidebar" },
    });
    setIcon(this.expandBtn, "sidebar");
    this.registerDomEvent(this.expandBtn, "click", () => this.setCollapsed(false));
  }

  private buildHeader(): void {
    const header = this.containerEl.createDiv({ cls: "obsidian-agents-sidebar-header" });

    this.titleEl = header.createDiv({ cls: "obsidian-agents-sidebar-title" });
    this.titleEl.setText(this.agentName);

    const actions = header.createDiv({ cls: "obsidian-agents-sidebar-actions" });

    const newFolderBtn = actions.createEl("button", {
      cls: "obsidian-agents-icon-btn",
      attr: { "aria-label": "New folder" },
    });
    setIcon(newFolderBtn, "folder-plus");
    this.registerDomEvent(newFolderBtn, "click", () => this.callbacks.onCreateFolder());

    const newChatBtn = actions.createEl("button", {
      cls: "obsidian-agents-icon-btn",
      attr: { "aria-label": "New chat" },
    });
    setIcon(newChatBtn, "square-pen");
    this.registerDomEvent(newChatBtn, "click", () => this.callbacks.onCreateSession());

    const collapseBtn = actions.createEl("button", {
      cls: "obsidian-agents-icon-btn",
      attr: { "aria-label": "Collapse sidebar" },
    });
    setIcon(collapseBtn, "sidebar");
    this.registerDomEvent(collapseBtn, "click", () => this.setCollapsed(true));
  }

  private setCollapsed(value: boolean): void {
    this.collapsed = value;
    this.panelEl.toggleClass("obsidian-agents-sidebar-collapsed", value);
  }

  setAgentName(name: string): void {
    this.agentName = name;
    this.titleEl.setText(name);
  }

  render(
    sessions: ChatSession[],
    folders: SessionFolder[],
    activeSessionId: string | null
  ): void {
    this.sessions = sessions;
    this.folders = folders;
    this.activeSessionId = activeSessionId;
    this.treeEl.empty();

    // Show any session that has at least one message. We previously only
    // counted user messages to hide the "empty reuse slot" that
    // createSession() keeps around, but that also hid new-chat sessions
    // created by scheduled jobs (which start with a single agent message).
    const visibleSessions = sessions.filter((s) => s.messages.length > 0);

    const topLevelFolders = folders.filter((f) => f.parentId === null);
    const topLevelSessions = visibleSessions
      .filter((s) => s.folderId === null)
      .sort((a, b) => b.updatedAt - a.updatedAt);

    // --- Projects (folders) — no section header, rendered directly ---
    if (topLevelFolders.length > 0) {
      const projectsBody = this.treeEl.createDiv({ cls: "obsidian-agents-section-body obsidian-agents-projects-body" });
      for (const folder of topLevelFolders) {
        this.renderFolder(projectsBody, folder, visibleSessions);
      }
    }

    // --- Recents — date group labels are static, non-collapsible ---
    if (topLevelSessions.length > 0) {
      this.renderDateGroupedSessions(this.treeEl, topLevelSessions);
    }

    // Drop-into-root target
    this.treeEl.addEventListener("dragover", (e) => {
      if (this.draggingSessionId || this.draggingFolderId) {
        e.preventDefault();
        this.treeEl.classList.add("obsidian-agents-drop-root");
      }
    });
    this.treeEl.addEventListener("dragleave", () => {
      this.treeEl.classList.remove("obsidian-agents-drop-root");
    });
    this.treeEl.addEventListener("drop", (e) => {
      if (this.draggingSessionId) {
        e.preventDefault();
        this.treeEl.classList.remove("obsidian-agents-drop-root");
        this.callbacks.onMoveSession(this.draggingSessionId, null);
        this.draggingSessionId = null;
      } else if (this.draggingFolderId) {
        e.preventDefault();
        this.treeEl.classList.remove("obsidian-agents-drop-root");
        this.callbacks.onMoveFolder?.(this.draggingFolderId, null);
        this.draggingFolderId = null;
      }
    });

    if (visibleSessions.length === 0 && folders.length === 0) {
      const empty = this.treeEl.createDiv({ cls: "obsidian-agents-empty-state" });
      empty.createDiv({ cls: "obsidian-agents-empty-state-text", text: "No chats yet" });
    }
  }

  private renderDateGroupedSessions(
    container: HTMLElement,
    sessions: ChatSession[]
  ): void {
    const grouped = new Map<DateGroup, ChatSession[]>();
    for (const s of sessions) {
      const g = getDateGroup(s.updatedAt);
      if (!grouped.has(g)) grouped.set(g, []);
      grouped.get(g)!.push(s);
    }

    for (const group of DATE_GROUP_ORDER) {
      const groupSessions = grouped.get(group);
      if (!groupSessions || groupSessions.length === 0) continue;

      const groupEl = container.createDiv({ cls: "obsidian-agents-date-group" });
      groupEl.createDiv({
        cls: "obsidian-agents-date-group-label",
        text: DATE_GROUP_LABELS[group],
      });

      const groupBody = groupEl.createDiv({ cls: "obsidian-agents-date-group-body" });
      for (const session of groupSessions) {
        this.renderSession(groupBody, session);
      }
    }
  }

  private draggingSessionId: string | null = null;
  private draggingFolderId: string | null = null;

  private isDescendantFolder(folderId: string, potentialAncestorId: string): boolean {
    let cursor: string | null = folderId;
    while (cursor) {
      if (cursor === potentialAncestorId) return true;
      const parent = this.folders.find((f) => f.id === cursor);
      cursor = parent ? parent.parentId : null;
    }
    return false;
  }

  private renderFolder(
    container: HTMLElement,
    folder: SessionFolder,
    visibleSessions: ChatSession[]
  ): void {
    const folderEl = container.createDiv({ cls: "obsidian-agents-tree-folder" });
    folderEl.setAttribute("data-folder-id", folder.id);

    const header = folderEl.createDiv({ cls: "obsidian-agents-tree-folder-header" });
    header.setAttribute("draggable", "true");
    const caret = header.createSpan({ cls: "obsidian-agents-tree-caret" });
    setIcon(caret, folder.collapsed ? "chevron-right" : "chevron-down");
    const nameSpan = header.createSpan({ cls: "obsidian-agents-tree-label", text: folder.name });

    header.addEventListener("dragstart", (e) => {
      this.draggingFolderId = folder.id;
      folderEl.classList.add("obsidian-agents-dragging");
      if (e.dataTransfer) {
        e.dataTransfer.effectAllowed = "move";
        e.dataTransfer.setData("text/plain", folder.id);
      }
      e.stopPropagation();
    });
    header.addEventListener("dragend", () => {
      this.draggingFolderId = null;
      folderEl.classList.remove("obsidian-agents-dragging");
    });

    header.addEventListener("dragover", (e) => {
      if (this.draggingSessionId) {
        e.preventDefault();
        e.stopPropagation();
        header.classList.add("obsidian-agents-drop-target");
      } else if (
        this.draggingFolderId &&
        this.draggingFolderId !== folder.id &&
        !this.isDescendantFolder(folder.id, this.draggingFolderId)
      ) {
        e.preventDefault();
        e.stopPropagation();
        header.classList.add("obsidian-agents-drop-target");
      }
    });
    header.addEventListener("dragleave", () => {
      header.classList.remove("obsidian-agents-drop-target");
    });
    header.addEventListener("drop", (e) => {
      if (this.draggingSessionId) {
        e.preventDefault();
        e.stopPropagation();
        header.classList.remove("obsidian-agents-drop-target");
        this.callbacks.onMoveSession(this.draggingSessionId, folder.id);
        this.draggingSessionId = null;
      } else if (
        this.draggingFolderId &&
        this.draggingFolderId !== folder.id &&
        !this.isDescendantFolder(folder.id, this.draggingFolderId)
      ) {
        e.preventDefault();
        e.stopPropagation();
        header.classList.remove("obsidian-agents-drop-target");
        this.callbacks.onMoveFolder?.(this.draggingFolderId, folder.id);
        this.draggingFolderId = null;
      }
    });

    const childrenEl = folderEl.createDiv({
      cls: "obsidian-agents-tree-folder-children",
    });
    childrenEl.style.display = folder.collapsed ? "none" : "block";

    this.registerDomEvent(header, "click", (evt: MouseEvent) => {
      if ((evt.target as HTMLElement).tagName === "INPUT") return;
      this.callbacks.onToggleFolderCollapse(folder.id);
    });

    this.registerDomEvent(header, "contextmenu", (evt: MouseEvent) => {
      evt.preventDefault();
      this.showFolderContextMenu(evt, folder);
    });

    this.registerDomEvent(header, "dblclick", (evt: MouseEvent) => {
      evt.preventDefault();
      this.startInlineRename(nameSpan, folder.name, (newName) => {
        this.callbacks.onRenameFolder(folder.id, newName);
      });
    });

    const childSessions = visibleSessions
      .filter((s) => s.folderId === folder.id)
      .sort((a, b) => b.createdAt - a.createdAt);
    for (const session of childSessions) {
      this.renderSession(childrenEl, session);
    }

    const childFolders = this.folders.filter((f) => f.parentId === folder.id);
    for (const childFolder of childFolders) {
      this.renderFolder(childrenEl, childFolder, visibleSessions);
    }
  }

  private renderSession(container: HTMLElement, session: ChatSession): void {
    const sessionEl = container.createDiv({
      cls: `obsidian-agents-tree-item ${
        session.id === this.activeSessionId ? "obsidian-agents-active" : ""
      }`,
    });
    sessionEl.setAttribute("data-session-id", session.id);
    sessionEl.setAttribute("draggable", "true");

    sessionEl.addEventListener("dragstart", (e) => {
      this.draggingSessionId = session.id;
      sessionEl.classList.add("obsidian-agents-dragging");
      if (e.dataTransfer) {
        e.dataTransfer.effectAllowed = "move";
        e.dataTransfer.setData("text/plain", session.id);
      }
    });
    sessionEl.addEventListener("dragend", () => {
      this.draggingSessionId = null;
      sessionEl.classList.remove("obsidian-agents-dragging");
    });

    const nameSpan = sessionEl.createSpan({ cls: "obsidian-agents-tree-label", text: session.name });

    // Unread dot / streaming spinner — mutually exclusive. Streaming wins
    // because a dot for a chat that's still actively generating would be
    // misleading.
    const streaming = this.callbacks.isSessionStreaming?.(session.id) ?? false;
    const unread = !streaming && (this.callbacks.isSessionUnread?.(session.id) ?? false);
    if (streaming) {
      sessionEl.createSpan({ cls: "obsidian-agents-session-indicator obsidian-agents-session-spinner" });
    } else if (unread) {
      sessionEl.createSpan({ cls: "obsidian-agents-session-indicator obsidian-agents-session-unread-dot" });
    }

    const menuBtn = sessionEl.createEl("button", {
      cls: "obsidian-agents-tree-item-menu",
      attr: { "aria-label": "More options" },
    });
    setIcon(menuBtn, "more-horizontal");

    this.registerDomEvent(sessionEl, "click", (evt: MouseEvent) => {
      if ((evt.target as HTMLElement).tagName === "INPUT") return;
      if ((evt.target as HTMLElement).closest(".obsidian-agents-tree-item-menu")) return;
      this.callbacks.onSelectSession(session.id);
    });

    this.registerDomEvent(menuBtn, "click", (evt: MouseEvent) => {
      evt.stopPropagation();
      this.showSessionContextMenu(evt, session);
    });

    this.registerDomEvent(sessionEl, "contextmenu", (evt: MouseEvent) => {
      evt.preventDefault();
      this.showSessionContextMenu(evt, session);
    });

    this.registerDomEvent(sessionEl, "dblclick", (evt: MouseEvent) => {
      evt.preventDefault();
      this.startInlineRename(nameSpan, session.name, (newName) => {
        this.callbacks.onRenameSession(session.id, newName);
      });
    });
  }

  private startInlineRename(
    span: HTMLElement,
    currentName: string,
    onDone: (name: string) => void
  ): void {
    const input = document.createElement("input");
    input.type = "text";
    input.value = currentName;
    input.className = "obsidian-agents-inline-rename";

    span.replaceWith(input);
    input.focus();
    input.select();

    const finish = (save: boolean) => {
      const newName = input.value.trim() || currentName;
      input.replaceWith(span);
      if (save) {
        span.setText(newName);
        onDone(newName);
      }
    };

    this.registerDomEvent(input, "keydown", (evt: KeyboardEvent) => {
      if (evt.key === "Enter") {
        evt.preventDefault();
        finish(true);
      } else if (evt.key === "Escape") {
        evt.preventDefault();
        finish(false);
      }
    });

    this.registerDomEvent(input, "blur", () => {
      finish(true);
    });
  }

  private showSessionContextMenu(evt: MouseEvent, session: ChatSession): void {
    const menu = new Menu();

    menu.addItem((item) =>
      item.setTitle("Rename").setIcon("pencil").onClick(() => {
        const el = this.treeEl.querySelector(
          `[data-session-id="${session.id}"] .obsidian-agents-tree-label`
        ) as HTMLElement;
        if (el) {
          this.startInlineRename(el, session.name, (newName) => {
            this.callbacks.onRenameSession(session.id, newName);
          });
        }
      })
    );

    if (this.folders.length > 0 || session.folderId !== null) {
      menu.addItem((item) => {
        item.setTitle("Move to folder").setIcon("folder");
        const sub = (item as unknown as MenuItemWithSubmenu).setSubmenu();
        sub.addItem((subItem) =>
          subItem.setTitle("(no folder)").onClick(() => {
            this.callbacks.onMoveSession(session.id, null);
          })
        );
        for (const folder of this.folders) {
          sub.addItem((subItem) =>
            subItem.setTitle(folder.name).onClick(() => {
              this.callbacks.onMoveSession(session.id, folder.id);
            })
          );
        }
      });
    }

    menu.addItem((item) =>
      item.setTitle("Delete").setIcon("trash").onClick(() => {
        if (confirm(`Delete "${session.name}"?`)) {
          this.callbacks.onDeleteSession(session.id);
        }
      })
    );

    menu.showAtMouseEvent(evt);
  }

  private showFolderContextMenu(evt: MouseEvent, folder: SessionFolder): void {
    const menu = new Menu();

    menu.addItem((item) =>
      item.setTitle("New chat here").setIcon("square-pen").onClick(() => {
        this.callbacks.onCreateSession(folder.id);
      })
    );

    menu.addItem((item) =>
      item.setTitle("New subfolder").setIcon("folder-plus").onClick(() => {
        this.callbacks.onCreateFolder(folder.id);
      })
    );

    menu.addSeparator();

    menu.addItem((item) =>
      item.setTitle("Rename").setIcon("pencil").onClick(() => {
        const folderEls = Array.from(
          this.treeEl.querySelectorAll(".obsidian-agents-tree-folder-header")
        );
        const target = folderEls.find((el) => {
          const label = el.querySelector(".obsidian-agents-tree-label") as HTMLElement;
          return label && label.getText() === folder.name;
        });
        const nameSpan = target?.querySelector(".obsidian-agents-tree-label") as HTMLElement;
        if (nameSpan) {
          this.startInlineRename(nameSpan, folder.name, (newName) => {
            this.callbacks.onRenameFolder(folder.id, newName);
          });
        }
      })
    );

    menu.addItem((item) =>
      item.setTitle("Delete").setIcon("trash").onClick(() => {
        const childSessions = this.sessions.filter((s) => s.folderId === folder.id);
        const childFolders = this.folders.filter((f) => f.parentId === folder.id);
        const msg = childSessions.length > 0 || childFolders.length > 0
          ? `Delete "${folder.name}" and move its contents out?`
          : `Delete "${folder.name}"?`;
        if (confirm(msg)) {
          this.callbacks.onDeleteFolder(folder.id);
        }
      })
    );

    menu.showAtMouseEvent(evt);
  }
}
