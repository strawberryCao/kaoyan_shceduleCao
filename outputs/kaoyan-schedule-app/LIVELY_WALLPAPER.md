# 考研桌面助手使用说明

现在推荐只记一个入口：

```text
启动考研桌面助手.cmd
```

它会同时启动：

```text
http://127.0.0.1:5173/?hub=1       统一入口
http://127.0.0.1:5173/?wallpaper=1 壁纸页，给 Lively 使用
http://127.0.0.1:5173/?console=1   桌面控制台
http://127.0.0.1:5173/?notes=1     笔记台
http://127.0.0.1:5174/health       笔记保存服务状态
```

旧的 `启动壁纸模式.cmd`、`启动笔记台.cmd`、`启动桌面控制台.cmd` 先保留为备用入口，但日常只用 `启动考研桌面助手.cmd`。

## 先安装依赖

第一次运行先双击：

```text
安装依赖.cmd
```

它会检查 Node.js / npm，安装项目依赖，并执行构建验证。

## Lively Wallpaper 使用

Lively Wallpaper 里添加网页 URL：

```text
http://127.0.0.1:5173/?wallpaper=1
```

桌面布局不要直接在 Lively 里改，打开控制台：

```text
http://127.0.0.1:5173/?console=1
```

控制台里拖动、缩放、添加、隐藏组件后会实时同步到壁纸页，不需要手动刷新。

## 笔记保存

Lively 壁纸里的拖拽/粘贴权限不稳定，所以壁纸右下角只作为“笔记台入口”。真正保存图片和画布请打开：

```text
http://127.0.0.1:5173/?notes=1
```

笔记台支持：

- 单图拖拽 / Ctrl+V / 选择文件保存。
- 大画布拼图。
- 图片拖动、缩放、删除。
- 文字添加、移动、删除。
- 画笔书写，线条可选中删除。
- 保存时调用千问结合图片和备注命名。

保存位置默认是：

```text
C:\Users\ASUS\Desktop\笔记
```

## 配置千问智能命名

双击：

```text
配置千问命名.cmd
```

输入 DashScope / 千问 API Key。脚本会把 Key 写到当前 Windows 用户环境变量，不会写进 GitHub：

```text
QWEN_API_KEY
QWEN_MODEL
QWEN_BASE_URL
```

配置完成后，关闭旧服务，重新双击：

```text
启动考研桌面助手.cmd
```

打开下面地址检查：

```text
http://127.0.0.1:5174/health
```

看到：

```json
"enabled": true
```

说明千问命名已启用。

文件名会类似：

```text
高数_极限夹逼准则例题_20260708_121530.png
数据结构_二叉树遍历错题_20260708_121700.png
```

如果没有配置 Key，或者千问调用失败，会用备注、类型和时间兜底命名，不再用随机串当主文件名。

## 为什么不用 Electron 贴桌面

之前的 Electron 方案会尝试使用 Windows 的 `WorkerW / Progman / SetParent` 把窗口强行挂到桌面层。这个方案容易出现窗口坐标错乱、固定位置跳动、层级异常等问题。

现在把真正的壁纸层交给 Lively Wallpaper。Lively Wallpaper 免费，适合把本地网页作为桌面壁纸加载。

## 开机自动使用

双击：

```text
设置开机自启.cmd
```

它会在 Windows 启动文件夹创建快捷方式，用于开机后隐藏启动本地服务。

同时在 Lively Wallpaper 设置里打开：

```text
Start with Windows / 随 Windows 启动
```

如果以后不想开机自动启动本地服务，双击：

```text
取消开机自启.cmd
```
