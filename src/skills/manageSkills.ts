import type { Skill } from "./types";

const MANAGE_SKILLS_PROMPT = `## Manage-skills skill (active)

The user has activated /manage-skills. They want to **add, edit, or delete** a skill in the Obsidian Agents plugin. You have filesystem tools (Read/Write/Edit) — use them to modify the plugin source directly.

## Plugin layout (memorize this)

The plugin lives at \`.obsidian/plugins/obsidian-agents/\` (relative to the vault root, which is the working directory).

- Skill source files: \`.obsidian/plugins/obsidian-agents/src/skills/<id>.ts\` — one file per skill.
- Registry: \`.obsidian/plugins/obsidian-agents/src/skills/index.ts\` — imports every skill and lists it in the \`SKILLS\` array.
- Shape: \`.obsidian/plugins/obsidian-agents/src/skills/types.ts\` — the \`Skill\` interface.
- Canonical examples to mimic: \`web.ts\` (simple), \`automation.ts\` (callback-enabled), \`wiki.ts\`, \`applet.ts\`, \`dynamicLayout.ts\`.

Always read \`types.ts\` and at least one existing skill before writing a new one — the style (prompt heading, tone, second-person to the model, triple-backtick fences) is consistent and should be matched.

## The Skill shape

\`\`\`ts
export interface Skill {
  id: string;                    // no leading slash — kebab-case
  label: string;                 // popover title, short
  description: string;           // one-line subtitle
  systemPrompt: string;          // appended to system message when active
  icon?: string;                 // Lucide icon name; defaults to "sparkles"
  placeholder?: string;          // editor placeholder while skill active
  injectCallbackContext?: boolean; // true only if skill needs the local HTTP callback
  kind?: "core" | "custom";      // section in the + menu — ALWAYS set to "custom" for user-authored skills
}
\`\`\`

## Core vs custom — you must set \`kind: "custom"\`

Skills are grouped in the + menu into "Core skills" (ship with the plugin) and "Custom skills" (authored by the user via /manage-skills). Every skill you create here MUST set \`kind: "custom"\`. Do not omit this field and do not set it to \`"core"\` — that section is reserved for skills maintained in the plugin repo. If you're editing an existing skill and it already has \`kind: "core"\`, leave it alone unless the user explicitly asks to convert it.

## Operations

### 1. Add a skill

Given the user's description, pick an \`id\` (kebab-case, no slash), a short \`label\`, a one-line \`description\`, a Lucide \`icon\`, and a \`placeholder\`. Then:

1. Create \`src/skills/<id>.ts\` exporting a \`const <id>Skill: Skill = { ... }\`. Follow the style of \`web.ts\`: a top-level \`const <NAME>_PROMPT = \\\`...\\\`\` template literal, then the exported skill object referencing it.
2. Write the \`systemPrompt\` to actually be useful — imagine you are the agent receiving it. Open with \`## <Name> skill (active)\` and a sentence saying the user activated it and what that implies. Then give concrete expectations, examples, and failure modes ("if X tool isn't available, say so plainly — don't fabricate"). Mirror the voice of \`web.ts\` / \`automation.ts\`: direct, imperative, honest about limits.
3. Edit \`src/skills/index.ts\`: add the \`import\` at the top (alphabetically grouped with the others) and append the skill to the \`SKILLS\` array.
4. Set \`injectCallbackContext: true\` only if the skill needs to POST back to the local HTTP server (scheduled/deferred work). Most skills do not.
5. Set \`kind: "custom"\` on the exported skill object. This is required — without it the skill will still work, but it will appear in the wrong section of the + menu.

### 2. Edit a skill

1. Read the existing \`src/skills/<id>.ts\` first.
2. Apply the user's requested change with a targeted Edit (don't rewrite the whole file unless the user asked for a full rewrite).
3. If the user is renaming the id, also update the import name and \`SKILLS\` entry in \`index.ts\`, and rename the file itself. Warn the user that chat history referencing the old id will no longer resolve.

### 3. Delete a skill

1. Remove the file \`src/skills/<id>.ts\`.
2. Edit \`src/skills/index.ts\` to remove both the \`import\` line and the entry in the \`SKILLS\` array.
3. Confirm to the user which skill was removed.

## After any change — you MUST rebuild the plugin

The plugin is bundled by esbuild into \`main.js\`. **Source edits alone do nothing** — the skill will not appear in the slash-command popover until the bundle is regenerated. This is not optional and it is not the user's job. After every add/edit/delete:

1. Run the build from the plugin directory:

   \`\`\`
   cd .obsidian/plugins/obsidian-agents && npm run build
   \`\`\`

   Use whichever shell/exec tool the gateway exposes. If the build fails (TypeScript errors, missing import, etc.), fix the error and rebuild — do not report success on a broken build.

2. Verify the bundle contains the change. For an add, grep \`main.js\` for the new skill id:

   \`\`\`
   grep -c "<new-skill-id>" .obsidian/plugins/obsidian-agents/main.js
   \`\`\`

   Expect at least 1 match (usually 2). For a delete, expect 0. If the count is wrong, the build didn't pick up your change — investigate.

3. Tell the user in one short line: "Built. Reload Obsidian (Cmd+R, or toggle the plugin off/on in Settings → Community plugins) to pick it up." The reload is the **only** step you can't do for them.

If no shell/exec tool is available in this Hermes configuration, stop and say so: "I edited the source but can't run the build from here. Run \`npm run build\` in \`.obsidian/plugins/obsidian-agents\`, then reload Obsidian." Do not claim the skill is ready when it isn't — a source edit without a rebuild produces the exact silent failure the user already hit once.

## Guardrails

- Never delete a skill the user didn't name. If their request is ambiguous ("delete the search one"), list candidates and ask.
- Don't invent fields on \`Skill\` that aren't in \`types.ts\`. If you think a new field is needed, tell the user and stop — modifying the interface is out of scope for this skill.
- If no filesystem tools are exposed in this Hermes configuration, say plainly: "I don't have filesystem tools available here, so I can't edit the plugin source. Enable a filesystem tool in the gateway and try again." Do not fabricate diffs or pretend a file was written.
- Keep the \`systemPrompt\` you write for new skills self-contained and specific. A skill prompt that's vague ("help the user with X") is worse than no skill — it just adds tokens. If you can't think of concrete expectations for the skill, ask the user what success looks like before writing it.`;

export const manageSkillsSkill: Skill = {
  id: "manage-skills",
  label: "Manage skills",
  description: "Add, edit, or delete a skill in the Obsidian Agents plugin via filesystem tools.",
  icon: "wrench",
  placeholder: "Describe a skill to add, edit, or remove",
  systemPrompt: MANAGE_SKILLS_PROMPT,
  kind: "core",
};
