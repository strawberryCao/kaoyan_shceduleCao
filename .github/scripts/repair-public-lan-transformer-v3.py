from pathlib import Path

path = Path('.github/scripts/apply-public-lan-parity.cjs')
source = path.read_text(encoding='utf-8')


def replace_once(old: str, new: str, label: str) -> None:
    global source
    count = source.count(old)
    if count != 1:
        raise SystemExit(f'{label}: expected one transformer fragment, found {count}')
    source = source.replace(old, new)


mobile_old = r'''  "             <p>{batchProgress || 'AI 正在寻找每一道完整题目的边界。'}</p>\n           </section>",
  "             <p>{batchProgress || 'AI 正在寻找每一道完整题目的边界。'}</p>\n             <ol className=\"mobile-detecting-steps\">\n               <li>上传并压缩原图</li><li>读取局域网 AI 配置</li><li>识别题目边界</li><li>生成可调整裁剪</li>\n             </ol>\n           </section>",'''
mobile_new = r'''  /(<p>\{batchProgress \|\| 'AI 正在寻找每一道完整题目的边界。'\}<\/p>)(\s*<\/section>)/,
  "$1\n             <ol className=\"mobile-detecting-steps\">\n               <li>上传并压缩原图</li><li>读取局域网 AI 配置</li><li>识别题目边界</li><li>生成可调整裁剪</li>\n             </ol>$2",'''
replace_once(mobile_old, mobile_new, 'mobile detection render anchor')

naming_old = r"/function namingPrompt\(settings, remark, repairReason = ''\) \{[\s\S]*?\n\}/,"
naming_new = naming_old.replace(r'\n\}/,', r'\n\}\n\nfunction applyNamingRuleTemplate/,')
replace_once(naming_old, naming_new, 'naming function boundary')
replace_once(
    "  ].filter(Boolean).join('\\n');\n}`,\n  'naming prompt from local contract',",
    "  ].filter(Boolean).join('\\n');\n}\n\nfunction applyNamingRuleTemplate`,\n  'naming prompt from local contract',",
    'naming replacement boundary',
)

commit_old = r'/function Commit-Pending\(\[string\]\$ClonePath, \[string\]\$Message\) \{[\s\S]*?\n\}/,'
commit_new = commit_old.replace(r'\n\}/,', r'\n\}\n\nif \(\$NativeCommandSelfTest\)/,')
replace_once(commit_old, commit_new, 'PowerShell function boundary')
replace_once(
    "  return $false\n}`,\n  'sync commit learning data',",
    "  return $false\n}\n\nif ($NativeCommandSelfTest)`,\n  'sync commit learning data',",
    'PowerShell replacement boundary',
)

note_file_old = r'/function resolveNoteFile\(notesRoot, requestedPath\) \{[\s\S]*?\n\}/,'
note_file_new = note_file_old.replace(r'\n\}/,', r'\n\}\n\nfunction resolveNoteImage/,')
replace_once(note_file_old, note_file_new, 'note file function boundary')
replace_once(
    "  return { filePath, mime, extension, inline: mime.startsWith('image/') };\n}`,\n  'local cloud attachment mapping',",
    "  return { filePath, mime, extension, inline: mime.startsWith('image/') };\n}\n\nfunction resolveNoteImage`,\n  'local cloud attachment mapping',",
    'note file replacement boundary',
)

replace_once(
    '"import { isRenameEligibleNote, runConfiguredRename } from \'./rename-job.js\';",',
    '"import { runConfiguredRename } from \'./rename-job.js\';",',
    'background duplicate eligibility import',
)

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
print('public LAN transformer repaired v3')
