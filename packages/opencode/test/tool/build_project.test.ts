import { describe, expect, test } from "bun:test"
import {
  formatBuildProjectOutput,
  formatBuildStatusLine,
  formatStdoutStderr,
  truncateOutput,
} from "../../src/tool/lib/build-project-output"

/** Mirrors the evaluator heuristic described in the false-failure report. */
function isBuildProjectOutputSuccess(output: string) {
  return /\bBUILD SUCCESSFUL\b/i.test(output) || /\bBuild completed successfully\b/i.test(output)
}

describe("build_project output formatting", () => {
  test("formatStdoutStderr concatenates stdout then stderr and strips ansi", () => {
    expect(formatStdoutStderr("ok\x1b[32m!\x1b[0m", "warn")).toBe("ok!warn")
    expect(formatStdoutStderr("only-out", "")).toBe("only-out")
    expect(formatStdoutStderr("", "only-err")).toBe("only-err")
  })

  test("truncateOutput keeps short logs intact", () => {
    const text = "a\nb"
    expect(truncateOutput(text)).toEqual({ text, truncated: false, preview: text })
  })

  test("truncateOutput keeps last 50 lines and marks truncated", () => {
    const lines = Array.from({ length: 60 }, (_, i) => `line-${i + 1}`)
    const text = lines.join("\n")
    const result = truncateOutput(text)
    expect(result.truncated).toBe(true)
    expect(result.preview.split("\n")).toHaveLength(50)
    expect(result.preview.startsWith("line-11")).toBe(true)
    expect(result.preview.endsWith("line-60")).toBe(true)
    expect(result.text.startsWith("--- The log is too long")).toBe(true)
  })

  test("formatBuildStatusLine encodes exitCode for evaluators", () => {
    expect(formatBuildStatusLine(0)).toBe("Build completed successfully (exitCode=0)")
    expect(formatBuildStatusLine(1)).toContain("BUILD FAILED")
    expect(formatBuildStatusLine(1)).toContain("exitCode=1")
  })

  test("stderr warning flood no longer hides successful build (task-007 style)", () => {
    const stdout = [
      ...Array.from({ length: 20 }, (_, i) => `build-step-${i + 1}`),
      "> hvigor BUILD SUCCESSFUL in 12 s",
      "Build completed successfully",
    ].join("\n")
    const stderr = Array.from(
      { length: 80 },
      (_, i) =>
        `WARN: Property 'field${i}' is private and can not be initialized through the component constructor`,
    ).join("\n")

    // Old path: merge then keep last 50 → only warnings remain → false failure
    const naive = truncateOutput(formatStdoutStderr(stdout, stderr))
    expect(isBuildProjectOutputSuccess(naive.preview)).toBe(false)

    // New path: per-stream truncate + exitCode status footer
    const result = formatBuildProjectOutput({ stdout, stderr, exitCode: 0 })
    expect(result.truncated).toBe(true)
    expect(isBuildProjectOutputSuccess(result.preview)).toBe(true)
    expect(result.preview).toContain("Build completed successfully (exitCode=0)")
    expect(result.full).toContain("Build completed successfully (exitCode=0)")
  })

  test("failed build does not claim success even when truncated", () => {
    const stdout = Array.from({ length: 10 }, (_, i) => `step-${i}`).join("\n")
    const stderr = Array.from({ length: 80 }, (_, i) => `ERROR: fail-${i}`).join("\n")
    const result = formatBuildProjectOutput({ stdout, stderr, exitCode: 1 })
    expect(result.truncated).toBe(true)
    expect(isBuildProjectOutputSuccess(result.preview)).toBe(false)
    expect(result.preview).toContain("BUILD FAILED (exitCode=1)")
  })

  test("short successful build keeps full log and status line", () => {
    const result = formatBuildProjectOutput({
      stdout: "Build completed successfully\n",
      stderr: "one warning\n",
      exitCode: 0,
    })
    expect(result.truncated).toBe(false)
    expect(result.text).toContain("Build completed successfully")
    expect(result.text).toContain("one warning")
    expect(result.text.endsWith("Build completed successfully (exitCode=0)")).toBe(true)
  })
})
