import { useQuery } from "@tanstack/react-query";
import { Link, useParams } from "react-router-dom";
import { fetchRun, safeGithubPullRequestUrl } from "../api.js";
import {
  ErrorState,
  LoadingState,
  SnapshotTime,
} from "../components/layout.js";

export function RunRoute() {
  const { runId = "" } = useParams();
  const query = useQuery({
    queryKey: ["operator", "run", runId],
    queryFn: () => fetchRun(runId),
    enabled: runId.length > 0,
  });
  if (query.isPending) return <LoadingState />;
  if (query.isError) return <ErrorState message={query.error.message} />;
  const { run, steps, findings, approvals, events } = query.data;
  const pullRequestHref = safeGithubPullRequestUrl(run.pull_request_url);
  return (
    <section className="route-stack" aria-labelledby="run-heading">
      <div className="page-heading page-heading--compact">
        <div>
          <Link className="back-link" to="/queue">
            ← Queue
          </Link>
          <p className="eyebrow">Run detail</p>
          <h1 id="run-heading">Issue #{run.issue_number}</h1>
          <p className="lede">
            {run.repository} · <code>{run.run_id}</code>
          </p>
        </div>
        <span
          className={`state-pill state-pill--${run.state.replaceAll("_", "-")}`}
        >
          {run.state.replaceAll("_", " ")}
        </span>
      </div>
      <div className="detail-grid">
        <section className="panel" aria-labelledby="run-facts-heading">
          <div className="section-heading">
            <h2 id="run-facts-heading">Execution facts</h2>
          </div>
          <dl className="facts-grid">
            <div>
              <dt>Revision</dt>
              <dd>{run.revision}</dd>
            </div>
            <div>
              <dt>Rework epoch</dt>
              <dd>{run.rework_epoch}</dd>
            </div>
            <div>
              <dt>Repair round</dt>
              <dd>{run.repair_round}</dd>
            </div>
            <div>
              <dt>Base branch</dt>
              <dd>{run.base_branch}</dd>
            </div>
            <div>
              <dt>Branch</dt>
              <dd>{run.branch ?? "—"}</dd>
            </div>
            <div>
              <dt>Worktree</dt>
              <dd>{run.worktree_path ?? "—"}</dd>
            </div>
            <div>
              <dt>Base SHA</dt>
              <dd>
                <code>{run.base_sha ?? "—"}</code>
              </dd>
            </div>
            <div>
              <dt>Head SHA</dt>
              <dd>
                <code>{run.head_sha ?? "—"}</code>
              </dd>
            </div>
          </dl>
        </section>
        <section className="panel" aria-labelledby="publication-heading">
          <div className="section-heading">
            <h2 id="publication-heading">Publication</h2>
          </div>
          <dl className="facts-grid">
            <div>
              <dt>Pull request</dt>
              <dd>
                {pullRequestHref ? (
                  <a href={pullRequestHref}>
                    {run.pull_request_title ??
                      `#${run.pull_request_number ?? "?"}`}
                  </a>
                ) : (
                  (run.pull_request_url ?? "—")
                )}
              </dd>
            </div>
            <div>
              <dt>Observed base</dt>
              <dd>
                <code>{run.observed_base_sha ?? "—"}</code>
              </dd>
            </div>
            <div>
              <dt>Merge SHA</dt>
              <dd>
                <code>{run.merge_sha ?? "—"}</code>
              </dd>
            </div>
            <div>
              <dt>Required action</dt>
              <dd>{run.required_action ?? "None"}</dd>
            </div>
          </dl>
        </section>
      </div>
      <section className="panel" aria-labelledby="steps-heading">
        <div className="section-heading">
          <h2 id="steps-heading">Steps</h2>
          <span className="count-badge">{steps.length}</span>
        </div>
        {steps.length === 0 ? (
          <p className="empty-state">No step receipts yet.</p>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Role</th>
                  <th>Step</th>
                  <th>Status</th>
                  <th>Attempt</th>
                  <th>Summary</th>
                </tr>
              </thead>
              <tbody>
                {steps.map((step) => (
                  <tr key={step.id}>
                    <td>{step.role}</td>
                    <td>{step.logical_step}</td>
                    <td>{step.status}</td>
                    <td>{step.attempt}</td>
                    <td>{step.summary ?? "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
      <div className="detail-grid">
        <section className="panel" aria-labelledby="findings-heading">
          <div className="section-heading">
            <h2 id="findings-heading">Findings</h2>
            <span className="count-badge">{findings.length}</span>
          </div>
          {findings.length === 0 ? (
            <p className="empty-state">No findings recorded.</p>
          ) : (
            <ul className="finding-list">
              {findings.map((finding) => (
                <li key={finding.id}>
                  <strong>{finding.severity}</strong>
                  <span>{finding.evidence}</span>
                  <small>{finding.disposition}</small>
                </li>
              ))}
            </ul>
          )}
        </section>
        <section className="panel" aria-labelledby="events-heading">
          <div className="section-heading">
            <h2 id="events-heading">Event history</h2>
            <span className="count-badge">{events.length}</span>
          </div>
          {events.length === 0 ? (
            <p className="empty-state">No events recorded.</p>
          ) : (
            <ol className="event-list">
              {events.map((event) => (
                <li key={event.id}>
                  <span className="event-sequence">{event.sequence}</span>
                  <div>
                    <strong>{event.summary}</strong>
                    <small>
                      {event.kind} · <SnapshotTime value={event.created_at} />
                    </small>
                  </div>
                </li>
              ))}
            </ol>
          )}
        </section>
      </div>
      {approvals.length > 0 && (
        <section className="panel" aria-labelledby="approvals-heading">
          <div className="section-heading">
            <h2 id="approvals-heading">Approval history</h2>
          </div>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Decision</th>
                  <th>Head SHA</th>
                  <th>Base SHA</th>
                  <th>Recorded</th>
                </tr>
              </thead>
              <tbody>
                {approvals.map((approval) => (
                  <tr key={approval.id}>
                    <td>{approval.decision}</td>
                    <td>
                      <code>{approval.approved_head_sha}</code>
                    </td>
                    <td>
                      <code>{approval.observed_base_sha}</code>
                    </td>
                    <td>{approval.created_at}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}
    </section>
  );
}
