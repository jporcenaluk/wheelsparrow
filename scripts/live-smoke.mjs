const REPOSITORY_PATTERN =
  /^[A-Za-z0-9][A-Za-z0-9_.-]*\/[A-Za-z0-9][A-Za-z0-9_.-]*$/u;

function text(value, label) {
  if (typeof value !== "string" || value.trim().length === 0)
    throw new Error(`${label} is required.`);
  return value.trim();
}

function endpoint(value) {
  const address = new URL(value ?? "https://api.github.com");
  if (
    address.protocol !== "https:" ||
    address.username ||
    address.password ||
    address.search ||
    address.hash ||
    !["api.github.com", "api.github.test"].includes(address.hostname) ||
    (address.hostname === "api.github.test" && value === undefined)
  ) {
    throw new Error("Live smoke GitHub endpoint is invalid.");
  }
  return address.toString().replace(/\/$/u, "");
}

export function parseLiveSmokeConfiguration(environment = process.env) {
  if (environment.WHEELSPARROW_LIVE_SMOKE_DISPOSABLE !== "true")
    throw new Error("Live smoke requires explicit disposable confirmation.");
  const repository = text(
    environment.WHEELSPARROW_LIVE_SMOKE_REPOSITORY,
    "Live smoke repository",
  );
  if (!REPOSITORY_PATTERN.test(repository))
    throw new Error("Live smoke repository must be owner/name.");
  if (
    environment.GITHUB_REPOSITORY !== undefined &&
    repository === environment.GITHUB_REPOSITORY
  ) {
    throw new Error("Live smoke must not target the current repository.");
  }
  const projectNumber = Number(
    text(
      environment.WHEELSPARROW_LIVE_SMOKE_PROJECT_NUMBER,
      "Live smoke project number",
    ),
  );
  if (!Number.isSafeInteger(projectNumber) || projectNumber < 1)
    throw new Error("Live smoke project number must be a positive integer.");
  const token = text(environment.GITHUB_TOKEN, "Live smoke GitHub credential");
  return {
    repository,
    projectNumber,
    token,
    endpoint: endpoint(environment.WHEELSPARROW_LIVE_SMOKE_API_ENDPOINT),
  };
}

function responseRecord(value, label) {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new Error(`${label} is invalid.`);
  return value;
}

async function readJson(response, label) {
  if (!response.ok) throw new Error(`${label} is unavailable.`);
  try {
    return responseRecord(await response.json(), label);
  } catch (error) {
    if (error instanceof Error && error.message.endsWith("is invalid."))
      throw error;
    throw new Error(`${label} is invalid.`);
  }
}

export async function verifyDisposableTarget({
  configuration,
  fetch = globalThis.fetch,
}) {
  const [owner, repository] = configuration.repository.split("/", 2);
  const headers = {
    accept: "application/vnd.github+json",
    authorization: `Bearer ${configuration.token}`,
    "user-agent": "wheelsparrow-live-smoke",
  };
  const repositoryResponse = await fetch(
    new URL(
      `repos/${encodeURIComponent(owner)}/${encodeURIComponent(repository)}`,
      `${configuration.endpoint}/`,
    ),
    { headers, signal: AbortSignal.timeout(30_000) },
  );
  const repositoryPayload = await readJson(
    repositoryResponse,
    "Live smoke repository",
  );
  if (
    repositoryPayload.full_name !== configuration.repository ||
    repositoryPayload.archived === true
  ) {
    throw new Error("Live smoke repository identity is invalid or archived.");
  }

  const projectResponse = await fetch(
    new URL("graphql", `${configuration.endpoint}/`),
    {
      method: "POST",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify({
        query: `query DisposableProject($owner: String!, $number: Int!) {
        organization(login: $owner) { projectV2(number: $number) { id number closed } }
        user(login: $owner) { projectV2(number: $number) { id number closed } }
      }`,
        variables: { owner, number: configuration.projectNumber },
      }),
      signal: AbortSignal.timeout(30_000),
    },
  );
  const projectPayload = await readJson(projectResponse, "Live smoke project");
  const data = responseRecord(projectPayload.data, "Live smoke project data");
  const candidate = data.organization ?? data.user;
  const project =
    typeof candidate === "object" &&
    candidate !== null &&
    !Array.isArray(candidate)
      ? candidate.projectV2
      : undefined;
  if (
    typeof project !== "object" ||
    project === null ||
    Array.isArray(project) ||
    typeof project.id !== "string" ||
    project.id.trim().length === 0 ||
    project.number !== configuration.projectNumber ||
    project.closed !== false
  ) {
    throw new Error("Live smoke disposable project is unavailable or closed.");
  }
  return {
    repository: configuration.repository,
    projectNumber: configuration.projectNumber,
    projectId: project.id,
  };
}

if (import.meta.main) {
  const configuration = parseLiveSmokeConfiguration();
  const result = await verifyDisposableTarget({ configuration });
  process.stdout.write(
    `${JSON.stringify({ schema_version: 1, status: "verified", ...result })}\n`,
  );
}
