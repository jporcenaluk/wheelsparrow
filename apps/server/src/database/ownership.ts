import { constants } from "node:fs";
import { type FileHandle, lstat, open } from "node:fs/promises";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { tryLock, unlock } = require("fs-native-extensions") as {
  tryLock(
    fileDescriptor: number,
    offset: number,
    length: number,
    options: { shared: boolean },
  ): boolean;
  unlock(fileDescriptor: number, offset: number, length: number): void;
};

export class OwnershipConflictError extends Error {
  constructor(lockPath: string) {
    super(
      `Another cooperating Wheelsparrow process holds the advisory ownership lock at ${lockPath}.`,
    );
    this.name = "OwnershipConflictError";
  }
}

export class OwnershipHandle {
  readonly #file: FileHandle;
  #released = false;

  constructor(file: FileHandle) {
    this.#file = file;
  }

  async release(): Promise<void> {
    if (this.#released) return;
    this.#released = true;

    let cleanupError: unknown;

    try {
      unlock(this.#file.fd, 0, 0);
    } catch (error) {
      cleanupError = error;
    }

    try {
      await this.#file.close();
    } catch (error) {
      cleanupError ??= error;
    }

    if (cleanupError !== undefined) throw cleanupError;
  }
}

async function rejectExistingSymbolicLink(lockPath: string): Promise<void> {
  try {
    if ((await lstat(lockPath)).isSymbolicLink()) {
      throw new Error(
        `Ownership lock path must not be a symbolic link: ${lockPath}`,
      );
    }
  } catch (error: unknown) {
    if (isMissingPathError(error)) return;
    throw error;
  }
}

function isMissingPathError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "ENOENT"
  );
}

function noFollowFlag(): number {
  return process.platform === "win32" ? 0 : constants.O_NOFOLLOW;
}

export async function acquireOwnership(
  lockPath: string,
): Promise<OwnershipHandle> {
  await rejectExistingSymbolicLink(lockPath);

  const file = await open(
    lockPath,
    constants.O_RDWR | constants.O_CREAT | noFollowFlag(),
    0o600,
  );

  try {
    const status = await file.stat();
    if (!status.isFile()) {
      throw new Error(
        `Ownership lock path must be a regular file: ${lockPath}`,
      );
    }

    await file.chmod(0o600);

    if (!tryLock(file.fd, 0, 0, { shared: false })) {
      throw new OwnershipConflictError(lockPath);
    }

    return new OwnershipHandle(file);
  } catch (error) {
    try {
      await file.close();
    } catch {
      // Preserve the original open, stat, lock, or conflict classification.
    }
    throw error;
  }
}
