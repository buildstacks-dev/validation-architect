/** Typed surface of the shipped control-sweep template (VA-ENF-008). */

export interface SweepPlanEntry {
  control_id: string;
  family_id: string;
  expected_failure: string;
  command?: string;
  paths: string[];
}

export interface SweepPlanSkip {
  control_id: string;
  family_id: string;
  reason: string;
}

export interface SweepPlan {
  entries: SweepPlanEntry[];
  skipped: SweepPlanSkip[];
}

export interface SweepExecuteRequest {
  command: string;
  paths: string[];
  cwd?: string;
  env: Record<string, string>;
}

export interface SweepOptions {
  cwd?: string;
  execute?: (request: SweepExecuteRequest) => Promise<number>;
  log?: (line: string) => void;
}

export function createLocalPort(root: string): {
  revision(): Promise<string>;
  readFile(path: string): Promise<string | null>;
  listFiles(globs: string[]): Promise<string[]>;
  changedPaths(base: string, head: string): Promise<string[]>;
};

export function planControlSweep(graph: {
  nodes: Array<{ id: string; kind: string; meaning: string; path?: string; details: Record<string, unknown> }>;
  edges: Array<{ from: string; to: string; type: string }>;
}): SweepPlan;

export function runControlSweep(plan: SweepPlan, options?: SweepOptions): Promise<number>;

export function main(
  target?: string,
  options?: SweepOptions & { api?: unknown },
): Promise<number>;
