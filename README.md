# DustDesk Electron

DustDesk Electron 桌面工作台，读取现有工作区数据：

```text
%LocalAppData%\DustDesk.Next\Data\workspace.json
```

## 本地命令

```powershell
npm install
npm run dev
npm run typecheck
npm run build
npm run e2e:organizer
npm run e2e:visual-special
npm run e2e:update
npm run dist
```

`dist` 目标为 Windows x64 NSIS 安装包和 portable 包。首次打包可能需要 electron-builder 下载 Electron/NSIS 工具链。

## 项目状态

- 已完成：Electron 主进程、sandbox preload、单实例、托盘、窗口快捷键、苹果风格浅深主题、React 工作台、JSON 原子保存、剪贴板 IPC/实时推送、任务/便签/项目/链接/启动器 CRUD、桌面文件扫描与分类移动、CPU/内存/网络/磁盘/Ping 系统指标、统计、启动项、备份恢复、文件搜索、命令前缀、全屏/窗口截图捕获、截图裁剪/画笔/线条/箭头/矩形/文字/序号/马赛克/模糊/橡皮擦/保存/置顶贴图、系统级多屏区域覆盖层、10 类桌面小组件窗口、收纳多级撤销（含跨重启持久化）。
- Electron 已作为本分支唯一默认入口，保留旧 workspace 字段兼容和数据备份恢复能力。
- 功能对齐和视觉回归继续通过 Electron 测试矩阵维护。

## 安全边界

- `contextIsolation: true`
- `nodeIntegration: false`
- `sandbox: true`
- 渲染进程只能通过 `window.dustdesk` 调用类型化 preload API。
