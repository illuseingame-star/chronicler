// Client-side mirror of skill outcomes.
//
// WHY THIS EXISTS
// YantrikDB accepts skill outcomes but exposes them through no read action:
// `skill get`, `list`, and `surface` all return skill METADATA only — no
// outcomes, no uses, no success_rate. Verified 2026-08-04 against engine
// 0.11.3 with 122 outcomes recorded and zero readable.
//
// Chronicler's outcome-driven state machine reads exactly that data.
// computeEvidence() derives net score / distinct sessions / days active /
// success rate from it, and deriveState() derives candidate→active→
// suppressed. Both were receiving [] forever, so no skill could ever reach
// core_trait and the whole identity layer stayed empty.
//
// This mirrors every outcome locally at write time, in the SAME shape the
// substrate would have returned, so the promoter and state machine work
// unchanged.
//
// KNOWN TRADEOFF (deliberate, chosen 2026-08-04)
// The substrate stops being the single source of truth for skill state.
// Outcomes are per-browser: they do not survive a cleared profile and do
// not sync across devices. The substrate still receives every write, so
// when the engine exposes outcomes on read this mirror becomes a cache and
// can be reconciled or dropped — see readOutcomesPreferringSubstrate().

import { toEngineSkillId } from "../yantrikdb/client";

const STORAGE_KEY = "chronicler.skill.outcome_mirror.v1";

/** Mirror entries are keyed by the ENGINE-normalized skill id.
 *
 *  Writers hold Chronicler's raw id ("ren-driver-x-observation"); readers
 *  get the normalized id back from skillList ("skill.ren_driver_x_
 *  observation"). Keying on the raw id silently split the mirror in two —
 *  every write landed under one key and every read missed under another,
 *  which looked identical to "no outcomes exist". Normalizing on both
 *  sides is what makes the two halves meet. */
function mirrorKey(skill_id: string): string {
  return toEngineSkillId(skill_id);
}

/** Mirrors the row shape the substrate returns for an outcome, so callers
 *  cannot tell the difference. `note` stays the ENCODED note string —
 *  decodeNote() in skill-outcomes.ts parses it. */
export interface MirroredOutcome {
  succeeded: boolean;
  note?: string;
  at: string;
}

type MirrorMap = Record<string, MirroredOutcome[]>;

function load(): MirrorMap {
  if (typeof localStorage === "undefined") return {};
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as MirrorMap;
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function save(map: MirrorMap): void {
  if (typeof localStorage === "undefined") return;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(map));
  } catch {
    // Quota or private-mode failure. Non-fatal: the substrate write still
    // happened, we just lose local evidence accumulation.
  }
}

/** Append one outcome. Call immediately after the substrate write, with
 *  the same encoded note, so the two stay aligned. */
export function mirrorOutcome(
  skill_id: string,
  outcome: MirroredOutcome
): void {
  const map = load();
  const key = mirrorKey(skill_id);
  const list = map[key] ?? [];
  list.push(outcome);
  map[key] = list;
  save(map);
}

/** Outcomes for one skill, oldest first (insertion order). */
export function getMirroredOutcomes(skill_id: string): MirroredOutcome[] {
  return load()[mirrorKey(skill_id)] ?? [];
}

/** Prefer whatever the substrate returned; fall back to the mirror.
 *
 *  Written this way on purpose: the moment YantrikDB exposes outcomes on
 *  its read path, substrate data wins automatically and this degrades to a
 *  cache with no call-site changes. */
export function readOutcomesPreferringSubstrate(
  skill_id: string,
  fromSubstrate: MirroredOutcome[] | undefined
): MirroredOutcome[] {
  if (fromSubstrate && fromSubstrate.length > 0) return fromSubstrate;
  return getMirroredOutcomes(skill_id);
}

/** Every skill id the mirror knows about. Lets callers enumerate skills
 *  that have outcome history even when a substrate list comes back thin. */
export function mirroredSkillIds(): string[] {
  return Object.keys(load());
}

/** Drop a skill's mirrored outcomes — used when a skill is archived or
 *  the user wipes local state. */
export function clearMirroredOutcomes(skill_id: string): void {
  const map = load();
  delete map[mirrorKey(skill_id)];
  save(map);
}

/** Wipe the whole mirror. Wired into the Danger Zone reset. */
export function clearAllMirroredOutcomes(): void {
  if (typeof localStorage === "undefined") return;
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    /* ignore */
  }
}
