export * as BashTool from "./bash"

import path from "path"
import { ToolFailure } from "@opencode-ai/llm"
import { Duration, Effect, Layer, Schema } from "effect"
import { ChildProcess } from "effect/unstable/process"
import { Config } from "../config"
import { EventV2 } from "../event"
import { FSUtil } from "../fs-util"
import { LocationMutation } from "../location-mutation"
import { AppProcess } from "../process"
import { PermissionV2 } from "../permission"
import { Sandbox, SandboxContextService, SandboxRuntimeService } from "../sandbox"
import { PositiveInt } from "../schema"
import { Tool } from "./tool"
import { Tools } from "./tools"

export const name = "bash"
export const DEFAULT_TIMEOUT_MS = 2 * 60 * 1_000
export const MAX_TIMEOUT_MS = 10 * 60 * 1_000
export const MAX_CAPTURE_BYTES = 1024 * 1024

export const Input = Schema.Struct({
  command: Schema.String.annotate({ description: "Shell command string to execute" }),
  workdir: Schema.String.pipe(Schema.optional).annotate({
    description: "Working directory. Defaults to the active Location; relative paths resolve from that Location.",
  }),
  timeout: PositiveInt.check(Schema.isLessThanOrEqualTo(MAX_TIMEOUT_MS))
    .pipe(Schema.optional)
    .annotate({
      description: `Timeout in milliseconds. Defaults to ${DEFAULT_TIMEOUT_MS} and may not exceed ${MAX_TIMEOUT_MS}.`,
    }),
  description: Schema.String.pipe(Schema.optional).annotate({
    description: "Concise description of the command's purpose",
  }),
})

const Output = Schema.Struct({
  command: Schema.String,
  cwd: Schema.String,
  exitCode: Schema.Number.pipe(Schema.optional),
  /** Bounded compact equivalent of stdout/stderr: stderr is labeled when present. */
  output: Schema.String,
  truncated: Schema.Boolean,
  stdoutTruncated: Schema.Boolean.pipe(Schema.optional),
  stderrTruncated: Schema.Boolean.pipe(Schema.optional),
  timedOut: Schema.Boolean.pipe(Schema.optional),
  warnings: Schema.Array(Schema.String).pipe(Schema.optional),
})

type Output = typeof Output.Type

const defaultShell = () => (process.platform === "win32" ? (process.env.COMSPEC ?? "cmd.exe") : "/bin/sh")

const compactOutput = (stdout: string, stderr: string) => {
  const output = stdout && stderr ? `${stdout}\n\nstderr:\n${stderr}` : stderr ? `stderr:\n${stderr}` : stdout
  return output || "(no output)"
}

const captureNotice = (stdoutTruncated: boolean, stderrTruncated: boolean) => {
  if (stdoutTruncated && stderrTruncated) return "[stdout and stderr capture truncated at the in-memory safety limit]"
  if (stdoutTruncated) return "[stdout capture truncated at the in-memory safety limit]"
  if (stderrTruncated) return "[stderr capture truncated at the in-memory safety limit]"
  return undefined
}

const modelOutput = (output: Output) => {
  const warnings = output.warnings?.length
    ? `\n\nWarnings:\n${output.warnings.map((warning) => `- ${warning}`).join("\n")}`
    : ""
  if (output.timedOut) return `${output.output}${warnings}\n\nCommand timed out before completion.`
  return `${output.output}${warnings}\n\nCommand exited with code ${output.exitCode}.`
}

const isTimeout = (error: AppProcess.AppProcessError) =>
  error.cause instanceof Error && error.cause.message === "Timed out"

/**
 * Minimal V2 core shell boundary. Keep parity debt visible without pulling the
 * legacy shell runtime into core.
 */
// TODO: Port tree-sitter bash / PowerShell parser-based approval reduction.
// TODO: Port BashArity reusable command-prefix approvals.
// TODO: Replace token-based command-argument external-directory advisories with parser-based detection.
// TODO: Restore PowerShell and cmd-specific invocation/path handling on Windows.
// TODO: Add plugin shell.env environment augmentation once V2 plugin hooks exist.
// TODO: Add durable/live progress metadata streaming for long-running commands once V2 tool invocation progress context is wired.
// TODO: Persist background job status and define restart recovery before exposing remote observation.
// TODO: Re-add model-facing background launch only with owner-bound get/wait/cancel tools and completion delivery.
// TODO: Add HTTP background-job observation only after durable status, restart recovery, and authorization are defined.
// TODO: Revisit process-group cleanup and platform coverage with shell-specific tests if current AppProcess semantics do not fully cover it.
// TODO: Revisit binary output handling if stdout/stderr decoding is text-only.
// TODO: Stream full shell output into managed storage while retaining only a bounded in-memory preview.

const shellTokens = (command: string) => command.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g) ?? []
const unquote = (value: string) => value.replace(/^(['"])(.*)\1$/, "$2")
const externalCommandDirectories = (command: string, cwd: string) => {
  const directories = new Set<string>()
  for (const token of shellTokens(command)) {
    const value = unquote(token).replace(/[;,|&]+$/, "")
    if (!path.isAbsolute(value)) continue
    const resolved = FSUtil.resolve(value)
    if (FSUtil.contains(cwd, resolved)) continue
    directories.add(FSUtil.resolve(path.dirname(resolved)))
  }
  return [...directories]
}

export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const tools = yield* Tools.Service
    const mutation = yield* LocationMutation.Service
    const fs = yield* FSUtil.Service
    const appProcess = yield* AppProcess.Service
    const config = yield* Config.Service
    const permission = yield* PermissionV2.Service
    const sandboxCtx = yield* SandboxContextService
    const sandboxRuntime = yield* SandboxRuntimeService
    const events = yield* EventV2.Service

    yield* tools
      .register({
        [name]: Tool.make({
          description: `Execute one shell command string with the host user's filesystem, process, and network authority. The active Location is the default working directory. Relative workdir values resolve from that Location. External workdir values require external_directory approval; best-effort command-argument path warnings are advisory only. Timeout values are milliseconds (default: ${DEFAULT_TIMEOUT_MS}; maximum: ${MAX_TIMEOUT_MS}). Uses the configured shell when set; otherwise uses /bin/sh on POSIX and COMSPEC or cmd.exe on Windows.`,
          input: Input,
          output: Output,
          toModelOutput: ({ output }) => [{ type: "text", text: modelOutput(output) }],
          execute: (input, context) =>
            Effect.gen(function* () {
              const source = {
                type: "tool" as const,
                messageID: context.assistantMessageID,
                callID: context.toolCallID,
              }
              const target = yield* mutation.resolve({ path: input.workdir ?? ".", kind: "directory" })
              const external = target.externalDirectory
              if (external)
                yield* permission.assert({
                  ...LocationMutation.externalDirectoryPermission(external),
                  sessionID: context.sessionID,
                  agent: context.agent,
                  source,
                })
              const warnings = externalCommandDirectories(input.command, target.canonical).map(
                (directory) =>
                  `Command argument references external directory ${path.join(directory, "*").replaceAll("\\", "/")}. Bash runs with host-user filesystem, process, and network authority; this scan is advisory only.`,
              )
              yield* permission.assert({
                action: name,
                resources: [input.command],
                save: [input.command],
                sessionID: context.sessionID,
                agent: context.agent,
                source,
              })

              if ((yield* fs.stat(target.canonical)).type !== "Directory")
                return yield* Effect.fail(new Error(`Working directory is not a directory: ${target.canonical}`))

              const entries = yield* config.entries()
              const shell =
                Object.assign({}, ...entries.flatMap((entry) => (entry.type === "document" ? [entry.info] : [])))
                  .shell ?? defaultShell()

              // FR-CFG-012: Command-level config snapshot.
              // resolvedProfile is captured at this point and bound to this command's
              // entire lifecycle. Config changes after this point only affect subsequent
              // commands, not this one. Snapshot includes: profile_id, filesystem,
              // network_enabled, workspace_roots, is_implicit, source_layer.
              // FR-CFG-008: agent-level sandbox.profile override is applied (S-AGENT-1).
              const resolvedProfile = yield* sandboxCtx.resolve(context.agent)

              // FR-OBS-001: Publish sandbox_request_started event (sanitized).
              // Also log to application log for observability (EventV2 events don't appear in deveco.log).
              const requestId = `sbx-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
              const sandboxStartTime = Date.now()
              // Sanitized command tag: first command word, skipping env var assignments
              const commandTag = (() => {
                const tokens = input.command.trim().split(/\s+/)
                for (const token of tokens) {
                  if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(token)) continue
                  return token || "unknown"
                }
                return "unknown"
              })()
              yield* Effect.logInfo(
                `sandbox_request_started request_id=${requestId} capability=${process.platform === "darwin" ? "macos-seatbelt" : "none"} platform=${process.platform} profile=${resolvedProfile.profile_id} network=${resolvedProfile.network_enabled ? "on" : "off"} command_tag=${commandTag}`,
              )
              yield* events.publish(Sandbox.SandboxTelemetry.RequestStarted, {
                request_id: requestId,
                capability: process.platform === "darwin" ? "macos-seatbelt" : "none",
                platform: process.platform,
                profile_type: resolvedProfile.profile_id,
                network_state: resolvedProfile.network_enabled ? "on" : "off",
                timestamp: sandboxStartTime,
                command_tag: commandTag,
              }).pipe(Effect.ignore)

              // Build SandboxTargetCommand: wrap shell + command text as structured target.
              // Windows cmd.exe uses /c; POSIX shells use -c (no login flag to preserve
              // original behavior).
              const isWindowsCmd =
                process.platform === "win32" &&
                (shell.endsWith("cmd.exe") || shell === process.env.COMSPEC)
              const sandboxTarget: Sandbox.SandboxTargetCommand = {
                executable: shell,
                args: isWindowsCmd ? ["/c", input.command] : ["-c", input.command],
                cwd: target.canonical,
                env: Object.fromEntries(
                  Object.entries(process.env).filter(([, v]) => v !== undefined),
                ) as Record<string, string>,
              }

              const prepareRequest = sandboxCtx.buildRequest(resolvedProfile, sandboxTarget)

              // Probe sandbox support; on macOS, fail closed if unsupported (FR-FAIL-001).
              // FR-OBS-002: Sandbox errors publish telemetry via tapError, which runs
              // inside the generator scope where events/requestId/sandboxStartTime
              // are accessible, without affecting the error propagation.
              const { probeResult, prepared } = yield* Effect.gen(function* () {
                const probeResult = yield* sandboxRuntime.probe(prepareRequest)
                yield* Effect.logInfo(
                  `sandbox_probe_result request_id=${requestId} probe_tag=${probeResult._tag}${probeResult._tag === "Unsupported" ? ` reason=${probeResult.reason}` : ""}`,
                )
                if (probeResult._tag === "Supported") {
                  const prepared = yield* sandboxRuntime.prepare(prepareRequest)
                  yield* Effect.logInfo(
                    `sandbox_prepare_result request_id=${requestId} executable=${prepared.executable} args=${JSON.stringify(prepared.args)}`,
                  )
                  return { probeResult, prepared }
                }
                // FR-FAIL-001: Fail closed on macOS — never execute without sandbox.
                // On non-macOS, sandbox is not available, so fall back to direct execution.
                if (process.platform === "darwin") {
                  return yield* Effect.fail(
                    new Sandbox.SandboxError({
                      code: "UnsupportedPlatform",
                      phase: "Probe",
                      message: `Sandbox enforcement unavailable on macOS: ${probeResult.reason}`,
                    }),
                  )
                }
                return {
                  probeResult,
                  prepared: {
                    executable: sandboxTarget.executable,
                    args: sandboxTarget.args,
                    cwd: sandboxTarget.cwd,
                    env: sandboxTarget.env,
                  },
                }
              }).pipe(
                Effect.tapError((error) => {
                  if (error instanceof Sandbox.SandboxError) {
                    return Effect.gen(function* () {
                      yield* Effect.logInfo(
                        `sandbox_request_finished request_id=${requestId} enforcement=failed execution=failed failure_stage=${error.phase} error_type=${error.code} duration_ms=${Date.now() - sandboxStartTime}`,
                      )
                      yield* events
                        .publish(Sandbox.SandboxTelemetry.RequestFinished, {
                          request_id: requestId,
                          enforcement_result: "failed",
                          execution_result: "failed",
                          failure_stage: error.phase,
                          error_type: error.code,
                          duration_ms: Date.now() - sandboxStartTime,
                          cleanup_result: "none",
                        })
                        .pipe(Effect.ignore)
                    })
                  }
                  return Effect.void
                }),
              )

              // Spawn the PreparedCommand exactly as returned (shell=false, no re-wrapping)
              const command = ChildProcess.make(prepared.executable, prepared.args, {
                cwd: prepared.cwd,
                shell: false,
                stdin: "ignore",
                detached: process.platform !== "win32",
                forceKillAfter: Duration.seconds(3),
                env: prepared.env,
              })
              const timeout = input.timeout ?? DEFAULT_TIMEOUT_MS
              const result = yield* appProcess
                .run(command, {
                  timeout: Duration.millis(timeout),
                  maxOutputBytes: MAX_CAPTURE_BYTES,
                  maxErrorBytes: MAX_CAPTURE_BYTES,
                })
                .pipe(
                  Effect.catchTag("AppProcessError", (error) =>
                    isTimeout(error) ? Effect.succeed(undefined) : Effect.fail(error),
                  ),
                  Effect.tapError(() =>
                    Effect.gen(function* () {
                      yield* Effect.logInfo(
                        `sandbox_request_finished request_id=${requestId} enforcement=${probeResult._tag === "Supported" ? "applied" : "bypassed"} execution=failed duration_ms=${Date.now() - sandboxStartTime}`,
                      )
                      yield* events
                        .publish(Sandbox.SandboxTelemetry.RequestFinished, {
                          request_id: requestId,
                          enforcement_result: probeResult._tag === "Supported" ? "applied" : "bypassed",
                          execution_result: "failed",
                          duration_ms: Date.now() - sandboxStartTime,
                          cleanup_result: "none",
                        })
                        .pipe(Effect.ignore)
                    }),
                  ),
                )
              if (!result) {
                // FR-OBS-002: Publish finish event for timeout
                yield* Effect.logInfo(
                  `sandbox_request_finished request_id=${requestId} enforcement=${probeResult._tag === "Supported" ? "applied" : "bypassed"} execution=timeout duration_ms=${Date.now() - sandboxStartTime}`,
                )
                yield* events.publish(Sandbox.SandboxTelemetry.RequestFinished, {
                  request_id: requestId,
                  enforcement_result: probeResult._tag === "Supported" ? "applied" : "bypassed",
                  execution_result: "timeout",
                  duration_ms: Date.now() - sandboxStartTime,
                  cleanup_result: "none",
                })
                return {
                  command: input.command,
                  cwd: target.canonical,
                  exitCode: undefined,
                  output: `Command exceeded timeout of ${timeout} ms. Retry with a larger timeout if the command is expected to take longer.`,
                  truncated: false,
                  timedOut: true,
                  ...(warnings.length ? { warnings } : {}),
                }
              }

              const compact = compactOutput(result.stdout.toString("utf8"), result.stderr.toString("utf8"))
              const notice = captureNotice(result.stdoutTruncated, result.stderrTruncated)

              // FR-OBS-002: Publish sandbox_request_finished event (sanitized).
              const sandboxEndTime = Date.now()
              yield* Effect.logInfo(
                `sandbox_request_finished request_id=${requestId} enforcement=${probeResult._tag === "Supported" ? "applied" : "bypassed"} execution=${result.exitCode === 0 ? "success" : "failed"} duration_ms=${sandboxEndTime - sandboxStartTime}`,
              )
              yield* events.publish(Sandbox.SandboxTelemetry.RequestFinished, {
                request_id: requestId,
                enforcement_result: probeResult._tag === "Supported" ? "applied" : "bypassed",
                execution_result: result.exitCode === 0 ? "success" : "failed",
                duration_ms: sandboxEndTime - sandboxStartTime,
                cleanup_result: "none",
              })

              return {
                command: input.command,
                cwd: target.canonical,
                exitCode: result.exitCode,
                output: notice ? `${compact}\n\n${notice}` : compact,
                truncated: result.stdoutTruncated || result.stderrTruncated,
                ...(warnings.length ? { warnings } : {}),
                ...(result.stdoutTruncated ? { stdoutTruncated: true } : {}),
                ...(result.stderrTruncated ? { stderrTruncated: true } : {}),
              }
            }).pipe(
              Effect.mapError((error) => {
                if (error instanceof Sandbox.SandboxError) {
                  return new ToolFailure({
                    message: `Sandbox blocked command execution: [${error.code}/${error.phase}] ${error.message}`,
                  })
                }
                return new ToolFailure({
                  message: `Unable to execute command: ${input.command}: ${error instanceof Error ? error.message : String(error)}`,
                })
              }),
            ),
        }),
      })
      .pipe(Effect.orDie)
  }),
)
