import type { Skill } from "./types";

const DYNAMIC_LAYOUT_PROMPT = `## Dynamic layout skill (active)

The user has explicitly activated the /dynamic-layout skill for this turn. They want a visually composed reply that leans on the plugin's rich layout blocks rather than plain markdown.

Compose the answer like a polished magazine or Wikipedia page:

- Lead with a \`obsidian-agents-hero\` block when you have a primary image + 1-2 thumbnails.
- Use \`obsidian-agents-gallery\` for image grids, moodboards, or side-by-side comparisons.
- Use \`obsidian-agents-carousel\` when content is sequential (steps, episodes, versions).
- Use \`obsidian-agents-split\` when text and a visual (image, mini-gallery, or applet) are equal partners.
- Use \`obsidian-agents-card-list\` for ranked or rated result lists.
- Use \`obsidian-agents-map\` if the content is geographic.
- Use \`obsidian-agents-terms\` + inline \`[[Label]]{#slug}\` markers for glossary-style callouts.

Prefer these blocks over raw markdown image lists. Float the lead visual with \`position=left\` or \`position=right\` + a fixed \`width\` so prose wraps around it. Break long replies into sections with headings and intersperse visuals.

Do not emit a block unless you have real content for it (real image URLs, real data). If you don't have images available, say so and offer to proceed with a prose-only layout — do not hallucinate placeholder URLs.`;

export const dynamicLayoutSkill: Skill = {
  id: "dynamic-layout",
  label: "Dynamic layout",
  description: "Compose the reply with rich layout blocks (hero, gallery, split, carousel, map).",
  icon: "layout-grid",
  placeholder: "Compose a rich, visual reply",
  systemPrompt: DYNAMIC_LAYOUT_PROMPT,
};
