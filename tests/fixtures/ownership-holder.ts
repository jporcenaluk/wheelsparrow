import { once } from "node:events";

import {
  acquireOwnership,
  OwnershipConflictError,
} from "../../apps/server/src/database/ownership.js";

const lockPath = process.argv[2];
const mode = process.argv[3] ?? "holder";
const contenderTimeoutMs = 2_000;

if (lockPath === undefined) {
  throw new Error("usage: ownership-holder.ts <lock-path> [contender]");
}

if (mode === "contender") {
  let timeout: NodeJS.Timeout | undefined;

  try {
    const ownership = await Promise.race([
      acquireOwnership(lockPath),
      new Promise<never>((_, reject) => {
        timeout = setTimeout(
          () => reject(new Error("contender ownership attempt timed out")),
          contenderTimeoutMs,
        );
      }),
    ]);
    await ownership.release();
    throw new Error("contender unexpectedly acquired ownership");
  } catch (error) {
    if (!(error instanceof OwnershipConflictError)) throw error;
    process.stdout.write("CONFLICT\n");
  } finally {
    clearTimeout(timeout);
  }
} else if (mode === "holder") {
  const ownership = await acquireOwnership(lockPath);
  process.stdout.write("READY\n");

  await once(process.stdin, "data");
  process.stdin.destroy();
  await ownership.release();
  process.stdout.write("RELEASED\n");
} else {
  throw new Error(`unknown ownership fixture mode: ${mode}`);
}
