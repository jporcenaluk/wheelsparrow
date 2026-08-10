import type { SchedulerControl } from "../database/runs.js";

export interface ProductionSchedulerClock {
  now(): string;
  setTimeout(callback: () => void, delayMs: number): unknown;
  clearTimeout(handle: unknown): void;
}

export interface ProductionSchedulerOptions {
  readonly intervalMs: number;
  readonly readControl: () => Promise<SchedulerControl>;
  /** Receives the exact durable revision to condition its later claim write. */
  readonly claim: (at: string, control: SchedulerControl) => Promise<unknown>;
  readonly clock?: ProductionSchedulerClock;
  readonly onError?: (error: unknown) => void;
}

export interface ProductionScheduler {
  start(): Promise<void>;
  tick(): Promise<void>;
  stop(): Promise<void>;
}

const systemClock: ProductionSchedulerClock = {
  now: () => new Date().toISOString(),
  setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
  clearTimeout: (handle) =>
    clearTimeout(handle as ReturnType<typeof setTimeout>),
};

export function createProductionScheduler(
  options: ProductionSchedulerOptions,
): ProductionScheduler {
  if (!Number.isInteger(options.intervalMs) || options.intervalMs < 1)
    throw new RangeError("Scheduler interval must be a positive integer.");

  const clock = options.clock ?? systemClock;
  let started = false;
  let stopped = false;
  let timer: unknown;
  let activeTick: Promise<void> | undefined;

  const runTick = async (): Promise<void> => {
    const control = await options.readControl();
    if (control.paused || control.stopAfterCurrent) return;
    await options.claim(clock.now(), control);
  };

  const tick = (): Promise<void> => {
    if (stopped) return Promise.resolve();
    if (activeTick !== undefined) return activeTick;
    activeTick = runTick().finally(() => {
      activeTick = undefined;
      schedule(options.intervalMs);
    });
    return activeTick;
  };

  const schedule = (delayMs: number): void => {
    if (!started || stopped || timer !== undefined) return;
    timer = clock.setTimeout(() => {
      timer = undefined;
      void tick().catch((error: unknown) => options.onError?.(error));
    }, delayMs);
  };

  return {
    start: async () => {
      if (stopped) throw new Error("The production scheduler has stopped.");
      if (started) return;
      started = true;
      schedule(0);
    },
    tick,
    stop: async () => {
      if (stopped) return;
      stopped = true;
      started = false;
      if (timer !== undefined) {
        clock.clearTimeout(timer);
        timer = undefined;
      }
      await activeTick;
    },
  };
}
