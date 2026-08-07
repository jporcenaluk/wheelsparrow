import { describe, expect, test } from "vitest";

interface ToolchainVersions {
  node: string;
  pnpm: string;
}

const toolchainModuleUrl = new URL("./verify-toolchain.mjs", import.meta.url)
  .href;
const { evaluateToolchainVersions, parsePnpmVersion } = (await import(
  toolchainModuleUrl
)) as {
  evaluateToolchainVersions: (
    expected: ToolchainVersions,
    actual: ToolchainVersions,
  ) => { ok: boolean; diagnostics: string[] };
  parsePnpmVersion: (userAgent: string | undefined) => string;
};

const pins = { node: "24.18.0", pnpm: "11.15.1" };

describe("evaluateToolchainVersions", () => {
  test("accepts the exact repository pins", () => {
    expect(evaluateToolchainVersions(pins, pins)).toEqual({
      ok: true,
      diagnostics: [],
    });
  });

  test.each([
    [
      "Node",
      { node: "24.18.1", pnpm: "11.15.1" },
      "Node version mismatch: expected 24.18.0, received 24.18.1",
    ],
    [
      "pnpm",
      { node: "24.18.0", pnpm: "11.15.2" },
      "pnpm version mismatch: expected 11.15.1, received 11.15.2",
    ],
  ])("rejects a wrong %s patch version", (_tool, actual, diagnostic) => {
    expect(evaluateToolchainVersions(pins, actual)).toEqual({
      ok: false,
      diagnostics: [diagnostic],
    });
  });
});

describe("parsePnpmVersion", () => {
  test("reads the actual pnpm version from the invoking package manager", () => {
    expect(parsePnpmVersion("pnpm/11.15.1 npm/? node/v24.18.0 linux x64")).toBe(
      "11.15.1",
    );
  });

  test.each([undefined, "", "npm/11.15.1 node/v24.18.0", "pnpm/latest"])(
    "rejects an unavailable or non-exact pnpm user agent",
    (userAgent) => {
      expect(() => parsePnpmVersion(userAgent)).toThrow(
        "unable to determine the invoking pnpm version",
      );
    },
  );
});
