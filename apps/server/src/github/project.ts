export interface ProjectSnapshotRequest {
  readonly projectId: string;
  readonly projectNumber: number;
  readonly repository: string;
}

export interface ProjectDependency {
  readonly issueNodeId: string;
  readonly issueNumber: number;
  readonly isOpen: boolean;
}

export type ProjectDependencies = readonly ProjectDependency[] | "unavailable";

export interface ProjectItem {
  readonly projectItemId: string;
  readonly projectId: string;
  readonly projectNumber: number;
  readonly repository: string;
  readonly issueNodeId: string;
  readonly issueNumber: number;
  readonly isOpen: boolean;
  readonly status: string;
  /** An opaque, non-empty token for the observed item revision. */
  readonly revision: string;
  readonly labels: readonly string[];
  readonly createdAt: string;
  readonly priorityRank?: number;
  readonly dependencies: ProjectDependencies;
}

export interface ProjectSnapshot {
  readonly projectId: string;
  readonly projectNumber: number;
  readonly repository: string;
  readonly items: readonly ProjectItem[];
}

export interface ConditionalProjectStatusMove {
  readonly projectId: string;
  readonly projectNumber: number;
  readonly itemId: string;
  readonly issueNodeId: string;
  readonly issueNumber: number;
  readonly expectedRevision: string;
  readonly fromStatus: string;
  readonly toStatus: string;
  /** Stable durable-effect key used for idempotent replay. */
  readonly effectKey: string;
}

export type ProjectMoveRequestField =
  | "effectKey"
  | "fromStatus"
  | "toStatus"
  | "expectedRevision"
  | "projectNumber"
  | "issueNumber";

export type ProjectMoveRejection =
  | {
      readonly kind: "wrong_project";
      readonly expectedProjectId: string;
      readonly expectedProjectNumber: number;
    }
  | { readonly kind: "unknown_item"; readonly itemId: string }
  | {
      readonly kind: "revision_mismatch";
      readonly expectedRevision: string;
      readonly actualRevision: string;
    }
  | {
      readonly kind: "status_mismatch";
      readonly expectedStatus: string;
      readonly actualStatus: string;
    }
  | {
      readonly kind: "issue_mapping_mismatch";
      readonly expectedIssueNodeId: string;
      readonly expectedIssueNumber: number;
      readonly actualIssueNodeId: string;
      readonly actualIssueNumber: number;
    }
  | {
      readonly kind: "invalid_request";
      readonly field: ProjectMoveRequestField;
    }
  | {
      readonly kind: "already_applied_drift";
      readonly expectedStatus: string;
      readonly expectedRevision: string;
      readonly actualStatus: string;
      readonly actualRevision: string;
    }
  | { readonly kind: "effect_key_conflict"; readonly effectKey: string };

export type ProjectStatusMoveResult =
  | { readonly outcome: "moved"; readonly item: ProjectItem }
  | { readonly outcome: "already_applied"; readonly item: ProjectItem }
  | { readonly outcome: "rejected"; readonly reason: ProjectMoveRejection };

export interface ProjectStatusMutation {
  readonly effectKey: string;
  readonly itemId: string;
  readonly fromStatus: string;
  readonly toStatus: string;
  readonly previousRevision: string;
  readonly revision: string;
  readonly request: ConditionalProjectStatusMove;
  readonly item: ProjectItem;
}

export interface GitHubProjectGateway {
  readProject(request: ProjectSnapshotRequest): Promise<ProjectSnapshot>;
  readProjectItem(projectItemId: string): Promise<ProjectItem | undefined>;
  moveProjectItem(
    request: ConditionalProjectStatusMove,
  ): Promise<ProjectStatusMoveResult>;
}
