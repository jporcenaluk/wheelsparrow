import { useQuery } from "@tanstack/react-query";
import { fetchReview } from "../api.js";
import { RunCard } from "../components/cards.js";
import { ErrorState, LoadingState } from "../components/layout.js";

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
              <div className="review-card__detail">
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
                <p className="muted-line">
                  Approval and merge controls become available in the later
                  delivery block.
                </p>
              </div>
            </article>
          ))}
        </div>
      )}
    </section>
  );
}
