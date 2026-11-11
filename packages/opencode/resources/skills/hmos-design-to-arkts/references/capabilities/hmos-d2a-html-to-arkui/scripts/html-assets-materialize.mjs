#!/usr/bin/env node
// Materialize design assets recorded in stage-1 layout facts.
//
// The third real run hand-rolled a throwaway CSS parser (two iterations, one
// real bug) just to extract data-URI gradients and circular masks — the two
// decoration vocabularies facts cannot translate by geometry alone. This
// script does that extraction once, correctly, from the values the browser
// already computed: facts carries them per node, so nothing here re-parses
// the HTML source.
//
// What it produces:
//   - decoded + normalized SVG/PNG files for every data-URI background/mask
//     (rgba() stops become rgb()+opacity, float channels round to ints —
//     ArkUI's SVG parser silently renders both as black otherwise)
//   - a clip recipe for single-circle data-URI masks (borderRadius + clip +
//     backgroundImage(size, position))
//   - file references resolved back inside the frozen tree
//   - an unknowns list for anything outside the vocabulary (multi-layer
//     masks, clip-path, non-circle shapes, files outside the tree) — those
//     stay with agent judgement instead of being mistranslated
//   - a content-sha256 dedupe table so identical assets land on disk once
//
// Output: files under --out plus a materialize.json manifest fragment the
// stage-2 agent merges into stage2/image-assets-manifest.json. This tool
// measures and prepares; it never blocks (exit 2 only for bad input).
//
// Usage:
//   node scripts/html-assets-materialize.mjs --facts <runDir>/stage1/layout-facts.json --out <dir>
//
// Exit codes:
//   0 = assets materialized (unknowns may be non-empty — read them)
//   2 = invalid input

const [, , ...argv] = process.argv;

function readArg(name) {
  const index = argv.indexOf(`--${name}`);
  if (index === -1) return null;
  const value = argv[index + 1];
  if (value === undefined || value.startsWith('--')) {
    console.error(`missing value for --${name}`);
    process.exit(2);
  }
  return value;
}

const factsPath = readArg('facts');
const outDir = readArg('out');
if (!factsPath || !outDir) {
  console.error('usage: node scripts/html-assets-materialize.mjs --facts <layout-facts.json> --out <outputDir>');
  process.exit(2);
}

const { join, dirname, resolve, isAbsolute, relative } = await import('node:path');
const { mkdir, writeFile, readFile } = await import('node:fs/promises');
const { createHash } = await import('node:crypto');

const sha256 = (buffer) => createHash('sha256').update(buffer).digest('hex');
// The frozen tree root is always run/source/html; the document directory is
// the actual location of the frozen HTML file (which may be nested).
const treeRoot = resolve(dirname(factsPath), '..', 'source', 'html');

const facts = JSON.parse(await readFile(factsPath, 'utf8'));
const nodes = Array.isArray(facts?.nodes) ? facts.nodes : [];
const documentDir = facts?.source?.path
  ? resolve(treeRoot, dirname(facts.source.path.replace(/^source\/html\/?/, '')))
  : treeRoot;

// A relative file reference must stay inside the frozen tree. Using
// path.relative instead of startsWith prevents "../html-evil" from passing.
function resolveInsideTree(baseDir, reference) {
  const absolute = resolve(baseDir, reference);
  const rel = relative(treeRoot, absolute);
  if (rel.startsWith('..') || isAbsolute(rel)) return null;
  return absolute;
}

// Chromium computes url() references as absolute file:/// addresses; map them
// back to paths and keep only what resolves inside the frozen tree.
function fileUrlToPath(layer) {
  const match = layer.match(/url\(\s*"?file:\/\/\/([^"?)]+)"?\s*\)/);
  if (!match) return null;
  try {
    return decodeURIComponent(match[1]).replace(/^\//, (m) => (/[A-Za-z]:/.test(match[1]) ? '' : m));
  } catch {
    return null;
  }
}

// Split a computed multi-layer value on top-level commas only: data-URI
// payloads carry commas inside quotes and parens, so a naive split corrupts
// them (the hand-rolled parser of the third run hit exactly this).
function splitLayers(value) {
  const layers = [];
  let depth = 0;
  let quote = null;
  let current = '';
  for (let i = 0; i < value.length; i += 1) {
    const ch = value[i];
    if (quote) {
      current += ch;
      if (ch === quote && value[i - 1] !== '\\') quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      current += ch;
      continue;
    }
    if (ch === '(') depth += 1;
    if (ch === ')') depth -= 1;
    if (ch === ',' && depth === 0) {
      layers.push(current.trim());
      current = '';
      continue;
    }
    current += ch;
  }
  if (current.trim().length > 0) layers.push(current.trim());
  return layers;
}

function decodeDataUri(layer) {
  const quoted = layer.match(/url\(\s*"data:([^,;]+)(;[^,]*)?,([^"]*)"\s*\)/);
  const bare = quoted ? null : layer.match(/url\(\s*data:([^,;]+)(;[^,]*)?,([^)]*)\s*\)/);
  const match = quoted ?? bare;
  if (!match) return null;
  const mime = match[1];
  const parameter = match[2] ?? '';
  const payload = match[3];
  if (parameter.includes('base64')) {
    const bytes = decodeBase64Strict(payload);
    return bytes ? { mime, bytes } : null;
  }
  let decoded;
  try {
    decoded = decodeURIComponent(payload.replace(/\+/g, ' '));
  } catch {
    decoded = payload;
  }
  return { mime, text: decoded };
}

// A media element records its raw `src` attribute, so the payload arrives
// without the url() wrapper: `data:image/png;base64,...` or a path relative to
// the frozen HTML file. The header ends at the first comma; everything after
// it is the payload, which may itself contain commas.
function decodeRawDataUri(value) {
  const comma = value.indexOf(',');
  if (comma === -1) return null;
  const header = value.slice('data:'.length, comma);
  const payload = value.slice(comma + 1);
  const [mime, ...parameters] = header.split(';');
  if (!mime) return null;
  if (parameters.includes('base64')) {
    const bytes = decodeBase64Strict(payload);
    return bytes ? { mime, bytes } : null;
  }
  try {
    return { mime, text: decodeURIComponent(payload) };
  } catch {
    return { mime, text: payload };
  }
}

// Node's Buffer.from(payload, 'base64') is lenient: it silently drops invalid
// characters and can produce a 0-byte buffer. A materialized asset must never
// be an empty file, so reject anything that does not decode cleanly.
function decodeBase64Strict(payload) {
  if (typeof payload !== 'string' || payload.length === 0) return null;
  const normalized = payload.replace(/\s+/g, '');
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(normalized)) return null;
  if (normalized.length % 4 !== 0) return null;
  const bytes = Buffer.from(normalized, 'base64');
  if (bytes.length === 0) return null;
  // Round-trip to catch silently dropped characters.
  if (bytes.toString('base64').replace(/=+$/, '') !== normalized.replace(/=+$/, '')) return null;
  return bytes;
}

const roundChannel = (value) => String(Math.round(Number(value)));

// ArkUI's SVG parser rejects rgba() stop/fill colors and float channels by
// rendering them black. Rewrite the two known attribute contexts into the
// SVG 1.1 forms and round every channel; anything left over is reported.
function normalizeSvgColors(text) {
  let output = text;
  for (const [colorAttr, opacityAttr] of [
    ['stop-color', 'stop-opacity'],
    ['fill', 'fill-opacity'],
    ['stroke', 'stroke-opacity']
  ]) {
    for (const quote of ["'", '"']) {
      const pattern = new RegExp(`${colorAttr}\\s*=\\s*${quote}\\s*rgba?\\(\\s*([\\d.]+)\\s*,\\s*([\\d.]+)\\s*,\\s*([\\d.]+)\\s*(?:,\\s*([\\d.]+)\\s*)?\\)\\s*${quote}`, 'g');
      output = output.replace(pattern, (all, r, g, b, a) =>
        a === undefined
          ? `${colorAttr}=${quote}rgb(${roundChannel(r)},${roundChannel(g)},${roundChannel(b)})${quote}`
          : `${colorAttr}=${quote}rgb(${roundChannel(r)},${roundChannel(g)},${roundChannel(b)})${quote} ${opacityAttr}=${quote}${Number(a)}${quote}`
      );
    }
  }
  output = output.replace(/rgb\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*\)/g, (all, r, g, b) =>
    `rgb(${roundChannel(r)},${roundChannel(g)},${roundChannel(b)})`
  );
  return output;
}

// A circular mask translates to a borderRadius+clip container. Pixso exports
// stack several concentric plumbing circles inside one mask SVG, so the rule
// is "every shape is a circle and the largest one fills the mask box" — not
// "exactly one circle". Anything else (paths, rects, mixed shapes) stays with
// agent judgement.
function parseCircleMaskRecipe(svgText, node) {
  const style = node?.style ?? {};
  const sizeMatch = String(style.maskSize ?? '').match(/^(\d+(?:\.\d+)?)px\s+(\d+(?:\.\d+)?)px$/);
  const positionMatch = String(style.maskPosition ?? '').match(/^(-?\d+(?:\.\d+)?)px\s+(-?\d+(?:\.\d+)?)px$/);
  if (!sizeMatch || Number(sizeMatch[1]) !== Number(sizeMatch[2])) {
    return null;
  }
  const diameter = Number(sizeMatch[1]);
  const circles = [...svgText.matchAll(/<circle\b[^>]*>/g)];
  const ellipses = [...svgText.matchAll(/<ellipse\b[^>]*>/g)];
  const hasOtherShapes = /<(?:path|polygon|text|image)\b/.test(svgText);
  const rects = [...svgText.matchAll(/<rect\b[^>]*>/g)];
  // Pixso stacks several concentric plumbing copies of the same mask shape;
  // a circle may be written as <circle> or as an <ellipse> with rx == ry.
  const circularRadii = [
    ...circles.map((match) => Number(match[0].match(/\br\s*=\s*["']?([\d.]+)/)?.[1] ?? 0)),
    ...ellipses.map((match) => {
      const rx = Number(match[0].match(/\brx\s*=\s*["']?([\d.]+)/)?.[1] ?? 0);
      const ry = Number(match[0].match(/\bry\s*=\s*["']?([\d.]+)/)?.[1] ?? 0);
      return Math.abs(rx - ry) < 1 ? Math.max(rx, ry) : 0;
    })
  ];
  const hasTrueEllipse = ellipses.some((match) => {
    const rx = Number(match[0].match(/\brx\s*=\s*["']?([\d.]+)/)?.[1] ?? 0);
    const ry = Number(match[0].match(/\bry\s*=\s*["']?([\d.]+)/)?.[1] ?? 0);
    return rx > 0 && ry > 0 && Math.abs(rx - ry) >= 1;
  });
  const isAllCircles = circularRadii.length > 0 && !hasOtherShapes && rects.length === 0 && !hasTrueEllipse;
  const isRoundedSquare =
    circularRadii.length === 0 && !hasOtherShapes && !hasTrueEllipse && rects.length > 0 &&
    rects.some((match) => {
      const rx = Number(match[0].match(/\brx\s*=\s*["']?([\d.]+)/)?.[1] ?? 0);
      const width = Number(match[0].match(/\bwidth\s*=\s*["']?([\d.]+)/)?.[1] ?? 0);
      return rx > 0 && Math.abs(rx * 2 - diameter) < 1 && Math.abs(width - diameter) < 1;
    });
  if (!isAllCircles && !isRoundedSquare) {
    return null;
  }
  if (isAllCircles) {
    const largestRadius = Math.max(...circularRadii);
    if (largestRadius * 2 < diameter * 0.85) {
      return null;
    }
  }
  return {
    clip: 'circle',
    diameterVp: diameter,
    offsetVp: positionMatch ? { x: Number(positionMatch[1]), y: Number(positionMatch[2]) } : { x: 0, y: 0 },
    backgroundSize: style.backgroundSize ?? null,
    backgroundPosition: style.backgroundPosition ?? null,
    hint: 'render as a square container of diameterVp at offsetVp with borderRadius(diameterVp/2), clip(true) and backgroundImage(size/position) inside'
  };
}

function pxPair(value) {
  const match = String(value ?? '').match(/^(\d+(?:\.\d+)?)px\s+(\d+(?:\.\d+)?)px$/);
  return match ? { w: Number(match[1]), h: Number(match[2]) } : null;
}

// A linear gradient with a non-identity gradientTransform does not render the
// way its raw stops suggest: the browser projects the transformed axis over
// the element box, which windows (and pads) the visible stop range. The
// fourth run hand-copied the raw stops into a native gradient and produced a
// systematically biased band — full-range prediction differed 6-23 per
// channel from the reference where the windowed reading differed 1-2. The
// recipe reduces the transform exactly: the direction comes from the physical
// axis (bbox units scaled by the node rect), and the stops are resampled onto
// plain angle+offsets so a native .linearGradient reproduces the same colors.
function parseGradientRecipe(svgText, node) {
  if (/<radialGradient/.test(svgText)) {
    return null;
  }
  const tagMatch = svgText.match(/<linearGradient\b[^>]*>/);
  if (!tagMatch) {
    return null;
  }
  const tag = tagMatch[0];
  const attr = (name) => {
    const single = tag.match(new RegExp(`\\b${name}\\s*=\\s*'([^']*)'`)) ?? tag.match(new RegExp(`\\b${name}\\s*=\\s*"([^"]*)"`));
    return single ? single[1] : null;
  };
  if (/spreadMethod\s*=\s*['"](?:repeat|reflect)/.test(tag)) {
    return null;
  }
  // Percentages are fractions of the bounding box, not raw numbers; and
  // userSpaceOnUse coordinates are not bounding-box ratios at all.
  const gradientUnits = attr('gradientUnits');
  if (gradientUnits === 'userSpaceOnUse') {
    return null;
  }
  const number = (value, fallback) => {
    if (value === null) return fallback;
    const text = String(value).trim();
    if (text.endsWith('%')) {
      const parsed = Number.parseFloat(text.slice(0, -1));
      return Number.isFinite(parsed) ? parsed / 100 : fallback;
    }
    const parsed = Number.parseFloat(text);
    return Number.isFinite(parsed) ? parsed : fallback;
  };
  const x1 = number(attr('x1'), 0);
  const y1 = number(attr('y1'), 0);
  const x2 = number(attr('x2'), 1);
  const y2 = number(attr('y2'), 0);
  const dx = x2 - x1;
  const dy = y2 - y1;
  const axisLengthSq = dx * dx + dy * dy;
  if (axisLengthSq < 1e-12) {
    return null;
  }

  let a = 1;
  let b = 0;
  let c = 0;
  let d = 1;
  let e = 0;
  let f = 0;
  const transform = attr('gradientTransform');
  if (transform) {
    const numbers = transform.match(/-?[\d.]+/g);
    if (!numbers || numbers.length < 6) {
      return null;
    }
    [a, b, c, d, e, f] = numbers.slice(0, 6).map(Number);
  }
  // gradientTransform maps the gradient's own coordinate space INTO the
  // element box, so evaluating the colour at a box point inverse-maps that
  // point and projects it onto the RAW axis: t(p) = ((M^-1 (p - T) - A) . D)
  // / |D|^2, affine in the element's bbox coords. (Projecting the
  // transformed axis M*D instead agrees only for near-orthogonal matrices —
  // n0009's shearing d=16.62 renders horizontal, which only the inverse-map
  // reproduces.)
  let inverse00 = 1;
  let inverse01 = 0;
  let inverse10 = 0;
  let inverse11 = 1;
  let offsetX = 0;
  let offsetY = 0;
  if (transform) {
    const determinant = a * d - b * c;
    if (Math.abs(determinant) < 1e-12) {
      return null;
    }
    inverse00 = d / determinant;
    inverse01 = -c / determinant;
    inverse10 = -b / determinant;
    inverse11 = a / determinant;
    offsetX = e;
    offsetY = f;
  }
  const anchorX = inverse00 * offsetX + inverse01 * offsetY + x1;
  const anchorY = inverse10 * offsetX + inverse11 * offsetY + y1;
  const c1 = (inverse00 * dx + inverse10 * dy) / axisLengthSq;
  const c2 = (inverse01 * dx + inverse11 * dy) / axisLengthSq;
  const c0 = -(anchorX * dx + anchorY * dy) / axisLengthSq;
  const rect = node?.rect ?? {};
  const w = Number(rect.w);
  const h = Number(rect.h);
  if (!Number.isFinite(w) || w <= 0 || !Number.isFinite(h) || h <= 0) {
    return null;
  }
  // Physical direction of increasing t: (c1, c2) is the gradient direction in
  // bbox-fraction space; its physical image scales by (w, h). Verified
  // empirically against Chromium renders (n0009 horizontal, n0021 at 159°,
  // n0042 vertical). ArkUI angle 0 = up, clockwise.
  const vx = c1 * w;
  const vy = c2 * h;
  const vLength = Math.hypot(vx, vy);
  if (vLength < 1e-9) {
    return null;
  }
  const angle = Number((((Math.atan2(vx / vLength, -vy / vLength) * 180) / Math.PI + 360) % 360).toFixed(1));
  // ArkUI/CSS offset function over the box for that angle (projection rule).
  const ux = vx / vLength;
  const uy = vy / vLength;
  const projectionLength = Math.abs(w * ux) + Math.abs(h * uy);
  if (projectionLength < 1e-9) {
    return null;
  }
  const offsetAt = (px, py) => ((px * w - w / 2) * ux + (py * h - h / 2) * uy) / (projectionLength / 2) + 0.5;
  const tAt = (px, py) => c1 * px + c2 * py + c0;
  // Both functions are affine with parallel level sets, so t = alpha*o + beta.
  const o00 = offsetAt(0, 0);
  const o11 = offsetAt(1, 1);
  const o10 = offsetAt(1, 0);
  const t00 = tAt(0, 0);
  const t11 = tAt(1, 1);
  const t10 = tAt(1, 0);
  let alpha = 0;
  let beta = 0;
  if (Math.abs(o11 - o00) > 1e-9) {
    alpha = (t11 - t00) / (o11 - o00);
    beta = t00 - alpha * o00;
  } else if (Math.abs(o10 - o00) > 1e-9) {
    alpha = (t10 - t00) / (o10 - o00);
    beta = t00 - alpha * o00;
  } else {
    return null;
  }
  const stops = [...svgText.matchAll(/<stop\s+stop-color='rgb\((\d+),(\d+),(\d+)\)'\s+stop-opacity='([\d.]+)'\s+offset='([\d.]+%?)'/g)]
    .map((match) => ({
      r: Number(match[1]),
      g: Number(match[2]),
      b: Number(match[3]),
      opacity: Number(match[4]),
      offset: match[5].endsWith('%') ? Number.parseFloat(match[5].slice(0, -1)) / 100 : Number(match[5])
    }))
    .sort((s, t) => s.offset - t.offset);
  if (stops.length < 2) {
    return null;
  }
  const firstOffset = stops[0].offset;
  const lastOffset = stops[stops.length - 1].offset;
  const colorAt = (t) => {
    const clamped = Math.min(Math.max(t, firstOffset), lastOffset);
    let lower = stops[0];
    for (const stop of stops) {
      if (stop.offset <= clamped) lower = stop;
      else break;
    }
    let upper = stops[stops.length - 1];
    for (const stop of stops) {
      if (stop.offset >= clamped) {
        upper = stop;
        break;
      }
    }
    const span = upper.offset - lower.offset;
    if (span <= 1e-12) {
      return lower;
    }
    const mix = (clamped - lower.offset) / span;
    return {
      r: Math.round(lower.r + (upper.r - lower.r) * mix),
      g: Math.round(lower.g + (upper.g - lower.g) * mix),
      b: Math.round(lower.b + (upper.b - lower.b) * mix),
      opacity: Number((lower.opacity + (upper.opacity - lower.opacity) * mix).toFixed(4))
    };
  };
  // Resample onto ArkUI offsets [0,1]: the ends carry the pad behaviour, and
  // the original stops land wherever their t maps inside the box.
  const offsets = new Set([0, 1]);
  if (Math.abs(alpha) > 1e-12) {
    for (const stop of stops) {
      const mapped = (stop.offset - beta) / alpha;
      if (mapped > 1e-4 && mapped < 1 - 1e-4) {
        offsets.add(Number(mapped.toFixed(4)));
      }
    }
  }
  const resampled = [...offsets].sort((x, y) => x - y).map((offset) => {
    const color = colorAt(alpha * offset + beta);
    return { offset, rgb: `rgb(${color.r},${color.g},${color.b})`, opacity: color.opacity };
  });
  const radii = Array.isArray(node?.style?.borderRadiusPx) ? node.style.borderRadiusPx : [0, 0, 0, 0];
  const uniformRadius = radii.every((r) => r === radii[0]);
  const clampRadius = (r) => Number(Math.min(r, Math.min(w, h) / 2).toFixed(3));
  return {
    angle,
    stops: resampled,
    ...(uniformRadius
      ? { radiusVp: clampRadius(radii[0]) }
      : { cornerRadiiVp: { topLeft: clampRadius(radii[0]), topRight: clampRadius(radii[1]), bottomRight: clampRadius(radii[2]), bottomLeft: clampRadius(radii[3]) } }),
    elementOpacity: typeof node?.style?.opacity === 'number' ? node.style.opacity : 1,
    hint: uniformRadius
      ? 'render natively with .linearGradient({ angle, colors }) over the node box and .borderRadius(radiusVp); the stops already account for the transform windowing and pad, apply elementOpacity via .opacity()'
      : 'render natively with .linearGradient({ angle, colors }) over the node box and .borderRadius({ topLeft, topRight, bottomRight, bottomLeft }) using cornerRadiiVp; the stops already account for the transform windowing and pad, apply elementOpacity via .opacity()'
  };
}

const assets = [];
const unknowns = [];
const written = new Map();
const usedFilenames = new Set();

async function emitAsset(nodeId, field, bytes, extension, note, maskRecipe, gradientRecipe) {
  // nodeId comes from the design source and may contain path separators;
  // sanitize it before using it as a filename.
  const safeNodeId = String(nodeId).replace(/[^a-zA-Z0-9_-]/g, '_');
  const contentSha = sha256(bytes);
  const existing = written.get(contentSha);
  // One node may carry several layers of the same mime type. Giving them the
  // same filename would overwrite the first layer and leave two manifest
  // entries pointing at one file, so disambiguate by content hash.
  const filename =
    existing ?? `${safeNodeId}.${field === 'maskImage' ? 'mask' : 'bg'}.${extension}`;
  const uniqueFilename = existing ?? (usedFilenames.has(filename) ? `${filename.replace(/\.([^.]+)$/, `.${contentSha.slice(0, 8)}.$1`)}` : filename);
  if (!existing) {
    written.set(contentSha, uniqueFilename);
    usedFilenames.add(uniqueFilename);
    await writeFile(join(outDir, uniqueFilename), bytes);
  }
  assets.push({
    nodeId,
    field,
    kind: existing ? 'deduped' : 'materialized',
    output: uniqueFilename,
    sha256: contentSha,
    bytes: bytes.byteLength,
    note,
    ...(maskRecipe ? { maskRecipe } : {}),
    ...(gradientRecipe ? { gradientRecipe } : {})
  });
}

// The decoded payload of a data-URI is the same whether it arrived wrapped in
// url() or as a raw `src` attribute, so both paths share this. The decoder
// returns either { mime, bytes } (base64) or { mime, text } (percent-encoded);
// normalize both into a single Buffer before emitting.
async function emitDecodedAsset(node, field, dataUri) {
  const text = dataUri.text ?? (dataUri.bytes ? dataUri.bytes.toString('utf8') : null);
  const bytes = dataUri.bytes ?? (dataUri.text ? Buffer.from(dataUri.text, 'utf8') : null);
  if (!bytes || bytes.length === 0) {
    unknowns.push({ nodeId: node.nodeId, field, reason: 'decoded asset is empty', detail: String(dataUri.mime).slice(0, 80) });
    return;
  }
  if (dataUri.mime === 'image/svg+xml') {
    const normalized = normalizeSvgColors(text);
    if (/rgba\(/.test(normalized)) {
      unknowns.push({ nodeId: node.nodeId, field, reason: 'rgba() outside the known attribute contexts remains', detail: normalized.slice(normalized.indexOf('rgba('), normalized.indexOf('rgba(') + 80) });
    }
    const recipe = field === 'maskImage' ? parseCircleMaskRecipe(normalized, node) : null;
    const gradientRecipe = field === 'imageSrc' && /<linearGradient/.test(normalized) ? parseGradientRecipe(normalized, node) : null;
    if (field === 'maskImage' && !recipe) {
      unknowns.push({ nodeId: node.nodeId, field, reason: 'mask is not circular (all circles, or a rounded square filling the box)', detail: 'asset extracted; translate the clip manually' });
    }
    if (field === 'imageSrc' && /<linearGradient/.test(normalized) && !gradientRecipe) {
      unknowns.push({ nodeId: node.nodeId, field, reason: 'linear gradient did not reduce to a native recipe (radial/repeat/degenerate axis)', detail: 'asset extracted; translate manually with probe verification' });
    }
    await emitAsset(node.nodeId, field, Buffer.from(normalized, 'utf8'), 'svg', `decoded from ${field} data-URI`, recipe, gradientRecipe);
    return;
  }
  await emitAsset(node.nodeId, field, bytes, dataUri.mime.split('/')[1] ?? 'bin', `decoded ${dataUri.mime} data-URI`, null);
}

await mkdir(outDir, { recursive: true });

for (const node of nodes) {
  const style = node?.style ?? {};
  if (style.clipPath) {
    unknowns.push({ nodeId: node.nodeId, field: 'clipPath', reason: 'clip-path needs manual translation', detail: String(style.clipPath).slice(0, 80) });
  }
  for (const field of ['imageSrc', 'maskImage']) {
    const value = style[field];
    if (typeof value !== 'string' || value.length === 0) continue;
    // A media element records its raw `src` attribute: a data-URI or a path
    // relative to the frozen HTML file. Those are not CSS layers - splitting
    // a data-URI on its comma would destroy it, and skipping it would drop
    // the asset with no entry and no unknown.
    if (field === 'imageSrc' && !value.includes('url(')) {
      if (value.startsWith('data:')) {
        const rawDataUri = decodeRawDataUri(value);
        if (!rawDataUri) {
          unknowns.push({ nodeId: node.nodeId, field, reason: 'data-URI could not be decoded', detail: value.slice(0, 80) });
          continue;
        }
        await emitDecodedAsset(node, field, rawDataUri);
        continue;
      }
      // Remote resources are registered, not downloaded or frozen.
      if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(value) || value.startsWith('//')) {
        unknowns.push({ nodeId: node.nodeId, field, reason: 'remote resource is not frozen', detail: value.slice(0, 80) });
        continue;
      }
      const absolute = resolveInsideTree(documentDir, value.replace(/^\.\//, ''));
      if (!absolute) {
        unknowns.push({ nodeId: node.nodeId, field, reason: 'file reference resolves outside the frozen tree', detail: value.slice(0, 80) });
        continue;
      }
      assets.push({ nodeId: node.nodeId, field, kind: 'file', source: absolute, note: 'copy into media with a business prefix' });
      continue;
    }
    const layers = splitLayers(value);
    if (field === 'maskImage' && layers.length > 1) {
      unknowns.push({ nodeId: node.nodeId, field, reason: 'multi-layer mask', detail: String(value).slice(0, 80) });
      continue;
    }
    for (const layer of layers) {
      if (!layer.includes('url(')) {
        if (field === 'maskImage') {
          unknowns.push({ nodeId: node.nodeId, field, reason: 'mask is not a url() image', detail: layer.slice(0, 80) });
        }
        continue;
      }
      const dataUri = layer.includes('data:') ? decodeDataUri(layer) : null;
      if (dataUri) {
        await emitDecodedAsset(node, field, dataUri);
        continue;
      }
      const filePath = fileUrlToPath(layer);
      if (filePath) {
        const absolute = /^[A-Za-z]:/.test(filePath) ? filePath : resolveInsideTree(documentDir, filePath.replace(/^\.\//, ''));
        if (!absolute || !resolveInsideTree(treeRoot, absolute)) {
          unknowns.push({ nodeId: node.nodeId, field, reason: 'file reference resolves outside the frozen tree', detail: layer.slice(0, 80) });
          continue;
        }
        assets.push({ nodeId: node.nodeId, field, kind: 'file', source: absolute, note: 'copy into media with a business prefix' });
        continue;
      }
      unknowns.push({ nodeId: node.nodeId, field, reason: 'unrecognised url() form', detail: layer.slice(0, 80) });
    }
  }
  if (style.backgroundSize && !pxPair(style.backgroundSize) && !/^(\d+(?:\.\d+)?%)\s+(\d+(?:\.\d+)?%)$/.test(style.backgroundSize) && style.backgroundSize !== 'cover' && style.backgroundSize !== 'contain') {
    unknowns.push({ nodeId: node.nodeId, field: 'backgroundSize', reason: 'mixed-unit background size needs manual sizing', detail: String(style.backgroundSize).slice(0, 60) });
  }
}

const manifest = {
  schemaVersion: 1,
  producer: { tool: 'html_assets_materialize', version: 1, command: `node html-assets-materialize.mjs ${argv.join(' ')}`, createdAt: new Date().toISOString() },
  assets,
  unknowns
};
await writeFile(join(outDir, 'materialize.json'), `${JSON.stringify(manifest, null, 2)}\n`);
console.log(`materialized ${assets.filter((entry) => entry.kind === 'materialized').length} asset(s), ${assets.filter((entry) => entry.kind === 'deduped').length} deduped reference(s), ${assets.filter((entry) => entry.kind === 'file').length} file reference(s), ${unknowns.length} unknown(s)`);
for (const entry of assets) {
  console.log(`  ${entry.nodeId} ${entry.field} -> ${entry.output ?? entry.source} (${entry.kind}${entry.maskRecipe ? ', circle recipe' : ''}${entry.gradientRecipe ? ', gradient recipe' : ''})`);
}
for (const entry of unknowns) {
  console.log(`  ? ${entry.nodeId} ${entry.field}: ${entry.reason}`);
}
console.log(`manifest: ${join(outDir, 'materialize.json')}`);
