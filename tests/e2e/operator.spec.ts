import { expect, type Page, type Route, test } from "@playwright/test";

const csrfToken = "e2e-csrf-token";
const baseSha = "1111111111111111111111111111111111111111";
const headSha = "2222222222222222222222222222222222222222";

const readyRun = {
  run_id: "run-ready",
  issue_number: 42,
  repository: "owner/repo",
  state: "preparing",
  revision: 4,
  rework_epoch: 0,
  repair_round: 0,
  branch: "codex/run-ready",
  pull_request_number: null,
  pull_request_title: null,
  pull_request_url: null,
  required_action: null,
  blocked_reason: null,
  updated_at: "2026-08-09T11:00:00.000Z",
};

const reviewRun = {
  run_id: "run-review",
  issue_number: 43,
  repository: "owner/repo",
  state: "review",
  revision: 9,
  rework_epoch: 0,
  repair_round: 1,
  branch: "codex/run-review",
  pull_request_number: 17,
  pull_request_title: "Improve the operator console",
  pull_request_url: "https://github.com/owner/repo/pull/17",
  required_action: "Confirm the exact head and base before merge.",
  blocked_reason: null,
  updated_at: "2026-08-09T11:05:00.000Z",
};

const scheduler = {
  revision: 7,
  paused: false,
  stop_after_current: false,
  updated_at: "2026-08-09T11:05:00.000Z",
};

const queue = {
  schema_version: 1,
  scheduler,
  active_todo: null,
  ready: [readyRun],
  review: [reviewRun],
  review_count: 1,
};

const findings = [
  {
    id: "finding-1",
    rework_epoch: 0,
    review_step_id: "step-review",
    stable_key: "review.follow-up",
    disposition_sequence: 1,
    severity: "medium",
    evidence: "The operator path needs an exact revision check.",
    disposition: "open",
    resolving_step_id: null,
    created_at: "2026-08-09T11:04:00.000Z",
  },
];

const reviewDetail = {
  schema_version: 1,
  run: {
    ...reviewRun,
    base_branch: "main",
    base_sha: baseSha,
    head_sha: headSha,
    observed_base_sha: baseSha,
    merge_sha: null,
    worktree_path: ".wheelsparrow/workspaces/run-review",
    stop_requested_at: null,
    started_at: "2026-08-09T11:00:00.000Z",
    handed_off_at: "2026-08-09T11:04:00.000Z",
    terminal_at: null,
  },
  steps: [
    {
      id: "step-review",
      rework_epoch: 0,
      role: "reviewer",
      logical_step: "review",
      attempt: 1,
      status_sequence: 1,
      status: "completed",
      model: "test-model",
      reasoning_effort: "medium",
      started_at: "2026-08-09T11:03:00.000Z",
      completed_at: "2026-08-09T11:04:00.000Z",
      summary: "Review receipt recorded.",
    },
  ],
  findings,
  approvals: [],
  events: [
    {
      id: "event-1",
      sequence: 1,
      run_revision: 9,
      kind: "review.completed",
      summary: "Independent review completed.",
      created_at: "2026-08-09T11:04:00.000Z",
    },
  ],
};

const readyDetail = {
  ...reviewDetail,
  run: {
    ...reviewDetail.run,
    ...readyRun,
    base_branch: "main",
    base_sha: null,
    head_sha: null,
    observed_base_sha: null,
    merge_sha: null,
    worktree_path: null,
    started_at: null,
    handed_off_at: null,
  },
  findings: [],
  approvals: [],
  events: [],
};

function json(route: Route, body: unknown, status = 200, headers = {}) {
  return route.fulfill({
    status,
    contentType: "application/json",
    headers,
    body: JSON.stringify(body),
  });
}

async function installFixtures(page: Page) {
  const mutations: Array<{ path: string; body: unknown; csrf: string | null }> =
    [];
  let currentScheduler = { ...scheduler };

  await page.route("**/*", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname;
    const method = request.method();
    const headers = { "x-csrf-token": csrfToken };

    if (path === "/api/operator/events") return route.abort();
    if (path === "/health" && method === "GET")
      return json(route, { schema_version: 1, status: "ok" }, 200, headers);
    if (path === "/api/operator/session" && method === "GET")
      return json(
        route,
        { schema_version: 1, csrf_token: csrfToken },
        200,
        headers,
      );
    if (path === "/api/operator/queue" && method === "GET")
      return json(
        route,
        { ...queue, scheduler: currentScheduler },
        200,
        headers,
      );
    if (path === "/api/operator/review" && method === "GET")
      return json(
        route,
        {
          schema_version: 1,
          items: [{ ...reviewRun, findings, approval: null }],
        },
        200,
        headers,
      );
    if (path === "/api/operator/runs/run-ready" && method === "GET")
      return json(route, readyDetail, 200, headers);
    if (path === "/api/operator/runs/run-review" && method === "GET")
      return json(route, reviewDetail, 200, headers);
    if (path === "/api/operator/scheduler" && method === "PATCH") {
      const body = request.postDataJSON() as {
        expected_revision?: unknown;
        paused?: unknown;
        stop_after_current?: unknown;
      };
      mutations.push({
        path,
        body,
        csrf: request.headers()["x-csrf-token"] ?? null,
      });
      if (
        request.headers()["x-csrf-token"] !== csrfToken ||
        body.expected_revision !== currentScheduler.revision
      )
        return json(
          route,
          {
            schema_version: 1,
            error: {
              code: "csrf_forbidden",
              message: "The request origin or CSRF token is invalid.",
            },
          },
          403,
        );
      currentScheduler = {
        ...currentScheduler,
        revision: currentScheduler.revision + 1,
        ...(typeof body.paused === "boolean" ? { paused: body.paused } : {}),
        ...(typeof body.stop_after_current === "boolean"
          ? { stop_after_current: body.stop_after_current }
          : {}),
      };
      return json(
        route,
        { schema_version: 1, scheduler: currentScheduler },
        200,
        headers,
      );
    }
    if (path === "/api/runs/run-review/approve" && method === "POST") {
      const body = request.postDataJSON();
      mutations.push({
        path,
        body,
        csrf: request.headers()["x-csrf-token"] ?? null,
      });
      return json(
        route,
        {
          schema_version: 1,
          error: {
            code: "revision_conflict",
            message: "The durable snapshot is stale; refresh and retry.",
          },
        },
        409,
      );
    }
    if (
      path === "/api/operator/runs/run-review/return-to-todo" &&
      method === "POST"
    ) {
      const body = request.postDataJSON();
      mutations.push({
        path,
        body,
        csrf: request.headers()["x-csrf-token"] ?? null,
      });
      return json(route, reviewDetail, 200, headers);
    }
    return route.continue();
  });

  return { mutations };
}

test.describe("operator console", () => {
  test("renders Queue and sends a guarded scheduler mutation", async ({
    page,
  }) => {
    const fixtures = await installFixtures(page);

    await page.goto("/queue");
    await expect(page.getByRole("heading", { name: "Queue" })).toBeVisible();
    await expect(page.getByText("Issue #42")).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Pause queue" }),
    ).toBeEnabled();

    await page.getByRole("button", { name: "Pause queue" }).click();
    await expect(
      page.getByRole("button", { name: "Resume queue" }),
    ).toBeVisible();
    expect(fixtures.mutations).toContainEqual({
      path: "/api/operator/scheduler",
      body: { schema_version: 1, expected_revision: 7, paused: true },
      csrf: csrfToken,
    });
  });

  test("renders Run detail from the durable receipt", async ({ page }) => {
    await installFixtures(page);

    await page.goto("/runs/run-ready");
    await expect(
      page.getByRole("heading", { name: "Issue #42" }),
    ).toBeVisible();
    await expect(
      page.getByRole("heading", { name: "Execution facts" }),
    ).toBeVisible();
    await expect(page.getByRole("heading", { name: "Steps" })).toBeVisible();
    await expect(page.getByText("No findings recorded.")).toBeVisible();
    await expect(page.getByRole("link", { name: "← Queue" })).toBeVisible();
  });

  test("requires exact candidate confirmation before approval and reports a stale guard", async ({
    page,
  }) => {
    const fixtures = await installFixtures(page);

    await page.goto("/review");
    await expect(page.getByRole("heading", { name: "Review" })).toBeVisible();
    await expect(page.getByText("Exact delivery candidate")).toBeVisible();
    const approve = page.getByRole("button", {
      name: "Approve exact candidate",
    });
    await expect(approve).toBeDisabled();

    await page
      .getByRole("checkbox", { name: /confirm this exact head and base/i })
      .check();
    await expect(approve).toBeEnabled();
    await approve.click();

    await expect(page.getByRole("alert")).toContainText(
      "review candidate is stale",
    );
    expect(fixtures.mutations).toContainEqual({
      path: "/api/runs/run-review/approve",
      body: {
        schema_version: 1,
        expected_run_revision: 9,
        approved_head_sha: headSha,
        approved_base_sha: baseSha,
      },
      csrf: csrfToken,
    });
  });

  test("returns a Review item to Todo with durable feedback and revision", async ({
    page,
  }) => {
    const fixtures = await installFixtures(page);

    await page.goto("/review");
    await page.getByRole("button", { name: "Return to Todo" }).click();
    await expect(
      page.getByRole("textbox", { name: "Operator feedback" }),
    ).toBeVisible();
    await page
      .getByRole("textbox", { name: "Operator feedback" })
      .fill("Please rework the failing verification.");
    await page.getByRole("button", { name: "Confirm return to Todo" }).click();

    expect(fixtures.mutations).toContainEqual({
      path: "/api/operator/runs/run-review/return-to-todo",
      body: {
        schema_version: 1,
        expected_revision: 9,
        feedback: "Please rework the failing verification.",
      },
      csrf: csrfToken,
    });
  });
});
