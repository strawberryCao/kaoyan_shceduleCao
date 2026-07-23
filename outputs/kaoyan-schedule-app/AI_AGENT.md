# 智能笔记 Agent

## 工作方式

- 保存图片时立即生成永久 `noteUid`，解析页码、题号与明显意图，并同步到当天课表的“自动同步笔记”。
- 每天 09:00 检查一次；距离上次成功整理满 72 小时才运行。关机错过后，下一次启动桌面助手会补跑。
- AI 会统一知识点和错因，物理目录最多为 `科目/一级知识点`；错题、经典、背诵、待复习等使用可叠加标签。
- 文件移动写入 `note-organizer-moves.jsonl`，中断后可恢复；手写课表备注不会被 AI 覆盖。
- 背诵与错题卡片先作为草稿生成，用户可以编辑、启用或忽略。

## 配置 Gemini 与 Kimi

双击 `配置多模型AI.cmd`，在打开的私有文件中填写 API Key 和你账号实际可用的模型名。配置文件默认位于：

```text
%USERPROFILE%\Desktop\考研桌面助手\ai-providers.json
```

也可以使用环境变量：`GEMINI_API_KEY`、`GEMINI_MODEL`、`GEMINI_BASE_URL`、`KIMI_API_KEY`、`KIMI_MODEL`、`KIMI_BASE_URL`。原有千问配置继续兼容。修改私有配置文件后，服务会自动重新加载。

## 手动运行

- 双击 `立即整理未分类笔记.cmd`：忽略 72 小时间隔，立即整理全部新增或变化的笔记。
- 仅预览：在项目目录运行 `node scripts/organize-notes.cjs --dry-run`。
- 服务状态：打开 `http://127.0.0.1:5174/health`。
