#!/usr/bin/env node

import { createHash, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MASTERGO_CONTRACT, MASTERGO_RUN_STATE, MASTERGO_CONFIRMATION_FILES, collectMasterGoInputIssues, collectMasterGoStage2Issues, collectMasterGoConfirmationIssues } from './mastergo-source.mjs';
import { LANHU_RUN_STATE, collectLanhuInputIssues, collectLanhuStage2Issues, collectLanhuConfirmationIssues, collectLanhuRecoveryIssues, lanhuRecoveryInputPaths } from './lanhu-workflow.mjs';

// Run files may be written by the host shell (PowerShell 5.1 UTF-8 emits a
// BOM); JSON.parse throws on a leading U+FEFF, so strip it before parsing.
function readJsonFile(path) {
  const raw = readFileSync(path, 'utf8')
  return JSON.parse(raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw)
}

const DESIGN_DOC_RECOVERY_REQUEST = 'design-doc-recovery-request.json';
const REPO_CONTEXT_JSON = 'stage2/repo-context.json';

const VALID_MODES = new Set(['init', 'status', 'stage-start', 'confirm', 'stage-complete', 'reacquire']);
const VALID_DECISIONS = new Set(['request', 'accepted', 'revision-requested']);
const VALID_RESULTS = new Set(['passed', 'blocked']);
const VALID_SOURCES = new Set(['pixso', 'figma', 'mastergo', 'lanhu', 'others-html', 'others-visual']);
const VALID_REASON_CODES = new Set([
  'build_failed',
  'dependency_unavailable',
  'invalid_input',
  'missing_asset',
  'security_blocked',
  'evidence_invalid',
  'external_tool_failed',
]);

function fail(message) {
  process.stderr.write(`workflow: ${message}\n`);
  process.exit(1);
}

function parseArgs(argv) {
  const result = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith('--')) {
      fail(`unexpected argument: ${token}`);
    }
    const key = token.slice(2);
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) {
      fail(`missing value for --${key}`);
    }
    result[key] = value;
    index += 1;
  }
  return result;
}

function readJson(path, label) {
  try {
    return readJsonFile(path);
  } catch (error) {
    fail(`${label} is missing or invalid JSON: ${path} (${error.message})`);
  }
}

function readJsonOrNull(path, label, issues) {
  if (!existsSync(path)) {
    issues.push(`${label} is missing: ${path}`);
    return null;
  }
  try {
    return readJsonFile(path);
  } catch (error) {
    issues.push(`${label} is invalid JSON: ${path} (${error.message})`);
    return null;
  }
}

function writeJsonAtomic(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = path + '.tmp';
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  renameSync(tmp, path);
}

function hashFile(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function gatePath(runDir, stage) {
  return join(runDir, 'stage-gates', `stage${String(stage).padStart(2, '0')}-gate.json`);
}

function readGate(runDir, stage) {
  const path = gatePath(runDir, stage);
  if (!existsSync(path)) {
    return null;
  }
  return readJson(path, `stage ${stage} gate`);
}

function isPassed(gate) {
  return gate?.status === 'passed';
}

function resolveEvidencePath(runDir, value, label, issues) {
  if (typeof value !== 'string' || value.length === 0) {
    issues.push(`${label} path is missing`);
    return null;
  }
  const path = resolve(runDir, value);
  const pathFromRunDir = relative(runDir, path);
  if (pathFromRunDir.startsWith('..') || isAbsolute(pathFromRunDir)) {
    issues.push(`${label} must stay inside the run directory`);
    return null;
  }
  return path;
}

function reportCheckPassed(report, name) {
  if (report?.checks && !Array.isArray(report.checks)) {
    return report.checks[name] === true;
  }
  if (Array.isArray(report?.checks)) {
    const check = report.checks.find((item) => item?.name === name);
    return check?.result === true || check?.result === 'pass' || check?.status === 'passed';
  }
  return false;
}

const FIGMA_COMPONENT_RECOGNITION_IMAGE = 'source/figma/component-recognition-screenshot.png';
const FIGMA_REFERENCE_SCREENSHOT = 'source/figma/reference-screenshot.png';

function collectComponentRecognitionEvidenceIssues(runDir, designSource = 'figma') {
  const expectedImage = designSource === 'lanhu' ? 'source/lanhu/component-recognition.png' : FIGMA_COMPONENT_RECOGNITION_IMAGE.replace('figma', designSource);
  const referenceScreenshot = FIGMA_REFERENCE_SCREENSHOT.replace('figma', designSource);
  const issues = [];
  const artifactPath = join(runDir, 'stage2', 'component-vision-analysis.json');
  if (existsSync(artifactPath) && statSync(artifactPath).size > 2 * 1024 * 1024) {
    issues.push(`stage 2 component recognition artifact exceeds the 2 MB limit: ${artifactPath}`);
    return issues;
  }
  const artifact = readJsonOrNull(
    artifactPath,
    'stage 2 component recognition artifact',
    issues
  );
  if (!artifact) {
    return issues;
  }

  if (artifact.schemaVersion !== 1 && artifact.schemaVersion !== 2) {
    issues.push('stage 2 component recognition artifact schemaVersion must equal 1 or 2');
  }
  if (
    artifact.producer?.tool !== 'recognize_ui_components' ||
    typeof artifact.producer?.model !== 'string' ||
    artifact.producer.model.length === 0 ||
    typeof artifact.producer?.invocationId !== 'string' ||
    artifact.producer.invocationId.length === 0 ||
    typeof artifact.producer?.createdAt !== 'string' ||
    !Number.isFinite(Date.parse(artifact.producer.createdAt))
  ) {
    issues.push('stage 2 component recognition artifact producer metadata is invalid');
  }

  if (artifact.schemaVersion === 2 && artifact.status !== 'ok' && artifact.status !== 'degraded') {
    issues.push('stage 2 component recognition artifact status must be ok or degraded for schemaVersion 2');
  }

  if (artifact.inputs?.source !== undefined) {
    issues.push('stage 2 component recognition must not include source input');
  }

  const image = artifact.inputs?.image;
  const normalizedPath = typeof image?.path === 'string' ? image.path.replaceAll('\\', '/') : '';
  if (
    normalizedPath.length === 0 ||
    isAbsolute(normalizedPath) ||
    normalizedPath.split('/').includes('..') ||
    !normalizedPath.endsWith(expectedImage)
  ) {
    if (normalizedPath.endsWith(referenceScreenshot)) {
      issues.push(
        `stage 2 component recognition image must not use the 2x ${referenceScreenshot}`
      );
    } else {
      issues.push('stage 2 component recognition image path is invalid');
    }
  }
  if (typeof image?.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(image.sha256)) {
    issues.push('stage 2 component recognition image sha256 is invalid');
  } else {
    const expectedPath = join(runDir, ...expectedImage.split('/'));
    if (!existsSync(expectedPath) || !statSync(expectedPath).isFile()) {
      issues.push(`stage 2 component recognition image input is missing: ${expectedPath}`);
    } else if (hashFile(expectedPath) !== image.sha256) {
      issues.push('stage 2 component recognition image sha256 does not match the current input');
    }
  }

  const requirements = artifact.inputs?.requirements;
  if (
    typeof requirements?.text !== 'string' ||
    requirements.text.length > 8000 ||
    typeof requirements?.sha256 !== 'string' ||
    sha256Text(requirements?.text ?? '') !== requirements?.sha256
  ) {
    issues.push('stage 2 component recognition requirements evidence is invalid');
  }

  const analysisError = validateComponentRecognitionAnalysis(artifact);
  if (analysisError) {
    issues.push(analysisError);
  }
  return issues;
}

function validateComponentRecognitionAnalysis(artifact) {
  if (artifact.schemaVersion === 1) {
    return isValidLegacyComponentRecognitionAnalysis(artifact.analysis)
      ? null
      : 'stage 2 component recognition analysis does not match the required schema';
  }
  if (artifact.schemaVersion === 2 && artifact.status === 'ok') {
    return isValidComponentRecognitionInventory(artifact.analysis)
      ? null
      : 'stage 2 component recognition analysis does not match the required schema';
  }
  if (artifact.schemaVersion === 2 && artifact.status === 'degraded') {
    return isValidComponentRecognitionDegraded(artifact)
      ? null
      : 'stage 2 component recognition degraded evidence does not match the required schema';
  }
  return 'stage 2 component recognition artifact schemaVersion or status is not supported';
}

function collectFigmaStage1EvidenceIssues(runDir, catalog, ctx = {}) {
  const issues = [];
  const manifest = readJsonOrNull(
    join(runDir, 'inputs-manifest.json'),
    'stage 1 inputs manifest',
    issues
  );
  if (!manifest) {
    return issues;
  }

  const screenshots = manifest.screenshots;
  if (!screenshots || typeof screenshots !== 'object') {
    issues.push('stage 1 inputs manifest must record screenshots for the figma source');
    return issues;
  }

  for (const [name, expectedPath, expectedPurpose, expectedScale] of [
    ['reference', FIGMA_REFERENCE_SCREENSHOT, 'general-visual-reference', 2],
    ['componentRecognition', FIGMA_COMPONENT_RECOGNITION_IMAGE, 'recognize-ui-components-only', 1]
  ]) {
    const entry = screenshots[name];
    const normalizedPath =
      typeof entry?.path === 'string' ? entry.path.replaceAll('\\', '/') : '';
    if (
      normalizedPath.length === 0 ||
      isAbsolute(normalizedPath) ||
      normalizedPath.split('/').includes('..') ||
      normalizedPath !== expectedPath
    ) {
      issues.push(`stage 1 screenshot ${name} path must be ${expectedPath}`);
    }
    if (entry?.purpose !== expectedPurpose) {
      issues.push(`stage 1 screenshot ${name} purpose must be ${expectedPurpose}`);
    }
    if (entry?.scale !== expectedScale) {
      issues.push(`stage 1 screenshot ${name} scale must be ${expectedScale}`);
    }
    if (
      !isPositiveBoundedNumber(entry?.width, 100000) ||
      !isPositiveBoundedNumber(entry?.height, 100000) ||
      typeof entry?.size !== 'number' ||
      !Number.isFinite(entry.size) ||
      entry.size <= 0
    ) {
      issues.push(`stage 1 screenshot ${name} dimensions and size must be positive numbers`);
    }
    if (typeof entry?.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(entry.sha256)) {
      issues.push(`stage 1 screenshot ${name} sha256 is invalid`);
      continue;
    }
    const filePath = join(runDir, ...expectedPath.split('/'));
    if (!existsSync(filePath) || !statSync(filePath).isFile()) {
      issues.push(`stage 1 screenshot ${name} file is missing: ${expectedPath}`);
    } else if (hashFile(filePath) !== entry.sha256) {
      issues.push(`stage 1 screenshot ${name} sha256 does not match the current file`);
    }
  }

  const reference = screenshots.reference;
  const componentRecognition = screenshots.componentRecognition;
  if (
    isPositiveBoundedNumber(reference?.width, 100000) &&
    isPositiveBoundedNumber(reference?.height, 100000) &&
    isPositiveBoundedNumber(componentRecognition?.width, 100000) &&
    isPositiveBoundedNumber(componentRecognition?.height, 100000)
  ) {
    if (
      reference.width !== componentRecognition.width * 2 ||
      reference.height !== componentRecognition.height * 2
    ) {
      issues.push(
        'stage 1 screenshots must render the same target node: the 2x reference dimensions must be exactly twice the 1x component recognition dimensions'
      );
    }
  }
  issues.push(...collectPageStage1IntegrationIssues(runDir, catalog, manifest, ctx));
  return issues;
}

const PAGE_REQUIRED_SNAPSHOT_FIELDS = [
  'projectRootPath',
  'runIndexFile',
  'existingGeneratedPages',
  'existingGeneratedRoutes',
  'startupPageBefore',
  'defaultPageBefore',
  'indexPageFile',
  'entryAbilityFile',
  'mainPagesFile',
  'registrationMode',
];

function collectPageStage1IntegrationIssues(runDir, catalog, manifest, ctx = {}) {
  const issues = [];
  const snapshot = manifest.integrationSnapshot;
  if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) {
    issues.push('stage 1 integrationSnapshot is missing');
    return issues;
  }
  for (const field of PAGE_REQUIRED_SNAPSHOT_FIELDS) {
    if (snapshot[field] === undefined || snapshot[field] === null) {
      issues.push(`stage 1 integrationSnapshot.${field} is missing`);
    }
  }
  if (typeof snapshot.existingGeneratedPages !== 'object' || !Array.isArray(snapshot.existingGeneratedPages)) {
    issues.push('stage 1 integrationSnapshot.existingGeneratedPages must be an array');
  }
  if (typeof snapshot.existingGeneratedRoutes !== 'object' || !Array.isArray(snapshot.existingGeneratedRoutes)) {
    issues.push('stage 1 integrationSnapshot.existingGeneratedRoutes must be an array');
  }
  if (!PAGE_VALID_REGISTRATION_MODES.has(snapshot.registrationMode)) {
    issues.push('stage 1 integrationSnapshot.registrationMode must be index-navigation, route-table or existing-router');
  }
  // The global run-index is variant-scoped and shared between Figma and Pixso;
  // a mismatched path would silently split or cross-read the wrong index.
  const expectedRunIndexFile = defaultRunIndexFile(catalog.variant);
  if (snapshot.runIndexFile !== expectedRunIndexFile) {
    issues.push(
      `stage 1 integrationSnapshot.runIndexFile must match the ${catalog.variant} workflow index path: ${expectedRunIndexFile}`
    );
  }

  const projectRoot = resolveLockedProjectRoot(
    runDir,
    snapshot.projectRootPath,
    'stage 1 integrationSnapshot.projectRootPath',
    issues
  );
  if (!projectRoot) {
    return issues;
  }
  if (!isArkUIProject(projectRoot)) {
    issues.push(`stage 1 integrationSnapshot.projectRootPath is not an ArkUI project (missing AppScope/app.json5 or entry/src/main/module.json5): ${snapshot.projectRootPath}`);
  }

  const appFiles = [
    ['integrationSnapshot.indexPageFile', snapshot.indexPageFile, 'Index'],
    ['integrationSnapshot.entryAbilityFile', snapshot.entryAbilityFile, 'EntryAbility'],
    ['integrationSnapshot.mainPagesFile', snapshot.mainPagesFile, 'main_pages'],
  ];
  for (const [label, rel, humanLabel] of appFiles) {
    const path = resolveProjectFile(projectRoot, rel, `stage 1 ${label}`, issues);
    if (path && (!existsSync(path) || !statSync(path).isFile())) {
      issues.push(`stage 1 ${humanLabel} file does not exist within projectRoot: ${rel}`);
    }
  }

  const entryFile = readProjectFile(projectRoot, snapshot.entryAbilityFile, 'stage 1 integrationSnapshot.entryAbilityFile', issues);
  const startupBefore = typeof snapshot.startupPageBefore === 'string' ? snapshot.startupPageBefore : 'pages/Index';
  if (ctx.live && entryFile.content !== null) {
    const loaded = findLoadContentPage(entryFile.content);
    if (loaded === null) {
      issues.push('stage 1 EntryAbility must load the startup page through a loadContent string literal argument; the loaded page could not be determined');
    } else if (loaded !== startupBefore) {
      issues.push(`stage 1 EntryAbility actually loads "${loaded}", but integrationSnapshot.startupPageBefore is "${startupBefore}"`);
    }
  }

  const mainPagesFile = readProjectFile(projectRoot, snapshot.mainPagesFile, 'stage 1 integrationSnapshot.mainPagesFile', issues);
  if (ctx.live && mainPagesFile.content !== null) {
    const src = parseMainPagesSrc(mainPagesFile.content);
    if (src === null) {
      issues.push('stage 1 main_pages.json is not valid JSON');
    } else if (!src.includes(startupBefore)) {
      issues.push(`stage 1 main_pages.json must contain ${startupBefore}`);
    }
  }

  const declaredPages = Array.isArray(snapshot.existingGeneratedPages) ? snapshot.existingGeneratedPages : [];
  const declaredRoutes = Array.isArray(snapshot.existingGeneratedRoutes) ? snapshot.existingGeneratedRoutes : [];
  const { pages } = readRunIndexPages(projectRoot, snapshot.runIndexFile, issues);
  // The snapshot describes the project state before this run started. Records
  // legitimately added by the current run (stage 2 completion) are excluded from
  // the comparison, but only after identity validation against the stage 2
  // policy; anything else that differs from the snapshot is an error.
  const stage2 = ctx.stage2 ?? null;
  const declaredPageSet = new Set(declaredPages.map((page) => String(page)));
  const isCurrentRunRecord = (page) =>
    !!page && typeof page === 'object' &&
    page.designSource === (catalog.designSource ?? 'figma') && page.runId === stage2?.runId;
  if (stage2 && stage2.scenario !== 'pre-commit' && stage2.identity) {
    const comparablePages = pages.filter((page) => {
      if (!isCurrentRunRecord(page)) return true;
      // A record already covered by the snapshot is historical (runId collision),
      // never a newly added current-run record.
      if (declaredPageSet.has(String(page.pageFile ?? ''))) return true;
      return !matchesStage2Identity(page, stage2.identity);
    });
    collectStage1PageComparisonIssues(projectRoot, comparablePages, declaredPages, declaredRoutes, issues);
  } else {
    if (stage2) {
      for (const page of pages) {
        if (isCurrentRunRecord(page) && !declaredPageSet.has(String(page.pageFile ?? ''))) {
          issues.push(stage2.scenario === 'pre-commit'
            ? 'run-index contains a record for the current run before stage 2 completion; the controller writes it during stage-complete 2'
            : 'run-index contains a current-run record but the stage 2 target identity is unavailable; restore stage2/startup-page-policy.json');
        }
      }
    }
    collectStage1PageComparisonIssues(projectRoot, pages, declaredPages, declaredRoutes, issues);
  }
  return issues;
}

function collectStage1PageComparisonIssues(projectRoot, pages, declaredPages, declaredRoutes, issues) {
  const actualPages = pages.map((page) => page?.pageFile);
  const actualRoutes = pages.map((page) => page?.route);
  if (sortedStringify(declaredPages) !== sortedStringify(actualPages)) {
    issues.push('stage 1 integrationSnapshot.existingGeneratedPages does not match the real run-index');
  }
  if (sortedStringify(declaredRoutes) !== sortedStringify(actualRoutes)) {
    issues.push('stage 1 integrationSnapshot.existingGeneratedRoutes does not match the real run-index');
  }

  for (const pageFile of actualPages) {
    const path = resolveProjectFile(projectRoot, pageFile, 'stage 1 run-index historical page file', issues);
    if (path && (!existsSync(path) || !statSync(path).isFile())) {
      issues.push(`stage 1 historical generated page no longer exists: ${pageFile}`);
    }
  }
}

function sortedStringify(values) {
  return JSON.stringify([...(values ?? [])].map((value) => String(value)).sort());
}

function sha256Text(value) {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

const PAGE_STAGE2_STARTUP_POLICY = 'stage2/startup-page-policy.json';
const PAGE_STAGE2_GENERATED_MANIFEST = 'stage2/generated-ui-manifest.json';
const PAGE_STAGE2_INITIAL_BUILD_REPORT = 'stage2/initial-build-report.json';
const PAGE_VALID_REGISTRATION_MODES = new Set(['index-navigation', 'route-table', 'existing-router']);

function resolveLockedProjectRoot(runDir, value, label, issues) {
  if (typeof value !== 'string' || value.length === 0) {
    issues.push(`${label} is missing`);
    return null;
  }
  const root = isAbsolute(value) ? resolve(value) : resolve(runDir, value);
  if (!existsSync(root) || !statSync(root).isDirectory()) {
    issues.push(`${label} is not an existing directory: ${value}`);
    return null;
  }
  return root;
}

function isArkUIProject(projectRoot) {
  return (
    existsSync(join(projectRoot, 'AppScope', 'app.json5')) ||
    existsSync(join(projectRoot, 'entry', 'src', 'main', 'module.json5'))
  );
}

function stripArkTsComments(content) {
  let result = '';
  let index = 0;
  const length = content.length;
  while (index < length) {
    const ch = content[index];
    const next = content[index + 1];
    if (ch === "'" || ch === '"' || ch === '`') {
      const quote = ch;
      result += ch;
      index += 1;
      while (index < length) {
        if (content[index] === '\\') {
          result += content[index] + (content[index + 1] ?? '');
          index += 2;
          continue;
        }
        result += content[index];
        if (content[index] === quote) {
          index += 1;
          break;
        }
        index += 1;
      }
    } else if (ch === '/' && next === '/') {
      while (index < length && content[index] !== '\n') index += 1;
    } else if (ch === '/' && next === '*') {
      index += 2;
      while (index < length && !(content[index] === '*' && content[index + 1] === '/')) index += 1;
      index += 2;
    } else {
      result += ch;
      index += 1;
    }
  }
  return result;
}

function hasArkTsDecorator(content, decorator) {
  return new RegExp(`^\\s*@${decorator}\\b`, 'm').test(stripArkTsComments(content));
}

function isArkTsIdentifier(value) {
  return typeof value === 'string' && /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(value);
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function hasDecoratedExportStruct(content, decorator, componentName) {
  const stripped = stripArkTsComments(content);
  const componentPattern = escapeRegExp(componentName);
  const decl = new RegExp(`(^|[^\\w$])export\\s+struct\\s+${componentPattern}\\b`, 'm');
  const match = decl.exec(stripped);
  if (!match) return false;
  const declIndex = match.index + match[1].length;
  const after = stripped.slice(declIndex + `export struct ${componentName}`.length);
  if (!/^\s*\{/.test(after)) return false;
  // Walk backwards from the declaration over whitespace and other legal decorators.
  // The target decorator must directly precede the export, possibly with other
  // decorators, whitespace, or decorator argument lists in between.
  let end = declIndex;
  while (end > 0) {
    // Skip trailing whitespace before the declaration
    let start = end;
    while (start > 0 && /\s/.test(stripped[start - 1])) start -= 1;
    if (start === 0) return false;
    // Expect a decorator (optionally with a balanced argument list) ending at `start`
    const before = stripped.slice(0, start);
    const decoratorMatch = /@[\w$]+(\s*\([^()]*\))?[\s]*$/.exec(before);
    if (!decoratorMatch) return false;
    const decoratorStart = start - decoratorMatch[0].length;
    const nameOnly = /^@[\w$]+/.exec(decoratorMatch[0]);
    if (nameOnly && nameOnly[0] === `@${decorator}`) return true;
    end = decoratorStart;
  }
  return false;
}

function isComponentInstantiated(content, componentName) {
  const stripped = stripArkTsComments(content);
  return new RegExp(`(^|[^\\w$])${escapeRegExp(componentName)}\\s*\\(`).test(stripped);
}

function routeAndComponentRegisteredTogether(content, route, component) {
  const stripped = stripArkTsComments(content);
  const routePattern = escapeRegExp(route);
  const componentPattern = escapeRegExp(component);
  const pairPatterns = [
    new RegExp(`['"]${routePattern}['"]\\s*:\\s*${componentPattern}\\b`),
    new RegExp(`\\.set\\s*\\(\\s*['"]${routePattern}['"]\\s*,\\s*${componentPattern}\\b`),
    new RegExp(`['"]${routePattern}['"]\\s*,\\s*${componentPattern}\\s*[,)]`),
    new RegExp(`\\(\\s*\\{\\s*[^(){}]*['"]${routePattern}['"][^(){}]*${componentPattern}[^(){}]*\\}\\s*\\)`)
  ];
  return pairPatterns.some((pattern) => pattern.test(stripped));
}

const LOAD_CONTENT_CALL = 'loadContent';

// Extracts the page path when the first loadContent argument is a plain string
// literal followed by the argument separator or the closing parenthesis.
// Dynamic expressions, template literals, and string concatenations stay
// unresolved (null) instead of guessing a partial path.
function extractLoadContentFirstArgument(stripped, openParenIndex) {
  let index = openParenIndex;
  while (index < stripped.length && /\s/.test(stripped[index])) index += 1;
  const quote = stripped[index];
  if (quote !== "'" && quote !== '"') {
    return null;
  }
  index += 1;
  let value = '';
  while (index < stripped.length) {
    const ch = stripped[index];
    if (ch === '\\') {
      const escaped = stripped[index + 1];
      if (escaped === undefined) {
        return null;
      }
      value += escaped;
      index += 2;
      continue;
    }
    if (ch === quote) {
      index += 1;
      break;
    }
    value += ch;
    index += 1;
    if (value.length > 4096) {
      return null;
    }
  }
  if (index > stripped.length || stripped[index - 1] !== quote) {
    return null;
  }
  let after = index;
  while (after < stripped.length && /\s/.test(stripped[after])) after += 1;
  if (after >= stripped.length || (stripped[after] !== ')' && stripped[after] !== ',')) {
    return null;
  }
  return value;
}

// Scans comment-stripped source outside string literals so that example text
// inside comments or ordinary strings is never treated as a real call.
function findLoadContentPage(content) {
  const stripped = stripArkTsComments(content);
  const length = stripped.length;
  let index = 0;
  while (index < length) {
    const ch = stripped[index];
    if (ch === "'" || ch === '"' || ch === '`') {
      const quote = ch;
      index += 1;
      while (index < length) {
        if (stripped[index] === '\\') {
          index += 2;
          continue;
        }
        if (stripped[index] === quote) {
          index += 1;
          break;
        }
        index += 1;
      }
      continue;
    }
    if (
      ch === 'l' &&
      stripped.startsWith(LOAD_CONTENT_CALL, index) &&
      (index === 0 || !/[A-Za-z0-9_$]/.test(stripped[index - 1]))
    ) {
      let parenIndex = index + LOAD_CONTENT_CALL.length;
      while (parenIndex < length && /\s/.test(stripped[parenIndex])) parenIndex += 1;
      if (parenIndex < length && stripped[parenIndex] === '(') {
        return extractLoadContentFirstArgument(stripped, parenIndex + 1);
      }
      index += LOAD_CONTENT_CALL.length;
      continue;
    }
    index += 1;
  }
  return null;
}

function parseMainPagesSrc(content) {
  try {
    const parsed = JSON.parse(stripArkTsComments(content));
    const src = parsed?.src;
    return Array.isArray(src) ? src : null;
  } catch {
    return null;
  }
}

function readRunIndexPages(projectRoot, runIndexFileRel, issues) {
  if (typeof runIndexFileRel !== 'string' || runIndexFileRel.length === 0) {
    issues.push('run-index path is missing');
    return { path: null, pages: [], exists: false };
  }
  const indexPath = resolve(projectRoot, runIndexFileRel);
  const relFromRoot = relative(projectRoot, indexPath);
  if (relFromRoot.startsWith('..') || isAbsolute(relFromRoot)) {
    issues.push(`run-index path must stay within the project root: ${runIndexFileRel}`);
    return { path: null, pages: [], exists: false };
  }
  if (!existsSync(indexPath)) {
    return { path: indexPath, pages: [], exists: false };
  }
  if (!statSync(indexPath).isFile()) {
    issues.push(`run-index is not a file: ${runIndexFileRel}`);
    return { path: indexPath, pages: [], exists: false };
  }
  let parsed;
  try {
    parsed = readJsonFile(indexPath);
  } catch (error) {
    issues.push(`run-index is invalid JSON: ${runIndexFileRel} (${error.message})`);
    return { path: indexPath, pages: [], exists: false };
  }
  if (!Array.isArray(parsed?.pages)) {
    issues.push(`run-index pages must be an array: ${runIndexFileRel}`);
    return { path: indexPath, pages: [], exists: false };
  }
  return { path: indexPath, pages: parsed.pages, exists: true };
}

function targetRegistrationFileOf(policy) {
  if (typeof policy.targetRegistrationFile === 'string' && policy.targetRegistrationFile.length > 0) {
    return policy.targetRegistrationFile;
  }
  if (policy.targetRegistrationMode === 'index-navigation') {
    return policy.indexPageFile;
  }
  return undefined;
}

function resolveProjectFile(projectRoot, rel, label, issues) {
  if (typeof rel !== 'string' || rel.length === 0) {
    issues.push(`${label} is missing`);
    return null;
  }
  const path = resolve(projectRoot, rel);
  const relFromRoot = relative(projectRoot, path);
  if (relFromRoot.startsWith('..') || isAbsolute(relFromRoot)) {
    issues.push(`${label} must stay within the project root: ${rel}`);
    return null;
  }
  return path;
}

function readProjectFile(projectRoot, rel, label, issues) {
  const path = resolveProjectFile(projectRoot, rel, label, issues);
  if (!path) {
    return { path: null, content: null };
  }
  if (!existsSync(path) || !statSync(path).isFile()) {
    issues.push(`${label} is missing: ${rel}`);
    return { path, content: null };
  }
  return { path, content: readFileSync(path, 'utf8') };
}

// Stage 2 run-index validation scenarios, derived from persisted state and the
// stage 2 gate — never from caller-provided stage numbers or file timestamps.
//   pre-commit: stage 2 not completed and no valid passed gate; the current-run
//               record must not exist yet (the controller writes it).
//   recovery:   gate written (and for Full, confirmation accepted) but state not
//               advanced; the interrupted stage-complete 2 may be replayed, so
//               0 or 1 identity-validated current records are allowed.
//   completed:  stage 2 in completedStages; exactly 1 current record is required
//               and later stages may legitimately edit the page content, so the
//               registered content hash is not re-compared.
function derivePageStage2IndexContext(runDir, catalog, state) {
  if (!['figma', 'mastergo', 'lanhu', 'others-html', 'others-visual'].includes(catalog.designSource)) {
    return null;
  }
  const runId = basename(runDir);
  if (state.completedStages.includes(2)) {
    return { scenario: 'completed', designSource: catalog.designSource, runId, identity: readStage2TargetIdentity(runDir) };
  }
  const gate = readGateOrNull(runDir, 2);
  const stage2Confirmed = !requiresPageStage2Confirmation(catalog, 2) ||
    (Array.isArray(state.confirmedStages) && state.confirmedStages.includes(2));
  if (
    Number(gate?.stage) === 2 &&
    gate?.status === 'passed' &&
    state.currentStage === 2 &&
    state.status === 'running' &&
    stage2Confirmed
  ) {
    return { scenario: 'recovery', designSource: catalog.designSource, runId, identity: readStage2TargetIdentity(runDir) };
  }
  return { scenario: 'pre-commit', designSource: catalog.designSource, runId, identity: null };
}

function readGateOrNull(runDir, stage) {
  const path = gatePath(runDir, stage);
  if (!existsSync(path)) {
    return null;
  }
  try {
    return readJsonFile(path);
  } catch {
    return null;
  }
}

function readStage2TargetIdentity(runDir) {
  const policyPath = join(runDir, PAGE_STAGE2_STARTUP_POLICY);
  if (!existsSync(policyPath) || !statSync(policyPath).isFile()) {
    return null;
  }
  let policy;
  try {
    policy = readJsonFile(policyPath);
  } catch {
    return null;
  }
  const pageFile = typeof policy.targetPageFile === 'string' && policy.targetPageFile.length > 0
    ? policy.targetPageFile.replaceAll('\\', '/')
    : null;
  const componentName = isArkTsIdentifier(policy.targetComponentName)
    ? policy.targetComponentName
    : null;
  const route = typeof policy.targetRoute === 'string' && policy.targetRoute.length > 0
    ? policy.targetRoute
    : null;
  if (!pageFile || !componentName || !route) {
    return null;
  }
  return { pageFile, componentName, route };
}

function matchesStage2Identity(record, identity) {
  return !!identity &&
    String(record.pageFile ?? '').replaceAll('\\', '/') === identity.pageFile &&
    record.componentName === identity.componentName &&
    record.route === identity.route;
}

function collectRunIndexIssues(runDir, projectRoot, policy, targetComponentName, targetRoute, indexContext) {
  const issues = [];
  const runId = basename(runDir);
  const { pages, exists } = readRunIndexPages(projectRoot, policy.runIndexFile, issues);
  const pageFile = policy.targetPageFile;
  const normalizedTargetPage = String(pageFile ?? '').replaceAll('\\', '/');
  const scenario = indexContext?.scenario ?? 'pre-commit';

  let contentSha256 = null;
  const targetPath = resolveProjectFile(projectRoot, pageFile, 'stage 2 target page file hash', issues);
  if (targetPath && existsSync(targetPath) && statSync(targetPath).isFile()) {
    contentSha256 = hashFile(targetPath);
  }

  if (scenario === 'completed' && !exists) {
    issues.push(`run-index is missing although stage 2 is completed: ${policy.runIndexFile}`);
  }

  const currentRecords = [];
  for (const existing of pages) {
    if (!existing || typeof existing !== 'object') {
      continue;
    }
    const existingPage = String(existing.pageFile ?? '').replaceAll('\\', '/');
    const existingPath = resolveProjectFile(projectRoot, existing.pageFile, 'run-index historical page file', issues);
    if (existingPath && (!existsSync(existingPath) || !statSync(existingPath).isFile())) {
      issues.push(`stage 2 historical generated page no longer exists: ${existing.pageFile}`);
    }
    if (typeof existing.registrationFile === 'string' && existing.registrationFile.length > 0) {
      const regPath = resolveProjectFile(projectRoot, existing.registrationFile, 'run-index historical registration file', issues);
      if (regPath && (!existsSync(regPath) || !statSync(regPath).isFile())) {
        issues.push(`stage 2 historical registration file no longer exists: ${existing.registrationFile}`);
      }
    }

    if (existing.designSource === (indexContext?.designSource ?? 'figma') && existing.runId === runId) {
      currentRecords.push(existing);
      continue;
    }

    if (existingPage.length > 0 && existingPage === normalizedTargetPage) {
      issues.push(`stage 2 target page file conflicts with an existing run: ${pageFile}`);
    }
    if (existing.componentName && existing.componentName === targetComponentName) {
      issues.push(`stage 2 target component name conflicts with an existing run: ${targetComponentName}`);
    }
    if (existing.route && existing.route === targetRoute) {
      issues.push(`stage 2 target route conflicts with an existing run: ${targetRoute}`);
    }
  }

  const declaredPageSet = new Set(
    (Array.isArray(indexContext?.declaredPages) ? indexContext.declaredPages : []).map((page) => String(page))
  );
  if (scenario === 'pre-commit') {
    for (const record of currentRecords) {
      if (declaredPageSet.has(String(record.pageFile ?? ''))) {
        issues.push(`stage 2 runId ${runId} collides with a historical run-index record; use a new runId`);
      } else {
        issues.push('stage 2 run-index record for the current run must not exist before stage 2 completion; the controller writes it during stage-complete 2');
      }
    }
    return issues;
  }

  const validCurrentRecords = [];
  for (const record of currentRecords) {
    if (declaredPageSet.has(String(record.pageFile ?? ''))) {
      issues.push(`stage 2 runId ${runId} collides with a historical run-index record; use a new runId`);
      continue;
    }
    if (!matchesStage2Identity(record, { pageFile: normalizedTargetPage, componentName: targetComponentName, route: targetRoute })) {
      issues.push('stage 2 same run with a different target identity or content must use a new runId');
      continue;
    }
    if (scenario === 'recovery' && record.contentSha256 !== contentSha256) {
      // Replay consistency: gate and index are written but state has not
      // advanced, so the submitted page content must still match the
      // registered hash.
      issues.push('stage 2 same run with a different target identity or content must use a new runId');
      continue;
    }
    validCurrentRecords.push(record);
  }
  if (scenario === 'completed' && validCurrentRecords.length !== 1) {
    issues.push('run-index must contain exactly one record for the current run after stage 2 completion');
  }
  if (scenario === 'recovery' && validCurrentRecords.length > 1) {
    issues.push('run-index must contain at most one record for the current run during stage 2 recovery');
  }
  return issues;
}

function collectPageRegistrationEvidenceIssues(runDir, ctx = {}) {
  const issues = [];
  const policy = readJsonOrNull(
    join(runDir, PAGE_STAGE2_STARTUP_POLICY),
    'stage 2 startup page policy',
    issues
  );
  if (!policy) {
    return issues;
  }

  if (policy.preserveIndexEntry !== true) {
    issues.push('stage 2 startup page policy must set preserveIndexEntry=true');
  }
  if (policy.indexRole !== 'stable-navigation-shell') {
    issues.push('stage 2 startup page policy must set indexRole=stable-navigation-shell');
  }
  if (policy.startupPageAfter !== 'pages/Index') {
    issues.push('stage 2 startup page policy must keep startupPageAfter=pages/Index');
  }
  if (policy.entryAbilityLoadContentAfter !== 'pages/Index') {
    issues.push('stage 2 startup page policy must keep entryAbilityLoadContentAfter=pages/Index');
  }
  if (typeof policy.changeDefaultPage !== 'boolean') {
    issues.push('stage 2 startup page policy changeDefaultPage must be a boolean');
  }
  if (typeof policy.targetRegistrationMode !== 'string' ||
    !PAGE_VALID_REGISTRATION_MODES.has(policy.targetRegistrationMode)) {
    issues.push('stage 2 startup page policy targetRegistrationMode must be one of index-navigation, route-table, existing-router');
  }
  for (const key of ['defaultPageBefore', 'defaultPageAfter']) {
    if (typeof policy[key] !== 'string') {
      issues.push(`stage 2 startup page policy ${key} must be a string`);
    }
  }
  if (typeof policy.projectType !== 'string' || !['template', 'business'].includes(policy.projectType)) {
    issues.push('stage 2 startup page policy projectType must be template or business');
  }
  if (typeof policy.userRequestedDefaultChange !== 'boolean') {
    issues.push('stage 2 startup page policy userRequestedDefaultChange must be a boolean');
  }
  const targetComponentName = policy.targetComponentName;
  if (typeof targetComponentName !== 'string' || targetComponentName.length === 0) {
    issues.push('stage 2 startup page policy targetComponentName is missing');
  }
  const validTargetComponentName = isArkTsIdentifier(targetComponentName);
  if (!validTargetComponentName) {
    issues.push('stage 2 startup page policy targetComponentName must be a valid ArkTS identifier');
  }
  const targetRoute = policy.targetRoute;
  if (typeof targetRoute !== 'string' || targetRoute.length === 0) {
    issues.push('stage 2 startup page policy targetRoute is missing');
  }

  const projectRoot = resolveLockedProjectRoot(runDir, policy.projectRootPath, 'stage 2 startup page policy projectRootPath', issues);
  if (!projectRoot) {
    return issues;
  }

  const inputsManifest = readJsonOrNull(
    join(runDir, 'inputs-manifest.json'),
    'stage 1 inputs manifest',
    issues
  );
  const snapshot = inputsManifest?.integrationSnapshot;
  if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) {
    issues.push('stage 1 integrationSnapshot is missing; stage 2 cannot bind the target project');
    return issues;
  }
  const snapshotRoot = resolveLockedProjectRoot(runDir, snapshot.projectRootPath, 'stage 1 integrationSnapshot.projectRootPath', issues);
  if (!snapshotRoot) {
    return issues;
  }
  if (snapshotRoot !== projectRoot) {
    issues.push('stage 2 projectRootPath must equal stage 1 integrationSnapshot.projectRootPath');
  }
  for (const field of ['indexPageFile', 'entryAbilityFile', 'mainPagesFile', 'runIndexFile']) {
    if (String(policy[field] ?? '') !== String(snapshot[field] ?? '')) {
      issues.push(`stage 2 ${field} must equal stage 1 integrationSnapshot.${field}`);
    }
  }

  const indexFile = readProjectFile(projectRoot, policy.indexPageFile, 'stage 2 indexPageFile', issues);
  if (indexFile.content !== null && !hasArkTsDecorator(indexFile.content, 'Entry')) {
    issues.push('stage 2 index page must retain the startup @Entry decorator');
  }

  const targetFile = readProjectFile(projectRoot, policy.targetPageFile, 'stage 2 targetPageFile', issues);
  if (targetFile.content !== null) {
    if (hasArkTsDecorator(targetFile.content, 'Entry')) {
      issues.push('stage 2 target page must not declare @Entry');
    }
    if (validTargetComponentName && !hasDecoratedExportStruct(targetFile.content, 'Component', targetComponentName)) {
      issues.push(`stage 2 target page must be a reusable @Component decorating export struct ${targetComponentName}`)
    }
  }

  const entryFile = readProjectFile(projectRoot, policy.entryAbilityFile, 'stage 2 entryAbilityFile', issues);
  if (entryFile.content !== null) {
    const loaded = findLoadContentPage(entryFile.content);
    if (loaded === null) {
      issues.push('stage 2 EntryAbility must load pages/Index through a loadContent string literal argument; the loaded page could not be determined');
    } else if (loaded !== 'pages/Index') {
      issues.push('stage 2 EntryAbility must still load pages/Index');
    }
  }

  const mainPagesFile = readProjectFile(projectRoot, policy.mainPagesFile, 'stage 2 mainPagesFile', issues);
  if (mainPagesFile.content !== null) {
    const src = parseMainPagesSrc(mainPagesFile.content);
    if (src === null) {
      issues.push('stage 2 main_pages.json must be valid JSON');
    } else if (!src.includes('pages/Index')) {
      issues.push('stage 2 main_pages.json must still contain pages/Index');
    }
  }

  const registrationFileRel = targetRegistrationFileOf(policy);
  if (!registrationFileRel) {
    issues.push(`stage 2 ${policy.targetRegistrationMode} requires startup page policy targetRegistrationFile`);
  } else {
    const registrationFile = readProjectFile(projectRoot, registrationFileRel, 'stage 2 target registration file', issues);
    if (registrationFile.content !== null) {
      if (policy.targetRegistrationMode === 'index-navigation') {
        if (validTargetComponentName && !isComponentInstantiated(registrationFile.content, targetComponentName)) {
          issues.push('stage 2 index-navigation registration must instantiate the target component in Index');
        }
      } else if (validTargetComponentName && !routeAndComponentRegisteredTogether(registrationFile.content, targetRoute, targetComponentName)) {
        issues.push(`stage 2 ${policy.targetRegistrationMode} registration must register the target route and component together`);
      }
    }
  }

  issues.push(...collectRunIndexIssues(runDir, projectRoot, policy, targetComponentName, targetRoute, {
    scenario: ctx.stage2?.scenario ?? 'pre-commit',
    designSource: ctx.stage2?.designSource ?? ctx.designSource ?? 'figma',
    declaredPages: Array.isArray(snapshot.existingGeneratedPages) ? snapshot.existingGeneratedPages : null,
  }));

  const uiManifest = readJsonOrNull(
    join(runDir, PAGE_STAGE2_GENERATED_MANIFEST),
    'stage 2 generated ui manifest',
    issues
  );
  if (uiManifest) {
    const page = uiManifest.page;
    const registration = uiManifest.registration;
    const startup = uiManifest.startup;
    if (typeof page?.file !== 'string' || page.file !== policy.targetPageFile) {
      issues.push('stage 2 generated ui manifest page.file must match startup page policy targetPageFile');
    }
    if (typeof page?.component !== 'string' || page.component !== targetComponentName) {
      issues.push('stage 2 generated ui manifest page.component must match targetComponentName');
    }
    if (page?.hasEntry !== false) {
      issues.push('stage 2 generated ui manifest page.hasEntry must be false');
    }
    if (typeof registration?.file !== 'string' || registration.file !== registrationFileRel) {
      issues.push('stage 2 generated ui manifest registration.file must match the target registration file');
    }
    if (typeof registration?.component !== 'string' || registration.component !== targetComponentName) {
      issues.push('stage 2 generated ui manifest registration.component must match targetComponentName');
    }
    if (typeof registration?.mode !== 'string' || registration.mode !== policy.targetRegistrationMode) {
      issues.push('stage 2 generated ui manifest registration.mode must match targetRegistrationMode');
    }
    if (typeof registration?.route !== 'string' || registration.route !== targetRoute) {
      issues.push('stage 2 generated ui manifest registration.route must match targetRoute');
    }
    if (registration?.default !== policy.changeDefaultPage) {
      issues.push('stage 2 generated ui manifest registration.default must match changeDefaultPage');
    }
    if (startup?.indexFile !== policy.indexPageFile) {
      issues.push('stage 2 generated ui manifest startup.indexFile must match indexPageFile');
    }
    if (startup?.entryAbilityPage !== 'pages/Index') {
      issues.push('stage 2 generated ui manifest startup.entryAbilityPage must be pages/Index');
    }
    if (startup?.mainPagesContainsIndex !== true) {
      issues.push('stage 2 generated ui manifest startup.mainPagesContainsIndex must be true');
    }
  }

  const buildReport = readJsonOrNull(
    join(runDir, PAGE_STAGE2_INITIAL_BUILD_REPORT),
    'stage 2 initial build report',
    issues
  );
  if (buildReport) {
    if (buildReport.success !== true) {
      issues.push('stage 2 initial build report must record success=true');
    }
    if (typeof buildReport.command !== 'string' || buildReport.command.trim().length === 0) {
      issues.push('stage 2 initial build report must record a non-empty command');
    }
    if (buildReport.exitCode !== 0) {
      issues.push('stage 2 initial build report must record exitCode=0');
    }
    if (typeof buildReport.completedAt !== 'string' || !Number.isFinite(Date.parse(buildReport.completedAt))) {
      issues.push('stage 2 initial build report must record a valid completedAt timestamp');
    }
  }

  if (policy.changeDefaultPage === true) {
    if (typeof policy.changeDefaultPageReason !== 'string' || policy.changeDefaultPageReason.length === 0) {
      issues.push('stage 2 must record changeDefaultPageReason when changing the default page');
    }
    const evidence = policy.defaultDecisionEvidence ?? {};
    const templateFirstRun = policy.projectType === 'template' &&
      evidence.templateHelloWorldOnly === true &&
      evidence.hasBusinessHome === false &&
      evidence.hasHistoricalGeneratedPages === false;
    if (!templateFirstRun && policy.userRequestedDefaultChange !== true) {
      issues.push('stage 2 must not change the default page unless it is the first generated page in a template project or the user explicitly requests it');
    }
  } else if (policy.changeDefaultPage === false && policy.defaultPageAfter !== policy.defaultPageBefore) {
    issues.push('stage 2 defaultPageAfter must equal defaultPageBefore when the default page is unchanged');
  }

  return issues;
}

function updateRunIndex(runDir, projectRoot, policy, designSource = 'figma') {
  const runIndexFileRel = policy.runIndexFile;
  const indexPath = resolve(projectRoot, runIndexFileRel);
  const existing = existsSync(indexPath)
    ? readJsonFile(indexPath)
    : { schemaVersion: 1, pages: [] };
  const pages = Array.isArray(existing.pages) ? existing.pages : [];
  const record = {
    designSource,
    runId: basename(runDir),
    pageFile: policy.targetPageFile,
    componentName: policy.targetComponentName,
    route: policy.targetRoute,
    registrationMode: policy.targetRegistrationMode,
    registrationFile: targetRegistrationFileOf(policy),
    default: policy.changeDefaultPage === true,
    contentSha256: hashFile(resolve(projectRoot, policy.targetPageFile)),
  };
  const index = pages.findIndex(
    (page) => page.designSource === record.designSource && page.runId === record.runId && page.pageFile === record.pageFile
  );
  if (index === -1) {
    pages.push(record);
  } else {
    pages[index] = record;
  }
  if (record.default) {
    for (const page of pages) {
      if (page !== record) {
        page.default = false;
      }
    }
  }
  writeJsonAtomic(indexPath, { schemaVersion: 1, pages });
}

// The global run index is variant-scoped: a fast run and a full run must not
// read or write the same file. The writer and the summary check have to
// resolve the default identically, or a fast run writes its record into the
// fast index while the summary looks for it in the full index.
function defaultRunIndexFile(variant) {
  return variant === 'fast' ? '.deveco/design-to-arkts-fast/run-index.json' : '.deveco/design-to-arkts/run-index.json';
}

// The others-html and others-visual sources write the same record shape but
// derive it from the stage 2 generated-ui manifest instead of a startup-page
// policy: neither source touches the default page, so there is no policy
// artifact to read. Sharing one run index lets the sibling sources see each
// other's generated pages instead of re-guessing the project state.
function updateGeneratedUiRunIndex(runDir, variant = 'full', designSource = 'others-html') {
  const manifest = readJsonOrNull(join(runDir, OTHERS_HTML_MANIFEST), 'stage 1 inputs manifest', []);
  const uiManifest = readJsonOrNull(
    join(runDir, ...OTHERS_HTML_UI_MANIFEST.split('/')),
    'stage 2 generated ui manifest',
    []
  );
  const projectRootPath = manifest?.integrationSnapshot?.projectRootPath;
  const pageFile = uiManifest?.page?.file;
  const componentName = uiManifest?.page?.component;
  const registration = uiManifest?.registration ?? {};
  if (
    typeof projectRootPath !== 'string' ||
    projectRootPath.length === 0 ||
    typeof pageFile !== 'string' ||
    pageFile.length === 0 ||
    typeof componentName !== 'string' ||
    componentName.length === 0 ||
    typeof registration.route !== 'string' ||
    registration.route.length === 0 ||
    typeof registration.file !== 'string' ||
    registration.file.length === 0 ||
    typeof registration.mode !== 'string' ||
    registration.mode.length === 0
  ) {
    return;
  }
  const projectRoot = isAbsolute(projectRootPath) ? projectRootPath : resolve(runDir, projectRootPath);
  const defaultRunIndex = defaultRunIndexFile(variant);
  const runIndexFileRel = (manifest?.integrationSnapshot?.runIndexFile ?? defaultRunIndex).toString();
  const indexPath = resolve(projectRoot, runIndexFileRel);
  const existing = existsSync(indexPath) ? readJsonFile(indexPath) : { schemaVersion: 1, pages: [] };
  const pages = Array.isArray(existing.pages) ? existing.pages : [];
  const pageAbs = resolve(projectRoot, pageFile);
  if (!existsSync(pageAbs)) {
    return;
  }
  const record = {
    designSource,
    runId: basename(runDir),
    pageFile,
    componentName,
    route: registration.route,
    registrationMode: registration.mode,
    registrationFile: registration.file,
    default: false,
    contentSha256: hashFile(pageAbs)
  };
  const index = pages.findIndex(
    (page) => page.designSource === record.designSource && page.runId === record.runId && page.pageFile === record.pageFile
  );
  if (index === -1) {
    pages.push(record);
  } else {
    pages[index] = record;
  }
  writeJsonAtomic(indexPath, { schemaVersion: 1, pages });
}

function isValidLegacyComponentRecognitionAnalysis(analysis) {
  if (
    !analysis ||
    typeof analysis !== 'object' ||
    !isPositiveBoundedNumber(analysis.canvas?.width, 100000) ||
    !isPositiveBoundedNumber(analysis.canvas?.height, 100000) ||
    !Array.isArray(analysis.regions) ||
    analysis.regions.length === 0 ||
    analysis.regions.length > 200 ||
    !isBoundedStringArray(analysis.global_observations, 100, 4000) ||
    !isBoundedStringArray(analysis.uncertainties, 100, 4000)
  ) {
    return false;
  }
  const ids = analysis.regions.map((region) => region?.id);
  if (
    ids.some((id) => !isNonEmptyBoundedString(id, 128)) ||
    new Set(ids).size !== ids.length
  ) {
    return false;
  }
  return analysis.regions.every((region) =>
    isNonEmptyBoundedString(region?.name, 4000) &&
    isNonEmptyBoundedString(region?.visual_evidence, 4000) &&
    isValidNormalizedBounds(region?.bounds) &&
    Array.isArray(region?.component_candidates) &&
    region.component_candidates.length > 0 &&
    region.component_candidates.length <= 10 &&
    region.component_candidates.every((candidate) =>
      isNonEmptyBoundedString(candidate?.name, 4000) &&
      ['arkui-native', 'custom', 'basic-layout', 'unknown'].includes(candidate?.category) &&
      isConfidence(candidate?.confidence) &&
      isNonEmptyBoundedString(candidate?.reason, 4000)
    ) &&
    isBoundedStringArray(region?.children, 100, 128) &&
    region.children.every((child) => child !== region.id && ids.includes(child)) &&
    isBoundedStringArray(region?.interaction_hints, 20, 4000) &&
    typeof region?.overlay === 'boolean' &&
    isConfidence(region?.confidence)
  );
}

function isValidNormalizedBounds(bounds) {
  return bounds &&
    typeof bounds.x === 'number' && Number.isFinite(bounds.x) && bounds.x >= 0 && bounds.x <= 1000 &&
    typeof bounds.y === 'number' && Number.isFinite(bounds.y) && bounds.y >= 0 && bounds.y <= 1000 &&
    isPositiveBoundedNumber(bounds.width, 1000) &&
    isPositiveBoundedNumber(bounds.height, 1000) &&
    bounds.x + bounds.width <= 1000 &&
    bounds.y + bounds.height <= 1000;
}

function isValidComponentRecognitionInventory(analysis) {
  if (
    !analysis ||
    typeof analysis !== 'object' ||
    !isPositiveBoundedNumber(analysis.canvas?.width, 100000) ||
    !isPositiveBoundedNumber(analysis.canvas?.height, 100000) ||
    !Array.isArray(analysis.visible_components) ||
    analysis.visible_components.length === 0 ||
    analysis.visible_components.length > 200 ||
    !isBoundedStringArray(analysis.global_observations, 100, 4000) ||
    !isBoundedStringArray(analysis.uncertainties, 100, 4000)
  ) {
    return false;
  }
  const ids = analysis.visible_components.map((component) => component?.id);
  if (
    ids.some((id) => !isNonEmptyBoundedString(id, 128)) ||
    new Set(ids).size !== ids.length
  ) {
    return false;
  }
  return analysis.visible_components.every((component) =>
    isNonEmptyBoundedString(component?.name, 4000) &&
    isNonEmptyBoundedString(component?.visual_evidence, 4000) &&
    Array.isArray(component?.component_candidates) &&
    component.component_candidates.length > 0 &&
    component.component_candidates.length <= 10 &&
    component.component_candidates.every((candidate) =>
      isNonEmptyBoundedString(candidate?.name, 4000) &&
      isConfidence(candidate?.confidence) &&
      isNonEmptyBoundedString(candidate?.reason, 4000)
    )
  );
}

function isValidComponentRecognitionDegraded(artifact) {
  return artifact.analysis === null &&
    artifact.failure?.code === 'empty_components' &&
    artifact.failure?.attempts === 2 &&
    artifact.failure?.fallbackPolicy === 'ignore-visual-component-recognition';
}

function isBoundedStringArray(value, maxItems, maxChars) {
  return Array.isArray(value) &&
    value.length <= maxItems &&
    value.every((item) => isNonEmptyBoundedString(item, maxChars));
}

function isNonEmptyBoundedString(value, maxChars) {
  return typeof value === 'string' && value.length > 0 && value.length <= maxChars;
}

function isPositiveBoundedNumber(value, max) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 && value <= max;
}

function isConfidence(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1;
}

const OTHERS_HTML_STAGE2_CONFIRMATION_FILES = [
  ['componentAnalysis', 'stage2/component-analysis.md'],
  ['componentTree', 'component-tree.md'],
  ['designDoc', 'design-doc.md'],
  ['visualSpec', 'stage1/visual-spec.json'],
  ['layoutFacts', 'stage1/layout-facts.json']
];

// The screenshot source produces its recognition artifact and its measured
// probe already in stage 1, so the confirmation snapshot freezes both together
// with the visual spec, which stays the visual authority for the whole run.
const OTHERS_VISUAL_STAGE2_CONFIRMATION_FILES = [
  ['componentVisionAnalysis', 'stage1/component-vision-analysis.json'],
  ['visualProbe', 'stage1/visual-probe.json'],
  ['visualSpec', 'stage1/visual-spec.json'],
  ['componentAnalysis', 'stage2/component-analysis.md'],
  ['componentTree', 'component-tree.md'],
  ['designDoc', 'design-doc.md']
];

// The HTML source freezes the measured layout facts as well: they are the only
// place the visual values live, so a post-confirmation edit must invalidate the
// stage instead of silently re-baselining the run.
const PAGE_STAGE2_CONFIRMATION_FILES = [
  ['componentVisionAnalysis', 'stage2/component-vision-analysis.json'],
  ['componentAnalysis', 'stage2/component-analysis.md'],
  ['componentTree', 'component-tree.md'],
  ['designDoc', 'design-doc.md']
];

function pageStage2ConfirmationFiles(catalog) {
  if (catalog.designSource === 'mastergo') return MASTERGO_CONFIRMATION_FILES;
  if (catalog.designSource === 'others-html') return OTHERS_HTML_STAGE2_CONFIRMATION_FILES;
  if (catalog.designSource === 'others-visual') return OTHERS_VISUAL_STAGE2_CONFIRMATION_FILES;
  return [
    ...PAGE_STAGE2_CONFIRMATION_FILES,
    ...(catalog.designSource === 'lanhu' ? [
      ['projectAnalysis', 'stage2/project-analysis.md'],
      ['systemUiPolicy', 'system-ui-policy.json'],
      ['viewportBoundary', 'viewport-boundary-spec.json'],
      ['assetSelection', 'stage2/asset-selection.json']
    ] : [])
  ];
}

function buildPageStage2ConfirmationSnapshot(runDir, catalog, issues) {
  const files = {};
  for (const [name, relativePath] of pageStage2ConfirmationFiles(catalog)) {
    const path = join(runDir, ...relativePath.split('/'));
    if (!existsSync(path) || !statSync(path).isFile()) {
      issues.push(`stage 2 confirmation file is missing: ${relativePath}`);
      continue;
    }
    const size = statSync(path).size;
    if (size === 0 || size > 2 * 1024 * 1024) {
      issues.push(`stage 2 confirmation file must be between 1 byte and 2 MB: ${relativePath}`);
      continue;
    }
    files[name] = {
      path: relativePath,
      sha256: hashFile(path)
    };
  }
  if (issues.length > 0) {
    return null;
  }
  try {
    return {
      stage: 2,
      files,
      ...(catalog.designSource === 'mastergo' ? {
        invocationId: readJsonFile(join(runDir, MASTERGO_RUN_STATE)).invocationId,
        contractSha256: hashFile(join(runDir, MASTERGO_CONTRACT))
      } : {}),
      ...(catalog.designSource === 'lanhu' ? {
        invocationId: readJsonOrNull(join(runDir, LANHU_RUN_STATE), 'Lanhu confirmation checkpoint', issues)?.invocationId
      } : {}),
      createdAt: new Date().toISOString()
    };
  } catch {
    // Evidence may disappear or change between validation and snapshot creation.
    issues.push('stage 2 conversion checkpoint or input contract changed while creating confirmation; validate and retry');
    return null;
  }
}

function collectPageStage2ConfirmationSnapshotIssues(runDir, catalog, state) {
  const issues = [];
  const snapshot = state.confirmationSnapshots?.['2'];
  const source = state.designSource ?? 'pixso';
  if (source === 'mastergo') issues.push(...collectMasterGoConfirmationIssues(runDir, snapshot));
  if (!snapshot || snapshot.stage !== 2 || !snapshot.files) {
    return ['stage 2 confirmation snapshot is missing or invalid'];
  }
  if (catalog.designSource === 'lanhu') {
    const checkpoint = readJsonOrNull(join(runDir, LANHU_RUN_STATE), 'Lanhu confirmation checkpoint', issues);
    if (!snapshot.invocationId || snapshot.invocationId !== checkpoint?.invocationId)
      issues.push('Lanhu confirmed invocation must match the original capability checkpoint');
  }
  for (const [name, relativePath] of pageStage2ConfirmationFiles(catalog)) {
    const evidence = snapshot.files[name];
    if (
      evidence?.path !== relativePath ||
      typeof evidence?.sha256 !== 'string' ||
      !/^[a-f0-9]{64}$/.test(evidence.sha256)
    ) {
      issues.push(`stage 2 confirmation snapshot entry is invalid: ${name}`);
      continue;
    }
    const path = join(runDir, ...relativePath.split('/'));
    if (!existsSync(path) || !statSync(path).isFile() || statSync(path).size === 0) {
      issues.push(`stage 2 confirmed file is missing or empty: ${relativePath}`);
    } else if (hashFile(path) !== evidence.sha256) {
      issues.push(`stage 2 confirmed file changed after confirmation request: ${relativePath}`);
    }
  }
  return issues;
}

// Sources whose stage 2 is a mid-stage confirmation gate backed by a frozen
// file snapshot. others-html additionally freezes the measured layout
// facts; others-visual freezes the recognition artifact and the measured
// probe. Both are the visual authority for the rest of the run.
function isPageStage2(catalog, stage) {
  return ['figma', 'mastergo', 'lanhu', 'others-html', 'others-visual'].includes(catalog.designSource) && stage === 2;
}

function requiresPageStage2Confirmation(catalog, stage) {
  return isPageStage2(catalog, stage) && catalog.stages[stage - 1]?.requiresConfirmation === true;
}

// Stages whose authoritative output is design-doc.md. Manual Full flows keep
// confirmation-snapshot validation and are intentionally excluded.
function requiresDesignDocMissingGuard(catalog, stage) {
  const designSource = catalog.designSource ?? 'pixso';
  return (
    (['figma', 'lanhu'].includes(designSource) && catalog.variant === 'fast' && stage === 2) ||
    (designSource === 'pixso' && stage === 5) ||
    // The screenshot source keeps the generic design-doc guard so a live
    // stage 2 completion still proves the solution-design skill ran; its
    // design-doc is additionally frozen by the confirmation snapshot.
    (designSource === 'others-visual' && stage === 2)
  );
}

function collectDesignDocEvidenceIssues(runDir) {
  const path = join(runDir, 'design-doc.md');

  if (!existsSync(path)) {
    return ['design-doc.md is missing'];
  }

  const stat = statSync(path);
  if (!stat.isFile()) {
    return ['design-doc.md must be a regular file'];
  }

  if (stat.size === 0) {
    return ['design-doc.md is empty'];
  }

  if (readFileSync(path, 'utf8').trim().length === 0) {
    return ['design-doc.md contains only whitespace'];
  }

  return [];
}

const DESIGN_DOC_RECOVERY_INSTRUCTION = 'references/design-doc-auto-recovery.md';
const SOLUTION_DESIGN_SKILL = 'hmos-d2a-solution-design';
const FIGMA_REACT_TO_ARKUI_RUN_STATE = 'stage2/hmos-d2a-react-to-arkui-run.json';
const FIGMA_REACT_TO_ARKUI_PHASES = new Set([
  'analyzing',
  'awaiting_confirmation',
  'implementing',
  'validating',
  'completed'
]);
const FIGMA_REACT_TO_ARKUI_RESUME_FORBIDDEN_PHASES = new Set(['implementing', 'validating', 'completed']);

function designDocStage(catalog) {
  if (['figma', 'mastergo', 'lanhu', 'others-html', 'others-visual'].includes(catalog.designSource)) return 2;
  return 5;
}

function isNonEmptyFile(path) {
  if (!existsSync(path)) return false;
  const stat = statSync(path);
  return stat.isFile() && stat.size > 0;
}

function isParseableJsonFile(path) {
  if (!isNonEmptyFile(path)) return false;
  try {
    readJsonFile(path);
    return true;
  } catch {
    return false;
  }
}

function runDirRelativePath(runDir, relativePath) {
  return join(runDir, ...relativePath.split('/'));
}

// The page DSL is located strictly through inputs-manifest.json pages[].dslPath.
// Two path formats are accepted: a runDir-relative `source/...` path and a
// repo-relative `.deveco/.../runs/{runId}/source/...` path that must start with
// the manifest's own runDir. Scanning the source directory for any parseable
// DSL is never a pass condition.
function collectPixsoDslEntries(runDir) {
  const issues = [];
  const entries = [];
  const manifest = readJsonOrNull(
    join(runDir, 'inputs-manifest.json'),
    'inputs manifest',
    issues
  );
  if (!manifest) {
    return { issues, entries };
  }
  if (!Array.isArray(manifest.pages) || manifest.pages.length === 0) {
    issues.push('inputs-manifest.json pages must be a non-empty array');
    return { issues, entries };
  }
  const manifestRunDir = typeof manifest.runDir === 'string' && manifest.runDir.length > 0
    ? manifest.runDir.replaceAll('\\', '/').replace(/\/+$/, '')
    : null;
  manifest.pages.forEach((page, index) => {
    const label = `inputs-manifest.json pages[${index}]` +
      (typeof page?.pageSlug === 'string' && page.pageSlug.length > 0 ? ` (${page.pageSlug})` : '');
    const rawPath = page?.dslPath;
    if (typeof rawPath !== 'string' || rawPath.length === 0) {
      issues.push(`${label} dslPath is missing`);
      return;
    }
    const normalized = rawPath.replaceAll('\\', '/');
    let candidate;
    if (normalized.startsWith('source/')) {
      candidate = normalized;
    } else if (manifestRunDir && normalized.startsWith(`${manifestRunDir}/`)) {
      candidate = normalized.slice(manifestRunDir.length + 1);
      if (!candidate.startsWith('source/')) {
        issues.push(`${label} dslPath must resolve into the run source directory: ${rawPath}`);
        return;
      }
    } else {
      issues.push(
        `${label} dslPath must be a source/... path or start with the manifest runDir (${manifestRunDir ?? 'missing'}): ${rawPath}`
      );
      return;
    }
    const resolved = resolve(runDir, candidate);
    const relFromRunDir = relative(runDir, resolved);
    if (relFromRunDir.startsWith('..') || isAbsolute(relFromRunDir)) {
      issues.push(`${label} dslPath escapes the run directory: ${rawPath}`);
      return;
    }
    entries.push({
      label,
      rawPath,
      relPath: relFromRunDir.replaceAll('\\', '/'),
      resolved,
      expectedSha256: typeof page?.dslSha256 === 'string' ? page.dslSha256 : undefined
    });
  });
  return { issues, entries };
}

function pixsoDslIssues(runDir) {
  const { issues, entries } = collectPixsoDslEntries(runDir);
  for (const entry of entries) {
    if (!existsSync(entry.resolved)) {
      issues.push(`${entry.label} DSL file is missing: ${entry.rawPath}`);
      continue;
    }
    const stat = statSync(entry.resolved);
    if (!stat.isFile()) {
      issues.push(`${entry.label} DSL file is not a regular file: ${entry.rawPath}`);
      continue;
    }
    if (stat.size === 0) {
      issues.push(`${entry.label} DSL file is empty: ${entry.rawPath}`);
      continue;
    }
    try {
      readJsonFile(entry.resolved);
    } catch (error) {
      issues.push(`${entry.label} DSL file is not valid JSON: ${entry.rawPath} (${error.message})`);
      continue;
    }
    if (entry.expectedSha256 !== undefined) {
      if (!/^[a-f0-9]{64}$/.test(entry.expectedSha256)) {
        issues.push(`${entry.label} dslSha256 must be 64 lowercase hex characters`);
      } else if (hashFile(entry.resolved) !== entry.expectedSha256) {
        issues.push(`${entry.label} dslSha256 does not match the DSL file: ${entry.rawPath}`);
      }
    }
  }
  return issues;
}

function missingNonEmptyInputs(runDir, relativePaths) {
  return relativePaths
    .filter((relativePath) => !isNonEmptyFile(runDirRelativePath(runDir, relativePath)))
    .map((relativePath) => `${relativePath} is missing or empty`);
}

function missingParseableJsonInputs(runDir, relativePaths) {
  return relativePaths
    .filter((relativePath) => !isParseableJsonFile(runDirRelativePath(runDir, relativePath)))
    .map((relativePath) => `${relativePath} is missing or not parseable`);
}

// Authoritative inputs that let hmos-d2a-solution-design rebuild only the
// missing design-doc.md for a Pixso run.
function pixsoRestoreDocumentInputIssues(runDir) {
  return [
    ...missingNonEmptyInputs(runDir, ['component-tree.md']),
    ...missingParseableJsonInputs(runDir, ['requirement-clarification.json', REPO_CONTEXT_JSON]),
    ...pixsoDslIssues(runDir),
    ...missingParseableJsonInputs(runDir, [
      'hds-decision.json',
      'startup-page-policy.json',
      'system-ui-policy.json',
      'viewport-boundary-spec.json',
      'system-ui-coordinate-normalization.json',
      'safe-area-unit-contract.json'
    ])
  ];
}

// Authoritative products that must all survive for an others-visual
// "document-only" restore; if any is missing the assessment falls through to
// the resume path.
function othersVisualRestoreDocumentInputIssues(runDir) {
  return [
    ...missingNonEmptyInputs(runDir, [
      'source/visual/screenshot.png',
      'stage2/project-analysis.md',
      'stage2/component-analysis.md',
      'component-tree.md'
    ]),
    ...missingParseableJsonInputs(runDir, [
      'stage1/visual-probe.json',
      'stage1/component-vision-analysis.json',
      'stage1/visual-spec.json',
      'system-ui-policy.json',
      'viewport-boundary-spec.json',
      'requirement-clarification.json'
    ])
  ];
}

// Stage 1-4 upstream inputs that let the others-visual solution-design subflow
// run again from its documented entry point.
function othersVisualUpstreamInputIssues(runDir) {
  const issues = [
    ...missingParseableJsonInputs(runDir, ['requirement-clarification.json']),
    ...missingNonEmptyInputs(runDir, ['source/visual/screenshot.png']),
    ...missingParseableJsonInputs(runDir, [
      'stage1/visual-probe.json',
      'stage1/component-vision-analysis.json',
      'stage1/visual-spec.json',
      'stage2/generated-ui-manifest.json',
      'stage2/initial-build-report.json'
    ])
  ];
  const pageFile = readJsonIfExistsQuietly(join(runDir, 'stage2', 'generated-ui-manifest.json'))?.page?.file;
  if (typeof pageFile === 'string' && pageFile.length > 0) {
    const projectRoot = readJsonIfExistsQuietly(join(runDir, 'inputs-manifest.json'))?.integrationSnapshot?.projectRootPath;
    if (typeof projectRoot === 'string' && projectRoot.length > 0) {
      const abs = isAbsolute(projectRoot) ? join(projectRoot, pageFile) : resolve(runDir, projectRoot, pageFile);
      if (!existsSync(abs)) {
        issues.push(`stage2 generated page file is missing: ${pageFile}`);
      }
    }
  }
  return issues;
}

// Stage 1-4 upstream inputs that let the Pixso stage 5 solution-design subflow
// run again from its documented entry point.
function pixsoUpstreamInputIssues(runDir) {
  const issues = [
    ...missingParseableJsonInputs(runDir, ['requirement-clarification.json']),
    ...pixsoDslIssues(runDir),
    ...missingParseableJsonInputs(runDir, [
      'stage2/image-assets-manifest.json',
      'stage3-repo-understand-report.json',
      'stage4-selected-practices.json',
      REPO_CONTEXT_JSON
    ])
  ];
  const generatedDir = runDirRelativePath(runDir, 'stage2/generated');
  const hasSkeleton = existsSync(generatedDir) &&
    statSync(generatedDir).isDirectory() &&
    readdirSync(generatedDir).some((name) => name.endsWith('.ets'));
  if (!hasSkeleton) {
    issues.push('stage2/generated/ contains no generated page skeleton');
  }
  return issues;
}

// Authoritative products that must all survive for a Figma "document-only"
// restore; if any is missing the assessment falls through to the resume path.
function figmaRestoreDocumentInputIssues(runDir) {
  return [
    ...missingNonEmptyInputs(runDir, [
      'source/figma/page.jsx',
      'source/figma/reference-screenshot.png',
      'stage2/project-analysis.md',
      'stage2/component-analysis.md',
      'component-tree.md'
    ]),
    ...missingParseableJsonInputs(runDir, [
      'system-ui-policy.json',
      'viewport-boundary-spec.json',
      'requirement-clarification.json'
    ])
  ];
}

// Validates the persisted hmos-d2a-react-to-arkui run state. The in-run resume
// keeps the historical restriction (the design generation must not have
// finished); design-only recovery may read a run state that already advanced
// past design generation but never one parked on a confirmation wait.
const FIGMA_REACT_TO_ARKUI_DESIGN_ONLY_FORBIDDEN_PHASES = new Set(['awaiting_confirmation']);

function figmaRunStateIssues(runDir, options = {}) {
  const designOnlyRecovery = options.designOnlyRecovery === true;
  const runStatePath = runDirRelativePath(runDir, FIGMA_REACT_TO_ARKUI_RUN_STATE);
  if (!isNonEmptyFile(runStatePath)) {
    return [`${FIGMA_REACT_TO_ARKUI_RUN_STATE} is missing or empty`];
  }
  let runState;
  try {
    runState = readJsonFile(runStatePath);
  } catch {
    return [`${FIGMA_REACT_TO_ARKUI_RUN_STATE} is not valid JSON`];
  }
  if (typeof runState?.invocationId !== 'string' || runState.invocationId.length === 0) {
    return [`${FIGMA_REACT_TO_ARKUI_RUN_STATE} invocationId is missing`];
  }
  if (!runState.inputs || typeof runState.inputs !== 'object' || Array.isArray(runState.inputs)) {
    return [`${FIGMA_REACT_TO_ARKUI_RUN_STATE} inputs are missing`];
  }
  const pageJsxHash = runState.inputs.pageJsx;
  if (typeof pageJsxHash !== 'string' || !/^[a-f0-9]{64}$/.test(pageJsxHash)) {
    return [
      `${FIGMA_REACT_TO_ARKUI_RUN_STATE} inputs.pageJsx must be the 64-char lowercase SHA-256 of source/figma/page.jsx`
    ];
  }
  const pageJsxPath = runDirRelativePath(runDir, 'source/figma/page.jsx');
  if (!isNonEmptyFile(pageJsxPath) || hashFile(pageJsxPath) !== pageJsxHash) {
    return [`${FIGMA_REACT_TO_ARKUI_RUN_STATE} inputs.pageJsx does not match the current source/figma/page.jsx`];
  }
  if (!FIGMA_REACT_TO_ARKUI_PHASES.has(runState.phase)) {
    return [`${FIGMA_REACT_TO_ARKUI_RUN_STATE} phase is invalid`];
  }
  if (designOnlyRecovery) {
    if (FIGMA_REACT_TO_ARKUI_DESIGN_ONLY_FORBIDDEN_PHASES.has(runState.phase)) {
      return [
        `${FIGMA_REACT_TO_ARKUI_RUN_STATE} phase awaiting_confirmation cannot be resumed by design-only recovery`
      ];
    }
  } else if (FIGMA_REACT_TO_ARKUI_RESUME_FORBIDDEN_PHASES.has(runState.phase)) {
    return [`${FIGMA_REACT_TO_ARKUI_RUN_STATE} has advanced past the design generation phase: ${runState.phase}`];
  }
  return [];
}

// Upstream inputs that let hmos-d2a-react-to-arkui resume its design
// generation, which then invokes hmos-d2a-solution-design for the document.
// Component recognition evidence is validated through the shared collector;
// the run state never redefines those fields.
function figmaUpstreamInputIssues(runDir, options = {}) {
  const issues = [
    ...missingNonEmptyInputs(runDir, [
      'source/figma/page.jsx',
      'source/figma/reference-screenshot.png',
      'stage2/project-analysis.md',
      'stage2/component-analysis.md'
    ]),
    ...missingParseableJsonInputs(runDir, ['requirement-clarification.json']),
    ...figmaRunStateIssues(runDir, options)
  ];
  const assetsDir = runDirRelativePath(runDir, 'source/figma/assets');
  if (!existsSync(assetsDir) || !statSync(assetsDir).isDirectory()) {
    issues.push('source/figma/assets is missing');
  }
  issues.push(...collectComponentRecognitionEvidenceIssues(runDir));
  return issues;
}

// Run dirs created before the ledger rename keep the legacy filename; prefer
// the canonical name and fall back so design-doc recovery can still read them.
function resolveLedgerPath(runDir) {
  const ledgerPath = join(runDir, 'capability-invocation-ledger.json');
  if (existsSync(ledgerPath)) return ledgerPath;
  const legacyPath = join(runDir, 'skill-invocation-ledger.json');
  return existsSync(legacyPath) ? legacyPath : ledgerPath;
}

// The design-doc.md writer is hmos-d2a-solution-design by contract; a live
// completion of a doc stage must show a completed ledger record for it.
function collectSolutionDesignLedgerIssues(runDir, stage) {
  const ledgerPath = resolveLedgerPath(runDir);
  if (!isNonEmptyFile(ledgerPath)) {
    return [`stage ${stage} requires capability-invocation-ledger.json with a completed ${SOLUTION_DESIGN_SKILL} invocation`];
  }
  let ledger;
  try {
    ledger = readJsonFile(ledgerPath);
  } catch {
    return [`stage ${stage} capability-invocation-ledger.json is not valid JSON`];
  }
  const entries = Array.isArray(ledger)
    ? ledger
    : Array.isArray(ledger?.invocations)
      ? ledger.invocations
      : null;
  if (!entries) {
    return [`stage ${stage} capability-invocation-ledger.json must be an array or contain an invocations array`];
  }
  const hasCompleted = entries.some(
    (entry) =>
      entry &&
      typeof entry === 'object' &&
      (entry.capability === SOLUTION_DESIGN_SKILL || entry.skill === SOLUTION_DESIGN_SKILL || entry.skillName === SOLUTION_DESIGN_SKILL) &&
      entry.status === 'completed'
  );
  if (!hasCompleted) {
    return [`stage ${stage} capability-invocation-ledger.json must contain a completed ${SOLUTION_DESIGN_SKILL} invocation record`];
  }
  return [];
}

// Unified assessment for an invalid design-doc.md. Outcomes:
//   none                              — the document is valid
//   restore_document                  — authoritative inputs are complete, so
//                                       hmos-d2a-solution-design can rebuild
//                                       only the document
//   resume_design_generation          — the doc generation stage is still
//                                       running, or it already completed and a
//                                       later stage lost the document; the
//                                       original orchestration subflow can be
//                                       resumed (design-only for Figma)
//   blocked_missing_upstream_evidence — recovery is impossible; report
//                                       design_stage_evidence_incomplete
function assessDesignDocRecovery(runDir, catalog, state) {
  const docIssues = collectDesignDocEvidenceIssues(runDir);
  if (docIssues.length === 0) {
    return { outcome: 'none', issues: [] };
  }

  const designSource = catalog.designSource ?? 'pixso';
  const docStage = designDocStage(catalog);
  const docStageCompleted = state.completedStages.includes(docStage);
  const inGenerationStage = state.currentStage === docStage && !docStageCompleted;

  // Safety boundary: after Pixso Full stage 5 completed, the component tree is
  // the user-confirmed artifact and no snapshot of that confirmation exists, so
  // nothing may be regenerated in its place.
  if (designSource === 'pixso' && catalog.variant === 'full' && docStageCompleted) {
    if (!isNonEmptyFile(runDirRelativePath(runDir, 'component-tree.md'))) {
      return {
        outcome: 'blocked_missing_upstream_evidence',
        issues: [
          ...docIssues,
          'component-tree.md is missing or empty; the user-confirmed Pixso component tree cannot be regenerated'
        ]
      };
    }
  }

  const restoreIssues = designSource === 'lanhu'
    ? collectLanhuRecoveryIssues(runDir, true)
    : designSource === 'figma'
    ? figmaRestoreDocumentInputIssues(runDir)
    : designSource === 'others-visual'
    ? othersVisualRestoreDocumentInputIssues(runDir)
    : pixsoRestoreDocumentInputIssues(runDir);
  if (restoreIssues.length === 0) {
    return { outcome: 'restore_document', issues: docIssues };
  }

  if (inGenerationStage || docStageCompleted) {
    const upstreamIssues = designSource === 'lanhu'
      ? collectLanhuRecoveryIssues(runDir, false)
      : designSource === 'figma'
      ? figmaUpstreamInputIssues(runDir, { designOnlyRecovery: docStageCompleted })
      : designSource === 'others-visual'
      ? othersVisualUpstreamInputIssues(runDir)
      : pixsoUpstreamInputIssues(runDir);
    if (upstreamIssues.length === 0) {
      return { outcome: 'resume_design_generation', issues: docIssues };
    }
    return {
      outcome: 'blocked_missing_upstream_evidence',
      issues: [...docIssues, ...restoreIssues, ...upstreamIssues]
    };
  }

  return {
    outcome: 'blocked_missing_upstream_evidence',
    issues: [...docIssues, ...restoreIssues]
  };
}

function stageCompleteRetry(requestedStage, result, reasonCode) {
  const retry = { mode: 'stage-complete', stage: requestedStage, result };
  if (result === 'blocked') {
    retry.reasonCode = reasonCode;
  }
  return retry;
}

function buildDesignDocRecoveryPayload(runDir, catalog, assessment, retry) {
  if (assessment.outcome === 'restore_document') {
    return {
      strategy: 'restore_document',
      skill: SOLUTION_DESIGN_SKILL,
      operation: 'restore_missing_design_doc',
      instructionPath: DESIGN_DOC_RECOVERY_INSTRUCTION,
      retry
    };
  }
  if (catalog.designSource === 'lanhu') {
    return { strategy: 'resume_design_generation', runnerSkill: 'hmos-d2a-lanhu-to-arkui', operation: 'restore_design_artifacts', stopAfterDesign: true, runStatePath: runDirRelativePath(runDir, LANHU_RUN_STATE), mustInvokeSkill: SOLUTION_DESIGN_SKILL, instructionPath: DESIGN_DOC_RECOVERY_INSTRUCTION, retry };
  }
  if ((catalog.designSource ?? 'pixso') === 'figma') {
    return {
      strategy: 'resume_design_generation',
      runnerSkill: 'hmos-d2a-react-to-arkui',
      operation: 'restore_design_artifacts',
      stopAfterDesign: true,
      runStatePath: runDirRelativePath(runDir, FIGMA_REACT_TO_ARKUI_RUN_STATE),
      mustInvokeSkill: SOLUTION_DESIGN_SKILL,
      instructionPath: DESIGN_DOC_RECOVERY_INSTRUCTION,
      retry
    };
  }
  return {
    strategy: 'resume_design_generation',
    runner: 'pixso_stage5_solution_design_subflow',
    instructionPath: DESIGN_DOC_RECOVERY_INSTRUCTION,
    stageInstructionPath: catalog.stages[designDocStage(catalog) - 1].instructionPath,
    mustInvokeSkill: SOLUTION_DESIGN_SKILL,
    retry
  };
}

// Read-only inputs whose content must stay frozen for the duration of one
// recovery event. Only files that currently exist are recorded; outputs the
// recovery may (re)create are never hashed.
function designDocRecoveryInputPaths(runDir, catalog, strategy) {
  const designSource = catalog.designSource ?? 'pixso';
  if (designSource === 'lanhu') return [...lanhuRecoveryInputPaths(runDir), ...(strategy === 'restore_document' ? ['component-tree.md', 'system-ui-policy.json', 'viewport-boundary-spec.json'] : [])];
  if (strategy === 'restore_document') {
    if (designSource === 'figma') {
      return [
        'source/figma/page.jsx',
        'source/figma/reference-screenshot.png',
        'stage2/project-analysis.md',
        'stage2/component-analysis.md',
        'component-tree.md',
        'system-ui-policy.json',
        'viewport-boundary-spec.json',
        'requirement-clarification.json',
        'inputs-manifest.json'
      ];
    }
    return [
      'component-tree.md',
      'requirement-clarification.json',
      'hds-decision.json',
      'startup-page-policy.json',
      'system-ui-policy.json',
      'viewport-boundary-spec.json',
      'system-ui-coordinate-normalization.json',
      'safe-area-unit-contract.json',
      'inputs-manifest.json',
      REPO_CONTEXT_JSON
    ];
  }
  if (designSource === 'figma') {
    return [
      'source/figma/page.jsx',
      'source/figma/reference-screenshot.png',
      'requirement-clarification.json',
      'stage2/project-analysis.md',
      'stage2/component-analysis.md',
      'source/figma/component-recognition-screenshot.png',
      'stage2/component-vision-analysis.json',
      'inputs-manifest.json',
      FIGMA_REACT_TO_ARKUI_RUN_STATE
    ];
  }
  return [
    'requirement-clarification.json',
    'inputs-manifest.json',
    'stage2/image-assets-manifest.json',
    'stage3-repo-understand-report.json',
    'stage4-selected-practices.json',
    REPO_CONTEXT_JSON
  ];
}

function computeDesignDocRecoveryInputHashes(runDir, catalog, strategy) {
  const inputHashes = {};
  const paths = designDocRecoveryInputPaths(runDir, catalog, strategy);
  if ((catalog.designSource ?? 'pixso') === 'pixso') {
    paths.push(...collectPixsoDslEntries(runDir).entries.map((entry) => entry.relPath));
    if (strategy === 'resume_design_generation') {
      // Freeze the stage 2 page skeletons the stage 5 subflow consumes: only
      // direct regular .ets children of stage2/generated, sorted by name so
      // the recorded set is stable.
      const generatedDir = join(runDir, 'stage2', 'generated');
      if (existsSync(generatedDir) && statSync(generatedDir).isDirectory()) {
        paths.push(
          ...readdirSync(generatedDir)
            .filter((name) => name.endsWith('.ets') && statSync(join(generatedDir, name)).isFile())
            .sort()
            .map((name) => relative(runDir, join(generatedDir, name)).replaceAll('\\', '/'))
        );
      }
    }
  }
  for (const relPath of new Set(paths)) {
    const fullPath = runDirRelativePath(runDir, relPath);
    if (isNonEmptyFile(fullPath)) {
      inputHashes[relPath] = hashFile(fullPath);
    }
  }
  return inputHashes;
}

function readPendingDesignDocRecoveryRequest(runDir) {
  const requestPath = join(runDir, DESIGN_DOC_RECOVERY_REQUEST);
  if (!existsSync(requestPath)) {
    return null;
  }
  try {
    const request = readJsonFile(requestPath);
    if (
      request?.status !== 'pending' ||
      typeof request?.recoveryInvocationId !== 'string' ||
      request.recoveryInvocationId.length === 0 ||
      !request?.recovery ||
      typeof request.recovery !== 'object' ||
      Array.isArray(request.recovery)
    ) {
      return null;
    }
    return request;
  } catch {
    return null;
  }
}

// Ensures a pending design-doc-recovery-request.json exists before a recovery
// payload is returned to the agent. Within one missing-document event the
// original ID and the original payload are reused; a completed request from an
// earlier event is replaced by a fresh UUID.
function prepareDesignDocRecovery(runDir, catalog, state, assessment, retry) {
  const existing = readPendingDesignDocRecoveryRequest(runDir);
  if (existing) {
    return existing.recovery;
  }
  const recoveryInvocationId = randomUUID();
  const recovery = {
    ...buildDesignDocRecoveryPayload(runDir, catalog, assessment, retry),
    recoveryInvocationId
  };
  writeJsonAtomic(join(runDir, DESIGN_DOC_RECOVERY_REQUEST), {
    schemaVersion: 1,
    recoveryInvocationId,
    strategy: assessment.outcome,
    designSource: catalog.designSource ?? 'pixso',
    documentStage: designDocStage(catalog),
    inputHashes: computeDesignDocRecoveryInputHashes(runDir, catalog, assessment.outcome),
    recovery,
    status: 'pending'
  });
  return recovery;
}

function findSolutionDesignLedgerEntry(runDir, invocationId) {
  const ledgerPath = resolveLedgerPath(runDir);
  if (!isNonEmptyFile(ledgerPath)) {
    return null;
  }
  let ledger;
  try {
    ledger = readJsonFile(ledgerPath);
  } catch {
    return null;
  }
  const entries = Array.isArray(ledger)
    ? ledger
    : Array.isArray(ledger?.invocations)
      ? ledger.invocations
      : null;
  if (!entries) {
    return null;
  }
  return entries.find(
    (entry) =>
      entry &&
      typeof entry === 'object' &&
      entry.invocationId === invocationId &&
      (entry.capability === SOLUTION_DESIGN_SKILL || entry.skill === SOLUTION_DESIGN_SKILL || entry.skillName === SOLUTION_DESIGN_SKILL) &&
      entry.status === 'completed'
  ) ?? null;
}

function designDocRecoveryInputHashIssues(runDir, request) {
  const issues = [];
  const inputHashes = request.inputHashes;
  if (!inputHashes || typeof inputHashes !== 'object' || Array.isArray(inputHashes)) {
    return [`${DESIGN_DOC_RECOVERY_REQUEST} inputHashes is invalid`];
  }
  for (const [relPath, expectedHash] of Object.entries(inputHashes)) {
    const fullPath = resolve(runDir, relPath);
    const relFromRunDir = relative(runDir, fullPath);
    if (relFromRunDir.startsWith('..') || isAbsolute(relFromRunDir)) {
      issues.push(`design-doc recovery input path escapes the run directory: ${relPath}`);
      continue;
    }
    if (typeof expectedHash !== 'string' || !/^[a-f0-9]{64}$/.test(expectedHash)) {
      issues.push(`design-doc recovery input hash for ${relPath} is invalid`);
      continue;
    }
    if (!isNonEmptyFile(fullPath)) {
      issues.push(`design-doc recovery input changed: ${relPath} is missing or empty`);
      continue;
    }
    if (hashFile(fullPath) !== expectedHash) {
      issues.push(`design-doc recovery input changed: ${relPath}`);
    }
  }
  return issues;
}

function outputDesignDocRecoveryUnverified(runDir, catalog, state, issues) {
  process.stdout.write(`${JSON.stringify({
    workflow: catalog.workflow,
    variant: catalog.variant,
    designSource: state.designSource ?? 'pixso',
    status: state.status,
    currentStage: state.currentStage,
    error: 'design_doc_recovery_unverified',
    issues
  }, null, 2)}\n`);
  process.stderr.write('workflow: design-doc recovery could not be verified; stop and report the real failure\n');
  process.exit(1);
}

function outputSavedDesignDocRecovery(runDir, catalog, state, request) {
  process.stdout.write(`${JSON.stringify({
    workflow: catalog.workflow,
    variant: catalog.variant,
    designSource: state.designSource ?? 'pixso',
    status: state.status,
    currentStage: state.currentStage,
    error: 'design_doc_invalid',
    issues: collectDesignDocEvidenceIssues(runDir),
    nextRequiredAction: request.strategy === 'restore_document'
      ? 'regenerate_design_doc'
      : 'resume_design_generation',
    recovery: request.recovery
  }, null, 2)}\n`);
  process.stderr.write('workflow: design-doc.md is still invalid; complete the pending recovery before retrying\n');
  process.exit(1);
}

// Runs before ordinary gates and design-doc assessments in every mode except
// init. A pending recovery request is either completed (document restored and
// the same-ID solution-design ledger record verified) or it short-circuits the
// call; it can never be silently bypassed.
function checkPendingDesignDocRecovery(runDir, catalog, state) {
  const requestPath = join(runDir, DESIGN_DOC_RECOVERY_REQUEST);
  if (!existsSync(requestPath)) {
    return;
  }
  let request;
  try {
    request = readJsonFile(requestPath);
  } catch (error) {
    outputDesignDocRecoveryUnverified(runDir, catalog, state, [
      `${DESIGN_DOC_RECOVERY_REQUEST} is not valid JSON: ${error.message}`
    ]);
  }
  if (!request || typeof request !== 'object' || Array.isArray(request)) {
    outputDesignDocRecoveryUnverified(runDir, catalog, state, [
      `${DESIGN_DOC_RECOVERY_REQUEST} must contain a JSON object`
    ]);
  }
  if (request.status === 'completed') {
    return;
  }
  if (
    request.status !== 'pending' ||
    request.schemaVersion !== 1 ||
    typeof request.recoveryInvocationId !== 'string' ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(request.recoveryInvocationId) ||
    !['restore_document', 'resume_design_generation'].includes(request.strategy) ||
    !request.recovery ||
    typeof request.recovery !== 'object' ||
    Array.isArray(request.recovery)
  ) {
    outputDesignDocRecoveryUnverified(runDir, catalog, state, [
      `${DESIGN_DOC_RECOVERY_REQUEST} does not match the recovery request schema`
    ]);
  }
  const hashIssues = designDocRecoveryInputHashIssues(runDir, request);
  if (hashIssues.length > 0) {
    outputDesignDocRecoveryUnverified(runDir, catalog, state, hashIssues);
  }
  if (collectDesignDocEvidenceIssues(runDir).length > 0) {
    outputSavedDesignDocRecovery(runDir, catalog, state, request);
  }
  if (!findSolutionDesignLedgerEntry(runDir, request.recoveryInvocationId)) {
    outputDesignDocRecoveryUnverified(runDir, catalog, state, [
      `design-doc.md is valid but capability-invocation-ledger.json has no completed ${SOLUTION_DESIGN_SKILL} record for recovery invocation ${request.recoveryInvocationId}`
    ]);
  }
  writeJsonAtomic(requestPath, { ...request, status: 'completed' });
}

function buildDesignDocAssessmentResponse(runDir, catalog, state, assessment, retry) {
  if (assessment.outcome === 'blocked_missing_upstream_evidence') {
    return {
      workflow: catalog.workflow,
      variant: catalog.variant,
      designSource: state.designSource ?? 'pixso',
      status: state.status,
      currentStage: state.currentStage,
      error: 'design_stage_evidence_incomplete',
      issues: assessment.issues
    };
  }
  return {
    workflow: catalog.workflow,
    variant: catalog.variant,
    designSource: state.designSource ?? 'pixso',
    status: state.status,
    currentStage: state.currentStage,
    error: 'design_doc_invalid',
    issues: assessment.issues,
    nextRequiredAction: assessment.outcome === 'restore_document'
      ? 'regenerate_design_doc'
      : 'resume_design_generation',
    recovery: prepareDesignDocRecovery(runDir, catalog, state, assessment, retry)
  };
}

function outputDesignDocAssessment(runDir, catalog, state, assessment, retry) {
  process.stdout.write(`${JSON.stringify(
    buildDesignDocAssessmentResponse(runDir, catalog, state, assessment, retry),
    null,
    2
  )}\n`);
}

// Recoverable design-doc failures keep the original stderr message and exit
// code; the structured recovery protocol rides on stdout so the parent agent
// can regenerate the document and retry the original operation.
function failWithDesignDocAssessment(runDir, catalog, state, assessment, retry, message) {
  outputDesignDocAssessment(runDir, catalog, state, assessment, retry);
  fail(message);
}

function collectVisualCalibrationEvidenceIssues(runDir, stage, designSource, ctx = {}) {
  const issues = [];
  const clarification = readJsonOrNull(
    join(runDir, 'requirement-clarification.json'),
    `stage ${stage} requirement clarification`,
    issues
  );
  const report = readJsonOrNull(
    join(runDir, `stage${stage}-visual-calibration-report.json`),
    `stage ${stage} visual calibration report`,
    issues
  );
  if (!clarification || !report) {
    return issues;
  }

  if (clarification.visualCalibration?.enabled === false) {
    if (
      report.status !== 'skipped' ||
      report.reason !== 'visualCalibration.disabled' ||
      report.roundsCompleted !== 0
    ) {
      issues.push(
        `stage ${stage} skipped report must use status=skipped, reason=visualCalibration.disabled, and roundsCompleted=0`
      );
    }
    return issues;
  }

  // An explicit value recorded by requirement clarification always wins; all
  // six scored sources share the same default bar.
  const threshold =
    typeof clarification.visualCalibration?.scoreThreshold === 'number'
      ? clarification.visualCalibration.scoreThreshold
      : 80;
  // maxRounds is the user-configurable round cap (1-5, default 5). Stage 1
  // validation rejects out-of-range values, so the fallback here is defensive.
  const maxRounds =
    Number.isInteger(clarification.visualCalibration?.maxRounds) &&
    clarification.visualCalibration.maxRounds >= 1 &&
    clarification.visualCalibration.maxRounds <= 5
      ? clarification.visualCalibration.maxRounds
      : 5;
  const roundsCompleted = Number(report.roundsCompleted);
  const validRounds =
    Number.isInteger(roundsCompleted) && roundsCompleted >= 1 && roundsCompleted <= maxRounds;

  if (report.status !== 'completed' || !validRounds) {
    issues.push(
      `stage ${stage} enabled calibration requires status=completed and roundsCompleted between 1 and ${maxRounds}`
    );
  }
  const invocations = Array.isArray(report.capabilityInvocations)
    ? report.capabilityInvocations
    : report.skillInvocations;
  const parentInvocation = Array.isArray(invocations)
    ? invocations.find(
        (item) =>
          (item?.capability === 'hmos-d2a-arkui-scoring-workflow' || item?.skill === 'hmos-d2a-arkui-scoring-workflow') &&
          item?.status === 'completed'
      )
    : null;
  if (!parentInvocation) {
    issues.push(`stage ${stage} report is missing completed hmos-d2a-arkui-scoring-workflow invocation`);
  }

  const upperBound = validRounds ? roundsCompleted : 0;
  for (let round = 1; round <= upperBound; round += 1) {
    const invocation = Array.isArray(invocations)
      ? invocations.find(
          (item) =>
            (item?.capability === 'hmos-d2a-ui-reconstruction-score' || item?.skill === 'hmos-d2a-ui-reconstruction-score') &&
            Number(item?.round) === round &&
            item?.status === 'completed'
          )
        : null;
    if (!invocation) {
      issues.push(`stage ${stage} report is missing completed hmos-d2a-ui-reconstruction-score invocation for round ${round}`);
    }

    const roundEvidence = Array.isArray(report.rounds)
      ? report.rounds.find((item) => Number(item?.round) === round)
      : null;
    if (!roundEvidence) {
      issues.push(`stage ${stage} report is missing evidence for round ${round}`);
      continue;
    }
    for (const [field, label] of [
      ['scoreJson', `stage ${stage} round ${round} score.json`],
      ['metricsJson', `stage ${stage} round ${round} metrics.json`]
    ]) {
      const path = resolveEvidencePath(runDir, roundEvidence[field], label, issues);
      if (path) {
        readJsonOrNull(path, label, issues);
      }
    }
  }

  const validReasons = ['score-threshold-reached', 'max-rounds-reached'];
  if (!validReasons.includes(report.completionReason)) {
    issues.push(`stage ${stage} report must include completionReason of ${validReasons.join(' / ')}`);
  }
  if (validRounds) {
    const lastRound = Array.isArray(report.rounds)
      ? report.rounds.find((item) => Number(item?.round) === roundsCompleted)
      : null;
    const lastScore = typeof lastRound?.score === 'number' ? lastRound.score : Number.NaN;
    if (
      report.completionReason === 'score-threshold-reached' &&
      (!Number.isFinite(lastScore) || lastScore < threshold)
    ) {
      issues.push(
        `stage ${stage} completionReason=score-threshold-reached requires last round score >= ${threshold}`
      );
    }
    if (
      report.completionReason === 'max-rounds-reached' &&
      (roundsCompleted !== maxRounds || !Number.isFinite(lastScore) || lastScore >= threshold)
    ) {
      issues.push(
        `stage ${stage} completionReason=max-rounds-reached requires roundsCompleted=${maxRounds} and last round score < ${threshold}`
      );
    }
  }

  for (const name of [
    'hmos-d2a-ui-reconstruction-score-invoked',
    'score-artifacts-present',
    'no-direct-compare-images-bypass',
    'calibration-completed'
  ]) {
    if (!reportCheckPassed(report, name)) {
      issues.push(`stage ${stage} report check ${name} must pass`);
    }
  }
  return issues;
}

// The score is only as honest as its inputs. The mainstream stage-5 contract
// carries these rules as prose (record the candidate hash, never re-score the
// same screenshot, keep one scoring package per round); the two others sources
// asked for the same guarantees as machine gates after a real run warped the
// candidate to the reference size, ran seven scoring directories, and hand-wrote
// the report score. The collector only ever runs inside the others branch of the
// shared dispatch, and only live: legacy reports that predate the switch must
// not gain issues on replay.
function collectOthersCalibrationIntegrityIssues(runDir, stage, designSource, ctx = {}) {
  const issues = [];
  if (ctx.live !== true) {
    // Completed-stage replays predate these gates; only live completion is gated.
    return issues;
  }
  const report = readJsonIfExistsQuietly(join(runDir, `stage${stage}-visual-calibration-report.json`));
  if (!report || typeof report !== 'object' || Array.isArray(report) || report.status === 'skipped') {
    return issues;
  }
  const rounds = Array.isArray(report.rounds) ? report.rounds : [];
  const roundsCompleted = Number(report.roundsCompleted);
  const upperBound = Number.isInteger(roundsCompleted) && roundsCompleted >= 1 ? roundsCompleted : 0;
  const canonicalReference = designSource === 'others-html' ? OTHERS_HTML_SCORED_REFERENCE : OTHERS_VISUAL_SCREENSHOT;
  const allowedIgnore = othersCalibrationAllowedIgnoreValues(runDir, designSource);
  const projectRoot = othersProjectRoot(runDir);
  // Rounds after the first owe repair evidence that is reconciled against the
  // project on disk, so a missing project root fails closed instead of
  // silently disabling that half of the check.
  if (upperBound >= 2 && projectRoot === null) {
    issues.push(
      `stage ${stage} rounds after the first require inputs-manifest integrationSnapshot.projectRootPath to reconcile repair evidence`
    );
  }
  collectOthersReferenceLockIssues(runDir, stage, designSource, canonicalReference, issues);

  // A temporary preview may stand in for a missing entry point, but the file it
  // touched has to come back byte for byte (migrated from the retired region
  // collector so the adapter's declared rule keeps its code backing).
  if (report.temporaryPreview !== undefined) {
    if (report.temporaryPreview?.applied === true && report.temporaryPreview?.restored !== true) {
      issues.push(`stage ${stage} temporary preview must be restored before the stage can pass`);
    }
    if (
      report.temporaryPreview?.applied === true &&
      report.temporaryPreview?.sha256Before !== report.temporaryPreview?.sha256After
    ) {
      issues.push(
        `stage ${stage} temporary preview must restore the original file byte for byte (sha256Before must equal sha256After)`
      );
    }
  }

  // Confirmed facts stay read-only during calibration (migrated likewise); the
  // guarded keys follow each source's confirmation snapshot.
  const state = readJsonIfExistsQuietly(join(runDir, OTHERS_HTML_WORKFLOW_STATE));
  const snapshot = state?.confirmationSnapshots?.['2']?.files;
  if (snapshot && typeof snapshot === 'object' && !Array.isArray(snapshot)) {
    for (const key of designSource === 'others-html' ? ['layoutFacts', 'visualSpec'] : ['visualSpec', 'visualProbe']) {
      const entry = snapshot[key];
      if (!entry || typeof entry.path !== 'string') {
        continue;
      }
      const current = join(runDir, ...entry.path.split('/'));
      if (!existsSync(current)) {
        issues.push(`stage ${stage} confirmed file is missing: ${entry.path}`);
      } else if (hashFile(current) !== entry.sha256) {
        issues.push(
          `stage ${stage} must not rewrite the confirmed facts: ${entry.path} changed after stage 2 confirmation`
        );
      }
    }
  }

  const candidateHashes = [];
  for (let round = 1; round <= upperBound; round += 1) {
    const evidence = rounds.find((item) => Number(item?.round) === round);
    if (!evidence) {
      continue; // the shared collector already reports missing round evidence
    }
    const roundRel = `visual-calibration/round-${String(round).padStart(2, '0')}`;
    const canonicalCandidates = [
      `${roundRel}/candidate.png`,
      `${roundRel}/candidate.jpg`,
      `${roundRel}/candidate.jpeg`,
    ];
    const scoreDocument = readRoundScoreDocument(runDir, evidence);

    // 1. the scored inputs are this round's original screenshot and the locked
    //    reference, at their canonical paths - derived images never qualify.
    for (const scored of collectScoredPaths(runDir, scoreDocument, 'candidate')) {
      if (!canonicalCandidates.includes(scored)) {
        issues.push(
          `stage ${stage} round ${round} scored candidate must be ${roundRel}/candidate.png|jpg|jpeg, got ${scored}`
        );
      }
    }
    for (const scored of collectScoredPaths(runDir, scoreDocument, 'reference')) {
      if (scored !== canonicalReference) {
        issues.push(`stage ${stage} round ${round} scored reference must be ${canonicalReference}, got ${scored}`);
      }
    }
    const reportedCandidate = normalizeRunEvidencePath(runDir, evidence.candidate?.path);
    if (!canonicalCandidates.includes(reportedCandidate)) {
      issues.push(`stage ${stage} round ${round} report candidate.path must be ${roundRel}/candidate.png|jpg|jpeg`);
    }

    // 3. the report's candidate hash is the hash of the file the scorer read;
    //    when both formats sit in the round directory, the reported one wins.
    const candidateRel = canonicalCandidates.includes(reportedCandidate)
      ? reportedCandidate
      : canonicalCandidates.find((candidate) => {
          const path = join(runDir, ...candidate.split('/'));
          return existsSync(path) && statSync(path).isFile();
        });
    if (!candidateRel) {
      issues.push(
        `stage ${stage} round ${round} must keep the scored screenshot at ${roundRel}/candidate.png|jpg|jpeg`
      );
    } else if (!isSha256Hex(evidence.candidate?.sha256)) {
      issues.push(`stage ${stage} round ${round} must record candidate.sha256 for ${candidateRel}`);
    } else {
      const onDisk = hashFile(join(runDir, ...candidateRel.split('/')));
      if (onDisk !== evidence.candidate.sha256) {
        issues.push(`stage ${stage} round ${round} candidate.sha256 does not match ${candidateRel} on disk`);
      }
      // A voluntary candidate probe (retained diagnostic) stays bound to the
      // screenshot it claims to have measured.
      const probePath = join(runDir, ...roundRel.split('/'), 'candidate-probe.json');
      if (existsSync(probePath)) {
        const probe = readJsonIfExistsQuietly(probePath);
        if (isSha256Hex(probe?.source?.sha256) && probe.source.sha256 !== onDisk) {
          issues.push(`stage ${stage} round ${round} candidate-probe.json source.sha256 does not match ${candidateRel}`);
        }
      }
      // 4. every round owes its own screenshot; re-scoring the same bytes must
      //    be explained instead of silently padding the round count.
      const repeated = candidateHashes.findIndex((entry) => entry.sha256 === onDisk);
      if (repeated >= 0 && !isNonEmptyBoundedString(evidence.reworkNotes, 4000)) {
        issues.push(
          `stage ${stage} round ${round} re-scores the screenshot of round ${repeated + 1}; the same bytes must carry reworkNotes with the reason and repair/build evidence`
        );
      }
      candidateHashes.push({ round, sha256: onDisk });
    }

    // 5. one scoring package per round - a round with several score* directories
    //    is a scoring spree that reports only its best shot.
    const roundDir = join(runDir, ...roundRel.split('/'));
    if (existsSync(roundDir) && statSync(roundDir).isDirectory()) {
      const scoreDirs = readdirSync(roundDir).filter((name) => {
        const path = join(roundDir, name);
        return /^score/i.test(name) && existsSync(path) && statSync(path).isDirectory();
      });
      if (scoreDirs.length > 1) {
        issues.push(`stage ${stage} round ${round} must keep at most one score* directory (${scoreDirs.join(', ')})`);
      }
    }

    // 6. the reported score is the script's score.
    if (scoreDocument) {
      const scored = scoreDocument.aggregate?.final_baseline_score;
      if (typeof scored !== 'number' || scored !== evidence.score) {
        issues.push(
          `stage ${stage} round ${round} report score must equal the score.json aggregate.final_baseline_score (${scored})`
        );
      }
      // 8. the ignore bands are the defaults or the measured system-area values,
      //    and the reference normalizes to its own width (no custom --target-width).
      const pair = Array.isArray(scoreDocument.pairs) ? scoreDocument.pairs[0] : null;
      for (const [value, allowed, label] of [
        [pair?.ignored_top_status_px, allowedIgnore.top, 'ignored_top_status_px'],
        [pair?.ignored_bottom_system_px, allowedIgnore.bottom, 'ignored_bottom_system_px']
      ]) {
        if (value !== undefined && !allowed.has(Number(value))) {
          issues.push(
            `stage ${stage} round ${round} ${label} (${value}) must be the default or a measured system-area value (${[...allowed].join(' / ')})`
          );
        }
      }
      if (
        Array.isArray(pair?.reference_size) &&
        Array.isArray(pair?.reference_normalized_size) &&
        pair.reference_size[0] !== pair.reference_normalized_size[0]
      ) {
        issues.push(
          `stage ${stage} round ${round} reference must normalize to its own width (reference_size ${pair.reference_size[0]} vs reference_normalized_size ${pair.reference_normalized_size[0]}); a custom --target-width is not allowed`
        );
      }
    }

    // 7. rounds after the first owe repair and build evidence.
    if (round >= 2) {
      collectOthersRoundRepairIssues(runDir, stage, round, evidence, projectRoot, round === upperBound, issues);
    }
  }

  // No rounds may hide beyond roundsCompleted: an uncounted low-score round is
  // exactly the record a hand-written summary would drop first.
  const beyond = rounds
    .map((item) => Number(item?.round))
    .filter((number) => Number.isInteger(number) && number > upperBound);
  if (beyond.length > 0) {
    issues.push(
      `stage ${stage} rounds may not record rounds beyond roundsCompleted (${[...new Set(beyond)].join(', ')})`
    );
  }
  return issues;
}

// The reference is locked per source: the HTML run scores the recorded first
// frame of its reference set (and that frame must still match the measured
// canvas), the screenshot run scores the user's screenshot (still byte-equal to
// the stage 1 manifest record). Derived frames never qualify as the reference.
function collectOthersReferenceLockIssues(runDir, stage, designSource, canonicalReference, issues) {
  const referencePath = join(runDir, ...canonicalReference.split('/'));
  if (!existsSync(referencePath) || !statSync(referencePath).isFile()) {
    issues.push(`stage ${stage} reference image is missing: ${canonicalReference}`);
    return;
  }
  if (designSource === 'others-html') {
    const facts = readJsonIfExistsQuietly(join(runDir, ...OTHERS_HTML_FACTS.split('/')));
    const frames = Array.isArray(facts?.reference?.frames) ? facts.reference.frames : [];
    if (frames.length > 0 && frames[0] !== 'reference-00.png') {
      issues.push(`stage ${stage} reference set must lock reference-00.png as the scored frame (got ${frames[0]})`);
    }
    const canvas = facts?.render?.canvas;
    const size = readPngSize(referencePath);
    if (canvas && size && (size.width !== canvas.physicalWidth || size.height !== canvas.physicalHeight)) {
      issues.push(
        `stage ${stage} scored reference frame (${size.width}x${size.height}) must match the measured canvas (${canvas.physicalWidth}x${canvas.physicalHeight})`
      );
    }
    return;
  }
  const manifest = readJsonIfExistsQuietly(join(runDir, 'inputs-manifest.json'));
  if (isSha256Hex(manifest?.screenshot?.sha256) && hashFile(referencePath) !== manifest.screenshot.sha256) {
    issues.push(`stage ${stage} scored reference screenshot must stay byte-identical to the stage 1 manifest record`);
  }
  // The stronger anchor: the probe is frozen by the stage 2 confirmation
  // snapshot and records the hash of the screenshot it actually measured, so
  // rewriting both the image and the manifest still leaves this one behind.
  const probe = readJsonIfExistsQuietly(join(runDir, ...OTHERS_VISUAL_PROBE.split('/')));
  if (isSha256Hex(probe?.source?.sha256) && hashFile(referencePath) !== probe.source.sha256) {
    issues.push(`stage ${stage} scored reference screenshot must stay byte-identical to the probe-locked original`);
  }
}

// The only non-default ignore values a scoring command may take are the
// measured system-area heights; anything else swallows real diff area. A
// measured value only counts while it stays plausible: an unbounded "truth"
// (a self-reported vp height, a content band read off the first probe stripe)
// would legalise ignoring half the screen.
function withinIgnoreCap(value, defaultValue, referenceHeightPx) {
  const cap = Math.max(defaultValue * 2, Math.round(referenceHeightPx * 0.1));
  return Number.isFinite(value) && value > 0 && value <= cap;
}

function othersCalibrationAllowedIgnoreValues(runDir, designSource) {
  const top = new Set([44]);
  const bottom = new Set([36]);
  if (designSource === 'others-html') {
    const facts = readJsonIfExistsQuietly(join(runDir, ...OTHERS_HTML_FACTS.split('/')));
    const statusBarVp = Number(facts?.render?.statusBarVp);
    const gestureBarVp = Number(facts?.render?.gestureBarVp);
    const dsf = Number(facts?.render?.deviceScaleFactor);
    const canvasHeightPx = Number(facts?.render?.canvas?.physicalHeight);
    // The scorer works in the reference's pixel space, so the measured vp
    // heights enter it scaled by the capture factor; both readings stay legal
    // to keep a 1x canvas honest.
    if (Number.isFinite(statusBarVp) && statusBarVp > 0) {
      if (withinIgnoreCap(statusBarVp, 44, canvasHeightPx)) {
        top.add(Math.round(statusBarVp));
      }
      if (Number.isFinite(dsf) && dsf > 0 && withinIgnoreCap(statusBarVp * dsf, 44, canvasHeightPx)) {
        top.add(Math.round(statusBarVp * dsf));
      }
    }
    if (Number.isFinite(gestureBarVp) && gestureBarVp > 0) {
      if (withinIgnoreCap(gestureBarVp, 36, canvasHeightPx)) {
        bottom.add(Math.round(gestureBarVp));
      }
      if (Number.isFinite(dsf) && dsf > 0 && withinIgnoreCap(gestureBarVp * dsf, 36, canvasHeightPx)) {
        bottom.add(Math.round(gestureBarVp * dsf));
      }
    }
    return { top, bottom };
  }
  const probe = readJsonIfExistsQuietly(join(runDir, ...OTHERS_VISUAL_PROBE.split('/')));
  const bands = Array.isArray(probe?.bands) ? probe.bands : [];
  // The probe is locked by the confirmation snapshot, so its canvas is the
  // trustworthy height - the manifest screenshot entry is agent-rewritable.
  const height = Number(probe?.canvas?.physicalHeight);
  if (Number.isFinite(height) && height > 0 && bands.length > 0) {
    const firstRatio = Number(bands[0]?.heightRatio);
    const lastRatio = Number(bands[bands.length - 1]?.heightRatio);
    if (withinIgnoreCap(firstRatio * height, 44, height)) {
      top.add(Math.round(firstRatio * height));
    }
    if (withinIgnoreCap(lastRatio * height, 36, height)) {
      bottom.add(Math.round(lastRatio * height));
    }
  }
  return { top, bottom };
}

// Repair paths are relative to the project root recorded by the stage 1
// integration snapshot; a missing root is rejected up front, so the disk
// reconciliation below always has its anchor.
function othersProjectRoot(runDir) {
  const manifest = readJsonIfExistsQuietly(join(runDir, 'inputs-manifest.json'));
  const projectRootPath = manifest?.integrationSnapshot?.projectRootPath;
  if (typeof projectRootPath !== 'string' || projectRootPath.length === 0) {
    return null;
  }
  return isAbsolute(projectRootPath) ? projectRootPath : resolve(runDir, projectRootPath);
}

// The shared collector already reports a missing or unparseable score.json;
// this read only feeds the integrity checks and never duplicates those issues.
function readRoundScoreDocument(runDir, evidence) {
  if (typeof evidence?.scoreJson !== 'string' || evidence.scoreJson.trim().length === 0) {
    return null;
  }
  const path = resolve(runDir, evidence.scoreJson);
  const pathFromRunDir = relative(runDir, path);
  if (pathFromRunDir.startsWith('..') || isAbsolute(pathFromRunDir)) {
    return null;
  }
  return readJsonIfExistsQuietly(path);
}

// ui_score echoes the paths it was given; normalize them back to run-relative
// so a canonical-path comparison cannot be dodged by absolute or dotted forms.
function normalizeRunEvidencePath(runDir, value) {
  if (typeof value !== 'string' || value.trim().length === 0) {
    return null;
  }
  let candidate = value.replaceAll('\\', '/');
  if (isAbsolute(value)) {
    const fromRunDir = relative(runDir, resolve(value)).replaceAll('\\', '/');
    if (!fromRunDir.startsWith('..')) {
      candidate = fromRunDir;
    }
  }
  while (candidate.startsWith('./')) {
    candidate = candidate.slice(2);
  }
  return candidate;
}

function collectScoredPaths(runDir, scoreDocument, key) {
  if (!scoreDocument || !Array.isArray(scoreDocument.pairs)) {
    return [];
  }
  return scoreDocument.pairs
    .map((pair) => normalizeRunEvidencePath(runDir, pair?.[key]))
    .filter((value) => value !== null);
}

// Rounds after the first owe repair and build evidence - the machine reading of
// the scoring workflow's "next round admission" clauses, which stay prose for
// the mainstream sources. The final round's hashes must still match the files
// on disk: nothing may change after the last scored repair.
function collectOthersRoundRepairIssues(runDir, stage, round, evidence, projectRoot, isFinalRound, issues) {
  const repair = evidence?.repair;
  const changedFiles = Array.isArray(repair?.changedFiles) ? repair.changedFiles : [];
  if (!repair || typeof repair !== 'object' || Array.isArray(repair) || changedFiles.length === 0) {
    issues.push(`stage ${stage} round ${round} must record repair.changedFiles (at least one modified file) for every round after the first`);
  } else {
    for (const file of changedFiles) {
      if (typeof file?.path !== 'string' || file.path.trim().length === 0) {
        issues.push(`stage ${stage} round ${round} repair.changedFiles entries must record a path`);
      } else if (!isSha256Hex(file.beforeSha256) || !isSha256Hex(file.afterSha256)) {
        issues.push(`stage ${stage} round ${round} repair.changedFiles ${file.path} must record beforeSha256 and afterSha256`);
      } else if (file.beforeSha256 === file.afterSha256) {
        issues.push(`stage ${stage} round ${round} repair.changedFiles ${file.path} records no change (before equals after)`);
      } else if (isFinalRound && projectRoot) {
        const target = resolve(projectRoot, file.path);
        const fromRoot = relative(projectRoot, target);
        if (fromRoot.startsWith('..') || isAbsolute(fromRoot)) {
          issues.push(`stage ${stage} round ${round} repair.changedFiles ${file.path} escapes the project root`);
        } else if (!existsSync(target) || hashFile(target) !== file.afterSha256) {
          issues.push(
            `stage ${stage} round ${round} final repair ${file.path} must match the file on disk (no edits after the last scored round)`
          );
        }
      }
    }
  }
  if (evidence?.build?.success !== true || !isSha256Hex(evidence?.build?.artifactSha256)) {
    issues.push(`stage ${stage} round ${round} must record a successful build (success=true with artifactSha256) for the repaired code`);
  }
}

// Hand-written stage timestamps are fabrication-prone: every faked value this
// path has produced either sat on an exact minute boundary (seconds and
// milliseconds both zero, which a real clock reading essentially never does)
// or was a plausible-looking invented value. Round values are rejected
// outright; causality closes the remaining hole — a hand-written value cannot
// predict the controller's clock, so any timestamp dated in the future of the
// reference time is rejected too.
const TIMESTAMP_CAUSALITY_TOLERANCE_MS = 60_000;
// File-time windows close the fabrication forms the causality gate cannot
// see: a value dated into the future of its own file (written ahead), or a
// remembered value from a previous session (round-4's 15.5h-stale stamps).
// Honest flows read the clock and then write, so a claimed timestamp always
// sits within [write - 15min, write + 10s].
const TIMESTAMP_FILE_WINDOW_PAST_MS = 15 * 60 * 1000;
const TIMESTAMP_FILE_WINDOW_FUTURE_MS = 10 * 1000;

function collectRoundTimestampIssues(value, label, issues, referenceNowMs) {
  if (typeof value !== 'string' || value.trim().length === 0) {
    return;
  }
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) {
    issues.push(`${label} must be a parseable timestamp`);
    return;
  }
  if (/T\d{2}:\d{2}:00(?:\.0+)?(?:Z|[+-]\d{2}:?\d{2})?$/.test(value.trim())) {
    issues.push(
      `${label} must carry nonzero seconds/milliseconds (re-read the system clock; hand-written round values are rejected)`
    );
  }
  if (Number.isFinite(referenceNowMs) && parsed > referenceNowMs + TIMESTAMP_CAUSALITY_TOLERANCE_MS) {
    issues.push(
      `${label} cannot be later than the controller clock (hand-written future values are rejected; re-read the system clock with new Date().toISOString())`
    );
  }
}

// The reference clock for causality checks: the current time, floored upward
// by any gate completion time this run has already persisted. A machine clock
// that steps backwards between stages must not turn old honest timestamps
// into "future" values on completed-stage replays; the persisted gate times
// pin the floor.
function resolveTimestampReferenceNowMs(runDir) {
  let reference = Date.now();
  const state = readJsonOrNull(join(runDir, 'workflow-state.json'), 'workflow-state', []);
  for (const stage of Array.isArray(state?.completedStages) ? state.completedStages : []) {
    const gate = readGate(runDir, Number(stage));
    const gateTime = gate?.completedAt ? Date.parse(gate.completedAt) : Number.NaN;
    if (Number.isFinite(gateTime) && gateTime > reference) {
      reference = gateTime;
    }
  }
  return reference;
}

// The capability ledger accumulates hand-written invokedAt/completedAt stamps
// across the whole run. Sweep them at every stage completion so a fabricated
// value fails the stage it was written in, not just the final summary.
function collectOthersHtmlLedgerTimestampIssues(runDir, referenceNowMs) {
  const issues = [];
  readCapabilityLedgerEntries(runDir).forEach((entry, index) => {
    collectRoundTimestampIssues(entry?.invokedAt, `capability ledger entry ${index} invokedAt`, issues, referenceNowMs);
    collectRoundTimestampIssues(entry?.completedAt, `capability ledger entry ${index} completedAt`, issues, referenceNowMs);
    const invokedAt = typeof entry?.invokedAt === 'string' ? Date.parse(entry.invokedAt) : Number.NaN;
    const completedAt = typeof entry?.completedAt === 'string' ? Date.parse(entry.completedAt) : Number.NaN;
    if (Number.isFinite(invokedAt) && Number.isFinite(completedAt) && invokedAt > completedAt + TIMESTAMP_CAUSALITY_TOLERANCE_MS) {
      issues.push(`capability ledger entry ${index} invokedAt cannot be later than completedAt`);
    }
  });
  return issues;
}

function collectTimestampFileWindowIssues(filePath, label, claimed, issues) {
  if (typeof claimed !== 'string' || claimed.trim().length === 0 || !existsSync(filePath)) {
    return;
  }
  const parsed = Date.parse(claimed);
  if (!Number.isFinite(parsed)) {
    return; // parse and causality checks already report malformed values
  }
  const writtenAt = statSync(filePath).mtimeMs;
  if (parsed < writtenAt - TIMESTAMP_FILE_WINDOW_PAST_MS) {
    issues.push(
      `${label} is dated before its own file was written (read the system clock in the same command sequence that writes the file; remembered or estimated values are rejected)`
    );
  } else if (parsed > writtenAt + TIMESTAMP_FILE_WINDOW_FUTURE_MS) {
    issues.push(
      `${label} is dated after its own file was written (read the system clock in the same command sequence that writes the file; estimated values are rejected)`
    );
  }
}

function readJsonIfExistsQuietly(filePath) {
  if (!existsSync(filePath)) {
    return null;
  }
  try {
    const raw = readFileSync(filePath, 'utf8');
    return JSON.parse(raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw);
  } catch {
    return null;
  }
}

function othersHtmlStageGatePassed(runDir, stage) {
  return readGate(runDir, stage)?.status === 'passed';
}

// Live-only file-time windows. Single-write report files are anchored to the
// stage that owns them: once that stage's gate has passed, stage-5 rework
// backfill may legitimately rewrite the file and move its mtime, so the
// window must not re-fire on later evaluations. The ledger is not stage-owned
// (append-only across the run): its first entry is anchored to the file's
// creation time and its last completed entry to the latest write. Missing
// files are the owning collectors' business; this pass stays quiet about them
// so fast-variant runs (no calibration report) are unaffected.
function collectOthersHtmlTimestampFileIssues(runDir, ctx = {}) {
  const issues = [];
  if (ctx.live !== true) {
    return issues;
  }
  if (!othersHtmlStageGatePassed(runDir, 1)) {
    const clarification = readJsonIfExistsQuietly(join(runDir, 'requirement-clarification.json'));
    if (clarification && typeof clarification === 'object' && !Array.isArray(clarification)) {
      collectTimestampFileWindowIssues(
        join(runDir, 'requirement-clarification.json'),
        'stage 1 requirement clarification clarificationTimestamp',
        clarification.clarificationTimestamp,
        issues
      );
    }
  }
  if (!othersHtmlStageGatePassed(runDir, 2)) {
    const build = readJsonIfExistsQuietly(join(runDir, 'stage2', 'initial-build-report.json'));
    if (build && typeof build === 'object' && !Array.isArray(build)) {
      collectTimestampFileWindowIssues(
        join(runDir, 'stage2', 'initial-build-report.json'),
        'stage 2 initial build report completedAt',
        build.completedAt,
        issues
      );
    }
    const review = readJsonIfExistsQuietly(join(runDir, 'stage2', 'visual-spec-review.json'));
    if (review && typeof review === 'object' && !Array.isArray(review)) {
      collectTimestampFileWindowIssues(
        join(runDir, 'stage2', 'visual-spec-review.json'),
        'stage 2 visual spec review reviewedAt',
        review.reviewedAt,
        issues
      );
    }
    const confirmation = readJsonIfExistsQuietly(join(runDir, 'stage2', 'component-confirmation.json'));
    if (confirmation && typeof confirmation === 'object' && !Array.isArray(confirmation)) {
      collectTimestampFileWindowIssues(
        join(runDir, 'stage2', 'component-confirmation.json'),
        'stage 2 component confirmation acceptedAt',
        confirmation.acceptedAt,
        issues
      );
    }
  }
  if (!othersHtmlStageGatePassed(runDir, 4)) {
    const audit = readJsonIfExistsQuietly(join(runDir, 'stage4', 'quality-audit.json'));
    if (audit && typeof audit === 'object' && !Array.isArray(audit)) {
      collectTimestampFileWindowIssues(
        join(runDir, 'stage4', 'quality-audit.json'),
        'stage 4 quality audit auditedAt',
        audit.auditedAt,
        issues
      );
    }
  }
  const ledgerEntries = readCapabilityLedgerEntries(runDir);
  const ledgerPath = join(runDir, 'capability-invocation-ledger.json');
  if (ledgerEntries.length > 0 && existsSync(ledgerPath)) {
    const stat = statSync(ledgerPath);
    const firstInvoked = Date.parse(ledgerEntries[0]?.invokedAt);
    // birthtimeMs is 0 on filesystems without a creation time (tmpfs, some
    // overlay and network mounts). Comparing against it would reject every
    // live stage, so the birthtime window only applies when it exists.
    if (Number.isFinite(firstInvoked) && stat.birthtimeMs > 0) {
      if (firstInvoked < stat.birthtimeMs - TIMESTAMP_FILE_WINDOW_PAST_MS) {
        issues.push(
          'capability ledger first entry invokedAt is dated before the ledger file was created (append the entry when the capability is invoked; estimated values are rejected)'
        );
      } else if (firstInvoked > stat.birthtimeMs + TIMESTAMP_FILE_WINDOW_FUTURE_MS) {
        issues.push(
          'capability ledger first entry invokedAt is dated after the ledger file was created (read the clock in the same command sequence that appends the entry)'
        );
      }
    }
    const lastEntry = ledgerEntries[ledgerEntries.length - 1];
    const lastCompleted = Date.parse(lastEntry?.completedAt);
    if (Number.isFinite(lastCompleted)) {
      if (lastCompleted < stat.mtimeMs - TIMESTAMP_FILE_WINDOW_PAST_MS) {
        issues.push(
          'capability ledger last entry completedAt is dated before the ledger was last written (read the clock in the same command sequence that writes the entry)'
        );
      } else if (lastCompleted > stat.mtimeMs + TIMESTAMP_FILE_WINDOW_FUTURE_MS) {
        issues.push('capability ledger last entry completedAt is dated after the ledger was last written');
      }
    }
  }
  return issues;
}

// Source-agnostic stage 1 evidence: the requirement clarification document is
// created by stage 1 itself, so it must exist and be structurally valid by the
// time stage 1 completes. The controller only validates evidence; it never
// creates, repairs, or rewrites this file.
function collectRequirementClarificationEvidenceIssues(runDir, catalog) {
  const issues = [];
  const clarification = readJsonOrNull(
    join(runDir, 'requirement-clarification.json'),
    'stage 1 requirement clarification',
    issues
  );
  // readJsonOrNull returns null both for missing/unparseable files (issue
  // already recorded) and for a legal JSON null document (no issue yet); the
  // latter must not slip through as a valid document.
  if (clarification === null) {
    if (issues.length === 0) {
      issues.push('stage 1 requirement clarification must be an object');
    }
    return issues;
  }
  if (typeof clarification !== 'object' || Array.isArray(clarification)) {
    issues.push('stage 1 requirement clarification must be an object');
    return issues;
  }
  if (clarification.preCheckCompleted !== true) {
    issues.push('stage 1 requirement clarification preCheckCompleted must be true');
  }
  const expectedSource = catalog.designSource ?? 'pixso';
  if (clarification.designSource !== expectedSource) {
    issues.push(`stage 1 requirement clarification designSource must be ${expectedSource}, got ${clarification.designSource}`);
  }
  // Only a truly absent field (undefined) skips the optional checks; a present
  // null is a type error per the runtime contract.
  if (clarification.visualCalibration !== undefined) {
    if (clarification.visualCalibration === null || typeof clarification.visualCalibration !== 'object' || Array.isArray(clarification.visualCalibration)) {
      issues.push('stage 1 requirement clarification visualCalibration must be an object');
    } else {
      if (clarification.visualCalibration.enabled !== undefined && typeof clarification.visualCalibration.enabled !== 'boolean') {
        issues.push('stage 1 requirement clarification visualCalibration.enabled must be a boolean');
      }
      // All six sources calibrate by score with the same defaults, so the
      // optional numbers must simply be sane wherever they appear.
      if (clarification.visualCalibration.scoreThreshold !== undefined) {
        if (!Number.isFinite(clarification.visualCalibration.scoreThreshold)) {
          issues.push('stage 1 requirement clarification visualCalibration.scoreThreshold must be a finite number');
        }
      }
      if (clarification.visualCalibration.maxRounds !== undefined) {
        if (
          !Number.isInteger(clarification.visualCalibration.maxRounds) ||
          clarification.visualCalibration.maxRounds < 1 ||
          clarification.visualCalibration.maxRounds > 5
        ) {
          issues.push('stage 1 requirement clarification visualCalibration.maxRounds must be an integer between 1 and 5 when present');
        }
      }
    }
  }
  return issues;
}

// ---------------------------------------------------------------------------
// others-html (HTML design source) evidence
//
// This source keeps its visual truth in text: the DOM plus the computed styles
// of the rendered page. Stage 1 therefore freezes measured layout facts instead
// of vision estimates, and every later stage is checked against those facts
// rather than against a prose claim. The three checks below close the gaps that
// the previous implementation left open: the facts themselves, the facts to
// page reconciliation, and the calibration report that must stay fact-driven.
// ---------------------------------------------------------------------------

const OTHERS_HTML_FACTS = 'stage1/layout-facts.json';
const OTHERS_HTML_SPEC = 'stage1/visual-spec.json';
const OTHERS_HTML_MANIFEST = 'inputs-manifest.json';
const OTHERS_HTML_INPUT = 'source/html/input.html';
// The frozen entry is normally source/html/input.html, but a design whose
// references reach above its own folder is frozen with a wider root, which leaves
// the entry in a subdirectory. Everything downstream addresses it through
// inputs-manifest.htmlSource.path instead of assuming the flat name.
const OTHERS_HTML_INPUT_PATTERN = /^source\/html\/(?:[^/]+\/)*input\.html$/;

function othersHtmlInputRelative(manifest) {
  const declared = typeof manifest?.htmlSource?.path === 'string' ? manifest.htmlSource.path.replaceAll('\\', '/') : '';
  return OTHERS_HTML_INPUT_PATTERN.test(declared) ? declared : null;
}
const OTHERS_HTML_WORKFLOW_STATE = 'workflow-state.json';
const OTHERS_HTML_UI_MANIFEST = 'stage2/generated-ui-manifest.json';
const OTHERS_HTML_INTERACTION_REPORT = 'stage3-interaction-report.md';
const OTHERS_HTML_COMPLETENESS_REPORT = 'completeness-report.md';
const OTHERS_HTML_QUALITY_AUDIT = 'stage4/quality-audit.json';
const OTHERS_HTML_CALIBRATION = 'stage5-visual-calibration-report.json';
// Stage 5 scores the first reference frame only. Frames above 00 exist for a
// human to read; the stitched and de-clipped images re-flow the layout and must
// never enter a pixel comparison.
const OTHERS_HTML_SCORED_REFERENCE = 'source/html/reference/reference-00.png';
const OTHERS_HTML_MIN_COVERAGE = 1.0;
const OTHERS_HTML_SPEC_KEYS = new Set(['roles', 'systemUi', 'notImplemented', 'unknowns']);
// Optional so completed runs recorded before the origin field existed remain
// replayable; live stage-1 completion still requires it (see the validator).
const OTHERS_HTML_OPTIONAL_SPEC_KEYS = new Set(['canvasIncludesSystemBar']);
const OTHERS_HTML_REGISTRATION_MODES = new Set(['route-table', 'index-navigation', 'existing-router']);
const OTHERS_HTML_REACHABILITY = new Set(['entry-point-exists', 'requires-temporary-preview']);
const OTHERS_HTML_AUDIT_KEYS = [
  'structureAndValues',
  'hds',
  'systemUi',
  'safeArea',
  'topCollision',
  'resources',
  'routing',
  'codeQuality'
];
function readCapabilityLedgerEntries(runDir) {
  const ledgerPath = resolveLedgerPath(runDir);
  if (!existsSync(ledgerPath)) {
    return [];
  }
  const document = readJsonOrNull(ledgerPath, 'capability ledger', []);
  if (Array.isArray(document)) {
    return document;
  }
  return Array.isArray(document?.invocations) ? document.invocations : [];
}

function hasCompletedCapability(entries, capability) {
  return entries.some((entry) => entry?.capability === capability && entry?.status === 'completed');
}

// Stage 3 owns the interaction report only: structure and visual values were
// frozen in stage 2, so this stage must not be able to pass on prose alone.
function collectOthersHtmlStage3InteractionIssues(runDir) {
  const issues = [];
  if (!isNonEmptyFile(join(runDir, OTHERS_HTML_INTERACTION_REPORT))) {
    issues.push(`stage 3 interaction report is missing or empty: ${OTHERS_HTML_INTERACTION_REPORT}`);
  }
  const entries = readCapabilityLedgerEntries(runDir);
  if (!hasCompletedCapability(entries, 'hmos-d2a-arkts-logic-completer')) {
    issues.push('stage 3 must record hmos-d2a-arkts-logic-completer as completed in the capability ledger');
  }
  return issues;
}

// Stage 6 closes the run: every artifact must exist, the ledger must be honest
// about what ran, and the run index must already contain this run's record.
function collectOthersHtmlStage6SummaryIssues(runDir, catalog = { variant: 'full' }) {
  const issues = [];
  const required = [
    'requirement-clarification.json',
    'inputs-manifest.json',
    'input-security-report.json',
    'stage1/layout-facts.json',
    'stage1/visual-spec.json',
    'component-tree.md',
    'design-doc.md',
    'stage3-interaction-report.md',
    'hds-decision.json',
    'stage4/quality-audit.json',
    'stage4/build-report.md',
    'capability-invocation-ledger.json'
  ];
  if ((catalog.variant ?? 'full') === 'full') {
    required.push('stage5-visual-calibration-report.json');
  }
  const stageOneManifest = readJsonOrNull(join(runDir, OTHERS_HTML_MANIFEST), 'stage 1 inputs manifest', []);
  required.push(othersHtmlInputRelative(stageOneManifest) ?? OTHERS_HTML_INPUT);
  const missing = required.filter((relativePath) => !isNonEmptyFile(join(runDir, ...relativePath.split('/'))));
  if (missing.length > 0) {
    issues.push(`stage 6 cannot close the run, missing artifacts: ${missing.join(', ')}`);
  }
  if (!isNonEmptyFile(join(runDir, OTHERS_HTML_COMPLETENESS_REPORT))) {
    issues.push(`stage 6 deliverable is missing or empty: ${OTHERS_HTML_COMPLETENESS_REPORT}`);
  }
  const entries = readCapabilityLedgerEntries(runDir);
  const requiredCapabilities = [
    'hmos-d2a-html-to-arkui',
    'hmos-d2a-solution-design',
    'hmos-d2a-arkts-logic-completer'
  ];
  for (const capability of requiredCapabilities) {
    if (!hasCompletedCapability(entries, capability)) {
      issues.push(`stage 6 capability ledger must record ${capability} as completed`);
    }
  }
  // Full runs calibrate by score: the ledger must show the scoring chain, one
  // completed scoring entry per round. Skipped calibrations and Fast runs (no
  // calibration stage at all) must not carry scoring entries.
  const clarification = readJsonIfExistsQuietly(join(runDir, 'requirement-clarification.json'));
  const calibrationEnabled = (catalog.variant ?? 'full') === 'full' && clarification?.visualCalibration?.enabled !== false;
  if (calibrationEnabled) {
    if (!hasCompletedCapability(entries, 'hmos-d2a-arkui-scoring-workflow')) {
      issues.push('stage 6 capability ledger must record hmos-d2a-arkui-scoring-workflow as completed');
    }
    const calibration = readJsonIfExistsQuietly(join(runDir, OTHERS_HTML_CALIBRATION));
    const roundsCompleted = Number(calibration?.roundsCompleted);
    const upperBound = Number.isInteger(roundsCompleted) && roundsCompleted >= 1 ? roundsCompleted : 0;
    for (let round = 1; round <= upperBound; round += 1) {
      const scored = entries.some(
        (entry) =>
          entry?.capability === 'hmos-d2a-ui-reconstruction-score' &&
          Number(entry?.round) === round &&
          entry?.status === 'completed'
      );
      if (!scored) {
        issues.push(`stage 6 capability ledger must record hmos-d2a-ui-reconstruction-score as completed for round ${round}`);
      }
    }
  } else {
    for (const unscored of ['hmos-d2a-arkui-scoring-workflow', 'hmos-d2a-ui-reconstruction-score']) {
      if (entries.some((entry) => entry?.capability === unscored)) {
        issues.push(`stage 6 capability ledger must not record ${unscored}: visual calibration was skipped or this variant has no calibration stage`);
      }
    }
  }
  const hds = readJsonOrNull(join(runDir, 'hds-decision.json'), 'hds decision', []);
  const hdsInvoked = entries.some((entry) => entry?.capability === 'hmos-d2a-arkui2hds');
  if (hds?.hdsRequired === false && hdsInvoked) {
    issues.push('stage 6 ledger must not record hmos-d2a-arkui2hds when the user asked for no HDS');
  }
  if (hds?.hdsRequired === true && !hasCompletedCapability(entries, 'hmos-d2a-arkui2hds')) {
    issues.push('stage 6 ledger must record hmos-d2a-arkui2hds as completed when HDS is required');
  }
  const manifest = readJsonOrNull(join(runDir, OTHERS_HTML_MANIFEST), 'stage 1 inputs manifest', []);
  const uiManifest = readJsonOrNull(
    join(runDir, ...OTHERS_HTML_UI_MANIFEST.split('/')),
    'stage 2 generated ui manifest',
    []
  );
  const projectRootPath = manifest?.integrationSnapshot?.projectRootPath;
  if (typeof projectRootPath === 'string' && projectRootPath.length > 0) {
    const projectRoot = isAbsolute(projectRootPath) ? projectRootPath : resolve(runDir, projectRootPath);
    const runIndexFileRel =
      (manifest?.integrationSnapshot?.runIndexFile ?? defaultRunIndexFile(catalog.variant ?? 'full')).toString();
    const indexPath = resolve(projectRoot, runIndexFileRel);
    if (!existsSync(indexPath)) {
      issues.push('stage 6 run index is missing; stage 2 completion should have written this run');
    } else {
      const index = readJsonOrNull(indexPath, 'run index', []);
      const record = (Array.isArray(index?.pages) ? index.pages : []).find(
        (page) =>
          page?.designSource === 'others-html' &&
          page?.runId === basename(runDir) &&
          page?.pageFile === uiManifest?.page?.file
      );
      if (!record) {
        issues.push('stage 6 run index must contain this run record');
      }
    }
  }
  return issues;
}
function readPngSize(path) {
  if (!existsSync(path) || !statSync(path).isFile()) {
    return null;
  }
  const bytes = readFileSync(path);
  if (bytes.length < 24 || bytes[0] !== 0x89 || bytes[1] !== 0x50 || bytes[2] !== 0x4e || bytes[3] !== 0x47) {
    return null;
  }
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

function isSha256Hex(value) {
  return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
}

// The visual spec carries semantics only. Any number in it means the author is
// re-stating a measured value by hand, which is exactly how the previous run
// ended up with a palette entry that contradicted its own CSS citation.
function collectVisualSpecNumericIssues(node, path, issues) {
  if (Array.isArray(node)) {
    for (const [index, item] of node.entries()) {
      collectVisualSpecNumericIssues(item, `${path}[${index}]`, issues);
    }
    return issues;
  }
  if (node === null || typeof node !== 'object') {
    return issues;
  }
  for (const [key, value] of Object.entries(node)) {
    const childPath = `${path}.${key}`;
    if (typeof value === 'number') {
      if (path !== 'visual-spec' || key !== 'schemaVersion') {
        issues.push(`stage 1 visual spec must not restate measured values: ${childPath} is a number, cite a layout-facts nodeId instead`);
      }
      continue;
    }
    collectVisualSpecNumericIssues(value, childPath, issues);
  }
  return issues;
}

function collectOthersHtmlFactsIssues(runDir, manifest, issues) {
  const factsPath = join(runDir, ...OTHERS_HTML_FACTS.split('/'));
  if (!existsSync(factsPath)) {
    issues.push(`stage 1 layout facts are missing: ${OTHERS_HTML_FACTS}`);
    return null;
  }
  if (statSync(factsPath).size > 2 * 1024 * 1024) {
    issues.push(`stage 1 layout facts must stay under 2 MB: ${OTHERS_HTML_FACTS}`);
  }
  const facts = readJsonOrNull(factsPath, 'stage 1 layout facts', issues);
  if (!facts || typeof facts !== 'object' || Array.isArray(facts)) {
    issues.push('stage 1 layout facts must be an object');
    return null;
  }
  if (facts.schemaVersion !== 1) {
    issues.push(`stage 1 layout facts schemaVersion must be 1, got ${facts.schemaVersion}`);
  }
  if (facts.designSource !== 'others-html') {
    issues.push(`stage 1 layout facts designSource must be others-html, got ${facts.designSource}`);
  }
  const declaredInput = othersHtmlInputRelative(manifest) ?? OTHERS_HTML_INPUT;
  const inputPath = join(runDir, ...declaredInput.split('/'));
  if (!isSha256Hex(facts.source?.sha256)) {
    issues.push('stage 1 layout facts source.sha256 must be a 64-char lowercase SHA-256');
  } else if (!existsSync(inputPath)) {
    issues.push(`stage 1 design source is missing: ${declaredInput}`);
  } else if (hashFile(inputPath) !== facts.source.sha256) {
    issues.push(`stage 1 layout facts source.sha256 does not match ${declaredInput}`);
  }
  if (typeof facts.source?.path === 'string' && facts.source.path.replaceAll('\\', '/') !== declaredInput) {
    issues.push(`stage 1 layout facts source.path must equal the frozen input (${declaredInput})`);
  }
  const render = facts.render;
  if (!render || typeof render !== 'object') {
    issues.push('stage 1 layout facts render must be an object');
  } else {
    if (!isPositiveBoundedNumber(render.deviceScaleFactor, 10)) {
      issues.push('stage 1 layout facts render.deviceScaleFactor must be a positive number');
    }
    if (
      !isPositiveBoundedNumber(render.canvas?.logicalWidth, 10000) ||
      !isPositiveBoundedNumber(render.canvas?.logicalHeight, 20000)
    ) {
      issues.push('stage 1 layout facts render.canvas logical size must be positive numbers');
    }
    if (!isPositiveBoundedNumber(render.content?.coverage, 1000)) {
      issues.push('stage 1 layout facts render.content.coverage must be a positive number');
    } else if (render.content.coverage < OTHERS_HTML_MIN_COVERAGE) {
      issues.push(
        `stage 1 reference coverage must reach the whole design content (got ${render.content.coverage}, need >= ${OTHERS_HTML_MIN_COVERAGE}); a single viewport capture leaves most of the page unverifiable`
      );
    }
    if (!isPositiveBoundedNumber(render.content?.extentPx, 200000)) {
      issues.push('stage 1 layout facts render.content.extentPx must record the measured design content height');
    }
    if (
      typeof render.content?.visibleCoverage !== 'number' ||
      !Number.isFinite(render.content.visibleCoverage) ||
      render.content.visibleCoverage <= 0 ||
      render.content.visibleCoverage > 1
    ) {
      issues.push('stage 1 layout facts render.content.visibleCoverage must be a number in (0, 1]');
    } else if (
      isPositiveBoundedNumber(render.content.extentPx, 200000) &&
      isPositiveBoundedNumber(render.canvas?.logicalHeight, 20000)
    ) {
      const expectedVisible = Math.min(
        1,
        (Number(render.content.frames) * Number(render.canvas.logicalHeight)) / Number(render.content.extentPx)
      );
      if (Math.abs(expectedVisible - render.content.visibleCoverage) > 0.01) {
        issues.push(
          `stage 1 layout facts render.content.visibleCoverage must equal frames x viewport height / extentPx (expected ${expectedVisible.toFixed(4)})`
        );
      }
    }
    if (render.resources !== undefined) {
      if (!Number.isFinite(render.resources?.total) || !Number.isFinite(render.resources?.missing)) {
        issues.push('stage 1 layout facts render.resources must record numeric total and missing');
      } else if (render.resources.total > 0 && render.resources.missing / render.resources.total > 0.25) {
        issues.push(
          `stage 1 local resources do not resolve beside input.html: ${render.resources.missing}/${render.resources.total}; the reference frames were rendered without them`
        );
      }
    }
    if (manifest?.referenceSet?.logicalCanvas) {
      const canvas = render.canvas ?? {};
      const manifestCanvas = manifest.referenceSet.logicalCanvas;
      if (
        Number(canvas.logicalWidth) !== Number(manifestCanvas.width) ||
        Number(canvas.logicalHeight) !== Number(manifestCanvas.height)
      ) {
        issues.push('stage 1 layout facts render.canvas must match inputs-manifest.json referenceSet.logicalCanvas');
      }
    }
  }
  if (!Array.isArray(facts.nodes) || facts.nodes.length === 0) {
    issues.push('stage 1 layout facts nodes must be a non-empty array');
    return facts;
  }
  const seen = new Set();
  for (const [index, node] of facts.nodes.entries()) {
    const nodeId = node?.nodeId;
    if (typeof nodeId !== 'string' || nodeId.trim().length === 0) {
      issues.push(`stage 1 layout facts nodes[${index}].nodeId must be a non-empty string`);
      continue;
    }
    if (seen.has(nodeId)) {
      issues.push(`stage 1 layout facts nodeId must be unique: ${nodeId}`);
    }
    seen.add(nodeId);
    const rect = node.rect;
    if (
      !rect ||
      !Number.isFinite(rect.x) ||
      !Number.isFinite(rect.y) ||
      !isPositiveBoundedNumber(rect.w, 100000) ||
      !isPositiveBoundedNumber(rect.h, 100000)
    ) {
      issues.push(`stage 1 layout facts nodes[${index}] rect must record finite x/y and positive w/h`);
    }
  }
  if (facts.systemUi !== undefined) {
    if (!Array.isArray(facts.systemUi)) {
      issues.push('stage 1 layout facts systemUi must be an array');
    } else {
      for (const [index, entry] of facts.systemUi.entries()) {
        if (!seen.has(entry?.nodeId)) {
          issues.push(`stage 1 layout facts systemUi[${index}].nodeId must reference an existing node`);
        }
        if (typeof entry?.kind !== 'string' || entry.kind.trim().length === 0) {
          issues.push(`stage 1 layout facts systemUi[${index}].kind must be a non-empty string`);
        }
      }
    }
  }
  if (!Array.isArray(facts.uncertainties)) {
    issues.push('stage 1 layout facts uncertainties must be an array');
  }
  return facts;
}

// The routine systemUi decision for a facts entry: the user's
// systemUiPreference (with per-node or per-kind overrides) decides it, not
// the agent. Unknown kinds return null and stay with agent judgement.
// Shared by the stage-1 spec check and the stage-2 text/font-size exemption
// so the two derivations can never drift apart.
function deriveSystemUiDecision(entry, preference) {
  if (typeof entry?.nodeId !== 'string' || typeof entry?.kind !== 'string') {
    return null;
  }
  const overrides = preference?.userOverrides ?? {};
  const override = overrides[entry.nodeId] ?? overrides[entry.kind];
  if (override !== undefined) {
    return override;
  }
  if (entry.kind === 'status-bar') {
    return preference?.drawStatusBar ? 'implemented-as-design' : 'not-implemented';
  }
  if (entry.kind === 'gesture-bar') {
    return preference?.drawGestureBar ? 'implemented-as-design' : 'not-implemented';
  }
  return null;
}

// systemUi nodes the controller derives as not-implemented are system-drawn,
// so their texts and font sizes are exempt from the stage-2 landing
// requirement. The exemption is recomputed from geometry instead of trusting
// the facts.systemUi entries (agents may append entries): a node qualifies
// only when its rect sits fully inside the avoidance band the capture itself
// declared, mirroring the classifier. An appended entry for an out-of-band
// node fails the recompute and keeps the landing requirement.
function collectSystemUiExemptNodeIds(facts, clarification) {
  const exempt = new Set();
  if (!facts || !Array.isArray(facts.nodes) || !Array.isArray(facts.systemUi)) {
    return exempt;
  }
  const preference = clarification?.systemUiPreference ?? {};
  const statusBarVp = Number(facts.render?.statusBarVp);
  const gestureBarVp = Number(facts.render?.gestureBarVp);
  const canvasHeight = Number(facts.render?.canvas?.logicalHeight);
  const nodeById = new Map(facts.nodes.map((node) => [node?.nodeId, node]));
  for (const entry of facts.systemUi) {
    if (deriveSystemUiDecision(entry, preference) !== 'not-implemented') {
      continue;
    }
    const node = nodeById.get(entry.nodeId);
    const rect = node?.rect ?? {};
    const y = Number(rect.y);
    const h = Number(rect.h);
    if (!Number.isFinite(y) || !Number.isFinite(h)) {
      continue;
    }
    const bottom = y + h;
    const inStatusBar = statusBarVp > 0 && y >= 0 && bottom <= statusBarVp;
    const inGestureBar =
      Number.isFinite(canvasHeight) && gestureBarVp > 0 && y >= canvasHeight - gestureBarVp && bottom <= canvasHeight + 1;
    const text = typeof node?.text === 'string' ? node.text.trim() : '';
    if ((inStatusBar || inGestureBar) && (text.length === 0 || /^\d{1,2}:\d{2}$/.test(text))) {
      exempt.add(entry.nodeId);
    }
  }
  return exempt;
}

function collectOthersHtmlStage1EvidenceIssues(runDir, referenceNowMs, live = false) {
  const issues = [];
  const manifest = readJsonOrNull(join(runDir, OTHERS_HTML_MANIFEST), 'stage 1 inputs manifest', issues);
  if (!manifest) {
    return issues;
  }
  if (manifest.designSource !== 'others-html') {
    issues.push(`stage 1 inputs manifest designSource must be others-html, got ${manifest.designSource}`);
  }
  if (manifest.screenshots !== undefined) {
    issues.push(
      'stage 1 inputs manifest must not declare screenshots for others-html; this source records a referenceSet and layout facts instead'
    );
  }
  if (manifest.layoutFactsPath !== OTHERS_HTML_FACTS) {
    issues.push(`stage 1 inputs manifest layoutFactsPath must be ${OTHERS_HTML_FACTS}`);
  }
  if (manifest.visualSpecPath !== OTHERS_HTML_SPEC) {
    issues.push(`stage 1 inputs manifest visualSpecPath must be ${OTHERS_HTML_SPEC}`);
  }
  // A fabricated clarification timestamp is an integrity problem even when the
  // rest of the document is sound: it claims the pre-check ran at a time the
  // run never ran. The stage-complete required-files list already enforces
  // existence; this only polices the value.
  const clarification = readJsonOrNull(join(runDir, 'requirement-clarification.json'), 'stage 1 requirement clarification', []);
  if (clarification && typeof clarification === 'object' && !Array.isArray(clarification)) {
    collectRoundTimestampIssues(
      clarification.clarificationTimestamp,
      'stage 1 requirement clarification clarificationTimestamp',
      issues,
      referenceNowMs
    );
  }
  const htmlSource = manifest.htmlSource;
  const htmlPath = typeof htmlSource?.path === 'string' ? htmlSource.path.replaceAll('\\', '/') : '';
  const declaredInput = othersHtmlInputRelative(manifest);
  if (!declaredInput) {
    issues.push(
      `stage 1 inputs manifest htmlSource.path must be ${OTHERS_HTML_INPUT} or a nested source/html/<dir>/input.html, got ${htmlPath || '<empty>'}`
    );
  }
  if (!isSha256Hex(htmlSource?.sha256)) {
    issues.push('stage 1 inputs manifest htmlSource.sha256 must be a 64-char lowercase SHA-256');
  } else if (!declaredInput) {
    // the path problem is already reported above
  } else if (!existsSync(join(runDir, ...declaredInput.split('/')))) {
    issues.push(`stage 1 design source is missing: ${declaredInput}`);
  } else if (hashFile(join(runDir, ...declaredInput.split('/'))) !== htmlSource.sha256) {
    issues.push(`stage 1 inputs manifest htmlSource.sha256 does not match ${declaredInput}`);
  }

  const referenceSet = manifest.referenceSet;
  if (!referenceSet || typeof referenceSet !== 'object') {
    issues.push('stage 1 inputs manifest must record referenceSet');
  } else {
    const dir = typeof referenceSet.dir === 'string' ? referenceSet.dir.replaceAll('\\', '/') : '';
    if (dir.length === 0 || isAbsolute(dir) || dir.split('/').includes('..')) {
      issues.push('stage 1 reference set dir must be a relative path inside the run directory');
    }
    const frames = referenceSet.frames;
    if (!Array.isArray(frames) || frames.length === 0) {
      issues.push('stage 1 reference set must list at least one frame');
    } else {
      for (const frame of frames) {
        const framePath = join(runDir, ...`${dir}/${frame}`.split('/'));
        if (!existsSync(framePath)) {
          issues.push(`stage 1 reference frame is missing: ${dir}/${frame}`);
        }
      }
      if (typeof referenceSet.contentFull !== 'string' || referenceSet.contentFull.length === 0) {
        issues.push('stage 1 reference set must record contentFull');
      } else if (!isNonEmptyFile(join(runDir, ...`${dir}/${referenceSet.contentFull}`.split('/')))) {
        issues.push(`stage 1 reference contentFull is missing or empty: ${dir}/${referenceSet.contentFull}`);
      }
      const declaredFrames = referenceSet.content?.frames;
      if (Number(declaredFrames) !== frames.length) {
        issues.push('stage 1 reference set content.frames must equal the number of listed frames');
      }
      const dsf = Number(referenceSet.deviceScaleFactor);
      const canvas = referenceSet.logicalCanvas ?? {};
      const firstFrame = readPngSize(join(runDir, ...`${dir}/${frames[0]}`.split('/')));
      if (!firstFrame) {
        issues.push('stage 1 first reference frame must be a readable PNG');
      } else if (isPositiveBoundedNumber(dsf, 10) && isPositiveBoundedNumber(canvas.width, 10000) && isPositiveBoundedNumber(canvas.height, 20000)) {
        if (
          firstFrame.width !== Math.round(Number(canvas.width) * dsf) ||
          firstFrame.height !== Math.round(Number(canvas.height) * dsf)
        ) {
          issues.push(
            `stage 1 first reference frame must be exactly the design canvas at the declared scale (expected ${Math.round(Number(canvas.width) * dsf)}x${Math.round(Number(canvas.height) * dsf)}, got ${firstFrame.width}x${firstFrame.height})`
          );
        }
      }
    }
  }

  const facts = collectOthersHtmlFactsIssues(runDir, manifest, issues);

  // The freeze record lets a hand-made copy be verified with the same ruler:
  // producer=manual is legal, but it has to say why and carry the audit numbers.
  const freezeSummary = readJsonOrNull(join(runDir, 'stage1', 'source-freeze.json'), 'stage 1 freeze summary', issues);
  if (!freezeSummary || typeof freezeSummary !== 'object' || Array.isArray(freezeSummary)) {
    if (freezeSummary === null) {
      issues.push('stage 1 freeze summary is missing: stage1/source-freeze.json');
    }
  } else {
    if (!['html_source_freeze', 'manual'].includes(freezeSummary.producer)) {
      issues.push('stage 1 freeze summary producer must be html_source_freeze or manual');
    }
    if (freezeSummary.producer === 'manual' && !isNonEmptyBoundedString(freezeSummary.reason, 500)) {
      issues.push('stage 1 manual freeze must record why the script could not be used (reason)');
    }
    const frozenInput = typeof freezeSummary.input === 'string' ? freezeSummary.input.replaceAll('\\', '/') : '';
    const expectedInput = declaredInput ?? OTHERS_HTML_INPUT;
    const expectedPath = join(runDir, ...expectedInput.split('/'));
    if (frozenInput !== expectedInput) {
      issues.push(`stage 1 freeze summary input ${frozenInput || '<empty>'} must match the frozen input (${expectedInput})`);
    } else if (isSha256Hex(freezeSummary.sha256) && existsSync(expectedPath) && hashFile(expectedPath) !== freezeSummary.sha256) {
      issues.push('stage 1 freeze summary sha256 does not match the frozen input');
    }
    const frozenResources = freezeSummary.resources;
    if (!Number.isFinite(frozenResources?.total) || !Number.isFinite(frozenResources?.missing)) {
      issues.push('stage 1 freeze summary resources must record numeric total and missing');
    } else if (frozenResources.total > 0 && frozenResources.missing / frozenResources.total > 0.25) {
      issues.push(
        `stage 1 freeze summary reports ${frozenResources.missing}/${frozenResources.total} unreachable references, above 25%`
      );
    }
  }

  const specPath = join(runDir, ...OTHERS_HTML_SPEC.split('/'));
  if (!existsSync(specPath)) {
    issues.push(`stage 1 visual spec is missing: ${OTHERS_HTML_SPEC}`);
    return issues;
  }
  const spec = readJsonOrNull(specPath, 'stage 1 visual spec', issues);
  if (!spec || typeof spec !== 'object' || Array.isArray(spec)) {
    issues.push('stage 1 visual spec must be an object');
    return issues;
  }
  if (spec.schemaVersion !== 1) {
    issues.push(`stage 1 visual spec schemaVersion must be 1, got ${spec.schemaVersion}`);
  }
  if (spec.designSource !== 'others-html') {
    issues.push(`stage 1 visual spec designSource must be others-html, got ${spec.designSource}`);
  }
  for (const [key, value] of Object.entries(spec)) {
    if (
      !['schemaVersion', 'designSource', 'producer', 'uncertainties'].includes(key) &&
      !OTHERS_HTML_SPEC_KEYS.has(key) &&
      !OTHERS_HTML_OPTIONAL_SPEC_KEYS.has(key)
    ) {
      issues.push(`stage 1 visual spec must not declare unknown section: ${key}`);
    }
    if (['roles', 'systemUi', 'notImplemented', 'unknowns'].includes(key) && !Array.isArray(value)) {
      issues.push(`stage 1 visual spec ${key} must be an array`);
    }
  }
  for (const key of OTHERS_HTML_SPEC_KEYS) {
    if (spec[key] === undefined) {
      issues.push(`stage 1 visual spec must declare ${key}`);
    }
  }
  collectVisualSpecNumericIssues(spec, 'visual-spec', issues);
  const statusBarVp = Number(facts?.render?.statusBarVp);
  const hasStatusBarNode =
    Array.isArray(facts?.systemUi) && facts.systemUi.some((entry) => entry?.kind === 'status-bar');
  if (live && spec.canvasIncludesSystemBar === undefined) {
    issues.push(
      'stage 1 visual spec must declare canvasIncludesSystemBar (whether the design canvas includes the system bar band)'
    );
  }
  if (spec.canvasIncludesSystemBar !== undefined) {
    if (typeof spec.canvasIncludesSystemBar !== 'boolean') {
      issues.push('stage 1 visual spec canvasIncludesSystemBar must be a boolean');
    } else if (Number.isFinite(statusBarVp) && spec.canvasIncludesSystemBar !== (statusBarVp > 0)) {
      issues.push(
        `stage 1 visual spec canvasIncludesSystemBar must equal layout-facts render.statusBarVp > 0 (${statusBarVp > 0})`
      );
    }
  }
  if (hasStatusBarNode && !(statusBarVp > 0)) {
    issues.push('stage 1 layout facts classify a status-bar node but render.statusBarVp is not positive');
  }
  const knownNodeIds = new Set((facts?.nodes ?? []).map((node) => node?.nodeId));
  const referenced = [
    ...(Array.isArray(spec.roles) ? spec.roles.map((entry) => entry?.nodeId) : []),
    ...(Array.isArray(spec.systemUi) ? spec.systemUi.map((entry) => entry?.nodeId) : []),
    ...(Array.isArray(spec.notImplemented)
      ? spec.notImplemented.flatMap((entry) => (Array.isArray(entry?.nodeIds) ? entry.nodeIds : []))
      : [])
  ];
  for (const nodeId of referenced) {
    if (typeof nodeId !== 'string' || !knownNodeIds.has(nodeId)) {
      issues.push(`stage 1 visual spec references unknown nodeId: ${String(nodeId)}`);
    }
  }
  // The routine systemUi decisions are not a judgement call: the facts kind
  // plus the user's systemUiPreference decide them. Deriving the expectation
  // here closes the self-attestation loop where the agent both declares what
  // it will skip and gets graded on its own declaration. Only nodes the script
  // could not classify (no facts.systemUi entry, or an unknown kind) fall back
  // to agent judgement.
  if (facts && Array.isArray(facts.systemUi) && Array.isArray(spec.systemUi)) {
    const preference = clarification?.systemUiPreference ?? {};
    const declared = new Map(spec.systemUi.map((entry) => [entry?.nodeId, entry]));
    for (const entry of facts.systemUi) {
      const expected = deriveSystemUiDecision(entry, preference);
      if (expected === null) {
        continue;
      }
      const recorded = declared.get(entry.nodeId);
      if (!recorded) {
        issues.push(`stage 1 visual spec systemUi must record a decision for ${entry.nodeId} (${entry.kind})`);
      } else if (recorded.decision !== expected) {
        issues.push(
          `stage 1 visual spec systemUi decision for ${entry.nodeId} must be ${expected} (derived from facts kind ${entry.kind} and systemUiPreference), got ${String(recorded.decision)}`
        );
      }
    }
  }
  return issues;
}

function readTextOrNull(path) {
  if (!existsSync(path) || !statSync(path).isFile()) {
    return null;
  }
  return readFileSync(path, 'utf8');
}

// Generated ArkTS pages put user visible text in string.json instead of inline
// literals, so a measured text is "implemented" when it appears either in the
// page source or in any element/string.json value of the target module.
function collectStringResourceValues(projectRoot, moduleName) {
  const values = [];
  const resourcesDir = resolve(projectRoot, moduleName, 'src', 'main', 'resources');
  if (!existsSync(resourcesDir)) {
    return values;
  }
  for (const locale of readdirSync(resourcesDir)) {
    const stringFile = resolve(resourcesDir, locale, 'element', 'string.json');
    if (!existsSync(stringFile)) {
      continue;
    }
    const parsed = readJsonOrNull(stringFile, `string resources ${locale}`, []);
    const entries = Array.isArray(parsed?.string) ? parsed.string : [];
    for (const entry of entries) {
      if (typeof entry?.value === 'string' && entry.value.length > 0) {
        values.push(entry.value);
      }
    }
  }
  return values;
}
// Whole-value text landing: a substring of a longer resource is not a landing
// ("OK" inside "BOOKING" must not satisfy the "OK" node), so texts land through
// exact resource equality, standalone quoted page literals, or declared
// dynamic templates for concatenated values that have no single resource.
function templateMatches(pattern, text) {
  const source = '^' + pattern.split('*').map((part) => escapeRegExp(part)).join('.*') + '$';
  return new RegExp(source).test(text);
}

function collectDeclaredTextTemplates(uiManifest, issues) {
  const declared = uiManifest?.textLandingDeclarations;
  if (declared === undefined || declared === null) {
    return [];
  }
  if (!Array.isArray(declared)) {
    issues.push('stage 2 generated ui manifest textLandingDeclarations must be an array of {pattern, basis}');
    return [];
  }
  if (declared.length > 5) {
    issues.push('stage 2 generated ui manifest textLandingDeclarations is capped at 5 entries');
  }
  const patterns = [];
  for (const [index, entry] of declared.entries()) {
    const pattern = typeof entry?.pattern === 'string' ? entry.pattern : null;
    if (pattern === null || pattern.trim().length === 0 || typeof entry?.basis !== 'string' || entry.basis.trim().length === 0) {
      issues.push(`stage 2 generated ui manifest textLandingDeclarations[${index}] must carry a pattern and a non-empty basis`);
      continue;
    }
    if (pattern.replaceAll('*', '').trim().length < 2) {
      issues.push(`stage 2 generated ui manifest textLandingDeclarations[${index}].pattern must keep at least 2 literal characters so it cannot match everything`);
      continue;
    }
    patterns.push(pattern);
  }
  return patterns;
}
// Confirm-time check for the HTML source: the facts are about to be frozen, so
// they must still describe the same input file that stage 1 captured.
function collectOthersHtmlConfirmRequestIssues(runDir) {
  const issues = [];
  const facts = readJsonOrNull(join(runDir, ...OTHERS_HTML_FACTS.split('/')), 'stage 1 layout facts', issues);
  if (!facts) {
    return issues;
  }
  const manifest = readJsonOrNull(join(runDir, OTHERS_HTML_MANIFEST), 'stage 1 inputs manifest', []);
  const declaredInput = othersHtmlInputRelative(manifest) ?? OTHERS_HTML_INPUT;
  const inputPath = join(runDir, ...declaredInput.split('/'));
  if (!isSha256Hex(facts.source?.sha256)) {
    issues.push('stage 2 layout facts source.sha256 must be a 64-char lowercase SHA-256');
  } else if (!existsSync(inputPath)) {
    issues.push(`stage 2 design source is missing: ${declaredInput}`);
  } else if (hashFile(inputPath) !== facts.source.sha256) {
    issues.push(`stage 2 layout facts no longer match ${declaredInput}; re-run stage 1 evidence before confirming`);
  }
  return issues;
}
function collectOthersHtmlStage2EvidenceIssues(runDir, referenceNowMs) {
  const issues = [];
  const uiManifest = readJsonOrNull(join(runDir, ...OTHERS_HTML_UI_MANIFEST.split('/')), 'stage 2 generated ui manifest', issues);
  if (!uiManifest) {
    return issues;
  }
  // The review's own timestamp is the same fabrication surface as the ledger:
  // validate it whenever the document is present.
  const review = readJsonOrNull(join(runDir, 'stage2', 'visual-spec-review.json'), 'stage 2 visual spec review', []);
  if (review && typeof review === 'object' && !Array.isArray(review)) {
    collectRoundTimestampIssues(review.reviewedAt, 'stage 2 visual spec review reviewedAt', issues, referenceNowMs);
  }
  // The confirmation index carries its own acceptedAt; validate the value when
  // the file is present without making the file itself mandatory here.
  const confirmationPath = join(runDir, 'stage2', 'component-confirmation.json');
  if (existsSync(confirmationPath)) {
    const confirmation = readJsonOrNull(confirmationPath, 'stage 2 component confirmation', issues);
    if (confirmation && typeof confirmation === 'object' && !Array.isArray(confirmation)) {
      collectRoundTimestampIssues(
        confirmation.acceptedAt,
        'stage 2 component confirmation acceptedAt',
        issues,
        referenceNowMs
      );
      // The acceptance happens at the confirm call; the index file is written
      // around it. A manual confirmation may trail the snapshot by minutes
      // (a human reading the component tree), so only the "before" side is
      // bounded here — the "after" side is the file-time window's job.
      const state = readJsonOrNull(join(runDir, 'workflow-state.json'), 'workflow-state', []);
      const snapshotTime = Date.parse(state?.confirmationSnapshots?.['2']?.createdAt);
      const acceptedTime = Date.parse(confirmation.acceptedAt);
      if (Number.isFinite(snapshotTime) && Number.isFinite(acceptedTime) && acceptedTime < snapshotTime - TIMESTAMP_CAUSALITY_TOLERANCE_MS) {
        issues.push(
          'stage 2 component confirmation acceptedAt cannot predate the controller confirmation snapshot (the acceptance happens at the confirm call, not before)'
        );
      }
    }
  }
  const facts = readJsonOrNull(join(runDir, ...OTHERS_HTML_FACTS.split('/')), 'stage 1 layout facts', []);
  const clarification = readJsonOrNull(join(runDir, 'requirement-clarification.json'), 'requirement clarification', issues);
  const page = uiManifest.page ?? {};
  if (typeof page.file !== 'string' || page.file.length === 0) {
    issues.push('stage 2 generated ui manifest page.file must be a non-empty path');
  }
  if (typeof page.component !== 'string' || page.component.length === 0) {
    issues.push('stage 2 generated ui manifest page.component must be a non-empty name');
  }
  if (page.hasEntry !== false) {
    issues.push('stage 2 generated ui manifest page.hasEntry must be false for others-html');
  }
  const registration = uiManifest.registration ?? {};
  if (!OTHERS_HTML_REGISTRATION_MODES.has(registration.mode)) {
    issues.push(
      `stage 2 generated ui manifest registration.mode must be one of ${[...OTHERS_HTML_REGISTRATION_MODES].join(', ')}`
    );
  }
  if (typeof registration.route !== 'string' || registration.route.trim().length === 0) {
    issues.push('stage 2 generated ui manifest registration.route must be a non-empty name');
  }
  // The run index stores the registration location. Without it the index write
  // is skipped silently and the run blocks in the summary stage, where the
  // record can no longer be backfilled.
  if (typeof registration.file !== 'string' || registration.file.trim().length === 0) {
    issues.push('stage 2 generated ui manifest registration.file must be a non-empty string');
  }
  if (registration.default !== false) {
    issues.push('stage 2 must not make the generated page the default page for others-html');
  }
  if (registration.component !== page.component) {
    issues.push('stage 2 generated ui manifest registration.component must equal page.component');
  }
  const startup = uiManifest.startup ?? {};
  if (startup.entryAbilityPage !== 'pages/Index') {
    issues.push('stage 2 generated ui manifest startup.entryAbilityPage must stay pages/Index');
  }
  if (startup.mainPagesContainsIndex !== true) {
    issues.push('stage 2 generated ui manifest startup.mainPagesContainsIndex must be true');
  }
  if (!OTHERS_HTML_REACHABILITY.has(uiManifest.reachability)) {
    issues.push(
      `stage 2 generated ui manifest reachability must be one of ${[...OTHERS_HTML_REACHABILITY].join(', ')}`
    );
  }
  if (existsSync(join(runDir, 'source', 'html', 'page.jsx'))) {
    issues.push('stage 2 must not produce source/html/page.jsx; the HTML source is translated from layout facts');
  }

  const manifest = readJsonOrNull(join(runDir, OTHERS_HTML_MANIFEST), 'stage 1 inputs manifest', []);
  const rootPath = manifest?.integrationSnapshot?.projectRootPath;
  const projectRoot =
    typeof rootPath === 'string' && rootPath.length > 0
      ? isAbsolute(rootPath)
        ? rootPath
        : resolve(runDir, rootPath)
      : null;
  if (projectRoot && typeof page.file === 'string' && page.file.length > 0) {
    const pageAbs = resolve(projectRoot, page.file);
    const pageText = readTextOrNull(pageAbs);
    if (pageText === null) {
      issues.push(`stage 2 page file is missing: ${page.file}`);
    } else {
      if (!pageText.includes('export struct')) {
        issues.push(`stage 2 page file must export a struct: ${page.file}`);
      }
      if (typeof page.component === 'string' && pageText.length > 0 && !pageText.includes(page.component)) {
        issues.push(`stage 2 page file must declare the component ${page.component}`);
      }
      if (hasArkTsDecorator(pageText, 'Entry')) {
        issues.push(`stage 2 page file must not declare @Entry: ${page.file}`);
      }
      const indexFile = manifest?.integrationSnapshot?.indexPageFile;
      const indexText = typeof indexFile === 'string' ? readTextOrNull(resolve(projectRoot, indexFile)) : null;
      if (indexText === null) {
        issues.push('stage 2 index page file from the integration snapshot is missing');
      } else {
        // Count real decorators only; a comment that mentions @Entry must not
        // turn a valid single-entry index page into a false duplicate.
        const entryCount = (stripArkTsComments(indexText).match(/^\s*@Entry\b/gm) ?? []).length;
        if (entryCount !== 1) {
          issues.push(`stage 2 Index page must keep exactly one @Entry, found ${entryCount}`);
        }
      }
      const routerMapDeclared = manifest?.integrationSnapshot?.routerMapDeclared === true;
      const builderUsed =
        /\.navDestination\s*\(/.test(pageText) || (indexText !== null && /\.navDestination\s*\(/.test(indexText));
      if (routerMapDeclared && builderUsed) {
        issues.push('stage 2 must not mix a routerMap declaration with .navDestination(builder); pick one registration style');
      }
      if (registration.mode === 'index-navigation' && !builderUsed) {
        issues.push('stage 2 registration.mode is index-navigation but no .navDestination(builder) was found');
      }
      if (registration.mode === 'route-table' && !routerMapDeclared) {
        issues.push('stage 2 registration.mode is route-table but the module does not declare a routerMap');
      }
      const mainPagesFile = manifest?.integrationSnapshot?.mainPagesFile;
      const mainPages = typeof mainPagesFile === 'string' ? readTextOrNull(resolve(projectRoot, mainPagesFile)) : null;
      if (mainPages !== null && !mainPages.includes('pages/Index')) {
        issues.push('stage 2 must keep pages/Index registered in main_pages.json');
      }
      if (Array.isArray(facts?.nodes)) {
        const moduleName = typeof page.file === 'string' && page.file.includes('/') ? page.file.split('/')[0] : 'entry';
        const resourceValues = collectStringResourceValues(projectRoot, moduleName);
        const resourceSet = new Set(resourceValues.map((value) => value.trim()));
        const declaredTemplates = collectDeclaredTextTemplates(uiManifest, issues);
        // systemUi nodes the controller itself derives as not-implemented are
        // system-drawn; exempt them so the design status-bar clock no longer
        // has to be registered as dead resources just to satisfy this check.
        const exemptNodeIds = collectSystemUiExemptNodeIds(facts, clarification);
        const texts = [
          ...new Set(
            facts.nodes
              .filter((node) => !exemptNodeIds.has(node?.nodeId))
              .map((node) => (typeof node?.text === 'string' ? node.text.trim() : ''))
              .filter((text) => text.length > 0)
          )
        ];
        const missingTexts = texts.filter(
          (text) =>
            !resourceSet.has(text) &&
            !new RegExp(`(['"])${escapeRegExp(text)}\\1`).test(pageText) &&
            !declaredTemplates.some((pattern) => templateMatches(pattern, text))
        );
        if (missingTexts.length > 0) {
          issues.push(
            `stage 2 page is missing ${missingTexts.length} text node(s) recorded in layout facts (whole-value landing: exact string resource, quoted page literal, or declared dynamic template), e.g. ${missingTexts.slice(0, 3).join(' / ')}`
          );
        }
        const fontSizes = [
          ...new Set(
            facts.nodes
              .filter((node) => !exemptNodeIds.has(node?.nodeId))
              .map((node) => node?.style?.fontSizePx)
              .filter((size) => Number.isFinite(size) && size > 0)
              .map((size) => Math.round(Number(size)))
          )
        ];
        const inlineSizes = [...pageText.matchAll(/\.fontSize\(\s*([0-9]+(?:\.[0-9]+)?)\s*\)/g)].map((match) =>
          Math.round(Number(match[1]))
        );
        // A named constant is just as faithful as an inline literal, so accept
        // `const PDV_TITLE_SIZE: number = 26` style declarations too.
        const namedSizes = [
          ...pageText.matchAll(/\b(?:const|let)\s+\w*(?:SIZE|Size)\w*\s*(?::\s*number\s*)?=\s*([0-9]+(?:\.[0-9]+)?)/g)
        ].map((match) => Math.round(Number(match[1])));
        const declared = [...inlineSizes, ...namedSizes];
        const missingSizes = fontSizes.filter((size) => !declared.some((value) => Math.abs(value - size) <= 1));
        if (missingSizes.length > 0) {
          issues.push(
            `stage 2 page must implement the measured font sizes from layout facts; missing ${missingSizes.join(', ')}`
          );
        }
      }
    }
  }

  const buildPath = join(runDir, 'stage2', 'initial-build-report.json');
  if (!existsSync(buildPath)) {
    issues.push('stage 2 initial build report is missing: stage2/initial-build-report.json');
  } else {
    const build = readJsonOrNull(buildPath, 'stage 2 initial build report', issues);
    if (build) {
      if (build.success !== true) {
        issues.push('stage 2 initial build report must set success to true');
      }
      if (typeof build.command !== 'string' || build.command.trim().length === 0) {
        issues.push('stage 2 initial build report must record the command that was executed');
      }
      if (Number(build.exitCode) !== 0) {
        issues.push('stage 2 initial build report must record exitCode 0');
      }
      if (typeof build.completedAt !== 'string' || !Number.isFinite(Date.parse(build.completedAt))) {
        issues.push('stage 2 initial build report must record a parseable completedAt');
      } else {
        collectRoundTimestampIssues(build.completedAt, 'stage 2 initial build report completedAt', issues, referenceNowMs);
      }
    }
  }
  return issues;
}

function collectOthersHtmlStage4QualityIssues(runDir) {
  const issues = [];
  const clarification = readJsonOrNull(join(runDir, 'requirement-clarification.json'), 'requirement clarification', []);
  const hdsPath = join(runDir, 'hds-decision.json');
  if (!existsSync(hdsPath)) {
    issues.push('stage 4 hds decision is missing: hds-decision.json');
  } else {
    const hds = readJsonOrNull(hdsPath, 'stage 4 hds decision', issues);
    if (hds) {
      if (typeof hds.hdsRequired !== 'boolean') {
        issues.push('stage 4 hds decision hdsRequired must be a boolean');
      } else if (clarification?.hdsUsagePreference === 'do-not-use-hds' && hds.hdsRequired !== false) {
        issues.push('stage 4 hds decision hdsRequired must be false because the user asked for no HDS');
      }
    }
  }
  const auditPath = join(runDir, ...OTHERS_HTML_QUALITY_AUDIT.split('/'));
  if (!existsSync(auditPath)) {
    issues.push(`stage 4 quality audit is missing: ${OTHERS_HTML_QUALITY_AUDIT}`);
    return issues;
  }
  const audit = readJsonOrNull(auditPath, 'stage 4 quality audit', issues);
  if (!audit || typeof audit !== 'object' || Array.isArray(audit)) {
    issues.push('stage 4 quality audit must be an object');
    return issues;
  }
  for (const field of ['criticalIssues', 'majorIssues']) {
    if (!Array.isArray(audit[field])) {
      issues.push(`stage 4 quality audit ${field} must be an array`);
    } else if (audit[field].length > 0) {
      issues.push(`stage 4 quality audit ${field} must be empty before the stage can pass`);
    }
  }
  const audits = audit.audits ?? {};
  for (const key of OTHERS_HTML_AUDIT_KEYS) {
    const entry = audits[key];
    if (!entry || typeof entry !== 'object') {
      issues.push(`stage 4 quality audit must record the ${key} audit`);
    } else if (entry.pass !== true) {
      issues.push(`stage 4 quality audit ${key} audit must pass`);
    }
  }
  if (Number(audit.buildResult?.exitCode) !== 0) {
    issues.push('stage 4 quality audit buildResult.exitCode must be 0');
  }
  if (typeof audit.buildResult?.command !== 'string' || audit.buildResult.command.trim().length === 0) {
    issues.push('stage 4 quality audit buildResult.command must record the executed command');
  }
  if (!isNonEmptyFile(join(runDir, 'stage4', 'build-report.md'))) {
    issues.push('stage 4 build report is missing or empty: stage4/build-report.md');
  }
  return issues;
}

function collectVisualSpecEvidenceIssues(runDir, designSource) {
  const issues = [];
  const rel = 'stage1/visual-spec.json';
  const spec = readJsonOrNull(join(runDir, rel), 'stage 1 visual spec', issues);
  if (spec === null) {
    if (issues.length === 0) issues.push('stage 1 visual spec must be an object');
    return issues;
  }
  if (typeof spec !== 'object' || Array.isArray(spec)) {
    issues.push('stage 1 visual spec must be an object');
    return issues;
  }
  if (spec.schemaVersion !== 1) {
    issues.push(`stage 1 visual spec schemaVersion must be 1, got ${spec.schemaVersion}`);
  }
  if (spec.designSource !== designSource) {
    issues.push(`stage 1 visual spec designSource must be ${designSource}, got ${spec.designSource}`);
  }
  const background = spec.background;
  const backgroundKinds = ['solid', 'gradient', 'image', 'unknown'];
  if (!background || typeof background !== 'object' || Array.isArray(background)) {
    issues.push('stage 1 visual spec background must be an object');
  } else {
    if (!backgroundKinds.includes(background.kind)) {
      issues.push(`stage 1 visual spec background.kind must be one of ${backgroundKinds.join(', ')}`);
    }
    if (background.kind !== 'unknown' && (typeof background.value !== 'string' || background.value.trim().length === 0)) {
      issues.push('stage 1 visual spec background.value must be a non-empty string when background.kind is not unknown');
    }
  }
  issues.push(...collectVisualSpecEntries(spec.palette, 'palette'));
  issues.push(...collectVisualSpecEntries(spec.typography, 'typography'));
  if (!Array.isArray(spec.uncertainties) || spec.uncertainties.some((item) => typeof item !== 'string')) {
    issues.push('stage 1 visual spec uncertainties must be an array of strings');
  }
  return issues;
}

function collectVisualSpecEntries(entries, label) {
  if (!Array.isArray(entries) || entries.length === 0) {
    return [`stage 1 visual spec ${label} must be a non-empty array`];
  }
  const issues = [];
  for (const [index, entry] of entries.entries()) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      issues.push(`stage 1 visual spec ${label}[${index}] must be an object`);
      continue;
    }
    if (typeof entry.role !== 'string' || entry.role.trim().length === 0) {
      issues.push(`stage 1 visual spec ${label}[${index}].role must be a non-empty string`);
    }
    if (typeof entry.evidence !== 'string' || entry.evidence.trim().length === 0) {
      issues.push(`stage 1 visual spec ${label}[${index}].evidence must cite the observation or CSS rule it came from`);
    }
    if (typeof entry.color !== 'string' || (entry.color !== 'unknown' && !/^#[0-9a-fA-F]{6}$/.test(entry.color))) {
      issues.push(`stage 1 visual spec ${label}[${index}].color must be a #RRGGBB value or unknown`);
    }
    if (label === 'typography' && entry.sizePx !== 'unknown' && !(Number.isFinite(entry.sizePx) && entry.sizePx > 0)) {
      issues.push(`stage 1 visual spec typography[${index}].sizePx must be a positive number or unknown`);
    }
  }
  return issues;
}

// ---------------------------------------------------------------------------
// others-visual evidence
//
// The screenshot path is the only source whose visual facts cannot be read from
// text (no DSL, no JSX, no CSS). Its stage 1 therefore has two independent
// producers: `recognize_ui_components` (what is here) and `visual_probe`
// (the exact numbers). Both are validated here - previously neither was, which
// let a degraded recognition artifact and an invented gradient through.
// ---------------------------------------------------------------------------

const OTHERS_VISUAL_SCREENSHOT = 'source/visual/screenshot.png';
const OTHERS_VISUAL_RECOGNITION = 'stage1/component-vision-analysis.json';
const OTHERS_VISUAL_PROBE = 'stage1/visual-probe.json';
const OTHERS_VISUAL_VISUAL_SPEC = 'stage1/visual-spec.json';
const PROBE_SAMPLE_BUDGET_MAX = 20_000_000;
/** M1 (main-model vision) may look at the screenshot at most this many times. */
const MAX_MAIN_MODEL_VISION_READS = 3;
const MAX_PROBE_BANDS = 12;

function collectOthersVisualStage1EvidenceIssues(runDir) {
  const issues = [];
  const manifest = readJsonOrNull(join(runDir, 'inputs-manifest.json'), 'stage 1 inputs manifest', issues);
  if (!manifest) {
    return issues;
  }
  if (manifest.designSource !== 'others-visual') {
    issues.push(`stage 1 inputs manifest designSource must be others-visual, got ${manifest.designSource}`);
  }

  const screenshotSha = collectOthersVisualScreenshotIssues(runDir, manifest, issues);
  collectOthersVisualProbeIssues(runDir, manifest, screenshotSha, issues);
  collectOthersVisualRecognitionIssues(runDir, manifest, screenshotSha, issues);
  issues.push(...collectVisualSpecProbeConsistencyIssues(runDir));
  return issues;
}

function collectOthersVisualScreenshotIssues(runDir, manifest, issues) {
  const entry = manifest.screenshot;
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
    issues.push('stage 1 inputs manifest must record screenshot details');
    return null;
  }

  const normalized = typeof entry.path === 'string' ? entry.path.replaceAll('\\', '/') : '';
  if (
    normalized.length === 0 ||
    isAbsolute(normalized) ||
    normalized.split('/').includes('..') ||
    normalized !== OTHERS_VISUAL_SCREENSHOT
  ) {
    issues.push(`stage 1 screenshot path must be ${OTHERS_VISUAL_SCREENSHOT}`);
  }
  if (
    !isPositiveBoundedNumber(entry.width, 100000) ||
    !isPositiveBoundedNumber(entry.height, 100000) ||
    typeof entry.size !== 'number' ||
    !Number.isFinite(entry.size) ||
    entry.size <= 0
  ) {
    issues.push('stage 1 screenshot dimensions and size must be positive numbers');
  }

  const canvas = manifest.canvas;
  if (!canvas || typeof canvas !== 'object') {
    issues.push('stage 1 inputs manifest must record the inferred canvas');
  } else {
    if (
      !isPositiveBoundedNumber(canvas.logicalWidth, 4000) ||
      !isPositiveBoundedNumber(canvas.logicalHeight, 8000) ||
      !isPositiveBoundedNumber(canvas.scale, 20)
    ) {
      issues.push('stage 1 inputs manifest canvas must record logicalWidth, logicalHeight and scale as positive numbers');
    } else if (isPositiveBoundedNumber(entry.width, 100000)) {
      const derivedScale = entry.width / canvas.logicalWidth;
      if (Math.abs(derivedScale - canvas.scale) > 0.05) {
        issues.push(
          `stage 1 inputs manifest canvas.scale (${canvas.scale}) must equal physicalWidth/logicalWidth (${derivedScale.toFixed(3)})`
        );
      }
      if (Math.abs(canvas.logicalHeight - entry.height / canvas.scale) > 2) {
        issues.push('stage 1 inputs manifest canvas.logicalHeight must equal physicalHeight/scale');
      }
    }
  }

  if (manifest.visualSpecPath !== OTHERS_VISUAL_VISUAL_SPEC) {
    issues.push(`stage 1 inputs manifest visualSpecPath must be ${OTHERS_VISUAL_VISUAL_SPEC}`);
  }
  if (manifest.visualProbePath !== OTHERS_VISUAL_PROBE) {
    issues.push(`stage 1 inputs manifest visualProbePath must be ${OTHERS_VISUAL_PROBE}`);
  }

  if (typeof entry.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(entry.sha256)) {
    issues.push('stage 1 screenshot sha256 is invalid');
    return null;
  }
  const filePath = join(runDir, ...OTHERS_VISUAL_SCREENSHOT.split('/'));
  if (!existsSync(filePath) || !statSync(filePath).isFile()) {
    issues.push(`stage 1 screenshot file is missing: ${OTHERS_VISUAL_SCREENSHOT}`);
    return entry.sha256;
  }
  if (statSync(filePath).size !== entry.size) {
    issues.push('stage 1 screenshot size does not match the current file');
  }
  if (hashFile(filePath) !== entry.sha256) {
    issues.push('stage 1 screenshot sha256 does not match the current file');
  }
  return entry.sha256;
}

// The probe is the deterministic half of stage 1 evidence. Its own report is
// checked against the screenshot so a hand-written probe cannot be substituted,
// and its bands must be an exhaustive partition (a partial one produced the
// 0.81-sum bands that broke stage 2 vertical layout).
function collectOthersVisualProbeIssues(runDir, manifest, screenshotSha, issues) {
  const probe = readJsonOrNull(join(runDir, ...OTHERS_VISUAL_PROBE.split('/')), 'stage 1 visual probe', issues);
  if (!probe) {
    return;
  }
  if (probe.schemaVersion !== 1) {
    issues.push(`stage 1 visual probe schemaVersion must be 1, got ${probe.schemaVersion}`);
  }
  if (probe.producer?.tool !== 'visual_probe' || typeof probe.producer?.version !== 'string' || probe.producer.version.length === 0) {
    issues.push('stage 1 visual probe must be produced by visual_probe (producer.tool/producer.version are invalid)');
  }
  if (probe.source?.path !== OTHERS_VISUAL_SCREENSHOT) {
    issues.push(`stage 1 visual probe source.path must be ${OTHERS_VISUAL_SCREENSHOT}`);
  }
  if (typeof screenshotSha === 'string' && probe.source?.sha256 !== screenshotSha) {
    issues.push('stage 1 visual probe source.sha256 must match the screenshot recorded in inputs-manifest.json');
  }
  if (
    !isPositiveBoundedNumber(probe.canvas?.physicalWidth, 100000) ||
    !isPositiveBoundedNumber(probe.canvas?.physicalHeight, 100000)
  ) {
    issues.push('stage 1 visual probe canvas physical size is invalid');
  } else if (
    isPositiveBoundedNumber(manifest?.screenshot?.width, 100000) &&
    (probe.canvas.physicalWidth !== manifest.screenshot.width ||
      probe.canvas.physicalHeight !== manifest.screenshot.height)
  ) {
    issues.push('stage 1 visual probe canvas must match the screenshot dimensions in inputs-manifest.json');
  }
  if (
    isPositiveBoundedNumber(probe.canvas?.scale, 20) &&
    isPositiveBoundedNumber(manifest?.canvas?.scale, 20) &&
    Math.abs(probe.canvas.scale - manifest.canvas.scale) > 0.05
  ) {
    issues.push('stage 1 visual probe canvas.scale must match inputs-manifest.json canvas.scale');
  }

  // Budget guard: a probe that ignored its fixed budget is not a probe any more.
  if (probe.budget?.withinBudget !== true) {
    issues.push('stage 1 visual probe must report budget.withinBudget=true');
  }
  if (!isPositiveBoundedNumber(probe.budget?.totalSamples, PROBE_SAMPLE_BUDGET_MAX)) {
    issues.push(`stage 1 visual probe budget.totalSamples must be a positive number below ${PROBE_SAMPLE_BUDGET_MAX}`);
  }
  if (probe.budget?.passes !== 1) {
    issues.push('stage 1 visual probe budget.passes must be 1 (single-pass measurement only)');
  }

  const background = probe.background;
  const kinds = ['solid', 'gradient', 'image', 'unknown'];
  if (!background || typeof background !== 'object' || !kinds.includes(background.kind)) {
    issues.push(`stage 1 visual probe background.kind must be one of ${kinds.join(', ')}`);
  } else if (background.kind === 'gradient') {
    const stops = background.stops;
    if (!Array.isArray(stops) || stops.length < 2 || stops.length > 12) {
      issues.push('stage 1 visual probe gradient background must record between 2 and 12 stops');
    } else {
      let previous = -1;
      for (const [index, stop] of stops.entries()) {
        if (!isPositiveBoundedNumber(stop?.position + Number.EPSILON, 1.0001) && stop?.position !== 0) {
          issues.push(`stage 1 visual probe background.stops[${index}].position must be within [0,1]`);
        } else if (stop.position < previous) {
          issues.push('stage 1 visual probe background stops must be ordered by position');
        }
        previous = typeof stop?.position === 'number' ? stop.position : previous;
        if (typeof stop?.color !== 'string' || !/^#[0-9A-F]{6}$/.test(stop.color)) {
          issues.push(`stage 1 visual probe background.stops[${index}].color must be #RRGGBB`);
        }
      }
    }
  }

  const bands = probe.bands;
  if (!Array.isArray(bands) || bands.length === 0 || bands.length > MAX_PROBE_BANDS) {
    issues.push(`stage 1 visual probe bands must be a non-empty array of at most ${MAX_PROBE_BANDS} entries`);
    return;
  }
  if (bands[0]?.y0 !== 0) {
    issues.push('stage 1 visual probe bands must start at y0=0');
  }
  let total = 0;
  for (const [index, band] of bands.entries()) {
    if (!Number.isFinite(band?.y0) || !Number.isFinite(band?.y1) || band.y1 <= band.y0) {
      issues.push(`stage 1 visual probe bands[${index}] must satisfy y0 < y1`);
    }
    if (!isPositiveBoundedNumber(band?.heightRatio, 1)) {
      issues.push(`stage 1 visual probe bands[${index}].heightRatio must be a positive number`);
    } else {
      total += band.heightRatio;
    }
  }
  if (Math.abs(total - 1) > 0.05) {
    issues.push(
      `stage 1 visual probe bands heightRatio must sum to 1.0 (+/-0.05), got ${total.toFixed(3)}; the probe must partition the full canvas instead of leaving an unidentified remainder`
    );
  }
}

// The probe measures, the spec must then *say the same thing*. Until this check
// existed, the contract demanded "values come from the probe" while nothing
// enforced it: a spec could measure a six-stop gradient and still write a
// hand-made one (that is exactly how an invented `#1D2623 -> #2E3A36` gradient
// reached the confirmation snapshot in the book-home run).
function collectVisualSpecProbeConsistencyIssues(runDir) {
  const issues = [];
  const spec = readJsonOrNull(join(runDir, ...OTHERS_VISUAL_VISUAL_SPEC.split('/')), 'stage 1 visual spec', issues);
  const probe = readJsonOrNull(join(runDir, ...OTHERS_VISUAL_PROBE.split('/')), 'stage 1 visual probe', issues);
  if (!spec || !probe) {
    return issues;
  }

  collectSpecCanvasIssues(spec, probe, issues);
  collectSpecBackgroundIssues(spec, probe, issues);
  collectSpecBandsIssues(spec, probe, issues);
  collectSpecTypographyIssues(spec, probe, issues);
  return issues;
}

function collectSpecCanvasIssues(spec, probe, issues) {
  const specCanvas = spec.canvas;
  if (!specCanvas || typeof specCanvas !== 'object') {
    issues.push('stage 1 visual spec must record canvas so it can be reconciled with visual-probe.json');
    return;
  }
  for (const key of ['logicalWidth', 'logicalHeight']) {
    if (Number(specCanvas[key]) !== Number(probe.canvas?.[key])) {
      issues.push(
        `stage 1 visual spec canvas.${key} must match visual-probe.json (${probe.canvas?.[key]}), got ${specCanvas[key]}`
      );
    }
  }
  if (
    isPositiveBoundedNumber(probe.canvas?.scale, 20) &&
    (!Number.isFinite(Number(specCanvas.scale)) || Math.abs(Number(specCanvas.scale) - probe.canvas.scale) > 0.05)
  ) {
    issues.push(`stage 1 visual spec canvas.scale must match visual-probe.json (${probe.canvas.scale})`);
  }
}

function collectSpecBackgroundIssues(spec, probe, issues) {
  const measured = probe.background;
  if (!measured || typeof measured !== 'object') {
    return;
  }
  const specBackground = spec.background;
  if (measured.kind === 'gradient') {
    if (specBackground?.kind !== 'gradient') {
      issues.push(
        'stage 1 visual spec background.kind must be gradient because visual-probe.json measured a gradient; recording it as unknown or solid contradicts the measurement'
      );
      return;
    }
    const text = String(specBackground.value ?? '').toUpperCase();
    const missing = (measured.stops ?? [])
      .map((stop) => String(stop.color ?? '').toUpperCase())
      .filter((color) => color.length > 0 && !text.includes(color));
    if (missing.length > 0) {
      issues.push(
        `stage 1 visual spec background.value must contain every measured stop colour from visual-probe.json (missing ${missing.join(', ')})`
      );
    }
    return;
  }
  if (measured.kind === 'solid') {
    if (specBackground?.kind !== 'solid') {
      issues.push('stage 1 visual spec background.kind must be solid because visual-probe.json measured a solid background');
      return;
    }
    const expected = String(measured.stops?.[0]?.color ?? '').toUpperCase();
    if (expected.length > 0 && !String(specBackground.value ?? '').toUpperCase().includes(expected)) {
      issues.push(`stage 1 visual spec background.value must contain the measured colour ${expected}`);
    }
  }
}

function collectSpecBandsIssues(spec, probe, issues) {
  const specBands = Array.isArray(spec.bands) ? spec.bands : [];
  const probeBands = Array.isArray(probe.bands) ? probe.bands : [];
  if (probeBands.length === 0) {
    return;
  }
  if (specBands.length !== probeBands.length) {
    issues.push(
      `stage 1 visual spec bands must list the ${probeBands.length} measured bands from visual-probe.json, got ${specBands.length}; do not merge, split or add a remainder band`
    );
    return;
  }
  for (const [index, probeBand] of probeBands.entries()) {
    const specRatio = Number(specBands[index]?.heightRatio);
    const probeRatio = Number(probeBand.heightRatio);
    if (!Number.isFinite(specRatio) || Math.abs(specRatio - probeRatio) > 0.02) {
      issues.push(
        `stage 1 visual spec bands[${index}].heightRatio must match visual-probe.json (${probeRatio}), got ${specBands[index]?.heightRatio}`
      );
    }
  }
}

function collectSpecTypographyIssues(spec, probe, issues) {
  const measured = (Array.isArray(probe.textRows) ? probe.textRows : [])
    .map((row) => Number(row.logicalHeightPx))
    .filter((value) => Number.isFinite(value) && value > 0);
  if (measured.length === 0) {
    return;
  }
  for (const [index, entry] of (Array.isArray(spec.typography) ? spec.typography : []).entries()) {
    if (entry?.sizePx === 'unknown' || entry?.sizePx === undefined) {
      continue;
    }
    const size = Number(entry.sizePx);
    if (!Number.isFinite(size)) {
      continue;
    }
    if (!measured.some((value) => Math.abs(value - size) <= 2)) {
      issues.push(
        `stage 1 visual spec typography[${index}].sizePx (${size}) must come from a measured text row in visual-probe.json (available: ${measured.join(', ')})`
      );
    }
  }
}

function collectOthersVisualRecognitionIssues(runDir, manifest, screenshotSha, issues) {
  const artifact = readJsonOrNull(join(runDir, ...OTHERS_VISUAL_RECOGNITION.split('/')), 'stage 1 component recognition artifact', issues);
  if (!artifact) {
    return;
  }
  if (artifact.schemaVersion !== 1 && artifact.schemaVersion !== 2) {
    issues.push('stage 1 component recognition artifact schemaVersion must equal 1 or 2');
  }
  // Two legitimate producers: the vision MCP tool (M0/M2) or, when the host
  // model can read images itself, one-shot main-model vision (M1). Either way the
  // artifact must be structured, and main-model vision must stay inside its read
  // budget - "I can see it" is not a licence to re-inspect crops forever.
  const visionMode = manifest?.visualEvidenceMode === 'main-model-vision' ? 'main-model-vision' : 'recognize-ui-components';
  const expectedTool = visionMode === 'main-model-vision' ? 'main-model-vision' : 'recognize_ui_components';
  if (
    artifact.producer?.tool !== expectedTool ||
    typeof artifact.producer?.model !== 'string' ||
    artifact.producer.model.length === 0 ||
    typeof artifact.producer?.invocationId !== 'string' ||
    artifact.producer.invocationId.length === 0 ||
    typeof artifact.producer?.createdAt !== 'string' ||
    !Number.isFinite(Date.parse(artifact.producer.createdAt))
  ) {
    issues.push(
      `stage 1 component recognition artifact producer.tool must be ${expectedTool} for visualEvidenceMode=${visionMode}`
    );
  }
  if (visionMode === 'main-model-vision') {
    const reads = manifest?.visionReads;
    if (!Number.isInteger(reads) || reads < 1 || reads > MAX_MAIN_MODEL_VISION_READS) {
      issues.push(
        `stage 1 inputs manifest visionReads must be an integer between 1 and ${MAX_MAIN_MODEL_VISION_READS} when visualEvidenceMode=main-model-vision`
      );
    }
    if (artifact.status === 'degraded') {
      issues.push('stage 1 main-model vision evidence cannot be degraded');
    }
  }
  if (artifact.inputs?.source !== undefined) {
    issues.push('stage 1 component recognition must not include source input');
  }
  const image = artifact.inputs?.image;
  const normalized = typeof image?.path === 'string' ? image.path.replaceAll('\\', '/') : '';
  if (!normalized.endsWith(OTHERS_VISUAL_SCREENSHOT)) {
    issues.push(`stage 1 component recognition image must be ${OTHERS_VISUAL_SCREENSHOT}`);
  }
  if (typeof image?.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(image.sha256)) {
    issues.push('stage 1 component recognition image sha256 is invalid');
  } else if (typeof screenshotSha === 'string' && image.sha256 !== screenshotSha) {
    issues.push('stage 1 component recognition image sha256 must match the current screenshot');
  }
  const requirements = artifact.inputs?.requirements;
  if (
    typeof requirements?.text !== 'string' ||
    requirements.text.length > 8000 ||
    typeof requirements?.sha256 !== 'string' ||
    sha256Text(requirements?.text ?? '') !== requirements?.sha256
  ) {
    issues.push('stage 1 component recognition requirements evidence is invalid');
  }
  const analysisError = validateComponentRecognitionAnalysis(artifact);
  if (analysisError) {
    issues.push(analysisError.replaceAll('stage 2', 'stage 1'));
  }
  if (artifact.schemaVersion === 2 && artifact.status === 'degraded') {
    issues.push('stage 1 component recognition is degraded; the stage must be blocked instead of completed');
  }
}

// Implementation fidelity: the code must use the numbers the design confirmed.
//
// Until this existed, nothing compared `visual-spec.json` with the shipped
// constants, so a confirmed `18vp` title could ship as `20vp` and no gate noticed
// (book-home run, stage 2 -> stage 5). Only numeric facts are checked, and only
// in the direction "every confirmed value must appear in the code" - the reverse
// would flag legitimate layout numbers the design never specified.
// The screenshot path is the only source whose visible copy has no structured
// origin: the probe has no OCR and the recognition tool is the sole text source.
// A real run lost the section heading "训练课程" (the recogniser never saw it) and
// shipped an invented "训练日历" that every gate accepted. Stage 1 therefore owes a
// text inventory, and a page string that no grounded inventory entry covers is a
// fabrication signal rather than a wording choice.
function collectVisualTextInventoryIssues(runDir) {
  const issues = [];
  const spec = readJsonOrNull(join(runDir, ...OTHERS_VISUAL_VISUAL_SPEC.split('/')), 'stage 1 visual spec', issues);
  if (!spec) {
    return issues;
  }
  const inventory = spec.textInventory;
  if (!Array.isArray(inventory) || inventory.length === 0) {
    issues.push(
      'stage 1 visual spec must record textInventory: every visible string the screenshot shows, grounded in the recognition artifact'
    );
    return issues;
  }
  const recognition = readJsonOrNull(
    join(runDir, ...OTHERS_VISUAL_RECOGNITION.split('/')),
    'stage 1 component recognition artifact',
    []
  );
  const corpus = visualRecognitionTextCorpus(recognition);
  for (const [index, entry] of inventory.entries()) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      issues.push(`stage 1 visual spec textInventory[${index}] must be an object`);
      continue;
    }
    const text = normalizeVisualText(entry.text);
    if (text.length === 0) {
      issues.push(`stage 1 visual spec textInventory[${index}].text must be a non-empty string`);
      continue;
    }
    if (typeof entry.evidence !== 'string' || entry.evidence.trim().length === 0) {
      issues.push(`stage 1 visual spec textInventory[${index}].evidence must cite the observation it came from`);
    }
    if (entry.inferred === true) {
      if (typeof entry.reason !== 'string' || entry.reason.trim().length === 0) {
        issues.push(
          `stage 1 visual spec textInventory[${index}] is marked inferred; record why the recognition artifact has no evidence for it`
        );
      }
      continue;
    }
    if (text.length >= 2 && !corpus.includes(text)) {
      issues.push(
        `stage 1 visual spec textInventory[${index}].text "${entry.text}" is not grounded in stage1/component-vision-analysis.json; cite the observation that shows it or mark it inferred with a reason`
      );
    }
  }
  return issues;
}

function visualRecognitionTextCorpus(artifact) {
  const parts = [];
  const push = (value) => {
    if (typeof value === 'string' && value.trim().length > 0) {
      parts.push(value);
    }
  };
  for (const component of Array.isArray(artifact?.analysis?.visible_components)
    ? artifact.analysis.visible_components
    : []) {
    push(component?.name);
    push(component?.visual_evidence);
  }
  for (const observation of Array.isArray(artifact?.analysis?.global_observations)
    ? artifact.analysis.global_observations
    : []) {
    push(typeof observation === 'string' ? observation : observation?.text);
  }
  return normalizeVisualText(parts.join(' '));
}

function normalizeVisualText(value) {
  return String(value ?? '').replace(/\s+/g, '');
}

// Page copy must come from the inventory. Strings covered only by an inferred
// entry stay allowed, but they have to be declared in the manifest so the
// confirmation and the summary can see which copy the design never proved.
function collectVisualUserVisibleStringIssues(runDir) {
  const issues = [];
  const spec = readJsonOrNull(join(runDir, ...OTHERS_VISUAL_VISUAL_SPEC.split('/')), 'stage 1 visual spec', issues);
  const generated = readJsonOrNull(
    join(runDir, 'stage2', 'generated-ui-manifest.json'),
    'stage 2 generated ui manifest',
    issues
  );
  if (!spec || !generated) {
    return issues;
  }
  const inventory = Array.isArray(spec.textInventory) ? spec.textInventory : [];
  const grounded = [];
  const inferred = [];
  for (const entry of inventory) {
    const text = normalizeVisualText(entry?.text);
    if (text.length === 0) {
      continue;
    }
    (entry?.inferred === true ? inferred : grounded).push(text);
  }
  const strings = generated.userVisibleStrings;
  if (!Array.isArray(strings)) {
    issues.push(
      'stage 2 generated-ui-manifest must record userVisibleStrings: every user-visible string the page renders'
    );
    return issues;
  }
  if (strings.length === 0) {
    issues.push('stage 2 generated-ui-manifest userVisibleStrings must not be empty');
  }
  const declaredInferred = new Set(
    (Array.isArray(generated.inferredStrings) ? generated.inferredStrings : []).map((value) => normalizeVisualText(value))
  );
  for (const [index, raw] of strings.entries()) {
    const value = normalizeVisualText(raw);
    if (value.length === 0) {
      issues.push(`stage 2 generated-ui-manifest userVisibleStrings[${index}] must be a non-empty string`);
      continue;
    }
    const covered = (pool) => pool.some((text) => text === value || text.includes(value) || value.includes(text));
    if (covered(grounded)) {
      continue;
    }
    if (!covered(inferred)) {
      issues.push(
        `stage 2 generated-ui-manifest userVisibleStrings[${index}] "${raw}" is not declared in stage 1 visual spec textInventory; add the copy (with its evidence) instead of inventing it`
      );
      continue;
    }
    if (!declaredInferred.has(value)) {
      issues.push(
        `stage 2 generated-ui-manifest userVisibleStrings[${index}] "${raw}" comes from an inferred inventory entry; list it in generated-ui-manifest.inferredStrings`
      );
    }
  }
  return issues;
}

function collectOthersVisualFidelityIssues(runDir) {
  const issues = [];
  const spec = readJsonOrNull(join(runDir, ...OTHERS_VISUAL_VISUAL_SPEC.split('/')), 'stage 1 visual spec', issues);
  const manifest = readJsonOrNull(join(runDir, 'inputs-manifest.json'), 'stage 1 inputs manifest', issues);
  const generated = readJsonOrNull(
    join(runDir, 'stage2', 'generated-ui-manifest.json'),
    'stage 2 generated ui manifest',
    issues
  );
  if (!spec || !manifest || !generated) {
    return issues;
  }
  const projectRoot = resolveLockedProjectRoot(
    runDir,
    manifest.integrationSnapshot?.projectRootPath,
    'stage 1 inputs manifest integrationSnapshot.projectRootPath',
    issues
  );
  if (!projectRoot) {
    return issues;
  }
  const pageFile = readProjectFile(projectRoot, generated.page?.file, 'stage 2 generated page file', issues);
  if (pageFile.content === null) {
    return issues;
  }
  const code = stripArkTsComments(pageFile.content);
  const pageName = generated.page?.file ?? 'the generated page';

  collectConfirmedTypographyIssues(code, spec, pageName, issues);
  collectConfirmedRadiusIssues(code, spec, pageName, issues);
  collectHardcodedColourIssues(code, pageName, issues);
  collectPaletteReachabilityIssues(projectRoot, code, spec, issues);
  return issues;
}

const NUMERIC_CALL_PATTERN = (name) => new RegExp(`\\.${name}\\(\\s*(\\d+(?:\\.\\d+)?)\\s*\\)`, 'g');

function numericArguments(code, name) {
  return [...code.matchAll(NUMERIC_CALL_PATTERN(name))].map((match) => Number(match[1]));
}

function collectConfirmedTypographyIssues(code, spec, pageName, issues) {
  const codeSizes = numericArguments(code, 'fontSize');
  for (const entry of Array.isArray(spec.typography) ? spec.typography : []) {
    const size = Number(entry?.sizePx);
    if (!Number.isFinite(size)) {
      continue;
    }
    if (!codeSizes.some((value) => Math.abs(value - size) <= 1)) {
      issues.push(
        `${pageName} must implement the confirmed typography size ${size}vp for role "${entry.role}"; no .fontSize within +/-1 was found (found ${codeSizes.join(', ') || 'none'})`
      );
    }
  }
}

function collectConfirmedRadiusIssues(code, spec, pageName, issues) {
  const codeRadii = numericArguments(code, 'borderRadius');
  for (const entry of Array.isArray(spec.radii) ? spec.radii : []) {
    const radius = Number(entry?.radiusPx);
    if (!Number.isFinite(radius)) {
      continue;
    }
    if (!codeRadii.some((value) => Math.abs(value - radius) <= 1)) {
      issues.push(
        `${pageName} must implement the confirmed radius ${radius}vp for "${entry.target}"; no .borderRadius within +/-1 was found (found ${codeRadii.join(', ') || 'none'})`
      );
    }
  }
}

function collectHardcodedColourIssues(code, pageName, issues) {
  const literals = [...code.matchAll(/['"](#[0-9a-fA-F]{6})['"]/g)].map((match) => match[1].toUpperCase());
  if (literals.length === 0) {
    return;
  }
  issues.push(
    `${pageName} must reference colour resources instead of literal values (found ${[...new Set(literals)].join(', ')})`
  );
}

// Palette entries must remain reachable from the shipped code: either as a
// literal (already rejected above) or through a colour resource that still holds
// the confirmed value. A +/-3 per channel tolerance absorbs calibration rounding
// while catching a renamed or re-tinted surface.
function collectPaletteReachabilityIssues(projectRoot, code, spec, issues) {
  const palette = (Array.isArray(spec.palette) ? spec.palette : [])
    .map((entry) => String(entry?.color ?? '').toUpperCase())
    .filter((color) => /^#[0-9A-F]{6}$/.test(color));
  if (palette.length === 0) {
    return;
  }
  const colorFile = join(projectRoot, 'entry', 'src', 'main', 'resources', 'base', 'element', 'color.json');
  if (!existsSync(colorFile)) {
    return;
  }
  let resourceColors = [];
  try {
    const parsed = JSON.parse(readFileSync(colorFile, 'utf8'));
    resourceColors = (Array.isArray(parsed?.color) ? parsed.color : [])
      .map((entry) => String(entry?.value ?? '').toUpperCase())
      .filter((value) => /^#[0-9A-F]{6}$/.test(value));
  } catch {
    issues.push('module colour resources (color.json) must be valid JSON');
    return;
  }
  for (const color of palette) {
    if (!resourceColors.some((value) => colorDistanceWithin(value, color, 3))) {
      issues.push(
        `the confirmed palette colour ${color} is no longer reachable from the module colour resources; a confirmed visual value must not be silently retinted`
      );
    }
  }
}

function colorDistanceWithin(left, right, tolerance) {
  for (const offset of [1, 3, 5]) {
    const a = parseInt(left.slice(offset, offset + 2), 16);
    const b = parseInt(right.slice(offset, offset + 2), 16);
    if (!Number.isFinite(a) || !Number.isFinite(b) || Math.abs(a - b) > tolerance) {
      return false;
    }
  }
  return true;
}
function collectOthersVisualStage2EvidenceIssues(runDir) {
  const issues = [];
  const manifest = readJsonOrNull(join(runDir, 'inputs-manifest.json'), 'stage 1 inputs manifest', issues);
  const generated = readJsonOrNull(
    join(runDir, 'stage2', 'generated-ui-manifest.json'),
    'stage 2 generated ui manifest',
    issues
  );
  if (!manifest || !generated) {
    return issues;
  }

  const projectRoot = resolveLockedProjectRoot(
    runDir,
    manifest.integrationSnapshot?.projectRootPath,
    'stage 1 inputs manifest integrationSnapshot.projectRootPath',
    issues
  );
  if (!projectRoot) {
    return issues;
  }

  const page = generated.page;
  if (!page || typeof page !== 'object') {
    issues.push('stage 2 generated ui manifest must record page');
    return issues;
  }
  const componentName = page.component;
  const validComponentName = isArkTsIdentifier(componentName);
  if (!validComponentName) {
    issues.push('stage 2 generated ui manifest page.component must be a valid ArkTS identifier');
  }
  if (page.hasEntry !== false) {
    issues.push('stage 2 generated ui manifest page.hasEntry must be false (only Index keeps @Entry)');
  }

  const registration = generated.registration;
  if (!registration || typeof registration !== 'object') {
    issues.push('stage 2 generated ui manifest must record registration');
  } else {
    if (registration.component !== componentName) {
      issues.push('stage 2 generated ui manifest registration.component must equal page.component');
    }
    if (typeof registration.route !== 'string' || registration.route.trim().length === 0) {
      issues.push('stage 2 generated ui manifest registration.route must be a non-empty string');
    }
    if (typeof registration.file !== 'string' || registration.file.trim().length === 0) {
      issues.push('stage 2 generated ui manifest registration.file must be a non-empty string');
    }
    if (!PAGE_VALID_REGISTRATION_MODES.has(registration.mode)) {
      issues.push(
        'stage 2 generated ui manifest registration.mode must be one of index-navigation, route-table, existing-router'
      );
    }
  }

  const startup = generated.startup;
  if (!startup || typeof startup !== 'object') {
    issues.push('stage 2 generated ui manifest must record startup');
  } else {
    if (startup.entryAbilityPage !== 'pages/Index') {
      issues.push('stage 2 generated ui manifest startup.entryAbilityPage must stay pages/Index');
    }
    if (startup.mainPagesContainsIndex !== true) {
      issues.push('stage 2 generated ui manifest startup.mainPagesContainsIndex must be true');
    }
  }

  if (!validComponentName) {
    return issues;
  }

  const pageFile = readProjectFile(projectRoot, page.file, 'stage 2 generated page file', issues);
  if (pageFile.content !== null) {
    if (hasArkTsDecorator(pageFile.content, 'Entry')) {
      issues.push(`stage 2 generated page ${page.file} must not declare @Entry`);
    }
    if (!hasDecoratedExportStruct(pageFile.content, 'Component', componentName)) {
      issues.push(`stage 2 generated page ${page.file} must export an @Component struct named ${componentName}`);
    }
  }

  // Only index-navigation requires the component to be instantiated in Index;
  // route-table and existing-router register through their own files.
  if (registration?.mode === 'index-navigation') {
    const indexFile = readProjectFile(projectRoot, startup?.indexFile, 'stage 2 index page file', issues);
    if (indexFile.content !== null && !isComponentInstantiated(indexFile.content, componentName)) {
      issues.push(`stage 2 index page ${startup?.indexFile} must instantiate ${componentName}`);
    }
  }

  const mainPagesFile = readProjectFile(
    projectRoot,
    manifest.integrationSnapshot?.mainPagesFile,
    'stage 2 main_pages file',
    issues
  );
  if (mainPagesFile.content !== null) {
    const src = parseMainPagesSrc(mainPagesFile.content);
    if (!src || !src.includes('pages/Index')) {
      issues.push('stage 2 main_pages.json must still contain pages/Index');
    }
  }

  const entryAbilityFile = readProjectFile(
    projectRoot,
    manifest.integrationSnapshot?.entryAbilityFile,
    'stage 2 entry ability file',
    issues
  );
  if (entryAbilityFile.content !== null && findLoadContentPage(entryAbilityFile.content) !== 'pages/Index') {
    issues.push('stage 2 EntryAbility must keep loadContent on pages/Index');
  }
  // The confirmation index carries its own acceptedAt; validate it when the
  // file is present without making the file itself mandatory here (mirrors
  // the HTML source: a file-time window plus a snapshot-causality bound).
  const confirmationPath = join(runDir, 'stage2', 'component-confirmation.json');
  if (existsSync(confirmationPath)) {
    const confirmation = readJsonOrNull(confirmationPath, 'stage 2 component confirmation', issues);
    if (confirmation && typeof confirmation === 'object' && !Array.isArray(confirmation)) {
      collectTimestampFileWindowIssues(
        confirmationPath,
        'stage 2 component confirmation acceptedAt',
        confirmation.acceptedAt,
        issues
      );
      const state = readJsonOrNull(join(runDir, 'workflow-state.json'), 'workflow-state', []);
      const snapshotTime = Date.parse(state?.confirmationSnapshots?.['2']?.createdAt);
      const acceptedTime = Date.parse(confirmation.acceptedAt);
      if (
        Number.isFinite(snapshotTime) &&
        Number.isFinite(acceptedTime) &&
        acceptedTime < snapshotTime - TIMESTAMP_CAUSALITY_TOLERANCE_MS
      ) {
        issues.push(
          'stage 2 component confirmation acceptedAt cannot predate the controller confirmation snapshot (the acceptance happens at the confirm call, not before)'
        );
      }
    }
  }
  return issues;
}

// others-visual stage 2 finishes with a first build. The stage instruction
// promises the Controller validates the report, so enforce it here: a run that
// skipped the build (or faked a success) cannot complete the stage. The
// completion time is additionally held against the report file itself,
// mirroring the HTML source initial-build-report window.
function collectOthersVisualStage2BuildEvidenceIssues(runDir) {
  const issues = [];
  const reportPath = join(runDir, 'stage2', 'initial-build-report.json');
  const report = readJsonOrNull(reportPath, 'stage 2 initial build report', issues);
  if (!report) {
    return issues;
  }
  if (report.success !== true) {
    issues.push('stage 2 initial build report must set success=true');
  }
  if (typeof report.command !== 'string' || report.command.trim() === '') {
    issues.push('stage 2 initial build report must record a non-empty command');
  }
  if (report.exitCode !== 0) {
    issues.push('stage 2 initial build report must record exitCode=0');
  }
  if (typeof report.completedAt !== 'string' || Number.isNaN(Date.parse(report.completedAt))) {
    issues.push('stage 2 initial build report must record a valid completedAt');
  } else {
    collectTimestampFileWindowIssues(
      reportPath,
      'stage 2 initial build report completedAt',
      report.completedAt,
      issues
    );
  }
  return issues;
}

function successfulBuild(build) {
  return build?.success === true && build?.exitCode === 0 &&
    typeof build?.command === 'string' && Number.isFinite(Date.parse(build?.completedAt));
}

// --- repo-context (shared engineering-understanding contract) ---------------
// Contract: references/repo-context.md. Both collectors are live-only: they are
// mounted from stage-complete --result passed so completed-stage replays of
// runs predating this rule keep working (same policy as the ledger rule below).

const REPO_CONTEXT_REQUIRED_KEYS = [
  'projectRootPath',
  'projectType',
  'entryChain',
  'routing',
  'stateManagement',
  'dataModel',
  'resources',
  'buildCommands',
  'existingComponents',
  'reusableComponents',
  'startupPage',
  'differences',
  'uncertainties',
  'evidence'
];
const REPO_CONTEXT_NON_EMPTY_SUBKEYS = [
  ['entryChain', 'indexFile'],
  ['entryChain', 'entryAbilityFile'],
  ['entryChain', 'mainPagesFile'],
  ['entryChain', 'loadContent'],
  ['routing', 'registrationMode'],
  ['routing', 'registrationFile'],
  ['resources', 'mediaDir'],
  ['resources', 'prefix'],
  ['resources', 'colorFile'],
  ['resources', 'stringFile'],
  ['resources', 'floatFile'],
  ['buildCommands', 'check'],
  ['buildCommands', 'build']
];
// Exact heading lines locked by the repo-understand capability's
// references/methodology/output-format.md; the 七点五/七点六/七点七 addenda
// are optional and intentionally absent from the required set.
const PIXSO_REPO_UNDERSTAND_PARTS = [
  '## 一、项目信息',
  '## 二、架构约束',
  '## 三、命名规范',
  '## 四、代码风格',
  '## 五、当前代码仓相关代码',
  '## 六、需要补充实现的部分',
  '## 七、差异分析摘要',
  '## 八、约束规则',
  '## 九、禁止事项',
  '## 十、代码生成行为规范'
];
const PIXSO_COMPONENT_LIST_ANCHOR = '### 5.2 已实现组件清单';
const DESIGN_DOC_REUSE_ANCHOR = '## 存量复用';
// A component name is an identifier: descriptions belong in useFor / kind.
const BARE_COMPONENT_NAME = /^[^\s@（）()\[\]{}<>,;:]+$/;
// Unfilled output-format.md placeholders look like {existingComponentsList}.
const TEMPLATE_PLACEHOLDER_PATTERN = /\{[a-zA-Z][a-zA-Z0-9]*\}/;

function markdownSection(md, anchor) {
  const lines = md.replace(/^\uFEFF/, '').split(/\r?\n/);
  const start = lines.findIndex((line) => line.trim() === anchor);
  if (start === -1) return null;
  // End at the next heading of the anchor's own level or higher so legitimate
  // subsections stay inside the extracted section.
  const anchorLevel = /^#+/.exec(anchor)?.[0].length ?? 6;
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((line) => {
    const heading = /^(#{1,6})\s/.exec(line.trim());
    return heading !== null && heading[1].length <= anchorLevel;
  });
  return (end === -1 ? rest : rest.slice(0, end)).join('\n');
}

// Component names are identifiers; require identifier boundaries so a lookup
// for List is not satisfied by WaterFlowList.
function containsIdentifier(text, name) {
  return new RegExp(`(?<![A-Za-z0-9_])${escapeRegExp(name)}(?![A-Za-z0-9_])`).test(text);
}

// A repo-context path field: relative to the project root, never escaping it.
// Drive-relative Windows paths ("D:dir\file") are neither isAbsolute nor
// containable, so they are rejected explicitly.
function repoContextProjectFile(projectRoot, value) {
  if (typeof value !== 'string' || value.length === 0 || isAbsolute(value) || /^[A-Za-z]:/.test(value)) return null;
  const path = resolve(projectRoot, value);
  const rel = relative(projectRoot, path);
  const firstSegment = rel.split(/[\\/]/)[0];
  if (firstSegment === '' || firstSegment === '..' || isAbsolute(rel)) return null;
  return path;
}

function repoContextNames(items) {
  return [...new Set((Array.isArray(items) ? items : [])
    .map((item) => (item !== null && typeof item === 'object' && typeof item.name === 'string' && item.name.trim().length > 0 ? item.name.trim() : null))
    .filter((name) => name !== null))];
}

// JSON.parse happily yields null, scalars and arrays; both collectors need a
// plain object, and a legal JSON null document must fail as a structured
// issue rather than crash on property access or silently pass.
function readRepoContext(path) {
  if (!isParseableJsonFile(path)) {
    return { issues: [`${REPO_CONTEXT_JSON} is missing or not parseable`] };
  }
  try {
    const parsed = readJsonFile(path);
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { issues: [`${REPO_CONTEXT_JSON} must be a JSON object`] };
    }
    return { context: parsed };
  } catch {
    return { issues: [`${REPO_CONTEXT_JSON} is missing or not parseable`] };
  }
}

// Assertion numbering follows references/repo-context.md §4. Assertions 3, 5
// and 7a need the project root, so they run after the manifest lookup; the
// MD-form checks (6, 7b) do not depend on it and keep reporting when the
// manifest itself is unusable.
function collectRepoContextIssues(runDir, designSource) {
  const issues = [];
  const parsed = readRepoContext(runDirRelativePath(runDir, REPO_CONTEXT_JSON));
  if (parsed.issues !== undefined) {
    return parsed.issues;
  }
  const context = parsed.context;

  // 1. identity
  if (context.schemaVersion !== 1) {
    issues.push(`${REPO_CONTEXT_JSON} schemaVersion must be 1`);
  }
  if (context.designSource !== designSource) {
    issues.push(`${REPO_CONTEXT_JSON} designSource must be ${designSource}, got ${JSON.stringify(context.designSource)}`);
  }

  // 2. the remaining 14 top-level keys plus the non-empty subkeys
  for (const key of REPO_CONTEXT_REQUIRED_KEYS) {
    if (context[key] === undefined) {
      issues.push(`${REPO_CONTEXT_JSON} is missing required key: ${key}`);
    }
  }
  for (const [key, subkey] of REPO_CONTEXT_NON_EMPTY_SUBKEYS) {
    if (!isNonEmptyBoundedString(context?.[key]?.[subkey], 2048)) {
      issues.push(`${REPO_CONTEXT_JSON} ${key}.${subkey} must be a non-empty string`);
    }
  }
  if (!['v1', 'v2'].includes(context?.stateManagement?.version)) {
    issues.push(`${REPO_CONTEXT_JSON} stateManagement.version must be v1 or v2`);
  }
  if (!isNonEmptyBoundedString(context?.stateManagement?.pattern, 2048)) {
    issues.push(`${REPO_CONTEXT_JSON} stateManagement.pattern must be a non-empty string`);
  }
  if (!isNonEmptyBoundedString(context?.stateManagement?.evidence, 2048)) {
    issues.push(`${REPO_CONTEXT_JSON} stateManagement.evidence must be a non-empty string`);
  }
  if (!['template', 'existing'].includes(context?.projectType)) {
    issues.push(`${REPO_CONTEXT_JSON} projectType must be template or existing`);
  }
  if (context?.routing !== undefined && !Array.isArray(context.routing.existingRoutes)) {
    issues.push(`${REPO_CONTEXT_JSON} routing.existingRoutes must be an array`);
  }
  if (context?.dataModel !== undefined && !Array.isArray(context.dataModel.existing)) {
    issues.push(`${REPO_CONTEXT_JSON} dataModel.existing must be an array`);
  }
  if (!isNonEmptyBoundedString(context?.startupPage?.before, 2048)) {
    issues.push(`${REPO_CONTEXT_JSON} startupPage.before must be a non-empty string`);
  }
  if (context?.startupPage !== undefined && !Array.isArray(context.startupPage.evidenceFiles)) {
    issues.push(`${REPO_CONTEXT_JSON} startupPage.evidenceFiles must be an array`);
  }
  if (context?.evidence !== undefined && !Array.isArray(context.evidence.filesRead)) {
    issues.push(`${REPO_CONTEXT_JSON} evidence.filesRead must be an array`);
  }
  const generatedAt = typeof context?.evidence?.generatedAt === 'string' ? context.evidence.generatedAt.trim() : '';
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/.test(generatedAt)) {
    issues.push(`${REPO_CONTEXT_JSON} evidence.generatedAt must be an ISO-8601 timestamp with seconds and an explicit zone (Z or numeric offset)`);
  } else if (/T\d{2}:\d{2}:00(\.0+)?(Z|[+-]\d{2}:\d{2})$/.test(generatedAt)) {
    // A whole-minute timestamp is the signature of a hand-written clock
    // reading; an honest clock reading has roughly a 1/60000 chance of
    // hitting it and can simply re-read the clock.
    issues.push(`${REPO_CONTEXT_JSON} evidence.generatedAt must come from the system clock; whole-minute timestamps are rejected`);
  }

  // 4. every component/difference conclusion names its subject and evidence
  for (const [key, subjectKey] of [['existingComponents', 'name'], ['reusableComponents', 'name'], ['differences', 'target']]) {
    if (context[key] === undefined) continue;
    if (!Array.isArray(context[key])) {
      issues.push(`${REPO_CONTEXT_JSON} ${key} must be an array`);
      continue;
    }
    context[key].forEach((item, index) => {
      if (item === null || typeof item !== 'object' || Array.isArray(item)) {
        issues.push(`${REPO_CONTEXT_JSON} ${key}[${index}] must be an object`);
        return;
      }
      if (!isNonEmptyBoundedString(item[subjectKey], 512)) {
        issues.push(`${REPO_CONTEXT_JSON} ${key}[${index}].${subjectKey} must be a non-empty string`);
      } else if (subjectKey === 'name' && !BARE_COMPONENT_NAME.test(item.name.trim())) {
        // Component labels like "Index@route host" make the design document's
        // verbatim reference arbitrary, so names stay identifiers.
        issues.push(`${REPO_CONTEXT_JSON} ${key}[${index}].name must be a bare component identifier (no description, "@", brackets or punctuation)`);
      }
      if (!isNonEmptyBoundedString(item.evidence, 2048)) {
        issues.push(`${REPO_CONTEXT_JSON} ${key}[${index}].evidence must be a non-empty string`);
      }
    });
  }

  // 6 + 7b. pixso: the ten-part MD is the capability's product; the JSON is
  // distilled from it, so both must exist and agree.
  const mdPath = runDirRelativePath(runDir, 'stage3-repo-understand-report.md');
  if (!isNonEmptyFile(mdPath)) {
    issues.push('stage3-repo-understand-report.md is missing or empty');
    return issues;
  }
  let md;
  try {
    md = readFileSync(mdPath, 'utf8');
  } catch {
    issues.push('stage3-repo-understand-report.md is missing or unreadable');
    return issues;
  }
  const lines = md.replace(/^\uFEFF/, '').split(/\r?\n/).map((line) => line.trim());
  for (const heading of PIXSO_REPO_UNDERSTAND_PARTS) {
    if (!lines.includes(heading)) {
      issues.push(`stage3-repo-understand-report.md is missing the required part heading: ${heading}`);
    }
  }
  if (TEMPLATE_PLACEHOLDER_PATTERN.test(md)) {
    issues.push('stage3-repo-understand-report.md still contains unfilled template placeholders like {existingComponentsList}');
  }
  for (const heading of PIXSO_REPO_UNDERSTAND_PARTS) {
    const index = lines.indexOf(heading);
    if (index === -1) continue;
    const nextPart = lines.findIndex((line, i) => i > index && /^##\s/.test(line));
    const end = nextPart === -1 ? lines.length : nextPart;
    const hasBody = lines.slice(index + 1, end).some((line) => line.length > 0 && !/^#{1,6}\s/.test(line));
    if (!hasBody) {
      issues.push(`stage3-repo-understand-report.md part has no content: ${heading}`);
    }
  }
  const componentList = markdownSection(md, PIXSO_COMPONENT_LIST_ANCHOR);
  const existingNames = repoContextNames(context.existingComponents);
  if (componentList === null) {
    issues.push(`stage3-repo-understand-report.md is missing the ${PIXSO_COMPONENT_LIST_ANCHOR} section`);
  } else if (componentList.split(/\r?\n/).every((line) => line.trim().length === 0 || /^#{1,6}\s/.test(line.trim()))) {
    issues.push(`stage3-repo-understand-report.md ${PIXSO_COMPONENT_LIST_ANCHOR} section is empty`);
  } else if (existingNames.length > 0 && !existingNames.some((name) => containsIdentifier(componentList, name))) {
    issues.push(`${REPO_CONTEXT_JSON} existingComponents has no overlap with the ${PIXSO_COMPONENT_LIST_ANCHOR} list`);
  }

  // 5. the project root must match what stage 1 actually measured. A missing,
  // unparseable or non-object manifest is a structured issue, never a silent
  // skip: a legal JSON null document would otherwise disable every
  // root-dependent check below.
  const manifestIssues = [];
  const manifest = readJsonOrNull(join(runDir, 'inputs-manifest.json'), 'inputs manifest', manifestIssues);
  const manifestObject = manifest !== null && typeof manifest === 'object' && !Array.isArray(manifest) ? manifest : null;
  if (manifestObject === null && manifestIssues.length === 0) {
    manifestIssues.push('inputs manifest must be a JSON object');
  }
  issues.push(...manifestIssues);
  const projectRoot = manifestObject === null
    ? null
    : resolveLockedProjectRoot(runDir, manifestObject.projectRootPath, 'inputs manifest projectRootPath', issues);
  const declaredRoot = context.projectRootPath === undefined
    ? null
    : resolveLockedProjectRoot(runDir, context.projectRootPath, `${REPO_CONTEXT_JSON} projectRootPath`, issues);
  if (projectRoot !== null && declaredRoot !== null && realpathSync(declaredRoot) !== realpathSync(projectRoot)) {
    issues.push(`${REPO_CONTEXT_JSON} projectRootPath must match the inputs manifest projectRootPath`);
  }
  if (projectRoot === null) {
    return issues;
  }

  // 3. stateManagement.evidence is path:line inside the project
  const stateEvidence = typeof context.stateManagement?.evidence === 'string' ? context.stateManagement.evidence.trim() : '';
  const stateEvidenceMatch = /^(\S+):(\d+)$/.exec(stateEvidence);
  const stateEvidenceFile = stateEvidenceMatch === null ? null : repoContextProjectFile(projectRoot, stateEvidenceMatch[1]);
  if (stateEvidenceMatch === null) {
    issues.push(`${REPO_CONTEXT_JSON} stateManagement.evidence must be path:line`);
  } else if (stateEvidenceFile === null || !existsSync(stateEvidenceFile) || !statSync(stateEvidenceFile).isFile()) {
    issues.push(`${REPO_CONTEXT_JSON} stateManagement.evidence path does not exist inside the project: ${stateEvidenceMatch[1]}`);
  }

  // 7a. every filesRead entry is a real project file
  if (Array.isArray(context.evidence?.filesRead)) {
    for (const value of context.evidence.filesRead) {
      const file = repoContextProjectFile(projectRoot, value);
      if (file === null || !existsSync(file) || !statSync(file).isFile()) {
        issues.push(`${REPO_CONTEXT_JSON} evidence.filesRead entry does not exist inside the project: ${JSON.stringify(value)}`);
      }
    }
  }
  return issues;
}

// The design document must consume the repo-context reuse conclusions (live-only).
// Known limitation: pixso has no confirmation snapshot for stages 3/5, so
// repo-context.json is trusted as-is between the two stages; only design-doc
// recovery events freeze it (recovery input hashes). The 存量复用 wording
// check is a floor, not a forgery detector: it rejects missing sections,
// missing statements and bare statements without a reason.
function collectRepoContextConsumptionIssues(runDir) {
  const designDocPath = runDirRelativePath(runDir, 'design-doc.md');
  if (!isNonEmptyFile(designDocPath)) {
    return []; // a missing design-doc is reported and recovered elsewhere
  }
  const parsed = readRepoContext(runDirRelativePath(runDir, REPO_CONTEXT_JSON));
  if (parsed.issues !== undefined) {
    return parsed.issues;
  }
  let designDoc;
  try {
    designDoc = readFileSync(designDocPath, 'utf8');
  } catch {
    return ['design-doc.md is missing or unreadable'];
  }
  const reusableNames = repoContextNames(parsed.context.reusableComponents);
  const section = markdownSection(designDoc, DESIGN_DOC_REUSE_ANCHOR);
  if (section === null) {
    return [`design-doc.md is missing the ${DESIGN_DOC_REUSE_ANCHOR} section`];
  }
  if (reusableNames.length > 0) {
    // A non-empty reuse list must be consumed, bounded by what actually exists.
    const required = Math.min(2, reusableNames.length);
    const referenced = reusableNames.filter((name) => containsIdentifier(section, name));
    if (referenced.length < required) {
      return [`design-doc.md ${DESIGN_DOC_REUSE_ANCHOR} section must reference at least ${required} reusable component(s) from ${REPO_CONTEXT_JSON} (available: ${reusableNames.join(', ')})`];
    }
    return [];
  }
  // An empty reuse list is legitimate (template projects); drifting through it is not.
  const bodyLength = section
    .split(/\r?\n/)
    .filter((line) => !/^#{1,6}\s/.test(line.trim()))
    .join('')
    .trim().length;
  if (!/无存量可复用|无可用存量/.test(section) || bodyLength < 30) {
    return [`design-doc.md ${DESIGN_DOC_REUSE_ANCHOR} section must state that the project has no reusable components, with a one-line reason (e.g. template project with only the Index page)`];
  }
  return [];
}

function collectStageEvidenceIssues(runDir, catalog, stage, ctx = {}) {
  const issues = [];
  const designSource = catalog.designSource ?? 'pixso';
  const visualStage = ['figma', 'mastergo', 'lanhu', 'others-html', 'others-visual'].includes(designSource) ? 5 : 9;
  const referenceNowMs = resolveTimestampReferenceNowMs(runDir);
  if (stage === 1) {
    issues.push(...collectRequirementClarificationEvidenceIssues(runDir, catalog));
  }
  if (designSource === 'lanhu' && stage === 1) {
    issues.push(...collectLanhuInputIssues(runDir));
    const manifest = readJsonOrNull(join(runDir, 'inputs-manifest.json'), 'stage 1 inputs manifest', issues);
    if (manifest) issues.push(...collectPageStage1IntegrationIssues(runDir, catalog, manifest, ctx));
  }
  if (designSource === 'lanhu' && stage === 2) {
    issues.push(...collectLanhuStage2Issues(runDir, catalog.variant));
    issues.push(...collectComponentRecognitionEvidenceIssues(runDir, 'lanhu'));
    issues.push(...collectPageRegistrationEvidenceIssues(runDir, { ...ctx, designSource: 'lanhu' }));
  }
  if (designSource === 'lanhu' && catalog.variant === 'fast' && stage >= 3) {
    const report = readJsonOrNull(join(runDir, `stage${stage}-report.json`), `Lanhu stage ${stage} report`, issues);
    if (report?.status !== 'completed') issues.push(`Lanhu stage ${stage} report must record completed`);
    if (stage === 4 && !successfulBuild(report?.build)) issues.push('Lanhu final build report is invalid');
  }
  if (designSource === 'lanhu' && catalog.variant === 'full') {
    const outputs = { 3: ['stage3-interaction-report.md'], 4: ['stage4-quality-audit.json', 'stage4-quality-audit.md', 'stage4-build-report.md', 'hds-decision.json'], 6: ['completeness-report.md'] };
    for (const file of outputs[stage] ?? []) {
      if (!isNonEmptyFile(join(runDir, file))) issues.push(`Lanhu Full requires ${file}`);
      else if (file.endsWith('.json')) readJsonOrNull(join(runDir, file), file, issues);
    }
    if (stage === 4) {
      const audit = readJsonOrNull(join(runDir, 'stage4-quality-audit.json'), 'Lanhu Full quality audit', issues);
      if (!successfulBuild(audit?.build)) issues.push('Lanhu Full quality audit must record a successful final build');
    }
  }
  if (designSource === 'pixso' && stage === 3 && ctx.live === true) {
    issues.push(...collectRepoContextIssues(runDir, designSource));
  }
  if (designSource === 'pixso' && stage === 5 && ctx.live === true) {
    issues.push(...collectRepoContextConsumptionIssues(runDir));
  }
  if (designSource === 'figma' && stage === 1) {
    issues.push(...collectFigmaStage1EvidenceIssues(runDir, catalog, ctx));
  }
  if (designSource === 'figma' && stage === 2) {
    issues.push(...collectComponentRecognitionEvidenceIssues(runDir));
    issues.push(...collectPageRegistrationEvidenceIssues(runDir, ctx));
  }
  if (designSource === 'mastergo' && stage === 1) {
    issues.push(...collectMasterGoInputIssues(runDir));
    const manifest = readJsonOrNull(join(runDir, 'inputs-manifest.json'), 'MasterGo inputs manifest', issues);
    if (manifest) issues.push(...collectPageStage1IntegrationIssues(runDir, catalog, manifest, ctx));
  }
  if (designSource === 'mastergo' && stage === 2) {
    issues.push(...collectComponentRecognitionEvidenceIssues(runDir, 'mastergo'));
    issues.push(...collectMasterGoStage2Issues(runDir, { variant: catalog.variant }));
    issues.push(...collectPageRegistrationEvidenceIssues(runDir, { ...ctx, designSource }));
  }
  if (designSource === 'mastergo' && stage >= 3) {
    // The catalog owns report paths; its reuse links identify the shared Figma instructions.
    const definition = catalog.stages[stage - 1];
    const required = definition.requiredOutputs;
    for (const name of required) {
      if (!isNonEmptyFile(join(runDir, name))) issues.push(`stage ${stage} report is missing or empty: ${name}`);
    }
    if (definition.buildEvidence) {
      const report = readJsonOrNull(join(runDir, definition.buildEvidence), 'quality audit', issues);
      if (report?.build?.success !== true || report?.build?.exitCode !== 0 || !report?.build?.command?.trim() || !Number.isFinite(Date.parse(report?.build?.completedAt))) {
        issues.push(`stage ${stage} requires successful final build evidence`);
      }
    }
  }
  if (designSource === 'others-html') {
    issues.push(...collectOthersHtmlLedgerTimestampIssues(runDir, referenceNowMs));
    issues.push(...collectOthersHtmlTimestampFileIssues(runDir, ctx));
  }
  if (designSource === 'others-html' && stage === 1) {
    issues.push(...collectOthersHtmlStage1EvidenceIssues(runDir, referenceNowMs, ctx.live === true));
  }
  if (designSource === 'others-html' && stage === 2 && ctx.waiveDesignDocEvidence !== true) {
    issues.push(...collectOthersHtmlStage2EvidenceIssues(runDir, referenceNowMs));
  }
  if (designSource === 'others-html' && stage === 3) {
    issues.push(...collectOthersHtmlStage3InteractionIssues(runDir));
  }
  if (designSource === 'others-html' && stage === 4) {
    issues.push(...collectOthersHtmlStage4QualityIssues(runDir));
  }
  // Full runs calibrate at stage 5 and summarise at stage 6; Fast runs have no
  // calibration stage, so stage 5 is the summary.
  const othersHtmlSummaryStage = catalog.variant === 'full' ? 6 : 5;
  if (designSource === 'others-html' && stage === othersHtmlSummaryStage) {
    issues.push(...collectOthersHtmlStage6SummaryIssues(runDir, catalog));
  }
  // The screenshot path keeps its own two-producer evidence (recognition +
  // probe) from stage 1, and re-checks the visual spec at the design stage so
  // a run cannot drop the spec after stage 1 and design from guesswork.
  if (designSource === 'others-visual' && stage === 1) {
    issues.push(...collectVisualSpecEvidenceIssues(runDir, designSource));
    issues.push(...collectOthersVisualStage1EvidenceIssues(runDir));
    if (ctx.live === true) {
      issues.push(...collectVisualTextInventoryIssues(runDir));
    }
  }
  if (designSource === 'others-visual' && stage === 2) {
    if (ctx.waiveDesignDocEvidence !== true) {
      issues.push(...collectVisualSpecEvidenceIssues(runDir, designSource));
      issues.push(...collectOthersVisualStage2BuildEvidenceIssues(runDir));
    }
    issues.push(...collectOthersVisualStage2EvidenceIssues(runDir));
    if (ctx.fidelityExempt !== true) {
      issues.push(...collectOthersVisualFidelityIssues(runDir));
    }
    if (ctx.live === true) {
      issues.push(...collectVisualTextInventoryIssues(runDir));
      issues.push(...collectVisualUserVisibleStringIssues(runDir));
    }
  }
  // Stage 4 must still match the confirmed design: it may fix defects, not
  // re-tune visuals. The calibration stage is deliberately exempt - it may
  // adjust the implementation as long as it records the difference. The
  // exemption has to reach the replay of the completed stages as well: a
  // finished stage is re-checked on every stage-complete, so without the
  // exemption the calibration stage could never be completed.
  if (designSource === 'others-visual' && stage === 4 && ctx.fidelityExempt !== true) {
    issues.push(...collectOthersVisualFidelityIssues(runDir));
  }
  // The interaction and summary stages declare their deliverables in the stage
  // documents. Until now nothing enforced them, so a run could skip both
  // reports and still complete; others-html already gates the same files.
  // Only live completion enforces these: a completed run that predates the
  // rule must not become invalid on replay.
  if (ctx.live === true && designSource === 'others-visual' && stage === 3 && !isNonEmptyFile(join(runDir, 'stage3-interaction-report.md'))) {
    issues.push('stage 3 interaction report is missing or empty: stage3-interaction-report.md');
  }
  const othersVisualSummaryStage = catalog.variant === 'full' ? 6 : 5;
  if (ctx.live === true && designSource === 'others-visual' && stage === othersVisualSummaryStage) {
    if (!isNonEmptyFile(join(runDir, 'completeness-report.md'))) {
      issues.push('summary deliverable is missing or empty: completeness-report.md');
    }
  }
  if (requiresDesignDocMissingGuard(catalog, stage) && ctx.waiveDesignDocEvidence !== true) {
    issues.push(...collectDesignDocEvidenceIssues(runDir));
    // Live completion of a doc stage must prove the solution-design skill ran;
    // completed-stage replays keep working for runs predating this rule.
    if (ctx.live === true) {
      issues.push(...collectSolutionDesignLedgerIssues(runDir, stage));
    }
  }
  // Every source with a calibration stage uses the same score criterion; the
  // two others sources additionally have their scoring inputs guarded.
  if (catalog.variant === 'full' && stage === visualStage) {
    issues.push(...collectVisualCalibrationEvidenceIssues(runDir, stage, designSource, ctx));
    if (designSource === 'others-html' || designSource === 'others-visual') {
      issues.push(...collectOthersCalibrationIntegrityIssues(runDir, stage, designSource, ctx));
    }
  }
  return issues;
}

function validatePathWithinSkillRoot(relPath, label, skillRoot) {
  if (typeof relPath !== 'string' || relPath.length === 0) {
    fail(`${label} is missing`);
  }
  if (isAbsolute(relPath)) {
    fail(`${label} must be relative, got absolute path: ${relPath}`);
  }
  const resolved = resolve(skillRoot, relPath);
  const rel = relative(skillRoot, resolved);
  if (rel.startsWith('..') || isAbsolute(rel)) {
    fail(`${label} must stay within the skill root directory: ${relPath}`);
  }
  return resolved;
}

function validateStageCatalog(catalog, expectedVariant, expectedSource, skillRoot) {
  if (catalog.schemaVersion !== 1) {
    fail(`catalog schemaVersion must be 1, got ${catalog.schemaVersion}`);
  }
  if (catalog.workflowVersion !== 4) {
    fail(`catalog workflowVersion must be 4, got ${catalog.workflowVersion}`);
  }
  if (catalog.variant !== expectedVariant) {
    fail(`catalog variant mismatch: expected ${expectedVariant}, got ${catalog.variant}`);
  }
  const catalogSource = catalog.designSource ?? 'pixso';
  if (catalogSource !== expectedSource) {
    fail(`catalog designSource mismatch: expected ${expectedSource}, got ${catalogSource}`);
  }
  if (typeof catalog.workflow !== 'string' || catalog.workflow.length === 0) {
    fail('catalog workflow must be a non-empty string');
  }
  const runtimeContractFullPath = validatePathWithinSkillRoot(catalog.runtimeContractPath, 'catalog runtimeContractPath', skillRoot);
  if (!existsSync(runtimeContractFullPath)) {
    fail(`catalog runtimeContractPath file does not exist: ${catalog.runtimeContractPath}`);
  }
  const stat = statSync(runtimeContractFullPath);
  if (!stat.isFile()) {
    fail(`catalog runtimeContractPath must be a file, not a directory: ${catalog.runtimeContractPath}`);
  }
  if (!catalog.runtimeContractPath.startsWith('references/')) {
    fail(`catalog runtimeContractPath must be under references/: ${catalog.runtimeContractPath}`);
  }
  if (!Array.isArray(catalog.stages) || catalog.stages.length === 0) {
    fail('catalog stages must be a non-empty array');
  }
  const expectedDir = `references/${expectedSource}/${expectedVariant}/stages/`;
  const instructionPaths = new Set();
  for (const [index, stage] of catalog.stages.entries()) {
    const expectedId = index + 1;
    if (stage.id !== expectedId) {
      fail(`catalog stage at index ${index} has id ${stage.id}, expected ${expectedId}`);
    }
    if (typeof stage.title !== 'string' || stage.title.length === 0) {
      fail(`catalog stage ${expectedId} title is missing`);
    }
    const instructionFullPath = validatePathWithinSkillRoot(stage.instructionPath, `catalog stage ${expectedId} instructionPath`, skillRoot);
    if (!stage.instructionPath.startsWith(expectedDir)) {
      fail(`catalog stage ${expectedId} instructionPath must be under ${expectedDir}: ${stage.instructionPath}`);
    }
    if (instructionPaths.has(stage.instructionPath)) {
      fail(`duplicate catalog instructionPath: ${stage.instructionPath}`);
    }
    instructionPaths.add(stage.instructionPath);
    if (!existsSync(instructionFullPath)) {
      fail(`catalog stage ${expectedId} instruction file does not exist: ${stage.instructionPath}`);
    }
    const instructionStat = statSync(instructionFullPath);
    if (!instructionStat.isFile()) {
      fail(`catalog stage ${expectedId} instructionPath must be a file: ${stage.instructionPath}`);
    }
    if (catalogSource === 'mastergo' && stage.id >= 3) {
      if (!Array.isArray(stage.requiredOutputs) || stage.requiredOutputs.some((file) => typeof file !== 'string' || !/^[a-z0-9-]+\.(?:md|json)$/.test(file)) || new Set(stage.requiredOutputs).size !== stage.requiredOutputs.length) {
        fail(`catalog stage ${expectedId} requiredOutputs must be unique run-relative report names`);
      }
      if (stage.buildEvidence !== undefined && !stage.requiredOutputs.includes(stage.buildEvidence)) {
        fail(`catalog stage ${expectedId} buildEvidence must be a required output`);
      }
    }
    if (typeof stage.requiresConfirmation !== 'boolean') {
      fail(`catalog stage ${expectedId} requiresConfirmation must be boolean`);
    }
    if (
      stage.confirmationContinuesStage !== undefined &&
      typeof stage.confirmationContinuesStage !== 'boolean'
    ) {
      fail(`catalog stage ${expectedId} confirmationContinuesStage must be boolean when present`);
    }
    if (stage.confirmationContinuesStage === true && stage.requiresConfirmation !== true) {
      fail(`catalog stage ${expectedId} confirmationContinuesStage requires requiresConfirmation=true`);
    }
    if (expectedSource === 'mastergo' && stage.id >= 3) {
      const reusedPath = validatePathWithinSkillRoot(stage.reusesInstructionPath, 'reused stage instruction', skillRoot);
      if (!existsSync(reusedPath) || !statSync(reusedPath).isFile()) {
        fail(`reused stage instruction is missing: ${stage.reusesInstructionPath}`);
      }
    }
  }
}

function computeWorkflowDigest(skillRoot, catalog, catalogRelPath) {
  const paths = [
    catalogRelPath,
    catalog.runtimeContractPath,
    ...(catalog.designSource === 'lanhu' ? ['scripts/lanhu-source.mjs', 'scripts/lanhu-capture.mjs', 'scripts/lanhu-connection.mjs', 'scripts/lanhu-setup.mjs', 'scripts/lanhu-private.mjs', 'scripts/lanhu-runtime.mjs', 'scripts/lanhu-runtime-lock.json', 'scripts/lanhu-mastergo.patch.json', 'scripts/lanhu_login.py', 'scripts/lanhu-import-assets.mjs', 'references/lanhu/mcp-setup.md', 'scripts/lanhu-workflow.mjs', 'references/lanhu/input-contract.md', 'references/capabilities/hmos-d2a-lanhu-to-arkui/INSTRUCTIONS.md', ...(catalog.variant === 'full' ? ['references/lanhu/fast/stages/01-acquire-lanhu-context.md', 'references/figma/full/stages/03-complete-interaction-logic.md', 'references/figma/full/stages/04-quality-and-build.md', 'references/figma/full/stages/05-visual-calibration.md'] : [])] : []),
    ...catalog.stages.map((s) => s.instructionPath)
  ];
  if (catalog.designSource === 'mastergo') {
    paths.push('scripts/mastergo-community-start.mjs', 'scripts/mastergo-community-verify.mjs', 'references/mastergo/community/manifest.json', 'references/mastergo/community/README.md', 'scripts/mastergo-source.mjs', 'scripts/mastergo-capture.mjs', 'scripts/mastergo-connection.mjs', 'scripts/mastergo-evidence.mjs', 'references/runtime-contract.md', 'references/mastergo/input-contract.md', 'references/mastergo/acquire.md', 'references/mastergo/convert.md', 'references/mastergo/mcp-setup.md', 'references/capabilities/hmos-d2a-mastergo-to-arkui/INSTRUCTIONS.md');
    paths.push(...catalog.stages.filter((stage) => stage.id >= 3).map((stage) => stage.reusesInstructionPath).filter(Boolean));
  }
  const normalized = paths.map((p) => p.replace(/\\/g, '/')).sort();
  const hash = createHash('sha256');
  for (const p of normalized) {
    const fullPath = join(skillRoot, p);
    if (!existsSync(fullPath)) {
      fail(`workflow digest: file does not exist: ${p}`);
    }
    hash.update(Buffer.from(p, 'utf8'));
    hash.update(Buffer.from([0]));
    hash.update(readFileSync(fullPath));
    hash.update(Buffer.from([0]));
  }
  return 'sha256:' + hash.digest('hex');
}

function validateState(state, catalog) {
  if (state.schemaVersion !== 2) {
    fail(`workflow-state schemaVersion must be 2, got ${state.schemaVersion}`);
  }
  if (state.workflowVersion !== 4) {
    fail(`workflow-state workflowVersion must be 4, got ${state.workflowVersion}; reinitialize this run`);
  }
  if (state.workflow !== catalog.workflow) {
    fail(`workflow-state.workflow mismatch: expected ${catalog.workflow}, got ${state.workflow}`);
  }
  if (state.variant !== catalog.variant) {
    fail(`workflow-state.variant mismatch: expected ${catalog.variant}, got ${state.variant}`);
  }
  const stateSource = state.designSource ?? 'pixso';
  const catalogSource = catalog.designSource ?? 'pixso';
  if (stateSource !== catalogSource) {
    fail(`workflow-state.designSource mismatch: expected ${catalogSource}, got ${stateSource}`);
  }
  if (typeof state.workflowDigest !== 'string' || state.workflowDigest.length === 0) {
    fail('workflow-state.workflowDigest is missing');
  }
  if (!Number.isInteger(state.currentStage) || state.currentStage < 1 || state.currentStage > catalog.stages.length) {
    fail(`workflow-state.currentStage must be an integer from 1 to ${catalog.stages.length}`);
  }
  if (!Array.isArray(state.completedStages)) {
    fail('workflow-state.completedStages must be an array');
  }
  for (const [index, value] of state.completedStages.entries()) {
    const expected = index + 1;
    if (value !== expected) {
      fail(`workflow-state.completedStages must be consecutive from 1; got ${value} at index ${index}, expected ${expected}`);
    }
  }
  if (state.completedStages.length !== state.currentStage - 1 && state.status !== 'completed') {
    fail(`workflow-state.completedStages length (${state.completedStages.length}) must equal currentStage - 1 (${state.currentStage - 1})`);
  }
  if (state.status === 'completed' && state.completedStages.length !== catalog.stages.length) {
    fail('workflow-state is completed but completedStages does not cover all stages');
  }
  const validStatuses = ['running', 'awaiting_confirmation', 'blocked', 'completed'];
  if (!validStatuses.includes(state.status)) {
    fail(`workflow-state.status must be one of ${validStatuses.join(', ')}, got ${state.status}`);
  }
  if (state.status === 'awaiting_confirmation') {
    if (state.awaitingConfirmationFor !== state.currentStage) {
      fail(`workflow-state.awaitingConfirmationFor must equal currentStage when awaiting_confirmation`);
    }
  }
  if (state.status === 'blocked' && (!state.blockedReasonCode || typeof state.blockedReasonCode !== 'string')) {
    fail('workflow-state.blockedReasonCode must be a non-empty string when status is blocked');
  }
  if (!Array.isArray(state.confirmedStages)) {
    fail('workflow-state.confirmedStages must be an array');
  }
  const confirmedSet = new Set(state.confirmedStages);
  if (confirmedSet.size !== state.confirmedStages.length) {
    fail('workflow-state.confirmedStages must not contain duplicates');
  }
  for (const stageId of state.confirmedStages) {
    if (!Number.isInteger(stageId) || stageId < 1 || stageId > catalog.stages.length) {
      fail(`workflow-state.confirmedStages contains invalid stage id: ${stageId}`);
    }
    if (!catalog.stages[stageId - 1].requiresConfirmation) {
      fail(`workflow-state.confirmedStages contains stage ${stageId} which does not require confirmation`);
    }
  }
  if (state.confirmationSnapshots !== undefined) {
    if (!state.confirmationSnapshots || typeof state.confirmationSnapshots !== 'object' || Array.isArray(state.confirmationSnapshots)) {
      fail('workflow-state.confirmationSnapshots must be an object');
    }
    for (const [stageKey, snapshot] of Object.entries(state.confirmationSnapshots)) {
      const stageId = Number(stageKey);
      if (
        !Number.isInteger(stageId) ||
        stageId < 1 ||
        stageId > catalog.stages.length ||
        !catalog.stages[stageId - 1].requiresConfirmation ||
        snapshot?.stage !== stageId ||
        !snapshot.files ||
        typeof snapshot.files !== 'object'
      ) {
        fail(`workflow-state.confirmationSnapshots contains invalid stage snapshot: ${stageKey}`);
      }
    }
  }
}

function checkDigest(state, catalog, skillRoot, catalogRelPath) {
  const currentDigest = computeWorkflowDigest(skillRoot, catalog, catalogRelPath);
  if (currentDigest !== state.workflowDigest) {
    return {
      mismatch: true,
      expected: state.workflowDigest,
      actual: currentDigest
    };
  }
  return { mismatch: false };
}

function deriveTodo(catalog, state) {
  return catalog.stages.map((stage) => {
    let status;
    if (state.status === 'completed') {
      status = 'completed';
    } else if (state.completedStages.includes(stage.id)) {
      status = 'completed';
    } else if (stage.id === state.currentStage) {
      status = 'in_progress';
    } else {
      status = 'pending';
    }
    return {
      content: stage.title,
      status,
      priority: 'high'
    };
  });
}

function writeTodoPayload(runDir, catalog, state) {
  const payload = {
    workflow: catalog.workflow,
    variant: catalog.variant,
    designSource: state.designSource ?? 'pixso',
    todos: deriveTodo(catalog, state)
  };
  writeJsonAtomic(join(runDir, 'todo-payload.json'), payload);
  return payload;
}

function checkCompletedGateIssues(runDir, catalog, stage, state, evidenceContext = {}) {
  const gate = readGate(runDir, stage);
  if (!gate) {
    return [`stage ${stage} gate is missing`];
  }
  if (!isPassed(gate)) {
    return [`stage ${stage} gate status must be passed, got ${gate.status}`];
  }
  if (Number(gate.stage) !== stage) {
    return [`stage ${stage} gate.stage must equal ${stage}`];
  }
  return [
    ...collectStageEvidenceIssues(runDir, catalog, stage, {
      ...evidenceContext,
      fidelityExempt: isCalibrationStageReached(catalog, state, runDir)
    }),
    ...(requiresPageStage2Confirmation(catalog, stage)
      ? collectPageStage2ConfirmationSnapshotIssues(runDir, catalog, state)
      : [])
  ];
}

// The calibration stage is allowed to adjust the implementation, so the
// stage-4 fidelity replay stops binding once the run has reached it. Without
// this, a calibration round that corrected a font size or a colour would be
// rejected by the replay of the already completed stage 4, and the run could
// only end by undoing the calibration. A run that explicitly disabled
// calibration must not get the exemption: there is no calibration to justify
// the drift.
function isCalibrationStageReached(catalog, state, runDir) {
  if ((catalog.designSource ?? 'pixso') !== 'others-visual' || catalog.variant !== 'full') {
    return false;
  }
  if (Number(state?.currentStage ?? 0) < 5) {
    return false;
  }
  const clarification = readJsonIfExistsQuietly(join(runDir, 'requirement-clarification.json'));
  return clarification?.visualCalibration?.enabled !== false;
}

function collectCompletedGateIssues(runDir, catalog, state, evidenceContext = {}) {
  return state.completedStages.flatMap((stage) => checkCompletedGateIssues(runDir, catalog, stage, state, evidenceContext));
}

function loadCatalogForVariant(skillRoot, variant, designSource = 'pixso') {
  if (!VALID_SOURCES.has(designSource)) {
    fail(`design source must be one of ${[...VALID_SOURCES].join(', ')}`);
  }
  const catalogRelPath = `references/${designSource}/stage-catalog-${variant}.json`;
  const catalogPath = join(skillRoot, catalogRelPath);
  const catalog = readJson(catalogPath, 'stage catalog');
  validateStageCatalog(catalog, variant, designSource, skillRoot);
  return { catalog, catalogRelPath };
}

function loadCatalogFromState(skillRoot, runDir) {
  const statePath = join(runDir, 'workflow-state.json');
  const state = readJson(statePath, 'workflow-state');
  if (!state.variant || !['full', 'fast'].includes(state.variant)) {
    fail('workflow-state.variant is missing or invalid');
  }
  const designSource = state.designSource ?? 'pixso';
  if (!VALID_SOURCES.has(designSource)) {
    fail('workflow-state.designSource is invalid');
  }
  const { catalog, catalogRelPath } = loadCatalogForVariant(skillRoot, state.variant, designSource);
  validateState(state, catalog);
  return { state, catalog, catalogRelPath, statePath };
}

function outputDigestError(state, catalog, digestResult) {
  process.stdout.write(`${JSON.stringify({
    workflow: catalog.workflow,
    variant: catalog.variant,
    designSource: state.designSource ?? 'pixso',
    status: state.status,
    currentStage: state.currentStage,
    error: 'workflow_digest_mismatch',
    message: 'Workflow instruction files have changed since initialization. Reinitialize this run to use the updated files.',
    expectedDigest: digestResult.expected,
    actualDigest: digestResult.actual
  }, null, 2)}\n`);
  process.exit(1);
}

function isCurrentStageConfirmed(state, catalog) {
  const stageInfo = catalog.stages[state.currentStage - 1];
  return stageInfo?.requiresConfirmation === true &&
    Array.isArray(state.confirmedStages) &&
    state.confirmedStages.includes(state.currentStage);
}

function confirmedStageNextAction(state, catalog) {
  if (!isCurrentStageConfirmed(state, catalog)) {
    return null;
  }
  return catalog.stages[state.currentStage - 1].confirmationContinuesStage === true
    ? 'resume_confirmed_stage'
    : 'stage_complete';
}

function checkPendingCurrentGate(runDir, state) {
  if (state.completedStages.includes(state.currentStage)) {
    return null;
  }
  const gate = readGate(runDir, state.currentStage);
  if (!gate) {
    return null;
  }
  if (Number(gate.stage) !== state.currentStage) {
    return { error: 'current_stage_gate_invalid', issues: [`gate.stage ${gate.stage} does not match currentStage ${state.currentStage}`] };
  }
  if (gate.status === 'passed') {
    return { completionResult: 'passed' };
  }
  if (gate.status === 'blocked') {
    if (!gate.reasonCode || !VALID_REASON_CODES.has(gate.reasonCode)) {
      return { error: 'current_stage_gate_invalid', issues: [`blocked gate has invalid reasonCode: ${gate.reasonCode}`] };
    }
    return { completionResult: 'blocked', reasonCode: gate.reasonCode };
  }
  return { error: 'current_stage_gate_invalid', issues: [`gate status ${gate.status} is not passed or blocked`] };
}

function deriveNextRequiredAction(state, catalog, runDir) {
  if (state.status === 'completed') {
    return 'sync_final_todo_then_finish';
  }
  if (state.status === 'blocked') {
    return 'resolve_blocking_issue';
  }
  if (state.status === 'awaiting_confirmation') {
    // A valid blocked gate for the current stage means a blocked write was
    // interrupted before the state advanced; replaying the blocked completion
    // takes precedence over resuming the confirmation question. Invalid gates
    // never reach here as an action: status fails earlier with
    // current_stage_gate_invalid.
    const pendingGate = checkPendingCurrentGate(runDir, state);
    if (pendingGate?.completionResult === 'blocked') {
      return 'stage_complete';
    }
    return 'resume_confirmation';
  }
  const pendingGate = checkPendingCurrentGate(runDir, state);
  if (pendingGate) {
    return 'stage_complete';
  }
  const confirmationAction = confirmedStageNextAction(state, catalog);
  if (confirmationAction) {
    return confirmationAction;
  }
  return 'stage_start';
}

function gateSemanticEquals(gate, stage, expectedStatus, expectedReasonCode) {
  if (Number(gate.stage) !== stage) {
    return false;
  }
  if (gate.status !== expectedStatus) {
    return false;
  }
  if (expectedStatus === 'blocked') {
    return gate.reasonCode === expectedReasonCode;
  }
  return true;
}

function buildCanonicalGate(stage, result, reasonCode, now) {
  const gate = {
    stage,
    status: result,
    completedAt: now,
  };
  if (result === 'blocked') {
    gate.reasonCode = reasonCode;
  }
  return gate;
}

const args = parseArgs(process.argv.slice(2));
const mode = args.mode;
if (!VALID_MODES.has(mode)) {
  fail(`--mode must be one of ${[...VALID_MODES].join(', ')}`);
}
if (!args['run-dir']) {
  fail('--run-dir is required');
}

const scriptPath = fileURLToPath(import.meta.url);
const skillRoot = dirname(dirname(scriptPath));
const runDir = isAbsolute(args['run-dir']) ? resolve(args['run-dir']) : resolve(process.cwd(), args['run-dir']);

if (mode === 'init') {
  const variant = args.variant;
  if (!['full', 'fast'].includes(variant)) {
    fail('--variant must be full or fast');
  }
  const designSource = args.source ?? 'pixso';
  if (!VALID_SOURCES.has(designSource)) {
    fail(`--source must be one of ${[...VALID_SOURCES].join(', ')}`);
  }
  const statePath = join(runDir, 'workflow-state.json');
  if (existsSync(statePath)) {
    fail('workflow-state.json already exists; refusing to overwrite. Use status to inspect or delete the run directory to reinitialize.');
  }
  const { catalog, catalogRelPath } = loadCatalogForVariant(skillRoot, variant, designSource);
  const digest = computeWorkflowDigest(skillRoot, catalog, catalogRelPath);
  mkdirSync(join(runDir, 'stage-gates'), { recursive: true });
  if (['figma', 'mastergo', 'lanhu'].includes(designSource)) {
    mkdirSync(join(runDir, 'source', designSource), { recursive: true });
  }
  const now = new Date().toISOString();
  const responseLanguage = args.language || 'zh-CN';
  const state = {
    schemaVersion: 2,
    workflowVersion: 4,
    workflow: catalog.workflow,
    variant,
    designSource,
    workflowDigest: digest,
    responseLanguage,
    currentStage: 1,
    completedStages: [],
    confirmedStages: [],
    confirmationSnapshots: {},
    status: 'running',
    awaitingConfirmationFor: null,
    blockedReasonCode: null,
    createdAt: now,
    updatedAt: now
  };
  writeJsonAtomic(statePath, state);
  writeTodoPayload(runDir, catalog, state);
  process.stdout.write(`${JSON.stringify({
    workflow: catalog.workflow,
    variant,
    designSource,
    status: 'running',
    currentStage: 1,
    nextRequiredAction: 'stage_start'
  }, null, 2)}\n`);
  process.exit(0);
}

if (!existsSync(runDir)) {
  fail(`run directory does not exist: ${runDir}`);
}

const { state, catalog, catalogRelPath, statePath } = loadCatalogFromState(skillRoot, runDir);

const digestResult = checkDigest(state, catalog, skillRoot, catalogRelPath);
if (digestResult.mismatch) {
  outputDigestError(state, catalog, digestResult);
}

// A new acquisition never mutates frozen inputs or inherits an old human confirmation.
if (state.reacquisition) {
  if (mode !== 'status') fail(`run superseded by reacquisition: ${state.reacquisition.runDir}`);
  process.stdout.write(`${JSON.stringify({ status: 'blocked', nextRequiredAction: 'continue_reacquisition', ...state.reacquisition }, null, 2)}\n`);
  process.exit(0);
}
if (mode === 'reacquire') {
  if (state.designSource !== 'mastergo' || state.currentStage !== 2 || !['running', 'awaiting_confirmation', 'blocked'].includes(state.status)) {
    fail('reacquire requires a MasterGo run in stage 2');
  }
  const reason = args.reason?.trim();
  if (!reason || reason.length > 1000) fail('--reason must explain the missing or changed design input (1–1000 characters)');
  const parent = realpathSync(dirname(runDir));
  const newRun = resolve(args['new-run-dir'] ?? runDir);
  // Compare both parents after resolving aliases such as macOS /tmp and /var.
  if (!statSync(dirname(newRun), { throwIfNoEntry: false })?.isDirectory() || realpathSync(dirname(newRun)) !== parent || !/^[a-zA-Z0-9_-]+$/.test(basename(newRun)) || newRun === realpathSync(runDir)) {
    fail('--new-run-dir must name a new sibling run using letters, digits, hyphens or underscores');
  }
  if (lstatSync(newRun, { throwIfNoEntry: false })) fail('reacquisition destination already exists');
  mkdirSync(newRun);
  const init = spawnSync(process.execPath, [scriptPath, '--mode', 'init', '--source', 'mastergo', '--variant', state.variant, '--language', state.responseLanguage ?? 'zh-CN', '--run-dir', newRun], { encoding: 'utf8' });
  if (init.status !== 0) {
    const detail = (init.error?.message || init.stderr?.trim() || `exit ${init.status ?? init.signal ?? 'unknown'}`).slice(-2000);
    try {
      // This directory did not exist before this invocation; discard only the failed new run.
      rmSync(newRun, { recursive: true });
    } catch (error) {
      fail(`unable to initialize reacquisition run (${detail}); original run is unchanged; unable to clean new run ${newRun} (${error.code})`);
    }
    fail(`unable to initialize reacquisition run (${detail}); original run is unchanged`);
  }
  const now = new Date().toISOString();
  const reacquisition = { runDir: newRun, reason, createdAt: now };
  writeJsonAtomic(join(newRun, 'reacquisition-origin.json'), { runDir: realpathSync(runDir), reason, createdAt: now });
  writeJsonAtomic(gatePath(runDir, 2), buildCanonicalGate(2, 'blocked', 'missing_asset', now));
  writeJsonAtomic(statePath, { ...state, status: 'blocked', awaitingConfirmationFor: null, blockedReasonCode: 'missing_asset', reacquisition, updatedAt: now });
  process.stdout.write(`${JSON.stringify({ status: 'running', currentStage: 1, nextRequiredAction: 'stage_start', ...reacquisition }, null, 2)}\n`);
  process.exit(0);
}

// Validation context derived once per invocation from the persisted state.
// stage2 describes how the current run relates to the run-index (see
// derivePageStage2IndexContext) so that completed-stage replays, interrupted
// recovery windows, and pre-commit checks each get the right strictness.
const evidenceContext = { stage2: derivePageStage2IndexContext(runDir, catalog, state) };

// Every non-init mode settles a pending design-doc recovery request before any
// gate validation or design-doc assessment runs.
checkPendingDesignDocRecovery(runDir, catalog, state);

if (mode === 'status') {
  // A blocked run must keep reporting its original blocker; a missing
  // design-doc.md in a completed stage is waived so it neither errors nor
  // triggers recovery. Other gate structure and non-doc evidence stay checked.
  const statusEvidenceContext = state.status === 'blocked'
    ? { ...evidenceContext, waiveDesignDocEvidence: true }
    : evidenceContext;
  const gateIssues = collectCompletedGateIssues(runDir, catalog, state, statusEvidenceContext);
  // For non-terminal states an invalid current-stage gate is an error, not a
  // nextRequiredAction. Checked once here for both Figma and Pixso so the
  // error always precedes confirmation-snapshot issues and todo writes.
  let statusPendingGate = null;
  if (state.status === 'running' || state.status === 'awaiting_confirmation') {
    statusPendingGate = checkPendingCurrentGate(runDir, state);
    if (statusPendingGate?.error) {
      process.stdout.write(`${JSON.stringify({
        workflow: catalog.workflow,
        variant: catalog.variant,
        designSource: state.designSource ?? 'pixso',
        status: state.status,
        currentStage: state.currentStage,
        error: statusPendingGate.error,
        issues: statusPendingGate.issues
      }, null, 2)}\n`);
      process.exit(1);
    }
  }
  // A pending blocked gate means the blocked write was interrupted before the
  // state advanced; replaying the blocked completion takes precedence over
  // every completed-stage evidence error below (including design-doc
  // recovery) so the state write can be completed first.
  const recoveringBlockedWrite = statusPendingGate?.completionResult === 'blocked';
  if (!recoveringBlockedWrite && state.status !== 'blocked') {
    // A completed doc stage with an invalid design-doc.md is assessed first so
    // recovery (or the explicit evidence-incomplete block) takes priority over
    // the generic completed-stage gate error below.
    const docStage = designDocStage(catalog);
    if (requiresDesignDocMissingGuard(catalog, docStage) && state.completedStages.includes(docStage)) {
      const assessment = assessDesignDocRecovery(runDir, catalog, state);
      if (assessment.outcome !== 'none') {
        outputDesignDocAssessment(runDir, catalog, state, assessment, { mode: 'status' });
        process.exit(1);
      }
    }
  }
  if (!recoveringBlockedWrite && gateIssues.length > 0) {
    process.stdout.write(`${JSON.stringify({
      workflow: catalog.workflow,
      variant: catalog.variant,
      designSource: state.designSource ?? 'pixso',
      status: state.status,
      currentStage: state.currentStage,
      error: 'completed_stage_gate_invalid',
      issues: gateIssues
    }, null, 2)}\n`);
    process.exit(1);
  }
  if (
    state.status === 'awaiting_confirmation' &&
    requiresDesignDocMissingGuard(catalog, state.currentStage) &&
    !recoveringBlockedWrite
  ) {
    const assessment = assessDesignDocRecovery(runDir, catalog, state);
    if (assessment.outcome !== 'none') {
      outputDesignDocAssessment(runDir, catalog, state, assessment, { mode: 'status' });
      process.exit(1);
    }
  }
  if (
    state.status === 'awaiting_confirmation' &&
    requiresPageStage2Confirmation(catalog, state.currentStage)
  ) {
    // Recovering an already-written blocked result must not depend on the
    // current stage's confirmation materials still being intact. Normal
    // confirmation waiting (and every passed path) keeps the snapshot check.
    // Invalid gates already failed above, so the gate error keeps priority
    // over missing or corrupted confirmation snapshots.
    if (!recoveringBlockedWrite) {
      const snapshotIssues = collectPageStage2ConfirmationSnapshotIssues(runDir, catalog, state);
      if (snapshotIssues.length > 0) {
        process.stdout.write(`${JSON.stringify({
          workflow: catalog.workflow,
          variant: catalog.variant,
          designSource: state.designSource ?? 'pixso',
          status: state.status,
          currentStage: state.currentStage,
          error: 'confirmation_snapshot_invalid',
          issues: snapshotIssues
        }, null, 2)}\n`);
        process.exit(1);
      }
    }
  }
  const payload = writeTodoPayload(runDir, catalog, state);
  const nextRequiredAction = deriveNextRequiredAction(state, catalog, runDir);
  const result = {
    workflow: catalog.workflow,
    variant: catalog.variant,
    designSource: state.designSource ?? 'pixso',
    status: state.status,
    currentStage: state.currentStage,
    completedStages: state.completedStages,
    awaitingConfirmationFor: state.awaitingConfirmationFor,
    blockedReasonCode: state.blockedReasonCode,
    nextRequiredAction
  };
  if (state.status === 'completed') {
    result.todoPayloadPath = join(runDir, 'todo-payload.json');
  }
  if (state.status === 'awaiting_confirmation') {
    result.instructionPath = catalog.stages[state.currentStage - 1].instructionPath;
  }
  if (nextRequiredAction === 'resume_confirmed_stage') {
    result.instructionPath = catalog.stages[state.currentStage - 1].instructionPath;
  }
  if (nextRequiredAction === 'stage_complete') {
    // Invalid gates already exited above with current_stage_gate_invalid; the
    // pending gate here is a valid one (or absent for a confirmed stage).
    if (statusPendingGate) {
      result.completionResult = statusPendingGate.completionResult;
      if (statusPendingGate.reasonCode) {
        result.reasonCode = statusPendingGate.reasonCode;
      }
    } else {
      result.completionResult = 'passed';
    }
  }
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  process.exit(0);
}

if (mode === 'stage-start') {
  const requestedStage = Number(args.stage);
  if (!Number.isInteger(requestedStage) || requestedStage < 1 || requestedStage > catalog.stages.length) {
    fail(`--stage must be an integer from 1 to ${catalog.stages.length}`);
  }
  const issues = collectCompletedGateIssues(runDir, catalog, state, evidenceContext);
  if (state.status === 'blocked') {
    issues.push(`workflow is blocked: ${state.blockedReasonCode}`);
  } else if (state.status === 'completed') {
    issues.push('workflow is already completed');
  } else if (state.status === 'awaiting_confirmation') {
    issues.push(`workflow is awaiting confirmation for stage ${state.awaitingConfirmationFor}`);
    if (requiresPageStage2Confirmation(catalog, requestedStage)) {
      issues.push(...collectPageStage2ConfirmationSnapshotIssues(runDir, catalog, state));
    }
  }
  if (state.status === 'running' && isCurrentStageConfirmed(state, catalog)) {
    const action = confirmedStageNextAction(state, catalog);
    issues.push(
      action === 'resume_confirmed_stage'
        ? `stage ${requestedStage} has been confirmed; resume the loaded stage without another stage-start`
        : `stage ${requestedStage} has been confirmed; call stage-complete --result passed`
    );
  }
  // Check pending current gate
  let pendingGateResult = null;
  if (state.status === 'running' && !state.completedStages.includes(requestedStage) && requestedStage === state.currentStage) {
    pendingGateResult = checkPendingCurrentGate(runDir, state);
    if (pendingGateResult?.error) {
      process.stdout.write(`${JSON.stringify({
        ready: false,
        error: pendingGateResult.error,
        stage: requestedStage,
        issues: pendingGateResult.issues
      }, null, 2)}\n`);
      process.exit(1);
    }
    if (pendingGateResult) {
      issues.push(`stage ${requestedStage} has a pending gate; call stage-complete --result ${pendingGateResult.completionResult}`);
    }
  }
  if (requestedStage !== state.currentStage) {
    issues.push(`requested stage ${requestedStage} differs from currentStage ${state.currentStage}`);
  }
  const uniqueIssues = [...new Set(issues)];
  const ready = uniqueIssues.length === 0;
  const docStage = designDocStage(catalog);
  const completedDocAssessment =
    requiresDesignDocMissingGuard(catalog, docStage) && state.completedStages.includes(docStage)
      ? assessDesignDocRecovery(runDir, catalog, state)
      : { outcome: 'none', issues: [] };
  const designDocRecoveryNeeded = completedDocAssessment.outcome === 'restore_document' ||
    completedDocAssessment.outcome === 'resume_design_generation';
  const designDocEvidenceIncomplete = completedDocAssessment.outcome === 'blocked_missing_upstream_evidence';
  // Priority: blocked-gate recovery > design-doc recovery > design-doc evidence
  // block > pending passed gate > confirmed-stage continuation > generic
  // issue resolution.
  let nextRequiredAction;
  if (ready) {
    nextRequiredAction = 'load_instruction_then_sync_todo_then_run_stage';
  } else if (pendingGateResult?.completionResult === 'blocked') {
    nextRequiredAction = 'stage_complete';
  } else if (designDocRecoveryNeeded) {
    nextRequiredAction = completedDocAssessment.outcome === 'restore_document'
      ? 'regenerate_design_doc'
      : 'resume_design_generation';
  } else if (designDocEvidenceIncomplete) {
    nextRequiredAction = 'resolve_issues';
  } else if (pendingGateResult) {
    nextRequiredAction = 'stage_complete';
  } else if (state.status === 'running' && isCurrentStageConfirmed(state, catalog)) {
    nextRequiredAction = confirmedStageNextAction(state, catalog);
  } else {
    nextRequiredAction = 'resolve_issues';
  }
  const result = {
    ready,
    nextRequiredAction,
    stage: requestedStage,
    designSource: state.designSource ?? 'pixso',
    title: catalog.stages[requestedStage - 1]?.title,
    requiresConfirmation: catalog.stages[requestedStage - 1]?.requiresConfirmation ?? false,
    issues: uniqueIssues
  };
  if (nextRequiredAction === 'regenerate_design_doc' || nextRequiredAction === 'resume_design_generation') {
    result.error = 'design_doc_invalid';
    result.recovery = prepareDesignDocRecovery(runDir, catalog, state, completedDocAssessment, {
      mode: 'stage-start',
      stage: requestedStage
    });
  }
  if (designDocEvidenceIncomplete && nextRequiredAction === 'resolve_issues') {
    result.error = 'design_stage_evidence_incomplete';
  }
  if (ready) {
    result.instructionPath = catalog.stages[requestedStage - 1].instructionPath;
    writeTodoPayload(runDir, catalog, state);
    result.todoPayloadPath = join(runDir, 'todo-payload.json');
  }
  if (pendingGateResult && !ready) {
    result.completionResult = pendingGateResult.completionResult;
    if (pendingGateResult.reasonCode) {
      result.reasonCode = pendingGateResult.reasonCode;
    }
  }
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  process.exit(0);
}

if (mode === 'confirm') {
  const requestedStage = Number(args.stage);
  if (!Number.isInteger(requestedStage) || requestedStage < 1 || requestedStage > catalog.stages.length) {
    fail(`--stage must be an integer from 1 to ${catalog.stages.length}`);
  }
  const decision = args.decision;
  if (!decision || !VALID_DECISIONS.has(decision)) {
    fail(`--decision must be one of ${[...VALID_DECISIONS].join(', ')}`);
  }
  if (requestedStage !== state.currentStage) {
    fail(`can only confirm the current stage ${state.currentStage}, got ${requestedStage}`);
  }
  const stageInfo = catalog.stages[requestedStage - 1];
  if (!stageInfo.requiresConfirmation) {
    fail(`stage ${requestedStage} does not require confirmation`);
  }
  // Checked before any evidence validation so a blocked (or otherwise
  // non-running) run can never be handed a design-doc recovery action.
  if (decision === 'request' && state.status !== 'running') {
    fail(`request decision requires status running, got ${state.status}`);
  }
  const gateIssues = collectCompletedGateIssues(runDir, catalog, state, evidenceContext);
  if (gateIssues.length > 0) {
    const docStage = designDocStage(catalog);
    if (requiresDesignDocMissingGuard(catalog, docStage) && state.completedStages.includes(docStage)) {
      const assessment = assessDesignDocRecovery(runDir, catalog, state);
      if (assessment.outcome !== 'none') {
        failWithDesignDocAssessment(
          runDir,
          catalog,
          state,
          assessment,
          { mode: 'confirm', stage: requestedStage, decision },
          `cannot confirm: completed stage gate issues: ${gateIssues.join('; ')}`
        );
      }
    }
    fail(`cannot confirm: completed stage gate issues: ${gateIssues.join('; ')}`);
  }
  let requestedConfirmationSnapshot = null;
  if (decision === 'request' && isPageStage2(catalog, requestedStage)) {
    // The HTML source has no recognition artifact to validate: the confirmable
    // evidence is the measured facts themselves, which must still belong to the
    // frozen input before they get locked into the snapshot. The screenshot
    // source has the same shape of guarantee one stage earlier: its recognition
    // and probe were validated at stage 1, so re-running the stage 1 collector
    // proves the frozen evidence still belongs to the current input.
    const evidenceIssues =
      catalog.designSource === 'others-html'
        ? collectOthersHtmlConfirmRequestIssues(runDir)
        : catalog.designSource === 'others-visual'
          ? collectOthersVisualStage1EvidenceIssues(runDir)
          : collectComponentRecognitionEvidenceIssues(runDir, catalog.designSource);
    if (catalog.designSource === 'mastergo') {
      evidenceIssues.push(...collectMasterGoStage2Issues(runDir, { proposal: true, variant: catalog.variant }));
    }
    if (catalog.designSource === 'lanhu') evidenceIssues.push(...collectLanhuConfirmationIssues(runDir));
    if (evidenceIssues.length > 0) {
      fail(`cannot request confirmation: ${evidenceIssues.join('; ')}`);
    }
    requestedConfirmationSnapshot = buildPageStage2ConfirmationSnapshot(runDir, catalog, evidenceIssues);
    if (evidenceIssues.length > 0) {
      fail(`cannot request confirmation: ${evidenceIssues.join('; ')}`);
    }
  }
  if (decision === 'request' && requiresDesignDocMissingGuard(catalog, requestedStage)) {
    const assessment = assessDesignDocRecovery(runDir, catalog, state);
    if (assessment.outcome !== 'none') {
      failWithDesignDocAssessment(
        runDir,
        catalog,
        state,
        assessment,
        { mode: 'confirm', stage: requestedStage, decision: 'request' },
        `cannot request confirmation: ${assessment.issues.join('; ')}`
      );
    }
  }
  const now = new Date().toISOString();
  let newState;
  if (decision === 'request') {
    newState = {
      ...state,
      status: 'awaiting_confirmation',
      awaitingConfirmationFor: requestedStage,
      ...(requestedConfirmationSnapshot && {
        confirmationSnapshots: {
          ...(state.confirmationSnapshots ?? {}),
          [String(requestedStage)]: requestedConfirmationSnapshot
        }
      }),
      updatedAt: now
    };
  } else if (decision === 'accepted') {
    if (state.status !== 'awaiting_confirmation') {
      fail(`accepted decision requires status awaiting_confirmation, got ${state.status}`);
    }
    if (state.awaitingConfirmationFor !== requestedStage) {
      fail(`awaitingConfirmationFor (${state.awaitingConfirmationFor}) does not match requested stage (${requestedStage})`);
    }
    if (isPageStage2(catalog, requestedStage)) {
      const snapshotIssues = collectPageStage2ConfirmationSnapshotIssues(runDir, catalog, state);
      if (catalog.designSource === 'lanhu') snapshotIssues.push(...collectLanhuConfirmationIssues(runDir));
      if (snapshotIssues.length > 0) {
        fail(`cannot accept confirmation: ${snapshotIssues.join('; ')}`);
      }
    }
    if (requiresDesignDocMissingGuard(catalog, requestedStage)) {
      const assessment = assessDesignDocRecovery(runDir, catalog, state);
      if (assessment.outcome !== 'none') {
        failWithDesignDocAssessment(
          runDir,
          catalog,
          state,
          assessment,
          { mode: 'confirm', stage: requestedStage, decision: 'accepted' },
          `cannot accept confirmation: ${assessment.issues.join('; ')}`
        );
      }
    }
    const confirmedStages = Array.isArray(state.confirmedStages) ? [...state.confirmedStages] : [];
    if (!confirmedStages.includes(requestedStage)) {
      confirmedStages.push(requestedStage);
    }
    newState = {
      ...state,
      status: 'running',
      awaitingConfirmationFor: null,
      confirmedStages,
      updatedAt: now
    };
  } else if (decision === 'revision-requested') {
    if (state.status !== 'awaiting_confirmation') {
      fail(`revision-requested decision requires status awaiting_confirmation, got ${state.status}`);
    }
    if (state.awaitingConfirmationFor !== requestedStage) {
      fail(`awaitingConfirmationFor (${state.awaitingConfirmationFor}) does not match requested stage (${requestedStage})`);
    }
    const confirmedStages = Array.isArray(state.confirmedStages) ? state.confirmedStages.filter((s) => s !== requestedStage) : [];
    const confirmationSnapshots = { ...(state.confirmationSnapshots ?? {}) };
    if (isPageStage2(catalog, requestedStage)) {
      delete confirmationSnapshots[String(requestedStage)];
    }
    newState = {
      ...state,
      status: 'running',
      awaitingConfirmationFor: null,
      confirmedStages,
      confirmationSnapshots,
      updatedAt: now
    };
  }
  writeJsonAtomic(statePath, newState);
  writeTodoPayload(runDir, catalog, newState);
  const confirmNextAction = decision === 'request'
    ? 'await_user_confirmation'
    : decision === 'accepted'
      ? stageInfo.confirmationContinuesStage === true
        ? 'resume_confirmed_stage'
        : 'stage_complete'
      : 'stage_start';
  process.stdout.write(`${JSON.stringify({
    status: newState.status,
    currentStage: newState.currentStage,
    decision,
    nextRequiredAction: confirmNextAction,
    ...(confirmNextAction === 'resume_confirmed_stage'
      ? { instructionPath: stageInfo.instructionPath }
      : {})
  }, null, 2)}\n`);
  process.exit(0);
}

if (mode === 'stage-complete') {
  const requestedStage = Number(args.stage);
  if (!Number.isInteger(requestedStage) || requestedStage < 1 || requestedStage > catalog.stages.length) {
    fail(`--stage must be an integer from 1 to ${catalog.stages.length}`);
  }
  const result = args.result;
  if (!result || !VALID_RESULTS.has(result)) {
    fail(`--result must be one of ${[...VALID_RESULTS].join(', ')}`);
  }
  const reasonCode = args['reason-code'];
  if (result === 'passed' && reasonCode) {
    fail('--result=passed must not include --reason-code');
  }
  if (result === 'blocked') {
    if (!reasonCode || !VALID_REASON_CODES.has(reasonCode)) {
      fail(`--reason-code must be one of ${[...VALID_REASON_CODES].join(', ')} when --result=blocked`);
    }
  }

  // Idempotent replay: already completed stage
  if (state.completedStages.includes(requestedStage)) {
    if (result !== 'passed') {
      fail(`stage ${requestedStage} is already completed; only result=passed replay is allowed`);
    }
    // Full validation including gate structure and special evidence
    const replayIssues = checkCompletedGateIssues(runDir, catalog, requestedStage, state, evidenceContext);
    if (replayIssues.length > 0) {
      if (requiresDesignDocMissingGuard(catalog, requestedStage)) {
        const assessment = assessDesignDocRecovery(runDir, catalog, state);
        if (assessment.outcome !== 'none') {
          failWithDesignDocAssessment(
            runDir,
            catalog,
            state,
            assessment,
            stageCompleteRetry(requestedStage, 'passed'),
            `stage ${requestedStage} replay validation failed: ${replayIssues.join('; ')}`
          );
        }
      }
      fail(`stage ${requestedStage} replay validation failed: ${replayIssues.join('; ')}`);
    }
    writeTodoPayload(runDir, catalog, state);
    const nextRequiredAction = deriveNextRequiredAction(state, catalog, runDir);
    const replayResult = {
      alreadyCompleted: true,
      status: state.status,
      currentStage: state.currentStage,
      completedStages: state.completedStages,
      nextRequiredAction
    };
    if (state.status === 'completed') {
      replayResult.todoPayloadPath = join(runDir, 'todo-payload.json');
    }
    process.stdout.write(`${JSON.stringify(replayResult, null, 2)}\n`);
    process.exit(0);
  }

  // Reject impossible stage requests
  if (requestedStage !== state.currentStage) {
    if (requestedStage > state.currentStage) {
      fail(`cannot complete future stage ${requestedStage}; current stage is ${state.currentStage}`);
    }
    fail(`cannot complete stage ${requestedStage}; current stage is ${state.currentStage}`);
  }
  if (state.status === 'blocked') {
    fail(`workflow is blocked: ${state.blockedReasonCode}; reinitialize the run before continuing`);
  }
  if (state.status === 'completed') {
    fail('workflow is already completed');
  }
  if (result === 'passed' && state.status === 'awaiting_confirmation') {
    fail(`stage ${requestedStage} is still awaiting confirmation; call confirm first`);
  }

  // A consistent blocked gate on disk means the blocked write was interrupted
  // before the state advanced. Replaying it must not be blocked by completed
  // stage design-doc recovery; only the stage, status and reasonCode still
  // have to match, and the gate consistency check below enforces that.
  const existingCurrentGate = readGate(runDir, requestedStage);
  const replayingBlockedWrite =
    result === 'blocked' &&
    existingCurrentGate?.status === 'blocked' &&
    Number(existingCurrentGate.stage) === requestedStage &&
    existingCurrentGate.reasonCode === reasonCode;

  // Validate completed stage gates
  const gateIssues = collectCompletedGateIssues(runDir, catalog, state, {
    ...evidenceContext,
    waiveDesignDocEvidence: replayingBlockedWrite
  });
  if (gateIssues.length > 0) {
    const docStage = designDocStage(catalog);
    if (
      !replayingBlockedWrite &&
      requiresDesignDocMissingGuard(catalog, docStage) &&
      state.completedStages.includes(docStage)
    ) {
      const assessment = assessDesignDocRecovery(runDir, catalog, state);
      if (assessment.outcome !== 'none') {
        failWithDesignDocAssessment(
          runDir,
          catalog,
          state,
          assessment,
          stageCompleteRetry(requestedStage, result, reasonCode),
          `cannot complete: completed stage gate issues: ${gateIssues.join('; ')}`
        );
      }
    }
    fail(`cannot complete: completed stage gate issues: ${gateIssues.join('; ')}`);
  }

  // Validate confirmation if required — the confirmation requirement only
  // constrains passing the stage; blocked may be recorded from any non-terminal
  // state, including before or during confirmation.
  const stageInfo = catalog.stages[requestedStage - 1];
  if (result === 'passed' && stageInfo.requiresConfirmation) {
    const confirmedStages = Array.isArray(state.confirmedStages) ? state.confirmedStages : [];
    if (!confirmedStages.includes(requestedStage)) {
      fail(`stage ${requestedStage} requires confirmation but has not been confirmed`);
    }
  }

  // Source-specific Full workflow evidence validation.
  if (result === 'passed') {
    const evidenceIssues = [
      ...collectStageEvidenceIssues(runDir, catalog, requestedStage, { ...evidenceContext, live: true }),
      ...(requiresPageStage2Confirmation(catalog, requestedStage)
        ? collectPageStage2ConfirmationSnapshotIssues(runDir, catalog, state)
        : [])
    ];
    if (requiresDesignDocMissingGuard(catalog, requestedStage)) {
      const assessment = assessDesignDocRecovery(runDir, catalog, state);
      if (assessment.outcome !== 'none') {
        failWithDesignDocAssessment(
          runDir,
          catalog,
          state,
          assessment,
          stageCompleteRetry(requestedStage, result),
          evidenceIssues.join('; ')
        );
      }
    }
    if (evidenceIssues.length > 0) {
      fail(evidenceIssues.join('; '));
    }
  }

  const now = new Date().toISOString();
  const canonicalGate = buildCanonicalGate(requestedStage, result, reasonCode, now);

  // Check for existing gate conflicts
  const existingGate = existingCurrentGate;
  if (existingGate) {
    if (gateSemanticEquals(existingGate, requestedStage, result, reasonCode)) {
      // Consistent gate from interrupted write — keep original completedAt, proceed to state
      canonicalGate.completedAt = existingGate.completedAt;
    } else {
      process.stdout.write(`${JSON.stringify({
        error: 'gate_result_conflict',
        stage: requestedStage,
        existingStatus: existingGate.status,
        existingReasonCode: existingGate.reasonCode,
        requestedResult: result,
        requestedReasonCode: reasonCode
      }, null, 2)}\n`);
      process.exit(1);
    }
  }

  writeJsonAtomic(gatePath(runDir, requestedStage), canonicalGate);

  if (
    result === 'passed' &&
    requestedStage === 2 &&
    ['others-html', 'others-visual'].includes(catalog.designSource ?? 'pixso')
  ) {
    updateGeneratedUiRunIndex(runDir, catalog.variant ?? 'full', catalog.designSource ?? 'others-html');
  }

  if (result === 'passed' && isPageStage2(catalog, requestedStage)) {
    const policy = readJsonOrNull(join(runDir, PAGE_STAGE2_STARTUP_POLICY), 'stage 2 startup page policy', []);
    if (policy) {
      const projectRoot = resolveLockedProjectRoot(
        runDir,
        policy.projectRootPath,
        'stage 2 startup page policy projectRootPath',
        []
      );
      if (projectRoot) {
        updateRunIndex(runDir, projectRoot, policy, catalog.designSource);
      }
    }
  }

  if (result === 'blocked') {
    const newState = {
      ...state,
      status: 'blocked',
      blockedReasonCode: reasonCode,
      awaitingConfirmationFor: null,
      updatedAt: now
    };
    writeJsonAtomic(statePath, newState);
    writeTodoPayload(runDir, catalog, newState);
    process.stdout.write(`${JSON.stringify({
      status: 'blocked',
      currentStage: newState.currentStage,
      blockedReasonCode: reasonCode,
      nextRequiredAction: 'resolve_blocking_issue'
    }, null, 2)}\n`);
    process.exit(0);
  }

  // result === 'passed'
  const completedStages = [...state.completedStages, requestedStage];
  const isLastStage = requestedStage === catalog.stages.length;
  const newState = {
    ...state,
    completedStages,
    currentStage: isLastStage ? requestedStage : requestedStage + 1,
    status: isLastStage ? 'completed' : 'running',
    updatedAt: now
  };
  writeJsonAtomic(statePath, newState);
  writeTodoPayload(runDir, catalog, newState);
  if (isLastStage) {
    process.stdout.write(`${JSON.stringify({
      status: 'completed',
      currentStage: newState.currentStage,
      completedStages: newState.completedStages,
      nextRequiredAction: 'sync_final_todo_then_finish',
      todoPayloadPath: join(runDir, 'todo-payload.json')
    }, null, 2)}\n`);
  } else {
    process.stdout.write(`${JSON.stringify({
      status: 'running',
      currentStage: newState.currentStage,
      completedStages: newState.completedStages,
      nextRequiredAction: 'stage_start'
    }, null, 2)}\n`);
  }
  process.exit(0);
}
