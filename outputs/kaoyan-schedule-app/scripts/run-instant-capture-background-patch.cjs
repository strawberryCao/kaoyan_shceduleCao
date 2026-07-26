const fs = require('fs');
const path = require('path');

const sourcePath = path.join(__dirname, 'apply-instant-capture-background-split.cjs');
const runtimePath = path.join(__dirname, '.runtime-instant-capture-background-split.cjs');
let source = fs.readFileSync(sourcePath, 'utf8');
source = source.replace(/replaceOnce\(\n  aiFile,\n  `    diagramRule:[\s\S]*?  'keep splitting variables stable',\n\);\n/, '');
if (source.includes("'keep splitting variables stable'")) {
  throw new Error('failed to remove no-op patch block');
}
fs.writeFileSync(runtimePath, source, 'utf8');
try {
  require(runtimePath);
} finally {
  fs.rmSync(runtimePath, { force: true });
}
