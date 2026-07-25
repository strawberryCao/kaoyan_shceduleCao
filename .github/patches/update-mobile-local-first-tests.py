from pathlib import Path

ROOT = Path('outputs/kaoyan-schedule-app/scripts')


def replace_once(name: str, before: str, after: str) -> None:
    path = ROOT / name
    source = path.read_text(encoding='utf-8')
    count = source.count(before)
    if count != 1:
        raise RuntimeError(f'{name}: expected one anchor, found {count}: {before}')
    path.write_text(source.replace(before, after, 1), encoding='utf-8')


replace_once(
    'cloud-capture-fast-pipeline.test.cjs',
    "  assert.match(block, /saveNoteImagesBatch|saveBatchReliably/);\n  assert.match(block, /正在一次性上传并归档/);",
    "  assert.match(block, /enqueueCaptureUpload\\(payloads\\)/);\n  assert.match(block, /本机后台队列|可以立即退出/);",
)
replace_once(
    'public-lan-parity.test.cjs',
    "assert.match(capture, /AI 正在后台按局域网规则命名/);",
    "assert.match(capture, /后台队列|局域网规则.*命名|完整分类/);",
)
replace_once(
    'public-lan-parity.test.cjs',
    "assert.match(rename, /updateMirroredCloudNote/);",
    "assert.match(text('cloudflare/learning.js'), /updateMirroredCloudNote/);",
)
replace_once(
    'public-lan-parity.test.cjs',
    "assert.match(media, /enqueueRenameJob/);",
    "assert.match(media, /enqueueNotePipelineJob/);",
)
print('legacy mobile capture assertions updated for local-first pipeline')
