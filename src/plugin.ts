import {
  Plugin,
  WorkspaceLeaf,
  PluginSettingTab,
  Setting,
  App,
  Notice,
} from "obsidian";
import {
  getHermesConfigPath,
  hermesConfigExists,
  readApprovalMode,
  writeApprovalMode,
} from "./lib/hermesConfig";
import type { ApprovalMode } from "./types";
import {
  ObsidianAgentsSettings,
  ChatSession,
  ChatMessage,
  Attachment,
  ToolCall,
  PermissionDecision,
  StreamHandlers,
  SessionFolder,
} from "./types";
import { loadSettings, saveSettings } from "./settings";
import { loadSessions, saveSessions, createSession, createFolder } from "./storage";
import { ChatView, CHAT_VIEW_TYPE } from "./ui/ChatView";
import { HermesInterface } from "./hermes";
import { resolveMentions, injectContextIntoMessage } from "./features/mentions";
import { generateId } from "./lib/id";
import { ChannelRegistry } from "./callback/channels";
import type { DeliveryContext } from "./callback/channels/types";
import { startCallbackServer, type CallbackServer } from "./callback/server";
import type { DeliveryPayload } from "./types";

export default class ObsidianAgentsPlugin extends Plugin {
  settings: ObsidianAgentsSettings;
  sessions: ChatSession[] = [];
  foldersList: SessionFolder[] = [];
  activeSessionId: string | null = null;
  private hermes: HermesInterface | null = null;
  private chatView: ChatView | null = null;
  private pendingPermissions = new Map<
    string,
    { resolve: (d: PermissionDecision) => void; reject: (e: Error) => void }
  >();
  // Per-session stream state. Keyed by sessionId so multiple threads can
  // stream concurrently without clobbering each other.
  private activeStreams = new Map<
    string,
    { messageId: string; abort: AbortController; startTime: number }
  >();
  private channelRegistry = new ChannelRegistry();
  private callbackServer: CallbackServer | null = null;

  async onload(): Promise<void> {
    await this.loadSettings();
    // Reconcile `approvalMode` with the live Hermes config on disk. The
    // config file is the source of truth for other Hermes clients (CLI, TUI,
    // Telegram), so mirror whatever it currently says.
    try {
      const onDisk = readApprovalMode();
      if (onDisk && onDisk !== this.settings.approvalMode) {
        this.settings.approvalMode = onDisk;
        await this.savePluginSettings();
      }
    } catch {
      /* config file unreadable — keep the stored value */
    }
    this.hermes = new HermesInterface(this.settings);
    await this.loadSessionsData();

    this.registerView(CHAT_VIEW_TYPE, (leaf) => {
      const view = new ChatView(leaf, this);
      this.chatView = view;
      return view;
    });

    this.addRibbonIcon("message-circle", "Open Obsidian Agents", () => {
      this.activateView();
    });

    this.addCommand({
      id: "open-obsidian-agents",
      name: "Open Obsidian Agents",
      callback: () => this.activateView(),
    });

    this.addSettingTab(new ObsidianAgentsSettingTab(this.app, this));

    await this.startCallbackServerIfEnabled();

    if (this.sessions.length === 0) {
      const session = createSession(null);
      session.name = "New Chat";
      this.sessions.push(session);
      this.activeSessionId = session.id;
      await this.saveSessionsData();
    } else {
      // Always land on a fresh greeting screen after Obsidian reloads.
      // Reuse an existing empty session if there is one; otherwise start
      // a new one. The previously-active session is still in the sidebar
      // and one click away.
      const emptySession =
        this.sessions.find((s) => s.folderId === null && s.messages.length === 0) ??
        (() => {
          const s = createSession(null);
          this.sessions.push(s);
          return s;
        })();
      this.activeSessionId = emptySession.id;
    }
  }

  onunload(): void {
    this.chatView = null;
    // Stop the callback server on unload. Obsidian will unload us on reload
    // and plugin-disable, so leaving the socket open leaks a port.
    if (this.callbackServer) {
      this.callbackServer.stop().catch(() => {});
      this.callbackServer = null;
    }
  }

  // --- Callback server --------------------------------------------------

  private buildDeliveryContext(): DeliveryContext {
    return {
      app: this.app,
      getSession: (id) => this.getSession(id),
      appendAgentMessage: (sessionId, payload) => {
        this.deliverToSession(sessionId, payload);
      },
      createSessionWithMessage: (name, payload) => {
        const s = createSession(null);
        s.name = name || s.name;
        this.sessions.push(s);
        this.deliverToSession(s.id, payload);
        // Surface a toast so the user can find the new session in the
        // sidebar — otherwise a scheduled result appearing in an unopened
        // chat is easy to miss.
        new Notice(`New chat "${s.name}" created from scheduled result`);
        this.chatView?.renderSidebar(this.sessions, this.foldersList, this.activeSessionId);
        return s;
      },
    };
  }

  private deliverToSession(sessionId: string, payload: DeliveryPayload): void {
    const session = this.getSession(sessionId);
    if (!session) return;

    const agentMsg: ChatMessage = {
      id: generateId(),
      role: "agent",
      content: payload.content,
      attachments: [],
      timestamp: Date.now(),
      metadata: payload.metadata
        ? { // Surface the scheduling metadata so the user can see what fired.
            ...(payload.title ? { model: `(delivered) ${payload.title}` } : {}),
          }
        : undefined,
    };
    session.messages.push(agentMsg);
    session.updatedAt = Date.now();
    this.saveSessionsData();

    // If the delivered-to session is the one currently open, rerender.
    if (this.activeSessionId === sessionId) {
      this.chatView?.loadSession(session);
    } else {
      this.chatView?.renderSidebar(this.sessions, this.foldersList, this.activeSessionId);
    }
  }

  private async startCallbackServerIfEnabled(): Promise<void> {
    if (!this.settings.callbackEnabled) return;

    // Auto-generate a token on first run so out-of-the-box use is secure.
    if (!this.settings.callbackToken) {
      this.settings.callbackToken = generateId() + generateId();
      await this.savePluginSettings();
    }

    try {
      this.callbackServer = await startCallbackServer({
        host: this.settings.callbackHost || "127.0.0.1",
        port: this.settings.callbackPort || 0,
        token: this.settings.callbackToken,
        registry: this.channelRegistry,
        context: this.buildDeliveryContext(),
        onError: (err) => {
          // Non-fatal — log and keep the plugin usable.
          console.error("[obsidian-agents] callback server error", err);
        },
      });
    } catch (err) {
      console.error("[obsidian-agents] failed to start callback server", err);
      new Notice(
        `Obsidian Agents: callback server failed to start (${
          err instanceof Error ? err.message : String(err)
        }). Scheduled jobs won't be able to reply back until this is fixed in settings.`
      );
    }
  }

  async restartCallbackServer(): Promise<void> {
    if (this.callbackServer) {
      await this.callbackServer.stop();
      this.callbackServer = null;
    }
    await this.startCallbackServerIfEnabled();
  }

  getCallbackUrl(): string | null {
    return this.callbackServer?.url() ?? null;
  }

  getCallbackToken(): string {
    return this.settings.callbackToken;
  }

  async activateView(): Promise<void> {
    const { workspace } = this.app;
    let leaf = workspace.getLeavesOfType(CHAT_VIEW_TYPE)[0] as WorkspaceLeaf | undefined;
    if (!leaf) {
      leaf = workspace.getRightLeaf(false);
      if (!leaf) return;
      await leaf.setViewState({ type: CHAT_VIEW_TYPE, active: true });
    }
    workspace.revealLeaf(leaf);
  }

  async loadSettings(): Promise<void> {
    this.settings = await loadSettings(this);
  }

  async savePluginSettings(): Promise<void> {
    await saveSettings(this, this.settings);
  }

  async loadSessionsData(): Promise<void> {
    const data = await loadSessions(this.app);
    this.sessions = data.sessions;
    this.foldersList = data.folders;
  }

  async saveSessionsData(): Promise<void> {
    // Only persist sessions that have at least one user message. Fresh,
    // unused "New Chat" sessions stay in memory but are not written to disk.
    const persistable = this.sessions.filter((s) =>
      s.messages.some((m) => m.role === "user")
    );
    await saveSessions(this.app, {
      sessions: persistable,
      folders: this.foldersList,
    });
  }

  getSession(id: string): ChatSession | undefined {
    return this.sessions.find((s) => s.id === id);
  }

  createSession(folderId: string | null = null): ChatSession {
    // Reuse an existing empty session instead of piling up "New Chat" entries.
    const existingEmpty = this.sessions.find(
      (s) => s.folderId === folderId && s.messages.length === 0
    );
    if (existingEmpty) {
      this.activeSessionId = existingEmpty.id;
      this.chatView?.loadSession(existingEmpty);
      this.chatView?.renderSidebar(this.sessions, this.foldersList, this.activeSessionId);
      return existingEmpty;
    }

    const session = createSession(folderId);
    // Leave the name as "New Chat" — it'll be renamed from the first user
    // message. The session also won't show up in the sidebar until a message
    // is sent (see Sidebar.render filter).
    this.sessions.push(session);
    this.activeSessionId = session.id;
    this.chatView?.loadSession(session);
    this.chatView?.renderSidebar(this.sessions, this.foldersList, this.activeSessionId);
    return session;
  }

  createFolder(parentId: string | null = null): void {
    const folder = createFolder(parentId);
    folder.name = `Folder ${this.foldersList.length + 1}`;
    this.foldersList.push(folder);
    this.saveSessionsData();
    this.chatView?.renderSidebar(this.sessions, this.foldersList, this.activeSessionId);
  }

  deleteSession(id: string): void {
    this.sessions = this.sessions.filter((s) => s.id !== id);
    if (this.activeSessionId === id) {
      this.activeSessionId = this.sessions.length > 0 ? this.sessions[0].id : null;
      if (this.activeSessionId) {
        const session = this.getSession(this.activeSessionId);
        if (session) this.chatView?.loadSession(session);
      }
    }
    this.saveSessionsData();
    this.chatView?.renderSidebar(this.sessions, this.foldersList, this.activeSessionId);
  }

  renameSession(id: string, name: string): void {
    const session = this.getSession(id);
    if (session) {
      session.name = name;
      session.updatedAt = Date.now();
      this.saveSessionsData();
      this.chatView?.renderSidebar(this.sessions, this.foldersList, this.activeSessionId);
    }
  }

  moveSession(id: string, folderId: string | null): void {
    const session = this.getSession(id);
    if (session) {
      session.folderId = folderId;
      session.updatedAt = Date.now();
      this.saveSessionsData();
      this.chatView?.renderSidebar(this.sessions, this.foldersList, this.activeSessionId);
    }
  }

  deleteFolder(id: string): void {
    // Move child sessions to top level
    for (const session of this.sessions) {
      if (session.folderId === id) {
        session.folderId = null;
      }
    }
    // Move child folders to top level
    for (const folder of this.foldersList) {
      if (folder.parentId === id) {
        folder.parentId = null;
      }
    }
    this.foldersList = this.foldersList.filter((f) => f.id !== id);
    this.saveSessionsData();
    this.chatView?.renderSidebar(this.sessions, this.foldersList, this.activeSessionId);
  }

  moveFolder(id: string, parentId: string | null): void {
    const folder = this.foldersList.find((f) => f.id === id);
    if (!folder) return;
    // Guard against cycles: don't let a folder become a descendant of itself.
    let cursor: string | null = parentId;
    while (cursor) {
      if (cursor === id) return;
      const next: SessionFolder | undefined = this.foldersList.find((f) => f.id === cursor);
      cursor = next ? next.parentId : null;
    }
    folder.parentId = parentId;
    this.saveSessionsData();
    this.chatView?.renderSidebar(this.sessions, this.foldersList, this.activeSessionId);
  }

  renameFolder(id: string, name: string): void {
    const folder = this.foldersList.find((f) => f.id === id);
    if (folder) {
      folder.name = name;
      this.saveSessionsData();
      this.chatView?.renderSidebar(this.sessions, this.foldersList, this.activeSessionId);
    }
  }

  toggleFolderCollapse(id: string): void {
    const folder = this.foldersList.find((f) => f.id === id);
    if (folder) {
      folder.collapsed = !folder.collapsed;
      this.saveSessionsData();
      this.chatView?.renderSidebar(this.sessions, this.foldersList, this.activeSessionId);
    }
  }

  selectSession(id: string): void {
    this.activeSessionId = id;
    const session = this.getSession(id);
    if (session) {
      this.chatView?.loadSession(session);
    }
    this.chatView?.renderSidebar(this.sessions, this.foldersList, this.activeSessionId);
  }

  isStreaming(sessionId: string): boolean {
    return this.activeStreams.has(sessionId);
  }

  getStreamMessageId(sessionId: string): string | null {
    return this.activeStreams.get(sessionId)?.messageId ?? null;
  }

  getStreamStartTime(sessionId: string): number | null {
    return this.activeStreams.get(sessionId)?.startTime ?? null;
  }

  abortStream(sessionId: string): void {
    const stream = this.activeStreams.get(sessionId);
    if (stream) {
      stream.abort.abort();
      this.activeStreams.delete(sessionId);
    }
  }

  async sendMessage(
    sessionId: string,
    text: string,
    attachments: Attachment[],
    handlers: StreamHandlers,
    skillId: string | null = null
  ): Promise<string | null> {
    const session = this.getSession(sessionId);
    if (!session) return null;

    // Build user message — content stays as the raw user text for display.
    // File context is injected separately into the API payload only.
    const userMsg: ChatMessage = {
      id: generateId(),
      role: "user",
      content: text,
      attachments,
      timestamp: Date.now(),
      skillId: skillId ?? undefined,
    };

    // Resolve @mentions → build an API-only version with file bodies injected.
    // The stored message always keeps the original text so the bubble shows
    // what the user actually typed, not a wall of file content.
    const { text: resolvedText, context } = await resolveMentions(text, this.app);
    let apiUserMsg: ChatMessage = { ...userMsg, content: resolvedText };
    if (Object.keys(context).length > 0) {
      apiUserMsg = injectContextIntoMessage(apiUserMsg, context);
    }

    // Auto-name a fresh session from the first user message
    const wasEmpty = !session.messages.some((m) => m.role === "user");
    session.messages.push(userMsg);      // store clean version
    session.updatedAt = Date.now();
    if (wasEmpty) {
      const snippet = text.trim().replace(/\s+/g, " ").slice(0, 48);
      session.name = snippet || "New Chat";
      this.chatView?.renderSidebar(this.sessions, this.foldersList, this.activeSessionId);
    }
    // Build API payload: history up to (but not including) the last user msg,
    // then substitute the context-injected version for the API call only.
    const requestMessages = [
      ...session.messages.slice(0, -1), // everything before userMsg
      apiUserMsg,                        // context-injected, never stored
    ];

    // Build agent placeholder
    const agentMsgId = generateId();
    const agentMsg: ChatMessage = {
      id: agentMsgId,
      role: "agent",
      content: "",
      attachments: [],
      timestamp: Date.now(),
    };
    session.messages.push(agentMsg);

    const startTime = Date.now();
    const abort = new AbortController();
    this.activeStreams.set(sessionId, { messageId: agentMsgId, abort, startTime });

    handlers.onStart?.({ userMsg, agentMsg });

    // Stream handlers that update session + UI
    const wrappedHandlers: StreamHandlers = {
      onToken: (token: string) => {
        agentMsg.content += token;
        handlers.onToken(token);
      },
      onThinking: (thinking: string) => {
        agentMsg.metadata = { ...agentMsg.metadata, thinking };
        handlers.onThinking(thinking);
      },
      onToolCall: (toolCall: ToolCall) => {
        const calls = agentMsg.metadata?.toolCalls ?? [];
        agentMsg.metadata = {
          ...agentMsg.metadata,
          toolCalls: [...calls, toolCall],
        };
        handlers.onToolCall(toolCall);
      },
      onLayoutBlock: (block) => {
        handlers.onLayoutBlock(block);
      },
      onComplete: (metadata) => {
        const durationMs = Date.now() - startTime;
        agentMsg.metadata = {
          ...agentMsg.metadata,
          ...metadata,
          durationMs,
        };
        session.updatedAt = Date.now();
        this.activeStreams.delete(sessionId);
        this.saveSessionsData();
        handlers.onComplete(metadata);
      },
      onError: (error) => {
        agentMsg.content += `\n\n[Error: ${error.message}]`;
        this.activeStreams.delete(sessionId);
        this.saveSessionsData();
        handlers.onError(error);
      },
    };

    if (!this.hermes) {
      this.hermes = new HermesInterface(this.settings);
    }
    await this.hermes.sendMessage(requestMessages, wrappedHandlers, abort, {
      sessionId,
      callbackUrl: this.getCallbackUrl(),
      callbackToken: this.settings.callbackEnabled ? this.getCallbackToken() : null,
      skillId,
    });
    return agentMsgId;
  }

  async requestPermission(toolCall: ToolCall): Promise<PermissionDecision> {
    return new Promise((resolve, reject) => {
      this.pendingPermissions.set(toolCall.id, { resolve, reject });
      this.chatView?.showPermissionWidget(toolCall);
    });
  }

  resolvePermission(toolCallId: string, decision: PermissionDecision): void {
    const pending = this.pendingPermissions.get(toolCallId);
    if (pending) {
      pending.resolve(decision);
      this.pendingPermissions.delete(toolCallId);
    }
  }

  denyPermission(toolCallId: string): void {
    const pending = this.pendingPermissions.get(toolCallId);
    if (pending) {
      pending.resolve({ action: "deny" });
      this.pendingPermissions.delete(toolCallId);
    }
  }
}

class ObsidianAgentsSettingTab extends PluginSettingTab {
  plugin: ObsidianAgentsPlugin;

  constructor(app: App, plugin: ObsidianAgentsPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.createEl("h2", { text: "Obsidian Agents Settings" });

    new Setting(containerEl)
      .setName("Agent name")
      .setDesc("The name displayed for the AI agent")
      .addText((text) =>
        text
          .setPlaceholder("Hermes")
          .setValue(this.plugin.settings.agentName)
          .onChange(async (value) => {
            this.plugin.settings.agentName = value || "Hermes";
            await this.plugin.savePluginSettings();
            this.plugin.chatView?.syncSettings();
          })
      );

    new Setting(containerEl)
      .setName("Model")
      .setDesc("The AI model used by Hermes")
      .addText((text) =>
        text
          .setPlaceholder("auto")
          .setValue(this.plugin.settings.model)
          .onChange(async (value) => {
            this.plugin.settings.model = value || "auto";
            await this.plugin.savePluginSettings();
          })
      );

    new Setting(containerEl)
      .setName("Effort level")
      .setDesc("How much reasoning effort the agent should apply")
      .addDropdown((drop) =>
        drop
          .addOption("low", "Low")
          .addOption("medium", "Medium")
          .addOption("high", "High")
          .setValue(this.plugin.settings.effortLevel)
          .onChange(async (value) => {
            this.plugin.settings.effortLevel = value as "low" | "medium" | "high";
            await this.plugin.savePluginSettings();
          })
      );

    new Setting(containerEl)
      .setName("Hermes gateway URL")
      .setDesc("Optional override. Leave blank to auto-detect from ~/.hermes/.env")
      .addText((text) =>
        text
          .setPlaceholder("http://localhost:8080/v1")
          .setValue(this.plugin.settings.hermesGatewayUrl)
          .onChange(async (value) => {
            this.plugin.settings.hermesGatewayUrl = value;
            await this.plugin.savePluginSettings();
          })
      );

    new Setting(containerEl)
      .setName("Hermes API key")
      .setDesc("Optional override. Leave blank to auto-detect from ~/.hermes/.env")
      .addText((text) =>
        text
          .setPlaceholder("API_SERVER_KEY from ~/.hermes/.env")
          .setValue(this.plugin.settings.hermesApiKey)
          .onChange(async (value) => {
            this.plugin.settings.hermesApiKey = value;
            await this.plugin.savePluginSettings();
          })
      );

    // --- Approvals ------------------------------------------------------
    containerEl.createEl("h3", { text: "Dangerous command approvals" });

    const approvalDesc = containerEl.createEl("p", {
      cls: "setting-item-description",
    });
    approvalDesc.createSpan({
      text:
        "How Hermes handles commands that could modify your system (rm -rf, " +
        "chmod 777, dd, DROP TABLE, etc). This writes to ",
    });
    approvalDesc.createEl("code", { text: "~/.hermes/config.yaml" });
    approvalDesc.createSpan({
      text: " and applies to every Hermes client (CLI, TUI, this plugin).",
    });

    if (!hermesConfigExists()) {
      const warn = containerEl.createEl("p", { cls: "setting-item-description" });
      warn.style.color = "var(--text-warning, var(--text-muted))";
      warn.setText(
        `No Hermes config found at ${getHermesConfigPath()}. ` +
          "Run `hermes setup` once, then this setting will take effect."
      );
    }

    new Setting(containerEl)
      .setName("Approval mode")
      .setDesc(
        "Manual: prompt for every dangerous command. " +
          "Smart: an LLM auto-approves low-risk commands and prompts for high-risk ones. " +
          "Off: skip all approval prompts (equivalent to --yolo)."
      )
      .addDropdown((drop) =>
        drop
          .addOption("manual", "Manual — prompt every time (safest)")
          .addOption("smart", "Smart — LLM auto-approves low-risk")
          .addOption("off", "Off — bypass all approvals (--yolo)")
          .setValue(this.plugin.settings.approvalMode)
          .onChange(async (value) => {
            const mode = value as ApprovalMode;
            const previous = this.plugin.settings.approvalMode;
            this.plugin.settings.approvalMode = mode;
            try {
              writeApprovalMode(mode);
              await this.plugin.savePluginSettings();
              new Notice(`Approval mode set to "${mode}".`);
            } catch (err) {
              // Roll back the in-memory value so the dropdown stays truthful.
              this.plugin.settings.approvalMode = previous;
              drop.setValue(previous);
              const msg = err instanceof Error ? err.message : String(err);
              new Notice(`Failed to write Hermes config: ${msg}`);
            }
          })
      );

    // --- Callback server -------------------------------------------------
    containerEl.createEl("h3", { text: "Background-job callback server" });

    const callbackDesc = containerEl.createEl("p", {
      cls: "setting-item-description",
    });
    callbackDesc.createSpan({
      text:
        "Lets scheduled/background jobs deliver their results back into a " +
        "chat, a new chat, a vault note, or a toast. The plugin runs a tiny " +
        "local HTTP server (default ",
    });
    callbackDesc.createEl("code", { text: "127.0.0.1" });
    callbackDesc.createSpan({
      text: ") that your Hermes gateway POSTs to when a job fires. Token-authed.",
    });

    const currentUrl = this.plugin.getCallbackUrl();
    const urlDisplay = containerEl.createEl("p", {
      cls: "setting-item-description",
    });
    urlDisplay.createSpan({ text: "Current endpoint: " });
    urlDisplay.createEl("code", {
      text: currentUrl ? `${currentUrl}/callback` : "(server not running)",
    });

    new Setting(containerEl)
      .setName("Enable callback server")
      .setDesc("Turn off to fully disable background-job delivery.")
      .addToggle((t) =>
        t.setValue(this.plugin.settings.callbackEnabled).onChange(async (value) => {
          this.plugin.settings.callbackEnabled = value;
          await this.plugin.savePluginSettings();
          await this.plugin.restartCallbackServer();
          this.display();
        })
      );

    new Setting(containerEl)
      .setName("Bind host")
      .setDesc(
        '"127.0.0.1" (default) accepts only local connections. Use "0.0.0.0" to accept LAN connections — combine with the token for safety.'
      )
      .addText((text) =>
        text
          .setPlaceholder("127.0.0.1")
          .setValue(this.plugin.settings.callbackHost)
          .onChange(async (value) => {
            this.plugin.settings.callbackHost = value.trim() || "127.0.0.1";
            await this.plugin.savePluginSettings();
          })
      );

    new Setting(containerEl)
      .setName("Bind port")
      .setDesc("0 = pick any free port. Set a fixed port if your gateway needs a stable URL.")
      .addText((text) =>
        text
          .setPlaceholder("0")
          .setValue(String(this.plugin.settings.callbackPort))
          .onChange(async (value) => {
            const n = parseInt(value, 10);
            this.plugin.settings.callbackPort = Number.isFinite(n) && n >= 0 ? n : 0;
            await this.plugin.savePluginSettings();
          })
      );

    new Setting(containerEl)
      .setName("Shared token")
      .setDesc(
        "Required in the Authorization: Bearer header (or ?token= query). Auto-generated on first run."
      )
      .addText((text) =>
        text
          .setValue(this.plugin.settings.callbackToken)
          .onChange(async (value) => {
            this.plugin.settings.callbackToken = value.trim();
            await this.plugin.savePluginSettings();
          })
      )
      .addButton((btn) =>
        btn
          .setButtonText("Regenerate")
          .setWarning()
          .onClick(async () => {
            this.plugin.settings.callbackToken = Math.random()
              .toString(36)
              .slice(2) + Date.now().toString(36) + Math.random().toString(36).slice(2);
            await this.plugin.savePluginSettings();
            await this.plugin.restartCallbackServer();
            this.display();
          })
      );

    new Setting(containerEl)
      .setName("Apply changes")
      .setDesc("Restart the server to pick up host/port/token changes.")
      .addButton((btn) =>
        btn
          .setButtonText("Restart server")
          .setCta()
          .onClick(async () => {
            await this.plugin.restartCallbackServer();
            new Notice("Callback server restarted.");
            this.display();
          })
      );

  }
}
