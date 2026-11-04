#!/usr/bin/env node
// EditablePPT MCP server (stdio, zero dependencies, Node.js 18+).
//
// Turns local PNG/JPG images into an editable PowerPoint deck through the
// EditablePPT API. Sign-in is the same PKCE-style device flow as the Figma
// plugin and the Chrome extension:
//
// 1. Keep a random `verifier`; open /agent-connect?challenge=base64url(sha256(verifier)).
// 2. The user approves the request on the website (signed in there).
// 3. Poll /api/agent/token with the verifier; the first redeem returns a
//    hash-only API key, stored in PLUGIN_DATA (never in plugin files).
//
// The URL alone can't be redeemed: only this process knows the verifier.

import { spawn } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { chmod, mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, extname, join, resolve } from 'node:path';
import { createInterface } from 'node:readline';

const VERSION = '1.0.0';
const API_BASE = (process.env.EDITABLEPPT_API_BASE || 'https://editableppt.com').replace(/\/+$/, '');
const DATA_DIR =
  process.env.PLUGIN_DATA || process.env.CLAUDE_PLUGIN_DATA || join(homedir(), '.editableppt-agent');
const CREDENTIALS = join(DATA_DIR, 'credentials.json');
const PENDING = join(DATA_DIR, 'pending-sign-in.json');
const JOBS = join(DATA_DIR, 'jobs');

const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
const MAX_IMAGES = 100;
/** The export endpoint takes at most 20 conversions per PowerPoint file. */
const SLIDES_PER_FILE = 20;
const PENDING_TTL_MS = 9 * 60 * 1000; // the server keeps approvals for 10 minutes
const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg']);
const TERMINAL = new Set(['success', 'failed', 'canceled']);

// ─── Small helpers ──────────────────────────────────────────────────────────

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
const log = (...args) => console.error('[editableppt]', ...args);

class UserError extends Error {}

class ApiError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

async function readJson(path) {
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch {
    return null;
  }
}

/** Private files (credentials, sign-in verifier) are readable by this user only. */
async function writePrivateJson(path, value) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeFile(path, JSON.stringify(value, null, 2), { mode: 0o600 });
  await chmod(path, 0o600).catch(() => {});
}

function openInBrowser(url) {
  if (process.env.EDITABLEPPT_NO_BROWSER) return false;
  const [command, args] =
    process.platform === 'darwin'
      ? ['open', [url]]
      : process.platform === 'win32'
        ? ['cmd', ['/c', 'start', '', url]]
        : ['xdg-open', [url]];
  try {
    const child = spawn(command, args, { detached: true, stdio: 'ignore' });
    child.on('error', () => {});
    child.unref();
    return true;
  } catch {
    return false;
  }
}

// ─── API client ─────────────────────────────────────────────────────────────

async function request(path, { token, method = 'GET', json, body, headers = {}, timeoutMs = 60_000 } = {}) {
  const init = { method, headers: { ...headers }, signal: AbortSignal.timeout(timeoutMs) };
  if (token) init.headers.Authorization = `Bearer ${token}`;
  if (json !== undefined) {
    init.headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(json);
  } else if (body !== undefined) {
    init.body = body;
  }
  let response;
  try {
    response = await fetch(API_BASE + path, init);
  } catch (error) {
    throw new ApiError(`Could not reach ${API_BASE} (${error?.cause?.code || error?.name || 'network error'})`, 0);
  }
  if (response.headers.get('content-type')?.includes('application/vnd.openxmlformats')) return response;
  const payload = await response.json().catch(() => null);
  if (!response.ok || !payload || payload.code !== 0)
    throw new ApiError(payload?.message || response.statusText || 'Request failed', response.status);
  return payload.data;
}

async function signedIn() {
  const saved = await readJson(CREDENTIALS);
  if (!saved?.token || saved.apiBase !== API_BASE)
    throw new UserError('Not signed in to EditablePPT. Call editableppt_sign_in first.');
  return saved;
}

/** An authenticated call; a rejected key is forgotten so the next sign-in starts clean. */
async function authed(path, options = {}) {
  const { token } = await signedIn();
  try {
    return await request(path, { ...options, token });
  } catch (error) {
    if (error instanceof ApiError && error.status === 401) {
      await rm(CREDENTIALS, { force: true });
      throw new UserError('The EditablePPT sign-in expired or was revoked. Call editableppt_sign_in again.');
    }
    throw error;
  }
}

// ─── Sign-in ────────────────────────────────────────────────────────────────

function newConnectRequest() {
  const verifier = randomBytes(32).toString('base64url');
  const challenge = createHash('sha256').update(verifier, 'utf8').digest('base64url');
  return { apiBase: API_BASE, verifier, challenge, createdAt: Date.now() };
}

function describeAccount(me) {
  return [
    `Signed in to EditablePPT as ${me.account.email}${me.account.name ? ` (${me.account.name})` : ''}.`,
    `Credit balance: ${me.balance}.`,
    `Cost per image: standard ${me.costs.standard} credits, layered ${me.costs.layered} credits.`,
  ].join('\n');
}

async function signIn({ wait_seconds = 90 } = {}) {
  const saved = await readJson(CREDENTIALS);
  if (saved?.token && saved.apiBase === API_BASE) {
    try {
      return describeAccount(await authed('/api/agent/me'));
    } catch (error) {
      if (!(error instanceof UserError)) throw error;
    }
  }
  let pending = await readJson(PENDING);
  const reuse = pending?.apiBase === API_BASE && Date.now() - pending.createdAt < PENDING_TTL_MS;
  if (!reuse) {
    pending = newConnectRequest();
    await writePrivateJson(PENDING, pending);
  }
  const url = `${API_BASE}/agent-connect?challenge=${pending.challenge}`;
  const opened = !reuse && openInBrowser(url);
  const deadline = Date.now() + Math.min(Math.max(wait_seconds, 0), 300) * 1000;
  do {
    let result;
    try {
      result = await request('/api/agent/token', { method: 'POST', json: { verifier: pending.verifier } });
    } catch (error) {
      // 429: polled too fast; anything else is reported below.
      if (!(error instanceof ApiError) || error.status !== 429) throw error;
    }
    if (result?.status === 'approved') {
      await writePrivateJson(CREDENTIALS, {
        apiBase: API_BASE,
        token: result.token,
        account: result.account,
        savedAt: new Date().toISOString(),
      });
      await rm(PENDING, { force: true });
      return describeAccount(await authed('/api/agent/me'));
    }
    if (Date.now() >= deadline) break;
    await sleep(2000);
  } while (true);
  return [
    opened
      ? 'Opened the EditablePPT authorization page in the browser.'
      : 'Open this EditablePPT authorization page in a browser:',
    url,
    '',
    'Ask the user to sign in there and click Authorize, then call editableppt_sign_in again to finish.',
    'The link stays valid for about 10 minutes.',
  ].join('\n');
}

async function signOut() {
  const saved = await readJson(CREDENTIALS);
  await rm(PENDING, { force: true });
  if (!saved?.token) return 'Not signed in.';
  try {
    await request('/api/agent/logout', { method: 'POST', token: saved.token });
  } catch (error) {
    if (!(error instanceof ApiError) || error.status !== 401) throw error;
  }
  await rm(CREDENTIALS, { force: true });
  return 'Signed out of EditablePPT and revoked this plugin’s key.';
}

// ─── Inputs ─────────────────────────────────────────────────────────────────

function imageType(bytes) {
  if (bytes.length > 8 && bytes[0] === 0x89 && bytes.toString('latin1', 1, 4) === 'PNG') return 'png';
  if (bytes.length > 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'jpeg';
  return null;
}

/** Files in the given order; a directory adds its PNG/JPG files in natural name order. */
async function collectImages(paths) {
  const files = [];
  for (const raw of paths) {
    const path = resolve(raw.replace(/^~(?=$|\/)/, homedir()));
    const info = await stat(path).catch(() => null);
    if (!info) throw new UserError(`Not found: ${raw}`);
    if (info.isDirectory()) {
      const names = (await readdir(path))
        .filter((name) => !name.startsWith('.') && IMAGE_EXTENSIONS.has(extname(name).toLowerCase()))
        .sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' }));
      if (!names.length) throw new UserError(`No PNG or JPG images in ${raw}`);
      files.push(...names.map((name) => join(path, name)));
    } else {
      if (!IMAGE_EXTENSIONS.has(extname(path).toLowerCase()))
        throw new UserError(`Only PNG and JPG images are supported: ${raw}. Convert it to PNG first.`);
      files.push(path);
    }
  }
  if (!files.length) throw new UserError('No images given.');
  if (files.length > MAX_IMAGES)
    throw new UserError(`At most ${MAX_IMAGES} images per job (got ${files.length}). Split them into several jobs.`);
  for (const file of files) {
    const { size } = await stat(file);
    if (size > MAX_IMAGE_BYTES) throw new UserError(`Larger than 20 MB: ${file}`);
  }
  return files;
}

const titleOf = (file) => basename(file, extname(file)).slice(0, 120) || 'Image';

/** Output .pptx paths, one per file of up to SLIDES_PER_FILE slides; never overwrites. */
function outputPaths(job, parts) {
  let base = job.output;
  if (!base) base = join(dirname(job.items[0].file), `${job.title}.pptx`);
  else if (!base.toLowerCase().endsWith('.pptx')) base = join(base, `${job.title}.pptx`);
  const stem = base.slice(0, -'.pptx'.length);
  return Array.from({ length: parts }, (_, index) => {
    const wanted = parts > 1 ? `${stem} (part ${index + 1})` : stem;
    let candidate = `${wanted}.pptx`;
    for (let n = 1; existsSync(candidate); n++) candidate = `${wanted} (${n}).pptx`;
    return candidate;
  });
}

// ─── Jobs ───────────────────────────────────────────────────────────────────

const jobPath = (id) => join(JOBS, `${id}.json`);
const saveJob = (job) => writePrivateJson(jobPath(job.id), job);

async function loadJob(id) {
  if (!/^[0-9a-f-]{36}$/i.test(id || '')) throw new UserError('Invalid job_id.');
  const job = await readJson(jobPath(id));
  if (!job) throw new UserError(`No local job ${id}. Use editableppt_list_jobs to see recent jobs.`);
  return job;
}

function progressNotifier(extra) {
  const token = extra?.progressToken;
  let count = 0;
  return (message) => {
    if (token === undefined) return;
    send({ jsonrpc: '2.0', method: 'notifications/progress', params: { progressToken: token, progress: ++count, message } });
  };
}

async function submit(job, notify) {
  const quality = job.quality;
  for (const item of job.items) {
    if (item.taskId || item.status !== 'queued') continue;
    const bytes = await readFile(item.file);
    const type = imageType(bytes);
    if (!type) {
      Object.assign(item, { status: 'rejected', error: 'Not a valid PNG or JPG file' });
      await saveJob(job);
      continue;
    }
    const params = new URLSearchParams({
      title: titleOf(item.file),
      quality,
      batchId: job.id,
      page: String(item.page),
      total: String(job.items.length),
      batchTitle: job.title,
    });
    if (job.refine) params.set('refine', '1');
    notify(`Uploading ${item.page}/${job.items.length}: ${basename(item.file)}`);
    let task;
    for (let attempt = 0; ; attempt++) {
      try {
        task = await authed(`/api/image-conversions?${params}`, {
          method: 'POST',
          body: bytes,
          headers: { 'Content-Type': type === 'png' ? 'image/png' : 'image/jpeg' },
          timeoutMs: 180_000,
        });
        break;
      } catch (error) {
        if (error instanceof ApiError && (error.status === 429 || error.status === 503) && attempt < 3) {
          await sleep(3000 * (attempt + 1));
          continue;
        }
        if (error instanceof ApiError && error.status === 402) {
          // Images already submitted stay charged and finish; stop here.
          for (const rest of job.items)
            if (!rest.taskId && rest.status === 'queued')
              Object.assign(rest, { status: 'skipped', error: 'Not enough credits' });
          await saveJob(job);
          return;
        }
        if (error instanceof ApiError && error.status >= 400 && error.status < 500 && error.status !== 401) {
          Object.assign(item, { status: 'rejected', error: error.message });
          break;
        }
        throw error;
      }
    }
    if (task) Object.assign(item, { taskId: task.id, status: task.status, progress: task.progress ?? 0 });
    await saveJob(job);
    await sleep(250);
  }
}

async function poll(job, deadline, notify) {
  while (true) {
    const active = job.items.filter((item) => item.taskId && !TERMINAL.has(item.status));
    for (const item of active) {
      try {
        const task = await authed(`/api/image-conversions?id=${encodeURIComponent(item.taskId)}`, { timeoutMs: 30_000 });
        Object.assign(item, { status: task.status, progress: task.progress ?? item.progress });
        if (task.status === 'failed' || task.status === 'canceled')
          item.error = task.error || `Conversion ${task.status}`;
      } catch (error) {
        if (error instanceof UserError) throw error;
        log('poll failed', item.taskId, error.message); // transient; try again next round
      }
    }
    await saveJob(job);
    const remaining = job.items.filter((item) => item.taskId && !TERMINAL.has(item.status));
    if (!remaining.length) return true;
    const done = job.items.length - remaining.length;
    const average = Math.round(remaining.reduce((sum, item) => sum + (item.progress || 0), 0) / remaining.length);
    notify(`Converting: ${done}/${job.items.length} finished, others at ~${average}%`);
    if (Date.now() + 4000 > deadline) return false;
    await sleep(4000);
  }
}

async function exportDeck(job, notify) {
  const converted = job.items.filter((item) => item.status === 'success');
  if (!converted.length) return;
  const parts = [];
  for (let i = 0; i < converted.length; i += SLIDES_PER_FILE) parts.push(converted.slice(i, i + SLIDES_PER_FILE));
  const paths = outputPaths(job, parts.length);
  job.files = [];
  for (const [index, part] of parts.entries()) {
    notify(`Building PowerPoint ${index + 1}/${parts.length}`);
    const title = parts.length > 1 ? `${job.title} (part ${index + 1})` : job.title;
    const response = await authed('/api/image-conversions/export', {
      method: 'POST',
      json: { ids: part.map((item) => item.taskId), title: title.slice(0, 120) },
      timeoutMs: 300_000,
    });
    const bytes = Buffer.from(await response.arrayBuffer());
    await mkdir(dirname(paths[index]), { recursive: true });
    await writeFile(paths[index], bytes);
    job.files.push({ path: paths[index], slides: part.length, pages: part.map((item) => item.page) });
  }
  job.exportedAt = new Date().toISOString();
  await saveJob(job);
}

function report(job, finished) {
  const count = (status) => job.items.filter((item) => item.status === status).length;
  const lines = [
    `Job ${job.id} — "${job.title}" (${job.quality}, ${job.items.length} image${job.items.length === 1 ? '' : 's'})`,
    `Converted: ${count('success')}, failed: ${count('failed') + count('canceled') + count('rejected')}, ` +
      `skipped: ${count('skipped')}, still running: ${job.items.filter((item) => item.taskId && !TERMINAL.has(item.status)).length}`,
  ];
  if (job.files?.length) {
    lines.push('', 'Editable PowerPoint:');
    for (const file of job.files) lines.push(`- ${file.path} (${file.slides} slide${file.slides === 1 ? '' : 's'})`);
  }
  const problems = job.items.filter((item) => item.error);
  if (problems.length) {
    lines.push('', 'Problems (failed and canceled conversions are refunded automatically):');
    for (const item of problems) lines.push(`- ${basename(item.file)}: ${item.error}`);
  }
  if (!finished)
    lines.push(
      '',
      'Conversions keep running on the server. Call editableppt_wait_for_job with this job_id to keep waiting; it writes the .pptx when they finish.'
    );
  return lines.join('\n');
}

async function runJob(job, waitSeconds, extra) {
  const notify = progressNotifier(extra);
  const deadline = Date.now() + Math.min(Math.max(waitSeconds, 0), 900) * 1000;
  await submit(job, notify);
  const finished = await poll(job, deadline, notify);
  if (finished && !job.exportedAt) await exportDeck(job, notify);
  return report(job, finished);
}

async function convertImages(args, extra) {
  const quality = args.quality === 'layered' ? 'layered' : 'standard';
  const files = await collectImages(Array.isArray(args.images) ? args.images : [args.images].filter(Boolean));
  const me = await authed('/api/agent/me');
  const cost = me.costs[quality] * files.length;
  if (me.balance < cost)
    throw new UserError(
      `Not enough credits: ${files.length} image(s) × ${me.costs[quality]} (${quality}) = ${cost} credits, balance is ${me.balance}. ` +
        `Top up at ${API_BASE}/pricing or convert fewer images.`
    );
  const job = {
    id: randomUUID(),
    apiBase: API_BASE,
    title: (args.title || titleOf(files[0])).trim().slice(0, 120) || 'Editable slides',
    quality,
    refine: quality === 'layered' && args.refine === true,
    output: args.output ? resolve(String(args.output).replace(/^~(?=$|\/)/, homedir())) : undefined,
    createdAt: new Date().toISOString(),
    cost,
    items: files.map((file, index) => ({ page: index + 1, file, status: 'queued' })),
  };
  await saveJob(job);
  return runJob(job, args.wait_seconds ?? 240, extra);
}

async function waitForJob(args, extra) {
  const job = await loadJob(args.job_id);
  if (job.apiBase !== API_BASE) throw new UserError(`Job ${job.id} belongs to ${job.apiBase}.`);
  return runJob(job, args.wait_seconds ?? 240, extra);
}

async function cancelJob(args) {
  const job = await loadJob(args.job_id);
  let canceled = 0;
  for (const item of job.items) {
    if (item.status === 'queued') Object.assign(item, { status: 'skipped', error: 'Canceled before upload' });
    if (!item.taskId || TERMINAL.has(item.status)) continue;
    try {
      const task = await authed(`/api/image-conversions?id=${encodeURIComponent(item.taskId)}`, { method: 'DELETE' });
      Object.assign(item, { status: task.status, error: 'Canceled' });
      canceled++;
    } catch (error) {
      if (error instanceof UserError) throw error;
      item.error = `Cancel failed: ${error.message}`;
    }
  }
  await saveJob(job);
  return `Canceled ${canceled} running conversion(s); their credits are refunded.\n\n${report(job, true)}`;
}

async function listJobs() {
  const names = existsSync(JOBS) ? await readdir(JOBS) : [];
  const jobs = (await Promise.all(names.map((name) => readJson(join(JOBS, name)))))
    .filter(Boolean)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .slice(0, 10);
  if (!jobs.length) return 'No conversion jobs yet.';
  return jobs
    .map((job) => {
      const ok = job.items.filter((item) => item.status === 'success').length;
      const state = job.exportedAt ? 'done' : job.items.some((i) => i.taskId && !TERMINAL.has(i.status)) ? 'running' : 'not exported';
      return `- ${job.id} | ${job.createdAt} | "${job.title}" | ${ok}/${job.items.length} converted | ${state}${
        job.files?.length ? ` | ${job.files.map((file) => file.path).join(', ')}` : ''
      }`;
    })
    .join('\n');
}

// ─── MCP tools ──────────────────────────────────────────────────────────────

const TOOLS = [
  {
    name: 'editableppt_sign_in',
    description:
      'Sign in to EditablePPT. Opens an authorization page in the browser (the URL is also returned) and waits for the user to click Authorize. If it returns before approval, call it again after the user approves. Returns the account and credit balance when signed in.',
    inputSchema: {
      type: 'object',
      properties: {
        wait_seconds: { type: 'number', description: 'How long to wait for approval in this call (0-300, default 90).' },
      },
      additionalProperties: false,
    },
    annotations: { title: 'Sign in to EditablePPT', readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    run: signIn,
  },
  {
    name: 'editableppt_account',
    description: 'Show the signed-in EditablePPT account, credit balance, and the credit cost per image for each quality.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    annotations: { title: 'EditablePPT account', readOnlyHint: true, openWorldHint: true },
    run: async () => describeAccount(await authed('/api/agent/me')),
  },
  {
    name: 'editableppt_convert_images',
    description:
      'Convert PNG/JPG images (slides, posters, screenshots) into one editable PowerPoint deck, one slide per image, with real text boxes over separated image layers. SPENDS CREDITS: each image costs the per-image price shown by editableppt_account (standard or layered). Accepts files and/or directories (directory images are taken in natural name order). Writes the .pptx next to the first image unless `output` is given; more than 20 images produce several files of up to 20 slides. If conversions are still running when wait_seconds runs out, returns a job_id for editableppt_wait_for_job.',
    inputSchema: {
      type: 'object',
      properties: {
        images: {
          type: 'array',
          items: { type: 'string' },
          minItems: 1,
          description: 'Absolute paths of PNG/JPG files or directories containing them, in slide order (max 100 images, 20 MB each).',
        },
        quality: {
          type: 'string',
          enum: ['standard', 'layered'],
          description:
            'standard: editable text over the image layers (cheaper, faster). layered: also separates photos, icons/decorations, cards and the background into depth layers.',
        },
        refine: { type: 'boolean', description: 'Layered only: also rebuild cards and buttons as native shapes.' },
        title: { type: 'string', description: 'Deck title and file name (default: first image name).' },
        output: { type: 'string', description: 'Output .pptx path, or a directory to write into.' },
        wait_seconds: {
          type: 'number',
          description: 'How long this call waits for the conversions (0-900, default 240). Standard images usually take 1-3 minutes.',
        },
      },
      required: ['images'],
      additionalProperties: false,
    },
    annotations: { title: 'Convert images to editable PowerPoint', readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    run: convertImages,
  },
  {
    name: 'editableppt_wait_for_job',
    description:
      'Keep waiting for a conversion job started by editableppt_convert_images and write its .pptx when every image has finished. Images already uploaded are not charged again; only uploads that never started (for example after a network error) are submitted now.',
    inputSchema: {
      type: 'object',
      properties: {
        job_id: { type: 'string', description: 'The job_id returned by editableppt_convert_images.' },
        wait_seconds: { type: 'number', description: 'How long to wait in this call (0-900, default 240).' },
      },
      required: ['job_id'],
      additionalProperties: false,
    },
    annotations: { title: 'Wait for a conversion job', readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    run: waitForJob,
  },
  {
    name: 'editableppt_list_jobs',
    description: 'List the 10 most recent local conversion jobs with their status and output files.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    annotations: { title: 'List conversion jobs', readOnlyHint: true, openWorldHint: false },
    run: listJobs,
  },
  {
    name: 'editableppt_cancel_job',
    description: 'Cancel the unfinished conversions of a job. Canceled conversions are refunded.',
    inputSchema: {
      type: 'object',
      properties: { job_id: { type: 'string' } },
      required: ['job_id'],
      additionalProperties: false,
    },
    annotations: { title: 'Cancel a conversion job', readOnlyHint: false, destructiveHint: true, openWorldHint: true },
    run: cancelJob,
  },
  {
    name: 'editableppt_sign_out',
    description: 'Sign out of EditablePPT and revoke the key this plugin was given.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    annotations: { title: 'Sign out of EditablePPT', readOnlyHint: false, destructiveHint: true, openWorldHint: true },
    run: signOut,
  },
];

// ─── JSON-RPC over stdio ────────────────────────────────────────────────────

const PROTOCOL_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

async function handle(message) {
  const { id, method, params } = message;
  switch (method) {
    case 'initialize':
      return {
        protocolVersion: PROTOCOL_VERSIONS.includes(params?.protocolVersion) ? params.protocolVersion : PROTOCOL_VERSIONS[0],
        capabilities: { tools: {} },
        serverInfo: { name: 'editableppt', title: 'EditablePPT', version: VERSION },
        instructions:
          'Converts images into editable PowerPoint decks through EditablePPT. Sign in with editableppt_sign_in, check the cost with editableppt_account and confirm it with the user before calling editableppt_convert_images, which spends credits.',
      };
    case 'ping':
      return {};
    case 'tools/list':
      return { tools: TOOLS.map(({ run, ...tool }) => tool) };
    case 'tools/call': {
      const tool = TOOLS.find((item) => item.name === params?.name);
      if (!tool) throw Object.assign(new Error(`Unknown tool: ${params?.name}`), { code: -32602 });
      try {
        const text = await tool.run(params.arguments || {}, params._meta || {});
        return { content: [{ type: 'text', text }] };
      } catch (error) {
        if (!(error instanceof UserError || error instanceof ApiError)) log(error);
        return { content: [{ type: 'text', text: error.message || String(error) }], isError: true };
      }
    }
    default:
      if (id === undefined) return undefined; // notifications need no answer
      throw Object.assign(new Error(`Method not found: ${method}`), { code: -32601 });
  }
}

const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
input.on('line', async (line) => {
  if (!line.trim()) return;
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
    return;
  }
  try {
    const result = await handle(message);
    if (message.id !== undefined) send({ jsonrpc: '2.0', id: message.id, result });
  } catch (error) {
    if (message.id !== undefined)
      send({ jsonrpc: '2.0', id: message.id, error: { code: error.code || -32603, message: error.message } });
  }
});
input.on('close', () => process.exit(0));
