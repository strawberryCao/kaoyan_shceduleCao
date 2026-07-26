'use strict';

const fs = require('fs');
const path = require('path');

const sourcePath = path.join(__dirname, 'apply-workspace-final-completion.cjs');
const runtimePath = path.join(__dirname, '.runtime-workspace-final-completion.cjs');
let source = fs.readFileSync(sourcePath, 'utf8');

function serializeTemplateArgument(bodyPrefix, endMarker) {
  const opener = "    `" + bodyPrefix;
  const start = source.indexOf(opener);
  if (start < 0) throw new Error('Template argument start not found: ' + bodyPrefix);
  const bodyStart = start + "    `".length;
  const end = source.indexOf(endMarker, bodyStart);
  if (end < 0) throw new Error('Template argument end not found: ' + endMarker);
  const body = source.slice(bodyStart, end)
    .replace(/\\`/g, '`')
    .replace(/\\\$\{/g, '${');
  source = source.slice(0, start)
    + '    '
    + JSON.stringify(body)
    + source.slice(end + 1);
}

// The helper replacement contains TypeScript template strings. Store the whole
// replacement as JSON text so the construction script never evaluates them.
serializeTemplateArgument('const noteFileUrl =', "`,\n    'asset fallback helpers');");

// The large preview implementation is also embedded source code. Convert the
// String.raw template assignment to one ordinary serialized string.
{
  const marker = 'const previewBlock = String.raw`';
  const start = source.indexOf(marker);
  if (start < 0) throw new Error('Preview block start not found');
  const bodyStart = start + marker.length;
  const tailMarker = '\n`;\n  source = `${source.slice';
  const end = source.indexOf(tailMarker, bodyStart);
  if (end < 0) throw new Error('Preview block end not found');
  const body = source.slice(bodyStart, end);
  source = source.slice(0, start)
    + 'const previewBlock = '
    + JSON.stringify(body)
    + ';'
    + source.slice(end + 3);
}

// Normalize the one local MIME-map target whose source uses two-space
// indentation while the original executor was authored with four spaces.
source = source
  .replace(
    "\"    ['.html', 'text/html'], ['.htm', 'text/html'], ['.txt', 'text/plain'], ['.md', 'text/markdown'],\\n  ]);\"",
    "\"  ['.html', 'text/html'], ['.htm', 'text/html'], ['.txt', 'text/plain'], ['.md', 'text/markdown'],\\n]);\"",
  )
  .replace(
    "\"    ['.html', 'text/html'], ['.htm', 'text/html'], ['.css', 'text/css'], ['.js', 'text/javascript'], ['.mjs', 'text/javascript'],\\n    ['.json', 'application/json'], ['.svg', 'image/svg+xml'], ['.txt', 'text/plain'], ['.md', 'text/markdown'],\\n  ]);\"",
    "\"  ['.html', 'text/html'], ['.htm', 'text/html'], ['.css', 'text/css'], ['.js', 'text/javascript'], ['.mjs', 'text/javascript'],\\n  ['.json', 'application/json'], ['.svg', 'image/svg+xml'], ['.txt', 'text/plain'], ['.md', 'text/markdown'],\\n]);\"",
  );

fs.writeFileSync(runtimePath, source, 'utf8');
try {
  require(runtimePath);
} finally {
  fs.rmSync(runtimePath, { force: true });
}
