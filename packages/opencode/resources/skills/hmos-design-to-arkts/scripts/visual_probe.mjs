#!/usr/bin/env node
/**
 * Deterministic, single-pass pixel probe for screenshot design sources.
 *
 * Why this exists
 * ---------------
 * For `others-visual` (and the rendered screenshot of `others-html`) the
 * main model cannot read the image, so every visual fact used to come from one
 * `recognize_ui_components` call. That call returns *estimates*: the font sizes,
 * corner radii and gradients it reports are off by 25-60% in practice, and the
 * contract forbade measuring them any other way. This script is the
 * deterministic counterpart: pure arithmetic over pixels, no model, no guessing.
 *
 * Dependencies (deliberately minimal)
 * -----------------------------------
 * `node` is already mandatory for this workflow - every stage runs
 * `node …/workflow.mjs`. This script therefore adds **no new dependency class
 * and needs nothing installed**:
 *
 *   - PNG                    : decoded natively with `node:zlib`.
 *   - baseline JPEG (SOF0/1) : decoded natively (markers, DQT, DHT, IDCT, 4:2:0).
 *   - progressive JPEG (SOF2): not decodable here; falls through to
 *                              (1) Playwright - already required by the
 *                                  others-html path,
 *                              (2) Python 3 + Pillow - already required by the
 *                                  visual-calibration path,
 *                              (3) otherwise a clear remediation message
 *                                  (re-capture as PNG).
 *
 * Python is therefore **not required** on the normal path: PNG and baseline JPEG
 * both run with zero external tooling. It only appears as the last resort for
 * progressive JPEG on a machine that also lacks Playwright.
 *
 * Design rules (do not relax these)
 * ---------------------------------
 * 1. **One pass, fixed budget.** One decode, one downscale, one luminance pass,
 *    then every measurement reuses those buffers. No recursion over regions, no
 *    re-sampling of a sub-crop, no "keep going until it looks right". The sample
 *    budget is reported in the output and enforced here.
 * 2. **Ratio first.** Everything is measured as a fraction of image width and
 *    then multiplied by the declared logical canvas, so a wrong DPR cannot
 *    distort proportions.
 * 3. **Never invent.** If a measurement is not supported by pixels the field is
 *    `null` / omitted rather than guessed.
 * 4. **Generic.** Any PNG/JPEG screen capture, any design source.
 *
 * Usage
 * -----
 *   node scripts/visual_probe.mjs \
 *     --screenshot <runDir>/source/visual/screenshot.png \
 *     --out <runDir>/stage1/visual-probe.json
 */

import { createHash } from "node:crypto"
import { execFileSync } from "node:child_process"
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { inflateSync } from "node:zlib"

const PROBE_VERSION = "1.0.0"
const SCHEMA_VERSION = 1

/** Analysis resolution: a downscaled copy, so cost does not grow with input size. */
const ANALYSIS_WIDTH = 400

/** Hard cap on analysis samples. Hitting it degrades output, never extends the run. */
const SAMPLE_BUDGET = 6_000_000
const MAX_BANDS = 8
const MAX_TEXT_ROWS = 12
const MAX_BLOCKS = 5
const MAX_PALETTE = 12
const STOP_COUNT = 6
const MIN_BAND_RATIO = 0.05
const BAND_DELTA_THRESHOLD = 40
const CONTENT_CONTRAST = 55
/** Rows thinner than this share of a run's peak density are antialiasing, not glyph. */
const TEXT_TRIM_RATIO = 0.35

const DEFAULT_RELATIVE_PATH = {
  "others-visual": "source/visual/screenshot.png",
  "others-html": "source/html/reference/reference-00.png",
}

const fail = (code, message) => {
  process.stderr.write(`visual_probe: [${code}] ${message}\n`)
  process.exit(code === "unsupported-image-format" ? 3 : 2)
}

const hex = (r, g, b) =>
  `#${[r, g, b].map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, "0")).join("").toUpperCase()}`

const luminance = (r, g, b) => 0.299 * r + 0.587 * g + 0.114 * b

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v)

// ---------------------------------------------------------------------------
// PNG decoding (native, no dependencies)
// ---------------------------------------------------------------------------

const PNG_SIGNATURE = 0x89504e47

function decodePng(buffer) {
  if (buffer.length < 8 || buffer.readUInt32BE(0) !== PNG_SIGNATURE) {
    fail("unsupported-image-format", "not a PNG buffer")
  }
  let offset = 8
  let width = 0
  let height = 0
  let bitDepth = 8
  let colorType = 6
  let interlace = 0
  let palette = null
  const idat = []

  while (offset + 8 <= buffer.length) {
    const length = buffer.readUInt32BE(offset)
    const type = buffer.toString("ascii", offset + 4, offset + 8)
    const dataStart = offset + 8
    const data = buffer.subarray(dataStart, dataStart + length)
    if (type === "IHDR") {
      width = data.readUInt32BE(0)
      height = data.readUInt32BE(4)
      bitDepth = data[8]
      colorType = data[9]
      interlace = data[12]
    } else if (type === "PLTE") {
      palette = data
    } else if (type === "IDAT") {
      idat.push(data)
    } else if (type === "IEND") {
      break
    }
    offset = dataStart + length + 4
  }

  if (!width || !height) fail("unsupported-image-format", "PNG header is incomplete")
  if (interlace !== 0) {
    fail(
      "unsupported-image-format",
      "interlaced PNG is not supported; re-export it without interlacing (or as a baseline JPEG)",
    )
  }
  if (bitDepth !== 8 && bitDepth !== 16) {
    fail(
      "unsupported-image-format",
      `PNG bit depth ${bitDepth} is not supported; re-export as 8-bit RGBA`,
    )
  }

  const channelCount = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[colorType]
  if (!channelCount) {
    fail("unsupported-image-format", `PNG color type ${colorType} is not supported`)
  }
  const sampleBytes = bitDepth === 16 ? 2 : 1
  const bytesPerPixel = channelCount * sampleBytes
  const stride = width * bytesPerPixel

  let raw
  try {
    // The header already bounds the real payload. Without a cap a crafted PNG
    // would inflate into arbitrary memory before the length check below runs.
    raw = inflateSync(Buffer.concat(idat), { maxOutputLength: (stride + 1) * height })
  } catch (error) {
    fail("unsupported-image-format", `PNG image data is corrupt: ${error.message}`)
  }
  if (raw.length < (stride + 1) * height) {
    fail("unsupported-image-format", "PNG image data is truncated")
  }

  // Unfilter into a single contiguous buffer (filters 0-4 of the PNG spec).
  const out = Buffer.alloc(stride * height)
  let position = 0
  for (let y = 0; y < height; y += 1) {
    const filter = raw[position]
    position += 1
    const rowStart = y * stride
    const previousStart = rowStart - stride
    for (let x = 0; x < stride; x += 1) {
      const value = raw[position + x]
      const left = x >= bytesPerPixel ? out[rowStart + x - bytesPerPixel] : 0
      const up = y > 0 ? out[previousStart + x] : 0
      const upLeft = y > 0 && x >= bytesPerPixel ? out[previousStart + x - bytesPerPixel] : 0
      let decoded
      switch (filter) {
        case 0:
          decoded = value
          break
        case 1:
          decoded = value + left
          break
        case 2:
          decoded = value + up
          break
        case 3:
          decoded = value + ((left + up) >> 1)
          break
        case 4: {
          const p = left + up - upLeft
          const pa = Math.abs(p - left)
          const pb = Math.abs(p - up)
          const pc = Math.abs(p - upLeft)
          const predictor = pa <= pb && pa <= pc ? left : pb <= pc ? up : upLeft
          decoded = value + predictor
          break
        }
        default:
          fail("unsupported-image-format", `PNG scanline filter ${filter} is not supported`)
      }
      out[rowStart + x] = decoded & 0xff
    }
    position += stride
  }

  // Expand to RGB (alpha is dropped; screenshots are opaque).
  const rgb = new Uint8Array(width * height * 3)
  for (let i = 0; i < width * height; i += 1) {
    const base = i * bytesPerPixel
    let r
    let g
    let b
    if (colorType === 2 || colorType === 6) {
      r = out[base]
      g = out[base + sampleBytes]
      b = out[base + sampleBytes * 2]
    } else if (colorType === 0 || colorType === 4) {
      r = g = b = out[base]
    } else {
      const index = out[base]
      if (!palette || index * 3 + 2 >= palette.length) {
        fail("unsupported-image-format", "PNG palette entry is missing")
      }
      r = palette[index * 3]
      g = palette[index * 3 + 1]
      b = palette[index * 3 + 2]
    }
    rgb[i * 3] = r
    rgb[i * 3 + 1] = g
    rgb[i * 3 + 2] = b
  }

  return { width, height, rgb }
}

// ---------------------------------------------------------------------------
// Baseline JPEG decoding (native, no dependencies)
//
// Screen captures are frequently JPEG. Rather than requiring Python or a browser
// only to read pixels, baseline (SOF0/SOF1) JPEG is decoded here: markers, DQT,
// DHT, single interleaved scan, restart markers, float IDCT, chroma upsampling.
// Progressive JPEG (SOF2) is rejected with a precise message - it needs a
// multi-scan coefficient pass that is not worth the code for this use case.
// ---------------------------------------------------------------------------

const JPEG_SOI = 0xd8
const ZIGZAG = [
  0, 1, 8, 16, 9, 2, 3, 10, 17, 24, 32, 25, 18, 11, 4, 5, 12, 19, 26, 33, 40, 48, 41, 34, 27, 20, 13, 6, 7, 14, 21,
  28, 35, 42, 49, 56, 57, 50, 43, 36, 29, 22, 15, 23, 30, 37, 44, 51, 58, 59, 52, 45, 38, 31, 39, 46, 53, 60, 61,
  54, 47, 55, 62, 63,
]

/** Precomputed 8x8 cosine basis for the separable inverse DCT. */
const IDCT_COS = (() => {
  const table = new Float64Array(64)
  for (let u = 0; u < 8; u += 1) {
    for (let x = 0; x < 8; x += 1) {
      table[u * 8 + x] = Math.cos(((2 * x + 1) * u * Math.PI) / 16)
    }
  }
  return table
})()

const IDCT_SCALE = (() => {
  const scale = new Float64Array(8)
  scale[0] = 1 / Math.SQRT2
  for (let i = 1; i < 8; i += 1) scale[i] = 1
  return scale
})()

function buildHuffman(bits, values) {
  const table = new Map()
  let code = 0
  let index = 0
  for (let length = 1; length <= 16; length += 1) {
    for (let i = 0; i < bits[length - 1]; i += 1) {
      table.set(`${length}:${code}`, values[index])
      index += 1
      code += 1
    }
    code <<= 1
  }
  return table
}

function unsupportedJpeg(message) {
  throw new Error(`visual_probe:${message}`)
}

function decodeJpeg(buffer) {
  if (buffer[0] !== 0xff || buffer[1] !== JPEG_SOI) unsupportedJpeg("not a JPEG buffer")

  const quantTables = new Map()
  const huffmanTables = new Map()
  let frame = null
  let restartInterval = 0
  let adobeTransform = null
  let scan = null
  let offset = 2

  while (offset < buffer.length) {
    while (offset < buffer.length && buffer[offset] !== 0xff) offset += 1
    while (offset < buffer.length && buffer[offset] === 0xff) offset += 1
    if (offset >= buffer.length) break
    const marker = buffer[offset]
    offset += 1
    if (marker === JPEG_SOI || marker === 0xd9) continue

    const length = buffer.readUInt16BE(offset)
    const segment = buffer.subarray(offset + 2, offset + length)
    offset += length

    if (marker === 0xc0 || marker === 0xc1) {
      frame = { precision: segment[0], height: segment.readUInt16BE(1), width: segment.readUInt16BE(3), components: [] }
      const count = segment[5]
      for (let i = 0; i < count; i += 1) {
        const base = 6 + i * 3
        frame.components.push({
          id: segment[base],
          h: segment[base + 1] >> 4,
          v: segment[base + 1] & 15,
          quant: segment[base + 2],
        })
      }
    } else if (marker === 0xc2) {
      unsupportedJpeg("progressive JPEG is not supported by the built-in decoder")
    } else if (marker === 0xdb) {
      let cursor = 0
      while (cursor < segment.length) {
        const packed = segment[cursor]
        if (packed >> 4 !== 0) unsupportedJpeg("16-bit JPEG quantization tables are not supported")
        const table = new Uint16Array(64)
        for (let i = 0; i < 64; i += 1) table[i] = segment[cursor + 1 + i]
        quantTables.set(packed & 15, table)
        cursor += 65
      }
    } else if (marker === 0xc4) {
      let cursor = 0
      while (cursor < segment.length) {
        const packed = segment[cursor]
        const bits = segment.subarray(cursor + 1, cursor + 17)
        let total = 0
        for (let i = 0; i < 16; i += 1) total += bits[i]
        const values = segment.subarray(cursor + 17, cursor + 17 + total)
        huffmanTables.set(`${packed >> 4}:${packed & 15}`, buildHuffman(bits, values))
        cursor += 17 + total
      }
    } else if (marker === 0xee) {
      if (segment.length >= 12 && segment.toString("latin1", 0, 5) === "Adobe") adobeTransform = segment[11]
    } else if (marker === 0xdd) {
      restartInterval = segment.readUInt16BE(0)
    } else if (marker === 0xda) {
      const components = []
      for (let i = 0; i < segment[0]; i += 1) {
        const base = 1 + i * 2
        components.push({ id: segment[base], dc: segment[base + 1] >> 4, ac: segment[base + 1] & 15 })
      }
      scan = { components, dataStart: offset }
      break
    }
  }

  if (!frame || !scan) unsupportedJpeg("JPEG frame or scan header is missing")
  if (frame.precision !== 8) {
    unsupportedJpeg(`JPEG sample precision ${frame.precision} is not supported`)
  }
  // Only trust shapes this decoder was verified against. Anything exotic (CMYK /
  // 4-component, sampling above 2x2, Adobe APP14 transforms) is delegated to an
  // external converter instead of being silently decoded into subtly wrong
  // pixels - a measurement tool must fail loudly rather than drift quietly.
  if (frame.components.length !== 1 && frame.components.length !== 3) {
    unsupportedJpeg(`${frame.components.length}-component JPEG is not decoded natively`)
  }
  // A scan may carry only some of the frame's components. Decoding the missing
  // ones as zeros turns every pixel green, which is exactly the quiet drift
  // this decoder refuses; hand the file to an external converter instead.
  if (scan.components.length !== frame.components.length) {
    unsupportedJpeg("non-interleaved JPEG scans are not decoded natively")
  }
  if (frame.components.some((component) => component.h < 1 || component.h > 2 || component.v < 1 || component.v > 2)) {
    unsupportedJpeg("JPEG sampling factors above 2x2 are not decoded natively")
  }
  if (adobeTransform === 0 && frame.components.length === 3) {
    unsupportedJpeg("3-component JPEG with Adobe transform=0 stores RGB, not YCbCr")
  }

  // Entropy-coded segment: runs until the next marker that is not byte stuffing.
  const bytes = []
  for (let i = scan.dataStart; i < buffer.length; i += 1) {
    if (buffer[i] !== 0xff) {
      bytes.push(buffer[i])
      continue
    }
    const next = buffer[i + 1]
    if (next === 0x00) {
      bytes.push(0xff)
      i += 1
      continue
    }
    if (next >= 0xd0 && next <= 0xd7) {
      i += 1
      continue
    }
    if (next === 0xff) {
      continue
    }
    break
  }
  const entropy = Uint8Array.from(bytes)
  let bitPosition = 0
  let restartPending = restartInterval

  const readBit = () => {
    if (bitPosition >= entropy.length * 8) throw new Error("visual_probe:jpeg-entropy-truncated")
    const bit = (entropy[bitPosition >> 3] >> (7 - (bitPosition & 7))) & 1
    bitPosition += 1
    return bit
  }
  const readBits = (count) => {
    let value = 0
    for (let i = 0; i < count; i += 1) value = (value << 1) | readBit()
    return value
  }
  const decodeSymbol = (table) => {
    let code = 0
    for (let length = 1; length <= 16; length += 1) {
      code = (code << 1) | readBit()
      const symbol = table.get(`${length}:${code}`)
      if (symbol !== undefined) return symbol
    }
    throw new Error("JPEG Huffman code is invalid")
  }
  const extend = (value, bits) => (value < 1 << (bits - 1) ? value - (1 << bits) + 1 : value)

  const maxH = Math.max(...frame.components.map((component) => component.h))
  const maxV = Math.max(...frame.components.map((component) => component.v))
  const mcuColumns = Math.ceil(frame.width / (maxH * 8))
  const mcuRows = Math.ceil(frame.height / (maxV * 8))

  for (const component of frame.components) {
    component.predictor = 0
    component.rowWidth = mcuColumns * component.h * 8
    component.rowHeight = mcuRows * component.v * 8
    component.plane = new Float64Array(component.rowWidth * component.rowHeight)
  }
  const componentById = new Map(frame.components.map((component) => [component.id, component]))
  const coefficients = new Float64Array(64)
  const intermediate = new Float64Array(64)

  const inverseDct = () => {
    for (let y = 0; y < 8; y += 1) {
      for (let x = 0; x < 8; x += 1) {
        let sum = 0
        for (let u = 0; u < 8; u += 1) sum += IDCT_SCALE[u] * coefficients[y * 8 + u] * IDCT_COS[u * 8 + x]
        intermediate[y * 8 + x] = sum
      }
    }
    for (let x = 0; x < 8; x += 1) {
      for (let y = 0; y < 8; y += 1) {
        let sum = 0
        for (let v = 0; v < 8; v += 1) sum += IDCT_SCALE[v] * intermediate[v * 8 + x] * IDCT_COS[v * 8 + y]
        coefficients[y * 8 + x] = sum / 4
      }
    }
    return coefficients
  }

  for (let mcuY = 0; mcuY < mcuRows; mcuY += 1) {
    for (let mcuX = 0; mcuX < mcuColumns; mcuX += 1) {
      if (restartInterval > 0) {
        if (restartPending === 0) {
          bitPosition = (bitPosition + 7) & ~7
          for (const component of frame.components) component.predictor = 0
          restartPending = restartInterval
        }
        restartPending -= 1
      }
      for (const scanComponent of scan.components) {
        const component = componentById.get(scanComponent.id)
        const dcTable = huffmanTables.get(`0:${scanComponent.dc}`)
        const acTable = huffmanTables.get(`1:${scanComponent.ac}`)
        const quant = quantTables.get(component.quant)
        if (!dcTable || !acTable || !quant) {
          unsupportedJpeg("JPEG references a missing Huffman or quantization table")
        }
        for (let blockY = 0; blockY < component.v; blockY += 1) {
          for (let blockX = 0; blockX < component.h; blockX += 1) {
            coefficients.fill(0)
            const dcLength = decodeSymbol(dcTable)
            if (dcLength > 0) component.predictor += extend(readBits(dcLength), dcLength)
            coefficients[0] = component.predictor * quant[0]
            for (let k = 1; k < 64; k += 1) {
              const symbol = decodeSymbol(acTable)
              if (symbol === 0) break
              const run = symbol >> 4
              const size = symbol & 15
              if (size === 0) {
                if (run !== 15) break
                k += 15
                continue
              }
              k += run
              if (k > 63) break
              coefficients[ZIGZAG[k]] = extend(readBits(size), size) * quant[k]
            }
            const samples = inverseDct()
            const originX = mcuX * component.h * 8 + blockX * 8
            const originY = mcuY * component.v * 8 + blockY * 8
            for (let y = 0; y < 8; y += 1) {
              const row = (originY + y) * component.rowWidth + originX
              for (let x = 0; x < 8; x += 1) component.plane[row + x] = samples[y * 8 + x] + 128
            }
          }
        }
      }
    }
  }

  const rgb = new Uint8Array(frame.width * frame.height * 3)
  const sample = (component, x, y) => {
    const sx = Math.min(component.rowWidth - 1, Math.floor((x * component.h) / maxH))
    const sy = Math.min(component.rowHeight - 1, Math.floor((y * component.v) / maxV))
    return component.plane[sy * component.rowWidth + sx]
  }
  const hasChroma = frame.components.length >= 3
  const lumaComponent = frame.components[0]
  const cbComponent = frame.components[1]
  const crComponent = frame.components[2]
  for (let y = 0; y < frame.height; y += 1) {
    for (let x = 0; x < frame.width; x += 1) {
      const Y = sample(lumaComponent, x, y)
      const Cb = hasChroma ? sample(cbComponent, x, y) - 128 : 0
      const Cr = hasChroma ? sample(crComponent, x, y) - 128 : 0
      const target = (y * frame.width + x) * 3
      rgb[target] = clamp(Y + 1.402 * Cr, 0, 255)
      rgb[target + 1] = clamp(Y - 0.344136 * Cb - 0.714136 * Cr, 0, 255)
      rgb[target + 2] = clamp(Y + 1.772 * Cb, 0, 255)
    }
  }
  return { width: frame.width, height: frame.height, rgb }
}

// ---------------------------------------------------------------------------
// Format conversion for non-PNG inputs (uses only what this workflow may already have)
// ---------------------------------------------------------------------------

async function convertWithPlaywright(source, targetPath, analysisWidth) {
  let chromium
  try {
    ;({ chromium } = await import("playwright"))
  } catch {
    return null
  }
  const browser = await chromium.launch().catch(() => null)
  // The Python converter is the fallback for a missing browser binary or a
  // sandbox that refuses the launch, so a launch failure must not escape as a
  // bare stack before the fallback gets its turn.
  if (!browser) return null
  try {
    const page = await browser.newPage()
    const dataUrl = `data:image/*;base64,${readFileSync(source).toString("base64")}`
    const encoded = await page.evaluate(
      async ({ url, width }) => {
        const image = new Image()
        image.src = url
        await image.decode()
        const scale = Math.min(1, width / image.naturalWidth)
        const canvas = document.createElement("canvas")
        canvas.width = Math.max(1, Math.round(image.naturalWidth * scale))
        canvas.height = Math.max(1, Math.round(image.naturalHeight * scale))
        const context = canvas.getContext("2d")
        context.drawImage(image, 0, 0, canvas.width, canvas.height)
        return {
          width: image.naturalWidth,
          height: image.naturalHeight,
          png: canvas.toDataURL("image/png").split(",")[1],
        }
      },
      { url: dataUrl, width: analysisWidth },
    )
    writeFileSync(targetPath, Buffer.from(encoded.png, "base64"))
    return { sourceWidth: encoded.width, sourceHeight: encoded.height }
  } catch {
    return null
  } finally {
    await browser.close().catch(() => {})
  }
}

function convertWithPython(source, targetPath, analysisWidth) {
  const candidates = process.platform === "win32" ? ["python", "py", "python3"] : ["python3", "python"]
  const sizePath = `${targetPath}.size`
  const script = [
    "import sys",
    "from PIL import Image",
    "src, dst, width, size_out = sys.argv[1], sys.argv[2], int(sys.argv[3]), sys.argv[4]",
    "image = Image.open(src).convert('RGB')",
    "w, h = image.size",
    "scale = min(1.0, width / float(w))",
    "if scale < 1.0:",
    "    image = image.resize((max(1, int(round(w * scale))), max(1, int(round(h * scale)))), Image.BILINEAR)",
    "image.save(dst, format='PNG')",
    "open(size_out, 'w', encoding='utf-8').write('%d %d' % (w, h))",
  ].join("\n")

  for (const executable of candidates) {
    try {
      // stdio is ignored on purpose: the sandbox forbids piping another process,
      // so all communication happens through temporary files.
      execFileSync(executable, ["-c", script, source, targetPath, String(analysisWidth), sizePath], {
        stdio: "ignore",
        timeout: 60_000,
      })
      if (existsSync(targetPath) && existsSync(sizePath)) {
        const [sourceWidth, sourceHeight] = readFileSync(sizePath, "utf8")
          .trim()
          .split(/\s+/)
          .map(Number)
        rmSync(sizePath, { force: true })
        const decoded = decodePng(readFileSync(targetPath))
        return { sourceWidth, sourceHeight, decoded }
      }
    } catch {
      continue
    }
  }
  return null
}

// ---------------------------------------------------------------------------
// Buffers
// ---------------------------------------------------------------------------

function boxDownscale(width, height, rgb, targetWidth) {
  if (width <= targetWidth) {
    return { width, height, rgb, ratio: 1 }
  }
  const ratio = width / targetWidth
  const targetHeight = Math.max(1, Math.round(height / ratio))
  const out = new Uint8Array(targetWidth * targetHeight * 3)
  for (let y = 0; y < targetHeight; y += 1) {
    const y0 = Math.floor(y * ratio)
    const y1 = Math.min(height, Math.max(y0 + 1, Math.floor((y + 1) * ratio)))
    for (let x = 0; x < targetWidth; x += 1) {
      const x0 = Math.floor(x * ratio)
      const x1 = Math.min(width, Math.max(x0 + 1, Math.floor((x + 1) * ratio)))
      let r = 0
      let g = 0
      let b = 0
      let count = 0
      for (let sy = y0; sy < y1; sy += 1) {
        const rowBase = sy * width
        for (let sx = x0; sx < x1; sx += 1) {
          const index = (rowBase + sx) * 3
          r += rgb[index]
          g += rgb[index + 1]
          b += rgb[index + 2]
          count += 1
        }
      }
      const target = (y * targetWidth + x) * 3
      out[target] = Math.round(r / count)
      out[target + 1] = Math.round(g / count)
      out[target + 2] = Math.round(b / count)
    }
  }
  return { width: targetWidth, height: targetHeight, rgb: out, ratio }
}

function buildLuminance(width, height, rgb, budget) {
  budget.spend(width * height)
  const lum = new Float32Array(width * height)
  for (let i = 0, p = 0; i < lum.length; i += 1, p += 3) {
    lum[i] = luminance(rgb[p], rgb[p + 1], rgb[p + 2])
  }
  return lum
}

class Budget {
  constructor(limit) {
    this.limit = limit
    this.used = 0
    this.exhausted = false
  }

  spend(count) {
    if (this.used + count > this.limit) {
      this.exhausted = true
      return false
    }
    this.used += count
    return true
  }
}

// ---------------------------------------------------------------------------
// Measurements
// ---------------------------------------------------------------------------

function probeBackground(width, height, rgb, ratio) {
  const edge = Math.max(1, Math.round(width * 0.02))
  const columns = []
  for (let x = 0; x < edge; x += 1) columns.push(x)
  for (let x = width - edge; x < width; x += 1) if (x >= 0) columns.push(x)

  const stops = []
  for (let index = 0; index < STOP_COUNT; index += 1) {
    const position = index / (STOP_COUNT - 1)
    const y = Math.min(height - 1, Math.round(position * (height - 1)))
    let r = 0
    let g = 0
    let b = 0
    for (const x of columns) {
      const offset = (y * width + x) * 3
      r += rgb[offset]
      g += rgb[offset + 1]
      b += rgb[offset + 2]
    }
    stops.push({
      position: Number(position.toFixed(4)),
      color: hex(r / columns.length, g / columns.length, b / columns.length),
      y: Math.round(y * ratio),
    })
  }

  const channelRgb = (value) => [
    parseInt(value.slice(1, 3), 16),
    parseInt(value.slice(3, 5), 16),
    parseInt(value.slice(5, 7), 16),
  ]
  const first = luminance(...channelRgb(stops[0].color))
  const last = luminance(...channelRgb(stops[stops.length - 1].color))
  const deltaL = Math.abs(last - first)

  const mid = Math.floor(height / 2)
  const leftOffset = (mid * width + Math.max(0, Math.floor(edge / 2))) * 3
  const rightOffset = (mid * width + Math.max(0, width - 1 - Math.floor(edge / 2))) * 3
  const horizontalDeltaL = Math.abs(
    luminance(rgb[leftOffset], rgb[leftOffset + 1], rgb[leftOffset + 2]) -
      luminance(rgb[rightOffset], rgb[rightOffset + 1], rgb[rightOffset + 2]),
  )

  let kind = "unknown"
  let direction = "unknown"
  if (deltaL < 6 && horizontalDeltaL < 6) {
    kind = "solid"
    direction = "none"
  } else if (horizontalDeltaL > deltaL) {
    kind = "gradient"
    direction = "horizontal"
  } else if (deltaL >= 6) {
    kind = "gradient"
    direction = "vertical"
  }

  if (kind === "solid") {
    const average = [0, 0, 0]
    for (const stop of stops) {
      const channels = channelRgb(stop.color)
      for (let i = 0; i < 3; i += 1) average[i] += channels[i]
    }
    return {
      kind,
      direction,
      stops: [{ position: 0, color: hex(average[0] / stops.length, average[1] / stops.length, average[2] / stops.length), y: 0 }],
      deltaL: Number(deltaL.toFixed(2)),
      horizontalDeltaL: Number(horizontalDeltaL.toFixed(2)),
    }
  }

  return {
    kind,
    direction,
    stops,
    deltaL: Number(deltaL.toFixed(2)),
    horizontalDeltaL: Number(horizontalDeltaL.toFixed(2)),
  }
}

function probeBands(width, height, rgb, ratio, physicalHeight) {
  const stepX = Math.max(1, Math.floor(width / 120))
  const means = []
  for (let y = 0; y < height; y += 1) {
    let r = 0
    let g = 0
    let b = 0
    let count = 0
    for (let x = 0; x < width; x += stepX) {
      const offset = (y * width + x) * 3
      r += rgb[offset]
      g += rgb[offset + 1]
      b += rgb[offset + 2]
      count += 1
    }
    means.push([r / count, g / count, b / count])
  }

  const deltas = []
  for (let y = 1; y < height; y += 1) {
    const delta =
      Math.abs(means[y][0] - means[y - 1][0]) +
      Math.abs(means[y][1] - means[y - 1][1]) +
      Math.abs(means[y][2] - means[y - 1][2])
    if (delta >= BAND_DELTA_THRESHOLD) deltas.push([delta, y])
  }
  deltas.sort((a, b) => b[0] - a[0])

  const minGap = Math.max(6, Math.round(height * MIN_BAND_RATIO))
  const boundaries = []
  for (const [, y] of deltas) {
    if (boundaries.every((kept) => Math.abs(y - kept) >= minGap)) boundaries.push(y)
    if (boundaries.length >= MAX_BANDS - 1) break
  }
  boundaries.sort((a, b) => a - b)

  // Merge bands that are too thin to be a real region: drop the boundary that
  // separates the thinnest band from its neighbour.
  const minHeight = Math.max(4, Math.round(height * MIN_BAND_RATIO))
  let edges = [0, ...boundaries, height]
  let changed = true
  while (changed && edges.length > 2) {
    changed = false
    for (let i = 1; i < edges.length - 1; i += 1) {
      const below = edges[i] - edges[i - 1]
      const above = edges[i + 1] - edges[i]
      if (below < minHeight || above < minHeight) {
        edges.splice(i, 1)
        changed = true
        break
      }
    }
  }

  const bands = []
  for (let i = 0; i < edges.length - 1; i += 1) {
    const y0 = edges[i]
    const y1 = edges[i + 1]
    if (y1 <= y0) continue
    bands.push({
      index: bands.length,
      y0: Math.round(y0 * ratio),
      y1: Math.round((y1 - 1) * ratio),
      heightRatio: Number(((y1 - y0) / height).toFixed(4)),
      evidence: "row-mean-colour-transition",
    })
  }
  if (bands.length > 0) {
    bands[0].y0 = 0
    bands[bands.length - 1].y1 = physicalHeight - 1
    const total = bands.reduce((sum, band) => sum + band.heightRatio, 0) || 1
    for (const band of bands) band.heightRatio = Number((band.heightRatio / total).toFixed(4))
  }
  return bands
}

function probeTextRows(width, height, lum, bands, ratio, scale) {
  const found = []
  const gapTolerance = Math.max(1, Math.round(height * 0.006))
  const maxRun = Math.max(6, Math.round(height * 0.05))

  for (const band of bands) {
    const y0 = clamp(Math.round(band.y0 / ratio), 0, height - 1)
    const y1 = clamp(Math.round(band.y1 / ratio) + 1, y0 + 1, height)
    const samples = []
    for (let y = y0; y < y1; y += 1) {
      for (let x = 0; x < width; x += 4) samples.push(lum[y * width + x])
    }
    if (samples.length === 0) continue
    samples.sort((a, b) => a - b)
    const median = samples[Math.floor(samples.length / 2)]

    let run = null
    let blank = 0
    for (let y = y0; y < y1; y += 1) {
      let hits = 0
      let first = -1
      let last = -1
      for (let x = 0; x < width; x += 2) {
        if (Math.abs(lum[y * width + x] - median) > CONTENT_CONTRAST) {
          hits += 1
          if (first < 0) first = x
          last = x
        }
      }
      const isContent = hits >= 3
      if (isContent) {
        blank = 0
        if (!run) run = { rows: [{ y, hits, first, last }], x0: first, x1: last }
        else {
          run.rows.push({ y, hits, first, last })
          run.x0 = Math.min(run.x0, first)
          run.x1 = Math.max(run.x1, last)
        }
        continue
      }
      if (run) {
        blank += 1
        if (blank > gapTolerance || y - run.rows[0].y > maxRun) {
          found.push(run)
          run = null
          blank = 0
        }
      }
    }
    if (run) found.push(run)
  }

  const textRows = []
  for (const run of found) {
    // Trim antialiased edges: keep only rows whose ink density is a decent share
    // of the run's peak. Without this the glyph box overshoots the font size.
    const peak = Math.max(...run.rows.map((row) => row.hits))
    const dense = run.rows.filter((row) => row.hits >= peak * TEXT_TRIM_RATIO)
    if (dense.length === 0) continue
    const runHeight = dense[dense.length - 1].y - dense[0].y + 1
    if (runHeight < 4 || runHeight > Math.round(height * 0.08)) continue
    const heightPx = runHeight * ratio
    textRows.push({
      y0: Math.round(dense[0].y * ratio),
      y1: Math.round(dense[dense.length - 1].y * ratio),
      x0: Math.round(Math.min(...dense.map((row) => row.first)) * ratio),
      x1: Math.round(Math.max(...dense.map((row) => row.last)) * ratio),
      heightPx: Math.round(heightPx),
      logicalHeightPx: Number((heightPx / scale).toFixed(1)),
    })
  }
  textRows.sort((a, b) => a.y0 - b.y0)

  const ranked = [...textRows].sort((a, b) => b.logicalHeightPx - a.logicalHeightPx)
  const largest = ranked[0]
  for (const [rank, row] of ranked.entries()) {
    if (rank === 0) row.roleHint = "largest-text"
    else if (largest && row.logicalHeightPx >= largest.logicalHeightPx * 0.75) row.roleHint = "section-title"
    else row.roleHint = "body-or-caption"
  }
  return textRows.slice(0, MAX_TEXT_ROWS)
}

function probeBlocks(width, height, lum, ratio, scale, budget) {
  const step = Math.max(4, Math.floor(width / 80))
  const gridWidth = Math.max(1, Math.floor(width / step))
  const gridHeight = Math.max(1, Math.floor(height / step))
  if (!budget.spend(gridWidth * gridHeight * step * step)) return []

  const samples = []
  for (let gy = 0; gy < gridHeight; gy += 1) {
    const y = Math.min(height - 1, gy * step + (step >> 1))
    for (let gx = 0; gx < gridWidth; gx += 1) {
      const x = Math.min(width - 1, gx * step + (step >> 1))
      samples.push(lum[y * width + x])
    }
  }
  samples.sort((a, b) => a - b)
  const median = samples[Math.floor(samples.length / 2)]

  const contentCells = new Set()
  for (let gy = 0; gy < gridHeight; gy += 1) {
    const y = Math.min(height - 1, gy * step + (step >> 1))
    for (let gx = 0; gx < gridWidth; gx += 1) {
      const x = Math.min(width - 1, gx * step + (step >> 1))
      if (Math.abs(lum[y * width + x] - median) > CONTENT_CONTRAST) contentCells.add(gy * gridWidth + gx)
    }
  }

  const visited = new Set()
  const components = []
  const MAX_COMPONENTS = 40
  for (const cell of [...contentCells].sort((a, b) => a - b)) {
    if (visited.has(cell) || components.length >= MAX_COMPONENTS) continue
    const queue = [cell]
    visited.add(cell)
    const members = []
    while (queue.length > 0 && members.length < 4000) {
      const current = queue.pop()
      members.push(current)
      const gx = current % gridWidth
      const gy = Math.floor(current / gridWidth)
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const nx = gx + dx
        const ny = gy + dy
        if (nx < 0 || ny < 0 || nx >= gridWidth || ny >= gridHeight) continue
        const neighbour = ny * gridWidth + nx
        if (contentCells.has(neighbour) && !visited.has(neighbour)) {
          visited.add(neighbour)
          queue.push(neighbour)
        }
      }
    }
    if (members.length < 6) continue
    const xs = members.map((value) => value % gridWidth)
    const ys = members.map((value) => Math.floor(value / gridWidth))
    components.push({
      size: members.length,
      left: Math.max(0, Math.min(...xs) * step),
      right: Math.min(width - 1, (Math.max(...xs) + 1) * step),
      top: Math.max(0, Math.min(...ys) * step),
      bottom: Math.min(height - 1, (Math.max(...ys) + 1) * step),
    })
  }

  // Keep the largest few rectangles; a component that spans nearly the whole
  // canvas is the background gradient, not a shape worth measuring.
  const blocks = []
  for (const component of components.sort((a, b) => b.size - a.size).slice(0, MAX_BLOCKS * 2)) {
    const boxWidth = component.right - component.left
    const boxHeight = component.bottom - component.top
    if (boxWidth < 6 || boxHeight < 6) continue
    if (boxWidth > width * 0.95 && boxHeight > height * 0.3) continue
    const radius = estimateRadius(width, lum, component.left, component.top, component.right, component.bottom)
    blocks.push({
      x0: Math.round(component.left * ratio),
      y0: Math.round(component.top * ratio),
      x1: Math.round(component.right * ratio),
      y1: Math.round(component.bottom * ratio),
      radiusPx: radius === null ? null : Math.round(radius * ratio),
      logicalRadiusPx: radius === null ? null : Number(((radius * ratio) / scale).toFixed(1)),
      confidence: radius === null ? "low" : "medium",
    })
    if (blocks.length >= MAX_BLOCKS) break
  }
  blocks.sort((a, b) => a.y0 - b.y0 || a.x0 - b.x0)
  return blocks
}

/**
 * Corner radius of a rectangle's top-left corner, in work pixels.
 * For a rounded corner the left edge keeps moving left as we walk down; the row
 * where it settles is the radius. Returns null when no rounded corner is visible.
 */
function estimateRadius(width, lum, left, top, right, bottom) {
  const limit = Math.min(bottom - top, Math.max(4, Math.round((bottom - top) * 0.35)), 44)
  const outside = lum[top * width + Math.max(0, left - 2)]
  let best = null
  let settled = null
  for (let offset = 0; offset < limit; offset += 1) {
    const y = top + offset
    if (y > bottom) break
    let hit = null
    for (let x = left; x <= Math.min(right, left + limit + 1); x += 1) {
      if (Math.abs(lum[y * width + x] - outside) > CONTENT_CONTRAST) {
        hit = x
        break
      }
    }
    if (hit === null) continue
    if (best === null) best = hit
    else if (hit < best - 1) best = hit
    else {
      settled = offset
      break
    }
  }
  if (settled === null || settled < 2) return null
  return settled
}

function probePalette(width, height, rgb, budget) {
  if (!budget.spend(width * height)) return []
  const counts = new Map()
  for (let i = 0; i < width * height; i += 1) {
    const offset = i * 3
    const key = ((rgb[offset] >> 3) << 10) | ((rgb[offset + 1] >> 3) << 5) | (rgb[offset + 2] >> 3)
    counts.set(key, (counts.get(key) ?? 0) + 1)
  }
  const total = width * height
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, MAX_PALETTE)
    .map(([key, count]) => ({
      color: hex((key >> 10) << 3, ((key >> 5) & 31) << 3, (key & 31) << 3),
      share: Number((count / total).toFixed(4)),
    }))
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const result = {}
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]
    if (!token.startsWith("--")) fail("invalid-argument", `unexpected argument: ${token}`)
    const key = token.slice(2)
    const value = argv[index + 1]
    if (value === undefined || value.startsWith("--")) fail("invalid-argument", `${key} needs a value`)
    result[key] = value
    index += 1
  }
  return result
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  if (!args.screenshot) fail("invalid-argument", "--screenshot is required")
  if (!args.out) fail("invalid-argument", "--out is required")
  const designSource = args["design-source"] ?? "others-visual"
  if (!DEFAULT_RELATIVE_PATH[designSource]) {
    fail("invalid-argument", `unsupported --design-source: ${designSource}`)
  }
  const logicalWidth = Number(args["logical-width"] ?? 360)
  if (!Number.isInteger(logicalWidth) || logicalWidth < 200 || logicalWidth > 2000) {
    fail("invalid-argument", "--logical-width must be an integer between 200 and 2000")
  }
  const relativePath = args["relative-path"] ?? DEFAULT_RELATIVE_PATH[designSource]
  const screenshotPath = resolve(args.screenshot)
  const outPath = resolve(args.out)

  const started = new Date()
  const clock = process.hrtime.bigint()
  const budget = new Budget(SAMPLE_BUDGET)

  if (!existsSync(screenshotPath)) fail("invalid-input", `screenshot not found: ${screenshotPath}`)
  const fileBuffer = readFileSync(screenshotPath)
  // Guard against oversized inputs before any decoding happens: a crafted or
  // simply huge image must not exhaust memory in the decode path.
  const MAX_INPUT_BYTES = 64 * 1024 * 1024
  if (fileBuffer.length > MAX_INPUT_BYTES) {
    fail("invalid-input", `screenshot is too large (${fileBuffer.length} bytes, max ${MAX_INPUT_BYTES}); downscale it first`)
  }
  const sha256 = createHash("sha256").update(fileBuffer).digest("hex")

  const isPng = fileBuffer.length > 8 && fileBuffer.readUInt32BE(0) === PNG_SIGNATURE
  const isJpeg = fileBuffer.length > 3 && fileBuffer[0] === 0xff && fileBuffer[1] === 0xd8 && fileBuffer[2] === 0xff
  if (!isPng && !isJpeg) {
    fail(
      "unsupported-image-format",
      "only PNG and JPEG are supported; re-export the screenshot as PNG (preferred) or JPEG",
    )
  }

  let physicalWidth
  let physicalHeight
  let work
  const MAX_TOTAL_PIXELS = 100_000_000
  if (isPng) {
    const decoded = decodePng(fileBuffer)
    physicalWidth = decoded.width
    physicalHeight = decoded.height
    if (physicalWidth * physicalHeight > MAX_TOTAL_PIXELS) {
      fail("invalid-input", `screenshot is too large (${physicalWidth}x${physicalHeight} = ${physicalWidth * physicalHeight} pixels, max ${MAX_TOTAL_PIXELS}); downscale it first`)
    }
    work = boxDownscale(decoded.width, decoded.height, decoded.rgb, ANALYSIS_WIDTH)
  } else {
    // Native baseline decoder first: it needs nothing installed. Only fall back
    // to external tools when the file is progressive JPEG or otherwise exotic.
    let decoded = null
    let nativeError = null
    try {
      decoded = decodeJpeg(fileBuffer)
      physicalWidth = decoded.width
      physicalHeight = decoded.height
    } catch (error) {
      // Any decoder limitation (progressive, exotic sampling, corrupt tail) falls
      // through to the external converters below instead of failing the probe.
      nativeError = error
      decoded = null
    }
    if (decoded) {
      if (physicalWidth * physicalHeight > MAX_TOTAL_PIXELS) {
        fail("invalid-input", `screenshot is too large (${physicalWidth}x${physicalHeight} = ${physicalWidth * physicalHeight} pixels, max ${MAX_TOTAL_PIXELS}); downscale it first`)
      }
      work = boxDownscale(decoded.width, decoded.height, decoded.rgb, ANALYSIS_WIDTH)
    } else {
      const converted = `${outPath}.work.png`
      mkdirSync(dirname(outPath), { recursive: true })
      let metadata = await convertWithPlaywright(screenshotPath, converted, ANALYSIS_WIDTH)
      let playwrightError = null
      if (!metadata) {
        try {
          metadata = convertWithPython(screenshotPath, converted, ANALYSIS_WIDTH)
        } catch (error) {
          playwrightError = error
        }
      }
      if (!metadata) {
        const reasons = [nativeError?.message, playwrightError?.message].filter(Boolean).join('; ')
        fail(
          "unsupported-image-format",
          "this JPEG needs one of: (1) a PNG re-capture (hdc snapshot_display -f shot.png), " +
            "(2) Playwright - already required by the others-html path, " +
            "(3) Python 3 with Pillow - already required by the visual-calibration path." +
            (reasons ? ` (causes: ${reasons})` : ''),
        )
      }
      physicalWidth = metadata.sourceWidth
      physicalHeight = metadata.sourceHeight
      if (physicalWidth * physicalHeight > MAX_TOTAL_PIXELS) {
        fail("invalid-input", `screenshot is too large (${physicalWidth}x${physicalHeight} = ${physicalWidth * physicalHeight} pixels, max ${MAX_TOTAL_PIXELS}); downscale it first`)
      }
      const convertedPng = metadata.decoded ?? decodePng(readFileSync(converted))
      rmSync(converted, { force: true })
      work = boxDownscale(convertedPng.width, convertedPng.height, convertedPng.rgb, ANALYSIS_WIDTH)
      // The converters already shrink the source to ANALYSIS_WIDTH, so the
      // downscale above is a no-op and reports ratio 1. The physical scale is
      // the converter's own factor: without it every downstream coordinate
      // stayed in analysis pixels while the canvas claimed the original size,
      // and the last band was pinned to physicalHeight next to analysis-sized
      // bands.
      work.ratio = (physicalWidth / work.width) * work.ratio
    }
  }

  const lum = buildLuminance(work.width, work.height, work.rgb, budget)

  let scale
  let scaleRule
  let logicalWidthOut
  if (physicalWidth <= 480) {
    logicalWidthOut = physicalWidth
    scale = 1
    scaleRule = "native-1x"
  } else {
    logicalWidthOut = logicalWidth
    scale = physicalWidth / logicalWidth
    scaleRule = "declared-logical-width"
  }
  const logicalHeight = Math.round(physicalHeight / scale)

  const background = probeBackground(work.width, work.height, work.rgb, work.ratio)
  const bands = probeBands(work.width, work.height, work.rgb, work.ratio, physicalHeight)
  const textRows = probeTextRows(work.width, work.height, lum, bands, work.ratio, scale)
  const blocks = probeBlocks(work.width, work.height, lum, work.ratio, scale, budget)
  const palette = probePalette(work.width, work.height, work.rgb, budget)

  const payload = {
    schemaVersion: SCHEMA_VERSION,
    designSource,
    producer: { tool: "visual_probe", runtime: "node", version: PROBE_VERSION, createdAt: started.toISOString() },
    source: {
      path: relativePath,
      sha256,
      size: fileBuffer.length,
      format: isPng ? "PNG" : "JPEG",
    },
    canvas: {
      physicalWidth,
      physicalHeight,
      logicalWidth: logicalWidthOut,
      logicalHeight,
      scale: Number(scale.toFixed(4)),
      scaleRule,
      analysisWidth: work.width,
    },
    budget: {
      sampleBudget: SAMPLE_BUDGET,
      totalSamples: budget.used,
      withinBudget: !budget.exhausted,
      passes: 1,
      elapsedMs: Number((Number(process.hrtime.bigint() - clock) / 1e6).toFixed(0)),
    },
    background,
    bands,
    textRows,
    blocks,
    palette,
    limits: {
      bands: MAX_BANDS,
      textRows: MAX_TEXT_ROWS,
      blocks: MAX_BLOCKS,
      palette: MAX_PALETTE,
      stops: STOP_COUNT,
    },
  }

  mkdirSync(dirname(outPath), { recursive: true })
  writeFileSync(outPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8")
  process.stdout.write(
    `${JSON.stringify({
      out: outPath,
      format: payload.source.format,
      canvas: [physicalWidth, physicalHeight],
      logical: [logicalWidthOut, logicalHeight],
      scale: payload.canvas.scale,
      bands: bands.length,
      textRows: textRows.length,
      blocks: blocks.length,
      samples: budget.used,
      elapsedMs: payload.budget.elapsedMs,
    })}\n`,
  )
}

await main()
