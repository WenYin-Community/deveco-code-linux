export * as ConfigAgent from "./agent"

import { Schema } from "effect"
import { PermissionSchema } from "../permission/schema"
import { ConfigProvider } from "./provider"
import { ConfigSandbox } from "./sandbox"
import { PositiveInt } from "../schema"

export const Color = Schema.Union([
  Schema.String.check(Schema.isPattern(/^#[0-9a-fA-F]{6}$/)),
  Schema.Literals(["primary", "secondary", "accent", "success", "warning", "error", "info"]),
])

export class Info extends Schema.Class<Info>("ConfigV2.Agent")({
  model: Schema.String.pipe(Schema.optional),
  variant: Schema.String.pipe(Schema.optional),
  request: ConfigProvider.Request.pipe(Schema.optional),
  system: Schema.String.pipe(Schema.optional),
  description: Schema.String.pipe(Schema.optional),
  mode: Schema.Literals(["subagent", "primary", "all"]).pipe(Schema.optional),
  hidden: Schema.Boolean.pipe(Schema.optional),
  color: Color.pipe(Schema.optional),
  steps: PositiveInt.pipe(Schema.optional),
  disabled: Schema.Boolean.pipe(Schema.optional),
  permissions: PermissionSchema.Ruleset.pipe(Schema.optional),
  // FR-CFG-008: per-agent sandbox profile override (S-AGENT-1)
  // Agent-level sandbox.profile overrides the top-level sandbox.profile.
  // The override is treated as if declared at the agent's config layer,
  // subject to the same V-SEL-1/V-SEL-2 validation.
  sandbox: ConfigSandbox.SandboxConfig.pipe(Schema.optional).annotate({
    description: "Per-agent sandbox config override; sandbox.profile overrides top-level selection",
  }),
}) {}
