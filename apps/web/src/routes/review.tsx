import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type {
  ApproveMergeRequest,
  OperatorReviewItem,
  OperatorRun,
} from "@wheelsparrow/contracts";
import { useState } from "react";
import {
  approveRun,
  fetchReview,
  fetchRun,
  OperatorApiError,
  retryStaging,
} from "../api.js";
import { RunCard } from "../components/cards.js";
import { ErrorState, LoadingState } from "../components/layout.js";

function actionErrorMessage(
  error: unknown,
  action: "approve" | "retry",
): string {
  const apiError = error instanceof OperatorApiError ? error : null;
  const status = apiError?.status;
  const statusSuffix = status === undefined ? "" : ` (HTTP ${status})`;

  if (
    action === "retry" &&
    (status === 503 || apiError?.code === "capability_unavailable")
  )
    return `Staging retry unavailable${statusSuffix}. No staging run was started and no merge was performed.`;
  if (status === 409 || apiError?.code === "revision_conflict")
    return `This review candidate is stale${statusSuffix}. Refresh and confirm the current head and base again.`;
  if (status === 403 || apiError?.code === "csrf_forbidden")
    return `${action === "approve" ? "Approval" : "Staging retry"} was not authorized${statusSuffix}. Check the operator session and try again.`;
  if (status === 400 || apiError?.code === "invalid_request")
    return `${action === "approve" ? "Approval" : "Staging retry"} was not accepted${statusSuffix}. Refresh the current run facts and try again.`;
  return `${action === "approve" ? "Approval" : "Staging retry"} could not be completed${statusSuffix}. The durable run state was not changed by the browser.`;
}

function DeliveryFacts({ run }: { run: OperatorRun }) {
  return (
    <dl className="delivery-facts">
      <div>
        <dt>Current revision</dt>
        <dd>{run.revision}</dd>
      </div>
      <div>
        <dt>Base SHA</dt>
        <dd>
          <code>{run.base_sha ?? "Unavailable"}</code>
        </dd>
      </div>
      <div>
        <dt>Head SHA</dt>
        <dd>
          <code>{run.head_sha ?? "Unavailable"}</code>
        </dd>
      </div>
      {run.merge_sha && (
        <div>
          <dt>Merge SHA</dt>
          <dd>
            <code>{run.merge_sha}</code>
          </dd>
        </div>
      )}
    </dl>
  );
}

function ReviewDeliveryControls({ item }: { item: OperatorReviewItem }) {
  const queryClient = useQueryClient();
  const [confirmed, setConfirmed] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const detailQuery = useQuery({
    queryKey: ["operator", "run", item.run_id],
    queryFn: () => fetchRun(item.run_id),
    enabled: item.state === "review",
  });
  const invalidateDeliveryQueries = async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ["operator", "review"] }),
      queryClient.invalidateQueries({ queryKey: ["operator", "queue"] }),
      queryClient.invalidateQueries({
        queryKey: ["operator", "run", item.run_id],
      }),
    ]);
  };
  const approvalMutation = useMutation({
    mutationFn: (request: ApproveMergeRequest) =>
      approveRun(item.run_id, request),
    onError: (error: unknown) => {
      setActionError(actionErrorMessage(error, "approve"));
    },
    onSuccess: () => setActionError(null),
    onSettled: async () => {
      setConfirmed(false);
      await invalidateDeliveryQueries();
    },
  });
  const retryMutation = useMutation({
    mutationFn: () => retryStaging(item.run_id),
    onError: (error: unknown) => {
      setActionError(actionErrorMessage(error, "retry"));
    },
    onSuccess: () => setActionError(null),
    onSettled: async () => {
      await invalidateDeliveryQueries();
    },
  });

  if (item.state !== "review") return null;
  if (detailQuery.isPending) {
    return (
      <div className="review-card__detail">
        <p className="muted-line" aria-live="polite">
          Loading the current delivery candidate…
        </p>
      </div>
    );
  }
  if (detailQuery.isError) {
    return (
      <div className="review-card__detail">
        <p className="notice notice--error" role="alert">
          The current delivery candidate could not be read. Refresh before
          taking an action.
        </p>
      </div>
    );
  }

  const run = detailQuery.data.run;
  const actionPending = approvalMutation.isPending || retryMutation.isPending;
  const canApprove =
    run.state === "review" &&
    run.base_sha !== null &&
    run.head_sha !== null &&
    run.merge_sha === null &&
    item.approval === null;
  const canRetryStaging = run.merge_sha !== null;

  return (
    <div className="review-card__detail">
      <div className="delivery-heading">
        <div>
          <h2>Exact delivery candidate</h2>
          <p className="muted-line">
            Read-only facts from the latest durable run snapshot.
          </p>
        </div>
        <span className="read-only-badge">Read only</span>
      </div>
      <DeliveryFacts run={run} />
      {canApprove && (
        <div className="delivery-controls">
          <label className="confirmation-control">
            <input
              type="checkbox"
              checked={confirmed}
              onChange={(event) => setConfirmed(event.currentTarget.checked)}
              disabled={actionPending}
            />
            <span>
              I confirm this exact head and base are the candidate I intend to
              merge.
            </span>
          </label>
          <button
            type="button"
            className="button button--primary"
            onClick={() => {
              if (!confirmed || run.base_sha === null || run.head_sha === null)
                return;
              setActionError(null);
              approvalMutation.mutate({
                schema_version: 1,
                expected_run_revision: run.revision,
                approved_head_sha: run.head_sha,
                approved_base_sha: run.base_sha,
              });
            }}
            disabled={!confirmed || actionPending}
          >
            {approvalMutation.isPending
              ? "Approving…"
              : "Approve exact candidate"}
          </button>
        </div>
      )}
      {canRetryStaging && (
        <div className="delivery-controls delivery-controls--retry">
          <p className="muted-line">
            A merge receipt exists, but staging still needs a truthful
            coordinator action.
          </p>
          <button
            type="button"
            className="button button--quiet"
            onClick={() => {
              setActionError(null);
              retryMutation.mutate();
            }}
            disabled={actionPending}
          >
            {retryMutation.isPending
              ? "Checking staging retry…"
              : "Retry staging"}
          </button>
        </div>
      )}
      {!canApprove && !canRetryStaging && (
        <p className="muted-line">
          Approval is unavailable until the server exposes a complete Review
          candidate with exact pull-request facts.
        </p>
      )}
      {actionError && (
        <p className="notice notice--error" role="alert">
          {actionError}
        </p>
      )}
    </div>
  );
}

export function ReviewRoute() {
  const query = useQuery({
    queryKey: ["operator", "review"],
    queryFn: fetchReview,
  });
  if (query.isPending) return <LoadingState />;
  if (query.isError) return <ErrorState message={query.error.message} />;
  return (
    <section className="route-stack" aria-labelledby="review-page-heading">
      <div className="page-heading">
        <div>
          <p className="eyebrow">Human handoff</p>
          <h1 id="review-page-heading">Review</h1>
          <p className="lede">
            A queue of durable run receipts that need an operator decision.
          </p>
        </div>
        <div className="revision-stamp">
          Inbox <strong>{query.data.items.length}</strong>
        </div>
      </div>
      {query.data.items.length === 0 ? (
        <p className="empty-state empty-state--large">
          No runs need your attention.
        </p>
      ) : (
        <div className="review-stack">
          {query.data.items.map((item) => (
            <article className="review-card" key={item.run_id}>
              <RunCard run={item} />
              <div className="review-card__detail review-card__receipt">
                {item.findings.length > 0 && (
                  <div>
                    <h2>Findings</h2>
                    <ul className="finding-list">
                      {item.findings.map((finding) => (
                        <li key={finding.id}>
                          <strong>{finding.severity}</strong>
                          <span>{finding.evidence}</span>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
                <p className="action-line">
                  <strong>Required action:</strong>{" "}
                  {item.required_action ?? "Inspect the run receipt."}
                </p>
              </div>
              <ReviewDeliveryControls item={item} />
            </article>
          ))}
        </div>
      )}
    </section>
  );
}
