import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { type Static, Type } from "typebox";
import { Value } from "typebox/value";

const BUILDER_PROMPT = readFileSync(
  new URL("../../../../prompts/builder.md", import.meta.url),
  "utf8",
).trim();

const ISSUE_TITLE_MAX_BYTES = 1_000;
const ISSUE_BODY_MAX_BYTES = 12_000;
const SUMMARY_MAX_LENGTH = 4_000;
const VALIDATION_ENTRY_MAX_LENGTH = 1_024;
const VALIDATION_MAX_ITEMS = 32;
const REQUESTED_ACTION_MAX_LENGTH = 1_024;
const UNTRUSTED_OPEN = "<untrusted-issue-context>";
const UNTRUSTED_CLOSE = "</untrusted-issue-context>";

export interface BuilderPromptInput {
  readonly issueNumber: number;
  readonly issueTitle: string;
  readonly issueBody: string;
  readonly worktreePath: string;
  readonly baseSha: string;
}

export interface RenderedBuilderPrompt {
  readonly prompt: string;
  readonly promptHash: string;
}

const BoundedSummary = Type.String({
  minLength: 1,
  maxLength: SUMMARY_MAX_LENGTH,
});

const BoundedValidationEntry = Type.String({
  minLength: 1,
  maxLength: VALIDATION_ENTRY_MAX_LENGTH,
});

export const BuilderTerminalResultSchema = Type.Object(
  {
    outcome: Type.Union([Type.Literal("completed"), Type.Literal("blocked")]),
    summary: BoundedSummary,
    validation: Type.Array(BoundedValidationEntry, {
      maxItems: VALIDATION_MAX_ITEMS,
    }),
    requested_action: Type.Optional(
      Type.String({ minLength: 1, maxLength: REQUESTED_ACTION_MAX_LENGTH }),
    ),
  },
  { additionalProperties: false },
);

export type BuilderTerminalResult = Static<typeof BuilderTerminalResultSchema>;

function boundIssueText(value: string, maxBytes: number): string {
  const sanitized = value
    .replaceAll(UNTRUSTED_OPEN, "[opening delimiter removed]")
    .replaceAll(UNTRUSTED_CLOSE, "[closing delimiter removed]");
  const characters: string[] = [];
  let byteLength = 0;

  for (const character of sanitized) {
    const characterBytes = Buffer.byteLength(character, "utf8");
    if (byteLength + characterBytes > maxBytes) break;
    characters.push(character);
    byteLength += characterBytes;
  }

  return characters.join("");
}

export function renderBuilderPrompt(
  input: BuilderPromptInput,
): RenderedBuilderPrompt {
  const issueTitle = boundIssueText(input.issueTitle, ISSUE_TITLE_MAX_BYTES);
  const issueBody = boundIssueText(input.issueBody, ISSUE_BODY_MAX_BYTES);
  const prompt = `${BUILDER_PROMPT}

## Trusted assignment facts

- Issue number: ${input.issueNumber}
- Worktree: ${input.worktreePath}
- Base SHA: ${input.baseSha}

${UNTRUSTED_OPEN}
Issue title:
${issueTitle}

Issue body:
${issueBody}
${UNTRUSTED_CLOSE}
`;

  return {
    prompt,
    promptHash: createHash("sha256").update(prompt, "utf8").digest("hex"),
  };
}

export function parseBuilderTerminalResult(
  value: unknown,
): BuilderTerminalResult {
  let candidate: unknown = value;

  if (typeof value === "string") {
    try {
      candidate = JSON.parse(value) as unknown;
    } catch {
      throw new Error("Invalid builder terminal result");
    }
  }

  if (!Value.Check(BuilderTerminalResultSchema, candidate)) {
    throw new Error("Invalid builder terminal result");
  }

  return candidate as BuilderTerminalResult;
}
