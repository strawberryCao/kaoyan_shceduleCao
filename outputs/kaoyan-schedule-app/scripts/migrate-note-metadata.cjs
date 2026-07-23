const fs = require('fs');
const os = require('os');
const path = require('path');

const NOTES_ROOT = process.env.KAOYAN_NOTES_ROOT || path.join(os.homedir(), 'Desktop', '笔记');
const ASSISTANT_ROOT = process.env.KAOYAN_ASSISTANT_ROOT || path.join(os.homedir(), 'Desktop', '考研桌面助手');
const LOG_PATH = path.join(ASSISTANT_ROOT, 'migrate-note-metadata.log');

function log(message) {
  fs.mkdirSync(ASSISTANT_ROOT, { recursive: true });
  const line = `[${new Date().toISOString()}] ${message}`;
  fs.appendFileSync(LOG_PATH, `${line}\n`, 'utf8');
  console.log(line);
}

function uniquePath(destPath) {
  if (!fs.existsSync(destPath)) return destPath;
  const parsed = path.parse(destPath);
  let counter = 2;
  while (true) {
    const candidate = path.join(parsed.dir, `${parsed.name}_${counter}${parsed.ext}`);
    if (!fs.existsSync(candidate)) return candidate;
    counter += 1;
  }
}

function moveIfExists(sourcePath, destPath) {
  if (!fs.existsSync(sourcePath)) return false;
  fs.mkdirSync(path.dirname(destPath), { recursive: true });
  const finalPath = uniquePath(destPath);
  fs.renameSync(sourcePath, finalPath);
  log(`MOVE ${sourcePath} -> ${finalPath}`);
  return true;
}

function migrateDir(dir) {
  const stat = fs.statSync(dir);
  if (!stat.isDirectory()) return;

  const metaDir = path.join(dir, '.metadata');
  let moved = 0;

  if (moveIfExists(path.join(dir, 'metadata.json'), path.join(metaDir, 'metadata.json'))) {
    moved += 1;
  }

  for (const fileName of fs.readdirSync(dir)) {
    const filePath = path.join(dir, fileName);
    if (fileName === '.metadata') continue;
    if (fs.statSync(filePath).isDirectory()) continue;
    if (/\.note\.json$/i.test(fileName)) {
      if (moveIfExists(filePath, path.join(metaDir, fileName))) {
        moved += 1;
      }
    }
  }

  if (moved === 0) {
    log(`SKIP ${dir}`);
  }
}

function main() {
  log('---- migrate note metadata start ----');
  log(`notesRoot=${NOTES_ROOT}`);
  if (!fs.existsSync(NOTES_ROOT)) {
    log('notesRoot does not exist');
    return;
  }

  for (const name of fs.readdirSync(NOTES_ROOT)) {
    const dir = path.join(NOTES_ROOT, name);
    if (fs.statSync(dir).isDirectory()) {
      migrateDir(dir);
    }
  }

  log('done');
}

main();
