import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, isAbsolute, resolve, sep } from 'node:path';
import { parseArgs } from 'node:util';

// This imports bytes supplied by the user; it never represents a successful MCP export.
const args = parseArgs({ options: { 'run-dir': { type: 'string' }, 'assets-file': { type: 'string' } } }).values;
if (!args['run-dir'] || !args['assets-file']) throw new Error('Required: --run-dir <runDir> --assets-file <JSON array>');
const runDir = resolve(args['run-dir']);
// Normalize separators before matching: resolve() returns backslashes on Windows.
if (!/\/\.deveco\/design-to-arkts(?:-fast)?\/runs\/[^/]+$/.test(runDir.split(sep).join('/'))) throw new Error('Invalid Lanhu run directory');
const identity = JSON.parse(readFileSync(resolve(runDir, 'source/lanhu/target-page-identity.json'), 'utf8'));
const nodes = JSON.parse(readFileSync(resolve(runDir, 'source/lanhu/node-index.json'), 'utf8'));
if (identity.designSource !== 'lanhu' || nodes.snapshotId !== identity.snapshotId || nodes.complete !== true)
  throw new Error('Import requires a complete, locked Lanhu node index');
const input = JSON.parse(readFileSync(args['assets-file'], 'utf8'));
if (!Array.isArray(input) || !input.length || input.length > 100) throw new Error('Provide 1–100 explicitly supplied assets');
const prepared = input.map((item) => {
  if (!item || typeof item.path !== 'string' || !isAbsolute(item.path) || lstatSync(item.path).isSymbolicLink())
    throw new Error('Each source must be an absolute regular file, not a symbolic link');
  if (!lstatSync(item.path).isFile() || lstatSync(item.path).size > 10 * 1024 * 1024)
    throw new Error('Source must be a regular image of at most 10 MiB');
  if (!nodes.nodes.some((node) => node.node_id === item.nodeId)) throw new Error(`Unknown source node: ${item.nodeId}`);
  const bytes = readFileSync(item.path);
  if (bytes.length < 33 || bytes.toString('hex', 0, 8) !== '89504e470d0a1a0a' || bytes.toString('ascii', 12, 16) !== 'IHDR')
    throw new Error('Only PNG input is supported; export other formats as PNG first');
  const width = bytes.readUInt32BE(16);
  const height = bytes.readUInt32BE(20);
  if (!width || !height || width * height > 80_000_000) throw new Error('Invalid PNG dimensions');
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  const assetId = `user-${createHash('sha256').update(item.nodeId + ':' + sha256).digest('hex').slice(0, 24)}`;
  return { bytes, asset: { assetId, nodeId: item.nodeId, originalName: basename(item.path), path: `source/user-assets/${assetId}.png`, sha256, size: bytes.length, width, height } };
});
const assets = prepared.map((entry) => entry.asset);
if (new Set(assets.map((asset) => asset.nodeId)).size !== assets.length) throw new Error('Each node may have only one supplied image');
const manifestPath = resolve(runDir, 'source/user-assets/manifest.json');
const manifest = {
  schemaVersion: 1,
  provenance: 'developer-provided',
  producer: { script: 'lanhu-import-assets.mjs' },
  snapshotId: identity.snapshotId,
  resolvedVersion: identity.resolvedVersion,
  assets
};
// Check all destinations before writing. Identical retries are allowed; changing a locked import requires a new run.
for (const entry of [...prepared.map((entry) => ({ path: resolve(runDir, entry.asset.path), bytes: entry.bytes })), { path: manifestPath, bytes: Buffer.from(JSON.stringify(manifest, null, 2) + '\n') }]) {
  const parts = entry.path.split(sep);
  for (const index of parts.keys()) {
    const parent = parts.slice(0, index + 1).join(sep) || sep;
    if (existsSync(parent) && lstatSync(parent).isSymbolicLink()) throw new Error('Destination contains a symbolic link');
  }
  if (existsSync(entry.path) && !readFileSync(entry.path).equals(entry.bytes)) throw new Error('Existing imported evidence differs; start a new run');
}
for (const entry of prepared) {
  mkdirSync(resolve(runDir, 'source/user-assets'), { recursive: true });
  if (!existsSync(resolve(runDir, entry.asset.path))) writeFileSync(resolve(runDir, entry.asset.path), entry.bytes, { flag: 'wx', mode: 0o600 });
}
if (!existsSync(manifestPath)) writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
console.log(JSON.stringify({ status: 'complete', provenance: manifest.provenance, path: 'source/user-assets/manifest.json', sha256: createHash('sha256').update(readFileSync(manifestPath)).digest('hex'), assets }));
