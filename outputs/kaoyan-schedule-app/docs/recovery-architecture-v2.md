# 考研系统 V2 恢复架构

## 不可违反的规则

- 正式公网地址保留；恢复版本先发预览 Worker。
- `Caobijidata` 必须为私有仓库。隐私检查不通过时，CI 拒绝部署。
- 自动同步默认保持暂停。只有显式运行安装器的 `-EnableNow` 参数才会首次同步、写启动项并启动监听。
- 公网不能删除资料；`DELETE /api/entries/:id` 固定返回 `405`。
- 远端 Entry、Asset、任务和配置中禁止出现 Windows 盘符路径。
- 一级目录只能是十个固定科目；错题、背诵、知识、方法、速记都是 Facet 或 `kind`，不能创建一级目录。

## 固定数据流

`C:\Users\ASUS\Desktop\笔记` ⇄ 本地 V2 适配器 ⇄ `D:\kaoyandata\Caobijidata` ⇄ 私有 GitHub `Caobijidata` ⇄ Cloudflare Worker

V2 数据位于：

- `data/v2/index.json`
- `data/v2/entries/{entryId}.json`
- `data/v2/assets/{assetId}.json`
- `data/assets/{sha256}.{ext}`

本地绝对路径只允许出现在 C 盘 sidecar 和本机映射中。发布到 D 盘/GitHub 的结构化数据只保存 `github://` 或仓库相对路径。

## 安全恢复顺序

1. 确认 `Caobijidata` 已是私有仓库。
2. 提交并推送 D 盘 V2 迁移结果。
3. 提交并推送代码恢复分支，创建预览部署。
4. 为预览 Worker 配置 `APP_PASSWORD`、独立 `SESSION_SECRET`、最小权限 `GITHUB_TOKEN` 和可选 AI 密钥。
5. 在预览环境执行浏览器验收与双向真实同步。
6. 连续完成 20 个五分钟端到端周期：零新增冲突副本、零绝对路径、零意外一级目录。
7. 只有全部通过后运行：

   ```powershell
   powershell -NoProfile -ExecutionPolicy Bypass -File scripts/install-note-folder-sync.ps1 -EnableNow
   ```

8. 再由手动生产工作流部署不可变提交 SHA；保留上一 Worker Version 作为回滚点。

## 验证命令

```powershell
$tests = Get-ChildItem cloudflare,scripts -Recurse -File |
  Where-Object { $_.Name -like '*.test.cjs' -or $_.Name -like '*.test.mjs' }
node --test @($tests.FullName)
npm.cmd run build
npm.cmd run test:e2e
npx.cmd wrangler deploy --dry-run --env=""
npx.cmd wrangler deploy --dry-run --env preview
```

安装但继续暂停：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/install-note-folder-sync.ps1
```

## 数据恢复

迁移前原始文件、冲突副本、重复 sidecar、Git Bundle 和哈希清单均保存在仓库外的恢复目录。冲突副本只有在源文件与归档 SHA-256 全部一致后才会从活动树移除；旧格式继续只读保留一个版本周期。
