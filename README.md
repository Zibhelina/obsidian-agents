# Obsidian Agents

A high-quality, AI-native chat interface for Obsidian. Obsidian Agents brings the power of LLM agents directly into your knowledge base, turning your vault into a conversational workspace where you can reason, create, and build alongside an AI that understands your notes, files, and context.

## Table of Contents

- [What is Obsidian Agents?](#what-is-obsidian-agents)
- [Why It Matters](#why-it-matters)
- [Requirements](#requirements)
- [Installation](#installation)
- [Getting Started](#getting-started)
- [Feature Guide](#feature-guide)
  - [Chat Interface](#chat-interface)
  - [Session Management](#session-management)
  - [Rich Media & Attachments](#rich-media--attachments)
  - [Vault Mentions](#vault-mentions)
  - [Hermes Commands](#hermes-commands)
  - [Thinking Traces & Metrics](#thinking-traces--metrics)
  - [Dynamic Layouts](#dynamic-layouts)
  - [Inline Applets](#inline-applets)
  - [Rich Layout Blocks](#rich-layout-blocks)
  - [Reply & Quote](#reply--quote)
  - [Term Glossary](#term-glossary)
  - [Settings](#settings)
- [Architecture](#architecture)
  - [Project Structure](#project-structure)
  - [Data Flow](#data-flow)
  - [Key Subsystems](#key-subsystems)
  - [How to Tweak It](#how-to-tweak-it)
- [Development](#development)
- [License](#license)

---

## What is Obsidian Agents?

Obsidian Agents is an Obsidian plugin that embeds a full-featured chat interface inside your vault. Unlike generic AI chatbots, it is deeply integrated with your knowledge base: you can mention files and folders with `@`, attach images and PDFs, organize conversations into folders, and render interactive applets and rich layouts directly inside chat messages.

The plugin connects to a Hermes gateway (or any OpenAI-compatible API) to stream LLM responses in real time, complete with reasoning traces, tool-call activity, token counts, and timing metrics.

### What It Solves

- **Contextual AI**: Generic chatbots don't know about your notes. Obsidian Agents injects vault files into the conversation context so the AI reasons over your actual knowledge base.
- **Organization**: Chat histories pile up and become unmanageable. Folder-based session management, drag-and-drop reordering, and date-grouped sidebars keep everything structured.
- **Rich Output**: Plain markdown is limiting. Agents can render interactive HTML/React applets, image galleries, maps, carousels, and split-layout articles — all inside a chat bubble.
- **Transparency**: Hidden reasoning makes it hard to trust AI output. The Thinking Trace drawer shows every step, tool call, and duration.
- **Unified Workflow**: No more copy-pasting between Obsidian and a browser tab. Everything happens inside your vault.

---

## Why It Matters

Modern knowledge work is conversational. You don't just *store* notes — you interrogate them, synthesize them, and turn them into action. Obsidian Agents treats your vault as a living workspace where:

- **Research** becomes a dialogue (`@"Literature Review.md" what are the gaps?`).
- **Coding** gets an interactive partner (agents render live HTML demos and diagrams).
- **Planning** stays organized (project folders with nested sessions and persistent history).
- **Reasoning** is inspectable (every thought process is logged, timed, and reviewable).

By combining the permanence of a knowledge base with the fluidity of conversational AI, Obsidian Agents turns your second brain into a collaborative first-class citizen.

---

## Requirements

### Mandatory

1. **Obsidian** v1.6.0 or newer (desktop only — the plugin uses Node.js APIs for streaming).
2. **Node.js** v18+ (for building the plugin from source).
3. **Hermes Gateway** (or any OpenAI-compatible API endpoint). The plugin reads connection details from `~/.hermes/.env` or accepts manual overrides in settings.

### Optional but Recommended

- **Hermes CLI** — provides the gateway, skill registry, and unified config file (`~/.hermes/config.yaml`).
- **Git** — for cloning the repository.
- **npm** — comes with Node.js; used to install dependencies and build.

---

## Installation

### From Source (Recommended)

1. **Clone the repository** into your vault's `.obsidian/plugins/` folder:

   ```bash
   cd /path/to/your/vault/.obsidian/plugins/
   git clone https://github.com/Zibhelina/Obsidian-Agent-Chat.git obsidian-agents
   cd obsidian-agents
   ```

2. **Install dependencies and build**:

   ```bash
   npm install
   npm run build
   ```

3. **Enable the plugin** in Obsidian:
   - Open **Settings → Community plugins**.
   - Turn off **Safe mode** if it is on.
   - Enable **Obsidian Agents**.

### Development (Live Reload)

If you want to hack on the plugin, start the watcher:

```bash
npm run dev
```

This rebuilds `main.js` automatically whenever you save a source file. You still need to **reload Obsidian** (Cmd/Ctrl+R, or toggle the plugin off/on) to load the new bundle.

---

## Getting Started

### Opening the Chat

Once enabled, open Obsidian Agents via:

- The **message-circle** icon in the left ribbon.
- The Command Palette (`Ctrl/Cmd+P`) → `Obsidian Agents: Open Obsidian Agents`.

The view opens as a right-side panel containing:

- **Sidebar** (left) — session tree with folders.
- **Message list** (center) — scrollable conversation history.
- **Composer** (bottom) — input area with attachments, mentions, and send.
- **Status bar** (bottom) — model name, token count, and elapsed time.

### Your First Message

1. Click **New chat** (square-pen icon) in the sidebar header.
2. Type a message in the composer and press **Enter** (or click the arrow button).
3. The agent streams its response in real time. A "Thinking..." pill appears above the bubble — click it to inspect reasoning and tool calls.

### Quick Keyboard Reference

| Shortcut | Action |
|----------|--------|
| `Ctrl/Cmd + Enter` | Send message |
| `Shift + Enter` | New line in composer |
| `@` | Mention a vault file or folder |
| `/` | Trigger Hermes command autocomplete |
| `Escape` | Close popovers / drawers |

---

## Feature Guide

### Chat Interface

The chat panel is the heart of the plugin. Messages are rendered as bubbles: user messages on the right, agent messages on the left. Agent messages support full Markdown rendering via Obsidian's native `MarkdownRenderer`, including headings, tables, code blocks, math, and internal links.

Every agent message has:

- A **thinking trace pill** (`Thought for 1m 13s · 2 tools`) that opens a detailed Activity drawer.
- **Action buttons** (copy, reply) that appear on hover.
- **Streaming indicator** — three animated dots while the response is in flight.

### Session Management

Sessions are persistent chat histories stored in `.obsidian/obsidian-agents-sessions.json`.

**Sidebar features:**

- **Folders** — create nested projects, collapse/expand them, and drag sessions or subfolders into them.
- **Date grouping** — top-level sessions are grouped into *Today*, *Yesterday*, *Last 7 days*, and *Older*.
- **Drag-and-drop** — reorder sessions by dragging them onto folders or back to the root.
- **Inline rename** — double-click any session or folder name to edit it in place.
- **Context menus** — right-click for rename, move, or delete.

Empty sessions (no user messages) are kept in memory but not saved to disk, preventing clutter.

### Rich Media & Attachments

The composer supports multiple ways to attach files:

- **Paste** (`Ctrl/Cmd+V`) — images from clipboard are converted to data URLs and sent as multimodal content.
- **Drag & drop** — drop files from your OS or from inside the vault.
- **Plus button** — click the `+` icon to select files from disk.

Supported types:

| Type | Handling |
|------|----------|
| Images (PNG, JPG, GIF, WebP, SVG) | Rendered inline; click for lightbox |
| PDFs | Sent as file references |
| Other files | Sent as file references |

User images appear above the text bubble; non-image files appear below it.

### Vault Mentions

Type `@` in the composer to open a fuzzy-search dropdown of every file and folder in your vault. Select an item to insert a mention chip.

When the message is sent, the plugin:

1. Reads the file contents (skips binary files safely).
2. Injects them as `<context file="...">...</context>` blocks into the API payload.
3. Displays the original message cleanly (without dumping file contents into the bubble).

This lets you ask questions about specific notes without polluting the chat history.

### Hermes Commands

Type `/` at the start of a line to trigger command autocomplete. The built-in commands include:

`/help`, `/model`, `/tools`, `/memory`, `/settings`, `/clear`, `/save`, `/load`, `/export`

Use arrow keys to navigate and `Enter` to accept. The plugin replaces the `/query` text with the selected command.

### Thinking Traces & Metrics

Every agent message carries metadata:

- **Model name** — which LLM answered.
- **Token count** — total tokens consumed (prompt + completion).
- **Duration** — wall-clock time from first token to last.
- **Thinking** — reasoning text emitted by the model (e.g., `<thinking>` tags or OpenRouter `reasoning` fields).
- **Tool calls** — every tool invocation with name, status, and argument chips.

Click the **thinking pill** to open a right-side Activity drawer that interleaves reasoning paragraphs and tool calls in a timeline, similar to ChatGPT's Activity panel.

### Dynamic Layouts

Agent responses can position images and applets relative to text using layout directives. The LayoutEngine scans rendered HTML for special attributes and repositions elements using CSS floats and flexbox.

Supported positions: `left`, `right`, `above`, `below`, `inline`.

### Inline Applets

Agents can embed **interactive HTML or React 18 components** inside their replies. These render in sandboxed iframes that inherit the user's Obsidian theme via CSS custom properties.

**Syntax:**

````markdown
```obsidian-agents-applet position=right width=320px height=240px
<!-- raw HTML + vanilla JS -->
<div>Hello World</div>
```
````

or

````markdown
```obsidian-agents-react position=right width=320px
const App = () => {
  return React.createElement('div', null, 'Hello React');
};
```
````

**Rules:**
- React 18 is pre-imported as `React`; `createRoot` is available.
- No JSX transpiler — use `React.createElement`.
- Extra libraries can be imported via CDN URLs (`https://esm.sh/...`).
- Applets auto-resize to fit content; a fullscreen button appears on hover.

### Rich Layout Blocks

For polished, media-heavy replies, agents can emit JSON-driven layout blocks instead of plain markdown:

| Block | Purpose |
|-------|---------|
| `obsidian-agents-hero` | Wikipedia-style opener: one large image + thumbnails |
| `obsidian-agents-gallery` | Responsive image grid |
| `obsidian-agents-carousel` | Horizontal scroller with counter |
| `obsidian-agents-map` | Leaflet map with rating pins |
| `obsidian-agents-card-list` | Vertical list of result cards |
| `obsidian-agents-split` | Visual on one side, prose on the other |
| `obsidian-agents-terms` | Silent glossary for inline `[[Label]]{#slug}` pills |

These are parsed from fenced code blocks and mounted into the rendered message after Markdown processing.

### Reply & Quote

Hover over any agent message and click the **reply** button to quote it in your next message. If you have text selected, the selection is quoted; otherwise the entire message is quoted. A dismissible quote bar appears above the composer.

### Term Glossary

The `obsidian-agents-terms` block registers term definitions. Once registered, any inline `[[Label]]{#slug}` marker in the prose becomes a clickable pill that opens a **TermPanel** sliding in from the right. The panel shows:

- Title and summary
- Key facts table
- Hero images
- Markdown sections
- Source citations

This is ideal for encyclopedia-style answers where entities deserve detail-on-demand.

### Settings

Open **Settings → Obsidian Agents** to configure:

| Setting | Description |
|---------|-------------|
| **Agent name** | Display name for the AI (default: "Hermes") |
| **Model** | LLM identifier (default: "auto") |
| **Effort level** | Low / Medium / High reasoning effort |
| **Hermes gateway URL** | Override the auto-detected gateway endpoint |
| **Hermes API key** | Override the key from `~/.hermes/.env` |
| **Approval mode** | Manual / Smart / Off — controls dangerous-command approvals (writes to `~/.hermes/config.yaml`) |

All other configuration (providers, tools, skills) is inherited from your Hermes CLI setup.

---

## Architecture

Obsidian Agents is built as a standard Obsidian plugin with a flat TypeScript source tree, bundled by esbuild into a single `main.js` file.

### Project Structure

```
obsidian-agents/
├── manifest.json              # Obsidian plugin manifest
├── package.json               # Dependencies & build scripts
├── esbuild.config.mjs         # Build configuration
├── tsconfig.json              # TypeScript strict config
├── styles.css                 # All UI styles (auto-loaded by Obsidian)
├── main.ts                    # Entry point — re-exports the plugin class
├── README.md                  # This file
├── LICENSE                    # MIT
└── src/
    ├── plugin.ts              # Main Plugin class: lifecycle, settings, session CRUD, messaging
    ├── types.ts               # Core TypeScript interfaces (ChatSession, ChatMessage, ToolCall, etc.)
    ├── settings.ts            # Settings load/save helpers
    ├── storage.ts             # Session/folder persistence (flat-file JSON in vault)
    ├── hermes.ts              # Gateway communication: SSE streaming, token parsing, reasoning extraction
    ├── tokenizer.ts           # Simple token estimator for the status bar
    ├── lib/
    │   ├── id.ts              # UUID-like ID generator
    │   ├── vault.ts           # Fuzzy vault file search for @mentions
    │   ├── layout.ts          # Layout position enums
    │   └── hermesConfig.ts    # Minimal read/write for ~/.hermes/config.yaml approvals.mode
    ├── features/
    │   ├── mentions.ts        # @mention parsing and file-context injection
    │   ├── attachments.ts     # Clipboard paste, drag-drop, file embed handling
    │   ├── commands.ts        # / command registry and autocomplete filtering
    │   └── applets.ts         # Dynamic applet registry (code-block, chart placeholders)
    └── ui/
        ├── ChatView.ts        # Main Obsidian ItemView; wires all sub-components together
        └── components/
            ├── Sidebar.ts            # Session tree with folders, drag-and-drop, date groups
            ├── Composer.ts           # Input: attachments, mention chips, reply quotes, CM6 editor, slash popover, send/abort button
            ├── LivePreviewEditor.ts  # CodeMirror 6 adapter with inline markdown preview
            ├── MessageList.ts        # Scrollable message container
            ├── MessageBubble.ts      # Individual message renderer (user vs agent, streaming states, actions)
            ├── ThinkingTrace.ts      # Expandable reasoning/trace drawer
            ├── StatusBar.ts          # Model name, token count, timer display
            ├── PermissionWidget.ts   # Accept / Deny / Explain tool-call widgets
            ├── LayoutEngine.ts       # Positions images/applets L/R/above/below; mounts rich layouts and applets
            ├── MentionPopover.ts     # File-search dropdown for @ trigger
            ├── ReplyHandle.ts        # Floating reply-to-selection button
            ├── TermPanel.ts          # Slide-in glossary detail panel
            └── rich-layouts.ts       # Gallery, carousel, hero, map, card-list, split, terms renderers
```

### Data Flow

1. **User opens ChatView** → active session loaded from `storage.ts`.
2. **User types / pastes / mentions** → `Composer` builds a payload with `Attachment[]` and resolved mentions.
3. **Message added to session** → `MessageList` renders the user bubble instantly.
4. **`hermes.ts` streams the request** → HTTP POST to `/v1/chat/completions` with SSE parsing.
5. **Tokens arrive** → `MessageBubble` updates incrementally; `<thinking>` tags are stripped to the ThinkingTrace drawer.
6. **Tool calls detected** → `ThinkingTrace` renders them in the Activity timeline.
7. **Stream ends** → metadata (model, tokens, duration) attached; session saved to disk.

### Key Subsystems

#### Hermes Integration (`src/hermes.ts`)

The gateway client is provider-agnostic OpenAI-compatible. It:

- Reads `API_SERVER_HOST`, `API_SERVER_PORT`, and `API_SERVER_KEY` from `~/.hermes/.env`.
- Normalizes URLs to `/v1`.
- Sends `stream: true` requests.
- Parses SSE events, including custom `hermes.tool.progress` events.
- Strips inline `<thinking>` / `<think>` / `<reasoning>` tags via a stateful `ThinkingStripper` so they don't leak into the visible message.
- Extracts structured reasoning from `delta.reasoning`, `delta.reasoning_content`, or `delta.thinking` fields.

#### Layout Engine (`src/ui/components/LayoutEngine.ts`)

Runs after Markdown rendering to:

1. Parse `obsidian-agents-applet` and `obsidian-agents-react` fenced blocks into placeholders.
2. Parse `obsidian-agents-*` rich layout blocks into placeholders.
3. Render Markdown over the cleaned text.
4. Mount each applet as a sandboxed iframe with auto-sizing and theme variable injection.
5. Mount each rich layout block into its placeholder.
6. Activate inline `[[Label]]{#slug}` term links.

Applets support floating (`left`/`right`) or full-width (`above`/`below`) positioning.

#### Mention System (`src/features/mentions.ts` + `src/lib/vault.ts`)

- `MentionPopover` listens for `@` keystrokes and fuzzy-searches the vault via `searchVaultFiles()`.
- Selected mentions insert `@"path"` syntax and render as chips.
- `resolveMentions()` replaces mention syntax with markers, reads file contents (skipping known binary extensions), and builds a context map.
- `injectContextIntoMessage()` prepends `<context>` XML blocks to the API message only; the stored message remains clean.

#### Session Storage (`src/storage.ts`)

Sessions and folders are persisted as JSON in `.obsidian/obsidian-agents-sessions.json`. The schema is flat (no nested arrays) for easy manual inspection:

```typescript
interface ChatSession {
  id: string;
  name: string;
  folderId: string | null;
  messages: ChatMessage[];
  createdAt: number;
  updatedAt: number;
  model: string;
}

interface SessionFolder {
  id: string;
  name: string;
  parentId: string | null;
  collapsed: boolean;
}
```

Only sessions with at least one user message are written to disk. Empty sessions are ephemeral.

### How to Tweak It

#### Change the Agent's System Prompt

The system prompt that teaches the agent about applets, layouts, and reasoning traces lives in `src/hermes.ts` as the `AGENTCHAT_SYSTEM_PROMPT` string constant. Edit it, rebuild, and reload Obsidian.

#### Add a New Rich Layout Block

1. Define the TypeScript spec interface in `src/ui/components/rich-layouts.ts`.
2. Add the block kind to the `RichLayoutKind` union.
3. Implement a `render*Layout()` function and register it in `mountRichLayout()`.
4. Update `parseRichLayouts()` to recognize the new fence language.
5. Rebuild and reload.

#### Add a New Applet Type

Register it in `src/features/applets.ts`:

```typescript
registerApplet({
  id: "my-widget",
  render(container, props) {
    container.setText(`Hello ${props.name}`);
  },
});
```

Then reference it in agent responses or programmatically via `createAppletElement()`.

#### Change Styling

All styles are in `styles.css` at the plugin root. Obsidian loads this automatically. The CSS uses Obsidian theme variables (`--background-primary`, `--text-normal`, etc.) so the plugin adapts to any theme.

#### Add a New Setting

1. Add the field to `ObsidianAgentsSettings` in `src/types.ts` and provide a default in `DEFAULT_SETTINGS`.
2. Add the UI control in `ObsidianAgentsSettingTab` inside `src/plugin.ts`.
3. Rebuild and reload.

#### Modify the Streaming Behavior

`src/hermes.ts` contains the full HTTP/S request logic and SSE parser. You can:

- Change the request body format (e.g., add `temperature`, `top_p`).
- Add new SSE event handlers (the `handleEvent` lambda inside `streamChatCompletion`).
- Modify `ThinkingStripper` to recognize additional tag patterns.

#### Hook Into Message Rendering

`MessageBubble.ts` decides how user vs agent messages are displayed. You can:

- Add new action buttons in `renderActions()`.
- Change the layout block positioning logic.
- Add custom attachment renderers.

---

## Development

### Build

```bash
cd /path/to/your/vault/.obsidian/plugins/obsidian-agents
npm run build
```

### Typecheck

```bash
npx tsc --noEmit
```

Ignore pre-existing errors in `plugin.ts`, `MessageBubble.ts`, and `Sidebar.ts` unless you introduced new ones.

### Verify the Bundle

After building, confirm your change made it into `main.js`:

```bash
grep -c "YourNewFunctionName" main.js
```

If the count is 0, the build didn't pick up your change.

### Reload Obsidian

Obsidian caches the plugin in memory. After every build, reload:

- **macOS**: `Cmd + R`
- **Windows/Linux**: `Ctrl + R`
- Or toggle the plugin off/on in **Settings → Community plugins**.

---

## License

MIT — see [LICENSE](./LICENSE)

Author: Joao Henrique Costa Araujo
