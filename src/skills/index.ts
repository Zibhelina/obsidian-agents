import type { Skill } from "./types";
import { automationSkill } from "./automation";
import { dynamicLayoutSkill } from "./dynamicLayout";
import { wikiSkill } from "./wiki";
import { appletSkill } from "./applet";
import { tutorSkill } from "./tutor";
import { webSkill } from "./web";
import { manageSkillsSkill } from "./manageSkills";

// On-demand skills: only injected into the system prompt when the user
// explicitly selects them from the slash-command popover. Keep general
// always-on skills (reasoning trace, layouts, applets) inlined in hermes.ts
// so every request gets them without extra cost.
export const SKILLS: Skill[] = [
  automationSkill,
  dynamicLayoutSkill,
  wikiSkill,
  appletSkill,
  tutorSkill,
  webSkill,
  manageSkillsSkill,
];

export class SkillRegistry {
  private byId = new Map<string, Skill>();

  constructor(initial: Skill[] = SKILLS) {
    for (const s of initial) this.byId.set(s.id, s);
  }

  register(skill: Skill): void {
    this.byId.set(skill.id, skill);
  }

  get(id: string): Skill | undefined {
    return this.byId.get(id);
  }

  list(): Skill[] {
    return Array.from(this.byId.values());
  }

  // Fuzzy filter by id or label. The leading slash in queries (and any
  // stored ids that still carry one) is stripped so callers don't have to
  // care about the sigil — it's a display concern, not an identity one.
  filter(query: string): Skill[] {
    const q = query.toLowerCase().replace(/^\//, "");
    if (!q) return this.list();
    return this.list().filter(
      (s) =>
        s.id.replace(/^\//, "").toLowerCase().includes(q) ||
        s.label.toLowerCase().includes(q)
    );
  }
}

export type { Skill } from "./types";
