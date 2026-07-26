'use strict';

const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const read = (relative) => fs.readFileSync(path.join(root, relative), 'utf8');
const write = (relative, value) => fs.writeFileSync(path.join(root, relative), value, 'utf8');

function replaceOnce(source, search, replacement, label) {
  if (source.includes(replacement)) return source;
  const next = source.replace(search, replacement);
  if (next === source) throw new Error(`Patch target not found: ${label}`);
  return next;
}

function appendOnce(source, marker, value) {
  return source.includes(marker) ? source : `${source.trimEnd()}\n\n${value.trim()}\n`;
}

{
  const file = 'src/components/QuickMaterialComposer.tsx';
  let source = read(file);
  source = source.replace('<strong>文字 / 多资料速记</strong>', '<strong>速记</strong>');
  source = source.replace('加入图片、PDF、Word、HTML 或文本', '加入图片、PDF、Word、HTML、网页资源或文本');
  source = source.replace(
    'accept="image/*,.pdf,.doc,.docx,.html,.htm,.txt,.md"',
    'accept="image/*,.pdf,.doc,.docx,.html,.htm,.css,.js,.mjs,.json,.svg,.txt,.md"',
  );
  write(file, source);
}

// Keep browser source compatible with the repository ES2020 target.
{
  const file = 'src/components/WorkspaceAssetPreview.tsx';
  let source = read(file);
  source = source.split(".replaceAll('\\\\', '/')").join(".split('\\\\').join('/')");
  write(file, source);
}

{
  const file = 'scripts/note-file-access.cjs';
  let source = read(file);
  source = replaceOnce(
    source,
    "  ['.md', 'text/markdown; charset=utf-8'],\n]);",
    "  ['.md', 'text/markdown; charset=utf-8'],\n  ['.css', 'text/css; charset=utf-8'],\n  ['.js', 'text/javascript; charset=utf-8'],\n  ['.mjs', 'text/javascript; charset=utf-8'],\n  ['.json', 'application/json; charset=utf-8'],\n  ['.svg', 'image/svg+xml'],\n]);",
    'local note-file MIME map',
  );
  write(file, source);
}

{
  const file = 'scripts/note-server.cjs';
  let source = read(file);
  source = replaceOnce(
    source,
    "  ['.html', 'text/html'], ['.htm', 'text/html'], ['.txt', 'text/plain'], ['.md', 'text/markdown'],\n]);",
    "  ['.html', 'text/html'], ['.htm', 'text/html'], ['.css', 'text/css'], ['.js', 'text/javascript'], ['.mjs', 'text/javascript'],\n  ['.json', 'application/json'], ['.svg', 'image/svg+xml'], ['.txt', 'text/plain'], ['.md', 'text/markdown'],\n]);",
    'local material MIME map',
  );
  write(file, source);
}

{
  const file = 'cloudflare/media.js';
  let source = read(file);
  source = replaceOnce(
    source,
    "  ['text/markdown', 'md'],\n]);",
    "  ['text/markdown', 'md'],\n  ['text/css', 'css'],\n  ['text/javascript', 'js'],\n  ['application/javascript', 'js'],\n  ['application/json', 'json'],\n  ['image/svg+xml', 'svg'],\n]);",
    'cloud material MIME map',
  );
  write(file, source);
}

{
  const file = 'src/components/LearningRecordWorkspacePreview.tsx';
  let source = read(file);
  source = replaceOnce(
    source,
    "import { useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';",
    "import { useCallback, useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';",
    'useCallback import',
  );
  source = replaceOnce(
    source,
    "import type { LearningAttachment, LearningAutoNote, LearningDataSnapshot } from '../utils/learningData';",
    "import type { LearningAttachment, LearningAutoNote, LearningDataSnapshot } from '../utils/learningData';\nimport { WorkspaceAssetPreview, type WorkspaceAssetPreviewItem } from './WorkspaceAssetPreview';",
    'workspace renderer import',
  );
  source = replaceOnce(
    source,
    "  fetchLearningData,\n  readLearningDataCache,",
    "  fetchLearningData,\n  patchLearningNote,\n  readLearningDataCache,\n  saveLearningDataCache,",
    'learning data repair imports',
  );
  source = replaceOnce(
    source,
    "  sizeLabel: string;\n};",
    "  sizeLabel: string;\n  fallbackPath: string;\n  fallbackUrl: string;\n};",
    'asset fallback type',
  );
  source = replaceOnce(
    source,
    "const overlap = (a: FloatingAsset, b: FloatingAsset) => !(",
    `const extensionForAttachment = (attachment: LearningAttachment): string => {\n  const named = attachment.name.toLowerCase().match(/\\.([a-z0-9]+)$/)?.[1];\n  const pathed = attachment.filePath.split('\\\\').join('/').toLowerCase().match(/\\.([a-z0-9]+)$/)?.[1];\n  if (named || pathed) return named || pathed || 'jpg';\n  if (attachment.mimeType === 'image/png') return 'png';\n  if (attachment.mimeType === 'image/webp') return 'webp';\n  if (attachment.mimeType === 'application/pdf') return 'pdf';\n  if (attachment.mimeType.includes('wordprocessingml')) return 'docx';\n  return attachment.kind === 'image' ? 'jpg' : 'bin';\n};\n\nconst stableFallbackPath = (note: LearningAutoNote, attachment: LearningAttachment): string => {\n  const normalized = attachment.filePath.trim().split('\\\\').join('/');\n  if (/^(?:github:\\/\\/data\\/assets\\/|data\\/assets\\/|r2:\\/\\/note-assets\\/)/i.test(normalized)) return '';\n  const materialIndex = /^material-(\\d+)$/.exec(attachment.id)?.[1];\n  if (materialIndex) {\n    return 'github://data/assets/' + note.noteUid + '/' + materialIndex.padStart(2, '0') + '-' + attachment.name;\n  }\n  if (attachment.kind === 'image') {\n    return 'github://data/assets/' + note.noteUid + '.' + extensionForAttachment(attachment);\n  }\n  const baseName = normalized.split('/').filter(Boolean).at(-1) || attachment.name;\n  return baseName ? 'github://data/assets/' + baseName : '';\n};\n\nconst overlap = (a: FloatingAsset, b: FloatingAsset) => !(`,
    'stable attachment fallback helper',
  );
  source = replaceOnce(
    source,
    "  const rootRef = useRef<HTMLDivElement | null>(null);",
    "  const rootRef = useRef<HTMLDivElement | null>(null);\n  const repairingPathsRef = useRef(new Set<string>());",
    'repairing path ref',
  );
  source = replaceOnce(
    source,
    "        sizeLabel: formatBytes(attachment.size),\n      };",
    "        sizeLabel: formatBytes(attachment.size),\n        fallbackPath: stableFallbackPath(note, attachment),\n        fallbackUrl: stableFallbackPath(note, attachment) ? noteFileUrl(stableFallbackPath(note, attachment)) : '',\n      };",
    'asset fallback mapping',
  );
  source = replaceOnce(
    source,
    "  const returnToLearningCenter = () => {",
    `  const repairAttachmentPath = useCallback(async (item: WorkspaceAssetPreviewItem) => {\n    if (!note || !item.fallbackPath || repairingPathsRef.current.has(item.id)) return;\n    repairingPathsRef.current.add(item.id);\n    try {\n      const sourceAttachments: LearningAttachment[] = note.attachments.length > 0\n        ? note.attachments\n        : [{\n            id: item.id, kind: item.kind, name: item.name, mimeType: item.mimeType, size: null,\n            filePath: item.filePath, previewPath: '', posterPath: '', createdAt: note.createdAt,\n          }];\n      const attachments = sourceAttachments.map((attachment) => attachment.id === item.id\n        ? { ...attachment, filePath: item.fallbackPath }\n        : attachment);\n      const next = await patchLearningNote(note.noteUid, { attachments });\n      saveLearningDataCache(next);\n      setSnapshot(next);\n      setActionError('历史附件路径已自动修复');\n    } catch (error) {\n      setActionError(error instanceof Error\n        ? '附件已显示，但路径写回失败：' + error.message\n        : '附件路径写回失败');\n    } finally {\n      repairingPathsRef.current.delete(item.id);\n    }\n  }, [note]);\n\n  const returnToLearningCenter = () => {`,
    'persistent path repair callback',
  );
  source = source.replaceAll(
    '<AssetPreview item={activeAsset} />',
    '<WorkspaceAssetPreview item={activeAsset} assets={assets} onRecovered={(item) => void repairAttachmentPath(item)} />',
  );
  source = source.replaceAll(
    '<AssetPreview item={current} />',
    '<WorkspaceAssetPreview item={current} assets={assets} onRecovered={(item) => void repairAttachmentPath(item)} />',
  );
  source = source.replaceAll('href={activeAsset.url}', 'href={activeAsset.fallbackUrl || activeAsset.url}');
  write(file, source);
}

{
  const file = 'src/learning-record-workspace-preview.css';
  let source = read(file);
  source = appendOnce(source, '.lrp-html-mode {', `
.lrp-html-preview { width: 100%; height: 100%; min-height: 260px; display: flex; flex-direction: column; }
.lrp-html-mode { display: flex; gap: 6px; align-items: center; padding: 7px 10px; border-bottom: 1px solid rgba(99, 86, 69, .16); background: rgba(248, 245, 240, .94); }
.lrp-html-mode button { border: 1px solid rgba(99, 86, 69, .2); border-radius: 8px; padding: 5px 9px; background: #fff; color: #51483e; font: inherit; cursor: pointer; }
.lrp-html-mode button.active { background: #2f3742; color: #fff; border-color: #2f3742; }
.lrp-html-mode span { margin-left: auto; color: #746a5e; font-size: 12px; }
.lrp-html-preview .lrp-document-frame { flex: 1; min-height: 240px; }
.lrp-text-preview { box-sizing: border-box; width: 100%; height: 100%; min-height: 260px; margin: 0; padding: 18px; overflow: auto; white-space: pre-wrap; overflow-wrap: anywhere; background: #fbfaf7; color: #25282d; font: 13px/1.65 ui-monospace, SFMono-Regular, Consolas, monospace; }
`);
  write(file, source);
}

write('scripts/workspace-final-completion.test.cjs', `'use strict';\n\nconst assert = require('node:assert/strict');\nconst fs = require('node:fs');\nconst path = require('node:path');\nconst test = require('node:test');\n\nconst root = path.resolve(__dirname, '..');\nconst read = (relative) => fs.readFileSync(path.join(root, relative), 'utf8');\n\ntest('workspace renders DOCX and runs HTML only in an isolated offline sandbox', () => {\n  const renderer = read('src/components/WorkspaceAssetPreview.tsx');\n  assert.match(renderer, /mammoth\\.convertToHtml/);\n  assert.match(renderer, /安全查看/);\n  assert.match(renderer, /隔离运行/);\n  assert.match(renderer, /allow-scripts allow-forms/);\n  assert.doesNotMatch(renderer, /allow-same-origin/);\n  assert.match(renderer, /connect-src 'none'/);\n});\n\ntest('historical paths derive stable GitHub asset paths and persist after recovery', () => {\n  const workspace = read('src/components/LearningRecordWorkspacePreview.tsx');\n  assert.match(workspace, /note\\.noteUid \\+ '\\.'/);\n  assert.match(workspace, /note\\.noteUid \\+ '\\/'/);\n  assert.match(workspace, /patchLearningNote\\(note\\.noteUid, \\{ attachments \\}\\)/);\n  assert.match(workspace, /WorkspaceAssetPreview/);\n});\n\ntest('速记 accepts web project resources on local and cloud storage', () => {\n  const composer = read('src/components/QuickMaterialComposer.tsx');\n  const local = read('scripts/note-file-access.cjs');\n  const cloud = read('cloudflare/media.js');\n  assert.match(composer, /\\.css,\\.js,\\.mjs,\\.json,\\.svg/);\n  assert.match(local, /text\\/css/);\n  assert.match(cloud, /text\\/css/);\n});\n`);

console.log('workspace parent integration applied');
