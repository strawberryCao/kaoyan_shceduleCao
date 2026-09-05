const path = require('node:path');
const { assertSafeRuntimePaths } = require('./runtime-paths.cjs');

const LAUNCHD_LABEL = 'com.local.kaoyan.study-center';
const LAUNCHD_PLIST_PATH = `/Library/LaunchDaemons/${LAUNCHD_LABEL}.plist`;

function xmlEscape(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}

function plistString(value, indentation = '    ') {
  return `${indentation}<string>${xmlEscape(value)}</string>`;
}

function validateServiceUser(value) {
  const user = String(value || '').trim();
  if (!/^[a-z_][a-z0-9_-]{0,63}$/i.test(user) || user === 'root') {
    throw new Error('A non-root macOS service user is required.');
  }
  return user;
}

function createLaunchDaemonDefinition(options) {
  const runtimePaths = assertSafeRuntimePaths(options.runtimePaths);
  const paths = runtimePaths.platform === 'win32' ? path.win32 : path.posix;
  const serviceUser = validateServiceUser(options.serviceUser);
  const projectRoot = paths.resolve(options.projectRoot);
  const nodePath = paths.resolve(options.nodePath);
  const notePort = Number(options.notePort || 5174);
  const webPort = Number(options.webPort || 5173);
  if (!Number.isInteger(notePort) || !Number.isInteger(webPort)
    || notePort < 1024 || webPort < 1024
    || notePort > 65535 || webPort > 65535
    || notePort === webPort) {
    throw new Error('LaunchDaemon ports must be distinct integers between 1024 and 65535.');
  }

  return Object.freeze({
    label: LAUNCHD_LABEL,
    plistPath: LAUNCHD_PLIST_PATH,
    serviceUser,
    projectRoot,
    nodePath,
    runtimeRoot: runtimePaths.runtimeRoot,
    stdoutPath: paths.join(runtimePaths.logsRoot, 'runtime.stdout.log'),
    stderrPath: paths.join(runtimePaths.logsRoot, 'runtime.stderr.log'),
    programArguments: [
      nodePath,
      paths.join(projectRoot, 'scripts', 'macmini-runtime.cjs'),
      'serve',
      `--runtime-root=${runtimePaths.runtimeRoot}`,
      `--note-port=${notePort}`,
      `--web-port=${webPort}`,
    ],
    environment: {
      HOME: `/Users/${serviceUser}`,
      LANG: 'zh_CN.UTF-8',
      NODE_ENV: 'production',
      KAOYAN_SERVICE_MODE: 'system',
      KAOYAN_RUNTIME_LAYOUT: 'managed',
      KAOYAN_RUNTIME_ROOT: runtimePaths.runtimeRoot,
      KAOYAN_WEB_HOST: '127.0.0.1',
    },
  });
}

function renderLaunchDaemonPlist(definition) {
  const argumentsXml = definition.programArguments.map((value) => plistString(value, '        ')).join('\n');
  const environmentXml = Object.entries(definition.environment)
    .map(([key, value]) => `        <key>${xmlEscape(key)}</key>\n${plistString(value, '        ')}`)
    .join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
${plistString(definition.label)}
    <key>ProgramArguments</key>
    <array>
${argumentsXml}
    </array>
    <key>WorkingDirectory</key>
${plistString(definition.projectRoot)}
    <key>EnvironmentVariables</key>
    <dict>
${environmentXml}
    </dict>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>ProcessType</key>
    <string>Background</string>
    <key>ThrottleInterval</key>
    <integer>10</integer>
    <key>Umask</key>
    <integer>63</integer>
    <key>UserName</key>
${plistString(definition.serviceUser)}
    <key>StandardOutPath</key>
${plistString(definition.stdoutPath)}
    <key>StandardErrorPath</key>
${plistString(definition.stderrPath)}
</dict>
</plist>
`;
}

function publicLaunchDaemonPlan(definition) {
  return {
    label: definition.label,
    plistPath: definition.plistPath,
    serviceUser: definition.serviceUser,
    projectRoot: definition.projectRoot,
    runtimeRoot: definition.runtimeRoot,
    nodePath: definition.nodePath,
    stdoutPath: definition.stdoutPath,
    stderrPath: definition.stderrPath,
    programArguments: definition.programArguments,
    networkBinding: '127.0.0.1 only',
    dataDeletionOnUninstall: false,
  };
}

module.exports = {
  LAUNCHD_LABEL,
  LAUNCHD_PLIST_PATH,
  createLaunchDaemonDefinition,
  publicLaunchDaemonPlan,
  renderLaunchDaemonPlist,
  validateServiceUser,
  xmlEscape,
};
