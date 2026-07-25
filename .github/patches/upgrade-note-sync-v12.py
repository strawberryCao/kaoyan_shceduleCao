from pathlib import Path

root = Path('outputs/kaoyan-schedule-app')
installer = root / 'scripts/install-note-folder-sync.ps1'
source = installer.read_text(encoding='utf-8-sig')
replacements = {
    "$version = '20260725-public-lan-parity-v11'": "$version = '20260726-mobile-local-first-v12'",
    '  version = 11': '  version = 12',
    "Write-Host '全局同步 v11 已启用。'": "Write-Host '全局同步 v12 已启用。'",
}
for before, after in replacements.items():
    count = source.count(before)
    if count != 1:
        raise RuntimeError(f'installer anchor count={count}: {before}')
    source = source.replace(before, after, 1)
installer.write_text(source, encoding='utf-8-sig')

for test_path in (root / 'scripts').glob('*.test.cjs'):
    text = test_path.read_text(encoding='utf-8')
    updated = text.replace('public-lan-parity-v11', 'mobile-local-first-v12').replace('version = 11', 'version = 12').replace('全局同步 v11', '全局同步 v12')
    if updated != text:
        test_path.write_text(updated, encoding='utf-8')
print('Windows synchronization installer upgraded to V12')
