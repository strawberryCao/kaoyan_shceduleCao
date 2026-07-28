import { runLocalAgentTask } from './agent-provider.js';
import { getTaskSettings } from './ai-config.js';
import { getEntry, patchEntry } from './entries.js';
import { readFile } from './github-store.js';

function bytesToDataUrl(bytes, mime) {
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, Math.min(bytes.length, offset + 0x8000)));
  }
  return `data:${mime};base64,${btoa(binary)}`;
}

function htmlText(bytes) {
  return new TextDecoder().decode(bytes)
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
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

export async function runConfiguredMaterialNaming(env, entryId, options = {}) {
  const loaded = await getEntry(env, entryId);
  const entry = loaded.entry;
  if (!Array.isArray(entry.assets) || entry.assets.length === 0) return { applied: false };
  const settings = await getTaskSettings(env, 'material_naming');
  const maxLength = Math.max(8, Math.min(60, Number(settings.options?.titleMaxLength) || 26));
  const contexts = [];
  const content = [];
  for (let index = 0; index < entry.assets.length; index += 1) {
    const asset = entry.assets[index];
    let extractedText = '';
    if (asset.mime === 'text/html' || /^text\//.test(asset.mime)) {
      try {
        const file = await readFile(env, asset.path, { maxBytes: 8 * 1024 * 1024 });
        extractedText = htmlText(file.bytes);
      } catch {}
    }
    contexts.push({
      index,
      originalName: asset.originalFileName,
      mimeType: asset.mime,
      extractedText,
    });
  }
  content.push({
    type: 'text',
    text: [
      ...(settings.workflow?.prompt?.instructions || []),
      settings.workflow?.prompt?.outputFormat || '',
      settings.customInstructions || '',
      `速记正文：${String(entry.body || '').slice(0, 4_000) || '无'}`,
      `附件信息：${JSON.stringify(contexts)}`,
    ].filter(Boolean).join('\n'),
  });
  let imageCount = 0;
  for (let index = 0; index < entry.assets.length && imageCount < 4; index += 1) {
    const asset = entry.assets[index];
    if (!String(asset.mime || '').startsWith('image/')) continue;
    try {
      const file = await readFile(env, asset.path, { maxBytes: 8 * 1024 * 1024 });
      content.push({ type: 'text', text: `下面是 index=${index} 的图片：` });
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
  const fileNames = Object.fromEntries((Array.isArray(response.json?.files) ? response.json.files : [])
    .map((item) => {
      const index = Number(item?.index);
      const asset = entry.assets[index];
      return asset && Number.isInteger(index)
        ? [asset.assetId, cleanName(item?.name, maxLength)]
        : null;
    })
    .filter((item) => item?.[1]));
  const generatedTitle = cleanName(response.json?.noteTitle, maxLength);
  return patchEntry(env, entry.entryId, {
    expectedVersion: entry.version,
    ...(options.userTitle || settings.options?.renameNoteTitle === false || !generatedTitle
      ? {}
      : { title: generatedTitle }),
    ...(settings.options?.renameAttachments === false ? {} : { assetNames: fileNames }),
  });
}
