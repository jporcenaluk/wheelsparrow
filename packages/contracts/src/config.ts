import { type Static, Type } from "typebox";

const NonEmpty = Type.String({ minLength: 1 });
const Command = Type.String({ minLength: 1, maxLength: 4096 });

export const ConfigurationSchema = Type.Object(
  {
    github: Type.Object(
      {
        owner: NonEmpty,
        repository: NonEmpty,
        project_number: Type.Integer({ minimum: 1 }),
        status_field: NonEmpty,
        lanes: Type.Object(
          {
            ready: NonEmpty,
            todo: NonEmpty,
            review: NonEmpty,
            done: NonEmpty,
          },
          { additionalProperties: false },
        ),
        required_labels: Type.Array(NonEmpty, {
          minItems: 1,
          uniqueItems: true,
        }),
        priority_field: NonEmpty,
      },
      { additionalProperties: false },
    ),
    poll_interval_seconds: Type.Integer({ minimum: 5, maximum: 3600 }),
    workspace_root: NonEmpty,
    agent: Type.Object(
      {
        command: NonEmpty,
        model: NonEmpty,
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
        workflow: NonEmpty,
        environment: NonEmpty,
        smoke_command: Command,
      },
      { additionalProperties: false },
    ),
  },
  { additionalProperties: false },
);

export type Configuration = Static<typeof ConfigurationSchema>;
