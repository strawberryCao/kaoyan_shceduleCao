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

壁纸页右上角还固定保留了“控制台 / 添加模块”入口。这个入口不属于桌面模块，无法被布局删除；即使快捷入口模块被隐藏，也能随时重新进入控制台。

## 壁纸资源与动态播放

仓库内置高清静态底图：

```text
public/dunhuang-wallpaper.png  1920x1080 原始底图
```

当前版本已经删除 WebGL 局部扭曲、鼠标风场和长条放射状沙尘，不再用代码假装布料运动。

网页只会查找正式的动态视频：

```text
public/dunhuang-master.webm
public/dunhuang-master.mp4
```

旧的 `dunhuang-reference.mp4` 只作为参考素材保留，不会自动播放，避免把带镜头运动或不符合要求的参考视频误当成最终壁纸。

找到正式视频后会使用双播放器在循环末尾进行约 0.8 秒交叉淡化，减轻重置帧。没有最终视频时，页面只显示高清静态底图和 42 个低透明度、小圆点状的缓慢浮尘；浮尘不会响应鼠标，也不会形成长线、喷射或放射效果。

生成最终视频的完整提示词、参数和验收标准见：

```text
DUNHUANG_ANIMATION_ASSET.md
```

生成后直接把 MP4 或 WebM 拖到：

```text
导入动态壁纸视频.cmd
```

脚本会自动放入正确位置，不需要改代码。

椭圆彩虹光晕相关的页面伪元素、`backdrop-filter`、径向蒙版和 `screen` 高光层仍保持彻底禁用。

`public/dunhuang-loop.mp4` 与 `scripts/build_seamless_wallpaper.py` 仅作为旧版实验资产保留，当前网页壁纸不会加载该视频。

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
