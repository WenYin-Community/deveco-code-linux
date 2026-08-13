import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { Effect, Layer, Logger, ManagedRuntime, References } from 'effect';
import { NodeFileSystem } from '@effect/platform-node';
import { Global } from '@opencode-ai/core/global';
import { sanitizePath } from '@opencode-ai/core/sanitize-path';
import { Logging } from '@opencode-ai/core/observability/logging';
import { ensureValidToken } from '@/plugin/deveco';
import { getOrCreateUid, getOsName, getOsVersion, getVersion } from '@/plugin/analytics';
import { createEnvironmentFields } from '@/plugin/analytics/events';
import { runID } from '@opencode-ai/core/observability/shared';
import { secureFetch } from '@/security/secure-fetch';
import Endpoint from '../../../../huawei-endpoints.json';

// Content Center configuration (via environment variables)
const baseUrl = process.env.DEVECO_CONTENT_CENTER_URL || `${Endpoint.devecoStudio}/codeGenie`;
const uploadUrl = '/cli/content/v3/files';
const uploadCompleteUrl = '/cli/content/v3/files/complete';

interface UploadInfo {
  url: string;
  method: string;
  headers: Record<string, string>;
}

interface FileRspInfo {
  index: string;
  fileId: string;
  uploadInfo: UploadInfo;
}

// --- Minimal logging runtime (uses the same fileLogger as Effect business logs) ---

let logRuntime: ManagedRuntime.ManagedRuntime<never, never> | undefined;

function getLogRuntime() {
  if (!logRuntime) {
    const layer = Logger.layer(Logging.loggers(), { mergeWithExisting: false })
      .pipe(
        Layer.provide(NodeFileSystem.layer),
        Layer.orDie,
        Layer.merge(Layer.succeed(References.MinimumLogLevel, Logging.minimumLogLevel())),
      );
    logRuntime = ManagedRuntime.make(layer);
  }
  return logRuntime;
}

/** Log to deveco.log via Effect's structured logger (same format as business logs). */
export function logInfo(message: string, extra?: Record<string, unknown>): void {
  try {
    getLogRuntime().runFork(Effect.logInfo(message, extra));
  } catch {
  }
}

export function logWarn(message: string, extra?: Record<string, unknown>): void {
  try {
    getLogRuntime().runFork(Effect.logWarning(message, extra));
  } catch {
  }
}

export function logError(message: string, extra?: Record<string, unknown>): void {
  try {
    getLogRuntime().runFork(Effect.logError(message, extra));
  } catch {
  }
}

/** List all *.log files available for collection. */
export function listLogFiles(): { path: string; label: string; group: string }[] {
  const logDir = Global.Path.log;
  const dirs = [
    { dir: logDir, group: 'deveco' },
  ];
  const results: { path: string; label: string; group: string }[] = [];

  for (const { dir, group } of dirs) {
    try {
      if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) {
        continue;
      }
      for (const file of fs.readdirSync(dir)) {
        const abs = path.join(dir, file);
        if (fs.statSync(abs).isFile() && file.endsWith('.log')) {
          results.push({ path: abs, label: file, group });
        }
      }
    } catch {
    }
  }

  return results;
}

/** Redact username from file paths in log content to protect privacy. */
function redactUsername(data: Buffer): Buffer {
  return Buffer.from(sanitizePath(data.toString('utf8')), 'utf8');
}

/** Pack given file paths into a zip archive. */
export function packLogs(paths: string[]): Buffer | undefined {
  const logDir = Global.Path.log;
  const entries: Array<{ name: string; absPath: string }> = [];

  if (paths.length > 0) {
    for (const p of paths) {
      if (fs.existsSync(p) && fs.statSync(p).isFile()) {
        const rel = path.relative(logDir, p) || path.basename(p);
        entries.push({ name: rel, absPath: p });
      }
    }
  }

  if (entries.length === 0) {
    return undefined;
  }

  return zipFiles(entries.map((e) => ({ name: e.name, data: fs.readFileSync(e.absPath) })));
}

/**
 * Three-step upload to Content Center (pre-shared key auth):
 * 1. POST /content-manager/v3/files  — get upload info
 * 2. PUT  {obsUrl}                    — upload file body
 * 3. POST /content-manager/v3/files/complete — confirm
 *
 * Retries up to 3 times (with incremental backoff) on failure.
 * Throws on final failure so callers can handle accordingly.
 */
export async function uploadLogs(archive: Buffer, triggerType: string = '00001', maxRetries = 3): Promise<void> {
  if (archive.length > 50 * 1024 * 1024) {
    throw new Error('archive file size exceeds 50MB');
  }
  const authToken = await ensureValidToken();
  if (!authToken) {
    throw new Error('no auth token');
  }

  let lastError: unknown;
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const fileId = await uploadOnce(archive, authToken);
      await uploadLogTracePoint(authToken, true, triggerType, fileId);
      return; // success
    } catch (e) {
      lastError = e;
      logError(`upload attempt ${attempt}/${maxRetries} failed`, { error: String(e) });
      if (attempt < maxRetries) {
        await new Promise((resolve) => setTimeout(resolve, 2000 * attempt));
      }
    }
  }
  try {
    await uploadLogTracePoint(authToken, false, triggerType);
  } catch {
  }
  throw lastError;
}

const PRIVATE_IP_REGEXES: RegExp[] = [
  /^10\./,
  /^172\.(1[6-9]|2\d|3[01])\./,
  /^192\.168\./,
  /^127\./,
  /^0\./,
  /^169\.254\./,
];

function validateUploadUrl(raw: string): void {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error(`upload url is not a valid URL: ${raw}`);
  }
  if (parsed.protocol !== 'https:') {
    throw new Error(`upload url must use https, got: ${parsed.protocol}`);
  }
  const hostname = parsed.hostname.toLowerCase();
  if (hostname === 'localhost' || hostname === '[::1]') {
    throw new Error(`upload url must not point to localhost`);
  }
  for (const re of PRIVATE_IP_REGEXES) {
    if (re.test(hostname)) {
      throw new Error(`upload url must not point to a private IP: ${hostname}`);
    }
  }
}

function commonAuthHeaders(authToken: string): Record<string, string> {
  return {
    authorization: `Bearer ${authToken}`,
    'Content-Type': 'application/json',
  };
}

async function getUploadInfo(archive: Buffer, authToken: string): Promise<{ fileId: string; uploadInfo: UploadInfo }> {
  const fileSha256 = crypto.createHash('sha256').update(archive).digest('hex');
  const fileName = `deveco-logs-${Date.now()}.zip`;
  const index = crypto.randomUUID().replace(/-/g, '').slice(0, 16);
  const body = JSON.stringify({
    fileInfos: [{ index, fileName, contentType: 900, fileSha256, fileSize: archive.length, fileAccessRight: 1 }],
    useAccelerate: false,
  });
  const resp = await fetchWithTimeout(`${baseUrl}${uploadUrl}`, { method: 'POST', headers: commonAuthHeaders(authToken), body }, 15_000);
  const data = (await resp.json()) as { code?: number; message?: string; data?: { fileRspInfos?: FileRspInfo[] } };
  if (data.code !== 200) {
    throw new Error(`step1 failed: code=${data.code} message=${data.message}`);
  }
  const rsp = data.data?.fileRspInfos?.[0];
  if (!rsp) {
    throw new Error('step1: no fileRspInfos in response');
  }
  return { fileId: rsp.fileId, uploadInfo: rsp.uploadInfo };
}

async function uploadToObs(archive: Buffer, info: UploadInfo): Promise<void> {
  validateUploadUrl(info.url);
  const resp = await fetchWithTimeout(info.url, { method: info.method || 'PUT', headers: info.headers, body: new Uint8Array(archive) }, 15_000);
  if (!resp.ok) {
    throw new Error(`step2 failed: status=${resp.status}`);
  }
}

async function confirmUpload(authToken: string, fileId: string): Promise<void> {
  const body = JSON.stringify({ fileCompleteInfos: [{ fileId, expireDate: 30 * 24 * 60 * 60 }] });
  const resp = await fetchWithTimeout(`${baseUrl}${uploadCompleteUrl}`, { method: 'POST', headers: commonAuthHeaders(authToken), body }, 15_000);
  const data = (await resp.json()) as { code?: number; message?: string };
  if (data.code === 200) {
    logInfo('logs uploaded success', { fileId });
  } else {
    throw new Error(`step3 failed: code=${data.code} message=${data.message}`);
  }
}

/** Single upload attempt — throws on any step failure. */
export async function uploadOnce(archive: Buffer, authToken: string): Promise<string> {
  const { fileId, uploadInfo } = await getUploadInfo(archive, authToken);
  await uploadToObs(archive, uploadInfo);
  await confirmUpload(authToken, fileId);
  return fileId;
}

async function fetchWithTimeout(url: string, init: RequestInit, ms: number): Promise<Response> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), ms);
  if (init.signal) {
    init.signal.addEventListener('abort', () => controller.abort(), { once: true });
  }
  try {
    return await secureFetch(url, { ...init, signal: controller.signal, timeout: ms });
  } finally {
    clearTimeout(timeoutId);
  }
}

async function uploadLogTracePoint(
  authToken: string,
  isSuccess: boolean,
  triggerType: string,
  fileId?: string,
): Promise<void> {
  try {
    const uid = await getOrCreateUid();
    const osName = getOsName();
    const osVersion = getOsVersion();
    const version = getVersion();
    const tracePoint = {
      fileId: fileId,
      uid,
      timestamp: Date.now(),
      sourceType: 'DevEco-Code-Cli',
      sourceVersion: version,
      osName: osName,
      osVersion: osVersion,
      traceSid: runID,
      eventType: triggerType,
      isSuccess: isSuccess,
    };
    const payload = {
      action: 'DevEco-Code-Log-Upload',
      countryCode: 'CN',
      detail: JSON.stringify(tracePoint),
      osArch: osName,
      sid: 10200,
      timestamp: Date.now(),
      uid,
      version,
    };
    const resp = await fetchWithTimeout(
      `${baseUrl}/cli/trace/upload`,
      {
        method: 'POST',
        headers: {
          authorization: `Bearer ${authToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify([payload]),
      },
      10_000,
    );

    if (resp.ok) {
      logInfo('log trace point uploaded successfully', { tracePoint });
    } else {
      logWarn('log trace point upload failed', { status: resp.status, tracePoint });
    }
  } catch (e) {
    logWarn('failed to upload log trace point', { error: String(e) });
  }
}

/**
 * Build a minimal ZIP archive (no compression — store method).
 * Compatible with all standard unzip tools.
 */
function zipFiles(files: { name: string; data: Buffer }[]): Buffer {
  const localParts: Buffer[] = [];
  const centralParts: Buffer[] = [];
  let offset = 0;

  for (const file of files) {
    const nameBuf = Buffer.from(file.name, 'utf8');
    const redacted = redactUsername(file.data);
    const crc = crc32(redacted);
    const size = redacted.length;

    localParts.push(buildLocalHeader(nameBuf, redacted, crc, size));
    centralParts.push(buildCentralHeader(nameBuf, crc, size, offset));
    offset += 30 + nameBuf.length + size;
  }

  const localBuf = Buffer.concat(localParts);
  const centralBuf = Buffer.concat(centralParts);
  return Buffer.concat([localBuf, centralBuf, buildEocd(files.length, centralBuf.length, localBuf.length)]);
}

function buildLocalHeader(nameBuf: Buffer, data: Buffer, crc: number, size: number): Buffer {
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4);
  local.writeUInt16LE(0, 6);
  local.writeUInt16LE(0, 8); // store
  local.writeUInt16LE(0, 10);
  local.writeUInt16LE(0, 12);
  local.writeUInt32LE(crc, 14);
  local.writeUInt32LE(size, 18);
  local.writeUInt32LE(size, 22);
  local.writeUInt16LE(nameBuf.length, 26);
  local.writeUInt16LE(0, 28);
  return Buffer.concat([local, nameBuf, data]);
}

function buildCentralHeader(nameBuf: Buffer, crc: number, size: number, offset: number): Buffer {
  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(20, 4);
  central.writeUInt16LE(20, 6);
  central.writeUInt16LE(0, 8);
  central.writeUInt16LE(0, 10); // store
  central.writeUInt16LE(0, 12);
  central.writeUInt16LE(0, 14);
  central.writeUInt32LE(crc, 16);
  central.writeUInt32LE(size, 20);
  central.writeUInt32LE(size, 24);
  central.writeUInt16LE(nameBuf.length, 28);
  central.writeUInt16LE(0, 30);
  central.writeUInt16LE(0, 32);
  central.writeUInt16LE(0, 34);
  central.writeUInt16LE(0, 36);
  central.writeUInt32LE(0, 38);
  central.writeUInt32LE(offset, 42);
  return Buffer.concat([central, nameBuf]);
}

function buildEocd(entryCount: number, centralSize: number, localSize: number): Buffer {
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(entryCount, 8);
  eocd.writeUInt16LE(entryCount, 10);
  eocd.writeUInt32LE(centralSize, 12);
  eocd.writeUInt32LE(localSize, 16);
  eocd.writeUInt16LE(0, 20);
  return eocd;
}

/** CRC32 lookup table (IEEE polynomial 0xEDB88320). */
const crcTable = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let j = 0; j < 8; j++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[i] = c >>> 0;
  }
  return table;
})();

function crc32(buf: Buffer): number {
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    crc = crcTable[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}
