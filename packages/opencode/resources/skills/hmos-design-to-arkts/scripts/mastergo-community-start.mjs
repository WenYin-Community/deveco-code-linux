import { randomBytes } from 'node:crypto';
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';

if (!process.argv[2]) throw new Error('Usage: node mastergo-community-start.mjs <patched-community-checkout>');
const root = realpathSync(resolve(process.argv[2]));
const entry = join(root, 'mcp-server/dist/index.js');
if (!existsSync(entry)) throw new Error('Build the patched community MCP server first');
const config = process.platform === 'win32'
  ? process.env.APPDATA || join(homedir(), 'AppData', 'Roaming')
  : process.env.XDG_CONFIG_HOME || join(homedir(), '.config');
const directory = join(config, 'deveco', 'mastergo');
mkdirSync(directory, { recursive: true, mode: 0o700 });
if (lstatSync(directory).isSymbolicLink()) throw new Error('The local credential directory must not be a symlink');
const file = join(directory, 'community-bridge-token.txt');
const stat = lstatSync(file, { throwIfNoEntry: false });
if (stat && (!stat.isFile() || stat.isSymbolicLink())) throw new Error('The local pairing credential must be a regular file');
protectCredential(directory, file, Boolean(stat));
if (!stat) writeFileSync(file, randomBytes(32).toString('hex') + '\n', { mode: 0o600, flag: 'wx' });
if (process.platform !== 'win32') chmodSync(file, 0o600);
const token = readFileSync(file, 'utf8').trim();
if (!/^[a-f0-9]{64}$/.test(token)) throw new Error('Invalid local pairing credential; repair the local configuration');

// Credentials stay in the child environment, never CLI arguments or console output.
const child = spawn(process.execPath, [entry], {
  cwd: join(root, 'mcp-server'),
  env: { ...process.env, MCP_HTTP_HOST: '127.0.0.1', MCP_HTTP_PORT: '3000',
    MASTERGO_BRIDGE_TOKEN: token, MASTERGO_BRIDGE_REQUEST_TIMEOUT_MS: '120000', DEVECO_MASTERGO_READ_ONLY: '1' },
  stdio: 'inherit',
});
process.on('SIGINT', () => child.kill('SIGINT'));
process.on('SIGTERM', () => child.kill('SIGTERM'));
child.on('error', () => { console.error('Unable to start the local MasterGo service'); process.exitCode = 1; });
child.on('exit', (code) => { process.exitCode = code ?? 1; });

function protectCredential(directory, file, existing) {
  if (process.platform !== 'win32') {
    chmodSync(directory, 0o700);
    return;
  }
  // Restrict the directory before creating a secret; existing files need their own ACL reset.
  const sid = currentUserId();
  restrictWindowsAcl(directory, sid, true);
  if (existing) restrictWindowsAcl(file, sid, false);
}

function restrictWindowsAcl(target, sid, directory) {
  // Set an explicit current-user ACL; chmod does not restrict Windows readers.
  // icacls rewrites only the DACL, which an unprivileged owner may always write.
  // Set-Acl round-trips the whole descriptor and fails with a missing
  // SeSecurityPrivilege on descriptors that carry audit rules.
  const result = spawnSync(
    'icacls.exe',
    // Keep "/grant:r" and the ACE spec as separate arguments: icacls on
    // Windows 11 24H2+ (build 26100) rejects the combined "/grant:r:Sid:perm"
    // form with error 87; the documented syntax is space-separated.
    [target, '/inheritance:r', '/grant:r', `*${sid}:${directory ? '(OI)(CI)F' : 'F'}`],
    { windowsHide: true, timeout: 30_000, maxBuffer: 16_384, encoding: 'utf8' },
  );
  if (result.error || result.status !== 0) {
    const detail = [result.stderr, result.stdout].filter(Boolean).join(' ').trim();
    throw new Error(
      `Unable to restrict the Windows MasterGo pairing credential ACL: ${detail || result.error?.message || `exit ${result.status}`}`,
    );
  }
}

function currentUserId() {
  const result = spawnSync('whoami.exe', ['/user', '/fo', 'csv', '/nh'], {
    windowsHide: true,
    timeout: 15_000,
    encoding: 'utf8',
  });
  const sid = result.stdout?.trim().split('\n').at(-1)?.split(',').at(-1)?.replaceAll('"', '').trim();
  if (!sid?.startsWith('S-1-')) throw new Error('Unable to resolve the current Windows user SID');
  return sid;
}
