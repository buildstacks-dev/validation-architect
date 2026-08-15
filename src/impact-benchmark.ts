import { performance } from "node:perf_hooks";
import { planChangedImpact, type ExplainedImpactPlan, type ImpactPlannerInput } from "./impact.js";

export type ImpactBenchmarkCategory = "generated" | "historical" | "corruption-negative" | "shadow";

export interface ImpactBenchmarkCase {
  id: string;
  category: ImpactBenchmarkCategory;
  input: ImpactPlannerInput;
  expected_family_ids: string[];
  independently_reviewed?: boolean;
}

export interface ImpactBenchmarkCaseResult {
  id: string;
  category: ImpactBenchmarkCategory;
  selected_family_ids: string[];
  missed_family_ids: string[];
  extra_family_ids: string[];
  planning_latency_ms: number;
  full_ci_exactly_once: boolean;
  plan: ExplainedImpactPlan;
}

export interface ImpactBenchmarkReport {
  schema: "validation-architect/impact-benchmark/v1";
  trustworthy_advice: boolean;
  full_ci_remains_authoritative: true;
  selection_recall: number;
  missed_family_ids: string[];
  extra_selections: number;
  planning_latency_ms: number;
  categories_present: ImpactBenchmarkCategory[];
  cases: ImpactBenchmarkCaseResult[];
}

const REQUIRED_CATEGORIES: ImpactBenchmarkCategory[] = ["generated", "historical", "corruption-negative", "shadow"];
const unique = (values: readonly string[]): string[] => [...new Set(values)].sort();

export function runImpactBenchmark(fixtures: readonly ImpactBenchmarkCase[]): ImpactBenchmarkReport {
  const cases = fixtures.map((fixture): ImpactBenchmarkCaseResult => {
    const start = performance.now();
    const plan = planChangedImpact(fixture.input);
    const latency = performance.now() - start;
    const expected = new Set(fixture.expected_family_ids);
    const selected = new Set(plan.family_ids);
    return {
      id: fixture.id,
      category: fixture.category,
      selected_family_ids: [...selected].sort(),
      missed_family_ids: [...expected].filter((id) => !selected.has(id)).sort(),
      extra_family_ids: [...selected].filter((id) => !expected.has(id)).sort(),
      planning_latency_ms: latency,
      full_ci_exactly_once: plan.full_required_ci.run_count === 1
        && plan.commands.filter((item) => item.purpose === "full-required-ci").length === 1,
      plan,
    };
  });
  const expectedCount = fixtures.reduce((sum, item) => sum + new Set(item.expected_family_ids).size, 0);
  const missed = unique(cases.flatMap((item) => item.missed_family_ids));
  const missedCount = cases.reduce((sum, item) => sum + item.missed_family_ids.length, 0);
  const categories = unique(cases.map((item) => item.category)) as ImpactBenchmarkCategory[];
  const shadowReviewed = fixtures.filter((item) => item.category === "shadow").every((item) => item.independently_reviewed === true);
  return {
    schema: "validation-architect/impact-benchmark/v1",
    trustworthy_advice: REQUIRED_CATEGORIES.every((category) => categories.includes(category))
      && shadowReviewed
      && missedCount === 0
      && cases.every((item) => item.full_ci_exactly_once),
    full_ci_remains_authoritative: true,
    selection_recall: expectedCount === 0 ? 1 : (expectedCount - missedCount) / expectedCount,
    missed_family_ids: missed,
    extra_selections: cases.reduce((sum, item) => sum + item.extra_family_ids.length, 0),
    planning_latency_ms: cases.reduce((sum, item) => sum + item.planning_latency_ms, 0),
    categories_present: categories,
    cases,
  };
}
