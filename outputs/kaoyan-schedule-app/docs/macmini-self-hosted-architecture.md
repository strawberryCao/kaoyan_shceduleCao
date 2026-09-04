# Mac mini 一致本地版：目标架构与迁移合同

状态：第一阶段设计冻结稿

目标分支：`deploy/macmini-full-migration`

产品基线：`e315be9982e99ef4b136739ba4734c607bc345ed`

适用设备：更新到最新 macOS 的 Apple 芯片 Mac mini、Windows Electron、手机与 iPad 浏览器

本文档是后续实现、迁移和验收的硬约束。第一阶段只冻结边界并验证现有基线，不部署服务、不修改生产数据、不关闭现有 Cloudflare 服务。

## 1. 已确认的产品决定

1. Mac mini 是唯一正式服务端、唯一权威数据源、唯一 AI 执行节点。
2. Windows 继续保留 Electron 速记小窗口。保存时先完整落到 Windows 本地副本，再通过 Tailscale 与 Mac 同步。
3. 手机和 iPad 默认通过 Tailscale 私有 HTTPS 直接访问 Mac，不以 Cloudflare 为默认路径。
4. 移动端不保存完整业务库；仅允许保存“尚未收到 Mac 确认”的端到端加密临时发件箱，确认后立即删除。
5. Cloudflare 公网地址继续保留，作为额外的备用/异地入口；它最终只把请求转发到同一台 Mac，不保存权威业务数据、不运行 AI。
6. 所有设备发起的 AI 任务统一由 Mac 排队和执行。Windows 旧密钥可以留在原机器，但新版业务运行时不得读取或使用它们。
7. Mac 不迁移 Windows 桌面壁纸能力；除此之外，产品功能、记录、附件、人工决定和交互能力都必须迁移。
8. FileVault 保持开启。核心服务在系统盘解锁并启动 macOS 后，无需进入桌面会话即可运行；不得宣称加密磁盘在完全断电后能够无条件无人值守启动。

## 2. 最终拓扑

```text
Mac 本机浏览器 / 可选管理界面
                 │ localhost
                 ▼
        ┌─────────────────────┐
        │ Mac 统一应用网关     │
        │ 身份、会话、限流、API │
        └──────────┬──────────┘
                   │
        ┌──────────▼──────────┐
        │ Mac 核心服务         │
        │ 数据 / 附件 / 同步 / AI│
        └──────────┬──────────┘
                   │
        ┌──────────▼──────────┐
        │ 权威库 + 资源库 + 备份 │
        └─────────────────────┘

Windows Electron ── Tailscale HTTPS ──┐
  └─ 完整本地副本 + 待同步日志          ├─> Mac 统一应用网关
手机 / iPad ───── Tailscale HTTPS ─────┤
  └─ 仅加密临时发件箱                   │
Cloudflare 公网入口 ─ Cloudflare Tunnel ┘
  └─ 备用入口，不承载正式数据或 AI
```

Tailscale Serve 只把 tailnet 内的 HTTPS 请求反向代理到 Mac 的 loopback 服务，并继续受 tailnet 访问控制约束。Cloudflare Tunnel 由 Mac 主动建立出站连接，不需要为业务服务开放公网入站端口。原始 Web、数据和 AI 端口只监听 `127.0.0.1`。

## 3. 各端职责

| 节点 | 正式职责 | 本地持久化 | 离线行为 |
| --- | --- | --- | --- |
| Mac mini | 权威数据、附件、同步协调、AI、审计、备份 | 完整权威库和全部附件 | 局域应用可继续运行；恢复网络后同步外部请求 |
| Windows Electron | 快速捕获、完整可用副本、后台同步 | 完整记录、附件、变更日志和待上传任务 | 继续新增、编辑、检索和查看资料；AI 状态显示“等待 Mac” |
| 手机 / iPad | 浏览、编辑、拍题、上传、复习 | 不保存完整业务库；只保存未确认上传的加密密文 | 可安全排队新捕获；既有资料不可承诺完整离线浏览 |
| Cloudflare | 公网域名、边缘防护、可选身份校验、Tunnel 入口 | 仅非业务静态缓存和必要安全日志 | Cloudflare 故障不影响 Tailscale 主路径 |

“Mac 唯一权威”不等于“Windows 没有数据”。Windows 是完整本地副本，但不能绕过同步协议直接成为其他设备的服务端；发生分歧时按字段、操作和人工优先级收敛到 Mac。

## 4. Mac 数据模型与目录

后续实现统一使用一个可迁移的数据根目录，不再把 Desktop 绝对路径当作服务端协议的一部分。推荐布局：

```text
/Library/Application Support/KaoyanStudyCenter/
├── config/                 # 非密钥配置、版本化 schema
├── secrets/                # 服务密钥；专用账号可读，权限 0600
├── data/
│   ├── study.sqlite        # 权威结构化库，WAL + 外键 + 迁移版本
│   ├── assets/sha256/      # 按内容哈希保存的不可变附件
│   ├── exports/            # 用户显式生成的导出，不作为权威库
│   └── migrations/         # 已应用迁移回执和守恒报告
├── backups/                # 一致性快照、恢复清单和校验和
├── logs/                   # 结构化运行日志，不记录密钥和正文
└── releases/               # 可回滚的不可变发布版本
```

具体账号名和安装根目录由第二阶段安装器实现时确认，但以下约束不变：

- 业务记录以稳定 UUID / `noteUid` 标识，不以文件名或设备路径标识。
- 附件以 SHA-256 标识；显示名、排序、分类与物理对象分离。
- 数据库保存相对资源引用或稳定 URI，禁止保存 `C:\...`、用户主目录等跨机无效路径。
- `attachments`、`facets`、`sourceType`、`sourceBatchId`、`sourceSplitIndex`、`sourceImageHash`、`userEditedFields`、`studyNotes`、`items`、`cards`、复习历史、画布关系、删除墓碑和未来未知字段必须保真。
- 删除使用可恢复墓碑；附件垃圾回收只能在引用检查、保留期和备份验证后进行。
- SQLite 是结构化权威库；附件不塞入数据库。对现有 JSON/V2 格式提供一个兼容导入/导出层，而不是长期双重权威。

## 5. 同步协议

### 5.1 操作信封

Windows 和移动端的每次写入都生成稳定操作：

```text
operationId + deviceId + entityId + baseRevision + clientSequence
+ createdAt + payloadHash + assetHashes + mutation + schemaVersion
```

Mac 在同一事务内完成去重、校验、合并、写入事件记录和生成回执。重复发送同一 `operationId` 只返回原回执，不得重复创建记录、附件或 AI 任务。

### 5.2 Windows 完整副本

1. Electron 首先把正文、附件和操作日志原子写入 Windows 本地。
2. UI 立即显示“已保存到本机”，不得提前显示“已同步”。
3. 后台同步器通过 Tailscale 上传操作和缺失附件；Mac 回执后推进本地同步游标。
4. Windows 按 Mac 事件游标拉取其他设备的变更，更新完整本地副本。
5. 网络中断、进程退出、电脑重启或重复发送都不能造成重复数据。
6. Windows 本地保存成功后即可继续编辑；需要 AI 的工作保持可见的“等待 Mac / 执行中 / 失败可重试”状态。

### 5.3 手机和 iPad 临时发件箱

移动端不会下载或持久化完整数据镜像。拍照或编辑提交时：

1. 使用 Mac 发布的上传公钥，在写入 IndexedDB 前加密正文、元数据和附件。
2. 本地只保存不可直接读取的密文、操作 ID、重试信息和最小展示状态。
3. Mac 完整校验并持久化后返回签名回执；浏览器收到回执立即删除对应密文。
4. 未确认项支持弱网、切后台、锁屏和浏览器重启后的幂等续传。
5. 设置明确的容量上限、告警和过期处理；过期不得静默删除，必须先提示导出或继续重试。
6. 查询到的正式资料只保存在内存和受控浏览器缓存中，退出登录时清理；Service Worker 不缓存业务 API 响应。

### 5.4 冲突与优先级

- 合并单位是字段和有序集合，不是整条记录“最后写入者覆盖”。
- 人工标题、备注、分类、错因、标签、附件排序、删除与恢复决定高于 AI 生成字段。
- 彼此独立的字段编辑自动合并；同一人工字段的并发编辑进入可理解、可撤销的冲突界面。
- 删除墓碑不会被旧副本复活；明确恢复会创建新的审计操作。
- 时间戳仅用于展示和辅助判断，不能单独决定覆盖关系；顺序以设备序列、Mac 修订和操作因果关系为准。
- 未来 schema 字段默认透传保留，旧客户端不得把未知字段归零。

## 6. AI 执行边界

所有 AI 能力——资料命名、题目切分、内容分析、画布整理、HTML 生成、语义搜索——都成为 Mac 上的显式任务。

1. 业务记录和附件先持久化，再创建 AI 任务；AI 失败不能回滚用户保存。
2. `aiJobId` 由 `operationId + taskType + inputRevision + configurationHash` 派生或唯一约束，防止 Windows、移动端和重试重复付费。
3. 同一任务只有 Mac worker 获得执行租约。客户端只能提交、观察、取消或显式重试。
4. 自动 AI 限于新保存/新追加的明确工作流；启动时不扫描历史资料，不批量重命名。
5. 带附件速记保存后命名标题和全部资料；追加时结合正文及全部新旧附件重新理解整组。用户手填标题永久优先，保留手动“AI 命名资料 / AI 重命名”。
6. AI 结果先通过 schema、科目白名单、标题策略和人工字段保护，再与对应输入修订原子合并；过期结果直接失效。
7. UI 只在能解释、能撤销且确实省操作时出现 AI。不得用聊天入口或“AI 光效”挤占学习主线。

## 7. 身份、网络与密钥

### 7.1 网络入口

- 主入口：Tailscale Serve 提供 tailnet 内 HTTPS，Windows、手机和 iPad默认使用它。
- 公网入口：保留现有域名，通过 Cloudflare Tunnel 指向 Mac 的独立 loopback ingress。
- 本机入口：Mac 管理和诊断只走 localhost 或显式授权的管理会话。
- 数据库、附件目录、AI worker、内部事件流和原始 Node 端口不直接暴露给 LAN、tailnet 或公网。

不能把“已经进入 Tailscale”当成全部应用授权。统一网关仍执行设备注册、会话过期、CSRF/Origin 校验、写入限流和操作级权限；Cloudflare 与 Tailscale 身份信息只能由各自的本地 ingress 验证后转换为内部可信身份，客户端自带同名 Header 必须被丢弃。

### 7.2 交互式配置脚本合同

后续提供一个 Mac 安装入口和一个可重复运行的配置入口。用户只需拉取代码并运行脚本，脚本必须：

- 检查 Apple 芯片、macOS、Node、Tailscale、`cloudflared`、磁盘空间和端口，不满足时给出可执行修复说明。
- 逐项询问实际启用的 AI 提供商、模型、API Base URL、API Key，以及 Cloudflare 域名/Tunnel 等配置；密钥输入不回显。
- 支持“跳过未使用提供商”，不要求填写与当前功能无关的密钥。
- 写入前进行格式检查和一次可取消的连通性验证；验证失败不覆盖旧配置。
- 使用临时文件 + 原子替换，设置最小文件权限；日志只显示掩码、提供商和校验结果。
- 支持 `配置 / 查看掩码状态 / 测试 / 轮换 / 删除 / 备份非密钥配置`，重复执行不破坏现有数据。
- 生成 `.env.example` 或配置模板，但真实密钥永不写入 Git、前端包、浏览器存储、Windows 同步数据或 Cloudflare Worker 变量。
- 完成后运行健康检查，明确报告 Tailscale 主入口、Cloudflare 备用入口、数据版本、备份状态和 AI provider 状态。

首选将服务密钥放入仅专用服务账号可读的 secrets 目录；若 macOS Keychain 能在无 GUI 登录的 LaunchDaemon 上下文中可靠使用，再在实现阶段以 Keychain 替代文件。不能为了使用 Keychain 而破坏“无需桌面登录运行”。

## 8. macOS 生命周期与可恢复性

- 核心数据服务、统一网关、同步协调器和 AI worker 使用系统级 `LaunchDaemon`，在系统盘解锁、macOS 启动后自动运行。
- 可选菜单栏、通知或管理 UI 使用用户级 `LaunchAgent`，它不是核心服务依赖。
- 不启用自动登录，不降低 Apple 芯片的完整安全策略，不关闭 FileVault。
- FileVault 启用时，系统盘在有效凭据或恢复方式解锁前不可访问。最新 Apple 芯片系统可能支持在满足系统版本、远程登录和网络条件时远程解锁，但第一版验收仍把“冷启动后确认磁盘已解锁”列为运维步骤。
- 建议接入 UPS、启用来电自启并监控 Tailscale/Tunnel/数据库健康；这些只提高可用性，不绕过 FileVault。
- 发布采用不可变版本目录和原子 `current` 指针；升级前做数据库快照，失败可回退程序与兼容 schema。

## 9. 迁移与切换顺序

### 阶段 A：只读盘点

- 枚举 Windows 笔记目录、V2 数据、画布、学习记录、本地浏览器存储、私有 GitHub/Cloudflare 正式数据和附件。
- 生成记录数、附件数、字节数、哈希、孤儿项、重复项、未知字段和绝对路径报告。
- 不移动、不重命名、不删除现有资料。

### 阶段 B：Mac 影子导入

- 将各来源转换到统一 schema 和内容寻址资源库。
- 按 `noteUid`、稳定实体 ID、源批次和附件哈希去重；人工决定优先。
- 输出逐字段守恒报告、冲突清单和可逆映射；Mac 此时不接受正式写入。

### 阶段 C：双端验证

- 用非生产副本验证 Mac 本机、Windows Electron、Tailscale 手机/iPad 和 Cloudflare 备用入口。
- 验证完整功能矩阵、弱网/重启、重复提交、附件大文件、AI 幂等和恢复演练。
- Windows 完成一次全量下行并与 Mac 按 ID/哈希核对。

### 阶段 D：短暂停写与增量切换

- 明确显示维护状态，短暂停止旧入口写入。
- 导入盘点水位线后的增量，重跑守恒和哈希核对。
- Mac 成为唯一权威写入点，Windows 切换到新同步协议；移动端默认地址切为 Tailscale。

### 阶段 E：观察与退役旧权威

- Cloudflare 公网入口改为 Tunnel 到 Mac，但保留旧数据只读快照和一键回滚窗口。
- 达到稳定观察期、备份恢复和跨端核对门槛后，才停止旧 GitHub/Worker 写入路径。
- 旧数据至少保留一个明确版本周期；任何删除另行取得用户许可。

## 10. 备份、监控与性能底线

- 每日自动一致性快照，附件按哈希校验；至少保留 Mac 本机快照、独立介质/Time Machine 和一个加密异地副本。
- 定期自动校验备份，但按计划进行真实恢复演练；“备份任务成功”不能替代“能恢复”。
- 健康页覆盖数据库迁移、可写性、磁盘空间、队列积压、最后一次同步、AI provider、Tailscale 和 Tunnel；不得泄露正文、路径或密钥。
- 前端长列表分段/虚拟化，图片懒加载；首屏不等待 AI。交互反馈目标沿用 120–220ms 动画与 `prefers-reduced-motion`。
- 当前正式构建存在大资源块警告。后续性能阶段需要拆分 PDF/HEIC 等低频预览能力，并用真实 Mac、Windows、iPhone 和 iPad 指标验收，不能只依赖构建成功。

## 11. 阶段门槛

1. 第一阶段：基线测试通过；本架构和功能矩阵冻结；不部署、不改生产数据。
2. 第二阶段：跨平台核心服务、数据根、配置脚本和 macOS 服务骨架；仅用测试数据。
3. 第三阶段：Windows 完整副本与字段级同步，完成断网和恢复测试。
4. 第四阶段：移动端 Tailscale 直连、加密临时发件箱和跨 Safari 生命周期测试。
5. 第五阶段：Cloudflare Tunnel 备用入口、正式迁移 dry-run 和全量验收。
6. 最终切换：只有逐字段守恒、备份恢复、跨端 UX、性能、安全和回滚全部通过，并经用户明确确认后执行。

## 12. 第一阶段明确不做

- 不安装 Mac 服务、不建立 Tunnel、不更改 Tailscale ACL。
- 不填写、搬运或测试真实 API 密钥。
- 不上传、覆盖或删除 Windows、GitHub、Cloudflare 上的正式数据。
- 不关闭现有 Cloudflare 地址或旧同步链路。
- 不实现 macOS 代码、不打包 Electron、不修改现有 UI。

## 13. 平台依据

- [Tailscale Serve 官方说明](https://tailscale.com/docs/features/tailscale-serve)：tailnet 内 HTTPS、ACL 与 loopback 反向代理边界。
- [Cloudflare Tunnel 官方说明](https://developers.cloudflare.com/tunnel/)：由 Mac 主动建立出站 Tunnel，不开放业务入站端口。
- [Apple FileVault 官方部署说明](https://support.apple.com/guide/deployment/intro-to-filevault-dep82064ec40/web)：Apple 芯片启动盘解锁要求，以及受系统版本和网络条件约束的远程解锁能力。
