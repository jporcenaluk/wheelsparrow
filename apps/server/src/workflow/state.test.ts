import { describe, expect, test } from "vitest";
import type {
  EffectKind,
  EffectStatus,
  RunState,
  WorkflowTrigger,
} from "./state.js";
import {
  assertEffectObservationTrigger,
  assertEffectTransition,
  CODING_STATES,
  canTransition,
  consumesCodingSlot,
  EFFECT_KINDS,
  EFFECT_STATUSES,
  InvalidTransitionError,
  isCodingState,
  isTerminalState,
  nextState,
  RUN_STATES,
  TERMINAL_STATES,
  WORKFLOW_TRIGGERS,
} from "./state.js";

const legalTransitions: ReadonlyArray<
  readonly [RunState, WorkflowTrigger, RunState]
> = [
  ["claiming", "todo_observed", "preparing"],
  ["claiming", "claim_rejected", "claim_failed"],
  ["claiming", "startup_failed", "rolling_back_claim"],
  ["preparing", "workspace_prepared", "intaking"],
  ["preparing", "startup_failed", "rolling_back_claim"],
  ["rolling_back_claim", "rollback_ready_observed", "claim_failed"],
  ["intaking", "intake_captured", "building"],
  ["building", "builder_succeeded", "verifying"],
  ["building", "builder_exhausted", "review"],
  ["verifying", "verification_passed", "reviewing"],
  ["verifying", "verification_failed_repairable", "repairing"],
  ["verifying", "verification_failed_exhausted", "review"],
  ["reviewing", "review_approved", "publishing"],
  ["reviewing", "review_needs_repair", "repairing"],
  ["repairing", "repair_succeeded", "verifying"],
  ["publishing", "pr_observed", "waiting_for_ci"],
  ["waiting_for_ci", "ci_passed", "review"],
  ["waiting_for_ci", "ci_failed_repairable", "repairing"],
  ["waiting_for_ci", "ci_failed_exhausted", "review"],
  ["review", "return_todo_queued", "queued_rework"],
  ["review", "return_todo_reserved", "returning_to_todo"],
  ["review", "merge_authorized", "merging"],
  ["review", "staging_retry_authorized", "waiting_for_staging"],
  ["review", "reconciled_merge", "waiting_for_staging"],
  ["review", "reconciled_staging", "smoking"],
  ["review", "reconciled_smoke", "completing"],
  ["review", "reconciled_done", "done"],
  ["queued_rework", "coding_slot_available", "returning_to_todo"],
  ["returning_to_todo", "todo_observed", "repairing"],
  ["returning_to_todo", "todo_move_rejected", "review"],
  ["merging", "merge_observed", "waiting_for_staging"],
  ["merging", "reconciled_merge", "waiting_for_staging"],
  ["merging", "delivery_failed", "review"],
  ["waiting_for_staging", "staging_succeeded", "smoking"],
  ["waiting_for_staging", "reconciled_staging", "smoking"],
  ["waiting_for_staging", "delivery_failed", "review"],
  ["smoking", "smoke_succeeded", "completing"],
  ["smoking", "reconciled_smoke", "completing"],
  ["smoking", "smoke_failed", "review"],
  ["smoking", "delivery_failed", "review"],
  ["completing", "done_observed", "done"],
  ["completing", "reconciled_done", "done"],
  ["completing", "done_projection_failed", "review"],
  ["completing", "delivery_failed", "review"],
];

const codingStates: RunState[] = [
  "claiming",
  "preparing",
  "rolling_back_claim",
  "intaking",
  "building",
  "verifying",
  "reviewing",
  "repairing",
  "publishing",
  "waiting_for_ci",
  "returning_to_todo",
];

const terminalStates: RunState[] = ["claim_failed", "done", "stopped"];

const observationRules: Record<
  EffectKind,
  Partial<Record<EffectStatus, readonly (WorkflowTrigger | null)[]>>
> = {
  project_todo: { confirmed: ["todo_observed"], failed: ["claim_rejected"] },
  project_ready: {
    confirmed: ["rollback_ready_observed"],
    failed: ["handoff_required"],
  },
  workspace_prepare: {
    confirmed: ["workspace_prepared"],
    failed: ["startup_failed"],
  },
  intake_capture: {
    confirmed: ["intake_captured"],
    failed: ["handoff_required"],
  },
  agent_build: {
    confirmed: ["builder_succeeded"],
    failed: ["builder_exhausted", "handoff_required"],
  },
  verify: {
    confirmed: ["verification_passed"],
    failed: [
      "verification_failed_repairable",
      "verification_failed_exhausted",
      "handoff_required",
    ],
  },
  agent_review: {
    confirmed: ["review_approved"],
    failed: ["review_needs_repair", "handoff_required"],
  },
  agent_repair: {
    confirmed: ["repair_succeeded"],
    failed: ["handoff_required"],
  },
  publish: { confirmed: ["pr_observed"], failed: ["handoff_required"] },
  observe_ci: {
    confirmed: ["ci_passed"],
    failed: ["ci_failed_repairable", "ci_failed_exhausted", "handoff_required"],
  },
  project_review: { confirmed: [null], failed: [null] },
  project_return_todo: {
    confirmed: ["todo_observed"],
    failed: ["todo_move_rejected"],
  },
  merge: {
    confirmed: ["merge_observed", "reconciled_merge"],
    failed: ["delivery_failed"],
  },
  observe_staging: {
    confirmed: ["staging_succeeded", "reconciled_staging"],
    failed: ["delivery_failed"],
  },
  smoke: {
    confirmed: ["smoke_succeeded", "reconciled_smoke"],
    failed: ["smoke_failed", "delivery_failed"],
  },
  project_done: {
    confirmed: ["done_observed", "reconciled_done"],
    failed: ["done_projection_failed", "delivery_failed"],
  },
};

describe("workflow state vocabulary", () => {
  test("exports exactly the canonical twenty run states", () => {
    expect(RUN_STATES).toEqual([
      "claiming",
      "preparing",
      "rolling_back_claim",
      "claim_failed",
      "intaking",
      "building",
      "verifying",
      "reviewing",
      "repairing",
      "publishing",
      "waiting_for_ci",
      "review",
      "queued_rework",
      "returning_to_todo",
      "merging",
      "waiting_for_staging",
      "smoking",
      "completing",
      "done",
      "stopped",
    ]);
    expect(new Set(RUN_STATES).size).toBe(20);
  });

  test("keeps every exported vocabulary unique and observation rules complete", () => {
    for (const vocabulary of [
      RUN_STATES,
      CODING_STATES,
      TERMINAL_STATES,
      EFFECT_KINDS,
      EFFECT_STATUSES,
      WORKFLOW_TRIGGERS,
    ]) {
      expect(new Set(vocabulary).size).toBe(vocabulary.length);
    }
    expect(Object.keys(observationRules).sort()).toEqual(
      [...EFFECT_KINDS].sort(),
    );
  });

  test("exports canonical coding and terminal metadata", () => {
    expect(CODING_STATES).toEqual(codingStates);
    expect(TERMINAL_STATES).toEqual(terminalStates);
    for (const state of RUN_STATES) {
      expect(isCodingState(state)).toBe(codingStates.includes(state));
      expect(isTerminalState(state)).toBe(terminalStates.includes(state));
    }
  });

  test("reports transition availability and coding-slot ownership", () => {
    expect(canTransition("claiming", "todo_observed")).toBe("preparing");
    expect(canTransition("review", "builder_succeeded")).toBe(false);
    expect(consumesCodingSlot("building")).toBe(true);
    expect(consumesCodingSlot("review")).toBe(false);
  });
});

describe("workflow transitions", () => {
  test.each(legalTransitions)(
    "transitions %s on %s to %s",
    (from, trigger, expected) => {
      expect(nextState(from, trigger)).toBe(expected);
    },
  );

  test("adds safe handoff from every coding state", () => {
    for (const state of codingStates)
      expect(nextState(state, "handoff_required")).toBe("review");
  });

  test("adds safe stop from every non-terminal state", () => {
    for (const state of RUN_STATES.filter(
      (value) => !terminalStates.includes(value),
    )) {
      expect(nextState(state, "stop_safe")).toBe("stopped");
    }
  });

  test("rejects every unlisted state and trigger pair", () => {
    const legal = new Set(
      legalTransitions.map(([from, trigger]) => `${from}:${trigger}`),
    );
    for (const state of RUN_STATES) {
      for (const trigger of WORKFLOW_TRIGGERS) {
        const isImplicitLegal =
          (codingStates.includes(state) && trigger === "handoff_required") ||
          (!terminalStates.includes(state) && trigger === "stop_safe");
        if (!legal.has(`${state}:${trigger}`) && !isImplicitLegal) {
          expect(() => nextState(state, trigger)).toThrowError(
            /invalid workflow transition/i,
          );
        }
      }
    }
  });

  test("rejects transitions from terminal states", () => {
    for (const state of terminalStates) {
      expect(() => nextState(state, "stop_safe")).toThrow();
    }
  });

  test("rejects inherited and unknown runtime state keys safely", () => {
    for (const state of ["constructor", "toString", "__proto__", "unknown"]) {
      const runtimeState = state as RunState;
      expect(canTransition(runtimeState, "todo_observed")).toBe(false);
      expect(() => nextState(runtimeState, "todo_observed")).toThrowError(
        InvalidTransitionError,
      );
    }
  });

  test("rejects inherited and unknown runtime trigger keys safely", () => {
    for (const trigger of ["constructor", "toString", "__proto__", "unknown"]) {
      const runtimeTrigger = trigger as WorkflowTrigger;
      expect(canTransition("claiming", runtimeTrigger)).toBe(false);
      expect(() => nextState("claiming", runtimeTrigger)).toThrowError(
        InvalidTransitionError,
      );
    }
  });
});

describe("effect transitions", () => {
  test("exports the six statuses and only allows the legal matrix", () => {
    expect(EFFECT_STATUSES).toEqual([
      "pending",
      "in_flight",
      "ambiguous",
      "confirmed",
      "failed",
      "cancelled",
    ]);
    const legal: Record<EffectStatus, readonly EffectStatus[]> = {
      pending: ["in_flight", "failed", "cancelled"],
      in_flight: ["confirmed", "failed", "ambiguous"],
      ambiguous: ["confirmed", "failed"],
      confirmed: [],
      failed: [],
      cancelled: [],
    };
    for (const from of EFFECT_STATUSES) {
      for (const to of EFFECT_STATUSES) {
        if (legal[from].includes(to))
          expect(() => assertEffectTransition(from, to)).not.toThrow();
        else expect(() => assertEffectTransition(from, to)).toThrow();
      }
    }
  });
});

describe("effect observation triggers", () => {
  test("accepts every valid status-specific observation trigger", () => {
    for (const [kind, statuses] of Object.entries(observationRules) as [
      EffectKind,
      Partial<Record<EffectStatus, readonly (WorkflowTrigger | null)[]>>,
    ][]) {
      for (const [status, triggers] of Object.entries(statuses) as [
        EffectStatus,
        readonly (WorkflowTrigger | null)[],
      ][]) {
        for (const trigger of triggers) {
          expect(() =>
            assertEffectObservationTrigger(kind, status, trigger),
          ).not.toThrow();
        }
      }
      expect(() =>
        assertEffectObservationTrigger(kind, "ambiguous", null),
      ).not.toThrow();
    }
  });

  test("rejects invalid observation statuses and triggers", () => {
    for (const [kind, statuses] of Object.entries(observationRules) as [
      EffectKind,
      Partial<Record<EffectStatus, readonly (WorkflowTrigger | null)[]>>,
    ][]) {
      for (const status of EFFECT_STATUSES) {
        const validTriggers =
          statuses[status] ?? (status === "ambiguous" ? [null] : []);
        for (const trigger of WORKFLOW_TRIGGERS) {
          if (!validTriggers.includes(trigger)) {
            expect(() =>
              assertEffectObservationTrigger(kind, status, trigger),
            ).toThrow();
          }
        }
        if (status !== "ambiguous" && validTriggers.length === 0) {
          expect(() =>
            assertEffectObservationTrigger(kind, status, null),
          ).toThrow();
        }
      }
    }
  });

  test("validates malformed kind, status, outcome, and trigger before branching", () => {
    const malformedObservations: readonly [string, string, unknown][] = [
      ["unknown", "ambiguous", null],
      ["constructor", "ambiguous", null],
      ["project_todo", "unknown", null],
      ["project_todo", "constructor", "todo_observed"],
      ["project_todo", "confirmed", "unknown"],
      ["project_todo", "confirmed", "constructor"],
      ["project_review", "confirmed", undefined],
      ["project_review", "ambiguous", undefined],
    ];
    for (const [kind, status, trigger] of malformedObservations) {
      expect(() =>
        assertEffectObservationTrigger(
          kind as EffectKind,
          status as EffectStatus,
          trigger as WorkflowTrigger | null,
        ),
      ).toThrowError(InvalidTransitionError);
    }
  });
});
