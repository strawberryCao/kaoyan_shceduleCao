const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { extractTailscaleHttpsUrl, readCloudflareFallback, readLatestBackup } = require('../macmini-manager-state.cjs');
const { renderManagerLaunchAgent, validateManagerDefinition } = require('../macos-manager-launchagent.cjs');
const { buildDefinition, parseArguments, publicPlan } = require('../install-macmini-manager.cjs');

test('menu bar state extracts only private Tailscale HTTPS and enabled fallback URL', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kaoyan-manager-state-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'config'));
  fs.writeFileSync(path.join(root, 'config', 'cloudflare-tunnel.json'), JSON.stringify({ enabled: true, hostname: 'study.example.com' }));
  assert.equal(extractTailscaleHttpsUrl({ Web: { 'https://study-mac.tailnet.ts.net': {} } }), 'https://study-mac.tailnet.ts.net');
  assert.equal(extractTailscaleHttpsUrl('http://not-private.example.com'), '');
  assert.equal(readCloudflareFallback(root), 'https://study.example.com');
  const backupPath = path.join(root, 'backups', 'snapshot-one');
  fs.mkdirSync(backupPath, { recursive: true });
  fs.writeFileSync(path.join(backupPath, 'manifest.json'), JSON.stringify({ kind: 'kaoyan-macmini-snapshot', createdAt: '2026-09-08T12:00:00Z', totals: { files: 12 } }));
  assert.deepEqual(readLatestBackup(root), { name: 'snapshot-one', createdAt: '2026-09-08T12:00:00Z', files: 12 });
  fs.writeFileSync(path.join(backupPath, 'manifest.json'), JSON.stringify({ kind: 'kaoyan-macmini-snapshot', createdAt: 'not-a-date', totals: { files: 12 } }));
  assert.equal(readLatestBackup(root), null);
  fs.writeFileSync(path.join(root, 'config', 'cloudflare-tunnel.json'), JSON.stringify({ enabled: false, hostname: 'study.example.com' }));
  assert.equal(readCloudflareFallback(root), '');
});

test('menu bar LaunchAgent is user-level, non-authoritative and contains no secret', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kaoyan-manager-agent-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const definition = buildDefinition({
    homeDir: path.join(root, 'home'),
    runtimeRoot: path.join(root, 'runtime'),
    projectRoot: path.join(root, 'project'),
    electronPath: path.join(root, 'Electron'),
  });
  const plan = publicPlan(definition);
  const plist = renderManagerLaunchAgent(definition);
  assert.match(plan.plistPath, /LaunchAgents/);
  assert.equal(plan.coreServiceDependency, false);
  assert.equal(plan.startsAfterUserLogin, true);
  assert.match(plist, /--macmini-manager/);
  assert.match(plist, /LimitLoadToSessionType/);
  assert.match(plist, /<key>SuccessfulExit<\/key>\s*<false\/>/);
  assert.doesNotMatch(plist, /api.?key|tunnel.?token/i);
  assert.deepEqual(parseArguments([]), { command: 'plan', runtimeRoot: '', json: false });
  assert.throws(() => validateManagerDefinition({ homeDir: path.parse(root).root, projectRoot: root, electronPath: path.join(root, 'e'), runtimeRoot: path.join(root, 'r') }), /用户目录/);
});
