// Settle a diagnosis I have been guessing at.
//
// Observed in a drive-session recap: "Ren shares the same birthday as the
// user" and "Pranab is actually a cat". April 2nd was the USER's birthday;
// Ren echoed it back in dialogue. Two candidate causes, different fixes:
//
//   (A) EXTRACTOR mis-attribution — the extractor read Ren's echo of a user
//       fact and wrote a canon row whose SUBJECT is Ren. Then the recap is
//       faithfully reporting poisoned canon, and hardening the recap path
//       fixes nothing. Fix = subject/speaker attribution at extraction.
//
//   (B) RECAP invention — canon is clean, and the recap generator fabricated
//       the attribution while summarizing. Fix = recap as derived view.
//
// Both may be true. This dumps the actual rows so the workplan stops being
// a guess.
//
// Run:  npx tsx scripts/diagnose-attribution.ts

import { McpTransport } from "../src/lib/yantrikdb/mcp-transport";
import { YantrikClient } from "../src/lib/yantrikdb/client";

const STACK = process.env.CHRONICLER_URL ?? "http://127.0.0.1:3001/api/mcp";

// Facts the driver script establishes about the USER (never about Ren).
const USER_FACTS = [
  { label: "birthday April 2nd", probe: "birthday April 2nd", terms: ["april 2"] },
  { label: "cat named Kiku", probe: "cat named Kiku", terms: ["kiku"] },
  { label: "hometown Oji", probe: "hometown fishing village Oji", terms: ["oji"] },
  { label: "name Pranab", probe: "the user's name", terms: ["pranab"] },
];

/** Heuristic: does this row's text attribute the fact to Ren rather than
 *  to the user? Looks for the character as grammatical subject. */
function attributionVerdict(text: string): "character-subject" | "user-subject" | "ambiguous" {
  const t = text.toLowerCase();
  const charSubject = /\b(ren)\b[^.!?]{0,40}\b(is|was|has|had|shares?|owns?|lives?|grew|likes?|prefers?|celebrat)/;
  const userSubject = /\b(pranab|the user|user's|driver)\b/;
  if (charSubject.test(t) && !userSubject.test(t)) return "character-subject";
  if (userSubject.test(t)) return "user-subject";
  return "ambiguous";
}

async function main(): Promise<void> {
  const t = new McpTransport({ kind: "streamable-http", url: STACK });
  const client = new YantrikClient(t);

  console.log("═".repeat(74));
  console.log("ATTRIBUTION DIAGNOSTIC — are user-facts stored as character-facts?");
  console.log("═".repeat(74));

  let characterSubjectRows = 0;
  let totalMatched = 0;

  for (const fact of USER_FACTS) {
    console.log(`\n── ${fact.label} ──`);
    const res = await client.recall({ query: fact.probe, top_k: 12 });
    const rows = (res.results ?? []).filter((r) => {
      const text = String((r as { text?: string }).text ?? "").toLowerCase();
      return fact.terms.some((term) => text.includes(term));
    });
    if (rows.length === 0) {
      console.log("  (no matching rows)");
      continue;
    }
    for (const r of rows) {
      const row = r as { text?: string; rid?: string; metadata?: Record<string, unknown> };
      const text = String(row.text ?? "");
      const verdict = attributionVerdict(text);
      totalMatched++;
      if (verdict === "character-subject") characterSubjectRows++;
      const mark = verdict === "character-subject" ? "✗ MIS-ATTRIBUTED" : verdict === "user-subject" ? "✓ user-subject  " : "? ambiguous     ";
      console.log(`  ${mark} ${text.slice(0, 110)}${text.length > 110 ? "…" : ""}`);
      const md = row.metadata ?? {};
      const keys = Object.keys(md);
      if (keys.length) {
        console.log(`      metadata: ${JSON.stringify(md).slice(0, 160)}`);
      } else {
        console.log(`      metadata: (none returned — YantrikDB strips it on read)`);
      }
    }
  }

  console.log(`\n${"═".repeat(74)}`);
  console.log("VERDICT");
  console.log("═".repeat(74));
  console.log(`rows matching a user-fact:        ${totalMatched}`);
  console.log(`rows with CHARACTER as subject:   ${characterSubjectRows}`);
  if (characterSubjectRows > 0) {
    console.log(`
→ (A) EXTRACTOR MIS-ATTRIBUTION is real. Canon itself is poisoned: facts
  the user stated, echoed by the character, were written with the CHARACTER
  as subject. The recap was reporting poisoned canon.
  Fix belongs at extraction (subject/speaker attribution), not in the recap.`);
  } else {
    console.log(`
→ No character-subject rows found for user facts. Canon looks clean, which
  points at (B) RECAP INVENTION — the generator fabricated the attribution
  while summarizing. Fix belongs in the recap path (derived view, must cite).`);
  }
  console.log(`
NOTE: both fixes may still be warranted. Recap-cannot-create-canon is cheap
defense in depth regardless of which cause this run implicates.`);

  await t.close();
}

main().catch((e) => { console.error("diagnostic failed:", e); process.exit(1); });
