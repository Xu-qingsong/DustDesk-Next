# DustDesk 重构迁移矩阵

## 边界

- 旧 WinForms 项目保持不变；新版本只位于 `DustDesk.Next`。
- 不复制旧版大型 `MainForm.cs`，按 Models、Services、ViewModels、Views、Widgets 拆分。
- 数据继续保存在本机 JSON。按用户要求，新版本固定使用 `%LocalAppData%\DustDesk.Next\Data`，不继续提供可变数据目录。
- 桌面恢复遇到同名目标时拒绝覆盖并保留源文件；这是相对旧版“可确认覆盖”的安全收紧。
- UI 已替换为 WPF-UI 4.3 提供的 Fluent 2 窗口基础与紧凑工作台样式；ViewModel、命令、服务、模型和持久化格式保持不变。

## 功能对照

| 旧版能力 | 新版实现 | 状态 |
| --- | --- | --- |
| 首页统计、快速任务、快速记录、自定义名称 | Dashboard + Workspace + 设置中的工作台名称 | 完成 |
| 任务增删改、完成、标签、备注、提醒、详情 | TasksViewModel、TodoReminderService | 完成 |
| 按日期查看任务、日历切换、桌面日期与农历 | TasksViewModel + TasksView + TodoWidgetView | 完成 |
| 自定义标签自动保存、颜色预设与颜色显示 | TasksViewModel + TagPresetRecord | 完成 |
| 多便签、重命名、颜色、透明、字体、背景图、仅图片 | NotesViewModel、NotesView、NoteWidgetView | 完成 |
| 多项目、阶段、状态、日期、进度、子事项、路径 | ProjectsViewModel + 项目组件 | 完成 |
| 单项目拆分组件 | `project:{id}` 组件 | 完成 |
| 快捷启动拖放、编辑、Shell 图标、最多 5 项 | LaunchersViewModel + FileIconConverter | 完成 |
| 超链接分组、名称/网址/备注、打开、搜索和桌面组件 | LinksViewModel + LinksView + LinksWidgetView | 新增完成 |
| 桌面/收纳目录中的快捷方式持久保存 | 本地 `Data\Launchers` 副本 | 完成 |
| Everything 搜索、目录回退、打开位置 | SearchService + 原生 Shell 菜单 | 完成 |
| 搜索快捷启动、分类、任务、便签、项目及定位管理页面 | SearchViewModel + ShellViewModel | 完成 |
| 搜索来源和自定义目录管理 | SettingsViewModel | 完成 |
| 剪贴板文字/图片、固定、锁定、复制、清理、刷新 | ClipboardMonitorService + ClipboardViewModel | 完成 |
| CPU、内存、网络、磁盘读写/空间、延迟、运行时长 | SystemMetricsService + SystemMonitorViewModel | 完成 |
| 监控指标显示开关 | AppSettings + 主页面/组件绑定 | 完成 |
| 桌面分类、移动、恢复、重命名、折叠、排序、合并 | OrganizerService + OrganizerViewModel | 完成 |
| 智能扫描桌面、跳过应用并按文件类型自动分类 | SmartOrganizerClassifier + OrganizerViewModel | 完成 |
| 全部收纳一键恢复、同名冲突保留源文件 | OrganizerViewModel + SettingsViewModel | 完成 |
| 多分类拆分/合并桌面组件及跨分类拖放 | `organizer-group:{id}` 组合组件 | 完成 |
| 原生文件图标和 Windows 右键菜单 | FileIconConverter + ShellContextMenuService | 完成 |
| 组件位置、尺寸、锁定、置顶、透明、折叠、10 秒自动折叠 | DesktopWidgetWindow + WidgetPlacementRecord | 完成 |
| 启动器吸附、名称显示和图标尺寸 | AppSettings + LauncherWidgetView | 完成 |
| 收纳名称显示和图标尺寸 | AppSettings + OrganizerWidgetView | 完成 |
| 指定全局快捷键控制的组件 | DesktopHotKeyWidgetKeys + WidgetManager | 完成 |
| 主窗口拖动、收起、全屏/还原和关闭到托盘 | MainWindow + App 生命周期 | 完成 |
| 桌面组件统一透明度与背景色盘 | AppSettings + SettingsViewModel + WidgetManager | 完成 |
| 托盘、单实例、开机启动、启动后隐藏 | App + TrayService + StartupService | 完成 |
| 每日自动恢复点、分层保留、操作前安全点、手动备份、恢复回滚、重置 | BackupArchiveService + DataMaintenanceService | 完成 |
| Excel 项目导出及路径超链接 | ProjectExportService | 完成 |
| GitHub Release 更新检查和 ZIP 安装 | UpdateService | 完成 |
| 操作简介、关于与反馈 | SettingsViewModel | 完成 |
| 旧配置和六类业务 JSON 导入 | LegacyDataImporter | 完成 |

## 旧数据映射

- `config.json`：名称、搜索、快捷键及目标组件、组件外观和位置、监控项、分类及组合组件。
- `todo.json`：任务、标签、备注、完成状态和提醒状态。
- `note.json`：内容、颜色、字体、背景图、仅图片和时间。
- `project.json`：项目、阶段、日期、状态、进度、子事项和路径。
- `launch.json`：启动项名称和路径。
- `clipboard.json`：文字、图片、固定和锁定状态。

特殊组件加载后会把列表记录与位置字典统一为同一对象，避免便签或组合组件的位置出现双份状态。

## 验证证据

截至 2026-07-23 已执行：

- Debug 构建：0 警告、0 错误。
- 主窗口真实启动、页面导航、系统监控采样、设置页和 `Ctrl+K` 搜索窗检查。
- 主窗口关闭到托盘，再由 `Ctrl+Shift+K` 恢复。
- 任务组件与双分类组合组件真实创建并回写尺寸，测试后恢复隐藏配置。
- JSON 原子往返、损坏文件隔离恢复和完整默认状态。
- 旧配置名称、快捷键目标、外观、吸附和组合组件映射。
- 收纳分类重命名、合并、排序及同名冲突保留源文件。
- 每日恢复点去重、7 个日备份加 4 个周备份保留、完整数据归档、ZIP 路径穿越拒绝和恢复点界面绑定。
- 自定义搜索目录、系统指标和快捷键解析。
- 应用内任务搜索、日期筛选、标签颜色和当天任务视图。
- 主窗口、快速搜索窗、桌面组件及全部主要页面执行真实 WPF 实例化、布局和离屏渲染，未出现绑定异常、控件重叠或缺失入口。
- 收纳恢复、占用文件阻止、失败日志以及跨盘复制内容校验。
- 到期任务托盘提醒及已通知状态写回。
- Excel 工作簿由独立解析器导入并渲染；日期和百分比为数值类型，三类路径为外部超链接，公式错误扫描为 0。

可重复质量门禁：

```powershell
dotnet format "DustDesk.Next\DustDesk.Next.slnx" --verify-no-changes --no-restore
dotnet build "DustDesk.Next\DustDesk.Next.slnx" -c Debug --no-restore
dotnet build "DustDesk.Next\DustDesk.Next.slnx" -c Release --no-restore
```
