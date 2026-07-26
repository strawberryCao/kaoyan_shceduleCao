'use strict';

const fs = require('node:fs');
const path = require('node:path');

const sourcePath = path.join(__dirname, 'apply-learning-center-image-display-fix.cjs');
const runtimePath = path.join(__dirname, '.runtime-learning-center-image-display-fix.cjs');
let source = fs.readFileSync(sourcePath, 'utf8');
const before = "=> \\`${NOTE_SERVER_URL}/note-file?path=\\${encodeURIComponent(filePath)}\\`;";
const after = "=> \\`\\${NOTE_SERVER_URL}/note-file?path=\\${encodeURIComponent(filePath)}\\`;";
if (!source.includes(before)) throw new Error('NOTE_SERVER_URL template target not found');
source = source.replace(before, after);
fs.writeFileSync(runtimePath, source, 'utf8');
try {
  require(runtimePath);
} finally {
  fs.rmSync(runtimePath, { force: true });
}
