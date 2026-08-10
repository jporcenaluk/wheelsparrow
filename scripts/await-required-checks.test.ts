import { expect, test } from "vitest";
import {
  REQUIRED_MAIN_CHECKS,
  requiredCheckOutcome,
} from "./await-required-checks.mjs";

test("waits for all same-revision required checks and rejects a terminal failure", () => {
  const pending = REQUIRED_MAIN_CHECKS.map((name) => ({
    name,
    status: "queued",
    conclusion: null,
  }));
  expect(requiredCheckOutcome(pending)).toEqual({ kind: "pending" });

  const succeeded = REQUIRED_MAIN_CHECKS.map((name) => ({
    name,
    status: "completed",
    conclusion: "success",
  }));
  expect(requiredCheckOutcome(succeeded)).toEqual({ kind: "success" });
  expect(
    requiredCheckOutcome([
      ...succeeded.slice(0, -1),
      {
        name: REQUIRED_MAIN_CHECKS[5],
        status: "completed",
        conclusion: "failure",
      },
    ]),
  ).toEqual({ kind: "failed", names: ["security"] });
});
