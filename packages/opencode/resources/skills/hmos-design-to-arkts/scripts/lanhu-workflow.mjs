import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readFileSync, statSync } from 'node:fs';
import { isAbsolute, relative, resolve, sep } from 'node:path';

export const LANHU_RUN_STATE = 'stage2/hmos-d2a-lanhu-to-arkui-run.json';
export const LANHU_USER_ASSETS = 'source/user-assets/manifest.json';
export const LANHU_INPUT_FILES = [
  'source/lanhu/target-page-identity.json',
  'source/lanhu/design-context.json',
  'source/lanhu/node-index.json',
  'source/lanhu/region-index.json',
  'source/lanhu/screenshots-manifest.json',
  'source/lanhu/overview-response.json',
  'source/lanhu/reference.png',
  'source/lanhu/component-recognition.png'
];

export function collectLanhuInputIssues(runDir) {
  const issues = [];
  const files = Object.fromEntries(
    LANHU_INPUT_FILES.filter((file) => file.endsWith('.json')).map((file) => [file, json(runDir, file, issues)])
  );
  const identity = files[LANHU_INPUT_FILES[0]];
  const context = files[LANHU_INPUT_FILES[1]];
  const nodes = files[LANHU_INPUT_FILES[2]];
  const regions = files[LANHU_INPUT_FILES[3]];
  const shots = files[LANHU_INPUT_FILES[4]];
  const overview = files[LANHU_INPUT_FILES[5]];
  const clarification = json(runDir, 'requirement-clarification.json', issues);
  const manifest = json(runDir, 'inputs-manifest.json', issues);
  const security = json(runDir, 'input-security-report.json', issues);
  if (!identity || !context || !nodes || !regions || !shots || !overview) return issues;
  if (
    identity.designSource !== 'lanhu' ||
    !id(identity.snapshotId) ||
    !string(identity.resolvedVersion) ||
    !string(identity.designId) ||
    !string(identity.projectId) ||
    !string(identity.mcpServerName)
  )
    issues.push('Lanhu target identity is invalid');
  if (
    context.producer?.script !== 'lanhu-capture.mjs' ||
    context.producer?.implementation !== 'dsphper/lanhu-mcp' ||
    JSON.stringify(context.identity) !== JSON.stringify(identity)
  )
    issues.push('Lanhu context producer or identity is invalid');
  if (
    overview.snapshot_id !== identity.snapshotId ||
    overview.resolved_version !== identity.resolvedVersion ||
    overview.design_id !== identity.designId ||
    overview.status !== 'complete'
  )
    issues.push('Lanhu overview does not match the locked design version');
  if (
    context.coordinateSpace !== 'source_canvas' ||
    context.coordinateMapping?.verified !== true ||
    !positive(context.canvas?.width) ||
    !positive(context.canvas?.height)
  )
    issues.push('Lanhu canvas coordinate mapping must be verified');
  if (
    clarification?.acquisitionMethod !== 'lanhu-link' ||
    !['lanhu-mcp-bundle', 'developer-provided'].includes(clarification?.assetProvisionMode) ||
    clarification?.targetPage?.pageId !== identity.designId ||
    clarification?.lanhuSource?.snapshotId !== identity.snapshotId ||
    clarification?.lanhuSource?.resolvedVersion !== identity.resolvedVersion ||
    clarification?.lanhuSource?.mcpServerName !== identity.mcpServerName
  )
    issues.push('Lanhu requirement clarification does not match the locked source');
  if (
    security?.status !== 'passed' ||
    security?.checks?.paths !== true ||
    security?.checks?.files !== true ||
    security?.checks?.untrustedContent !== true ||
    !Array.isArray(manifest?.missingInputs) ||
    manifest.missingInputs.length !== 0
  )
    issues.push('Lanhu input security and missingInputs checks must pass');
  for (const file of LANHU_INPUT_FILES) {
    const recorded = Array.isArray(manifest?.lanhuInputs)
      ? manifest.lanhuInputs.find((item) => item?.path === file)
      : null;
    if (!recorded || !checkHash(runDir, file, recorded.sha256, issues))
      issues.push(`Lanhu inputs manifest must lock ${file}`);
  }
  if (clarification?.assetProvisionMode === 'developer-provided') collectUserAssets(runDir, identity, manifest, issues);
  if (
    nodes.snapshotId !== identity.snapshotId ||
    nodes.complete !== true ||
    !Array.isArray(nodes.nodes) ||
    nodes.total !== nodes.nodes.length ||
    context.nodeIndex?.complete !== true ||
    context.nodeIndex?.count !== nodes.total
  )
    issues.push('Lanhu node index is incomplete');
  const nodeIDs = Array.isArray(nodes.nodes) ? nodes.nodes.map((node) => node?.node_id) : [];
  if (nodeIDs.some((node) => !string(node)) || new Set(nodeIDs).size !== nodeIDs.length)
    issues.push('Lanhu node IDs must be present and distinct');
  const pages = Array.isArray(regions.queries)
    ? regions.queries.filter((query) => query?.fullCanvas === true).sort((a, b) => a.offset - b.offset)
    : [];
  const coverage = { offset: 0, complete: false, nodes: [] };
  for (const page of pages) {
    if (coverage.complete) continue;
    if (
      page.offset !== coverage.offset ||
      !string(page.responsePath) ||
      !page.responsePath.startsWith('source/lanhu/regions/')
    ) {
      issues.push('Lanhu node pagination has a gap or invalid path');
      continue;
    }
    checkHash(runDir, page.responsePath, page.responseSha256, issues);
    const response = json(runDir, page.responsePath, issues);
    if (
      !response ||
      response.snapshot_id !== identity.snapshotId ||
      response.resolved_version !== identity.resolvedVersion ||
      response.total !== nodes.total ||
      response.coordinate_mapping?.verified !== true ||
      response.coordinate_space !== 'source_canvas' ||
      JSON.stringify(response.canvas) !== JSON.stringify(overview.canvas) ||
      !Array.isArray(response.nodes) ||
      response.returned !== response.nodes.length
    ) {
      issues.push('Lanhu paginated response has inconsistent identity or count');
      continue;
    }
    coverage.nodes.push(...response.nodes);
    coverage.complete = response.truncated === false && response.next_offset === null;
    if (!coverage.complete && (!Number.isInteger(response.next_offset) || response.next_offset <= coverage.offset))
      issues.push('Lanhu pagination does not advance');
    coverage.offset = response.next_offset;
  }
  if (!coverage.complete || JSON.stringify(coverage.nodes) !== JSON.stringify(nodes.nodes))
    issues.push('Lanhu node index does not match complete source pagination');
  for (const [key, file] of [
    ['reference', 'source/lanhu/reference.png'],
    ['componentRecognition', 'source/lanhu/component-recognition.png']
  ]) {
    const image = shots[key];
    const full = evidencePath(runDir, file, issues);
    if (
      !image ||
      image.path !== file ||
      shots.snapshotId !== identity.snapshotId ||
      !positive(image.width) ||
      !positive(image.height) ||
      !positive(image.scale?.x) ||
      !positive(image.scale?.y) ||
      !positive(image.sourceRegion?.width) ||
      !positive(image.sourceRegion?.height)
    ) {
      issues.push(`Lanhu ${key} screenshot mapping is invalid`);
      continue;
    }
    checkHash(runDir, file, image.sha256, issues);
    if (!full || !existsSync(full)) continue;
    const bytes = readFileSync(full);
    if (
      bytes.length < 33 ||
      bytes.length !== image.size ||
      bytes.toString('hex', 0, 8) !== '89504e470d0a1a0a' ||
      bytes.readUInt32BE(16) !== image.width ||
      bytes.readUInt32BE(20) !== image.height
    )
      issues.push(`Lanhu ${key} screenshot bytes differ from metadata`);
    if (
      Math.abs(image.width - image.sourceRegion.width * image.scale.x) > 1 ||
      Math.abs(image.height - image.sourceRegion.height * image.scale.y) > 1
    )
      issues.push(`Lanhu ${key} screenshot scale is inconsistent`);
    if (image.sourceRegion.width !== context.canvas.width || image.sourceRegion.height !== context.canvas.height)
      issues.push(`Lanhu ${key} must cover the selected full canvas`);
  }
  return issues;
}

export function collectLanhuStage2Issues(runDir, variant = 'fast') {
  const issues = collectLanhuAssetIssues(runDir);
  const state = json(runDir, LANHU_RUN_STATE, issues);
  if (state?.phase !== 'completed' || !string(state?.invocationId))
    issues.push('Lanhu stage 2 run state must record a completed invocation');
  if (variant === 'full') {
    if (state?.confirmationPolicy !== 'manual') issues.push('Lanhu Full requires manual confirmation policy');
    const confirmation = json(runDir, 'stage2/component-confirmation.json', issues);
    if (confirmation?.decision !== 'accepted' || confirmation?.invocationId !== state?.invocationId)
      issues.push('Lanhu Full component confirmation must accept the current invocation');
  }
  for (const file of LANHU_INPUT_FILES) checkHash(runDir, file, state?.inputs?.[file], issues);
  if (existsSync(resolve(runDir, LANHU_USER_ASSETS))) checkHash(runDir, LANHU_USER_ASSETS, state?.inputs?.[LANHU_USER_ASSETS], issues);
  for (const file of [
    'stage2/project-analysis.md',
    'stage2/component-analysis.md',
    'component-tree.md',
    'system-ui-policy.json',
    'viewport-boundary-spec.json'
  ])
    evidencePath(runDir, file, issues, true);
  return issues;
}

// Confirmation validates the proposal, not implementation/build outputs. This
// is deliberately separate from the final stage 2 gate, which runs after the
// user accepts and the same capability resumes implementing.
export function collectLanhuConfirmationIssues(runDir) {
  const issues = [];
  const state = json(runDir, LANHU_RUN_STATE, issues);
  if (state?.phase !== 'awaiting_confirmation' || state?.confirmationPolicy !== 'manual' || !string(state?.invocationId))
    issues.push('Lanhu Full confirmation requires an awaiting_confirmation checkpoint and manual policy');
  for (const file of LANHU_INPUT_FILES) checkHash(runDir, file, state?.inputs?.[file], issues);
  if (existsSync(resolve(runDir, LANHU_USER_ASSETS))) checkHash(runDir, LANHU_USER_ASSETS, state?.inputs?.[LANHU_USER_ASSETS], issues);
  for (const file of ['stage2/project-analysis.md', 'stage2/component-analysis.md', 'component-tree.md', 'design-doc.md'])
    evidencePath(runDir, file, issues, true);
  for (const file of ['system-ui-policy.json', 'viewport-boundary-spec.json']) json(runDir, file, issues);
  const identity = json(runDir, 'source/lanhu/target-page-identity.json', issues);
  const selection = json(runDir, 'stage2/asset-selection.json', issues);
  if (selection?.snapshotId !== identity?.snapshotId || !Array.isArray(selection?.assetIds) ||
      selection.assetIds.some((asset) => !string(asset)) || new Set(selection.assetIds).size !== selection.assetIds.length ||
      (!selection.assetIds.length && !string(selection.emptyReason)))
    issues.push('Lanhu confirmation requires an explicit resource plan for the locked snapshot');
  const ledger = json(runDir, 'capability-invocation-ledger.json', issues, true);
  const invocations = Array.isArray(ledger) ? ledger : ledger?.invocations;
  if (!Array.isArray(invocations) || !invocations.some((entry) =>
    (entry?.capability ?? entry?.skill ?? entry?.skillName) === 'hmos-d2a-solution-design' &&
    entry.status === 'completed' && entry.invocationId === state?.invocationId))
    issues.push('Lanhu confirmation requires completed Solution Design for the current invocation');
  return issues;
}

export function collectLanhuAssetIssues(runDir) {
  const issues = [];
  const identity = json(runDir, 'source/lanhu/target-page-identity.json', issues);
  const selection = json(runDir, 'stage2/asset-selection.json', issues);
  const bindings = json(runDir, 'stage2/asset-bindings.json', issues);
  const delivery = json(runDir, 'stage2/asset-delivery.json', issues);
  const manifest = json(runDir, 'inputs-manifest.json', issues);
  const clarification = json(runDir, 'requirement-clarification.json', issues);
  if (!identity || !selection || !bindings || !delivery || !manifest) return issues;
  if ([selection, bindings, delivery].some((item) => item.snapshotId !== identity.snapshotId))
    issues.push('Lanhu asset evidence belongs to another snapshot');
  if (
    !Array.isArray(selection.assetIds) ||
    new Set(selection.assetIds).size !== selection.assetIds.length ||
    selection.assetIds.some((asset) => !string(asset)) ||
    !Array.isArray(bindings.assets) ||
    bindings.assets.some((item) => !record(item)) ||
    !Array.isArray(delivery.bundles) ||
    delivery.bundles.some((item) => !record(item))
  )
    return [...issues, 'Lanhu asset evidence lists are invalid'];
  if (!selection.assetIds.length) {
    if (clarification?.assetProvisionMode === 'developer-provided') issues.push('Supplied images require explicit nonempty selection and bindings');
    if (bindings.assets.length || delivery.bundles.length || !string(selection.emptyReason))
      issues.push('A resource-free page requires empty bindings/bundles and a documented reason');
    return issues;
  }
  const installed = [];
  if (clarification?.assetProvisionMode === 'developer-provided') {
    if (delivery.bundles.length || delivery.provenance !== 'developer-provided' || selection.provenance !== 'developer-provided')
      issues.push('User-supplied images must not be represented as MCP bundles');
    const supplied = collectUserAssets(runDir, identity, manifest, issues);
    checkHash(runDir, LANHU_USER_ASSETS, delivery.userAssets?.sha256, issues);
    if (delivery.userAssets?.path !== LANHU_USER_ASSETS) issues.push('User asset delivery must reference the locked import');
    installed.push(...supplied.map((asset) => ({ ...asset, selectedId: asset.assetId })));
    if (supplied.some((asset) => !selection.assetIds.includes(asset.assetId))) issues.push('Every supplied image must have an explicit selection');
  }
  if (clarification?.assetProvisionMode !== 'developer-provided' && (delivery.provenance === 'developer-provided' || manifest.userAssets))
    issues.push('User assets require an explicit developer-provided input mode');
  for (const bundle of delivery.bundles) {
    if (!id(bundle?.bundleId)) {
      issues.push('Invalid Lanhu bundle identity');
      continue;
    }
    const prefix = `source/lanhu/delivery/${bundle.bundleId}`;
    const verified = json(runDir, `${prefix}/verified.json`, issues);
    const receipt = json(runDir, `${prefix}/install-receipt.json`, issues);
    const exported = json(runDir, `source/lanhu/exports/${bundle.bundleId}/export-response.json`, issues);
    if (!verified || !receipt || !exported) continue;
    checkHash(runDir, `${prefix}/verified.json`, bundle.sha256, issues);
    checkHash(runDir, `${prefix}/install-receipt.json`, verified.receiptSha256, issues);
    if (
      receipt.status !== 'complete' ||
      exported.status !== 'complete' ||
      !Array.isArray(exported.failed) ||
      exported.failed.length ||
      receipt.snapshot_id !== identity.snapshotId ||
      receipt.resolved_version !== identity.resolvedVersion ||
      verified.snapshotId !== identity.snapshotId ||
      receipt.bundle_id !== bundle.bundleId ||
      verified.bundleId !== bundle.bundleId ||
      !Array.isArray(verified.assets) ||
      !Array.isArray(receipt.assets) ||
      !Array.isArray(exported.assets) ||
      verified.assets.some((item) => !record(item)) ||
      receipt.assets.some((item) => !record(item)) ||
      exported.assets.some((item) => !record(item)) ||
      verified.producer?.script !== 'lanhu-capture.mjs' ||
      verified.assets.length !== receipt.assets.length ||
      verified.assets.length !== exported.assets.length
    ) {
      issues.push('Lanhu bundle delivery is incomplete or mismatched');
      continue;
    }
    for (const asset of verified.assets) {
      const source = exported.assets.find((item) => item.asset_id === asset.assetId);
      const entry = receipt.assets.find((item) => item.asset_id === asset.assetId);
      if (
        !source ||
        !entry ||
        entry.sha256 !== asset.sha256 ||
        source.sha256 !== asset.sha256 ||
        source.node_id !== asset.nodeId ||
        entry.node_id !== asset.nodeId ||
        source.bytes !== asset.size ||
        entry.bytes !== asset.size ||
        !string(asset.path) ||
        !asset.path.startsWith(prefix + '/assets/')
      ) {
        issues.push('Lanhu installed asset does not match export and receipt');
        continue;
      }
      checkHash(runDir, asset.path, asset.sha256, issues);
      installed.push({ ...asset, selectedId: source.base_asset_id ?? source.asset_id });
    }
  }
  for (const selected of selection.assetIds)
    if (!installed.some((asset) => asset.selectedId === selected))
      issues.push(`Selected Lanhu asset was not installed: ${selected}`);
  if (bindings.assets.length !== installed.length)
    issues.push('Lanhu resource bindings must cover every installed asset');
  const projectRoot = manifest.integrationSnapshot?.projectRootPath;
  if (!string(projectRoot)) return [...issues, 'Lanhu resource bindings require a locked project root'];
  for (const binding of bindings.assets) {
    const asset = installed.find((item) => item.assetId === binding.assetId);
    if (
      !asset ||
      binding.sourcePath !== asset.path ||
      binding.sha256 !== asset.sha256 ||
      binding.nodeId !== asset.nodeId
    ) {
      issues.push('Lanhu resource binding does not match installed evidence');
      continue;
    }
    checkHash(resolve(runDir, projectRoot), binding.projectPath, binding.sha256, issues);
  }
  if (new Set(bindings.assets.map((asset) => asset.assetId)).size !== bindings.assets.length)
    issues.push('Lanhu asset bindings contain duplicate IDs');
  return issues;
}

export function collectLanhuRecoveryIssues(runDir, restoreDocument) {
  const issues = collectLanhuInputIssues(runDir);
  const state = json(runDir, LANHU_RUN_STATE, issues);
  if (!string(state?.invocationId) || !['analyzing', 'implementing', 'validating', 'completed'].includes(state?.phase))
    issues.push('Lanhu design recovery requires an existing safe checkpoint');
  for (const file of LANHU_INPUT_FILES) checkHash(runDir, file, state?.inputs?.[file], issues);
  if (existsSync(resolve(runDir, LANHU_USER_ASSETS))) checkHash(runDir, LANHU_USER_ASSETS, state?.inputs?.[LANHU_USER_ASSETS], issues);
  for (const file of [
    'stage2/project-analysis.md',
    'stage2/component-analysis.md',
    'stage2/component-vision-analysis.json'
  ])
    evidencePath(runDir, file, issues, true);
  if (restoreDocument)
    for (const file of ['component-tree.md', 'system-ui-policy.json', 'viewport-boundary-spec.json'])
      evidencePath(runDir, file, issues, true);
  return issues;
}

export function lanhuRecoveryInputPaths(runDir) {
  return [
    ...LANHU_INPUT_FILES,
    ...(runDir && existsSync(resolve(runDir, LANHU_USER_ASSETS)) ? [LANHU_USER_ASSETS] : []),
    LANHU_RUN_STATE,
    'requirement-clarification.json',
    'inputs-manifest.json',
    'stage2/project-analysis.md',
    'stage2/component-analysis.md',
    'stage2/component-vision-analysis.json',
    'stage2/asset-selection.json',
    'stage2/asset-bindings.json',
    'stage2/asset-delivery.json'
  ];
}

function collectUserAssets(runDir, identity, manifest, issues) {
  const supplied = json(runDir, LANHU_USER_ASSETS, issues);
  const nodes = json(runDir, 'source/lanhu/node-index.json', issues);
  checkHash(runDir, LANHU_USER_ASSETS, manifest?.userAssets?.sha256, issues);
  if (manifest?.userAssets?.path !== LANHU_USER_ASSETS || supplied?.provenance !== 'developer-provided' ||
      supplied?.producer?.script !== 'lanhu-import-assets.mjs' || supplied?.schemaVersion !== 1 ||
      supplied?.snapshotId !== identity.snapshotId || supplied?.resolvedVersion !== identity.resolvedVersion ||
      !Array.isArray(supplied?.assets) || !supplied.assets.length || supplied.assets.some((asset) => !record(asset))) {
    issues.push('User asset manifest must lock the local import and selected design version');
    return [];
  }
  if (new Set(supplied.assets.map((asset) => asset.assetId)).size !== supplied.assets.length ||
      new Set(supplied.assets.map((asset) => asset.nodeId)).size !== supplied.assets.length)
    issues.push('User asset IDs and node bindings must be distinct');
  for (const asset of supplied.assets) {
    if (!/^user-[a-f0-9]{24}$/.test(asset.assetId ?? '') || asset.path !== `source/user-assets/${asset.assetId}.png` ||
        !nodes?.nodes?.some((node) => node.node_id === asset.nodeId)) {
      issues.push('User image must bind to a real locked node and a local evidence path');
      continue;
    }
    if (!checkHash(runDir, asset.path, asset.sha256, issues)) continue;
    const bytes = readFileSync(resolve(runDir, asset.path));
    if (bytes.length < 33 || bytes.toString('hex', 0, 8) !== '89504e470d0a1a0a' || bytes.length !== asset.size ||
        bytes.readUInt32BE(16) !== asset.width || bytes.readUInt32BE(20) !== asset.height || !positive(asset.width) || !positive(asset.height))
      issues.push('User image bytes or dimensions differ from the import');
  }
  return supplied.assets;
}

function json(runDir, rel, issues, allowArray = false) {
  const file = evidencePath(runDir, rel, issues, true);
  if (!file) return null;
  try {
    const value = JSON.parse(readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
    if (!value || typeof value !== 'object' || (!allowArray && Array.isArray(value))) throw new Error('expected object');
    return value;
  } catch {
    issues.push(`Invalid JSON evidence: ${rel}`);
    return null;
  }
}

function evidencePath(root, rel, issues, required = false) {
  if (!string(rel) || isAbsolute(rel)) {
    issues.push(`Invalid evidence path: ${rel}`);
    return null;
  }
  const file = resolve(root, rel);
  if (relative(root, file).split(sep).includes('..')) {
    issues.push(`Evidence path escapes root: ${rel}`);
    return null;
  }
  const parts = file.split(sep);
  for (const index of parts.keys()) {
    const current = parts.slice(0, index + 1).join(sep) || sep;
    if (existsSync(current) && lstatSync(current).isSymbolicLink()) {
      issues.push(`Evidence path contains a symbolic link: ${rel}`);
      return null;
    }
  }
  if (
    !existsSync(file) ||
    !statSync(file).isFile() ||
    statSync(file).size <= 0 ||
    statSync(file).size > 10 * 1024 * 1024
  ) {
    if (required) issues.push(`Required evidence is missing, empty or too large: ${rel}`);
    return null;
  }
  if (required && /\.(?:md|json)$/.test(rel) && !readFileSync(file, 'utf8').trim()) {
    issues.push(`Required text evidence contains only whitespace: ${rel}`);
    return null;
  }
  return file;
}

function checkHash(root, rel, expected, issues) {
  const file = evidencePath(root, rel, issues, true);
  if (
    !file ||
    !/^[a-f0-9]{64}$/.test(expected ?? '') ||
    createHash('sha256').update(readFileSync(file)).digest('hex') !== expected
  ) {
    issues.push(`Evidence hash mismatch: ${rel}`);
    return false;
  }
  return true;
}

function string(value) {
  return typeof value === 'string' && value.trim().length > 0;
}
function positive(value) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}
function id(value) {
  return typeof value === 'string' && /^[a-f0-9]{32}$/.test(value);
}

function record(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
