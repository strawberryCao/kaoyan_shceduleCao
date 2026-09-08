const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const {
  configureTunnel,
  createTunnelChildSpecification,
  disableTunnel,
  normalizeHostname,
  publicTunnelStatus,
} = require('../cloudflare-tunnel-config.cjs');
const { buildPlan, parseArguments } = require('../configure-cloudflare-tunnel.cjs');
const { resolveRuntimePaths } = require('../runtime-paths.cjs');
const { createChildSpecifications } = require('../macmini-runtime.cjs');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kaoyan-cloudflare-tunnel-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { root, runtime: resolveRuntimePaths({ env: { KAOYAN_RUNTIME_ROOT: root } }) };
}

test('Cloudflare plan is read-only and refuses secrets in command arguments', (t) => {
  const { runtime } = fixture(t);
  const plan = buildPlan(runtime, { hostname: 'study.example.com', webPort: 6173 });
  assert.equal(plan.defaultClientPath, 'Tailscale');
  assert.equal(plan.authoritativeServer, 'Mac mini');
  assert.equal(plan.mutatesCloudflareAccount, false);
  assert.equal(plan.origin, 'http://127.0.0.1:6173');
  assert.throws(() => parseArguments(['configure', '--token=secret']), /Unknown argument/);
});

test('Tunnel token is private and the supervised command uses token-file', (t) => {
  const { runtime } = fixture(t);
  const token = `eyJ${'a'.repeat(120)}.signature`;
  const status = configureTunnel(runtime, { hostname: 'Study.Example.com.', token, webPort: 5173 });
  assert.equal(status.enabled, true);
  assert.equal(status.hostname, 'study.example.com');
  assert.equal(status.token, '已安全保存');
  assert.equal(JSON.stringify(status).includes(token), false);
  const spec = createTunnelChildSpecification(runtime, { command: '/opt/homebrew/bin/cloudflared', environment: { SAFE: '1' } });
  assert.deepEqual(spec.args.slice(0, 3), ['tunnel', '--no-autoupdate', 'run']);
  assert.equal(spec.critical, false);
  assert.equal(spec.args.includes('--token-file'), true);
  assert.equal(spec.args.includes(token), false);
  assert.equal(fs.readFileSync(status.tokenPath, 'utf8').trim(), token);
  const runtimeSpecs = createChildSpecifications(runtime, {
    nodePath: process.execPath,
    cloudflaredPath: '/opt/homebrew/bin/cloudflared',
    projectRoot: path.resolve(__dirname, '..', '..'),
  });
  assert.deepEqual(runtimeSpecs.map((item) => item.id), ['note-service', 'web-gateway', 'backup-scheduler', 'cloudflare-tunnel']);
  assert.deepEqual(runtimeSpecs.map((item) => item.critical), [true, true, false, false]);
  assert.equal(runtimeSpecs[1].environment.KAOYAN_CLOUDFLARE_HOSTNAME, 'study.example.com');
  disableTunnel(runtime);
  assert.equal(publicTunnelStatus(runtime).enabled, false);
  assert.equal(fs.existsSync(status.tokenPath), true);
  assert.equal(createTunnelChildSpecification(runtime, { command: 'cloudflared' }), null);
});

test('Cloudflare hostname validation fails closed', () => {
  assert.equal(normalizeHostname('Study.Example.com.'), 'study.example.com');
  assert.throws(() => normalizeHostname('localhost'), /格式无效/);
  assert.throws(() => normalizeHostname('bad host.example.com'), /格式无效/);
});
