export interface ChatSession {
  id: string;
  name: string;
  folderId: string | null;
  messages: ChatMessage[];
  createdAt: number;
  updatedAt: number;
  model: string;
}

export interface SessionFolder {
  id: string;
  name: string;
  parentId: string | null;
  collapsed: boolean;
}

export interface ChatMessage {
  id: string;
  role: "user" | "agent" | "system";
  content: string;
  attachments: Attachment[];
  timestamp: number;
  metadata?: MessageMetadata;
  // Slash-skills invoked for this message (e.g. ["automation", "web"]).
  // User messages only. Rendered as chips in the bubble so there's a
  // visible trace of which skills were applied per-request. Capped at 3
  // by the composer UI.
  skillIds?: string[];
}

export interface Attachment {
  id: string;
  type: "image" | "file" | "pdf";
  name: string;
  path: string;
  dataUrl?: string;
}

export interface MessageMetadata {
  model?: string;
  tokensUsed?: number;
  tokensTotal?: number;
  durationMs?: number;
  thinking?: string;
  toolCalls?: ToolCall[];
}

export type LayoutPosition = "left" | "right" | "above" | "below" | "inline";

export interface LayoutBlock {
  type: "text" | "image" | "applet";
  content: string;
  position: LayoutPosition;
  width?: string;
}

export interface ToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
  status: "pending" | "accepted" | "denied" | "running" | "completed" | "failed";
  result?: string;
}

export interface PendingPermission {
  toolCall: ToolCall;
  resolve: (decision: PermissionDecision) => void;
}

export type PermissionDecision =
  | { action: "accept" }
  | { action: "deny" }
  | { action: "explain"; reason: string };

export type ApprovalMode = "manual" | "smart" | "off";

export interface ObsidianAgentsSettings {
  agentName: string;
  model: string;
  effortLevel: "low" | "medium" | "high";
  hermesGatewayUrl: string;
  hermesApiKey: string;
  contextWindow: number;
  approvalMode: ApprovalMode;
  // Local callback server — lets scheduled/background jobs run by the gateway
  // deliver their results back into a specific chat, a new chat, a vault note,
  // or a toast. See src/callback/ for details.
  callbackEnabled: boolean;
  callbackHost: string;   // default "127.0.0.1"
  callbackPort: number;   // 0 = auto-pick an ephemeral port
  callbackToken: string;  // shared secret — auto-generated on first run
}

export const DEFAULT_SETTINGS: ObsidianAgentsSettings = {
  agentName: "Hermes",
  model: "auto",
  effortLevel: "medium",
  hermesGatewayUrl: "",
  hermesApiKey: "",
  contextWindow: 128000,
  approvalMode: "manual",
  callbackEnabled: true,
  callbackHost: "127.0.0.1",
  callbackPort: 0,
  callbackToken: "",
};

// --- Delivery channels -----------------------------------------------------
// A channel is the destination a scheduled/background job writes its result
// to. The registry is open: anyone can drop a new channel into
// src/callback/channels/ and register it in src/callback/channels/index.ts.

export interface DeliveryPayload {
  // Primary body — markdown, rendered the same way as any agent message.
  content: string;
  // Optional short title for channels that need one (e.g. new-chat, note).
  title?: string;
  // Free-form metadata the channel may consume (jobId, scheduled time, etc).
  // Surfaced to the user so they can see what fired.
  metadata?: Record<string, unknown>;
}

export interface DeliveryRequest {
  channel: string;           // e.g. "chat", "new-chat", "note", "notice"
  // When channel === "chat" this is the session id the job should reply into.
  // Injected into the system prompt so the agent knows the current session.
  sessionId?: string;
  // Channel-specific target. For "note" this is a vault path. Ignored otherwise.
  target?: string;
  payload: DeliveryPayload;
}

export interface MentionItem {
  type: "file" | "folder";
  path: string;
  displayName: string;
}

export interface StreamHandlers {
  onStart?: (info: { userMsg: ChatMessage; agentMsg: ChatMessage }) => void;
  onToken: (token: string) => void;
  onThinking: (thinking: string) => void;
  onToolCall: (toolCall: ToolCall) => void;
  onLayoutBlock: (block: LayoutBlock) => void;
  onComplete: (metadata: Partial<MessageMetadata>) => void;
  onError: (error: Error) => void;
}
