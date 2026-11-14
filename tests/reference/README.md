# Historical behavior reference

These frozen TypeScript modules are used only by mocked Node tests and Rust/Tauri parity tests. No Electron runtime is installed or launched by the application build. They preserve the previous behavior for regression comparisons while the application source lives in `src-tauri` and the shared React renderer.

Reference shared modules are intentionally frozen with the old implementation. Do not import these files into the application.

旧双运行时草稿交接和来源认证集成脚本保留为历史记录，不属于当前产品开发或验收命令。截图功能的外部窗口已改用 WinForms，Canvas 与 Worker 对照使用独立浏览器，项目 CSV/XLSX 对照在纯 Node mock 中执行，不需要安装或启动 Electron。
