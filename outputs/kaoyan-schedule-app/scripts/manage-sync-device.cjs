#!/usr/bin/env node

const path = require('node:path');
const { resolveRuntimePaths } = require('./runtime-paths.cjs');
const { createDevice, listDevices, revokeDevice } = require('./sync-device-auth.cjs');

function parseArguments(argv = process.argv.slice(2)) {
  const result = { command: argv[0] || 'list', deviceId: '', label: '', runtimeRoot: '' };
  for (const argument of argv.slice(1)) {
    if (argument.startsWith('--device-id=')) result.deviceId = argument.slice('--device-id='.length).trim();
    else if (argument.startsWith('--label=')) result.label = argument.slice('--label='.length).trim();
    else if (argument.startsWith('--runtime-root=')) result.runtimeRoot = argument.slice('--runtime-root='.length).trim();
    else throw new Error(`Unknown argument: ${argument}`);
  }
  return result;
}

function main(argv = process.argv.slice(2), environment = process.env) {
  const arguments_ = parseArguments(argv);
  const env = { ...environment };
  if (arguments_.runtimeRoot) env.KAOYAN_RUNTIME_ROOT = path.resolve(arguments_.runtimeRoot);
  const runtime = resolveRuntimePaths({ env });
  if (runtime.layout !== 'managed') throw new Error('Sync devices require a managed runtime root.');
  const configPath = path.join(runtime.secretsRoot, 'sync-devices.json');
  if (arguments_.command === 'create') {
    const created = createDevice(configPath, arguments_);
    process.stdout.write('Sync device created. Copy this token now; it is never shown again.\n');
    process.stdout.write(`Device ID: ${created.deviceId}\n`);
    process.stdout.write(`Token: ${created.token}\n`);
    return created;
  }
  if (arguments_.command === 'revoke') {
    if (!arguments_.deviceId) throw new Error('--device-id is required.');
    const revoked = revokeDevice(configPath, arguments_.deviceId);
    process.stdout.write(revoked ? `Revoked ${arguments_.deviceId}.\n` : `Device ${arguments_.deviceId} was not found.\n`);
    return revoked;
  }
  if (arguments_.command === 'list') {
    const devices = listDevices(configPath);
    process.stdout.write(`${JSON.stringify(devices, null, 2)}\n`);
    return devices;
  }
  throw new Error(`Unknown command: ${arguments_.command}`);
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`Sync device command failed: ${error.message}\n`);
    process.exitCode = 1;
  }
}

module.exports = { main, parseArguments };
