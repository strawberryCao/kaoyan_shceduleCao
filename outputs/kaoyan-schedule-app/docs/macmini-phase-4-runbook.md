# Mac mini 第四阶段：移动访问、统一 AI 与冲突处理手册

状态：功能实现稿；已在 Windows 开发机、临时数据和真实浏览器中验证，尚未在 Apple 芯片 Mac、iPhone 与 iPad 实机上启用

目标分支：`deploy/macmini-full-migration`

本阶段补齐正式迁移前最关键的三个产品闭环：手机/iPad 经 Tailscale 私有 HTTPS 登录 Mac、所有设备的 AI 工作由 Mac 唯一执行、同字段并发修改由用户看得懂地选择和撤销。Cloudflare 备用入口和正式数据迁移仍属于第五阶段，本阶段没有改动它们。

## 1. 用户最终会得到什么

- Mac 保存完整正式数据、附件、同步状态和 AI 任务，是唯一权威节点。
- Windows 继续使用原 Electron 速记小窗口，先完整保存在 Windows，再同步到 Mac；新版运行时不在 Windows 发起 AI 请求。
- 手机和 iPad 使用 Tailscale 的 `*.ts.net` HTTPS 地址访问。登录成功后直接读写 Mac，不保留完整业务副本。
- 移动端网络中断时，尚未送达的文字、元数据和附件以 AES-GCM 密文暂存在浏览器；Mac 确认接收后立即清除对应密文。
- 活动中心集中显示 Mac AI 进度、模型请求次数、明确重试按钮，以及 Mac 内容和另一设备内容的冲突对比。
- 非 Electron 环境不显示也不能直达 Windows 壁纸页；手机端不暴露 AI 密钥页和桌面控制台。

## 2. 第一次在 Mac 上执行

先拉取并检查专用分支：

```bash
git switch deploy/macmini-full-migration
npm ci
npm run macmini:setup
```

最后一条命令只展示计划，不安装服务、不填写密钥、不配置 Tailscale，也不迁移数据。确认计划无误后才执行：

```bash
npm run macmini:setup -- install
```

安装流程会依次：

1. 运行离线测试、类型检查、正式构建和临时目录冒烟。
2. 安装只监听 `127.0.0.1` 的 Mac 核心服务与 Web 网关。
3. 通过隐藏输入配置实际使用的 AI provider；密钥不会出现在命令参数、Git 或浏览器中。
4. 通过隐藏输入设置手机/iPad 登录用户名和密码，并使旧会话失效。
5. 在网关 readiness 成功后，将 Tailscale Serve 私有 HTTPS 指向 Mac 回环网关。
6. 运行 doctor，检查目录权限、登录配置、AI 配置和服务状态。

脚本使用 Tailscale Serve，而不是 Funnel：访问只面向 tailnet 内设备。当前实现所用命令等价于：

```bash
tailscale serve --bg --https=443 http://127.0.0.1:5173
```

安装后使用下面两条命令查看实际 `*.ts.net` 地址和整体状态：

```bash
npm run macmini:tailscale -- status
npm run macmini:doctor
```

这个安装流程不会建立 Cloudflare Tunnel，也不会上传、删除或切换任何正式数据。

## 3. 分开配置和轮换

需要单独更改移动登录时：

```bash
# 查看状态，不显示密码或会话签名密钥
npm run macmini:mobile-access -- status

# 配置或轮换；密码输入不回显，保存后旧会话全部失效
npm run macmini:mobile-access -- configure

# 停用移动登录；不会删除学习数据
npm run macmini:mobile-access -- remove
```

需要先看 Tailscale 会做什么，再决定是否应用：

```bash
npm run macmini:tailscale
npm run macmini:tailscale -- apply
npm run macmini:tailscale -- status
```

`apply` 只允许在 macOS 执行，且必须先配置移动登录、确认本机网关已 ready。它不会开启公网 Funnel，也不会修改 Cloudflare。

## 4. 移动端数据与会话边界

远程 HTTPS 页面使用 Mac 签发的 `HttpOnly + Secure + SameSite=Strict` 会话 Cookie。登录失败会逐步限速；轮换密码会更换配置代次，使全部旧 Cookie 失效。所有远程业务 API 都需要会话，同步设备使用的 Bearer 令牌不能从普通浏览器调用。

移动端只允许以下持久化内容：

- 未送达 Mac 的捕获密文、随机 IV、操作 ID、重试次数和最小状态。
- 浏览器生成且不可导出的 WebCrypto AES 密钥，用于浏览器重启后的续传。

完整学习快照、计划、画布草稿、活动任务视图和待提交业务替换只保存在当前页面内存。升级后启动会清理旧版本遗留的明文业务缓存，但保留新的加密发件箱。成功收到 Mac 回执后，密文内容会被清空。

这里的目标是“浏览器磁盘上不出现可直接阅读的临时正文和图片”，不是宣称浏览器已成为可信硬件。若同源页面本身被恶意脚本控制，脚本仍可能请求 WebCrypto 解密；因此 CSP、依赖审计、会话保护和 Mac 入口隔离仍是第五阶段安全验收的一部分。

手机端可使用“安全退出”。退出会清除服务端会话 Cookie，但不会删除尚未送达 Mac 的加密速记；重新登录后仍可继续发送。

## 5. Safari、弱网与重复提交

- 单次捕获先加密写入 IndexedDB，再开始网络传输；页面关闭不影响已落盘密文。
- `online`、`pageshow` 和重新回到前台都会唤醒可安全重放的上传。
- 操作 ID 保持不变，超时后重复发送不会在 Mac 重复创建记录。
- Mac 确认保存后才从移动端清除密文；上传失败会显示可恢复状态。
- 涉及付费 AI 的步骤不会因为页面恢复而自动重放。多题原图和任务状态会保留，是否重新调用由 Mac 队列状态和用户明确操作决定。

## 6. Mac AI 的付费安全语义

AI 队列使用 SQLite WAL 持久化任务、幂等键、输入修订、provider 尝试和模型请求次数。业务内容先保存，随后才排 AI，AI 失败不会撤销笔记。

| 中断位置 | 重启后的行为 | 原因 |
| --- | --- | --- |
| 尚未开始 provider 请求 | 自动回到等待队列 | 确认没有产生付费请求 |
| provider 请求已发出但未确认结果 | 标记“结果不确定” | 防止重启后重复付费 |
| provider 明确返回失败 | 标记“等待你重试” | 由用户决定是否再次调用 |
| 完成或跳过 | 保留结果和回执 | 同一幂等任务不重复执行 |

活动中心只在任务确实需要决策时显示“确认重试”，并同时展示已经记录的模型请求次数。启动服务不会扫描历史笔记，也不会批量触发 AI。

## 7. 数据冲突体验

只有两个设备并发修改同一个人工字段时才出现冲突卡片。卡片并排或在窄屏上下展示：

- “Mac 当前内容 / 保留这一版”；
- “另一设备内容 / 采用这一版”。

系统不会静默覆盖任何一版。选择会形成新的权威修订并保留审计记录；只要之后没有更新，可以立即撤销。如果已有更晚修改，撤销会被拒绝并提示刷新，避免撤销动作覆盖新内容。不同字段的独立修改仍自动合并，不打扰用户。

## 8. 本阶段验证结果

2026-09-07 开发机结果：

- 420/420 离线测试通过。
- TypeScript `--noEmit` 通过。
- 正式构建通过；PDF worker 与 HEIC 低频资源仍有大 chunk 警告。
- 8/8 Playwright 浏览器流程通过。
- 浏览器验证了单题与整页多题在断网入队时，IndexedDB 不出现可直接读取的正文、元数据或图片，AES key 不可导出；恢复网络并触发 Safari 风格生命周期事件后，Mac 收到内容且本地密文被清除。
- 真实 note-server 重启验证了 AI 任务、provider 尝试和显式重试状态不会丢失或自动重复付费。
- 冲突选择、撤销保护、移动会话轮换、同源退出、Tailscale 只读计划和 apply 前置检查均有自动测试。

## 9. 仍然不能宣称完成的项目

1. 尚未在真实 Apple 芯片 Mac 上安装 LaunchDaemon 或执行 Tailscale Serve。
2. 尚未在真实 iPhone/iPad Safari 上验证相机、锁屏、强制结束 Safari、超大附件和长时间弱网。
3. 尚未只读盘点并 dry-run 导入 Windows、GitHub、Cloudflare 的正式数据；Mac 目前不能切为正式权威。
4. Cloudflare Tunnel 备用入口尚未接到 Mac，现有 Cloudflare 能力没有被关闭或替换。
5. 备份、逐字段守恒报告、真实恢复演练、跨端性能基线和最终回滚演练尚未完成。

这些工作统一进入第五阶段。任何正式数据导入、旧链路停写、Cloudflare 切换或不可逆清理，都必须在报告完成后再次取得用户明确批准。
