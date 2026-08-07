import { Refine, type Static, Type } from "typebox";

const SemanticString = Type.String({ minLength: 1, pattern: "\\S" });
const Command = Type.String({
  minLength: 1,
  maxLength: 4096,
  pattern: "\\S",
});

const LanesSchema = Refine(
  Type.Object(
    {
      ready: SemanticString,
      todo: SemanticString,
      review: SemanticString,
      done: SemanticString,
    },
    { additionalProperties: false },
  ),
  (lanes) => new Set(Object.values(lanes)).size === 4,
  () => "lane values must be pairwise distinct",
);

export const ConfigurationSchema = Type.Object(
  {
    github: Type.Object(
      {
        owner: SemanticString,
        repository: SemanticString,
        project_number: Type.Integer({ minimum: 1 }),
        status_field: SemanticString,
        lanes: LanesSchema,
        required_labels: Type.Array(SemanticString, {
          minItems: 1,
          uniqueItems: true,
        }),
        priority_field: SemanticString,
      },
      { additionalProperties: false },
    ),
    poll_interval_seconds: Type.Integer({ minimum: 5, maximum: 3600 }),
    workspace_root: SemanticString,
    agent: Type.Object(
      {
        command: SemanticString,
        model: SemanticString,
        reasoning_effort: Type.Union([
          Type.Literal("low"),
          Type.Literal("medium"),
          Type.Literal("high"),
          Type.Literal("xhigh"),
          Type.Literal("max"),
        ]),
        timeout_minutes: Type.Integer({ minimum: 1, maximum: 240 }),
      },
      { additionalProperties: false },
    ),
    verification: Type.Object(
      {
        command: Command,
      },
      { additionalProperties: false },
    ),
    staging: Type.Object(
      {
        workflow: SemanticString,
        environment: SemanticString,
        smoke_command: Command,
      },
      { additionalProperties: false },
    ),
  },
  { additionalProperties: false },
);

export type Configuration = Static<typeof ConfigurationSchema>;
