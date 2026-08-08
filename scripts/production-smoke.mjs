import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  copyFile,
  lstat,
  mkdtemp,
  readFile,
  realpath,
  rm,
} from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const STARTUP_TIMEOUT_MS = 15_000;
const OVERALL_TIMEOUT_MS = 45_000;
const SHUTDOWN_GRACE_MS = 2_000;
const MAX_CAPTURED_OUTPUT_BYTES = 64 * 1024;
const MAX_RESPONSE_BODY_BYTES = 8 * 1024;
const MAX_ASSET_BODY_BYTES = 5 * 1024 * 1024;
const FIXTURE_PREFIX = "wheelsparrow-production-smoke-";
const REQUIRED_TABLES = [
  "approvals",
  "events",
  "findings",
  "runs",
  "side_effects",
  "steps",
];

export function resolveBundleRoot(moduleDirectory = import.meta.dirname) {
  return resolve(moduleDirectory, "..");
}

export function resolveBuiltMain(bundleRoot = resolveBundleRoot()) {
  return join(bundleRoot, "apps/server/dist/main.js");
}

export function resolveFixturePrefix(temporaryDirectory = tmpdir()) {
  return join(temporaryDirectory, FIXTURE_PREFIX);
}

export function assertSafeFixturePath(temporaryDirectory, fixture) {
  if (
    !temporaryDirectory ||
    !fixture ||
    !isAbsolute(temporaryDirectory) ||
    !isAbsolute(fixture) ||
    dirname(fixture) !== temporaryDirectory ||
    !basename(fixture).startsWith(FIXTURE_PREFIX) ||
    basename(fixture) === FIXTURE_PREFIX
  ) {
    throw new Error(`unsafe production smoke fixture: ${fixture || "[empty]"}`);
  }
}

export function assertCanonicalSchemaLedger(entries, tables, checksum) {
  if (
    !entries.some(
      (entry) =>
        entry.id === 1 &&
        entry.name === "001_initial.sql" &&
        entry.checksum === checksum,
    )
  ) {
    throw new Error("database does not contain the canonical migration ledger");
  }
  const missing = REQUIRED_TABLES.filter((table) => !tables.includes(table));
  if (missing.length > 0) {
    throw new Error(
      `database is missing persisted tables: ${missing.join(", ")}`,
    );
  }
}

function createOutputCapture(stream) {
  const chunks = [];
  let capturedBytes = 0;
  let truncated = false;

  stream.on("data", (chunk) => {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    const remaining = MAX_CAPTURED_OUTPUT_BYTES - capturedBytes;
    if (remaining <= 0) {
      truncated = true;
      return;
    }
    const captured = bytes.subarray(0, remaining);
    chunks.push(captured);
    capturedBytes += captured.length;
    truncated ||= captured.length < bytes.length;
  });

  const rawText = () => Buffer.concat(chunks).toString("utf8");
  return {
    rawText,
    text: () => `${rawText()}${truncated ? "\n[output truncated]" : ""}`,
  };
}

function waitForChildExit(child) {
  let result;
  let resolveExit;
  const processErrors = [];
  const exited = new Promise((resolve) => {
    resolveExit = resolve;
  });
  child.on("error", (error) => processErrors.push(error));
  child.once("close", (code, signal) => {
    result = { code, signal };
    resolveExit(result);
  });
  return {
    errors: () => [...processErrors],
    exited,
    result: () => result,
  };
}

function waitFor(promise, timeoutMs, message, signal) {
  return new Promise((resolvePromise, rejectPromise) => {
    let timeout;
    let settled = false;
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      signal?.removeEventListener("abort", onAbort);
      callback(value);
    };
    const onAbort = () => finish(rejectPromise, signal.reason);
    if (signal?.aborted) {
      finish(rejectPromise, signal.reason);
      return;
    }
    signal?.addEventListener("abort", onAbort, { once: true });
    timeout = setTimeout(
      () => finish(rejectPromise, new Error(message)),
      timeoutMs,
    );
    promise.then(
      (value) => finish(resolvePromise, value),
      (error) => finish(rejectPromise, error),
    );
  });
}

function assertResponse(path, response, body, expectedStatus) {
  const expected = { schema_version: 1, status: expectedStatus };
  if (
    response.status !== 200 ||
    !body ||
    typeof body !== "object" ||
    Array.isArray(body) ||
    Object.keys(body).length !== Object.keys(expected).length ||
    Object.entries(expected).some(([key, value]) => body[key] !== value)
  ) {
    throw new Error(
      `${path} did not match its health contract: HTTP ${response.status} ${JSON.stringify(body)}`,
    );
  }
}

async function readBoundedText(path, response) {
  const declaredLength = Number(response.headers.get("content-length"));
  if (
    Number.isFinite(declaredLength) &&
    declaredLength > MAX_RESPONSE_BODY_BYTES
  ) {
    await response.body?.cancel();
    throw new Error(
      `${path} response exceeded ${MAX_RESPONSE_BODY_BYTES} bytes`,
    );
  }

  if (!response.body) throw new Error(`${path} response had no body`);
  const reader = response.body.getReader();
  const chunks = [];
  let totalBytes = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    totalBytes += value.byteLength;
    if (totalBytes > MAX_RESPONSE_BODY_BYTES) {
      await reader.cancel();
      throw new Error(
        `${path} response exceeded ${MAX_RESPONSE_BODY_BYTES} bytes`,
      );
    }
    chunks.push(Buffer.from(value));
  }

  return Buffer.concat(chunks, totalBytes).toString("utf8");
}

async function readBoundedJson(path, response) {
  const text = await readBoundedText(path, response);
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(`${path} did not return valid JSON`, { cause: error });
  }
}

function mediaType(response) {
  return response.headers.get("content-type")?.split(";", 1)[0]?.trim();
}

function attributeValues(tag) {
  const attributes = new Map();
  const expression =
    /(?:^|\s)([a-zA-Z][\w:-]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/g;
  for (const match of tag.matchAll(expression)) {
    attributes.set(match[1].toLowerCase(), match[2] ?? match[3] ?? match[4]);
  }
  return attributes;
}

function localAsset(reference, kind, address) {
  if (!reference?.startsWith("/assets/")) {
    throw new Error(`${kind} asset must be a local /assets/ path`);
  }

  let url;
  try {
    url = new URL(reference, address);
  } catch (error) {
    throw new Error(`${kind} asset has an invalid URL`, { cause: error });
  }
  if (
    url.origin !== address.origin ||
    url.protocol !== "http:" ||
    url.username ||
    url.password
  ) {
    throw new Error(`${kind} asset must be a local /assets/ path`);
  }
  if (url.search || url.hash) {
    throw new Error(`${kind} asset must not include a query or fragment`);
  }
  return { kind, path: url.pathname, url };
}

export function extractBuiltAssets(html, address) {
  const assets = [];
  const tagExpression = /<(script|link)\b[^>]*>/gi;
  for (const tagMatch of html.matchAll(tagExpression)) {
    const tag = tagMatch[0];
    const tagName = tagMatch[1].toLowerCase();
    const attributes = attributeValues(tag);
    if (tagName === "script" && attributes.has("src")) {
      const asset = localAsset(attributes.get("src"), "JavaScript", address);
      if (!asset.path.endsWith(".js")) {
        throw new Error("JavaScript asset must have a .js path");
      }
      assets.push(asset);
    }
    if (
      tagName === "link" &&
      attributes.get("rel")?.split(/\s+/).includes("stylesheet") &&
      attributes.has("href")
    ) {
      const asset = localAsset(attributes.get("href"), "stylesheet", address);
      if (!asset.path.endsWith(".css")) {
        throw new Error("stylesheet asset must have a .css path");
      }
      assets.push(asset);
    }
  }

  if (!assets.some((asset) => asset.kind === "JavaScript")) {
    throw new Error("built HTML is missing a JavaScript asset");
  }
  if (!assets.some((asset) => asset.kind === "stylesheet")) {
    throw new Error("built HTML is missing a stylesheet asset");
  }
  return assets;
}

export async function assertAssetResponse(asset, response) {
  if (response.status !== 200) {
    throw new Error(
      `${asset.path} did not return HTTP 200: ${response.status}`,
    );
  }
  const expectedMediaTypes =
    asset.kind === "JavaScript"
      ? new Set(["application/javascript", "text/javascript"])
      : new Set(["text/css"]);
  if (!expectedMediaTypes.has(mediaType(response))) {
    throw new Error(`${asset.path} did not return ${asset.kind} media`);
  }
  const declaredLength = Number(response.headers.get("content-length"));
  if (
    Number.isFinite(declaredLength) &&
    declaredLength > MAX_ASSET_BODY_BYTES
  ) {
    await response.body?.cancel();
    throw new Error(
      `${asset.path} response exceeded ${MAX_ASSET_BODY_BYTES} bytes`,
    );
  }
  if (!response.body) throw new Error(`${asset.path} had no body`);
  const reader = response.body.getReader();
  try {
    let totalBytes = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      totalBytes += value.byteLength;
      if (totalBytes > MAX_ASSET_BODY_BYTES) {
        await reader.cancel();
        throw new Error(
          `${asset.path} response exceeded ${MAX_ASSET_BODY_BYTES} bytes`,
        );
      }
    }
    if (!totalBytes) throw new Error(`${asset.path} had an empty body`);
  } finally {
    reader.releaseLock();
  }
}

function formatFailure(value) {
  if (value instanceof AggregateError) {
    return `${value.message}: ${value.errors.map(formatFailure).join("; ")}`;
  }
  if (value instanceof Error) return value.message;
  try {
    return JSON.stringify(value) ?? String(value);
  } catch (_error) {
    try {
      return String(value);
    } catch (_stringError) {
      return "[unprintable rejection]";
    }
  }
}

function combineFailures(primary, cleanup) {
  if (!primary) return cleanup;
  return new AggregateError(
    [primary, cleanup],
    "production smoke encountered multiple failures",
  );
}

function parseLoopbackAddress(output) {
  const match = output.match(/(?:^|\n)WHEELSPARROW_URL=([^\r\n]+)\r?\n/);
  if (!match?.[1]) return undefined;

  let address;
  try {
    address = new URL(match[1]);
  } catch (error) {
    throw new Error("server announced an invalid URL", { cause: error });
  }

  if (
    address.protocol !== "http:" ||
    address.hostname !== "127.0.0.1" ||
    address.username ||
    address.password ||
    address.pathname !== "/" ||
    address.search ||
    address.hash
  ) {
    throw new Error(`server announced a non-loopback HTTP URL: ${address}`);
  }
  return address;
}

async function waitForAddress({ child, stdout, signal }) {
  return new Promise((resolve, reject) => {
    const finish = (callback, value) => {
      child.stdout.off("data", onOutput);
      child.off("error", onError);
      child.off("exit", onExit);
      signal.removeEventListener("abort", onAbort);
      callback(value);
    };
    const onOutput = () => {
      try {
        const address = parseLoopbackAddress(stdout.rawText());
        if (address) finish(resolve, address);
      } catch (error) {
        finish(reject, error);
      }
    };
    const onError = (error) =>
      finish(
        reject,
        new Error("server process failed to start", { cause: error }),
      );
    const onExit = (code, exitSignal) =>
      finish(
        reject,
        new Error(
          `server exited before ready: code=${code} signal=${exitSignal}`,
        ),
      );
    const onAbort = () => finish(reject, signal.reason);

    child.stdout.on("data", onOutput);
    child.once("error", onError);
    child.once("exit", onExit);
    signal.addEventListener("abort", onAbort, { once: true });
    onOutput();
  });
}

async function terminateChild(child, exited, result, errors) {
  const terminationErrors = [];
  if (!result()) {
    try {
      child.kill("SIGTERM");
    } catch (error) {
      terminationErrors.push(error);
    }
  }
  try {
    await waitFor(
      exited,
      SHUTDOWN_GRACE_MS,
      "server did not exit after SIGTERM",
    );
  } catch (error) {
    terminationErrors.push(error);
  }
  if (!result()) {
    try {
      child.kill("SIGKILL");
    } catch (error) {
      terminationErrors.push(error);
    }
    try {
      await waitFor(
        exited,
        SHUTDOWN_GRACE_MS,
        "server did not exit after SIGKILL",
      );
    } catch (error) {
      terminationErrors.push(error);
    }
  }

  const childErrors = errors();
  if (!result() || terminationErrors.length > 0 || childErrors.length > 0) {
    throw new AggregateError(
      [...terminationErrors, ...childErrors],
      result()
        ? "server required forced or erroneous termination"
        : "server could not be terminated",
    );
  }
  return result();
}

function spawnService(bundleRoot, repositoryRoot, startupBarrier = false) {
  const args = startupBarrier
    ? [
        import.meta.filename,
        "--startup-barrier-child",
        bundleRoot,
        repositoryRoot,
      ]
    : [resolveBuiltMain(bundleRoot)];
  const child = spawn(process.execPath, args, {
    cwd: repositoryRoot,
    env: { ...process.env, WHEELSPARROW_PORT: "0" },
    stdio: startupBarrier
      ? ["ignore", "pipe", "pipe", "ipc"]
      : ["ignore", "pipe", "pipe"],
  });
  const messages = [];
  child.on("message", (message) => messages.push(message));
  return {
    child,
    stdout: createOutputCapture(child.stdout),
    stderr: createOutputCapture(child.stderr),
    messages,
    ...waitForChildExit(child),
  };
}

async function waitForMessage(child, messages, type, signal) {
  const received = messages.find((message) => message?.type === type);
  if (received) return received;
  return new Promise((resolve, reject) => {
    const finish = (callback, value) => {
      child.off("message", onMessage);
      child.off("exit", onExit);
      signal.removeEventListener("abort", onAbort);
      callback(value);
    };
    const onMessage = (message) => {
      if (message?.type === type) finish(resolve, message);
    };
    const onExit = (code, exitSignal) =>
      finish(
        reject,
        new Error(
          `barrier child exited before ${type}: code=${code} signal=${exitSignal}`,
        ),
      );
    const onAbort = () => finish(reject, signal.reason);
    child.on("message", onMessage);
    child.once("exit", onExit);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

async function exerciseStartupBarrier(bundleRoot, repositoryRoot, signal) {
  const service = spawnService(bundleRoot, repositoryRoot, true);
  let failure;
  try {
    await waitForMessage(
      service.child,
      service.messages,
      "MIGRATION_BARRIER",
      signal,
    );
    const signalHandled = waitForMessage(
      service.child,
      service.messages,
      "SIGNAL_HANDLED",
      signal,
    );
    service.child.kill("SIGTERM");
    await signalHandled;
    service.child.send({ type: "CONTINUE" });
    const exit = await waitFor(
      service.exited,
      SHUTDOWN_GRACE_MS,
      "barrier child did not exit after continuation",
      signal,
    );
    if (exit.code !== 0 || exit.signal !== null) {
      throw new Error(
        `barrier child shutdown was not clean: code=${exit.code} signal=${exit.signal}`,
      );
    }
  } catch (error) {
    failure = error;
  } finally {
    try {
      await terminateChild(
        service.child,
        service.exited,
        service.result,
        service.errors,
      );
    } catch (error) {
      failure = combineFailures(failure, error);
    }
  }
  if (failure) {
    throw new Error(
      `startup barrier failed: ${formatFailure(failure)}\nstdout:\n${service.stdout.text()}\nstderr:\n${service.stderr.text()}`,
      { cause: failure },
    );
  }
}

async function assertDatabaseProof(bundleRoot, databasePath) {
  const metadata = await lstat(databasePath);
  if (
    !metadata.isFile() ||
    (process.platform !== "win32" && (metadata.mode & 0o077) !== 0)
  ) {
    throw new Error(
      `SQLite database must be a private regular file: ${databasePath}`,
    );
  }
  const requireFromServer = createRequire(
    pathToFileURL(join(bundleRoot, "apps/server/package.json")),
  );
  const BetterSqlite3 = requireFromServer("better-sqlite3");
  const database = new BetterSqlite3(databasePath, { readonly: true });
  try {
    const entries = database
      .prepare("SELECT id, name, checksum FROM schema_migrations ORDER BY id")
      .all();
    const tables = database
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
      .all()
      .map(({ name }) => name);
    const checksum = createHash("sha256")
      .update(await readFile(join(bundleRoot, "migrations/001_initial.sql")))
      .digest("hex");
    assertCanonicalSchemaLedger(entries, tables, checksum);
  } finally {
    database.close();
  }
}

async function assertContenderRejected(
  bundleRoot,
  repositoryRoot,
  primary,
  signal,
) {
  const contender = spawnService(bundleRoot, repositoryRoot);
  let failure;
  try {
    const exit = await waitFor(
      contender.exited,
      STARTUP_TIMEOUT_MS,
      "ownership contender did not exit",
      signal,
    );
    if (
      parseLoopbackAddress(contender.stdout.rawText()) ||
      exit.code === 0 ||
      exit.signal !== null ||
      !/ownership lock/i.test(contender.stderr.text())
    ) {
      throw new Error(
        `ownership contender did not fail before URL announcement: code=${exit.code} signal=${exit.signal}\nstdout:\n${contender.stdout.text()}\nstderr:\n${contender.stderr.text()}`,
      );
    }
    const response = await fetch(new URL("/ready", primary), {
      redirect: "error",
      signal,
    });
    assertResponse(
      "/ready after contender",
      response,
      await readBoundedJson("/ready", response),
      "ready",
    );
  } catch (error) {
    failure = error;
  } finally {
    try {
      await terminateChild(
        contender.child,
        contender.exited,
        contender.result,
        contender.errors,
      );
    } catch (error) {
      failure = combineFailures(failure, error);
    }
  }
  if (failure) throw failure;
}

async function assertHealthyUi(address, signal) {
  for (const [path, expectedStatus] of [
    ["/health", "ok"],
    ["/ready", "ready"],
  ]) {
    const response = await fetch(new URL(path, address), {
      redirect: "error",
      signal,
    });
    assertResponse(
      path,
      response,
      await readBoundedJson(path, response),
      expectedStatus,
    );
  }

  const rootResponse = await fetch(address, {
    redirect: "error",
    signal,
  });
  if (rootResponse.status !== 200 || mediaType(rootResponse) !== "text/html") {
    throw new Error(`/: did not return HTTP 200 HTML: ${rootResponse.status}`);
  }
  const assets = extractBuiltAssets(
    await readBoundedText("/", rootResponse),
    address,
  );
  for (const asset of assets) {
    const response = await fetch(asset.url, {
      headers: { connection: "close" },
      redirect: "error",
      signal,
    });
    await assertAssetResponse(asset, response);
  }
}

async function createRepositoryFixture(bundleRoot, temporaryDirectory) {
  const root = await mkdtemp(resolveFixturePrefix(temporaryDirectory));
  try {
    await copyFile(
      join(bundleRoot, "wheelsparrow.yaml"),
      join(root, "wheelsparrow.yaml"),
    );
  } catch (error) {
    await removeFixture(temporaryDirectory, root).catch(() => undefined);
    throw error;
  }
  return root;
}

async function removeFixture(temporaryDirectory, fixture) {
  assertSafeFixturePath(temporaryDirectory, fixture);
  const canonicalTemporaryDirectory = await realpath(temporaryDirectory);
  const canonicalFixture = await realpath(fixture);
  assertSafeFixturePath(canonicalTemporaryDirectory, canonicalFixture);
  await rm(canonicalFixture, { recursive: true, force: true });
}

export async function productionSmoke() {
  const bundleRoot = resolveBundleRoot();
  const temporaryDirectory = await realpath(tmpdir());
  const fixture = await createRepositoryFixture(bundleRoot, temporaryDirectory);
  const abortController = new AbortController();
  const deadline = setTimeout(
    () =>
      abortController.abort(
        new Error(`production smoke exceeded ${OVERALL_TIMEOUT_MS}ms`),
      ),
    OVERALL_TIMEOUT_MS,
  );
  let service;
  let lastService;
  let failure;
  try {
    await exerciseStartupBarrier(bundleRoot, fixture, abortController.signal);
    service = spawnService(bundleRoot, fixture);
    lastService = service;
    const address = await waitForAddress({
      child: service.child,
      stdout: service.stdout,
      signal: abortController.signal,
    });
    await assertHealthyUi(address, abortController.signal);
    await assertDatabaseProof(
      bundleRoot,
      join(fixture, ".wheelsparrow/wheelsparrow.sqlite3"),
    );
    await assertContenderRejected(
      bundleRoot,
      fixture,
      address,
      abortController.signal,
    );
    const exit = await terminateChild(
      service.child,
      service.exited,
      service.result,
      service.errors,
    );
    service = undefined;
    if (exit.code !== 0 || exit.signal !== null)
      throw new Error(
        `server shutdown was not clean: code=${exit.code} signal=${exit.signal}`,
      );
    const successor = spawnService(bundleRoot, fixture);
    service = successor;
    lastService = service;
    const successorAddress = await waitForAddress({
      child: successor.child,
      stdout: successor.stdout,
      signal: abortController.signal,
    });
    await assertHealthyUi(successorAddress, abortController.signal);
  } catch (error) {
    failure = error;
  } finally {
    clearTimeout(deadline);
    if (service) {
      try {
        const exit = await terminateChild(
          service.child,
          service.exited,
          service.result,
          service.errors,
        );
        if (exit.code !== 0 || exit.signal !== null)
          failure = combineFailures(
            failure,
            new Error(
              `server shutdown was not clean: code=${exit.code} signal=${exit.signal}`,
            ),
          );
      } catch (error) {
        failure = combineFailures(failure, error);
      }
    }
    try {
      await removeFixture(temporaryDirectory, fixture);
    } catch (error) {
      failure = combineFailures(failure, error);
    }
  }

  if (failure) {
    throw new Error(
      `production smoke failed: ${formatFailure(failure)}${
        lastService
          ? `\nstdout:\n${lastService.stdout.text()}\nstderr:\n${lastService.stderr.text()}`
          : ""
      }`,
      { cause: failure },
    );
  }
  console.log("production smoke passed");
}

async function startupBarrierChild(bundleRoot, repositoryRoot) {
  const module = (path) => import(pathToFileURL(join(bundleRoot, path)).href);
  const [main, config, connection, migrate, ownership, app, readiness, web] =
    await Promise.all([
      module("apps/server/dist/main.js"),
      module("apps/server/dist/config.js"),
      module("apps/server/dist/database/connection.js"),
      module("apps/server/dist/database/migrate.js"),
      module("apps/server/dist/database/ownership.js"),
      module("apps/server/dist/app.js"),
      module("apps/server/dist/readiness.js"),
      module("apps/server/dist/web.js"),
    ]);
  let continueMigration;
  const barrier = new Promise((resolve) => {
    continueMigration = resolve;
  });
  process.on("message", (message) => {
    if (message?.type === "CONTINUE") continueMigration();
  });
  const listeners = new Map();
  const signalTarget = {
    once(signal, listener) {
      const byListener = listeners.get(signal) ?? new Map();
      listeners.set(signal, byListener);
      const wrapped = () => {
        byListener.delete(listener);
        process.send?.({ type: "SIGNAL_HANDLED", signal });
        const force = setTimeout(() => process.exit(1), 10_000);
        force.unref();
        void Promise.resolve(listener()).then(
          () => clearTimeout(force),
          () => {
            process.exitCode = 1;
          },
        );
      };
      byListener.set(listener, wrapped);
      process.once(signal, wrapped);
    },
    removeListener(signal, listener) {
      const wrapped = listeners.get(signal)?.get(listener);
      if (wrapped === undefined) return;
      process.removeListener(signal, wrapped);
      listeners.get(signal)?.delete(listener);
    },
  };
  try {
    await main.startService(repositoryRoot, {
      loadRuntimeConfiguration: config.loadRuntimeConfiguration,
      prepareLocalPaths: config.prepareLocalPaths,
      acquireOwnership: ownership.acquireOwnership,
      openDatabase: connection.openDatabase,
      migrateDatabase: async (database, directory) => {
        process.send?.({ type: "MIGRATION_BARRIER" });
        await barrier;
        migrate.migrateDatabase(database, directory);
      },
      buildApp: app.buildApp,
      createReadinessGate: readiness.createReadinessGate,
      announce: (url) => process.stdout.write(`WHEELSPARROW_URL=${url}\n`),
      signalTarget,
      registerWeb: web.registerWeb,
    });
  } catch (error) {
    if (error?.name !== "ShutdownRequestedError") throw error;
  }
  process.disconnect?.();
}

if (process.argv[2] === "--startup-barrier-child")
  await startupBarrierChild(process.argv[3], process.argv[4]);
else if (import.meta.main) await productionSmoke();
