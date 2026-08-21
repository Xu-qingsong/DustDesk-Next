# DustDesk Next

一个面向 Windows 的本地桌面工作台。它把桌面整理、待办任务、便签、项目管理、快捷启动、链接、剪贴板历史、文件搜索和桌面小组件集中到一个轻量应用中。


## 功能

- **任务**：按日期、全部、未完成或逾期查看；支持标签、备注、提醒、重复提醒、稍后提醒和托盘通知。
- **便签**：多便签、全文搜索、颜色和字体设置、背景图片、透明背景、图片模式和桌面固定。
- **项目**：项目、阶段和子事项管理；阶段或子事项可以直接转换为任务。
- **桌面整理**：智能识别文件类型、移动到分类、执行前预览、冲突保护、跨磁盘校验、多级撤销和恢复到桌面。
- **剪贴板**：监听文字和图片，支持搜索、类型筛选、固定、锁定、复制，以及转换为任务或便签。
- **快速搜索**：支持任务、便签、项目、链接、启动器、分类和文件搜索；支持命令 `todo`、`task`、`note`、`clip` 和 `open`。
- **快捷启动与链接**：管理常用应用、文件、目录和 HTTP/HTTPS 链接，并支持桌面小组件。
- **系统监控**：CPU、内存、网络、磁盘读写、磁盘空间、延迟和运行时长。
- **桌面小组件**：任务、便签、项目、启动器、链接、搜索、剪贴板、监控和收纳组件；支持位置、大小、透明、置顶、锁定、折叠和布局方案。
- **本地备份**：JSON 原子保存、损坏文件隔离、自动恢复点、操作前安全点、备份恢复和失败回滚。

## 快速搜索命令

在快速搜索窗口中输入以下命令并按回车：

```text
todo 准备周报       创建任务
task 修复登录问题   创建任务
note 会议纪要       创建便签
clip                打开剪贴板页面
open C:\\Work       打开文件或目录
```

## 技术栈

- .NET 10
- WPF
- WPF-UI 4.3 / Fluent 2
- CommunityToolkit.Mvvm
- Microsoft.Extensions.DependencyInjection
- System.Text.Json
- Windows Shell、托盘、全局快捷键、剪贴板监听和系统性能计数器

## 环境要求

- Windows 10 或更高版本
- .NET 10 SDK
- 可选：Everything 的 `es.exe`，用于提升文件搜索速度

## 构建与运行

在当前项目目录执行：

```powershell
dotnet restore .\DustDesk.Next.slnx
dotnet build .\DustDesk.Next.slnx -c Debug
dotnet run --project .\DustDesk.Next.csproj
```

Release 构建：

```powershell
dotnet build .\DustDesk.Next.slnx -c Release --no-restore
```

## 数据位置

默认数据目录：

```text
%LocalAppData%\DustDesk.Next\Data
```

主要文件和目录：

```text
workspace.json          工作区数据
workspace.json.bak      最近一次有效备份
ClipboardImages         剪贴板图片
NoteBackgrounds         便签背景图片
```

应用还会在以下位置生成自动恢复点：

```text
%LocalAppData%\DustDesk.Next\Backups
```

首次启动时，程序会尝试从旧版 `%AppData%\DustDesk\Data` 导入数据，不会修改旧项目或旧数据文件。

## 快捷键

- `Ctrl+K`：打开快速搜索
- `Ctrl+Shift+K`：显示或隐藏主窗口
- `Ctrl+Shift+D`：显示或隐藏配置的小组件

快捷键可以在设置页中修改。

## 目录结构

```text
Models/       数据模型和默认状态
Services/     存储、备份、Shell、系统能力和小组件生命周期
ViewModels/   页面状态、命令和业务协调
Views/        主窗口、页面和对话框
Widgets/      可固定到桌面的组件内容
Themes/       颜色和控件样式
Converters/   WPF 显示转换器
Controls/     自定义控件
```

## 项目状态

当前项目处于持续开发阶段。核心功能已经可以构建和运行，Release 构建及现有自动化测试均已验证通过。桌面整理会真实移动文件，使用前建议先确认数据目录和备份设置。

## 致谢

特别感谢原项目作者 [Abyxs](https://github.com/Abyxs) 及 [DustDesk-Desktop-Manager](https://github.com/Abyxs/DustDesk-Desktop-Manager) 提供的产品思路和功能基础。

