const fs = require('fs');
const path = require('path');

const exportPath = path.resolve(__dirname, '..', 'public', 'migration-export.json');
const targetPath = 'data/diagnostics/learning-record-migration-export.json';

async function main() {
  if (process.env.GITHUB_ACTIONS !== 'true' || !fs.existsSync(exportPath)) return;
  const token = String(process.env.CAOBIJI_GITHUB_TOKEN || '').trim();
  if (!token) throw new Error('CAOBIJI_GITHUB_TOKEN is required to publish migration export.');
  const repository = String(process.env.DATA_REPOSITORY || 'strawberryCao/Caobijidata');
  const branch = String(process.env.DATA_BRANCH || 'main');
  const url = `https://api.github.com/repos/${repository}/contents/${targetPath}`;
  const headers = {
    Accept: 'application/vnd.github+json',
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
    'X-GitHub-Api-Version': '2026-03-10',
    'User-Agent': 'kaoyan-learning-record-migration-export',
  };
  let sha = '';
  const current = await fetch(`${url}?ref=${encodeURIComponent(branch)}`, { headers });
  if (current.ok) {
    const payload = await current.json();
    sha = typeof payload.sha === 'string' ? payload.sha : '';
  } else if (current.status !== 404) {
    throw new Error(`Unable to inspect migration export target: HTTP ${current.status}`);
  }
  const content = fs.readFileSync(exportPath);
  const response = await fetch(url, {
    method: 'PUT',
    headers,
    body: JSON.stringify({
      message: 'diagnostic: publish learning record migration export',
      content: content.toString('base64'),
      branch,
      ...(sha ? { sha } : {}),
    }),
  });
  if (!response.ok) throw new Error(`Unable to publish migration export: HTTP ${response.status}`);
  console.log(`Published migration export (${content.length} bytes).`);
}

main().catch((error) => {
  console.error(error?.stack || error);
  process.exitCode = 1;
});
