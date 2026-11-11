#!/usr/bin/env node
/**
 * visual_region_diff.mjs - deterministic region reconciliation for the screenshot path.
 *
 * Stage 5 calibrates an implementation by comparing rendered screenshots with the
 * design screenshot. The pixel score answers "how close", never "which region is
 * off", and the comparison model gets tired: round 5 of a real run reported "no
 * perceivable difference" while the hero region was 13% too tall and the info bar
 * 40% too tall. This script answers "which region" with arithmetic only.
 *
 * Input is always two `visual_probe.mjs` reports:
 *   - the design report measured once in stage 1 (`stage1/visual-probe.json`), and
 *   - a report of the same round's implementation screenshot.
 * Both are normalized to the same declared logical width, so their boundaries are
 * directly comparable in logical units. Every difference is reported with its
 * tolerance; nothing here needs a model, a device, or the network.
 *
 * Region boundaries are the structural truth: a partition of the canvas derived
 * from row-mean colour transitions. Decoration (radius, palette, block boxes) is
 * reported as a warning because `visual_probe` is a coarse estimator - treating
 * it as exact would enforce the estimator's own error.
 *
 * Usage:
 *   node scripts/visual_region_diff.mjs \
 *     --design <runDir>/stage1/visual-probe.json \
 *     --candidate <runDir>/visual-calibration/round-01/candidate-probe.json \
 *     --out <runDir>/visual-calibration/round-01/region-diff.json [--strict]
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname } from "node:path"

const SCHEMA_VERSION = 1
/** A region boundary may move by this share of canvas height before it is a failure. */
const DEFAULT_BAND_TOLERANCE = 0.015
/** Blocks of at least this share of canvas area are structural, not decoration. */
const STRUCTURAL_BLOCK_AREA_RATIO = 0.05
/** Structural block width/height may drift by this share before it is a failure. */
const DEFAULT_BLOCK_TOLERANCE = 0.12
/** Corner radius tolerance in logical units; probe radii are medium confidence at best. */
const DEFAULT_RADIUS_TOLERANCE = 1.5
/** Per-channel tolerance for quantized palette and background colours. */
const DEFAULT_COLOR_TOLERANCE = 8

const fail = (code, message) => {
  process.stderr.write(`visual_region_diff: [${code}] ${message}\n`)
  process.exit(2)
}

function parseArgs(argv) {
  const result = {}
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]
    if (!token.startsWith("--")) fail("invalid-argument", `unexpected argument: ${token}`)
    const key = token.slice(2)
    if (key === "strict") {
      result.strict = true
      continue
    }
    const value = argv[index + 1]
    if (value === undefined || value.startsWith("--")) fail("invalid-argument", `${key} needs a value`)
    result[key] = value
    index += 1
  }
  return result
}

const number = (value, fallback) => {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : fallback
}

function loadProbe(path, label) {
  if (!existsSync(path)) fail("missing-input", `${label} does not exist: ${path}`)
  let parsed
  try {
    parsed = JSON.parse(readFileSync(path, "utf8").replace(/^\uFEFF/, ""))
  } catch (error) {
    fail("invalid-input", `${label} is not valid JSON: ${error.message}`)
  }
  const scale = Number(parsed?.canvas?.scale)
  const logicalHeight = Number(parsed?.canvas?.logicalHeight)
  const logicalWidth = Number(parsed?.canvas?.logicalWidth)
  if (!Number.isFinite(scale) || scale <= 0) fail("invalid-input", `${label} canvas.scale must be positive`)
  if (!Number.isFinite(logicalHeight) || logicalHeight <= 0) {
    fail("invalid-input", `${label} canvas.logicalHeight must be positive`)
  }
  if (!Array.isArray(parsed?.bands) || parsed.bands.length === 0) {
    fail("invalid-input", `${label} must contain a non-empty bands array`)
  }
  return {
    path,
    scale,
    logicalWidth,
    logicalHeight,
    raw: parsed,
  }
}

const round = (value, digits = 2) => Number(Number(value).toFixed(digits))
const compact = (text) => String(text ?? "").replace(/\s+/g, "")

/** Internal region boundaries in logical units, ignoring the two canvas edges. */
function bandBoundaries(probe, label) {
  const boundaries = []
  for (const [index, band] of probe.raw.bands.entries()) {
    const y1 = Number(band?.y1)
    if (!Number.isFinite(y1)) fail("invalid-input", `${label} bands[${index}].y1 must be a number`)
    const values = boundaries.length === 0 && Number.isFinite(Number(band?.y0)) ? [Number(band.y0), y1] : [y1]
    for (const value of values) {
      const logical = value / probe.scale
      const normalized = logical / probe.logicalHeight
      if (normalized <= 0.005 || normalized >= 0.995) continue
      boundaries.push({ logical: round(logical), normalized: round(normalized, 4) })
    }
  }
  boundaries.sort((a, b) => a.normalized - b.normalized)
  return dedupeBoundaries(boundaries)
}

function dedupeBoundaries(boundaries) {
  const result = []
  for (const boundary of boundaries) {
    const previous = result[result.length - 1]
    if (previous && Math.abs(previous.normalized - boundary.normalized) < 0.002) continue
    result.push(boundary)
  }
  return result
}

function matchBoundaries(design, candidate, tolerance) {
  const used = new Set()
  const matches = []
  const missing = []
  for (const boundary of design) {
    let bestIndex = -1
    let bestDelta = Number.POSITIVE_INFINITY
    for (const [index, other] of candidate.entries()) {
      if (used.has(index)) continue
      const delta = Math.abs(other.normalized - boundary.normalized)
      if (delta < bestDelta) {
        bestDelta = delta
        bestIndex = index
      }
    }
    if (bestIndex >= 0 && bestDelta <= tolerance) {
      used.add(bestIndex)
      matches.push({
        designNormalized: boundary.normalized,
        designY: boundary.logical,
        candidateNormalized: candidate[bestIndex].normalized,
        candidateY: candidate[bestIndex].logical,
        deltaNormalized: round(candidate[bestIndex].normalized - boundary.normalized, 4),
        deltaY: round(candidate[bestIndex].logical - boundary.logical),
        tolerance,
        passed: true,
      })
      continue
    }
    missing.push({ designNormalized: boundary.normalized, designY: boundary.logical, tolerance })
  }
  const extras = []
  for (const [index, other] of candidate.entries()) {
    if (used.has(index)) continue
    extras.push({ candidateNormalized: other.normalized, candidateY: other.logical })
  }
  return { matches, missing, extras }
}

function blockBoxes(probe) {
  const boxes = []
  for (const [index, block] of probe.raw.blocks.entries()) {
    const x0 = Number(block?.x0)
    const y0 = Number(block?.y0)
    const x1 = Number(block?.x1)
    const y1 = Number(block?.y1)
    if (![x0, y0, x1, y1].every((value) => Number.isFinite(value))) continue
    const width = (x1 - x0) / probe.scale
    const height = (y1 - y0) / probe.scale
    if (width <= 0 || height <= 0) continue
    // An unknown radius must stay unknown: Number(null) is 0, which would
    // report a 0-radius design against a measured corner and fire a false
    // block-radius difference.
    const rawRadius = block?.logicalRadiusPx
    const radius = rawRadius === null || rawRadius === undefined ? null : Number(rawRadius)
    boxes.push({
      index,
      x: round(x0 / probe.scale),
      y: round(y0 / probe.scale),
      width: round(width),
      height: round(height),
      radius: Number.isFinite(radius) ? round(radius) : null,
      areaRatio: round((width * height) / (probe.logicalWidth * probe.logicalHeight), 4),
    })
  }
  return boxes
}

function matchBlocks(design, candidate) {
  const used = new Set()
  const matches = []
  const unmatchedDesign = []
  for (const block of [...design].sort((a, b) => b.areaRatio - a.areaRatio)) {
    const centerY = block.y + block.height / 2
    let bestIndex = -1
    let bestDistance = Number.POSITIVE_INFINITY
    for (const [index, other] of candidate.entries()) {
      if (used.has(index)) continue
      const otherCenterY = other.y + other.height / 2
      const verticalDistance = Math.abs(otherCenterY - centerY)
      const overlap = Math.min(block.x + block.width, other.x + other.width) - Math.max(block.x, other.x)
      if (overlap <= 0) continue
      if (verticalDistance > Math.max(block.height, other.height) * 0.6) continue
      if (verticalDistance < bestDistance) {
        bestDistance = verticalDistance
        bestIndex = index
      }
    }
    if (bestIndex < 0) {
      unmatchedDesign.push(block)
      continue
    }
    used.add(bestIndex)
    matches.push({ design: block, candidate: candidate[bestIndex] })
  }
  const unmatchedCandidate = candidate.filter((_, index) => !used.has(index))
  return { matches, unmatchedDesign, unmatchedCandidate }
}

function compareBlocks(design, candidate, options) {
  const { matches, unmatchedDesign, unmatchedCandidate } = matchBlocks(blockBoxes(design), blockBoxes(candidate))
  const warnings = []
  for (const { design: expected, candidate: actual } of matches) {
    const widthTolerance = Math.max(2, expected.width * options.blockTolerance)
    const heightTolerance = Math.max(2, expected.height * options.blockTolerance)
    for (const [metric, expectedValue, actualValue, tolerance] of [
      ["width", expected.width, actual.width, widthTolerance],
      ["height", expected.height, actual.height, heightTolerance],
    ]) {
      const delta = round(actualValue - expectedValue)
      if (Math.abs(delta) <= tolerance) continue
      // Block boxes are advisory: two adjacent cards merge into one connected
      // component on one side and stay separate on the other, which is a probe
      // artefact rather than a layout defect. Only region boundaries gate.
      warnings.push({
        kind: "block-size",
        metric: `block[${expected.index}].${metric}`,
        design: expectedValue,
        candidate: actualValue,
        delta,
        tolerance: round(tolerance),
      })
    }
    if (expected.radius !== null && actual.radius !== null) {
      const delta = round(actual.radius - expected.radius)
      if (Math.abs(delta) > options.radiusTolerance) {
        warnings.push({
          kind: "block-radius",
          metric: `block[${expected.index}].radius`,
          design: expected.radius,
          candidate: actual.radius,
          delta,
          tolerance: options.radiusTolerance,
        })
      }
    }
  }
  for (const block of unmatchedDesign) {
    warnings.push({ kind: "block-missing", metric: `block[${block.index}]`, design: block, candidate: null })
  }
  for (const block of unmatchedCandidate) {
    warnings.push({ kind: "block-extra", metric: `block[${block.index}]`, design: null, candidate: block })
  }
  return {
    matched: matches.length,
    warnings,
    unmatchedDesign: unmatchedDesign.length,
    unmatchedCandidate: unmatchedCandidate.length,
  }
}

function channelRgb(value) {
  const text = String(value ?? "").toUpperCase()
  if (!/^#[0-9A-F]{6}$/.test(text)) return null
  return [parseInt(text.slice(1, 3), 16), parseInt(text.slice(3, 5), 16), parseInt(text.slice(5, 7), 16)]
}

function colorDistanceWithin(left, right, tolerance) {
  const a = channelRgb(left)
  const b = channelRgb(right)
  if (!a || !b) return false
  return a.every((value, index) => Math.abs(value - b[index]) <= tolerance)
}

function compareBackground(design, candidate, options) {
  const expected = design.raw.background
  const actual = candidate.raw.background
  const warnings = []
  if (!expected || !actual) return warnings
  if (expected.kind !== actual.kind) {
    warnings.push({ kind: "background-kind", design: expected.kind, candidate: actual.kind })
    return warnings
  }
  if (expected.kind === "gradient" && expected.direction !== actual.direction) {
    warnings.push({ kind: "background-direction", design: expected.direction, candidate: actual.direction })
  }
  const expectedStops = Array.isArray(expected.stops) ? expected.stops : []
  const actualStops = Array.isArray(actual.stops) ? actual.stops : []
  if (expectedStops.length !== actualStops.length) {
    warnings.push({
      kind: "background-stops",
      design: expectedStops.length,
      candidate: actualStops.length,
    })
  }
  for (const [index, stop] of expectedStops.entries()) {
    const other = actualStops[index]
    if (!other) break
    if (!colorDistanceWithin(stop.color, other.color, options.colorTolerance)) {
      warnings.push({
        kind: "background-stop-colour",
        metric: `stops[${index}]`,
        design: stop.color,
        candidate: other.color,
        tolerance: options.colorTolerance,
      })
    }
  }
  return warnings
}

function comparePalette(design, candidate, options) {
  const expected = Array.isArray(design.raw.palette) ? design.raw.palette : []
  const actual = Array.isArray(candidate.raw.palette) ? candidate.raw.palette : []
  const missing = []
  for (const entry of expected) {
    const color = String(entry?.color ?? "").toUpperCase()
    if (!channelRgb(color)) continue
    if (!actual.some((other) => colorDistanceWithin(color, other?.color, options.colorTolerance))) {
      missing.push({ color, share: entry?.share })
    }
  }
  return { missing }
}

function textRowSummary(probe) {
  const rows = Array.isArray(probe.raw.textRows) ? probe.raw.textRows : []
  return rows
    .map((row) => ({
      y: round(Number(row?.y0) / probe.scale),
      height: round(Number(row?.logicalHeightPx)),
      x: round(Number(row?.x0) / probe.scale),
      width: round((Number(row?.x1) - Number(row?.x0)) / probe.scale),
    }))
    .filter((row) => Number.isFinite(row.y) && Number.isFinite(row.height))
}

/**
 * Text rows are reported, never judged: on the design side a row can be an icon or
 * a highlight circle, and white copy sitting on a dark band is invisible to the
 * row detector on both sides. Using them as pass/fail would enforce the estimator's
 * own error, which is exactly how a 25.2vp "font size" was born in the first place.
 */
function compareTextRows(design, candidate) {
  const expected = textRowSummary(design)
  const actual = textRowSummary(candidate)
  const warnings = []
  for (const row of expected) {
    const match = actual.find((other) => Math.abs(other.y - row.y) <= design.logicalHeight * 0.03)
    if (!match) {
      warnings.push({ kind: "text-row-missing", design: row, candidate: null })
      continue
    }
    const delta = round(match.height - row.height)
    if (row.height > 0 && Math.abs(delta) / row.height > 0.25) {
      warnings.push({
        kind: "text-row-height",
        design: row.height,
        candidate: match.height,
        delta,
        y: row.y,
      })
    }
  }
  for (const row of actual) {
    if (expected.some((other) => Math.abs(other.y - row.y) <= design.logicalHeight * 0.03)) continue
    warnings.push({ kind: "text-row-extra", design: null, candidate: row })
  }
  return warnings
}

function main() {
  const args = parseArgs(process.argv.slice(2))
  if (!args.design) fail("invalid-argument", "--design is required")
  if (!args.candidate) fail("invalid-argument", "--candidate is required")
  if (!args.out) fail("invalid-argument", "--out is required")

  const options = {
    bandTolerance: number(args["band-tolerance"], DEFAULT_BAND_TOLERANCE),
    blockTolerance: number(args["block-tolerance"], DEFAULT_BLOCK_TOLERANCE),
    radiusTolerance: number(args["radius-tolerance"], DEFAULT_RADIUS_TOLERANCE),
    colorTolerance: number(args["color-tolerance"], DEFAULT_COLOR_TOLERANCE),
  }

  const design = loadProbe(args.design, "design probe")
  const candidate = loadProbe(args.candidate, "candidate probe")
  const designWidth = Number(design.logicalWidth)
  const candidateWidth = Number(candidate.logicalWidth)
  if (Number.isFinite(designWidth) && Number.isFinite(candidateWidth) && Math.abs(designWidth - candidateWidth) > 0.5) {
    fail(
      "invalid-input",
      `design and candidate were measured against different logical widths (${designWidth} vs ${candidateWidth}); pass the same --logical-width to visual_probe`,
    )
  }

  const designBoundaries = bandBoundaries(design, "design probe")
  const candidateBoundaries = bandBoundaries(candidate, "candidate probe")
  const bandResult = matchBoundaries(designBoundaries, candidateBoundaries, options.bandTolerance)

  const failures = []
  for (const boundary of bandResult.missing) {
    failures.push({
      kind: "band-boundary-missing",
      metric: `boundary@${boundary.designY}`,
      design: boundary.designY,
      candidate: null,
      tolerance: options.bandTolerance,
    })
  }
  for (const match of bandResult.matches) {
    if (Math.abs(match.deltaNormalized) > options.bandTolerance) {
      failures.push({
        kind: "band-boundary-moved",
        metric: `boundary@${match.designY}`,
        design: match.designY,
        candidate: match.candidateY,
        delta: match.deltaY,
        tolerance: round(options.bandTolerance * design.logicalHeight),
      })
    }
  }
  // An extra boundary in the candidate is just as much a structural deviation
  // as a missing one: it means the implementation introduced a new region that
  // the design does not have.
  for (const boundary of bandResult.extras) {
    failures.push({
      kind: "band-boundary-extra",
      metric: `boundary@${boundary.candidateY}`,
      design: null,
      candidate: boundary.candidateY,
      tolerance: options.bandTolerance,
    })
  }

  const blockResult = compareBlocks(design, candidate, options)
  const warnings = [
    ...blockResult.warnings,
    ...compareBackground(design, candidate, options),
  ]
  const palette = comparePalette(design, candidate, options)
  for (const entry of palette.missing) {
    warnings.push({ kind: "palette-missing", design: entry.color, candidate: null, share: entry.share })
  }
  warnings.push(...compareTextRows(design, candidate))

  const report = {
    schemaVersion: SCHEMA_VERSION,
    design: {
      path: args.design,
      canvas: {
        logicalWidth: design.logicalWidth,
        logicalHeight: design.logicalHeight,
        scale: design.scale,
      },
      sourceSha256: design.raw?.source?.sha256 ?? null,
    },
    candidate: {
      path: args.candidate,
      canvas: {
        logicalWidth: candidate.logicalWidth,
        logicalHeight: candidate.logicalHeight,
        scale: candidate.scale,
      },
      sourceSha256: candidate.raw?.source?.sha256 ?? null,
    },
    tolerances: {
      band: options.bandTolerance,
      block: options.blockTolerance,
      radius: options.radiusTolerance,
      colour: options.colorTolerance,
    },
    bands: {
      designBoundaries: designBoundaries.map((boundary) => boundary.logical),
      candidateBoundaries: candidateBoundaries.map((boundary) => boundary.logical),
      matches: bandResult.matches,
      missing: bandResult.missing,
      extras: bandResult.extras,
    },
    blocks: {
      matched: blockResult.matched,
      unmatchedDesign: blockResult.unmatchedDesign,
      unmatchedCandidate: blockResult.unmatchedCandidate,
    },
    palette: { missing: palette.missing },
    failures,
    warnings,
    failureCount: failures.length,
    warningCount: warnings.length,
    deviationCount: failures.length,
    passed: failures.length === 0,
  }

  mkdirSync(dirname(args.out), { recursive: true })
  writeFileSync(args.out, `${JSON.stringify(report, null, 2)}\n`)
  process.stdout.write(
    `${JSON.stringify({
      out: args.out,
      passed: report.passed,
      failureCount: report.failureCount,
      warningCount: report.warningCount,
      designBoundaries: report.bands.designBoundaries.length,
      candidateBoundaries: report.bands.candidateBoundaries.length,
    })}\n`,
  )
  if (args.strict && !report.passed) process.exit(1)
}

main()
