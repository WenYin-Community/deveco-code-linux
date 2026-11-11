#!/usr/bin/env node
// Capture the design source of the others-html (HTML) path in one browser
// session and emit both evidence products at once:
//
//   <out>/stage1/layout-facts.json                     measured layout + computed styles
//   <out>/source/html/reference/reference-00..NN.png   one frame per viewport scroll
//   <out>/source/html/reference/content-full.png       stitched full-height view (human only)
//
// Usage:
//   node scripts/html-source-capture.mjs --html <path> --out <runDir>
//        [--viewport-width 360] [--viewport-height 792] [--dsf 2]
//        [--status-bar-vp 36] [--gesture-bar-vp 28] [--max-nodes 3000]
//
// Playwright is an optional environment dependency. It never installs anything
// itself; on missing dependencies it prints the official hint and exits 1 so the
// caller can block the stage with dependency_unavailable.
//
// Exit codes: 0 = captured, 1 = dependency missing or capture failed, 2 = invalid args.

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

const htmlPath = readArg('html', null);
const outDir = readArg('out', null);
if (!htmlPath || !outDir) {
  console.error('usage: node scripts/html-source-capture.mjs --html <path> --out <runDir> [options]');
  process.exit(2);
}

function positiveNumberArg(name, fallback) {
  const raw = readArg(name, String(fallback));
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) {
    console.error(`invalid --${name}: ${raw}`);
    process.exit(2);
  }
  return value;
}

const viewportWidth = positiveNumberArg('viewport-width', 360);
const viewportHeight = positiveNumberArg('viewport-height', 792);
const deviceScaleFactor = positiveNumberArg('dsf', 2);

// The system UI heights are optional: 0 means "not provided", which disables
// the geometric classification instead of failing the capture.
function nonNegativeNumberArg(name, fallback) {
  const raw = readArg(name, String(fallback));
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) {
    console.error(`invalid --${name}: ${raw}`);
    process.exit(2);
  }
  return value;
}

const statusBarVp = nonNegativeNumberArg('status-bar-vp', 0);
const gestureBarVp = nonNegativeNumberArg('gesture-bar-vp', 0);
const maxNodes = Math.round(positiveNumberArg('max-nodes', 3000));

const { resolve, join, dirname, relative } = await import('node:path');
const { pathToFileURL } = await import('node:url');
const { mkdir, writeFile, readFile } = await import('node:fs/promises');
const { createHash } = await import('node:crypto');

let chromium;
try {
  ({ chromium } = await import('playwright'));
} catch {
  console.error('playwright is not installed in this environment; cannot capture the HTML design source.');
  console.error('install guidance (run it yourself, this script never installs anything):');
  console.error('  npm install --no-save playwright');
  console.error('  npx playwright install chromium');
  process.exit(1);
}

const absoluteHtmlPath = resolve(htmlPath);
const runDir = resolve(outDir);
// The input may sit in a subdirectory of source/html when the design references
// resources one level up; always report where it actually is.
const sourceRelativePath = relative(runDir, absoluteHtmlPath).split(/[\\/]/).join('/');
const referenceDir = join(runDir, 'source', 'html', 'reference');

// The page is loaded through file://, so every reference must resolve inside
// the frozen tree: root-absolute paths and file:/// URLs escape it.
const { auditLocalResources, RESOURCE_GUIDANCE } = await import('./local-resources.mjs');
const resourceAudit = auditLocalResources({
  entryAbsolutePath: absoluteHtmlPath,
  treeRootAbsolutePath: join(runDir, 'source', 'html')
});
if (resourceAudit.total >= 5 && resourceAudit.missing / resourceAudit.total >= 0.5) {
  console.error(
    `local resources are not usable inside source/html: ${resourceAudit.missing}/${resourceAudit.total} references`
  );
  for (const problem of resourceAudit.problems.slice(0, 8)) {
    console.error(`  ${problem.reason}: ${problem.reference}`);
    console.error(`    ${RESOURCE_GUIDANCE[problem.reason] ?? ''}`);
  }
  console.error('re-run scripts/html-source-freeze.mjs instead of copying the folder by hand');
  process.exit(2);
}
if (resourceAudit.missing > 0) {
  console.error(`warning: ${resourceAudit.missing}/${resourceAudit.total} local references are imperfect`);
}

// Minimal PNG header reader: enough to report the real pixel size of a frame
// without pulling in an image library.
async function pngSize(path) {
  const buffer = await readFile(path);
  if (buffer.length < 24) return null;
  if (buffer[0] !== 0x89 || buffer[1] !== 0x50 || buffer[2] !== 0x4e || buffer[3] !== 0x47) return null;
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
}

function sha256(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

let browser;
try {
  browser = await chromium.launch({ headless: true });
} catch (error) {
  console.error('playwright/chromium is unavailable: ' + (error?.message ?? String(error)));
  console.error('install guidance (run it yourself, this script never installs anything):');
  console.error('  npx playwright install chromium');
  process.exit(1);
}

try {
  // The design source is untrusted input: never let it reach the network.
  // Only file: and data: URLs are allowed. JavaScript stays enabled because
  // the capture itself needs eval (page.evaluate) and because JS-rendered
  // design sources only lay out once their scripts have run. What that buys is
  // a network boundary plus a ban on dynamically created script tags - it does
  // NOT mean "the design source's JS never runs": parser-inserted inline
  // scripts execute before the DOMContentLoaded sweep below, so their DOM
  // mutations are untrusted input rather than a guarantee of a clean DOM.
  const context = await browser.newContext({
    viewport: { width: Math.round(viewportWidth), height: Math.round(viewportHeight) },
    deviceScaleFactor
  });
  await context.route('**/*', (route) => {
    const url = route.request().url();
    if (url.startsWith('file://') || url.startsWith('data:')) {
      return route.continue();
    }
    return route.abort();
  });
  const page = await context.newPage();
  // Block script tag creation and sweep the tags the parser already turned
  // into elements. This bounds the damage; it cannot undo the inline scripts
  // the parser ran before DOMContentLoaded. The capture script's own
  // evaluate() calls still work because eval is intentionally left intact.
  await page.addInitScript(() => {
    const originalCreateElement = document.createElement.bind(document);
    document.createElement = (tagName, options) => {
      if (String(tagName).toLowerCase() === 'script') {
        throw new Error('script tags are disabled');
      }
      return originalCreateElement(tagName, options);
    };
    document.addEventListener('DOMContentLoaded', () => {
      for (const script of document.querySelectorAll('script')) {
        script.remove();
      }
    }, { once: true });
  });
  await page.goto(pathToFileURL(absoluteHtmlPath).href, { waitUntil: 'load', timeout: 60000 });
  await page.evaluate(() => document.fonts?.ready);
  await page.evaluate(
    () => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done)))
  );

  // Force lazy images to decode before measuring: a design that ships
  // `loading="lazy"` would otherwise give frames where below-the-fold images are
  // still blank while the layout facts claim they are there.
  const imageInfo = await page.evaluate(async () => {
    const images = Array.from(document.images ?? []);
    for (const image of images) {
      try {
        image.loading = 'eager';
      } catch {
        /* older engines: ignore */
      }
    }
    await Promise.race([
      Promise.all(images.map((image) => (image.decode ? image.decode().catch(() => {}) : Promise.resolve()))),
      new Promise((done) => setTimeout(done, 5000))
    ]);
    const pending = images.filter((image) => !image.complete || image.naturalWidth === 0).length;
    return { total: images.length, pending };
  });

  // Facts are dumped at scroll offset 0 so every rect is already in design
  // coordinates, including nodes that sit below the first viewport.
  const facts = await page.evaluate(
    ({ maxNodes, statusBarVp, gestureBarVp, viewportHeight }) => {
      const parseRadius = (value) => {
        if (typeof value !== 'string' || value.length === 0) return [0, 0, 0, 0];
        const parts = value
          .split('/')[0]
          .trim()
          .split(/\s+/)
          .map((token) => Number.parseFloat(token))
          .filter((token) => Number.isFinite(token));
        if (parts.length === 0) return [0, 0, 0, 0];
        if (parts.length === 1) return [parts[0], parts[0], parts[0], parts[0]];
        if (parts.length === 2) return [parts[0], parts[1], parts[0], parts[1]];
        if (parts.length === 3) return [parts[0], parts[1], parts[2], parts[1]];
        return [parts[0], parts[1], parts[2], parts[3]];
      };
      // The browser reports the four computed corners separately. Reading only
      // the top-left one turned `border-radius: 12px 12px 0 0` into four
      // rounded corners, and facts is the only numeric truth downstream.
      const parseCornerRadius = (value) => {
        if (typeof value !== 'string' || value.length === 0) return 0;
        const horizontal = Number.parseFloat(value.split('/')[0].trim().split(/\s+/)[0]);
        return Number.isFinite(horizontal) ? horizontal : 0;
      };
      const isTransparent = (color) =>
        typeof color !== 'string' ||
        color === 'transparent' ||
        /^rgba\(\s*0\s*,\s*0\s*,\s*0\s*,\s*0\s*\)$/.test(color);
      const interactiveSelector = 'a,button,input,select,textarea,[onclick],[role="button"]';
      // Icon fonts put a private-use codepoint where an icon is drawn. Treating
      // that codepoint as user visible text would fake a text node that the
      // generated page can never reproduce, so it is recorded as an icon glyph
      // instead of text.
      const isIconGlyph = (value) => {
        const chars = Array.from(value);
        if (chars.length === 0 || chars.length > 4) return false;
        return chars.every((char) => {
          const code = char.codePointAt(0);
          return (code >= 0xe000 && code <= 0xf8ff) || code >= 0xf0000 || code === 0xfffd;
        });
      };
      const nodes = [];
      const systemUi = [];
      const uncertainties = [];
      let blendCount = 0;
      let backdropCount = 0;
      let iconGlyphs = 0;

      const elements = Array.from(document.querySelectorAll('body *'));
      for (const element of elements) {
        if (nodes.length >= maxNodes) {
          uncertainties.push(`node budget reached at ${maxNodes}; remaining elements were not recorded`);
          break;
        }
        const rect = element.getBoundingClientRect();
        if (!Number.isFinite(rect.width) || !Number.isFinite(rect.height)) continue;
        if (rect.width <= 0 || rect.height <= 0) continue;
        const style = getComputedStyle(element);
        if (style.display === 'none' || style.visibility === 'hidden') continue;
        if (Number(style.opacity) === 0) continue;

        const hasChildElements = element.childElementCount > 0;
        const ownText = hasChildElements ? '' : (element.textContent ?? '').trim();
        const backgroundImage = style.backgroundImage && style.backgroundImage !== 'none' ? style.backgroundImage : null;
        // Masked decorations (Pixso exports circular data-URI masks on top of
        // bitmap art) cannot be reproduced from geometry alone, so the computed
        // mask properties travel with the node. Background sizing/positioning
        // pairs with them to rebuild the clip recipe; object-fit covers <img>
        // content that a different exporter would size via CSS instead.
        const rawMaskImage = style.maskImage && style.maskImage !== 'none' ? style.maskImage : style.webkitMaskImage && style.webkitMaskImage !== 'none' ? style.webkitMaskImage : null;
        const maskImage = rawMaskImage;
        const maskSize =
          (style.maskSize && style.maskSize !== 'none' ? style.maskSize : null) ??
          (style.webkitMaskSize && style.webkitMaskSize !== 'none' ? style.webkitMaskSize : null);
        const maskPosition =
          (style.maskPosition && style.maskPosition !== 'none' ? style.maskPosition : null) ??
          (style.webkitMaskPosition && style.webkitMaskPosition !== 'none' ? style.webkitMaskPosition : null);
        const backgroundSize = style.backgroundSize && style.backgroundSize !== 'auto' ? style.backgroundSize : null;
        const backgroundPosition = style.backgroundPosition && style.backgroundPosition !== '0% 0%' ? style.backgroundPosition : null;
        const hasBackground = !isTransparent(style.backgroundColor) || backgroundImage !== null;
        const cornerRadii = [
          style.borderTopLeftRadius,
          style.borderTopRightRadius,
          style.borderBottomRightRadius,
          style.borderBottomLeftRadius
        ];
        const radius = cornerRadii.every((value) => typeof value === 'string' && value.length > 0)
          ? cornerRadii.map(parseCornerRadius)
          : parseRadius(style.borderRadius);
        const hasRadius = radius.some((value) => value > 0);
        const hasBorder =
          parseFloat(style.borderTopWidth) > 0 ||
          parseFloat(style.borderRightWidth) > 0 ||
          parseFloat(style.borderBottomWidth) > 0 ||
          parseFloat(style.borderLeftWidth) > 0;
        const tag = element.tagName.toLowerCase();
        const isMedia = tag === 'img' || tag === 'svg' || tag === 'canvas' || tag === 'video';

        if (!hasBackground && !hasRadius && !hasBorder && ownText.length === 0 && !isMedia) {
          continue;
        }
        if (style.mixBlendMode && style.mixBlendMode !== 'normal') blendCount += 1;
        if (style.backdropFilter && style.backdropFilter !== 'none') backdropCount += 1;

        let gradient = null;
        if (backgroundImage && backgroundImage.includes('linear-gradient')) {
          const colors = backgroundImage.match(/rgba?\([^)]*\)|#[0-9a-fA-F]{3,8}/g) ?? [];
          // A directionless gradient puts a color first; the old capture
          // mislabelled it (e.g. "rgb(255") as the direction. Only keyword or
          // angle forms are directions — anything else means the CSS default.
          const firstParam = backgroundImage.match(/linear-gradient\(\s*([^,]+),/)?.[1]?.trim();
          const direction = firstParam !== undefined && /^(to\s|[-+]?[\d.]+(?:deg|turn|rad|grad)\b)/i.test(firstParam) ? firstParam : 'to bottom';
          gradient = {
            direction,
            stops: colors.map((color, index) => [colors.length > 1 ? index / (colors.length - 1) : 0, color]),
            raw: backgroundImage
          };
        }

        const glyph = ownText.length > 0 && isIconGlyph(ownText);
        if (glyph) iconGlyphs += 1;
        const nodeId = `n${String(nodes.length).padStart(4, '0')}`;
        const entry = {
          nodeId,
          tag,
          cls: typeof element.className === 'string' ? element.className : null,
          text: ownText.length > 0 && !glyph ? ownText : null,
          iconGlyph: glyph || undefined,
          rect: {
            x: Math.round(rect.left * 100) / 100,
            y: Math.round(rect.top * 100) / 100,
            w: Math.round(rect.width * 100) / 100,
            h: Math.round(rect.height * 100) / 100
          },
          style: {
            fontSizePx: ownText.length > 0 ? Math.round(parseFloat(style.fontSize) * 100) / 100 : null,
            fontWeight: ownText.length > 0 ? style.fontWeight : null,
            fontFamily: ownText.length > 0 ? style.fontFamily : null,
            color: ownText.length > 0 ? style.color : null,
            backgroundColor: isTransparent(style.backgroundColor) ? null : style.backgroundColor,
            borderRadiusPx: radius,
            linearGradient: gradient,
            opacity: Number(style.opacity),
            backdropFilter: style.backdropFilter && style.backdropFilter !== 'none' ? style.backdropFilter : null,
            mixBlendMode: style.mixBlendMode && style.mixBlendMode !== 'normal' ? style.mixBlendMode : null,
            zIndex: style.zIndex === 'auto' ? null : style.zIndex,
            imageSrc: isMedia ? (element.getAttribute('src') ?? null) : backgroundImage && /url\(/.test(backgroundImage) ? backgroundImage : null,
            maskImage,
            maskSize,
            maskPosition,
            backgroundSize,
            backgroundPosition,
            objectFit: isMedia && style.objectFit && style.objectFit !== 'fill' ? style.objectFit : null,
            objectPosition:
              isMedia && style.objectPosition && style.objectPosition !== '50% 50%' ? style.objectPosition : null,
            clipPath: style.clipPath && style.clipPath !== 'none' ? style.clipPath : null
          }
        };
        nodes.push(entry);

        const interactive = element.matches(interactiveSelector) || element.querySelector(interactiveSelector) !== null;
        const rectBottom = rect.top + rect.height;
        const businessText = ownText.length > 0 && !/^\d{1,2}:\d{2}$/.test(ownText);
        if (!interactive && !businessText) {
          if (statusBarVp > 0 && rect.top >= 0 && rectBottom <= statusBarVp) {
            systemUi.push({ nodeId, kind: 'status-bar', reason: 'rect fully inside the status bar area with no business text or interaction' });
          }
          if (gestureBarVp > 0 && rect.top >= viewportHeight - gestureBarVp && rectBottom <= viewportHeight + 1) {
            systemUi.push({ nodeId, kind: 'gesture-bar', reason: 'rect fully inside the gesture bar area with no business text or interaction' });
          }
        }
      }
      if (iconGlyphs > 0) {
        uncertainties.push(
          `${iconGlyphs} node(s) render an icon font glyph instead of text; they are marked iconGlyph and carry no text value, so they must be implemented as icons rather than labels`
        );
      }
      if (blendCount > 0) {
        uncertainties.push(`${blendCount} node(s) use mix-blend-mode; the composited result cannot be measured from computed styles`);
      }
      if (backdropCount > 0) {
        uncertainties.push(`${backdropCount} node(s) use backdrop-filter; only the declared blur/saturate values are recorded, not the rendered pixels`);
      }
      if (statusBarVp === 0 || gestureBarVp === 0) {
        uncertainties.push('system UI areas were not provided, so no node is classified as status bar or gesture bar');
      }
      // Structures this script intentionally does not walk into. Reporting the
      // counts turns a silent blind spot into a visible one.
      let shadowHosts = 0;
      let framesCount = 0;
      for (const element of document.querySelectorAll('*')) {
        if (element.shadowRoot) shadowHosts += 1;
        if (element.tagName.toLowerCase() === 'iframe') framesCount += 1;
      }
      if (shadowHosts > 0) {
        uncertainties.push(
          `${shadowHosts} shadow host(s) found; shadow trees are not traversed, so nodes rendered inside them are missing from the facts`
        );
      }
      if (framesCount > 0) {
        uncertainties.push(
          `${framesCount} iframe(s) found; their content is not traversed and is not part of the measured facts`
        );
      }
      return { nodes, systemUi, uncertainties };
    },
    { maxNodes, statusBarVp, gestureBarVp, viewportHeight: Math.round(viewportHeight) }
  );

  // Reference set: one frame per viewport step of the design's own scroll
  // container, so sticky and absolutely positioned chrome lands where the
  // design puts it in every frame. fullPage is deliberately never used: on this
  // class of export it returns the viewport height only.
  // Pick the scroll container by the largest scrollable range, not the first
  // match in DOM order: a short side panel can appear earlier in the DOM than the
  // real content column, and picking it would leave most of the design
  // uncaptured while still reporting a plausible frame count.
  const scrollInfo = await page.evaluate(() => {
    const doc = document.documentElement;
    const bodyScrollHeight = document.body ? document.body.scrollHeight : 0;
    const docScrollHeight = Math.max(doc.scrollHeight, bodyScrollHeight);
    const docDelta = docScrollHeight - doc.clientHeight;
    let best = null;
    for (const element of document.querySelectorAll('*')) {
      const style = getComputedStyle(element);
      if (!['auto', 'scroll'].includes(style.overflowY)) continue;
      const delta = element.scrollHeight - element.clientHeight;
      if (delta <= 1) continue;
      if (best === null || delta > best.delta) best = { element, delta };
    }
    const horizontalOverflow = Math.max(
      0,
      Math.max(doc.scrollWidth, document.body ? document.body.scrollWidth : 0) - window.innerWidth
    );
    if (best !== null && best.delta >= docDelta) {
      window.__d2aScroller = best.element;
      return {
        container: 'design-element',
        scrollHeight: best.element.scrollHeight,
        clientHeight: best.element.clientHeight,
        horizontalOverflow
      };
    }
    window.__d2aScroller = null;
    return {
      container: 'document',
      scrollHeight: docScrollHeight,
      clientHeight: doc.clientHeight,
      horizontalOverflow
    };
  });

  const stepHeight = Math.round(viewportHeight);
  const frames = Math.max(1, Math.ceil(scrollInfo.scrollHeight / stepHeight));
  if (frames > 32) {
    console.error(`refusing to capture ${frames} frames; the design is taller than 32 viewports`);
    process.exit(1);
  }

  await mkdir(referenceDir, { recursive: true });
  const frameNames = [];
  const frameBuffers = [];
  for (let index = 0; index < frames; index += 1) {
    const offset = index * stepHeight;
    await page.evaluate(({ offset }) => {
      const scroller = window.__d2aScroller;
      if (scroller) {
        scroller.scrollTop = offset;
      } else {
        window.scrollTo(0, offset);
      }
    }, { offset });
    await page.evaluate(
      () => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done)))
    );
    const buffer = await page.screenshot({ type: 'png', fullPage: false });
    const name = `reference-${String(index).padStart(2, '0')}.png`;
    await writeFile(join(referenceDir, name), buffer);
    frameNames.push(name);
    frameBuffers.push(buffer.toString('base64'));
  }

  // Stitch the frames in the browser: no image library, and the result is only
  // ever used for human inspection and coverage review, never for comparison.
  const stitched = await page.evaluate(
    async ({ frames: encoded, width, height }) => {
      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height * encoded.length;
      const context = canvas.getContext('2d');
      for (let index = 0; index < encoded.length; index += 1) {
        const image = new Image();
        image.src = `data:image/png;base64,${encoded[index]}`;
        await image.decode();
        context.drawImage(image, 0, index * height);
      }
      return canvas.toDataURL('image/png').split(',')[1];
    },
    { frames: frameBuffers, width: Math.round(viewportWidth * deviceScaleFactor), height: Math.round(viewportHeight * deviceScaleFactor) }
  );
  // A canvas over the browser's limit returns 'data:,' instead of throwing, and
  // writing that out ships a zero-byte "reference" the stage 1 gate can only
  // report as missing. Fail here, with the cause and the fix, instead.
  if (!stitched) {
    throw new Error('content-full.png stitching returned an empty data URL (canvas limit exceeded by the frame count); this is a required stage 1 artifact, so reduce the viewport or split the design rather than ship a zero-byte reference');
  }
  await writeFile(join(referenceDir, 'content-full.png'), Buffer.from(stitched, 'base64'));

  // Human-only preview for designs whose artboard clips its own content: the
  // frames above cannot show what the artboard hides, so lift the clipping and
  // take one tall screenshot. This image is NOT equivalent to the design (the
  // layout re-flows and sticky chrome moves), so it is recorded as
  // `equivalence: 'not-comparable'` and must never be used as evidence.
  const MAX_UNCLIPPED_PX = 20000;
  let unclippedInfo = { available: false, reason: 'nothing-clipped' };
  const contentExtentGuess = await page.evaluate(() => {
    let maxBottom = 0;
    for (const element of document.querySelectorAll('body *')) {
      const rect = element.getBoundingClientRect();
      if (Number.isFinite(rect.bottom)) maxBottom = Math.max(maxBottom, rect.bottom);
    }
    return Math.round(maxBottom);
  });
  if (contentExtentGuess > Math.round(viewportHeight) + 4) {
    const touched = await page.evaluate(() => {
      const apply = (element) => {
        element.style.setProperty('height', 'auto', 'important');
        element.style.setProperty('overflow', 'visible', 'important');
        element.style.setProperty('max-height', 'none', 'important');
      };
      const clippers = [];
      for (const element of document.querySelectorAll('body *')) {
        const style = getComputedStyle(element);
        const clips = ['hidden', 'clip'].includes(style.overflowY) || ['hidden', 'clip'].includes(style.overflow);
        if (clips && element.scrollHeight - element.clientHeight > 1) clippers.push(element);
      }
      let count = 0;
      for (const clipper of clippers) {
        for (let element = clipper; element && element !== document.documentElement; element = element.parentElement) {
          apply(element);
          count += 1;
        }
      }
      for (const element of [document.documentElement, document.body]) {
        if (element) {
          apply(element);
          count += 1;
        }
      }
      return count;
    });
    await page.evaluate(
      () => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done)))
    );
    const expanded = await page.evaluate(() => ({
      docHeight: document.documentElement.scrollHeight,
      docWidth: document.documentElement.scrollWidth
    }));
    if (touched === 0) {
      unclippedInfo = { available: false, reason: 'no-clipper-found' };
    } else if (expanded.docHeight > MAX_UNCLIPPED_PX) {
      unclippedInfo = { available: false, reason: `unclipped-height-exceeds-limit (${expanded.docHeight}px)` };
    } else if (expanded.docHeight <= Math.round(viewportHeight) + 4) {
      unclippedInfo = { available: false, reason: 'unclip-did-not-expand' };
    } else {
      const unclippedPath = join(referenceDir, 'content-unclipped.png');
      await page.screenshot({ path: unclippedPath, fullPage: true });
      const size = await pngSize(unclippedPath);
      unclippedInfo = {
        available: true,
        path: 'content-unclipped.png',
        docHeightPx: expanded.docHeight,
        docWidthPx: expanded.docWidth,
        pixelWidth: size ? size.width : null,
        pixelHeight: size ? size.height : null,
        widthDriftPx: size ? size.width - Math.round(viewportWidth * deviceScaleFactor) : null,
        equivalence: 'not-comparable'
      };
      facts.uncertainties.push(
        `content-unclipped.png lifts the artboard clipping to show the hidden ${expanded.docHeight - Math.round(viewportHeight)}px of content; the layout re-flowed (content width ${expanded.docWidth}px, ${Math.abs(unclippedInfo.widthDriftPx ?? 0)}px wider than the reference frame), so it is human-only and must never be used as calibration evidence`
      );
    }
  }

  const htmlBuffer = await readFile(absoluteHtmlPath);
  // Two different coverages matter and must never be conflated:
  //   coverage        - how much of the *scrollable* content the frames captured
  //   visibleCoverage - how much of the *design content extent* those frames show
  // Pixso/Figma exports are often clipped artboards: the artboard does not
  // scroll, so the frames cannot show the rows below the fold even though the
  // DOM and the facts still describe them.
  const contentExtentPx = Math.max(
    Math.round(viewportHeight),
    ...facts.nodes.map((node) => Math.round((node.rect.y + node.rect.h) * 100) / 100)
  );
  const capturedPx = frameNames.length * Math.round(viewportHeight);
  const visibleCoverage = Math.round(Math.min(1, capturedPx / contentExtentPx) * 10000) / 10000;
  if (scrollInfo.horizontalOverflow > 1) {
    facts.uncertainties.push(
      `design content is ${scrollInfo.horizontalOverflow}px wider than the viewport; horizontal overflow is measured but not captured as frames`
    );
  }
  if (imageInfo.pending > 0) {
    facts.uncertainties.push(
      `${imageInfo.pending} of ${imageInfo.total} image(s) did not finish decoding before measurement; their frames may be blank`
    );
  }
  if (visibleCoverage < 1) {
    facts.uncertainties.push(
      `the design is a clipped artboard: its content extends to ${contentExtentPx}px but only ${capturedPx}px is visible, so ${Math.round((1 - visibleCoverage) * 100)}% of the design has layout facts but no visual reference`
    );
  }
  const coverage = Math.round((scrollInfo.scrollHeight / stepHeight) * 10000) / 10000;
  const payload = {
    schemaVersion: 1,
    designSource: 'others-html',
    producer: { tool: 'html_source_capture', version: 1, createdAt: new Date().toISOString() },
    source: { path: sourceRelativePath, sha256: sha256(htmlBuffer), size: htmlBuffer.byteLength },
    render: {
      deviceScaleFactor,
      viewport: { width: Math.round(viewportWidth), height: Math.round(viewportHeight) },
      canvas: {
        logicalWidth: Math.round(viewportWidth),
        logicalHeight: Math.round(viewportHeight),
        physicalWidth: Math.round(viewportWidth * deviceScaleFactor),
        physicalHeight: Math.round(viewportHeight * deviceScaleFactor)
      },
      content: {
        scrollHeightPx: scrollInfo.scrollHeight,
        extentPx: contentExtentPx,
        frames: frameNames.length,
        coverage,
        visibleCoverage
      },
      scrollContainer: scrollInfo.container,
      horizontalOverflowPx: scrollInfo.horizontalOverflow,
      // Persisted so stage 5 can exclude the system UI bands by measurement
      // instead of re-using a value copied from another run.
      statusBarVp,
      gestureBarVp,
      // References that do not resolve beside the html file mean the frames
      // were rendered without those images. Stage 1 has to see that number
      // instead of trusting a reference set that looks complete.
      resources: {
        total: resourceAudit.total,
        missing: resourceAudit.missing,
        remote: resourceAudit.remote,
        samples: resourceAudit.samples
      }
    },
    reference: {
      dir: 'source/html/reference',
      frames: frameNames,
      contentFull: 'content-full.png',
      unclipped: unclippedInfo
    },
    nodes: facts.nodes,
    systemUi: facts.systemUi,
    uncertainties: facts.uncertainties
  };

  await mkdir(join(runDir, 'stage1'), { recursive: true });
  await writeFile(join(runDir, 'stage1', 'layout-facts.json'), `${JSON.stringify(payload, null, 2)}\n`, 'utf8');

  console.log(
    `captured ${absoluteHtmlPath} -> ${runDir} (${payload.nodes.length} nodes, ${frameNames.length} frames, coverage ${coverage}, visible ${visibleCoverage})`
  );
} catch (error) {
  console.error('capture failed: ' + (error?.message ?? String(error)));
  process.exitCode = 1;
} finally {
  await browser.close().catch(() => {});
}
