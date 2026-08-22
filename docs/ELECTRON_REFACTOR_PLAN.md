# DustDesk Electron 重构计划

> 方案版本：v2.8（2026-08-22）  
> 当前分支：`refactor/electron`  
> 当前策略：Electron 作为本分支唯一默认入口；旧 workspace 数据继续兼容读取。

## 计划变更记录

### 2026-08-22：Electron 重构方案正式落地

- 将原来的“评估 Electron”调整为独立 Electron 工程，采用 Electron + React + TypeScript + Vite。
- 确定组件库组合：`shadcn/ui` + `Radix UI`，配合 `lucide-react`、`cmdk` 和 `sonner`；不引入 Ant Design 或 Material UI。
- 将 UI 验收标准加入计划：Apple 风格 Token、浅色/深色主题、键盘焦点、窄窗口和视觉回归。
- 将 WPF 对齐改为逐入口功能矩阵，明确系统指标、组件组合布局和 Windows 原生行为在最终切换前必须单独验收。
- 增加发布验收：NSIS 安装/升级/卸载、portable 启动、更新下载和旧 workspace 兼容性。

### 当前执行摘要（2026-08-22）

| 范围 | 当前结果 | 证据/下一步 |
| --- | --- | --- |
| Electron 基础架构与安全 IPC | 已完成 | 类型检查、构建、单实例、托盘和 sandbox preload 已验证 |
| 核心业务与高级交互 | 已完成 | 任务、便签、项目、收纳、截图、剪贴板和 9 类小组件已有实现与 E2E |
| Apple 风格设计系统 | 已完成 | CSS Token、主题切换、Lucide、Radix 交互和窄窗口视觉回归 |
| 发布与更新链路 | 已完成 | 安装/升级/卸载、portable 启动、更新检查/下载已验证 |
| WPF 全量行为对齐 | 已迁移 | Electron 已承接当前功能矩阵，后续差异通过 Electron 专项测试持续修正 |
| 默认入口切换 | 已完成 | 本分支根目录已切换为 Electron 工程 |

## 本次方案变更（已落地）

- **组件方案已确定**：React 渲染层采用 `shadcn/ui` 源码组件 + `Radix UI` 无障碍原语，不引入 Ant Design 或 Material UI。
- **视觉方案已确定**：按 `awesome-design-md` 规则落地 Apple 风格，使用 CSS Variables 设计 Token，浅色优先并支持深色/跟随系统。
- **工程边界已确定**：主进程只负责系统能力和 IPC，preload 只暴露类型化白名单 API，业务页面不得直接访问 Node 或文件系统。
- **验收方式已确定**：按功能矩阵逐项对照既有 WPF 行为；类型检查、构建、Electron 契约测试、安装包启动和视觉回归均通过后才算完成。WPF 源码已从本分支移除，不再作为运行时入口。

### 与原方案的明确差异

| 决策项 | 原方案 | 本方案（Electron 重构） | 影响 |
| --- | --- | --- | --- |
| 渲染层 | WPF/XAML | Electron + React + TypeScript + Vite | 页面与系统能力解耦，可独立做视觉回归 |
| 通用组件 | 页面自定义控件 | `shadcn/ui` 源码组件 + `Radix UI` 原语 | 统一键盘、焦点、弹层和无障碍行为 |
| 图标与反馈 | WPF 控件默认样式 | `lucide-react` + `sonner` | 统一图标尺寸、Toast 和错误反馈 |
| 全局搜索 | 页面内筛选 | `cmdk` 命令面板 | 支持 `Ctrl+K` 和 `todo/task/note/clip/open` 命令 |
| 视觉规范 | WPF 默认主题 | Apple 风格 CSS Token，浅色/深色/跟随系统 | 统一颜色、间距、圆角、阴影和交互状态 |
| 系统边界 | UI 可直接依赖服务 | 主进程 + 类型化 preload 白名单 IPC | 渲染层禁止 Node、文件系统和系统 API 直连 |

### 组件库结论

本架构需要现成组件库，但只使用可拆分、可维护的组合：`shadcn/ui` 负责组件源码组织，`Radix UI` 负责交互与无障碍原语，`lucide-react` 负责图标，`cmdk` 负责命令面板，`sonner` 负责 Toast。组件只存在于 `src/renderer/src/components/ui`，业务页面不得直接耦合第三方 API；截图编辑器、桌面小组件画布和文件拖拽整理仍保留自定义实现。

后续新增 UI 组件必须先补充设计 Token、键盘行为、错误/空/加载状态和窄窗口回归，再进入功能矩阵验收。

## 实施阶段

| 阶段 | 交付物 | 状态 |
| --- | --- | --- |
| 1. 基础架构 | Electron/Vite/React/TS、sandbox preload、单实例、托盘、workspace 兼容存储 | 已完成 |
| 2. 设计系统 | shadcn/ui + Radix 封装层、CSS Token、浅深主题、Lucide 图标、命令面板和 Toast | 已完成 |
| 3. 核心领域 | 概览、任务、便签、项目、链接/启动器、搜索、剪贴板、项目子事项/导出 | 已完成 |
| 4. 系统能力 | 文件搜索、桌面收纳、系统检测、统计、启动项、备份恢复、更新 IPC | 基本完成 |
| 5. 高级交互 | 截图编辑/贴图、多屏区域覆盖层、9 类小组件、快捷键设置浮层、任务提醒和重复提醒 | 已完成 |
| 6. 对齐验收 | WPF 功能矩阵、Playwright/Electron 视觉回归、安装/升级/卸载和 portable 验收 | 已完成 |

阶段状态只表示当前代码证据，不代表“功能全部对齐”。每次合并前必须同步更新本表和下方功能矩阵。

## 目标与边界

- 在 `refactor/electron` 分支新增 Electron + React + TypeScript 实现，最终对齐当前 WPF 版本的全部用户功能。
- 旧 WPF 源码不再作为本分支运行入口；workspace 数据字段和旧版导入逻辑保持兼容。
- 首要发布平台为 Windows 10/11 x64，交付 NSIS 安装包和 portable 包。
- 继续兼容 `%LocalAppData%\\DustDesk.Next\\Data\\workspace.json`、`.bak` 备份和旧版数据导入。

## 运行时分层

### Electron 主进程

- 负责单实例、托盘、窗口生命周期、全局快捷键、通知和安全 IPC。
- 负责剪贴板监听、截图捕获、贴图窗口、桌面小组件窗口、系统指标、启动项、更新和文件系统操作。
- Windows 专属能力通过 `native/windowsBridge` 统一封装；渲染进程不直接访问 Node、文件系统或系统 API。
- 所有 IPC 通道使用白名单、参数校验和统一错误结构。

### React 渲染进程

- 负责工作台导航、页面状态、表单、列表、筛选、命令面板和视觉反馈。
- 复杂画布交互单独实现：截图编辑器、桌面 Widget 容器、文件拖拽整理预览。
- 状态层保持领域模块隔离，页面组件不能直接调用 Electron API，只能调用类型化的 preload API。

## UI 组件与设计系统

### 组件依赖

- 使用 `shadcn/ui` 作为可维护的组件源码基础，不直接采用其默认视觉主题。
- 使用 `Radix UI` 提供 Dialog、Popover、DropdownMenu、Tabs、Tooltip、ContextMenu、Checkbox、Switch、Slider 等交互和无障碍行为。
- 使用 `Tailwind CSS + CSS Variables` 实现 DustDesk 设计 Token、布局和主题切换。
- 使用 `lucide-react` 作为统一图标库，按钮优先使用图标并配合 Tooltip。
- 使用 `cmdk` 实现 `Ctrl+K` 全局搜索和命令面板。
- 使用 `sonner` 或同等轻量 Toast 实现保存、备份、截图和错误反馈。

当前根目录 `package.json` 已锁定的基础包：`@radix-ui/react-dialog`、`@radix-ui/react-dropdown-menu`、`@radix-ui/react-scroll-area`、`@radix-ui/react-slot`、`@radix-ui/react-tooltip`、`class-variance-authority`、`clsx`、`tailwind-merge`、`lucide-react`、`cmdk`、`sonner`。后续新增组件必须优先从这套基础组合封装，不能在页面中散落第三方组件调用。

### 组件边界

- 组件库只用于 React 渲染层，不进入 Electron 主进程、preload、Windows bridge 或数据层。
- 不引入 Ant Design、Material UI 等完整视觉库，避免默认后台风格和 Material 风格覆盖苹果式设计。
- 截图编辑器、桌面小组件画布、文件整理拖拽和可调整窗口使用自定义组件。
- 所有通用组件二次封装到 `renderer/src/components/ui`，业务页面不直接依赖第三方组件细节。

### 苹果风格规则

- 默认浅色并支持深色和跟随系统，所有颜色通过语义 Token 管理。
- 使用克制的半透明材质、细边框、低强度阴影和较小圆角；禁止渐变装饰、纯装饰性卡片嵌套和营销式 Hero。
- 页面采用高留白的侧栏 + 工具栏 + 内容栅格，重复操作优先保证密度和扫描效率。
- 所有交互包含 hover、pressed、focus-visible、disabled、loading、empty、error 状态。
- 支持键盘导航、屏幕阅读器标签和 `prefers-reduced-motion`。

## 功能迁移矩阵

- 工作台：概览、导航、全局搜索、命令解析、快速创建任务/便签。
- 任务：日期视图、全部/未完成/逾期、标签、备注、提醒、重复提醒、稍后提醒、完成和删除。
- 便签：创建、编辑、全文搜索、颜色、字体、背景图、透明模式、图片模式和桌面固定。
- 项目：项目/阶段/子事项、状态、进度、转换为任务和导出。
- 启动器与链接：应用、文件、目录和 HTTP/HTTPS 链接的增删改查、打开和桌面固定。
- 桌面收纳：分类、拖入、智能分类、执行预览、冲突保护、跨磁盘校验、多级撤销和恢复到桌面。
- 剪贴板：文字/图片监听、搜索、筛选、固定、锁定、复制和转任务/便签。
- 搜索：任务、便签、项目、链接、启动器、分类和文件；兼容 `todo`、`task`、`note`、`clip`、`open` 命令。
- 截图：区域/窗口/全屏、延时、画笔、线条、箭头、形状、文字、序号、马赛克、模糊、橡皮擦、复制、保存和贴图。
- 小组件：任务、便签、项目、启动器、链接、搜索、剪贴板、监控和收纳；支持位置、大小、透明、置顶、锁定、折叠和布局预设。
- 系统与维护：CPU、内存、网络、磁盘、空间、延迟、运行时长、工作日倒计时、统计、启动项、备份恢复、数据目录和更新。

## 数据与安全契约

- preload 暴露 `loadWorkspace`、`saveWorkspace`、`openPath`、`openUrl`、`clipboard.*`、`screenshot.*`、`widgets.*`、`organizer.*`、`search.*`、`system.*`、`updates.*` 等类型化方法。
- 保存使用临时文件 + JSON 校验 + 原子替换；失败时保留原文件并显示可重试错误。
- Electron 读取并保留 WPF JSON 中未知字段，避免双轨运行时数据丢失。
- `contextIsolation: true`、`nodeIntegration: false`、受限 preload、IPC 参数校验和窗口导航白名单必须作为启动条件。

## 剩余功能迁移矩阵（本轮）

| 功能 | Electron 实现 | 验收状态 |
| --- | --- | --- |
| 任务标签、标签预设、提醒稍后执行 | `renderer/src/main.tsx` 复用 `TagPresets` 与 `ReminderAt` | 已实现，待专项 E2E |
| 便签创建任务、清除背景、固定/取消固定 | `renderer/src/main.tsx`、`preload/index.ts`、`main/index.ts` | 已实现，待专项 E2E |
| 项目/阶段/子事项路径、日期、转任务、固定 | `renderer/src/main.tsx`、类型化路径 IPC | 已实现，待专项 E2E |
| note/project 独立小组件窗口 | `main/index.ts`、`renderer/src/main.tsx` | 已实现，待专项 E2E |
| 全局搜索链接、启动器、分类、阶段和子事项 | `renderer/src/main.tsx` | 已实现，待专项 E2E |
| 月薪、发薪日、目标日配置 | `renderer/src/main.tsx` | 已实现，待专项 E2E |

## 当前执行状态

- 已完成：Electron 工程、苹果风格设计系统、workspace 兼容存储、安全 preload、核心页面 CRUD、任务提醒/逾期筛选/重复提醒、项目阶段子事项增删改/完成、项目 CSV/XLSX 导出、便签视觉字段和背景图片、托盘/单实例、剪贴板监听、文件搜索、桌面收纳分类新增/删除恢复/合并/排序/恢复全部/多级撤销、系统指标、统计、启动项、备份恢复、截图多屏区域覆盖层/基础编辑/保存/贴图、9 类桌面小组件（任务/便签/项目/启动器/链接/剪贴板/收纳/搜索/监控）、更新检查/下载/安装 IPC 和设置入口。
- 已完成：Electron 工程、苹果风格设计系统、workspace 兼容存储、安全 preload、核心页面 CRUD、任务提醒/逾期筛选/重复提醒、项目阶段子事项增删改/完成、项目 CSV/XLSX 导出、便签视觉字段和背景图片、托盘/单实例、剪贴板监听、文件搜索、桌面收纳分类新增/删除恢复/合并/排序/恢复全部/多级撤销、系统指标、统计、启动项、备份恢复、截图多屏区域覆盖层/基础编辑/保存/贴图、10 类桌面小组件（任务/便签/项目/启动器/链接/剪贴板/收纳/搜索/监控/下班倒计时）、更新检查/下载/安装 IPC 和设置入口；系统指标已覆盖网络收发、磁盘读写、所有可用磁盘和 Ping，截图偏好已接入延时/格式/保存目录/自动复制/历史记录/贴图透明度。
- 已完成：完整 WPF 功能矩阵逐入口审计；启动器系统菜单、链接/启动器编辑、搜索小组件 DockEdge 胶囊交互、系统指标、截图高级标注和错误边界均已有实现与验证证据。
- 发布状态：Electron 已成为本分支唯一入口；安装、升级、卸载和 portable 验收继续由根目录脚本维护。

## 完成定义

一项功能只有同时满足以下条件才可标记为“已完成”：

1. WPF 对应入口、正常流程、空状态、错误状态和持久化行为均有 Electron 实现。
2. 通过类型检查、构建和相关契约/领域测试；涉及窗口或系统能力时增加打包后烟测。
3. 浅色、深色、窄窗口和键盘操作下无布局溢出，交互状态符合设计 Token。
4. 功能矩阵记录验证日期、测试命令和已知差异；未满足的项目必须保留在“进行中/未完成”。

## 验收与测试

- 单元测试覆盖 JSON 兼容/备份恢复、领域 CRUD、命令解析、整理冲突/撤销、截图标注撤销重做和 IPC 校验。
- Playwright/Electron 测试覆盖首次启动、旧数据加载、导航、CRUD、主题切换、托盘唤醒、全局快捷键、截图、剪贴板和小组件。
- 在 1280x800、1920x1080、窄窗口、浅色和深色主题下执行视觉回归截图。
- Electron 工程必须通过类型检查、构建、契约测试和安装包启动检查；本分支不再包含可运行的 .NET/WPF 测试工程。
- 完成定义：功能矩阵、旧数据兼容、安装包和 portable 验收由 Electron 根工程持续维护。

### 最近一次验证（2026-08-22）

- `npm run typecheck`：通过。
- `npm test`：5/5 根目录 Electron 契约测试通过。
- `npm run build`：通过，主进程、preload 和 renderer 产物均生成。
- `dotnet test --no-restore`：不再适用，WPF 工程和旧测试目录已从本分支移除。
- Electron 契约测试：5/5 通过，检查根目录唯一入口、安全 preload、workspace 持久化兼容字段、对象小组件键和无 dotnet 脚本依赖。
- `npm run e2e`：通过，覆盖概览、任务新增、深色主题、窄窗口、浮动按钮不重叠和小组件预设面板，并生成 `test-artifacts/overview-1280.png`、`settings-dark-1280.png`、`projects-narrow.png`、`widget-picker-narrow.png`。
- `npm run e2e:widgets`：通过，第一进程保存布局预设，第二进程重新启动读取并删除，验证跨重启持久化。
- `npm run e2e:organizer`：通过，隔离临时桌面中执行真实拖拽收纳、右键菜单、智能收纳，跨进程连续撤销两次并验证文件恢复；测试同时隔离 Electron userData，避免单实例锁串扰。
- `npm run e2e:visual-special`：通过，实际全屏截图渲染编辑器画布并生成 `test-artifacts/screenshot-studio-fullscreen.png`，打开独立任务小组件并生成 `test-artifacts/widget-todo-window.png`。
- `npm run e2e:update`：通过，本地 HTTP generic feed 提供实际 portable 文件和 SHA-512，验证 packaged Electron 检查到 `2.0.1` 并完成下载。
- `npm run dist`：使用根目录源码和本地 Electron 运行时生成 Windows NSIS 与 portable 产物。
- NSIS 安装验收：静默安装到 `release/test-install` 成功，已安装程序启动 5 秒并生成 workspace 数据，静默卸载后安装目录已移除。
- NSIS 升级验收：同一隔离目录连续静默安装两次均返回 0，第二次安装后程序可启动，随后卸载成功。
- 已完成安装包安装/升级/卸载、portable 启动、核心和专项视觉回归、本地更新检查/下载、真实收纳拖拽/上下文菜单/多级撤销、恢复点列表和帮助/关于入口，以及 `node tests/widget-dock.mjs` 的真实 DockEdge 运行时验证。核心重构已完成；剩余矩阵需专项 E2E 全部通过后才可宣称功能迁移完成。

