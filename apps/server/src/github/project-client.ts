import { createHash } from "node:crypto";

import type {
  ConditionalProjectStatusMove,
  GitHubProjectGateway,
  ProjectItem,
  ProjectSnapshot,
  ProjectSnapshotRequest,
  ProjectStatusMoveResult,
} from "./project.js";

const GRAPHQL_ENDPOINT = "https://api.github.com/graphql";
const MAX_PROJECT_PAGES = 100;

const PROJECT_ID_QUERY = `
  query WheelsparrowProjectId($owner: String!, $number: Int!) {
    user(login: $owner) { projectV2(number: $number) { id } }
    organization(login: $owner) { projectV2(number: $number) { id } }
  }
`;

const PROJECT_PAGE_QUERY = `
  query WheelsparrowProjectItems($projectId: ID!, $cursor: String) {
    node(id: $projectId) {
      ... on ProjectV2 {
        id
        number
        items(first: 100, after: $cursor) {
          nodes {
            id
            content {
              __typename
              ... on Issue {
                id
                number
                state
                createdAt
                repository { nameWithOwner }
                labels(first: 100) { nodes { name } }
                blockedBy(first: 100) {
                  nodes { ... on Issue { id number state } }
                  pageInfo { hasNextPage endCursor }
                }
              }
            }
            fieldValues(first: 100) {
              nodes {
                __typename
                ... on ProjectV2ItemFieldSingleSelectValue {
                  name
                  optionId
                  field {
                    ... on ProjectV2SingleSelectField {
                      id
                      name
                      options { id name }
                    }
                  }
                }
                ... on ProjectV2ItemFieldNumberValue {
                  number
                  field { ... on ProjectV2Field { id name } }
                }
              }
            }
          }
          pageInfo { hasNextPage endCursor }
        }
      }
    }
  }
`;

export interface GitHubProjectClientOptions {
  readonly owner: string;
  readonly repository: string;
  readonly projectNumber: number;
  readonly statusField: string;
  readonly readyStatus: string;
  readonly requiredLabels: readonly string[];
  readonly priorityField: string;
  /** A token read from an existing credential store; never from YAML. */
  readonly token?: string;
  readonly endpoint?: string;
  readonly fetch?: typeof globalThis.fetch;
  readonly timeoutMs?: number;
}

export type GitHubProjectClientErrorKind =
  | "credentials_unavailable"
  | "provider_unavailable"
  | "invalid_response"
  | "project_mismatch"
  | "repository_mismatch";

export class GitHubProjectClientError extends Error {
  readonly kind: GitHubProjectClientErrorKind;

  constructor(kind: GitHubProjectClientErrorKind, message: string) {
    super(message);
    this.name = "GitHubProjectClientError";
    this.kind = kind;
  }
}

export class GitHubCredentialsUnavailableError extends GitHubProjectClientError {
  constructor() {
    super(
      "credentials_unavailable",
      "GitHub credentials are unavailable from the configured credential store.",
    );
    this.name = "GitHubCredentialsUnavailableError";
  }
}

export class GitHubProjectResponseError extends GitHubProjectClientError {
  constructor(message = "GitHub Project data is unavailable.") {
    super("invalid_response", message);
    this.name = "GitHubProjectResponseError";
  }
}

export function githubTokenFromEnvironment(
  environment: NodeJS.ProcessEnv = process.env,
): string | undefined {
  for (const name of ["GITHUB_TOKEN", "GH_TOKEN"] as const) {
    const value = environment[name]?.trim();
    if (value !== undefined && value.length > 0) return value;
  }
  return undefined;
}

interface GraphQLPayload {
  readonly data?: unknown;
  readonly errors?: unknown;
}

interface RecordValue {
  readonly [key: string]: unknown;
}

function isRecord(value: unknown): value is RecordValue {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function array(value: unknown): readonly unknown[] | undefined {
  return Array.isArray(value) ? value : undefined;
}

function nonEmptyText(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function requiredRecord(value: unknown, label: string): RecordValue {
  if (!isRecord(value))
    throw new GitHubProjectResponseError(`${label} is unavailable.`);
  return value;
}

function requiredText(value: unknown, label: string): string {
  if (!nonEmptyText(value))
    throw new GitHubProjectResponseError(`${label} is unavailable.`);
  return value;
}

function requiredPositiveInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    throw new GitHubProjectResponseError(`${label} is unavailable.`);
  }
  return value as number;
}

function canonicalTimestamp(value: unknown): string {
  if (!nonEmptyText(value))
    throw new GitHubProjectResponseError("Issue creation time is unavailable.");
  const parsed = new Date(value);
  if (Number.isNaN(parsed.valueOf())) {
    throw new GitHubProjectResponseError("Issue creation time is unavailable.");
  }
  return parsed.toISOString();
}

function graphqlErrorPresent(value: unknown): boolean {
  const errors = array(value);
  return errors !== undefined && errors.length > 0;
}

function priorityRank(
  field: RecordValue,
  optionId: unknown,
): number | undefined {
  const options = array(field.options);
  if (options === undefined || !nonEmptyText(optionId)) return undefined;
  const index = options.findIndex(
    (option) => isRecord(option) && option.id === optionId,
  );
  return index >= 0 ? index : undefined;
}

interface ParsedProjectItem {
  readonly item: ProjectItem;
  readonly statusFieldId: string;
  readonly statusOptionIds: ReadonlyMap<string, string>;
}

function parseProjectItem(
  raw: unknown,
  projectId: string,
  projectNumber: number,
  statusFieldName: string,
  priorityFieldName: string,
): ParsedProjectItem | undefined {
  const item = requiredRecord(raw, "Project item");
  const projectItemId = requiredText(item.id, "Project item ID");
  const content = isRecord(item.content) ? item.content : undefined;
  if (content === undefined || content.__typename !== "Issue") return undefined;

  const issueNodeId = requiredText(content.id, "Issue ID");
  const issueNumber = requiredPositiveInteger(content.number, "Issue number");
  const repository = requiredText(
    requiredRecord(content.repository, "Issue repository").nameWithOwner,
    "Issue repository",
  );
  const isOpen = content.state === "OPEN";
  if (content.state !== "OPEN" && content.state !== "CLOSED") {
    throw new GitHubProjectResponseError("Issue state is unavailable.");
  }
  const createdAt = canonicalTimestamp(content.createdAt);
  const labelsContainer = requiredRecord(content.labels, "Issue labels");
  const labels = array(labelsContainer.nodes);
  if (
    labels === undefined ||
    labels.some((label) => !isRecord(label) || !nonEmptyText(label.name))
  ) {
    throw new GitHubProjectResponseError("Issue labels are unavailable.");
  }

  const blockedByContainer = content.blockedBy;
  let dependencies: ProjectItem["dependencies"];
  const blockedByPageInfo = isRecord(blockedByContainer)
    ? blockedByContainer.pageInfo
    : undefined;
  if (
    !isRecord(blockedByContainer) ||
    array(blockedByContainer.nodes) === undefined ||
    !isRecord(blockedByPageInfo) ||
    typeof blockedByPageInfo.hasNextPage !== "boolean" ||
    blockedByPageInfo.hasNextPage
  ) {
    // A Project dependency connection that is truncated or does not expose
    // pagination metadata cannot prove that every blocker is closed.
    dependencies = "unavailable";
  } else {
    const dependencyNodes = blockedByContainer.nodes as readonly unknown[];
    const parsedDependencies = dependencyNodes.map((dependency) => {
      if (
        !isRecord(dependency) ||
        !nonEmptyText(dependency.id) ||
        !Number.isSafeInteger(dependency.number) ||
        (dependency.number as number) < 1 ||
        (dependency.state !== "OPEN" && dependency.state !== "CLOSED")
      ) {
        return undefined;
      }
      return {
        issueNodeId: dependency.id,
        issueNumber: dependency.number as number,
        isOpen: dependency.state === "OPEN",
      };
    });
    dependencies = parsedDependencies.some(
      (dependency) => dependency === undefined,
    )
      ? "unavailable"
      : (parsedDependencies as NonNullable<ProjectItem["dependencies"]>);
  }

  const fieldValues = requiredRecord(item.fieldValues, "Project item fields");
  const fieldNodes = array(fieldValues.nodes);
  if (fieldNodes === undefined)
    throw new GitHubProjectResponseError("Project fields are unavailable.");

  let status: string | undefined;
  let statusFieldId: string | undefined;
  let statusOptionIds = new Map<string, string>();
  let priority: number | undefined;
  for (const fieldValue of fieldNodes) {
    if (!isRecord(fieldValue)) continue;
    const field = isRecord(fieldValue.field) ? fieldValue.field : undefined;
    const fieldName = field?.name;
    if (!isRecord(field) || !nonEmptyText(fieldName)) continue;
    if (
      fieldName === statusFieldName &&
      fieldValue.__typename === "ProjectV2ItemFieldSingleSelectValue"
    ) {
      status = requiredText(fieldValue.name, "Project status");
      statusFieldId = requiredText(field.id, "Project status field ID");
      const options = array(field.options);
      if (options !== undefined) {
        statusOptionIds = new Map(
          options.flatMap((option) => {
            if (
              !isRecord(option) ||
              !nonEmptyText(option.id) ||
              !nonEmptyText(option.name)
            )
              return [];
            return [[option.name, option.id] as const];
          }),
        );
      }
    } else if (fieldName === priorityFieldName) {
      if (fieldValue.__typename === "ProjectV2ItemFieldSingleSelectValue") {
        priority = priorityRank(field, fieldValue.optionId);
      } else if (
        fieldValue.__typename === "ProjectV2ItemFieldNumberValue" &&
        typeof fieldValue.number === "number" &&
        Number.isFinite(fieldValue.number) &&
        Number.isSafeInteger(fieldValue.number)
      ) {
        priority = fieldValue.number;
      }
    }
  }
  if (status === undefined || statusFieldId === undefined) {
    throw new GitHubProjectResponseError(
      "Configured Project status is unavailable.",
    );
  }

  const normalizedLabels = labels.map(
    (label) => (label as RecordValue).name as string,
  );
  const revision = createHash("sha256")
    .update(
      JSON.stringify({
        projectItemId,
        projectId,
        projectNumber,
        repository,
        issueNodeId,
        issueNumber,
        isOpen,
        status,
        labels: normalizedLabels,
        createdAt,
        priority,
        dependencies,
      }),
      "utf8",
    )
    .digest("hex");
  const result = {
    projectItemId,
    projectId,
    projectNumber,
    repository,
    issueNodeId,
    issueNumber,
    isOpen,
    status,
    revision,
    labels: normalizedLabels,
    createdAt,
    dependencies,
    ...(priority === undefined ? {} : { priorityRank: priority }),
  } satisfies ProjectItem;
  return { item: result, statusFieldId, statusOptionIds };
}

export interface ConfiguredGitHubProjectGateway extends GitHubProjectGateway {
  readConfiguredProject(): Promise<ProjectSnapshot>;
}

export class GitHubProjectClient implements ConfiguredGitHubProjectGateway {
  readonly #options: GitHubProjectClientOptions;
  readonly #fetch: typeof globalThis.fetch;
  readonly #token: string | undefined;
  readonly #endpoint: string;
  readonly #timeoutMs: number;
  #projectId: string | undefined;
  #statusFieldId: string | undefined;
  #statusOptionIds = new Map<string, string>();

  constructor(options: GitHubProjectClientOptions) {
    this.#options = options;
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#token = options.token?.trim();
    this.#endpoint = options.endpoint ?? GRAPHQL_ENDPOINT;
    this.#timeoutMs = options.timeoutMs ?? 30_000;
  }

  async readConfiguredProject(): Promise<ProjectSnapshot> {
    const data = await this.#request(PROJECT_ID_QUERY, {
      owner: this.#options.owner,
      number: this.#options.projectNumber,
    });
    const root = requiredRecord(data, "GitHub Project lookup");
    const ids = ["user", "organization"].flatMap((ownerType) => {
      const owner = root[ownerType];
      const project = isRecord(owner) ? owner.projectV2 : undefined;
      if (!isRecord(project) || !nonEmptyText(project.id)) return [];
      return [project.id];
    });
    const uniqueIds = [...new Set(ids)];
    if (uniqueIds.length !== 1) {
      throw new GitHubProjectClientError(
        "project_mismatch",
        "The configured GitHub Project could not be resolved uniquely.",
      );
    }
    const projectId = uniqueIds[0];
    if (projectId === undefined) {
      throw new GitHubProjectClientError(
        "project_mismatch",
        "The configured GitHub Project could not be resolved uniquely.",
      );
    }
    this.#projectId = projectId;
    return this.readProject({
      projectId,
      projectNumber: this.#options.projectNumber,
      repository: this.#options.repository,
    });
  }

  async readProject(request: ProjectSnapshotRequest): Promise<ProjectSnapshot> {
    if (
      request.projectNumber !== this.#options.projectNumber ||
      request.repository !== this.#options.repository
    ) {
      throw new GitHubProjectClientError(
        request.repository === this.#options.repository
          ? "project_mismatch"
          : "repository_mismatch",
        "The GitHub Project request does not match configured scope.",
      );
    }
    if (!nonEmptyText(request.projectId)) {
      throw new GitHubProjectResponseError("Project ID is unavailable.");
    }
    this.#projectId = request.projectId;
    const items: ProjectItem[] = [];
    let cursor: string | null = null;
    let projectNumber: number | undefined;
    for (let page = 0; page < MAX_PROJECT_PAGES; page += 1) {
      const data = await this.#request(PROJECT_PAGE_QUERY, {
        projectId: request.projectId,
        cursor,
      });
      const root = requiredRecord(data, "GitHub Project response");
      const project = requiredRecord(root.node, "GitHub Project");
      if (project.id !== request.projectId) {
        throw new GitHubProjectClientError(
          "project_mismatch",
          "The GitHub Project response does not match configured scope.",
        );
      }
      const observedNumber = requiredPositiveInteger(
        project.number,
        "Project number",
      );
      if (projectNumber === undefined) projectNumber = observedNumber;
      if (
        projectNumber !== observedNumber ||
        observedNumber !== request.projectNumber
      ) {
        throw new GitHubProjectClientError(
          "project_mismatch",
          "The GitHub Project number does not match configured scope.",
        );
      }
      const itemsContainer = requiredRecord(
        project.items,
        "GitHub Project items",
      );
      const nodes = array(itemsContainer.nodes);
      const pageInfo = requiredRecord(
        itemsContainer.pageInfo,
        "GitHub Project pagination",
      );
      if (nodes === undefined || typeof pageInfo.hasNextPage !== "boolean") {
        throw new GitHubProjectResponseError(
          "GitHub Project pagination is unavailable.",
        );
      }
      for (const node of nodes) {
        const parsed = parseProjectItem(
          node,
          request.projectId,
          request.projectNumber,
          this.#options.statusField,
          this.#options.priorityField,
        );
        if (parsed === undefined) continue;
        items.push(parsed.item);
        this.#statusFieldId = parsed.statusFieldId;
        this.#statusOptionIds = new Map([
          ...this.#statusOptionIds,
          ...parsed.statusOptionIds,
        ]);
      }
      if (!pageInfo.hasNextPage) break;
      const endCursor = pageInfo.endCursor;
      if (!nonEmptyText(endCursor)) {
        throw new GitHubProjectResponseError(
          "GitHub Project cursor is unavailable.",
        );
      }
      cursor = endCursor;
      if (page === MAX_PROJECT_PAGES - 1) {
        throw new GitHubProjectResponseError(
          "GitHub Project has too many pages.",
        );
      }
    }
    return {
      projectId: request.projectId,
      projectNumber: request.projectNumber,
      repository: request.repository,
      items,
    };
  }

  async readProjectItem(
    projectItemId: string,
  ): Promise<ProjectItem | undefined> {
    const snapshot = await (this.#projectId === undefined
      ? this.readConfiguredProject()
      : this.readProject({
          projectId: this.#projectId,
          projectNumber: this.#options.projectNumber,
          repository: this.#options.repository,
        }));
    return snapshot.items.find((item) => item.projectItemId === projectItemId);
  }

  async moveProjectItem(
    request: ConditionalProjectStatusMove,
  ): Promise<ProjectStatusMoveResult> {
    const snapshot = await this.readProject({
      projectId: request.projectId,
      projectNumber: request.projectNumber,
      repository: this.#options.repository,
    });
    const current = snapshot.items.find(
      (item) => item.projectItemId === request.itemId,
    );
    if (current === undefined) {
      return {
        outcome: "rejected",
        reason: { kind: "unknown_item", itemId: request.itemId },
      };
    }
    if (
      current.issueNodeId !== request.issueNodeId ||
      current.issueNumber !== request.issueNumber
    ) {
      return {
        outcome: "rejected",
        reason: {
          kind: "issue_mapping_mismatch",
          expectedIssueNodeId: request.issueNodeId,
          expectedIssueNumber: request.issueNumber,
          actualIssueNodeId: current.issueNodeId,
          actualIssueNumber: current.issueNumber,
        },
      };
    }
    if (
      current.status === request.toStatus &&
      current.revision !== request.expectedRevision
    ) {
      return {
        outcome: "rejected",
        reason: {
          kind: "already_applied_drift",
          expectedStatus: request.fromStatus,
          expectedRevision: request.expectedRevision,
          actualStatus: current.status,
          actualRevision: current.revision,
        },
      };
    }
    if (current.revision !== request.expectedRevision) {
      return {
        outcome: "rejected",
        reason: {
          kind: "revision_mismatch",
          expectedRevision: request.expectedRevision,
          actualRevision: current.revision,
        },
      };
    }
    if (current.status !== request.fromStatus) {
      return {
        outcome: "rejected",
        reason: {
          kind: "status_mismatch",
          expectedStatus: request.fromStatus,
          actualStatus: current.status,
        },
      };
    }
    const fieldId = this.#statusFieldId;
    const optionId = this.#statusOptionIds.get(request.toStatus);
    if (fieldId === undefined || optionId === undefined) {
      return {
        outcome: "rejected",
        reason: { kind: "invalid_request", field: "toStatus" },
      };
    }
    await this.#request(
      `
        mutation WheelsparrowMoveProjectItem($projectId: ID!, $itemId: ID!, $fieldId: ID!, $optionId: String!) {
          updateProjectV2ItemFieldValue(input: {
            projectId: $projectId,
            itemId: $itemId,
            fieldId: $fieldId,
            value: { singleSelectOptionId: $optionId }
          }) { projectV2Item { id } }
        }
      `,
      {
        projectId: request.projectId,
        itemId: request.itemId,
        fieldId,
        optionId,
      },
    );
    const observed = await this.readProject({
      projectId: request.projectId,
      projectNumber: request.projectNumber,
      repository: this.#options.repository,
    });
    const moved = observed.items.find(
      (item) => item.projectItemId === request.itemId,
    );
    if (
      moved === undefined ||
      moved.issueNodeId !== request.issueNodeId ||
      moved.issueNumber !== request.issueNumber ||
      moved.status !== request.toStatus
    ) {
      throw new GitHubProjectResponseError(
        "GitHub Project move was not confirmed.",
      );
    }
    return { outcome: "moved", item: moved };
  }

  async #request(
    query: string,
    variables: Record<string, unknown>,
  ): Promise<unknown> {
    const token = this.#token;
    if (token === undefined || token.length === 0)
      throw new GitHubCredentialsUnavailableError();
    let response: Response;
    try {
      response = await this.#fetch(this.#endpoint, {
        method: "POST",
        headers: {
          accept: "application/vnd.github+json",
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
          "user-agent": "wheelsparrow",
        },
        body: JSON.stringify({ query, variables }),
        signal: AbortSignal.timeout(this.#timeoutMs),
      });
    } catch {
      throw new GitHubProjectClientError(
        "provider_unavailable",
        "GitHub Project provider is unavailable.",
      );
    }
    if (!response.ok) {
      throw new GitHubProjectClientError(
        "provider_unavailable",
        "GitHub Project provider is unavailable.",
      );
    }
    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      throw new GitHubProjectResponseError();
    }
    if (!isRecord(payload)) throw new GitHubProjectResponseError();
    const graphql = payload as GraphQLPayload;
    if (graphqlErrorPresent(graphql.errors) || graphql.data === undefined) {
      throw new GitHubProjectResponseError();
    }
    return graphql.data;
  }
}

export function createGitHubProjectGateway(
  options: Omit<GitHubProjectClientOptions, "token"> & {
    readonly token?: string;
  },
): ConfiguredGitHubProjectGateway {
  const configuredToken = options.token ?? githubTokenFromEnvironment();
  const clientOptions = { ...options };
  if (configuredToken === undefined)
    return new GitHubProjectClient(clientOptions);
  return new GitHubProjectClient({ ...clientOptions, token: configuredToken });
}
