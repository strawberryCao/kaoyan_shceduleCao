# Mac mini 第五阶段：迁移预检、双入口、备份与体验收口手册

状态：Mac 基础服务已在真实 Mac mini 安装并通过 doctor；Windows 数据已完成真实规模的只读导出、哈希验证和隔离权威库灌入演练，正式数据切换及 Windows 同步配对尚未执行

目标分支：`deploy/macmini-full-migration`

本阶段把“能开发”推进到“可上机验收”：Tailscale 仍是手机和 iPad 的默认入口，Cloudflare Tunnel 是用户明确选择的备用入口；两条路径都只到同一台 Mac。Mac 负责 AI 和最终数据，Windows Electron 保留完整本地副本与速记小窗口，移动端只保留未送达内容的加密发件箱。

本阶段没有读取或迁移正式数据，没有修改 Cloudflare 账户、DNS 或 Access，也没有把 Mac 切成正式权威源。

## 1. 这次新增的成品能力

- 一个安装入口串起核心服务、隐藏式 AI 密钥填写、移动登录、Tailscale、Cloudflare 本地凭据和菜单栏管理器。
- Cloudflare 使用 remotely-managed Tunnel token；token 只写入 Mac 私有文件，并通过 `--token-file` 交给 `cloudflared`，不进入参数、环境变量、日志或浏览器。
- 网关明确识别 Tailscale 主路径和 Cloudflare 备用路径；Tailscale 会话最长 30 天，Cloudflare 会话最长 7 天，不静默切换入口。
- 菜单栏管理器显示 Mac 服务、Tailscale 地址、Cloudflare 地址和最近备份，可打开或复制入口；它只是可选的只读界面，不是核心服务依赖。
- 每日一致性快照覆盖正式数据和非密钥配置；SQLite 先做完整性检查再生成快照，全部文件按 SHA-256 验证，不自动删除旧备份。
- 正式迁移盘点器只读扫描 Windows 笔记、Windows 助手、V2 数据与 Cloudflare 导出，报告稳定 ID、重复附件、人工字段冲突、未知字段、绝对路径和损坏文件。
- iPhone/iPad 使用“温暖学习系统 + 克制空间感”的专用视觉层：暖纸底色、轻量玻璃导航、清晰的今日任务和同步状态；桌面与 Windows 外观不随之改变。

## 2. 在 Mac 上先只看计划

```bash
git switch deploy/macmini-full-migration
npm ci
npm run macmini:setup
npm run macmini:cloudflare
npm run macmini:backup
npm run macmini:migrate
```

这些默认命令只展示计划。正式安装前应确认 Mac 是 Apple 芯片、macOS 已更新、FileVault 已开启、Tailscale 已登录，并为运行目录预留足够空间。默认安装还会配置 Cloudflare 备用入口，因此需要 `cloudflared`、remotely-managed Tunnel、备用域名与 Tunnel token；token 不需要写入任何文件或命令。

确认后运行：

```bash
npm run macmini:setup -- install
```

安装脚本会先确认 `cloudflared` 可用，再运行测试、类型检查、正式构建和临时数据冒烟，然后安装系统级核心服务；随后用不回显输入配置 AI、移动登录和 Cloudflare token，应用 Tailscale Serve，重载核心服务，最后安装登录后出现的菜单栏管理器并运行 doctor。任一入口缺少依赖时会在触碰正式数据前停止并给出错误。

如果目前没有可用于 Published application 的 Cloudflare 域名，可以明确选择仅安装 Tailscale：

```bash
npm run macmini:setup -- --skip-cloudflare
npm run macmini:setup -- install --skip-cloudflare
```

此模式不检查 `cloudflared`、不询问 Tunnel 域名或 token，也不会修改 Cloudflare 本机配置；核心服务、AI、移动登录、Tailscale Serve、备份调度和菜单栏管理器仍会完整安装。Cloudflare 账户中已有的 Tunnel 保持不变，之后可以按 3.2 节单独启用备用入口。

如果曾经运行 Cloudflare 控制台给出的 `service install` 命令，先执行 `sudo cloudflared service uninstall` 删除那套独立的 macOS 后台服务，再在 Tunnel 概览中 Rotate token，使终端历史中的旧 token 失效。该操作不会删除 Cloudflare 账户中的 Tunnel；Tailscale-only 安装也不会重新启动它。

这一步仍然不会迁移正式数据，也不会替用户修改 Cloudflare 账户。

## 3. 两条访问路径

### 3.1 默认：Tailscale 私有 HTTPS

```bash
npm run macmini:tailscale -- status
```

手机、iPad 和 Windows 日常使用这里显示的 `https://...ts.net`。网关仍要求应用登录，不能只依赖“已经加入 tailnet”。

### 3.2 备用：Cloudflare Tunnel

先在 Cloudflare Zero Trust 控制台创建 remotely-managed Tunnel，并把 Published application 的 Service URL 设为：

```text
http://127.0.0.1:5173
```

公开域名必须和本地向导填写的域名完全相同。建议在 Cloudflare Access 再加一层仅本人可访问的策略；应用自身登录仍保留。如果已通过一键安装完成本地配置，只需核对状态；需要单独配置或轮换时运行：

```bash
npm run macmini:cloudflare -- version
npm run macmini:cloudflare -- configure
npm run macmini:service:install
npm run macmini:cloudflare -- status
npm run macmini:doctor
```

`configure` 只保存本机域名与隐藏输入的 token，不创建 Tunnel、不改 DNS。核心监督器发现已启用配置后才启动 `cloudflared`。备用域名只提供普通读写界面，不开放 AI 密钥、管理控制台或桌面专属能力。

需要暂时关闭备用入口时：

```bash
npm run macmini:cloudflare -- disable
npm run macmini:service:install
```

这会保留 token 和 Cloudflare 账户；重新启用需再次运行配置向导。删除本地配置使用 `remove`，也不会删除 Cloudflare 账户中的 Tunnel 或 DNS。

## 4. 正式数据只读盘点

先分别导出或复制四类来源到只读工作目录，不要直接把浏览器正在写入的目录当作迁移来源。将 `scripts/macmini-migration-sources.example.json` 复制到仓库外，填写实际路径；不使用的来源可以从数组中删除。

```bash
npm run macmini:migrate -- dry-run \
  --manifest=/绝对路径/macmini-migration-sources.json \
  --output=/绝对路径/macmini-migration-report.json
```

退出码 `2` 表示报告发现了解析失败、未解析附件或同一稳定 ID 的人工字段冲突，不代表工具改过源数据。盘点器不跟随符号链接，拒绝磁盘根目录、用户主目录和未填写的模板路径，排除 AI、移动登录和 Tunnel 凭据。

进入影子导入前必须人工确认：

1. 所有来源的文件数、字节数和 JSON 解析结果合理。
2. 人工标题、备注、分类、标签、学习记录、附件顺序和删除/恢复决定都有守恒统计。
3. 重复附件按 SHA-256 合并，不按文件名猜测。
4. 同一人工字段冲突进入人工选择；独立字段才自动合并。
5. 绝对 Windows 路径全部变成稳定 ID 或哈希资源引用。

Windows 是本次切换的权威来源时，使用 `docs/windows-migration-bundle.md` 中的两段式工具。Windows 先生成不含密钥的逐字节业务包；Mac 上的 `macmini:migrate:activate -- plan` 只读验证。只有带 `--confirm-windows-authoritative` 的 `sudo ... apply` 才会生成权威 SQLite、同步附件与画布实体、短暂停服并原子交换 `data`。旧 Mac `data` 保留在 `releases/windows-authority-*`，启动或健康检查失败会自动回滚。完成后还必须创建 Windows 设备令牌并执行一次双向同步验收。

## 5. 备份和恢复门槛

核心监督器每小时检查一次；若最近一次成功快照已超过 20 小时，会在 Mac 内置盘生成并校验新快照。也可以手动执行：

```bash
npm run macmini:backup -- create
npm run macmini:backup -- status
npm run macmini:backup -- verify --backup="/Library/Application Support/KaoyanStudyCenter/backups/某个快照"
npm run macmini:backup -- restore-plan --backup="/Library/Application Support/KaoyanStudyCenter/backups/某个快照"
```

`restore-plan` 只输出恢复计划，不写数据。实际恢复必须先停止服务、再做一份当下安全快照，并由用户确认目标快照。API 密钥、移动口令材料和 Cloudflare token 不进入业务快照，需要单独安全保管。

本机快照不是完整备份方案。正式切换前还必须在真实 Mac 上完成：Time Machine 或独立介质副本、一个加密异地副本、以及从副本恢复到隔离目录的演练。

## 6. 菜单栏与移动体验

登录桌面后，菜单栏会出现“考研中心”管理器。它可以查看服务是否在线、打开 Tailscale 主入口或 Cloudflare 备用入口、复制地址、打开数据/备份目录并查看最近快照。退出菜单栏管理器不会停止核心服务。

iPhone/iPad 会自动启用 Apple 移动视觉层，关键触控目标至少 44×44px，减少动效设置会被尊重。首页明确显示当前任务、今日进度和 Mac 服务状态；备用入口会直接标识“备用入口”，不会假装成主路径。AI 只以任务状态和可撤销建议出现，不增加聊天首页或夸张光效。

## 7. 正式切换前的实机验收

- Mac：LaunchDaemon、FileVault 冷启动、休眠唤醒、断网恢复、磁盘权限、连续 24 小时服务和每日备份。
- iPhone/iPad：Tailscale 与 Cloudflare 两条入口、相机、锁屏、Safari 强制结束、弱网续传、44px 触控和无横向溢出。
- Windows：Electron 小窗口本地先保存、离线连续写入、重启续传、完整副本下行、冲突处理和 AI 只由 Mac 执行。
- 数据：正式 dry-run 零未解释解析失败，记录和人工字段守恒，附件逐字节哈希一致，并完成隔离恢复。
- 网络：Mac 的 5173/5174 只监听回环并由 Tailscale/Cloudflare 入口转发；Windows 的 5174 只监听回环，5173 明确监听局域网以保留 iPad 应急入口；Tailscale 仍是移动端默认地址，Cloudflare 明确标记备用且由 Access 与应用登录双层保护。

全部通过后，再进行 30 分钟计划停写、增量导入和最终核对。任何正式导入、权威切换、旧链路停写或删除都需要用户再次明确批准。

## 8. 当前开发机验证

2026-09-19：448/448 离线测试、TypeScript 类型检查、正式构建和 Windows Electron 目录打包通过；打包产物已核对包含网页、局域网网关、Windows 副本同步运行时及共享模块。真实 Windows 业务包共 2100 个文件、527,852,210 字节，逐项哈希通过；隔离权威库演练得到 870 个实体、100 个墓碑、409 个同步附件、92 个画布、零冲突。Windows 局域网网关已在 `0.0.0.0:5173` 实测返回健康响应。开发机演练不能替代正式 Mac 切换和跨设备双向写入验收。

## 9. 平台依据

- [Cloudflare：remotely-managed Tunnel](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/do-more-with-tunnels/local-management/)：Cloudflare 对多数场景推荐 remotely-managed Tunnel。
- [Cloudflare：Tunnel run parameters](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/configure-tunnels/run-parameters/)：支持通过 token file 启动 Tunnel，避免把凭据放进进程参数。
- [Cloudflare：macOS service](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/do-more-with-tunnels/local-management/as-a-service/)：`cloudflared` 在 macOS 上作为长期服务运行的官方边界。
