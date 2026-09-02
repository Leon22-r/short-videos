'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { createServer, resumableUrl } = require('../n8n/provider-uploader/server');

const SESSION_URL = 'https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&upload_id=session-123';

function providerResponse(status, body = null, headers = {}) {
  return new Response(body === null ? null : JSON.stringify(body), {
    status,
    headers: { ...(body === null ? {} : { 'content-type': 'application/json' }), ...headers },
  });
}

async function withServer(t, options = {}) {
  const server = createServer(options);
  try {
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
  } catch (error) {
    if (error?.code !== 'EPERM') throw error;
    t.skip('Host sandbox forbids loopback listeners; this suite is also run inside Docker');
    return null;
  }
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return `http://127.0.0.1:${server.address().port}`;
}

async function post(baseUrl, route, body, authorization = 'Bearer test-access-token') {
  return fetch(`${baseUrl}${route}`, {
    method: 'POST',
    headers: { authorization, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

test('health is unauthenticated but upload routes require a bearer header', async (t) => {
  const baseUrl = await withServer(t, { fetchImpl: async () => assert.fail('provider must not be called') });
  if (!baseUrl) return;
  const health = await fetch(`${baseUrl}/health`);
  assert.equal(health.status, 200);
  assert.deepEqual(await health.json(), { ok: true });

  const denied = await post(baseUrl, '/youtube/probe', { upload_url: SESSION_URL, total_bytes: 4 }, 'Basic nope');
  assert.equal(denied.status, 401);
  assert.equal((await denied.json()).error, 'bearer_required');
});

test('init forwards bearer and exact resumable metadata without exposing it in the response', async (t) => {
  let captured;
  const baseUrl = await withServer(t, {
    fetchImpl: async (url, options) => {
      captured = { url, options };
      return providerResponse(200, null, { location: SESSION_URL });
    },
  });
  if (!baseUrl) return;
  const response = await post(baseUrl, '/youtube/init', {
    total_bytes: 1234,
    mime_type: 'video/mp4',
    metadata: { snippet: { title: 'Short' }, status: { privacyStatus: 'private' } },
  });
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.deepEqual(result, { statusCode: 200, location: SESSION_URL, totalBytes: 1234, mimeType: 'video/mp4', body: null });
  assert.match(captured.url, /^https:\/\/www\.googleapis\.com\/upload\/youtube\/v3\/videos\?/);
  assert.equal(captured.options.headers.authorization, 'Bearer test-access-token');
  assert.equal(captured.options.headers['x-upload-content-length'], '1234');
  assert.equal(captured.options.headers['x-upload-content-type'], 'video/mp4');
  assert.doesNotMatch(JSON.stringify(result), /test-access-token/);
});

test('probe only permits official YouTube session URLs and returns recovery headers', async (t) => {
  const baseUrl = await withServer(t, {
    fetchImpl: async (url, options) => {
      assert.equal(url, SESSION_URL);
      assert.equal(options.method, 'PUT');
      assert.equal(options.headers['content-length'], '0');
      assert.equal(options.headers['content-range'], 'bytes */99');
      return providerResponse(308, null, { range: 'bytes=0-39', 'retry-after': '5' });
    },
  });
  if (!baseUrl) return;
  const response = await post(baseUrl, '/youtube/probe', { upload_url: SESSION_URL, total_bytes: 99 });
  assert.deepEqual(await response.json(), { statusCode: 308, range: 'bytes=0-39', retryAfter: '5', body: null });

  assert.throws(() => resumableUrl('https://evil.example/upload/youtube/v3/videos?upload_id=x'), /not an allowed/);
  const blocked = await post(baseUrl, '/youtube/probe', {
    upload_url: 'https://www.googleapis.com.evil.example/upload/youtube/v3/videos?upload_id=x',
    total_bytes: 99,
  });
  assert.equal(blocked.status, 400);
  assert.equal((await blocked.json()).error, 'upload_url_not_allowed');
});

test('upload streams only the requested file range and never sends a Buffer or base64 body', async (t) => {
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'provider-uploader-data-'));
  t.after(() => fs.rmSync(dataRoot, { recursive: true, force: true }));
  const videoPath = path.join(dataRoot, 'video.mp4');
  fs.writeFileSync(videoPath, Buffer.from('0123456789'));

  let bodyWasStream = false;
  const baseUrl = await withServer(t, {
    dataRoot,
    fetchImpl: async (url, options) => {
      assert.equal(url, SESSION_URL);
      assert.equal(options.headers['content-length'], '6');
      assert.equal(options.headers['content-range'], 'bytes 4-9/10');
      assert.equal(options.headers['content-type'], 'video/mp4');
      bodyWasStream = options.body instanceof fs.ReadStream;
      assert.equal(Buffer.isBuffer(options.body), false);
      assert.equal(typeof options.body, 'object');
      const chunks = [];
      for await (const chunk of options.body) chunks.push(chunk);
      assert.equal(Buffer.concat(chunks).toString(), '456789');
      return providerResponse(201, { id: 'youtube-video-1' });
    },
  });
  if (!baseUrl) return;
  const response = await post(baseUrl, '/youtube/upload', {
    upload_url: SESSION_URL,
    file_path: videoPath,
    total_bytes: 10,
    offset: 4,
    mime_type: 'video/mp4',
  });
  assert.equal(response.status, 200);
  assert.equal(bodyWasStream, true);
  assert.deepEqual(await response.json(), { statusCode: 201, range: '', retryAfter: '', body: { id: 'youtube-video-1' } });
});

test('upload rejects traversal, symlink escape, size drift, and oversized JSON before provider access', async (t) => {
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'provider-uploader-root-'));
  const outsideRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'provider-uploader-outside-'));
  t.after(() => {
    fs.rmSync(dataRoot, { recursive: true, force: true });
    fs.rmSync(outsideRoot, { recursive: true, force: true });
  });
  const outsideFile = path.join(outsideRoot, 'secret.mp4');
  fs.writeFileSync(outsideFile, 'secret');
  const symlink = path.join(dataRoot, 'escape.mp4');
  fs.symlinkSync(outsideFile, symlink);
  const videoPath = path.join(dataRoot, 'video.mp4');
  fs.writeFileSync(videoPath, '1234');

  let calls = 0;
  const baseUrl = await withServer(t, {
    dataRoot,
    bodyLimitBytes: 1024,
    fetchImpl: async () => {
      calls += 1;
      return providerResponse(500);
    },
  });
  if (!baseUrl) return;
  const escaped = await post(baseUrl, '/youtube/upload', {
    upload_url: SESSION_URL, file_path: symlink, total_bytes: 6, mime_type: 'video/mp4',
  });
  assert.equal(escaped.status, 403);
  assert.equal((await escaped.json()).error, 'file_path_not_allowed');

  const drifted = await post(baseUrl, '/youtube/upload', {
    upload_url: SESSION_URL, file_path: videoPath, total_bytes: 5, mime_type: 'video/mp4',
  });
  assert.equal(drifted.status, 409);
  assert.equal((await drifted.json()).error, 'video_size_changed');

  const oversized = await post(baseUrl, '/youtube/init', {
    total_bytes: 4, mime_type: 'video/mp4', metadata: { description: 'x'.repeat(2000) },
  });
  assert.equal(oversized.status, 413);
  assert.equal(calls, 0);
});

test('provider timeout is bounded and sanitized', async (t) => {
  const baseUrl = await withServer(t, {
    providerTimeoutMs: 100,
    fetchImpl: async (_url, options) => new Promise((_resolve, reject) => {
      options.signal.addEventListener('abort', () => reject(Object.assign(new Error('secret provider detail'), { name: 'AbortError' })));
    }),
  });
  if (!baseUrl) return;
  const response = await post(baseUrl, '/youtube/probe', { upload_url: SESSION_URL, total_bytes: 4 });
  assert.equal(response.status, 504);
  assert.deepEqual(await response.json(), { error: 'provider_timeout', message: 'The provider request timed out' });
});
