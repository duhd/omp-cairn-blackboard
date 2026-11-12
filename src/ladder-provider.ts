/**
 * Summary provider for a Visibility Ladder extension (registry `Symbol.for("omp.visibility-ladder.providers")`).
 * A ladder collapses large tool results to short or hidden levels; when a fact on a board already quotes that
 * result in its evidence, the fact is the better summary, so the result collapses to a pointer at the fact.
 * Pure: the caller supplies the facts, so this module never touches SQLite.
 */

export const LADDER_PROVIDERS: unique symbol = Symbol.for("omp.visibility-ladder.providers");

/** Shorter lines (`}`, `ok`, blank padding) appear in many outputs and would link unrelated facts. */
const MIN_QUOTE = 40;
const MAX_FACT_TEXT = 300;

export interface LadderFact {
  id: string;
  text: string;
  evidence: string | null;
  status: string;
}

/**
 * The newest non-disputed fact whose evidence quotes a line of `blockText` verbatim, rendered as one line;
 * `undefined` when none does. `facts` are expected newest first, as `snapshotFrom` returns them.
 */
export function factFor(blockText: string, facts: readonly LadderFact[], project: string): string | undefined {
  const quotes = [...new Set(blockText.split("\n").map(line => line.trim()).filter(line => line.length >= MIN_QUOTE))];
  if (quotes.length === 0) return undefined;
  for (const fact of facts) {
    if (fact.status === "disputed" || !fact.evidence) continue;
    const evidence = fact.evidence;
    if (!quotes.some(quote => evidence.includes(quote))) continue;
    const text = fact.text.length > MAX_FACT_TEXT ? `${fact.text.slice(0, MAX_FACT_TEXT)}…` : fact.text;
    return `→ fact ${fact.id.slice(0, 12)} (board ${project || "default"}): ${text}`;
  }
  return undefined;
}
