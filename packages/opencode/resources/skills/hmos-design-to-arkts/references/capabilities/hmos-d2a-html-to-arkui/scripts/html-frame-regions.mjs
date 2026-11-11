#!/usr/bin/env node
// Region-level visual inspection for the others-html path.
//
// Compares the staged reference frame against the device screenshot and writes
// a machine-checkable region list instead of a score:
//
//   <out>/stage5/regions.json                    regions + alignment + bands + producer
//   <out>/stage5/regions-sheet-reference.png     numbered crops of every region (reference)
//   <out>/stage5/regions-sheet-candidate.png     numbered crops of every region (candidate)
//
// Usage:
//   node scripts/html-frame-regions.mjs --reference <png> --candidate <png|jpg> \
//        --facts <layout-facts.json> --out <runDir>
//        [--gesture-luma 12] [--min-area 0.005] [--min-mean 24] [--min-peak 80]
//        [--min-cluster 0.0005] [--block 8] [--align-y 6] [--align-x 3]
//
// Probe mode — point color sampling for stage-5 investigations. It measures
// and reports; it never blocks:
//   node scripts/html-frame-regions.mjs --reference <png> --candidate <png> \
//        --facts <layout-facts.json> --points <points.json>
//        [--density <px-per-vp>] [--sample-radius 2] [--out <runDir>]
// --out persists the readings to <runDir>/stage5/probe-<points-name>.json so a
// triage can cite them; regions.json additionally carries per-region
// peakCluster (where the strongest differences sit) and probeGridVp (the
// cluster / bbox-grid / flat-wash points the script says to measure).
// points.json is a JSON array of { "name": "...", "x": 80, "y": 274 } with
// x/y in design vp. By default the candidate is sampled in reference space
// with the measured alignment shift applied; --density samples the original
// candidate pixels at vp*density without the shift — use that to prove what
// the device actually rendered (rendering fallbacks, black-filled shapes).
//
// Every number in regions.json is computed here; the agent never writes it.
// The script performs no judgement: it only says where pixels differ and which
// measured nodes sit in each region.
//
// Playwright is an optional environment dependency. It is guaranteed to exist
// when the HTML path reached stage 5 (stage 1 capture uses it), but this script
// never installs anything: on missing dependencies it prints the official hint
// and exits 1 so the caller can block with dependency_unavailable.
//
// Exit codes:
//   0 = regions written
//   1 = dependency missing or runtime failure
//   2 = invalid input (bad args, unreadable facts, alignment guard tripped)
//   3 = unsupported image format

const [, , ...argv] = process.argv;

function readArg(name, fallback) {
  const index = argv.indexOf(`--${name}`);
  if (index === -1) return fallback;
  const value = argv[index + 1];
  if (value === undefined || value.startsWith('--')) {
    console.error(`missing value for --${name}`);
    process.exit(2);
  }
  return value;
}

function numberArg(name, fallback) {
  const raw = readArg(name, String(fallback));
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) {
    console.error(`invalid --${name}: ${raw}`);
    process.exit(2);
  }
  return value;
}

const referencePath = readArg('reference', null);
const candidatePath = readArg('candidate', null);
const factsPath = readArg('facts', null);
const pointsPath = readArg('points', null);
const densityRaw = readArg('density', null);
const density = densityRaw === null ? 0 : Number(densityRaw);
if (densityRaw !== null && (!Number.isFinite(density) || density <= 0)) {
  console.error(`invalid --density: ${densityRaw}`);
  process.exit(2);
}
const sampleRadius = Math.round(numberArg('sample-radius', 2));
const outDir = readArg('out', null);
if (pointsPath === null && density !== 0) {
  console.error('--density only applies to probe mode (--points)');
  process.exit(2);
}
if (!referencePath || !candidatePath || !factsPath || (!pointsPath && !outDir)) {
  console.error(
    'usage: node scripts/html-frame-regions.mjs --reference <png> --candidate <png|jpg> --facts <layout-facts.json> --out <runDir>'
  );
  if (pointsPath) {
    console.error(
      'probe usage: node scripts/html-frame-regions.mjs --reference <png> --candidate <png> --facts <layout-facts.json> --points <points.json> [--density <px-per-vp>] [--sample-radius 2] [--out <runDir>]'
    );
  }
  process.exit(2);
}

const gestureLumaThreshold = numberArg('gesture-luma', 12);
const minAreaRatio = numberArg('min-area', 0.005);
const minMeanDelta = numberArg('min-mean', 24);
const minPeakDelta = numberArg('min-peak', 80);
const minPeakClusterRatio = numberArg('min-cluster', 0.0005);
const blockSize = Math.round(numberArg('block', 8));
const alignY = Math.round(numberArg('align-y', 6));
const alignX = Math.round(numberArg('align-x', 3));

// A block joins the connected-component walk at a lower bar than the region
// acceptance bar: the walk decides the extent, the acceptance decides whether
// the region is worth reporting.
const blockMeanFloor = 12;
const blockPeakFloor = 32;
// A flat reference wash that differs on the candidate is a defect (the
// frosted-bar blob class), not photo noise, so flat blocks get their own
// probe points in the region output.
const flatChannelRange = 10;

const { basename, resolve, join } = await import('node:path');
const { mkdir, writeFile, readFile } = await import('node:fs/promises');
const { createHash } = await import('node:crypto');
const { inflateSync } = await import('node:zlib');

function sha256(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

function relOut(absolutePath) {
  const relative = resolve(absolutePath).slice(resolve(outDir).length + 1);
  return relative.split('\\').join('/');
}

let chromium;
try {
  ({ chromium } = await import('playwright'));
} catch {
  // Only the JPEG fallback needs the browser; PNG-only runs (including every
  // probe) must work without it. The dependency error surfaces exactly when a
  // JPEG actually reaches jpegToPng.
  chromium = null;
}

function decodePng(buffer) {
  if (buffer.length < 8 || buffer[0] !== 0x89 || buffer[1] !== 0x50 || buffer[2] !== 0x4e || buffer[3] !== 0x47) {
    return null;
  }
  let position = 8;
  let header = null;
  const idat = [];
  while (position + 8 <= buffer.length) {
    const length = buffer.readUInt32BE(position);
    const type = buffer.toString('ascii', position + 4, position + 8);
    const data = buffer.subarray(position + 8, position + 8 + length);
    if (type === 'IHDR') {
      header = {
        width: data.readUInt32BE(0),
        height: data.readUInt32BE(4),
        bitDepth: data[8],
        colorType: data[9],
        interlace: data[12]
      };
    } else if (type === 'IDAT') {
      idat.push(data);
    } else if (type === 'IEND') {
      break;
    }
    position += 12 + length;
  }
  if (!header) {
    return null;
  }
  const channels = header.colorType === 6 ? 4 : header.colorType === 2 ? 3 : header.colorType === 0 ? 1 : 0;
  if (header.bitDepth !== 8 || header.interlace !== 0 || channels === 0) {
    console.error(
      `unsupported png variant: bitDepth=${header.bitDepth} colorType=${header.colorType} interlace=${header.interlace}`
    );
    process.exit(3);
  }
  const raw = inflateSync(Buffer.concat(idat));
  const stride = header.width * channels;
  const rgba = Buffer.alloc(header.width * header.height * 4);
  let previous = Buffer.alloc(stride);
  for (let y = 0; y < header.height; y += 1) {
    const filter = raw[y * (stride + 1)];
    const line = Buffer.from(raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1)));
    for (let x = 0; x < stride; x += 1) {
      const left = x >= channels ? line[x - channels] : 0;
      const up = previous[x];
      const upLeft = x >= channels ? previous[x - channels] : 0;
      if (filter === 1) line[x] = (line[x] + left) & 0xff;
      else if (filter === 2) line[x] = (line[x] + up) & 0xff;
      else if (filter === 3) line[x] = (line[x] + ((left + up) >> 1)) & 0xff;
      else if (filter === 4) {
        const p = left + up - upLeft;
        const pa = Math.abs(p - left);
        const pb = Math.abs(p - up);
        const pc = Math.abs(p - upLeft);
        const predictor = pa <= pb && pa <= pc ? left : pb <= pc ? up : upLeft;
        line[x] = (line[x] + predictor) & 0xff;
      }
    }
    for (let x = 0; x < header.width; x += 1) {
      const source = x * channels;
      const target = (y * header.width + x) * 4;
      if (channels === 1) {
        rgba[target] = line[source];
        rgba[target + 1] = line[source];
        rgba[target + 2] = line[source];
        rgba[target + 3] = 255;
      } else {
        rgba[target] = line[source];
        rgba[target + 1] = line[source + 1];
        rgba[target + 2] = line[source + 2];
        rgba[target + 3] = channels === 4 ? line[source + 3] : 255;
      }
    }
    previous = line;
  }
  return { width: header.width, height: header.height, data: rgba };
}

// JPEG never reaches a decoder of our own: the browser decodes it (baseline and
// progressive alike, colour profiles included) and hands back lossless pixels.
async function jpegToPng(buffer) {
  if (!chromium) {
    console.error('playwright is not installed in this environment; cannot convert a JPEG candidate.');
    console.error('install the optional dependency and retry:');
    console.error('  npm install --no-save playwright');
    console.error('  npx playwright install chromium');
    console.error('or re-capture the candidate as PNG (snapshot_display -t png).');
    process.exit(1);
  }
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    const dataUrl = 'data:image/jpeg;base64,' + buffer.toString('base64');
    const pngBase64 = await page.evaluate(async (url) => {
      const image = new Image();
      image.src = url;
      await image.decode();
      const canvas = document.createElement('canvas');
      canvas.width = image.naturalWidth;
      canvas.height = image.naturalHeight;
      canvas.getContext('2d').drawImage(image, 0, 0);
      return canvas.toDataURL('image/png').split(',')[1];
    }, dataUrl);
    return Buffer.from(pngBase64, 'base64');
  } finally {
    await browser.close();
  }
}

async function loadImage(path) {
  const buffer = await readFile(path);
  const direct = decodePng(buffer);
  if (direct) {
    return { image: direct, pngBytes: buffer, converted: false, sourceSha256: sha256(buffer) };
  }
  if (buffer.length > 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    const pngBytes = await jpegToPng(buffer);
    const converted = decodePng(pngBytes);
    if (!converted) {
      console.error(`could not decode the jpeg conversion of ${path}`);
      process.exit(3);
    }
    return { image: converted, pngBytes, converted: true, sourceSha256: sha256(buffer) };
  }
  console.error(`unsupported image format: ${path}`);
  process.exit(3);
}

function resizeRgba(source, sourceWidth, sourceHeight, targetWidth, targetHeight) {
  const target = Buffer.alloc(targetWidth * targetHeight * 4);
  for (let y = 0; y < targetHeight; y += 1) {
    const startY = Math.floor((y * sourceHeight) / targetHeight);
    const endY = Math.max(startY + 1, Math.floor(((y + 1) * sourceHeight) / targetHeight));
    for (let x = 0; x < targetWidth; x += 1) {
      const startX = Math.floor((x * sourceWidth) / targetWidth);
      const endX = Math.max(startX + 1, Math.floor(((x + 1) * sourceWidth) / targetWidth));
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      let count = 0;
      for (let sy = startY; sy < endY; sy += 1) {
        for (let sx = startX; sx < endX; sx += 1) {
          const index = (sy * sourceWidth + sx) * 4;
          r += source[index];
          g += source[index + 1];
          b += source[index + 2];
          a += source[index + 3];
          count += 1;
        }
      }
      const target4 = (y * targetWidth + x) * 4;
      target[target4] = Math.round(r / count);
      target[target4 + 1] = Math.round(g / count);
      target[target4 + 2] = Math.round(b / count);
      target[target4 + 3] = Math.round(a / count);
    }
  }
  return target;
}

const facts = JSON.parse(await readFile(factsPath, 'utf8'));
const factsBuffer = await readFile(factsPath);
const render = facts?.render ?? {};
const logicalWidth = Number(render?.canvas?.logicalWidth ?? render?.viewport?.width ?? 0);
const logicalHeight = Number(render?.canvas?.logicalHeight ?? render?.viewport?.height ?? 0);
if (!(logicalWidth > 0) || !(logicalHeight > 0)) {
  console.error('layout facts carry no canvas size (render.canvas.logicalWidth/logicalHeight)');
  process.exit(2);
}

const reference = await loadImage(referencePath);
const candidate = await loadImage(candidatePath);

const referenceAspect = reference.image.width / reference.image.height;
const candidateAspect = candidate.image.width / candidate.image.height;
const aspectDrift = Math.abs(candidateAspect - referenceAspect) / referenceAspect;
if (aspectDrift > 0.02) {
  console.error(
    `candidate aspect ${candidateAspect.toFixed(4)} deviates from reference ${referenceAspect.toFixed(4)} by ${(aspectDrift * 100).toFixed(1)}%; a cropped or rescaled screenshot is not comparable`
  );
  process.exit(2);
}

const width = reference.image.width;
const height = reference.image.height;
const referencePixels = reference.image.data;
const candidatePixels =
  candidate.image.width === width && candidate.image.height === height
    ? candidate.image.data
    : resizeRgba(candidate.image.data, candidate.image.width, candidate.image.height, width, height);

const scale = width / logicalWidth;

// ---- system UI bands -------------------------------------------------------
// The design draws a fake status bar and gesture bar; the device shows the real
// ones. Comparing those pixels is meaningless, so both bands are excluded. The
// band height is the larger of what the capture was told and what the measured
// system UI nodes actually occupy.
function rectOf(rect) {
  if (!rect || typeof rect !== 'object') return null;
  const x = Number(rect.x);
  const y = Number(rect.y);
  const w = Number(rect.w ?? rect.width);
  const h = Number(rect.h ?? rect.height);
  if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(w) || !Number.isFinite(h)) return null;
  if (w <= 0 || h <= 0) return null;
  return { x, y, w, h };
}

function rectOverlap(a, b) {
  const x = Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x));
  const y = Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));
  return x * y;
}

function bandExtentVp(kind) {
  let extent = Number(kind === 'status-bar' ? render.statusBarVp : render.gestureBarVp) || 0;
  for (const entry of Array.isArray(facts.systemUi) ? facts.systemUi : []) {
    if (entry?.kind !== kind) continue;
    const node = (Array.isArray(facts.nodes) ? facts.nodes : []).find((item) => item?.nodeId === entry?.nodeId);
    const rect = rectOf(node?.rect);
    if (!rect) continue;
    const occupied = kind === 'status-bar' ? rect.y + rect.h : logicalHeight - rect.y;
    if (Number.isFinite(occupied) && occupied > extent) extent = occupied;
  }
  return extent;
}

const topExcludedPx = Math.max(0, Math.round(bandExtentVp('status-bar') * scale));
const bottomExcludedPx = Math.max(0, Math.round(bandExtentVp('gesture-bar') * scale));
const bandsProvided = Number(render.statusBarVp) > 0 || Number(render.gestureBarVp) > 0;

// ---- alignment -------------------------------------------------------------
// A global offset of a few pixels is honest rendering noise (device chrome vs
// artboard). Search it out, and treat a search that clamps to its boundary or a
// page-wide difference that stays huge as "the two images are not the same
// screen" instead of inventing dozens of regions.
function meanAbsoluteDiff(shiftX, shiftY, step) {
  let sum = 0;
  let count = 0;
  const startY = Math.max(topExcludedPx, -shiftY);
  const endY = Math.min(height - bottomExcludedPx, height - shiftY);
  for (let y = startY; y < endY; y += step) {
    const candidateY = y + shiftY;
    // The candidate row must also be inside the comparable region, otherwise
    // the search would score a shift that the accumulator later discards.
    if (candidateY < topExcludedPx || candidateY >= height - bottomExcludedPx) continue;
    const rowA = y * width;
    const rowB = candidateY * width;
    const startX = Math.max(0, -shiftX);
    const endX = Math.min(width, width - shiftX);
    for (let x = startX; x < endX; x += step) {
      const a = (rowA + x) * 4;
      const b = (rowB + x + shiftX) * 4;
      sum +=
        (Math.abs(referencePixels[a] - candidatePixels[b]) +
          Math.abs(referencePixels[a + 1] - candidatePixels[b + 1]) +
          Math.abs(referencePixels[a + 2] - candidatePixels[b + 2])) /
        3;
      count += 1;
    }
  }
  return count === 0 ? Number.POSITIVE_INFINITY : sum / count;
}

let best = { shiftX: 0, shiftY: 0, mae: Number.POSITIVE_INFINITY };
for (let shiftY = -alignY; shiftY <= alignY; shiftY += 1) {
  for (let shiftX = -alignX; shiftX <= alignX; shiftX += 1) {
    const mae = meanAbsoluteDiff(shiftX, shiftY, 2);
    // Prefer a smaller MAE; on a tie prefer the smaller total displacement,
    // then the lexicographically smaller shift so the result is deterministic.
    const displacement = Math.abs(shiftX) + Math.abs(shiftY);
    const bestDisplacement = Math.abs(best.shiftX) + Math.abs(best.shiftY);
    if (
      mae < best.mae ||
      (mae === best.mae && displacement < bestDisplacement) ||
      (mae === best.mae && displacement === bestDisplacement && (shiftY < best.shiftY || (shiftY === best.shiftY && shiftX < best.shiftX)))
    ) {
      best = { shiftX, shiftY, mae };
    }
  }
}
// ---- probe mode --------------------------------------------------------------
// Point color sampling for stage-5 investigations: given design-space points,
// report what the reference and the candidate actually render there. The
// region-mode alignment guard does not apply here — a probe that refused to
// measure would be useless exactly when the alignment is in question. The
// alignment values travel in the output so the reader knows how much to trust
// the aligned numbers.
if (pointsPath) {
  let pointsRaw;
  try {
    pointsRaw = JSON.parse(await readFile(pointsPath, 'utf8'));
  } catch {
    console.error(`points file is missing or not valid JSON: ${pointsPath}`);
    process.exit(2);
  }
  if (!Array.isArray(pointsRaw) || pointsRaw.length === 0) {
    console.error('points file must be a non-empty JSON array of {name, x, y}');
    process.exit(2);
  }
  const points = pointsRaw.map((point, index) => {
    // Number(null) === 0, so a null coordinate has to be rejected by type
    // before the finite check or it silently samples the origin.
    if (typeof point?.x !== 'number' || typeof point?.y !== 'number' || !Number.isFinite(point.x) || !Number.isFinite(point.y)) {
      console.error(
        `points[${index}] must carry finite numeric x/y in design vp (got x=${JSON.stringify(point?.x)}, y=${JSON.stringify(point?.y)})`
      );
      process.exit(2);
    }
    return {
      name: typeof point?.name === 'string' && point.name.length > 0 ? point.name : `point-${index}`,
      x: point.x,
      y: point.y
    };
  });
  const hugsBoundaryProbe = Math.abs(best.shiftY) === alignY || Math.abs(best.shiftX) === alignX;
  function sampleAreaAvg(pixels, pixelWidth, pixelHeight, cx, cy) {
    let r = 0;
    let g = 0;
    let b = 0;
    let count = 0;
    for (let dy = -sampleRadius; dy <= sampleRadius; dy += 1) {
      const y = Math.min(pixelHeight - 1, Math.max(0, cy + dy));
      for (let dx = -sampleRadius; dx <= sampleRadius; dx += 1) {
        const x = Math.min(pixelWidth - 1, Math.max(0, cx + dx));
        const index = (y * pixelWidth + x) * 4;
        r += pixels[index];
        g += pixels[index + 1];
        b += pixels[index + 2];
        count += 1;
      }
    }
    return { r: Math.round(r / count), g: Math.round(g / count), b: Math.round(b / count) };
  }
  const native = density > 0;
  const results = points.map((point) => {
    const px = Math.round(point.x * scale);
    const py = Math.round(point.y * scale);
    const referenceColor = sampleAreaAvg(referencePixels, width, height, px, py);
    const candidateColor = native
      ? sampleAreaAvg(
          candidate.image.data,
          candidate.image.width,
          candidate.image.height,
          Math.round(point.x * density),
          Math.round(point.y * density)
        )
      : sampleAreaAvg(candidatePixels, width, height, px + best.shiftX, py + best.shiftY);
    const maxChannelDiff = Math.max(
      Math.abs(referenceColor.r - candidateColor.r),
      Math.abs(referenceColor.g - candidateColor.g),
      Math.abs(referenceColor.b - candidateColor.b)
    );
    return { name: point.name, x: point.x, y: point.y, reference: referenceColor, candidate: candidateColor, maxChannelDiff };
  });
  const mode = native ? 'native' : 'aligned';
  console.log(
    `probe: reference ${width}x${height} candidate ${candidate.image.width}x${candidate.image.height} mode=${mode} alignment=(${best.shiftX},${best.shiftY}) mae=${best.mae.toFixed(1)}${native ? ' (not applied in native mode)' : hugsBoundaryProbe ? ' (hugs the search boundary; aligned colors may be misleading)' : ''}`
  );
  for (const result of results) {
    console.log(
      `${result.name.padEnd(24)} vp(${result.x},${result.y})  ref rgb(${result.reference.r},${result.reference.g},${result.reference.b})  cand rgb(${result.candidate.r},${result.candidate.g},${result.candidate.b})  maxdiff=${result.maxChannelDiff}`
    );
  }
  if (outDir) {
    // Persist under stage5/ next to regions.json, named after the points file
    // so successive probe runs never overwrite each other's evidence.
    const probeOutDir = join(outDir, 'stage5');
    const pointsBase = basename(pointsPath).replace(/\.[^.]+$/, '') || 'points';
    const probePath = join(probeOutDir, `probe-${pointsBase}.json`);
    await mkdir(probeOutDir, { recursive: true });
    await writeFile(
      probePath,
      `${JSON.stringify(
        {
          producer: {
            tool: 'html_frame_regions_probe',
            version: 1,
            command: `node html-frame-regions.mjs ${argv.join(' ')}`,
            createdAt: new Date().toISOString(),
            mode,
            alignment: {
              shiftXPx: best.shiftX,
              shiftYPx: best.shiftY,
              mae: Math.round(best.mae * 10) / 10,
              hugsBoundary: hugsBoundaryProbe
            },
            referenceSha256: reference.sourceSha256,
            candidateSha256: candidate.sourceSha256
          },
          sampleRadius,
          points: results
        },
        null,
        2
      )}\n`
    );
    console.log(`probe results written to ${probePath}`);
  }
  process.exit(0);
}

const globalMae = best.mae;
const hugsBoundary = Math.abs(best.shiftY) === alignY || Math.abs(best.shiftX) === alignX;
const alignmentGuard = hugsBoundary || globalMae > 24 ? 'fail' : 'pass';
if (alignmentGuard === 'fail') {
  console.error(
    `alignment guard tripped: best shift (${best.shiftX},${best.shiftY}) mae=${globalMae.toFixed(1)}${hugsBoundary ? ' hugs the search boundary' : ''}; check that the candidate is the same page as the reference`
  );
  process.exit(2);
}

// ---- diff, blocks, regions -------------------------------------------------
const blockColumns = Math.floor(width / blockSize);
const blockRows = Math.floor((height - topExcludedPx - bottomExcludedPx) / blockSize);
const blockCount = blockColumns * blockRows;
const blockSum = new Float64Array(blockCount);
const blockPeak = new Float64Array(blockCount);
const blockPixels = new Uint32Array(blockCount);
let diffTotal = 0;
let comparedPixels = 0;

for (let y = topExcludedPx; y < height - bottomExcludedPx; y += 1) {
  const candidateY = y + best.shiftY;
  if (candidateY < topExcludedPx || candidateY >= height - bottomExcludedPx) continue;
  const blockRow = Math.floor((y - topExcludedPx) / blockSize);
  for (let x = 0; x < width; x += 1) {
    // The alignment search shifts both axes; the block diff used to apply only
    // shiftY, inflating text/edge region means by the un-applied shiftX.
    const candidateX = x + best.shiftX;
    if (candidateX < 0 || candidateX >= width) continue;
    const referenceIndex = (y * width + x) * 4;
    const candidateIndex = (candidateY * width + candidateX) * 4;
    const delta =
      (Math.abs(referencePixels[referenceIndex] - candidatePixels[candidateIndex]) +
        Math.abs(referencePixels[referenceIndex + 1] - candidatePixels[candidateIndex + 1]) +
        Math.abs(referencePixels[referenceIndex + 2] - candidatePixels[candidateIndex + 2])) /
      3;
    const blockColumn = Math.floor(x / blockSize);
    if (blockColumn >= blockColumns) continue;
    const blockIndex = blockRow * blockColumns + blockColumn;
    blockSum[blockIndex] += delta;
    blockPixels[blockIndex] += 1;
    if (delta > blockPeak[blockIndex]) blockPeak[blockIndex] = delta;
    diffTotal += delta;
    comparedPixels += 1;
  }
}

const blockMean = new Float64Array(blockCount);
for (let index = 0; index < blockCount; index += 1) {
  blockMean[index] = blockPixels[index] > 0 ? blockSum[index] / blockPixels[index] : 0;
}

// Reference flatness per block: a flat wash with a real difference is where
// sub-threshold patches hide (the blob that averaged below its region mean).
const refMinR = new Float32Array(blockCount).fill(255);
const refMaxR = new Float32Array(blockCount).fill(0);
const refMinG = new Float32Array(blockCount).fill(255);
const refMaxG = new Float32Array(blockCount).fill(0);
const refMinB = new Float32Array(blockCount).fill(255);
const refMaxB = new Float32Array(blockCount).fill(0);
for (let y = topExcludedPx; y < height - bottomExcludedPx; y += 1) {
  const blockRow = Math.floor((y - topExcludedPx) / blockSize);
  for (let x = 0; x < width; x += 1) {
    const blockColumn = Math.floor(x / blockSize);
    if (blockColumn >= blockColumns) continue;
    const pixel = (y * width + x) * 4;
    const blockIndex = blockRow * blockColumns + blockColumn;
    const r = referencePixels[pixel];
    const g = referencePixels[pixel + 1];
    const b = referencePixels[pixel + 2];
    if (r < refMinR[blockIndex]) refMinR[blockIndex] = r;
    if (r > refMaxR[blockIndex]) refMaxR[blockIndex] = r;
    if (g < refMinG[blockIndex]) refMinG[blockIndex] = g;
    if (g > refMaxG[blockIndex]) refMaxG[blockIndex] = g;
    if (b < refMinB[blockIndex]) refMinB[blockIndex] = b;
    if (b > refMaxB[blockIndex]) refMaxB[blockIndex] = b;
  }
}
const flatBlock = new Uint8Array(blockCount);
for (let index = 0; index < blockCount; index += 1) {
  flatBlock[index] =
    refMaxR[index] - refMinR[index] <= flatChannelRange &&
    refMaxG[index] - refMinG[index] <= flatChannelRange &&
    refMaxB[index] - refMinB[index] <= flatChannelRange
      ? 1
      : 0;
}

const hot = new Uint8Array(blockCount);
for (let index = 0; index < blockCount; index += 1) {
  hot[index] = blockMean[index] >= blockMeanFloor || blockPeak[index] >= blockPeakFloor ? 1 : 0;
}

const visited = new Uint8Array(blockCount);
const imageArea = width * height;
const nodes = Array.isArray(facts.nodes) ? facts.nodes : [];
const systemUiNodes = (Array.isArray(facts.systemUi) ? facts.systemUi : [])
  .map((entry) => {
    const node = nodes.find((item) => item?.nodeId === entry?.nodeId);
    const rect = rectOf(node?.rect);
    return rect ? { kind: entry?.kind, rect } : null;
  })
  .filter(Boolean);

const regions = [];
for (let start = 0; start < blockCount; start += 1) {
  if (!hot[start] || visited[start]) continue;
  const queue = [start];
  visited[start] = 1;
  const blocks = [];
  let minColumn = blockColumns;
  let maxColumn = -1;
  let minRow = blockRows;
  let maxRow = -1;
  while (queue.length > 0) {
    const index = queue.pop();
    blocks.push(index);
    const column = index % blockColumns;
    const row = Math.floor(index / blockColumns);
    if (column < minColumn) minColumn = column;
    if (column > maxColumn) maxColumn = column;
    if (row < minRow) minRow = row;
    if (row > maxRow) maxRow = row;
    for (let dy = -1; dy <= 1; dy += 1) {
      for (let dx = -1; dx <= 1; dx += 1) {
        const nextColumn = column + dx;
        const nextRow = row + dy;
        if (nextColumn < 0 || nextColumn >= blockColumns || nextRow < 0 || nextRow >= blockRows) continue;
        const nextIndex = nextRow * blockColumns + nextColumn;
        if (!hot[nextIndex] || visited[nextIndex]) continue;
        visited[nextIndex] = 1;
        queue.push(nextIndex);
      }
    }
  }

  let sum = 0;
  let pixels = 0;
  let peak = 0;
  for (const index of blocks) {
    sum += blockSum[index];
    pixels += blockPixels[index];
    if (blockPeak[index] > peak) peak = blockPeak[index];
  }
  const regionMean = pixels > 0 ? sum / pixels : 0;
  const regionTop = topExcludedPx + minRow * blockSize;
  const bbox = {
    x: minColumn * blockSize,
    y: regionTop,
    width: Math.min(width - minColumn * blockSize, (maxColumn - minColumn + 1) * blockSize),
    height: Math.min((maxRow - minRow + 1) * blockSize, height - regionTop)
  };
  const bboxArea = bbox.width * bbox.height;
  const areaRatio = bboxArea / imageArea;
  const clusterRatio = (blocks.length * blockSize * blockSize) / imageArea;
  const accepted =
    (areaRatio >= minAreaRatio && regionMean >= minMeanDelta) ||
    (peak >= minPeakDelta && clusterRatio >= minPeakClusterRatio);
  if (!accepted) continue;

  const bboxVp = {
    x: bbox.x / scale,
    y: bbox.y / scale,
    width: bbox.width / scale,
    height: bbox.height / scale
  };
  const bboxVpRect = { x: bboxVp.x, y: bboxVp.y, w: bboxVp.width, h: bboxVp.height };
  let systemUiArea = 0;
  for (const entry of systemUiNodes) {
    systemUiArea += rectOverlap(bboxVpRect, entry.rect);
  }
  const factsNodes = nodes
    .map((node) => ({ node, rect: rectOf(node?.rect) }))
    .filter((item) => item.rect && rectOverlap(bboxVpRect, item.rect) > 0)
    .map(({ node, rect }) => ({
      nodeId: node.nodeId,
      overlapRatio: rectOverlap(bboxVpRect, rect) / Math.max(1, bboxVp.width * bboxVp.height),
      rect: { x: rect.x, y: rect.y, w: rect.w, h: rect.h },
      fontSizePx: node.style?.fontSizePx ?? null,
      color: node.style?.color ?? null,
      backgroundColor: node.style?.backgroundColor ?? null,
      borderRadiusPx: node.style?.borderRadiusPx ?? null,
      text: node.text ?? null
    }))
    .sort((a, b) => b.overlapRatio - a.overlapRatio)
    .slice(0, 8);

  // The script performs no judgement, it only says where to measure: cluster
  // points mark the peak cluster, grid points spread over the bbox, and flat
  // points mark reference-wash blocks whose candidate differs. Flat points are
  // pushed first so a coordinate shared with a cluster point keeps the
  // stricter kind.
  const peakThreshold = Math.max(minPeakDelta, Math.round(peak * 0.75));
  const clusterBlocks = blocks.filter((index) => blockPeak[index] >= peakThreshold);
  const flatHotBlocks = blocks.filter((index) => flatBlock[index] === 1 && blockMean[index] >= blockMeanFloor);
  function blocksBbox(selected) {
    let minColumn = blockColumns;
    let maxColumn = -1;
    let minRow = blockRows;
    let maxRow = -1;
    for (const index of selected) {
      const column = index % blockColumns;
      const row = Math.floor(index / blockColumns);
      if (column < minColumn) minColumn = column;
      if (column > maxColumn) maxColumn = column;
      if (row < minRow) minRow = row;
      if (row > maxRow) maxRow = row;
    }
    if (maxColumn < 0) {
      return null;
    }
    const x = minColumn * blockSize;
    const y = topExcludedPx + minRow * blockSize;
    return {
      x,
      y,
      width: Math.min((maxColumn - minColumn + 1) * blockSize, width - x),
      height: Math.min((maxRow - minRow + 1) * blockSize, height - bottomExcludedPx - y)
    };
  }
  const clusterBbox = blocksBbox(clusterBlocks) ?? bbox;
  const probeGridVp = [];
  const seenProbe = new Set();
  function pushProbePoint(px, py, kind) {
    const clampedX = Math.min(Math.max(px, 0), width - 1);
    const clampedY = Math.min(Math.max(py, 0), height - 1);
    const x = Math.round((clampedX / scale) * 100) / 100;
    const y = Math.round((clampedY / scale) * 100) / 100;
    const key = `${x},${y}`;
    if (seenProbe.has(key)) return;
    seenProbe.add(key);
    probeGridVp.push({ x, y, kind });
  }
  for (const { index } of flatHotBlocks
    .map((index) => ({ index, mean: blockMean[index] }))
    .sort((a, b) => b.mean - a.mean)
    .slice(0, 6)) {
    const column = index % blockColumns;
    const row = Math.floor(index / blockColumns);
    pushProbePoint(column * blockSize + blockSize / 2, topExcludedPx + row * blockSize + blockSize / 2, 'flat');
  }
  pushProbePoint(clusterBbox.x + clusterBbox.width / 2, clusterBbox.y + clusterBbox.height / 2, 'cluster');
  pushProbePoint(clusterBbox.x + clusterBbox.width * 0.2, clusterBbox.y + clusterBbox.height * 0.2, 'cluster');
  pushProbePoint(clusterBbox.x + clusterBbox.width * 0.8, clusterBbox.y + clusterBbox.height * 0.2, 'cluster');
  pushProbePoint(clusterBbox.x + clusterBbox.width * 0.2, clusterBbox.y + clusterBbox.height * 0.8, 'cluster');
  pushProbePoint(clusterBbox.x + clusterBbox.width * 0.8, clusterBbox.y + clusterBbox.height * 0.8, 'cluster');
  for (const fractionX of [1 / 6, 1 / 2, 5 / 6]) {
    for (const fractionY of [1 / 6, 1 / 2, 5 / 6]) {
      pushProbePoint(bbox.x + bbox.width * fractionX, bbox.y + bbox.height * fractionY, 'grid');
    }
  }

  regions.push({
    bbox,
    bboxVp,
    areaRatio,
    meanDelta: regionMean,
    peakDelta: peak,
    clusterRatio,
    peakCluster: {
      threshold: peakThreshold,
      blockCount: clusterBlocks.length,
      bbox: clusterBbox,
      bboxVp: {
        x: clusterBbox.x / scale,
        y: clusterBbox.y / scale,
        width: clusterBbox.width / scale,
        height: clusterBbox.height / scale
      }
    },
    probeGridVp,
    systemUiOverlap: Math.min(1, systemUiArea / Math.max(1, bboxVp.width * bboxVp.height)),
    accent: 'both',
    factsNodes
  });
}

regions.sort((a, b) => b.areaRatio * b.meanDelta - a.areaRatio * a.meanDelta);
for (const [index, region] of regions.entries()) {
  region.id = `R${index + 1}`;
}

// ---- gesture band assertion ------------------------------------------------
// The band is excluded from the region walk (the fake bar and the real bar never
// match), but application content that reaches into the band still has to be
// right. A plain brightness comparison over the band catches the case the score
// criterion used to miss (a gradient running past the safe area).
function meanLuma(pixels, yStart, yEnd) {
  let sum = 0;
  let count = 0;
  for (let y = yStart; y < yEnd; y += 1) {
    for (let x = 0; x < width; x += 2) {
      const index = (y * width + x) * 4;
      sum += 0.299 * pixels[index] + 0.587 * pixels[index + 1] + 0.114 * pixels[index + 2];
      count += 1;
    }
  }
  return count === 0 ? 0 : sum / count;
}
const referenceBandLuma = meanLuma(referencePixels, height - bottomExcludedPx, height);
const candidateBandLuma = meanLuma(candidatePixels, height - bottomExcludedPx, height);
const gestureBandDelta = Math.abs(referenceBandLuma - candidateBandLuma);
const gestureBand = {
  referenceLuma: Number(referenceBandLuma.toFixed(1)),
  candidateLuma: Number(candidateBandLuma.toFixed(1)),
  meanDelta: Number(gestureBandDelta.toFixed(1)),
  threshold: gestureLumaThreshold,
  passed: bottomExcludedPx > 0 ? gestureBandDelta <= gestureLumaThreshold : true
};

// ---- contact sheets --------------------------------------------------------
const sheetScale = 340 / Math.max(1, ...regions.map((region) => region.bbox.width));
function sheetHtml(pngBytes, sourceLabel) {
  const dataUrl = 'data:image/png;base64,' + pngBytes.toString('base64');
  const cells = regions
    .map((region) => {
      const cropWidth = Math.max(1, Math.round(region.bbox.width * sheetScale));
      const cropHeight = Math.max(1, Math.round(region.bbox.height * sheetScale));
      return `<figure><figcaption>${region.id} · ${region.bbox.width}×${region.bbox.height}px · mean ${region.meanDelta.toFixed(1)} · peak ${region.peakDelta.toFixed(0)}</figcaption><div class="crop" style="width:${cropWidth}px;height:${cropHeight}px;background-image:url('${dataUrl}');background-size:${Math.round(width * sheetScale)}px ${Math.round(height * sheetScale)}px;background-position:-${Math.round(region.bbox.x * sheetScale)}px -${Math.round(region.bbox.y * sheetScale)}px"></div></figure>`;
    })
    .join('');
  return `<!doctype html><html><head><meta charset="utf-8"><style>
  body{margin:0;background:#111;color:#ddd;font:12px/1.4 sans-serif}
  h1{font-size:14px;margin:10px 12px}
  .grid{display:flex;flex-wrap:wrap;gap:12px;padding:0 12px 12px}
  figure{margin:0;background:#1c1c1c;border:1px solid #333;padding:6px}
  figcaption{font-size:11px;color:#9ab;margin-bottom:4px;font-family:monospace}
  .crop{background-repeat:no-repeat;image-rendering:pixelated;outline:1px solid #444}
  </style></head><body><h1>${sourceLabel} · ${regions.length} region(s) · reference ${width}×${height}</h1><div class="grid">${cells}</div></body></html>`;
}

let sheetReferencePath = null;
let sheetCandidatePath = null;
if (regions.length > 0) {
  await mkdir(join(outDir, 'stage5'), { recursive: true });
  const browser = await chromium.launch();
  try {
    for (const [side, pngBytes, label] of [
      ['reference', reference.pngBytes, 'REFERENCE (design frame)'],
      ['candidate', candidate.pngBytes, 'CANDIDATE (device screenshot)']
    ]) {
      const page = await browser.newPage({ viewport: { width: 740, height: 400 } });
      await page.setContent(sheetHtml(pngBytes, label), { waitUntil: 'load' });
      const target = join(outDir, 'stage5', `regions-sheet-${side}.png`);
      await page.screenshot({ path: target, fullPage: true });
      await page.close();
      if (side === 'reference') sheetReferencePath = target;
      else sheetCandidatePath = target;
    }
  } finally {
    await browser.close();
  }
}

// ---- output ----------------------------------------------------------------
const regionDiffTotal = regions.reduce((sum, region) => {
  let regionSum = 0;
  for (let y = region.bbox.y; y < Math.min(height, region.bbox.y + region.bbox.height); y += 1) {
    const candidateY = y + best.shiftY;
    if (candidateY < 0 || candidateY >= height) continue;
    for (let x = region.bbox.x; x < Math.min(width, region.bbox.x + region.bbox.width); x += 1) {
      // The alignment search shifts both axes. Sampling only shiftY here made
      // the region share of the diff grow with every horizontal drift, so the
      // share could exceed 1 on a purely horizontal misalignment.
      const candidateX = x + best.shiftX;
      if (candidateX < 0 || candidateX >= width) continue;
      const a = (y * width + x) * 4;
      const b = (candidateY * width + candidateX) * 4;
      regionSum +=
        (Math.abs(referencePixels[a] - candidatePixels[b]) +
          Math.abs(referencePixels[a + 1] - candidatePixels[b + 1]) +
          Math.abs(referencePixels[a + 2] - candidatePixels[b + 2])) /
        3;
    }
  }
  return sum + regionSum;
}, 0);

const payload = {
  schemaVersion: 1,
  designSource: 'others-html',
  producer: {
    tool: 'html_frame_regions',
    version: 1,
    command: ['node', 'scripts/html-frame-regions.mjs', ...argv].join(' '),
    createdAt: new Date().toISOString()
  },
  inputs: {
    reference: {
      path: relOut(referencePath),
      sha256: reference.sourceSha256,
      width: reference.image.width,
      height: reference.image.height
    },
    candidate: {
      path: relOut(candidatePath),
      sha256: candidate.sourceSha256,
      converted: candidate.converted,
      convertedPath: candidate.converted ? relOut(join(outDir, 'stage5', 'candidate.converted.png')) : null,
      width: candidate.image.width,
      height: candidate.image.height
    },
    facts: {
      path: relOut(factsPath),
      sha256: sha256(factsBuffer)
    }
  },
  thresholds: {
    minAreaRatio,
    minMeanDelta,
    minPeakDelta,
    minPeakClusterRatio,
    blockSize,
    searchXPx: alignX,
    searchYPx: alignY,
    gestureBandLuma: gestureLumaThreshold
  },
  alignment: {
    shiftXPx: best.shiftX,
    shiftYPx: best.shiftY,
    globalMae: Number(globalMae.toFixed(2)),
    guard: alignmentGuard
  },
  bands: {
    provided: bandsProvided,
    topExcludedVp: Number((topExcludedPx / scale).toFixed(1)),
    bottomExcludedVp: Number((bottomExcludedPx / scale).toFixed(1)),
    topExcludedPx,
    bottomExcludedPx,
    gestureBand
  },
  scale,
  diffCoverage: diffTotal > 0 ? Number((regionDiffTotal / diffTotal).toFixed(3)) : 0,
  regions,
  sheets: {
    reference: sheetReferencePath ? relOut(sheetReferencePath) : null,
    candidate: sheetCandidatePath ? relOut(sheetCandidatePath) : null
  },
  uncertainties: bandsProvided
    ? []
    : ['layout facts carry no statusBarVp/gestureBarVp, so no system UI band was excluded']
};

// Keep the converted image next to the original: the report cites both hashes,
// and the original stays the record of what the device actually produced.
if (candidate.converted) {
  await mkdir(join(outDir, 'stage5'), { recursive: true });
  await writeFile(join(outDir, 'stage5', 'candidate.converted.png'), candidate.pngBytes);
}
await mkdir(join(outDir, 'stage5'), { recursive: true });
await writeFile(join(outDir, 'stage5', 'regions.json'), JSON.stringify(payload, null, 2) + '\n');

console.log(
  `regions=${regions.length} alignment=(${best.shiftX},${best.shiftY}) mae=${globalMae.toFixed(1)} gestureBand=${gestureBand.passed ? 'pass' : `fail ${gestureBand.meanDelta}>${gestureLumaThreshold}`} diffCoverage=${payload.diffCoverage}`
);
for (const region of regions) {
  console.log(
    `  ${region.id} bbox=${region.bbox.width}x${region.bbox.height}@${region.bbox.x},${region.bbox.y} area=${(region.areaRatio * 100).toFixed(2)}% mean=${region.meanDelta.toFixed(1)} peak=${region.peakDelta.toFixed(0)} nodes=${region.factsNodes.length} systemUiOverlap=${region.systemUiOverlap.toFixed(2)}`
  );
}
