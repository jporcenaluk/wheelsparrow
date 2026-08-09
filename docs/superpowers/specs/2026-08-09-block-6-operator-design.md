# Block 6 Operator Surface Design

## Scope

Block 6 exposes durable server truth to one trusted local operator. It adds Queue, Run detail,
Review, and Configuration routes, guarded scheduler controls, and notification-only SSE. Block 7
retains exact-SHA approval, merge, staging, smoke, and Done authority.

## Shape

TypeBox contracts define redacted snapshot and command payloads. Fastify routes validate origin,
per-process CSRF token, and expected revisions, then call coordinator commands; routes never write
SQLite repositories directly. Read projections omit ownership tokens, raw intents/receipts, process
IDs, credentials, and unbounded logs. SSE only tells the browser to refetch; it carries no durable
replay contract.

The React application uses declarative React Router routes and TanStack Query snapshots. React owns
only display state. EventSource invalidates active queries, and all untrusted fields render as text.
The UI provides Queue Pause, Resume, and Stop-after-current controls, but no Block 7 approval or
delivery mutation.

## Safety and evidence

Every mutation needs a same-origin request, matching CSRF token, and durable expected revision.
Malformed input is `400`, CSRF/origin rejection `403`, missing data `404`, stale/state conflicts
`409`, and unavailable capabilities `503`; all responses use versioned JSON. Tests use Fastify
injection and browser component routes; the E2E harness required by the MVP is added only when it
can exercise a production-equivalent server without weakening the coordinator boundary.
