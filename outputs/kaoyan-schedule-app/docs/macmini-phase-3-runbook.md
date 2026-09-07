# Mac mini 第三阶段：Windows 本地副本与同步协议手册

状态：协议实现稿；仅用临时数据验证，禁止直接切换正式资料

目标分支：`deploy/macmini-full-migration`

## 1. 本阶段交付了什么

本阶段解决的是“Windows 速记必须先在本机保存，同时最终收敛到 Mac”这一条数据主线，不是正式数据搬家。

- Mac 权威同步库：SQLite WAL、完整同步、字段时钟、墓碑、冲突、幂等回执和单调事件游标。
- Windows 完整副本：SQLite 投影、持久化离线发件箱、稳定设备序列、重试记录和独立下行游标。
- 业务桥接：学习笔记、卡片、每日人工记录和画布在现有 JSON/画布文件成功落盘后才进入同步队列。
- 附件桥接：图片、PDF、Word、HTML 等二进制按 SHA-256 去重；下载后再次计算哈希，绝对路径不会进入跨设备文档。
- 合并：不同字段自动合并，集合使用 add/remove 增量，同一人工字段并发产生显式冲突；删除不会被旧副本复活。
- 安全：每台 Windows 使用独立令牌；Mac 只保存哈希；撤销立即生效；同步接口不接受普通浏览器 Origin。
- AI 边界：Windows 新运行时删除继承的 AI 环境变量并拒绝本机 AI 请求，界面明确显示需要等待 Mac。

## 2. 数据流和落盘顺序

```text
Windows Electron 保存
  -> 现有本地文件 / learning-data.json / canvas 文件成功
  -> Windows replica.sqlite 写投影 + outbox（同一事务）
  -> UI 显示“已保存到本机，等待 Mac”
  -> Tailscale HTTPS /sync/v1 上传单个操作
  -> Mac authority.sqlite 去重、合并、写事件、返回回执
  -> 缺失附件按 SHA-256 上传
  -> Windows 标记回执并按 Mac 游标拉取所有设备的新状态
  -> 本地 JSON / canvas 文件幂等物化
```

Mac 本机产生的学习和画布修改也先保存既有文件，再进入同一权威事件库。同步桥失败不会回滚或删除已经成功保存的用户数据，而会把状态标记为降级，等待修复。

## 3. 状态含义

Windows 本地 `GET http://127.0.0.1:5174/replica/status`：

- `queued` / `pending > 0`：本机已经保存，Mac 尚未确认。
- `acknowledged`：Mac 已按同一操作回执确认。
- `conflict` / `conflicts > 0`：Mac 保留了权威值，同时记录了需要人工选择的并发字段。
- `capture.state=degraded`：业务文件已保存，但写同步发件箱失败，不能误报“已同步”。

Mac 本地 `/health` 的 `sync` 字段和经设备认证的 `/sync/v1/status` 会报告实体、墓碑、操作、未解决冲突、附件、已产生操作的设备和最新游标数量，不返回正文、令牌或令牌哈希。注册但尚未同步的设备以 `sync:device list` 为准。

## 4. 设备配置合同

下面命令只展示最终部署步骤。本阶段不要对正式目录执行；先在副本或临时运行根演练。

Mac 为 Windows 创建独立令牌：

```bash
npm run sync:device -- create --device-id=windows-main --label="主 Windows" --runtime-root="/Library/Application Support/KaoyanStudyCenter"
```

令牌只显示一次。Mac 配置文件只保存 SHA-256 哈希。遗失令牌时先撤销再创建替代令牌：

```bash
npm run sync:device -- revoke --device-id=windows-main --runtime-root="/Library/Application Support/KaoyanStudyCenter"
```

Windows 使用隐藏输入向导写入当前用户的 `%LOCALAPPDATA%\KaoyanStudyCenter`。候选地址和令牌先完成连通性验证，失败不会覆盖旧配置：

```powershell
npm run sync:windows:configure -- wizard --live
```

设备地址必须是 Tailscale 提供的 HTTPS 地址；只有自动化测试允许 loopback HTTP。令牌不会进入命令行、Git、浏览器或状态文件。

## 5. 启动方式

完成未来正式导入并取得切换批准后，Windows 仍使用原来的 `scripts/start-note-app.cmd`。当新同步配置存在时，它会启动：

1. Windows 本地速记服务（副本角色）；
2. Windows 后台同步服务；
3. 本地 Web 静态服务；
4. 原 Electron 置顶速记小窗口。

此时旧 GitHub/Worker 自动同步不会同时启动。若 5174 端口仍运行旧笔记服务，启动会明确失败并要求先停止旧进程，不能在错误角色下静默使用。

调试时可以单独执行一次同步：

```powershell
npm run sync:windows:once
```

持续运行副本服务：

```powershell
npm run windows:replica:serve
```

## 6. Mac 入口合同

Mac 内部 Web 与数据服务仍只监听 `127.0.0.1`。统一 Web 网关在 Mac 托管运行时显式信任来自 loopback 的 Tailscale Serve / Cloudflare Tunnel 代理，因此原始 MagicDNS 或公网域名可以保留；来自 LAN 的直接连接不会获得这一信任。

`/sync/v1/*` 只用于已注册的后台设备客户端，保留 `Authorization: Bearer ...` 后转发到内部同步服务。普通 `/api/*` 继续删除 Authorization/Cookie 并受业务路由白名单限制。带浏览器 Origin 的同步请求会被拒绝，手机和 iPad 以后使用面向用户会话的业务 API，而不是持有 Windows 设备令牌。

本阶段没有执行 `tailscale serve` 或 `cloudflared` 命令，也没有更改现有域名、ACL 或公网入口。

## 7. 已自动验证的故障场景

- 相同 operationId 和相同内容重复提交只返回原回执；同 ID 不同内容被拒绝。
- 未知操作不能复用已消费的设备序列。
- Windows 断网时多次编辑保留在本地；恢复后按顺序上传并按最新 Mac 修订重建投影。
- 事件游标缺页或服务端声称的游标与最后事件不一致时拒绝推进。
- 附件上传与下载都验证 SHA-256；错误内容不能写入资源库。
- 并发人工标题进入冲突，人工可以基于最新修订显式解决。
- 删除墓碑拒绝旧补丁，恢复必须基于当前墓碑修订。
- 画布内嵌图片外置为不可变资源后可以无损恢复，未知画布字段保留。
- Windows 速记在 Mac 不可用时仍本地成功，且本机 AI 请求返回“由 Mac 处理”。
- Mac 收到远端记录和附件后会物化到现有学习数据格式；重放不会重复记录。
- 真实的 Windows 速记进程与后台同步进程并发打开同一副本时，可在一个周期内完成 Windows 上行、Mac 既有记录下行和本地界面刷新通知。
- 旧程序遇到未来版本的 Mac 数据库、Windows 副本库或设备配置时会停止并保留原版本号，不会把新 schema 静默降级。

## 8. 现在仍不能做什么

以下项目是正式启用前的硬阻断，不是可忽略的“以后优化”：

1. 尚未盘点或导入 Windows、GitHub、Cloudflare 的真实记录与附件；当前新托管目录可能是空的。
2. 尚未生成逐字段数量、稳定 ID、附件哈希、未知字段、孤儿项和冲突的守恒报告。
3. Mac AI 任务还没有形成持久化、幂等、可恢复的统一任务队列；Windows 已禁止本机 AI，因此正式切换前必须补齐。
4. 冲突已有协议和人工解决 API，但还没有达到产品要求的可视化比较、撤销和批量处理体验。
5. 手机/iPad 的加密临时发件箱、用户会话与 Safari 生命周期恢复尚未实现。
6. Tailscale 主入口、Cloudflare 备用入口、备份恢复与 Mac 实机 LaunchDaemon 尚未验收。

因此目前只能继续开发和使用临时数据测试。不得把 Windows 新配置写进正式启动环境，不得停止旧数据链路，也不得删除任何旧数据。

## 9. 下一阶段顺序

1. 建立持久化 AI 任务队列和跨端任务状态，验证一次操作不会重复付费。
2. 实现只读正式数据盘点器与守恒清单，不修改任何来源。
3. 实现可逆 dry-run 导入器，并在非生产 Mac 数据根完成全量核对。
4. 补移动端会话与加密临时发件箱。
5. 完成 Tailscale/Cloudflare 双入口、备份恢复和真实设备 UX/性能验收。
6. 只有用户查看守恒报告并明确批准后，才进入短暂停写和正式切换。
