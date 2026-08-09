import type { OperatorQueueRun, OperatorRun } from "@wheelsparrow/contracts";
import { Link } from "react-router-dom";
import { SnapshotTime } from "./layout.js";

function StatePill({ state }: { state: string }) {
  return (
    <span className={`state-pill state-pill--${state.replaceAll("_", "-")}`}>
      {state.replaceAll("_", " ")}
    </span>
  );
}

export function RunCard({ run }: { run: OperatorQueueRun | OperatorRun }) {
  return (
    <article className="run-card">
      <div className="run-card__heading">
        <div>
          <p className="run-card__issue">Issue #{run.issue_number}</p>
          <h3>
            <Link to={`/runs/${encodeURIComponent(run.run_id)}`}>
              {run.repository}
            </Link>
          </h3>
        </div>
        <StatePill state={run.state} />
      </div>
      <dl className="compact-facts">
        <div>
          <dt>Run</dt>
          <dd>{run.run_id}</dd>
        </div>
        <div>
          <dt>Revision</dt>
          <dd>{run.revision}</dd>
        </div>
        <div>
          <dt>Epoch</dt>
          <dd>{run.rework_epoch}</dd>
        </div>
        <div>
          <dt>Updated</dt>
          <dd>
            <SnapshotTime value={run.updated_at} />
          </dd>
        </div>
      </dl>
      {run.branch && (
        <p className="branch-line">
          <span aria-hidden="true">↳</span> {run.branch}
        </p>
      )}
      {run.required_action && (
        <p className="action-line">
          <strong>Operator action:</strong> {run.required_action}
        </p>
      )}
      {run.blocked_reason && (
        <p className="muted-line">Blocked: {run.blocked_reason}</p>
      )}
    </article>
  );
}
