# 当前 Tauri 分支

- 产品由 Rust + Tauri 2 启动，保留 React 页面与工作区 JSON 格式。Electron 已退出产品依赖和构建。
- 后台专注、任务提醒、剪贴板与局域网服务由 Rust 管理，启动到托盘时不创建主窗口；原生通知点击可打开主窗口。
- 下文的 ASAR、Electron 和内存采样结果是旧框架的历史记录，不能用作当前 Tauri 产物的内存结论。

# 常驻内存优化与验证

## 行为

- 启动到托盘时不创建主窗口；从托盘或快捷键打开时再加载界面。
- 总览页没有未提交的任务、搜索内容、弹窗或已访问的工具页面时，收起主窗口会先提交待保存内容，再销毁窗口。重新打开时从工作区重建总览。
- 编辑页面、未提交输入、工具箱与截图草稿保留窗口，避免为释放内存而丢失内容。因此这些场景以及多个小组件、图片处理、系统监控和局域网服务启用后，仍可能超过 100 MiB。
- 快速记录收起前保存本地草稿并释放窗口，再次打开恢复草稿；保存失败保留窗口并提示。
- 剪贴板记录由主进程排队保存并广播，不依赖主窗口存在；保存失败可在剪贴板内容不变时重试。
- Excel 导出、系统信息、ZIP 打包与局域网服务按需加载；已开启的局域网服务仍会自动恢复。未开启服务时不生成 TLS 证书。各小组件只加载对应界面。
- React、Radix 等只用于构建渲染界面的依赖归入开发依赖，避免将其源码及元数据重复打进 ASAR；主进程运行时依赖仍完整打包。

## 测量方法

运行 `npm run check:silent`，再运行 `node tests/memory-regressions.mjs`。测试使用独立工作区与用户目录，不修改系统剪贴板，只替换测试进程的剪贴板读取函数。

Windows 采样汇总应用所有子进程的 `Win32_PerfRawData_PerfProc_Process.WorkingSetPrivate`，采用任务管理器常用的专用工作集口径；MiB 按 1024² 字节计算。不能累加进程总工作集当作任务管理器内存，因为这会重复计算共享内存。

测试先验证带调试连接的真实 Electron 工作流，再启动一个无调试连接的普通进程测量后台小组件。可通过 `DUSTDESK_PRESET_EXECUTABLE` 指定本地打包程序，通过 `DUSTDESK_MEMORY_BASELINE_EXECUTABLE` 指定旧程序，对同一测试工作区比较。设置 `DUSTDESK_MEMORY_BUDGET_MIB=100` 时，还会断言普通进程的总专用工作集低于 100 MiB（旧程序对照不参与预算断言）。

2026-11-09 Windows x64 本机测量：普通启动、不附加调试器、相同测试配置、托盘运行并保留一个任务小组件，原 v1.0.2 绿色版为 149.82 MiB，最终本地打包程序为 87.36 MiB，约降低 42%，通过 100 MiB 预算断言。应用代码 ASAR 从 65,091,322 字节减至 18,445,871 字节，索引从 2,342,216 字节减至 104,484 字节。数值随运行时间、工作区内容、窗口数量和系统环境变化，这不是所有功能运行时的内存上限。

## 验证范围

- `npm run check:silent`：类型检查、114 项单元测试、生产构建、4 项无窗口界面回归，无跳过。
- `node tests/memory-regressions.mjs`：托盘启动不创建界面、后台剪贴板与失败重试、快速记录草稿回收和恢复、主窗口回收与重建、未提交任务阻止回收、小组件持续运行。
- `node tests/productivity.mjs`、`node tests/optimization-regressions.mjs`、`node tests/widget-linkage-native.mjs`、`node tests/screenshot-regressions.mjs`：快速记录、编辑与冲突保护、备份、监控、文件搜索、项目/便签/收纳同步、截图和贴图。
- 本地 Windows x64 目录包：通过 `tests/package-smoke.mjs`（含真实 Excel 导出）、100 MiB 预算内存回归、`tests/optimization-regressions.mjs`、`tests/toolbox-native.mjs`。验证打包后的依赖、首次启用 TLS 配对、文件/文件夹/文本传输、后台接收、占用文件重试与正常退出。

本次优化未递增发布版本，未推送或创建 GitHub Release。
