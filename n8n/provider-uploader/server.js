'use strict';

const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');

const DEFAULT_DATA_ROOT = '/data';
const DEFAULT_BODY_LIMIT_BYTES = 1024 * 1024;
const DEFAULT_PROVIDER_TIMEOUT_MS = 30 * 60 * 1000;
const DEFAULT_PROVIDER_RESPONSE_LIMIT_BYTES = 1024 * 1024;
const MAX_VIDEO_BYTES = 256 * 1024 * 1024 * 1024;
const YOUTUBE_INIT_URL = 'https://www.googleapis.com/upload/youtube/v3/videos';
const YOUTUBE_UPLOAD_PATH = '/upload/youtube/v3/videos';

class RequestError extends Error {
  constructor(statusCode, code, message) {
    super(message);
    this.statusCode = statusCode;
    this.code = code;
  }
}

function integerSetting(value, fallback, minimum, maximum) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= minimum && parsed <= maximum ? parsed : fallback;
}

function requireBearer(req) {
  const authorization = String(req.headers.authorization || '');
  if (!/^Bearer [^\s]+$/i.test(authorization) || authorization.length > 8192) {
    throw new RequestError(401, 'bearer_required', 'A valid Bearer authorization header is required');
  }
  return authorization;
}

async function readJson(req, limitBytes) {
  const contentType = String(req.headers['content-type'] || '').split(';', 1)[0].trim().toLowerCase();
  if (contentType !== 'application/json') {
    throw new RequestError(415, 'json_required', 'Content-Type must be application/json');
  }

  const declaredLength = Number(req.headers['content-length']);
  if (Number.isFinite(declaredLength) && declaredLength > limitBytes) {
    throw new RequestError(413, 'body_too_large', 'Request body exceeds the configured limit');
  }

  const chunks = [];
  let received = 0;
  for await (const chunk of req) {
    received += chunk.length;
    if (received > limitBytes) {
      throw new RequestError(413, 'body_too_large', 'Request body exceeds the configured limit');
    }
    chunks.push(chunk);
  }

  if (received === 0) throw new RequestError(400, 'body_required', 'A JSON request body is required');
  try {
    const value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('not an object');
    return value;
  } catch {
    throw new RequestError(400, 'invalid_json', 'Request body must be a JSON object');
  }
}

function positiveVideoSize(value, field = 'total_bytes') {
  const size = Number(value);
  if (!Number.isSafeInteger(size) || size <= 0 || size > MAX_VIDEO_BYTES) {
    throw new RequestError(400, 'invalid_video_size', `${field} must be a positive integer no larger than 256 GiB`);
  }
  return size;
}

function videoMime(value) {
  const mime = String(value || '').trim().toLowerCase();
  if (mime === 'application/octet-stream' || /^video\/[a-z0-9][a-z0-9.+-]*$/.test(mime)) return mime;
  throw new RequestError(400, 'invalid_video_mime', 'mime_type must be video/* or application/octet-stream');
}

function resumableUrl(value) {
  let parsed;
  try {
    parsed = new URL(String(value || ''));
  } catch {
    throw new RequestError(400, 'invalid_upload_url', 'upload_url must be a valid URL');
  }

  const validPort = parsed.port === '' || parsed.port === '443';
  if (
    parsed.protocol !== 'https:'
    || parsed.hostname !== 'www.googleapis.com'
    || !validPort
    || parsed.username
    || parsed.password
    || parsed.pathname !== YOUTUBE_UPLOAD_PATH
    || !parsed.searchParams.get('upload_id')
  ) {
    throw new RequestError(400, 'upload_url_not_allowed', 'upload_url is not an allowed YouTube resumable session URL');
  }
  return parsed.toString();
}

async function confinedVideoFile(filePath, dataRoot) {
  if (typeof filePath !== 'string' || !path.isAbsolute(filePath)) {
    throw new RequestError(400, 'invalid_file_path', 'file_path must be an absolute path under /data');
  }

  let realRoot;
  let realFile;
  try {
    [realRoot, realFile] = await Promise.all([
      fs.promises.realpath(dataRoot),
      fs.promises.realpath(filePath),
    ]);
  } catch {
    throw new RequestError(404, 'video_not_found', 'The requested video file does not exist');
  }

  if (realFile !== realRoot && !realFile.startsWith(`${realRoot}${path.sep}`)) {
    throw new RequestError(403, 'file_path_not_allowed', 'file_path must resolve under /data');
  }

  const stat = await fs.promises.stat(realFile);
  if (!stat.isFile()) throw new RequestError(400, 'not_a_file', 'file_path must reference a regular file');
  if (!Number.isSafeInteger(stat.size) || stat.size <= 0 || stat.size > MAX_VIDEO_BYTES) {
    throw new RequestError(400, 'invalid_video_size', 'Video file size is outside the supported range');
  }
  return { realFile, size: stat.size };
}

async function readProviderBody(response, limitBytes) {
  if (!response.body) return null;
  const chunks = [];
  let received = 0;
  for await (const chunk of response.body) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    received += bytes.length;
    if (received > limitBytes) throw new RequestError(502, 'provider_response_too_large', 'Provider response exceeded the configured limit');
    chunks.push(bytes);
  }
  if (received === 0) return null;
  const text = Buffer.concat(chunks).toString('utf8');
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

async function providerFetch(fetchImpl, url, options, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  timer.unref?.();
  try {
    return await fetchImpl(url, { ...options, signal: controller.signal, redirect: 'manual' });
  } catch (error) {
    if (controller.signal.aborted || error?.name === 'AbortError') {
      throw new RequestError(504, 'provider_timeout', 'The provider request timed out');
    }
    throw new RequestError(502, 'provider_unavailable', 'The provider request failed');
  } finally {
    clearTimeout(timer);
  }
}

function sendJson(res, statusCode, value) {
  const body = Buffer.from(JSON.stringify(value));
  res.writeHead(statusCode, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': body.length,
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  });
  res.end(body);
}

function createHandler(options = {}) {
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  if (typeof fetchImpl !== 'function') throw new Error('A Fetch API implementation is required');
  const dataRoot = options.dataRoot || DEFAULT_DATA_ROOT;
  const bodyLimitBytes = integerSetting(options.bodyLimitBytes, DEFAULT_BODY_LIMIT_BYTES, 1024, 2 * 1024 * 1024);
  const providerTimeoutMs = integerSetting(options.providerTimeoutMs, DEFAULT_PROVIDER_TIMEOUT_MS, 100, 2 * 60 * 60 * 1000);
  const providerResponseLimitBytes = integerSetting(options.providerResponseLimitBytes, DEFAULT_PROVIDER_RESPONSE_LIMIT_BYTES, 1024, 2 * 1024 * 1024);

  return async function handler(req, res) {
    try {
      const url = new URL(req.url, 'http://provider-uploader.internal');
      if (req.method === 'GET' && url.pathname === '/health') {
        sendJson(res, 200, { ok: true });
        return;
      }
      if (req.method !== 'POST' || !['/youtube/init', '/youtube/probe', '/youtube/upload'].includes(url.pathname)) {
        throw new RequestError(404, 'not_found', 'Route not found');
      }

      const authorization = requireBearer(req);
      const input = await readJson(req, bodyLimitBytes);

      if (url.pathname === '/youtube/init') {
        const file = input.file_path ? await confinedVideoFile(input.file_path, dataRoot) : null;
        const totalBytes = file ? file.size : positiveVideoSize(input.total_bytes);
        const mimeType = videoMime(input.mime_type);
        if (!input.metadata || typeof input.metadata !== 'object' || Array.isArray(input.metadata)) {
          throw new RequestError(400, 'invalid_metadata', 'metadata must be a JSON object');
        }
        const query = new URLSearchParams({
          uploadType: 'resumable',
          part: 'snippet,status',
          notifySubscribers: input.notify_subscribers === true ? 'true' : 'false',
        });
        const metadataBody = JSON.stringify(input.metadata);
        const response = await providerFetch(fetchImpl, `${YOUTUBE_INIT_URL}?${query}`, {
          method: 'POST',
          headers: {
            authorization,
            'content-type': 'application/json; charset=UTF-8',
            'content-length': String(Buffer.byteLength(metadataBody)),
            'x-upload-content-length': String(totalBytes),
            'x-upload-content-type': mimeType,
          },
          body: metadataBody,
        }, providerTimeoutMs);
        const body = await readProviderBody(response, providerResponseLimitBytes);
        const location = response.headers.get('location') || '';
        if (location) resumableUrl(location);
        sendJson(res, 200, { statusCode: response.status, location, totalBytes, mimeType, body });
        return;
      }

      const uploadUrl = resumableUrl(input.upload_url);
      const totalBytes = positiveVideoSize(input.total_bytes);
      if (url.pathname === '/youtube/probe') {
        const response = await providerFetch(fetchImpl, uploadUrl, {
          method: 'PUT',
          headers: {
            authorization,
            'content-length': '0',
            'content-range': `bytes */${totalBytes}`,
          },
        }, providerTimeoutMs);
        const body = await readProviderBody(response, providerResponseLimitBytes);
        sendJson(res, 200, {
          statusCode: response.status,
          range: response.headers.get('range') || '',
          retryAfter: response.headers.get('retry-after') || '',
          body,
        });
        return;
      }

      const { realFile, size } = await confinedVideoFile(input.file_path, dataRoot);
      if (size !== totalBytes) throw new RequestError(409, 'video_size_changed', 'total_bytes does not match the current video file size');
      const mimeType = videoMime(input.mime_type);
      const offset = input.offset === undefined ? 0 : Number(input.offset);
      if (!Number.isSafeInteger(offset) || offset < 0 || offset >= size) {
        throw new RequestError(400, 'invalid_offset', 'offset must identify a byte inside the video file');
      }
      const remainingBytes = size - offset;
      const stream = fs.createReadStream(realFile, { start: offset });
      let response;
      try {
        response = await providerFetch(fetchImpl, uploadUrl, {
          method: 'PUT',
          headers: {
            authorization,
            'content-type': mimeType,
            'content-length': String(remainingBytes),
            'content-range': `bytes ${offset}-${size - 1}/${size}`,
          },
          body: stream,
          duplex: 'half',
        }, providerTimeoutMs);
      } finally {
        if (!stream.destroyed) stream.destroy();
      }
      const body = await readProviderBody(response, providerResponseLimitBytes);
      sendJson(res, 200, {
        statusCode: response.status,
        range: response.headers.get('range') || '',
        retryAfter: response.headers.get('retry-after') || '',
        body,
      });
    } catch (error) {
      if (!res.headersSent) {
        const statusCode = error instanceof RequestError ? error.statusCode : 500;
        const code = error instanceof RequestError ? error.code : 'internal_error';
        const message = error instanceof RequestError ? error.message : 'Internal server error';
        sendJson(res, statusCode, { error: code, message });
      } else {
        res.destroy();
      }
    }
  };
}

function createServer(options = {}) {
  const server = http.createServer(createHandler(options));
  server.requestTimeout = integerSetting(options.requestTimeoutMs, 30_000, 1000, 120_000);
  server.headersTimeout = integerSetting(options.headersTimeoutMs, 10_000, 1000, 60_000);
  server.keepAliveTimeout = 5_000;
  server.maxHeadersCount = 50;
  return server;
}

if (require.main === module) {
  const port = integerSetting(process.env.PORT, 8080, 1, 65535);
  const server = createServer({
    bodyLimitBytes: integerSetting(process.env.BODY_LIMIT_BYTES, DEFAULT_BODY_LIMIT_BYTES, 1024, 2 * 1024 * 1024),
    providerTimeoutMs: integerSetting(process.env.PROVIDER_TIMEOUT_MS, DEFAULT_PROVIDER_TIMEOUT_MS, 100, 2 * 60 * 60 * 1000),
  });
  server.listen(port, '0.0.0.0');
  server.on('error', () => {
    process.exitCode = 1;
  });
}

module.exports = {
  MAX_VIDEO_BYTES,
  YOUTUBE_INIT_URL,
  createHandler,
  createServer,
  resumableUrl,
};
