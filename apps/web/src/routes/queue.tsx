import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type {
  QueueResponse,
  SchedulerControlPatch,
} from "@wheelsparrow/contracts";
import { fetchQueue, updateScheduler } from "../api.js";
import { RunCard } from "../components/cards.js";
import { ErrorState, LoadingState } from "../components/layout.js";

export const queueQueryKey = ["operator", "queue"] as const;
type SchedulerIntent = Pick<
  SchedulerControlPatch,
  "paused" | "stop_after_current"
>;

export function QueueRoute() {
  const queryClient = useQueryClient();
  const query = useQuery({ queryKey: queueQueryKey, queryFn: fetchQueue });
  const mutation = useMutation({
    mutationFn: (patch: SchedulerControlPatch) => updateScheduler(patch),
    onSuccess: (response) => {
      queryClient.setQueryData<QueueResponse>(queueQueryKey, (current) =>
        current ? { ...current, scheduler: response.scheduler } : current,
      );
    },
  });

  if (query.isPending) return <LoadingState />;
  if (query.isError) return <ErrorState message={query.error.message} />;
  const snapshot = query.data;
  const scheduler = snapshot.scheduler;

  function setScheduler(patch: SchedulerIntent) {
    mutation.mutate({
      schema_version: 1,
      expected_revision: scheduler.revision,
      ...patch,
    });
  }

  return (
    <section className="route-stack" aria-labelledby="queue-heading">
      <div className="page-heading">
        <div>
          <p className="eyebrow">Operational queue</p>
          <h1 id="queue-heading">Queue</h1>
          <p className="lede">
            One durable execution slot. Review work stays visible without
            blocking the next ticket.
          </p>
        </div>
        <div className="revision-stamp">
          Scheduler rev <strong>{scheduler.revision}</strong>
        </div>
      </div>

      <fieldset className="control-strip">
        <legend className="sr-only">Scheduler controls</legend>
        <div className="control-strip__state">
          <span
            className={`state-dot ${scheduler.paused ? "state-dot--paused" : "state-dot--live"}`}
            aria-hidden="true"
          />
          <div>
            <strong>{scheduler.paused ? "Paused" : "Running"}</strong>
            <span>
              {scheduler.stop_after_current
                ? " will stop after current"
                : " accepting work"}
            </span>
          </div>
        </div>
        <div className="control-strip__actions">
          {scheduler.paused ? (
            <button
              type="button"
              className="button button--primary"
              onClick={() => setScheduler({ paused: false })}
              disabled={mutation.isPending}
            >
              Resume queue
            </button>
          ) : (
            <button
              type="button"
              className="button button--primary"
              onClick={() => setScheduler({ paused: true })}
              disabled={mutation.isPending}
            >
              Pause queue
            </button>
          )}
          <button
            type="button"
            className="button button--quiet"
            onClick={() =>
              setScheduler({
                stop_after_current: !scheduler.stop_after_current,
              })
            }
            disabled={mutation.isPending}
          >
            {scheduler.stop_after_current
              ? "Continue after current"
              : "Stop after current"}
          </button>
        </div>
      </fieldset>

      <div className="queue-grid">
        <section
          className="queue-section queue-section--active"
          aria-labelledby="active-heading"
        >
          <div className="section-heading">
            <h2 id="active-heading">Active ticket</h2>
            <span className="count-badge">{snapshot.active_todo ? 1 : 0}</span>
          </div>
          {snapshot.active_todo ? (
            <RunCard run={snapshot.active_todo} />
          ) : (
            <p className="empty-state">No ticket is currently executing.</p>
          )}
        </section>
        <section className="queue-section" aria-labelledby="ready-heading">
          <div className="section-heading">
            <h2 id="ready-heading">Ready</h2>
            <span className="count-badge">{snapshot.ready.length}</span>
          </div>
          {snapshot.ready.length > 0 ? (
            <div className="card-stack">
              {snapshot.ready.map((run) => (
                <RunCard key={run.run_id} run={run} />
              ))}
            </div>
          ) : (
            <p className="empty-state">No eligible tickets discovered.</p>
          )}
        </section>
        <section className="queue-section" aria-labelledby="review-heading">
          <div className="section-heading">
            <h2 id="review-heading">Review inbox</h2>
            <span className="count-badge">{snapshot.review_count}</span>
          </div>
          {snapshot.review.length > 0 ? (
            <div className="card-stack">
              {snapshot.review.map((run) => (
                <RunCard key={run.run_id} run={run} />
              ))}
            </div>
          ) : (
            <p className="empty-state">No runs need your attention.</p>
          )}
        </section>
      </div>
    </section>
  );
}
