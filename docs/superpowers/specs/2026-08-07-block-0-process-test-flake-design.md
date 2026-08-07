# Block 0: deterministic process-cleanup test

## Scope

Repair test-only flakiness in `scripts/preflight.test.ts`. The product command, its timeout value, and its public API remain unchanged. The only new interface is a narrow internal export that lets the test call the real process-group terminator.

The observed failure is a scheduling race: the `runCommand` test starts its 80 ms timeout before the fixture parent receives CPU time to write `descendant.pid`. A focused run failed once in ten attempts, while the full suite passed 126/126 with one worker. No product cleanup failure was observed.

## Design

Extract the existing POSIX process-group termination logic from `runCommand` into an internal helper in `scripts/preflight.ts`. `runCommand` continues to use that helper when its timeout fires. On Windows, preserve the current fallback cleanup path.

Add a POSIX-only fixture test that directly starts a detached parent process. The test waits for `descendant.pid` before it calls the exported terminator, then verifies that both the detached leader and its descendant have exited. Skip this process-group assertion on `win32`.

Keep a separate `runCommand` timeout test. It proves timeout reporting and command cleanup through the command API, but does not depend on fixture startup occurring inside an 80 ms timeout window.

## Data and cleanup flow

1. The fixture starts a detached parent and records the descendant PID in `descendant.pid`.
2. The test condition-waits for that file and reads both PIDs only after the fixture is ready.
3. The test invokes the extracted terminator with the parent PID.
4. On POSIX, the helper signals the parent process group, so the leader and descendant exit; the test waits for and asserts both exits.
5. The test removes temporary fixture state in `finally`, including best-effort cleanup if an assertion fails. Windows follows the existing fallback and skips the POSIX group assertion.

The helper must tolerate an already-exited process and preserve existing error handling: cleanup errors must not replace the original timeout or command failure.

## TDD verification

1. Add the deterministic failing test for direct group termination, plus the retained `runCommand` timeout test.
2. Extract the helper without changing the current termination behavior.
3. Run the focused preflight tests repeatedly and the full test suite with one worker. Confirm the direct test proves leader and descendant termination and no cleanup failure is reported.

## Files

- Modify `scripts/preflight.ts` to extract and internally export the terminator.
- Modify `scripts/preflight.test.ts` to separate timeout behavior from deterministic POSIX process-group cleanup coverage.
- Add or update only a test fixture if the existing fixture cannot write `descendant.pid` for the direct test.

## Rejected alternatives

- Readiness protocol: unnecessary product/test coordination for a test scheduling race.
- Increasing the 80 ms timeout: hides timing variance and does not prove group cleanup.
- Product behavior or public API changes: no production defect was observed.
- A Windows process-group assertion: POSIX detached process groups do not apply there; retain the existing fallback instead.

## Acceptance

- `runCommand` retains its current timeout contract and invokes the extracted terminator.
- The direct POSIX test waits for fixture readiness before termination and proves both leader and descendant exit.
- Windows cleanup behavior remains intact, with the POSIX-specific assertion skipped on `win32`.
- Focused tests are repeatable, and the single-worker full suite passes without a flaky fixture-start race.
