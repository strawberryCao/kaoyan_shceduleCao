# Mac mini 第二阶段：核心服务安装与运行手册

状态：第二阶段实现稿；已通过 Windows 开发机上的自动化验证，等待 Apple 芯片 Mac 实机验收

适用分支：`deploy/macmini-full-migration`

本阶段交付的是 Mac 上的单机核心服务基础层：统一运行目录、回环监听、AI 密钥配置、进程监督、健康检查和 `LaunchDaemon`。它不会迁移正式数据，也不会创建 Tailscale Serve 或 Cloudflare Tunnel；这两个远程入口只有在应用层设备认证完成后才会接入。

## 1. 本阶段已经实现的能力

| 组件 | 职责 | 安全/数据边界 |
| --- | --- | --- |
| `runtime-paths.cjs` | 解析并创建统一运行目录 | 拒绝磁盘根、用户主目录、越界子目录和运行目录内的符号链接；目录默认 `0700`，JSON 原子写入并 `fsync` |
| `macmini-runtime.cjs` | 监督笔记服务与 Web 网关 | 两个子进程共享同一数据根；Web 仅监听 `127.0.0.1`；进程锁防止重复实例；托管模式显式使用 `077` umask |
| `web-server.cjs` | 静态资源、受限 API 代理、健康检查 | 默认从 `0.0.0.0` 收紧为 `127.0.0.1`；提供 `/healthz` 和 `/readyz` |
| `configure-macmini.cjs` | 配置、轮换、删除和测试 AI provider | 密钥不回显、不接受命令行密钥；真实连通性测试使用临时 `0600` 文件，失败不覆盖旧配置 |
| `install-macmini-service.cjs` | 生成和管理系统级服务 | 实际安装只允许 macOS/arm64/root；服务必须以非 root 用户运行；plist 安装前通过 `plutil -lint`，激活失败尽力恢复旧 plist |
| `setup-macmini.cjs` | 一次性安装编排 | 默认只输出计划；显式 `install` 才测试、构建、安装服务、交互配置并检查 readiness |
| `smoke-macmini-runtime.cjs` | 测试数据端到端冒烟 | 随机端口和临时数据根启动真实双进程，验证 readiness 与学习数据 API，退出后清理 |

Windows 旧运行方式保持兼容：没有显式启用托管布局时，仍使用原来的 Desktop 数据位置。Mac 托管服务会清除继承到进程环境中的旧 Qwen、Gemini、Kimi、Moonshot 和 DeepSeek 变量，只从 Mac 的受限配置文件读取 AI 密钥；旧 GitHub 综合复习自动同步也被禁用，避免第二阶段在没有迁移水位线时误写正式数据。

## 2. 当前数据目录

系统服务默认使用：

```text
/Library/Application Support/KaoyanStudyCenter/
├── config/
│   ├── runtime-layout.json       # 运行目录清单
│   └── ai-provider-status.json   # 不含 apiKey 的脱敏状态
├── secrets/
│   └── ai-providers.json         # 真实 AI 配置，0600
├── data/
│   ├── notes/                    # 第二阶段现有笔记/sidecar 文件权威位置
│   ├── assistant/                # 学习、画布、回执和任务状态
│   └── assets/sha256/            # 内容寻址附件库预留位置
├── backups/                      # 后续一致性备份
├── logs/                         # LaunchDaemon stdout/stderr
├── run/                          # 进程锁
└── releases/                     # 后续不可变发布目录
```

重要：第二阶段没有假装完成 SQLite 权威库或正式附件重排。当前服务只是把既有文件/JSON 行为放进统一且可迁移的数据根；SQLite、内容寻址全量转换、同步事件库和守恒迁移器属于后续阶段。不得把空的预留目录当成迁移完成。

## 3. 在 Mac 上首次安装

前提：Apple 芯片 Mac mini、最新稳定 macOS、FileVault 保持开启、Tailscale 已安装、Node.js 22 或更高版本。请以日常使用的普通账户执行，不要先运行 `sudo -s`。

```bash
git switch deploy/macmini-full-migration
npm ci
npm run macmini:setup
```

第三条命令只显示计划，不写系统服务、不迁移数据、不调用 AI。确认项目路径和服务用户正确后执行：

```bash
npm run macmini:setup -- install
```

安装器依次执行离线测试、TypeScript 检查、正式构建和临时数据根双进程冒烟；只有写入 `/Library/LaunchDaemons` 时才请求 `sudo`。随后配置向导逐个询问是否启用 Qwen、Gemini、Kimi、DeepSeek，并隐藏 API Key 输入。没有使用的 provider 直接跳过。

如果选择最小真实 API 验证，可能产生少量费用。候选密钥只有在选中的 provider 全部验证成功后才替换正式配置；任一失败都会删除临时文件并保留旧配置。跳过真实验证时，仍会执行密钥、HTTPS Base URL 和模型 ID 的本地格式校验。

克隆目录当前就是服务的 `WorkingDirectory`，安装完成后不要随意移动或删除。安装器在可用时优先记录 `/opt/homebrew/bin/node` 或 `/usr/local/bin/node` 这类稳定入口，避免 Homebrew 小版本目录变化后 plist 失效；特殊环境可在安装前设置 `KAOYAN_NODE_PATH`。不可变 release 切换在后续发布阶段实现。

## 4. 日常检查和密钥操作

```bash
# 服务是否已安装、是否被 launchd 加载
npm run macmini:service:status

# 运行目录、构建、Node、Tailscale、Cloudflare 和 AI 配置检查
npm run macmini:doctor

# 只显示掩码状态，不输出完整密钥
npm run macmini:configure -- status

# 轮换一个 provider；输入仍然隐藏
npm run macmini:configure -- rotate --provider=qwen

# 用户明确授权后才发送最小真实请求
npm run macmini:configure -- test --provider=qwen --live

# 删除单个 provider；默认再次确认
npm run macmini:configure -- remove --provider=qwen
```

AI 路由按配置文件时间戳重新加载，正常轮换不需要重启服务。脚本不会接受 `--api-key=...`，避免密钥进入 shell history、进程列表或诊断日志。

本机探针：

```bash
curl -fsS http://127.0.0.1:5173/healthz
curl -fsS http://127.0.0.1:5173/readyz
```

`healthz` 只表示 Web 网关进程存活；`readyz` 还要求内部笔记服务健康。远程入口后续只应转发到 Web 网关，不得直连 5174 笔记服务。

## 5. 停用与回滚

查看实际目标后再停用：

```bash
npm run macmini:service:plan
sudo node scripts/install-macmini-service.cjs uninstall
```

卸载只执行 `launchctl bootout` 并删除 `com.local.kaoyan.study-center.plist`，不会删除 `/Library/Application Support/KaoyanStudyCenter`、密钥、日志或数据。恢复服务可重新执行安装命令。任何正式数据删除都不属于这个脚本的权限范围。

诊断日志位于：

```text
/Library/Application Support/KaoyanStudyCenter/logs/runtime.stdout.log
/Library/Application Support/KaoyanStudyCenter/logs/runtime.stderr.log
```

日志设计不输出 API Key；遇到问题时仍应先检查日志中是否包含用户正文或路径，再决定是否对外分享。

## 6. 第二阶段验收证据

开发机自动化覆盖：

- 运行目录解析、路径越界、符号链接、目录权限和原子写入。
- provider 格式校验、掩码状态、未知配置保留、轮换、删除和失败回滚。
- LaunchDaemon 非 root、回环绑定、私有 umask、XML 转义和端口边界。
- 进程锁、重复实例、旧 AI 环境变量清理和损坏配置诊断。
- Web liveness/readiness、完整 Playwright 捕获流程和真实双进程临时目录冒烟。
- Windows Explorer 与 macOS Finder 的资料定位均使用参数数组启动系统程序，不经过 shell。

在 Apple 芯片 Mac 上仍必须完成以下实机门槛，不能由 Windows 模拟结果替代：

1. `plutil -lint`、`launchctl bootstrap`、开机自启和异常退出拉起。
2. FileVault 解锁后、不登录图形桌面时的核心服务恢复。
3. 系统服务用户对数据目录可写，其他本地普通账户不能读取 secrets。
4. 空密钥、正确密钥、错误密钥和轮换失败时的旧配置保留。
5. 重启前后的进程锁、日志、health/readiness 和现有测试数据一致。

## 7. 本阶段明确未做

- 不读取、复制、上传、覆盖或删除 Windows、GitHub、Cloudflare 上的正式数据。
- 不把 Mac 切成正式权威源，不停用任何旧同步或 Cloudflare 能力。
- 不配置 Tailscale Serve、ACL、设备注册、Cloudflare Tunnel 或公网域名。
- 不实现 Windows 完整副本同步、移动端加密发件箱、SQLite 事件库、正式备份或恢复。
- 不迁移 Mac 桌面壁纸；该能力已按用户决定永久排除。

只有后续完成应用层设备认证后，Tailscale 才能成为 Windows、手机和 iPad 的默认 HTTPS 入口；Cloudflare 只作为指向同一 Mac 的备用入口。
