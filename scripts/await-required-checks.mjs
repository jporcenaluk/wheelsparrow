const POLL_INTERVAL_MS = 10_000;
const TIMEOUT_MS = 20 * 60_000;

export const REQUIRED_MAIN_CHECKS = [
  "test",
  "prompt-contract",
  "integration",
  "e2e",
  "actionlint",
  "security",
];

export function requiredCheckOutcome(checkRuns) {
  const byName = new Map();
  for (const check of checkRuns) {
    if (!REQUIRED_MAIN_CHECKS.includes(check.name)) continue;
    const existing = byName.get(check.name);
    if (existing?.status === "completed" && check.status !== "completed")
      continue;
    byName.set(check.name, check);
  }
  if (byName.size !== REQUIRED_MAIN_CHECKS.length) return { kind: "pending" };
  const failed = REQUIRED_MAIN_CHECKS.filter((name) => {
    const check = byName.get(name);
    return check.status === "completed" && check.conclusion !== "success";
  });
  if (failed.length > 0) return { kind: "failed", names: failed };
  if (
    REQUIRED_MAIN_CHECKS.some((name) => byName.get(name).status !== "completed")
  )
    return { kind: "pending" };
  return { kind: "success" };
}

function environment(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} must be set.`);
  return value;
}

function pause() {
  return new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
}

export async function awaitRequiredChecks({
  fetch = globalThis.fetch,
  repository = environment("GITHUB_REPOSITORY"),
  sha = environment("GITHUB_SHA"),
  token = environment("GITHUB_TOKEN"),
  now = () => Date.now(),
} = {}) {
  const deadline = now() + TIMEOUT_MS;
  while (now() < deadline) {
    const response = await fetch(
      `https://api.github.com/repos/${repository}/commits/${sha}/check-runs?per_page=100`,
      {
        headers: {
          Accept: "application/vnd.github+json",
          Authorization: `Bearer ${token}`,
          "X-GitHub-Api-Version": "2022-11-28",
        },
      },
    );
    if (!response.ok)
      throw new Error(
        `Could not read required checks: HTTP ${response.status}.`,
      );
    const body = await response.json();
    const checkRuns = Array.isArray(body?.check_runs)
      ? body.check_runs
      : undefined;
    if (!checkRuns) throw new Error("Required-check response is malformed.");
    const outcome = requiredCheckOutcome(checkRuns);
    if (outcome.kind === "success") return;
    if (outcome.kind === "failed")
      throw new Error(`Required checks failed: ${outcome.names.join(", ")}.`);
    await pause();
  }
  throw new Error("Timed out waiting for same-revision required checks.");
}

if (import.meta.main) await awaitRequiredChecks();
