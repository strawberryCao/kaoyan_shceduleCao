from pathlib import Path

root = Path('outputs/kaoyan-schedule-app')

runtime_path = root / 'cloudflare/agent-runtime.js'
runtime = runtime_path.read_text(encoding='utf-8')
old_path = "data/config/local-assistant/legacy-v11-analysis-workflows.json"
new_path = "control-plane/compatibility/legacy-v11-analysis-workflows.json"
if runtime.count(old_path) != 1:
    raise RuntimeError(f'agent-runtime compatibility path count={runtime.count(old_path)}')
runtime_path.write_text(runtime.replace(old_path, new_path, 1), encoding='utf-8')

test_path = root / 'scripts/legacy-v11-runtime-compat.test.mjs'
test_source = test_path.read_text(encoding='utf-8')
if test_source.count(old_path) != 1:
    raise RuntimeError(f'compatibility test path count={test_source.count(old_path)}')
test_source = test_source.replace(old_path, new_path, 1)
test_source += """

test('legacy compatibility path is outside every V11 synchronization-owned directory', () => {
  assert.ok(!LEGACY_V11_WORKFLOW_COMPAT_PATH.startsWith('data/config/local-assistant/'));
  assert.equal(LEGACY_V11_WORKFLOW_COMPAT_PATH, 'control-plane/compatibility/legacy-v11-analysis-workflows.json');
});
"""
test_path.write_text(test_source, encoding='utf-8')

sync_test_path = root / 'scripts/mobile-local-first-analysis.test.cjs'
sync_tests = sync_test_path.read_text(encoding='utf-8')
marker = 'V11 config synchronization cannot delete the compatibility control-plane file'
if marker not in sync_tests:
    sync_tests += r'''

test('V11 config synchronization cannot delete the compatibility control-plane file', () => {
  const sync = text('scripts/windows-assistant-config-sync.ps1');
  const runtime = text('cloudflare/agent-runtime.js');
  assert.match(sync, /data\\config\\local-assistant/);
  assert.match(sync, /git.*add.*data\/config\/local-assistant/s);
  assert.match(runtime, /control-plane\/compatibility\/legacy-v11-analysis-workflows\.json/);
  assert.doesNotMatch(runtime, /data\/config\/local-assistant\/legacy-v11-analysis-workflows\.json/);
});
'''
    sync_test_path.write_text(sync_tests, encoding='utf-8')

print('Moved legacy V11 compatibility contract outside synchronization-owned paths.')
