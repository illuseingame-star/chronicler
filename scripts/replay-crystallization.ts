// Replay harness — manufacture a play-crystallized character on demand.
//
// WHY THIS EXISTS
// Core-trait promotion requires >=4 distinct sessions spanning >=7 days.
// There is no amount of playing in one sitting that produces a core trait,
// so the crystallization path had never been exercised end-to-end. That is
// how the SkillFormer/Verifier framing mismatch went unnoticed, and why the
// published benchmark had to use a hand-authored fixture instead of a
// character grown through play.
//
// HOW IT AVOIDS CHEATING
// It does NOT backdate rows in the database — that would test states
// production can never reach. Time enters only through the seams the
// production code already exposes (`opts.now` on SkillOutcomeTracker.record
// and CoreTraitPromoter.run), and every write goes through the real client,
// the real tracker, and the real promoter. What is simulated is the passage
// of time and the user's reactions; the machinery under test is production.
//
// WHAT IT PROVES (and does not)
// Proves: given N sessions of positive outcomes spread over D days, the
// real promoter + real LLM verifier will (or will not) crystallize a trait,
// and which phrasings survive. Does NOT prove ecological validity — real
// users produce messier outcome streams than a script.
//
// Run:  npx tsx scripts/replay-crystallization.ts
//       SESSIONS=5 DAYS=10 VERIFY_MODEL=qwen3.5:9b npx tsx scripts/replay-crystallization.ts

import { McpTransport } from "../src/lib/yantrikdb/mcp-transport";
import { YantrikClient } from "../src/lib/yantrikdb/client";
import { SkillOutcomeTracker } from "../src/lib/orchestrator/skill-outcomes";
import { CoreTraitVerifier } from "../src/lib/skills/core-trait-verifier";
import {
  CoreTraitPromoter,
  PROMOTION_CRITERIA,
} from "../src/lib/skills/core-trait-promoter";
import { listCoreTraitsForCharacter } from "../src/lib/skills/core-trait-promotions";
import type { ChatRequest, ChatResponse, LlmProvider } from "../src/lib/providers";

// ── localStorage polyfill: core-trait promotions persist there ──
class MemoryStorage {
  private map = new Map<string, string>();
  getItem(k: string): string | null { return this.map.get(k) ?? null; }
  setItem(k: string, v: string): void { this.map.set(k, v); }
  removeItem(k: string): void { this.map.delete(k); }
  clear(): void { this.map.clear(); }
  key(i: number): string | null { return Array.from(this.map.keys())[i] ?? null; }
  get length(): number { return this.map.size; }
}
(globalThis as unknown as { localStorage: unknown }).localStorage = new MemoryStorage();

const STACK = process.env.CHRONICLER_URL ?? "http://127.0.0.1:3001/api/mcp";
const OLLAMA = process.env.OLLAMA_URL ?? "http://localhost:11434";
const VERIFY_MODEL = process.env.VERIFY_MODEL ?? "qwen3.5:9b";
const SESSIONS = Number(process.env.SESSIONS ?? 5);
const DAYS = Number(process.env.DAYS ?? 10);

const TAG = Date.now().toString(36);
const CHARACTER_ID = `replay-ren-${TAG}`;
const CHARACTER_NAME = "Ren";

class DirectOllama implements LlmProvider {
  name = "verifier";
  async chat(req: ChatRequest): Promise<ChatResponse> {
    const res = await fetch(`${OLLAMA}/api/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: req.model,
        messages: [
          { role: "system", content: req.system },
          ...req.messages.map((m) => ({ role: m.role, content: m.content })),
        ],
        stream: false,
        think: false,
        options: { temperature: req.temperature ?? 0, num_predict: req.max_tokens ?? 800 },
      }),
    });
    if (!res.ok) throw new Error(`${res.status}: ${await res.text()}`);
    const d = (await res.json()) as { message?: { content?: string; thinking?: string } };
    return { content: d.message?.content?.trim() ? d.message.content : (d.message?.thinking ?? "") };
  }
}

/** Candidate bodies in the two phrasings under test.
 *
 *  "behavior" is the shape SkillFormer actually emits (its prompt asks for
 *  action-oriented descriptions). "posture" is the shape the Verifier was
 *  observed to accept. Running both through the SAME pipeline is the point:
 *  it measures the framing mismatch instead of assuming it. */
const CANDIDATES = [
  {
    id: "observation",
    behavior: "Ren watches the room before speaking when someone new arrives.",
    posture: "Ren is fundamentally observation-led. Speaking is something Ren does after watching, never the opening move.",
  },
  {
    id: "caution",
    behavior: "Ren repeats names and dates slowly when someone tells him one.",
    posture: "Ren is quietly cautious with new information, turning what matters over slowly before keeping it.",
  },
  {
    id: "reserve",
    behavior: "Ren answers personal questions with a remark about the weather.",
    posture: "Ren is uncomfortable with performative warmth and meets it with a literal observation instead of social filler.",
  },
];

/** A clean positive observation — the user accepted the reply and moved on. */
const ACCEPTED = {
  surfaced_at_turn: 0,
  turns_observed: 2,
  regenerated_within: Infinity,
  retconned_within: Infinity,
  deleted_related: false,
};

async function main(): Promise<void> {
  console.log(`Replay crystallization harness`);
  console.log(`  character : ${CHARACTER_ID}`);
  console.log(`  sessions  : ${SESSIONS} across ${DAYS} simulated days`);
  console.log(`  verifier  : ${VERIFY_MODEL}`);
  console.log(`  criteria  : net>=${PROMOTION_CRITERIA.min_net_score}, sessions>=${PROMOTION_CRITERIA.min_distinct_sessions}, days>=${PROMOTION_CRITERIA.min_days_active}, success>=${PROMOTION_CRITERIA.min_success_rate}`);
  console.log("");

  const transport = new McpTransport({ kind: "streamable-http", url: STACK });
  const client = new YantrikClient(transport);
  const tracker = new SkillOutcomeTracker(client);

  // Anchor the simulated timeline in the past so "now" lands after it.
  const t0 = new Date(Date.now() - DAYS * 24 * 60 * 60 * 1000);
  const dayMs = 24 * 60 * 60 * 1000;
  const spacing = (DAYS * dayMs) / Math.max(1, SESSIONS - 1);

  // Define every candidate as a real skill in the substrate.
  const skillIds: Record<string, string> = {};
  for (const c of CANDIDATES) {
    for (const shape of ["behavior", "posture"] as const) {
      const skill_id = `${CHARACTER_ID}-${c.id}-${shape}`;
      skillIds[`${c.id}:${shape}`] = skill_id;
      await client.skillDefine({
        skill_id,
        body: c[shape],
        skill_type: "pattern",
        applies_to: [CHARACTER_ID],
      });
    }
  }
  console.log(`defined ${Object.keys(skillIds).length} skills\n`);

  // ── Replay sessions, advancing the clock between them ──
  console.log("── replaying sessions ──");
  for (let s = 0; s < SESSIONS; s++) {
    const when = new Date(t0.getTime() + s * spacing);
    const session_id = `${CHARACTER_ID}-s${s}`;
    let recorded = 0;
    for (const [, skill_id] of Object.entries(skillIds)) {
      // Two positive outcomes per skill per session — enough that
      // net_score clears the threshold by session 4.
      for (let turn = 0; turn < 2; turn++) {
        await tracker.record(
          skill_id,
          session_id,
          { ...ACCEPTED, surfaced_at_turn: turn },
          { now: when }
        );
        recorded++;
      }
    }
    console.log(`  session ${s + 1}/${SESSIONS} @ day ${((when.getTime() - t0.getTime()) / dayMs).toFixed(1)} — ${recorded} outcomes`);
  }
  console.log("");

  // ── Run the REAL promoter at a "now" past the whole timeline ──
  console.log("── running the real promoter (live LLM verifier) ──");
  const verifier = new CoreTraitVerifier(new DirectOllama(), VERIFY_MODEL);
  const promoter = new CoreTraitPromoter(client, verifier);
  const now = new Date();
  const result = await promoter.run({
    character_id: CHARACTER_ID,
    character_name: CHARACTER_NAME,
    now,
  });

  console.log(`  promoted            : ${result.promoted.length}`);
  console.log(`  rejected by verifier: ${result.rejected.length}`);
  console.log(`  failed quantitative : ${result.skipped_quantitative}`);
  console.log("");

  // ── Report by phrasing shape — the actual question ──
  const shapeOf = (skill_id: string): "behavior" | "posture" =>
    /_posture$|-posture$/.test(skill_id) ? "posture" : "behavior";
  const tally = { behavior: { pass: 0, fail: 0 }, posture: { pass: 0, fail: 0 } };

  for (const p of result.promoted) {
    tally[shapeOf(p.skill_id)].pass++;
    console.log(`  ✓ PROMOTED [${shapeOf(p.skill_id)}] rank ${p.rank.toFixed(2)}`);
    console.log(`      ${p.reasoning.slice(0, 150)}`);
  }
  for (const r of result.rejected) {
    tally[shapeOf(r.skill_id)].fail++;
    console.log(`  ✗ rejected [${shapeOf(r.skill_id)}]`);
    console.log(`      ${r.reasoning.slice(0, 150)}`);
  }

  const crystallized = listCoreTraitsForCharacter(CHARACTER_ID);
  console.log(`\n${"═".repeat(64)}`);
  console.log(`crystallized traits in the store: ${crystallized.length}`);
  console.log(`  behavior-phrased : ${tally.behavior.pass} promoted / ${tally.behavior.fail} rejected`);
  console.log(`  posture-phrased  : ${tally.posture.pass} promoted / ${tally.posture.fail} rejected`);

  if (result.skipped_quantitative > 0 && crystallized.length === 0) {
    console.log(`\n⚠ Nothing cleared the QUANTITATIVE gate — the replay did not`);
    console.log(`  generate enough evidence. Raise SESSIONS/DAYS and re-run;`);
    console.log(`  this is a harness calibration issue, not a verifier verdict.`);
  } else if (tally.posture.pass > tally.behavior.pass) {
    console.log(`\n→ CONFIRMS the framing mismatch: identity-posture phrasing`);
    console.log(`  crystallizes where behavior phrasing does not. Since`);
    console.log(`  SkillFormer emits behavior phrasing, the identity layer will`);
    console.log(`  stay empty in real use until a synthesis step abstracts`);
    console.log(`  posture from accumulated behavioral skills.`);
  } else if (tally.behavior.pass > 0) {
    console.log(`\n→ Behavior phrasing DID crystallize. The mismatch may be`);
    console.log(`  weaker than the earlier hand-authored probe suggested —`);
    console.log(`  worth re-examining before building a synthesis step.`);
  }

  await transport.close();
}

main().catch((e) => {
  console.error("replay failed:", e);
  process.exit(1);
});
