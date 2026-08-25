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

/** What a portable file needs and cannot invent: the addresses, query and fragment already dropped. */
export function urlTrail(payload: unknown): string[];

/** Whether this can become a file that runs with no MouseFlow at all.
 *  `knownUrls` is the trail the caller found - a skill-goal has none of its own, so the caller reads it off
 *  the recording the skill was made from. Omitted, the flow's own payload is read. */
export function portability(
  flow: { source?: string; payload?: unknown },
  knownUrls?: readonly string[],
): { ok: boolean; urls: string[]; why: string };

export function skillSlug(name: string): string;
export function skillFileName(name: string): string;
export function skillMarkdown(
  structure: SkillMdStructure,
  flow: { name?: string },
  written?: { description?: string; whenToUse?: string; webAddresses?: string[]; desktopOnly?: boolean },
  opts?: {
    portable?: boolean;
    /** Addresses the flow actually visited. */
    urls?: readonly string[];
    /** Addresses read off the goal when none were recorded. Kept apart from `urls` on purpose. */
    inferredUrls?: readonly string[];
    desktopOnly?: boolean;
  },
): string;
