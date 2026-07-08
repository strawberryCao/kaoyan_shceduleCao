# Lively Wallpaper 壁纸模式

这个项目已经把“壁纸显示”和“桌面窗口”分开处理：

- 普通地址 `/`：完整管理模式，可以看 30 天课表、勾选、写备注、导入导出、看统计。
- 壁纸地址 `/?wallpaper=1`：Lively Wallpaper 专用，只显示今日课表和进度，不再依赖 Electron 贴桌面。

## 为什么不用 Electron 贴桌面

之前的 Electron 方案会尝试使用 Windows 的 `WorkerW / Progman / SetParent` 把窗口强行挂到桌面层。这个方案容易出现窗口坐标错乱、固定位置跳动、层级异常等问题。

现在推荐把“真正的壁纸层”交给 Lively Wallpaper。Lively Wallpaper 免费，适合把本地网页作为桌面壁纸加载。

## 推荐方式：使用启动脚本

1. 安装 Lively Wallpaper。
2. 双击项目目录里的：

```text
启动壁纸模式.cmd
```

3. 脚本会启动本地服务，并打开：

```text
http://127.0.0.1:5173/?wallpaper=1
```

4. 打开 Lively Wallpaper。
5. 添加壁纸，类型选择网页 / URL。
6. 填入：

```text
http://127.0.0.1:5173/?wallpaper=1
```

7. 保存并设为桌面壁纸。

## 手动运行方式

在 `outputs/kaoyan-schedule-app` 目录执行：

```bash
npm install
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

## 开机自动使用

如果希望开机后自动可用：

1. 按 `Win + R`。
2. 输入：

```text
shell:startup
```

3. 把 `启动壁纸模式.cmd` 的快捷方式放进去。
4. Lively Wallpaper 里保留这个 URL 壁纸。

开机后脚本会启动本地服务，Lively 会加载壁纸页面。

## 注意

- 壁纸模式的数据仍然使用浏览器 `localStorage`。
- 壁纸模式可以勾选今日任务；如果 Lively 的交互受限，可以到普通管理模式里编辑。
- 不需要 Wallpaper Engine，因为它收费。
- 不要再让 Electron 执行贴桌面逻辑；Electron 现在只作为普通桌面窗口使用。
