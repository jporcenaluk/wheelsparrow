export interface LiveSmokeConfiguration {
  repository: string;
  projectNumber: number;
  token: string;
  endpoint: string;
}

export interface DisposableTargetReceipt {
  repository: string;
  projectNumber: number;
  projectId: string;
}

export function parseLiveSmokeConfiguration(
  environment?: NodeJS.ProcessEnv,
): LiveSmokeConfiguration;

export function verifyDisposableTarget(input: {
  configuration: LiveSmokeConfiguration;
  fetch?: typeof globalThis.fetch;
}): Promise<DisposableTargetReceipt>;
