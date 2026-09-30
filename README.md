# DustDesk 1.0.0

DustDesk 是一个面向 Windows 的本地桌面工作台。它把任务、便签、项目、链接、快捷启动、剪贴板、桌面整理、截图和系统监控集中到一个轻量的 Electron 应用中，数据保存在本机，适合需要快速记录和整理工作环境的个人用户。

## 主要功能

- **任务与专注**：按日期管理任务、提醒和重复事项，并记录实际专注时长。
- **便签与快速记录**：支持多便签、全文搜索、背景图片、桌面小组件和跨窗口草稿恢复。
- **项目管理**：组织项目、阶段和子事项，并可将阶段或子事项转换为任务。
- **桌面整理**：按规则预览、分类和移动文件，提供冲突保护、多级撤销和恢复。
- **统一搜索**：搜索任务、便签、项目、链接、启动器、剪贴板和桌面文件，也支持 `todo`、`task`、`note`、`clip`、`open` 命令。
- **快捷启动与链接**：管理应用、文件、目录和 HTTP/HTTPS 地址，并固定到桌面小组件。
- **截图工具**：支持区域、窗口和全屏截图，以及裁剪、画笔、箭头、文字、马赛克、模糊、保存和置顶贴图。
- **系统监控**：查看 CPU、内存、网络、磁盘、延迟和运行时长。
- **备份与恢复**：工作区采用 JSON 原子保存，支持自动备份、恢复点、回收站和失败回滚。

## 快速开始

环境要求：Windows 10 或更高版本、Node.js 20+。

```powershell
npm install
npm run dev
```

常用检查和构建命令：

```powershell
npm run typecheck
npm test
npm run build
npm run dist
```

`dist` 会生成 Windows x64 NSIS 安装包和 portable 包。

## 数据位置

默认工作区数据位于：

```text
%AppData%\DustDesk.Next\Data\workspace.json
```

同一目录还可能包含备份、回收站、便签背景图片、剪贴板图片和截图。应用启动时会兼容旧版工作区字段，并在需要时保留恢复点。

## 默认快捷键

- `Ctrl+K`：打开全局搜索
- `Ctrl+Shift+K`：显示或隐藏主窗口
- `Ctrl+Shift+D`：显示或隐藏已配置的小组件
- `Ctrl+Shift+Space`：打开快速记录

所有快捷键都可以在设置页中修改。

## 技术栈

- Electron 37、React 19、TypeScript 5
- Vite / electron-vite
- Radix UI、Lucide React、systeminformation
- Windows Shell、系统托盘、全局快捷键和原生窗口能力

渲染进程启用 `contextIsolation` 和 `sandbox`，关闭 `nodeIntegration`，所有系统能力都通过类型化 preload API 暴露。

## 项目结构

```text
src/main       Electron 主进程、窗口、IPC 和系统能力
src/preload    渲染进程可用的类型化 API
src/renderer   React 页面、组件、工作台和小组件
src/shared     主进程与渲染进程共享的类型和业务模型
tests          单元、回归和 Electron 测试
docs           设计与重构记录
```

## 项目状态

当前主线版本为 **1.0.0**。核心工作台、数据保存、备份恢复、桌面整理、截图、小组件和回归测试已经纳入 Electron 主线，项目仍会继续迭代。

## 许可与致谢

DustDesk 延续了原 DustDesk.Next 项目的数据模型和产品思路，感谢原项目作者 [Abyxs](https://github.com/Abyxs) 及 [DustDesk-Desktop-Manager](https://github.com/Abyxs/DustDesk-Desktop-Manager)。
