const fs = require('fs');
const path = require('path');

const sourcePath = path.join(__dirname, 'apply-instant-capture-background-split.cjs');
const runtimePath = path.join(__dirname, '.runtime-instant-capture-background-split.cjs');
let source = fs.readFileSync(sourcePath, 'utf8');
source = source.replace(/replaceOnce\(\n  aiFile,\n  `    diagramRule:[\s\S]*?  'keep splitting variables stable',\n\);\n/, '');
if (source.includes("'keep splitting variables stable'")) {
  throw new Error('failed to remove no-op patch block');
}
source = source.replace(
  "  if (sameKey) return true;\\n  const gap = current.y - (previous.y + previous.height);",
  "  if (sameKey) return true;\\n  if (previous.questionKey && current.questionKey && previous.questionKey !== current.questionKey) return false;\\n  const gap = current.y - (previous.y + previous.height);",
);
if (!source.includes('previous.questionKey !== current.questionKey')) {
  throw new Error('failed to add different-question merge guard');
}
fs.writeFileSync(runtimePath, source, 'utf8');
try {
  require(runtimePath);
} finally {
  fs.rmSync(runtimePath, { force: true });
}
