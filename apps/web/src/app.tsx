import { useEffect, useState } from "react";

import { fetchHealth } from "./api.js";

type ServiceState = "checking" | "live" | "unavailable";

const statusText: Record<ServiceState, string> = {
  checking: "Checking service",
  live: "Service live",
  unavailable: "Service unavailable",
};

export function App() {
  const [state, setState] = useState<ServiceState>("checking");

  useEffect(() => {
    let active = true;
    void fetchHealth().then(
      () => active && setState("live"),
      () => active && setState("unavailable"),
    );
    return () => {
      active = false;
    };
  }, []);

  return (
    <main className="control-surface">
      <p className="eyebrow">Local SDLC orchestrator</p>
      <h1>Wheelsparrow</h1>
      <p className={`status status--${state}`} role="status" aria-live="polite">
        <span aria-hidden="true" className="status__mark" />
        {statusText[state]}
      </p>
    </main>
  );
}
