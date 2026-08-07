import { spawn } from "node:child_process";

const STARTUP_TIMEOUT_MS = 15_000;
const SHUTDOWN_GRACE_MS = 2_000;
const MAX_CAPTURED_OUTPUT_BYTES = 64 * 1024;
const MAX_RESPONSE_BODY_BYTES = 8 * 1024;
const MAX_ASSET_BODY_BYTES = 5 * 1024 * 1024;

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

function waitFor(promise, timeoutMs, message) {
  let timeout;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timeout = setTimeout(() => reject(new Error(message)), timeoutMs);
    }),
  ]).finally(() => clearTimeout(timeout));
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

export async function productionSmoke() {
  const abortController = new AbortController();
  const deadline = setTimeout(() => {
    abortController.abort(
      new Error(`production smoke exceeded ${STARTUP_TIMEOUT_MS}ms`),
    );
  }, STARTUP_TIMEOUT_MS);
  const child = spawn(process.execPath, ["apps/server/dist/main.js"], {
    cwd: process.cwd(),
    env: { ...process.env, WHEELSPARROW_PORT: "0" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const stdout = createOutputCapture(child.stdout);
  const stderr = createOutputCapture(child.stderr);
  const { errors, exited, result } = waitForChildExit(child);

  let failure;
  let address;
  try {
    address = await waitForAddress({
      child,
      stdout,
      signal: abortController.signal,
    });
    for (const [path, expectedStatus] of [
      ["/health", "ok"],
      ["/ready", "ready"],
    ]) {
      const response = await fetch(new URL(path, address), {
        redirect: "error",
        signal: abortController.signal,
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
      signal: abortController.signal,
    });
    if (
      rootResponse.status !== 200 ||
      mediaType(rootResponse) !== "text/html"
    ) {
      throw new Error(
        `/: did not return HTTP 200 HTML: ${rootResponse.status}`,
      );
    }
    const assets = extractBuiltAssets(
      await readBoundedText("/", rootResponse),
      address,
    );
    for (const asset of assets) {
      const response = await fetch(asset.url, {
        headers: { connection: "close" },
        redirect: "error",
        signal: abortController.signal,
      });
      await assertAssetResponse(asset, response);
    }
  } catch (error) {
    failure = error;
  } finally {
    clearTimeout(deadline);
    try {
      const exit = await terminateChild(child, exited, result, errors);
      if (exit.code !== 0 || exit.signal !== null) {
        failure = combineFailures(
          failure,
          new Error(
            `server shutdown was not clean: code=${exit.code} signal=${exit.signal}`,
          ),
        );
      }
    } catch (error) {
      failure = combineFailures(failure, error);
    }
  }

  if (failure) {
    throw new Error(
      `production smoke failed: ${formatFailure(failure)}\nstdout:\n${stdout.text()}\nstderr:\n${stderr.text()}`,
      { cause: failure },
    );
  }

  console.log(`production smoke passed at ${address.origin}`);
}

if (import.meta.main) await productionSmoke();
