import http from 'http';
import https from 'https';
import type { ClientRequest, IncomingMessage } from 'http';
import { URL } from 'url';
import tls from 'tls';
import type { TLSSocket } from 'tls';
import type { Socket } from 'net';
import TlsCipherWhitelist from './tls-cipher-whitelist.json';

export class InsecureCipherError extends Error {
  constructor(
    public cipher: string,
    public protocol: string,
    public url: string,
  ) {
    super(`Insecure TLS cipher suite "${cipher}" (${protocol}) rejected for ${url}`);
    this.name = 'InsecureCipherError';
  }
}

const whitelist = {
  tls12: new Set(TlsCipherWhitelist.tls12),
  tls13: new Set(TlsCipherWhitelist.tls13),
};

function isWhitelisted(cipher: string, protocol: string): boolean {
  if (protocol === 'TLSv1.3') {
    return whitelist.tls13.has(cipher);
  }
  if (protocol === 'TLSv1.2') {
    return whitelist.tls12.has(cipher);
  }
  return false;
}

const opensslToIetf = new Map<string, string>();
for (const name of [...TlsCipherWhitelist.tls12, ...TlsCipherWhitelist.tls13]) {
  const openssl = name
    .replace(/^TLS_/, '')
    .replace(/_WITH_/g, '-')
    .replace(/POLY1305_SHA256$/, 'POLY1305')
    .replace(/([A-Z])_(\d)/g, '$1$2')
    .replace(/_/g, '-');
  opensslToIetf.set(openssl, name);
}

function getProxyUrl(): URL | undefined {
  const raw = process.env.HTTPS_PROXY ?? process.env.https_proxy;
  if (!raw) {
    return undefined;
  }
  try {
    return new URL(raw);
  } catch {
    return undefined;
  }
}

function setupProxyConnect(
  proxyUrl: URL,
  targetHost: string,
  targetPort: number,
  resolve: (socket: Socket) => void,
  reject: (err: Error) => void,
): void {
  const connectReq = http.request({
    hostname: proxyUrl.hostname,
    port: proxyUrl.port || 80,
    method: 'CONNECT',
    path: `${targetHost}:${targetPort}`,
    headers: { Host: `${targetHost}:${targetPort}` },
  });
  const timeoutId = setTimeout(() => {
    connectReq.destroy(new Error(`Proxy CONNECT timeout after ${DEFAULT_TIMEOUT_MS}ms`));
  }, DEFAULT_TIMEOUT_MS);
  connectReq.on('connect', (res, socket) => {
    clearTimeout(timeoutId);
    if (res.statusCode !== 200) {
      socket.destroy();
      reject(new Error(`Proxy CONNECT failed with status ${res.statusCode}`));
      return;
    }
    resolve(socket);
  });
  connectReq.on('error', (err) => {
    clearTimeout(timeoutId);
    reject(err);
  });
  connectReq.end();
}

function connectViaProxy(proxyUrl: URL, targetHost: string, targetPort: number): Promise<Socket> {
  return new Promise((resolve, reject) => {
    setupProxyConnect(proxyUrl, targetHost, targetPort, resolve, reject);
  });
}

export interface SecureFetchOptions extends Omit<RequestInit, 'signal'> {
  signal?: AbortSignal | null;
  timeout?: number;
}

const MAX_REDIRECTS = 10;
const DEFAULT_TIMEOUT_MS = 30_000;

const SENSITIVE_HEADERS = new Set([
  'authorization',
  'cookie',
  'proxy-authorization',
]);

interface CipherState {
  validated: boolean;
}

interface BodyState {
  sent: boolean;
}

interface ResolvedInput {
  url: URL;
  mergedInit: SecureFetchOptions | undefined;
}

async function resolveInput(
  input: RequestInfo | URL,
  init: SecureFetchOptions | undefined,
): Promise<ResolvedInput> {
  if (input instanceof Request) {
    return {
      url: new URL(input.url),
      mergedInit: {
        method: init?.method ?? input.method,
        headers: init?.headers ?? input.headers,
        body: init?.body ?? (input.body ? await input.arrayBuffer() : undefined),
        signal: init?.signal ?? input.signal,
        timeout: init?.timeout,
      },
    };
  }
  const url = input instanceof URL ? input : new URL(input);
  return { url, mergedInit: init };
}

async function bodyToBuffer(body: BodyInit | null | undefined): Promise<Buffer | undefined> {
  if (body === undefined || body === null) {
    return undefined;
  }
  if (typeof body === 'string') {
    return Buffer.from(body);
  }
  if (Buffer.isBuffer(body)) {
    return body;
  }
  if (body instanceof ArrayBuffer) {
    return Buffer.from(body);
  }
  if (ArrayBuffer.isView(body)) {
    return Buffer.from(body.buffer, body.byteOffset, body.byteLength);
  }
  if (body instanceof URLSearchParams) {
    return Buffer.from(body.toString());
  }
  if (body instanceof Blob) {
    const arrayBuffer = await body.arrayBuffer();
    return Buffer.from(arrayBuffer);
  }
  if (body instanceof FormData) {
    throw new Error('FormData body type is not supported by secureFetch. Serialize to string or JSON before sending.');
  }
  if (body instanceof ReadableStream) {
    const reader = body.getReader();
    const chunks: Uint8Array[] = [];
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      if (value) {
        chunks.push(value);
      }
    }
    return Buffer.concat(chunks);
  }
  const typeName = (body as { constructor?: { name?: string } }).constructor?.name ?? typeof body;
  throw new Error(`Unsupported body type: ${typeName}`);
}

function parseHeaders(initHeaders: HeadersInit | undefined): Record<string, string> {
  const headers: Record<string, string> = {};
  if (!initHeaders) {
    return headers;
  }
  if (initHeaders instanceof Headers) {
    initHeaders.forEach((value, key) => {
      headers[key] = value;
    });
    return headers;
  }
  if (Array.isArray(initHeaders)) {
    for (const [key, value] of initHeaders) {
      headers[key] = String(value);
    }
    return headers;
  }
  for (const [key, value] of Object.entries(initHeaders)) {
    if (value !== undefined) {
      headers[key] = String(value);
    }
  }
  return headers;
}

function setContentLength(headers: Record<string, string>, bodyBuffer: Buffer | undefined): void {
  if (!bodyBuffer) {
    return;
  }
  const hasContentLength = Object.keys(headers).some((k) => k.toLowerCase() === 'content-length');
  if (!hasContentLength) {
    headers['Content-Length'] = String(bodyBuffer.length);
  }
}

function setContentType(headers: Record<string, string>, body: BodyInit | null | undefined): void {
  if (body === undefined || body === null) {
    return;
  }
  const hasContentType = Object.keys(headers).some((k) => k.toLowerCase() === 'content-type');
  if (hasContentType) {
    return;
  }
  if (typeof body === 'string') {
    headers['Content-Type'] = 'text/plain;charset=UTF-8';
  } else if (body instanceof URLSearchParams) {
    headers['Content-Type'] = 'application/x-www-form-urlencoded;charset=UTF-8';
  } else {
    headers['Content-Type'] = 'application/octet-stream';
  }
}

function validateCipher(socket: TLSSocket, url: URL): Error | null {
  const cipher = socket.getCipher();
  if (!cipher) {
    return new Error('Failed to get TLS cipher information');
  }
  const standardName = cipher.standardName ?? opensslToIetf.get(cipher.name) ?? cipher.name;
  const negotiatedProtocol = socket.getProtocol() ?? cipher.version;
  if (!isWhitelisted(standardName, negotiatedProtocol)) {
    return new InsecureCipherError(standardName, negotiatedProtocol, url.toString());
  }
  return null;
}

function sendBody(req: ClientRequest, bodyBuffer: Buffer | undefined, bodyState: BodyState): void {
  if (bodyState.sent) {
    return;
  }
  bodyState.sent = true;
  if (bodyBuffer) {
    req.end(bodyBuffer);
  } else {
    req.end();
  }
}

function startHandshakeTimeout(
  destroy: (err: Error) => void,
  cipherState: CipherState,
  deadline: number,
): ReturnType<typeof setTimeout> | undefined {
  const remaining = deadline - Date.now();
  if (remaining <= 0) {
    destroy(new Error('Request timeout before TLS handshake'));
    return undefined;
  }
  return setTimeout(() => {
    if (!cipherState.validated) {
      destroy(new Error(`TLS handshake timeout after ${remaining}ms`));
    }
  }, remaining);
}

function runCipherCheck(
  socket: TLSSocket,
  url: URL,
  cipherState: CipherState,
  bodyBuffer: Buffer | undefined,
  bodyState: BodyState,
  deadline: number,
  req: ClientRequest,
  timeoutRef: { value: ReturnType<typeof setTimeout> | undefined },
): void {
  if (cipherState.validated) {
    return;
  }
  const err = validateCipher(socket, url);
  if (err) {
    req.destroy(err);
    return;
  }
  cipherState.validated = true;
  const remaining = deadline - Date.now();
  if (remaining <= 0) {
    req.destroy(new Error('Request timeout after cipher validation'));
    return;
  }
  timeoutRef.value = setTimeout(() => {
    req.destroy(new Error(`Request timeout after ${remaining}ms`));
  }, remaining);
  sendBody(req, bodyBuffer, bodyState);
}

function setupRequestLifecycle(
  req: ClientRequest,
  init: SecureFetchOptions | undefined,
  cleanup: () => void,
  reject: (reason: Error) => void,
): () => void {
  let abortHandler: (() => void) | undefined;
  if (init?.signal) {
    abortHandler = () => {
      const err = new DOMException('The operation was aborted.', 'AbortError');
      cleanup();
      reject(err);
      req.destroy(err);
    };
    if (init.signal.aborted) {
      abortHandler();
      return () => {};
    }
    init.signal.addEventListener('abort', abortHandler, { once: true });
  }

  return () => {
    if (abortHandler && init?.signal) {
      init.signal.removeEventListener('abort', abortHandler);
    }
  };
}

function parseResponseHeaders(rawHeaders: IncomingMessage['headers']): Headers {
  const headers = new Headers();
  for (const [key, value] of Object.entries(rawHeaders)) {
    if (!value) {
      continue;
    }
    if (Array.isArray(value)) {
      value.forEach((v) => headers.append(key, v));
    } else {
      headers.set(key, value);
    }
  }
  return headers;
}

function buildBufferedResponse(res: IncomingMessage, cleanup: () => void, statusCode: number): Promise<Response> {
  return new Promise((resolve, reject) => {
    const responseHeaders = parseResponseHeaders(res.headers);
    const chunks: Buffer[] = [];

    res.on('data', (chunk: Buffer) => {
      chunks.push(chunk);
    });
    res.on('end', () => {
      cleanup();
      resolve(new Response(Buffer.concat(chunks), {
        status: statusCode,
        statusText: res.statusMessage ?? '',
        headers: responseHeaders,
      }));
    });
    res.on('error', (err) => {
      cleanup();
      reject(err);
    });
  });
}

function stripBodyHeaders(headers: HeadersInit | undefined): HeadersInit | undefined {
  if (headers instanceof Headers) {
    const cloned = new Headers(headers);
    cloned.delete('content-length');
    cloned.delete('content-type');
    return cloned;
  }
  if (Array.isArray(headers)) {
    return headers.filter(
      ([key]) => key.toLowerCase() !== 'content-length' && key.toLowerCase() !== 'content-type',
    );
  }
  if (headers && typeof headers === 'object') {
    return filterHeaderRecord(headers as Record<string, string>, ['content-length', 'content-type']);
  }
  return undefined;
}

function stripCrossOriginHeaders(headers: HeadersInit | undefined): HeadersInit | undefined {
  if (headers instanceof Headers) {
    const cloned = new Headers(headers);
    for (const h of SENSITIVE_HEADERS) {
      cloned.delete(h);
      cloned.delete(h.charAt(0).toUpperCase() + h.slice(1));
    }
    return cloned;
  }
  if (Array.isArray(headers)) {
    return headers.filter(([key]) => !SENSITIVE_HEADERS.has(key.toLowerCase()));
  }
  if (headers && typeof headers === 'object') {
    return stripSensitiveHeaders(headers as Record<string, string>);
  }
  return undefined;
}

function filterHeaderRecord(
  headers: Record<string, string>,
  forbidden: string[],
): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    if (!forbidden.includes(key.toLowerCase())) {
      result[key] = value;
    }
  }
  return result;
}

function stripSensitiveHeaders(headers: Record<string, string>): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    if (!SENSITIVE_HEADERS.has(key.toLowerCase())) {
      result[key] = value;
    }
  }
  return result;
}

function shouldConvertToGet(statusCode: number, method: string): boolean {
  return statusCode === 303 || ((statusCode === 301 || statusCode === 302) && method === 'POST');
}

function prepareRedirectInit(
  init: SecureFetchOptions | undefined,
  statusCode: number,
  method: string,
  url: URL,
  redirectUrl: URL,
): SecureFetchOptions {
  const redirectInit: SecureFetchOptions = { ...init };

  if (shouldConvertToGet(statusCode, method)) {
    redirectInit.method = 'GET';
    redirectInit.body = undefined;
    redirectInit.headers = stripBodyHeaders(redirectInit.headers);
  }

  if (!isSameOrigin(url, redirectUrl)) {
    redirectInit.headers = stripCrossOriginHeaders(redirectInit.headers);
  }

  return redirectInit;
}

function isSameOrigin(a: URL, b: URL): boolean {
  return a.origin === b.origin;
}

function handleRedirect(
  statusCode: number,
  method: string,
  url: URL,
  req: ClientRequest,
  res: IncomingMessage,
  init: SecureFetchOptions | undefined,
  redirectCount: number,
  cleanup: () => void,
  resolve: (value: Response) => void,
  reject: (reason: Error) => void,
): void {
  if (redirectCount >= MAX_REDIRECTS) {
    res.on('error', () => {});
    req.destroy();
    cleanup();
    reject(new Error(`Maximum redirects (${MAX_REDIRECTS}) exceeded`));
    return;
  }

  const redirectUrl = new URL(res.headers.location!, url);
  res.resume();

  if (url.protocol === 'https:' && redirectUrl.protocol === 'http:') {
    res.on('error', () => {});
    req.destroy();
    cleanup();
    reject(new Error(`Refusing to follow HTTPS-to-HTTP redirect for ${url.toString()}`));
    return;
  }

  const redirectInit = prepareRedirectInit(init, statusCode, method, url, redirectUrl);
  res.on('error', () => {});
  req.destroy();
  cleanup();
  secureFetchInternal(redirectUrl, redirectInit, redirectCount + 1).then(resolve).catch(reject);
}

function handleResponse(
  res: IncomingMessage,
  url: URL,
  method: string,
  req: ClientRequest,
  init: SecureFetchOptions | undefined,
  redirectCount: number,
  cipherState: CipherState,
  cleanup: () => void,
  resolve: (value: Response) => void,
  reject: (reason: Error) => void,
): void {
  if (!cipherState.validated) {
    const err = validateCipher(res.socket as TLSSocket, url);
    if (err) {
      res.on('error', () => {});
      req.destroy();
      cleanup();
      reject(err);
      return;
    }
    cipherState.validated = true;
  }

  const statusCode = res.statusCode ?? 200;

  if (statusCode >= 300 && statusCode < 400 && res.headers.location) {
    handleRedirect(statusCode, method, url, req, res, init, redirectCount, cleanup, resolve, reject);
    return;
  }

  buildBufferedResponse(res, cleanup, statusCode).then(resolve).catch(reject);
}

function bindResponseHandler(
  req: ClientRequest,
  url: URL,
  method: string,
  init: SecureFetchOptions | undefined,
  redirectCount: number,
  cipherState: CipherState,
  cleanup: () => void,
  resolve: (value: Response) => void,
  reject: (reason: Error) => void,
): void {
  req.on('response', (res: IncomingMessage) => {
    handleResponse(res, url, method, req, init, redirectCount, cipherState, cleanup, resolve, reject);
  });
}

function bindErrorHandler(req: ClientRequest, cleanup: () => void, reject: (reason: Error) => void): void {
  req.on('error', (err: Error) => {
    cleanup();
    reject(err);
  });
}

const ALLOWED_CIPHERS = [...opensslToIetf.keys()].join(':');

function connectTls(url: URL, rawSocket: Socket | undefined): TLSSocket {
  return tls.connect({
    host: url.hostname,
    port: Number(url.port) || 443,
    minVersion: 'TLSv1.2',
    ciphers: ALLOWED_CIPHERS,
    ...(rawSocket ? { socket: rawSocket } : {}),
  });
}

function createRequestCleanup(
  tlsSocket: TLSSocket,
  rawSocket: Socket | undefined,
): { cleanup: () => void; cleanupFns: Array<() => void> } {
  const cleanupFns: Array<() => void> = [];
  let cleaned = false;
  const cleanup = () => {
    if (cleaned) {
      return;
    }
    cleaned = true;
    for (const fn of cleanupFns) {
      fn();
    }
    tlsSocket.destroy();
    rawSocket?.destroy();
  };
  return { cleanup, cleanupFns };
}

function createHttpRequest(
  url: URL,
  method: string,
  headers: Record<string, string>,
  tlsSocket: TLSSocket,
): ClientRequest {
  return https.request({
    hostname: url.hostname,
    port: url.port || 443,
    path: url.pathname + url.search,
    method,
    headers,
    agent: false,
    createConnection: () => tlsSocket,
  });
}

function bindSecureRequest(
  req: ClientRequest,
  url: URL,
  method: string,
  init: SecureFetchOptions | undefined,
  redirectCount: number,
  cipherState: CipherState,
  cleanup: () => void,
  cleanupFns: Array<() => void>,
  timeoutRef: { value: ReturnType<typeof setTimeout> | undefined },
  safeResolve: (value: Response) => void,
  safeReject: (err: Error) => void,
): void {
  cleanupFns.push(() => {
    if (timeoutRef.value) {
      clearTimeout(timeoutRef.value);
    }
  });
  cleanupFns.push(setupRequestLifecycle(req, init, cleanup, safeReject));
  bindResponseHandler(req, url, method, init, redirectCount, cipherState, cleanup, safeResolve, safeReject);
  bindErrorHandler(req, cleanup, safeReject);
}

function handleOnSecureConnect(
  handshakeTimeoutId: ReturnType<typeof setTimeout> | undefined,
  tlsSocket: TLSSocket,
  url: URL,
  cipherState: CipherState,
  bodyBuffer: Buffer | undefined,
  bodyState: BodyState,
  deadline: number,
  req: ClientRequest,
  timeoutRef: { value: ReturnType<typeof setTimeout> | undefined },
): void {
  if (handshakeTimeoutId) {
    clearTimeout(handshakeTimeoutId);
  }
  runCipherCheck(tlsSocket, url, cipherState, bodyBuffer, bodyState, deadline, req, timeoutRef);
}

function setupRequestPromise(
  url: URL,
  init: SecureFetchOptions | undefined,
  headers: Record<string, string>,
  bodyBuffer: Buffer | undefined,
  redirectCount: number,
  rawSocket: Socket | undefined,
  safeResolve: (value: Response) => void,
  safeReject: (err: Error) => void,
): void {
  const method = init?.method ?? 'GET';
  const deadline = Date.now() + (init?.timeout || DEFAULT_TIMEOUT_MS);
  const cipherState: CipherState = { validated: false };
  const bodyState: BodyState = { sent: false };
  const timeoutRef = { value: undefined as ReturnType<typeof setTimeout> | undefined };
  const tlsSocket = connectTls(url, rawSocket);
  const { cleanup, cleanupFns } = createRequestCleanup(tlsSocket, rawSocket);
  const handshakeTimeoutId = startHandshakeTimeout(
    (err: Error) => {
      cleanup();
      safeReject(err);
    },
    cipherState,
    deadline,
  );
  tlsSocket.on('secureConnect', () => {
    handleOnSecureConnect(handshakeTimeoutId, tlsSocket, url, cipherState, bodyBuffer, bodyState, deadline, req as ClientRequest, timeoutRef);
  });
  tlsSocket.on('error', (err: Error) => {
    cleanup();
    safeReject(err);
  });
  const req = createHttpRequest(url, method, headers, tlsSocket);
  bindSecureRequest(req, url, method, init, redirectCount, cipherState, cleanup, cleanupFns, timeoutRef, safeResolve, safeReject);
}

async function executeRequest(
  url: URL,
  init: SecureFetchOptions | undefined,
  headers: Record<string, string>,
  bodyBuffer: Buffer | undefined,
  redirectCount: number,
): Promise<Response> {
  const proxyUrl = getProxyUrl();
  let rawSocket: Socket | undefined;
  if (proxyUrl) {
    rawSocket = await connectViaProxy(proxyUrl, url.hostname, Number(url.port) || 443);
  }

  return new Promise((resolve, reject) => {
    let settled = false;
    const safeResolve = (value: Response) => {
      if (settled) {
        return;
      }
      settled = true;
      resolve(value);
    };
    const safeReject = (err: Error) => {
      if (settled) {
        return;
      }
      settled = true;
      reject(err);
    };

    try {
      setupRequestPromise(url, init, headers, bodyBuffer, redirectCount, rawSocket, safeResolve, safeReject);
    } catch (err) {
      safeReject(err as Error);
    }
  });
}

async function secureFetchInternal(
  input: RequestInfo | URL,
  init: SecureFetchOptions | undefined,
  redirectCount: number,
): Promise<Response> {
  if (init?.signal?.aborted) {
    throw new DOMException('The operation was aborted.', 'AbortError');
  }

  const { url, mergedInit } = await resolveInput(input, init);

  if (url.protocol !== 'https:') {
    throw new Error(`Refusing to send request over insecure connection: ${url.origin}`);
  }

  const headers = parseHeaders(mergedInit?.headers);
  setContentType(headers, mergedInit?.body);
  const bodyBuffer = await bodyToBuffer(mergedInit?.body);
  setContentLength(headers, bodyBuffer);
  if (mergedInit) {
    mergedInit.body = bodyBuffer as BodyInit | undefined;
  }

  return executeRequest(url, mergedInit, headers, bodyBuffer, redirectCount);
}

export async function secureFetch(
  input: RequestInfo | URL,
  init?: SecureFetchOptions,
): Promise<Response> {
  return secureFetchInternal(input, init, 0);
}
