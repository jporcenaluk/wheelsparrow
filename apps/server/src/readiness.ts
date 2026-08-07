export interface ReadinessGate {
  isReady(): boolean;
  markReady(): void;
  markNotReady(): void;
}

export function createReadinessGate(): ReadinessGate {
  let ready = false;

  return {
    isReady: () => ready,
    markReady: () => {
      ready = true;
    },
    markNotReady: () => {
      ready = false;
    },
  };
}
