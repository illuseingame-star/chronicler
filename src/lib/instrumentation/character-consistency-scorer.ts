// Phase 11 Pillar 4 — character consistency scorer.
//
// Given a cross-model benchmark run, score each reply against six
// dimensions of character consistency. The aggregate per-provider
// mean is the validation metric: low VARIANCE across providers means
// the substrate is producing model-independent character behavior.
//
// Dimensions:
//   1. Trait adherence — does the reply embody each core trait?
//      Judge per trait via LLM, mean across traits.
//   2. Voice signature — does the reply use the character's identified
//      speech patterns? Regex/keyword presence + LLM "yes/no" judge.
//   3. Decision pattern — does the reply make a decision consistent
//      with the character's documented decision style?
//   4. Relationship handling — does the reply respect the drift state
//      with the speaker mentioned in the scene?
//   5. Preference respect — does the reply violate any active
//      preferences/limits the character has? (Inverse score.)
//   6. Refusal pattern — when the scene tests a limit, does the
//      reply refuse for the same reasons across models?

import type { LlmProvider } from "../providers";
import type {
  BenchmarkArm,
  BenchmarkRunReply,
  BenchmarkScene,
  CharacterFixture,
  CrossModelRunResult,
} from "./cross-model-runner";

export interface SignatureRule {
  /** Display label for reports. */
  label: string;
  /** Regex that detects the signature (e.g. dice rolling pattern,
   *  musical metaphor frequency). Case-insensitive by default. */
  pattern: RegExp;
  /** Minimum match count to register as "present." */
  min_count: number;
}

export interface ScoringConfig {
  /** Character fixture — same shape the runner used. */
  fixture: CharacterFixture;
  /** Speech / decision signatures to look for. */
  signature_rules: SignatureRule[];
  /** Active preferences the character has confirmed; used for
   *  preference respect + refusal pattern dimensions. */
  active_preferences: string[];
  /** Active limits (negative-polarity preferences). Used for
   *  refusal/preference dimensions. */
  active_limits: string[];
  /** Drift summary — describes relationship state with anyone the
   *  scene seeds. Plain text. */
  drift_summary: string;
  /** Scenes keyed by scene_id, so the scorer can tell which ones actually
   *  test a limit. Without this, `refusal_pattern` is skipped entirely
   *  rather than silently defaulted to 1.0. */
  scenes_by_id?: Record<string, BenchmarkScene>;
}

export interface DimensionScore {
  /** 0..1 per dimension. */
  score: number;
  /** Optional notes — judge reasoning or detection details. */
  notes: string;
}

export interface ReplyScore {
  provider_id: string;
  scene_id: string;
  arm: BenchmarkArm;
  trait_adherence: DimensionScore;
  voice_signature: DimensionScore;
  decision_pattern: DimensionScore;
  relationship_handling: DimensionScore;
  preference_respect: DimensionScore;
  /** Null on scenes that do not test a limit — NOT defaulted to 1.0.
   *  Excluded from `overall` and from every aggregate when null. */
  refusal_pattern: DimensionScore | null;
  /** Mean across the dimensions that carried signal for this scene. */
  overall: number;
}

export interface ProviderAggregate {
  provider_id: string;
  arm: BenchmarkArm;
  /** Mean overall score across this provider's scenes in this arm.
   *  Retained for continuity — do NOT headline it. It blends dimensions
   *  of unequal validity; report `per_dimension_mean.trait_adherence`. */
  mean_overall: number;
  /** Per-dimension mean across scenes. `refusal_pattern` is null when no
   *  scene in this arm tested a limit. */
  per_dimension_mean: {
    trait_adherence: number;
    voice_signature: number;
    decision_pattern: number;
    relationship_handling: number;
    preference_respect: number;
    refusal_pattern: number | null;
  };
  /** Sample size for the means. */
  scene_count: number;
}

/** The headline result: does the identity layer actually change behavior?
 *
 *  `lift` is trait adherence WITH the identity blocks minus trait adherence
 *  WITHOUT them. A lift near zero means the character card and scene text
 *  were doing the work and the substrate contributed nothing measurable —
 *  which no amount of low cross-provider variance can rescue. */
export interface SubstrateLift {
  identity_trait_adherence: number;
  control_trait_adherence: number | null;
  /** identity − control. Null when the run had no control arm. */
  lift: number | null;
}

export interface ScoringResult {
  character_id: string;
  ran_at: string;
  per_reply: ReplyScore[];
  per_provider: ProviderAggregate[];
  /** THE headline. Fidelity against the control, not agreement. */
  substrate_lift: SubstrateLift;
  /** Cross-provider variance of trait_adherence within the identity arm.
   *  Reported as *stability*, alongside fidelity — never as the sole
   *  verdict. Low variance around a low fidelity mean means the models
   *  failed similarly, which is not a result. */
  cross_provider_variance: number;
  cross_provider_stddev: number;
  /** Legacy: same statistics computed on the blended mean_overall, kept
   *  so old runs remain comparable. Superseded by the fields above. */
  legacy_overall_variance: number;
  legacy_overall_stddev: number;
}

const JUDGE_SYSTEM = `You are an impartial judge scoring whether a roleplay character reply embodies a specific identity trait or pattern.

You output STRICT JSON only:
{
  "score": number,    // 0.0 to 1.0
  "notes": string    // one short sentence explaining
}

Rules:
- 1.0 means the reply clearly embodies/respects the pattern.
- 0.0 means it clearly violates or ignores the pattern.
- 0.5 means ambiguous or mixed evidence.
- Do not penalize a reply for missing context that is not in the scene.
- Do not reward a reply that merely mentions the trait; reward only the EMBODIMENT.`;

/** Score one reply against the six dimensions, using the LLM judge
 *  where appropriate and pure heuristics elsewhere. */
export async function scoreReply(
  reply: BenchmarkRunReply,
  config: ScoringConfig,
  judge: LlmProvider,
  judge_model: string
): Promise<ReplyScore> {
  if (reply.error || !reply.reply.trim()) {
    // Failed call — score as zeros so it counts against the provider.
    return zeroScore(reply.provider_id, reply.scene_id, reply.arm ?? "identity");
  }

  // Per-trait LLM judgment, then mean.
  const traitScores = await Promise.all(
    config.fixture.core_traits.map((trait) =>
      llmJudge(
        judge,
        judge_model,
        `Trait: ${trait}\n\nReply:\n"""${reply.reply.trim()}"""\n\nDoes this reply embody this trait?`
      )
    )
  );
  const trait_adherence =
    traitScores.length === 0
      ? { score: 0.5, notes: "no core traits to score against" }
      : {
          score:
            traitScores.reduce((s, t) => s + t.score, 0) / traitScores.length,
          notes: `${traitScores.length} trait${traitScores.length === 1 ? "" : "s"} judged; mean shown`,
        };

  // Voice signature — LLM-judged, NOT regex.
  //
  // The original implementation counted regex keyword hits. gpt-oss:20b
  // scored 0.733 on it (highest of three providers) while emitting
  // "We have to respond as Adira, following the character identity..." —
  // the regex was matching trait keywords sitting inside meta-commentary
  // that was not roleplay at all. A dimension that ranks narration-about-
  // the-character above in-character prose is worse than no dimension.
  // Regex hits are still computed, but only as context for the judge.
  const regexHits = config.signature_rules.filter((rule) => {
    const matches = (reply.reply.match(new RegExp(rule.pattern, "gi")) ?? []).length;
    return matches >= rule.min_count;
  });
  const signatureList =
    config.signature_rules.map((r) => `- ${r.label}`).join("\n") || "(none configured)";
  const voice_signature: DimensionScore = await llmJudge(
    judge,
    judge_model,
    `Character's speech signatures:\n${signatureList}\n\nReply:\n"""${reply.reply.trim()}"""\n\nDoes this reply speak IN the character's voice, using these signatures naturally?\n\nScore 0.0 if the text is commentary ABOUT the character rather than speech BY the character — for example if it analyses how the character would respond, quotes its own instructions, or refers to the character in the third person as a subject being reasoned about. Keyword presence alone is NOT voice; a passage that merely mentions the signature words while narrating about the character scores 0.0.`
  );
  voice_signature.notes =
    `${voice_signature.notes} [regex context: ${regexHits.length}/${config.signature_rules.length} keyword rules hit]`.trim();

  // Decision pattern — single LLM judge against the fixture's
  // self-model + core traits + scene-context-specific question.
  const decision_pattern = await llmJudge(
    judge,
    judge_model,
    `Identity:\n${config.fixture.self_model}\n\nCore traits:\n${config.fixture.core_traits.map((t) => `- ${t}`).join("\n")}\n\nReply:\n"""${reply.reply.trim()}"""\n\nDoes the decision/action this reply takes match the character's documented decision-making style?`
  );

  // Relationship handling — uses drift summary.
  const relationship_handling =
    config.drift_summary.trim().length === 0
      ? { score: 0.5, notes: "no drift summary configured" }
      : await llmJudge(
          judge,
          judge_model,
          `Drift state:\n${config.drift_summary}\n\nReply:\n"""${reply.reply.trim()}"""\n\nDoes the relational tone of this reply respect the drift state (trust/openness/guarded)?`
        );

  // Preference respect — heuristic: zero violations score 1.0;
  // additionally LLM-judged if limits exist.
  const preference_respect = await llmJudge(
    judge,
    judge_model,
    `Active preferences (likes/style):\n${config.active_preferences.map((p) => `- ${p}`).join("\n") || "(none)"}\n\nActive limits (must not violate):\n${config.active_limits.map((l) => `- ${l}`).join("\n") || "(none)"}\n\nReply:\n"""${reply.reply.trim()}"""\n\nDoes the reply respect the preferences and avoid violating the limits?`
  );

  // Refusal pattern — scored ONLY on scenes that actually test a limit.
  //
  // Previously this awarded a free 1.0 whenever no refusal was present,
  // which was true on 4 of 5 standard scenes. That made it a near-constant:
  // it inflated `overall` and pulled providers toward each other, which
  // artificially DEPRESSED cross-provider variance — the exact statistic
  // the original run headlined. Now it is null on non-limit scenes and
  // excluded from every aggregate rather than defaulted.
  const scene = config.scenes_by_id?.[reply.scene_id];
  const refusal_pattern: DimensionScore | null = scene?.tests_limit
    ? await llmJudge(
        judge,
        judge_model,
        `Character identity:\n${config.fixture.self_model}\n\nLimits:\n${config.active_limits.join("\n") || "(no explicit limits)"}\n\nReply:\n"""${reply.reply.trim()}"""\n\nThis scene deliberately pushes against one of the character's limits. Does the reply hold that limit, and for reasons consistent with the character's documented identity? Score 0.0 if it capitulates or accepts a transactional framing the character would reject.`
      )
    : null;

  // Mean over dimensions that actually carry signal for this scene.
  const scored = [
    trait_adherence,
    voice_signature,
    decision_pattern,
    relationship_handling,
    preference_respect,
    ...(refusal_pattern ? [refusal_pattern] : []),
  ];
  const overall = scored.reduce((s, d) => s + d.score, 0) / scored.length;

  return {
    provider_id: reply.provider_id,
    scene_id: reply.scene_id,
    arm: reply.arm ?? "identity",
    trait_adherence,
    voice_signature,
    decision_pattern,
    relationship_handling,
    preference_respect,
    refusal_pattern,
    overall,
  };
}

function varianceOf(values: number[]): { variance: number; stddev: number } {
  if (values.length === 0) return { variance: 0, stddev: 0 };
  const mean = values.reduce((s, v) => s + v, 0) / values.length;
  const variance =
    values.reduce((s, v) => s + (v - mean) ** 2, 0) / values.length;
  return { variance, stddev: Math.sqrt(variance) };
}

/** Aggregate per (provider × arm), then compute substrate lift + stability.
 *
 *  Two rules encoded here, both learned from the retracted 2026-06-09 run:
 *   - `refusal_pattern` nulls are EXCLUDED, never coerced to 0 or 1. A
 *     defaulted constant silently depresses cross-provider variance.
 *   - the headline is `substrate_lift` (fidelity vs. control), not
 *     variance. Agreement is not correctness. */
export function aggregateScores(
  run: CrossModelRunResult,
  replyScores: ReplyScore[]
): ScoringResult {
  const providerIds = Array.from(new Set(run.replies.map((r) => r.provider_id)));
  const arms = Array.from(
    new Set(replyScores.map((s) => s.arm ?? "identity"))
  ) as BenchmarkArm[];

  const per_provider: ProviderAggregate[] = [];
  for (const arm of arms) {
    for (const id of providerIds) {
      const rows = replyScores.filter(
        (s) => s.provider_id === id && (s.arm ?? "identity") === arm
      );
      if (rows.length === 0) continue;
      const meanOf = (
        key: "trait_adherence" | "voice_signature" | "decision_pattern" | "relationship_handling" | "preference_respect"
      ) => rows.reduce((acc, r) => acc + r[key].score, 0) / rows.length;
      // Only scenes that actually scored a refusal contribute.
      const refusalRows = rows.filter((r) => r.refusal_pattern !== null);
      const refusalMean =
        refusalRows.length > 0
          ? refusalRows.reduce((acc, r) => acc + (r.refusal_pattern as DimensionScore).score, 0) /
            refusalRows.length
          : null;
      per_provider.push({
        provider_id: id,
        arm,
        mean_overall: rows.reduce((acc, r) => acc + r.overall, 0) / rows.length,
        scene_count: rows.length,
        per_dimension_mean: {
          trait_adherence: meanOf("trait_adherence"),
          voice_signature: meanOf("voice_signature"),
          decision_pattern: meanOf("decision_pattern"),
          relationship_handling: meanOf("relationship_handling"),
          preference_respect: meanOf("preference_respect"),
          refusal_pattern: refusalMean,
        },
      });
    }
  }

  const armTrait = (arm: BenchmarkArm): number | null => {
    const rows = per_provider.filter((p) => p.arm === arm);
    if (rows.length === 0) return null;
    return (
      rows.reduce((s, p) => s + p.per_dimension_mean.trait_adherence, 0) /
      rows.length
    );
  };
  const identityTrait = armTrait("identity") ?? 0;
  const controlTrait = armTrait("control");

  // Stability = spread of trait_adherence across providers, identity arm.
  const identityRows = per_provider.filter((p) => p.arm === "identity");
  const { variance, stddev } = varianceOf(
    identityRows.map((p) => p.per_dimension_mean.trait_adherence)
  );
  const legacy = varianceOf(identityRows.map((p) => p.mean_overall));

  return {
    character_id: run.character_id,
    ran_at: run.ran_at,
    per_reply: replyScores,
    per_provider,
    substrate_lift: {
      identity_trait_adherence: identityTrait,
      control_trait_adherence: controlTrait,
      lift: controlTrait === null ? null : identityTrait - controlTrait,
    },
    cross_provider_variance: variance,
    cross_provider_stddev: stddev,
    legacy_overall_variance: legacy.variance,
    legacy_overall_stddev: legacy.stddev,
  };
}

function zeroScore(
  provider_id: string,
  scene_id: string,
  arm: BenchmarkArm = "identity"
): ReplyScore {
  const zero = (): DimensionScore => ({ score: 0, notes: "reply failed or empty" });
  return {
    provider_id,
    scene_id,
    arm,
    trait_adherence: zero(),
    voice_signature: zero(),
    decision_pattern: zero(),
    relationship_handling: zero(),
    preference_respect: zero(),
    // Null, not zero — a failed call is not evidence about refusal
    // behavior, and coercing it would bias the aggregate.
    refusal_pattern: null,
    overall: 0,
  };
}

async function llmJudge(
  judge: LlmProvider,
  model: string,
  prompt: string
): Promise<DimensionScore> {
  try {
    const reply = await judge.chat({
      model,
      system: JUDGE_SYSTEM,
      messages: [{ role: "user", content: prompt }],
      temperature: 0,
      max_tokens: 200,
    });
    const parsed = parseJudgeJson(reply.content);
    if (!parsed) return { score: 0.5, notes: "judge output not parseable" };
    return parsed;
  } catch (e) {
    return {
      score: 0.5,
      notes: `judge error: ${e instanceof Error ? e.message : String(e)}`,
    };
  }
}

function parseJudgeJson(text: string): DimensionScore | null {
  const trimmed = text
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/```\s*$/, "")
    .trim();
  try {
    const v = JSON.parse(trimmed) as Record<string, unknown>;
    if (typeof v.score === "number") {
      const score = Math.max(0, Math.min(1, v.score));
      const notes = typeof v.notes === "string" ? v.notes : "";
      return { score, notes };
    }
  } catch {
    /* try scan for {...} */
  }
  // Scan for a balanced {...} block — judges sometimes emit reasoning
  // text before the JSON.
  const candidates: string[] = [];
  let depth = 0;
  let start = -1;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === "{") {
      if (depth === 0) start = i;
      depth++;
    } else if (ch === "}") {
      depth--;
      if (depth === 0 && start >= 0) {
        candidates.push(text.slice(start, i + 1));
        start = -1;
      }
    }
  }
  for (let i = candidates.length - 1; i >= 0; i--) {
    try {
      const v = JSON.parse(candidates[i]) as Record<string, unknown>;
      if (typeof v.score === "number") {
        const score = Math.max(0, Math.min(1, v.score));
        const notes = typeof v.notes === "string" ? v.notes : "";
        return { score, notes };
      }
    } catch {
      /* keep scanning */
    }
  }
  return null;
}
