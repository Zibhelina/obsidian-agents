import type { Skill } from "./types";

const SELF_IMPROVE_PROMPT = `## Self-improve skill (active)

The user has activated /self-improve. They want you to make a concrete change to the **Obsidian Agents plugin itself** — the very plugin you are running inside. This skill exists so you don't have to rediscover the codebase from scratch on every request: it hands you the architecture, the workflow, and the self-maintenance contract in one block.

You have filesystem + shell + git tools via the Hermes gateway. Use them directly. If any of those are missing in this configuration, stop and tell the user which tool is missing — do not fabricate diffs or pretend a change landed.

---

## 1. Where everything lives

Working directory is the vault root. The plugin source is at:

\`.obsidian/plugins/obsidian-agents/\`

Inside:

- \`manifest.json\` — Obsidian plugin manifest (id, version, minAppVersion).
- \`package.json\` — \`npm run build\` (one-shot) and \`npm run dev\` (watch) scripts. Build uses esbuild, bundles into \`main.js\` at the plugin root. \`main.js\` is committed.
- \`esbuild.config.mjs\` — build config. Entry is \`main.ts\`, output is \`main.js\`.
- \`tsconfig.json\` — TypeScript config. Run \`npx tsc --noEmit\` from the plugin dir to typecheck. Note: the repo currently has a few pre-existing non-blocking TS errors in \`plugin.ts\`, \`MessageBubble.ts\`, and \`Sidebar.ts\`. Do not treat those as your fault. Only worry about NEW errors you introduced.
- \`styles.css\` — all plugin styles. Obsidian loads this automatically.
- \`main.ts\` — top-level entry that re-exports the plugin class.
- \`ARCHITECTURE.md\` — authoritative layout doc. Worth reading for any non-trivial change.
- \`README.md\`, \`LICENSE\`.

### \`src/\` layout

\`\`\`
src/
  plugin.ts             -- Main Obsidian Plugin subclass; lifecycle, commands, view registration
  types.ts              -- Core shared types (ChatSession, ChatMessage, Attachment, MentionItem, Settings, StreamHandlers, ToolCall, etc.)
  settings.ts           -- Settings schema, defaults, tab UI
  storage.ts            -- Session + folder persistence (flat-file JSON under the plugin data dir)
  hermes.ts             -- Hermes CLI/gateway communication (reads ~/.hermes/.env, streams responses, merges skills into system prompt)
  tokenizer.ts          -- Rough token estimator for the status bar
  lib/
    vault.ts            -- Vault helpers for @mentions
    layout.ts           -- Layout position enums / helpers
    id.ts               -- generateId() — use this, don't roll your own
    hermesConfig.ts     -- Parses ~/.hermes/.env for model list, gateway URL, etc.
  features/
    mentions.ts         -- @file / @folder resolution
    attachments.ts      -- File paste / drag-drop / embed handling
    commands.ts         -- Hermes CLI command autocomplete (also owns the global SkillRegistry singleton via getSkillRegistry())
    applets.ts          -- Dynamic applet registry + renderer
  callback/
    server.ts           -- Local HTTP callback server for deferred/scheduled replies
    channels/           -- Delivery channels: chat, new-chat, note, notice
  skills/               -- THIS skill lives here. See section below.
  ui/
    ChatView.ts         -- Main Obsidian ItemView, view type "obsidian-agents"
    components/
      Sidebar.ts                -- Session tree with folders
      Composer.ts               -- Input: + menu, skill chips, slash popover, CM6 editor, send button
      LivePreviewEditor.ts      -- CodeMirror 6 adapter used by Composer
      MessageList.ts            -- Scrollable message container
      MessageBubble.ts          -- Individual message renderer
      ThinkingTrace.ts          -- Expandable reasoning block
      StatusBar.ts              -- Model name, token count, timer
      PermissionWidget.ts       -- Accept / Deny / Explain tool calls
      LayoutEngine.ts           -- Positions images / applets around the message
      MentionPopover.ts         -- File-search dropdown for @
      ReplyHandle.ts            -- Reply-to-message affordance
      TermPanel.ts              -- Inline terminal-output panel
      rich-layouts.ts           -- Hero/gallery/split/carousel/map renderers
\`\`\`

### The skills system (you will touch this often)

- \`src/skills/types.ts\` — the \`Skill\` interface. Fields: \`id\`, \`label\`, \`description\`, \`systemPrompt\`, optional \`icon\` (Lucide name), optional \`placeholder\`, optional \`injectCallbackContext\`, and optional \`kind: "core" | "custom"\`. Core ships with the plugin; custom is authored by the user via /manage-skills. Undefined defaults to "core".
- \`src/skills/index.ts\` — registry. Imports every skill file and lists it in the exported \`SKILLS\` array. New skills must be added here in two places (import + array).
- \`src/skills/<id>.ts\` — one file per skill. Canonical style: a \`const <NAME>_PROMPT = \\\`...\\\`\` template literal, then \`export const <id>Skill: Skill = { ... }\`.
- Skills are **only injected into the system prompt when active**. Always-on behavior (reasoning trace, layouts, applets) is inlined in \`hermes.ts\` — don't add always-on behavior as a skill.

Current core skills: /automation, /dynamic-layout, /wiki, /applet, /web, /manage-skills, /self-improve. The user may have added custom skills since this was written — \`ls .obsidian/plugins/obsidian-agents/src/skills/\` is the source of truth.

---

## 2. The build + reload loop

This is the loop that burned users last time. Do it every time, in this order:

1. **Edit the source files.** Use Read + Edit/Write, not shell heredocs.
2. **Typecheck.** From the plugin dir:

   \`\`\`
   cd .obsidian/plugins/obsidian-agents && npx tsc --noEmit
   \`\`\`

   Ignore the pre-existing errors listed above. Fix any NEW error you introduced.

3. **Build the bundle.** This is **not optional** — Obsidian loads \`main.js\`, not your source files:

   \`\`\`
   cd .obsidian/plugins/obsidian-agents && npm run build
   \`\`\`

4. **Verify the bundle.** Grep \`main.js\` for a string unique to your change (a new function name, a new skill id, a new CSS class). If the count is 0 when it should be ≥1, the build didn't pick up your change — investigate, don't ship.

5. **Tell the user to reload.** Obsidian caches the loaded plugin in memory. Reload is the one step you can't do for them. Tell them in one line: "Built. Reload Obsidian (Cmd+R, or toggle the plugin off/on in Settings → Community plugins) to pick it up."

Never skip steps 3 or 4. Never claim "done" after only editing source.

### When \`npm run dev\` is running

If the user has \`npm run dev\` open in a terminal, esbuild is watching and rebuilding automatically. You still need to tell them to reload Obsidian, but you can skip the explicit \`npm run build\`. If you're not sure whether dev mode is running, just run \`npm run build\` — it's idempotent and fast.

---

## 3. Testing

There is no automated test suite today. Your verification options, in order of preference:

1. **Typecheck** (\`npx tsc --noEmit\`) catches most mistakes.
2. **Bundle grep** (step 4 above) confirms the change made it into \`main.js\`.
3. **Runtime check in Obsidian** — the user reloads and exercises the change. You can't do this yourself, so when it matters, ask the user to confirm a specific observable result ("after reloading, the + menu should show a 'Custom skills' section below 'Core skills' — does it?").
4. **Read your diff before claiming done.** \`git diff\` on the plugin dir. Look for typos, leftover console.logs, half-finished edits.

If you introduce something that really needs an automated test (parser logic, a pure helper), it's fine to add a small Node script under the plugin dir and run it with \`node\`. Don't add a test framework dependency without asking first.

---

## 4. Git + committing

- **Never run \`git\` commands unless the user explicitly asked you to commit or push.** Editing and building is in-scope by default; committing is not.
- When you do commit, write a clean scoped message. Use \`feat: …\`, \`fix: …\`, \`refactor: …\` style prefixes.
- **Do NOT add a \`Co-Authored-By: AI …\` trailer** unless the user asks.
- \`main.js\` is committed in many setups. A plugin change without a rebuilt \`main.js\` is a broken commit.
- If the user asks you to "sync" or "push the plugin", commit the changes and push to the appropriate remote. Never push vault-level files (session data, \`community-plugins.json\`, AKB notes, other plugins) to a public plugin repository.

---

## 5. Style and guardrails

- **Match existing code style.** TypeScript strict-ish, double quotes, no semicolons missing, 2-space indent, Obsidian API idioms (\`createDiv\`, \`setIcon\`, \`registerDomEvent\`). Read a nearby file before writing new code.
- **No emojis in code or commits** unless the user asks.
- **Don't invent Skill fields** that aren't in \`types.ts\`. Don't add framework-level abstractions (plugin systems, registries) unless the user explicitly wants one.
- **Prefer Edit over Write** for existing files. Only use Write for new files or full rewrites.
- **Composer quirks you'll hit**: the "+" menu is \`renderAddMenu()\` in \`Composer.ts\`; the slash autocomplete is \`handleSlashInput()\` / \`renderSlashItems()\`. Skills are categorized in the + menu but flat in autocomplete — don't change that without the user asking.
- **Settings changes** require updating \`settings.ts\` (schema + defaults + tab UI) and possibly \`storage.ts\` for migration. Forgetting the default is the most common bug.

---

## 6. CRITICAL: keep this skill up to date

**This skill is self-maintaining.** Whenever your change to the plugin invalidates anything in this prompt — a moved file, a renamed export, a new subsystem, a changed workflow, a new always-on skill, a new field on \`Skill\`, a changed build command, a new repo convention — you MUST also update \`src/skills/selfImprove.ts\` in the same change so future /self-improve runs see the new reality.

Examples that require updating this skill:

- You add a new core skill → update the "Current core skills" list in section 1.
- You rename or move a file in \`src/\` → update the tree in section 1.
- You add a new field to the \`Skill\` interface → update the skills-system bullet in section 1.
- You change the build/typecheck command or add a test suite → update section 2 or 3.
- You change the repo layout or commit conventions → update section 4.

Examples that do NOT require updating this skill:

- Pure bug fixes that don't change structure.
- CSS tweaks, copy changes, icon swaps.
- Changes to a user's custom skill under \`src/skills/\`.

When updating this prompt, keep it dense and specific. Don't let it grow into a general-purpose style guide — every sentence should help a future agent ship a change faster. If a section stops paying for its tokens, trim it.

After updating this file, the same build + reload loop in section 2 applies — the skill's prompt is compiled into \`main.js\`.

---

## 7. If something is missing from the gateway

- No filesystem tools → "I can't edit the plugin source from this Hermes configuration. Enable a filesystem tool and retry." Stop.
- No shell/exec tools → edit the source, then tell the user: "I edited the files but can't run \`npm run build\` from here. Run it in \`.obsidian/plugins/obsidian-agents\` and reload Obsidian." Stop.
- No git tools and the user asked you to commit → do everything else, then explain that the user needs to run git themselves, and paste the exact commit message you would have used.

Honesty beats theatrics. A clear "I can't do step X from here, please do it and I'll continue" is always better than a fabricated success.`;

export const selfImproveSkill: Skill = {
  id: "self-improve",
  label: "Self-improve",
  description: "Modify the Obsidian Agents plugin itself — architecture, workflow, and self-maintenance baked in.",
  icon: "git-branch",
  placeholder: "Describe a change to the plugin",
  systemPrompt: SELF_IMPROVE_PROMPT,
  kind: "core",
};
