import { bootstrapFromR2 } from './bootstrap.js';
import {
  listCanvasProjects,
  loadCanvasProject,
  saveCanvasProject,
  setActiveCanvas,
} from './canvas.js';
import { handleError, HttpError, json, readJson, requireBasicAuth } from './http.js';
import {
  applyReviewActions,
  createCard,
  createNote,
  getLearningSnapshot,
  patchCard,
  patchDay,
  patchNote,
  putManualRecords,
  replaceLearningSnapshot,
  restoreNote,
} from './learning.js';
import { detectQuestions } from './ai.js';
import { getGlobalAiSettings } from './ai-config.js';
import {
  enqueueRenameJob,
  getBackgroundJob,
  kickPendingJobs,
  listBackgroundJobs,
  processBackgroundJob,
} from './background-jobs.js';
import { getNoteFile, saveNote } from './media.js';
import { githubStorageInfo } from './github-store.js';
import { readAppState, writeAppState } from './storage.js';

const WRITE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

function apiPath(pathname) {
  if (pathname === '/api') return '/';
  return pathname.startsWith('/api/') ? pathname.slice(4) : null;
}

function publicReadEnabled(env) {
  return ['1', 'true', 'yes', 'on'].includes(String(env.PUBLIC_READ_ENABLED || '').trim().toLowerCase());
}

function unavailable(feature) {
  throw new HttpError(501, `${feature} is available only in the local Windows app.`, 'LOCAL_ONLY_FEATURE');
}

function cloudDeleteDisabled() {
  throw new HttpError(403, '云端不允许永久删除。请在 Windows 本地笔记目录执行删除。', 'CLOUD_DELETE_DISABLED');
}

function enforceWriteRequest(request, url, pathname) {
  if (!WRITE_METHODS.has(request.method)) return;
  const fetchSite = request.headers.get('sec-fetch-site')?.toLowerCase();
  const origin = request.headers.get('origin');
  if (fetchSite === 'cross-site' || (origin && origin !== url.origin)) {
    throw new HttpError(403, 'Cross-site writes are not allowed.', 'CSRF_REJECTED');
  }
  const noJsonBody = new Set(['/admin/bootstrap', '/organizer/run']);
  if (noJsonBody.has(pathname)) return;
  const contentType = request.headers.get('content-type')?.toLowerCase() ?? '';
  if (!contentType.startsWith('application/json')) {
    throw new HttpError(415, 'Write requests must use application/json.', 'JSON_CONTENT_TYPE_REQUIRED');
  }
}

async function handleLearningRoute(request, env, pathname, ctx) {
  if (request.method === 'GET' && pathname === '/learning-data') {
    return json(await getLearningSnapshot(env));
  }
  if (request.method === 'POST' && pathname === '/learning-data/seed') {
    const payload = await readJson(request, 12 * 1024 * 1024);
    return json(await replaceLearningSnapshot(env, payload.snapshot ?? payload.learningData, payload.expectedRevision ?? 0));
  }
  if (request.method === 'PATCH' && pathname === '/learning-data/day') {
    return json(await patchDay(env, await readJson(request)));
  }
  if (request.method === 'PUT' && pathname === '/learning-data/manual-records') {
    return json(await putManualRecords(env, await readJson(request)));
  }
  if (request.method === 'POST' && pathname === '/learning-data/notes') {
    return json(await createNote(env, await readJson(request)), 201);
  }
  if (request.method === 'POST' && pathname === '/learning-data/cards') {
    return json(await createCard(env, await readJson(request)), 201);
  }
  if (request.method === 'POST' && pathname === '/learning-data/note-review-actions') {
    const payload = await readJson(request, 512 * 1024);
    const result = await applyReviewActions(env, payload.actions);
    return json(result.body, result.status);
  }
  if (request.method === 'GET' && pathname === '/learning-data/events') {
    return json({ ok: false, code: 'POLLING_REQUIRED', error: 'Cloud synchronization uses polling.' }, 501);
  }
  if (request.method === 'GET' && pathname === '/schedule-records') {
    const snapshot = await getLearningSnapshot(env);
    const records = Object.fromEntries(Object.entries(snapshot.days).map(([date, day]) => [date, day.manual]));
    return json({ ok: true, revision: snapshot.revision, records });
  }

  const noteRename = /^\/learning-data\/notes\/([^/]+)\/rename$/.exec(pathname);
  if (noteRename && request.method === 'POST') {
    await readJson(request, 64 * 1024);
    const { job, replayed } = await enqueueRenameJob(env, decodeURIComponent(noteRename[1]));
    ctx?.waitUntil?.(processBackgroundJob(env, job.id));
    return json({ ok: true, accepted: true, replayed, job }, 202);
  }
  const noteRestore = /^\/learning-data\/notes\/([^/]+)\/restore$/.exec(pathname);
  if (noteRestore && request.method === 'POST') {
    return json(await restoreNote(env, decodeURIComponent(noteRestore[1]), await readJson(request)));
  }
  const note = /^\/learning-data\/notes\/([^/]+)$/.exec(pathname);
  if (note && request.method === 'PATCH') {
    return json(await patchNote(env, decodeURIComponent(note[1]), await readJson(request)));
  }
  if (note && request.method === 'DELETE') cloudDeleteDisabled();
  const card = /^\/learning-data\/cards\/([^/]+)$/.exec(pathname);
  if (card && request.method === 'PATCH') {
    return json(await patchCard(env, decodeURIComponent(card[1]), await readJson(request)));
  }
  if (card && request.method === 'DELETE') cloudDeleteDisabled();
  return null;
}

async function handleCanvasRoute(request, env, pathname) {
  if (request.method === 'GET' && pathname === '/canvas-projects') {
    return json({ ok: true, projects: await listCanvasProjects(env) });
  }
  if (request.method === 'GET' && pathname === '/canvas-projects/events') {
    return json({ ok: false, code: 'POLLING_REQUIRED', error: 'Cloud canvas synchronization uses save/load polling.' }, 501);
  }
  if (request.method === 'POST' && pathname === '/canvas-projects/active') {
    return json({ ok: true, active: await setActiveCanvas(env, await readJson(request, 64 * 1024)) });
  }
  const liveStroke = /^\/canvas-projects\/([^/]+)\/live-stroke$/.exec(pathname);
  if (liveStroke && request.method === 'POST') {
    await readJson(request, 2 * 1024 * 1024);
    return json({ ok: true, degraded: true, persistence: 'next-canvas-save' }, 202);
  }
  const aiOrganize = /^\/canvas-projects\/([^/]+)\/ai-organize$/.exec(pathname);
  if (aiOrganize && (request.method === 'GET' || request.method === 'POST')) unavailable('Canvas AI organization');
  const project = /^\/canvas-projects\/([^/]+)$/.exec(pathname);
  if (!project) return null;
  const projectId = decodeURIComponent(project[1]);
  if (request.method === 'GET') return json({ ok: true, document: await loadCanvasProject(env, projectId) });
  if (request.method === 'PUT') {
    const result = await saveCanvasProject(env, projectId, await readJson(request));
    return json({ ok: true, ...result });
  }
  if (request.method === 'DELETE') cloudDeleteDisabled();
  return null;
}

async function handleJobRoute(request, env, pathname, url, ctx) {
  if (request.method === 'GET' && pathname === '/ai/jobs') {
    const noteUid = url.searchParams.get('noteUid') || '';
    const type = url.searchParams.get('type') || '';
    const jobs = await listBackgroundJobs(env, { noteUid, type });
    ctx?.waitUntil?.(kickPendingJobs(env));
    return json({ ok: true, jobs });
  }
  const match = /^\/ai\/jobs\/([^/]+)$/.exec(pathname);
  if (request.method === 'GET' && match) {
    const job = await getBackgroundJob(env, decodeURIComponent(match[1]));
    if (!job) throw new HttpError(404, 'Background job not found.', 'JOB_NOT_FOUND');
    if (job.status === 'queued') ctx?.waitUntil?.(processBackgroundJob(env, job.id));
    return json({ ok: true, job });
  }
  return null;
}

async function handleApi(request, env, pathname, url, ctx) {
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: { Allow: 'GET,POST,PUT,PATCH,DELETE,OPTIONS' } });
  if (request.method === 'DELETE') cloudDeleteDisabled();
  if (request.method === 'POST' && pathname === '/admin/bootstrap') {
    const force = url.searchParams.get('force') === '1';
    const rawExpected = url.searchParams.get('expectedRevision');
    const expectedRevision = rawExpected === null ? undefined : Number(rawExpected);
    return json(await bootstrapFromR2(env, { force, expectedRevision }));
  }
  if (request.method === 'GET' && pathname === '/layout') {
    const stored = await readAppState(env, 'desktop-layout');
    return json({ ok: true, updatedAt: stored?.updatedAt ?? null, layout: stored?.value?.layout ?? null });
  }
  if (request.method === 'POST' && pathname === '/layout') {
    const payload = await readJson(request, 512 * 1024);
    if (!Array.isArray(payload.layout) || payload.layout.length > 200) {
      throw new HttpError(400, 'layout must be an array of at most 200 widgets.', 'INVALID_LAYOUT');
    }
    const current = await readAppState(env, 'desktop-layout');
    const updatedAt = new Date().toISOString();
    const revision = Number(current?.revision || 0) + 1;
    await writeAppState(env, 'desktop-layout', { layout: payload.layout }, revision, updatedAt);
    return json({ ok: true, updatedAt, layout: payload.layout });
  }
  if (request.method === 'GET' && pathname === '/layout/events') {
    const stored = await readAppState(env, 'desktop-layout');
    const event = `retry: 60000\nevent: layout\ndata: ${JSON.stringify({ layout: stored?.value?.layout ?? null })}\n\n`;
    return new Response(event, {
      headers: {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'private, no-store',
        'X-Content-Type-Options': 'nosniff',
      },
    });
  }
  if (request.method === 'GET' && pathname === '/ai/config') {
    return json({ ok: true, ...(await getGlobalAiSettings(env)) });
  }
  if (request.method === 'POST' && pathname === '/ai/detect-questions') {
    return json(await detectQuestions(env, await readJson(request, 28 * 1024 * 1024)));
  }
  const jobResponse = await handleJobRoute(request, env, pathname, url, ctx);
  if (jobResponse) return jobResponse;
  const learningResponse = await handleLearningRoute(request, env, pathname, ctx);
  if (learningResponse) return learningResponse;
  const canvasResponse = await handleCanvasRoute(request, env, pathname);
  if (canvasResponse) return canvasResponse;
  if (request.method === 'POST' && pathname === '/save-note') {
    const result = await saveNote(env, await readJson(request, 28 * 1024 * 1024));
    return json(result, result.idempotentReplay ? 200 : 202);
  }
  if (request.method === 'GET' && pathname === '/note-file') return getNoteFile(env, url.searchParams.get('path'));
  if (pathname === '/notes/reveal') unavailable('Windows file reveal');
  if (pathname === '/organizer/run') unavailable('AI note organization');
  if (request.method === 'GET' && pathname === '/organizer/status') {
    return json({ ok: true, available: false, running: false, code: 'LOCAL_ONLY_FEATURE' });
  }
  return json({ ok: false, code: 'NOT_FOUND', error: 'API route not found.' }, 404);
}

function assetCacheControl(request, response, isPublic) {
  if (!isPublic) return 'private, no-cache';
  if (!['GET', 'HEAD'].includes(request.method) || response.status !== 200) return 'public, no-store';
  const pathname = new URL(request.url).pathname.toLowerCase();
  if (pathname.startsWith('/assets/')) return 'public, max-age=31536000, immutable';
  if (/\.(?:woff2?|ttf|otf|png|jpe?g|webp|avif|gif|svg|ico)$/.test(pathname)) {
    return 'public, max-age=604800, stale-while-revalidate=86400';
  }
  if (/\.(?:js|css)$/.test(pathname)) return 'public, max-age=3600, stale-while-revalidate=86400';
  return 'public, max-age=0, must-revalidate';
}

async function serveAsset(request, env, isPublic) {
  if (!env.ASSETS || typeof env.ASSETS.fetch !== 'function') {
    throw new HttpError(500, 'Static asset binding is unavailable.', 'ASSET_BINDING_MISSING');
  }
  const response = await env.ASSETS.fetch(request);
  const headers = new Headers(response.headers);
  headers.set('Cache-Control', assetCacheControl(request, response, isPublic));
  headers.set('X-Content-Type-Options', 'nosniff');
  headers.set('Referrer-Policy', 'same-origin');
  headers.set('X-Frame-Options', 'SAMEORIGIN');
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

export async function handleRequest(request, env, ctx) {
  const url = new URL(request.url);
  const pathname = apiPath(url.pathname);
  const isPublic = publicReadEnabled(env);
  if (pathname === '/health' && request.method === 'GET') {
    const github = githubStorageInfo(env);
    return json({
      ok: true,
      runtime: 'cloudflare-workers',
      storage: 'github',
      publicRead: isPublic,
      authConfigured: Boolean(env.APP_USERNAME && env.APP_PASSWORD),
      githubConfigured: github.configured,
      repository: github.repository,
      branch: github.branch,
      aiConfigured: Boolean(env.AI && typeof env.AI.run === 'function'),
      cloudDeleteEnabled: false,
      d1Bound: false,
      r2Bound: false,
    });
  }

  if (pathname !== null) {
    // Static application files stay loadable, but all data/configuration APIs
    // require the device-persisted password. The image endpoint remains a
    // narrow exception because ordinary <img> requests cannot attach the
    // authorization header stored by the application fetch wrapper.
    const publicImageRead = request.method === 'GET' && pathname === '/note-file';
    if (!publicImageRead) {
      const authResponse = await requireBasicAuth(request, env);
      if (authResponse) return authResponse;
    }
    enforceWriteRequest(request, url, pathname);
    if (ctx?.waitUntil) ctx.waitUntil(kickPendingJobs(env, 1));
    return handleApi(request, env, pathname, url, ctx);
  }

  if (!isPublic) {
    const authResponse = await requireBasicAuth(request, env);
    if (authResponse) return authResponse;
  }
  return serveAsset(request, env, isPublic);
}

export default {
  async fetch(request, env, ctx) {
    try {
      return await handleRequest(request, env, ctx);
    } catch (error) {
      return handleError(error);
    }
  },
};
