import { describe, expect, test } from "vitest";

import {
  createProductionScheduler,
  type ProductionSchedulerClock,
} from "./production-scheduler.js";

function control(
  overrides: Partial<{ paused: boolean; stopAfterCurrent: boolean }> = {},
) {
  return {
    id: 1 as const,
    revision: 7,
    paused: false,
    stopAfterCurrent: false,
    updatedAt: "2026-08-10T12:00:00.000Z",
    ...overrides,
  };
}

function clock(): {
  readonly clock: ProductionSchedulerClock;
  readonly fire: (index?: number) => void;
  readonly scheduled: readonly number[];
} {
  const callbacks: Array<() => void> = [];
  const scheduled: number[] = [];
  return {
    clock: {
      now: () => "2026-08-10T12:00:00.000Z",
      setTimeout(callback, delayMs) {
        callbacks.push(callback);
        scheduled.push(delayMs);
        return callbacks.length - 1;
      },
      clearTimeout(handle) {
        callbacks[handle as number] = () => undefined;
      },
    },
    fire(index = 0) {
      callbacks[index]?.();
    },
    scheduled,
  };
}

describe("production scheduler", () => {
  test("does not claim while durably paused or stopping after current", async () => {
    const controls = [
      control({ paused: true }),
      control({ stopAfterCurrent: true }),
    ];
    let claims = 0;
    const scheduler = createProductionScheduler({
      intervalMs: 30_000,
      readControl: async () => controls.shift() ?? control(),
      claim: async () => {
        claims += 1;
      },
    });

    await scheduler.tick();
    await scheduler.tick();

    expect(claims).toBe(0);
  });

  test("coalesces overlapping ticks and uses the durable clock for claims", async () => {
    const pending: { resolve: () => void }[] = [];
    let claims = 0;
    const scheduler = createProductionScheduler({
      intervalMs: 30_000,
      readControl: async () => control(),
      claim: async (at, durableControl) => {
        expect(at).toBe("2026-08-10T12:00:00.000Z");
        expect(durableControl.revision).toBe(7);
        claims += 1;
        await new Promise<void>((resolve) => pending.push({ resolve }));
      },
      clock: clock().clock,
    });

    const first = scheduler.tick();
    const second = scheduler.tick();
    expect(second).toBe(first);
    await Promise.resolve();
    expect(claims).toBe(1);

    pending[0]?.resolve();
    await Promise.all([first, second]);
    expect(claims).toBe(1);
  });

  test("starts after reconciliation, schedules one poll, and releases the timer on stop", async () => {
    const fakeClock = clock();
    let claims = 0;
    const scheduler = createProductionScheduler({
      intervalMs: 30_000,
      readControl: async () => control(),
      claim: async () => {
        claims += 1;
      },
      clock: fakeClock.clock,
    });

    await scheduler.start();
    expect(claims).toBe(0);
    expect(fakeClock.scheduled).toEqual([0]);

    fakeClock.fire();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(claims).toBe(1);
    expect(fakeClock.scheduled).toEqual([0, 30_000]);

    await scheduler.stop();
    fakeClock.fire(1);
    await Promise.resolve();
    expect(claims).toBe(1);
  });

  test("waits for an active tick before completing shutdown", async () => {
    let resolveClaim!: () => void;
    const claim = new Promise<void>((resolve) => {
      resolveClaim = resolve;
    });
    const scheduler = createProductionScheduler({
      intervalMs: 30_000,
      readControl: async () => control(),
      claim: async () => claim,
    });

    const tick = scheduler.tick();
    let stopped = false;
    const stop = scheduler.stop().then(() => {
      stopped = true;
    });
    await Promise.resolve();
    expect(stopped).toBe(false);

    resolveClaim();
    await Promise.all([tick, stop]);
    expect(stopped).toBe(true);
  });
});
