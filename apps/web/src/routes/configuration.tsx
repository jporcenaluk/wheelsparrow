import { useQuery } from "@tanstack/react-query";
import { fetchConfiguration } from "../api.js";
import { ErrorState, LoadingState } from "../components/layout.js";

export function ConfigurationRoute() {
  const query = useQuery({
    queryKey: ["operator", "configuration"],
    queryFn: fetchConfiguration,
  });
  if (query.isPending) return <LoadingState />;
  if (query.isError) return <ErrorState message={query.error.message} />;
  const { configuration } = query.data;
  return (
    <section className="route-stack" aria-labelledby="configuration-heading">
      <div className="page-heading">
        <div>
          <p className="eyebrow">Effective runtime contract</p>
          <h1 id="configuration-heading">Configuration</h1>
          <p className="lede">
            Validated read-only settings for this local operator instance.
          </p>
        </div>
        <span className="read-only-badge">Read only</span>
      </div>
      <div className="detail-grid">
        <section className="panel" aria-labelledby="github-heading">
          <div className="section-heading">
            <h2 id="github-heading">GitHub project</h2>
          </div>
          <dl className="facts-grid">
            <div>
              <dt>Repository</dt>
              <dd>
                {configuration.github.owner}/{configuration.github.repository}
              </dd>
            </div>
            <div>
              <dt>Project number</dt>
              <dd>{configuration.github.project_number}</dd>
            </div>
            <div>
              <dt>Status field</dt>
              <dd>{configuration.github.status_field}</dd>
            </div>
            <div>
              <dt>Priority field</dt>
              <dd>{configuration.github.priority_field}</dd>
            </div>
            <div>
              <dt>Ready lane</dt>
              <dd>{configuration.github.lanes.ready}</dd>
            </div>
            <div>
              <dt>Todo lane</dt>
              <dd>{configuration.github.lanes.todo}</dd>
            </div>
            <div>
              <dt>Review lane</dt>
              <dd>{configuration.github.lanes.review}</dd>
            </div>
            <div>
              <dt>Done lane</dt>
              <dd>{configuration.github.lanes.done}</dd>
            </div>
          </dl>
          <p className="muted-line">
            Required labels: {configuration.github.required_labels.join(", ")}
          </p>
        </section>
        <section className="panel" aria-labelledby="runtime-heading">
          <div className="section-heading">
            <h2 id="runtime-heading">Runtime</h2>
          </div>
          <dl className="facts-grid">
            <div>
              <dt>Poll interval</dt>
              <dd>{configuration.poll_interval_seconds}s</dd>
            </div>
            <div>
              <dt>Workspace root</dt>
              <dd>{configuration.workspace_root}</dd>
            </div>
            <div>
              <dt>Agent command</dt>
              <dd>
                <code>{configuration.agent.command}</code>
              </dd>
            </div>
            <div>
              <dt>Model</dt>
              <dd>{configuration.agent.model}</dd>
            </div>
            <div>
              <dt>Reasoning</dt>
              <dd>{configuration.agent.reasoning_effort}</dd>
            </div>
            <div>
              <dt>Agent timeout</dt>
              <dd>{configuration.agent.timeout_minutes}m</dd>
            </div>
            <div>
              <dt>Verification</dt>
              <dd>
                <code>{configuration.verification.command}</code>
              </dd>
            </div>
            <div>
              <dt>Staging</dt>
              <dd>
                {configuration.staging.environment} ·{" "}
                {configuration.staging.workflow}
              </dd>
            </div>
            <div>
              <dt>Smoke</dt>
              <dd>
                <code>{configuration.staging.smoke_command}</code>
              </dd>
            </div>
          </dl>
        </section>
      </div>
    </section>
  );
}
