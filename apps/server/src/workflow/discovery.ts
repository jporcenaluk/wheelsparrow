import type {
  ProjectDependencies,
  ProjectItem,
  ProjectSnapshot,
} from "../github/project.js";

export interface DiscoveryInput {
  readonly projectId: string;
  readonly projectNumber: number;
  readonly repository: string;
  readonly readyStatus: string;
  readonly requiredLabels: readonly string[];
  readonly ownedProjectItemIds: ReadonlySet<string>;
}

export const EXCLUSION_REASONS = [
  "invalid_snapshot_identity",
  "invalid_snapshot_items",
  "invalid_input",
  "invalid_item_identity",
  "duplicate_project_item_id",
  "wrong_project",
  "wrong_repository",
  "issue_closed",
  "status_not_ready",
  "missing_required_label",
  "invalid_dependencies",
  "blocked_dependency_open",
  "blocked_dependencies_unavailable",
  "owned_durable",
  "invalid_created_at",
  "invalid_priority",
] as const;

export type ExclusionReason = (typeof EXCLUSION_REASONS)[number];

export type ExcludedProjectCandidate = ProjectItem & {
  readonly reason: ExclusionReason;
};

export interface DiscoveryResult {
  readonly selected: ProjectItem | undefined;
  readonly eligible: readonly ProjectItem[];
  readonly excluded: readonly ExcludedProjectCandidate[];
  readonly reason?: ExclusionReason;
}

type CandidateEvaluation =
  | { readonly item: ProjectItem; readonly eligible: true }
  | {
      readonly item: ProjectItem;
      readonly eligible: false;
      readonly reason: ExclusionReason;
    };

const canonicalTimestampPattern =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{3}))?Z$/u;

function isNonEmptyText(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isPositiveSafeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) > 0;
}

function isProjectNumber(value: unknown): value is number {
  return isPositiveSafeInteger(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isDenseArray(value: unknown): value is readonly unknown[] {
  if (!Array.isArray(value)) return false;
  for (let index = 0; index < value.length; index += 1) {
    if (!Object.hasOwn(value, index)) return false;
  }
  return true;
}

function arrayEntriesSatisfy(
  value: unknown,
  predicate: (entry: unknown) => boolean,
): boolean {
  if (!isDenseArray(value)) return false;
  for (let index = 0; index < value.length; index += 1) {
    if (!predicate(value[index])) return false;
  }
  return true;
}

function daysInMonth(year: number, month: number): number {
  if (month === 2) {
    const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
    return leapYear ? 29 : 28;
  }
  return month === 4 || month === 6 || month === 9 || month === 11 ? 30 : 31;
}

function isValidSnapshotIdentity(
  snapshot: ProjectSnapshot,
): snapshot is ProjectSnapshot {
  return (
    isNonEmptyText(snapshot.projectId) &&
    isProjectNumber(snapshot.projectNumber) &&
    isNonEmptyText(snapshot.repository) &&
    isDenseArray(snapshot.items)
  );
}

function isNativeSet(value: unknown): value is ReadonlySet<string> {
  return value instanceof Set;
}

function isValidItemIdentity(item: ProjectItem): boolean {
  if (!isRecord(item)) return false;
  return (
    isNonEmptyText(item.projectItemId) &&
    isNonEmptyText(item.projectId) &&
    isProjectNumber(item.projectNumber) &&
    isNonEmptyText(item.repository) &&
    isNonEmptyText(item.issueNodeId) &&
    isPositiveSafeInteger(item.issueNumber) &&
    typeof item.isOpen === "boolean" &&
    isNonEmptyText(item.status) &&
    isNonEmptyText(item.revision) &&
    arrayEntriesSatisfy(item.labels, isNonEmptyText)
  );
}

function isValidDependency(value: unknown): boolean {
  if (!isRecord(value)) return false;
  return (
    isNonEmptyText(value.issueNodeId) &&
    isPositiveSafeInteger(value.issueNumber) &&
    typeof value.isOpen === "boolean"
  );
}

function validateDependencies(
  dependencies: ProjectDependencies,
): ExclusionReason | undefined {
  if (dependencies === "unavailable") return "blocked_dependencies_unavailable";
  if (!arrayEntriesSatisfy(dependencies, isValidDependency)) {
    return "invalid_dependencies";
  }
  for (let index = 0; index < dependencies.length; index += 1) {
    if (dependencies[index]?.isOpen === true) {
      return "blocked_dependency_open";
    }
  }
  return undefined;
}

function canonicalTimestamp(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const match = canonicalTimestampPattern.exec(value);
  if (match === null) return undefined;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  const milliseconds = Number(match[7] ?? "0");
  if (
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > daysInMonth(year, month) ||
    hour > 23 ||
    minute > 59 ||
    second > 59
  ) {
    return undefined;
  }
  const date = new Date(0);
  date.setUTCFullYear(year, month - 1, day);
  date.setUTCHours(hour, minute, second, milliseconds);
  return date.toISOString();
}

function validPriority(value: unknown): boolean {
  return value === undefined || Number.isSafeInteger(value);
}

function compareBytes(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}

function compareCandidates(left: ProjectItem, right: ProjectItem): number {
  const leftPriority = left.priorityRank;
  const rightPriority = right.priorityRank;
  if (leftPriority === undefined && rightPriority !== undefined) return 1;
  if (leftPriority !== undefined && rightPriority === undefined) return -1;
  if (
    leftPriority !== undefined &&
    rightPriority !== undefined &&
    leftPriority !== rightPriority
  ) {
    return leftPriority - rightPriority;
  }
  const leftCreatedAt = canonicalTimestamp(left.createdAt) ?? "";
  const rightCreatedAt = canonicalTimestamp(right.createdAt) ?? "";
  if (leftCreatedAt !== rightCreatedAt) {
    return leftCreatedAt < rightCreatedAt ? -1 : 1;
  }
  if (left.issueNumber !== right.issueNumber) {
    return left.issueNumber - right.issueNumber;
  }
  return compareBytes(left.projectItemId, right.projectItemId);
}

function excluded(
  item: ProjectItem,
  reason: ExclusionReason,
): CandidateEvaluation {
  return { item, eligible: false, reason };
}

function evaluateCandidate(
  item: ProjectItem,
  input: DiscoveryInput,
  snapshotExclusionReason: ExclusionReason | undefined,
  duplicateProjectItemIds: ReadonlySet<string>,
): CandidateEvaluation {
  if (snapshotExclusionReason !== undefined)
    return excluded(item, snapshotExclusionReason);
  const projectItemId = isRecord(item) ? item.projectItemId : undefined;
  if (
    isNonEmptyText(projectItemId) &&
    duplicateProjectItemIds.has(projectItemId)
  ) {
    return excluded(item, "duplicate_project_item_id");
  }
  if (!isValidItemIdentity(item))
    return excluded(item, "invalid_item_identity");
  if (
    item.projectId !== input.projectId ||
    item.projectNumber !== input.projectNumber
  ) {
    return excluded(item, "wrong_project");
  }
  if (item.repository !== input.repository) {
    return excluded(item, "wrong_repository");
  }
  if (!item.isOpen) return excluded(item, "issue_closed");
  if (item.status !== input.readyStatus)
    return excluded(item, "status_not_ready");
  if (
    !arrayEntriesSatisfy(input.requiredLabels, (label) =>
      item.labels.includes(label as string),
    )
  ) {
    return excluded(item, "missing_required_label");
  }
  const dependencyReason = validateDependencies(item.dependencies);
  if (dependencyReason !== undefined) return excluded(item, dependencyReason);
  if (input.ownedProjectItemIds.has(item.projectItemId)) {
    return excluded(item, "owned_durable");
  }
  if (canonicalTimestamp(item.createdAt) === undefined) {
    return excluded(item, "invalid_created_at");
  }
  if (!validPriority(item.priorityRank)) {
    return excluded(item, "invalid_priority");
  }
  return { item, eligible: true };
}

function isValidInput(input: DiscoveryInput): boolean {
  if (!isRecord(input)) return false;
  if (
    !isNonEmptyText(input.projectId) ||
    !isProjectNumber(input.projectNumber) ||
    !isNonEmptyText(input.repository) ||
    !isNonEmptyText(input.readyStatus) ||
    !isNativeSet(input.ownedProjectItemIds)
  ) {
    return false;
  }
  return (
    Array.isArray(input.requiredLabels) &&
    input.requiredLabels.length > 0 &&
    arrayEntriesSatisfy(input.requiredLabels, isNonEmptyText)
  );
}

function invalidInputResult(snapshot: ProjectSnapshot): DiscoveryResult {
  const excluded: ExcludedProjectCandidate[] = [];
  if (isRecord(snapshot) && isDenseArray(snapshot.items)) {
    for (let index = 0; index < snapshot.items.length; index += 1) {
      excluded.push({
        ...(snapshot.items[index] as ProjectItem),
        reason: "invalid_input",
      });
    }
  }
  return {
    selected: undefined,
    eligible: [],
    excluded,
    reason: "invalid_input",
  };
}

function snapshotExclusionReason(
  snapshot: ProjectSnapshot,
  input: DiscoveryInput,
): ExclusionReason | undefined {
  if (!isDenseArray(snapshot.items)) return "invalid_snapshot_items";
  if (!isValidSnapshotIdentity(snapshot)) return "invalid_snapshot_identity";
  if (
    snapshot.projectId !== input.projectId ||
    snapshot.projectNumber !== input.projectNumber
  ) {
    return "wrong_project";
  }
  if (snapshot.repository !== input.repository) return "wrong_repository";
  return undefined;
}

function duplicateProjectItemIds(
  items: readonly ProjectItem[],
): ReadonlySet<string> {
  const counts = new Map<string, number>();
  const duplicates = new Set<string>();
  for (let index = 0; index < items.length; index += 1) {
    if (!Object.hasOwn(items, index)) continue;
    const candidate = items[index];
    if (!isRecord(candidate) || !isNonEmptyText(candidate.projectItemId)) {
      continue;
    }
    const count = (counts.get(candidate.projectItemId) ?? 0) + 1;
    counts.set(candidate.projectItemId, count);
    if (count > 1) duplicates.add(candidate.projectItemId);
  }
  return duplicates;
}

export function selectProjectCandidate(
  snapshot: ProjectSnapshot,
  input: DiscoveryInput,
): DiscoveryResult {
  if (!isValidInput(input)) return invalidInputResult(snapshot);

  if (!isRecord(snapshot) || !Array.isArray(snapshot.items)) {
    return { selected: undefined, eligible: [], excluded: [] };
  }

  const snapshotReason = snapshotExclusionReason(snapshot, input);
  const duplicateIds = duplicateProjectItemIds(snapshot.items);
  const evaluations: CandidateEvaluation[] = [];
  for (let index = 0; index < snapshot.items.length; index += 1) {
    if (!Object.hasOwn(snapshot.items, index)) {
      evaluations.push(
        excluded({} as ProjectItem, snapshotReason ?? "invalid_snapshot_items"),
      );
      continue;
    }
    evaluations.push(
      evaluateCandidate(
        snapshot.items[index] as ProjectItem,
        input,
        snapshotReason,
        duplicateIds,
      ),
    );
  }
  const eligible = evaluations
    .filter(
      (
        evaluation,
      ): evaluation is Extract<CandidateEvaluation, { eligible: true }> =>
        evaluation.eligible,
    )
    .map((evaluation) => evaluation.item)
    .toSorted(compareCandidates);
  const excludedCandidates = evaluations
    .filter(
      (
        evaluation,
      ): evaluation is Extract<CandidateEvaluation, { eligible: false }> =>
        !evaluation.eligible,
    )
    .map(({ item, reason }) => ({ ...item, reason }));

  return {
    selected: eligible[0],
    eligible,
    excluded: excludedCandidates,
  };
}
