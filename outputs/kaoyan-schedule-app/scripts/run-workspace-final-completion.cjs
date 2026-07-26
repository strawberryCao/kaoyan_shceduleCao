'use strict';

const fs = require('fs');
const path = require('path');

const sourcePath = path.join(__dirname, 'apply-workspace-final-completion.cjs');
const runtimePath = path.join(__dirname, '.runtime-workspace-final-completion.cjs');
let source = fs.readFileSync(sourcePath, 'utf8');

const replacements = [
  ["({ src: `data:${image.contentType};base64,${value}` }))", "({ src: 'data:' + image.contentType + ';base64,' + value }))"],
  ["const document = `<!doctype html><html><head><meta charset=\"utf-8\"><style>body{font:16px/1.75 system-ui,sans-serif;padding:24px;max-width:900px;margin:auto;color:#202124}img{max-width:100%;height:auto}table{border-collapse:collapse;max-width:100%}td,th{border:1px solid #bbb;padding:6px}p{white-space:normal}</style></head><body>${html}${messages.length ? `<hr><small>${messages.join('；')}</small>` : ''}</body></html>`;", "const document = '<!doctype html><html><head><meta charset=\"utf-8\"><style>body{font:16px/1.75 system-ui,sans-serif;padding:24px;max-width:900px;margin:auto;color:#202124}img{max-width:100%;height:auto}table{border-collapse:collapse;max-width:100%}td,th{border:1px solid #bbb;padding:6px}p{white-space:normal}</style></head><body>' + html + (messages.length ? '<hr><small>' + messages.join('；') + '</small>' : '') + '</body></html>';"],
  ["return replacement ? `url(\"${replacement}\")` : whole;", "return replacement ? 'url(\\\"' + replacement + '\\\")' : whole;"],
  ["return { html: `<!doctype html>${document.documentElement.outerHTML}`, urls };", "return { html: '<!doctype html>' + document.documentElement.outerHTML, urls };"],
  ["<article className={`lrp-file-preview is-${item.kind}`}>", "<article className={'lrp-file-preview is-' + item.kind}>"],
];

for (const [before, after] of replacements) {
  if (!source.includes(before)) throw new Error('Nested template target not found: ' + before.slice(0, 80));
  source = source.replace(before, after);
}

fs.writeFileSync(runtimePath, source, 'utf8');
try {
  require(runtimePath);
} finally {
  fs.rmSync(runtimePath, { force: true });
}
