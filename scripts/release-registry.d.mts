export interface ViewProcessResult {
  status: number | null;
  stdout: string;
  stderr: string;
  error?: Error;
}

export type RegistryState =
  | { state: "missing" }
  | { state: "matching"; integrity: string };

export function tarballIntegrity(path: string): string;
export function classifyViewResult(
  result: ViewProcessResult,
  expectedVersion: string,
  expectedIntegrity: string,
  packageName: string,
): RegistryState;
export function publicationPlan(
  core: RegistryState,
  design: RegistryState,
): { publishCore: boolean; publishDesign: boolean };
export function main(argv: string[]): number;
