'use strict';

const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const appRoot = path.join(root, 'outputs', 'kaoyan-schedule-app');
const workspacePath = path.join(appRoot, 'src', 'components', 'LearningRecordWorkspacePreview.tsx');
const learningCenterPath = path.join(appRoot, 'src', 'components', 'LearningCenter.tsx');

function replaceOnce(source, before, after, label) {
  const index = source.indexOf(before);
  if (index < 0) {
    if (source.includes(after)) return source;
    throw new Error(`Missing attachment workspace anchor: ${label}`);
  }
  if (source.indexOf(before, index + before.length) >= 0) {
    throw new Error(`Ambiguous attachment workspace anchor: ${label}`);
  }
  return `${source.slice(0, index)}${after}${source.slice(index + before.length)}`;
}

let workspace = fs.readFileSync(workspacePath, 'utf8');
workspace = replaceOnce(
  workspace,
  "  const activeAsset = assets.find((item) => item.id === activeId) || assets[0] || null;",
  "  const activeAsset = assets.find((item) => item.id === activeId) || assets[0] || null;\n  const assetKey = assets.map((item) => item.id).join('\\u001f');",
  'workspace asset identity key',
);
workspace = replaceOnce(
  workspace,
  "  useEffect(() => {\n    if (!assets.some((item) => item.id === activeId)) setActiveId(assets[0]?.id || '');\n    setFloating([]);\n  }, [assets, activeId]);",
  "  useEffect(() => {\n    const validIds = new Set(assetKey ? assetKey.split('\\u001f') : []);\n    setActiveId((current) => validIds.has(current) ? current : assets[0]?.id || '');\n    setFloating((current) => current.filter((item) => validIds.has(item.assetId)));\n  }, [assetKey, assets]);",
  'workspace attachment synchronization',
);
fs.writeFileSync(workspacePath, workspace, 'utf8');

let learningCenter = fs.readFileSync(learningCenterPath, 'utf8');
learningCenter = replaceOnce(
  learningCenter,
  "          <div className=\"lc-heading-actions\">\n            <button type=\"button\" onClick={() => beginEditNote(note)}><Pencil size={15} />编辑</button>",
  "          <div className=\"lc-heading-actions\">\n            {attachments.length > 0 && (\n              <button type=\"button\" onClick={() => {\n                const url = new URL(window.location.href);\n                url.searchParams.set('workspaceNote', note.noteUid);\n                url.searchParams.delete('hub');\n                url.searchParams.delete('notes');\n                url.searchParams.delete('noteApp');\n                window.location.assign(url.toString());\n              }}><FolderOpen size={15} />资料工作区</button>\n            )}\n            <button type=\"button\" onClick={() => beginEditNote(note)}><Pencil size={15} />编辑</button>",
  'learning center workspace action',
);
fs.writeFileSync(learningCenterPath, learningCenter, 'utf8');

console.log('Connected real learning records to the attachment workspace route.');
