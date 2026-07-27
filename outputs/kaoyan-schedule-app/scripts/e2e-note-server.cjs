const fs = require('node:fs');
const path = require('node:path');

const projectRoot = path.resolve(__dirname, '..');
const runtimeRoot = path.resolve(projectRoot, '.e2e-runtime');
if (path.dirname(runtimeRoot) !== projectRoot || path.basename(runtimeRoot) !== '.e2e-runtime') {
  throw new Error(`Refusing to reset unexpected E2E runtime path: ${runtimeRoot}`);
}

fs.rmSync(runtimeRoot, { recursive: true, force: true });
fs.mkdirSync(runtimeRoot, { recursive: true });
const assistantRoot = path.join(runtimeRoot, 'assistant');
fs.mkdirSync(assistantRoot, { recursive: true });
fs.writeFileSync(
  path.join(assistantRoot, 'ai-providers.json'),
  `${JSON.stringify({ version: 1, tasks: { weekly_review_pdf: { enabled: false, options: { autoSync: false } } } }, null, 2)}\n`,
  'utf8',
);

process.env.KAOYAN_NOTE_PORT = '5174';
process.env.KAOYAN_NOTES_ROOT = path.join(runtimeRoot, 'notes');
process.env.KAOYAN_ASSISTANT_ROOT = assistantRoot;
process.env.KAOYAN_AI_CONFIG_PATH = path.join(assistantRoot, 'ai-providers.json');

module.exports = require('./note-server.cjs');
