# 速记 HTML Agent 架构

## 目标与边界

速记中的 AI 负责把用户的明确需求转换为一个可预览、可删除的 HTML 附件。它不是拥有后台写权限的通用自治 Agent。首版闭环固定为：

1. 读取用户主动输入的需求和当前速记草稿。
2. 生成类型化 `{ title, html, css, js }` 产物。
3. 运行确定性的离线安全校验。
4. 在无同源权限的 iframe 中预览。
5. 只有用户点击“加入本条速记”后，产物才成为待保存附件。
6. 只有用户点击“保存速记”后，产物才进入持久存储和自动命名流程。

模型不能直接保存、删除、联网、读取浏览器存储或操作其他笔记。

## 状态机

```text
draft
  -> generating
  -> validating
  -> preview_ready
  -> user_approved
  -> attached_to_draft
  -> saved

generating | validating -> failed -> retryable
preview_ready -> discarded
```

每次生成都记录 `operationId`、模型、是否回退、耗时、prompt hash、validator version、artifact hash 和错误码。相同 `operationId + prompt hash` 必须幂等；草稿 revision 改变后，旧结果只能预览，不能静默覆盖新草稿。

## 记忆分层

- 临时上下文：当前需求、标题、正文和用户明确选中的附件摘要。随生成任务结束而释放。
- 会话记忆：本次预览中的修改要求和验证错误，只用于有限的 1–2 次修复循环。
- 持久记忆：仅保存用户批准后的产物摘要、artifact hash、验证器版本和显式偏好。不得保存 API 密钥、原始隐私附件或未批准的模型推断。

持久记忆必须可查看、可删除，并区分“用户明确提供”与“AI 推断”。

## 工具面

允许的只读工具：

- `read_draft_context`
- `read_selected_attachment_text`
- `search_notes`（必须由用户主动选择范围）
- `inspect_render_errors`

允许的纯计算工具：

- `emit_html_project`
- `validate_html_project`
- `compute_artifact_hash`

`attach_to_draft` 和 `save_note` 不提供给模型；它们只能由用户界面事件调用。未来若增加外部资料检索，必须单独显示来源、网络权限和即将发送的查询。

## 编排与恢复

本地单次生成可由现有 AI router 完成。多步修复、长时间任务和云端运行应进入持久任务队列或 Durable Workflow：每一步有稳定 ID、结果快照、超时、重试策略和取消点；重试不得重复已成功的付费调用。

活动中心统一呈现：

```text
已读取草稿 -> 模型生成 -> 安全校验 -> 等待确认 -> 已加入 -> 已保存
```

任务重启恢复时先比较 draft revision 和 artifact hash。若草稿已变化，状态改为“结果已过期，需重新确认”，不得自动附加。

## HTML 安全配置

- 默认 CSP：无网络、无 frame、无 object、无 form action、无 base URI。
- iframe 仅 `allow-scripts`，不启用 `allow-same-origin`。
- 禁止 `fetch`、XHR、WebSocket、EventSource、浏览器存储、cookie、父页面和顶层窗口访问。
- HTML、CSS、JS 分字段限长；先拒绝危险输出，再做客户端二次清洗。
- GeoGebra 导出属于独立的 `geogebra-pinned` 运行配置，只对白名单 `*.geogebra.org` 放行所需资源；不得因此给普通 AI HTML 开放网络。

## 实施阶段

- Phase 1（当前）：有界单次生成、安全校验、沙箱预览、用户确认后附加，本地与 Cloudflare API 同构。
- Phase 2：生成任务持久化并接入活动中心；记录模型回退、耗时和错误；支持取消与幂等重试。
- Phase 3：最多两轮的验证错误修复；只读笔记搜索工具；草稿 revision 保护。
- Phase 4：经用户逐项授权的扩展工具与可管理记忆。任何写工具仍保留明确确认门。

设计方向参考 Cloudflare Agents 的会话/状态模型、工具接口与 Workflows 的可恢复步骤，但不要求为首版引入一个无限工具循环：

- https://developers.cloudflare.com/agents/api-reference/agents-api/
- https://developers.cloudflare.com/agents/api-reference/store-and-sync-state/
- https://developers.cloudflare.com/agents/api-reference/using-ai-models/
- https://developers.cloudflare.com/workflows/
