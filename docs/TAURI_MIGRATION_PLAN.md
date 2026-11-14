# DustDesk Rust + Tauri 2 框架替换

当前分支按用户要求直接替换 Electron，保留原有 React 界面、功能和工作区数据格式。旧双运行时交接协议与来源冻结实验仅保留为历史记录。

## 产品结构

- `src-tauri/src`：Rust 工作区存储、后台服务、Windows 系统能力、托盘、窗口和生命周期。
- `src/renderer`：原有 React 页面、小组件、截图编辑器和浏览器 Worker。
- `src/renderer/src/runtime`：按主窗口、小组件、截图、贴图和快速记录适配类型化 API。
- `tests/reference`：不进入产品构建的旧行为参考，仅在 Node mock 中执行。
- Electron、electron-vite 和 electron-builder 不再是产品依赖；默认开发、构建和打包命令均使用 Tauri。

## 功能与数据

- 工作区、备份和图片资产默认使用 `DustDesk.exe` 同级的 `Data`，开发模式使用项目根目录下的 `Data`，不受启动工作目录影响，不回退到 AppData。保留未知 JSON 字段及原子保存规则；旧 AppData 数据可通过备份恢复导入。
- 保留任务、便签、项目、资源、剪贴板、桌面收纳、截图贴图、工具箱、局域网传输、系统监控和快捷键。
- Rust 后台处理任务提醒、专注完成、剪贴板监听、备份与局域网服务；关闭或收起主窗口后继续运行。
- 保留保存失败提示、退出前提交、退出取消、多窗口同步、托盘常驻、启动时隐藏和单实例唤起。
- 原 Electron 浏览器中尚未提交的草稿不属于磁盘工作区；切换前应在旧版完成保存。新应用使用独立 WebView2 profile，保留自身重启与冲突草稿恢复。

## 验证与交付

- `npm run check:silent`：TypeScript、Node 测试、前端构建和 Rust 全目标测试。
- `cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings`：Rust 严格静态检查。
- 真实 Tauri / WebView2 回归覆盖原有页面、组件、原生对话框、后台服务和跨窗口生命周期。
- 截图的外部窗口使用 WinForms，Canvas / Worker 使用独立浏览器，导出格式使用冻结 Node 参考；功能回归不启动 Electron。
- `npm run dist` 生成 Windows x64 NSIS 安装包、绿色 ZIP 和 SHA256SUMS。校验实际 Release 程序和实际 ZIP 解压后的 `DustDesk.exe`，包含版本、顶部菜单、组件、保存、退出与重启。
- 按用户确认发布 v1.0.3：当前分支改名为 `v1.0.3`，同步现有 `main`；保留 v1.0.1 / v1.0.2 的标签和发布内容，再从发布基线创建仅本地的 `v1.0.4` 开发分支。

实际结果见 [迁移执行记录](TAURI_MIGRATION_PROGRESS.md)。
