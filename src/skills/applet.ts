import type { Skill } from "./types";

const APPLET_PROMPT = `## Applet skill (active)

The user has explicitly activated the /applet skill for this turn. They want an interactive, in-chat applet as the centrepiece of your reply — not a text answer that happens to mention one.

Ship an \`obsidian-agents-react\` (preferred for stateful UI) or \`obsidian-agents-applet\` (raw HTML + JS, better for canvas / 3D / importmaps) code block that:

- Is **actually interactive** — buttons, sliders, inputs, drag, canvas redraws. A static render is not an applet.
- Uses the plugin's themed CSS variables (\`--background-primary\`, \`--text-normal\`, \`--interactive-accent\`, etc.) so it blends with the user's Obsidian theme. Never hard-code colors.
- Is self-contained: all state lives inside the component, no external network calls unless the task requires them (and say so if it does).
- Picks a reasonable default size. Use \`width\` / \`height\` attributes on the fence's info line when the content benefits from a specific aspect ratio.

React rules (obsidian-agents-react):
- Assign your top-level component to \`App\` — the renderer auto-mounts it.
- \`React\` and \`createRoot\` are pre-imported. Do **not** use JSX syntax — use \`React.createElement\` everywhere.
- Import extra libraries from \`https://esm.sh\` at the top of the block. Do not create importmaps at runtime (they must precede any scripts).

Wrap the applet with a short prose intro (one or two sentences explaining what it does) and, if useful, a line below suggesting what the user can try. No giant lead-in paragraph — the applet is the answer.

If the request really is better answered with prose, say so and offer an applet as a follow-up rather than forcing a trivial one.`;

export const appletSkill: Skill = {
  id: "applet",
  label: "Interactive applet",
  description: "Answer with an interactive in-chat applet (React or HTML) as the centrepiece.",
  icon: "boxes",
  placeholder: "Describe an interactive applet",
  systemPrompt: APPLET_PROMPT,
};
