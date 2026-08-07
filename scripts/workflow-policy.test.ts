import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

const root = resolve(import.meta.dirname, "..");
const workflowDirectory = resolve(root, ".github/workflows");
const knownWorkflows = ["pr-title.yml", "ci.yml", "main.yml"] as const;
type WorkflowFilename = (typeof knownWorkflows)[number];
type WorkflowStep = {
  name?: string;
  run?: string;
  uses?: string;
  with?: Record<string, unknown>;
};
type WorkflowJob = { name?: string; steps?: WorkflowStep[] };

const checkout = "actions/checkout@de0fac2e4500dabe0009e67214ff5f5447ce83dd";
const setupNode = "actions/setup-node@48b55a011bda9f5d6aeb4c2d9c7362e8dae4041e";
const uploadArtifact =
  "actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a";
const approvedActions: Record<
  WorkflowFilename,
  Array<{ reference: string; release: string }>
> = {
  "pr-title.yml": [],
  "ci.yml": [
    { reference: checkout, release: "v6.0.2" },
    { reference: setupNode, release: "v6.4.0" },
  ],
  "main.yml": [
    { reference: checkout, release: "v6.0.2" },
    { reference: setupNode, release: "v6.4.0" },
    { reference: uploadArtifact, release: "v7.0.1" },
  ],
};
const prTitleEnv = `PR_TITLE: ${"$"}{{ github.event.pull_request.title }}`;
const prDraftEnv = `PR_DRAFT: ${"$"}{{ github.event.pull_request.draft }}`;
const ciConcurrency = `ci-${"$"}{{ github.event.pull_request.number || github.sha }}`;
const prOnlyCancellation = `${"$"}{{ github.event_name == 'pull_request' }}`;
const githubShaShell = `${"$"}{GITHUB_SHA}`;
const discoveredWorkflows = readdirSync(workflowDirectory, {
  recursive: true,
  withFileTypes: true,
})
  .filter(
    (entry) => entry.isFile() && /\.ya?ml$/.test(entry.name.toLowerCase()),
  )
  .map((entry) =>
    resolve(entry.parentPath, entry.name)
      .slice(workflowDirectory.length + 1)
      .replaceAll("\\", "/"),
  )
  .sort();

const workflowPath = (filename: string) => resolve(workflowDirectory, filename);

function readWorkflow(filename: string) {
  const source = readFileSync(workflowPath(filename), "utf8");
  return { source, workflow: parse(source) as Record<string, unknown> };
}

function structuredActionReferences(workflow: Record<string, unknown>) {
  const jobs = workflow.jobs as Record<string, WorkflowJob & { uses?: string }>;
  return Object.values(jobs).flatMap((job) => [
    ...(job.uses ? [job.uses] : []),
    ...(job.steps ?? []).flatMap((step) => (step.uses ? [step.uses] : [])),
  ]);
}

function runCommands(step: WorkflowStep | undefined) {
  return (step?.run ?? "")
    .split("\n")
    .map((command) => command.trim())
    .filter(Boolean);
}

function commentedActionUses(
  source: string,
  workflow: Record<string, unknown>,
) {
  const uses = source
    .split("\n")
    .filter((line) => /^\s*(?:-\s*)?uses:\s*/.test(line))
    .map((line) => {
      const match = line.match(
        /^\s*(?:-\s*)?uses:\s*(?:["']([^"']+)["']|([^\s#]+))\s+#\s+(v\d+\.\d+\.\d+)\s*$/,
      );
      expect(
        match,
        `action use must have a same-line release comment: ${line}`,
      ).not.toBeNull();
      return { reference: match?.[1] ?? match?.[2], release: match?.[3] };
    });
  expect(uses.map(({ reference }) => reference)).toEqual(
    structuredActionReferences(workflow),
  );
  for (const { reference } of uses) {
    expect(reference).toMatch(/^[^@\s]+@[0-9a-f]{40}$/);
  }
  return uses;
}

describe("workflow policy", () => {
  it("uses immutable actions, least privilege, and no pull_request_target", () => {
    for (const filename of discoveredWorkflows) {
      const { source, workflow } = readWorkflow(filename);
      expect(workflow.permissions).toEqual({ contents: "read" });
      expect(source).not.toContain("pull_request_target");
      commentedActionUses(source, workflow);
    }
  });

  it("uses exactly the approved pinned action releases in each workflow", () => {
    expect(discoveredWorkflows).toEqual(
      expect.arrayContaining([...knownWorkflows]),
    );
    for (const filename of knownWorkflows) {
      const { source, workflow } = readWorkflow(filename);
      expect(commentedActionUses(source, workflow)).toEqual(
        approvedActions[filename],
      );
    }
  });

  it("runs PR metadata checks without checkout and handles untrusted fields through env", () => {
    const { source, workflow } = readWorkflow("pr-title.yml");
    const trigger = workflow.on as { pull_request?: { types?: string[] } };
    const jobs = workflow.jobs as Record<string, Record<string, unknown>>;

    expect(trigger.pull_request?.types).toEqual([
      "opened",
      "reopened",
      "edited",
      "synchronize",
      "ready_for_review",
      "converted_to_draft",
    ]);
    expect(jobs["validate-pr-title"]?.name).toBe("validate-pr-title");
    expect(jobs["ready-for-review-gate"]?.name).toBe("ready-for-review-gate");
    expect(source).not.toMatch(/actions\/checkout@/);
    expect(source).toContain(prTitleEnv);
    expect(source).toContain(prDraftEnv);
    for (const job of Object.values(jobs)) {
      for (const step of (job.steps ?? []) as Array<{ run?: string }>) {
        expect(step.run ?? "").not.toMatch(/\$\{\{/);
      }
    }
    expect(source).toContain('test "$PR_DRAFT" = "false"');
  });

  it("runs stable commit checks for pull requests, merge groups, and main safely", () => {
    const { workflow } = readWorkflow("ci.yml");
    const trigger = workflow.on as {
      pull_request?: Record<string, never>;
      merge_group?: Record<string, never>;
      push?: { branches?: string[] };
    };
    const jobs = workflow.jobs as Record<string, Record<string, unknown>>;
    const concurrency = workflow.concurrency as Record<string, unknown>;

    expect(trigger).toEqual({
      pull_request: {},
      merge_group: {},
      push: { branches: ["main"] },
    });
    expect(jobs.test?.name).toBe("test");
    expect(concurrency.group).toBe(ciConcurrency);
    expect(concurrency["cancel-in-progress"]).toBe(prOnlyCancellation);

    const steps = (jobs.test?.steps ?? []) as WorkflowStep[];
    const verifyIndex = steps.findIndex((step) => step.name === "Verify");
    const buildIndex = steps.findIndex((step) => step.name === "Build");
    const smokeIndex = steps.findIndex(
      (step) => step.name === "Production smoke",
    );
    expect(runCommands(steps[verifyIndex])).toEqual(["make verify-agent"]);
    expect(runCommands(steps[buildIndex])).toEqual(["make build"]);
    expect(runCommands(steps[smokeIndex])).toEqual([
      "node scripts/production-smoke.mjs",
    ]);
    expect(buildIndex).toBeGreaterThan(verifyIndex);
    expect(smokeIndex).toBeGreaterThan(buildIndex);
    for (const step of steps.filter(({ uses }) => uses === checkout)) {
      expect(step.with?.["persist-credentials"]).toBe(false);
    }
  });

  it("packages a revision-bound, runnable main artifact and verifies it before upload", () => {
    const { workflow } = readWorkflow("main.yml");
    const jobs = workflow.jobs as Record<string, WorkflowJob>;
    const buildJob = jobs["build-artifact"];
    const steps = buildJob?.steps ?? [];

    expect(workflow.on).toEqual({ push: { branches: ["main"] } });
    expect(buildJob?.name).toBe("build-artifact");
    const checkoutStep = steps.find((step) => step.uses === checkout);
    expect(checkoutStep?.with?.["persist-credentials"]).toBe(false);

    const revisionVerification = steps.find(
      (step) => step.name === "Verify and build exact revision",
    );
    expect(runCommands(revisionVerification)).toEqual([
      "make verify-agent",
      "make build",
      "make smoke-production",
    ]);

    const packageIndex = steps.findIndex(
      (step) => step.name === "Package exact revision",
    );
    const verifyIndex = steps.findIndex(
      (step) => step.name === "Verify packaged artifact",
    );
    const uploadIndex = steps.findIndex((step) => step.uses === uploadArtifact);
    expect(packageIndex).toBeGreaterThanOrEqual(0);
    expect(verifyIndex).toBeGreaterThan(packageIndex);
    expect(uploadIndex).toBeGreaterThan(verifyIndex);
    expect(runCommands(steps[packageIndex])).toEqual([
      `ARTIFACT_PATH="wheelsparrow-${githubShaShell}.tar.gz"`,
      'tar -czf "$ARTIFACT_PATH" \\',
      ".node-version \\",
      "package.json \\",
      "pnpm-lock.yaml \\",
      "pnpm-workspace.yaml \\",
      "apps/server/package.json \\",
      "apps/server/dist \\",
      "apps/web/package.json \\",
      "apps/web/dist \\",
      "packages/contracts/package.json \\",
      "packages/contracts/dist \\",
      "wheelsparrow.yaml \\",
      "scripts/production-smoke.mjs",
    ]);

    expect(runCommands(steps[verifyIndex])).toEqual([
      `ARTIFACT_PATH="wheelsparrow-${githubShaShell}.tar.gz"`,
      `PACKAGE_DIR="$RUNNER_TEMP/wheelsparrow-${githubShaShell}"`,
      'mkdir -p "$PACKAGE_DIR"',
      'tar -xzf "$ARTIFACT_PATH" -C "$PACKAGE_DIR"',
      'cd "$PACKAGE_DIR"',
      "pnpm install --prod --frozen-lockfile --ignore-scripts",
      "node scripts/production-smoke.mjs",
    ]);
    expect(steps[uploadIndex]?.uses).toBe(uploadArtifact);
    expect(steps[uploadIndex]?.with).toEqual({
      name: `wheelsparrow-${"$"}{{ github.sha }}`,
      path: `wheelsparrow-${"$"}{{ github.sha }}.tar.gz`,
      "retention-days": 7,
      "if-no-files-found": "error",
    });
  });
});
