# debug-widget-open

Status: [OPEN]

## Symptom
- 用户反馈：桌面组件打不开了。

## Session
- Session ID: widget-open

## Hypotheses
- H1: `ShowWidget()` 中 `Activate()` 后立刻 `SendBehindNormalWindows()` 置底，窗口其实打开了但被压到所有窗口后面，用户看起来像没打开。
- H2: `WS_EX_NOACTIVATE` 与 `Activate()` / WinUI Window 显示流程冲突，导致窗口显示失败或立即失活隐藏。
- H3: `SWP_HIDEWINDOW` 隐藏后，再次显示时 `SWP_SHOWWINDOW` 没有正确恢复顶层窗口可见状态。
- H4: 最近深色玻璃 UI 改动导致窗口显示但透明度/颜色过低，在桌面背景上难以辨认。
- H5: 创建桌面组件时抛出异常或进程崩溃，但主窗口未明显提示。

## Evidence Plan
- 在桌面组件打开/隐藏/透明样式/置底流程加入临时诊断日志。
- 优先确认是否执行到 `ShowWidget.finish`，以及 HWND rect、visible style、exStyle 是否正确。

## Observation 1
- 用户运行首个诊断包后点击“桌面组件”，反馈仍看不到组件。
- Debug Server 健康检查显示 `log_count=0`。
- 结论：尚未进入 `DesktopOrganizerWidgetWindow.ShowWidget()` 的诊断点，或者点击没有触发到窗口管理链路；需要上移插桩到 `DesktopOrganizerWindowManager.ShowMain()`。

## Observation 2
- 用户运行第二个诊断包后点击“桌面组件”，反馈仍看不到组件。
- `/logs` 返回空数组，`log_count=0`。
- 结论：仍没有进入 `DesktopOrganizerWindowManager.ShowMain()` 诊断点。最可能原因是用户实际运行的不是诊断包，或发布路径混淆。下一步将诊断版本发布到正式目录，消除路径误用变量。

## Evidence Analysis
- 正式目录诊断包点击后收到 25 条日志。
- `WindowManager.ShowMain`、`DesktopOrganizerWidgetWindow.ShowWidget` 均已执行，排除按钮命令未触发和窗口未创建。
- 关键证据：`ShowWidget.finish` 中 `placement.X=-32000`、`placement.Y=-32000`，窗口矩形为 `Left=-32000, Top=-32000, Right=-31580, Bottom=-31496`。
- 根因：之前隐藏组件时把 placement 写成了屏幕外坐标；再次显示按已持久化的 `-32000,-32000` 打开，因此组件实际在屏幕外。

## Fix Plan
- 显示前如果检测到 placement 在屏幕外哨兵坐标，重置为可见默认坐标。
- 隐藏时只隐藏窗口，不再把 `-32000,-32000` 写入位置，避免污染持久化坐标。
