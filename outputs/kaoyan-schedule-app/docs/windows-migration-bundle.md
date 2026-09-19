# Windows 业务数据迁移与 Mac 权威库激活

导出工具负责逐字节复制、哈希验证和隔离准备；激活工具在 Mac 上再次验证后，才把 Windows 数据灌入 Mac 权威同步库。`export` 和 `stage` 永远不会切换正式数据。

导出前暂停笔记编辑及后台整理。工具会在复制前后重新扫描；发现文件变化会失败并保留不完整目录供检查，重新导出需使用新的目标目录。此检查不是运行中数据库的一致性事务。

Windows PowerShell：

```powershell
node scripts/windows-migration-bundle.cjs export --notes="C:\Users\ASUS\Desktop\笔记" --assistant="C:\Users\ASUS\Desktop\考研桌面助手" --output="C:\Users\ASUS\Desktop\kaoyan-migration-001"
node scripts/windows-migration-bundle.cjs verify --bundle="C:\Users\ASUS\Desktop\kaoyan-migration-001"
```

输出目录必须尚不存在。请将整个目录通过文件传输复制到 Mac；不要提交到 Git。

Mac 在项目目录运行（按实际位置修改路径）：

```bash
node scripts/windows-migration-bundle.cjs stage --bundle="$HOME/Downloads/kaoyan-migration-001" --output="$HOME/Downloads/kaoyan-shadow-001"
node scripts/windows-migration-bundle.cjs prepare --bundle="$HOME/Downloads/kaoyan-migration-001" --output="$HOME/Downloads/kaoyan-runtime-shadow-001"
npm run macmini:migrate:activate -- plan --bundle="$HOME/Downloads/kaoyan-migration-001"
```

`plan` 只校验、不写 Mac 正式数据。确认报告后，正式激活必须显式声明 Windows 是权威来源，并使用安装服务所需的 `sudo`：

```bash
sudo /opt/homebrew/bin/node scripts/activate-macmini-migration.cjs apply \
  --bundle="$HOME/Downloads/kaoyan-migration-001" \
  --runtime-root="/Library/Application Support/KaoyanStudyCenter" \
  --user="$USER" \
  --node="/opt/homebrew/bin/node" \
  --confirm-windows-authoritative
```

激活会在 `releases/windows-authority-*` 内保留原 Mac `data` 目录，密钥、移动端登录和 Tunnel 配置位于 `secrets`/`config`，不会被 Windows 包覆盖。脚本先在隔离目录生成并核验权威 SQLite、同步附件与画布实体，随后短暂停服并原子交换 `data`；重启或健康检查失败时自动恢复原 Mac 数据。迁移成功后仍需单独创建 Windows 同步设备令牌并在 Windows 配置，脚本不会把令牌写入迁移包。

保留笔记目录中的业务文件及隐藏附件；助手目录选择学习记录、布局、分类体系、画布、保存回执及隔离笔记。旧密钥、密钥备份和运行配置不随包迁移。其他未选文件逐项列于 manifest 的 excluded，需复核是否有遗漏的业务附件。内容保持逐字节一致，未知 JSON 字段和删除记录不会被丢弃。

`prepare` 会生成符合 Mac 目录布局的隔离运行时，把来源目录内的 Windows 绝对路径改写到隔离目录。它会区分两类缺失引用：迁移包本来包含、但隔离运行时没有复制成功的 `brokenInternalPaths` 会阻止激活；Windows 源目录在导出前就已缺失的 `preexistingMissingPaths` 会完整列出供复核，但不会把一次逐字节完整的迁移误报为复制失败。来源之外的 Windows 绝对路径仍会阻止激活。只有迁移自身没有丢文件且没有未解析外部路径时才会输出 `activationReady: true`。

浏览器中的学习缓存和课表会自动汇入 Windows 的 `learning-data.json`；界面偏好继续留在 Windows。迁移前仍需在 Windows 打开应用联网一次，并确认活动中心没有“等待发送”“上传中”或可重试的业务任务。加密临时队列绑定当前设备，不应复制到 Mac。

必须复核 excluded 和 `preexistingMissingPaths`。暂存或 `prepare` 成功不等于正式切换完成；只有激活报告中 `activated: true`、Mac 健康检查通过，并完成 Windows 同步配置后，才进入同一套数据系统。
