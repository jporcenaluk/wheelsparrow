import { constants, type Stats } from "node:fs";
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

function validateLockStatus(lockPath: string, status: Stats): void {
  if (status.isSymbolicLink() || !status.isFile()) {
    throw new Error(`Ownership lock path must be a regular file: ${lockPath}`);
  }

  if (process.platform !== "win32") {
    const currentUid = process.getuid?.();
    if (currentUid !== undefined && status.uid !== currentUid) {
      throw new Error(
        `Ownership lock path is not owned by the current user: ${lockPath}`,
      );
    }
    if ((status.mode & 0o022) !== 0) {
      throw new Error(
        `Ownership lock path must not be group- or world-writable: ${lockPath}`,
      );
    }
  }
}

async function validateExistingLockTarget(lockPath: string): Promise<boolean> {
  try {
    validateLockStatus(lockPath, await lstat(lockPath));
  } catch (error: unknown) {
    if (isMissingPathError(error)) return false;
    throw error;
  }
  return true;
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
  const lockExisted = await validateExistingLockTarget(lockPath);

  const file = await open(
    lockPath,
    constants.O_RDWR | constants.O_CREAT | noFollowFlag(),
    0o600,
  );

  try {
    validateLockStatus(lockPath, await file.stat());

    if (!lockExisted && process.platform !== "win32") await file.chmod(0o600);

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
