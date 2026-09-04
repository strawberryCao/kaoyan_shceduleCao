import { runLocalAgentTask } from './agent-provider.js';
import { getTaskSettings } from './ai-config.js';
import { getEntry, patchEntry } from './entries.js';
import { readFile } from './github-store.js';
import { HttpError } from './http.js';

function bytesToDataUrl(bytes, mime) {
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, Math.min(bytes.length, offset + 0x8000)));
  }
  return `data:${mime};base64,${btoa(binary)}`;
}

function htmlText(bytes) {
  const html = new TextDecoder().decode(bytes);
  const visibleText = html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const geoGebraContext = /(?:geogebra\.org\/apps\/deployggb\.js|\bGGBApplet\s*\()/i.test(html)
    ? [...html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)]
      .map((match) => match[1])
      .filter((script) => /GGBApplet|ggbOnInit|evalCommand|setValue|setVisible/i.test(script))
      .join(' ')
      .replace(/\/\*[\s\S]*?\*\//g, ' ')
      .replace(/\/\/[^\r\n]*/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 3_000)
    : '';
  return [visibleText, geoGebraContext ? `GeoGebra 交互定义：${geoGebraContext}` : '']
    .filter(Boolean)
    .join('\n')
    .slice(0, 8_000);
}

function cleanName(value, maxLength) {
  return String(value || '')
    .normalize('NFKC')
    .replace(/[\\/:*?"<>|\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/^[.\s]+|[.\s]+$/g, '')
    .slice(0, maxLength);
}

const GENERIC_MATERIAL_NAME_RE = /^(?:资料|图片|截图|文档|文件|原图|附件|素材|未命名|image|img|file|document|screenshot|attachment|material|asset)(?:[-_ ]?(?:\d+|[一二三四五六七八九十]+))?$/iu;

function originalStem(asset) {
  return cleanName(String(asset?.originalFileName || asset?.displayName || '').replace(/\.[^.]+$/, ''), 120);
}

function weakMaterialStem(value) {
  const normalized = cleanName(value, 120);
  const compact = normalized.replace(/[\s_-]+/g, '');
  return !normalized
    || GENERIC_MATERIAL_NAME_RE.test(normalized)
    || /^[a-f0-9]{16,}$/i.test(compact);
}

function validateCompleteAssetNames(assets, files, maxLength) {
  const sourceAssets = Array.isArray(assets) ? assets : [];
  const returnedFiles = Array.isArray(files) ? files : [];
  const byIndex = new Map();
  const seenNames = new Map();
  const failures = [];
  for (const item of returnedFiles) {
    const index = Number(item?.index);
    if (!Number.isInteger(index) || index < 0 || index >= sourceAssets.length) {
      failures.push(`无效附件索引 ${String(item?.index ?? '')}`);
      continue;
    }
    if (byIndex.has(index)) {
      failures.push(`附件 ${index + 1} 重复返回`);
      continue;
    }
    const name = cleanName(item?.name, maxLength);
    const compact = name.replace(/[\s_-]+/g, '');
    const oldName = originalStem(sourceAssets[index]);
    let reason = '';
    if (!name) reason = '名称为空';
    else if (GENERIC_MATERIAL_NAME_RE.test(name)) reason = '名称过于泛化';
    else if (/^[a-f0-9]{16,}$/i.test(compact)) reason = '名称疑似哈希值';
    else if (name.localeCompare(oldName, undefined, { sensitivity: 'accent' }) === 0
      && weakMaterialStem(oldName)) reason = '名称没有变化';
    const normalizedName = name.toLocaleLowerCase('zh-CN');
    if (!reason && seenNames.has(normalizedName)) reason = `与附件 ${seenNames.get(normalizedName) + 1} 重名`;
    if (reason) failures.push(`附件 ${index + 1}：${reason}`);
    else {
      byIndex.set(index, name);
      seenNames.set(normalizedName, index);
    }
  }
  for (let index = 0; index < sourceAssets.length; index += 1) {
    if (!byIndex.has(index)) failures.push(`附件 ${index + 1} 缺少有效新名称`);
  }
  if (failures.length) {
    throw new HttpError(422, `AI 未返回完整、有效的资料名称：${failures.join('；')}`, 'AI_MATERIAL_NAMES_INCOMPLETE', {
      failures,
      expectedAttachmentCount: sourceAssets.length,
      returnedFileCount: returnedFiles.length,
      returnedIndexes: returnedFiles.map((item) => item?.index),
    });
  }
  return Object.fromEntries(sourceAssets.map((asset, index) => [asset.assetId, byIndex.get(index)]));
}

function assertSameAssetSet(sourceAssets, latestAssets) {
  const sourceIds = (Array.isArray(sourceAssets) ? sourceAssets : []).map((asset) => String(asset?.assetId || ''));
  const latestIds = (Array.isArray(latestAssets) ? latestAssets : []).map((asset) => String(asset?.assetId || ''));
  if (sourceIds.some((id) => !id) || latestIds.some((id) => !id)
    || sourceIds.length !== latestIds.length
    || new Set(sourceIds).size !== sourceIds.length
    || sourceIds.some((id) => !latestIds.includes(id))) {
    throw new HttpError(409, '资料列表在 AI 命名期间发生了增删，请重试以保护最新资料。', 'AI_MATERIAL_ATTACHMENTS_CHANGED', {
      sourceIds,
      latestIds,
    });
  }
}

export const materialNamingInternals = {
  validateCompleteAssetNames,
  assertSameAssetSet,
};

export async function runConfiguredMaterialNaming(env, entryId, options = {}) {
  const loaded = await getEntry(env, entryId);
  const entry = loaded.entry;
  if (!Array.isArray(entry.assets)) return { applied: false };
  const settings = await getTaskSettings(env, 'material_naming');
  const renameAttachments = settings.options?.renameAttachments !== false && entry.assets.length > 0;
  const maxLength = Math.max(8, Math.min(60, Number(settings.options?.titleMaxLength) || 26));
  const noteTitleMaxLength = Math.max(8, Math.min(32, Number(settings.options?.noteTitleMaxLength) || 18));
  const contexts = [];
  const batchSize = 8;
  const contextCharsPerFile = Math.max(240, Math.floor(18_000 / Math.max(1, entry.assets.length)));
  for (let index = 0; index < entry.assets.length; index += 1) {
    const asset = entry.assets[index];
    let extractedText = '';
    if (asset.mime === 'text/html' || /^text\//.test(asset.mime)) {
      try {
        const file = await readFile(env, asset.path, { maxBytes: 8 * 1024 * 1024 });
        extractedText = htmlText(file.bytes).slice(0, contextCharsPerFile);
      } catch {}
    }
    contexts.push({
      index,
      originalName: asset.originalFileName,
      mimeType: asset.mime,
      extractedText,
    });
  }
  const sharedPrompt = [
    ...(settings.workflow?.prompt?.instructions || []),
    settings.workflow?.prompt?.outputFormat || '',
    settings.customInstructions || '',
    '以下正文与附件属于同一条速记。必须先整体判断共同主题和资料间关系，再完成命名。',
    '附件较多时系统会分批提供原图，但全部附件摘要始终属于同一组；不得把批次当成不同笔记。',
    '速记标题只保留共同主题；附件名称要说明该附件在本条速记中的具体作用。',
    'files 中的 index 必须使用原始全局 index。',
    `速记正文：${String(entry.body || '').slice(0, 4_000) || '无'}`,
    `全部附件摘要：${JSON.stringify(contexts)}`,
  ].filter(Boolean).join('\n');
  const starts = renameAttachments
    ? Array.from({ length: Math.ceil(entry.assets.length / batchSize) }, (_, index) => index * batchSize)
    : [0];
  const responses = [];
  const returnedFiles = [];
  for (const start of starts) {
    const end = renameAttachments ? Math.min(entry.assets.length, start + batchSize) : 0;
    const content = [{
      type: 'text',
      text: [
        sharedPrompt,
        renameAttachments
          ? `本次只命名全局 index ${start} 到 ${end - 1}；files 必须且只能返回这些 index。`
          : '本条速记没有附件，只返回 noteTitle。',
        responses.length === 0 ? '本次必须返回 noteTitle。' : '标题已在首批生成，本次只返回 files。',
      ].join('\n'),
    }];
    let imageCount = 0;
    for (let index = start; index < end; index += 1) {
      const asset = entry.assets[index];
      if (!String(asset.mime || '').startsWith('image/')) continue;
      try {
        const file = await readFile(env, asset.path, { maxBytes: 8 * 1024 * 1024 });
        content.push({ type: 'text', text: `下面是全局 index=${index} 的图片：` });
        content.push({ type: 'image_url', image_url: { url: bytesToDataUrl(file.bytes, asset.mime) } });
        imageCount += 1;
      } catch {}
    }
    const response = await runLocalAgentTask(env, 'material_naming', {
      messages: [{ role: 'user', content }],
      json: true,
      temperature: Number(settings.temperature) || 0.1,
      maxTokens: Number(settings.options?.maxTokens) || 1200,
      requiredCapabilities: imageCount ? ['vision', 'json'] : ['text', 'json'],
    });
    responses.push(response);
    if (renameAttachments) {
      const batchFiles = Array.isArray(response.json?.files) ? response.json.files : [];
      validateCompleteAssetNames(
        entry.assets.slice(start, end),
        batchFiles.map((item) => ({ ...item, index: Number(item?.index) - start })),
        maxLength,
      );
      returnedFiles.push(...batchFiles);
    }
  }
  const response = responses[0];
  const fileNames = renameAttachments
    ? validateCompleteAssetNames(entry.assets, returnedFiles, maxLength)
    : {};
  const generatedTitle = cleanName(response.json?.noteTitle, noteTitleMaxLength);
  const latestLoaded = await getEntry(env, entry.entryId);
  const latestEntry = latestLoaded.entry;
  assertSameAssetSet(entry.assets, latestEntry.assets);
  const titleChangedWhileRunning = latestEntry.title !== entry.title;
  const patched = await patchEntry(env, entry.entryId, {
    expectedVersion: latestEntry.version,
    ...(options.userTitle || titleChangedWhileRunning || settings.options?.renameNoteTitle === false || !generatedTitle
      ? {}
      : { title: generatedTitle }),
    ...(renameAttachments ? { assetNames: fileNames } : {}),
  });
  return {
    ...patched,
    applied: true,
    title: patched.entry?.title || latestEntry.title || '',
    provider: response.provider || '',
    model: response.model || '',
  };
}
