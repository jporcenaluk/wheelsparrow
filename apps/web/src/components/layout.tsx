import { useEffect, useState } from "react";
import { NavLink, Outlet } from "react-router-dom";
import { fetchHealth, subscribeToSnapshots } from "../api.js";

type ServiceState = "checking" | "live" | "unavailable";

const statusText: Record<ServiceState, string> = {
  checking: "Checking service",
  live: "Service live",
  unavailable: "Service unavailable",
};

export function ServiceIndicator() {
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
    <p className={`status status--${state}`} role="status" aria-live="polite">
      <span aria-hidden="true" className="status__mark" />
      {statusText[state]}
    </p>
  );
}

export function Shell({ onSnapshot }: { onSnapshot: () => void }) {
  useEffect(() => subscribeToSnapshots(onSnapshot), [onSnapshot]);

  return (
    <div className="app-shell">
      <header className="topbar">
        <div className="brand-lockup">
          <span className="brand-mark" aria-hidden="true">
            W/
          </span>
          <div>
            <p className="eyebrow">Local SDLC orchestrator</p>
            <p className="brand-name">Wheelsparrow</p>
          </div>
        </div>
        <ServiceIndicator />
      </header>
      <nav className="primary-nav" aria-label="Operator views">
        <NavLink
          to="/queue"
          className={({ isActive }) =>
            isActive ? "nav-link nav-link--active" : "nav-link"
          }
        >
          Queue
        </NavLink>
        <NavLink
          to="/review"
          className={({ isActive }) =>
            isActive ? "nav-link nav-link--active" : "nav-link"
          }
        >
          Review
        </NavLink>
        <NavLink
          to="/configuration"
          className={({ isActive }) =>
            isActive ? "nav-link nav-link--active" : "nav-link"
          }
        >
          Configuration
        </NavLink>
      </nav>
      <main className="page-frame">
        <Outlet />
      </main>
      <footer className="footer-note">
        Operator surface · durable state remains on the server
      </footer>
    </div>
  );
}

export function LoadingState() {
  return (
    <p className="notice" aria-live="polite">
      Loading durable snapshot…
    </p>
  );
}

export function ErrorState({ message }: { message: string }) {
  return (
    <p className="notice notice--error" role="alert">
      {message}
    </p>
  );
}

export function SnapshotTime({ value }: { value: string }) {
  return (
    <time className="snapshot-time" dateTime={value}>
      {value}
    </time>
  );
}
