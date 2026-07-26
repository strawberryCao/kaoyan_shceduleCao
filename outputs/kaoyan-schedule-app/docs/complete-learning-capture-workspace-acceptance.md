# 课表学习记录、资料工作区与移动端拍题综合验收

此分支是唯一综合交付分支。任何单项施工分支均不得独立合并或部署。

## 1. 无损同步

- `attachments`、`facets`、`sourceType`、`sourceBatchId`、`sourceSplitIndex`、`sourceImageHash`、`userEditedFields`、`studyNotes`、`items`、`cards` 全部保真。
- 公网与本机冲突采用字段级合并，不允许整条记录二选一覆盖。
- 删除墓碑、人工决策、人工标题和人工分类优先级明确且可测试。
- 迁移前后生成逐字段守恒报告。

## 2. 速记与统一记录模型

- 小 App 明确显示“速记”入口。
- 文字、图片、PDF、Word、HTML 和多附件组合使用同一记录模型。
- 快速记录不得落入不可见默认桶；学习中心存在明确“速记”视图。
- `facets` 参与分类判定，不能只依赖 tags/noteType。

## 3. 资料工作区

- 多附件缩略图与类型标识。
- 图片预览，PDF/HTML 内嵌或安全打开，Word 下载/打开。
- 附件重排、删除、补充、改名和备注。
- 记录导出 PDF 与 DOCX，保留标题、科目、备注、附件顺序和来源信息。

## 4. 移动端即时保存

- 单题、非 AI 图片和多题原图均先写入 IndexedDB，再更新 UI。
- 保存确认仅表示“本机安全落队列”，不得谎称云端已完成。
- 入队后立即返回，不等待 AI、GitHub 或 Cloudflare。
- 弱网、切后台、锁屏、离线、Safari 被杀后重开可恢复。
- noteUid 固定且幂等，无重复记录、无重复附件。

## 5. AI 多题后台处理

- 不强制逐题确认；人工调整仅作为可选补救。
- AI 使用压缩轻量识别图，最终裁剪使用原图。
- 同一题号/例号的题干、分析、解答、答案和续接公式合并为一题。
- 不同题号/例号绝不合并。
- 质量门包括面积、宽高比、页眉页脚、置信度、完整题干、选项、配图、重叠和碎片合并。
- 最终失败保留整页原图并进入待确认，不丢图。

## 6. 公网与局域网统一 AI 约束

必须共享同一实现，而不仅是提示词：

- `normalizeSubject`
- `normalizeChineseTitle`
- `validateTitle`
- `applyNamingRule`
- `protectUserFields`
- `buildKnowledgePath`

要求：

- 标题以中文为主，英文解释、拒答、模型说明不得落库。
- 科目只能来自统一白名单。
- 两次修复仍不合格时使用确定性中文占位标题并标记待确认。
- 人工编辑标题、备注、分类、错因和标签不得被后台 AI 覆盖。

## 7. 学习中心后续操作

- 图片记录提供“AI 重命名”。
- 提供“重新分析”、处理状态、失败原因和重试。
- 批量记录显示批次与题序，可定位原图。
- 所有后台任务均可观察，不以无限旋转动画代替状态。

## 8. 回流与审计

每批至少记录：

- device/browser
- batchId
- original image hash
- configurationHash/workflowHash
- candidate boxes
- rejected reasons
- final crops
- noteUids
- retries
- raw naming output
- title validation result
- final title/subject
- cloud-to-local flowback result

## 9. 总体验收

- iPhone Safari、iPad Safari、Android Chrome。
- 1/2/4/8/12 题页面。
- 印刷、手写、倾斜、阴影、公式、表格、配图和选择题。
- 连续 30 批真实图片无丢失、无重复、无卡死。
- 断网、切后台、锁屏、杀进程后重开恢复。
- 标题中文校验通过率 100%，科目白名单通过率 100%。
- 同图同备注在公网与局域网遵循同一约束。
- 全量 Node 测试、正式构建、Cloudflare Worker dry-run 全部通过。

## 10. 发布约束

- 未经用户明确许可，不合并到 `fix/learning-detail-title-latex`。
- 未经用户明确许可，不部署 Cloudflare，不写生产数据仓库。
