export const REQUIRED_MAIN_CHECKS: readonly [
  "test",
  "prompt-contract",
  "integration",
  "e2e",
  "actionlint",
  "security",
];

export function requiredCheckOutcome(
  checkRuns: Array<{
    name: string;
    status: string;
    conclusion: string | null;
  }>,
):
  | { kind: "pending" }
  | { kind: "success" }
  | { kind: "failed"; names: string[] };

export function awaitRequiredChecks(options?: {
  fetch?: typeof globalThis.fetch;
  repository?: string;
  sha?: string;
  token?: string;
  now?: () => number;
}): Promise<void>;
