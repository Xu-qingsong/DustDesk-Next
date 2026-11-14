# DustDesk 1.0.3

DustDesk 是一个面向 Windows 的本地桌面工作台。它把任务、便签、项目、链接、快捷启动、剪贴板、桌面整理、截图和系统监控集中到一个 Rust + Tauri 应用中，数据保存在本机，适合需要快速记录和整理工作环境的个人用户。

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

当前版本包含三个独立侧栏页面：文本工具箱、批量图片工具箱和 DustDesk 电脑间的局域网传输。使用方法、续传数据位置与限制见 [工具箱与局域网传输](docs/TOOLBOX.md)。

开发环境：Windows 10/11 x64、Node.js 20+、Rust stable、Visual Studio C++ 生成工具和 WebView2。使用安装包或绿色版时无需安装 Node.js 或 Rust。

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

`npm run check:silent` 执行 TypeScript 检查、Node 单元测试、前端构建和 Rust 全目标测试，不启动应用窗口。`npm run build:app -- --debug` 生成可运行的 Tauri 开发程序；`npm run e2e` 启动真实 WebView2 窗口验证编辑、保存和退出。测试使用独立临时数据目录。

`dist` 会生成 Windows x64 NSIS 安装包和免安装绿色 ZIP。绿色版解压后运行 `DustDesk.exe`，保留压缩包内的全部文件；数据继续保存在下方所列的默认工作区目录。发布规则见 [开发与发布规范](docs/DEVELOPMENT.md)。

## 数据位置

默认工作区数据位于：

```text
DustDesk.exe 所在目录\Data\workspace.json
```

开发模式使用项目根目录下的 `Data`，安装版和绿色版使用 `DustDesk.exe` 同级的 `Data`，不受启动时工作目录影响。程序目录须可写；移动绿色版时一起移动 `Data`。同一目录还可能包含备份、回收站、便签背景图片、剪贴板图片和截图。应用启动时会兼容旧版工作区字段，并在需要时保留恢复点。

剪贴板图片存放在 `ClipboardImages` 中，工作区只保存图片引用；旧版内嵌图片会在首次读取时自动迁移。备份仍内嵌图片，可独立恢复。迁移后的工作区格式为版本 3，旧版应用会拒绝打开，请通过应用的备份功能导出数据。图片文件暂时保留，以保证 `.bak` 和恢复点中的引用可用。

## 默认快捷键

- `Ctrl+K`：打开全局搜索
- `Ctrl+Shift+K`：显示或隐藏主窗口
- `Ctrl+Shift+D`：显示或隐藏已配置的小组件
- `Ctrl+Shift+Space`：打开快速记录

所有快捷键都可以在设置页中修改。

## 技术栈

- Rust、Tauri 2、系统 WebView2
- React 19、TypeScript 5、Vite
- Radix UI、Lucide React、Windows 原生窗口、托盘与快捷键

页面通过类型化 `DustDeskApi` 访问 Rust 服务。原生权限按主窗口、小组件、截图、贴图和快速记录分别授予；不开放任意执行或通用文件读写。

## 项目结构

```text
src-tauri       Rust 应用、存储、窗口和 Windows 系统能力
src/renderer    原有 React 页面、小组件、样式和浏览器 Worker
src/shared      TypeScript 类型与业务模型
scripts         构建与 Windows 安装包、绿色 ZIP 打包
tests           单元测试、原生 Tauri 回归与历史行为对照
docs            开发规范和迁移记录
```

## 当前分支

`v1.0.3` 为 Rust + Tauri 2 框架的正式版本，`main` 同步该发布基线；后续开发从本地 `v1.0.4` 分支继续。`v1.0.1`、`v1.0.2` 的标签与已发布内容保持不变。框架变更和升级步骤见 [v1.0.3 版本说明](docs/releases/v1.0.3.md)。

当前分支直接以 Rust + Tauri 替换 Electron，默认开发、构建和运行入口均为 Tauri。产品源码不包含 Electron 主进程或 preload，npm 不再安装 Electron、electron-vite 或 electron-builder。`tests/reference` 中保留的旧 TypeScript 代码只供模拟系统接口的行为对照测试使用，不打入应用，也不启动 Electron。

迁移保持原有界面、操作方式、工作区 JSON 格式与功能范围。工作区默认位于本地 `Data`；旧 `%AppData%\DustDesk.Next\Data` 不会自动覆盖本地目录，可通过备份恢复导入旧工作区。局域网身份继续使用已存在的原用户配置目录，避免生成另一设备身份。自动创建默认工作区仅发生在首次使用且没有工作区或备份时；损坏、丢失和未完成恢复会保留原文件并阻断编辑。

安装包和绿色版均使用系统 WebView2。开发测试入口与正式应用入口分开，原型窗口仅允许 Debug 构建打开。构建和运行检查进度见 [迁移执行记录](docs/TAURI_MIGRATION_PROGRESS.md)，历史记录不代表当前源码的验收结果。

## 许可与致谢

DustDesk 延续了原 DustDesk.Next 项目的数据模型和产品思路，感谢原项目作者 [Abyxs](https://github.com/Abyxs) 及 [DustDesk-Desktop-Manager](https://github.com/Abyxs/DustDesk-Desktop-Manager)。
