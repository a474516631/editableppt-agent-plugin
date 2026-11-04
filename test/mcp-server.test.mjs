// End-to-end test of the MCP server against a mock EditablePPT API:
// node --test test/
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, before, test } from 'node:test';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64'
);

// ─── Mock API ───────────────────────────────────────────────────────────────

const api = { tokenPolls: 0, uploads: [], exports: [], balance: 1000, failPage: null, polls: {} };
const TOKEN = 'sk_test_token';
const ok = (res, data) => {
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ code: 0, message: 'ok', data }));
};
const err = (res, status, message) => {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ code: -1, message }));
};
const body = (req) =>
  new Promise((done) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => done(Buffer.concat(chunks)));
  });

const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const authorized = req.headers.authorization === `Bearer ${TOKEN}`;
  if (url.pathname === '/api/agent/token') {
    const { verifier } = JSON.parse(await body(req));
    assert.match(verifier, /^[A-Za-z0-9_-]{43}$/);
    api.verifier = verifier;
    if (++api.tokenPolls < 2) return ok(res, { status: 'pending' });
    return ok(res, { status: 'approved', token: TOKEN, account: { id: 'u1', name: 'Ada', email: 'ada@example.test' } });
  }
  if (!authorized) return err(res, 401, 'Sign in to continue');
  if (url.pathname === '/api/agent/me')
    return ok(res, {
      account: { id: 'u1', name: 'Ada', email: 'ada@example.test' },
      balance: api.balance,
      costs: { standard: 40, layered: 80 },
    });
  if (url.pathname === '/api/agent/logout') return ok(res, { signedOut: true });
  if (url.pathname === '/api/image-conversions/' || url.pathname === '/api/image-conversions') {
    if (req.method === 'POST') {
      const bytes = await body(req);
      const id = crypto.randomUUID();
      const params = Object.fromEntries(url.searchParams);
      api.uploads.push({ id, params, size: bytes.length, type: req.headers['content-type'] });
      api.polls[id] = 0;
      return ok(res, { id, status: 'pending', stage: 'recognizing', progress: 0 });
    }
    const id = url.searchParams.get('id');
    const upload = api.uploads.find((item) => item.id === id);
    if (!upload) return err(res, 404, 'Not found');
    const done = ++api.polls[id] >= 2;
    const failed = done && upload.params.page === api.failPage;
    return ok(res, {
      id,
      status: failed ? 'failed' : done ? 'success' : 'processing',
      stage: done ? 'completed' : 'styling',
      progress: done ? 100 : 40,
      ...(failed ? { error: 'Conversion failed' } : {}),
    });
  }
  if (url.pathname === '/api/image-conversions/export') {
    const request = JSON.parse(await body(req));
    api.exports.push(request);
    res.writeHead(200, {
      'Content-Type': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    });
    return res.end(`PPTX:${request.ids.join(',')}`);
  }
  err(res, 404, 'Not found');
});

// ─── MCP client over stdio ──────────────────────────────────────────────────

let child;
let nextId = 1;
const waiting = new Map();
const notifications = [];

function call(method, params) {
  const id = nextId++;
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
  return new Promise((done) => waiting.set(id, done));
}
async function tool(name, args = {}) {
  const { result } = await call('tools/call', { name, arguments: args, _meta: { progressToken: name } });
  return { text: result.content[0].text, isError: !!result.isError };
}

let work;
let data;
before(async () => {
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  work = await mkdtemp(join(tmpdir(), 'editableppt-agent-test-'));
  data = join(work, 'data');
  child = spawn(process.execPath, [join(root, 'server/editableppt-mcp.mjs')], {
    env: {
      ...process.env,
      EDITABLEPPT_API_BASE: `http://127.0.0.1:${server.address().port}`,
      EDITABLEPPT_NO_BROWSER: '1',
      PLUGIN_DATA: data,
    },
    stdio: ['pipe', 'pipe', 'inherit'],
  });
  createInterface({ input: child.stdout }).on('line', (line) => {
    const message = JSON.parse(line);
    if (message.id !== undefined) waiting.get(message.id)?.(message), waiting.delete(message.id);
    else notifications.push(message);
  });
});

after(async () => {
  child.kill();
  server.close();
  await rm(work, { recursive: true, force: true });
});

// ─── Tests ──────────────────────────────────────────────────────────────────

test('initialize and list tools', async () => {
  const init = await call('initialize', {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'test', version: '0' },
  });
  assert.equal(init.result.protocolVersion, '2025-06-18');
  assert.equal(init.result.serverInfo.name, 'editableppt');
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
  const { result } = await call('tools/list', {});
  assert.deepEqual(
    result.tools.map((item) => item.name),
    [
      'editableppt_sign_in',
      'editableppt_account',
      'editableppt_convert_images',
      'editableppt_wait_for_job',
      'editableppt_list_jobs',
      'editableppt_cancel_job',
      'editableppt_sign_out',
    ]
  );
  const unknown = await call('nope', {});
  assert.equal(unknown.error.code, -32601);
});

test('tools refuse to work before sign-in', async () => {
  const account = await tool('editableppt_account');
  assert.equal(account.isError, true);
  assert.match(account.text, /Not signed in/);
});

test('sign-in returns the authorization URL, then finishes after approval', async () => {
  const first = await tool('editableppt_sign_in', { wait_seconds: 0 });
  assert.match(first.text, /\/agent-connect\?challenge=([A-Za-z0-9_-]{43})/);
  const challenge = first.text.match(/challenge=([A-Za-z0-9_-]{43})/)[1];
  // The URL carries only the challenge; the verifier behind it stays local.
  assert.equal(createHash('sha256').update(api.verifier).digest('base64url'), challenge);
  const second = await tool('editableppt_sign_in', { wait_seconds: 5 });
  assert.match(second.text, /Signed in to EditablePPT as ada@example.test/);
  assert.match(second.text, /Credit balance: 1000/);
  const credentials = join(data, 'credentials.json');
  assert.equal(JSON.parse(await readFile(credentials, 'utf8')).token, TOKEN);
  if (process.platform !== 'win32') assert.equal((await stat(credentials)).mode & 0o777, 0o600);
  assert.equal(existsSync(join(data, 'pending-sign-in.json')), false);
});

test('a folder converts into one deck in natural order', async () => {
  const folder = join(work, 'slides');
  await mkdir(folder);
  for (const name of ['10.png', '2.png', '1.jpg', 'notes.txt']) await writeFile(join(folder, name), PNG);
  const result = await tool('editableppt_convert_images', { images: [folder], title: 'Quarterly review' });
  assert.equal(result.isError, false, result.text);
  assert.deepEqual(
    api.uploads.map((item) => [item.params.title, item.params.page, item.params.total]),
    [
      ['1', '1', '3'],
      ['2', '2', '3'],
      ['10', '3', '3'],
    ]
  );
  assert.equal(new Set(api.uploads.map((item) => item.params.batchId)).size, 1);
  assert.equal(api.uploads[0].params.quality, 'standard');
  const deck = join(folder, 'Quarterly review.pptx');
  assert.match(result.text, /Converted: 3/);
  assert.ok(result.text.includes(deck));
  assert.equal(await readFile(deck, 'utf8'), `PPTX:${api.uploads.map((item) => item.id).join(',')}`);
  assert.ok(notifications.some((item) => item.method === 'notifications/progress'));
});

test('a failed image is reported and the rest are exported; files are never overwritten', async () => {
  api.uploads.length = 0;
  api.failPage = '2';
  const folder = join(work, 'slides');
  const files = ['1.jpg', '2.png', '10.png'].map((name) => join(folder, name));
  const result = await tool('editableppt_convert_images', {
    images: files,
    quality: 'layered',
    title: 'Quarterly review',
  });
  api.failPage = null;
  assert.match(result.text, /Converted: 2, failed: 1/);
  assert.match(result.text, /2\.png: Conversion failed/);
  assert.ok(result.text.includes(join(folder, 'Quarterly review (1).pptx')));
  assert.equal(api.uploads[0].params.quality, 'layered');
});

test('more than 20 images are split into several files', async () => {
  api.exports.length = 0;
  const folder = join(work, 'many');
  await mkdir(folder);
  for (let i = 1; i <= 23; i++) await writeFile(join(folder, `${i}.png`), PNG);
  const result = await tool('editableppt_convert_images', { images: [folder], output: join(work, 'out') });
  assert.deepEqual(
    api.exports.map((item) => item.ids.length),
    [20, 3]
  );
  assert.ok(result.text.includes(join(work, 'out', '1 (part 1).pptx')));
  assert.ok(result.text.includes(join(work, 'out', '1 (part 2).pptx')));
});

test('a job still running is resumed by wait_for_job without uploading again', async () => {
  api.uploads.length = 0;
  const image = join(work, 'slides', '2.png');
  const started = await tool('editableppt_convert_images', { images: [image], wait_seconds: 0 });
  assert.match(started.text, /editableppt_wait_for_job/);
  const jobId = started.text.match(/Job ([0-9a-f-]{36})/)[1];
  const finished = await tool('editableppt_wait_for_job', { job_id: jobId, wait_seconds: 30 });
  assert.match(finished.text, /Converted: 1/);
  assert.equal(api.uploads.length, 1);
  const listed = await tool('editableppt_list_jobs');
  assert.ok(listed.text.includes(jobId));
});

test('nothing is uploaded when the balance does not cover the job', async () => {
  api.uploads.length = 0;
  api.balance = 50;
  const result = await tool('editableppt_convert_images', { images: [join(work, 'slides')] });
  api.balance = 1000;
  assert.equal(result.isError, true);
  assert.match(result.text, /Not enough credits: 3 image\(s\) × 40/);
  assert.equal(api.uploads.length, 0);
});

test('unsupported files are refused before anything is uploaded', async () => {
  const result = await tool('editableppt_convert_images', { images: [join(work, 'slides', 'notes.txt')] });
  assert.equal(result.isError, true);
  assert.match(result.text, /Only PNG and JPG/);
});

test('sign-out revokes and forgets the key', async () => {
  const result = await tool('editableppt_sign_out');
  assert.match(result.text, /Signed out/);
  assert.equal(existsSync(join(data, 'credentials.json')), false);
  assert.ok((await readdir(join(data, 'jobs'))).length > 0);
});
