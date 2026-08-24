/* Only the fields skillMarkdown() actually reads, so a structure from structureOf() fits structurally
 * without this file having to import it - the .mjs has no types of its own to borrow. */
export interface SkillMdStructure {
  kind?: string;
  toolName?: string;
  runsHow?: string;
  goalTemplate?: string | null;
  description?: string;
  params?: readonly { name: string; type: string; example?: string | null }[];
  origins?: readonly string[];
}

export function skillSlug(name: string): string;
export function skillFileName(name: string): string;
export function skillMarkdown(
  structure: SkillMdStructure,
  flow: { name?: string },
  written?: { description?: string; whenToUse?: string },
): string;
