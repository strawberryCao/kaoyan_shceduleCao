const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');
const {
  LAUNCHD_LABEL,
  createLaunchDaemonDefinition,
  renderLaunchDaemonPlist,
  validateServiceUser,
} = require('../macos-launchd.cjs');
const { resolveRuntimePaths } = require('../runtime-paths.cjs');
const { parseArguments } = require('../install-macmini-service.cjs');

test('LaunchDaemon runs as a non-root user with loopback services and private umask', () => {
  const runtime = resolveRuntimePaths({
    platform: 'darwin',
    homeDir: '/Users/study',
    pathImpl: path.posix,
    env: { KAOYAN_RUNTIME_ROOT: '/Library/Application Support/KaoyanStudyCenter' },
  });
  const definition = createLaunchDaemonDefinition({
    runtimePaths: runtime,
    serviceUser: 'study',
    projectRoot: '/Users/study/kaoyan app',
    nodePath: '/opt/homebrew/bin/node',
    webPort: 5173,
    notePort: 5174,
  });
  const plist = renderLaunchDaemonPlist(definition);
  assert.match(plist, new RegExp(`<string>${LAUNCHD_LABEL}</string>`));
  assert.match(plist, /<key>UserName<\/key>\s*<string>study<\/string>/);
  assert.match(plist, /<key>Umask<\/key>\s*<integer>63<\/integer>/);
  assert.match(plist, /KAOYAN_WEB_HOST[\s\S]*127\.0\.0\.1/);
  assert.match(plist, /--runtime-root=\/Library\/Application Support\/KaoyanStudyCenter/);
  assert.doesNotMatch(plist, /API_KEY|apiKey/);
  assert.equal(definition.programArguments[0], '/opt/homebrew/bin/node');
});

test('LaunchDaemon renderer escapes paths and rejects root service ownership', () => {
  assert.throws(() => validateServiceUser('root'), /non-root/);
  assert.throws(() => validateServiceUser('../study'), /non-root/);
  const runtime = resolveRuntimePaths({
    platform: 'darwin',
    homeDir: '/Users/study',
    pathImpl: path.posix,
    env: { KAOYAN_RUNTIME_ROOT: '/Library/Application Support/KaoyanStudyCenter' },
  });
  const definition = createLaunchDaemonDefinition({
    runtimePaths: runtime,
    serviceUser: 'study',
    projectRoot: '/Users/study/a&b',
    nodePath: '/opt/homebrew/bin/node',
  });
  assert.match(renderLaunchDaemonPlist(definition), /a&amp;b/);
});

test('installer defaults to a read-only plan and never accepts a key on the command line', () => {
  const parsed = parseArguments([], { SUDO_USER: 'study' });
  assert.equal(parsed.command, 'plan');
  assert.equal(parsed.serviceUser, 'study');
  assert.throws(() => parseArguments(['plan', '--api-key=leak'], { SUDO_USER: 'study' }), /Unknown argument/);
});

test('LaunchDaemon rejects privileged, invalid, and duplicate ports before installation', () => {
  const runtime = resolveRuntimePaths({
    platform: 'darwin',
    homeDir: '/Users/study',
    pathImpl: path.posix,
    env: { KAOYAN_RUNTIME_ROOT: '/Library/Application Support/KaoyanStudyCenter' },
  });
  const base = {
    runtimePaths: runtime,
    serviceUser: 'study',
    projectRoot: '/Users/study/kaoyan',
    nodePath: '/opt/homebrew/bin/node',
  };
  assert.throws(() => createLaunchDaemonDefinition({ ...base, notePort: 80, webPort: 5173 }), /1024/);
  assert.throws(() => createLaunchDaemonDefinition({ ...base, notePort: 5173, webPort: 5173 }), /distinct/);
  assert.throws(() => createLaunchDaemonDefinition({ ...base, notePort: 5174, webPort: 70000 }), /65535/);
});
