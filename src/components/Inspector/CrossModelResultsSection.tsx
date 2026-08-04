// Phase 11 Pillar 4 — cross-model consistency display.
//
// Renders the latest cross-model benchmark result inside the Identity
// inspector. Goal: make the model-independence claim auditable from
// the UI, not only the docs. When no benchmark has been run yet, this
// section explains the methodology and points to the CLI runner.
//
// Data flows in via props; loading is up to the host (App.tsx imports
// the embedded result module written by the benchmark script).

import { useState } from "react";

export interface BenchmarkProviderResult {
  provider_id: string;
  /** "identity" | "control". Older embedded results predate the control
   *  arm and omit it; treated as "identity". */
  arm?: string;
  mean_overall: number;
  scene_count: number;
  per_dimension_mean: {
    trait_adherence: number;
    voice_signature: number;
    decision_pattern: number;
    relationship_handling: number;
    preference_respect: number;
    /** Null when no scene in this arm tested a limit. */
    refusal_pattern: number | null;
  };
}

/** Fidelity against control — the headline. Absent on pre-2026-08-04 runs. */
export interface BenchmarkSubstrateLift {
  identity_trait_adherence: number;
  control_trait_adherence: number | null;
  lift: number | null;
}

export interface CrossModelBenchmarkResult {
  character_id: string;
  character_name: string;
  ran_at: string;
  judge_model: string;
  participants: string[];
  scene_labels: { id: string; label: string }[];
  cross_provider_variance: number;
  cross_provider_stddev: number;
  per_provider: BenchmarkProviderResult[];
  /** Absent on runs published before the control arm existed. */
  substrate_lift?: BenchmarkSubstrateLift;
}

interface Props {
  /** The benchmark result to render. Undefined means no benchmark has
   *  been published yet; we explain the methodology instead. */
  result: CrossModelBenchmarkResult | null;
}

export function CrossModelResultsSection({ result }: Props) {
  const [expanded, setExpanded] = useState(false);
  return (
    <section className="rounded-md border border-amber-800/50 bg-amber-950/15 p-3">
      <header className="flex items-center justify-between mb-2">
        <div>
          <h3 className="text-[12px] font-medium text-amber-300">
            Cross-model consistency
          </h3>
          <p className="text-[10px] text-neutral-500 mt-0.5">
            Does the same character emerge across different LLMs?
          </p>
        </div>
        {result && (
          <span
            className={`text-[10px] font-mono px-1.5 py-0.5 rounded ${verdictStyle(result)}`}
            title="Mean trait adherence across providers — the dimension that tests whether replies embody the crystallized traits. Cross-provider σ is shown alongside but is not the headline: agreement is not fidelity."
          >
            trait {meanTraitAdherence(result).toFixed(2)} · σ{" "}
            {result.cross_provider_stddev.toFixed(3)}
          </span>
        )}
      </header>
      {result ? (
        <ResultBody
          result={result}
          expanded={expanded}
          onToggle={() => setExpanded(!expanded)}
        />
      ) : (
        <EmptyState />
      )}
    </section>
  );
}

function EmptyState() {
  return (
    <div className="text-[11px] text-neutral-400 leading-relaxed space-y-2">
      <p>
        The cross-model benchmark fans the same character + same scene seeds out
        to multiple providers and scores each reply on six dimensions: trait
        adherence, voice signature, decision pattern, relationship handling,
        preference respect, and refusal pattern.
      </p>
      <p>
        The number that matters is{" "}
        <span className="text-amber-300 font-mono">trait adherence</span> — do
        the replies actually embody the crystallized traits — measured against
        a control arm with the identity blocks disabled. Cross-provider{" "}
        <span className="font-mono">σ</span> is reported alongside it, but low
        σ on its own only means the models agreed, and models can agree on a
        generic or wrong characterization.
      </p>
      <p className="text-neutral-500 italic">
        No benchmark has been published yet. Run{" "}
        <code className="text-emerald-400">
          npx tsx scripts/run-cross-model-benchmark.ts
        </code>{" "}
        from the chronicler/ directory to generate one.
      </p>
    </div>
  );
}

function ResultBody({
  result,
  expanded,
  onToggle,
}: {
  result: CrossModelBenchmarkResult;
  expanded: boolean;
  onToggle: () => void;
}) {
  return (
    <div className="space-y-2 text-[11px]">
      <p className="text-neutral-400 leading-relaxed">
        {verdictNarrative(result)}{" "}
        <span className="text-neutral-500">
          Same {result.character_name} across {result.participants.length} LLMs
          on {result.scene_labels.length} scenes; judge:{" "}
          <code className="text-emerald-400">{result.judge_model}</code>.
        </span>
      </p>
      <div className="space-y-1">
        {result.per_provider.map((p) => (
          <ProviderRow key={p.provider_id} provider={p} />
        ))}
      </div>
      <button
        type="button"
        onClick={onToggle}
        className="text-[10px] text-amber-400 hover:text-amber-300 mt-1"
      >
        {expanded ? "hide" : "show"} per-dimension breakdown
      </button>
      {expanded && <DimensionTable result={result} />}
      <p className="text-[10px] text-neutral-500 mt-1">
        Ran {new Date(result.ran_at).toLocaleString()}. See{" "}
        <code className="text-emerald-400">docs/CHARACTER-EMERGENCE-RESULTS.md</code>{" "}
        for methodology and raw replies.
      </p>
    </div>
  );
}

function ProviderRow({ provider }: { provider: BenchmarkProviderResult }) {
  const pct = Math.max(0, Math.min(1, provider.mean_overall));
  return (
    <div className="flex items-center gap-2 text-[11px]">
      <span className="font-mono text-amber-300 min-w-[7rem]">
        {provider.provider_id}
      </span>
      <div className="flex-1 h-2 rounded bg-neutral-900 overflow-hidden">
        <div
          className="h-full bg-amber-500/60"
          style={{ width: `${pct * 100}%` }}
        />
      </div>
      <span className="font-mono text-neutral-300 min-w-[3rem] text-right">
        {provider.mean_overall.toFixed(3)}
      </span>
    </div>
  );
}

function DimensionTable({ result }: { result: CrossModelBenchmarkResult }) {
  return (
    <div className="overflow-x-auto mt-1">
      <table className="w-full text-[10px] font-mono">
        <thead className="text-neutral-500">
          <tr>
            <th className="text-left font-normal pr-2">Provider</th>
            <th className="text-right font-normal px-1.5" title="trait_adherence">trait</th>
            <th className="text-right font-normal px-1.5" title="voice_signature">voice</th>
            <th className="text-right font-normal px-1.5" title="decision_pattern">decis</th>
            <th className="text-right font-normal px-1.5" title="relationship_handling">rel</th>
            <th className="text-right font-normal px-1.5" title="preference_respect">pref</th>
            <th className="text-right font-normal px-1.5" title="refusal_pattern">refuse</th>
          </tr>
        </thead>
        <tbody>
          {result.per_provider.map((p) => (
            <tr key={`${p.provider_id}-${p.arm ?? "identity"}`} className="text-neutral-300">
              <td className="text-left text-amber-300 pr-2">
                {p.provider_id}
                {p.arm === "control" && (
                  <span className="text-neutral-500"> [control]</span>
                )}
              </td>
              <td className="text-right px-1.5">{p.per_dimension_mean.trait_adherence.toFixed(2)}</td>
              <td className="text-right px-1.5">{p.per_dimension_mean.voice_signature.toFixed(2)}</td>
              <td className="text-right px-1.5">{p.per_dimension_mean.decision_pattern.toFixed(2)}</td>
              <td className="text-right px-1.5">{p.per_dimension_mean.relationship_handling.toFixed(2)}</td>
              <td className="text-right px-1.5">{p.per_dimension_mean.preference_respect.toFixed(2)}</td>
              <td
                className="text-right px-1.5"
                title={
                  p.per_dimension_mean.refusal_pattern === null
                    ? "No scene in this arm tested a limit — excluded from the aggregate rather than defaulted to 1.0"
                    : undefined
                }
              >
                {p.per_dimension_mean.refusal_pattern === null
                  ? "n/a"
                  : p.per_dimension_mean.refusal_pattern.toFixed(2)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** Mean trait_adherence across providers — the only dimension that tests
 *  whether replies actually embody the crystallized traits. Everything
 *  user-facing keys off this, NOT off mean_overall. */
function meanTraitAdherence(result: CrossModelBenchmarkResult): number {
  if (result.substrate_lift) return result.substrate_lift.identity_trait_adherence;
  // Identity arm only — averaging the control in would drag fidelity down
  // and misreport it. Rows without an arm predate the control and are
  // identity by construction.
  const rows = result.per_provider.filter((p) => (p.arm ?? "identity") === "identity");
  if (rows.length === 0) return 0;
  return (
    rows.reduce((s, p) => s + p.per_dimension_mean.trait_adherence, 0) / rows.length
  );
}

/** Badge colour keys off FIDELITY, not variance.
 *
 *  Variance alone measures agreement, not correctness — three models can
 *  converge on the same generic characterization and produce a beautiful
 *  σ. The 2026-06-09 run scored σ=0.087 within the qwen family while trait
 *  adherence averaged 0.275, and an earlier build of this component
 *  rendered that as "Strong substrate signal". It wasn't. */
function verdictStyle(result: CrossModelBenchmarkResult): string {
  const fidelity = meanTraitAdherence(result);
  if (fidelity < 0.4) return "bg-rose-700/60 text-rose-50";
  if (fidelity < 0.65) return "bg-amber-700/60 text-amber-50";
  return "bg-emerald-700/60 text-emerald-50";
}

function verdictNarrative(result: CrossModelBenchmarkResult): string {
  const fidelity = meanTraitAdherence(result);
  const f = fidelity.toFixed(3);
  const stddev = result.cross_provider_stddev.toFixed(3);
  if (fidelity < 0.4) {
    return `Not demonstrated: mean trait adherence ${f} — the models mostly did not embody the traits. Cross-provider σ ${stddev} reflects them failing similarly, not the substrate working.`;
  }
  if (fidelity < 0.65) {
    return `Partial: mean trait adherence ${f}, cross-provider σ ${stddev}. Directional, but not a clean result.`;
  }
  return `Traits embodied at ${f} mean adherence, cross-provider σ ${stddev}. Only meaningful against an identity-disabled control arm.`;
}
