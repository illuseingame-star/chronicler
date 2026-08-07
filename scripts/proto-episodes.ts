// PROTOTYPE — relationship-typed episodes. Not wired into the app.
//
// Tests the hinge of the "memories build character, character makes
// relationship, relationship makes episodes" idea:
//
//   Given the relationship state carried out of episode N-1, can a model
//   read episode N and (a) name what the bond IS and what stage it's at,
//   (b) name what actually CHANGED between the two people, and (c) hand
//   forward a state that stays coherent — no resetting to strangers in
//   episode 3?
//
// That last property is the one that matters. Chronicler today tracks
// drift as axis values (trust/openness/guarded); it cannot say what the
// relationship IS or what stage it's at, so nothing constrains episode 3
// from behaving like episode 1.
//
// Run:  npx tsx scripts/proto-episodes.ts
//       MODEL=qwen3.5:9b npx tsx scripts/proto-episodes.ts

import type { ChatRequest, ChatResponse, LlmProvider } from "../src/lib/providers";

const OLLAMA = process.env.OLLAMA_URL ?? "http://localhost:11434";
const MODEL = process.env.MODEL ?? "qwen3.5:9b";

class DirectOllama implements LlmProvider {
  name = "proto";
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
        options: { temperature: req.temperature ?? 0.2, num_predict: req.max_tokens ?? 900 },
      }),
    });
    if (!res.ok) throw new Error(`${res.status}: ${await res.text()}`);
    const d = (await res.json()) as { message?: { content?: string; thinking?: string } };
    return { content: d.message?.content?.trim() ? d.message.content : (d.message?.thinking ?? "") };
  }
}

/** What an episode hands to the next one. This is the object Chronicler
 *  does not currently have — drift gives axes, not kind/stage/tension. */
interface RelationshipState {
  kind: string;        // "strangers" | "wary acquaintances" | "frenemies" | "slow-burn romance" | ...
  stage: string;       // where along that kind's arc
  open_tension: string; // the unresolved thing that pulls the next episode
  carried_facts: string[];
}

interface EpisodeRecord {
  title: string;
  what_changed: string;
  beats: string[];
  relationship_after: RelationshipState;
}

const SYSTEM = `You are the continuity editor for a serialized character drama. You read one episode and report what happened BETWEEN the two people.

You are given the relationship state as it stood at the END of the previous episode. Your job is to carry it forward honestly.

RULES THAT MATTER MOST:
- Relationships do not reset. If the previous state says they are past being strangers, they are past it. Never regress the bond unless the episode contains a specific rupture that earns it.
- Movement is usually SMALL. Most episodes nudge a relationship; few transform it. "no meaningful change" is a valid and common answer for what_changed.
- Name the KIND of bond, not a score. Examples of kinds: strangers, wary acquaintances, working alliance, frenemies, found family, slow-burn romance, estranged, rivals-with-respect. Invent a better label if none fit.
- open_tension is the unresolved thing that would make someone want the next episode. One sentence. If genuinely nothing is unresolved, say so.
- Only report what the episode text supports. Do not invent backstory.

OUTPUT STRICT JSON, no commentary:
{"title": "...", "what_changed": "...", "beats": ["...", "..."], "relationship_after": {"kind": "...", "stage": "...", "open_tension": "...", "carried_facts": ["..."]}}

title: how a viewer would refer to this episode — concrete, from the episode's own events. Not "Episode 3".`;

/** Three episodes over simulated weeks. Written so the bond genuinely
 *  moves, INCLUDING a setback — a monotonic warm-up would not test whether
 *  the model can hold a line under pressure. */
const EPISODES = [
  {
    when: "Day 1",
    text: `Late evening at The Salt Page, Ren's second-hand bookshop. Alex comes in out of the rain, browsing without buying, clearly killing time.

ALEX: "You're open late."
REN: *doesn't look up from the ledger* "The rain's open late. I'm just here."
ALEX: "Fair. I'm Alex, by the way."
REN: *a pause, a pencil mark* "Ren."
ALEX: "That's it? Just Ren?"
REN: "That's it so far." *finally looks up* "You've picked up the same book three times and put it down. You don't want the book."
ALEX: *caught* "...No. I don't."
REN: "Then sit. The chair by the stove doesn't mind."`,
  },
  {
    when: "Day 9",
    text: `Alex has come by four times since. Today they bring two coffees without asking what Ren takes.

ALEX: "Black. I guessed."
REN: *takes it* "You guessed right." *sets it down without drinking* "You've been coming a lot."
ALEX: "Is that a complaint?"
REN: "It's an observation. I make those." *a beat* "My uncle left me this shop. I was nineteen. I've been here since."
ALEX: "That's the first real thing you've told me."
REN: *goes back to the shelves* "Don't make it a ceremony."
ALEX: *smiling at the shelf* "Wouldn't dream of it."`,
  },
  {
    when: "Day 23",
    text: `Alex arrives with someone else — a colleague, loud and friendly, who talks over Ren twice and calls the shop "quaint."

COLLEAGUE: "You should really put in better lighting, mate. Nobody can see anything."
REN: *flat* "People find what they came for."
ALEX: *laughing along with the colleague* "He's got a system. Allegedly."
REN: *says nothing, moves behind the counter, starts sorting receipts that do not need sorting.*

Later, after the colleague leaves, Alex lingers.

ALEX: "That was — sorry. He's a lot."
REN: "You laughed."
ALEX: "...I did."
REN: *doesn't look up* "It's fine. Shop's still here." *and it plainly is not fine*`,
  },
];

function parseJson(text: string): EpisodeRecord | null {
  const cleaned = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "").trim();
  try {
    return JSON.parse(cleaned) as EpisodeRecord;
  } catch { /* scan for a balanced object */ }
  let depth = 0, start = -1;
  for (let i = 0; i < text.length; i++) {
    if (text[i] === "{") { if (depth === 0) start = i; depth++; }
    else if (text[i] === "}") { depth--; if (depth === 0 && start >= 0) {
      try { return JSON.parse(text.slice(start, i + 1)) as EpisodeRecord; } catch { start = -1; }
    } }
  }
  return null;
}

async function main(): Promise<void> {
  console.log(`Episode prototype — relationship-typed serial continuity`);
  console.log(`model: ${MODEL}\n`);
  const llm = new DirectOllama();

  let state: RelationshipState = {
    kind: "strangers",
    stage: "no prior contact",
    open_tension: "none yet",
    carried_facts: [],
  };

  for (let i = 0; i < EPISODES.length; i++) {
    const ep = EPISODES[i];
    const prompt = `PREVIOUS RELATIONSHIP STATE (end of episode ${i}):
${JSON.stringify(state, null, 2)}

EPISODE ${i + 1} — ${ep.when}
${ep.text}

Report what happened between Ren and Alex. Return JSON only.`;

    const reply = await llm.chat({
      model: MODEL,
      system: SYSTEM,
      messages: [{ role: "user", content: prompt }],
      temperature: 0.2,
      max_tokens: 900,
    });
    const rec = parseJson(reply.content);
    console.log(`${"═".repeat(66)}`);
    console.log(`EPISODE ${i + 1} — ${ep.when}`);
    console.log("═".repeat(66));
    if (!rec) {
      console.log("  ✗ unparseable:", reply.content.slice(0, 200));
      continue;
    }
    console.log(`  title        : ${rec.title}`);
    console.log(`  what changed : ${rec.what_changed}`);
    console.log(`  beats        :`);
    for (const b of rec.beats ?? []) console.log(`      · ${b}`);
    const a = rec.relationship_after;
    console.log(`  ── carried forward ──`);
    console.log(`  kind         : ${state.kind}  ->  ${a?.kind}`);
    console.log(`  stage        : ${a?.stage}`);
    console.log(`  open tension : ${a?.open_tension}`);
    console.log(`  facts        : ${(a?.carried_facts ?? []).join(" | ") || "(none)"}`);
    console.log("");
    if (a) state = a;
  }

  console.log("═".repeat(66));
  console.log("FINAL STATE");
  console.log("═".repeat(66));
  console.log(JSON.stringify(state, null, 2));
  console.log(`
WHAT TO LOOK FOR:
  · Does 'kind' progress and never regress to "strangers"?
  · Does episode 3 (the setback) reduce warmth WITHOUT resetting the bond?
  · Do carried_facts accumulate rather than reshuffle?
  · Is open_tension something you'd actually want the next episode for?`);
}

main().catch((e) => { console.error(e); process.exit(1); });
