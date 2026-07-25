from pathlib import Path

path = Path('.github/scripts/apply-public-lan-parity.cjs')
source = path.read_text(encoding='utf-8')

replacements = [
    (
        '''  "             <p>{batchProgress || 'AI 正在寻找每一道完整题目的边界。'}</p>\\n           </section>",
  "             <p>{batchProgress || 'AI 正在寻找每一道完整题目的边界。'}</p>\\n             <ol className=\\"mobile-detecting-steps\\">\\n               <li>上传并压缩原图</li><li>读取局域网 AI 配置</li><li>识别题目边界</li><li>生成可调整裁剪</li>\\n             </ol>\\n           </section>",''',
        '''  /(<p>\\{batchProgress \\|\\| 'AI 正在寻找每一道完整题目的边界。'\\}<\\/p>)(\\s*<\\/section>)/,
  "$1\\n             <ol className=\\"mobile-detecting-steps\\">\\n               <li>上传并压缩原图</li><li>读取局域网 AI 配置</li><li>识别题目边界</li><li>生成可调整裁剪</li>\\n             </ol>$2",''',
        'mobile detection render anchor',
    ),
    (
        "/function namingPrompt\\(settings, remark, repairReason = ''\\) \\{[\\s\\S]*?\\n\\}/,",
        "/function namingPrompt\\(settings, remark, repairReason = ''\\) \\{[\\s\\S]*?\\n\\}\\n\\nfunction applyNamingRuleTemplate/,
",
        'naming function boundary',
    ),
    (
        "  ].filter(Boolean).join('\\n');\n}`,\n  'naming prompt from local contract',",
        "  ].filter(Boolean).join('\\n');\n}\n\nfunction applyNamingRuleTemplate`,\n  'naming prompt from local contract',",
        'naming replacement boundary',
    ),
    (
        "/function Commit-Pending\\(\\[string\\]\\$ClonePath, \\[string\\]\\$Message\\) \\{[\\s\\S]*?\\n\\}/,",
        "/function Commit-Pending\\(\\[string\\]\\$ClonePath, \\[string\\]\\$Message\\) \\{[\\s\\S]*?\\n\\}\\n\\nif \\(\\$NativeCommandSelfTest\\)/,",
        'PowerShell function boundary',
    ),
    (
        "  return $false\n}`,\n  'sync commit learning data',",
        "  return $false\n}\n\nif ($NativeCommandSelfTest)`,\n  'sync commit learning data',",
        'PowerShell replacement boundary',
    ),
    (
        "/function resolveNoteFile\\(notesRoot, requestedPath\\) \\{[\\s\\S]*?\\n\\}/,",
        "/function resolveNoteFile\\(notesRoot, requestedPath\\) \\{[\\s\\S]*?\\n\\}\\n\\nfunction resolveNoteImage/,
",
        'note file function boundary',
    ),
    (
        "  return { filePath, mime, extension, inline: mime.startsWith('image/') };\n}`,\n  'local cloud attachment mapping',",
        "  return { filePath, mime, extension, inline: mime.startsWith('image/') };\n}\n\nfunction resolveNoteImage`,\n  'local cloud attachment mapping',",
        'note file replacement boundary',
    ),
]

for old, new, label in replacements:
    count = source.count(old)
    if count != 1:
        raise SystemExit(f'{label}: expected one transformer fragment, found {count}')
    source = source.replace(old, new)

mirror_patch = """replaceOnce(
  'outputs/kaoyan-schedule-app/cloudflare/source-mirror.js',
  \"    subject: '默认文件夹',\\n    sourceType: sourceType(note, current),\",
  \"    subject: String(note.subject || current.subject || '默认文件夹').slice(0, 80),\\n    sourceType: sourceType(note, current),\",
  'mirror metadata subject parity',
);

"""
marker = '// Public client waits for the locally configured task instead of aborting at 45 seconds.'
if mirror_patch not in source:
    if source.count(marker) != 1:
        raise SystemExit('source mirror insertion marker missing')
    source = source.replace(marker, mirror_patch + marker)

path.write_text(source, encoding='utf-8')
print('public LAN transformer repaired')
