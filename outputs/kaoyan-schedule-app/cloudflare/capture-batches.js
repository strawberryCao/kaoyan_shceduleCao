import { detectQuestions } from './ai.js';
import { getTaskSettings } from './ai-config.js';
import { commitCaptureResults, createEntry } from './entries.js';
import { getBranchHead, readFile, readJsonFile, writeJsonFile } from './github-store.js';
import { HttpError, sha256 } from './http.js';
import { decodeMaterialFile } from './media.js';

const JOB_ROOT = 'data/v2/jobs';
const JOB_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,159}$/;

function text(value, limit = Infinity) {
  return typeof value === 'string' ? value.trim().slice(0, limit) : '';
}

function jobPath(jobId) {
  if (!JOB_ID_PATTERN.test(jobId)) throw new HttpError(400, 'Invalid capture job id.', 'INVALID_JOB_ID');
  return `${JOB_ROOT}/${jobId}.json`;
}

function bytesToDataUrl(bytes, mime) {
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, Math.min(bytes.length, offset + 0x8000)));
  }
  return `data:${mime};base64,${btoa(binary)}`;
}

async function runtimeHashes(env) {
  try {
    const settings = await getTaskSettings(env, 'question_splitting');
    return {
      configurationHash: settings.configurationHash,
      workflowHash: settings.workflowHash,
      ready: Boolean(settings.configurationHash && settings.workflowHash),
      error: '',
    };
  } catch (error) {
    return {
      configurationHash: '',
      workflowHash: '',
      ready: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

async function updateJob(env, jobId, patch) {
  const path = jobPath(jobId);
  const current = await readJsonFile(env, path, { allowMissing: true, maxBytes: 512 * 1024 });
  if (!current) throw new HttpError(404, 'Capture job not found.', 'JOB_NOT_FOUND');
  const job = {
    ...current.value,
    ...patch,
    updatedAt: new Date().toISOString(),
  };
  await writeJsonFile(env, path, job, { message: `data: update capture job ${jobId}` });
  return job;
}

async function triggerWorkflow(env, ctx, job) {
  const instanceId = `${job.jobId}-r${Number(job.attempts) || 0}`;
  if (env.CAPTURE_WORKFLOW && typeof env.CAPTURE_WORKFLOW.create === 'function') {
    try {
      await env.CAPTURE_WORKFLOW.create({ id: instanceId, params: { jobId: job.jobId } });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!/already exists|duplicate|conflict/i.test(message)) throw error;
    }
    return { mode: 'workflow', instanceId };
  }
  return { mode: 'workflow-unavailable', instanceId: '' };
}

async function reflectUnavailableWorkflow(env, job, trigger) {
  if (trigger.mode === 'workflow') return job;
  return updateJob(env, job.jobId, {
    status: 'failed_retryable',
    progress: Number(job.progress) || 5,
    message: '原图已安全保存，但后台裁剪服务尚未就绪；请稍后点“重试”',
    error: 'CAPTURE_WORKFLOW binding is unavailable',
  });
}

export async function createCaptureBatch(env, payload, ctx) {
  const imageDataUrl = text(payload.imageDataUrl);
  if (!imageDataUrl) throw new HttpError(400, 'imageDataUrl is required.', 'INVALID_CAPTURE_BATCH');
  const decoded = decodeMaterialFile({
    name: text(payload.fileName, 120) || '整页原题.jpg',
    dataUrl: imageDataUrl,
  });
  if (decoded.kind !== 'image') throw new HttpError(415, 'Capture source must be an image.', 'INVALID_CAPTURE_BATCH');
  const sourceAssetId = await sha256(decoded.bytes);
  const batchId = (text(payload.batchId, 120) || `batch-${crypto.randomUUID()}`)
    .replace(/[^A-Za-z0-9._-]/g, '-');
  const jobId = `capture-${(await sha256(`${batchId}:${sourceAssetId}`)).slice(0, 48)}`;
  const parentEntryId = `source-${jobId}`.slice(0, 160);
  const hashes = await runtimeHashes(env);
  const timestamp = new Date().toISOString();
  const descriptor = {
    schemaVersion: 2,
    jobId,
    batchId,
    parentEntryId,
    sourceAssetId,
    sourcePath: `data/assets/${sourceAssetId}.${decoded.extension}`,
    status: hashes.ready ? 'queued' : 'waiting_configuration',
    progress: hashes.ready ? 5 : 0,
    message: hashes.ready ? '原图已保存，等待后台识别' : '原图已保存，等待本地发布 AI 配置',
    error: hashes.error,
    attempts: 0,
    configurationHash: hashes.configurationHash,
    workflowHash: hashes.workflowHash,
    detectedCount: 0,
    resultEntryIds: [],
    createdAt: timestamp,
    updatedAt: timestamp,
    completedAt: '',
  };
  const path = jobPath(jobId);
  const result = await createEntry(env, {
    entryId: parentEntryId,
    kind: 'note',
    title: text(payload.title, 240) || '多题原图（处理中）',
    body: text(payload.remark, 8000),
    subject: payload.subject,
    facets: payload.facets,
    tags: [...(Array.isArray(payload.tags) ? payload.tags : []), 'AI多题原图'],
    files: [{ name: decoded.fileName, dataUrl: imageDataUrl }],
  }, {
    additionalFiles: () => [{ path, content: `${JSON.stringify(descriptor, null, 2)}\n` }],
    result: () => ({ job: descriptor }),
  });
  let job = descriptor;
  if (result.idempotentReplay) {
    const existing = await readJsonFile(env, path, { allowMissing: true, maxBytes: 512 * 1024 });
    if (!existing) throw new HttpError(409, 'Capture receipt exists without a job.', 'CAPTURE_JOB_INCOMPLETE');
    job = existing.value;
  }
  let trigger = { mode: 'not-ready', instanceId: '' };
  if (job.status === 'queued' || job.status === 'failed_retryable') {
    trigger = await triggerWorkflow(env, ctx, job);
    job = await reflectUnavailableWorkflow(env, job, trigger);
  }
  return {
    ok: true,
    accepted: true,
    job,
    jobId,
    entryId: parentEntryId,
    trigger,
    idempotentReplay: result.idempotentReplay,
  };
}

export async function getCaptureJob(env, jobId) {
  const file = await readJsonFile(env, jobPath(jobId), { allowMissing: true, maxBytes: 512 * 1024 });
  if (!file) throw new HttpError(404, 'Capture job not found.', 'JOB_NOT_FOUND');
  let workflow = null;
  let workflowError = '';
  const instanceId = `${jobId}-r${Number(file.value.attempts) || 0}`;
  if (env.CAPTURE_WORKFLOW && typeof env.CAPTURE_WORKFLOW.get === 'function') {
    try {
      const instance = await env.CAPTURE_WORKFLOW.get(instanceId);
      workflow = await instance.status();
    } catch (error) {
      workflowError = error instanceof Error ? error.message : String(error);
    }
  } else {
    workflowError = 'CAPTURE_WORKFLOW binding is unavailable';
  }
  const job = file.value;
  const updatedAt = Date.parse(String(job.updatedAt || job.createdAt || ''));
  const stalledMs = Number.isFinite(updatedAt) ? Date.now() - updatedAt : 0;
  if (
    ['queued', 'processing'].includes(job.status)
    && stalledMs >= 90_000
    && (!workflow || workflowError)
  ) {
    const recovered = await updateJob(env, jobId, {
      status: 'failed_retryable',
      progress: Number(job.progress) || 5,
      message: '后台任务超过 90 秒没有继续更新；原图已保留，可以安全重试',
      error: workflowError || 'Capture workflow stopped reporting progress',
    });
    return { ok: true, job: recovered, workflow, stalled: true };
  }
  if (['queued', 'processing'].includes(job.status) && stalledMs >= 30_000) {
    return {
      ok: true,
      job: {
        ...job,
        message: `${job.message || 'AI 后台处理中'}（已等待 ${Math.max(1, Math.round(stalledMs / 1000))} 秒）`,
      },
      workflow,
      stalled: false,
    };
  }
  return { ok: true, job, workflow, stalled: false };
}

export async function retryCaptureJob(env, jobId, ctx) {
  const current = await getCaptureJob(env, jobId);
  if (current.job.status === 'completed') return { ...current, replayed: true };
  const hashes = await runtimeHashes(env);
  if (!hashes.ready) {
    const job = await updateJob(env, jobId, {
      status: 'waiting_configuration',
      progress: current.job.progress || 0,
      message: '等待本地发布 AI 配置后重试',
      error: hashes.error,
    });
    return { ok: true, accepted: false, job };
  }
  const job = await updateJob(env, jobId, {
    status: 'queued',
    message: '已重新加入后台处理队列',
    error: '',
    attempts: Number(current.job.attempts || 0) + 1,
    configurationHash: hashes.configurationHash,
    workflowHash: hashes.workflowHash,
  });
  const trigger = await triggerWorkflow(env, ctx, job);
  const reflected = await reflectUnavailableWorkflow(env, job, trigger);
  return { ok: true, accepted: trigger.mode === 'workflow', job: reflected, trigger };
}

function quotaError(message) {
  return /quota|limit|allowance|429|too many requests|daily|monthly/i.test(message);
}

export async function processCaptureBatch(env, jobId) {
  const current = await getCaptureJob(env, jobId);
  const job = current.job;
  if (job.status === 'completed') return { ok: true, job, idempotentReplay: true };
  try {
    const settings = await getTaskSettings(env, 'question_splitting');
    if (settings.configurationHash !== job.configurationHash || settings.workflowHash !== job.workflowHash) {
      const updated = await updateJob(env, jobId, {
        status: 'configuration_mismatch',
        message: 'AI 配置与任务创建时不一致，已暂停以避免套用旧规则',
        error: 'configurationHash 或 workflowHash 不一致',
      });
      return { ok: false, job: updated };
    }
    if (!env.IMAGES || typeof env.IMAGES.info !== 'function') {
      const updated = await updateJob(env, jobId, {
        status: 'needs_review',
        message: '原图已保留；当前环境没有启用免费 Images 裁剪绑定',
        error: 'IMAGES binding is unavailable',
      });
      return { ok: false, job: updated };
    }
    await updateJob(env, jobId, {
      status: 'processing',
      progress: 15,
      message: '正在识别完整题目区域',
      error: '',
    });
    const source = await readFile(env, job.sourcePath, { maxBytes: 20 * 1024 * 1024 });
    const info = await env.IMAGES.info(source.bytes);
    const width = Number(info?.width) || 0;
    const height = Number(info?.height) || 0;
    if (!width || !height) throw new HttpError(422, 'Image dimensions are unavailable.', 'INVALID_CAPTURE_IMAGE');
    const detection = await detectQuestions(env, {
      imageDataUrl: bytesToDataUrl(source.bytes, info?.format ? `image/${String(info.format).replace(/^image\//, '')}` : 'image/jpeg'),
      imageWidth: width,
      imageHeight: height,
    });
    const crops = [];
    for (const region of detection.regions) {
      const response = (
        await env.IMAGES.input(source.bytes)
          .transform({
            trim: {
              top: region.y,
              left: region.x,
              width: region.width,
              height: region.height,
            },
          })
          .output({ format: 'image/jpeg', quality: 85, anim: false })
      ).response();
      if (!response.ok) throw new Error(`Images crop failed with status ${response.status}`);
      crops.push({
        bytes: new Uint8Array(await response.arrayBuffer()),
        mime: 'image/jpeg',
        extension: 'jpg',
      });
    }
    return commitCaptureResults(env, {
      jobId,
      jobPath: jobPath(jobId),
      batchId: job.batchId,
      parentEntryId: job.parentEntryId,
      sourceAssetId: job.sourceAssetId,
      regions: detection.regions,
      crops,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const review = error instanceof HttpError && ['NO_QUESTIONS_DETECTED', 'INVALID_CAPTURE_IMAGE'].includes(error.code);
    const updated = await updateJob(env, jobId, {
      status: quotaError(message) ? 'waiting_quota' : review ? 'needs_review' : 'failed_retryable',
      progress: 15,
      message: quotaError(message)
        ? '免费额度暂不可用，原图已保留并可次日重试'
        : review ? '自动裁剪未得到可靠结果，原图已进入待处理'
          : '后台处理暂时失败，原图仍安全保存，可重试',
      error: message.slice(0, 1000),
    });
    if (!quotaError(message) && !review) throw error;
    return { ok: false, job: updated };
  }
}

export const CAPTURE_JOB_ROOT = JOB_ROOT;
