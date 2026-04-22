import { ItemView, WorkspaceLeaf, Component } from "obsidian";
import {
  ChatSession,
  Attachment,
  ToolCall,
  PermissionDecision,
  StreamHandlers,
  LayoutBlock,
  SessionFolder,
} from "../types";
import { Sidebar } from "./components/Sidebar";
import { MessageList } from "./components/MessageList";
import { Composer } from "./components/Composer";
import { StatusBar } from "./components/StatusBar";
import { PermissionWidget } from "./components/PermissionWidget";
import { MentionPopover } from "./components/MentionPopover";
import { ReplyHandle } from "./components/ReplyHandle";
import { TermPanel } from "./components/TermPanel";
import { generateId } from "../lib/id";

export const CHAT_VIEW_TYPE = "obsidian-agents";

export interface IObsidianAgentsPlugin {
  app: any;
  settings: { agentName: string; model: string; contextWindow: number };
  sessions: ChatSession[];
  foldersList: SessionFolder[];
  activeSessionId: string | null;
  createSession(folderId?: string | null): ChatSession;
  createFolder(parentId?: string | null): void;
  deleteSession(id: string): void;
  renameSession(id: string, name: string): void;
  moveSession(id: string, folderId: string | null): void;
  moveFolder(id: string, parentId: string | null): void;
  deleteFolder(id: string): void;
  renameFolder(id: string, name: string): void;
  toggleFolderCollapse(id: string): void;
  selectSession(id: string): void;
  sendMessage(
    sessionId: string,
    text: string,
    attachments: Attachment[],
    handlers: StreamHandlers,
    skillIds?: string[]
  ): Promise<string | null>;
  isStreaming(sessionId: string): boolean;
  getStreamMessageId(sessionId: string): string | null;
  getStreamStartTime(sessionId: string): number | null;
  abortStream(sessionId: string): void;
  resolvePermission(toolCallId: string, decision: PermissionDecision): void;
}

export class ChatView extends ItemView {
  static VIEW_TYPE = CHAT_VIEW_TYPE;
  private plugin: IObsidianAgentsPlugin;

  private sidebar: Sidebar | null = null;
  private messageList: MessageList | null = null;
  private composer: Composer | null = null;
  private statusBar: StatusBar | null = null;
  private replyHandle: ReplyHandle | null = null;
  private termPanel: TermPanel | null = null;

  private currentSessionId: string | null = null;

  constructor(leaf: WorkspaceLeaf, plugin: IObsidianAgentsPlugin) {
    super(leaf);
    this.plugin = plugin;
  }

  getViewType(): string {
    return CHAT_VIEW_TYPE;
  }

  getDisplayText(): string {
    return "Obsidian Agents";
  }

  async onOpen(): Promise<void> {
    const container = this.containerEl.children[1] as HTMLElement;
    container.empty();
    container.addClass("obsidian-agents-view");
    // Strip Obsidian's default view-content padding so we fill edge-to-edge
    container.style.padding = "0";

    // Swallow horizontal trackpad pans anywhere inside the chat view.
    // Without this, a right-to-left two-finger swipe produces a horizontal
    // scroll delta that the browser applies to the nearest scrollable
    // ancestor (or a history gesture), which was translating the chat
    // column. We never want horizontal scrolling in this view.
    container.addEventListener(
      "wheel",
      (e: WheelEvent) => {
        if (Math.abs(e.deltaX) > Math.abs(e.deltaY)) {
          e.preventDefault();
        }
      },
      { passive: false }
    );

    // Sidebar
    this.sidebar = new Sidebar(
      container,
      {
        onSelectSession: (id) => this.plugin.selectSession(id),
        onCreateSession: (folderId) => this.plugin.createSession(folderId ?? null),
        onCreateFolder: (parentId) => this.plugin.createFolder(parentId ?? null),
        onDeleteSession: (id) => this.plugin.deleteSession(id),
        onRenameSession: (id, name) => this.plugin.renameSession(id, name),
        onMoveSession: (id, folderId) => this.plugin.moveSession(id, folderId),
        onMoveFolder: (id, parentId) => this.plugin.moveFolder(id, parentId),
        onDeleteFolder: (id) => this.plugin.deleteFolder(id),
        onRenameFolder: (id, name) => this.plugin.renameFolder(id, name),
        onToggleFolderCollapse: (id) => this.plugin.toggleFolderCollapse(id),
      },
      this.plugin.settings.agentName
    );
    this.addChild(this.sidebar);

    // Main chat area
    const chatPanel = container.createDiv({ cls: "obsidian-agents-chat-panel" });

    this.messageList = new MessageList(chatPanel);
    this.addChild(this.messageList);

    this.composer = new Composer(
      chatPanel,
      (text, attachments, skillIds) => {
        this.doSendMessage(text, attachments, skillIds ?? []);
      },
      () => {
        if (this.currentSessionId) this.plugin.abortStream(this.currentSessionId);
      }
    );
    this.composer.setApp(this.plugin.app);
    this.addChild(this.composer);

    // When the composer flips to expanded mode, add a root class so CSS
    // can reshape the layout into a right-side document view.
    container.addEventListener("obsidian-agents:composer-expanded", (e: Event) => {
      const expanded = (e as CustomEvent).detail as boolean;
      container.toggleClass("obsidian-agents-composer-docked", expanded);
    });

    const mentionPopover = new MentionPopover(
      this.plugin.app,
      () => {}
    );
    this.composer.setMentionPopover(mentionPopover);

    // Reply-to-selection floating button
    this.replyHandle = new ReplyHandle(container, (quote) => {
      this.composer?.setReplyQuote(quote);
    });

    // Reply button embedded in each agent message dispatches this event
    container.addEventListener("obsidian-agents:reply", (e: Event) => {
      const quote = (e as CustomEvent).detail as string;
      if (quote) this.composer?.setReplyQuote(quote);
    });

    // Term detail panel — slides in from the right when a user clicks an
    // inline `[[Label]]{#slug}` pill in any agent message.
    this.termPanel = new TermPanel(container, this.plugin.app, "");
    this.addChild(this.termPanel);
    container.addEventListener("obsidian-agents:open-term", (e: Event) => {
      const detail = (e as CustomEvent).detail as { id?: string } | undefined;
      if (detail?.id) this.termPanel?.open(detail.id);
    });

    // Load active session if any
    if (this.plugin.activeSessionId) {
      const session = this.plugin.sessions.find(
        (s) => s.id === this.plugin.activeSessionId
      );
      if (session) {
        this.loadSession(session);
      }
    }

    this.renderSidebar(this.plugin.sessions, this.plugin.foldersList, this.plugin.activeSessionId);
  }

  async onClose(): Promise<void> {
    this.replyHandle?.destroy();
    this.replyHandle = null;
  }

  renderSidebar(
    sessions: ChatSession[],
    folders: SessionFolder[],
    activeSessionId: string | null
  ): void {
    this.sidebar?.render(sessions, folders, activeSessionId);
  }

  syncSettings(): void {
    this.sidebar?.setAgentName(this.plugin.settings.agentName);
  }

  loadSession(session: ChatSession): void {
    this.currentSessionId = session.id;
    this.termPanel?.close();
    // Close any open thinking-trace drawer — it's tied to a message in the
    // previous session and shouldn't carry over when switching chats.
    this.containerEl
      .querySelector(".obsidian-agents-thinking-drawer")
      ?.remove();
    this.messageList?.clear();
    for (const msg of session.messages) {
      this.messageList?.addMessage(msg, this.plugin);
    }
    // If this session has an in-flight stream, flag the corresponding bubble
    // and pass the real stream start time so the thinking timer isn't reset.
    const streamId = this.plugin.getStreamMessageId(session.id);
    if (streamId) {
      const startTime = this.plugin.getStreamStartTime(session.id) ?? undefined;
      this.messageList?.setStreaming(streamId, true, startTime);
    }
    this.composer?.setStreaming(this.plugin.isStreaming(session.id));
    this.messageList?.scrollToBottom();
    this.updateEmptyState(session);
  }

  private updateEmptyState(session: ChatSession): void {
    // A scheduled/delivered agent message counts as "not empty" too — otherwise
    // a new chat created from a callback delivery still shows the greeting and
    // the centered composer.
    const isEmpty = session.messages.length === 0;
    const panel = this.containerEl.querySelector(
      ".obsidian-agents-chat-panel"
    ) as HTMLElement | null;
    if (!panel) return;
    panel.classList.toggle("obsidian-agents-empty", isEmpty);

    let greeting = panel.querySelector(".obsidian-agents-greeting") as HTMLElement | null;
    if (isEmpty) {
      if (!greeting) {
        greeting = document.createElement("div");
        greeting.className = "obsidian-agents-greeting";
        panel.insertBefore(greeting, panel.firstChild);
      }
      greeting.setText(this.pickGreeting());
    } else if (greeting) {
      greeting.remove();
    }
  }

  private pickGreeting(): string {
    const hour = new Date().getHours();
    const timeGreet =
      hour < 5 ? "Still up?"
      : hour < 12 ? "Good morning."
      : hour < 18 ? "Good afternoon."
      : "Good evening.";
    const prompts = [
      "What's on your mind?",
      "What are we building today?",
      "How can I help?",
      "Where should we start?",
      "Ready when you are.",
    ];
    const p = prompts[Math.floor(Math.random() * prompts.length)];
    return `${timeGreet} ${p}`;
  }

  private async doSendMessage(
    text: string,
    attachments: Attachment[],
    skillIds: string[] = []
  ): Promise<void> {
    if (!this.currentSessionId) return;
    // Capture the session id at send-time so late stream events apply to the
    // right session even if the user navigates away.
    const sessionId = this.currentSessionId;

    // Remove greeting / empty-state once the user sends something
    const panel = this.containerEl.querySelector(
      ".obsidian-agents-chat-panel"
    ) as HTMLElement | null;
    if (panel) {
      panel.classList.remove("obsidian-agents-empty");
      panel.querySelector(".obsidian-agents-greeting")?.remove();
    }

    let agentMsgId: string | null = null;

    const onUI = (fn: () => void) => {
      // Only touch the DOM if the targeted session is the one on screen.
      if (sessionId === this.currentSessionId) fn();
    };

    const handlers: StreamHandlers = {
      onStart: ({ userMsg, agentMsg }) => {
        agentMsgId = agentMsg.id;
        onUI(() => {
          // Pass shallow copies so the message list's bubble holds its own
          // state. The plugin's wrappedHandlers also mutate the original
          // `agentMsg` (so session persistence stays in sync); if we shared
          // the reference, the first onToken would double-append — plugin
          // sets `agentMsg.content = "Yes"`, then our updater reads the same
          // object back as "Yes" and appends again to "YesYes".
          this.messageList?.addMessage({ ...userMsg }, this.plugin);
          this.messageList?.addMessage({ ...agentMsg }, this.plugin);
          this.messageList?.setStreaming(agentMsg.id, true);
          this.messageList?.scrollToBottom();
          this.composer?.setStreaming(true);
        });
      },
      onToken: (token: string) => {
        onUI(() => {
          if (!agentMsgId || !this.messageList) return;
          this.messageList.updateMessage(
            agentMsgId,
            (msg) => ({ ...msg, content: msg.content + token }),
            this.plugin
          );
          // Respect user's scroll position: only pin to bottom if they're
          // already there. Without this, scrolling up mid-stream teleports
          // back down on every token.
          this.messageList.scrollToBottomIfFollowing();
        });
      },
      onThinking: (thinking: string) => {
        onUI(() => {
          if (!agentMsgId || !this.messageList) return;
          this.messageList.updateMessage(
            agentMsgId,
            (msg) => ({ ...msg, metadata: { ...msg.metadata, thinking } }),
            this.plugin
          );
        });
      },
      onToolCall: (toolCall: ToolCall) => {
        onUI(() => {
          if (!agentMsgId || !this.messageList) return;
          // Tool calls streamed from the gateway already executed server-side,
          // so we render them as read-only trace entries rather than gated
          // permission applets. Dangerous-command approval is enforced by the
          // Hermes API server config (approvals.mode) and surfaced through the
          // gateway's own channels — the Obsidian client has no round-trip
          // path for it.
          this.messageList.updateMessage(
            agentMsgId,
            (msg) => {
              const calls = msg.metadata?.toolCalls ?? [];
              // De-dupe: same id shouldn't render twice.
              if (calls.some((c) => c.id === toolCall.id)) return msg;
              return {
                ...msg,
                metadata: { ...msg.metadata, toolCalls: [...calls, toolCall] },
              };
            },
            this.plugin
          );
          this.messageList.scrollToBottomIfFollowing();
        });
      },
      onLayoutBlock: (block: LayoutBlock) => {
        onUI(() => {
          if (!agentMsgId || !this.messageList) return;
          this.messageList.updateMessage(
            agentMsgId,
            (msg) => ({
              ...msg,
              attachments: [
                ...msg.attachments,
                {
                  id: generateId(),
                  type: block.type === "image" ? "image" : "file",
                  name: block.content.slice(0, 20),
                  path: block.content,
                  dataUrl: block.content,
                },
              ],
            }),
            this.plugin
          );
        });
      },
      onComplete: (metadata) => {
        onUI(() => {
          if (agentMsgId && this.messageList) {
            this.messageList.setStreaming(agentMsgId, false);
            this.messageList.updateMessage(
              agentMsgId,
              (msg) => ({ ...msg, metadata: { ...msg.metadata, ...metadata } }),
              this.plugin
            );
          }
          this.composer?.setStreaming(false);
        });
      },
      onError: (error) => {
        onUI(() => {
          if (agentMsgId && this.messageList) {
            this.messageList.setStreaming(agentMsgId, false);
            this.messageList.updateMessage(
              agentMsgId,
              (msg) => ({ ...msg, content: msg.content + `\n\n[Error: ${error.message}]` }),
              this.plugin
            );
          }
          this.composer?.setStreaming(false);
        });
      },
    };

    await this.plugin.sendMessage(sessionId, text, attachments, handlers, skillIds);
  }

  showPermissionWidget(toolCall: ToolCall): void {
    if (!this.messageList) return;
    const widgetContainer = this.messageList.containerEl.createDiv({
      cls: "obsidian-agents-permission-slot",
    });

    const widget = new PermissionWidget(widgetContainer, toolCall, (decision) => {
      this.plugin.resolvePermission(toolCall.id, decision);
      widget.unload();
      widgetContainer.remove();
    });
    this.addChild(widget);
    this.messageList.scrollToBottom();
  }
}
