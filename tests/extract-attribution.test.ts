// Regression test for the canon-poisoning attribution bug.
//
// Observed on 2026-08-04 in a live drive-session: a durable canon row
// reading "Ren's birthday is April 2nd". April 2nd was the USER's
// birthday. The user stated it, Ren repeated the date back in dialogue
// ("April 2nd," Ren repeats), and the extractor wrote it as a fact about
// Ren. A second row read "my cat's name is Kiku" — stored with the
// pronoun unresolved, so it had no subject anchor at all.
//
// Root cause: LlmExtractor's prompt named exactly one entity — the
// CHARACTER — and never told the model who the user was. Every fact
// collapsed onto the only available name.
//
// These tests are deterministic (scripted provider): they assert the
// prompt CONTRACT that makes correct attribution possible. Behavioral
// verification against a real model lives in
// scripts/verify-attribution-fix.ts, since prompt quality can't be
// asserted with a mock.

import {
  LlmExtractor,
  sanitizeExtraction,
  type ExtractionInput,
} from "../src/lib/orchestrator/extract";
import type { LlmProvider } from "../src/lib/providers";
import type { Character, ChatTurn } from "../src/lib/orchestrator/types";

function assert(cond: unknown, msg: string): void {
  if (!cond) throw new Error(`assert failed: ${msg}`);
}
function ok(msg: string): void {
  console.log("  ok  ", msg);
}

const REN: Character = {
  id: "ren-1",
  name: "Ren",
  world_id: "salt-page",
  description: "A calm bookseller.",
};

function turn(role: ChatTurn["role"], speaker: string, content: string): ChatTurn {
  return {
    id: `t-${role}`,
    role,
    speaker,
    content,
    created_at: new Date(0).toISOString(),
    session_id: "s1",
  };
}

/** Captures the prompts sent, returns an empty-but-valid extraction. */
function capturingProvider(sink: { system: string; user: string }[]): LlmProvider {
  return {
    name: "capture",
    async chat(req) {
      sink.push({
        system: req.system,
        user: req.messages.find((m) => m.role === "user")?.content ?? "",
      });
      return { content: '{"canon":[],"heuristic":[],"reflex":[]}' };
    },
  };
}

const EXCHANGE: Omit<ExtractionInput, "user_persona"> = {
  character: REN,
  user_turn: turn("user", "user", "My birthday is April 2nd."),
  assistant_turn: turn("assistant", "Ren", '"April 2nd," Ren repeats. "A Tuesday, that year."'),
};

async function test_prompt_names_the_user(): Promise<void> {
  console.log("--- extractor: the user is named in the prompt at all ---");
  const sink: { system: string; user: string }[] = [];
  await new LlmExtractor(capturingProvider(sink), "m").extract({
    ...EXCHANGE,
    user_persona: { name: "Pranab" },
  });
  assert(sink.length === 1, "one extraction call");
  const { system, user } = sink[0];
  assert(user.includes("Pranab"), "user persona name reaches the prompt");
  assert(
    system.includes("Pranab"),
    "attribution rules are written in terms of the actual user name"
  );
  assert(user.includes("Ren"), "character still named");
  ok("both parties named");
}

async function test_prompt_forbids_echo_attribution(): Promise<void> {
  console.log("--- extractor: prompt explicitly forbids treating an echo as a claim ---");
  const sink: { system: string; user: string }[] = [];
  await new LlmExtractor(capturingProvider(sink), "m").extract({
    ...EXCHANGE,
    user_persona: { name: "Pranab" },
  });
  const { system } = sink[0];
  assert(
    /repeats it back|echo/i.test(system),
    "prompt addresses the character echoing a user fact"
  );
  assert(
    system.includes("Ren's birthday is April 2nd"),
    "the exact observed failure is present as a WRONG worked example"
  );
  assert(
    system.includes("Pranab's birthday is April 2nd"),
    "the correct attribution is present as the CORRECT worked example"
  );
  ok("echo rule + worked example present");
}

async function test_prompt_requires_pronoun_resolution(): Promise<void> {
  console.log("--- extractor: prompt requires resolving 'my' before writing ---");
  const sink: { system: string; user: string }[] = [];
  await new LlmExtractor(capturingProvider(sink), "m").extract({
    character: REN,
    user_turn: turn("user", "user", "My cat's name is Kiku."),
    assistant_turn: turn("assistant", "Ren", '"Kiku," Ren says.'),
    user_persona: { name: "Pranab" },
  });
  const { system } = sink[0];
  assert(
    /resolve every pronoun/i.test(system),
    "pronoun-resolution rule present"
  );
  assert(
    system.includes("Pranab's cat is named Kiku"),
    "the exact second observed failure has a corrected worked example"
  );
  assert(
    /DROP IT|drop it/.test(system),
    "unattributable facts are dropped rather than guessed"
  );
  ok("pronoun resolution + drop-if-ambiguous");
}

async function test_falls_back_when_persona_absent(): Promise<void> {
  console.log("--- extractor: degrades to a usable subject when persona is unset ---");
  const sink: { system: string; user: string }[] = [];
  await new LlmExtractor(capturingProvider(sink), "m").extract(EXCHANGE);
  const { system, user } = sink[0];
  // Must NOT silently fall back to a state where the character is the only
  // named entity — that is the original bug.
  assert(
    user.includes("the user") || user.includes("USER"),
    "the user is still identified as a distinct party"
  );
  assert(
    system.includes("the user") || /USER/.test(system),
    "attribution rules still reference a user entity"
  );
  ok("safe degradation, character is never the sole entity");
}

async function test_persona_description_included(): Promise<void> {
  console.log("--- extractor: persona description is passed when present ---");
  const sink: { system: string; user: string }[] = [];
  await new LlmExtractor(capturingProvider(sink), "m").extract({
    ...EXCHANGE,
    user_persona: { name: "Pranab", description: "a traveling cartographer" },
  });
  assert(
    sink[0].user.includes("traveling cartographer"),
    "description reaches the prompt"
  );
  ok("persona description threaded");
}

// ── Structural sanitizer — the defense that does not trust the model ──

function test_sanitizer_drops_placeholder_leaks(): void {
  console.log("--- sanitizer: drops literal template placeholders ---");
  // Observed verbatim from qwen2.5:1.5b in a live drive-session.
  const out = sanitizeExtraction({
    canon: ["<C> keeps a calendar on the wall"],
    heuristic: ["Pranab's cat is named Kiku", "<U> prefers tea"],
    reflex: ["< C > is holding a cup"],
  });
  assert(out.canon.length === 0, "placeholder canon dropped");
  assert(out.reflex.length === 0, "spaced placeholder dropped too");
  assert(
    out.heuristic.length === 1 && out.heuristic[0].includes("Kiku"),
    "legitimate entry survives alongside a dropped one"
  );
  ok("placeholder leaks dropped");
}

function test_sanitizer_drops_unresolved_subjects(): void {
  console.log("--- sanitizer: drops claims with no resolved subject ---");
  const out = sanitizeExtraction({
    canon: ["my cat's name is Kiku", "I grew up in Oji"],
    heuristic: ["Pranab grew up in Oji", "your birthday is April 2nd"],
    reflex: [],
  });
  assert(out.canon.length === 0, "bare first-person claims dropped");
  assert(
    out.heuristic.length === 1 && out.heuristic[0].startsWith("Pranab"),
    "only the properly-attributed entry survives"
  );
  ok("unresolved subjects dropped");
}

function test_sanitizer_preserves_good_entries(): void {
  console.log("--- sanitizer: does not over-filter well-formed facts ---");
  const good = {
    canon: ["Pranab's birthday is April 2nd"],
    heuristic: ["Ren's uncle left Ren the shop", "Ren hums when nervous"],
    reflex: ["Ren is holding a cup of tea"],
  };
  const out = sanitizeExtraction(good);
  assert(out.canon.length === 1, "canon preserved");
  assert(out.heuristic.length === 2, "heuristic preserved");
  assert(out.reflex.length === 1, "reflex preserved");
  ok("well-formed entries untouched");
}

(async () => {
  try {
    test_sanitizer_drops_placeholder_leaks();
    test_sanitizer_drops_unresolved_subjects();
    test_sanitizer_preserves_good_entries();
    await test_prompt_names_the_user();
    await test_prompt_forbids_echo_attribution();
    await test_prompt_requires_pronoun_resolution();
    await test_falls_back_when_persona_absent();
    await test_persona_description_included();
    console.log("\n--- PASS: extract-attribution ---");
  } catch (e) {
    console.error("--- FAIL: extract-attribution ---", e);
    process.exit(1);
  }
})();
