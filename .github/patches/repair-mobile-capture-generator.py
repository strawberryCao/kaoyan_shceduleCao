from __future__ import annotations

import json
from pathlib import Path

TARGET = Path('.github/patches/apply-mobile-capture-fast-pipeline.cjs')


def replace_block(source: str, variable: str, next_marker: str) -> str:
    start_marker = f'const {variable} = String.raw`'
    start = source.find(start_marker)
    if start < 0:
        raise RuntimeError(f'{variable}: start marker not found')
    end = source.find(next_marker, start + len(start_marker))
    if end < 0:
        raise RuntimeError(f'{variable}: end marker not found')
    section = source[start:end]
    body_with_suffix = section[len(start_marker):]
    suffix = '`;'
    suffix_index = body_with_suffix.rfind(suffix)
    if suffix_index < 0 or body_with_suffix[suffix_index + len(suffix):].strip():
        raise RuntimeError(f'{variable}: closing delimiter not found')
    body = body_with_suffix[:suffix_index]
    replacement = f'const {variable} = {json.dumps(body, ensure_ascii=False)};\n'
    return source[:start] + replacement + source[end:]


def replace_test_block(source: str) -> str:
    start_marker = 'fs.writeFileSync(testPath, String.raw`'
    next_marker = '\n\nfor (const relative of ['
    start = source.find(start_marker)
    if start < 0:
        raise RuntimeError('test block: start marker not found')
    end = source.find(next_marker, start + len(start_marker))
    if end < 0:
        raise RuntimeError('test block: end marker not found')
    section = source[start:end]
    body_with_suffix = section[len(start_marker):]
    suffix = "`, 'utf8');"
    suffix_index = body_with_suffix.rfind(suffix)
    if suffix_index < 0 or body_with_suffix[suffix_index + len(suffix):].strip():
        raise RuntimeError('test block: closing delimiter not found')
    body = body_with_suffix[:suffix_index]
    replacement = f"fs.writeFileSync(testPath, {json.dumps(body, ensure_ascii=False)}, 'utf8');"
    return source[:start] + replacement + source[end:]


source = TARGET.read_text(encoding='utf-8')
for variable, marker in [
    ('fastSaveImplementation', '\nmedia = replaceRegexOnce('),
    ('streamHelper', '\nworker = replaceOnce(worker,'),
    ('streamingClient', '\nnotes = replaceRegexOnce('),
    ('batchReliableHelper', '\ndrop = replaceOnce(drop,'),
    ('fastBatchSave', '\ndrop = replaceRegexOnce('),
]:
    source = replace_block(source, variable, marker)
source = replace_test_block(source)
TARGET.write_text(source, encoding='utf-8')
print('nested generator literals repaired')
