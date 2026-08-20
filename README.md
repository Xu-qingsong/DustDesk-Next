# DustDesk Next

一个面向 Windows 的本地桌面工作台，集中提供桌面整理、任务、便签、项目、快捷启动、链接、剪贴板、文件搜索和桌面小组件。

推荐 GitHub 仓库名：`DustDesk-Next`

## 项目来源与参考

本项目参考并重构自 [Abyxs/DustDesk-Desktop-Manager](https://github.com/Abyxs/DustDesk-Desktop-Manager)。原项目是 C# / .NET / WinForms 版本；`DustDesk.Next` 是在保留核心使用场景和本地数据迁移方向的基础上重新实现的 .NET 10 WPF 版本。

旧版参考代码保留在仓库根目录，新版代码位于 `DustDesk.Next/`，测试位于 `DustDesk.Next.Tests/`。新版的界面、ViewModel、服务层、桌面组件和数据存储经过重新组织，并增加了快速命令、跨模块创建、任务筛选、剪贴板筛选、布局方案和桌面整理多级撤销等功能。

原项目的名称、代码和资源权利归原作者及其适用许可证所有。

## 主要功能

- 任务：按日期、全部、未完成或逾期查看，支持标签、备注、提醒和重复提醒。
- 便签：全文搜索、颜色和字体设置、背景图片、透明背景和桌面固定。
- 项目：项目、阶段和子事项管理，并可直接转换为任务。
- 桌面整理：智能分类、执行前确认、冲突保护、跨磁盘校验、多级撤销和恢复。
- 剪贴板：文字和图片历史、搜索、类型筛选、固定、锁定，以及转换为任务或便签。
- 快速搜索：文件和应用搜索，以及 `todo`、`task`、`note`、`clip`、`open` 命令。
- 桌面小组件：任务、便签、项目、启动器、链接、搜索、剪贴板、监控和收纳组件。
- 本地备份：JSON 原子保存、损坏文件隔离、自动恢复点、操作前安全点和失败回滚。

## 技术栈

- .NET 10 / WPF
- WPF-UI 4.3 / Fluent 2
- CommunityToolkit.Mvvm
- Microsoft.Extensions.DependencyInjection
- System.Text.Json
- Windows Shell、托盘、全局快捷键、剪贴板监听和性能计数器

## 环境要求

- Windows 10 或更高版本
- .NET 10 SDK
- 可选：Everything 的 `es.exe`，用于提升文件搜索速度

## 构建、运行和测试

```powershell
dotnet restore .\DustDesk-Next.slnx
dotnet build .\DustDesk-Next.slnx -c Debug
dotnet run --project .\DustDesk.Next\DustDesk.Next.csproj
dotnet test .\DustDesk-Next.slnx -c Release --no-restore
```

Release 构建：

```powershell
dotnet build .\DustDesk-Next.slnx -c Release --no-restore
```

## 数据位置

```text
%LocalAppData%\DustDesk.Next\Data
```

剪贴板图片保存在 `ClipboardImages`，便签背景保存在 `NoteBackgrounds`，自动恢复点保存在 `%LocalAppData%\DustDesk.Next\Backups`。首次启动会尝试从旧版 `%AppData%\DustDesk\Data` 导入数据，不会修改旧数据。

## 快捷键

- `Ctrl+K`：打开快速搜索
- `Ctrl+Shift+K`：显示或隐藏主窗口
- `Ctrl+Shift+D`：显示或隐藏配置的小组件

## 目录结构

```text
DustDesk.Next/       WPF 应用
DustDesk.Next.Tests/ 自动化测试
Models/              数据模型
Services/            服务和系统能力
ViewModels/          页面状态和业务协调
Views/               页面和对话框
Widgets/             桌面组件
```

## 许可证与致谢

当前仓库未附带独立许可证文件。公开发布前，请根据原项目许可证、代码来源和新增代码的授权情况补充合适的 `LICENSE` 文件，并确认发布内容符合原项目许可要求。

感谢原项目作者 [Abyxs](https://github.com/Abyxs) 及 [DustDesk-Desktop-Manager](https://github.com/Abyxs/DustDesk-Desktop-Manager) 提供的产品思路和功能基础。

完整迁移矩阵见 [DustDesk.Next/MIGRATION.md](DustDesk.Next/MIGRATION.md)。
