# 桌面版说明

桌面版基于 Electron，启动后是无边框桌面组件窗口，不显示浏览器地址栏。

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
- 移动或缩放窗口后会保存到 Electron 用户数据目录的 `window-state.json`。
- 默认不置顶，其他窗口会自然覆盖它。
- 默认不占任务栏，通过系统托盘显示、隐藏和退出。
- 第一次启动后会开启开机自启，托盘菜单里可以关闭。
- 托盘菜单支持恢复到红框位置、保存当前位置、显示、隐藏和退出。

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
