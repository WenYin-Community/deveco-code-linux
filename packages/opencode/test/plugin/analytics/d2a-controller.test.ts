import { describe, expect, test } from "bun:test"
import { spawn, spawnSync } from "node:child_process"
import { createHash } from "node:crypto"
import fs from "node:fs"
import path from "node:path"
import { tmpdir } from "../../fixture/fixture"

/**
 * D2A workflow controller regressions. These drive the REAL Node
 * controller and assert stdout/exit codes/gates plus the structured analytics
 * inside workflow-state.json; timing arithmetic itself is never re-implemented
 * here 鈥?tests pre-seed legal state timestamps and a canonical interrupted
 * gate so the controller's own computation is deterministic.
 */

const CONTROLLER = path.resolve(
  __dirname,
  "..",
  "..",
  "..",
  "resources",
  "skills",
  "hmos-design-to-arkts",
  "scripts",
  "workflow.mjs",
)

// Fixed epoch base for deterministic timestamps; never Date.now-derived.
const T0 = 1_700_000_000_000
const iso = (ms: number) => new Date(ms).toISOString()
const sha256 = (data: Buffer | string) => createHash("sha256").update(data).digest("hex")

// A parseable 1x1 PNG so the controller's readPngSize accepts the others-html
// reference frame. The exact bytes do not matter, only the IHDR dimensions.
const PNG_1X1 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
)

// Stage timestamps the causality and file-window gates accept: slightly in the
// past and away from the exact-minute boundary hand-written values get caught on.
function honestIso(msAgo = 61_000) {
  const base = Date.now() - msAgo
  return new Date(base - (base % 1000) + 123).toISOString()
}

type StateShape = {
  designSource: string
  variant: string
  currentStage: number
  completedStages: number[]
  confirmedStages?: number[]
  status: string
  workflowDigest: string
  analytics: {
    version: number
    runId: string
    revision: number
    stages: Record<
      string,
      {
        startedAtMs?: number
        completedAtMs?: number
        activeDurationMs?: number
        confirmationWaits?: Array<{ startedAtMs: number; endedAtMs?: number }>
      }
    >
    calibration?: { calibrationRounds: number; correctionRounds: number; completionReason: string }
    finalScore?: Record<string, unknown>
    taskCompletion?: Record<string, unknown>
  }
}

function runController(...args: string[]) {
  return spawnSync(process.execPath, [CONTROLLER, ...args], { encoding: "utf8" })
}

function runOk(...args: string[]) {
  const result = runController(...args)
  expect(result.status).toBe(0)
  return result.stdout
}

function statePath(dir: string) {
  return path.join(dir, "workflow-state.json")
}

function readState(dir: string) {
  return JSON.parse(fs.readFileSync(statePath(dir), "utf8")) as StateShape
}

function writeState(dir: string, state: unknown) {
  fs.writeFileSync(statePath(dir), `${JSON.stringify(state, null, 2)}\n`, "utf8")
}

function gatePath(dir: string, stage: number) {
  return path.join(dir, "stage-gates", `stage${String(stage).padStart(2, "0")}-gate.json`)
}

function writeGate(dir: string, stage: number, completedAtMs: number) {
  fs.mkdirSync(path.dirname(gatePath(dir, stage)), { recursive: true })
  fs.writeFileSync(gatePath(dir, stage), `${JSON.stringify({ stage, status: "passed", completedAt: iso(completedAtMs) })}\n`)
}

function initRun(dir: string, source: string, variant = "full") {
  runOk("--mode", "init", "--source", source, "--variant", variant, "--run-dir", dir)
  return readState(dir)
}

function writeClarification(dir: string, options: { enabled?: boolean; maxRounds?: number; source?: string } = {}) {
  const visualCalibration =
    options.enabled === false
      ? { enabled: false }
      : {
          enabled: true,
          scoreThreshold: 80,
          ...(options.maxRounds ? { maxRounds: options.maxRounds } : {}),
        }
  fs.writeFileSync(
    path.join(dir, "requirement-clarification.json"),
    `${JSON.stringify({ preCheckCompleted: true, designSource: options.source ?? "pixso", visualCalibration }, null, 2)}\n`,
  )
}

function writeDesignDoc(dir: string) {
  fs.writeFileSync(path.join(dir, "design-doc.md"), "# design doc\n\nkept content for the doc guard\n")
}

function writeRoundArtifacts(dir: string, round: number, score: number) {
  const root = path.join(dir, "visual-calibration", `round-${String(round).padStart(2, "0")}`)
  const scoreRel = `visual-calibration/round-${String(round).padStart(2, "0")}/score/score.json`
  const metricsRel = `visual-calibration/round-${String(round).padStart(2, "0")}/score/pairs/p1/metrics.json`
  fs.mkdirSync(path.dirname(path.join(dir, scoreRel)), { recursive: true })
  fs.mkdirSync(path.dirname(path.join(dir, metricsRel)), { recursive: true })
  fs.writeFileSync(path.join(dir, scoreRel), `${JSON.stringify({ aggregate: { final_baseline_score: score } })}\n`)
  fs.writeFileSync(path.join(dir, metricsRel), `${JSON.stringify({ pair: "p1" })}\n`)
  return { scoreRel, metricsRel }
}

// A valid stage-9 calibration report for the pixso Full visual stage.
function writeCalibrationReport(dir: string, rounds: Array<{ round: number; score: number }>, options: { stage?: number; completionReason?: string } = {}) {
  const stage = options.stage ?? 9
  const roundsCompleted = rounds.length
  const roundEvidence = rounds.map((entry) => {
    const { scoreRel, metricsRel } = writeRoundArtifacts(dir, entry.round, entry.score)
    return { round: entry.round, score: entry.score, scoreJson: scoreRel, metricsJson: metricsRel }
  })
  const report = {
    status: "completed",
    roundsCompleted,
    completionReason: options.completionReason ?? (rounds.at(-1)!.score >= 80 ? "score-threshold-reached" : "max-rounds-reached"),
    rounds: roundEvidence,
    capabilityInvocations: [
      { capability: "hmos-d2a-arkui-scoring-workflow", status: "completed" },
      ...rounds.map((entry) => ({ capability: "hmos-d2a-ui-reconstruction-score", round: entry.round, status: "completed" })),
    ],
    checks: [
      { name: "hmos-d2a-ui-reconstruction-score-invoked", result: true },
      { name: "score-artifacts-present", result: true },
      { name: "no-direct-compare-images-bypass", result: true },
      { name: "calibration-completed", result: true },
    ],
  }
  fs.writeFileSync(path.join(dir, `stage${stage}-visual-calibration-report.json`), `${JSON.stringify(report, null, 2)}\n`)
  return report
}

function writeSkippedCalibrationReport(dir: string, stage = 9) {
  fs.writeFileSync(
    path.join(dir, `stage${stage}-visual-calibration-report.json`),
    `${JSON.stringify({ status: "skipped", reason: "visualCalibration.disabled", roundsCompleted: 0 }, null, 2)}\n`,
  )
}

// Pre-seeds a run at currentStage with the given completed stages: their
// gates and the shared evidence every completed-stage check needs.
function preseedStages(dir: string, completed: number[]) {
  for (const stage of completed) writeGate(dir, stage, T0 + stage * 1000)
  const state = readState(dir)
  writeState(dir, { ...state, completedStages: completed, currentStage: completed.length + 1 })
}

function writeJson(dir: string, relativePath: string, value: unknown) {
  const target = path.join(dir, ...relativePath.split("/"))
  fs.mkdirSync(path.dirname(target), { recursive: true })
  fs.writeFileSync(target, `${JSON.stringify(value, null, 2)}\n`)
}

function writeFinalScore(dir: string, value: unknown) {
  writeJson(dir, "final-visual-score.json", value)
}

function writeUnavailableFinalScore(dir: string, reason?: string) {
  writeFinalScore(dir, reason === undefined ? { status: "unavailable" } : { status: "unavailable", reason })
}

// The delivery_check evidence set the summary stage saves for the current page,
// plus the artifact that points at it.
function writeDeliveryCheck(dir: string, score: number) {
  const finalDelivery = path.join(dir, "visual-calibration", "final-delivery")
  fs.mkdirSync(finalDelivery, { recursive: true })
  writeJson(dir, "visual-calibration/final-delivery/score.json", { aggregate: { final_baseline_score: score } })
  fs.writeFileSync(path.join(finalDelivery, "candidate.png"), "png")
  fs.writeFileSync(path.join(finalDelivery, "build-log.md"), "build")
  fs.writeFileSync(path.join(finalDelivery, "deployment-log.md"), "deploy")
  writeFinalScore(dir, {
    status: "recorded",
    source: "delivery_check",
    scoreJson: "visual-calibration/final-delivery/score.json",
    metricsJson: "visual-calibration/final-delivery/score.json",
    candidate: "visual-calibration/final-delivery/candidate.png",
    buildLog: "visual-calibration/final-delivery/build-log.md",
    deploymentLog: "visual-calibration/final-delivery/deployment-log.md",
  })
}

// A pixso Full run whose last stage is 10, sitting on a completed stage-9
// calibration: the state a final submission starts from.
function seedPixsoFinalRun(dir: string, rounds: Array<{ round: number; score: number }> = [{ round: 1, score: 82 }]) {
  initRun(dir, "pixso")
  writeClarification(dir, { maxRounds: Math.max(rounds.length, 1) })
  writeDesignDoc(dir)
  writeCalibrationReport(dir, rounds)
  preseedStages(dir, [1, 2, 3, 4, 5, 6, 7, 8])
  runOk("--mode", "stage-complete", "--run-dir", dir, "--stage", "9", "--result", "passed")
}

// The refusal contract: a correctable error naming the artifact the model has
// to record, plus the exact submission to retry.
function expectFinalScoreRefusal(dir: string, result: ReturnType<typeof runController>, reason: string) {
  expect(result.status).toBe(1)
  const payload = JSON.parse(result.stdout)
  expect(payload.error).toBe("final_score_evidence_required")
  expect(payload.reason).toBe(reason)
  expect(payload.artifactPath).toBe(path.join(dir, "final-visual-score.json"))
  expect(payload.retry).toEqual({ mode: "stage-complete", stage: payload.stage, result: "passed" })
  return payload
}

// Everything a refused submission must leave untouched: the state file itself
// and the Gate of the stage being submitted.
function snapshotSubmission(dir: string, stage: number) {
  const gate = gatePath(dir, stage)
  return {
    state: fs.readFileSync(statePath(dir), "utf8"),
    gate: fs.existsSync(gate) ? fs.readFileSync(gate, "utf8") : null,
  }
}

// Freezes the stage-2 confirmation snapshot the page-style sources require:
// every confirmed file is hashed at its canonical path, exactly like the
// controller's own snapshot builder would.
function writeStage2ConfirmationSnapshot(dir: string, files: Array<[string, string]>) {
  const state = readState(dir)
  writeState(dir, {
    ...state,
    confirmationSnapshots: {
      "2": {
        stage: 2,
        createdAt: honestIso(),
        files: Object.fromEntries(
          files.map(([name, relativePath]) => [
            name,
            { path: relativePath, sha256: sha256(fs.readFileSync(path.join(dir, ...relativePath.split("/")))) },
          ]),
        ),
      },
    },
  })
}

// A one-round stage-5 calibration report that satisfies both the shared
// score criterion and the others-source scoring-integrity gates: the candidate
// screenshot sits at its canonical path with a matching hash, the score
// document's pairs point at the canonical candidate and reference, and the
// reported score equals the score.json aggregate.
function writeOthersCalibration(dir: string, source: "others-html" | "others-visual") {
  const reference =
    source === "others-html" ? "source/html/reference/reference-00.png" : "source/visual/screenshot.png"
  const candidateRel = "visual-calibration/round-01/candidate.png"
  const scoreRel = "visual-calibration/round-01/score/score.json"
  const metricsRel = "visual-calibration/round-01/score/pairs/p1/metrics.json"
  const candidateBytes = Buffer.from("round-01 candidate screenshot bytes")
  fs.mkdirSync(path.dirname(path.join(dir, ...candidateRel.split("/"))), { recursive: true })
  fs.writeFileSync(path.join(dir, ...candidateRel.split("/")), candidateBytes)
  writeJson(dir, scoreRel, {
    aggregate: { final_baseline_score: 82 },
    pairs: [{ candidate: candidateRel, reference }],
  })
  writeJson(dir, metricsRel, { pair: "p1" })
  writeJson(dir, "stage5-visual-calibration-report.json", {
    status: "completed",
    roundsCompleted: 1,
    completionReason: "score-threshold-reached",
    rounds: [
      {
        round: 1,
        score: 82,
        scoreJson: scoreRel,
        metricsJson: metricsRel,
        candidate: { path: candidateRel, sha256: sha256(candidateBytes) },
      },
    ],
    capabilityInvocations: [
      { capability: "hmos-d2a-arkui-scoring-workflow", status: "completed" },
      { capability: "hmos-d2a-ui-reconstruction-score", round: 1, status: "completed" },
    ],
    checks: [
      { name: "hmos-d2a-ui-reconstruction-score-invoked", result: true },
      { name: "score-artifacts-present", result: true },
      { name: "no-direct-compare-images-bypass", result: true },
      { name: "calibration-completed", result: true },
    ],
  })
}

// Seeds an others-html run through its own stage 1-4 gates: manifest, frozen
// HTML input with a real PNG reference frame, layout facts, visual spec, the
// stage-2 conversion manifest and build report, the stage-3/4 deliverables and
// the capability ledger. The integration snapshot is deliberately absent so
// the project-side reconciliation stays out of scope; calibration is added for
// enabled Full runs.
function seedOthersHtmlRun(dir: string, options: { variant?: "full" | "fast"; calibration?: "enabled" | "skipped" } = {}) {
  const variant = options.variant ?? "full"
  const calibration = variant === "full" ? (options.calibration ?? "enabled") : "none"
  initRun(dir, "others-html", variant)
  writeClarification(dir, { source: "others-html", ...(calibration === "skipped" ? { enabled: false } : {}) })
  fs.mkdirSync(path.join(dir, "source", "html", "reference"), { recursive: true })
  fs.writeFileSync(path.join(dir, "source", "html", "input.html"), "<html><body><div>hello</div></body></html>")
  const inputSha = sha256(fs.readFileSync(path.join(dir, "source", "html", "input.html")))
  fs.writeFileSync(path.join(dir, "source", "html", "reference", "reference-00.png"), PNG_1X1)
  fs.writeFileSync(path.join(dir, "source", "html", "reference", "reference-full.png"), "stitched reference frames")
  writeJson(dir, "inputs-manifest.json", {
    designSource: "others-html",
    htmlSource: { path: "source/html/input.html", sha256: inputSha },
    layoutFactsPath: "stage1/layout-facts.json",
    visualSpecPath: "stage1/visual-spec.json",
    referenceSet: {
      dir: "source/html/reference",
      frames: ["reference-00.png"],
      contentFull: "reference-full.png",
      content: { frames: 1 },
      deviceScaleFactor: 1,
      logicalCanvas: { width: 1, height: 1 },
    },
  })
  writeJson(dir, "stage1/layout-facts.json", {
    schemaVersion: 1,
    designSource: "others-html",
    source: { path: "source/html/input.html", sha256: inputSha },
    render: {
      deviceScaleFactor: 1,
      canvas: { logicalWidth: 1, logicalHeight: 1, physicalWidth: 1, physicalHeight: 1 },
      content: { coverage: 1, extentPx: 1, visibleCoverage: 1, frames: 1 },
      statusBarVp: 0,
      gestureBarVp: 0,
    },
    nodes: [{ nodeId: "n1", rect: { x: 0, y: 0, w: 1, h: 1 }, text: "hello" }],
    systemUi: [],
    uncertainties: [],
  })
  writeJson(dir, "stage1/visual-spec.json", {
    schemaVersion: 1,
    designSource: "others-html",
    canvasIncludesSystemBar: false,
    roles: [],
    systemUi: [],
    notImplemented: [],
    unknowns: ["none"],
  })
  writeJson(dir, "stage1/source-freeze.json", {
    producer: "html_source_freeze",
    input: "source/html/input.html",
    sha256: inputSha,
    resources: { total: 1, missing: 0 },
  })
  writeJson(dir, "stage2/generated-ui-manifest.json", {
    page: { file: "entry/src/main/ets/pages/HtmlPage.ets", component: "HtmlPage", hasEntry: false },
    registration: {
      mode: "existing-router",
      route: "html_page",
      file: "route/map.json",
      default: false,
      component: "HtmlPage",
    },
    startup: { entryAbilityPage: "pages/Index", mainPagesContainsIndex: true },
    reachability: "entry-point-exists",
  })
  writeJson(dir, "stage2/initial-build-report.json", {
    success: true,
    command: "hvigorw assembleHap",
    exitCode: 0,
    completedAt: honestIso(),
  })
  fs.writeFileSync(path.join(dir, "stage3-interaction-report.md"), "interaction report\n")
  writeJson(dir, "hds-decision.json", { hdsRequired: false })
  writeJson(dir, "stage4/quality-audit.json", {
    criticalIssues: [],
    majorIssues: [],
    audits: {
      structureAndValues: { pass: true },
      hds: { pass: true },
      systemUi: { pass: true },
      safeArea: { pass: true },
      topCollision: { pass: true },
      resources: { pass: true },
      routing: { pass: true },
      codeQuality: { pass: true },
    },
    buildResult: { exitCode: 0, command: "hvigorw assembleHap" },
  })
  fs.writeFileSync(path.join(dir, "stage4/build-report.md"), "build report\n")
  fs.writeFileSync(path.join(dir, "design-doc.md"), "# design doc\n")
  fs.writeFileSync(path.join(dir, "component-tree.md"), "- n1 Button\n")
  writeJson(dir, "input-security-report.json", { schemaVersion: 1, status: "clean" })
  fs.writeFileSync(path.join(dir, "stage2", "component-analysis.md"), "component analysis\n")
  // Only the Full variant confirms stage 2; the fast catalog has no
  // confirmation stage and rejects a stage-2 snapshot.
  if (variant === "full") {
    writeStage2ConfirmationSnapshot(dir, [
      ["componentAnalysis", "stage2/component-analysis.md"],
      ["componentTree", "component-tree.md"],
      ["designDoc", "design-doc.md"],
      ["visualSpec", "stage1/visual-spec.json"],
      ["layoutFacts", "stage1/layout-facts.json"],
    ])
  }
  const baseCapabilities = [
    { capability: "hmos-d2a-html-to-arkui", status: "completed" },
    { capability: "hmos-d2a-solution-design", status: "completed" },
    { capability: "hmos-d2a-arkts-logic-completer", status: "completed" },
  ]
  if (calibration === "enabled") {
    writeOthersCalibration(dir, "others-html")
    writeJson(dir, "capability-invocation-ledger.json", [
      ...baseCapabilities,
      { capability: "hmos-d2a-arkui-scoring-workflow", status: "completed" },
      { capability: "hmos-d2a-ui-reconstruction-score", round: 1, status: "completed" },
    ])
  } else {
    if (calibration === "skipped") writeSkippedCalibrationReport(dir, 5)
    writeJson(dir, "capability-invocation-ledger.json", baseCapabilities)
  }
  preseedStages(dir, [1, 2, 3, 4])
}

// Seeds an others-visual run through its own stage 1-4 gates: the screenshot
// plus its manifest/probe/recognition evidence, a visual spec that matches the
// probe measurement, a mini ArkUI project the stage-2 reconciliation reads,
// the design-doc guard, and a one-round stage-5 calibration.
function seedOthersVisualRun(dir: string) {
  initRun(dir, "others-visual")
  writeClarification(dir, { source: "others-visual" })
  const screenshotBytes = Buffer.from("visual screenshot bytes")
  fs.mkdirSync(path.join(dir, "source", "visual"), { recursive: true })
  fs.writeFileSync(path.join(dir, "source", "visual", "screenshot.png"), screenshotBytes)
  const screenshotSha = sha256(screenshotBytes)
  const projectRoot = path.join(dir, "project")
  fs.mkdirSync(path.join(projectRoot, "entry", "src", "main", "ets", "pages"), { recursive: true })
  fs.mkdirSync(path.join(projectRoot, "entry", "src", "main", "ets", "entryability"), { recursive: true })
  fs.writeFileSync(
    path.join(projectRoot, "entry", "src", "main", "ets", "pages", "VisualPage.ets"),
    "@Component\nexport struct VisualPage {\n  build() {}\n}\n",
  )
  fs.writeFileSync(
    path.join(projectRoot, "entry", "src", "main", "main_pages.json"),
    `${JSON.stringify({ src: ["pages/Index"] }, null, 2)}\n`,
  )
  fs.writeFileSync(
    path.join(projectRoot, "entry", "src", "main", "ets", "entryability", "EntryAbility.ets"),
    "export default class EntryAbility {\n  onWindowStageCreate(windowStage) {\n    windowStage.loadContent('pages/Index', () => {})\n  }\n}\n",
  )
  writeJson(dir, "inputs-manifest.json", {
    designSource: "others-visual",
    screenshot: {
      path: "source/visual/screenshot.png",
      width: 200,
      height: 400,
      size: screenshotBytes.length,
      sha256: screenshotSha,
    },
    canvas: { logicalWidth: 100, logicalHeight: 200, scale: 2 },
    visualSpecPath: "stage1/visual-spec.json",
    visualProbePath: "stage1/visual-probe.json",
    integrationSnapshot: {
      projectRootPath: projectRoot,
      mainPagesFile: "entry/src/main/main_pages.json",
      entryAbilityFile: "entry/src/main/ets/entryability/EntryAbility.ets",
    },
  })
  writeJson(dir, "stage1/visual-probe.json", {
    schemaVersion: 1,
    producer: { tool: "visual_probe", version: "test" },
    source: { path: "source/visual/screenshot.png", sha256: screenshotSha },
    canvas: { physicalWidth: 200, physicalHeight: 400, logicalWidth: 100, logicalHeight: 200, scale: 2 },
    budget: { withinBudget: true, totalSamples: 40, passes: 1 },
    background: { kind: "solid", stops: [{ color: "#112233" }] },
    bands: [
      { y0: 0, y1: 200, heightRatio: 0.5 },
      { y0: 200, y1: 400, heightRatio: 0.5 },
    ],
  })
  writeJson(dir, "stage1/component-vision-analysis.json", {
    schemaVersion: 2,
    status: "ok",
    producer: { tool: "recognize_ui_components", model: "test-model", invocationId: "inv-others-visual-1", createdAt: honestIso() },
    inputs: {
      image: { path: "source/visual/screenshot.png", sha256: screenshotSha },
      requirements: { text: "build the visual page", sha256: sha256("build the visual page") },
    },
    analysis: {
      canvas: { width: 200, height: 400 },
      visible_components: [
        {
          id: "c1",
          name: "Button",
          visual_evidence: "rounded rectangle with a text label",
          component_candidates: [{ name: "Button", confidence: 0.9, reason: "shape and label" }],
        },
      ],
      global_observations: ["one visible component"],
      uncertainties: [],
    },
  })
  writeJson(dir, "stage1/visual-spec.json", {
    schemaVersion: 1,
    designSource: "others-visual",
    canvas: { logicalWidth: 100, logicalHeight: 200, scale: 2 },
    background: { kind: "solid", value: "#112233 background" },
    palette: [{ role: "primary", evidence: "probe background colour", color: "#112233" }],
    typography: [{ role: "title", evidence: "recognition hint, size unmeasured", color: "#112233", sizePx: "unknown" }],
    uncertainties: ["none"],
    bands: [{ heightRatio: 0.5 }, { heightRatio: 0.5 }],
  })
  writeJson(dir, "stage2/generated-ui-manifest.json", {
    page: { file: "entry/src/main/ets/pages/VisualPage.ets", component: "VisualPage", hasEntry: false },
    registration: { component: "VisualPage", route: "visual_page", file: "route/map.json", mode: "existing-router" },
    startup: { entryAbilityPage: "pages/Index", mainPagesContainsIndex: true },
  })
  writeJson(dir, "stage2/initial-build-report.json", {
    success: true,
    command: "hvigorw assembleHap",
    exitCode: 0,
    completedAt: honestIso(2_000),
  })
  fs.writeFileSync(path.join(dir, "design-doc.md"), "# design doc\n")
  fs.writeFileSync(path.join(dir, "stage2", "component-analysis.md"), "component analysis\n")
  fs.writeFileSync(path.join(dir, "component-tree.md"), "- c1 Button\n")
  writeStage2ConfirmationSnapshot(dir, [
    ["componentVisionAnalysis", "stage1/component-vision-analysis.json"],
    ["visualProbe", "stage1/visual-probe.json"],
    ["visualSpec", "stage1/visual-spec.json"],
    ["componentAnalysis", "stage2/component-analysis.md"],
    ["componentTree", "component-tree.md"],
    ["designDoc", "design-doc.md"],
  ])
  writeOthersCalibration(dir, "others-visual")
  preseedStages(dir, [1, 2, 3, 4])
}

describe("d2a workflow controller analytics", () => {
  test("init assigns a fresh analytics runId per source and variant", async () => {
    await using tmp = await tmpdir()
    const seen = new Set<string>()
    for (const source of ["pixso", "figma", "mastergo", "lanhu", "others-html", "others-visual"]) {
      for (const variant of ["full", "fast"]) {
        const dir = path.join(tmp.path, `${source}-${variant}`)
        const state = initRun(dir, source, variant)
        expect(state.designSource).toBe(source)
        expect(state.variant).toBe(variant)
        expect(state.currentStage).toBe(1)
        expect(state.completedStages).toEqual([])
        expect(state.analytics).toEqual({ version: 1, runId: expect.any(String), revision: 1, stages: {} })
        expect(seen.has(state.analytics.runId)).toBe(false)
        seen.add(state.analytics.runId)
      }
    }
  })

  test("net duration 50000: 30s before, 300s confirmation wait, 20s after", async () => {
    await using tmp = await tmpdir()
    const dir = path.join(tmp.path, "run")
    initRun(dir, "pixso")
    writeClarification(dir)
    // An interrupted stage-complete wrote the canonical gate but never advanced
    // the state; replaying keeps the gate completedAt, making timing exact.
    writeGate(dir, 1, T0 + 350_000)
    const state = readState(dir)
    writeState(dir, {
      ...state,
      analytics: {
        ...state.analytics,
        stages: {
          "1": { startedAtMs: T0, confirmationWaits: [{ startedAtMs: T0 + 30_000, endedAtMs: T0 + 330_000 }] },
        },
      },
    })

    const out = runOk("--mode", "stage-complete", "--run-dir", dir, "--stage", "1", "--result", "passed")
    expect(JSON.parse(out)).toMatchObject({ status: "running", currentStage: 2 })
    const after = readState(dir)
    expect(after.completedStages).toEqual([1])
    expect(after.analytics.revision).toBe(2)
    expect(after.analytics.stages["1"].startedAtMs).toBe(T0)
    expect(after.analytics.stages["1"].completedAtMs).toBe(T0 + 350_000)
    expect(after.analytics.stages["1"].activeDurationMs).toBe(50_000)
  })

  test("two revision waits and duplicate stage-start subtract once and keep the original start", async () => {
    await using tmp = await tmpdir()
    const dir = path.join(tmp.path, "run")
    initRun(dir, "pixso")
    writeClarification(dir)
    runOk("--mode", "stage-start", "--run-dir", dir, "--stage", "1")
    const firstStart = readState(dir)
    expect(firstStart.analytics.revision).toBe(2)
    expect(firstStart.analytics.stages["1"].startedAtMs).toBeGreaterThan(0)
    // Duplicate entry keeps the original timestamp and the revision.
    runOk("--mode", "stage-start", "--run-dir", dir, "--stage", "1")
    expect(readState(dir).analytics.revision).toBe(2)

    writeGate(dir, 1, T0 + 400_000)
    const state = readState(dir)
    writeState(dir, {
      ...state,
      analytics: {
        ...state.analytics,
        stages: {
          "1": {
            startedAtMs: T0,
            confirmationWaits: [
              { startedAtMs: T0 + 30_000, endedAtMs: T0 + 330_000 },
              { startedAtMs: T0 + 340_000, endedAtMs: T0 + 360_000 },
            ],
          },
        },
      },
    })
    runOk("--mode", "stage-complete", "--run-dir", dir, "--stage", "1", "--result", "passed")
    const after = readState(dir)
    expect(after.analytics.revision).toBe(3)
    expect(after.analytics.stages["1"].activeDurationMs).toBe(400_000 - 320_000)
  })

  test("legacy state without analytics is adopted at the first mutation and omits missing timings", async () => {
    await using tmp = await tmpdir()
    const dir = path.join(tmp.path, "run")
    initRun(dir, "pixso")
    writeClarification(dir)
    writeGate(dir, 1, T0 + 100_000)
    const state = readState(dir)
    const { analytics: _legacy, ...legacyState } = state
    writeState(dir, legacyState)

    runOk("--mode", "stage-complete", "--run-dir", dir, "--stage", "1", "--result", "passed")
    const after = readState(dir)
    expect(after.completedStages).toEqual([1])
    // The old run adopts a fresh identity at its first compatible change.
    expect(after.analytics.version).toBe(1)
    expect(after.analytics.runId).toEqual(expect.any(String))
    expect(after.analytics.revision).toBe(1)
    // The stage started before adoption, so its duration is omitted but the
    // completion time is recorded.
    expect(after.analytics.stages["1"].completedAtMs).toBe(T0 + 100_000)
    expect(after.analytics.stages["1"].startedAtMs).toBeUndefined()
    expect(after.analytics.stages["1"].activeDurationMs).toBeUndefined()
  })

  test("reversed timestamps omit activeDurationMs and keep the business result", async () => {
    await using tmp = await tmpdir()
    const dir = path.join(tmp.path, "run")
    initRun(dir, "pixso")
    writeClarification(dir)
    writeGate(dir, 1, T0 + 100_000)
    const state = readState(dir)
    writeState(dir, {
      ...state,
      analytics: { ...state.analytics, stages: { "1": { startedAtMs: T0 + 200_000 } } },
    })
    const out = runOk("--mode", "stage-complete", "--run-dir", dir, "--stage", "1", "--result", "passed")
    expect(JSON.parse(out).status).toBe("running")
    const after = readState(dir)
    expect(after.analytics.stages["1"].activeDurationMs).toBeUndefined()
  })

  test("digest mismatch keeps the original error behaviour", async () => {
    await using tmp = await tmpdir()
    const dir = path.join(tmp.path, "run")
    initRun(dir, "pixso")
    const state = readState(dir)
    writeState(dir, { ...state, workflowDigest: "sha256:tampered" })
    const result = runController("--mode", "status", "--run-dir", dir)
    expect(result.status).toBe(1)
    expect(JSON.parse(result.stdout).error).toBe("workflow_digest_mismatch")
  })

  test("confirm request/revision-requested/accepted open and close waits", async () => {
    await using tmp = await tmpdir()
    const dir = path.join(tmp.path, "run")
    initRun(dir, "pixso")
    writeClarification(dir)
    writeDesignDoc(dir)
    preseedStages(dir, [1, 2, 3, 4])
    const baseRevision = readState(dir).analytics.revision

    runOk("--mode", "confirm", "--run-dir", dir, "--stage", "5", "--decision", "request")
    const requested = readState(dir)
    expect(requested.status).toBe("awaiting_confirmation")
    expect(requested.analytics.revision).toBe(baseRevision + 1)
    expect(requested.analytics.stages["5"]!.confirmationWaits).toEqual([{ startedAtMs: expect.any(Number) }])
    const firstWaitStart = requested.analytics.stages["5"]!.confirmationWaits![0].startedAtMs

    runOk("--mode", "confirm", "--run-dir", dir, "--stage", "5", "--decision", "revision-requested")
    const revised = readState(dir)
    expect(revised.status).toBe("running")
    expect(revised.analytics.revision).toBe(baseRevision + 2)
    expect(revised.analytics.stages["5"]!.confirmationWaits![0]).toEqual({
      startedAtMs: firstWaitStart,
      endedAtMs: expect.any(Number),
    })

    // A revision request re-opens a second wait for the same stage.
    runOk("--mode", "confirm", "--run-dir", dir, "--stage", "5", "--decision", "request")
    runOk("--mode", "confirm", "--run-dir", dir, "--stage", "5", "--decision", "accepted")
    const accepted = readState(dir)
    expect(accepted.status).toBe("running")
    expect(accepted.confirmedStages).toContain(5)
    expect(accepted.analytics.revision).toBe(baseRevision + 4)
    const waits = accepted.analytics.stages["5"]!.confirmationWaits!
    expect(waits).toHaveLength(2)
    for (const wait of waits) {
      expect(wait.endedAtMs).toBeGreaterThanOrEqual(wait.startedAtMs)
    }
    expect(waits[1].startedAtMs).toBeGreaterThanOrEqual(waits[0].endedAtMs!)
  })

  test("stage-complete blocked bumps the revision without completing timing", async () => {
    await using tmp = await tmpdir()
    const dir = path.join(tmp.path, "run")
    initRun(dir, "pixso")
    writeClarification(dir)
    runOk("--mode", "stage-start", "--run-dir", dir, "--stage", "1")
    const before = readState(dir)
    const out = runOk("--mode", "stage-complete", "--run-dir", dir, "--stage", "1", "--result", "blocked", "--reason-code", "build_failed")
    expect(JSON.parse(out)).toMatchObject({ status: "blocked", blockedReasonCode: "build_failed" })
    const after = readState(dir)
    expect(after.analytics.revision).toBe(before.analytics.revision + 1)
    expect(after.analytics.stages["1"].completedAtMs).toBeUndefined()
    expect(after.analytics.stages["1"].activeDurationMs).toBeUndefined()
  })

  test("round 1 passing records calibration {1, 0}", async () => {
    await using tmp = await tmpdir()
    const dir = path.join(tmp.path, "run")
    initRun(dir, "pixso")
    writeClarification(dir)
    writeDesignDoc(dir)
    writeCalibrationReport(dir, [{ round: 1, score: 82 }])
    preseedStages(dir, [1, 2, 3, 4, 5, 6, 7, 8])

    runOk("--mode", "stage-complete", "--run-dir", dir, "--stage", "9", "--result", "passed")
    const after = readState(dir)
    expect(after.completedStages).toContain(9)
    expect(after.analytics.calibration).toEqual({
      calibrationRounds: 1,
      correctionRounds: 0,
      completionReason: "score-threshold-reached",
    })
  })

  test("delivering round 3 reports 75; a restored round-2 candidate reports 78 (correction 2)", async () => {
    await using tmp = await tmpdir()
    const dir = path.join(tmp.path, "run")
    initRun(dir, "pixso")
    writeClarification(dir, { maxRounds: 3 })
    writeDesignDoc(dir)
    writeCalibrationReport(dir, [
      { round: 1, score: 70 },
      { round: 2, score: 78 },
      { round: 3, score: 75 },
    ])
    preseedStages(dir, [1, 2, 3, 4, 5, 6, 7, 8])
    runOk("--mode", "stage-complete", "--run-dir", dir, "--stage", "9", "--result", "passed")
    expect(readState(dir).analytics.calibration).toEqual({
      calibrationRounds: 3,
      correctionRounds: 2,
      completionReason: "max-rounds-reached",
    })

    fs.writeFileSync(
      path.join(dir, "final-visual-score.json"),
      `${JSON.stringify({ status: "recorded", source: "calibration_round", round: 3 }, null, 2)}\n`,
    )
    runOk("--mode", "stage-complete", "--run-dir", dir, "--stage", "10", "--result", "passed")
    const completed = readState(dir)
    expect(completed.status).toBe("completed")
    expect(completed.analytics.finalScore).toEqual({
      status: "recorded",
      source: "calibration_round",
      scoredRound: 3,
      score: 75,
    })

    // Replaying the final completion keeps the frozen delivery score even if
    // the delivery artifact later changes; the replay also never re-diagnoses.
    fs.writeFileSync(path.join(dir, "final-visual-score.json"), `${JSON.stringify({ status: "unavailable" }, null, 2)}\n`)
    const replayResult = runController("--mode", "stage-complete", "--run-dir", dir, "--stage", "10", "--result", "passed")
    expect(replayResult.status).toBe(0)
    expect(JSON.parse(replayResult.stdout).alreadyCompleted).toBe(true)
    expect(replayResult.stderr).not.toContain("missing final-visual-score.json")
    const replayed = readState(dir)
    expect(replayed.analytics.revision).toBe(completed.analytics.revision)
    expect(replayed.analytics.finalScore).toEqual(completed.analytics.finalScore)
  })

  test("delivery_check re-scoring records the scorer output", async () => {
    await using tmp = await tmpdir()
    const seed = async () => {
      const dir = path.join(tmp.path, `run-${Math.random().toString(36).slice(2, 8)}`)
      initRun(dir, "pixso")
      writeClarification(dir, { maxRounds: 2 })
      writeDesignDoc(dir)
      writeCalibrationReport(dir, [
        { round: 1, score: 70 },
        { round: 2, score: 75 },
      ])
      preseedStages(dir, [1, 2, 3, 4, 5, 6, 7, 8])
      runOk("--mode", "stage-complete", "--run-dir", dir, "--stage", "9", "--result", "passed")
      return dir
    }

    const delivery = await seed()
    fs.mkdirSync(path.join(delivery, "visual-calibration", "final-delivery"), { recursive: true })
    fs.writeFileSync(
      path.join(delivery, "visual-calibration", "final-delivery", "score.json"),
      `${JSON.stringify({ aggregate: { final_baseline_score: 81 } })}\n`,
    )
    fs.writeFileSync(path.join(delivery, "visual-calibration", "final-delivery", "candidate.png"), "png")
    fs.writeFileSync(path.join(delivery, "visual-calibration", "final-delivery", "build-log.md"), "build")
    fs.writeFileSync(path.join(delivery, "visual-calibration", "final-delivery", "deployment-log.md"), "deploy")
    fs.writeFileSync(
      path.join(delivery, "final-visual-score.json"),
      `${JSON.stringify(
        {
          status: "recorded",
          source: "delivery_check",
          scoreJson: "visual-calibration/final-delivery/score.json",
          metricsJson: "visual-calibration/final-delivery/score.json",
          candidate: "visual-calibration/final-delivery/candidate.png",
          buildLog: "visual-calibration/final-delivery/build-log.md",
          deploymentLog: "visual-calibration/final-delivery/deployment-log.md",
        },
        null,
        2,
      )}\n`,
    )
    runOk("--mode", "stage-complete", "--run-dir", delivery, "--stage", "10", "--result", "passed")
    expect(readState(delivery).analytics.finalScore).toEqual({ status: "recorded", source: "delivery_check", score: 81 })
  })

  test("the final Full submission is refused until the delivery score is on disk, then retried as-is", async () => {
    await using tmp = await tmpdir()
    const dir = path.join(tmp.path, "missing")
    seedPixsoFinalRun(dir)
    const before = snapshotSubmission(dir, 10)

    const refused = runController("--mode", "stage-complete", "--run-dir", dir, "--stage", "10", "--result", "passed")
    const payload = expectFinalScoreRefusal(dir, refused, "missing")
    expect(payload.stage).toBe(10)
    // Nothing advanced: no Gate, no completed stage, no analytics change.
    expect(snapshotSubmission(dir, 10)).toEqual(before)
    expect(fs.existsSync(gatePath(dir, 10))).toBe(false)
    const blocked = readState(dir)
    expect(blocked.status).toBe("running")
    expect(blocked.status).not.toBe("blocked")
    expect(blocked.completedStages).not.toContain(10)
    expect(blocked.analytics.finalScore).toBeUndefined()

    // Recording the adopted round and retrying the same submission completes.
    writeFinalScore(dir, { status: "recorded", source: "calibration_round", round: 1 })
    const retried = runController("--mode", "stage-complete", "--run-dir", dir, "--stage", "10", "--result", "passed")
    expect(retried.status).toBe(0)
    expect(JSON.parse(retried.stdout).status).toBe("completed")
    const done = readState(dir)
    expect(done.status).toBe("completed")
    expect(done.analytics.finalScore).toEqual({
      status: "recorded",
      source: "calibration_round",
      scoredRound: 1,
      score: 82,
    })
  })

  test("an explicit unavailable artifact completes without carrying its local reason", async () => {
    await using tmp = await tmpdir()
    const dir = path.join(tmp.path, "explicit-unavailable")
    seedPixsoFinalRun(dir)
    writeUnavailableFinalScore(dir, "no candidate screenshot could be produced for the delivery page")
    runOk("--mode", "stage-complete", "--run-dir", dir, "--stage", "10", "--result", "passed")
    const done = readState(dir)
    expect(done.status).toBe("completed")
    expect(done.analytics.finalScore).toEqual({ status: "unavailable" })
    // The note stays on the local artifact and never reaches the frozen shape.
    expect(JSON.parse(fs.readFileSync(path.join(dir, "final-visual-score.json"), "utf8")).reason).toContain("candidate")
    expect(JSON.stringify(done.analytics.finalScore)).not.toContain("reason")
  })

  test("invalid delivery artifacts are refused before any write", async () => {
    await using tmp = await tmpdir()
    const cases: Array<{ name: string; seed: (dir: string) => void; reason: string }> = [
      {
        name: "malformed json",
        seed: (dir) => fs.writeFileSync(path.join(dir, "final-visual-score.json"), "{oops\n"),
        reason: "invalid_artifact",
      },
      { name: "root not an object", seed: (dir) => writeFinalScore(dir, []), reason: "invalid_artifact" },
      { name: "unknown status", seed: (dir) => writeFinalScore(dir, { status: "maybe" }), reason: "invalid_artifact" },
      {
        name: "unknown source",
        seed: (dir) => writeFinalScore(dir, { status: "recorded", source: "calibration" }),
        reason: "invalid_artifact",
      },
      {
        name: "empty unavailable reason",
        seed: (dir) => writeFinalScore(dir, { status: "unavailable", reason: "" }),
        reason: "invalid_artifact",
      },
      {
        name: "non-string unavailable reason",
        seed: (dir) => writeFinalScore(dir, { status: "unavailable", reason: 3 }),
        reason: "invalid_artifact",
      },
      {
        name: "round out of range",
        seed: (dir) => writeFinalScore(dir, { status: "recorded", source: "calibration_round", round: 99 }),
        reason: "invalid_score_evidence",
      },
      {
        name: "round not an integer",
        seed: (dir) => writeFinalScore(dir, { status: "recorded", source: "calibration_round", round: "1" }),
        reason: "invalid_score_evidence",
      },
      {
        name: "delivery score escaping the run",
        seed: (dir) =>
          writeFinalScore(dir, {
            status: "recorded",
            source: "delivery_check",
            scoreJson: "../outside-run.json",
            metricsJson: "visual-calibration/final-delivery/metrics.json",
            candidate: "visual-calibration/final-delivery/candidate.png",
            buildLog: "visual-calibration/final-delivery/build-log.md",
            deploymentLog: "visual-calibration/final-delivery/deployment-log.md",
          }),
        reason: "invalid_score_evidence",
      },
      {
        name: "delivery evidence file missing",
        seed: (dir) => {
          writeDeliveryCheck(dir, 81)
          fs.rmSync(path.join(dir, "visual-calibration", "final-delivery", "candidate.png"))
        },
        reason: "invalid_score_evidence",
      },
      {
        name: "delivery aggregate out of range",
        seed: (dir) => writeDeliveryCheck(dir, 150),
        reason: "invalid_score_evidence",
      },
    ]

    for (const item of cases) {
      const dir = path.join(tmp.path, item.name.replace(/\s+/g, "-"))
      seedPixsoFinalRun(dir)
      item.seed(dir)
      const before = snapshotSubmission(dir, 10)
      const result = runController("--mode", "stage-complete", "--run-dir", dir, "--stage", "10", "--result", "passed")
      expectFinalScoreRefusal(dir, result, item.reason)
      expect(snapshotSubmission(dir, 10)).toEqual(before)
      expect(fs.existsSync(gatePath(dir, 10))).toBe(false)
    }
  }, 60_000)

  test("an interrupted final submission keeps its Gate and resumes after the artifact lands", async () => {
    await using tmp = await tmpdir()
    const dir = path.join(tmp.path, "recovery")
    seedPixsoFinalRun(dir)
    // A previous attempt wrote the canonical Gate and died before the state advanced.
    const gateTime = T0 + 10_000
    writeGate(dir, 10, gateTime)
    const before = snapshotSubmission(dir, 10)

    expectFinalScoreRefusal(
      dir,
      runController("--mode", "stage-complete", "--run-dir", dir, "--stage", "10", "--result", "passed"),
      "missing",
    )
    expect(snapshotSubmission(dir, 10)).toEqual(before)

    writeFinalScore(dir, { status: "recorded", source: "calibration_round", round: 1 })
    runOk("--mode", "stage-complete", "--run-dir", dir, "--stage", "10", "--result", "passed")
    const gate = JSON.parse(fs.readFileSync(gatePath(dir, 10), "utf8"))
    expect(Date.parse(gate.completedAt)).toBe(gateTime)
    expect(readState(dir).status).toBe("completed")
  })

  test("fast completion is not_applicable; disabled calibration is skipped", async () => {
    await using tmp = await tmpdir()
    // pixso fast: stage 5 keeps the doc guard, the last stage is 9.
    const fastDir = path.join(tmp.path, "fast-run")
    initRun(fastDir, "pixso", "fast")
    writeClarification(fastDir)
    writeDesignDoc(fastDir)
    preseedStages(fastDir, [1, 2, 3, 4, 5, 6, 7, 8])
    const fastResult = runController("--mode", "stage-complete", "--run-dir", fastDir, "--stage", "9", "--result", "passed")
    expect(fastResult.status).toBe(0)
    expect(fastResult.stderr).not.toContain("missing final-visual-score.json")
    const fastDone = readState(fastDir)
    expect(fastDone.status).toBe("completed")
    expect(fastDone.analytics.calibration).toBeUndefined()
    expect(fastDone.analytics.finalScore).toEqual({ status: "not_applicable" })

    const disabledDir = path.join(tmp.path, "disabled-run")
    initRun(disabledDir, "pixso")
    writeClarification(disabledDir, { enabled: false })
    writeDesignDoc(disabledDir)
    writeSkippedCalibrationReport(disabledDir)
    preseedStages(disabledDir, [1, 2, 3, 4, 5, 6, 7, 8])
    runOk("--mode", "stage-complete", "--run-dir", disabledDir, "--stage", "9", "--result", "passed")
    const disabledStage = readState(disabledDir)
    expect(disabledStage.analytics.calibration).toBeUndefined()
    fs.writeFileSync(path.join(disabledDir, "completeness-report.md"), "summary\n")
    const skippedResult = runController("--mode", "stage-complete", "--run-dir", disabledDir, "--stage", "10", "--result", "passed")
    expect(skippedResult.status).toBe(0)
    // Fast and explicitly skipped calibration never trigger the missing-artifact hint.
    expect(skippedResult.stderr).not.toContain("missing final-visual-score.json")
    expect(readState(disabledDir).analytics.finalScore).toEqual({ status: "skipped" })
  })

  test("the first 40 lines of the pixso stage-10 instructions carry the delivery-score requirements", async () => {
    const lines = fs
      .readFileSync(
        path.join(
          __dirname,
          "..",
          "..",
          "..",
          "resources",
          "skills",
          "hmos-design-to-arkts",
          "references",
          "pixso",
          "full",
          "stages",
          "10-summary.md",
        ),
        "utf8",
      )
      .split(/\r?\n/)
    const head = lines.slice(0, 40).join("\n")
    // Read the full instruction (pagination included), write the delivery
    // score artifact, and confirm it is on disk before submitting stage 10.
    expect(head).toContain("按 offset 继续读取")
    expect(head).toContain("final-visual-score.json")
    expect(head).toContain("检查文件存在后再提交")
    // The task acceptance report must also be on disk before the final submit.
    expect(head).toContain("task-completion.json")
    // The mandatory Todo sync stays ahead of the execution steps.
    const todoHeading = lines.findIndex((line) => line.includes("强制阶段入口 Todo 同步"))
    const executionHeading = lines.findIndex((line) => line.trim() === "## 执行步骤")
    expect(todoHeading).toBeGreaterThanOrEqual(0)
    expect(executionHeading).toBeGreaterThan(todoHeading)
  })

  test("run lock excludes concurrent commands and a stale lock is reclaimed", async () => {
    await using tmp = await tmpdir()
    const dir = path.join(tmp.path, "run")
    initRun(dir, "pixso")
    const lockPath = path.join(dir, "workflow-state.lock")
    fs.writeFileSync(lockPath, "999999\nheld by another process\n")

    // While the lock is held, a concurrent command must not run to completion.
    const held = spawn(process.execPath, [CONTROLLER, "--mode", "status", "--run-dir", dir])
    await new Promise((resolve) => setTimeout(resolve, 1500))
    expect(held.exitCode).toBeNull()
    held.kill()
    await new Promise((resolve) => held.once("exit", resolve))
    // An abnormal exit leaves the lock behind (reclaimed below, not deleted).
    expect(fs.existsSync(lockPath)).toBe(true)

    // A stale lock (crashed holder) is reclaimed after the stale window.
    const stale = new Date(Date.now() - 10 * 60 * 1000)
    fs.utimesSync(lockPath, stale, stale)
    const out = runOk("--mode", "status", "--run-dir", dir)
    expect(JSON.parse(out).status).toBe("running")
    expect(fs.existsSync(lockPath)).toBe(false)
  })

  test("others-html full run calibrates at stage 5 and delivers at stage 6", async () => {
    await using tmp = await tmpdir()
    const dir = path.join(tmp.path, "html-run")
    seedOthersHtmlRun(dir)

    // The stage-5 calibration report feeds the analytics calibration summary.
    const calibrated = runOk("--mode", "stage-complete", "--run-dir", dir, "--stage", "5", "--result", "passed")
    expect(JSON.parse(calibrated).status).toBe("running")
    expect(readState(dir).analytics.calibration).toEqual({
      calibrationRounds: 1,
      correctionRounds: 0,
      completionReason: "score-threshold-reached",
    })

    // A completed calibration without the delivery artifact is refused; the
    // stage and its Gate stay untouched until the artifact lands.
    const missingDir = path.join(tmp.path, "html-missing")
    fs.cpSync(dir, missingDir, { recursive: true })
    fs.writeFileSync(path.join(missingDir, "completeness-report.md"), "summary\n")
    const missing = runController("--mode", "stage-complete", "--run-dir", missingDir, "--stage", "6", "--result", "passed")
    expectFinalScoreRefusal(missingDir, missing, "missing")
    expect(fs.existsSync(gatePath(missingDir, 6))).toBe(false)
    expect(readState(missingDir).status).toBe("running")
    writeFinalScore(missingDir, { status: "recorded", source: "calibration_round", round: 1 })
    runOk("--mode", "stage-complete", "--run-dir", missingDir, "--stage", "6", "--result", "passed")
    expect(readState(missingDir).analytics.finalScore).toEqual({
      status: "recorded",
      source: "calibration_round",
      scoredRound: 1,
      score: 82,
    })

    // An explicit unavailable artifact is a deliberate record.
    const explicitDir = path.join(tmp.path, "html-explicit")
    fs.cpSync(dir, explicitDir, { recursive: true })
    writeUnavailableFinalScore(explicitDir)
    fs.writeFileSync(path.join(explicitDir, "completeness-report.md"), "summary\n")
    runOk("--mode", "stage-complete", "--run-dir", explicitDir, "--stage", "6", "--result", "passed")
    expect(readState(explicitDir).analytics.finalScore).toEqual({ status: "unavailable" })

    // A pointer to the adopted scored round records the delivered score.
    const recordedDir = path.join(tmp.path, "html-recorded")
    fs.cpSync(dir, recordedDir, { recursive: true })
    fs.writeFileSync(
      path.join(recordedDir, "final-visual-score.json"),
      `${JSON.stringify({ status: "recorded", source: "calibration_round", round: 1 }, null, 2)}\n`,
    )
    fs.writeFileSync(path.join(recordedDir, "completeness-report.md"), "summary\n")
    const recorded = runController("--mode", "stage-complete", "--run-dir", recordedDir, "--stage", "6", "--result", "passed")
    expect(recorded.status).toBe(0)
    expect(readState(recordedDir).analytics.finalScore).toEqual({
      status: "recorded",
      source: "calibration_round",
      scoredRound: 1,
      score: 82,
    })

    // Replaying the completed stage keeps the frozen score and never re-hints.
    const replay = runController("--mode", "stage-complete", "--run-dir", recordedDir, "--stage", "6", "--result", "passed")
    expect(replay.status).toBe(0)
    expect(JSON.parse(replay.stdout).alreadyCompleted).toBe(true)
    expect(replay.stderr).not.toContain("missing final-visual-score.json")
    expect(readState(recordedDir).analytics.finalScore).toEqual({
      status: "recorded",
      source: "calibration_round",
      scoredRound: 1,
      score: 82,
    })
  })

  test("others-visual full run calibrates at stage 5 and delivers at stage 6", async () => {
    await using tmp = await tmpdir()
    const dir = path.join(tmp.path, "visual-run")
    seedOthersVisualRun(dir)

    const calibrated = runOk("--mode", "stage-complete", "--run-dir", dir, "--stage", "5", "--result", "passed")
    expect(JSON.parse(calibrated).status).toBe("running")
    expect(readState(dir).analytics.calibration).toEqual({
      calibrationRounds: 1,
      correctionRounds: 0,
      completionReason: "score-threshold-reached",
    })

    const missingDir = path.join(tmp.path, "visual-missing")
    fs.cpSync(dir, missingDir, { recursive: true })
    fs.writeFileSync(path.join(missingDir, "completeness-report.md"), "summary\n")
    const missing = runController("--mode", "stage-complete", "--run-dir", missingDir, "--stage", "6", "--result", "passed")
    expectFinalScoreRefusal(missingDir, missing, "missing")
    expect(fs.existsSync(gatePath(missingDir, 6))).toBe(false)
    expect(readState(missingDir).status).toBe("running")
    writeFinalScore(missingDir, { status: "recorded", source: "calibration_round", round: 1 })
    runOk("--mode", "stage-complete", "--run-dir", missingDir, "--stage", "6", "--result", "passed")
    expect(readState(missingDir).analytics.finalScore).toEqual({
      status: "recorded",
      source: "calibration_round",
      scoredRound: 1,
      score: 82,
    })

    const recordedDir = path.join(tmp.path, "visual-recorded")
    fs.cpSync(dir, recordedDir, { recursive: true })
    fs.writeFileSync(
      path.join(recordedDir, "final-visual-score.json"),
      `${JSON.stringify({ status: "recorded", source: "calibration_round", round: 1 }, null, 2)}\n`,
    )
    fs.writeFileSync(path.join(recordedDir, "completeness-report.md"), "summary\n")
    const recorded = runController("--mode", "stage-complete", "--run-dir", recordedDir, "--stage", "6", "--result", "passed")
    expect(recorded.status).toBe(0)
    expect(readState(recordedDir).analytics.finalScore).toEqual({
      status: "recorded",
      source: "calibration_round",
      scoredRound: 1,
      score: 82,
    })
  })

  test("others-html fast and skipped-calibration runs never hint", async () => {
    await using tmp = await tmpdir()
    // Fast: stage 5 is the summary; the run completes without calibration.
    const fastDir = path.join(tmp.path, "html-fast")
    seedOthersHtmlRun(fastDir, { variant: "fast" })
    fs.writeFileSync(path.join(fastDir, "completeness-report.md"), "summary\n")
    const fast = runController("--mode", "stage-complete", "--run-dir", fastDir, "--stage", "5", "--result", "passed")
    expect(fast.status).toBe(0)
    expect(JSON.parse(fast.stdout).status).toBe("completed")
    expect(fast.stderr).not.toContain("missing final-visual-score.json")
    const fastDone = readState(fastDir)
    expect(fastDone.analytics.calibration).toBeUndefined()
    expect(fastDone.analytics.finalScore).toEqual({ status: "not_applicable" })

    // Explicitly disabled calibration records skipped without a hint.
    const skipDir = path.join(tmp.path, "html-skipped")
    seedOthersHtmlRun(skipDir, { calibration: "skipped" })
    runOk("--mode", "stage-complete", "--run-dir", skipDir, "--stage", "5", "--result", "passed")
    expect(readState(skipDir).analytics.calibration).toBeUndefined()
    fs.writeFileSync(path.join(skipDir, "completeness-report.md"), "summary\n")
    const skipped = runController("--mode", "stage-complete", "--run-dir", skipDir, "--stage", "6", "--result", "passed")
    expect(skipped.status).toBe(0)
    expect(skipped.stderr).not.toContain("missing final-visual-score.json")
    expect(readState(skipDir).analytics.finalScore).toEqual({ status: "skipped" })
  })

  test("the first 40 lines of the new summary instructions carry the delivery-score requirements", async () => {
    for (const source of ["others-html", "others-visual"]) {
      const lines = fs
        .readFileSync(
          path.join(
            __dirname,
            "..",
            "..",
            "..",
            "resources",
            "skills",
            "hmos-design-to-arkts",
            "references",
            source,
            "full",
            "stages",
            "06-summary.md",
          ),
          "utf8",
        )
        .split(/\r?\n/)
      const head = lines.slice(0, 40).join("\n")
      expect(head).toContain("按 offset 继续读取")
      expect(head).toContain("final-visual-score.json")
      expect(head).toContain("确认落盘")
      // The task acceptance report is required before the same final submit.
      expect(head).toContain("task-completion.json")
      const todoHeading = lines.findIndex((line) => line.includes("强制阶段入口 Todo 同步"))
      const executionHeading = lines.findIndex((line) => line.trim() === "## 执行")
      expect(todoHeading).toBeGreaterThanOrEqual(0)
      expect(executionHeading).toBeGreaterThan(todoHeading)
    }
  })

  // The task acceptance report the shared SKILL asks the model to write at the
  // run root; the summary itself stays local, only counts reach the state.
  function task(id: string, status: "passed" | "failed" | "unverified", description = `task ${id}`) {
    return { id, task: description, status, evidence: `evidence for ${id}` }
  }

  function writeTaskReport(dir: string, tasks: unknown[]) {
    fs.writeFileSync(path.join(dir, "task-completion.json"), `${JSON.stringify({ tasks }, null, 2)}\n`)
  }

  test("task completion is computed at final completion for full and fast variants", async () => {
    await using tmp = await tmpdir()
    // Full: an others-html run past its stage-5 calibration.
    const base = path.join(tmp.path, "html-full")
    seedOthersHtmlRun(base)
    runOk("--mode", "stage-complete", "--run-dir", base, "--stage", "5", "--result", "passed")

    const recorded = path.join(tmp.path, "html-recorded")
    fs.cpSync(base, recorded, { recursive: true })
    writeTaskReport(recorded, [
      ...Array.from({ length: 8 }, (_, index) => task(`T${String(index + 1).padStart(2, "0")}`, "passed")),
      task("T09", "failed"),
      task("T10", "unverified"),
    ])
    fs.writeFileSync(path.join(recorded, "completeness-report.md"), "summary\n")
    // The final score contract is separate from the acceptance report: record
    // an explicit unavailable score, then focus this test on task completion.
    writeUnavailableFinalScore(recorded)
    const done = runController("--mode", "stage-complete", "--run-dir", recorded, "--stage", "6", "--result", "passed")
    expect(done.status).toBe(0)
    expect(JSON.parse(done.stdout).status).toBe("completed")
    expect(readState(recorded).analytics.taskCompletion).toEqual({
      status: "recorded",
      passed: 8,
      failed: 1,
      unverified: 1,
      rate: 0.8,
    })
    // The delivery score keeps its own contract on the same final write.
    expect(readState(recorded).analytics.finalScore).toEqual({ status: "unavailable" })

    // A valid all-failed report records a real 0, not unavailable.
    const allFailed = path.join(tmp.path, "html-all-failed")
    fs.cpSync(base, allFailed, { recursive: true })
    writeTaskReport(allFailed, [task("T01", "failed"), task("T02", "failed")])
    fs.writeFileSync(path.join(allFailed, "completeness-report.md"), "summary\n")
    writeUnavailableFinalScore(allFailed)
    const failedRun = runController("--mode", "stage-complete", "--run-dir", allFailed, "--stage", "6", "--result", "passed")
    expect(failedRun.status).toBe(0)
    expect(readState(allFailed).analytics.taskCompletion).toEqual({
      status: "recorded",
      passed: 0,
      failed: 2,
      unverified: 0,
      rate: 0,
    })

    // Fast: no visual calibration exists, the completion rate still records.
    const fast = path.join(tmp.path, "html-fast-tasks")
    seedOthersHtmlRun(fast, { variant: "fast" })
    writeTaskReport(fast, [task("T01", "passed"), task("T02", "unverified")])
    fs.writeFileSync(path.join(fast, "completeness-report.md"), "summary\n")
    const fastDone = runController("--mode", "stage-complete", "--run-dir", fast, "--stage", "5", "--result", "passed")
    expect(fastDone.status).toBe(0)
    const fastState = readState(fast)
    expect(fastState.analytics.taskCompletion).toEqual({
      status: "recorded",
      passed: 1,
      failed: 0,
      unverified: 1,
      rate: 0.5,
    })
    expect(fastState.analytics.finalScore).toEqual({ status: "not_applicable" })

    // Replaying the completed final stage keeps the frozen summary.
    const replay = runController("--mode", "stage-complete", "--run-dir", fast, "--stage", "5", "--result", "passed")
    expect(replay.status).toBe(0)
    expect(readState(fast).analytics.taskCompletion).toEqual({
      status: "recorded",
      passed: 1,
      failed: 0,
      unverified: 1,
      rate: 0.5,
    })
  })

  test("missing or invalid task reports record unavailable without blocking delivery", async () => {
    await using tmp = await tmpdir()
    const base = path.join(tmp.path, "base")
    seedOthersHtmlRun(base)
    runOk("--mode", "stage-complete", "--run-dir", base, "--stage", "5", "--result", "passed")

    const unavailable = { status: "unavailable" }
    const scenarios: Array<{ name: string; seed: (dir: string) => void }> = [
      { name: "missing file", seed: () => {} },
      { name: "empty task list", seed: (dir) => writeTaskReport(dir, []) },
      {
        name: "broken json",
        seed: (dir) => fs.writeFileSync(path.join(dir, "task-completion.json"), "{oops\n"),
      },
      {
        name: "illegal status",
        seed: (dir) => writeTaskReport(dir, [task("T01", "passed"), { ...task("T02", "passed"), status: "maybe" }]),
      },
      {
        name: "duplicate id",
        seed: (dir) => writeTaskReport(dir, [task("T01", "passed"), task("T01", "failed")]),
      },
      {
        name: "missing evidence",
        seed: (dir) => writeTaskReport(dir, [{ id: "T01", task: "a", status: "passed" }]),
      },
      {
        name: "directory instead of a plain file",
        seed: (dir) => fs.mkdirSync(path.join(dir, "task-completion.json")),
      },
      {
        name: "symlink escaping the run",
        seed: (dir) => {
          const outside = path.join(tmp.path, "outside-report.json")
          fs.writeFileSync(outside, JSON.stringify({ tasks: [task("T01", "passed")] }))
          fs.symlinkSync(outside, path.join(dir, "task-completion.json"))
        },
      },
    ]
    for (const scenario of scenarios) {
      const dir = path.join(tmp.path, scenario.name.replace(/\s+/g, "-"))
      fs.cpSync(base, dir, { recursive: true })
      // A scenario may be impossible on this platform (file symlinks need
      // privileges on Windows); skip only that scenario, not the run.
      let seeded = true
      try {
        scenario.seed(dir)
      } catch {
        seeded = false
      }
      if (!seeded) continue
      fs.writeFileSync(path.join(dir, "completeness-report.md"), "summary\n")
      // Keep the delivery-score contract satisfied so only the task report varies.
      writeUnavailableFinalScore(dir)
      const result = runController("--mode", "stage-complete", "--run-dir", dir, "--stage", "6", "--result", "passed")
      expect(result.status).toBe(0)
      expect(JSON.parse(result.stdout).status).toBe("completed")
      expect(readState(dir).analytics.taskCompletion).toEqual(unavailable)
      // The final gate and delivery result keep their original rules.
      expect(readState(dir).analytics.finalScore).toEqual({ status: "unavailable" })
    }
  })

  test("legacy states without taskCompletion keep loading under the original rules", async () => {
    await using tmp = await tmpdir()
    // A fast run whose non-final stages are done: states created before the
    // field existed simply lack it, and every command path still validates.
    const dir = path.join(tmp.path, "legacy-fast")
    seedOthersHtmlRun(dir, { variant: "fast" })
    expect(readState(dir).analytics.taskCompletion).toBeUndefined()
    const status = runController("--mode", "status", "--run-dir", dir)
    expect(status.status).toBe(0)
    expect(JSON.parse(status.stdout).status).toBe("running")

    // Completing a non-final stage leaves the field absent until completion.
    const seeded = path.join(tmp.path, "legacy-seeded")
    fs.cpSync(dir, seeded, { recursive: true })
    writeTaskReport(seeded, [task("T01", "passed")])
    // Fast has 5 stages; stage 4 completion is a normal mid-run write.
    runOk("--mode", "stage-complete", "--run-dir", seeded, "--stage", "4", "--result", "passed")
    expect(readState(seeded).analytics.taskCompletion).toBeUndefined()

    // The final stage then records the summary from the pre-written report.
    fs.writeFileSync(path.join(seeded, "completeness-report.md"), "summary\n")
    const final = runController("--mode", "stage-complete", "--run-dir", seeded, "--stage", "5", "--result", "passed")
    expect(final.status).toBe(0)
    expect(readState(seeded).analytics.taskCompletion).toEqual({
      status: "recorded",
      passed: 1,
      failed: 0,
      unverified: 0,
      rate: 1,
    })
  })

  test("all twelve catalogs end at the shared summary branch", () => {
    const skillRoot = path.join(__dirname, "..", "..", "..", "resources", "skills", "hmos-design-to-arkts")
    const expected: Record<string, number> = {
      "pixso/full": 10,
      "pixso/fast": 9,
      "figma/full": 6,
      "figma/fast": 5,
      "mastergo/full": 6,
      "mastergo/fast": 5,
      "lanhu/full": 6,
      "lanhu/fast": 5,
      "others-html/full": 6,
      "others-html/fast": 5,
      "others-visual/full": 6,
      "others-visual/fast": 5,
    }
    for (const [key, lastStage] of Object.entries(expected)) {
      const [source, variant] = key.split("/")
      const catalog = JSON.parse(
        fs.readFileSync(path.join(skillRoot, "references", source, `stage-catalog-${variant}.json`), "utf8"),
      )
      expect(catalog.stages.at(-1).id).toBe(lastStage)
      // The shared SKILL acceptance rule applies to every source and mode.
      expect(catalog.stages.length).toBe(lastStage)
    }
    const skill = fs.readFileSync(path.join(skillRoot, "SKILL.md"), "utf8")
    expect(skill).toContain("task-completion.json")
  })
})
