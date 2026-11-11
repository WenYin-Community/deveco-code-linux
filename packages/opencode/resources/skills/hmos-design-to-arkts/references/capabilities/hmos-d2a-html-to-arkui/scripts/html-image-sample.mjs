#!/usr/bin/env node
// Official asset-content sampler for the others-html path (stage-5
// investigations and the stage-4 resource audit).
//
// Measures and reports; it never blocks and renders no judgement. It exists
// so nobody hand-rolls a PNG decoder again: round-4's hand-written samplers
// skipped scanline defiltering entirely, and every value they read from
// Sub/Up/Average/Paeth-filtered assets was garbage that then fed a wrong
// root-cause call.
//
//   node scripts/html-image-sample.mjs --image <png> [--points <points.json>]
//        [--alpha-extent] [--alpha-threshold 128] [--out <runDir>]
//
// points.json: [{ "name": "p1", "x": 40, "y": 83 }] with x/y in NATIVE IMAGE
// PIXELS — not design vp, and no alignment shift of any kind. Each point
// reports r/g/b/a. --alpha-extent prints the opaque bounding box and per-row
// opaque ranges at the alpha threshold, answering "where is this asset
// actually opaque". --out persists the readings to <runDir>/stage5/
// sample-<image-name>.json (producer + image SHA-256) so a triage can cite
// them.
//
// Exit codes:
//   0 = sampled
//   2 = invalid input (bad args, unreadable file, out-of-bounds point)
//   3 = unsupported image format (non-PNG, bit depths other than 8,
//       interlaced PNGs — re-export the asset instead of hand-decoding)

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
  if (!Number.isFinite(value)) {
    console.error(`invalid --${name}: ${raw}`);
    process.exit(2);
  }
  return value;
}

const imagePath = readArg('image', null);
const pointsPath = readArg('points', null);
const alphaExtent = argv.includes('--alpha-extent');
const alphaThreshold = Math.round(numberArg('alpha-threshold', 128));
const outDir = readArg('out', null);

if (!imagePath || (!pointsPath && !alphaExtent)) {
  console.error(
    'usage: node scripts/html-image-sample.mjs --image <png> [--points <points.json>] [--alpha-extent] [--alpha-threshold 128] [--out <runDir>]'
  );
  process.exit(2);
}
if (alphaThreshold < 0 || alphaThreshold > 255) {
  console.error(`invalid --alpha-threshold: ${alphaThreshold}`);
  process.exit(2);
}

const { basename, join } = await import('node:path');
const { mkdir, writeFile, readFile } = await import('node:fs/promises');
const { createHash } = await import('node:crypto');
const { inflateSync } = await import('node:zlib');

async function readPngPixels(path) {
  let buffer;
  try {
    buffer = await readFile(path);
  } catch {
    console.error(`image file is missing or unreadable: ${path}`);
    process.exit(2);
  }
  if (buffer.length < 8 || buffer.readUInt32BE(0) !== 0x89504e47 || buffer.readUInt32BE(4) !== 0x0d0a1a0a) {
    console.error(`unsupported image format (PNG only): ${path}`);
    process.exit(3);
  }
  let offset = 8;
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = 0;
  let interlaced = 0;
  let palette = null;
  let transparency = null;
  const idat = [];
  while (offset + 8 <= buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.toString('ascii', offset + 4, offset + 8);
    const data = buffer.subarray(offset + 8, offset + 8 + length);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      bitDepth = data[8];
      colorType = data[9];
      interlaced = data[12];
    } else if (type === 'PLTE') {
      palette = data;
    } else if (type === 'tRNS') {
      transparency = data;
    } else if (type === 'IDAT') {
      idat.push(data);
    } else if (type === 'IEND') {
      break;
    }
    offset += 12 + length;
  }
  if (bitDepth !== 8) {
    console.error(`unsupported bit depth ${bitDepth}: only 8-bit channels decode here; re-export the asset`);
    process.exit(3);
  }
  if (interlaced !== 0) {
    console.error('interlaced PNGs are not supported; re-export the asset without interlacing');
    process.exit(3);
  }
  const channels = colorType === 6 ? 4 : colorType === 2 ? 3 : colorType === 4 ? 2 : colorType === 0 ? 1 : colorType === 3 ? 1 : 0;
  if (channels === 0) {
    console.error(`unsupported color type ${colorType}`);
    process.exit(3);
  }
  if (colorType === 3 && palette === null) {
    console.error('palette PNG without a PLTE chunk');
    process.exit(3);
  }
  if (width <= 0 || height <= 0) {
    console.error(`invalid dimensions ${width}x${height}`);
    process.exit(3);
  }
  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  if (raw.length < (stride + 1) * height) {
    console.error(`decompressed data is shorter than ${width}x${height} needs; the image is truncated`);
    process.exit(3);
  }
  const pixels = Buffer.alloc(width * height * 4);
  const reconstructed = Buffer.alloc(stride);
  const previous = Buffer.alloc(stride);
  let rawOffset = 0;
  for (let y = 0; y < height; y += 1) {
    const filter = raw[rawOffset];
    rawOffset += 1;
    for (let x = 0; x < stride; x += 1) {
      const rawByte = raw[rawOffset + x];
      const left = x >= channels ? reconstructed[x - channels] : 0;
      const up = previous[x];
      const upLeft = x >= channels ? previous[x - channels] : 0;
      let value = rawByte;
      if (filter === 1) value = rawByte + left;
      else if (filter === 2) value = rawByte + up;
      else if (filter === 3) value = rawByte + ((left + up) >> 1);
      else if (filter === 4) {
        const prediction = left + up - upLeft;
        const distanceLeft = Math.abs(prediction - left);
        const distanceUp = Math.abs(prediction - up);
        const distanceUpLeft = Math.abs(prediction - upLeft);
        value =
          rawByte +
          (distanceLeft <= distanceUp && distanceLeft <= distanceUpLeft
            ? left
            : distanceUp <= distanceUpLeft
              ? up
              : upLeft);
      } else if (filter > 4) {
        console.error(`invalid scanline filter ${filter} at row ${y}`);
        process.exit(3);
      }
      reconstructed[x] = value & 0xff;
    }
    rawOffset += stride;
    for (let x = 0; x < width; x += 1) {
      const input = x * channels;
      const output = (y * width + x) * 4;
      if (colorType === 6) {
        pixels[output] = reconstructed[input];
        pixels[output + 1] = reconstructed[input + 1];
        pixels[output + 2] = reconstructed[input + 2];
        pixels[output + 3] = reconstructed[input + 3];
      } else if (colorType === 2) {
        pixels[output] = reconstructed[input];
        pixels[output + 1] = reconstructed[input + 1];
        pixels[output + 2] = reconstructed[input + 2];
        pixels[output + 3] = 255;
      } else if (colorType === 4) {
        pixels[output] = reconstructed[input];
        pixels[output + 1] = reconstructed[input];
        pixels[output + 2] = reconstructed[input];
        pixels[output + 3] = reconstructed[input + 1];
      } else if (colorType === 0) {
        pixels[output] = reconstructed[input];
        pixels[output + 1] = reconstructed[input];
        pixels[output + 2] = reconstructed[input];
        pixels[output + 3] = 255;
      } else {
        const entry = reconstructed[input] * 3;
        pixels[output] = palette[entry];
        pixels[output + 1] = palette[entry + 1];
        pixels[output + 2] = palette[entry + 2];
        pixels[output + 3] = transparency !== null && reconstructed[input] < transparency.length ? transparency[reconstructed[input]] : 255;
      }
    }
    previous.set(reconstructed);
  }
  return { width, height, pixels, colorType };
}

const image = await readPngPixels(imagePath);

function pixelAt(x, y) {
  const offset = (y * image.width + x) * 4;
  return {
    r: image.pixels[offset],
    g: image.pixels[offset + 1],
    b: image.pixels[offset + 2],
    a: image.pixels[offset + 3]
  };
}

let points = [];
if (pointsPath !== null) {
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
  points = pointsRaw.map((point, index) => {
    // Number(null) === 0, so a null coordinate has to be rejected by type
    // before the integer check or it silently samples the corner.
    if (
      typeof point?.x !== 'number' ||
      typeof point?.y !== 'number' ||
      !Number.isInteger(point.x) ||
      !Number.isInteger(point.y) ||
      point.x < 0 ||
      point.y < 0 ||
      point.x >= image.width ||
      point.y >= image.height
    ) {
      console.error(
        `points[${index}] must carry integer x/y inside the image bounds (got x=${JSON.stringify(point?.x)}, y=${JSON.stringify(point?.y)}, image is ${image.width}x${image.height})`
      );
      process.exit(2);
    }
    return { name: typeof point?.name === 'string' && point.name.length > 0 ? point.name : `point-${index}`, x: point.x, y: point.y };
  });
}

let extent = null;
if (alphaExtent) {
  let minX = image.width;
  let minY = image.height;
  let maxX = -1;
  let maxY = -1;
  let opaque = 0;
  const rowRanges = [];
  const rowStep = Math.max(1, Math.floor(image.height / 16));
  for (let y = 0; y < image.height; y += 1) {
    let rowMin = image.width;
    let rowMax = -1;
    for (let x = 0; x < image.width; x += 1) {
      if (pixelAt(x, y).a >= alphaThreshold) {
        opaque += 1;
        if (x < rowMin) rowMin = x;
        if (x > rowMax) rowMax = x;
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
    if (y % rowStep === 0) {
      rowRanges.push({ y, from: rowMin === image.width ? null : rowMin, to: rowMax });
    }
  }
  extent = {
    alphaThreshold,
    opaquePixels: opaque,
    totalPixels: image.width * image.height,
    opaqueRatio: Number(((opaque / (image.width * image.height)) * 100).toFixed(2)),
    bbox: maxX < 0 ? null : { x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1 },
    rowRanges
  };
}

console.log(`sample: ${basename(imagePath)} ${image.width}x${image.height} colorType=${image.colorType} alphaThreshold=${alphaThreshold}`);
for (const point of points) {
  const color = pixelAt(point.x, point.y);
  console.log(
    `${point.name.padEnd(24)} px(${point.x},${point.y})  rgba(${color.r},${color.g},${color.b},${color.a})`
  );
}
if (extent !== null) {
  console.log(
    `alpha-extent: opaque ${extent.opaquePixels}/${extent.totalPixels} px (${extent.opaqueRatio}%)  bbox ${extent.bbox === null ? 'none' : `${extent.bbox.x},${extent.bbox.y} ${extent.bbox.width}x${extent.bbox.height}`}`
  );
  for (const row of extent.rowRanges) {
    console.log(`  row ${String(row.y).padStart(4)} opaque ${row.from === null ? 'none' : `x ${row.from}..${row.to}`}`);
  }
}

if (outDir) {
  const sampleDir = join(outDir, 'stage5');
  const sampleName = `sample-${basename(imagePath).replace(/\.[^.]+$/, '')}.json`;
  await mkdir(sampleDir, { recursive: true });
  const imagePathAbsolute = await readFile(imagePath);
  const payload = {
    producer: {
      tool: 'html_image_sample',
      version: 1,
      command: `node html-image-sample.mjs ${argv.join(' ')}`,
      createdAt: new Date().toISOString(),
      image: basename(imagePath),
      imageSha256: createHash('sha256').update(imagePathAbsolute).digest('hex')
    },
    alphaThreshold,
    points: points.map((point) => ({ ...point, ...pixelAt(point.x, point.y) })),
    alphaExtent: extent
  };
  await writeFile(join(sampleDir, sampleName), `${JSON.stringify(payload, null, 2)}\n`);
  console.log(`sample results written to ${join(sampleDir, sampleName)}`);
}
