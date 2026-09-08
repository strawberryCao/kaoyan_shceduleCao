# 考研学习课表 App

React + TypeScript + Vite 实现的 30 天考研学习课表，支持本地记录、筛选、统计、导入导出和 GitHub Pages 静态部署。

## 项目结构

```text
kaoyan-schedule-app/
├─ index.html
├─ package.json
├─ vite.config.mjs
├─ tsconfig.json
├─ DESKTOP.md
├─ LIVELY_WALLPAPER.md
├─ 启动考研课表.cmd
├─ 启动壁纸模式.cmd
├─ electron/
│  ├─ main.cjs
│  └─ preload.cjs
└─ src/
   ├─ App.tsx
   ├─ main.tsx
   ├─ styles.css
   ├─ types.ts
   ├─ components/
   │  ├─ DayCard.tsx
   │  ├─ DataPanel.tsx
   │  ├─ NotesPanel.tsx
   │  ├─ Sidebar.tsx
   │  ├─ ScheduleApp.tsx
   │  └─ StatsPanel.tsx
   └─ utils/
      └─ schedule.ts
```

## 本地运行

```bash
npm install
npm run dev
```

PowerShell 如果拦截 `npm.ps1`，可以使用：

```bash
npm.cmd install
npm.cmd run dev
```

## Mac mini 自托管候选版

Mac mini 专用工作位于 `deploy/macmini-full-migration`。默认入口是 Tailscale 私有 HTTPS，Cloudflare Tunnel 作为明确的备用入口；Mac 保存权威数据并统一执行 AI，Windows 继续保留 Electron 速记与完整本地副本。

```bash
git switch deploy/macmini-full-migration
npm ci
npm run macmini:setup
```

最后一条默认只显示安装计划。真实安装、隐藏式密钥填写、正式数据只读盘点、备份和实机验收顺序见 [第五阶段手册](docs/macmini-phase-5-runbook.md)。在完成守恒报告和用户再次确认前，脚本不会迁移正式数据或切换权威源。

## 构建

```bash
npm run build
```

构建产物在 `dist/`。`vite.config.mjs` 已设置 `base: './'`，适合部署到 GitHub Pages 的仓库子路径。

## 桌面版

开发运行：

```bash
npm run electron:dev
```

打包桌面程序：

```bash
npm run desktop:build
```

打包后的可执行文件位于：

```text
desktop-dist/win-unpacked/考研学习课表.exe
```

详细说明见 `DESKTOP.md`。

## 壁纸模式

浏览器访问：

```text
http://127.0.0.1:5173/?wallpaper=1
```

或双击 `启动壁纸模式.cmd`。如果要作为桌面底层交互壁纸使用，请参考 `LIVELY_WALLPAPER.md`。
