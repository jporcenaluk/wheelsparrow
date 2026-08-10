import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

const root = resolve(import.meta.dirname, "..");
const workflowDirectory = resolve(root, ".github/workflows");
const knownWorkflows = [
  "pr-title.yml",
  "ci.yml",
  "main.yml",
  "live-smoke.yml",
  "security.yml",
] as const;
type WorkflowFilename = (typeof knownWorkflows)[number];
type WorkflowStep = {
  name?: string;
  run?: string;
  uses?: string;
  with?: Record<string, unknown>;
};
type WorkflowJob = {
  name?: string;
  "runs-on"?: string;
  steps?: WorkflowStep[];
};

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
    { reference: uploadArtifact, release: "v7.0.1" },
    { reference: checkout, release: "v6.0.2" },
    { reference: setupNode, release: "v6.4.0" },
    { reference: uploadArtifact, release: "v7.0.1" },
    { reference: checkout, release: "v6.0.2" },
    { reference: setupNode, release: "v6.4.0" },
    { reference: uploadArtifact, release: "v7.0.1" },
    { reference: checkout, release: "v6.0.2" },
    { reference: setupNode, release: "v6.4.0" },
    { reference: uploadArtifact, release: "v7.0.1" },
    { reference: checkout, release: "v6.0.2" },
    { reference: setupNode, release: "v6.4.0" },
    { reference: uploadArtifact, release: "v7.0.1" },
    { reference: checkout, release: "v6.0.2" },
    { reference: setupNode, release: "v6.4.0" },
  ],
  "main.yml": [
    { reference: checkout, release: "v6.0.2" },
    { reference: setupNode, release: "v6.4.0" },
    { reference: checkout, release: "v6.0.2" },
    { reference: setupNode, release: "v6.4.0" },
    { reference: uploadArtifact, release: "v7.0.1" },
    { reference: uploadArtifact, release: "v7.0.1" },
  ],
  "live-smoke.yml": [
    { reference: checkout, release: "v6.0.2" },
    { reference: setupNode, release: "v6.4.0" },
    { reference: uploadArtifact, release: "v7.0.1" },
  ],
  "security.yml": [
    { reference: checkout, release: "v6.0.2" },
    {
      reference:
        "github/codeql-action/init@03e4368ac7daa2bd82b3e85262f3bf87ee112f57",
      release: "v3.36.0",
    },
    {
      reference:
        "github/codeql-action/analyze@03e4368ac7daa2bd82b3e85262f3bf87ee112f57",
      release: "v3.36.0",
    },
    {
      reference:
        "gitleaks/gitleaks-action@e0c47f4f8be36e29cdc102c57e68cb5cbf0e8d1e",
      release: "v3.0.0",
    },
    { reference: uploadArtifact, release: "v7.0.1" },
  ],
};
const prTitleEnv = `PR_TITLE: ${"$"}{{ github.event.pull_request.title }}`;
const prDraftEnv = `PR_DRAFT: ${"$"}{{ github.event.pull_request.draft }}`;
const ciConcurrency = `ci-${"$"}{{ github.event.pull_request.number || github.sha }}`;
const prOnlyCancellation = `${"$"}{{ github.event_name == 'pull_request' }}`;
const failureOnly = `${"$"}{{ failure() }}`;
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

function job(workflow: Record<string, unknown>, identifier: string) {
  const jobs = workflow.jobs as Record<string, WorkflowJob>;
  const result = jobs[identifier];
  expect(result, `missing ${identifier} job`).toBeDefined();
  return result as WorkflowJob;
}

function commandText(steps: WorkflowStep[]) {
  return steps.flatMap(runCommands).join("\n");
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
      expect(workflow.permissions).toMatchObject({ contents: "read" });
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
    expect(runCommands(steps[smokeIndex])).toEqual(["make smoke-production"]);
    expect(buildIndex).toBeGreaterThan(verifyIndex);
    expect(smokeIndex).toBeGreaterThan(buildIndex);
    for (const step of steps.filter(({ uses }) => uses === checkout)) {
      expect(step.with?.["persist-credentials"]).toBe(false);
    }
  });

  it("proves native storage on macOS with the pinned toolchain and real process coverage", () => {
    const { workflow } = readWorkflow("ci.yml");
    const nativeStorage = job(workflow, "native-storage");
    const steps = nativeStorage.steps ?? [];
    const commands = commandText(steps);

    expect(nativeStorage.name).toBe("native-storage");
    expect(nativeStorage["runs-on"]).toMatch(/^macos-/);
    expect(steps.find((step) => step.uses === checkout)?.with).toMatchObject({
      "persist-credentials": false,
    });
    expect(steps.find((step) => step.uses === setupNode)?.with).toMatchObject({
      "node-version-file": ".node-version",
    });
    expect(commands).toContain("corepack enable");
    expect(commands).toMatch(/pnpm install --frozen-lockfile/);
    expect(commands).not.toContain("--ignore-scripts");

    const workspace = parse(
      readFileSync(resolve(root, "pnpm-workspace.yaml"), "utf8"),
    ) as { allowBuilds?: Record<string, boolean> };
    const server = JSON.parse(
      readFileSync(resolve(root, "apps/server/package.json"), "utf8"),
    ) as { dependencies?: Record<string, string> };
    expect(workspace.allowBuilds).toEqual({
      "better-sqlite3": true,
      esbuild: true,
    });
    expect(server.dependencies).toMatchObject({
      "better-sqlite3": "13.0.3",
      "fs-native-extensions": "1.5.0",
    });
    expect(server.dependencies).not.toHaveProperty("esbuild");

    const nativeTestStep = steps.find(
      (step) => step.name === "Native SQLite and ownership",
    );
    expect(nativeTestStep).toBeDefined();
    const nativeTestCommands = runCommands(nativeTestStep);
    expect(nativeTestCommands.join("\n")).toContain(
      "apps/server/src/database/sqlite-persistence.test.ts",
    );
    expect(nativeTestCommands.join("\n")).toContain(
      "tests/integration/migrations.test.ts",
    );
    expect(nativeTestCommands.join("\n")).toContain(
      "tests/integration/ownership.test.ts",
    );
    const ownershipContract = readFileSync(
      resolve(root, "tests/integration/ownership.test.ts"),
      "utf8",
    );
    for (const behavior of [
      "reports a typed conflict from a second process while the holder remains live",
      "permits a successor after normal release",
      "permits an immediate successor after a holder is SIGKILLed",
    ]) {
      expect(ownershipContract).toContain(behavior);
    }
  });

  it("packages an installable, revision-bound source bundle and proves the extracted revision", () => {
    const { workflow } = readWorkflow("main.yml");
    const jobs = workflow.jobs as Record<string, WorkflowJob>;
    const buildJob = jobs["build-artifact"];
    const waitJob = jobs["await-required-checks"];
    const steps = buildJob?.steps ?? [];

    expect(workflow.on).toEqual({ push: { branches: ["main"] } });
    expect(buildJob?.name).toBe("build-artifact");
    expect(waitJob).toMatchObject({ name: "await-required-checks" });
    expect(buildJob).toMatchObject({ needs: "await-required-checks" });
    expect(workflow.permissions).toEqual({ checks: "read", contents: "read" });
    expect(commandText(waitJob?.steps ?? [])).toContain(
      "node scripts/await-required-checks.mjs",
    );
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
    const failureUpload = steps.find(
      (step) => step.name === "Upload build diagnostics",
    );
    const uploadIndex = steps.findIndex(
      (step) => step.uses === uploadArtifact && step.name === undefined,
    );
    expect(packageIndex).toBeGreaterThanOrEqual(0);
    expect(verifyIndex).toBeGreaterThan(packageIndex);
    expect(uploadIndex).toBeGreaterThan(verifyIndex);
    const packageText = runCommands(steps[packageIndex]).join("\n");
    expect(packageText).toContain(`wheelsparrow-${githubShaShell}.tar.gz`);
    for (const requiredPath of [
      ".node-version",
      "REVISION",
      "package.json",
      "pnpm-lock.yaml",
      "pnpm-workspace.yaml",
      "tsconfig.base.json",
      "apps/server/package.json",
      "apps/server/src",
      "apps/server/tsconfig.json",
      "apps/server/dist",
      "apps/web/package.json",
      "apps/web/index.html",
      "apps/web/src",
      "apps/web/tsconfig.json",
      "apps/web/vite.config.ts",
      "apps/web/dist",
      "packages/contracts/package.json",
      "packages/contracts/prepare.mjs",
      "packages/contracts/src",
      "packages/contracts/tsconfig.json",
      "packages/contracts/dist",
      "migrations",
      "prompts",
      "wheelsparrow.yaml",
      "scripts/live-smoke.mjs",
      "scripts/await-required-checks.mjs",
      "scripts/production-smoke.mjs",
    ]) {
      expect(packageText).toContain(requiredPath);
    }
    expect(packageText).toContain(
      'test "$(git rev-parse HEAD)" = "$GITHUB_SHA"',
    );
    expect(packageText).toMatch(/(?:printf|git rev-parse).*REVISION/);

    const verificationText = runCommands(steps[verifyIndex]).join("\n");
    expect(verificationText).toContain(
      `ARTIFACT_PATH="wheelsparrow-${githubShaShell}.tar.gz"`,
    );
    expect(verificationText).toContain("tar -xzf");
    expect(verificationText).toContain(
      'test "$(cat "$PACKAGE_DIR/REVISION")" = "$GITHUB_SHA"',
    );
    for (const prompt of ["builder.md", "reviewer.md", "repair.md"]) {
      expect(verificationText).toContain(
        `test -s "$PACKAGE_DIR/prompts/${prompt}"`,
      );
    }
    expect(verificationText).toContain(
      'pnpm --dir "$PACKAGE_DIR" install --prod --frozen-lockfile',
    );
    expect(verificationText).not.toContain("--ignore-scripts");
    expect(verificationText).not.toContain('cd "$PACKAGE_DIR"');
    expect(verificationText).toContain(
      'node "$PACKAGE_DIR/scripts/production-smoke.mjs"',
    );
    expect(steps[uploadIndex]?.uses).toBe(uploadArtifact);
    expect(steps[uploadIndex]?.with).toEqual({
      name: `wheelsparrow-${"$"}{{ github.sha }}`,
      path: `wheelsparrow-${"$"}{{ github.sha }}.tar.gz`,
      "retention-days": 7,
      "if-no-files-found": "error",
    });
    expect(failureUpload).toMatchObject({
      if: failureOnly,
      uses: uploadArtifact,
      with: { "if-no-files-found": "ignore", "retention-days": 14 },
    });
  });

  it("makes external live smoke explicitly opt-in and refuses this repository", () => {
    const { source, workflow } = readWorkflow("live-smoke.yml");
    const trigger = workflow.on as {
      workflow_dispatch?: { inputs?: Record<string, Record<string, unknown>> };
    };
    const inputs = trigger.workflow_dispatch?.inputs ?? {};
    for (const name of [
      "repository",
      "project_number",
      "disposable_confirmation",
    ]) {
      expect(inputs[name]?.required).toBe(true);
    }
    expect(inputs.repository?.type).toBe("string");
    expect(inputs.project_number?.type).toBe("number");
    expect(inputs.disposable_confirmation?.type).toBe("boolean");
    expect(source).toContain(
      'test "$WHEELSPARROW_LIVE_SMOKE_DISPOSABLE" = "true"',
    );
    expect(source).toContain(
      'test "$WHEELSPARROW_LIVE_SMOKE_REPOSITORY" != "$GITHUB_REPOSITORY"',
    );
    expect(source).toContain(
      `GITHUB_TOKEN: ${"$"}{{ secrets.WHEELSPARROW_LIVE_SMOKE_TOKEN }}`,
    );
    expect(source).toContain('test -n "$GITHUB_TOKEN"');
    expect(source).toContain("make live-smoke");
  });

  it("runs exact-head CodeQL and Gitleaks with minimal security permissions", () => {
    const { source, workflow } = readWorkflow("security.yml");
    const security = job(workflow, "security") as WorkflowJob & {
      permissions?: Record<string, string>;
    };
    expect(security.permissions).toEqual({
      contents: "read",
      "security-events": "write",
    });
    expect(source).toContain('test "$(git rev-parse HEAD)" = "$GITHUB_SHA"');
    expect(source).toContain("javascript-typescript");
    expect(source).toContain("gitleaks/gitleaks-action@");
    expect(source).toContain('GITLEAKS_ENABLE_COMMENTS: "false"');
  });

  it("runs prompt, integration, browser, and workflow policy gates in CI", () => {
    const { workflow } = readWorkflow("ci.yml");
    for (const [identifier, command] of [
      ["prompt-contract", "make test-prompts"],
      ["integration", "make test-integration"],
      ["e2e", "make test-e2e"],
      ["actionlint", "make actionlint"],
    ] as const) {
      const steps = job(workflow, identifier).steps ?? [];
      expect(commandText(steps)).toContain(command);
    }
    expect(commandText(job(workflow, "e2e").steps ?? [])).toContain(
      "playwright install --with-deps chromium",
    );
    expect(commandText(job(workflow, "actionlint").steps ?? [])).toContain(
      "actionlint@v1.7.12",
    );
    expect(commandText(job(workflow, "actionlint").steps ?? [])).toContain(
      "zizmor==1.27.0",
    );
  });
});
