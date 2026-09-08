const path = require('node:path');

const MANAGER_LAUNCHD_LABEL = 'com.local.kaoyan.study-center.manager';

function xmlEscape(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}

function validateManagerDefinition(options = {}) {
  const homeDir = path.resolve(String(options.homeDir || ''));
  const projectRoot = path.resolve(String(options.projectRoot || ''));
  const electronPath = path.resolve(String(options.electronPath || ''));
  const runtimeRoot = path.resolve(String(options.runtimeRoot || ''));
  if (!homeDir || homeDir === path.parse(homeDir).root) throw new Error('有效的 Mac 用户目录是必需的。');
  if (!projectRoot || projectRoot === path.parse(projectRoot).root) throw new Error('有效的项目目录是必需的。');
  if (!electronPath || electronPath === path.parse(electronPath).root) throw new Error('有效的 Electron 可执行文件是必需的。');
  if (!runtimeRoot || runtimeRoot === path.parse(runtimeRoot).root) throw new Error('有效的 Mac 数据目录是必需的。');
  return {
    label: MANAGER_LAUNCHD_LABEL,
    plistPath: path.join(homeDir, 'Library', 'LaunchAgents', `${MANAGER_LAUNCHD_LABEL}.plist`),
    homeDir,
    projectRoot,
    electronPath,
    runtimeRoot,
    stdoutPath: path.join(runtimeRoot, 'logs', 'manager.stdout.log'),
    stderrPath: path.join(runtimeRoot, 'logs', 'manager.stderr.log'),
    programArguments: [electronPath, projectRoot, '--macmini-manager'],
  };
}

function renderManagerLaunchAgent(input) {
  const definition = validateManagerDefinition(input);
  const argumentsXml = definition.programArguments.map((value) => `        <string>${xmlEscape(value)}</string>`).join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>${xmlEscape(definition.label)}</string>
    <key>ProgramArguments</key>
    <array>
${argumentsXml}
    </array>
    <key>WorkingDirectory</key>
    <string>${xmlEscape(definition.projectRoot)}</string>
    <key>EnvironmentVariables</key>
    <dict>
        <key>KAOYAN_RUNTIME_ROOT</key>
        <string>${xmlEscape(definition.runtimeRoot)}</string>
    </dict>
    <key>LimitLoadToSessionType</key>
    <string>Aqua</string>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <dict>
        <key>SuccessfulExit</key>
        <false/>
    </dict>
    <key>ProcessType</key>
    <string>Interactive</string>
    <key>ThrottleInterval</key>
    <integer>10</integer>
    <key>StandardOutPath</key>
    <string>${xmlEscape(definition.stdoutPath)}</string>
    <key>StandardErrorPath</key>
    <string>${xmlEscape(definition.stderrPath)}</string>
</dict>
</plist>
`;
}

module.exports = {
  MANAGER_LAUNCHD_LABEL,
  renderManagerLaunchAgent,
  validateManagerDefinition,
  xmlEscape,
};
