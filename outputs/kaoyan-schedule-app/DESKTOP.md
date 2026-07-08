# 桌面版说明

桌面版基于 Electron，启动后会尝试挂到 Windows 桌面 `Progman/WorkerW` 层，视觉上贴在桌面壁纸上，不显示浏览器地址栏，也不作为普通任务栏窗口出现。

## 直接运行

打包后的可执行文件在：

```text
desktop-dist/win-unpacked/考研学习课表.exe
```

也可以双击输出目录中的快捷方式：

```text
考研学习课表-桌面版.lnk
```

## 行为

- 启动后默认显示在屏幕右侧红框区域。
- 当前 1920x1080、125% 缩放环境下，Windows 读取到的窗口矩形约为 `x=1070, y=0, width=458, height=810`，换算到截图像素约为 `x=1340, y=0, width=570, height=1010`。
- 启动后会自动执行桌面层贴附；如果 Windows Explorer 重启或贴附失效，可以从托盘点击“重新贴到桌面”。
- 默认主界面只显示今天课表、进度和任务勾选。日期切换、备注、统计、导入导出和清空记录收在右上角“更多”按钮里。
- 默认不置顶，其他窗口会自然覆盖它；回到桌面时它会贴在壁纸层。
- 默认不占任务栏，通过系统托盘显示、隐藏和退出。
- 第一次启动后会开启开机自启，托盘菜单里可以关闭。
- 托盘菜单支持重新贴到桌面、恢复到红框位置、保存当前位置、显示、隐藏和退出。

## 桌面层说明

当前实现使用 Windows 桌面层技术：

- 程序启动后找到桌面 `Progman/WorkerW` 窗口。
- 将 Electron 主窗口切换为桌面子窗口，再挂到该层。
- 为了保持可交互，不启用鼠标穿透；课表所在区域仍然可以点击勾选和展开详情。
- 如果桌面层挂载失败，会自动退回右侧桌面组件窗口模式，托盘里仍可手动重试“重新贴到桌面”。

## 开机自启

桌面版使用两种方式保证开机后自动显示：

- Electron 登录项：由程序自动设置。
- Windows 启动文件夹快捷方式：`%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup\考研学习课表.lnk`

当前快捷方式指向：

```text
desktop-dist/win-unpacked/考研学习课表.exe
```

## 开发运行

```bash
npm run electron:dev
```

PowerShell 如果拦截 `npm.ps1`，使用：

```bash
npm.cmd run electron:dev
```

## 打包

```bash
npm run desktop:build
```

当前打包输出为免安装文件夹版本，避免 NSIS 单文件打包在部分 Windows 环境下下载或权限失败。可执行文件位于 `desktop-dist/win-unpacked/`。
