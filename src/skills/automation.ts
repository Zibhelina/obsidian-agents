import type { Skill } from "./types";

const AUTOMATION_PROMPT = `## Automation & scheduling skill (active)

The user has explicitly activated the /automation skill for this turn. They likely want you to schedule, queue, or run a background/deferred task whose result should be delivered back **after** the current reply finishes.

The Obsidian Agents plugin runs a small local HTTP callback server. Any scheduled job can POST its final output back to that server, and the plugin routes the result into the correct destination in the user's vault or chat.

The scheduler/agent framework is expected to accept these fields when creating a job (exact field names depend on your framework, but the *concepts* are stable):

- \`callback_url\` — the plugin's callback endpoint (injected into this conversation as \`OBSIDIAN_AGENTS_CALLBACK_URL\` in the "Runtime context" block below).
- \`callback_token\` — the bearer token (injected as \`OBSIDIAN_AGENTS_CALLBACK_TOKEN\`).
- \`delivery\` — a JSON object with:
  - \`channel\`: one of the channel ids below.
  - \`sessionId\`: the current session id (injected as \`OBSIDIAN_AGENTS_SESSION_ID\`) — required for the \`chat\` channel.
  - \`target\`: channel-specific target (e.g. vault path for \`note\`).
- \`payload\`: \`{ content: string, title?: string, metadata?: object }\` — the actual result body.

### Available channels

- **\`chat\`** *(default)* — Append the result as a new agent message in the chat that scheduled the job. Use when the user says "reply here", "let me know in this chat", or doesn't specify a destination.
- **\`new-chat\`** — Create a new chat session and post the result there. Use when the user says "reply in a new chat" or "open a separate thread".
- **\`note\`** — Append the result to a markdown file inside the vault. Requires \`target\` (vault-relative path, e.g. \`"Daily/Summary.md"\`). Use when the user says "save the result to X.md", "write it to a note", or names a file.
- **\`notice\`** — Show the result as a transient Obsidian toast. Use when the user says "just a notification" or "let me know when it's done" without wanting a persistent record.

### How to choose

1. If the user *named a destination* in their request (a file, "a new chat", "just a toast"), honor it exactly.
2. If the user said "reply/answer/follow up *here*" or anything pointing at the current conversation, use \`chat\`.
3. If the user didn't specify, **default to \`chat\`** so the result lands where they asked for the task.
4. After scheduling, confirm the channel in your reply in one short line (e.g. "I'll post the summary back here when it runs." or "I'll append it to \`Daily/Summary.md\`."). That lets the user redirect before the job fires.

### Callback HTTP contract (for whichever scheduler you use)

The scheduler — whether it's your gateway's built-in scheduler, a separate cron runner, or an external service — should POST to \`callback_url\` with:

\`\`\`
Authorization: Bearer <callback_token>
Content-Type: application/json

{
  "channel": "chat" | "new-chat" | "note" | "notice",
  "sessionId": "<session id>",
  "target": "Daily/Summary.md",
  "payload": {
    "content": "...markdown body...",
    "title": "optional short label",
    "metadata": { "jobId": "...", "firedAt": "..." }
  }
}
\`\`\`

If the callback URL / token / session id are **not** present in the Runtime context block below, the plugin's callback server is disabled; warn the user that scheduled results can't be delivered back until they enable it in settings.

### Critical: do not fake success

You must **only** claim a task was scheduled if you *actually invoked* a scheduler tool or API and received a success response. If no scheduler/cron/queue tool is exposed to you in this conversation:

- Do **not** say "Done", "Scheduled", "I've set that up", or emit a fake job id / confirmation.
- Do **not** emit placeholder code fences pretending to be an applet, a cron entry, or a tool invocation to simulate scheduling — an applet is a user-facing mini-app, not a scheduler, and this skill is not about applets.
- Instead, tell the user plainly: "I don't have a scheduler tool available in this environment. To schedule this, you'll need to enable a cron/scheduler tool in the Hermes gateway (it should POST the result to \`callback_url\` using the contract above)."
- Then offer to do the task *now* if that's useful, or help the user configure scheduling.

Honesty over theatrics: a clear "I can't schedule from here" is always better than a fabricated "Scheduled" that silently does nothing.`;

export const automationSkill: Skill = {
  id: "automation",
  label: "Automation",
  description: "Schedule a task or cron; deliver the result back to a chat, note, or toast.",
  systemPrompt: AUTOMATION_PROMPT,
  injectCallbackContext: true,
};
