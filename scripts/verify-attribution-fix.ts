// Behavioral verification of the attribution fix against a REAL model.
//
// The unit tests assert the prompt contract; they cannot assert that a
// model actually obeys it. This replays the exact exchange that produced
// the poisoned canon row "Ren's birthday is April 2nd" and checks what
// the extractor now writes.
//
// Run:  npx tsx scripts/verify-attribution-fix.ts

import { LlmExtractor } from "../src/lib/orchestrator/extract";
import type { ChatRequest, ChatResponse, LlmProvider } from "../src/lib/providers";
import type { Character, ChatTurn } from "../src/lib/orchestrator/types";

const OLLAMA = process.env.OLLAMA_URL ?? "http://localhost:11434";
const MODEL = process.env.EXTRACT_MODEL ?? "qwen2.5:7b";

class DirectOllama implements LlmProvider {
  name = "extract";
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
        options: { temperature: req.temperature ?? 0, num_predict: req.max_tokens ?? 600 },
      }),
    });
    if (!res.ok) throw new Error(`${res.status}: ${await res.text()}`);
    const d = (await res.json()) as { message?: { content?: string; thinking?: string } };
    return { content: d.message?.content?.trim() ? d.message.content : (d.message?.thinking ?? "") };
  }
}

const REN: Character = {
  id: "ren-1",
  name: "Ren",
  world_id: "salt-page",
  description: "A calm bookseller.",
};

function turn(role: ChatTurn["role"], speaker: string, content: string): ChatTurn {
  return { id: `t-${role}`, role, speaker, content, created_at: new Date(0).toISOString(), session_id: "s1" };
}

/** The two exchanges that actually poisoned canon, plus a control where
 *  the fact genuinely IS about the character. */
const CASES = [
  {
    label: "user states birthday, character echoes it",
    user: "My birthday is April 2nd.",
    reply: '"April 2nd," Ren repeats, marking the ledger. "A Tuesday, that year."',
    // Any entry asserting the birthday belongs to Ren is a failure.
    bad: /ren(?:'s)?\b[^.]{0,40}\bbirthday|birthday[^.]{0,30}\bren\b|share[sd]?\s+(?:the\s+)?same\s+birthday/i,
    good: /pranab(?:'s)?\b[^.]{0,40}\bbirthday|birthday[^.]{0,30}\bpranab\b/i,
  },
  {
    label: "user states cat's name in first person",
    user: "My cat's name is Kiku.",
    reply: '"Kiku," Ren says. "Good name for a cat."',
    bad: /ren(?:'s)?\s+cat|\bmy cat\b/i,
    // Subject-anchored, not possessive-specific: "Pranab's cat is Kiku"
    // and "Pranab has a cat named Kiku" are both correctly attributed.
    good: /pranab[^.]{0,30}\bcat\b|\bcat\b[^.]{0,30}pranab/i,
  },
  {
    label: "CONTROL — character states a fact about themselves",
    user: "Have you always run this shop?",
    reply: '"My uncle left me The Salt Page," Ren says. "I was nineteen."',
    bad: /pranab(?:'s)?\s+uncle|pranab[^.]{0,30}salt page/i,
    good: /ren(?:'s)?\b[^.]{0,40}uncle|uncle[^.]{0,30}\bren\b|ren[^.]{0,40}salt page/i,
  },
];

async function main(): Promise<void> {
  console.log(`Attribution fix — behavioral verification`);
  console.log(`model: ${MODEL}\n`);
  const extractor = new LlmExtractor(new DirectOllama(), MODEL);
  let failures = 0;

  for (const c of CASES) {
    console.log(`── ${c.label} ──`);
    console.log(`   user:  ${c.user}`);
    console.log(`   reply: ${c.reply.slice(0, 70)}…`);
    const result = await extractor.extract({
      character: REN,
      user_turn: turn("user", "Pranab", c.user),
      assistant_turn: turn("assistant", "Ren", c.reply),
      user_persona: { name: "Pranab" },
    });
    const all = [...result.canon, ...result.heuristic, ...result.reflex];
    console.log(`   extracted ${all.length}:`);
    for (const e of all) console.log(`     · ${e}`);

    const misattributed = all.filter((e) => c.bad.test(e));
    const correct = all.filter((e) => c.good.test(e));
    if (misattributed.length > 0) {
      failures++;
      console.log(`   ✗ MIS-ATTRIBUTED: ${misattributed.join(" | ")}`);
    } else if (correct.length > 0) {
      console.log(`   ✓ correctly attributed`);
    } else {
      // Dropping is acceptable — the prompt says an omitted fact is
      // cheaper than a false one. Only assertion of the WRONG subject fails.
      console.log(`   ~ fact dropped (acceptable: prompt prefers omission to guessing)`);
    }
    console.log("");
  }

  console.log("═".repeat(60));
  if (failures > 0) {
    console.log(`✗ FAIL — ${failures}/${CASES.length} cases still mis-attribute.`);
    process.exit(1);
  }
  console.log(`✓ PASS — no mis-attribution across ${CASES.length} cases.`);
}

main().catch((e) => { console.error(e); process.exit(1); });
