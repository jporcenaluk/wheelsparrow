import { once } from "node:events";

import { acquireOwnership } from "../../apps/server/src/database/ownership.js";

const lockPath = process.argv[2];

if (lockPath === undefined) {
  throw new Error("usage: ownership-holder.ts <lock-path>");
}

const ownership = await acquireOwnership(lockPath);
process.stdout.write("READY\n");

await once(process.stdin, "data");
await ownership.release();
process.stdout.write("RELEASED\n");
