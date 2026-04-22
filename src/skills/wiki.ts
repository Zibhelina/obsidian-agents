import type { Skill } from "./types";

const WIKI_PROMPT = `## Wiki article skill (active)

The user has explicitly activated the /wiki skill for this turn. They want a thorough, Wikipedia-style encyclopedia article about the topic they named — not a conversational answer.

Structure:

1. **Lead paragraph** — a concise definition + one-paragraph overview that answers "what is this and why does it matter?". Bold the subject on first mention.
2. **Infobox** (optional but encouraged) — a floated \`obsidian-agents-hero\` or a compact \`obsidian-agents-split\` on the right with key facts (dates, category, origin, notable instances).
3. **Body sections** — use \`##\` headings: *History / Origin*, *Description / How it works*, *Notable examples*, *Cultural impact*, *Criticism / controversy*, *See also* — pick the sections that apply; do not pad with empty ones.
4. **Cross-references** — when you mention other key entities, wrap them in inline \`[[Label]]{#slug}\` markers and emit a matching \`obsidian-agents-terms\` block at the bottom so the user can click for quick details.
5. **Sources / Further reading** — close with a bullet list of authoritative references when you know them.

Tone: neutral, factual, encyclopedic third person. No "As an AI…" preambles. No "Great question!". No first-person. Cite what you're uncertain about rather than glossing over it.

If you don't actually know enough to write a full article, say so up front and offer either a briefer summary or a list of aspects you'd cover if the user provided more context — do not fabricate facts, dates, or sources to fill space.`;

export const wikiSkill: Skill = {
  id: "wiki",
  label: "Wiki article",
  description: "Write a Wikipedia-style article about the topic (lead, infobox, sections, sources).",
  icon: "book-open",
  placeholder: "Learn something new",
  systemPrompt: WIKI_PROMPT,
};
