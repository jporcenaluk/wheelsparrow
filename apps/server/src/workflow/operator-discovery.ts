import type { OperatorQueueRun } from "@wheelsparrow/contracts";

import type { DatabaseConnection } from "../database/connection.js";
import { listActiveProjectItemIds } from "../database/runs.js";
import type { ProjectItem } from "../github/project.js";
import type { ConfiguredGitHubProjectGateway } from "../github/project-client.js";
import { type DiscoveryResult, selectProjectCandidate } from "./discovery.js";

export interface OperatorDiscoveryConfiguration {
  readonly repository: string;
  readonly projectNumber: number;
  readonly readyStatus: string;
  readonly requiredLabels: readonly string[];
}

export interface DiscoverReadyQueueInput {
  readonly connection: DatabaseConnection;
  readonly gateway: Pick<
    ConfiguredGitHubProjectGateway,
    "readConfiguredProject"
  >;
  readonly configuration: OperatorDiscoveryConfiguration;
  readonly now?: () => string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isSafeProjectItem(value: unknown): value is ProjectItem {
  if (!isRecord(value)) return false;
  if (
    typeof value.projectItemId !== "string" ||
    value.projectItemId.trim().length === 0 ||
    typeof value.projectId !== "string" ||
    value.projectId.trim().length === 0 ||
    !Number.isSafeInteger(value.projectNumber) ||
    (value.projectNumber as number) < 1 ||
    typeof value.repository !== "string" ||
    value.repository.trim().length === 0 ||
    typeof value.issueNodeId !== "string" ||
    value.issueNodeId.trim().length === 0 ||
    !Number.isSafeInteger(value.issueNumber) ||
    (value.issueNumber as number) < 1 ||
    typeof value.isOpen !== "boolean" ||
    typeof value.status !== "string" ||
    value.status.trim().length === 0 ||
    typeof value.revision !== "string" ||
    value.revision.trim().length === 0 ||
    typeof value.createdAt !== "string" ||
    value.createdAt.trim().length === 0 ||
    !Array.isArray(value.labels) ||
    value.labels.some(
      (label) => typeof label !== "string" || label.trim().length === 0,
    )
  ) {
    return false;
  }
  if (
    value.priorityRank !== undefined &&
    !Number.isSafeInteger(value.priorityRank)
  ) {
    return false;
  }
  if (value.dependencies !== "unavailable") {
    if (!Array.isArray(value.dependencies)) return false;
    if (
      value.dependencies.some(
        (dependency) =>
          !isRecord(dependency) ||
          typeof dependency.issueNodeId !== "string" ||
          dependency.issueNodeId.trim().length === 0 ||
          !Number.isSafeInteger(dependency.issueNumber) ||
          (dependency.issueNumber as number) < 1 ||
          typeof dependency.isOpen !== "boolean",
      )
    ) {
      return false;
    }
  }
  return true;
}

function assertSnapshot(snapshot: unknown): asserts snapshot is {
  readonly projectId: string;
  readonly projectNumber: number;
  readonly repository: string;
  readonly items: readonly ProjectItem[];
} {
  if (
    !isRecord(snapshot) ||
    typeof snapshot.projectId !== "string" ||
    snapshot.projectId.trim().length === 0 ||
    !Number.isSafeInteger(snapshot.projectNumber) ||
    (snapshot.projectNumber as number) < 1 ||
    typeof snapshot.repository !== "string" ||
    snapshot.repository.trim().length === 0 ||
    !Array.isArray(snapshot.items) ||
    snapshot.items.some((item) => !isSafeProjectItem(item))
  ) {
    throw new Error("GitHub Project discovery returned an invalid snapshot.");
  }
}

function queueRun(
  item: ProjectItem,
  now: string,
  blockedReason: string | null,
): OperatorQueueRun {
  return {
    run_id: `ready:${item.projectItemId}`,
    issue_number: item.issueNumber,
    repository: item.repository,
    state: "claiming",
    revision: 0,
    rework_epoch: 0,
    repair_round: 0,
    branch: null,
    pull_request_number: null,
    pull_request_title: null,
    pull_request_url: null,
    required_action: null,
    blocked_reason: blockedReason,
    updated_at: now,
  };
}

function inConfiguredReadyScope(
  item: ProjectItem,
  snapshot: {
    readonly projectId: string;
    readonly projectNumber: number;
    readonly repository: string;
  },
  configuration: OperatorDiscoveryConfiguration,
): boolean {
  return (
    item.projectId === snapshot.projectId &&
    item.projectNumber === snapshot.projectNumber &&
    item.repository === configuration.repository &&
    item.status === configuration.readyStatus &&
    item.isOpen
  );
}

function resultReason(
  result: DiscoveryResult,
  item: ProjectItem,
): string | null {
  return (
    result.excluded.find(
      (candidate) => candidate.projectItemId === item.projectItemId,
    )?.reason ?? null
  );
}

export async function discoverReadyQueue(
  input: DiscoverReadyQueueInput,
): Promise<readonly OperatorQueueRun[]> {
  const snapshot = await input.gateway.readConfiguredProject();
  assertSnapshot(snapshot);
  if (
    snapshot.projectNumber !== input.configuration.projectNumber ||
    snapshot.repository !== input.configuration.repository
  ) {
    throw new Error(
      "GitHub Project discovery returned a snapshot outside configured scope.",
    );
  }
  const ownedProjectItemIds = await listActiveProjectItemIds(
    input.connection.db,
  );
  const result = selectProjectCandidate(snapshot, {
    projectId: snapshot.projectId,
    projectNumber: snapshot.projectNumber,
    repository: input.configuration.repository,
    readyStatus: input.configuration.readyStatus,
    requiredLabels: input.configuration.requiredLabels,
    ownedProjectItemIds,
  });
  const now = input.now?.() ?? new Date().toISOString();
  const readyItems = snapshot.items.filter((item) =>
    inConfiguredReadyScope(item, snapshot, input.configuration),
  );
  return readyItems
    .map((item) =>
      queueRun(
        item,
        now,
        result.eligible.includes(item) ? null : resultReason(result, item),
      ),
    )
    .toSorted(
      (left, right) =>
        left.issue_number - right.issue_number ||
        left.run_id.localeCompare(right.run_id),
    );
}
