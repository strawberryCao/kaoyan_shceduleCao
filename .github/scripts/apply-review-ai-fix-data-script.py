from pathlib import Path

path = Path('.github/scripts/apply-review-ai-data.py')
text = path.read_text(encoding='utf-8')
old = '    "      wrongReason: parsed.wrongReasons?.[0] || \'\',\\n      intent,\\n",\n    "      wrongReason: parsed.wrongReasons?.[0] || \'\',\\n      wrongReasonSource:'
new = '    "    wrongReason: parsed.wrongReasons?.[0] || \'\',\\n    intent,\\n",\n    "    wrongReason: parsed.wrongReasons?.[0] || \'\',\\n    wrongReasonSource:'
if old not in text:
    raise SystemExit('data script indentation pattern not found')
path.write_text(text.replace(old, new, 1), encoding='utf-8', newline='\n')
print('Fixed note-server initial provenance indentation in data patch script.')
