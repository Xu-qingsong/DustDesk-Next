# Electron 维护会话到隔离运行宿主

## 范围与入口

- 开发版“文件 → 验证隔离运行交接（开发临时数据）”复用实际 Electron 主窗口 Session、全部编辑窗口保存屏障、工作区独占和原生组合快照。仅允许系统 TEMP 下 `dustdesk-runtime-preview-*` 直接子目录中的同级 Data／profile；当前 Session 必须是该完整 profile。打包版没有此菜单，客户端和原生入口也独立拒绝生产目录。
- 原安装目录仍由系统选择器取得，参考代码须匹配编译内置信任记录；读取草稿使用现有空白受控页面，不执行原 EXE／ASAR 页面脚本。当前准备 Electron 的 file URL 存储可能共享，选择原安装路径不证明历史用户 profile。
- 入口由主进程生成新的同级组合快照和实际运行 Data 目录，不接受 renderer 提供路径、事务、归档或回执。它没有增加公共业务 API，也没有切换正式入口、版本或生产数据。

## 持续维护与退出顺序

- 所有编辑器先保存并冻结，工作区队列封存后排空和销毁原 LAN 服务；期间不允许重新创建 LAN 服务。原生持有来源、完整快照、原 LAN 状态和实际运行所有权，接着在同一进程建立新 WebView2 profile。
- 客户端核验实际运行 Data 的准备／重复验证回执和物理身份。收到 `runtimeBrowserStarting` 后，核对新 profile 路径、原生物理身份、固定 origin 和所有权 ID，并再次核验当前 Electron Session 与原工作区独占，才发送 `continueRuntime`。
- `runtimeBrowserReady` 必须属于同一所有权，且继续声明 `businessServicesStarted=false`、`productionReady=false`、`migrationComplete=false`。该响应不释放维护；“隔离运行草稿已核验”通知保持原编辑器和 LAN 冻结，直到用户选择结束或维护被取消。
- 宿主运行期间，客户端每 200 ms 重新检查实际 Session、目录和原工作区独占；原维护屏障继续监控全部参与窗口的重载／退出。原生同时监督其来源与目标句柄。客户端不能继续发送已消费来源的 RPC。
- 正常结束先关闭 stdin，让原生监督退出；最多等待五秒，仍未结束才终止子进程。取消、参与窗口失效、协议错误或宿主提前退出关闭等待通知并撤权。两条路径均等待真实子进程 `close`，再结束维护并恢复编辑器和原 LAN；LAN 恢复失败明确提示，不伪称已经恢复。最长五分钟的维护时限继续有效，不自动续期。
- 已经写入的原生准备、授予和草稿决定保留，失败不删除／合并目标或猜测回滚。原 Electron 没有向新宿主开放普通编辑器或业务服务，因此结束此验证可以恢复原应用，但不代表完整生产回退已实现。

## 验证

- `npm run e2e:electron:runtime-bootstrap` 构建并验证真实 Electron → 原生来源快照／实际 Data → 同进程 WebView2。测试使用精确官方参考代码和隔离数据，原 LAN 仅在测试进程中绑定回环地址；读取真实 Session 与小组件草稿，并通过 CDP 读回实际新浏览器内容。
- 场景验证显式结束、菜单取消、宿主异常终止、参与窗口重载、真实 Electron 主进程终止后的通道 EOF 与重启，以及普通临时数据根在启动前被拒绝；运行场景检查等待期间主窗／小组件冻结、工作区／LAN 操作被拒绝、原资产保持固定，以及退出后的原草稿、设备身份和已经完成的原生决定保持不变。
- `npm run check:electron:runtime-bootstrap` 冻结源码／配置／测试，串行执行 `check:silent`、主进程 TypeScript、实际 Debug 构建和本专项、已有 Electron 来源快照／来源租约专项，复制原生证据并复核日志和 EXE 摘要。该入口只覆盖列出的套件，不代替全部 Rust／原生、物理网络或发布验收。
- 首轮测试直接读取运行期仍被独占固定的快照而收到 `EBUSY`，改为运行期核对浏览器、退出后核对归档；随后两轮把维护中的工作区读取／保存拒绝当成可成功的返回值，已改为断言现有异常拒绝。原始失败日志和报告保留，不放宽产品独占或维护门闩。
- 首次六场景冻结在客户端终止场景失败：当前 Windows Playwright 的 `electronApp.process()` 是启动 Electron 的外层 `cmd.exe`，终止外壳后 Electron 主进程和来源通道仍然存活，不能据此判定撤权失效。测试改为在真实 Electron 内取得 `process.pid`，只终止该主进程并核验它已退出，再等待原生宿主因 EOF 结束；不使用同时终止宿主的进程树结束来代替通道验证。失败报告／日志保留于 `artifacts/tauri-migration/electron-runtime-bootstrap-frozen-client-exit-failure/`，后续通过仍须以修正后最终冻结结果为准。

## 最终记录

- 2026-11-13 20:12（北京时间）最终冻结通过：558 项输入、六步、230 项 Node、4 项无窗口、主进程 TypeScript、实际 Tauri Debug 构建和三套／26 项真实集成测试。新增六场景／7 项全部通过；原来源快照 9 项和原来源租约 10 项通过。真实主进程终止记录分别包含启动外壳、Electron 主进程和原生宿主 PID，并在宿主退出后重新打开原 Session，验证原草稿与 LAN 身份。
- `artifacts/tauri-migration/electron-runtime-bootstrap-final/verification.json` 及 `evidence-audit.json` 绑定全部输入、逐步日志、原生证据副本和当前构建产物摘要；`change-scope.json` 列出相对上一轮输入的五项新增／修改，原生源码与配置未变。当前 EXE 为重新构建的不同摘要产物，本轮没有重跑全部 Rust、Clippy、Release 或全部既有原生套件，不把旧执行计入本轮数字。
- 20:13 的 `process-cleanup.json` 只读核验项目 Electron／Tauri、隔离 WebView2、相关集成执行进程和本轮新建相关 TEMP 目录均无残留；历史目录保留，未清理用户剪贴板或无关应用。原始三轮夹具失败和首次终止场景冻结失败继续保留。默认入口仍为 Electron，版本 1.0.2，未提交、推送或发布。

## 剩余切换工作

- 后续新增独立的“验证原 LAN 隔离交接”入口，将 [原 LAN 交接内核](ORIGINAL_LAN_HANDOVER.md) 接入实际维护会话，并增加持久重启屏障与显式原生交还恢复，详见 [原 LAN 隔离运行](ORIGINAL_LAN_RUNTIME.md)。本页原“验证隔离运行交接”入口继续只验证草稿，保持原 LAN 冻结至宿主退出。

- 本入口只连接隔离宿主，原 LAN 身份／服务正式移交、普通业务编辑器／后台服务开放、生产来源选择与历史 profile 认证仍未完成。
- 整体持久切换决定、原运行时退出／恢复、跨会话继续同一运行授予和完整回退尚未由此菜单提供。原生单独 profile 恢复验证见 [隔离运行启动](RUNTIME_BROWSER_BOOTSTRAP.md)，不能替代上述整体协议。
- 物理双机、混合 DPI／IME、长期资源释放、Release 性能、WebView2 缺失和安装包／实际绿色 ZIP 验证继续按 [迁移计划](TAURI_MIGRATION_PLAN.md) 执行。
