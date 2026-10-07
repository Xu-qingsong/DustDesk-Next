# DustDesk 1.0.1

DustDesk 是一个面向 Windows 的本地桌面工作台。它把任务、便签、项目、链接、快捷启动、剪贴板、桌面整理、截图和系统监控集中到一个轻量的 Electron 应用中，数据保存在本机，适合需要快速记录和整理工作环境的个人用户。

## 主要功能

- **任务与专注**：按日期管理任务、提醒和重复事项，并记录实际专注时长。
- **便签与快速记录**：支持多便签、全文搜索、背景图片、桌面小组件和跨窗口草稿恢复。
- **项目管理**：使用甘特图组织项目阶段、日期、进度和子事项，并可将阶段或子事项转换为任务。
- **桌面整理**：按规则预览、分类和移动文件，提供冲突保护、多级撤销和恢复。
- **统一搜索**：搜索任务、便签、项目、链接、启动器、剪贴板和桌面文件，也支持 `todo`、`task`、`note`、`clip`、`open` 命令。
- **快捷启动与链接**：管理应用、文件、目录和 HTTP/HTTPS 地址，并固定到桌面小组件。
- **截图工具**：区域快捷键先显示透明框选层，在实时桌面上拖动和调整选区，确认操作后只捕获选中区域，不预先截取整屏。应用内编辑页共用对象标注、样式修改、文字再次编辑、100 步撤销重做、缩放和裁剪预览。支持图片拖入及剪贴板导入，复制、PNG/JPG 保存和贴图使用同一份编辑结果，原图捕获时不导出、不复制。贴图仅在本次运行期间保留，支持缩放、透明度、锁定、置顶、鼠标穿透和重新编辑；托盘可统一显示、隐藏、关闭和恢复鼠标操作。
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

需要不打扰桌面的检查时，运行 `npm run check:silent`。它执行类型检查、Node 测试、构建和无界面页面测试；测试使用实际 preload、IPC 与持久化代码，模拟系统接口，不启动 Electron 窗口、注册真实快捷键或访问系统剪贴板。无界面页面测试使用已安装的 Chromium、Chrome 或 Edge，也可通过 `DUSTDESK_HEADLESS_BROWSER` 指定浏览器路径；没有可用浏览器时会明确跳过该项。`e2e:*` 命令则会启动真实应用窗口。

`dist` 会生成 Windows x64 NSIS 安装包和免安装绿色 ZIP。绿色版解压后运行 `DustDesk.exe`，保留压缩包内的全部文件；数据继续保存在下方所列的默认工作区目录。发布规则见 [开发与发布规范](docs/DEVELOPMENT.md)。

## 数据位置

默认工作区数据位于：

```text
%AppData%\DustDesk.Next\Data\workspace.json
```

同一目录还可能包含备份、回收站、便签背景图片、剪贴板图片和截图。应用启动时会兼容旧版工作区字段，并在需要时保留恢复点。

剪贴板图片存放在 `ClipboardImages` 中，工作区只保存图片引用；旧版内嵌图片会在首次读取时自动迁移。备份仍内嵌图片，可独立恢复。迁移后的工作区格式为版本 3，旧版应用会拒绝打开，请通过应用的备份功能导出数据。图片文件暂时保留，以保证 `.bak` 和恢复点中的引用可用。

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

当前主线版本为 **1.0.1**。核心工作台、数据保存、备份恢复、桌面整理、截图、小组件和回归测试已经纳入 Electron 主线，项目仍会继续迭代。

本版本的修复、新增功能与兼容性说明见 [v1.0.1 更新说明](docs/releases/v1.0.1.md)。开发、版本编号与发布介绍统一遵循 [开发与发布规范](docs/DEVELOPMENT.md)；未指定发布版本时默认递增补丁号，例如 `v1.0.0 → v1.0.1`。

设置和托盘只提供“检查更新”，从 [当前项目的 GitHub Releases](https://github.com/Xu-qingsong/DustDesk-Next/releases) 读取最新正式版本。发现新版本时显示版本号及 Release 更新说明，确认后打开对应版本的发布页面下载；不会自动下载、安装或退出应用。发布时使用 `v1.2.3` 这样的版本标签，并同步修改 `package.json` 中的版本号。项目主页和问题反馈均指向本仓库。

## 许可与致谢

DustDesk 延续了原 DustDesk.Next 项目的数据模型和产品思路，感谢原项目作者 [Abyxs](https://github.com/Abyxs) 及 [DustDesk-Desktop-Manager](https://github.com/Abyxs/DustDesk-Desktop-Manager)。
