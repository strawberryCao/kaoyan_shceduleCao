# Lively Wallpaper 壁纸模式

这个 App 支持 `?wallpaper=1` 模式，界面会更紧凑，适合放在桌面壁纸层使用。

## 推荐方式：本地服务 URL

1. 双击 `启动壁纸模式.cmd`，确认本地服务运行。
2. 打开 Lively Wallpaper。
3. 选择添加壁纸，类型选网页或 URL。
4. 输入：

```text
http://127.0.0.1:5173/?wallpaper=1
```

5. 保存后设置为桌面壁纸。

## 开机自动可用

如果希望开机后桌面自动出现这个课表：

1. 将 `启动壁纸模式.cmd` 的快捷方式放到 Windows 启动文件夹。
2. 在 Lively Wallpaper 中保留这个 URL 壁纸。
3. 开机后脚本会启动本地服务，Lively 会加载这个桌面页面。

Windows 启动文件夹可以用 `Win + R` 打开：

```text
shell:startup
```

## 说明

普通网页不能自己变成 Windows 桌面底层。真正做到“不遮挡其他窗口、像壁纸一样交互”，需要 Lively Wallpaper 或 Wallpaper Engine 这类壁纸容器承载网页。
