const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { applyTailscaleServe, buildPlan, parseArguments } = require('../configure-tailscale-serve.cjs');
const { configureMobileAccess } = require('../mobile-session-auth.cjs');
const { resolveRuntimePaths } = require('../runtime-paths.cjs');

test('Tailscale Serve defaults to private HTTPS and never enables Funnel', () => {
  const plan = buildPlan({ webPort: 5173 });
  assert.deepEqual(plan.command, ['tailscale', 'serve', '--bg', '--https=443', 'http://127.0.0.1:5173']);
  assert.equal(plan.publicFunnel, false);
  assert.equal(plan.changesCloudflare, false);
  assert.throws(() => parseArguments(['apply', '--funnel']), /Unknown argument/);
});

test('apply requires mobile authentication and verifies the loopback service first', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kaoyan-tailscale-plan-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const runtime = resolveRuntimePaths({ env: { KAOYAN_RUNTIME_ROOT: root } });
  await assert.rejects(() => applyTailscaleServe({ runtimeRoot: root, webPort: 6173 }, {
    allowNonMac: true, command: 'tailscale', probeReady: async () => true, spawn: () => ({ status: 0, stdout: '{}' }),
  }), /先配置手机\/iPad 登录/);

  configureMobileAccess(path.join(runtime.secretsRoot, 'mobile-access.json'), {
    username: 'study', password: 'a-long-private-password',
  });
  const calls = [];
  const result = await applyTailscaleServe({ runtimeRoot: root, webPort: 6173 }, {
    allowNonMac: true,
    command: '/mock/tailscale',
    probeReady: async (port) => { calls.push(['probe', port]); },
    spawn: (command, args) => {
      calls.push([command, ...args]);
      return { status: 0, stdout: '{"TCP":{}}', stderr: '' };
    },
  });
  assert.equal(result.ok, true);
  assert.deepEqual(calls[0], ['probe', 6173]);
  assert.deepEqual(calls[1], ['/mock/tailscale', 'serve', '--bg', '--https=443', 'http://127.0.0.1:6173']);
  assert.deepEqual(calls[2], ['/mock/tailscale', 'serve', 'status', '--json']);
});
