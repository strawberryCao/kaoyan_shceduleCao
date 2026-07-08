# Lively Wallpaper 壁纸模式

这个项目已经把“壁纸显示”和“桌面窗口”分开处理：

- 普通地址 `/`：完整管理模式，可以看 30 天课表、勾选、写备注、导入导出、看统计。
- 壁纸地址 `/?wallpaper=1`：Lively Wallpaper 专用，只显示今日课表和进度，不再依赖 Electron 贴桌面。

## 先安装依赖

如果你是第一次运行，先双击项目目录里的：

```text
安装依赖.cmd
```

这个脚本会做几件事：

1. 检查 Node.js / npm。
2. 如果可以使用 winget，会尝试安装 Node.js LTS。
3. 如果可以使用 winget，会尝试安装 Lively Wallpaper。
4. 执行 `npm install` 安装项目依赖。
5. 执行 `npm run build` 验证项目能否正常构建。

如果脚本提示 winget 不可用，就手动安装 Node.js LTS 和 Lively Wallpaper，然后重新运行脚本。

## 为什么不用 Electron 贴桌面

之前的 Electron 方案会尝试使用 Windows 的 `WorkerW / Progman / SetParent` 把窗口强行挂到桌面层。这个方案容易出现窗口坐标错乱、固定位置跳动、层级异常等问题。

现在推荐把“真正的壁纸层”交给 Lively Wallpaper。Lively Wallpaper 免费，适合把本地网页作为桌面壁纸加载。

## 第一次手动启动

1. 先运行 `安装依赖.cmd`。
2. 双击项目目录里的：

```text
启动壁纸模式.cmd
```

3. 脚本会启动两个本地服务：

```text
http://127.0.0.1:5173/?wallpaper=1
http://127.0.0.1:5174/health
```

第一个是壁纸页面，第二个是笔记保存服务。

4. 打开 Lively Wallpaper。
5. 添加壁纸，类型选择网页 / URL。
6. 填入：

```text
http://127.0.0.1:5173/?wallpaper=1
```

7. 保存并设为桌面壁纸。

注意：`启动壁纸模式.cmd` 不再自动打开浏览器。它只负责启动本地服务。壁纸 URL 应该添加到 Lively Wallpaper 里，而不是当作普通浏览器窗口使用。

## 笔记暂存功能

壁纸右下角有一个“笔记暂存”小矩形。

### 单图保存

- 把图片拖到小矩形上。
- 或点击小矩形后按 `Ctrl + V` 粘贴图片。
- 保存前会提示填写备注，备注可以为空。
- 图片会保存到：

```text
C:\Users\ASUS\Desktop\笔记\默认文件夹
```

实际代码会优先使用当前 Windows 用户的桌面路径，所以在你的电脑上就是上面的路径。

### 存储画布

- 点击小矩形右侧的画布按钮。
- 在弹出的画布里拖入或粘贴多张图片。
- 图片可以拖动位置，右下角拖拽可以调整大小。
- 双击画布空白处可以打字。
- 点击“保存画布”后填写备注，备注可以为空。
- 画布也会先保存进 `默认文件夹`。

每次保存都会生成图片文件，同时生成对应的 `.note.json` 和 `metadata.json`。后续接入千问模型后，可以每天 24:00 读取 `metadata.json`，再按科目移动到对应文件夹。

## 开机自动使用

如果不想每次开机后手动启动代码服务，双击：

```text
设置开机自启.cmd
```

它会在 Windows 启动文件夹创建一个快捷方式，用于开机后隐藏启动本地服务。

然后你还需要在 Lively Wallpaper 设置里打开：

```text
Start with Windows / 随 Windows 启动
```

最终开机流程是：

1. Windows 自动运行本项目的本地服务。
2. Lively Wallpaper 自动启动。
3. Lively 加载之前保存的 URL 壁纸。
4. 桌面自动出现课表壁纸。

如果以后不想开机自动启动本地服务，双击：

```text
取消开机自启.cmd
```

## 手动运行方式

在 `outputs/kaoyan-schedule-app` 目录执行：

```bash
npm install
npm run note:server
npm run dev -- --host 127.0.0.1 --port 5173 --strictPort
```

然后在 Lively Wallpaper 里添加这个 URL：

```text
http://127.0.0.1:5173/?wallpaper=1
```

## 普通管理模式

浏览器打开：

```text
http://127.0.0.1:5173/
```

这里可以编辑记录、导入导出、查看完整 30 天安排。

## 注意

- 壁纸模式的数据仍然使用浏览器 `localStorage`。
- 壁纸模式可以勾选今日任务；如果 Lively 的交互受限，可以到普通管理模式里编辑。
- 不需要 Wallpaper Engine，因为它收费。
- 不要再让 Electron 执行贴桌面逻辑；Electron 现在只作为普通桌面窗口使用。
