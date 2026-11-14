# Tauri 迁移执行记录

## 当前状态

- 发布分支：`v1.0.3`，版本 1.0.3；按用户确认同步 `main` 并发布，随后创建仅本地的 `v1.0.4`。v1.0.1 / v1.0.2 的历史标签与发布内容保持不变。本轮发布验证结果见下方发布记录。
- 按用户最新要求，当前分支直接用 Rust + Tauri 替换 Electron，保留原有 React 界面、工作区格式与功能行为，不继续扩展双运行时交还验证。
- `src/main`、`src/preload` 和 Electron 构建配置已退出产品源码，Electron、electron-vite、electron-builder 依赖已移除；旧实现只保存在 `tests/reference` 供模拟测试对照。
- 默认开发、前端构建、原生构建和打包流程已切换到 Tauri，当前直接框架替换已完成。保留原有 React 页面、功能范围与工作区 JSON 格式；数据目录按最新要求改为 EXE 同级的 `Data`，开发模式使用项目根目录下的 `Data`。旧双运行时交还实验不作为本次完成条件。
- 当前源码的 TypeScript、239 项 Node 测试、前端构建、557 项 Rust 测试通过；默认另有 2 项历史官方来源夹具和 1 项真实桌面图标测试 ignored，桌面图标测试已在本轮收纳专项中显式执行并通过。严格 Clippy 和 Rust 格式检查通过。
- 本轮真实 Tauri / WebView2 回归覆盖工作区编辑与退出、备份恢复、剪贴板、桌面组件、任务与专注、提醒、收纳、截图贴图、工具箱、导出、系统对话框、启动设置、快捷键、更新和局域网传输。修复了设置保存后立即截图的锁竞争、快捷键重新注册期间丢弃按键、启动时隐藏，以及提醒和专注完成通知缺口。
- 2026-11-14 桌面原位恢复功能完成后的 `npm run dist` 实际退出码为 0，生成 `release/DustDesk-1.0.2-x64.exe`（4,473,912 字节）、`release/DustDesk-1.0.2-x64-green.zip`（5,797,222 字节）和 `release/SHA256SUMS.txt`，两份产物的 SHA-256 已独立核对。
- 实际 Release EXE 与实际绿色 ZIP 解压后的 `DustDesk.exe` 均通过无参数启动、版本显示、Alt 无顶部菜单、任务保存、真实组件显示、退出提交、重启读取和再次直接运行 EXE 的单实例唤起验证。正式版在创建 profile 前正常拒绝调试原型入口；ZIP 仅包含主程序与说明，无便携启动器。
- 桌面位置功能完成时的打包日志为 `artifacts/tauri-migration/desktop-positions-dist-verified.log`，包含 239 项 Node、557 项 Rust 测试（默认另有 3 项 ignored，真实桌面用例已在收纳专项显式补验）、前端构建、正式版及实际绿色 ZIP 启动验证；图标替换、数据目录调整与此前框架替换打包日志保留于 `artifacts/icon-review/approved-icon-dist-verified.log`、`artifacts/tauri-migration/local-data-dist.log` 和 `direct-tauri-verified-dist.log`。收纳位置初轮本地打包主动中止于边界调整，保留于 `desktop-positions-dist.log`，不计成功。快捷键、局域网与快速记录的成功复验见 `direct-tauri-final-core-recheck.log`，该轮的后台截图失败随后已在 `direct-tauri-native-tray-verified.log` 中完整复验 11 项通过。截图、区域捕获、隐藏启动、文本工具箱与项目导出的先前修复复验为 `direct-tauri-regression-recheck.log`（54 项通过）。初轮失败日志保留，不改写为成功。
- 已应用用户确认的 v5 图标：主色 `#409EFF`，收纳托盘与浅蓝灰卡片。侧栏使用 128 像素 PNG，程序、窗口、托盘、通知及安装／卸载程序使用同源 ICO；开始菜单快捷方式引用安装后的 `DustDesk.exe`。真实 WebView2 深浅主题下确认原图 128×128、显示 32×32，打包图片与源文件摘要相同；Debug、Release 与 NSIS 安装器的 9 个原生图标尺寸均逐帧匹配审核资源，报告为 `artifacts/icon-review/applied-icon-renderer.json` 与 `applied-icon-native.json`。补充 Cargo 对包外 ICO 的重建依赖，修复只替换图片时 EXE 图标资源仍使用旧缓存的问题；发现缓存问题后中止的初轮打包日志单独保留于 `approved-icon-dist.log`。
- 默认数据目录已通过真实 Debug、Release 和实际绿色 ZIP 的无测试目录覆盖启动验证：开发版读取项目根目录的 `Data`，正式版读取 EXE 同级的 `Data`；从其他工作目录启动、中文目录均不改变路径规则。当前本机工作区已复制到项目 `Data`，只重定位收纳路径并逐文件校验，旧 AppData 完整保留；便签、剪贴板图片、备份和收纳文件读取通过。报告为 `local-data-debug.json`、`local-data-release.json`、`local-data-green.json` 和 `local-data-copy.json`。
- 新收纳项目已支持持久保存 Explorer 图标坐标，分类间移动不丢失；恢复、撤销、退出恢复和异常补偿回到桌面时使用同一坐标记录，页面保存不能覆盖原生位置状态。新增重启／跨分类／保存冲突／退出后重新收纳测试，并使用真实 Windows 桌面的独立文件与文件夹验证原位恢复、撤销、重启和同名改名恢复；收纳专项 45 项全部通过（含显式启用的真实桌面用例），真实 WebView2 手动与智能收纳专项 13 项通过。日志为 `artifacts/tauri-migration/desktop-positions-organizer-verified.log` 与 `desktop-positions-webview-verified.log`。首轮 WebView2 启动被当时仍在运行的旧程序单实例拦截，用户正常退出后复验成功；失败日志保留。Windows 自动排列设置不被修改，开启时由系统排列；未记录过坐标的历史收纳无法追溯原位。
- 旧 Electron 浏览器中尚未提交的草稿须先在旧版保存；自动读取旧浏览器草稿不属于本次直接框架替换的交付范围。本轮没有重新验证物理双机、混合 DPI／物理输入法／热插拔或 Release 内存性能，不沿用历史结果作当前结论。

## v1.0.3 发布基线（2026-11-14）

- 当前迁移分支已从 `codex/tauri-migration` 改名为 `v1.0.3`；发布提交作为 `main` 和 `v1.0.3` 标签的共同基线，后续开发使用仅本地的 `v1.0.4`。历史 v1.0.1 / v1.0.2 标签、分支与 Release 保留原样。
- 包版本、npm 锁文件、Cargo 元数据和 README 同步为 1.0.3，Tauri 配置继续读取包版本。应用“设置 → 更新”增加框架变更、数据目录迁移提示和完整版本说明入口；GitHub Release 正文使用 `docs/releases/v1.0.3.md`。
- `npm run dist` 实际退出码 0：TypeScript、239 项 Node 测试、前端构建和 557 项 Rust 测试通过。默认另有 3 项 ignored：2 项历史官方来源夹具本轮未重新执行；1 项真实桌面坐标用例已在此前同功能源码的收纳专项显式执行通过，证据见当前状态中的记录。
- 真实 WebView2 更新专项 19 项全部通过，覆盖动态当前版本、设置更新页、原生确认、托盘、取消、超时和退出。更新页明暗主题均核验无横向溢出；Rust 格式检查与严格 Clippy 通过。日志为 `artifacts/tauri-migration/v1.0.3-update-native.log`、`v1.0.3-clippy.log`。
- `npm run dist` 内的正式 EXE 与实际绿色 ZIP 解压启动验证通过；额外执行 `node tests/package-smoke.mjs` 通过。验证无参数启动、v1.0.3 版本、Alt 无顶部菜单、任务与组件、退出保存、重启、单实例唤起，以及正式版拒绝调试原型入口。日志为 `v1.0.3-dist.log` 与 `v1.0.3-package-smoke.log`。
- 发布安装包为 `DustDesk-1.0.3-x64.exe`（4,473,270 字节，SHA-256 `454f90a2b1c4849f35c1ea11882d638f91cfd89c198d281b576bf69c7caa89ff`）；绿色版为 `DustDesk-1.0.3-x64-green.zip`（5,793,474 字节，SHA-256 `ff0f7725e4a78d8b527b612e753b417b1571186b55c71eaaea297973739aa2e6`）。校验清单精确包含以上两件产物；ZIP 仅包含 `DustDesk.exe` 与说明，EXE 字节与正式构建一致。
- Debug、Release 和 NSIS 安装器的 9 个原生图标尺寸均与审核资源逐帧一致。构建期间 277 项产品源码、配置和资源摘要保持不变；未提交本地 Data、测试日志、打包产物或无代码引用的模型资源。

### 历史执行记录（本文下方全部记录以当时源码为准）

以下是已结束的迁移实验和阶段记录，其中的“当前增量”“未完成”“默认 Electron”仅描述当时状态，不是本次直接框架替换的剩余清单。

- P0 已建立公共接口清单：DustDeskApi 83 个成员、ToolboxApi 16 个成员；新增 onFilesDropped 原生路径与落点订阅，仍为部分迁移，原型命令不计为公共业务 API 已迁移。
- P1 已实现原生托盘、透明多窗口、物理像素定位、置顶、透明度、鼠标穿透和恢复、GDI 区域捕获、Windows Graphics Capture 窗口捕获、贴图预览、调用窗口权限校验与捕获失败重试。
- 现有截图编辑器与 Worker 已在真实 WebView2 中通过矩形标注、撤销、重做及贴图导出验证；原型复制与保存明确报未实现，不触碰系统剪贴板。仍不能据此宣称完整截图业务迁移完成。
- P2–P7 尚未完成：完整适配器、业务和生命周期、草稿迁移、收纳、系统能力、剪贴板监听、工具箱、局域网、完整性能和发布验收继续按主计划推进。存储验证命令不计为正式 DustDeskApi 已迁移，正式适配器的隔离验证也不等于生产迁移完成。
- LAN 桌面阶段已将 Rust 服务接入实际 Tauri 主程序与共享传输页，覆盖文件／目录／文本、原生确认、暂停清理、维护／恢复／退出及同机重启续传；详见“原生 LAN 桌面服务接入”和后续目录所有权记录。
- 上一阶段修复原生草稿记录因可共享只读观察者而被旧替换语义拒绝的确定性机制，保留实际写锁／只读／拒绝 DELETE 的阻断，不改普通文件替换路径。2026-11-13 10:12（北京时间）完整冻结回归通过：519 项输入、21 步，223 项 Node、4 项无窗口、418 项 Rust、十四套／137 项原生检查及普通工具箱生命周期。完整证据归档为 `artifacts/tauri-migration/native-record-replacement-final/`，上一阶段失败保留且不反写成成功。原始瞬时读句柄的具体进程、普通文件替换和历史无窗口超时仍不计已解决。
- 上一增量为正式旧版安装代码来源识别，不读取旧业务数据或接管 profile。2026-11-13 10:54（北京时间）完整冻结回归通过：525 项输入、22 步、223 项 Node、4 项无窗口、433 项 Rust、十五套／145 项原生检查及普通工具箱生命周期；默认 Rust 中 1 项真实包用例为 ignored，但专项已显式执行并通过。证据保留于 `artifacts/tauri-migration/source-authentication-final/`，不以这批数字代表后续增量。
- 上一增量接入实际准备 Electron 运行时来源租约。2026-11-13 11:52（北京时间）完整冻结回归通过：530 项输入、25 步、225 项 Node、4 项无窗口、448 项 Rust、十八套／168 项原生检查及普通工具箱生命周期；默认 Rust 的 1 项正式字节测试另行显式执行，来源内核专项 30 项全部通过。证据保留于 `artifacts/tauri-migration/live-source-binding-final/`。
- 上一增量为存活来源与独占原 LAN 的原生组合准备内核。2026-11-13 12:40（北京时间）完整冻结回归通过：532 项输入、26 步、225 项 Node、4 项无窗口、459 项 Rust、十九套／174 项原生检查及普通工具箱生命周期；默认 Rust 的 1 项正式字节测试另行显式执行，来源专项 40 项全通过。证据归档为 `artifacts/tauri-migration/live-source-snapshot-final/`，不作为下列新入口的完整验收。
- 上一增量把准备 Electron 的真实 Session、全编辑器维护、LAN 排空／恢复和原生组合准备接通。2026-11-13 13:32（北京时间）完整冻结通过：534 项输入、27 步、229 项 Node、4 项无窗口、459 项 Rust、二十套／183 项原生测试和普通工具箱生命周期；来源专项另行显式运行 40 项全通过。多窗口屏障、两类读取中断、提交后取消及真实 file-origin 共享存储边界均已验证。证据归档为 `artifacts/tauri-migration/electron-source-snapshot-final/`，不能作为本轮资产护栏的完整验收。
- 上一增量加入存活来源的完整资产清单复核和保留句柄。2026-11-13 14:17（北京时间）完整冻结通过：536 项输入、27 步、229 项 Node、4 项无窗口、471 项 Rust（默认另有 1 项 ignored）、二十套／185 项原生测试和普通工具箱生命周期；正式参考来源专项另行显式运行 42 项全通过。两项修复前失败证据保留，真实 Electron 证明原生成功响应时资产仍被固定，重开旧决定对资产变化的拒绝及固定后新增撤销均已验证。证据归档为 `artifacts/tauri-migration/live-source-freshness-final/`；该阶段尚未持续固定目标对象，不能把旧结果作为本轮目标护栏的验收。

## 整体应用持久输入准备（当前增量，验证中）

- 新增原生 `RuntimeApplication/` 输入准备协议，从最新固定句柄生成完整副本，并保留原／新 Data 清单、原／新草稿归档和精确覆盖／新增／删除计划。准备决定仍明确未应用原 Data／Session；两套源、所有权与桌面屏障保持。
- 显式准备／恢复已连接 Debug TEMP 隔离宿主的封存恢复会话；不接受客户端提供路径、归档或清单，不创建普通业务窗口或服务。复制的迁移控制记录仅保留历史原字节，不能作为新 Data 身份下的活动记录。
- 开发轮 7 项新增 Rust 测试及严格 Clippy 已通过，真实 WebView2／进程专项正在验证；新冻结入口为 `npm run check:tauri:runtime-application-inputs`。旧桌面封存验收继续作为历史证据，不能替代本轮 Rust 输入变化后的验收。
- 真实进程首轮在完成输入准备和草稿计划核对后，因测试假定夹具必有 `MigrationLineage/lineage.json` 而失败；实际隔离导入通过持有的原快照证明授权，不自动生成该文件。已改为按封存清单核对三类控制记录的实际字节或实际缺失，未补造记录；失败报告、日志和当时夹具保留于 `runtime-application-inputs-development/attempt-1/`。原生用例另行覆盖三类记录均存在时的原字节保留。
- Windows 原生目录句柄探针显示，持有拒绝 DELETE 共享的后代文件或目录句柄会阻止顶层目录重命名（错误 5），无后代句柄时成功。后续须设计明确的固定权转移与按原物理身份恢复，而非直接移动仍被固定的整棵树。探针与日志均保留在 artifacts，未操作用户目录。
- 向原 Data／实际 Electron Session 应用、原物理 Data 根保持、控制记录新绑定、部分应用后早于旧 SHA 入口的恢复，以及完成两侧后的屏障解除仍未实现；完整迁移目标保持进行中。

## Electron 整体封存维护与启动屏障（此前增量，已验收）

- 将原生整体封存接入独立 Debug TEMP 桌面菜单，复用实际 Session 与全编辑器维护。运行 Data／物理浏览器绑定核验后、导入和 LAN 准入前发布持久整体屏障；结束时排空、最终读取并封存，再等待实际宿主退出，启动独立原生进程重新取得同一授予并核验同一终态。
- 成功、取消和异常均不解除整体屏障或恢复旧编辑器。重启先处理整体屏障，再允许任何普通窗口／草稿恢复／业务初始化；原 Data 缺失时不补建目录。显式核验只读重试原终态，普通退出保留数据、不运行旧工作区的退出保存／收纳恢复。
- 新入口仍未将最新 Data／资产／草稿应用回原 Electron，核验成功也只能保持暂停或退出；普通 Tauri 编辑器最终保存与生产切换继续保留。协议和测试入口见 [整体运行交还](RUNTIME_HANDOVER.md)。
- 开发轮 `check:silent` 及新增屏障单元测试通过。首轮实际专项被夹具中缺失既有字段的便签草稿拒绝，尚未进入新封存路径；原日志、报告与当时夹具保留于 `runtime-handback-desktop-development/attempt-1/` 和 `native-first.log`，修正后已重新运行。最终验收仍以本轮冻结报告为准。
- 第二轮实际专项三个场景／4 项全部通过，包含真实 LAN 排空、原宿主退出后新进程复核、启动零普通窗口、已封存资产变化拒绝、封存后真实 SIGKILL，以及封存前取消后拒绝缺失终态。成功报告及当时夹具独立保留于 `attempt-2/`；最终冻结增加精确归档原文／Data 清单摘要、进程退出先后、取消后终态目录缺失和重启后终态记录字节不变断言，已在完整专项中全部通过。
- `npm run check:electron:runtime-handback` 最终于 2026-11-14 11:32:59（北京时间）完成 15 步冻结回归，真实退出码为 0：587 项输入保持一致，239 项 Node、4 项无窗口、542 项 Rust、六套／34 项集成测试通过，两项默认 ignored 分别显式补验；主进程 TypeScript、严格 Clippy、Release 全目标、fmt 与实际 Debug 构建通过。`runtime-handback-desktop-final/verification.json` 标记 verified=true、sourceStable=true，productionReady=false、migrationComplete=false。
- 11:34 独立 `evidence-audit.json` 核验完整输入、日志、原生证据、产物、旧浏览器基线及 12 份开发记录摘要。六次导入／LAN 准入前屏障存在、宿主 close 后独立接收方才恢复、一次真实 SIGKILL、重启零普通窗口均有本轮事件证据。2,041 个历史 TEMP 根完全不变，项目测试进程无残留；Rust 输入相对旧浏览器基线未改变。
- 独立审计首次把两项 LAN helper 摘要与主程序比较而失败，定位后仅修正审计的文件映射，再执行完整审计通过；未改源码、原测试报告或产物。原审计脚本、失败日志和修正说明保留于最终目录，并由成功审计绑定修正说明摘要。接续整体 Data／Session 应用事务与普通业务开放，本轮不计完整迁移或生产回退已完成。

## 隔离宿主真实浏览器封存与冷恢复（此前增量）

- 将整体终态内核接入 Debug TEMP 隔离宿主。`sealRuntime` 仅接受同请求的 `continueRuntime` 之后调用，停止导入／LAN 准入并排空服务，由原生读取当前工作区字节与实际 WebView2 白名单原文、固定 profile／origin 与页面代次；客户端不提供归档、条目或目标路径。
- 决定完成后销毁 WebView，保留原所有权、Data／资产及物理 profile 独占并持续复核至客户端关闭。`recoverRuntimeHandback` 只核验原终态并保留独占，不创建 WebView、可写存储或网络服务；普通启动不能重开已封存授予。
- 完整浏览器专项于 2026-11-14 10:29:41（北京时间）通过 10 个场景／11 项测试：精确剩余草稿、最新 Data／资产／空目录、正常关闭与封存后真实 SIGKILL 后各两次冷恢复、真实 LAN 排空，以及 pending／未来版本／读取中重载拒绝。原导入、两处真实中断恢复和来源迟到撤权回归继续通过，未过滤或跳过场景。
- 该浏览器阶段的最新 Data 编辑仍由文件夹具完成；冷恢复未重读重启后 localStorage；新真实强杀只覆盖封存决定之后。该阶段尚未接通桌面维护结束和整体 Electron 启动屏障，后续接入见上方当前增量；向原 Data／Session 应用事务、普通业务开放、生产切换和完整回退继续未完成。协议和证据见 [整体运行交还](RUNTIME_HANDOVER.md)。
- 本轮开发记录保留于 `runtime-handback-browser-development/`，最终目录的 `history.json` 绑定失败日志、当时夹具及定向诊断。夹具修正包含封存独占期间的读取顺序、真实子进程句柄强杀及重载拒绝诊断范围；两次普通 Electron 保存 rename EPERM 未定位，不计已修复。
- `npm run check:tauri:runtime-handback` 最终于 2026-11-14 10:35:02（北京时间）完成 14 步冻结验证：583 项输入保持一致，235 项 Node、4 项无窗口、542 项 Rust、五套／30 项集成测试通过，两项默认 ignored 均显式补验；主进程 TypeScript、严格 Clippy、Release 全目标、fmt 和实际 Debug 构建通过。`runtime-handback-browser-final/verification.json` 标记 verified=true、sourceStable=true，未开启生产许可。
- 10:35 独立 `evidence-audit.json` 核验完整输入、日志、原生证据、产物、历史报告和 12 份开发记录摘要；浏览器完整 10 场景无过滤，各两次冷恢复、实际 LAN 关闭和重载拒绝均有本轮证据。2,041 个历史 TEMP 根完全不变，`process-cleanup.json` 只读核验无项目测试进程残留。重载实际返回无效草稿回调诊断，未单独证明由代次检查拒绝；不把已验证的保守拒绝扩写为其他机制已验收。

## 整体运行工作区与浏览器交还内核（此前增量）

- 新增 `RuntimeOwner` 的整体终态与专用冷恢复 API，复用完整文件枚举、实际物理身份及保留句柄，封存最新 Data／资产／空目录，并绑定当前工作区原始字节、物理浏览器配置、Tauri 草稿归档摘要及原 LAN 最新终态；不覆盖原工作区或回放旧快照。
- 原子创建整体交还记录目录即阻断普通确认／读写／可写恢复和原 LAN 服务／旧专用恢复。意图、Data 清单、浏览器原文和最终决定不可覆盖发布；完整载荷的未决记录或成功响应丢失只继续原决定，未知／缺失／损坏／换目录保持阻断，不猜测修复。原 LAN 已采用时必须先提供实际服务排空后的持久交还。
- 六项新增原生内核测试已通过，使用最小可信代码夹具和构造的浏览器归档；中断为回调故障注入。该批内核测试不含实际原生浏览器最终读取、桌面结束协议、整体 Electron 屏障／应用事务或新接口的真实 SIGKILL。协议、验证入口及完整剩余范围见 [整体运行交还](RUNTIME_HANDOVER.md)。
- 开发阶段严格 Clippy 首次因一处多余的闭包借用被拒绝，已修正；原日志保留于 `runtime-handback-clippy-development.log`，后续成功日志为 `runtime-handback-clippy-development-passed.log`。
- 内核阶段最终于 2026-11-14 09:33:42（北京时间）完成 14 步冻结验证：581 项输入保持一致，235 项 Node、4 项无窗口、542 项 Rust、五套／24 项集成测试通过，两项 ignored 均显式补验；两类 TypeScript、严格 Clippy、Release 全目标、fmt 和实际 Debug 构建通过。`runtime-handback-kernel-final/verification.json` 与独立 `evidence-audit.json` 绑定输入、日志、产物与 2,041 个原 TEMP 根不变；项目测试进程无残留。这是新 stdio／真实浏览器接入前的历史结果。
- 隔离宿主显式 `sealRuntime` 和只读 `recoverRuntimeHandback` 的后续实现及实际进程／浏览器验收见上方当前增量，不能据此认定完整桌面结束、普通编辑器保存或向原 Electron 应用新数据已完成。

## Electron 维护会话的原 LAN 隔离运行（此前增量）

- 新增独立 Debug TEMP 菜单，将实际 Electron 全编辑器维护、可信组合快照、运行授予和同进程 WebView2 导入连接到真实原 LAN 服务。原草稿专用菜单保持原行为，未初始化或关闭的 LAN 不创建身份或监听。
- 在允许新宿主启动 LAN 前刷盘持久屏障；工作区读写／规范化和旧 LAN 自动恢复在屏障存在时均被拒绝。正常结束、取消和客户端 EOF 等待真实服务与 Windows 确认队列排空，绑定证明、实际成功退出和当前物理身份／完整摘要全部匹配后才解除屏障。
- 新增显式原生恢复：未授予路径核验原检查点，空／意图中断持久中止；已授予路径无网络监听地排空实际工作线程并交还最新状态；已有交还记录仅继续交还。未知、孤立或篡改记录保持阻断。启动恢复先于编辑器、草稿恢复与后台服务。
- 修正交还失败后的内存维护标记阻挡显式恢复，以及明确接受默认目录后未创建专用接收目录的问题；取消／拒绝不创建目录，原生路径检查拒绝父级路径与重解析点。机制、验证入口和剩余门槛见 [原 LAN 隔离运行](ORIGINAL_LAN_RUNTIME.md)。
- 开发阶段增加 5 项 Node 屏障测试与 5 项 Rust 恢复测试；真实菜单专项及最终冻结结果须以下方验收记录为准，不能将旧基线数字计入本轮。
- 开发失败日志独立保留于 `original-lan-runtime-development-failure-1/` 与 `original-lan-runtime-development-failure-2/`：前者为直接 Cargo 构建覆盖内置前端产物，后者发现首次默认接收目录未创建。旧冻结基线未覆盖。
- 第三轮已通过前五场景，启动恢复受测试框架原固定 15 秒等待限制而失败，记录保留于 `original-lan-runtime-development-failure-3/`。专项增加有上限的启动等待和启动错误诊断，原通用等待默认值保持不变；后续通过须重新实际运行，不能将超时当作成功。
- 2026-11-14 08:21:26–08:52:39（北京时间）最终冻结验证通过：578 项源码／测试／配置输入、21 个串行步骤，235 项 Node＋4 项无窗口、536 项 Rust（默认两项 ignored 均分别显式补验），十二套／57 项真实进程、浏览器、Electron 与 LAN 集成测试。主进程 TypeScript、严格 Clippy、Release 全目标、格式和实际 Tauri Debug 构建通过；本轮从头执行全部步骤，没有复用上次中断前的成功日志。
- 新增真实菜单专项六场景／7 项全部通过：未初始化与已禁用 LAN 保持关闭，Windows 实际配对／接收确认授权上传，活动上传交还后由原 Electron 接续，取消待决窗口，以及分别强杀 Tauri／Electron 主进程后的持久屏障和显式恢复。Electron 重启恢复提示时实际普通窗口数为零。保留 1,048,576 字节前缀后完成同一 3,145,747 字节文件，最终 SHA-256 为 `7594133b53d60326de2606320f23cddabfa86e99e3aa4b30b764e6d43cd5ac4a`。
- 最终证据为 `artifacts/tauri-migration/original-lan-runtime-final/`，`verification.json` 标记 verified=true、sourceStable=true。08:53 的独立 `evidence-audit.json` 复核完整输入清单、每步命令／日志／原生证据／产物摘要、五项新增 Rust 恢复用例、两项补验、六个真实场景、启动零普通窗口和活动上传摘要；相对上一轮冻结输入新增／修改 23 项，preload 构建摘要不变。
- 本轮实际 Tauri Debug EXE SHA-256 为 `ee40f87780a1607ab308d4efe27af8e2c591afdda3094d0566216064d7013a85`；交还／恢复 example 为 `aafc92a65cbc0a124087915d74238ee41f8a5163ef2dfebd9e341432d581f5d2`。`process-cleanup.json` 只读核验项目测试进程无残留，冻结前后的 2,041 个严格小写 `dustdesk-*` 历史 TEMP 根完全一致，没有新增或移除历史根。
- 上一轮暂停／恢复后的验证进程已经终止，仅完成前九步和新增专项的前五场景，未形成完整验收。其原始报告／控制台／不完整原生证据及七个任务夹具根（1,303 个文件与完整摘要）可恢复地保留于 `original-lan-runtime-interrupted-1/`，不将其改写为通过；最终目录中的 `history-and-interruption.json` 绑定归档和三次开发失败，并确认中断轮与本轮输入一致。早期缺少 lstatSync 的测试边界、Rust 夹具编译与固定期间读取错误只有对话输出及开发摘要，未伪称存在独立原始日志。
- 当前仅完成 Debug TEMP 原 LAN 隔离运行与专用交还。下一步补齐整体运行工作区／浏览器的持久交还与恢复，再将普通业务启用接到同一所有权和启动屏障；生产来源接管、整体切换／完整回退、物理双机、Release 性能及安装／实际绿色 ZIP 门槛继续未完成。默认 Electron、版本 1.0.2，未提交、推送或发布；productionReady 和 migrationComplete 保持 false。

## 原 LAN 最新状态持久交还（此前增量）

- 新增同一原授予的实际服务监督与排空凭证、封闭写入、最新原始字节固定、旧 LAN 状态兼容核验，以及绑定原授予和最新检查点的持久交还意图／决定。普通恢复不能在开始交还后重新打开服务，明确冷交还入口可完成意图后中断或成功响应丢失。
- Receiver 最终保存的首次停止失败现在锁存，重复停止不能误报成功；无法真实排空时不返回交还凭证。未完成原生发布状态保持原字节、拒绝交还，不静默规范化或回放旧快照。
- 开发期修正 Rust 夹具语法、夹具对象析构顺序与权限恢复写法；首次冻结另发现新增未完成发布夹具误用 `last_seen`，实际应为 `lastSeen`。产品正确拒绝损坏状态，修正夹具后重新冻结；原始冻结失败与当时源码保留于 `original-lan-handback-frozen-failure-1/`，其余开发失败仅有对话工具输出和摘要。
- 原生九项与独立真实进程三场景的机制和验证入口见 [原 LAN 交接内核](ORIGINAL_LAN_HANDOVER.md)。最终冻结与独立审计结果见下。
- 2026-11-13 22:14（北京时间）最终冻结验证通过：571 项输入、20 个串行步骤，230 项 Node＋4 项无窗口、531 项 Rust（默认两项 ignored 分别显式补验），十一套／50 项真实进程、浏览器、Electron 与 LAN 集成测试。主进程 TypeScript、严格 Clippy、Release 全目标、格式和实际 Debug 构建通过。
- 证据保留于 `artifacts/tauri-migration/original-lan-handback-final/`；最终报告标记 verified=true、sourceStable=true。独立审计复核输入清单、日志／证据／产物摘要、九项新增原生用例、交还及冷恢复进程事件、两项补验与失败归档。首轮交接和冷恢复基线均未覆盖。
- 本轮 Tauri Debug EXE SHA-256 为 `963ec0804627c14c07f940fbdad084652155e3f06db7bb87afeb23d0677af40a`；交还／恢复 example 为 `732e618c921b095ef8c8d27464e9483d73c43efbfc7a5398a00e6f6591c635ee`。Electron 主进程／preload 构建摘要与上一轮冷恢复基线一致。
- 2026-11-13 22:14 的只读清理核验无相关进程或新增 dustdesk-* TEMP 根，冻结开始的 2041 个历史根保留。开发双重 panic 遗留的四个合成夹具根经所有权核验后可恢复地归档于证据目录。首次冻结的夹具字段错误及完整失败日志单独保留，最终通过不覆盖失败记录。
- 当前仅为 LAN 专用 Debug TEMP 原生能力，尚未接入桌面维护菜单；整体工作区／浏览器交还、生产切换和完整回退继续未完成。默认 Electron、版本 1.0.2，未提交、推送或发布。

## 原 LAN 合法最新状态冷恢复（此前增量）

- 新增原生专用冷恢复与显式服务采用入口：当前状态先固定，原组合快照／完整资产清单／来源绑定／运行授予和原 LAN 成功记录分别核验，原物理目录与设备身份必须一致；原快照状态不会覆盖接管后的新信任或传输任务。普通不可变恢复保持严格检查。
- 恢复不创建或重写原 LAN 授予记录，未决、缺失、未知、摘要不符和替换的身份／目录均拒绝；同一新租约贯穿冻结、授予恢复和服务存储采用。采用前保留当前状态固定，采用后继续取消／来源失效／所有者释放撤权。
- 新增六项原生测试及独立原生进程／实际旧发送模块测试。后者使用官方 v1.0.2 参考字节认证来源，通过回环 HTTPS 与明确 stdin 确认验证强杀后续传，不执行旧版 EXE。详细机制、复跑入口和最终验证记录见 [原 LAN 交接内核](ORIGINAL_LAN_HANDOVER.md)。
- 开发阶段先修正归档返回类型的 Clippy 复杂度、官方来源准备的测试等待上限，以及活动分片不能被外部读取的夹具错误；分片摘要改在真实强杀退出后核验，没有放宽共享权限。首次冻结回归另发现来源核验拆分改变既有拒绝诊断，已恢复“不属于当前仍存活的来源”的语义，替换浏览器 profile 的原断言保持不变。失败报告分别保留于 `original-lan-recovery-development-1/`、`original-lan-recovery-development-2/` 与 `original-lan-recovery-frozen-failure-1/`；只有冻结失败有完整原始 Rust 日志，不伪称前两次有独立控制台全日志。
- 2026-11-13 21:25（北京时间）最终冻结通过：566 项输入、19 个串行步骤，230 项 Node＋4 项无窗口、522 项 Rust（默认两项 ignored 分别显式补验），十套／46 项实际进程、浏览器、Electron 和 LAN 集成测试。新增进程用例真实强杀后保留 1 MiB 已核验前缀，以原身份／授予重开最新任务，明确确认后续传至完整 SHA-256 一致，并验证二次恢复和授权篡改拒绝。TypeScript、严格 Clippy、Release 全目标、格式与实际 Debug 构建通过。
- 证据保留于 `artifacts/tauri-migration/original-lan-recovery-final/`，最终报告 `verified=true`、`sourceStable=true`；独立摘要审计复核输入、日志、补验、进程事件与清理，首轮交接基线未覆盖。该轮 Debug 主程序 SHA-256 为 `e3bde78241ffab1d825a64879f3a451c96b4a7f3085618471a4d2abf20d75c38`，Electron 主进程／preload 摘要不变。21:25 只读核验无相关进程或本轮新增 TEMP 根，冻结开始的 2041 个历史根保留。
- 该轮尚未完成持久交还、桌面菜单接管、生产切换和完整回退；现有 Electron 维护菜单继续 `businessServicesStarted=false`。默认入口 Electron、版本 1.0.2，未提交、推送或发布。

## 原 LAN 首轮同租约交接内核（此前增量）

- 新增 `RuntimeOwner::prepare_original_lan_preview`，仅供 Debug 专用 TEMP 原生库使用；实际运行授予、完整原来源／快照与原 LAN 检查点保持关联。先持久化绑定原授予和检查点的意图／成功决定并读回、固定记录，再释放原状态文件固定，把同一原生目录租约直接交给现有 `StateStore`／`Receiver::start_owned`。原设备身份继续由原文件句柄固定，不复制到输出、不生成新设备身份。
- 来源和真实服务工人共同保留目录／身份／决定护栏；取消或释放运行所有者后拒绝服务提交，来源监督失败同样永久撤权。工人退出后来源仍持有租约，来源提前释放也不会让尚未退出的工人放开 LAN 独占。未决、已授予或未知记录保留并阻断第二次交接，意图后／决定后撤权均不返回可写存储，也不反转已持久成功决定。
- 新增十项原生库测试使用测试内最小代码信任夹具，覆盖真实文件／目录句柄、状态提交、原身份／快照保护和撤权；其中一个用例将交接存储直接交给实际 Rust Receiver，与第二个实际 Receiver 完成回环双向 TLS 配对、新增信任落盘及真实停止。它不替代正式参考字节的新路径端到端验证或跨交接文件续传；现有正式来源／Electron 回归另行验证其各自路径。
- 首轮七项专项中六项因零共享文件被按路径重开／读取而失败，实现改为复制已授权 OS 身份句柄，测试改用冻结前原字节及所有者释放后的记录读取；未放宽文件共享。失败只保留本对话工具输出和开发摘要，不冒充存在原始独立日志。
- 原状态合法变化后，旧恢复入口继续拒绝不匹配的原检查点，保留当前数据和决定；本轮没有冷恢复／持久交还。现有 Electron 菜单没有调用新入口，仍等待宿主退出才恢复原 LAN，`businessServicesStarted=false`；普通业务开放、整体持久切换和完整回退继续未完成。实现边界与验证入口见 [原 LAN 交接内核](ORIGINAL_LAN_HANDOVER.md)。
- 2026-11-13 20:46（北京时间）最终冻结通过：561 项输入、17 个串行步骤，230 项 Node＋4 项无窗口、516 项 Rust（新增十项已计入；默认另两项 ignored 均在本轮显式补验），九套／45 项真实浏览器、Electron 与 LAN 集成测试。主进程 TypeScript、严格 Clippy、Release 全目标检查、fmt 和实际 Debug 构建均通过；没有以此替代完整迁移、物理双机或发布验收。
- `artifacts/tauri-migration/original-lan-handover-final/` 保存最终报告、逐步日志、原生证据副本、两项补验和独立摘要审计。相对上一轮冻结输入共有十一项新增／修改；当前 Tauri Debug EXE 摘要为 `a7bdd66aa25043aa281cb96ccb6bd7ecaf76f21f3613a833e1bdf27c1c8f33a1`，Electron 主进程／preload 摘要与上一轮一致。20:46 的只读清理核验没有相关进程或本轮新建 `dustdesk-*` TEMP 根残留，统计内的 2044 个历史 TEMP 根保留。默认入口 Electron、版本 1.0.2，未提交、推送或发布。

## Electron 维护会话到隔离宿主（此前增量）

- 开发菜单已复用实际主窗口 Session 和全编辑器屏障，从真实受控草稿读取、原 LAN 排空、组合快照／运行 Data 准备接到同进程 Tauri WebView2；客户端核验运行回执和物理 profile 后才确认导入。仍只允许专用 TEMP 根，不新增公共业务 API 或生产接管入口。
- 导入完成不会释放维护；等待结束通知时，客户端持续检查实际 Session／目录和工作区独占，原窗口重载、取消或宿主退出会撤权。正常关闭 stdin 或异常终止均等真实子进程关闭，再恢复原编辑器和 LAN；原生决定保留，既有维护超时不自动续期。
- 最终源码下六个端到端场景／7 项测试通过：真实 Session 与小组件草稿导入、显式结束、菜单取消、宿主异常退出、参与窗口重载、真实 Electron 主进程终止后的宿主 EOF 退出与原 Session／LAN 重启，以及普通数据根在选择旧安装／冻结／启动原生进程前被拒绝。每次正常恢复均保留原草稿、原 LAN 身份和已完成的原生决定。
- 前三轮分别因测试读取受保护快照、维护期间调用工作区读取、把保存异常误当结果对象而失败，已保留原始证据并同步正确断言，没有放宽文件共享或维护门闩。新增客户端终止场景的首次冻结失败保留于 `electron-runtime-bootstrap-frozen-client-exit-failure/`；已确认 Windows Playwright 返回外层 cmd 启动进程，原测试未真正终止 Electron。修正为取得并结束真实主进程，再单独核验宿主 EOF，未使用进程树整体结束冒充撤权。
- 2026-11-13 20:12（北京时间），558 项输入／六步限定冻结回归通过：230 项 Node＋4 项无窗口、主进程 TypeScript、实际 Tauri Debug 构建，以及三套／26 项真实集成测试（新增运行 7、原来源快照 9、原来源租约 10）。所有输入、逐步日志、原生证据副本与 Electron 主进程／preload、当前 Tauri EXE 摘要再次复核。证据位于 `artifacts/tauri-migration/electron-runtime-bootstrap-final/`。
- 本轮原生源码／配置与上一轮基线一致，当前 EXE 为重新构建的不同摘要产物，不能写成同一二进制；当前集成测试执行该新 EXE。本轮未重跑全部 Rust、严格 Clippy、Release 或既有原生套件，不把上一轮 506 项 Rust 和两项补验当作本轮新执行结果。`evidence-audit.json` 保留两轮源码／产物关系和失败摘要；20:13 的 `process-cleanup.json` 只读确认相关进程和本轮新建相关 TEMP 目录均无残留，历史目录未删除。
- 协议、验证入口及剩余切换工作见 [Electron 维护会话连接](ELECTRON_RUNTIME_BOOTSTRAP.md)。原 LAN 正式服务移交、普通业务开放、整体持久切换／退出恢复／完整回退仍未完成。

## 同进程隔离启动与真实浏览器导入（此前增量）

- 已续接上一对话中断时新增的 profile 绑定，把不可序列化 `RuntimeOwner` 接到实际 Tauri Debug 进程；仍采用原工作区独占并保留原来源、组合快照、LAN 冻结与原生决定护栏。新 WebView2 目录有先意图、后物理身份决定的持久绑定，恢复只接受原所有权和原目录，不复用已有未知目录或复制 profile。
- 专用私有启动只允许 `dustdesk-runtime-preview-*` TEMP 根中的隔离来源及同级输出；客户端先建立浏览器，再确认启动导入。页面只获一个原生步骤命令，归档／检查点／profile／事务来源均由原生取得；没有普通工作区、系统或窗口业务权限，也未启动托盘和后台业务服务。
- 原生初始恢复、来源可用、当前暂存、已决定和完成阶段独立约束；旧 pending 只能先中止恢复，不能直接请求 commit。真实浏览器暂存与原生副本／决定、实际值和回执读回均沿用已有内核，完成后拒绝第二次写入。页面代次和客户端断连／来源失效仍参与撤权。
- 最终源码下真实 WebView2 四组场景／5 项测试通过：原文导入与读回、IPC 拒绝／EOF 释放、暂存后及提交后的真实进程强杀恢复、同物理 profile 复用和原来源迟到新增撤权；同时验证启动确认前不创建事务，以及完成后拒绝再次导入。强杀通过实际构建脚本的调试器断点观察原生 pending／commit，未替换只读 `invoke` 或放宽产品权限。
- 初次错误草稿夹具、在授予前向受保护输出加入目录、无效的只读 invoke 拦截、未等待 WebView2 收尾的目录释放断言和 Clippy 写法失败均保留在 `artifacts/tauri-migration/runtime-bootstrap-*` 的日志／报告中。修正夹具及写法，不把这些失败表述为已发布框架缺陷；历史 Electron 普通保存 EPERM 的具体占用者继续未知。
- 2026-11-13 19:34（北京时间）本轮限定范围的冻结回归通过：556 项源码／测试／配置输入、13 个串行步骤、230 项 Node＋4 项无窗口、506 项 Rust（默认另 2 项 ignored）、四套／57 项原生测试和普通隐藏启动生命周期。两类 TypeScript、严格 Clippy、Release all-target check、fmt 与实际 Debug 构建均通过；两项默认 ignored 的实际工作区所有权和正式发布字节用例分别显式执行且通过。本轮只覆盖验证脚本列出的套件，不冒充此前二十套原生全回归或完整迁移验收。
- 最终报告与逐步日志、原生证据副本位于 `artifacts/tauri-migration/runtime-bootstrap-final/`；`evidence-audit.json` 独立复核全部 556 项输入、13 步日志、实际 Electron 主进程／preload 与 Tauri EXE、两项显式原生用例和保留日志摘要。首次冻结的 Clippy 失败保留于 `runtime-bootstrap-clippy-failure/`，未覆盖成成功。`process-cleanup.json` 于 19:35 只读确认项目 Electron／Tauri、隔离 WebView2、记录读取进程及本轮新建相关 TEMP 目录均无残留；历史目录保留，未操作用户剪贴板或无关进程。
- 完整范围、协议和复跑入口见 [隔离运行启动与浏览器草稿接入](RUNTIME_BROWSER_BOOTSTRAP.md)。尚未接管原 LAN 服务、开放普通编辑器／后台服务、实现整体生产切换与完整回退；仍不切换默认入口，不提交／推送／发布，版本保持 1.0.2。
- 该阶段的下一步是把准备 Electron 的真实存活维护会话接入新运行入口，当前进展见上节；全编辑器屏障、原 Session、服务暂停和超时／取消须持续有效。原 LAN 正式服务移交和整体切换的持久决定仍未实现。

## 原浏览器归档的运行来源授权（此前增量，未接 GUI）

- 运行所有权现可从原组合快照的固定文件句柄有界读取完整原始浏览器归档并重核摘要／取消；真实工作区只有持有该活权限且仍处于原检查点时，才能让原始归档进入既有原生草稿事务。可变 Data 中的同名归档不能替代原对象。
- 普通目录仍要求原生谱系的原物理根，不为克隆目录放宽校验。新测试覆盖原字节重复读取、同名替代无效、恢复、迟到原来源条目、分块限额／取消和撤权；正式字节工作区用例新增原目录／普通克隆／活权限来源及事务准入区别，中止后仍须完成浏览器恢复，不能自动开放编辑。
- 当前 Rust 504 项（默认另 2 项 ignored）、正式字节来源专项 65 项（含所有权 12 项）和真实工作区门槛 1 项通过，严格 Clippy、Release 全目标、格式和两类 TypeScript 检查通过。229 项 Node 全通过，但四项无窗口测试中一项再次遇到 Electron 保存重命名 EPERM／持久化超时；具体占用者未知，未改成通过。记录位于 `artifacts/tauri-migration/runtime-browser-provenance/`，明确全量未通过；此前剪贴板前置阻断也没有被本轮专项替代。
- 尚未接入实际 GUI／新 profile、WebView2 写入及读回、客户端断连、LAN 服务移交和整体切换。

## 实际运行 Data 可写所有权（此前增量，部分证据归档）

- 输出文件固定释放前取得真正跨运行时目录独占，独立所有权意图／不可逆授予与原生记录持续固定；原来源、完整快照与原 LAN 保持冻结。可变输出不重放旧只读清单，只通过原成功授予及原根／父目录身份恢复。
- 实际 `WorkspaceStore` 消费不可序列化 `RuntimeOwner`，采用原独占而非释放重取，已经执行真实加载、编辑、保存、重开和取消后读写保护。所有权子进程验证意图／授予／实际写入后退出及双进程原生锁排他。
- 502 项 Rust 全集通过、默认 2 项 ignored；正式字节来源专项 64 项（含所有权 11 项）及真实工作区门槛 1 项另行显式通过，严格 Clippy、Release 全目标和格式检查通过。原 LAN 已初始化情形的原租约／身份保活也已验证，不是 LAN 服务接管。
- 首次 547 项输入／计划 28 步完整冻结回归在 2026-11-13 17:43（北京时间）前置失败：GameViewer 的虚拟文件剪贴板 `FileContents` 无法无损备份，维护测试尚未启动应用；没有清空或替换用户剪贴板。保留失败原证据，之后的剪贴板无关子集不替代全量门槛，不把上一阶段 542 项输入／491 项 Rust 当作本轮验收。
- 当前 547 项源码冻结的八套／61 项剪贴板无关原生回归及普通工具箱生命周期通过；真实工作区专项再次通过。结束只读审计无 Electron／Tauri 残留进程或工作区专项 TEMP 目录。部分证据归档为 `artifacts/tauri-migration/runtime-ownership-partial/`，明确全量未通过，不标成完整成功归档。
- 尚未接入实际 GUI 启动、原 LAN 服务接管、浏览器导入或完整切换／回退；详见 [运行 Data 可写所有权](RUNTIME_DATA_OWNERSHIP.md)。

## 实际运行 Data 准备（上一增量，准备内核已验证）

- 在保留原来源／快照／原生决定句柄的会话内，从原对象句柄复制实际 Data 树；保留原字节、空目录、精确 Windows 写入时间和只读属性。输出不含快照 objects、浏览器／LAN 副本和旧锁。
- 新增先写意图、完整外置清单、独立决定和实际输出保活；中途失败保留部分文件，恢复只中止未决定意图。原生元数据查询支持有界分页与丢响应后发现，但不代替显式输出核验。
- 修复精确句柄发布的长本地路径 os error 206，并保留禁止覆盖与身份／祖先固定。2026-11-13 17:05（北京时间）完整冻结回归通过：542 项输入、27 步、229 项 Node、4 项无窗口、491 项 Rust（另 1 项默认 ignored）、二十套／189 项原生测试及普通工具箱生命周期；正式参考来源专项另行显式运行 53 项全通过。严格 Clippy、Release check、fmt、Debug 构建及主进程 TypeScript 检查通过，实际输入／日志／可执行文件／原生报告独立复核一致，归档为 `artifacts/tauri-migration/runtime-data-preparation-final/`。
- 运行数据内核专项 12 项，原生与真实 Electron 专项共 21 项通过；原目录形态／元数据、实际输出与记录保活、丢响应后的状态发现及显式核验均已验证。终止后进程／临时目录审计为零，无手工强杀或删除；保留本轮早期失败和七批历史基线，不把旧保存 EPERM 计为已解决。
- 尚无新运行时启动、实际所有权移交、浏览器草稿导入或生产切换。机制、接口和剩余门槛见 [运行 Data 准备](RUNTIME_DATA_PREPARATION.md)。

## 完整目标与实际原生决定保活（上一增量）

- 2026-11-13 15:08（北京时间）完整冻结回归通过：538 项输入、27 步、229 项 Node、4 项无窗口、478 项 Rust（默认另有 1 项 ignored）、二十套／187 项原生测试及普通工具箱生命周期；正式参考来源专项另行显式运行 43 项全通过。全部输入／日志／实际可执行文件摘要及二十份原生报告独立复核一致，严格 Clippy、Release check、fmt、Debug 构建和主进程 TypeScript 检查通过。完整证据归档为 `artifacts/tauri-migration/target-retention-final/`。
- 修复核验返回后释放目标句柄的确定性缺口：新增回归在修改前可直接打开 `handoff.json` 写句柄而失败，原始证据保留于 `artifacts/tauri-migration/target-retention/before.log`。
- 成功会话保留完整组合包／Data／objects、两份清单、原始草稿、可选 LAN 状态及实际 catalog／意图／成功决定。重复查询复用原句柄重算所有摘要，确认检测目标三层目录新增、文件属性／身份／单链接变化；只从当前存活来源和真实原生成功决定构造护栏。
- 真实写者、中途取消／授权失效、错误回执和复制包均拒绝且释放构造中的部分句柄；helper 正常关闭、失败或强制退出后释放全部保活，但不改写原成功决定。完整机制与当前边界见 [目标与原生决定保活](RETAINED_SNAPSHOT_TARGET.md)。
- 真实 Electron 在三次原生成功响应时分别直接确认 11 个目标／原生记录文件仍拒绝写入，helper 退出后逐个恢复可写；原生进程验证三层目标新增撤销及核验后强制终止／重开。首次完整检查的旧无窗口保存 `EPERM` 原件与同源码独立复验均保留，第二次完整冻结通过不代表已定位或修复该瞬时阻断。清理审计未发现残留应用／测试进程或本轮临时目录，没有手工强杀或清理。
- 当前仍是“不切换”准备模式；下一门槛是把双方存活护栏贯穿真实持久切换／所有权移交／恢复／完整回退，不把静态元数据、准备成功或护栏保活替代正式迁移验收。

## 存活来源完整资产复核（上一增量）

- 原生成功决定和目标内容验证现在直接提供同一已认证 Data 清单，原生来源重新固定并核验全部非运行时资产；工作区不变而资产变更的旧记录不再通过。同身份、同大小并伪造原写入时间仍须通过完整 SHA-256。
- 资产／空目录句柄持续持有，后续确认复核目录集合和元数据，再次完整查询复用原句柄重新哈希，不释放后重开；同一会话绑定一个准备 ID 和完整回执，不接受跨 ID 或固定后再准备。helper 退出才释放资产，失败不抹去原准备决定。
- 十项资产内核专项通过，覆盖八种变更、伪造时间、写者冲突、迟到新增、固定后新增、按读取块取消／授权失效、只读属性及运行锁排除。真实 Electron 在原生 `verifiedPrepared` 输出后、客户端处理前探测写句柄被拒绝，关闭后恢复可写；不把旧回执或 UI 显示当成存活资产权限。
- 该阶段完整冻结于 `2026-11-13T06:17:12.433Z` 通过：全部源输入、二十份原生报告、日志与实际构建摘要重新核验一致，主进程 TypeScript、严格 Clippy、Release check、fmt 和 Debug 构建通过。旧 534 项归档保留不变。该批结果不包含本轮目标保活，也不证明持久生产切换／恢复／回退；详细机制、原始失败与验证范围见 [活源资产复核](LIVE_SOURCE_FRESHNESS.md)。

## 实际 Electron 来源组合维护（上一增量）

- 文件和托盘新增独立准备／取消菜单；实际目录选择确认后等待全部编辑器保存，LAN 单独排空释放独占，不销毁图片资产，然后使用真实 Session 的受控读取、谱系和分块原生准备。核验原生持久决定及真实目标物理身份后才显示成功，现有草稿导出不改变语义。
- 超时或取消不再早于已封存原生操作的清理解除门闩。退出请求只取消当前准备并等待排空；已决定后客户端取消保留目标与决定，不伪装为未曾发布，也不自动删除。LAN 恢复失败保留用户可见警告，并保留主操作错误。
- 实际重启 Session 和原 LAN 服务的九项专项通过；测试使用精确正式参考字节、真实主窗／任务组件、回环限定的 TLS 服务和原身份，不执行旧代码或外发发现广播。真实 file URL 共享当前 profile 存储，因此维护时当前任务草稿更新也会反映在读取检查点；不把选中目录伪装成历史 profile 归属证明。系统目录对话框仅在测试进程替换。
- 新入口完整冻结于 `2026-11-13T05:32:22.721Z` 通过，输入、全部日志和实际构建摘要复核一致；主进程 TypeScript、严格 Clippy、Release check、fmt 及 Debug 构建通过。原始夹具失败与首次完整回归的过时取消契约自锁日志均保留；十七项相关专项及重跑完整冻结通过，不能把这些测试失配写成产品历史来源隔离已修复。实际迁移门槛仍未满足，详见 [存活来源组合快照](LIVE_SOURCE_SNAPSHOT.md)。

## 存活来源与冻结 LAN 的原生组合快照（上一增量）

- 新增消耗原生存活来源的 `FrozenSource`，贯穿真实 LAN 物理目录独占、原始文件固定、Data／资产清单、分块原始 Electron 格式草稿和外层持久准备决定；目标不能位于受保护源内，不导出身份私钥或接管生产目录。
- 新增独立 `--legacy-source-snapshot-v1` 通道；只读来源租约模式不能上传或发布。原生成功记录绑定完整来源和 LAN 检查点，重启核验不能靠旧回执重新授权已替换的 profile 或已改变的 LAN。
- 实际复现并修复来源工作区租约与零共享快照读取的 Windows 共享冲突；只允许根工作区的被动读取，保留拒绝写入／删除及其他文件零共享约束。原始失败与测试文案失配保留。
- 此阶段完整冻结于 `2026-11-13T04:40:22.766Z` 通过：532 输入／26 步／225 Node＋4 无窗口／459 Rust（默认另有 1 项 ignored）／十九套原生 174 项；严格 Clippy、Release check、fmt、Debug 构建与普通工具箱生命周期通过。来源内核另行显式执行 40 项全通过，原始失败保留。当时实际准备 Electron 浏览器读取与全维护入口尚未连接；重开记录核验仍不是完整活源资产新鲜度许可，不将原生夹具当作生产组合迁移通过。

## 实际准备运行时来源绑定（上一增量）

- 旧安装导出不再仅信任目录字符串：临时 Rust 子进程匹配真实正式包，固定代码、实际原生 Data 检查点、当前 Session 配置和 userData／LAN 目录；私有 stdio 通道、请求 ID、取消／EOF 和实际物理身份约束不能由 renderer 回执替代。
- 采用全阶段维护，持有至原始草稿读取、谱系和发布前确认结束；保留普通来源导出、v1 草稿格式及退出排空行为。源变更或 helper 丢失不发布，结束后无常驻 helper。准备 Electron 的打包 helper 尚未分发，缺失明确失败，不回退为未认证读取。
- 新增测试实际发现并修复属性目录句柄不能独立阻止重命名的问题，底层固定目录增加真实目录读取访问；修复前两项失败保留。只读工作区允许受信读取但拒绝写入／删除，原始内容及未知字段不重写。
- 已通过真实正式代码与实际 Electron 受控导出、原生私有租约检查，包含持有期间写入拒绝、helper 中断、EOF、篡改、外部 profile、迟到 LAN 目录和清理；首轮测试工具动态 import 失败保留。LAN 仍只绑定目录、不冻结状态，不能据此称完成组合生产快照或历史 profile 认证。
- 本轮完整冻结于 `2026-11-13T03:52:08.409Z` 通过：530 输入／25 步／225 Node＋4 无窗口／448 Rust（默认另有 1 项 ignored）／十八套原生 168 项；严格 Clippy、Release check、fmt、Debug 构建和工具箱生命周期通过。另行显式执行来源内核 30 项全通过，未执行旧 EXE 或接管生产数据。归档包括逐步日志、报告、源码与产物摘要、原始失败和清理核验；不覆盖 525 输入基线。机制和下一步见 [实际运行时来源绑定](LIVE_SOURCE_BINDING.md)。

## 正式旧版安装来源识别（上一增量）

- 已从正式 `v1.0.2` Release 取得原始 SHA256SUMS，核对本地历史绿色 ZIP 的精确摘要；只提取 EXE／ASAR，从未运行旧代码。只提取文本核对真实发布包的入口、页面及 Data／LAN 相对路径，不再以当前源码推测正式旧版。
- Windows 原生 `PinnedInstallation` 使用编译内置信任目录，持有安装根、resources、全部祖先及两个单链接普通文件；64 KiB 有界散列及原生有效性／取消检查，同一发行版同时匹配 EXE／ASAR，并能在存活句柄上重新确认。既有读写锁、junction、硬链接、替换和篡改均拒绝，不放宽权限或执行旧程序。
- 主窗独有 `legacy-source-inspection` 权限和真实原生选目录入口；不接收 renderer 路径、哈希或信任回执。返回仅供展示的信息，检查结束释放所有句柄，不能复用为未来接管凭据。`productionReady`、`migrationComplete`、`legacyExecuted`、`productionDataRead` 均为 false。
- 专项已通过 16 项 Rust（含显式执行的真实正式包用例）、Clippy、5 项权限契约，以及真实主窗／原生选择的 8 项检查；包含正式字节、伪回执取消、同尺寸篡改、返回后的锁释放、工作区未变且无迁移决定／LAN 身份创建。原生截图已查看；原始证据在 `artifacts/tauri-migration/source-authentication/` 和 `legacy-source-native/`。
- 当前仅支持官方 Windows x64 v1.0.2 的两个代码文件，非 Authenticode 或全安装树安全认证；未知版本和重新打包构建拒绝。未与实际生产 profile／Data／浏览器／LAN 绑定、未接管或切换，也未解决通用／改名 Electron 检测、完整回退、外部文件、物理双机和 Release 产物门槛。详见 [正式旧版来源说明](LEGACY_SOURCE_AUTHENTICATION.md)。
- 本轮完整冻结于 `2026-11-13T02:54:45.358Z` 通过，525 输入／22 步／433 Rust／十五套原生 145 项；包含原有跨运行时交接、共享读取、Data／组合快照及新增正式字节校验。当前源码、执行文件与逐步日志摘要再次核对，证据封存，不覆盖 519 输入基线和历史失败。来源检查仍不构成生产数据接管能力。

## 草稿原生记录共享读取（上一增量）

- 已用显式共享模式的 Windows 句柄实验和实际原生事务测试，稳定重现目标仅有共享只读句柄时的 `MoveFileExW os error 5`；修复前确实执行一项确定性测试并失败，与历史失败的非只读／DELETE 探测采样一致。原始瞬时句柄的具体进程仍未知，不归因杀毒软件或权限设置。
- 只对两个已存在的原生草稿记录接入单次源句柄 FileRenameInfoEx 发布：父目录固定、源禁止写入／删除共享、目标拒绝写入共享，目标只读与拒绝 DELETE 的真实占用继续失败。只有可共享只读观察者得到兼容，旧句柄保留旧完整记录、新打开看到新记录；不改 ACL、不清只读、不重试或回退，首次不覆盖发布和既有记录格式保持不变。
- 六项文件内核、十七项原生事务 Rust 定向通过，严格 Clippy 通过；Clippy 首次指出新测试清理直接 set_readonly(false)，已改为还原夹具创建时的原权限，未降低检查。真实 Tauri 套件新增两个外部进程持有读句柄、跨决定与重启完成的场景，当前十八项事务原生检查全部通过，包括保留的两项只读保护与明确修复后恢复。
- 2026-11-13 首次原生定向执行中，两个新共享读取场景和完整导入套件（包括先前失败的 lost-begin-response）通过；事务套件两处预期只读拒绝确实返回新 API 的 os error 5，但旧断言仍要求错误包含 MoveFileExW，因此本次定向总体失败。仅将精确 API 名断言同步为 FileRenameInfoEx，保留文件名、错误码、内容不变／不开放编辑器及明确修复后恢复的全部断言；原始失败日志 `replacement-diagnosis/native-regressions-first.log` 保留，不把断言修正冒充产品修复。
- 详细机制、范围、保留限制和官方语义见 `docs/NATIVE_RECORD_REPLACEMENT.md`；普通文件替换及历史无窗口偶发超时不因这个限定修复就算解决。
- 最终冻结运行于 2026-11-13T02:12:07.346Z 完成：519 项输入、21 步全部通过，223 项 Node、4 项无窗口、418 项 Rust、严格 Clippy、Release all-target check、fmt、实际 Debug 构建、十四套／137 项原生检查及普通工具箱生命周期。没有把旧失败项简单重试到绿：增加了确定性红测试、源句柄发布与写锁保护，并同步精确 API 名后才运行本次完整链。
- `native-record-replacement-final/verification.json` 绑定冻结报告与全部 21 步日志、原生产物与每套原生证据、五张实际截图、确定性修复前失败与首次精确名称断言失败；`full-run/` 和原生证据／截图另存副本，不依赖之后会被更新的活动路径。源码、日志和产物摘要完成后再核验，productionReady=false、migrationComplete=false；本轮没有提交、推送、改版、切换生产目录或发布。
- 同目录 `process-cleanup.json` 于 2026-11-13 10:15（北京时间）只读复核：项目 Debug Electron／Tauri、隔离 WebView2、独立 PowerShell 记录读进程及本轮创建的临时夹具均为零，历史临时目录未删除。保留旧阶段失败报告，不把本次完整通过改写成生产迁移或物理／性能／安装验收完成。

## 原 profile 组合交接快照（前阶段）

- 已把实际 Data、原样浏览器白名单归档和原始 LAN 持久状态接入一次原生维护；新增隔离主窗“准备隔离交接快照”。源／目标均由原生取得，复用全部编辑器保存／冻结、服务／LAN 收尾、真实工作区所有权及浏览器谱系；不切换生产目录、默认入口或版本。
- LAN 检查点持续持有共用实际目录租约及原文件句柄，只绑定原 profile 中的原身份 ID／公钥指纹与物理文件证明，不生成或导出私钥。未使用 LAN 不初始化；已存在状态缺少原身份、瞬态文本／控制数据、链接、占用或源变化均拒绝，状态原样保留 enabled／trusted 等字段。输入缓冲有界且销毁清零；复制 profile、替换身份或状态不能作为原来源重新打开。
- 整体包包含既有 Data 对象／清单、草稿归档、可选原始 LAN 状态和最后发布的 `handoff.json`。V2 原生意图先于全部输出并绑定组件摘要，只有整体物理回执核验后追加 `handoffPrepared`；启动只中止未决，不把内层／外层完成清单提升为成功。V1 Data 记录保持兼容；历史成功不授权当前切换，也不使普通启动依赖旧介质在线。
- 严格标记 `original-profile-only` 与 `original-locations-required`：身份仅留原 profile，外部发送源／接收终文件／续传分片不在包内，NTFS 额外语义未补齐；这不是独立灾难恢复包或完整回退。普通快照／日志不包含私钥。完整格式、上限与授权边界见 `docs/MIGRATION_SNAPSHOT_FORMAT.md`。
- 新增 11 项 LAN、6 项组合 Rust 测试和七项实际 Tauri 原生检查；四个真实子进程退出边界不代替 OS／断电证明。原生检查覆盖主窗与组件脏输入、raw 白名单和 cookie 排除、enabled LAN 原身份／状态保留与服务恢复、角色权限／伪造参数、非法白名单、真实硬链接失败后的 V2 启动中止，以及准备 Electron 的实际原目录谱系接受。
- `lan-checkpoint-first.log` 保留早期 Rust 夹具逗号语法错误；`handoff-bundle-kernel-first.log` 的零测试由补丁后半段失败未写入测试文件导致，不计通过证据。修正后分别 11／6 项定向通过，`handoff-native-first.log` 七项原生通过；未靠重试、放宽权限或清理失败现场解决产品问题。旧 Windows MoveFileExW 拒绝及无窗口偶发超时仍未定位，不称作已修复。
- 前阶段 510 项输入／394 项 Rust／十三套原生的最终报告、日志、Data 原生证据及截图已原样另存 `artifacts/tauri-migration/snapshot-preparation-510-baseline/`，`relocation.json` 复核旧摘要并说明旧活动路径会被更新；旧证据只说明当时源码，不作为本次新增源码的通过证明。
- 本次冻结链在 `tauri-draft-transaction` 的 tray-abort 原生决定替换时再现 `MoveFileExW os error 5`；即时采样两文件均非只读且 DELETE 探测可打开，不能据此归因 ACL、杀毒软件或断言已定位。原始报告／日志另存 `handoff-frozen-first-failure/`，没有重跑失败项、修改权限或自动重试。只在同一输入摘要下接续尚未执行的套件，接续报告为 `handoff-frozen-continuation/verification.json`，其通过也不改变完整链失败。
- 接续的 `tauri-draft-import` lost-begin-response 同样因持久中止决定替换被拒绝而停在受控恢复页，外部断言等待编辑器重载超时；后续该套件场景未执行，不能算已覆盖或把超时伪称已修复。两处错误均保留原路径、立即采样与调用栈，完整回归必须保持未通过状态。
- 2026-11-12 22:26（北京时间）接续结束，全部 516 项冻结输入前后及最终摘要一致：223 项 Node、4 项无窗口、411 项 Rust、Clippy、Release all-target check、fmt、Debug 构建及普通工具箱生命周期通过。21 个步骤中 19 个通过、2 个失败；十四套原生中十二套通过，实际报告 127 项／5 项失败（含父级失败），导入套件另有 8 项未到达，不能写成 135 项通过。新增组合七项与既有 Data 七项均在此相同输入上通过。
- `artifacts/tauri-migration/handoff-snapshot-stage/verification.json` 交叉复核全部输入、21 步实际日志、产物、原生证据及截图；保持 `verified=false`、`fullRegressionVerified=false`，只有本增量 `incrementalVerified=true`。`process-cleanup.json` 只读核验本轮项目进程、隔离 WebView2 与本轮创建的临时夹具均为零；历史遗留目录未删除。源码与功能定向通过不改变完整回归失败，也没有提交、推送、改版或发布。

## Data 原生持久准备与隔离主窗（前阶段）

- 新增原生 `Catalog`：按源／记录目录真实身份绑定并持有独占句柄；128 KiB 记录边界、最多 4096 次操作、严格 schema、未知内容拒绝。先不覆盖发布并读回 `intent.json`，再创建目标及复制；只有完整核验和维护有效时才不覆盖追加 `decision.json`。同名文件、原决定及源内容从不自动删除／重写，失败保留现场。
- 实际 `WorkspaceStore` 从原生根目录与跨运行时命名管道所有权出发，生成 profile 内、Data 外的记录目录；每块重新核验原生维护租约和所有权。启动在工作区普通访问前恢复有效未决记录为 Aborted，不因对象或完成清单存在而认定成功。记录错误阻止打开，保留意图／决定／快照，须明确排除原因后重启；普通启动不要求旧快照介质在线，历史 Prepared 不代表当前完整性或接管许可。
- 隔离主窗“准备隔离 Data 快照”使用真实 Windows 文件夹选择，并将目标父目录固定、新目标名原生生成；物理祖先身份拒绝 profile 内部路径及 verbatim 别名。准备调用既有全部编辑器保存／冻结和后台服务／LAN 停机协议，并在存储队列及窗口维护门闩内运行。渲染进程不能提供源、目标路径、摘要或回执；prototype、组件、恢复、覆盖层、贴图和快速记录均不具备该命令权限。
- 12 项持久记录测试涵盖独占、原生目录复制拒绝、篡改／超限／硬链接、取消／撤权、不可覆盖发布、阻断决定后的明确排障，以及三个真实子进程退出边界（意图后、清单后未决定、成功决定后）。4 项工作区测试验证实际命名管道所有权、启动前只中止、损坏恢复阻断及整个 profile 的物理路径保护；未将进程退出等同物理断电。
- `npm run e2e:tauri:migration:snapshot` 与 `data-snapshot-native/verification.json` 记录七项真实 Tauri 检查：原生取消／内部目录选择、主窗快速记录与组件输入维护、原始工作区和空目录／资产、持久回执、错误调用角色与伪造参数不能绕过选择、真实硬链接拒绝留下 pending 并重启为 abort，以及移动历史快照不影响普通编辑。`data-snapshot-native/prepared.png` 是实际成功界面；源／目录均为隔离夹具，不操作生产数据。
- 保留专项早期失败：`snapshot-preparation-first.log` 中的 .part 断言错误把“读到被目录阻挡的决定”当成已经开始发布；拆分为实际阻断测试与直接不覆盖发布测试，未放宽保存／只中止断言。`snapshot-preparation-contract-first-failure.log` 记录新增最小权限后的旧精确列表差异，更新列表并另检查其他窗口无该权限。原生首次失败 `snapshot-preparation-native-first.log`／`snapshot-preparation-native-first-failure.json` 是夹具对异步所有权获取使用同步 assert.throws，改为等待 assert.rejects，保留跨运行时真实互斥断言；不称作产品修复。
- Ready 租约仍为两分钟，过期停止且保留不完整目录，不截断或自动续期。本次只准备 Data，尚无浏览器草稿、LAN 状态／原身份、NTFS 额外语义和外部收纳文件的一致组合／恢复，也没有生产来源认证、正式切换或发布入口；普通备份和日志依旧不包含 LAN 私钥。后续仍须完整生产准备／切换决定、回退演练及原计划全部物理／性能／打包门槛。
- 最终 `draft-reverse-final/verification.json` 于 2026-11-12T13:45:09.563Z 完成，verified=true、sourceStable=true；510 项源码／配置／测试输入前后及结束后摘要一致，20 步全部串行重跑，不复用历史日志。TypeScript、223 项 Node、4 项无窗口、394 项 Rust（含本轮 12 项目录与 4 项工作区）、严格 Clippy、Release all-target check、fmt、Debug 实际构建、十三套／128 项原生检查和普通工具箱生命周期通过；各步日志／产物摘要再次复核。`snapshot-preparation/verification.json` 同时绑定七项原生专项及实际成功截图摘要，productionReady=false、migrationComplete=false。
- `snapshot-preparation/process-cleanup.json` 只读复核项目 Debug Electron／Tauri、隔离 WebView2，以及 Data 内核／持久目录／原生工作区临时夹具，残留均为零，未结束无关进程或清理未知目录。前一阶段 506 项输入／378 项 Rust 的报告与日志完整保留在 `snapshot-preparation-baseline/`，历史失败仍保留而非因新运行通过被撤销。

## 受管 Data 快照内核（生产组合协议尚未完成）

- 新增 Windows 原生 `managed_snapshot` 存储内核，固定 Data 全部普通文件和目录，保存原始工作区、资产、收纳日志、备份与空目录，仅排除根运行锁；不规范化 JSON、不改写路径。新目标不覆盖／合并，数字对象分块复制、刷新、读回核验，清单最后发布；取消／撤权或失败保留不完整目录，不递归清理。
- 普通完整性核验与原生回执核验分开：复制快照可以通过字节完整性检查，但不能冒充原目标的物理目录身份。回执必须来自后续受控原生准备记录，不能信任归档或渲染进程提供的回执。源文件／祖先固定、链接与 junction 拒绝、源变化、清单边界、1 TiB 实际稀疏文件、跨应用版本元数据及回执复制拒绝由 17 项本机文件系统测试覆盖。详细格式与边界见 `docs/MIGRATION_SNAPSHOT_FORMAT.md`。
- 这是前一阶段存储内核边界记录：当时尚未接通原生持久准备意图／决定与启动恢复、全部编辑器及服务协调。当前 Data 专项协调见上节；生产可信路径选择、浏览器草稿和 LAN 状态／原身份的一致组合或恢复仍未完成，LAN 私钥不进入普通快照／日志。NTFS 安全描述符、备用流和外部收纳文件语义也未捕获，不能据此宣布完整回退或切换完成。
- 本轮首次完整回归的 Node／无窗口、376 项 Rust、严格 Clippy、Release check、fmt、Debug 构建与前六套原生检查通过，但 `tauri-draft-transaction` 的 tray-abort 再现 Windows `MoveFileExW` 错误 5；失败记录仍为 pending、未完成。原始报告、日志和状态保存在 `managed-snapshot-transaction-first-failure.json`、`managed-snapshot-transaction-first-failure.log`、`managed-snapshot-transaction-first-state.json`，未把拒绝原因推断成已证实的文件占用或杀毒拦截。
- 原子替换只增加失败后的即时属性／DELETE 共享采样，保留原始 OS 错误；不自动重试、不改权限、不放宽共享保护。新增两项测试验证占用及只读诊断、原内容／属性保持不变，必须显式解除原因后再执行新的操作。该采样晚于失败，仍不能保证捕捉瞬时根因，历史替换拒绝与无窗口偶发超时继续列为未解决。
- 前一阶段源码冻结回归于 2026-11-12T13:12:47.266Z 完成：19 步全部通过，506 项输入前后及结束后 SHA-256 复核一致，构建产物和各步日志摘要亦复核。223 项 Node、4 项无窗口、378 项 Rust（含本节 17 项快照与 2 项失败诊断）、十二套／121 项原生检查及独立普通工具箱生命周期通过；严格 Clippy、Release all-target check、fmt 与实际 Debug 构建通过。历史报告及逐步日志另存 `snapshot-preparation-baseline/`，`managed-snapshot/verification.json` 保留原摘要；这不是本次新增协调源码的通过证据。productionReady=false、migrationComplete=false，后续成功也不撤销已保留失败或扩大生产验收范围。
- `managed-snapshot/process-cleanup.json` 在本轮结束后只读检查项目 Debug Electron／Tauri、隔离 WebView2 和本内核临时夹具，三类残留均为零；未终止无关进程或递归删除未知目录。

## 文件拖入与内部拖动进展（P1/P2/P5 部分，尚未完成验收）

- 共享 onFilesDropped 接口提供路径、WebView 逻辑像素落点及错误；Electron 从实际 File 提取本地路径，Tauri 仅从真实 WindowEvent 拖放接收路径，未提供可由页面传入路径取得拖放授权的命令。主页面通过私有 Channel 接收，覆盖层、组件和恢复页不具备该命令权限。
- 原生按完整批次验证绝对路径、重解析点、普通文件/目录和数量，大小写不敏感去重；只登记实际拖入的精确路径，不授权父目录或同级文件。失败发布回滚本批新授权，保留已有合法授权。维护、退出、重载和恢复使排队任务失效，恢复编辑后保留有效通道。相关路径、授权和生命周期已由 Rust 单测覆盖，尚不能替代真实 Shell 拖入验收。
- 图片工具箱、截图和局域网页面接入共享落点路由，只有当前可见、非忙碌且实际命中的区域处理导入，跳过被遮挡、输入框和对话框；仍保留浏览器 File 字节导入。原生授权发生在实际主窗口投递边界，不宣称仅在前端接受区域内才产生授权。截图后续接入及验证见“截图原生文件导入与真实拖入”节；当时局域网 Rust 服务尚未实现；当前接入范围见下方原生 LAN 桌面服务节，仍不计作完整迁移。
- 侧栏排序、桌面项目拖入分类改为 dnd-kit 指针与键盘传感器，保留上下移按钮、原生收纳事务、撤销和原有打开/菜单操作；拖动手柄沿用 Lucide GripVertical。真实 WebView2 已验证侧栏指针提交、键盘提交/取消及重载持久化，以及收纳键盘取消、指针/键盘移动、实际文件内容和撤销恢复。报告为 artifacts/tauri-migration/internal-drag-native.json；键盘自动化等待激活、布局及碰撞渲染帧，不用合成 drop 事件替代实际传感器。
- 核验 Tauri 框架源码发现其自身仍会广播拖放事件，仅新增私有通道不足以限制原型跨窗监听。已移除原型的通用事件权限，改为当前真实窗口、事件白名单和私有 Channel；跨窗目标不接受页面参数，重载/销毁清理原生监听。原型截图/贴图与工作区多窗同步原生回归通过；独立权限拒绝场景和通道排序/取消测试保留。
- 外部 OLE 自动化已通过 13 项原生测试（含父测试）：真实 CF_HDROP 取消不授权、Unicode/重复/多图导入、精确路径且不授权父目录或同级文件、合成事件拒绝、缺失文件与 junction 整批拒绝、维护恢复、非活动页/输入框/真实确认框忽略、慢速导入期间不重复处理、重载撤权与旧令牌不能拆除新通道，以及备份恢复撤权后重新导入。相同进程还验证侧栏指针/键盘排序，与独立收纳移动/撤销套件共同覆盖内外拖动共存。报告为 artifacts/tauri-migration/file-drop-native.json；不据此宣称截图业务、局域网或物理混合 DPI/Explorer 手工拖入全部验收完成。
- 原始 .NET 夹具和初版 C++ 夹具均卡在 Ole32 消息循环；自采原生栈及源回调诊断定位为源线程未收到移动唤醒。现使用 tests/tauri-file-drop-native.cpp 创建隔离源窗口，构造真实 IDataObject/CF_HDROP 与 IDropSource，经 DoDragDrop 进入系统目标；只向夹具自身线程投递 WM_MOUSEMOVE 唤醒，不向应用伪造 drop 或授权消息。夹具限定临时根与精确测试进程/窗口，有十秒 watchdog，并恢复鼠标和前台；MSVC 仅用于测试编译，不增加产品运行依赖。已删除失效的 .NET 方案，保留全部失败日志，不将夹具修正写成产品拖放 Bug 修复。
- 此增量 Rust 243 项单测、严格 Clippy、fmt、Release 编译检查通过；完整本轮结果与未通过门槛统一记录到 artifacts/tauri-migration/file-drop-verification.json。以前图片工具箱的 25 套/287 项报告仅是历史基线，不能当作当前改动的全量原生证明。
- OLE 夹具修正后的相关原生回归按顺序运行 file-drop、internal-drag、toolbox-images、toolbox-text、backup、workspace、main-release 与 native，共 8 套/85 项均通过、无跳过；OLE 套件包含 14 次真实系统拖动。退出码和日志索引为 artifacts/tauri-migration/file-drop-final-native-runs.json。不以本次 main-release 成功宣称历史菜单快照间歇性失败已修复。
- Electron 原生工具箱回归增加真实磁盘 File 的共享路径订阅：落点位于图片页时只导入一次，截图页无人接受订阅时仍向 DOM 传播并成功导入，隐藏图片页不消耗截图拖入；保留双 Electron 的本机 TLS 配对、文件/目录/文本、托盘接收与源文件占用重试验证。日志为 artifacts/tauri-migration/file-drop-electron-routing-third.log；此测试通过实际 Electron webUtils 与 DOM 路由，但不冒充物理 OLE 或两台电脑互传。
- 夹具与双运行时回归更新后再次完整执行 npm run check:silent：202 项 Node、4 项无窗口测试通过、无跳过；Rust 243 项、fmt、严格 Clippy 和 Release check 再次通过。当前验证报告包含对应日志 SHA-256 与新测试源码指纹，保留原始 .NET/OLE 超时和两次 Electron 测试定位修正的失败日志；整个迁移仍为 productionReady=false。

## 原生截图文档与源图会话（P5 部分）

- 新增 Rust screenshot/screenshot_api 服务及主窗专属 screenshot-documents 权限，只开放创建、文档元数据、源图二进制读取和显式丢弃。原型、组件及恢复页无该能力；文档 ID 和源图资产 ID 由原生分别生成，不能用资产 ID 或任意路径读取源图。
- 支持 PNG/JPEG/WebP/BMP，输入和归一化源图上限 32 MiB、4000 万像素；PNG 解码验证后保留原始字节及元数据，其他格式归一化为 PNG。单原生工作槽、64 会话及 256 MiB 压缩源图预算；耗尽时明确拒绝新建，不静默驱逐仍在编辑的源图，显式丢弃恢复预算。
- 共享 React ScreenshotPage 通过原生适配器创建/读取源图，继续使用原有 Canvas/Worker、矩形标注和撤销重做。切换来源及卸载时释放文档，迟到导入不覆盖新来源；新文档首次源图交付失败清理未认领文档，已有文档读取失败保留源图以便重试。
- 退出和草稿维护使进行中的任务失效；维护恢复保留已存在的源图。成功恢复备份、主页面导航和销毁撤销全部会话；原生截图会话和工作槽独立否决主窗口回收，不仅依赖 renderer 的繁忙标记。
- Electron 真实 IPC 提供 PNG/JPEG 文档参考。发现旧 Electron nativeImage 原始 WebP/BMP 导入失败，与文件选择声明的格式不一致；原生测试如实记录 legacyFormatLimitations，并仅以实际 Electron 浏览器解码、转换 PNG 后的真实 IPC 作为这两种格式的像素参考，不宣称原始格式全量差分通过或旧缺陷已修复。
- 原生测试及当前增量汇总位于 artifacts/tauri-migration/screenshot-documents-native.json 和 screenshot-documents-verification.json；历史失败日志保留，未把其他增量的绿色报告作为本次源码的证明。
- 当前源码通过 Rust 248 项、严格 Clippy、Release cargo check、TypeScript 和格式/脚本检查；截图文档 11 项及相关拖放/内部拖动、Electron 工具箱、Tauri 图片/文本工具箱、备份、工作区、主窗回收、原型多窗和维护回归串行运行，共 11 组/110 个 Node 测试条目（含父测试/文件级条目）通过。最终 check:silent 的 202 项 Node 测试和 4 项无头测试通过；Release cargo check 不是 Release 安装产物或性能验收。
- 本次首次 check:silent 在 renderer-headless.mjs:217 的便签跨窗新值等待中超时，随后未改产品源码，单独重跑和完整检查均通过；保留 screenshot-documents-check-silent-first-timeout.log，不把原样重试通过当成根因修复。最初交付故障注入试图覆盖 Tauri 不可写 invoke 属性，未触发预期失败；已改为仅测试侧拦截实际 IPC fetch 响应，保留 screenshot-documents-delivery-injection-first.log，未降低清理/重试断言或修改权限边界。
- 上述源图会话增量首次验收时，finishScreenshot 仍返回未实现错误；后续复制/保存的实现与验证见下一节，不以历史源图报告代替输出验证。贴图/再编辑、业务捕获、截图原生外部拖入、完整会话生命周期、物理多屏/DPI/IME、Release 性能及实际产物仍待完成。未切换默认入口、版本或生产目录，未提交、推送或发布。

## 截图复制、保存与输出事务（P5 部分）

- 共享编辑器的 finishScreenshot 已接入主窗专属 Rust screenshot_finish，支持 copy/save/saveAs；pin/openEditor/updatePin 仍明确报未实现，尚未接入业务捕获与贴图再编辑。适配器和接口清单标记 partial，不宣称完整截图迁移。
- 使用原生原始二进制请求：4 字节小端元数据长度、UTF-8 JSON、PNG/JPEG 字节，元数据最多 16 MiB、单图最多 32 MiB。原生核验完整标注结构、UTF-16 文本长度、唯一标注 ID、样式/坐标范围、裁剪、来源/目标贴图身份、非倒退修订与实际导出尺寸；不接受 JSON 图片数组、伪造来源或 null 冒充缺省来源字段。
- 一个输出执行槽、最多两个排队请求，按会话代次重新核验；128 项有界成功请求缓存按文档/请求 ID 和完整请求摘要去重，同 ID 不同数据拒绝。文件或剪贴板主效果成功后才提交文档，取消与失败不提交并允许同请求显式重试，重复成功请求不再次生成文件或历史。显式释放、恢复与导航清理对应缓存。
- 默认保存沿用隔离工作区 Screenshots 或已保存的自定义目录、PNG/JPG 设置和唯一文件名；另存为使用实际原生 PNG/JPEG 过滤器、覆盖确认与取消。只允许截图专用目录或外部目录，不将原生保存对话框当任意内部数据写权限；重解析点/硬链接保护、暂存刷盘后原子发布继续有效，暂存未发布时维护/退出会阻止替换。
- 原生复制使用 PNG 和 DIBV5，保持透明度、像素和完整 32 MiB 输出边界，不套用普通剪贴板 API 的 12 MiB 输入限制。写入前排空已接收的历史候选；检测到关闭剪贴板与销毁所有者窗口会改变最终序列，改为原生随机标记在写入、关闭后重开核验，再在读锁内登记真实序列，仅抑制本次应用写入，保留后续其他应用复制。
- 显式截图历史使用 ScreenshotAutoAddToClipboardHistory，独立于 ClipboardMonitoringEnabled；按 PNG SHA-256/已有资产去重，磁盘写入成功后才广播小记录和定向 onClipboardChanged。保留截图专属的前 200 项加受保护记录规则，不改变普通后台剪贴板保留策略。
- 主效果成功、自动复制或加入历史失败时返回 ok=true 和具体 warning，并缓存该结果，避免用户重试时重复文件。现有历史资产及备份单图上限仍为 12 MiB：大于该上限的截图可复制/保存至 32 MiB，但加入历史会明确警告失败且不生成损坏记录；没有擅自扩大全局历史/备份格式或将该限制写成已解决。
- 新增 tests/tauri-screenshot-output.mjs 和 npm run e2e:tauri:screenshot:output，使用真实 Electron 文件/剪贴板参考、Windows 另存为/覆盖确认及实际剪贴板占用，覆盖失败重试、二进制/尺寸/权限、请求去重、32 MiB 边界、显式历史/监听去重、维护/重载/退出及有界队列。最新结果与源码指纹见 artifacts/tauri-migration/screenshot-output-verification.json；截图源图套件的共享编辑器保存断言已从未实现错误改为真实 PNG 文件尺寸验证。
- 首次扩展自动化遇到原生对话框已显示但 UIA 未暴露文件名/取消控件，保留 screenshot-output-native-picker-readiness-failure.log。维护/重载/退出只需证明实际进程的原生对话框可见，新增 visible 观察动作，不绕过产品选择与权限；选路径、取消及覆盖确认仍操作真实控件。initial-monitor-candidate 日志记录测试启动捕获了此前 Electron 参考图片，已在启动前用会恢复原剪贴板的夹具清空；sequence-close-failure 日志保留本次真实序列去重缺陷与后续修正的证据。
- 扩展回归中的普通剪贴板占用释放场景首次在 tauri-clipboard.mjs:69 读到空文本，保留 screenshot-output-clipboard-contention-first-failure.log；未修改产品源码或该断言的原样重跑通过，不能把重跑通过当成根因修复，也不因此声称系统剪贴板竞争已全部解决。
- 当前增量通过 Rust 253 项、严格 Clippy、Release cargo check，以及完整 check:silent 的 TypeScript、202 项 Node 测试和 4 项无头测试；另有串行原生回归覆盖截图输出/源图、剪贴板读写/监听/退出排空、工具箱、项目导出、备份/工作区、主窗回收、维护、Electron 工具箱、原型多窗及内外拖动，详见带逐文件源码与日志 SHA-256 的 screenshot-output-verification.json。Release 编译检查和 Debug 原生测试均不代替五轮 Release 性能、物理多机或实际安装产物验证。
- 本次输出增量验收时仍需贴图/再编辑、业务捕获与截图原生外部拖入、完整长会话/物理交互、Release 内存和实际安装产物；后续文件拖入见下一节。没有提交、推送、发布、切换默认入口或接管生产目录。

## 截图原生文件导入与真实拖入（P5 部分）

- 保持公共接口数量不变，createScreenshotDocument 接受 Uint8Array 或精确的 {path} 文件来源；共享截图页连接 onFilesDropped，保留浏览器 File 字节回退及多文件只处理首张的现有行为，不自动复制或保存。通用按钮继续使用现有 Lucide 图标和共享编辑器。
- Tauri 的 screenshot_import 限实际当前主窗，读取前后重新校验精确原生路径授权、工作区状态与会话代次；与截图二进制创建共用单执行槽。不把目录授权扩展到子项，不接受合成事件或页面自报路径取得权限，组件/原型均无导入能力。导航/恢复撤销旧授权，维护拒绝新导入并保留已有合法编辑源。
- Rust 对路径和祖先重解析点、真实普通文件句柄及 32 MiB 上限进行检查，以 FILE_SHARE_READ 打开并在读取后核对长度和修改时间；锁定、损坏、空文件、超限和非支持格式明确失败。继续支持 PNG/JPEG/WebP/BMP 与 4000 万像素限制，不以任意路径 API 代替截图会话读取。
- Electron 预加载只缓存最近一次实际 DOM drop 的 File 与 webUtils.getPathForFile 对应路径，不新增任意文件路径读取 IPC。每次新 drop（含无原生路径的浏览器 File）及维护开始都撤销旧缓存，读取后核验维护代次，仍由原有主窗 IPC 创建截图文档；其现有 nativeImage 对部分 BMP/WebP 输入的限制没有因此修复。
- 共享页面在 File 异步读取前就进入忙碌状态，失败或过期回复保留原有编辑源并释放未认领的新会话；非活动页、输入区、真实颜色对话框、编辑器输出或上次源图交付中不会消费新拖入。
- 新增 tests/tauri-screenshot-drop.mjs 与 npm run e2e:tauri:screenshot:drop。使用既有 C++ 夹具经实际 IDataObject/CF_HDROP 和 DoDragDrop 投递，不向产品伪造授权；13 项测试（含父测试）覆盖四格式、取消、伪造事件、精确授权、多文件去重、损坏修复、实际 32 MiB/下一字节边界、junction 整批拒绝、隐藏/输入/颜色对话框/忙碌过滤、实际另存为取消及维护/恢复/重载。报告为 artifacts/tauri-migration/screenshot-drop-native.json。
- tests/toolbox-native.mjs 增加真实 Electron 磁盘 File 经 {path} 导入、父目录/同级路径拒绝、浏览器 File 字节回退及新 drop 清理旧原生缓存的断言，保留原有双实例传输回归。
- 本增量完整 Rust 254 项、严格 Clippy、Release cargo check、cargo fmt --check、TypeScript、202 项 Node 与 4 项无头检查通过；12 组串行原生套件共 127 个测试条目（含父测试）通过，涵盖截图源图/输出/拖入、内外拖动、双运行时工具箱、备份、主窗回收、维护与原型。逐文件源码、实际 Debug 二进制和日志 SHA-256 汇总于 artifacts/tauri-migration/screenshot-drop-verification.json；结束后 CIM 核验无本仓库 Electron/Tauri 遗留进程。该记录不覆盖未重跑的历史原生套件，不代替 Release 产物运行或性能。
- 首次夹具断言将测试自身的故意越权调用算入拖入次数，第二次订阅晚于页面消费回调而漏记；修正观察顺序和计数边界，不降低产品权限或忙碌断言。保留 screenshot-drop-observer-first-failure.log 与 screenshot-drop-observer-order-failure.log；首次 Clippy 的闭包错误类型推断记录亦保留于 screenshot-drop-clippy-first.log，显式类型修正后严格检查通过。
- 当前结果仅证明隔离预览的文件导入；仍需业务捕获、贴图/再编辑、完整长会话、物理混合 DPI/IME/Explorer 手工拖入、Rust 局域网与双实体机兼容、生产迁移回滚、五轮 Release 性能和实际安装包/绿色 ZIP 验收。未切换 Electron 默认入口、生产目录或版本，未提交、推送或发布。

## 截图窗口来源与 WGC 捕获后端（P5 部分）

- 新增主窗专属 screenshot_windows 与 screenshot_capture_window，沿用截图服务单执行槽及会话容量，不开放 HWND 输入或通用桌面捕获给组件/原型。窗口来源为随机 window:UUID，原生记录实际 HWND、进程/线程及标题；刷新后全部旧令牌失效，五分钟到期、维护、工作区恢复及主窗导航/销毁均撤销来源。
- 原生 EnumWindows 列举可见、未最小化且标题有效的普通窗口，跳过工具窗、cloaked 与明确受保护窗口；正常拥有者对话框及同进程的真实工作区窗口仍可枚举和捕获，不以排除整个应用进程缩减原有能力。最多 128 项，标题最多 2048 UTF-16 单元；不把裸 HWND、Electron window:句柄:0、截图文档 ID 或改写后的令牌当成授权。
- WGC 生成真实 320×180 以内的缩略图，单张编码最多 256 KiB、列表共 4 MiB；预览采集设四秒预算，单窗等待最多 400ms，预算不足/预览失败保留窗口名称及令牌，不以黑图或删除可选窗口冒充成功。完整捕获仍使用 4000 万像素/32 MiB 截图限制及五秒帧等待，捕获前后重新核验窗口身份、最小化/隐藏/保护状态与生命周期；维护取消后不发布过期源图。
- 共享 listScreenshotWindows 接入类型化适配器并跟踪原生待办，明示维护/退出错误；窗口选择器沿用现有 React 交互，缩略图缺失使用现有 Lucide Image 本地图标。该后端增量初次验收时只将窗口列表标为 partial、startScreenshot 尚未接通；后续业务流程推进见下一节，不将后端报告等同完整区域/全屏/窗口流程。
- 新增 tests/tauri-window-capture.mjs 与 npm run e2e:tauri:screenshot:window：由隔离 Electron 创建实际双色原生窗口，以真实 webContents.capturePage 作为颜色参考，Rust WGC 缩略图与完整源图进行像素核验；还验证实际共享选择器显示与取消、拥有者对话框、裸句柄拒绝、跨角色权限、隐藏/最小化/受保护/关闭、刷新/维护/恢复/重载撤权及已有源图保留。不是使用原型命令或合成窗口源代替业务后端。
- 初次严格 Clippy 提示来源有效期布尔表达式可简化，修正后通过；扩展 UI 测试首次使用了不存在的“截图工具/开始截图”控件名称，已按实际“截图编辑/开始捕获”修正，保留 window-capture-clippy-first.log 与 window-capture-native-second.log，不将测试定位错误写成产品缺陷修复。
- 当前源码通过 Rust 257 项、严格 Clippy、Release cargo check、cargo fmt --check、TypeScript、202 项 Node 与 4 项无头测试；6 组串行原生套件共 68 个条目（含父测试）通过，其中窗口捕获新增套件 11 项，另覆盖源图、输出、真实拖入、原型及主窗回收。报告 artifacts/tauri-migration/window-capture-verification.json 记录逐文件源码、实际 Debug 二进制和日志 SHA-256；CIM 结束核验未发现本仓库 Electron/Tauri 遗留进程。未重跑的历史套件不能据此视为当前通过，Release 编译检查不是实际 Release 性能或安装包启动证明。
- 关联截图输出套件首次遇到已有的另存为对话框 UIA 控件未就绪，保留 window-capture-output-picker-first-failure.log；相同产品和断言的原样复测及最终串行回归均通过，未修改对话框产品实现或宣称就绪竞争已根治。迁移事务访问拒绝、纯托盘启动与延迟草稿保存等既有不稳定项同样没有据此关闭。
- 该后端增量初次验收时仍需接入共享 startScreenshot、区域透明覆盖层、全屏目标显示器、设置延迟/后续动作、贴图和托盘；Window/FullScreen 后续接入见下一节。物理 DPI/IME/热插拔、Release 性能、真实安装产物及生产迁移回滚门槛不变。未更改默认 Electron 入口、版本或生产目录，未提交、推送或发布。

## 业务窗口/全屏截图与专属覆盖层（P5 部分）

- startScreenshot 已从明确未接通推进为 partial：Window 使用当前原生窗口来源，FullScreen 使用延迟结束时鼠标所在显示器的物理边界；设置延迟在 Rust 以最多十秒有界等待执行，等待中持续校验实际主窗/会话代次。窗口来源在延迟后及发布时再次核验，刷新令牌不能通过已排队操作继续使用。Region、截图后贴图和未知模式明确失败，不以全屏预截图替代实时区域框选。
- 新增独立 capture.html 与最小 React 运行时，捕获成功后才创建透明、无边框、置顶、任务栏隐藏且内容受保护的原生窗口，再挂载原有 ScreenshotEditor/Worker。通用图标继续使用 Lucide，不重做视觉或标注逻辑。传输格式提取为双入口共用的 screenshotWire，覆盖层不装载主窗适配器或完整工作区。
- 原生截图会话新增真实窗口 owner，读取、输出、成功请求缓存与显式释放均按所有权核验：主窗不能读取或释放覆盖层文档，覆盖层不能读取主窗/其他窗口源图，缓存的成功结果也不能跨 owner 取得。覆盖层仅有四个专属命令，不能加载/保存工作区、读取普通剪贴板、任意选择/打开路径、枚举窗口、启动截图或退出整个应用；设置只投影 ScreenshotFormat 与 ScreenshotAfterAction。主窗恢复/导航/销毁清理覆盖层及来源，原生 Destroyed 回收其源图和去重缓存。
- 覆盖层二进制源图读取复用截图单执行槽和原生代次验证，不在 UI 线程直接复制大图；首次交付暂时失败保留原生文档并提供“重试读取”，不通过删除合法源图逃避交付失败。原生文件选择器记录实际 owner，截图取消/销毁只取消自己拥有的保存对话框，不得关闭主窗或其他窗口的原生选择；维护/整体退出仍可由已有受控服务统一取消。
- 覆盖层输出复用现有原生二进制事务、所有权校验、PNG/JPG、默认目录、另存为过滤器/覆盖确认、内部目录保护和原子发布。复制/保存成功且没有警告时关闭实际覆盖层，失败或用户取消保留当前文档；次要效果警告保持窗口可见。ScreenshotAfterAction=copy 由共享编辑器真实渲染后执行，剪贴板占用失败可点击复制重试；pin/openEditor/updatePin 仍明确未实现，未伪装成功。
- 当前生命周期仍是保守的明确拒绝：有活跃覆盖层或正在启动截图时，维护、备份恢复与退出要求先完成/取消截图；主窗回收由原生服务独立否决。尚未实现截图作为维护/退出检查点参与者的完整流程，不能将此保护当成计划要求全部完成；没有静默丢弃截图标注以换取退出通过。
- 新增 tests/tauri-capture-overlay.mjs 与 npm run e2e:tauri:screenshot:capture，使用实际隔离 Electron 窗口、共享窗口选择器与真实 WGC/GDI，验证覆盖层角色隔离、真实另存为取消、Worker 保存像素、自动复制的剪贴板竞争与重试、原生延迟/单飞/刷新撤权、Esc、主窗重载和实际保存对话框取消。物理多屏/混合 DPI 和 Release 性能仍未由这些隔离 Debug 测试证明。
- 进一步验证关闭覆盖层后主窗实际原生选择器仍可见且正常取消，以及测试侧拦截首次真实 IPC 交付后，点击“重试读取”仍取得原文档并进入现有编辑器；不会弱化源图权限或把模拟失败当成系统异常根因修复。
- 首次交付故障注入发现真实交互缺陷：新增恢复按钮复用了原提示层的 pointer-events:none，导致“重试读取/关闭截图”可见但无法鼠标点击。已为仅冷启动错误面板增加交互样式，不改变编辑器被动提示层；保留 capture-overlay-retry-pointer-first-failure.log，并继续用实际鼠标点击验证，不通过强制点击或脚本触发绕过。
- 当前源码通过 Rust 260 项、严格 Clippy、Release cargo check、cargo fmt --check、TypeScript、202 项 Node 与 4 项无头检查；13 组串行原生套件共 158 个测试条目（含父测试）通过，其中业务覆盖层套件 12 项，另外覆盖窗口来源、源图/输出/拖入、备份、维护、系统选择器、便签背景、图片/文本工具箱、原型和主窗回收。artifacts/tauri-migration/capture-overlay-verification.json 记录逐文件源码、实际 Debug 二进制及日志 SHA-256；结束后 CIM 核验无本仓库 Electron/Tauri 遗留进程。未重跑的其他历史套件不计为本次通过，Release 编译检查不代替实际 Release 性能或安装包验证。
- 初次编译修正覆盖层 invoke 泛型与仅测试使用的主窗便捷封装；初版对话框测试误用 operateDialog 参数形状，随后误将 holdClipboard 返回的释放函数当成对象，保留 capture-overlay-typecheck-first.log、capture-overlay-clippy-first.log、capture-overlay-native-first.log 和 capture-overlay-native-third.log。已修正夹具调用与嵌套 finally，并仅清理核实的该失败测试进程树；不把测试契约错误记作产品缺陷。第四次断言错误地把 Windows 圆角首像素当作内容中心颜色，现对比实际截图源的同位置像素/尺寸，保留 capture-overlay-native-fourth.log，仍保留双色内容中心的独立保存像素断言。
- 待续范围包含实时区域层、编辑页交接、贴图/再编辑及托盘、维护/退出完整协同、物理 DPI/IME/睡眠热插拔、Rust 局域网与双实体机、生产迁移/回滚、五轮 Release 性能和安装 EXE/实际绿色 ZIP 验收。Electron 默认入口和生产目录未切换，版本不变，未提交、推送或发布。

## 实时区域框选与选区源图交付（P5 部分）

- startScreenshot 的 Region 已进入隔离预览：按真实显示器创建独立透明、置顶、受保护的框选窗口，初始只含显示器尺寸和空来源，不预截全屏。沿用共享 ScreenshotEditor、Canvas/Worker、Lucide、撤销重做、复制与保存，不另造一套标注实现。主窗 selectScreenshotRegion 公共适配器仍未开放，覆盖层仅通过注入的 ScreenshotRuntime 调用自身原生命令。
- 确认、完成首次标注手势或按 ScreenshotAfterAction=copy 结束框选后才捕获；原生隐藏全部实际框选层，等待桌面合成后只读取所选物理矩形，再恢复合法窗口并聚焦调用者。捕获前后核验当前窗口、会话代次、显示器位置/尺寸/缩放及窗口物理边界；显示器改变时明确拒绝，不猜测旧坐标或退回全屏截图。
- DIP 边界经缩放与边缘取整映射到物理像素，支持负显示器原点的受检加法；原生单测覆盖 150% 缩放、负原点、完整边界、越界、非有限数及图像预算。文档保留完整显示器坐标与 sourceRect，但原生压缩源图仅包含选区像素；没有为形成文档而读取或分配整屏捕获图。
- 新增截图覆盖层专属 region/adopt 两个命令，当前最小权限总计六个；未扩展工作区、路径、普通剪贴板或进程权限。替换来源先保留旧源图，客户端实际收到新二进制后才 adopt 并释放旧来源；失败保留选择与来源，取消/销毁/主窗导航清理整组及全部保留会话。原生测试连续 66 次捕获/读取/采纳，跨过 64 会话容量，验证正常重复操作不会因已替换来源累积而耗尽会话。
- 实际第一笔矩形标注测试发现共享编辑器的真实缺陷：原生隐藏窗口会释放指针捕获，原先尚未完成的手势被取消并丢失标注。ensureSource 现在等待当前手势释放后才隐藏捕获，期间保留本地预览，代次改变仍取消；验证实际输出包含红色第一笔，并检查撤销/重做，不以只有裁剪历史代替标注存在。该共享代码同时影响 Electron，须运行其真实截图回归及无头套件。
- 新增 npm run e2e:tauri:screenshot:region 与 tests/tauri-region-capture.mjs。实际原生测试覆盖无隐式捕获、角色隔离、非法范围、绿色参考窗口像素、首次保存、第一笔标注、Escape/重载整组关闭、二进制交付失败后的保存重试，以及设置驱动的框选后自动复制；成功报告为 artifacts/tauri-migration/region-capture-native.json。
- 保留 region-capture-native-first/second/fourth/fifth.log 的失败证据：首次测试误等选择前不存在的工具栏；第二次暴露第一笔丢失；第四次是销毁窗口先于 IPC 应答的自动化竞争；第五次误把始终存在的框选提示当作错误。修正实际交互与断言，不掩盖产品异常；最终成功日志为 region-capture-native-sixth.log。之前窗口/全屏节的四命令、260 项 Rust 和 158 条原生验证属于当时增量，旧报告不代表当前区域实现已被验证。
- 无头截图回归原先要求按住指针时已开始捕获，与防止原生隐藏丢失第一笔的新时序冲突，首次 check:silent 在该等待处超时；保留 region-check-silent.log。已改为断言手势期间零新增原生捕获、实时预览仍可见，释放后再阻塞源图 Worker；仍验证重捕获旧图像保留、后续手势期间源图交接、自由画笔中间采样、撤销和最终导出像素。中间一次断言早于 RAF 启动捕获，保留 region-screenshot-headless-current.log；修正等待位置，不放宽像素、响应时间或长任务门槛。
- 本增量最终通过 Rust 263 项、严格 Clippy、Release cargo check、cargo fmt --check，以及 check:silent 的 TypeScript、202 项 Node、4 项无头测试。11 组串行实际桌面回归共 113 个条目，其中 9 组 Node 原生套件 111 项（含父测试），另原型与 Electron 截图回归各计 1 个整体检查；没有把其内部断言数另算为测试数。覆盖区域、窗口/全屏、来源、文档/输出/拖入、备份、草稿维护、主窗回收和共享 Electron 截图。最终冷 4K 预览反馈为 23/12/15 ms，未观察到长任务，不作为正式 Release 性能结论。
- artifacts/tauri-migration/region-capture-verification.json 汇总当前源码、实际 Debug 二进制、成功与失败日志 SHA-256，明确范围未含完整迁移；最终 CIM 核验无本仓库 Electron/Tauri 遗留进程，git diff --check 通过，仅有既有换行提示，未追踪源码无新增尾随空白。
- 当前物理桌面只验证单屏 1920×1080、100% 缩放；150% 与负原点仅由几何单测覆盖。混合 DPI、多屏实际交互、IME、睡眠/热插拔、转编辑页、贴图、完整维护/退出检查点、Release 性能及安装包仍待验收，productionReady 与 migrationComplete 均保持 false；Electron 默认入口、版本与正式数据不变。

## 覆盖层转主编辑页与受控交接（P5 部分）

- 实际截图覆盖层的“在应用内编辑”（openEditor）已接入 Rust 与共享 onScreenshotDocument：恢复隐藏或最小化的现有主窗并导航到既有 ScreenshotPage，沿用 ScreenshotEditor、Worker 与 Lucide，不另造编辑页或引入通用窗口/文件权限。前述历史增量中 openEditor 未实现属于当时范围，不代表当前状态；贴图、再编辑及完整生命周期仍未完成。
- 原生先以不同文档/资产 ID 暂存一个主窗专属副本，压缩源图以 Arc 共享而不重编码，仍保守计入 64 会话和 256 MiB 字节预算，不驱逐编辑源。区域文档由完整显示器坐标归一化到源图尺寸，平移 crop 与全部标注点、移除 sourceRect 和 targetPinId、修订归零并保留编号；源图不合并标注，主页面仍可选中、移动、撤销/重做及继续保存。
- 主窗新增 screenshot_editor_pending/received 两个原生命令，覆盖层继续只有原六个截图专属命令；原覆盖层与主窗不能互读对方来源。事件只向实际 workspace-main 发送唤醒信号，不广播图像、标注或工作区；主窗订阅注册时也检查待交接，避免监听尚未准备好时丢失事件。元数据与 32 MiB 二进制仍分开读取，不把 PNG 放进通用事件 JSON。
- 单项交接使用原生 UUID 票据、真实窗口身份、会话代次、来源文档和 15 秒单调截止时间。主窗收到源图后先取得原生确认，再触发共享业务订阅；原生确认成功才提交覆盖层编辑并缓存请求结果，不执行保存、自动复制或截图历史入库。等待主窗读取时释放原截图执行槽，避免交接持槽、读取又要同一槽而自锁，仍保留输出队列与独立单飞上限。
- 读取失败、超时、取消、主窗重载或覆盖层重载清理暂存副本，不删除仍合法的原截图。覆盖层额外记录原生导航 epoch，交接前、暂存和确认均核对；注册检查与 pending 变更受同一把锁保护，避免导航取消恰好早于注册时旧请求重新生效。超时与确认也以原生决定/应答串行化，过期或重复票据不能确认下一张截图。
- 三项新增 Rust 单测验证选区坐标与原始 Arc 像素、所有权和失败暂存不提交，以及容量/字节上限不驱逐来源。tests/tauri-screenshot-editor.mjs 与 npm run e2e:tauri:screenshot:editor 使用真实 Electron 参考窗口、Tauri 覆盖层和共享主编辑器，验证原始绿色像素未扁平化、移动标注后导出红色像素、无隐式文件/剪贴板/历史副作用、交付失败重试、真实 15 秒超时、三种非主窗角色拒绝、伪造/过期票据、取消、双窗口重载及全屏相同请求重放仅生成一个主文档。
- 首两次原生验证在查找参考窗口时失败，第二次增加原生来源列表与实际 Electron 标题诊断，确认是夹具 data URL 缺少 charset=utf-8 导致中文标题乱码，不是 Rust 枚举漏窗；已补 UTF-8、保留夹具强引用和诊断，editor-handoff-native-first/second.log 留存。第三次本增量原生套件 10 项（含父测试）通过；失败日志不改写为产品缺陷修复，也不以重跑掩盖已知历史不稳定。
- 增补并实际验证隐藏主窗恢复后完成交接，当前专项共 11 项（含父测试）。本轮串行实际桌面回归共 12 组、124 个条目，其中 10 组 Node 原生套件 122 项（含父测试），原型与 Electron 真实截图回归各计一个整体检查；包含区域捕获、窗口/全屏覆盖层、窗口来源、文档/输出/拖入、备份、草稿维护和主窗回收，不把未重跑的历史套件计入本轮通过。
- 当前源码 Rust 全量 266 项、严格 Clippy、Release cargo check 与 cargo fmt --check 通过；最终 check:silent 的 TypeScript、202 项 Node 和 4 项无头测试全部通过。结束时 CIM 核验无本仓库 Electron/Tauri 遗留进程，git diff --check 通过，仅保留既有换行提示。细粒度报告及源码/二进制/日志 SHA-256 记录于 artifacts/tauri-migration/editor-handoff-verification.json。Release 编译检查不等于实际 Release 性能或安装产物验收，过去增量报告不能直接用于当前源码。
- 仍只使用隔离 Debug 构建和单屏 100% 物理桌面；无主窗后台/全局快捷键全部入口、原生贴图/再编辑与托盘、完整维护/退出参与、物理混合 DPI/IME/热插拔、Rust 局域网及双实体机、生产迁移回滚、实际 Release 性能与安装包待继续。Electron 默认入口、正式数据和版本保持不变，未提交、推送或发布，不标记完整迁移完成。

## 原生截图贴图与可编辑源图（P5 部分）

- 隔离预览已接入原生 Pin/UpdatePin，沿用共享 PinnedScreenshot、截图编辑器、Worker 和 Lucide，不安装主窗适配器到贴图页面。每张贴图使用不同原生窗口/文档/资产 ID，保留未扁平化来源、标注和单独的渲染 PNG；同请求重放不会重复建窗。最多 32 张贴图、渲染 PNG 合计 256 MiB，并继续受 32 MiB 单图、64 源图会话及 256 MiB 源图预算约束；仅本次运行保留，不宣称退出后恢复贴图。
- 六个贴图专属命令分别提供元数据、限版本二进制读取、控制、保存、连接与断开。原生以实际调用窗口绑定贴图，另一贴图、主窗、组件和原型不能借参数伪装所有者；贴图无通用工作区、文件、剪贴板、窗口或事件订阅权限。变化、保存和错误通过原生私有 Channel 定向发送，连接替换不累积，过期/其他窗口的令牌不能断开当前连接。
- 透明度、置顶、锁定、穿透、滚轮缩放、拖动、原始比例和关闭已接入实际窗口；原生右键菜单只通过共享托盘处理器分派一次，避免重复全局/窗口监听使开关切两次。托盘按贴图动态生成控制菜单并提供恢复鼠标操作入口，但统一显示/隐藏/关闭所有贴图及实际托盘点击仍待补齐，不能把实际右键菜单验证等同全部托盘验收。
- 复制使用原生渲染 PNG；Ctrl+S 沿用共享 Worker 生成 JPEG，通过有界二进制包进入既有原生另存为事务，保留默认 PNG/JPG、Unicode 路径、取消与原子发布。次级贴图复制/保存不重复触发自动复制或历史；初次贴图/更新仍按截图设置执行次要效果并报告警告。新二进制读取失败显示显式重试，不删除合法源图。
- 再编辑使用独立覆盖层，保留原始像素及对象标注，绑定原贴图 ID/版本。更新只替换对应渲染结果，继续保留可编辑原图；原贴图关闭或版本变更时明确拒绝更新，不静默创建替代，用户可显式创建新贴图。主窗重载或备份恢复不释放独立贴图源图；关闭贴图仅取消自己的保存框，等待原生输出排空后恢复维护，空闲贴图不阻止正常退出。活跃截图编辑覆盖层仍先要求完成/取消，完整维护/退出检查点尚未完成。
- 测试中发现过泛化事件监听使其他贴图同时处理保存并排入额外对话框；已改为原生私有 Channel，而不只在渲染端过滤 payload。留存早期失败日志；原生弹出菜单为阻塞调用，测试保持 IPC 待定并实际点击菜单，不能等待弹出调用返回后再点击。另有几何浮点误差、将备份创建误当排他维护检查点、关闭页面后未等待原生输出排空等夹具问题，分别以容差、真实 drafts_prepare 和有界排空等待修正，不把这些夹具调整写成产品缺陷修复。
- 当前贴图专项 14 项（含父测试）通过：覆盖真实窗口操作、原生右键菜单、私有通道替换与跨窗口隔离、原生 PNG/JPG 另存为、红色标注与未改像素、可编辑原图、恢复/重载、关闭保存框与正常退出。区域专项新增真实框选后自动贴图，当前共 10 项（含父测试）通过；Window 设置为 pin 的真实业务捕获也已加入覆盖层回归。本增量实际桌面回归共 14 组、146 个条目，其中 12 组业务原生套件 144 项（含父测试），原型与 Electron 真实截图回归各计一个整体检查；全部严格串行，包含组件私有事件、备份、草稿维护及主窗回收。
- Rust 全量 269 项、严格 Clippy、Release cargo check、cargo fmt --check 和双运行时构建通过；最终 check:silent 的类型检查、202 项 Node 与 4 项无头测试全部通过。验证结束后核验仓库 Electron/Tauri 进程与空白差异，源码/二进制/日志指纹及失败记录见 artifacts/tauri-migration/pins-verification.json。调用了不存在的 tauri-window-sources 测试名，已依据实际 package 命令改为 tauri-window-capture 后继续串行回归；不能把路径错误计为执行通过。Release 编译检查不等于实际 Release 性能或安装产物验收，旧报告不能证明当前源码。
- 物理混合 DPI/IME/热插拔、真实托盘操作、全部全局/无主窗入口、完整截图检查点、长期资源释放、Rust 局域网、生产接管/回退、Release 性能和安装产物仍待完成。Electron 默认入口、正式数据、包版本保持不变，不提交、推送或发布，不标记迁移完成。

## 原生托盘贴图统一控制（P4/P5 部分）

- 托盘“截图贴图”新增统一显示/隐藏、恢复鼠标操作与关闭所有桌面贴图。显示切换与 Electron 保持相同规则：任一贴图可见就隐藏全部，否则显示全部；不会创建主窗、重新编码来源或改变标注/版本。逐项子菜单按原生 ID 稳定排序，无贴图时三个批量项禁用，其他窗口不在操作集合中。
- 批量操作与贴图发布、选项更新共用原生串行门；先取得与维护/退出启动相同的窗口门，再检查启动恢复完成和交互生命周期，避免检查后才开始维护的竞争，封存维护期间即使从真实托盘点击也不能绕过保护。逐窗执行并保留部分成功，失败汇总到原生诊断与各自私有错误通道，不把失败静默当成功。恢复重置透明度、锁定和穿透但保留置顶；统一关闭只取消各贴图自己的保存选择，随后沿用销毁回收来源和通道的流程，不取消其他窗口的原生会话。
- tests/tauri-pin-tray.ps1 从 Windows 通知区域或隐藏图标面板定位隔离预览 tooltip，实际右键点击并沿层级悬停/点击原生菜单，不调用测试分派命令代替托盘。专项现在 17 项（含父测试），验证主窗隐藏时的逐项置顶与统一隐藏/显示、穿透/锁定恢复、原始字节与版本不变、封存维护拒绝关闭、统一关闭时取消真实保存框、主窗保留、后续新贴图与正常退出。实际点击的 tooltip、各级菜单名称与启用状态记录在 pins-native.json 的 trayClicks。
- 前两次托盘夹具误将任务栏应用分组当作通知图标，诊断确认名称为“DustDesk Tauri Preview - 1 个运行窗口”；已改为匹配含“隔离验证”的完整通知 tooltip，并处理隐藏图标面板。第三次已经点击真实托盘，但夹具最后无条件 Escape 传播到恢复焦点的贴图，触发共享 Esc 关闭；现仅在失败且实际原生菜单仍存在时撤销菜单，成功后不发送全局 Esc，隐藏图标面板通过其原生按钮收起。保留 pin-tray-native-first/second/third.log，不把夹具修正描述成产品故障修复；第四次 16 项通过，加入维护拒绝后当前 17 项通过。
- 本增量不新增贴图通用 IPC、任意窗口操作或事件权限。仅验证本机单屏 100% 通知区域，不能外推到全部 Windows Shell 版本、混合 DPI、多屏或物理 IME；全部无主窗截图入口、完整截图维护/退出检查点、Release 性能及安装产物仍待验收，正式入口和数据保持不变。
- 加入维护/退出启动互斥后，最终源码重新构建并串行通过 14 组实际桌面回归、149 个条目：12 组业务原生套件共 147 项（含父测试），原型和 Electron 真实截图回归各计一项，不累计早期重复执行。Rust 全量 269 项、严格 Clippy、Release cargo check、cargo fmt --check、TypeScript、202 项 Node 与双运行时构建通过。零贴图时原生批量项禁用也由真实通知菜单断言验证，不以源码存在替代执行证据。
- 本轮 check:silent 未全绿：首轮在 renderer-headless.mjs:217 等待延迟重载期间的跨窗便签广播超时；最终源码检查在 renderer-headless.mjs:165 等待便签颜色落盘超时，HEX/RGB 输入已更新但持久值仍是前一颜色。两个日志分别为 pin-tray-check-silent-final.log 和 pin-tray-check-silent-current.log，均有 202 项 Node 通过、4 项无头测试中 3 项通过/1 项失败。未改动相关便签或无头夹具来规避检查，不宣称根因已修复，也不继续盲目重跑取得绿色。最终报告 artifacts/tauri-migration/pin-tray-verification.json 将原生专项标为通过、整体 verified 标为 false，并保留此前历史不稳定；完整迁移与发布门槛仍未满足。

## 配置化全局快捷键与剪贴板贴图（P4/P5 部分）

- 隔离预览现使用已保存的五类快捷键：打开主窗、切换指定组件、区域截图、剪贴板贴图和快速记录；移除原型硬编码绑定，不为后台动作预建主窗。主窗口的共享快捷键管理界面调用专属 Rust 命令；解析后按组合键身份拒绝别名重复、未知字段、非字符串和超长输入，空字符串可单独禁用。组件名单去重并沿用空名单回退 todo、任一可见则统一隐藏、内容不存在则跳过创建的既有语义。
- 设置变更与原生注册采用同一事务：先准备新增绑定，全部成功后才释放不再使用的绑定并保存设置；准备失败不释放任何旧绑定，释放或写盘失败恢复旧注册并报告补偿失败。交换两个动作的现有组合键不重复注册。启动、设置广播和维护恢复重新读取最新存储；备份或一般保存发生系统占用时保留旧绑定，通过原生错误状态和主窗事件明确说明尚未应用，不伪报已生效。同步状态查询采用非阻塞锁，避免原生主线程等待正在向该线程注册快捷键的工作线程。
- 快捷键与托盘的剪贴板贴图共用 Rust 路径，只读取 PNG／DIB 图片格式；PNG 上限沿用截图 32 MiB、4000 万像素，不读取无关文本。窗口、源图与尺寸／选项沿用既有原生贴图服务，最多 32 个贴图和 256 MiB 贴图渲染图；不新增 renderer 通用剪贴板或任意窗口权限，不隐式输出文件、历史或剪贴板内容。
- 重新核对 Electron 的 completeScreenshotOutput 后，将无图片回退设为上一次成功编辑输出的渲染 PNG，包含标注；直接剪贴板导入、仅捕获后取消、编辑交接和贴图自身复制／保存不替换它。缓存最多一张有界图像，独立于编辑来源存活；原生测试通过真实共享编辑器／Worker 输出带标注的区域，再取消另一次截图、关闭来源，并逐像素摘要核对回退贴图，避免把原始捕获像素当作旧版语义。
- 剪贴板读取十秒超时后不创建迟到窗口；仍在运行的阻塞读取继续持有操作与剪贴板许可，直到实际结束才释放。真实延迟 PNG 提供者验证超时前后均否决维护，释放后没有迟到贴图，显式重试才能创建；普通占用同样保留原输出并支持重试。发布再次核验恢复／交互状态并与维护／退出启动共用窗口门，失败只清理本次新贴图与来源。
- 新增 tests/tauri-hotkeys.mjs 与原生按键／占用夹具；初始化后以零 WebView 隐藏启动，实际 Win32 组合键触发五种动作，验证图片像素及剪贴板序号、主窗／组件／快速记录权限、管理界面、别名重复、外部占用、真实文件替换拒绝、旧绑定回滚、动作交换、独立禁用、配置广播、备份恢复、维护拒绝、48 次并发状态查询和正常退出释放全部测试键。保存／恢复原系统剪贴板，只操作临时工作区；普通原生套件仍默认禁用系统快捷键，新专项才显式启用测试前确认空闲的 F13–F24 组合。
- 首轮夹具为探测注册状态而临时占用目标组合，恰与启动竞争，现改为等待真实注册成功日志；第二轮未在最后 WebView 释放后重连调试连接；第三轮误调不存在的公共 quit；第五轮误要求 BackupPreview 含 ok 字段；第六／七轮分别误等框选前尚未显示的工具栏、以及与共享编辑器的原生源图交付争用，现等待真实交付完成。原始 hotkeys-native-first 至 seventh 日志与失败报告均保留。第四轮实际通知区域子菜单曾一次消失，后续通过及夹具等待窗口清理不证明该间歇失败的根因已修复，仍保留排查项。早期试验中“取消也更新原始捕获回退”的行为已按 Electron 真实实现纠正，最终证据只采用修正后的执行。
- 最终同一 Debug EXE 串行通过 11 组／141 个条目（含父测试）：快捷键 19、贴图 17、无主窗截图 10、快速记录 13、草稿维护 13、主窗回收 15、组件事件 7、备份 10、窗口／全屏覆盖层 12、剪贴板退出 8、截图输出事务 17；日志 hotkeys-verified-*.log，不累计早期重复执行。Rust 278 项、严格 Clippy、Release cargo check、fmt 和完整 check:silent 的 TypeScript、204 项 Node、Electron 构建与 4 项无窗口回归通过，无跳过。源码、Debug EXE、前端资产及日志摘要见 artifacts/tauri-migration/hotkeys-verification.json；整体迁移仍未验收。
- 历史概览 QuickNote、便签颜色／跨窗广播、迁移拒绝访问和强杀 WebView2 草稿恢复故障继续保留，当前通过不代表这些问题已修复。系统快捷键的物理键盘／IME／睡眠及非标准 accelerator 全矩阵、原生托盘瞬时提示恢复一致性、完整截图检查点、Rust 局域网、生产接管／回退、Release 性能和实际安装包／绿色 ZIP 验收继续待办；未切换默认入口或版本，未提交、推送或发布。

## 快速记录原生窗口与草稿生命周期（P2/P4 部分）

- 继续沿用隔离分支与 Electron 默认入口。新增 quick.html 与 quick-capture 原生窗口，主页面设置及真实托盘“快速记录”均按需创建；无主页面时读取已初始化隔离工作区，不自动创建空数据或隐藏主窗。主窗口重载不撤销独立快速记录。窗口沿用共享 QuickCapture React 界面、尺寸、任务／便签切换、中文提示和键盘行为。
- 共用组件接受四项小接口：核对 requestId、提交记录、收起自身及注册保存回调；Electron 默认实现保留现有 API。Tauri 不在快速记录中安装 window.dustdesk，不开放全量工作区快照或任意业务动作。原生 Draft 只接受 kind/title/text/requestId，拒绝未知字段、sourceNoteId 和其他动作；沿用现有 Rust capture 原子保存与幂等逻辑。请求标识兼容旧草稿的非 UUID 值，并遵守原有 100 个 UTF-16 单元边界；核对仅返回布尔值，包含任务、便签和相应回收站记录。
- 快速记录仅获专用命令与私有 Channel，无通用事件、文件、剪贴板或任意窗口权限；原生按实际窗口身份校验调用者，事件白名单只包含自身收起及生命周期。事件重连、旧令牌注销和页面销毁沿用既有原生连接所有权；原生另外记录编辑器是否曾就绪，断开或替换连接不能把活跃编辑器降格为错误页来跳过草稿保存。
- Esc、主页面收起及系统 WM_CLOSE 先执行保存回调，浏览器存储异常或组合输入时保留窗口与输入。隐藏窗口回收再次保存并确认，检查点失败或超时不会销毁；显示取消旧回收请求。窗口释放期间建立原生销毁等待，先完成旧 Destroyed 清理再以同名创建新窗口，避免旧清理误删新通道。未完成浏览器迁移日志时不挂载编辑器；错误页可重试或安全收起，已挂载编辑器不能使用该提前关闭命令。
- 退出与草稿维护在共用建窗门闩内纳入快速记录参与者，等待草稿保存并按实际窗口确认。维护封存时拒绝新建、提交与收起；失败／超时恢复编辑。备份恢复使用同一门闩，并在快速记录仍存在时明确拒绝，须先收起并等待释放，不宣称已完成恢复时自动合并内存输入。
- 新专项 tests/tauri-quick-capture.mjs 覆盖任务键盘提交、便签正文、IME 标志、主窗／组件同步、实际 WM_CLOSE、收起重建、存储异常注入、真实工作区写入失败、成功后清理失败／重载／回收站去重、维护与备份保护、主窗重载和反复显隐、真实 15 秒未确认退出超时、启动错误页及正常退出后的零 WebView 托盘重启。托盘入口使用实际通知区域和原生菜单物理点击，保存后释放最后 WebView，再从托盘正常退出；测试只使用临时隔离目录。
- 初轮 quick-capture-check-silent-first.log 因旧权限清单断言未包含新窗口而失败，现补充精确的快速记录权限集断言。quick-capture-native-first.log 误把已经封存后的主窗重复确认当作越权；second.log 试图覆盖只读 SDK invoke 属性，未真实拦截退出确认；现用真实 IPC fetch 边界制造 15 秒超时并断言请求确实被挂起。third.log 的夹具直接强杀 WebView2 后未恢复最后草稿，正常保存退出后通过的结果不能证明强杀边界已修复。quick-capture-final-tauri-quick-capture.log 中正常退出先关闭调试页、后返回命令的时序由夹具修正为核验进程确实以 0 退出，只容许该退出时的已关闭连接，不吞掉其他错误。原始失败日志全部保留。
- 相邻备份回归在 quick-capture-complete-tauri-backup.log 中出现一次恢复失败后概览 QuickNote 自动保存超时；未修改概览保存逻辑、放宽断言或延长等待。tests/tauri-backup.mjs 现会保留带时间戳的失败现场，记录隔离磁盘、输入、页面、inert 与原生日志；后续通过不证明该间歇故障根因已修复，仍为整体验收待查项。
- 最终 Debug 构建串行通过快速记录 13 项、备份 10 项、主窗回收 15 项、组件事件 7 项、草稿维护 13 项、无主窗截图 10 项、Rust／Electron 原子业务对照 7 项和 Electron 真实业务文件级回归 1 项，共 8 组／76 个条目（含父测试），日志 quick-capture-verified-*.log；不累计较早重复执行。Rust 275 项、全目标严格 Clippy、Release cargo check 与 fmt 通过。完整 check:silent 的 TypeScript、204 项 Node、Electron 构建及 4 项无窗口测试通过，无跳过，日志 quick-capture-check-silent-complete.log。范围化验证、Debug EXE／源码／日志摘要见 artifacts/tauri-migration/quick-capture-verification.json，明确保留整体未验收和历史故障。
- 此增量仍不代表全功能迁移完成：配置化全局快捷键、剪贴板贴图入口、完整截图检查点、Rust 局域网、生产接管／回退、物理输入／DPI、非正常终止恢复边界、Release 性能和实际安装产物继续待办。正式默认入口、版本和生产目录未切换，未提交、推送或发布。

## 无主窗托盘截图与冷启动编辑交接（P4/P5 部分）

- 原对话中断时已写入的原生区域／全屏托盘入口继续使用同一个捕获服务；由原生直接读取已初始化的隔离工作区设置、执行延迟和取得显示器，不为截图创建隐藏主窗口或原型窗口。维护／退出启动锁与捕获许可共同保护入口，不添加 renderer 启动后台捕获的额外权限。
- 原生入口拥有独立代次，主窗口导航／销毁只撤销从该主窗发起的覆盖层；独立托盘覆盖层及贴图源图保留。工作区恢复仍撤销覆盖层，贴图沿用现有独立生命周期。延迟捕获和实际区域选取在调用时重新核对状态；捕获失败通过原生托盘提示和有界错误输出反馈。
- 覆盖层或贴图再编辑可在没有主窗时请求“在应用内编辑”：按需创建共用主页面，等待真实主页面安装截图接收器后，才暂存并交付来源；准备与交付共用 15 秒期限。主页面启动、重载或初次加载不会销毁独立来源；超时仍保留源图和标注，用户显式重试后才继续交接。等待主页面期间不占用截图图像处理槽，避免冷启动读取与交接相互阻塞。
- 新增 tests/tauri-native-capture.mjs，实际点击 Windows 通知区域图标及原生子菜单，验证初始零 WebView、区域来源／权限与取消后零 WebView、全屏来源到贴图的完整像素摘要一致、冷启动主页面交接、主窗重载保留原始源图字节、维护期间拒绝、延迟捕获和正常退出。对首次接收器请求做测试侧传输阻塞，真实等待 15 秒后断言超时、原源图保留及显式重试成功；不在产品加入测试命令或放宽权限。
- 首轮托盘夹具仅悬停子菜单未在本机展开，改为实际点击每一级原生菜单；共用贴图托盘回归也须重新验证。第二轮将全屏 PNG 展开成数字数组经调试连接搬运，触发测试侧 Array buffer allocation failed 及系统提交内存不足，已改为所属 WebView 内计算字节／RGBA 摘要。第三轮错误地要求 Worker 重新编码的 PNG 与原 PNG 压缩字节相同，现按完整解码像素核对贴图，源图跨重载仍严格比较原 PNG 字节摘要。上述原始失败日志均保留，不将测试夹具修正记为产品缺陷修复。
- 扩展冷启动专项 8 项通过，日志 continue-native-capture-readiness.log；原生报告 native-capture-native.json 保持 productionReady=false。本轮初始完整 check:silent 的 202 项 Node 和 4 项无窗口测试通过，但未改动便签保存或无窗口夹具，不能据此宣称上一轮间歇颜色保存／跨窗广播超时已定位或修复。
- 扩展既有窗口截图回归实际发现中断代码的主窗捕获死锁：create_owned 在截图状态锁内核验来源时，CaptureOrigin::active 再次读取同一状态代次。诊断复现保存了仍停留“捕获中”的界面与原生日志，见 continue-current-tauri-capture-overlay.log、continue-capture-overlay-diagnostic.log 及 capture-overlay-failure-1794329294908.json。现将来源／窗口／生命周期核验与外层代次读取分开；事务仍在原锁内核验传入代次，回调只检查独立状态，不放宽旧来源撤销。新增主窗全屏捕获与重载撤销场景专门覆盖同一分支，须在修正构建上重新跑全部相关原生套件。
- 主窗死锁修正后，既有窗口／全屏覆盖层 12 项与扩展无主窗专项 9 项通过。贴图套件随后暴露原生菜单标签的 UIA 规范化：完整 UUID 短标签以 f8 结尾时，UIA 的 Name 将其当快捷键尾部剔除。用独立原生菜单固定“贴图 9b40a8f8”复现，GetMenuStringW 保留全文而 UIA 返回“贴图 9b40a8”，证据 native-label-probe.json 与 native-label-producer.out。夹具改为按目标 PID 枚举实际 #32768 弹出窗口、精确读取原生文字／启用状态及 GetMenuItemRect 的屏幕矩形，再实际点击；不改产品标签，不模糊匹配或改用合成命令。原生子菜单并不全部出现在 UIA 根节点，首次仅使用 UIA 根节点取得 HMENU 的夹具尝试失败，日志 continue-pins-native-labels.log 保留；改用原生窗口枚举后，贴图 17 项通过，日志 continue-pins-native-enumeration.log。
- 来源保留的进一步审查发现，reset_main 原先保留了独立源图却清空全部成功输出回执；存在已保存但次要自动复制失败的覆盖层时，主窗重载后重放同一请求可能再次执行主效果。新增单测先稳定失败（continue-native-receipts-before.log），修正后按实际存活会话保留有界回执，删除／恢复撤销的会话仍移除回执，旧代次、外窗及同编号不同请求继续拒绝；单项修正验证为 continue-native-receipts-after.log。新增真实剪贴板占用、保存警告、主窗重载及完全相同二进制请求重放的原生场景，验证只生成一个文件、返回同一警告且不丢源图；系统剪贴板由夹具保存并恢复。
- 本轮再次出现 renderer-headless.mjs 的旧跨窗广播等待超时，日志 continue-check-silent-final.log。审查发现夹具把“下一次读取”当作“本地便签保存后的快照”，会误拦截编辑前读取；显式加入一次编辑前读取后，原夹具稳定失败（continue-headless-checkpoint-before.log）。现在仅延迟包含目标便签本地编辑的快照，并明确断言捕获内容，增加非目标读取不消耗检查点的回归；原跨窗新值与迟到快照不能覆盖的断言保留，未修改产品便签保存逻辑或加长超时。此诊断证明检查点此前可误拦截，但不据此把所有历史颜色／广播超时归于同一原因。
- 最终按修正后的同一 Debug 构建串行通过 15 组原生／双运行时回归、159 个条目（含父测试和两个文件级检查），其中无主窗专项扩展至 10 项；最终日志 continue-complete-*.log，不累计早期重复执行。Rust 271 项、全目标严格 Clippy、fmt 和 Release cargo check 通过；完整 check:silent 的 TypeScript、202 项 Node、Electron 构建和 4 项无窗口测试通过，无失败或跳过，日志 continue-check-silent-checkpoint.log。脚本语法、含未跟踪源码的改动检查及测试应用进程清理通过，历史原始失败日志仍保留。
- 最终报告 artifacts/tauri-migration/native-capture-verification.json 包含逐文件源码、当前 Debug EXE、全部检查／原生日志和原生菜单诊断的 SHA-256，以及明确的未完成范围。该增量 verified=true，整体 productionReady=false；Release 编译检查不代表性能、安装包或绿色 ZIP 验收，未切换正式入口，未提交、推送或发布。
- 此增量只覆盖托盘区域／全屏入口；配置化全局快捷键、剪贴板贴图入口、完整截图维护／退出检查点、物理混合 DPI/IME、长期资源释放、Release 性能和实际安装产物仍需完成。默认入口、版本及生产目录保持原状，未提交、推送或发布。

## 截图覆盖层的维护与退出检查点（P5 部分）

- 根据实际 Electron `prepareToQuit` / `will-quit` 行为，截图覆盖层是退出后关闭的临时编辑器，不属于重启草稿。Tauri 现在让空闲覆盖层参与全窗口维护与正常退出，替代仅因窗口存在而永久否决操作；只有所有参与窗口应答成功、覆盖层原生任务结束且窗口/通道仍有效时，才允许完成退出。备份恢复仍要求先完成或取消截图。
- 覆盖层增加私有 Channel 的连接/断开及专用检查点应答共三个命令，截图业务仍为原六项。事件严格限制为维护/退出的 flush/resume，不授予通用事件、工作区、文件、主窗应答或退出发起权限。原生校验实际窗口、会话代次、连接令牌、请求 ID、退出/维护目的及待响应参与者；旧请求、错误目的、其他令牌与重复应答不能替换有效检查点，重载/销毁撤销连接与检查点。
- 检查点在同一进程中冻结整个共享编辑器实例，保留 Worker、源图、标注、裁剪、工具/样式、未提交文字和文字选择、撤销/重做、缩放/平移与导出格式，不重新挂载或合成输出。同步设置 inert 和引用屏障，拒绝新的键盘/指针/输出；实际捕获、输出、源图切换、拖动、输入法组合输入或尚未完成的控件输入会明确否决。取消、错误、15 秒真实超时及维护结束后恢复原编辑器与文字焦点/选择；成功退出按 Electron 语义关闭临时截图，不产生隐式文件、剪贴板、历史或重启草稿。
- 草稿导入成功需要重载主窗与组件时，截图不属于导入白名单，故其 resume 明确不重载；已冻结的主窗来源转为独立截图所有者，主窗重载不会删除源图或活编辑器。真实产品导入 normal 模式已验证原编辑器实例标识和未提交文字保留；其余五种导入分支仍验证原有恢复事务。主动重载截图本身会使维护检查点失效；不承诺恢复其此前内存编辑，也不把此机制当作崩溃/断电恢复。
- 新增 `tests/tauri-capture-lifecycle.mjs` 与 `e2e:tauri:screenshot:lifecycle`，验证实际 WebView2/Worker 像素、文字选择、撤销/重做、视图与格式冻结、窄权限、目的/令牌/旧应答拒绝、真实等待超时、合成组合输入及 WebView 指针手势否决、另一窗口保存失败、Ready 后重载撤权、原生另存为取消、实际收纳退出取消及正常退出零截图输出。组合事件与系统注入不是物理中文输入法/键盘验收。
- 无主窗专项新增：仅从原生托盘创建全屏编辑器，输入未提交文字，再通过 Windows 通知区域的 Win+B / Shift+F10 键盘路径打开真实原生菜单，实际选择退出，验证退出码 0、无新增文件，随后独立后台进程启动无截图/WebView 恢复。原生菜单名称、启用状态及 keyboardContext 记录在报告中。此前鼠标右键尝试没有出现菜单，保留 `capture-lifecycle-native-capture-first.log/json`；根因未证实，不将键盘路径通过描述成已修复鼠标/历史托盘间歇故障。
- 两次早期生命周期夹具失败分别为绘制落在顶部工具栏、尝试替换窗口内部 invoke 未拦截实际 IPC；现使用视口落点与实际 fetch 请求屏障，保留 first/second 日志及失败 JSON。业务捕获首次回归因新维护检查点按既有规则撤销窗口列表令牌，旧夹具继续使用过期令牌失败；现先断言旧令牌被拒绝，再重新枚举，不放宽产品权限，原始日志为 `capture-lifecycle-capture-overlay-first.log/json`。
- 首次合并回归确实发现产品行为倒退：忙碌判断误用了全局截图源图/输出工作槽，阻止主页面维护取消原生保存对话框。现改为覆盖层自身的原生操作计数，覆盖读取、区域捕获、输出与冷启动编辑交接，开始捕获和贴图继续沿用原有保护；主页面保持取消并排空已追踪输出的行为。另增同一时刻存在空闲覆盖层和主页面保存框的真实回归，不修改旧输出套件的取消断言；失败原日志保留为 `capture-lifecycle-screenshot-output-first.log`，修正前各轮原始结果在 `capture-lifecycle-before-scope-fix/`。
- 修正后的最终 Debug EXE 串行通过 16 组原生回归、207 个条目（含父测试）：生命周期 11、截图输出 17、业务覆盖层 12、区域捕获 10、无主窗捕获 11、贴图 17、维护 13、快速记录 13、主窗回收 15、组件事件 7、备份 10、剪贴板退出 8、截图文档 11、编辑交接 11、快捷键 19、产品草稿导入 22，均无跳过。Rust 279 项、严格全目标 Clippy、Release cargo check、fmt、check:silent 的 204 项 Node / 4 项无头、TypeScript 及双运行时构建通过；capture 初始化的最终通道等待还经单独 TypeScript 与全部本轮原生流程验证。251 个运行时/构建输入及 Debug EXE 在原生回归前后保持相同；重建后的 116 项前端资源与嵌入测试构建逐项一致，进程清理无残留。完整摘要与原始日志索引在 `artifacts/tauri-migration/capture-lifecycle-verification.json`；早期轮次不重复计入通过数，不将 Debug 专项或 Release cargo check 当作发布/性能验收。
- 本增量保留此前便签落盘/广播、迁移访问拒绝、WebView2 强杀草稿及托盘菜单间歇性历史失败，不据本轮通过认定根因修复。错误 tooltip 在部分成功路径未清理、物理混合 DPI/多屏/热插拔/睡眠、实际 IME、完整截图公共适配器、LAN 协议、生产接管/回退、Release 性能和实际安装产物仍待完成。正式入口、版本、生产目录保持原状，未提交、推送或发布。

## 存储基础进展（P2/P3 部分）

- Rust WorkspaceStore 使用预览目录下的 Workspace，按进程锁互斥，以单队列执行读取、三方合并、写入和广播；不会接管生产目录。
- 维持 SchemaVersion 3，补齐旧版默认值和缺失 ID；保留未知记录、设置及嵌套布局字段。有效旧版样本与实际 Electron 读取、保存逐字段差分，仅对各自生成的 UUID 作对应比较。
- 临时文件校验与落盘后安全替换，保留原始恢复字节；读取损坏数据可恢复备份，但占用、权限或 I/O 错误不能降级读取旧备份。未来数字版本（包括 4.5）不能被备份覆盖，已丢失的工作区不能静默初始化。
- 主窗口和验证组件通过带序号的定向广播同步；未保存输入不被广播重置。原生测试延迟真实 IPC HTTP 响应，确认迟到读取及保存响应不能覆盖较新更新。
- 剪贴板图片按 SHA-256 外置到 ClipboardImages，资产先于 JSON 提交、去重并保留恢复引用；按记录 ID 返回二进制，不接受任意路径。已验证缺失、损坏、目录阻塞后的重试及真实 Windows junction 越界拒绝。尚未接通系统剪贴板监听或完整图片业务。
- 工作区原生套件包含 12 项场景（加父测试共 13 项），不以 Electron 原有测试冒充 Tauri 覆盖。
- 本轮重新执行 npm run check:silent（116 项 Node、4 项无窗口测试，全部通过、无跳过）、npm run check:tauri、Rust fmt 检查及全目标 clippy；重新构建 Debug 后，工作区套件、截图/多窗原型和后台启动套件全部通过。后台套件仍明确标记 performanceGateSatisfied=false。
- 存储已被共用 React 主页面的工作区适配器使用；便签背景选择/导入已在隔离主页面接入，但生产目录及完整资产接管、浏览器草稿交接与全部业务仍未完成。原型验证界面的私人输入仍需显式保存，不能视为正式的数据与生命周期验收。

## 共用主页面与退出进展（P2/P3 部分）

- 新增 tauri.html 与 runtime/tauri.ts，在挂载现有 App 前安装类型化 DustDeskApi，并预先注册工作区和退出事件。未另做任务、便签页面，也未改动正式 Electron 入口。使用 npm run dev:tauri:workspace 或二进制 --workspace 进入。
- workspace-main 采用独立 capability，不具备原型、通用文件系统、任意 Shell 或窗口销毁权限；工作区命令再次验证真实调用窗口。创建初始数据必须由用户明确触发，已有数据拒绝覆盖。
- 已通过真实 WebView2 验证概览任务新增、便签标题与正文编辑、快速记录防抖保存、重新加载恢复和原型窗口独立更新同步。平台标识改为共享联合类型，通过原生命令获取，不再向页面暴露 NodeJS.Platform。
- 接口清单区分 isolated-verified、partial 与 pending：7 个公共成员已接入隔离主页面，退出保存及回收判定注册为部分实现；工具箱等未接通操作明确返回错误或拒绝，不把占位处理计为已迁移能力。
- 主页面及原生/托盘退出共用保存握手：暂停界面输入，运行注册回调、等待前端保存、单次请求确认、禁止最终阶段新写入、排空 Rust 存储队列后退出。保存错误、回调错误、15 秒超时会取消退出并恢复编辑；请求 ID 和前端退出代次拒绝迟到确认与旧回调干扰新请求。
- 已新增直接 --workspace 入口与主页面原生回归；包含真实磁盘保存失败后恢复编辑、等待超时、重复请求、跨代迟到回调、立即退出时尚在防抖队列的修改。Rust 新增退出状态机单元测试，总计 21 项。
- 本轮验证：npm run check:silent 117 项 Node 加 4 项无窗口测试全部通过、无跳过；check:tauri、fmt、全目标 clippy 通过。重新构建 Debug 后，直接入口 1 项、主页面 8 个场景（加父测试共 9 项）、工作区 12 个场景（加父测试共 13 项）以及截图/多窗和后台原型套件通过。主页面截图位于 artifacts/tauri-migration/shared-app.png；后台原型仍不满足完整业务性能门槛。
- 这只是单业务主窗口的退出基础。全部组件与草稿参与、后台剪贴板/局域网收尾、主窗口安全回收和生产数据迁移仍未完成，P2/P3 不据此整体验收通过；收纳退出恢复询问的后续实现见退出桌面会话一节。

## 原子业务与后台专注（P3 部分）

- workspace_productivity 接入既有 ProductivityAction，复用 Rust 单队列读改写与定向广播；快速记录、任务完成、便签编辑、回收站恢复/永久清空、整理规则保存及专注开始/暂停/继续/结束/放弃均在原工作区事务中处理，不另建数据模型。
- 快速记录保留稳定 requestId；重复提交及已删除记录重试不会重复创建或复活。输入长度按 JavaScript UTF-16 语义检查，便签继续返回 NOTE_CONFLICT / NOTE_DELETED；失败操作不提交部分字段，失败后可重试。
- 回收站恢复保留完整记录，重建缺失的链接父分组，恢复分组时过滤已存在链接但不覆盖当前项目；整理规则验证重复 ID、匹配内容、分类存在性和最多 100 条限制，普通保存不能篡改后台拥有的规则和专注集合。
- 新增原生后台计时服务，读取已有隔离工作区即可在 --hidden --workspace 无窗口启动时运行；首次启动或崩溃恢复只计到持久化检查点并暂停，检查点间隔超过 20 秒时按休眠处理。每 5 秒维护检查点及回收站过期，不依赖 React 计时器；没有变化不重复写入，也不为比较变化复制整份工作区。
- 到时生成一次专注记录；后台磁盘保存失败保留原文件，后续维护继续重试。最终退出排空队列前将运行中的专注持久化为暂停；这一步失败也会取消退出并恢复界面，不能仅凭前端保存确认直接结束进程。
- 30 项 Rust 单测覆盖确定性专注算法、恢复与冲突、文本/规则验证、保存失败后恢复和后台完成重试。原生差分以每步当前 Rust 状态为 Electron 输入，通过实际 productivity:action 比较结果及完整保存状态；仅对生成的 UUID 和实际时钟相关字段作有边界的对应，专注时间按共享算法用实际检查点重算，不忽略其他字段。
- 新增 tests/tauri-productivity.mjs 与 tests/tauri-productivity-background.mjs。后者验证真实隐藏进程没有 WebView 子进程、崩溃重启检查点恢复、模拟休眠间隔、无主窗口自动完成与目录占用后的自动重试；模拟时间间隔不能代替物理睡眠/唤醒硬件验收。
- 本轮完整检查通过：117 项 Node、4 项无窗口、30 项 Rust 测试无失败或跳过，check:tauri、全目标 clippy、fmt 和 diff 检查通过。重建最终 Debug 后，业务差分 6 个场景（加父测试共 7 项）、隐藏后台 1 项、主页面 9 个场景（加父测试共 10 项）、直接入口、工作区及截图/多窗原型套件均通过。最终退出闸门已统一放在存储队列入口，原型命令或可能触发规范化写入的迟到读取也不能绕过收尾。
- productivity 接口仍标记 partial：原生专注完成通知、快速记录窗口与草稿交接等尚未迁移。自动备份维护、资源重新关联已在后续隔离阶段接入；后台进程无 WebView 的证据不是完整业务性能验收，不据此满足 20% 内存目标或 P3 全部完成。

## 隔离备份与恢复（P3 部分）

- Rust 复用现有 JSON 备份格式，包含活跃及回收站便签背景、剪贴板图片与警告；预览使用文件原始字节 SHA256 指纹，改变后必须重新预览。手动备份遇到缺失资产明确失败；恢复前保护允许保留缺失引用并写出警告，不伪装资源完整。
- 恢复在同一存储队列内验证、创建保护副本、生成新的受管背景路径、重新关联活跃及回收站便签，再原子提交元数据。失败时清理本次新增背景/剪贴板资产，保留旧工作区及既有资产；恢复的运行中专注只计到检查点并暂停。当前数据与 .bak 均损坏时先逐字节保护，再允许显式恢复；未来版本数据也只允许显式恢复替换，不自动降级。
- 原生服务每分钟检查每日自动备份，按本地日历日判断；保留天数仅清理过期 auto 备份，不删除手动和恢复前保护。错误进入 backupStatus，下一维护周期自动重试，不依赖 React 页面定时器。
- 共用 Settings 的 BackupManager 使用实际 Rust 命令；恢复前暂停交互、排空已注册保存回调及待完成写入，防止旧防抖草稿覆盖恢复结果。恢复失败恢复编辑；退出请求等待正在进行的恢复，回调失败同时取消恢复和退出，避免死锁。启动页在载入失败时提供备份列表、预览和明确确认，不先挂载默认 App 或创建空数据。
- 只允许真实 workspace-main 窗口调用备份/图片命令，拒绝路径越界、父目录穿越、重解析点及未被当前活跃/回收站便签引用的图片；readImageFile 暂仅支持受管便签背景，不代表通用文件授权完成。
- 已新增 12 项 Rust 备份单测与 tests/tauri-backup.mjs 的 9 个原生场景（加父测试共 10 项）。覆盖实际 Electron IPC 双向导出/恢复、逐字段与图片字节比较、浏览器真实图片解码、设置页确认、自动调度、指纹变化、磁盘失败回滚、junction 拒绝、待保存草稿、并发退出及损坏启动恢复；测试仅规范化生成的资产路径/存储形式，不跳过实质记录。
- 当前备份 JSON 上限为 64 MiB，单图片上限 12 MiB；导出累积检查容量，超过时不发布部分备份。Electron 大于该上限的备份仍是迁移差距，需后续决定有界流式/分包方案；因此 5 个备份 API 暂列 partial，不能宣称全部备份兼容或 P3 完成。正式生产路径接管、完整草稿交接、通用背景导入和全部生命周期仍未完成。
- 本轮最终验证：117 项 Node、4 项 Electron 无窗口测试及 42 项 Rust 单测通过，无失败或跳过；check:tauri、严格 clippy 与 fmt 检查通过。最终 Debug 的备份 10 项、入口 1 项、主页面 10 项、工作区 13 项、业务 7 项、隐藏业务 1 项及截图/多窗、后台原型套件均通过。新增普通文件检查的错误提示带明确“保存失败”上下文，原有故障退出回归保持通过；未执行正式安装包、绿色 ZIP、生产数据接管或硬件发布验收。

## 资源检查与重新关联（P3/P4 部分）

- Rust 枚举启动器、项目、阶段、子任务、收纳文件与链接，沿用 ResourceHealth / ResourceScanProgress 契约。共用 ResourceHealthPage 不新增专用页面，也不直接调用 invoke；主页面挂载前安装原生进度监听，适配层保留 Electron 可选 parentId 的 undefined 语义。
- 每轮最多四个检查任务，文件探测另受跨扫描共享的四槽预算限制；文件系统探测与 HTTP 均有等待上限，不持有工作区存储锁。取消立即返回已完成部分结果，取消或替代后的任务不得发布迟到进度；不能强制中断的 OS 文件探测继续持有原槽直到返回，避免反复取消产生无限后台线程。
- HTTP 保留显式 http/https，不自动升级 HTTP；HEAD 返回 405/501 时在同一六秒总时限内回退 GET，不加载完整响应体。认证/缺失状态与连接失败仅标警告，凭据 URL 与含凭据/非 HTTP 重定向不发起后续请求，不因检查失败删除原记录。
- 重新关联在探测前校验引用身份，事务提交时再次校验 kind/id/parentId/target，拒绝过期引用；保留完整未知字段，仅链接更新 UpdatedAt。六类资源支持重新关联，收纳项目限原分类的受管真实路径、拒绝 junction 和大小写等价重复归属，不移动或删除实体文件。探测失败或元数据提交失败保留原记录。
- workspace-main 独享扫描与取消命令；请求 ID 与窗口所有者同时匹配。新扫描替代旧扫描、页面卸载取消、成功恢复和最终退出清理已接入；扫描期间任务仍能保存，不等待慢 HTTP 或网络磁盘。
- 新增 tests/tauri-resources.mjs，覆盖实际 Electron IPC 的完整枚举/HTTP 结果及五类普通重新关联全状态差分、收纳分类安全、共用页面编辑与单项重查、进度顺序、六秒超时、取消/替代、四并发上限、恢复/退出取消和磁盘提交失败；另有 10 项 Rust 资源/取消测试。截图与报告位于 artifacts/tauri-migration/resources-shared-page.png 和 resources-native.json。
- checkResources/cancelResourceCheck/onResourceCheckProgress 暂列 partial：真实网络磁盘断开、权限变更及物理断网尚未验收；后续已接入原生选择路径与 Shell 打开，具体实现和未完成验证见下一节。此阶段不代表 P3/P4 或全功能迁移完成。
- 本轮验证完成：117 项 Node、4 项 Electron 无窗口测试、52 项 Rust 单测及资源套件 11 个原生场景（加父测试共 12 项）通过，无失败或跳过；check:tauri、严格 clippy、fmt 和 diff 检查通过。最终 Debug 上备份 10 项、入口 1 项、主页面 10 项、工作区 13 项、业务 7 项、隐藏业务 1 项及截图/多窗、后台原型回归均通过。页面卸载用实际未完成检查 Promise 验证及时取消，不仅观察界面切页。

## 原生路径选择与打开（P4 部分）

- pickPath/pickFolder 接入 Windows IFileOpenDialog，专用 STA 线程执行 COM 操作，绑定真实工作区窗口；只允许一个选择框。通用模式可选文件或通过“选择当前文件夹”选目录，文件夹模式只选目录；标题有 UTF-16 长度与 NUL 校验，取消保留 {ok:false,canceled:true} 语义。
- openPath/openUrl 使用 ShellExecuteExW 的 open 动词，不拼接命令行、不经过 cmd/PowerShell；执行文件时不传任意参数。链接仅允许显式 HTTP/HTTPS；路径拒绝相对路径、NUL、设备路径及备用数据流。文件打开限当前工作区明确引用、数据目录或本窗口原生选择授权的精确路径，不因选择目录而授权全部后代/相邻文件。
- 文件可用性探测复用资源服务四槽预算和六秒等待；Shell 调度另限四个并发 STA，避免重复打开造成无限线程。选择授权不落盘，主窗口销毁清理授权；不开放通用 shell 插件、任意程序参数、文件读取或远程页面权限。
- 原生退出在请求保存前先取消选择框，恢复在等待待完成写入前取消选择框，解决 tracked picker 与保存/恢复相互等待。取消标记覆盖窗口句柄尚未就绪的竞态，注册选择框后复查退出状态；原生模态窗口关闭后才释放选择会话。退出失败恢复编辑，并允许重新选择。
- 新增 tests/tauri-system.mjs 与 tests/tauri-dialog.ps1，以 PowerShell 7 UIAutomation 操作真实文件选择框，不伪造选择结果。安全测试生成临时 Unicode EXE，仅写本测试目录标记，用实际 ShellExecute 确认启动且参数数量为零；与 Electron 实际 IPC 比较选择/取消结果。覆盖文件、文件夹、通用目录、并发选择拒绝、非法路径/协议、越权窗口、共用资源重新关联、恢复及成功/失败退出取消。
- 4 个系统 API 暂列 partial：默认浏览器真实调度、系统文件关联失败、物理网络盘/中文输入法及全部组件调用者尚未验收；资源右键菜单、原生文件图标和便签背景导入的后续实现见各节。相比旧实现，任意未关联路径不能直接打开，需先选择或关联；桌面枚举后另可打开本次扫描的精确路径，不把权限收敛当作全功能替代验收。
- 本轮验证：117 项 Node、4 项 Electron 无窗口、56 项 Rust 单测通过；原生系统套件 10 个场景（加父测试共 11 项）通过。最终 Debug 重新执行资源 12 项、备份 10 项、入口 1 项、主页面 10 项、工作区 13 项、业务 7 项、隐藏业务 1 项及截图/多窗、后台原型套件均通过；check:tauri、严格 clippy、fmt、接口清单与 diff 检查通过。未把默认浏览器/文件关联/物理设备或正式打包验证计为通过。

## 便签背景选择、导入与清除（P3/P4 部分）

- pickNoteBackground/importNoteBackground/clearNoteBackground 接入共用便签页，不新增专用界面。图片选择复用专用 STA 的 Windows 原生选择框和单会话策略，过滤 PNG/JPG/JPEG/WebP/GIF/BMP；恢复、退出先取消模态框，再等待受跟踪写入，防止相互等待。
- 与 Electron 保持六种扩展名、非空普通文件、12 MiB 上限及原始字节语义，不额外解码、压缩或丢失动画。读取复用跨扫描四槽预算及六秒等待；源路径和受管目录拒绝静态重解析点，源文件不移动、不删除。现有实现不声称已消除恶意进程同时替换父目录的所有竞态。
- 保留 expectedPath 未提供与显式 null/空值的区别；读取前及存储锁内提交时检查活跃便签与背景路径，迟到选择不能覆盖已修改背景。元数据失败只删除本次暂存文件，清除失败不更改引用；成功操作保留其他字段和正文，更新时间符合旧契约。
- 清除重置 ImageOnly；旧图片仍被活跃便签、回收站或 .bak 引用时保留，恢复点不可读时也保守保留。不删除外部图片；readImageFile 仍只读当前活跃/回收站授权的受管图片，不因恢复点存在而扩大读取权限。
- 新增六项 Rust 单测及 tests/tauri-note-images.mjs，原生套件比较实际 Electron import/clear IPC 的完整状态和字节，浏览器实际解码六种格式，并验证共用页面选择/路径导入/重新加载、冲突、失败回滚、越权窗口、静态 junction、共享回收站图片及备份恢复。原生选择框自动化共用 tests/tauri-dialog.mjs/ps1，不伪造选择结果。
- 三个背景 API 暂列 partial：全部小组件、原生文件拖入、网络盘断开和真实中文输入法尚未验收。生产数据完整资产接管、浏览器草稿交接及硬件/发布门槛未通过；这不是 P3/P4 或全量迁移完成。
- 本轮验证：117 项 Node、4 项 Electron 无窗口、62 项 Rust 单测及背景原生套件 11 个场景（加父测试共 12 项）全部通过，无失败或跳过。最终 Debug 重新执行系统 11 项、资源 12 项、备份 10 项、入口 1 项、主页面 10 项、工作区 13 项、业务 7 项、隐藏业务 1 项及截图/多窗、后台原型套件均通过；check:tauri、严格 clippy、fmt、接口清单与 diff 检查通过。报告为 artifacts/tauri-migration/note-images-native.json；后台原型仍明确 performanceGateSatisfied:false，不能代替完整 Release 性能验收。

## 原生文件与快捷方式图标（P4 部分）

- getPathIcon 接入隔离工作区适配器。Windows 专用 STA 使用 SHGetFileInfoW 读取真实 Shell 项，文件夹不会因 .exe/.lnk 等名称后缀变成文件或卷图标；EXE/DLL/ICO/ICL 优先 ExtractIconExW，不启动目标程序或拼接命令行。
- 快捷方式通过 IShellLinkW/IPersistFile 只读加载，不调用 Resolve 或执行目标。保留自定义资源、正/负索引及无效索引回退 0、丢失资源回退目标再回退 Shell 的旧语义；路径支持环境变量、Unicode、逗号和相对图标位置。PNG/JPEG/GIF/BMP 自定义图片保留旧版 4 MiB/1024px 限制，解码内存另有预算，过限回退目标图标，不把整张图片/任意 SVG HTML 注入页面。
- 原生 HICON、颜色/掩码位图、DIB、DC 和 COM 生命周期均有释放守卫；按 HICON 实际位图尺寸编码，不强制缩成 32px，并有 64px 原生句柄转换测试。图标按黑/白背景重建 RGBA，保留透明度，并允许 Windows 预乘透明度带来的小量舍入差异，不以 PNG 编码字节完全一致冒充像素要求。普通操作图标仍使用静态导入 Lucide，不引入其他通用图标库；合成 64px 测试不代替物理混合 DPI 验收。
- 原生服务最多四个提取线程和 32 个待完成键，同路径请求共享结果；总等待六秒。超时不能强行终止系统 Shell 扩展，真实线程继续占用原许可直至返回，不能通过重复超时无上限创建线程。缓存最多 256 项、8 MiB 编码数据，成功/失败分别 30/3 秒逻辑有效期，按最早插入淘汰；超过预算的单项可返回但不缓存。
- 读取前、返回前复查当前工作区或本窗口精确选择授权；引用撤销后连缓存也不可读，不授权被选文件的父目录或同级文件。非法、不可读、缺失和静态重解析路径返回空图标结果，已知目录在提取失败时保留 isDirectory；命令仅 workspace-main 可调用，不开放通用文件读取。任意外部 Shell 扩展的内部行为不在应用进程的安全保证范围内。
- 新增五项 Rust 服务测试，覆盖共享、短失败缓存/重试、数量/字节淘汰及超时后许可保留；另四项 Windows/路径测试验证实际句柄分辨率、资源位置、非法路径与环境展开前的 UTF-16 分配预算。tests/tauri-icons.mjs 在真实 WebView2 调用公共 API，以实际 Electron Windows 读图器作参考，比较 34 个文件夹/卷/文档/程序/快捷方式样本，含环境变量、相对路径、Unicode 与逗号资源；还覆盖静态权限约束、非法类型输入、选择授权、源路径 junction、超限资源、并发 GDI/USER 句柄收尾与目标程序未被调用。六个原生场景加父测试共七项通过，最大合成像素通道差约 1.985/255。
- 对比报告为 artifacts/tauri-migration/icons-native.json，截图为 icons-native-comparison.png；截图是明确标记的诊断夹具，不是已迁移全部小组件的界面证明。getPathIcon 暂列 partial：全部组件调用者、混合 DPI、远程 Shell 扩展、物理网络盘断开与发布包资源仍待验收。
- 本轮验证：117 项 Node、4 项 Electron 无窗口、71 项 Rust 单测及七项图标原生测试通过，无失败或跳过。最终 Debug 重新执行背景图片 12 项、系统 11 项、资源 12 项、备份 10 项、入口 1 项、主页面 10 项、工作区 13 项、业务 7 项、隐藏业务 1 项及截图/多窗、后台原型套件均通过；check:tauri、严格 clippy、fmt、接口清单和 diff 检查通过。后台原型仍为 performanceGateSatisfied:false，未进行正式安装/绿色包、五轮全功能 Release 性能、生产接管或两台物理电脑验收。

## 桌面枚举与原生文件菜单（P4 部分）

- listDesktopEntries 接入共用桌面收纳页，保持 Name/Path/IsDirectory、仅直属项目、排除大小写不敏感 desktop.ini、目录优先及 zh-CN 排序。Rust 使用 ICU 中文排序，不将字符串字节顺序当作语言排序；差分夹具覆盖汉字、英文、数字、标点、重音及规范等价名字。
- 预览默认只枚举预览应用目录下 Desktop，测试使用 DUSTDESK_TEST_DESKTOP_DIR 的显式绝对路径；不自动创建不可读/不存在的目录，也不探测生产桌面。读取失败和六秒超时沿用旧版空数组语义，不是“桌面确实无文件”的诊断结论。单扫描许可和资源共享四槽保留到实际阻塞 IO 结束，避免慢盘反复扫描创建无限线程；并发追加扫描不启动另一个 IO。
- 每次有效扫描替换精确项目授权，不授权父目录、后代和相邻路径；失败扫描清除上次授权，恢复/主窗口销毁使未完成扫描世代失效。图标、菜单及 openPath 可复用本次桌面授权；菜单和原生打开探测新增共享的静态重解析点检查，不因为桌面返回 junction 条目就允许越界打开。
- showPathContextMenu 保留旧菜单三项，不新增整套 Explorer 扩展动词或删除操作。使用 Windows TrackPopupMenu，在独立 STA 的临时工具窗口泵消息，该隐藏窗口归属主窗口，避免在 Tauri 主线程的嵌套菜单循环阻塞后续 IPC。单会话防止目标串线，取消标志覆盖尚未创建 HWND 的竞态；弹出窗口和菜单句柄自动释放。
- 点击操作再次验证当前路径授权和存在性。打开复用 ShellExecuteExW open、不传任意参数；显示通过 PIDL 和 SHOpenFolderAndSelectItems，不拼接 explorer.exe 参数；复制使用 CF_UNICODETEXT 和可移动内存，明确转移系统所有权并处理剪贴板短暂占用重试。预检失败返回错误，异步菜单动作失败定向通知共用主页面并显示 toast；两个原有调用者也展示返回的失败结果。
- 原生退出、恢复等待写入前先取消活动菜单；恢复成功/窗口销毁清理桌面授权，已取消操作不派发迟到动作。保留旧 API“菜单已请求显示”返回语义，不把返回 ok:true 当成用户已选中或 Shell 操作已成功；恶意外部进程并发替换路径的全部竞态仍不在已验证保证内。
- 新增三项 Rust 桌面测试和两项菜单会话/取消测试。tests/tauri-desktop.mjs 在隔离目录与实际 Electron organizer:list 比较完整结果，使用真实共用页面缩略图、原生菜单和物理点击验证三项操作；Explorer 只关闭测试独有目录窗口。复制测试保存/恢复剪贴板，独占锁故障测试不改写内容并验证序列号不变。另验证越权窗口、非法路径/junction、菜单期间撤销授权、失败扫描、恢复/成功及失败退出，不以假菜单返回值代替原生交互。
- 两个 API 暂列 partial：真实桌面 Known Folder/重定向、网络盘断开、混合 DPI 菜单位置、全部组件调用者仍待验收；手动整理移动/分类收纳/撤销和事务恢复日志的后续实现见下一节。没有将只读枚举和三项菜单当成完成整个整理模块或 P4 的证据。
- 当前共用页面仍会提示未迁移的小组件状态读取失败；页面截图中该提示不表示本轮枚举或菜单失败，也不能隐去它来宣称整个桌面收纳页面已无功能缺口。
- 本轮验证：117 项 Node、4 项 Electron 无窗口、76 项 Rust 单测与桌面套件 11 个原生场景（加父测试共 12 项）通过，无失败或跳过；实际菜单保持弹出时，工作区读取/保存仍在两秒内完成并持久化，确认不是依赖关闭菜单才能继续 IPC。最终 Debug 上图标 7 项、背景图片 12 项、系统 11 项、资源 12 项、备份 10 项、入口 1 项、主页面 10 项、工作区 13 项、业务 7 项、隐藏业务 1 项及截图/多窗、后台原型套件通过。check:tauri、严格 clippy、fmt、接口清单与 diff 检查通过；后台原型仍明确 performanceGateSatisfied:false，不代表完整 Release 内存、正式包、生产接管或物理两机验收已通过。

## 手动收纳与文件事务日志（P4 部分）

- moveIntoCategory/restoreToDesktop/undoOrganizerMove 接入原有共用页面与受跟踪写入，命令只允许 workspace-main。工作区存储队列内重读当前分类和项目归属，手动收纳限配置的隔离桌面直属项目或受管项目；恢复限指定分类子树，路径禁止根目录/包含受管根目录的祖先、静态 symlink/junction 和未授权来源。分类名沿用旧 safeName，冲突不自动覆盖或伪装成功。
- 同卷使用 Windows MoveFileExW（不带替换目标标志），即使预检后出现同名目标也不能覆盖。递归文件树记录卷/文件 ID、创建时间、完整修改时间、长度及 SHA256，目录、空文件、Unicode 文件名和 1970 年前时间均有测试；数据流以有限缓冲读取，不将整个文件载入内存。跨卷错误进入目标同目录的唯一暂存目录，逐项 create_new、文件 sync，验证内容与源身份稳定后才发布目标并开始清理源项目。
- organizer.pending.json 在移动前原子发布并 sync，保存配置根、前后位置、源/目标文件身份树、暂存位置及待提交工作区；128 MiB 日志上限明确报错。OrganizerTransactionId 为原生拥有的未知字段，防止前后元数据恰好相同被误判已提交；普通 renderer 保存不得改写它。提交后清理日志失败不把已完成操作伪报成未完成，后续读取会继续核验收尾。
- 崩溃/元数据失败恢复先核验当前工作区和保存身份：未提交的同卷移动补偿回源，已提交的不反向移动，源与完整副本同时存在时仅在两者身份内容均完整时清除重复副本。源清理只完成一部分、暂存身份不明、目标被替换或恢复日志损坏时保留完整副本及原位置，不盲删/覆盖；后续读写、初始化和备份恢复会拒绝继续，错误包含需检查的位置。手动修复入口尚未实现。
- 跨卷反向重命名返回不同卷错误时，先在原位置同目录登记独立补偿暂存目录，再复制、sync、核对完整字节和目标身份，持久化新副本身份后才以不覆盖重命名恢复原位置，重新校验恢复副本后才删除失败目标。补偿日志可续跑创建暂存前、空暂存、完整副本登记后、原位置发布后、目标清理后、暂存清理后六个持久边界；补偿不会提交失败的工作区元数据或推进撤销。新同名源、未知部分副本、替换身份、修改后的目标和越界/重叠日志均拒绝自动清理，保留数据与日志。
- 手动操作保留其他工作区/分类字段；持久化最近 100 个撤销动作、分类间转移的原分类身份和未知字段，撤销可恢复已删除分类或复用同目录分类。兼容目录扫描找回可撤销项目，但不将暂存目录当成普通项目。失败记录追加到隔离 Logs/organizer-move.log，记录失败不能掩盖原错误。成功后广播真实快照并撤销过期桌面授权。
- 收纳现有 23 项 Rust 测试，覆盖原始字节、目录树、持久化撤销/分类恢复、同名竞争、独占文件占用、元数据失败、强制复制分支、部分源清理、已提交/未提交进程重启、反向补偿及六个持久边界、旧版无补偿字段日志、暂存目录不得与源/目标重叠、替换身份、损坏/外部根/越界树日志和原生事务字段保护。tests/tauri-organizer.mjs 使用真实 Electron IPC 比较手动收纳/分类转移/撤销/恢复的已知状态和文件字节；额外断言 Rust 保留旧 Electron 规范化会丢弃的分类未知字段。真实共用菜单收纳与撤销、目录与 junction、安全拒绝和元数据失败回滚有原生覆盖。
- tests/tauri-organizer-cross-volume.mjs 使用实际不同 NTFS 卷 C/D，核实 stat.dev 不同和普通 rename 返回 EXDEV，不用强制复制代替跨卷证据。跨卷收纳、恢复/撤销、收纳元数据失败自动反向复制、恢复元数据失败自动反向复制已有实际验证；智能批量跨卷事务与失败补偿的后续验证见下一节。8 MiB 确定性数据按 SHA256 核验，并检查嵌套/空目录、空文件、元数据未变、无残留暂存与日志及故障解除后可重试。报告为 artifacts/tauri-migration/organizer-cross-volume.json。不同卷不等于两块物理设备，仍不宣称已通过可移动盘断开或完整文件系统元数据兼容。
- 三个手动 API 暂列 partial：可移动盘断开/权限、ACL/备用数据流等元数据保真、全部小组件和生产接管仍未完成或未验收；智能计划/批量执行及退出桌面会话的后续实现见各节。递归文件事务当前持有存储队列，慢盘会延迟其他保存/退出，未达到最终后台性能与完整退出恢复门槛。损坏/不确定日志目前要求人工检查，不应删除日志或用旧备份冒充实体文件恢复。
- 本次最终验证：117 项 Node、4 项 Electron 无窗口、99 项 Rust 单测全部通过，无失败或跳过；类型检查、Electron/Tauri 前端和原生 Debug 构建、严格 clippy、fmt、接口清单及 diff 检查通过。最终 Debug 串行通过手动收纳 6 项、真实跨卷 5 项、桌面菜单 12 项、备份 10 项、工作区 13 项。此前中断尾部回归的单实例并发干扰已消除，按顺序重跑工作区、业务、隐藏业务、截图/多窗和后台原型通过；这些结果不替代完整 Release 性能、物理环境、正式产物或生产接管门槛。

## 智能整理预览与确认执行（P4 部分）

- planSmartOrganize/executeSmartOrganize 接入共用 React 页面、已有 workspace_organizer 命令及 workspace-main 权限，不新增任意文件读写能力。预览只枚举隔离桌面直属项目，排除大小写不敏感 desktop.ini；目录与普通文件沿用旧版同名分类语义。读取失败明确报错，不生成空目录或隐式执行移动；既有待恢复事务仍由工作区读取先恢复。
- 规则按保存顺序选择第一个启用且分类仍存在的匹配项，支持名称包含、扩展名、英文/中文逗号、*.ext/.ext/ext 和大小写不敏感；复用已有 JavaScript trim 兼容函数，覆盖 BOM、NEL、Unicode 大小写及多个后缀。未命中时保留“工作/开发/工具/文件”扩展名分类，再回退第一个分类，没有分类时返回空计划，不创建新分类。
- 执行必须提供数组，整批预检最多 5000 项且每项 SourcePath/CategoryId 为字符串；缺少计划、错误格式或超过上限在任何移动前返回原有确认错误。按原始 SourcePath 去重，首项分类优先；不重新扫描替换用户确认的计划，不信任 CategoryName。逐项重读当前分类与工作区，仅允许隔离桌面顶层源，拒绝外部/嵌套/junction、同名覆盖和失效分类。
- 每项复用原生收纳文件事务、持久化撤销和元数据失败补偿，部分失败继续后续项，返回准确 moved 及原有中文失败说明；已成功项目不因后续失败回滚，实际快照广播并撤销旧桌面授权。批量操作纳入 renderer 退出/恢复写入跟踪。失败逐项追加隔离日志，日志写入失败不能覆盖原错误。
- 测试发现旧版目录恢复扫描会把已有同名冲突文件追加到最新真实撤销之后，导致“成功项目可逐项撤销”被无关文件阻挡。Tauri 将目录扫描找回项放在真实持久化历史之前，优先撤销最近成功事务；同名目标仍不覆盖。不把此项行为修正伪称完全复刻旧版缺陷。
- 新增 7 项 Rust 测试，覆盖默认分类、规则优先级与缺失分类、Unicode/空白、只读预览、缺目录、空分类、错误/超大确认、重复项、部分成功、外部/嵌套路径、元数据失败和撤销。tests/tauri-organizer-smart.mjs 通过真实 Electron IPC 对比完整预览、错误/重复确认及部分失败结果，并在真实 WebView2 页面点击智能预览、执行计划、撤销。页面保留 Lucide 操作图标和 Shell 文件图标，不另做视觉改版；截图为 organizer-smart-preview-native.png 和 organizer-smart-shared-native.png。
- 两个智能 API 暂列 partial，整个 P4 不标完成。仍需解决慢盘/大批量持有存储队列对保存和退出的影响，补齐物理断盘与元数据保真、全部组件、生产接管与完整发布性能验收；退出恢复/启动重收纳的后续实现见下一节。
- 本轮验证：117 项 Node、4 项 Electron 无窗口、106 项 Rust 单测通过，无失败或跳过；类型检查、双前端与 Tauri Debug 构建、严格 clippy、fmt、接口清单和 diff 检查通过。最终 Debug 串行通过智能整理 7 项、实际跨卷 6 项（新增确认批量的失败补偿、重试与撤销）、手动整理 6 项、桌面菜单 12 项、备份 10 项、工作区 13 项、业务 7 项和主页面 10 项。实际预览与执行后截图已检查，页面仍显示尚未迁移的小组件能力提示，不能据此宣称整个收纳页面已无缺口。接口清单保持 7 个隔离验证项，智能接口不提升为生产完成状态；Electron 默认入口、版本和生产目录未切换。

## 退出恢复桌面与启动重收纳（P3/P4 部分）

- 退出在主页面完成保存握手、暂停新操作、进入原生提交阶段后检查真实受管项目，弹出 Windows 原生三选确认；默认选择“取消”。“是”恢复并退出，“否”保留收纳并退出，正文明确解释下次启动重收纳；关闭/取消返回编辑，不以默认恢复或无提示移动代替原有确认。弹窗绑定可见主窗口，后台退出也可显示原生确认，不依赖创建新 WebView。
- 临时桌面恢复不改分类 ItemPaths、原分类未知字段及持久化撤销，逐项复用不覆盖、跨卷校验和失败补偿事务。文件冲突按 stem (n).ext、目录按完整名称 (n) 分配桌面位置；提交时写 OrganizerDesktopRestores，保留 source/target/categoryId/ino/birthtimeMs，并附 NativeRestoreId 和原生根身份。完整内容树只在事务日志使用，工作区只保留根身份，避免大目录重复膨胀工作区。
- 跨卷新目标身份在移动后重新核验，并在提交工作区前原子更新事务的 after 和恢复记录；进程在封存身份前、后或元数据提交后崩溃，重启按未提交补偿或已提交收尾，不误用旧卷身份。Native 字段仍按工作区未知字段保留，不降低 SchemaVersion，也不允许 renderer 改写原生恢复记录。
- 存储首次成功读取前先恢复待处理事务、执行启动重收纳，再提供快照；托盘后台维护同样经过该路径，不要求先打开主窗口。只重收记录仍由分类持有、位于受管根下一层分类目录且桌面根正确的项目，分类更名不丢失旧物理路径。已存在受管源、消失桌面目标、已删除归属和替换身份不会覆盖/误收新文件；真实原项目在桌面编辑内容或目录增删子项后仍按根身份收回，再以当前完整内容树验证移动。
- 原生记录校验卷/文件 ID/创建时间；旧 Electron 记录使用精确 ino/birthtimeMs。已用实际 Node fs.stat 及 Electron 的 restoreOrganizerForQuit/resumeOrganizerSession 双向验证格式和时间算术，不以自造匹配样本代替旧运行时兼容证据。启动失败保留记录并拒绝返回可写工作区，解除占用或权限故障后可重试；同名替换文件留在桌面，不因字节相同被认作原项目。
- 启动跨卷收回时若元数据失败，反向补偿产生新桌面身份；补偿日志同时保护旧身份与新副本，先刷新当前恢复记录身份后才清理失败受管副本。刷新失败保留两个完整副本及日志，故障解除后可续恢复并再次收纳，避免将安全补偿出的原文件误判成外部替换。退出中途失败取消退出，并在恢复编辑前重收此前成功恢复的项目；不删除实体文件来模拟回滚。
- 新增 8 项会话 Rust 测试及 1 项事务封存崩溃边界测试，覆盖更名分类、编辑与目录变化、冲突后缀、替换身份、旧格式、外部记录、独占占用启动重试、部分退出失败后重收及元数据故障。tests/tauri-organizer-session.mjs 覆盖实际原生取消/保留/恢复按钮、默认取消、真实进程重启、文件编辑、元数据失败和 Electron 双向会话兼容；tests/tauri-organizer-cross-volume.mjs 补充实际 C/D 卷退出与启动失败身份刷新和恢复重试。所有文件均为隔离模拟桌面，不访问生产桌面。
- 当前仍不是完整 P3/P4 验收：慢盘事务与批量操作持有存储队列、全部编辑组件/草稿、原生剪贴板与局域网收尾、生产桌面定位和身份接管、物理断盘与完整元数据保真、Release 性能及正式产物/回退仍未完成。无法确认身份的部分日志仍需人工检查，尚无完整恢复管理界面。
- 本轮最终验证：115 项 Rust、117 项 Node 和 4 项 Electron 无窗口测试通过，无失败或跳过；类型检查、双前端与原生 Debug 构建、严格 clippy、fmt、接口清单与 diff 检查通过。第一次无窗口便签延迟同步测试在同时运行原生回归时超时，保留失败日志；分离后完整 check:silent 重跑通过，未修改无关便签代码或放宽断言。最终 Debug 串行通过会话 8 项、实际跨卷 7 项、智能 7 项、手动 6 项、桌面 12 项、备份 10 项、工作区 13 项、业务 7 项、隐藏业务 1 项、主页面 10 项、入口 1 项及截图/多窗和后台原型。后台报告仍为 performanceGateSatisfied:false；这些证据不代替全功能 Release 内存、正式安装包/实际绿色 ZIP、物理两机与生产回退验收。保持专用分支、Electron 默认入口和隔离数据，未提交、推送或发布。

## 原生文件搜索与结果授权（P4 部分）

- searchFiles/cancelFileSearch 接入共用全局搜索栏及两项 workspace-main 专用命令，不允许 renderer 指定任意临时扫描根。读取工作区快照后离开存储队列，扫描采用独立阻塞任务，保存不等待目录遍历；取消、替换查询、退出、主窗销毁和成功备份恢复使过期扫描失效。
- 保留原有设置顺序：隔离桌面、开始菜单 Programs、隔离应用数据、项目/阶段/子事项关联目录或关联文件父目录、自定义根；按 Windows 路径去重，最多十个根。预览应用数据与开始菜单均定位到隔离预览根，不扫描真实用户 AppData/开始菜单；生产 Known Folder/重定向定位仍待迁移验收，不将隔离路径伪称生产兼容。
- 文件名按 JavaScript 兼容 trim、Unicode 小写和包含匹配；少于两个 UTF-16 单元或超过 256 单元返回空数组，保留单个代理对字符的既有语义。不读取文件正文。广度优先、每根最多 50000 项、总共最多 40 个结果；重叠根不重复结果/目录，读取失败跳过。沿用实际 Windows 目录枚举顺序，不引入新的大小写敏感排序；已通过真实 Electron IPC 完整结果与顺序差分。
- 相同根与小写查询缓存两秒，最多 32 组；根配置变化不复用其他范围缓存，过期结果仍需通过原生打开的存在性与路径安全检查。取消后不缓存不完整扫描，旧任务不得发布缓存、结果或授权。请求 ID 相同也按原生会话身份阻止旧超时取消新任务。
- 扫描仅允许一个实际阻塞 worker，并复用资源检查的四槽文件 IO 预算。排队等待可取消；对外六秒返回空数组并停止发布，已进入不可中断系统 IO 的线程仍持有许可直到实际返回，不因超时/取消无限增建阻塞线程。物理慢盘/断网六秒交互与完整 Release 性能尚未验收，此处不宣称能强制中止 Windows 同步 IO。
- 每次发布仅授权本次精确结果，供既有文件图标、Shell 打开和受控菜单使用，不授权父目录或任意后代；新查询、对应活动/已完成请求取消、退出、销毁及恢复撤销旧授权。根/祖先和条目的静态 symlink/junction、设备/ADS 路径拒绝搜索/打开；这比旧实现展示重解析点更收敛，不以越界结果算兼容。并发外部恶意路径替换的全部竞态仍不作已验证保证。
- 新增 8 项 Rust 测试，覆盖 UTF-16/空白、根选择与上限、BFS/结果去重与上限、缓存容量/到期、世代取消、同 ID 超时、精确授权和阻塞 worker 许可保留、junction。tests/tauri-search.mjs 覆盖真实 Electron 多范围/错误查询/重复根/上限差分，缓存、取消与保存并发、越权窗口、重解析点、结果权限撤销、备份恢复和真实共用搜索栏 Enter 打开隔离 EXE，验证没有附加命令参数；截图为 search-shared-native.png。
- 两个 API 暂列 partial：全部小组件调用者、生产 Known Folder、网络盘断开、物理慢 IO、Release 内存与生产接管未通过。不因此标记完整 P4 或迁移计划完成；工作区保存仍可能被尚未拆分的收纳文件事务阻挡，不能把搜索扫描解耦推广为全应用存储队列已解决。
- 本轮验证：123 项 Rust、117 项 Node 与 4 项 Electron 无窗口测试通过，无失败或跳过；类型检查、Electron/Tauri 前端与原生 Debug 构建、严格 clippy、fmt、接口清单及 diff 检查通过。最终 Debug 串行通过搜索 8 项、系统 11 项、桌面 12 项、资源 12 项、备份 10 项、会话 8 项、实际跨卷 7 项、智能 7 项、手动 6 项、工作区 13 项、业务 7 项、隐藏业务 1 项、主页面 10 项、入口 1 项及截图/多窗与后台原型。资源旧回归曾因新增收纳退出确认等待而失败，现补充真实默认取消检查、确认前扫描已取消及点击“保留收纳”，重跑通过，没有关闭生产确认来让测试过关。真实搜索栏截图已检查，继续使用 Lucide。接口清单保持 7 个隔离验证成员，不把新增部分实现提升为生产完成；后台性能门槛仍未通过，Electron 默认入口、版本及生产目录未切换，未提交、推送或发布。

## 原生系统监控与共用检测页（P4 部分）

- sampleSystemMetrics 已通过 workspace-main 专用 system_sample 命令接通现有 React 系统检测页；不改公共字段、单位或监控显示设置，不新增另一套监控界面，继续静态使用 Lucide。验证窗口与其他角色无调用权限，退出握手期间拒绝新采样，前端在恢复/退出期间也不发起采样。
- Windows 平台实现直接使用 GetSystemTimes、GlobalMemoryStatusEx、GetTickCount64、GetLogicalDriveStringsW/GetDiskFreeSpaceExW；CPU 按内核（含空闲）与用户时间差计算，物理可用内存对应旧版 available 语义。不可访问或无容量驱动器略过，不把查询失败写成零容量盘。
- 网络按 Windows 到固定 1.1.1.1 的最佳接口采集 GetIfEntry2 字节计数，在约 250 ms 间隔计算速率；接口改变、重置或不可用时不制造负数、溢出或跨接口差值。不是把所有网卡及回环流量相加。延迟用固定目标 ICMP，单次等待上限 1000 ms，失败保持 -1。
- 磁盘吞吐通过原生 PDH 英文 PhysicalDisk(_Total) 读写计数采样，不启动 PowerShell/CIM/Node/ping 子进程；PDH 不可用、状态无效、负值或非有限值保持 null。PDH 查询与 ICMP 句柄由 RAII 释放。测试可使用 PowerShell 获取独立参考，但产品运行不依赖它。
- 仅按调用需求采样，无原生周期轮询。成功结果缓存两秒，同一批并发调用共享单个阻塞 worker；采样脱离工作区保存队列。单次调用五秒超时，即使 OS 查询仍阻塞也保留该 worker 的在途状态，不因超时重试积累线程；之后可共享其最终结果，失败不缓存。
- 新增 7 项 Rust 测试验证字段/空值、CPU 差分/溢出、接口变化/计数重置、无效磁盘值、成功缓存到期、并发共享、超时后保留 worker、失败和 panic 后恢复。原生套件为 9 场景加父测试共 10 项，验证真实 Electron IPC 字段契约、独立 Windows 内存/磁盘容量/运行时长参考、实际刷盘负载下正磁盘速率、并发缓存与到期、保存并发、无采集子进程、共用页面定时/手动刷新与设置重载、角色/退出限制及四轮过期查询句柄数。报告 metrics-native.json，截图 monitor-shared-native.png；Electron 无窗口指标为模拟值，不据此声称实时数值完全相等。
- 共用页面的 null 磁盘、-1 延迟和拒绝采样提示通过受控适配器故障验证，不冒充物理断网、禁用计数器或防火墙故障验收。实际 Shell 小组件运行时尚未接通，启动时仍可能显示既有“小组件状态”不可用提示，不把监控页可用写成全部系统能力可用。
- 当前 API 仍列 partial。监控小组件、真实网卡/路由切换与断网、禁用磁盘计数器、ICMP 被拦截、慢/断开的网络盘、多处理器组、混合 DPI、完整 Release 性能和生产接管仍待验收。GetSystemTimes 在多处理器组上的覆盖范围不能直接等同所有 CPU；五秒超时也不是底层网络盘 I/O 的强制取消。
- 本轮基础验证：130 项 Rust、117 项 Node、4 项 Electron 无窗口测试通过；严格 clippy、fmt、类型检查、Electron/Tauri 前端和原生 Debug 构建、接口清单通过。新增命令权限缺漏曾在真实调用中被拒绝，已仅补入主窗口能力并验证其他角色仍被拒绝；测试的按钮定位修正为真实 title，不修改产品交互来配合测试。完整迁移仍未完成，默认入口、生产目录及版本未切换。
- 最终 Debug 的原生监控 10 项、搜索 8 项、系统 11 项、工作区 13 项、共用主页面/退出 10 项和入口 1 项通过，均无跳过。系统套件首次未在 UI Automation 快照中找到“选择当前文件夹”，保留失败日志 metrics-regression-system.log；未改产品或削弱断言，独立串行重跑 11 项通过，结果为 metrics-final-system.log。监控正磁盘速率来自隔离文件的 64 MiB 累计写入及 sync，不以静止时零值或另一采样时刻的 CIM 速率冒充有效吞吐验证；四轮采样句柄检查只是有界回归，不是长时间泄漏或性能验收。

## 原生开机启动设置（P4 部分）

- getStartupEnabled/setStartupEnabled 接通共用设置页和主窗口专用 system_startup 命令，保持 boolean/void 公共契约。Rust 使用 HKCU 注册表原生 API，仅维护 DustDeskTauriPreview 单个值，不启用通用注册表、任意执行或 renderer 指定启动路径权限；其他窗口与退出期间的新操作被拒绝，修改与工作区保存不共用阻塞队列。
- 预览手动启用时使用当前可信可执行文件的带引号路径及固定 --workspace --hidden 参数，禁止路径中的引号/控制符，超过 Windows Run 命令长度限制时明确报错，不截断命令，也不因此阻止应用正常启动。读取只认可当前完整命令；其他程序/旧路径、额外参数和不匹配命令不当作本进程已启用，不执行注册表读出的内容。
- 未配置测试目录时，只在用户明确调用开关后修改独立预览 Run 项，不接管或删除 Electron 项，也不自动根据导入的 StartWithWindows 字段变更系统设置。配置 DUSTDESK_TEST_USER_DATA_DIR 后始终使用 Software/DustDesk/TauriMigrationTests/<目录 SHA-256>/Run 隔离子键，包括非 Unicode 环境路径也不回落到真实 Run。读取缺失项不创建键，禁用仅删除自身值并保留其他值。
- 注册表读取校验 REG_SZ、大小、UTF-16、终止符和嵌入空字符，限制缓冲区并保留原始错误；句柄通过 RAII 释放。系统操作串行执行，写入后重读验证，不以返回空值冒充写入成功；产品不启动 PowerShell/reg.exe/Node 辅助进程。读取的是本应用精确 Run 注册项，不把它说成已证明 Windows 实际登录必然启动，StartupApproved 仍待验证。
- 共用设置页读取真实系统状态而不是把工作区字段视作系统事实；加载/提交期间禁用开关并防止重复点击，未知状态保持禁用并给出重开设置的提示。读取和设置失败有明确提示，不产生未处理的 Promise 拒绝或盲目翻转开关。StartWithWindows 仍是界面保存的工作区副本，系统 Run 与工作区并非跨资源原子事务；不能因工作区备份中的布尔值变化就悄悄修改系统启动项。
- 新增 3 项 Rust 测试覆盖命令引号/固定参数/无效及超长路径、隔离键哈希/注入和畸形注册表字符串。原生套件 10 场景加父测试共 11 项，覆盖真实 Electron IPC 契约、缺失读/幂等、其他值保留、不匹配及 DWORD 类型、参数/角色限制、共用开关与重载/重复点击、实际 SetValue 拒绝及 ACL 恢复、原生读取错误、恢复备份不改系统项、退出拒绝与实际进程重启。启动参数通过隔离启动直接执行，不对真实 Windows Run 写入测试命令。
- 隐藏重启实测只有主进程与 Debug conhost，没有 WebView2；通过单实例唤起后只打开共用 tauri.html，不打开原型页面，注册项跨进程保留且可正常退出。测试读前/读后真实预览 Run 值均未变化。注册表 helper 仅处理校验后的测试哈希子键，临时拒绝 SetValue 规则在 finally 与清理时精确移除，结束删除本套件子键；不修改生产 Run、StartupApproved 或系统登录策略。
- 报告 artifacts/tauri-migration/startup-native.json，截图 startup-shared-native.png，命令 npm run e2e:tauri:startup。此项仍标为 partial：真实注销/登录、任务管理器禁用状态、安装/移动路径、正式项接管与回退、StartHiddenToTray 设置以及全部后台服务、Release 安装/绿色包仍未完成；不能以预览 Run 项和隐藏启动测试替代这些门槛。
- 本轮 133 项 Rust、117 项 Node、4 项 Electron 无窗口测试通过，类型检查、严格 clippy、fmt、Electron/Tauri 构建及接口清单通过。一次完整 Rust 回归中的既有 old_electron_identity_records... 测试遇到 NotFound，失败日志 rust-startup-final.log 保留；未改该测试或产品实现，单项及完整 133 项重跑通过（rust-startup-final-retry.log），尚不推断偶发原因或宣称该问题已修复。默认入口仍是 Electron，未提交、推送或发布。
- 最终 Debug 串行回归：启动项 11 项、系统监控 10 项、系统对话框 11 项、备份 10 项、工作区 13 项、主页面/退出 10 项、入口 1 项通过，无跳过，日志 startup-final-<套件>.log。最终 check:silent 的既有 renderer-headless 便签迟到广播断言曾在 tests/renderer-headless.mjs:216 超时，日志 check-silent-startup-final.log 保留；未修改便签实现、测试断言或等待时限，完整隔离重跑 117 项 Node 和 4 项无窗口测试通过（check-silent-startup-final-retry.log），不宣称偶发问题已修复。启动开关成功与原生错误界面均已验证，截图只用于共用界面显示检查，不充当真实 Windows 登录验收。

## 原生剪贴板读写与记录图片预览（P4 部分）

- readClipboard、writeClipboard、previewClipboardImage 已通过主窗口专用命令接入共用剪贴板页面；不改公共返回字段与 recordId 读取语义。按记录 ID 从当前工作区解析文本或受控图片资产，忽略 caller 附带的替代内容，不接受任意图片路径；缺失/损坏资产、删除记录、junction 越界与错误调用窗口明确失败。
- Windows 实现直接调用 OpenClipboard/GetClipboardData/SetClipboardData，读写各自使用短生命周期的 message-only 所有者窗口，约 500 ms 内重试占用；全局内存和窗口/剪贴板句柄通过 RAII 回收。写入前完成参数、Base64、图片解码、PNG 重编码与全部输出内存准备，避免无效输入先清空现有内容；不启动 PowerShell/Node 辅助进程。
- 支持 Unicode 文本、注册的 PNG 格式及 Windows DIB/DIBV5 位图；图片输出同时提供 PNG 和含透明度掩码的 DIBV5。真实 GDI 位图测试发现 Windows 合成的 V5 缓冲区可能重复附带掩码，直接优先读 V5 会错行；现按原始枚举顺序优先选择源 DIB/Bitmap 或 V5，底向上和顶向下的像素方向均有测试，不通过修改期望像素规避问题。
- 读取/复制文本最多 5,000,000 个 UTF-16 单元，拒绝写入嵌入 NUL；PNG 字节上限 12 MiB，解码先检查尺寸乘积不超过 40,000,000 像素，并限制解码分配。DIB 校验头长度、尺寸、压缩、位深、掩码/调色板偏移及字节上限。复制带文本与图片时保持旧版“图片优先”的最终语义，但无效图片不会先写入文本；仅传空文本仍可清空文本。
- 列表按记录读取图片后生成最大 160×120 的缩略图，不放大小图；完整预览保留原图尺寸，返回 width/height 为原始像素。图片编解码离开存储队列并由单许可限制并发，预览不读取/写入系统剪贴板；失败返回明确 ok:false，保留共用界面重试与 Lucide 图标。读取资产阶段仍经过工作区队列，不宣称所有磁盘 I/O 都已脱离该队列。
- 新增 5 项 Rust 测试覆盖输入/ID/Base64、空值/未知字段、UTF-16 上限、无效混合写、PNG/DIBV5 透明像素往返、外部掩码的底向上位图、缩略图尺寸及有正确 CRC 的超大 PNG 头提前拒绝。原生套件 8 场景加父测试共 9 项，验证真实 Unicode 与 Electron IPC 返回契约、GDI-only 外部位图与 PNG/DIBV5 互通、逐像素/alpha、预览不变更剪贴板序列或工作区字节、受控资产、无效内容前置拒绝、占用/释放重试、共用预览/复制、角色与退出拒绝。
- 测试辅助进程在任何修改前保存系统剪贴板已有格式，最终 finally 恢复，产品退出后再恢复避免自触发测试记录；不清空用户工作区。测试输入管道改为 Base64 JSON 避免 PowerShell 控制台 UTF-8/转义错误。占用回归揭示 NULL HWND 读取可能绕过另一 NULL HWND 所有者的锁：改为专用非空 HWND 后真实占用拒绝与释放后重试通过；没有放宽断言或把失败当成功。
- 报告 artifacts/tauri-migration/clipboard-native.json，截图 clipboard-preview-shared-native.png，命令 npm run e2e:tauri:clipboard。真实截图确认完整预览、透明棋盘及 Lucide 复制按钮；实际 Electron 对比只证明文本读返回契约，不等同全部图片解码结果或系统剪贴板格式矩阵已完全一致。
- 三个 API 仍为 partial；WM_CLIPBOARDUPDATE 后台监听、历史去重/保留/入库与写盘失败重试、onClipboardChanged、全部小组件调用、后台无主窗口、恢复时监听协调仍未接通。延迟渲染第三方所有者造成 GetClipboardData 阻塞、完整遗留格式、PNG/DIB 多格式提交中途 OS 失败补偿及长期资源/Release 内存也未验证；OpenClipboard 的重试上限不等同上述系统调用均有硬截止期限。不能因此标记剪贴板监听或 P4 完成。
- 本轮 138 项 Rust、117 项 Node、4 项 Electron 无窗口测试通过；严格 clippy、fmt、类型检查、Electron/Tauri 前端及原生 Debug 构建、接口清单与 diff 检查通过。最终 Debug 的原生剪贴板 9 项、桌面 12 项、系统对话框 11 项、备份 10 项、工作区 13 项、共用主页面/退出 10 项和入口 1 项串行通过，无跳过；日志 rust-clipboard-final.log、check-silent-clipboard.log、clipboard-native.log、clipboard-regression-<套件>.log。Electron 默认入口、生产工作区、版本和分支均未切换，未提交、推送或发布。

## Windows 剪贴板通知与后台历史入库（P4 部分）

- 接通原生 AddClipboardFormatListener/WM_CLIPBOARDUPDATE：专用 message-only 窗口与独立 Win32 消息线程只发送合并唤醒，不执行图片解码、磁盘访问或前端操作。不创建 WebView，不以固定周期轮询代替系统更新通知；服务在已有工作区隐藏启动、主页面加载/初始化后启动，未初始化工作区不会读取系统剪贴板。
- 后台异步任务通过单许可复用原生读写服务，限制同时进行的采样/编解码。采样前检查持久化设置，提交前再次核验设置、Windows 序列号、退出状态及采样世代。快速通知合并为当前内容，仅保留一个未提交候选；新序列替换未保存的旧采样，不把旧内容迟到写回。此语义不承诺完整记录短暂存在的每一个中间剪贴板状态。
- 新记录使用旧字段和 SHA-256(text UTF-8 + imagePngBase64 UTF-8) 指纹，持久化历史内存在相同指纹即不重复插入。保留总量 200 的共享规则：固定和锁定项永不驱逐，受保护项占满时不发布未保留的新记录。图片先外置到受控 ClipboardImages，再通过现有原子工作区事务提交；广播和 onClipboardChanged 仅在成功保存后发出，图片事件只携带资产引用，不广播完整 Base64。
- 读取/采样上限保持文本 5,000,000 个 UTF-16 单元、PNG 12 MiB；后台图片采用旧采样器 16,000,000 像素上限，手动预览/复制的 40,000,000 像素上限保持独立。超大图在解码像素前拒绝；不能以手动预览能力放宽后台采样预算。
- 占用和暂时读取失败保留按需重试，真实占用七秒后释放且不再次复制也能入库；畸形/不可处理内容有限次重试后等待下一更新。保存失败不确认序列、不广播错误候选，最多保留一个当前候选并每秒重试，当前内容变化可替换；这是失败期间重试，不是正常状态的轮询。工作区禁用监听时不读取系统内容，重新启用仅采样当前内容。
- 备份恢复与退出握手使用可嵌套暂停和世代检查，防止恢复前/退出前的解码结果越界提交。成功恢复后忽略恢复时刻仍在系统剪贴板中的旧序列，直到新的真实更新才重新采集，避免旧内容立即污染恢复后的历史；失败恢复或取消退出恢复监听。正常退出停止通知窗口/线程；退出失败前已保存的历史保持不变。
- onClipboardChanged 接入真实 runtime 定向事件，回调收到已提交的小记录并可取消订阅；共用主页面仍依靠带 revision 的工作区广播更新，图片列表继续按需读取缩略图，沿用 Lucide。Rust 新增状态/指纹/像素上限和工作区事务测试，覆盖禁用、世代/嵌套暂停、重启去重、保留规则、元数据失败后的同候选重试及图片先落盘后发布。
- 新增 tests/tauri-clipboard-monitor.mjs：11 场景加父测试共 12 项，真实验证禁用/启用、Unicode 指纹、重复系统更新/自身复制、GDI 图片外置与小事件、超过七秒占用、实际 .bak 目录阻塞后的无通知重试、失败候选替换、与共享 TypeScript 保留函数逐 ID 对比、恢复不再导入旧剪贴板、退出否决/恢复、取消订阅以及无 WebView 隐藏重启/失败重试/持久化去重。报告 clipboard-monitor-native.json，截图 clipboard-monitor-shared-native.png；截图已检查自动更新的文字、图片缩略图及 Lucide 按钮。
- 测试必须显式设置 DUSTDESK_TAURI_ENABLE_TEST_CLIPBOARD 且使用隔离测试目录才启用后台监听；其他原生套件默认不监听真实用户剪贴板，避免把生产内容误采入测试数据。没有测试目录的预览正常按工作区设置运行，不依赖该测试开关。自动化在开始前保存原剪贴板格式，所有应用进程结束后恢复；只读测试日志不得记录用户内容。隐藏进程树实测仅程序与 Debug conhost，无 WebView2/PowerShell/Node 子进程。
- 四个剪贴板 API 仍为 partial。全部小组件、睡眠/恢复、第三方延迟渲染导致的系统调用阻塞、跨 Electron/Rust PNG 编码器的历史图片去重、完整格式/剪贴板管理器矩阵、长期资源及完整 Release 内存、生产迁移仍待验证。正常退出会使未提交采样失效，尚未建立持久化未保存候选的关机/退出恢复协议；因此不能据本轮握手隔离证明所有后台待保存数据都已纳入完整退出门槛。
- 本轮新增 7 项 Rust 测试，最终 145 项 Rust 以 --test-threads=1 全量通过；严格 clippy、fmt、类型检查、Electron/Tauri 前端和原生 Debug 构建、接口清单通过。117 项 Node、4 项 Electron 无窗口测试完整重跑通过（check-silent-clipboard-monitor-retry.log）；首轮既有便签颜色保存断言超时，保留 check-silent-clipboard-monitor.log，未修改相关产品/断言。默认并行 Rust 与其独立单项回归中既有 old_electron_identity_records... 再次出现 NotFound，日志 rust-clipboard-monitor.log 保留，串行通过不能证明该偶发问题已解决。
- 最终原生后台监听 12 项、剪贴板读写 9 项、备份 10 项、资源 12 项、桌面 12 项、系统对话框 11 项、工作区 13 项、共用主页面/退出 10 项、入口 1 项和隐藏专注服务 1 项串行通过，无跳过。退出测试最初在页面关闭与 child exit 回调之间产生 IPC 关闭错误，现等待真实 exitCode=0 且仅接受页面关闭错误，不屏蔽其他退出失败；原始记录 clipboard-monitor-exit-race.log 保留。占用夹具先关闭监听再锁定并重新启用，避免夹具与读线程抢锁掩盖真实占用；超过七秒持锁和无新通知恢复断言保留。
- 此为 P4 部分实现，未切换 Electron 默认入口、生产目录或版本；接口清单仍仅有 7 个隔离验证完成成员，不把新增 partial 实现列为生产完成。未提交、推送或发布，继续按完整计划推进。

## 旧版文件身份 JSON 精度修复（P3/P4 部分）

- 针对前述旧版收纳身份匹配偶发 NotFound，新增确定性复现：serde_json 默认浮点解析会将 1794268800000.0015 读为 1794268800000.0017，相差一个 f64 位，导致原本同一文件的 birthtimeMs 严格比较失败。修复前 identity-json-red.log 保留实际十进制和 to_bits 差异，identity-file-red.log 保留真实 Windows FILETIME 经工作区保存/重载后的失败；不能用串行重跑通过替代此精度验证。
- 为 serde_json 启用 float_roundtrip，保持 Node 已存储的有限 f64 在 JSON 读取、保存、备份及恢复间精确往返；不改变恢复身份字段或放宽匹配规则，不增加 epsilon/时间容差，不跳过 inode 校验。此修复不修复 Node 自身对超大整数的既有精度限制，也不代表全部文件系统身份行为已经验证。
- Rust 新增 10,000 个分数时间戳的逐位往返测试，以及固定创建 FILETIME 的真实文件保存、重载和旧格式重收纳测试。文件夹具在首次收纳前设置创建时间，避免移动后修改时间与 NTFS 文件名隧道缓存相互作用；不能据此宣称 NTFS 隧道行为已解决。原有身份回归断言未放宽，默认并行全量 147 项 Rust 通过，原偶发单项额外独立运行 20 次全部通过；日志 rust-identity-full.log、identity-repeated.log、identity-green.log。严格 clippy 和 fmt 检查通过。
- 新增 tests/tauri-identity.mjs，4 场景加父测试共 5 项。由真实 Electron 主进程实现生成 48 个实际文件的旧格式 ino/birthtimeMs，使用固定的分数创建时间，交给原生启动重收纳；逐文件验证正文和原路径消失，3 次实际进程重启、重复保存、备份字节及显式恢复后未知数值样本均与 Node 原值精确相等。不同 inode 和相差 0.001 ms 的创建时间仍拒绝收纳，文件留在桌面。负向 inode 夹具使用明确可表示的不同数值并自行断言不相等，避免超大 Node Number 加一后实际未改变；首轮夹具失败日志 identity-native-first-fixture.log 保留。
- 报告为 artifacts/tauri-migration/identity-native.json，日志 identity-native.log；所有文件只在隔离临时目录创建，不访问生产桌面、剪贴板或工作区。最终 Debug 原生退出收纳 8 项、智能整理 7 项、手动收纳 6 项、真实双卷补偿 7 项、工作区 13 项、备份 10 项和剪贴板通知后台入库 12 项顺序通过，无跳过；日志 identity-regression-<套件>.log。
- npm run check:silent 完整复跑通过：117 项 Node、4 项 Electron 无窗口测试、类型检查及 Electron 构建；Tauri 前端和 Debug 原生构建、接口清单及 diff 检查也通过。首轮既有便签颜色保存断言超时，check-silent-identity.log 保留，未修改其代码或断言；check-silent-identity-retry.log 记录独立完整复跑通过，不能据此宣称该既有时序问题已修复。
- 本修复只关闭已复现的 JSON 精度缺陷，不据此标记 P3/P4、生产身份接管或完整迁移完成。剪贴板退出前未保存候选、全部组件/草稿、两台物理电脑互传、完整 Release 性能、安装与绿色 ZIP、回退门槛仍未完成；继续保留 Electron 默认入口和隔离预览，未提交、推送、发布或修改版本。

## 剪贴板已接收候选的正常退出收尾（P3/P4 部分）

- 修复前述退出缺口：原先后台循环内的未保存候选会在退出暂停后被清空，即使正常退出成功也可能遗漏退出前已经接收的内容。新增真实原生红测，先阻塞 workspace.json.bak 使历史保存失败，在退出握手期间改变系统剪贴板并解除磁盘阻塞；旧程序以 exitCode=0 退出但缺少原候选。clipboard-shutdown-red.log 保留该确定性失败，不以退出成功代替内容持久化验证。
- 未提交候选改为共享控制状态下的单个有界对象。接收、退出冻结及恢复在同一互斥保护下交接，保留原 Id、CreatedAt、指纹和图片内容；退出仅冻结边界时当前序列、当前世代且已接收的候选。边界前已被新序列替代的旧内容不复活；边界后不再开始新采样，不额外读取系统剪贴板来冒充原候选。普通备份暂停仍使旧采样失效，显式禁用或并发恢复也使退出冻结的旧候选失效。
- 退出在主页面保存确认后、进入拒绝新保存的 Committing 阶段前，等待监听启动/后台处理周期完成，再用现有工作区串行事务保存冻结候选。保留三方合并、历史去重/200 条保留、未知字段及图片先外置后元数据规则；主页面退出草稿不会被候选提交覆盖。成功保存后才广播工作区和小记录事件，随后继续收纳确认、专注收尾及退出。
- 候选保存失败会取消退出并恢复编辑，未保存对象归还后台重试，Id 和 CreatedAt 不重建；系统剪贴板此时被占用也不必重新读取才能完成保存。如果监听设置、恢复世代或当前序列已改变，则按原有失效/替代规则处理，不把旧样本写进恢复后的历史。
- 后台周期使用异步互斥门闩覆盖监听创建、采样/解码及入库；尚未开始的监听创建在暂停期间等待恢复信号，停止后不再创建新线程/窗口，避免退出排空后又开始初始化。退出最多等待 10 秒，未完成则取消退出，不丢弃、分叉或重新启动仍在运行的底层任务。真实 Win32 延迟渲染夹具让 GetClipboardData 读线程保持阻塞，本轮实测约 10 秒取消退出且 UI 恢复；所有者随后正常释放，原处理周期返回后重新采样并只保留一条成功记录。此处的截止期限仅限退出等待，不能解释为 Windows 系统调用已被强制中断。
- Rust 新增 5 项测试，覆盖冻结/归还、边界前替代、普通恢复暂停、设置/嵌套暂停/停止失效，以及接收与退出、接收与设置切换两组各 64 轮真实线程竞争。配置世代更新和候选清空也纳入同一互斥，避免清除刚在新世代接收的有效对象；默认并行全量 152 项通过。严格 clippy、fmt、Tauri 前端和原生 Debug 构建通过，日志 rust-clipboard-shutdown.log、clippy-clipboard-shutdown.log、build-clipboard-shutdown.log。
- 剪贴板控制状态、指纹及尺寸限制的 8 项 Rust 子集独立复跑 20 次全部通过，记录 clipboard-shutdown-races-repeated.log；此为控制状态竞争回归，不用于宣称全部 Windows 窗口或剪贴板管理器行为已经验证。
- 新增 tests/tauri-clipboard-shutdown.mjs，7 场景加父测试共 8 项：退出前原候选与页面草稿同时持久化；实际写盘失败否决并在剪贴板占用期间保存原候选；并发原生恢复不再导入冻结旧数据；显式禁用持久生效；真实图片落盘后重启预览；真实延迟渲染导致的等待超时/恢复；空队列正常退出及重启无重复。报告 clipboard-shutdown-native.json，日志 clipboard-shutdown-native.log。夹具只使用隔离工作区，并在测试和失败清理后恢复原系统剪贴板；PowerShell/C# 仅用于测试，产品不增加辅助进程依赖。
- 最终 Debug 重新构建后，退出收尾 8 项、后台监听 12 项、剪贴板读写 9 项、备份恢复 10 项、共用主页面/退出 10 项、工作区 13 项、收纳退出会话 8 项、隐藏专注服务 1 项和入口 1 项共 72 项原生回归顺序通过，无跳过；日志 clipboard-shutdown-native.log、clipboard-shutdown-regression-<套件>.log。npm run check:silent 一次完整通过：117 项 Node、4 项 Electron 无窗口测试、类型检查及 Electron 构建，记录 check-silent-clipboard-shutdown.log；接口清单仍为 7 项隔离验证、productionReady=false，diff 检查通过。
- 本轮补齐的是已接收候选的正常退出保存和失败否决，不是独立的候选落盘日志；尚未接收的在途结果按世代取消，强制杀进程或掉电前未提交的内存候选仍可能丢失。全部组件、Windows 注销/系统关机、第三方延迟渲染与格式矩阵、长期资源、生产接管、两机互传及完整 Release 性能/发布/回退仍需按主计划验证，不标记 P3/P4 或迁移完成。默认入口、生产目录及版本未切换，未提交、推送或发布。

## 原生组件窗口、布局预设与全窗口退出（P3/P4 部分）

- 新增 Rust 原生组件服务和独立 widget.html 入口，沿用现有 React WidgetHost、任务/便签组件、样式及 Lucide，不重做交互。组件按持久化 Visible=true 且业务对象仍存在时创建；空布局不预建全部 WebView，启动只恢复配置可见的窗口。隐藏后暂保留原 WebView 和私有草稿，不宣称已实现干净窗口回收或所有后台内存目标。
- 接通 toggleWidgets、getWidgetVisibility、hideWidget、setWidgetVisibility、setWidgetOptions、moveWidget、resizeWidget、四个布局预设接口及可见性/外观事件，共 13 个成员列为 partial。支持锁定、置顶、透明背景、自动折叠、折叠/展开高度、吸附边缘；恢复位置保留标题可达范围。预设保存/应用/删除使用原字段，按中文排序，不引用可变的当前布局对象。
- 可见性、选项和最终拖动/缩放提交先经过工作区原子事务，再更改窗口；真实 .bak 目录拒写时，已保存布局和窗口状态保持不变。指针预览只更新窗口与内存，不逐帧读写工作区或广播工作区；最终提交、原生移动/尺寸事件的去抖保存以及退出收尾持久化几何数据，保留未知布局字段和展开高度。布局应用带 revision 门槛，拒绝迟到旧布局覆盖新窗口状态。
- 安全边界使用 Rust 注册表中的真实随机窗口标签，不信任 URL 查询或前端传入的组件 key。组件仅能控制自身窗口，不能调用布局预设、完整工作区保存/初始化、备份或退出主控命令。任务组件读取裁剪后的任务快照并仅允许新增/完成任务；便签组件限定目标便签，保留私有草稿和冲突保护，仅允许对应编辑/另存新便签。其他组件业务能力仍需逐项授权接通，不能因窗口可打开就算全业务迁移。
- 初次真实多窗口测试发现 WebviewWindow.emit 会把组件裁剪快照传播到主页面，导致主页面误认为便签消失；已改为 app.emit_to 按真实窗口标签定向发送快照和外观。新增主窗每次快照都保留原便签 ID 的断言，确保不能将组件裁剪状态当完整工作区保存。失败证据 widgets-global-snapshot-red.log 保留。能力列表最初未在 tauri.conf.json 显式启用，导致组件被 ACL 正确拒绝；修正为单独 widgets capability，未扩大主窗口权限集，证据 widgets-capability-red.log 保留。
- 退出协议从单主窗响应扩展为所有已注册且仍存活的组件和主窗口共同确认；隐藏便签也必须保存/持久化草稿，任一失败或超时取消退出并向所有参与窗口发送恢复事件。请求 ID、真实调用标签及一次性待确认集合共同约束响应，重复、外来和旧响应不允许结束当前退出；主窗确认不再替代组件确认。冻结参与窗口前取得组件串行门闩，退出期间不创建新组件；退出成功前还保存尚未提交的拖动预览，再执行剪贴板和原有收纳/专注收尾。
- Rust 新增 6 项布局/预设/身份/裁剪/几何测试和 2 项全窗口退出确认测试，默认并行全量 160 项通过；负坐标恰为半像素时采用与 JavaScript Math.round 相同的向正无穷方向取整，不使用 Rust 对负半数远离零的 round，以保持旧版坐标兼容。严格 clippy、类型检查、fmt、Tauri 前端及 Debug 原生构建通过，日志 rust-widgets.log、clippy-widgets.log、typecheck-widgets.log、build-widgets.log。
- 新增 tests/tauri-widgets.mjs，9 场景加父测试共 10 项，验证真实 Electron IPC 已知布局字段/预设差分、无布局时零组件窗口、真实任务新增/完成、组件业务与跨窗权限、预览零写盘、锁定/吸附/折叠/置顶、实际磁盘故障、实际可见窗口的预设恢复、隐藏便签保存及组件否决、退出保存预览/正文和实际重启可见窗口。Electron 原规范化会移除样本中的未知布局字段，原生按计划保留，差分仅剥离这两个显式扩展字段并另行断言原生原值不丢失，日志 widgets-differential-unknown-red.log 保留。报告 widgets-native.json，截图 widgets-main-native.png、widgets-task-native.png；主页面和任务组件截图已目视检查。
- 原生 Win32 SetWindowPos 移动测试与持续的独立工作区保存并发，验证实际窗口事件的几何结果最终落盘，不被无关快照拉回旧位置；无关广播仅在布局几何字段确实改变时重设窗口，并重新安排未保存原生移动的去抖提交。测试窗口通过本套件实际 child PID 与已测矩形共同查找，不按猜测标题修改其他应用；早期标题夹具查找失败记录 widgets-native-move-fixture-red.log 保留。该自动化仅覆盖本机 100% 缩放，不能替代混合 DPI 验收。
- 最终 Debug 重新构建后，组件窗口 10 项、共用主页面/退出 10 项、工作区 13 项、备份恢复 10 项、剪贴板退出收尾 8 项、后台通知入库 12 项、收纳退出会话 8 项、隐藏专注服务 1 项和入口 1 项共 73 项真实原生回归串行通过，无跳过；日志 widgets-native.log、widgets-regression-<套件>.log。npm run check:silent 完整通过：118 项 Node、4 项 Electron 无窗口测试、类型检查及 Electron 构建，日志 check-silent-widgets.log。首轮契约测试仍断言旧的两个 capability，因此在新增 widgets 后失败；更新精确权限清单并新增更窄组件权限/partial 状态测试后完整重跑通过，不放宽通用文件系统、Shell 或窗口创建权限，首轮记录 check-silent-widgets-capability-contract-red.log 保留。
- 仍需完成其他组件业务调用、全部组件草稿迁移/恢复、干净隐藏窗口回收、真实原生关闭/崩溃与多窗故障矩阵、快捷键及托盘切换、混合 DPI/显示器拔插、全组件 Release 性能和生产数据接管。本轮不标记 P3/P4 或整体迁移完成，不切换默认 Electron 入口，不提交、推送、发布或修改版本。

## 组件系统业务与按窗口隔离搜索（P3/P4 部分）

- 在原生组件窗口基础上接通启动器、收纳/收纳组合、便签背景、剪贴板、搜索和监控的系统业务，继续复用原 React 组件与 Lucide。权限由 Rust 注册表中的真实窗口标签和组件角色决定，不因 widget capability 包含某个命令就开放主窗能力；原生选择器、完整工作区保存、备份、开机启动、裸剪贴板读取及应用退出仍不授予组件。
- 启动器仅能打开及读取当前启动项的精确路径；收纳组件仅能操作当前分类 ItemPaths，组合仅限其分类 ID。主窗项目引用、选择器授权、桌面授权和父目录不自动下放。链接组件只允许其当前已保存的精确 HTTP/HTTPS URL；移除业务引用后重新调用立即拒绝，不因已有 Shell 图标缓存继续授权。文件菜单在实际执行前复核调用方及资源，异步错误仅定向发送到请求窗口。
- 便签背景读取限定当前关联路径，单便签不能读取另一便签的背景；通用便签可以切换读取当前便签。剪贴板组件仅能按已保存 recordId 复制文本或图片，不接受任意文本、图片字节或 recordId 与伪造正文混合输入，也不能直接读取系统剪贴板。图片预览仍使用原记录及受控附件读取；小记录通知仅发往主窗与实际注册的剪贴板组件，不广播完整 Base64 或向其他组件泄漏历史。
- 搜索从单个全局会话改为按真实窗口分隔取消、结果授权和缓存；主窗与搜索组件即使使用相同 requestId 也不互相取消、不继承结果访问权限。所有会话共用单个扫描信号量及原有文件工作预算，避免每窗口新增并发扫描器。窗口销毁释放对应会话；恢复/退出释放全部会话，成功备份恢复后隐藏组件的旧结果同样失效。
- Rust 新增精确业务引用及搜索所有者隔离两项测试，全量 162 项通过；严格 clippy 与 fmt 通过，日志 rust-widget-business.log、clippy-widget-business.log。Tauri 前端和 Debug 原生构建通过，记录 build-widget-business.log。
- 新增 tests/tauri-widget-business.mjs 和 npm run e2e:tauri:widgets:business，8 场景加父测试共 9 项原生测试通过，无跳过。覆盖共享启动器/收纳按钮实际 Shell 启动标记、原生菜单复制精确 Unicode 路径、真实剪贴板占用错误仅出现在请求组件、便签位图渲染及跨便签拒绝、剪贴板缩略图/文本与图片复制/越权拒绝、定向后台通知、相同请求 ID 的搜索隔离与真实结果打开及高度恢复、监控采样、项目/链接/倒计时裁剪展示和恢复后的搜索撤权。报告 widget-business-native.json，日志 widget-business-native.log。
- 原生故障测试发现 widget.html 入口没有 Toaster，导致原生菜单的剪贴板占用错误虽已到达组件但不显示；补齐与主页面一致的错误提示容器后测试通过，保留 widget-business-toast-red.log。测试夹具中的旧 1×1 PNG 有 IDAT CRC 错误，原生正确拒绝；改用浏览器生成的有效 PNG，不放宽产品解码校验，记录 widget-business-test-invalid-png-red.log。其余测试接口名、菜单夹具恢复语义、图片定位与异步复制时序错误均保留独立 test-*-red.log，不计作产品修复。
- 便签、剪贴板、搜索和监控截图为 widget-business-note.png、widget-business-clipboard.png、widget-business-search.png、widget-business-monitor.png，均已目视检查。测试使用独立工作区、测试 EXE、模拟搜索根和受保护的系统剪贴板备份；结束先关闭原生程序再恢复原剪贴板，不读取或改写生产工作区。
- 最终 Debug 构建下，新组件业务 9 项，以及搜索 8、图标 7、系统 11、桌面菜单 12、便签背景 12、剪贴板 9、后台监听 12、监控 10、组件窗口 10、主页面/退出 10、备份 10、剪贴板退出 8、工作区 13、收纳退出会话 8、隐藏专注服务 1、入口 1，共 151 项真实原生测试串行通过，无失败或跳过；回归日志 widget-business-regression-<套件>.log。原生套件全部退出后再运行 npm run check:silent，118 项 Node、4 项 Electron 无窗口测试、类型检查及 Electron 构建全部通过，记录 check-silent-widget-business.log。接口清单重新生成，仍仅 7 项 isolated-verified、productionReady=false，diff 检查通过。
- 尚需正向实际浏览器链接打开、所有组件草稿迁移及重启/关闭/崩溃矩阵、干净隐藏窗口回收、Lucide 装饰 SVG 的完整辅助技术审计、混合 DPI/IME/睡眠/外部拖放、全产品 Release 性能、生产数据及身份接管、两台物理电脑互传和真实发布/回退验收。本节不将窗口展示等同于全部业务完成，相关接口继续标记 partial，不切默认入口，不提交、推送、发布或修改版本。

## 隐藏组件的保守回收与最后窗口驻留（P3/P4 部分）

- 新增 Rust window_release 服务：组件隐藏 30 秒后发起回收检查，3 秒未确认则保留；不同隐藏周期使用不同 token，每轮检查使用新 requestId，回复绑定真实调用窗口且只能消费一次。显示或销毁会取消本周期、立即唤醒旧计时器；迟到确认不能销毁重新显示或新建的同 key 窗口。组件仅获得 window_release_ready 确认命令，不获得任意销毁窗口权限。
- 前端聚合所有释放检查，必须全部明确返回 true，且没有退出/恢复、在途受跟踪写入、组合输入或未就绪状态，才暂时冻结交互及新写入。Native 最终再取得与布局、可见性及退出参与者共用的组件门闩，复核真实注册身份、隐藏状态、退出阶段及原生文件菜单会话，再保存未提交几何预览并销毁 WebView。显示、超时、失败或取消会恢复对应请求的交互；位置保存失败保留原窗口并稍后重试，不以丢弃预览换取回收成功。
- 私有便签存在脏草稿、失败的 localStorage 写入、冲突、尚在执行的保存或初始读取错误时不回收；已切换便签的草稿也由窗口级草稿库检查，不因当前编辑器切换而漏检。通用便签选择写入失败同样保留，写入成功后按原选择重建。任务存在输入、操作或错误时保留；折叠只隐藏任务/便签与有选择状态的内容，不销毁编辑器，因此未提交任务标题不再因折叠丢失。只读监控等内容在折叠时仍卸载，避免为保留编辑器而让监控持续采样。
- 链接和收纳处于非默认分类时，保守保留窗口及当前选中状态；回到默认分类且无其他保护条件才回收。尚未增加这些分类选择的独立持久化检查点，不将所有无文本编辑的窗口都当作可丢弃状态。主窗口暂未接入自动回收；普通关闭仍隐藏，不将本节当作主窗内存目标已完成。
- 原生窗口销毁继续释放该窗口的搜索会话与资源检查。几何去抖提交额外比较原生 label，防止已销毁窗口的迟到计时器命中同 key 新窗口；窗口与布局快照继续使用 revision 保护，不为回收改数据模型或损失未知字段。
- 真实测试发现最后一个组件 WebView 销毁时，旧 RunEvent::ExitRequested 处理会把自动退出请求转成完整退出，child 以 0 结束，丢失托盘驻留。修复为无 WebView 的非程序化退出请求只阻止退出，不启动用户退出协议；显式退出仍经原收尾流程。确定性失败保留 widget-release-last-window-exit-red.log；不据此宣称 Windows 注销/系统关机矩阵已经通过。
- 回收测试的短间隔只在 Debug 且指定测试用户目录时启用，正式 Release 固定使用 30 秒；产品未增加测试命令、Node/PowerShell 常驻进程或测试 WebView 的调试端口。截图 widget-release-task-retained.png、widget-release-note-conflict.png 已目视检查。超时测试使用真实 4.3 秒 JS 停顿，不修改原生确认结果；Tauri invoke 不可写，最初试图拦截它的测试夹具无效，已改用真实停顿并保留 widget-release-test-immutable-ipc-red.log。另有警告文本定位和懒加载控件等待的 test-*-red.log，均不计作产品修复。
- 新增 3 项 Rust 回收 token/窗口/一次性响应测试和 1 项 Node 便签干净检查点/失败写入测试。最终 Rust 全量 165 项、严格 clippy、fmt、类型检查、Tauri 前端与 Debug 构建通过，日志 rust-window-release.log、clippy-window-release.log、typecheck-window-release.log、build-window-release.log。
- 新增 tests/tauri-widget-release.mjs，14 场景加父测试共 15 项通过，无跳过；报告 widget-release-native.json，日志 widget-release-native.log。覆盖隐藏后真实销毁/惰性重建、任务折叠及标题保留、便签冲突与跨选择脏草稿、localStorage 失败及重试、选择检查点恢复、非默认分类保留、组合状态门闩、真实 JS 停顿超时、旧确认/外来确认、原生菜单未完成、实际 .bak 写盘失败、退出与回收重叠、真实退出重启，以及 --hidden 仅组件启动时最后 WebView 回收。最后场景在所有 WebView 已关闭后用实际 Windows 剪贴板写入唯一测试文本，从磁盘确认原生后台入库，再启动第二个真实进程通过单实例协议重新打开完整主页面并正常退出；系统剪贴板在所有原生程序结束后恢复，不把调试进程数作为 Release 性能证明。
- 最终同一 Debug 程序下，回收 15 项与组件业务、窗口、搜索、图标、系统、桌面菜单、便签背景、剪贴板、监听、监控、主页面/退出、备份、退出收尾、工作区、收纳会话、后台专注、入口共 151 项原生回归串行通过，总计 166 项，无失败或跳过；回归日志 window-release-regression-<套件>.log。额外的原生窗口原型与无工作区纯托盘进程检查通过，仍不满足完整 Release 性能门槛。原生套件结束后 npm run check:silent 一次完整通过，119 项 Node、4 项 Electron 无窗口测试、类型检查及 Electron 构建通过，记录 check-silent-window-release.log；接口清单重新生成，仍 7 项 isolated-verified、productionReady=false。
- 后续安全门槛：审阅当前 Tauri 2.12.5 的 Manager.emit_to 和事件监听器 match_any_or_filter 实现后，发现 emit_to 按订阅 target 过滤，而 Any 订阅可匹配定向事件。当前组件具有 core:event:allow-listen，常规按自身 target 的测试不能证明恶意选择 Any 或其他窗口 target 时仍隔离。下一步需加入原生越角色订阅测试，并改用绑定真实窗口的受控事件传输或等价原生限制；未证明该边界前，不把现有定向快照和命令角色检查当作完整敌手事件隔离证明，不允许切换生产。
- 本轮的回收只允许丢弃已确认干净的组件，不自动保存脏便签来制造干净状态，也不把未提交任务输入自动转换成任务。任务输入仍未获得退出/崩溃后的独立持久化或旧 Electron 草稿迁移；主窗回收、非默认分类选择检查点、完整崩溃/强制关闭矩阵、实际 IME/混合 DPI/睡眠/拖放、完整 Release 进程树性能、生产数据/身份接管、两机互传、安装和回退仍待完成。接口继续 partial、productionReady=false，不切换默认入口，不提交、推送、发布或修改版本。

## 小组件事件所有权修复（P2/P4 部分）

- 真实 WebView2 负向测试证明：仅由原生 app.emit_to 指定接收窗口并不能建立事件权限边界。旧组件拥有通用 event.listen 权限时，可将订阅目标改为 Any 或 workspace-main，收到包含主窗口私有便签的完整快照。确定性失败证据保留在 artifacts/tauri-migration/widget-events-red.log 与 widget-events-red.json；该结果不能解释成只是测试夹具问题。
- 移除组件的 core:event:allow-listen / allow-unlisten，仅保留精确业务命令。新增原生 events 服务，widget_events_attach 由真实调用 WebView 注入的 Channel 和原生组件注册表确定接收窗口、角色；渲染层传入的 label、role、target、window 不参与授权。主窗口及原型窗口不能调用组件 attach / detach，组件不能通用 listen、unlisten、emit 或 emit_to。
- 每个实际原生 label 只有一个连接；重新连接替换自身旧连接，detach 同时检查真实调用窗口和连接 token，旧 token 或外窗 token 不能撤销新连接；销毁窗口清理连接。中心发送入口再次裁剪 workspace:snapshot 并清空工作区路径，只对白名单事件开放组件通道；剪贴板记录限剪贴板角色，可见性事件限自身组件 key，未知事件拒绝。
- 组件前端改用实际 Tauri SDK Channel，本地分发、即时取消订阅、单消费者异常隔离、幂等连接；dispose 后不再投递，attach 尚未完成时由迟到结果撤销自身 token。SDK 按序及结束帧仍由公开 Channel API 管理，不修改不可写的 invoke、不绕过 native capability，也不调用 SDK 私有清理方法。主窗口仍使用原有自身目标的通用事件。
- 新增 4 项 Rust 测试和 5 项实际 SDK 的 Node 传输测试；真实 tests/tauri-widget-events.mjs 为 6 场景加父测试共 7 项，覆盖 Any/外窗/自身通用订阅拒绝、事件发送拒绝、真实角色、共享 UI 更新、取消订阅、连接替换、跨窗撤销、页面重载与销毁重建。大快照实际 56991 字节，保留 Unicode、字段与列表顺序；便签渲染器真实停顿期间由任务组件发起 64 次底层 channel fetch 探测，未取到私有便签，便签自身仍收到完整正文。报告 widget-events-native.json；不据此声称所有工具箱/截图/LAN 的新通道都已实现。

## 桌面任务输入草稿（P3/P4 部分）

- 共享 TaskWidget 新增 taskDrafts 存储，使用 widget-task-draft:v1:todo 独立键保存标题和稳定 requestId，每次输入同步提交 localStorage；未提交内容不写成正式任务。组件挂载时先核对正式任务和回收站，再允许编辑，保留已有请求 ID 以便失败重试。任务创建成功后换新 ID、清空输入；若清理失败，旧草稿在重新读取时通过正式记录核对，避免重复提交。
- 存储读取或格式无效时不静默覆盖原值；输入持久化失败保留内存内容，显示中文重试入口，并否决隐藏回收与确认退出，恢复存储后可重试。退出参与者调用待写入草稿 flush；折叠继续保持原编辑器，已有保守回收条件不放宽为“所有草稿都可丢弃”。
- 新增 5 项 Node 草稿测试和 tests/tauri-task-drafts.mjs 的 5 场景加父测试共 6 项真实测试：正常原生进程退出并重启恢复标题及 requestId、Storage 实际异常导致回收/退出否决与恢复、成功创建后的清理失败/页面重载不重复、工作区真实磁盘失败的原 ID 重试、无效持久化内容不被覆盖。报告 task-drafts-native.json；截图 task-drafts-restored.png 已目视检查。
- 这里证明的是隔离预览与共享组件的 localStorage 正常退出/重启恢复，不是 OS 崩溃/断电 fsync 保证，也未完成 Electron 浏览器草稿的白名单导出、双向导入或生产接管。迁移计划导出范围已补充桌面任务输入；全部草稿迁移、主窗自动回收、两机互传、完整 Release 性能、安装和回退门槛仍未满足。

## 本轮验证汇总：事件所有权与任务草稿

- Rust 全量 169 项、cargo clippy --all-targets -- -D warnings、cargo fmt --check、TypeScript 与最终 Tauri Debug 构建通过。日志 rust-widget-events.log、clippy-widget-events.log、build-task-drafts.log。SDK 私有 cleanupCallback 曾被 TypeScript 检查拒绝，已改为公开 onmessage 及正常原生结束帧流程；后续完整类型检查与构建通过，不绕过私有类型限制。
- 最终构建顺序执行事件、回收、业务组件、组件布局、搜索、图标、系统、桌面、便签图片、剪贴板、原生剪贴板监控、指标、主页面、备份、剪贴板退出、工作区、收纳会话、无窗口生产力及直接入口回归，加本轮任务草稿共 179 项原生自动化测试通过；另执行原型窗口与纯托盘进程检查。日志 widget-events-final-*.log、task-drafts-native.log；这些是 Debug/隔离范围，不是完整业务 Release 或物理环境验收。
- npm run check:silent 全链通过：129 项 Node 单测、Electron 构建、4 项实际 preload/main IPC 的无窗口页面与 Worker 回归。日志 check-silent-widget-events-drafts.log。migration:inventory 仍为 82 项 DustDeskApi 与 16 项 ToolboxApi，只有原有 7 项 isolated-verified，productionReady=false；不因本轮修复扩大完成声明。
- 最终格式与 git diff --check 通过，无遗留测试 Tauri 进程。继续保留 codex/tauri-migration 分支及原有所有未提交改动，不切默认入口、不移除 Electron、不改版本、不提交、推送或发布。下一阶段仍需实现主窗口安全回收与旧浏览器草稿迁移，并推进截图、工具箱、LAN 等未完成模块及完整发布门槛。

## 主窗口保守回收与同进程布局（P3/P4 部分）

- 先以真实 tests/tauri-main-release.mjs 证明旧主窗口只隐藏、不销毁，12 秒等待实际 WebView 关闭失败；证据 main-release-red.log。新增 main_window 服务，把共用适配器、原生 WM_CLOSE、工作区快捷键切换、托盘打开/恢复、单实例激活与直接启动统一到主窗显示/隐藏入口，和组件布局、回收、退出参与者共用异步门闩；退出中不创建新的主窗。
- 复用隐藏 30 秒、每轮随机 nonce、3 秒确认超时的原生回收服务；主窗必须由真实窗口回复 window_release_ready，且所有前端释放检查同意。useWorkspace 新增独立否决：完整读取失败、延迟/失败的待保存队列、在途保存都不能回收，避免通知消失后误把失败输入当干净状态。App 仍仅允许未访问工具、无全局搜索/未提交概览输入/弹层或通知的概览；其他页面与已访问工具保留挂载内容。已保存的快速记录 textarea 不因有非空文本而永久阻止回收。
- 原生最终复核真实 WebView 实例、隐藏状态、退出阶段、原生菜单、选择器、Shell 打开、桌面枚举和资源扫描状态；不能只凭固定 label 或 SDK 的相等判断（其相等只比较 label）。实际实例检查使用公开资源表的稳定地址；主窗开始销毁后等待 Destroyed 清理完成，才允许同 label 的新主窗创建，避免旧清理撤销新实例的授权和会话。任何超时/否决均保留或恢复交互，不把关闭误当应用退出。
- 同进程内保留主窗正常矩形与最大化状态；最小化激活恢复窗口。真实测试发现只保存当前逻辑矩形会把最大化尺寸当正常尺寸，证据 main-release-maximized-restore-red.log 和 main-release-maximized-logical-red.log。Windows 现使用 GetWindowPlacement / SetWindowPlacement 保存和恢复原生正常矩形，先隐藏创建再恢复布局及显示，激活非最小化窗口不再无条件 unminimize。这里不承诺跨进程布局持久化或混合 DPI/拔插显示器验收。
- tests/tauri-main-release.mjs 已实际验证 14 场景加父测试共 15 项：干净回收与新窗口、已保存快速记录、最大化/正常矩形、概览输入/全局查询/便签页、访问工具后回概览保留草稿、真实工作区磁盘失败、组合状态与 4.3 秒 JS 停顿、活跃跨窗文件菜单、实际 STA 选择器、实际未完成 HTTP 资源扫描、原生 WM_CLOSE/最小化、8 轮显示隐藏竞争、退出参与者竞争与取消、最后主 WebView 销毁后剪贴板仍后台落盘且真实单实例激活重建主页面。截图 main-release-tool-retained.png 已目视检查；合成组合事件不充当真实中文 IME 验收。
- 菜单夹具额外要求实际窗口焦点和鼠标位置；隐藏菜单自身的 owner 会由 Windows 结束该菜单，不应继续断言其仍活跃。最终测试用仍可见组件的真实原生菜单来验证主窗回收否决，保留 main-release-menu-focus-red.log 和 main-release-menu-owner-hide-fixture-red.log，未为夹具放宽产品保护或制造假菜单。
- 这仍是干净概览的保守回收，不把编辑页面/工具草稿丢弃以追求低内存。旧 Electron 浏览器草稿白名单双向迁移、全部页面检查点、完整工具箱/截图/LAN、五轮 Release 性能、物理两机和真实安装/回退门槛继续待完成；接口继续 partial、productionReady=false，Electron 保持默认。
- 最终 Rust 169 项、严格 clippy、fmt、类型检查及 Debug 构建通过，日志 rust-main-release.log、clippy-main-release.log、build-main-release.log。最终构建顺序执行主窗、事件、任务草稿、组件回收/业务/布局、搜索/资源、系统/图标/桌面/便签图片、剪贴板/监控/退出、指标、主页面/备份/工作区、收纳/智能/会话、生产力/后台/入口共 25 套 226 项原生自动化测试全部通过，另执行原型窗口和纯托盘进程检查，日志 main-release-final-*.log。原生套件未和 Electron 无窗口界面测试并行。
- npm run check:silent 全链通过：129 项 Node 单测、Electron 构建与 4 项无窗口真实 preload/main IPC、共用截图编辑器及 Worker 回归；日志 check-silent-main-release.log。最终最大化回归同时覆盖重复激活及最大化后最小化再激活，未把前一次部分通过当最终结果。inventory 仍仅 7 项 isolated-verified、productionReady=false；最终无遗留测试 Tauri 进程，未改版本、默认入口或提交/推送/发布。

## 浏览器草稿包与可恢复导入内核（P2/P3 部分）

- 新增 src/shared/draftMigration.ts，定义版本 1 草稿包：固定外层格式、原始 JSON payload 的 SHA-256、导出 ID、UTC 时间、运行时/应用版本及工作区 fingerprint。只枚举便签 legacy/v2 私有草稿与干净检查点、桌面任务输入、快速记录和选中便签；不导出任意存储、Cookie、令牌、缓存、原生身份或导入历史。未知键版本、角色/ID 不匹配、错误编码、摘要、重复键与形状无效均拒绝，不以静默忽略作为成功。
- 导入只写不存在且无 alias 冲突的键；现有空草稿和 saved=true 也保留。旧 legacy 与对应窗口私有键做冲突保护，不把新版本优先级错误地用于覆盖目标旧草稿；notes 和 note:<id> 各自独立。完成回执记录导出 ID/摘要，同包再次导入不复活已清理内容、也不覆盖后来编辑，同编号不同内容拒绝。
- 先写完整待导入日志，再逐键写入，最后提交回执并清日志。回执前任何失败回滚仍精确等于本次导入值的键，后来改变的内容保留；回滚失败保留日志并提示禁止切换。回执后清理失败只重试清日志，不撤销成功导入。目标异常草稿、日志和历史回执不被覆盖。入口尚未开放，原生排他协议接入前不能直接让多个存活编辑器调用该内核。
- 标题/正文采用现有 UTF-16 长度语义；包 64 MiB、5000 项、4096 个回执的上限明确失败，不截断/不遗忘旧回执。导出累计长度在组装完整字符串之前校验，枚举/读取期间发生变化会拒绝。限额不是完整历史兼容或断电保证，真实旧数据超限须先扩展有界分包；fingerprint 必须来自原生已确认快照，摘要不是身份签名。
- 产品 TaskDraftStore 和 NoteDraftStore 使用同一份共享键定义，键名及保存语义不变；未增加测试专用产品接口、远程脚本或绕过 IPC 权限。详细集成前提和未完成内容见 docs/DRAFT_MIGRATION_FORMAT.md。
- 新增 13 项 Node 内核测试，覆盖白名单、双向 Unicode/原始字节、每个写入失败点、alias、防重复、回滚失败和回执前后中断、坏包/坏目标、容量/UTF-16 及导出期间变化。tests/tauri-draft-format.mjs 另以真实 Electron preload/main IPC 的共用便签/任务/快速记录输入作为来源，在实际 WebView2 中故障回滚后导入，原生便签/任务恢复未提交输入，再反向导入新的 Electron 无窗口页面，4 场景加父测试共 5 项通过；报告 draft-format-native.json，截图 draft-format-native-note.png。
- 这不是完整旧用户迁移交付：测试自行暂停参与页面，尚未接入生产全窗口检查点与排他维护、原 origin 受控隐藏读取、用户文件交互、持久化谱系/切换阻断、启动恢复协调；Tauri 快速记录窗口仍未实现，只验证其草稿原值往返。未读写生产数据或解析 LevelDB，不把测试中的临时模块加载当作产品迁移入口。
- 最终 npm run check:silent 通过：142 项 Node 单测、Electron 构建与 4 项真实 preload/main IPC 共用界面/Worker 回归；日志 check-silent-draft-format.log。Tauri Debug 构建通过，随后顺序执行格式、任务草稿、组件回收/事件/业务/布局、主窗回收、主页面、工作区、便签图片共 10 套 102 项原生自动化测试，全部通过，日志 draft-format-final-*.log。draft-format-native-note.png 已目视检查；没有将格式测试的页面暂停冒充原生维护协议验证。
- 接口清单仍为 82 项 DustDeskApi 与 16 项 ToolboxApi、7 项 isolated-verified、productionReady=false。本轮未新增公共 IPC 权限或更换存储键，格式与 diff 检查通过，无残留测试 Tauri 进程；继续保留 Electron 默认入口与全部既有未提交文件，不提交、推送、发布或改版本。

## Tauri 草稿维护检查点（P2/P3 部分）

- 新增 src-tauri/src/draft_maintenance.rs，使用主窗/组件共用原生门闩登记真实参与窗口，通过独立 drafts:flush/drafts_checkpoint_ready/drafts:resume 协议完成保存、交互冻结与恢复。复用共用页面的现有 onBeforeQuit 回调，但确认用途与退出请求严格隔离；真实当前主窗才可准备和结束，组件只能确认自己参与的请求，原型无相应权限。不以维护 Ready 状态授权退出。
- 准备阶段允许保存回调及其在途工作落盘；全部应答后先提交组件布局并排空已接受的剪贴板候选，再于实际工作区存储队列互斥锁内读取文件、计算 SHA-256 并封存。Ready 阶段包括原型在内的排队工作区操作全部拒绝，后台业务维护不再将预期拒绝刷成错误日志；新的窗口交互、主窗隐藏和退出同样拒绝。
- 失败保存即使是最后一个 pending 应答也不能封存；随机请求、窗口、用途和单次确认共同约束状态机。默认 120 秒有界租约，到期、参与页面重载/窗口销毁、保存异常或准备超时均恢复编辑和剪贴板；旧结束令牌及旧租约定时器不能释放新维护会话。前端 flush generation 阻止取消后迟到的异步回调解冻另一会话。
- 合成 composition 进行中直接否决准备，不把未结束的组合输入当已完成检查点；这仍不是物理中文输入法验证。实际挂起的保存回调验证原生 15 秒超时及下一次维护隔离，不把它描述成整个 JS 引擎冻结测试。Debug 且存在隔离测试根时才允许缩短 Ready 租约，正式时限不受测试参数影响。
- 新增 3 项 Rust 状态机测试；全部 172 项 Rust 测试通过，Debug/Release cargo check、cargo fmt、严格 clippy 及 TypeScript 检查通过。新增 tests/tauri-draft-maintenance.mjs 的 12 个真实原生场景加父测试共 13 项通过，报告 draft-maintenance-native.json、日志 draft-maintenance-native.log；通过 npm run e2e:tauri:drafts:maintenance 可重新构建并验证。
- 原生场景涵盖实际主窗、任务和通用/固定便签、冲突私有草稿、磁盘精确摘要、权限、准备期交互限制与 Ready 队列屏障、Storage 写入异常、真实 workspace.json.bak 目录阻塞、迟到回调、准备阶段参与者重载立即取消、Ready 阶段真实主窗/组件重载、系统剪贴板暂停恢复、租约到期及旧定时器隔离。所有工作区和 WebView 数据隔离；剪贴板夹具在进程关闭后恢复原有内容。
- 同一 Debug 构建随后串行通过既有任务草稿、草稿包、多窗回收/事件/业务/布局、主窗回收、共用主页面、工作区、备份、剪贴板退出/监听、后台专注和真实收纳退出共 14 套 129 项原生回归；连同本轮维护套件共 15 套 142 项通过。回归日志 draft-maintenance-final-*.log；没有把这些隔离测试当作生产接管、真实 IME 或发布验收。
- npm run check:silent 两次均通过 TypeScript、142 项 Node 单测及 Electron 构建，截图与工具箱 3 项 headless 测试通过，但共用 renderer-headless 未稳定全绿：首次在 tests/renderer-headless.mjs:164 的 RGB 颜色持久化等待超时，单独复核完整测试通过；第二次在 :216 的并发工作区广播等待超时。分别保留 check-silent-draft-maintenance.log、draft-maintenance-renderer-recheck.log 和 check-silent-draft-maintenance-recheck.log。不将单独复核成功当作整个检查通过，不修改颜色或并发保存功能来掩盖本轮范围外的间歇性失败。
- 再生接口清单仍为 DustDeskApi 82 项、ToolboxApi 16 项、7 项 isolated-verified、productionReady=false；新增的是按角色限制的内部维护命令，不是已完成的公共迁移 API。最终语法与 diff 检查通过，全部测试结束后无残留 Tauri 测试进程。
- 这只是 Tauri 侧一致检查点基础，不是产品迁移入口或完整旧数据兼容：Electron 全窗口协调、原 origin 受控读取、用户文件交互、跨运行时锁、可信持久谱系、启动恢复及生产切换/回退仍未完成。当前摘要不是 lineage 认证；未来异步校验与 localStorage 提交必须受原生有效会话的原子边界约束，不能以一次查询替代租约失效后的写入防护。详见 docs/DRAFT_MIGRATION_FORMAT.md。
- 继续保留 Electron 默认入口和隔离 Tauri 预览；不提交、推送、发布、改版本或纳入未跟踪模型资产，完整迁移目标仍未完成。

## Electron 准备构建：当前来源草稿导出（P2/P3 部分）

- 新增 src/main/draftMaintenance.ts 和 draftExport.ts，在真实 Electron 中提供原生全窗口草稿检查点和安全文件导出。托盘“导出迁移草稿…”及非打包开发菜单共用入口；先选择文件再冻结窗口，取消不冻结，重复请求不创建第二个会话。本轮仍未发布准备构建，也没有 Tauri 产品导入入口。
- 主进程按原生配置的应用 URL 检查 scheme、host、origin 与页面路径，避免 file/data 等不透明来源同为 null origin 的误匹配。所有参与者必须为同 session 的实际主窗、快速记录或登记组件；确认使用真实 WebContents 对象及随机请求，不把重用的数字 ID、前端窗口标签、退出应答或其他组件采集回复当作主窗授权。
- 原 preload 通过独立 drafts:flush / drafts:flushed 保存所有编辑器，排空在途保存；原生变更队列内等待实际写入、读取原始 workspace.json 并计算 SHA-256，然后同步封存工作区操作，由主窗隔离 preload 执行共享白名单采集。普通退出、主窗/快速记录回收、新组件、截图入口与剪贴板新采样在维护期间受限；准备前已接受的写入通过同一队列收尾。已登记的维护前组件操作也在实际执行前复查，不在冻结后创建新编辑窗口。
- 冻结采集阶段 35 秒有界；保存异常、窗口重载/销毁、渲染进程退出或 composition 进行中都会取消并恢复存活编辑器；取消后的异步封存及旧请求不能操作新会话。普通 workspace:flush 失败后的既有重试语义保留，maintenance 不消费正常退出的应答或被其 resume 解冻。文件选择和恢复编辑后的不可变归档落盘不计入冻结时限。
- 只在采集成功后使用已验证的不可变键值和对应文件摘要生成版本 1 草稿包；采集结束即恢复窗口，异步打包与落盘不再读写恢复后的 localStorage。原生写出使用同目录随机排他临时文件、文件刷盘和重命名；应用数据目录、工作区、目录、符号链接及指向受保护目录的 junction 别名均拒绝。导出不清理源草稿、不包含任意存储或局域网私钥；普通错误不替换此前成功导出文件。
- 新增 5 项 Node 测试，覆盖实际发送者、用途/令牌/重复确认、主窗采集、坏值/重复键、原生认可的 URL/同 session、失效窗口、超时和迟到封存、UTF-8 实际写出、保护根及真实 junction。tests/electron-draft-export.mjs 使用真实 Electron sandbox preload 与 file-origin 主窗、任务、通用/固定便签、快速记录，6 个场景加父测试共 7 项通过；验证未提交输入、请求 ID、排除令牌、原生写出文件、禁退出/新窗、失败保留文件、重载取消、取消后重试，以及落盘后通知失败不误报已完成文件。最终原生日志 electron-draft-export-complete.log。
- 原生测试替换保存对话框和结果通知的返回值，不把它宣称为真实系统文件选择 UI 验证。报告 electron-draft-export-native.json、归档样本 electron-browser-drafts.json 均位于 artifacts/tauri-migration；失败运行会先删除旧成功报告，避免复用旧证据。测试不访问生产工作区、不修改系统剪贴板，不以 file-origin 当前路径测试证明旧安装路径已受控读取。
- 更新 tests/preload-source.mjs，使既有 Electron 共用界面与 Tauri 草稿格式测试装载同一份真实白名单代码，而非复制一个测试替代实现；没有新增公共 DustDeskApi 方法或测试专用产品 IPC 命令。Electron 原生组件移动/缩放/重启回归、七组实际生产力流程，以及 Tauri 格式与维护套件均已串行通过，日志 electron-draft-final-*.log。
- 最终 npm run check:silent 通过 TypeScript、147 项 Node 单测、Electron 构建和 4 项真实 preload/main IPC 共用界面/Worker 测试；日志 check-silent-electron-drafts-complete.log。来源与通知处理的最终构建另通过全部 7 项真实 Electron 导出测试；Tauri 格式 5 项、维护 13 项也通过。本轮不将前轮 renderer-headless 间歇性超时写成已修复，原失败日志保留。
- 接口清单重新生成后仍为 DustDeskApi 82 项、ToolboxApi 16 项、7 项 isolated-verified、productionReady=false。实际归档重新校验摘要通过，只含本套件创建的 4 类白名单键。语法与 diff 检查通过，测试结束后未残留 Electron/Tauri 原生测试进程；没有纳入未跟踪模型文件或改变版本与默认入口。
- 仍未完成旧存储 origin 的受控隐藏读取、可信持久化谱系、跨运行时独占及生产数据接管、Tauri 导入的租约内原子提交/启动恢复、完整反向迁移和回退；导出的文件不能单独授权切换。检查点与包当前 64 MiB 上限仍需历史大数据兼容验收，不据此宣称完整旧用户迁移交付。继续保留 Electron 默认入口与全部原有未提交文件，不提交、推送、改版本或发布。

## 同用户数据配置的旧安装来源受控读取（P2/P3 部分）

- 新增 src/main/legacyDraftReader.ts 和 src/preload/draftReader.ts；托盘及开发菜单“从旧安装目录导出草稿…”通过原生目录选择，推导固定旧打包布局 resources/app.asar/out/renderer/index.html。只处理同一实际 session/用户数据配置，不运行旧 EXE，不把用户所选目录名称当作版本或数据身份认证。
- 复用全部实际编辑器保存及工作区队列封存后，才在旧 file URL 下创建隐藏受限读取窗。临时 file 协议为唯一目标返回自有空 HTML 和严格 CSP，旧 ASAR 的 HTML/JS 不参与执行；其他文件请求使用 session.fetch 的 bypassCustomProtocolHandlers 委托默认协议。已有处理器时明确拒绝，不覆盖未知处理器。正常、失败和取消都在恢复编辑前清理读取窗与本次处理器。
- 原生 additionalArguments 决定只读 preload 角色；它不安装桌面 API、不暴露 window.dustdesk，仅提供一次白名单私有回复。sandbox/contextIsolation 启用、Node integration/webview 禁用，页面导航、重定向及新窗拒绝。真实 WebContents、主 frame 的 processId/routingId/URL、随机令牌和当前维护状态共同约束响应，外来窗口即使得到真令牌也无权替换结果。
- 增加原生 DraftCollectionContext，将 AbortSignal 与检查点权威绑定；原生取消在恢复编辑前使私有读取失效，迟到回调不能重新封存或加入下一会话。读取窗最多等待 10 秒且受父维护 35 秒总上限约束；结果再次经过同一白名单、字段、重复键与容量校验。未找到任何可识别草稿时明确提示不能确认恢复，不把空包当作旧用户迁移完成。
- 实际构建先发现多 preload 入口会产生 sandbox 不允许 require 的共享分块，已改为一个自包含 preload/index.js 内按原生角色安装行为，共用真实 collectDrafts。最终构建仅一个 preload 文件，唯一 require 为 electron；不是通过关闭 sandbox、开放 Node、加载远程脚本或复制白名单来绕过。桌面角色的既有保存、退出与失败重试语义不变。
- 新增 5 项 Node 测试，验证只读角色不暴露 API、不写键值且不读取未知键的值、桌面角色仍有效、封存后才开始其他来源采集、取消信号与迟到结果、坏来源结果及固定本地路径/既有协议准入。完整 npm run check:silent 通过 TypeScript、152 项 Node 单测、Electron 构建和 4 项共用界面/Worker 回归；日志 check-silent-legacy-drafts.log。前轮间歇性页面超时仍不列为已修复。
- 新增 tests/electron-legacy-drafts.mjs：真实旧布局 ASAR 中写入草稿，实际正常退出/重启后将旧 ASAR 替换为会改草稿、联网和开新窗的恶意页面；验证保留原值、请求 ID 和对应原生工作区摘要，排除令牌/缓存、旧包文件未改动且无恶意网络请求。另验证已有协议拒绝与保留、实际读取窗销毁后恢复、携带真令牌的外来 WebContents、取消及普通重载/导出，6 场景加父测试共 7 项通过；报告 electron-legacy-drafts-native.json 明确 productionReady=false。
- 顺序执行普通 Electron 导出 7 项、旧来源导出 7 项、Tauri 格式 5 项、Tauri 维护 13 项，共 4 套 32 项原生测试通过；既有 Electron 原生组件移动/缩放/重启与七组生产力流程也通过。日志 legacy-draft-final-*.log；测试全部使用隔离工作区和用户数据配置，对话框返回值由夹具提供，不声称操作了真实目录选择系统 UI 或读取了真实旧用户 profile。
- 再生清单仍为 DustDeskApi 82 项、ToolboxApi 16 项、7 项 isolated-verified、productionReady=false，没有添加公开的测试或私有读取命令到桌面 API。格式、语法与构建产物依赖检查通过，原生测试进程全部退出；保留 Electron 默认入口、现有分支与所有原有未提交内容，不提交、推送、改版本、发布或纳入模型资产。
- 尚未覆盖其他用户数据/profile、非标准旧布局、已无法定位的历史入口及真实旧版本 profile 升级/回退样本；读取的是指定文件 URL 在实际 Chromium 分区中的白名单，不假设每个 file URL 必然独立。可信持久谱系、跨运行时互斥、Tauri 产品导入的租约内原子提交/启动恢复、生产接管和反向回退仍是未完成门槛；本轮没有据此开放生产切换。


## Windows 跨运行时工作区所有权（P2/P3 部分）

- 新增 src/main/workspaceOwnership.ts 和 src-tauri/src/workspace/ownership.rs；共享目录句柄的卷序列号及 64 位 file index，派生 dustdesk-workspace-v1 命名管道，而非以应用名、路径大小写、浏览器 profile、PID 文件或可删除的“过期锁”确定所有权。Node/Rust 双向互斥，独立工作区不阻塞。
- Electron 在首次工作区读取、IPC 注册、收纳恢复、窗口及后台服务启动前取得锁，持有到进程终止；readState 拒绝尚无独占权限的调用。占用/权限失败显示错误并以非零状态终止，不继续启动服务。Rust 在 WorkspaceStore 读取数据或打开原有 fs2 锁前创建同名首实例管道，保留管道和禁止共享删除的目录句柄至 store 释放；不改变 Tauri 预览目录或授权生产接管。
- 管道没有数据/控制协议；Rust 禁止远程客户，Electron 接入即断开。加锁前拒绝已知符号链接/junction，Node 在加锁后重验目录身份。保留 Rust 原有 workspace.lock，但不声称该文件本身可被 Node 原生识别。进程终止由内核释放管道，不依赖清理锁文件。协议及边界见 DRAFT_MIGRATION_FORMAT.md 的“跨运行时工作区所有权”。
- 新增 3 项 Node 测试覆盖同目录/大小写/规范化路径互斥、不同目录并行、相对路径/普通文件/junction 拒绝、重复释放及真实子进程终止后重开；新增 2 项 Rust 测试覆盖原生目录别名、独立目录及持锁期间不能重命名目录、释放后可重命名再开。无窗口夹具显式取得/释放真实临时目录所有权，不放宽产品检查。
- 新增 npm run e2e:migration:ownership，使用 Tauri CLI 的 Debug 构建及独立 Electron/Tauri 测试根；真实 Electron 已启动时，不同 profile 的另一 Electron 在读写前退出且工作区摘要不变。Node 已持有目标管道时实际 Tauri 初始化被拒绝且未创建 workspace.json；释放后 Tauri 成功初始化并拒绝 Node 及大小写别名，终止 Tauri/Electron 后能重新加锁且数据不变。共 6 场景加父测试 7 项通过，报告 workspace-ownership-native.json 明确 productionReady=false。
- 原生验证发现 Node 接触 Rust 单实例管道时返回 EBUSY，已与 EADDRINUSE/EACCES 一并转换为可理解的拒绝提示，不改变失败关闭策略。首次原生夹具共用目录、直接 cargo build 的未完成运行不计通过；最终分离临时根、使用正式 Tauri 构建命令后串行验证。错误框由夹具替换，不声称实际系统对话框或物理人工交互已验收。
- 完整 npm run check:silent 通过类型检查、155 项 Node 单测、Electron 构建和 4 项共用页面/Worker 回归；174 项 Rust 单测、fmt 和全目标严格 clippy 通过。所有权 7 项、普通 Electron 草稿导出 7 项、旧来源导出 7 项、Tauri 工作区 13 项、Tauri 草稿维护 13 项，共 5 套 47 项原生测试通过。日志 ownership-native-passed.log、ownership-regression-*.log、check-silent-ownership.log、ownership-rust-tests-final.log、ownership-clippy.log；不把既有间歇性页面超时列为已修复。
- 不识别此协议的历史版本仍可绕过锁，额外进程检测/退出门槛、可信持久谱系、租约内原子导入、启动恢复和反向迁移/回退尚未完成。其他会话/网络卷及 Electron 持锁后的恶意目录或上级路径替换也未验证；当前互斥不能当作完整生产接管或来源认证。完整接口、截图/工具箱/局域网、物理 DPI/输入法/睡眠/拖放、五轮 Release 性能与真实产物验收继续按主计划推进。没有改版本、切换默认入口、提交、推送或发布。

## 标准旧版本进程检测与维护撤销（P2/P3 部分）

- 新增 src-tauri/src/platform/legacy_processes.rs，使用 Windows Tool Help 原生快照，不启动 PowerShell/命令行子进程、不读所有进程命令行或用户数据。完整匹配 DustDesk.exe、DustDesk.Next.exe、dustdesk-tauri.exe，大小写不敏感，仅排除当前 Rust 原生 PID；其他目录/profile 的同名进程也保守拒绝，通用 Electron、WebView2 和相似名称不误判。
- drafts_prepare 在创建维护会话和冻结编辑器前检测，封存队列和工作区文件前再次检测；Ready 中每秒复检，发现旧版重启或快照错误则通过已有 requestId 绑定的 finish 取消维护、释放剪贴板暂停并恢复所有参与窗口。120 秒租约到期任务独立保留；迟到检测或旧令牌不能释放新的维护会话。没有新增 renderer 命令、事件权限或结束其他应用的权限。
- 枚举创建/首条/后续查询错误、超过 65536 条进程和缺少名称终止符均拒绝，不能用部分清单宣称旧版已退出。原生句柄由 RAII 关闭；提示按 PID 稳定排序、去重并限制显示前 8 条，但保留总数。3 项新增 Rust 单测覆盖全部标准名称、非子串匹配、只排除自己、快照错误失败关闭及有界提示，完整 177 项 Rust 单测及全目标严格 clippy 通过。
- 新增 npm run e2e:tauri:migration:processes，rustc 编译独立 stdin 等待器并以固定产品名启动，模拟真实不识别新管道锁的进程，不运行用户旧安装。5 场景加父测试共 6 项通过：准备前拒绝且无 flush/工作区字节变化；历史大写名和其他 Tauri PID 拒绝；通用 Electron/相似名不误判；实际主窗口与任务组件保存中出现旧版导致封存失败；Ready 后出现旧版自动撤销、恢复两编辑器并保留未提交任务，退出夹具后可重试且旧令牌无效。所有被检测夹具在产品拒绝/撤销后仍存活，由测试自己结束。
- 报告 legacy-processes-native.json 明确 productionReady=false；真实多窗进程场景、跨运行时所有权、维护协议、草稿格式和共用页面/退出共 5 套 41 项原生测试通过，日志 legacy-process-final-*.log。互斥回归曾发现夹具在终止命令返回后未等待子进程真实 exit/signal 状态，现先确认进程终止再尝试重新加锁；保留失败日志 legacy-process-regression-workspace-ownership-native.log，不给生产锁增加绕过、重试或提前释放。
- 完整 npm run check:silent 通过类型检查、155 项 Node 单测、Electron 构建和 4 项共用页面/Worker 回归，日志 check-silent-legacy-processes.log；Rust 177 项、fmt、等待器 rustfmt 与严格 clippy 通过，日志 legacy-process-rust-full.log、legacy-process-clippy.log。接口清单重新生成仍为 DustDeskApi 82 项、ToolboxApi 16 项、7 项 isolated-verified、productionReady=false。原生进程检测最终夹具清理调整后单独重跑 6 项通过，不把此前间歇性无窗口超时列为已修复；未改版本、提交、推送或发布。
- 该范围只是标准名称存在检测，不认证执行文件、来源 profile 或工作区谱系；其他同名程序可能保守阻止，任意改名及通用 Electron 承载的未知旧版本仍需来源定位。每秒快照有观察间隔，不能代替未来导入提交时的再次检测和原生原子授权。真实历史安装样本、跨用户会话、生产启动接管、可信谱系、原子导入/启动恢复及完整回退仍未完成；完整截图/工具箱/局域网、物理操作、Release 性能和真实产物门槛继续保留，默认入口与生产目录未切换。

## Electron 原生本地回执与退出排空（P2/P3 部分）

- 新增 src/main/draftLineage.ts，在准备构建的实际草稿导出流程中记录 Data/MigrationLineage/lineage.json。原生回执包含独立 workspaceId、已持有目录句柄的 volume/file 身份、每个原始归档的 SHA-256、payload 摘要和封存检查点等固定字段，不记录 entries/草稿正文、导出路径、Cookie 或缓存。归档 version 1 不变，不往包里加入可被用户文件自我声明的“可信 ledger”。
- WorkspaceOwnership 增加原生根身份和 assertHeld；回执读写及核验都要求该实际所有权有效。复制 ledger 到其他物理目录拒绝，重新格式化归档或伪造同 ID 内容也不能匹配；既有 ID/同原始字节幂等。校验严格拒绝额外字段、未来版本、重复 ID、错误目录身份、坏回执和多硬链接，不默默重置损坏历史。
- 原生回执写入按所有权对象串行化，使用同目录 wx 临时文件、sync、首次不覆盖发布和后续 rename，提交前比较原有记录；读取有 8 MiB 上限、最多 4096 条，不自动清理历史。单测发现追加时误复用上一快照对象，已改成复制 exports 后追加，12 个并发导出不再丢失或误报前态变化。临时和未用于外部文件的回执不等于导出成功；初次发布的中断恢复、受控历史整理和更大规模兼容仍需验收。
- 新增 8 项 Node 测试覆盖释放/重取所有权后的持久核验、未登记/改字节/同 ID 伪造拒绝、物理目录复制、并发追加、坏/未来/重复回执保留、硬链接/junction、目录阻塞/失锁和容量。当前账户不能创建文件 symlink，不将该物理场景写成通过，保留产品拒绝链接检查；不提权、不替换为不安全路径策略。
- 真实 Electron 导出套件增加 ledger 原始字节绑定、损坏阻断和正常退出/重启后的身份延续。主进程边界延迟真实 rename 调用：短暂阻塞时正常退出等待 ledger 与外部文件都完成；持续阻塞约 15 秒后取消退出、恢复实际主窗/组件并保留任务输入，释放后原导出继续完成。原有 before-quit 只会在导出中直接拒绝退出，现保持采集阶段的拒绝，仅对不可变归档的落盘阶段接受等待；独立跟踪 draftExportWrite，不等待通知框。初次退出等待验证的失败日志 draft-lineage-quit-native.log 保留，修正后 9 场景加父测试共 10 项通过，日志 draft-lineage-quit-native-final.log。
- 最终完整 npm run check:silent 通过类型检查、163 项 Node 单测、Electron 构建和 4 项共用页面/Worker 回归；177 项 Rust 单测、fmt、语法及 diff 检查通过。普通 Electron 导出 10 项、旧来源导出 7 项、跨运行时锁 7 项、Tauri 格式 5 项、Tauri 维护 13 项，共 5 套 42 项原生测试通过；既有组件移动/缩放/重启和七组生产力流程也通过。日志 draft-lineage-quit-native-final.log、draft-lineage-final-*.log、draft-lineage-rust-tests.log、check-silent-draft-lineage-final.log；接口清单仍为 82/16 项、7 项 isolated-verified、productionReady=false。以前间歇性无窗口超时不列为已修复。
- 这只是原生路径和用户文件权限约束的本地回执基础，不是签名或对抗同账户篡改的来源认证。Rust 核验、可信生产源/一致快照、跨目录受控移交、原子导入/启动恢复和反向回执仍未接通，不能据此启用生产迁移或宣称完整可信谱系完成；完整截图/工具箱/局域网、物理操作、Release 性能和产物门槛继续保留。没有变更版本、默认入口或生产目录，也未提交、推送或发布。

## Rust 原生回执只读核验与原始检查点保持（P3 部分）

- 新增 src-tauri/src/workspace/draft_lineage.rs，读取当前已独占根目录固定 MigrationLineage/lineage.json，核对打开目录的物理身份、原始归档 SHA-256、payload 摘要和来源头，以及当前 workspace.json 原始字节与 Ready 封存检查点。ledger 限 8 MiB/4096 条，归档限 64 MiB/5000 entries，拒绝坏/未来/重复回执、重解析点、非普通文件和多硬链接；损坏文件保留，不自动重置或修复。
- 新增独立 draft-verifier 权限，只给实际 workspace-main 的 drafts_verify。门闩、存储队列、当前窗口、标准旧进程和实际 Ready 截止时间均复核；预期摘要来自原生维护会话，不接收 renderer 自报路径、ledger 或 fingerprint。返回只读元数据，不写浏览器草稿，不发可用于后续异步写入的授权令牌，也不代替共享内核逐项白名单及冲突验证。
- 首次真实 Electron → Rust 同目录验证发现 Tauri 启动规范化把合法整数保留天数/布局坐标转换成浮点表示，引发语义未变却重写 workspace.json，破坏已封存的原始检查点。修复 normalize.rs：值无需规范化时保留原数字表示，布局在 JS 安全整数范围内保留合法整数；分数/非法范围仍按原规则处理，未知大整数不丢精度。不放宽原始摘要、不补写回执、不引入语义相等绕过。失败日志 rust-lineage-native.log、rust-lineage-native-diagnostic.log 和诊断 rust-lineage-startup-delta.json 保留。
- tests/electron-harness.mjs 仅为互操作夹具增加 dataDirectory，必须是显式隔离 tempRoot 内的绝对子目录；拒绝根目录自身、相邻前缀、相对路径、.. 及外部目录。新增无启动安全测试；产品没有增加环境或来源路径入口。真实 Electron 先通过原生菜单导出、正常退出并确认 exit 0，Tauri 才使用同一物理隔离目录；退出后及 Tauri 启动后的原始工作区摘要均须不变。
- tests/tauri-draft-lineage.mjs 的 8 场景加父测试共 9 项通过：原型窗/真实组件拒绝、Ready 绑定、重格式化/伪造及自报参数拒绝、坏/未来/重复记录不重置、真实硬链接/junction 拒绝、当前工作区哪怕只改空白也拒绝、结束请求不可复用、实际重启后的 1 秒租约到期拒绝。目标任务草稿始终为空，报告 draft-lineage-native.json 明确 productionReady=false。该报告不证明生产来源选择或跨目录移交完成。
- Rust 新增 7 项回执、2 项 Ready/截止时间和 2 项规范化测试，共 188 项通过，严格全目标 clippy 通过，日志 rust-lineage-unit-fixed.log、rust-lineage-clippy.log。7 套原生回归共 68 项通过：谱系 9、工作区 13、维护 13、旧进程 6、跨运行时所有权 7、共用 App 10、组件 10；日志 rust-lineage-final-*.log。最终权限契约曾漏列新独立权限，现补齐精确列表并确认其只允许 drafts_verify、不混入 workspace 通用权限。
- 修复契约后完整 npm run check:silent 通过类型检查、164 项 Node 单测、Electron 构建和 4 项无窗口页面/Worker 回归，无跳过；日志 check-silent-rust-lineage.log。接口清单重新生成仍为 82/16 项、7 项 isolated-verified、productionReady=false；只读迁移命令不计为公共业务 API 已完成。
- 下一依赖仍是原生协调的浏览器原子导入/启动恢复、生产源与一致快照选择/移交及反向回执/回退。当前本地记录不是签名或同账户篡改认证，单次核验不能授权过期/取消后的写入；截图/工具箱/局域网、物理操作、五轮 Release 性能和实际安装包/ZIP/SHA256SUMS 门槛继续保留。未更改版本、默认入口、生产路径，未提交、推送或发布。

## 草稿可暂存事务与同步提交内核（P3 部分）

- src/shared/draftMigration.ts 将异步 prepareDraftImport 与同步 stage/commit/rollback 分开。预检只解析并验证归档、摘要、白名单及预期工作区，不访问目标存储，返回冻结准备对象；内部 payload 不对外暴露。stage 持久化原有 version 1 pending 格式并暂存草稿，但不写完成回执，原格式和已有 importDraftArchive 即时包装保持兼容。
- isActive 必须同步返回严格 true，Promise、字符串、undefined 或 false 一律不能授权。在首次存储操作、日志发布前、逐键写入及最终回执前复核。回执是完成边界；不把 stage 返回或结果数组当完成，也不把布尔回调或只读 drafts_verify 当成原生授权。原生排他尚未接通这条事务链，因此产品入口仍关闭。
- 每个 Storage 对象只有一个活动事务，另一个 stage 不能隐式回滚仍等待提交的事务。日志、回执历史和暂存内容变化会否决提交；显式恢复使旧句柄失效，即使新重试的日志字节完全相同，旧 commit/rollback 也不能操作新事务。该进程内身份只防同对象误用，不代替跨 WebView 原生门闩。
- 回滚只删除仍等于本次写入的值，保留之后的输入与外部有效回执；未知/被替换的日志不覆盖。故障使存储不可读或回滚失败时保留现有数据并禁止切换，解除故障可恢复重试，不残留永久内存锁。回执已落盘后的清理失败仍按既有完成回执恢复，不回滚或复活已消费草稿。
- 最终提交检查新增旧格式 alias，但源包本身同时保留旧/新格式键时不误判为外部冲突，不丢任一原始值。逐键边界只检查轻量活动状态，完整 pending/回执快照在暂存结束及提交边界复核，避免每个键都复制最大 64 MiB 日志；外部键集合只筛选一次。5000 键单测验证整批日志/回执读取次数保持常数级，不将这项单测充当 Release 性能门槛。
- 共享格式单测由 13 增至 27 项，新增 14 项覆盖暂存无回执、两阶段间取消、写入中失效、显式恢复/旧句柄、日志与回执替换、异步屏障拒绝、旧新 alias 共存、存储暂时失联及大批次。日志 draft-staged-unit.log。完整 npm run check:silent 通过 178 项 Node、4 项无窗口回归、类型检查与 Electron 构建，无跳过；日志 check-silent-draft-staged.log。
- 真实 WebView2 格式套件增加测试屏障撤销后的回滚，以及 Tauri 正常退出 exit 0 后用同一隔离配置重启，确认未提交 pending/草稿保留，再显式恢复并打开测试编辑器；共 6 场景加父测试 7 项通过，日志 draft-staged-native.log 和 draft-staged-final-tauri-draft-format.log。源端继续使用现有共享 preload/main IPC 编辑器夹具，不将其说成新增的真实 Electron 进程导入入口。
- 最终顺序运行格式 7、Rust 谱系 9、原生维护 13、真实 Electron 当前导出 10、旧来源导出 7，共 5 套 46 项通过；日志 draft-staged-final-*.log。npm run check:tauri 通过类型检查、Tauri UI 构建和 188 项 Rust 测试，日志 draft-staged-tauri-check.log；fmt、语法与包括本轮未跟踪源码的 whitespace 检查通过，原生测试进程无残留。接口清单重新生成仍为 82/16 项、7 项 isolated-verified、productionReady=false。
- 原生最终提交决定、取消/过期与已排队 WebView 任务之间的原子关系，以及所有编辑窗口创建前的自动恢复阻断仍待接通；本轮测试主动调用恢复和提供同步布尔屏障，不能据此声称这些门槛已完成。生产源/快照移交、反向回执/回退、全功能 API、物理两机/IME/DPI、五轮 Release 性能与真实产物验收继续保留。未变更默认入口、版本或生产路径，未提交、推送或发布。

## 原生持久决定与未恢复事务启动阻断（P3 部分）

- 新增 src-tauri/src/workspace/draft_transaction.rs，在当前已独占物理根目录的固定 MigrationTransaction.json 持久化事务元数据：原生 request/transaction/workspace/archive ID、原始包/工作区/预期暂存日志摘要、物理根身份和 pending/commit/abort。记录严格限定字段及 16 KiB，拒绝坏/未来记录、错误身份、额外字段、非普通文件、多硬链接及重解析路径；不记录草稿正文、源路径或私钥。
- 首次发布使用排他临时文件、sync_all 和不覆盖硬链接，后续决定先比较原有记录，再用 Windows write-through 替换；不先删除有效记录，遗留临时文件不是权威。多硬链接/坏记录保留并阻断，不自动修复。开始必须匹配真实 Ready 和当前原生回执，决定绑定原请求/事务并重新核验原始工作区字节。
- 新增独立 draft-transaction 权限和 drafts_transaction 命令，仅真实 workspace-main 可调用；不扩充 DustDeskApi、不提供产品导入按钮。状态读取与开始/决定使用存储队列和组件门闩；决定边界持有维护会话互斥，复核单调时钟截止时间、取消状态、检查点及旧进程。无有效会话/已过期/取消/旧进程检测失败只能产生 abort，已持久 commit/abort 不被相反迟到请求反转；原生 commit 是决定而不是浏览器导入完成。
- 未恢复记录存在或不可安全读取时，普通工作区命令、底层读写/初始化及后台组件恢复拒绝继续。主页面在事件传输安装和共用 App 挂载前查询原生记录，存在记录则显示错误而不创建编辑器；活跃事务也禁止 drafts_end 和租约超时恢复编辑。没有 renderer 假 recovered/acknowledged/clear 的解除接口；即使原生为 abort/commit，仍保持阻断，等待下一阶段的受控浏览器恢复与原生确认。
- 新增 9 项 Rust 事务测试覆盖终态持久/相反请求、重新打开目录、错误请求/事务、失效检查点、工作区字节变化、坏/未来/额外字段、目录复制、多硬链接和非普通文件；另新增 2 项维护测试验证真实截止时间/取消/错误请求及发布边界互斥。完整 Rust 199 项通过，严格全目标 clippy 通过，日志 draft-transaction-rust.log、draft-transaction-clippy.log；fmt 与语法/含未跟踪源码的 whitespace 检查通过。
- 新增 npm run e2e:tauri:migration:transaction。真实 Electron 在同一隔离物理目录导出并正常退出，Tauri 分别验证 commit、abort、租约过期和未决定 4 种状态，再由测试结束整个原生进程树、重启并检查主页面无输入框/编辑器、原始工作区不变和目标草稿为空。无效开始不污染后续维护；错误角色/请求/事务被拒绝，renderer 假确认不清理记录，重启无新租约也不能把旧 pending 变成 commit。4 场景加父测试共 5 项通过，报告 draft-transaction-native.json 明确 productionReady=false，日志 draft-transaction-native-final.log。
- 未决定场景同时使用真实 Electron 中已显示任务组件的布局，源组件完成加载后再导出，不手工修改包或原生回执。Tauri 首次正常恢复可见组件并拒绝其事务命令；事务存在后重启不再创建该配置中的组件窗口。新增夹具最初在源组件 URL 尚未加载时立即导出被正确拒绝 Invalid URL，现等待真实输入框就绪后导出，失败日志 draft-transaction-native-widget-loading.log 保留，不把产品拒绝改成跳过来源检查。
- 首次原生测试在已有维护拒绝错误和新增恢复阻断错误的优先级上暴露差异，现普通命令先检查已有 store 的未恢复事务，再检查生命周期阶段，明确报出受控恢复要求；保留 draft-transaction-native.log，修正及最终套件日志分别为 draft-transaction-native-fixed.log、draft-transaction-native-final.log。未放宽权限、工作区摘要或复用旧维护请求。
- 格式回归遇到正常退出先销毁 WebView、IPC 成功应答未能返回的夹具竞态；现在仅容许已关闭/销毁/断连错误，仍必须等待真实进程退出且 exit 0，再重启检查 pending 和实际恢复值。保留失败日志 draft-transaction-final-tauri-draft-format.log，修正后连续 3 次各 7 项通过，日志 draft-transaction-format-retry-1/2/3.log，不以忽略任意错误或只等页面关闭替代正常退出证明。
- 最终 9 套原生检查共 89 项通过：本轮事务 5、工作区 13、共用 App 10、组件 10、维护 13、谱系 9、格式 7、所有权 7、主窗回收 15；日志 draft-transaction-native-final.log、draft-transaction-final-*.log，格式使用上述 retry 日志为最终证据。完整 npm run check:silent 通过类型检查、178 项 Node、Electron 构建和 4 项无窗口回归，无跳过，日志 check-silent-draft-transaction.log；接口清单仍为 82/16 项、7 项 isolated-verified、productionReady=false。
- 当前 journalSha256 只是预期摘要绑定，尚未核验实际浏览器 pending 内容、差量或 WebView profile；测试没有暂存/提交任何目标草稿。下一依赖是受控 profile 中的 pending 与原生决定核对、commit/abort 恢复、真正原生完成确认及解除阻断，不是把记录存在或浏览器布尔值当完成。生产源/快照移交、完整原子导入/回退、全 API、物理环境、Release 性能和产物验收门槛保持不变。未更改默认入口/版本/生产路径，未提交、推送或发布。

## 真实浏览器绑定、原生副本与启动恢复（P3 部分）

- 新增 src-tauri/src/workspace/draft_browser.rs。原生仅认可实际 workspace-main、固定 /tauri.html 入口、当前窗口对象、原生配置的 WebView2 目录与 URL origin；持有无删除共享的目录句柄并按卷/file 身份计算 browserBinding。通过原生 eval_with_callback 直接观察真实 pending、回执及被绑定键，不接受 renderer 提供正文或 recovered/acknowledged/clear 布尔值替代存储观察；等待有 15 秒上限，失败保持阻断。
- 原生开始先核验实际 pending 摘要、归档 ID/payload 摘要、唯一写入条目以及每个原始键值都属于已通过本地原生谱系的原始归档，再一次发布绑定元数据。MigrationTransaction.json 增加浏览器身份、payload 摘要、逐键摘要与 completed，元数据边界由 16 KiB 扩展为有界 16 MiB/5000 键，不存正文；旧无绑定预览记录保留并拒绝自动恢复，不伪造浏览器归属。
- 首次真实 commit → 原生进程树结束/重启暴露 localStorage 同步应答尚未刷盘，pending/键可能丢失；保留 draft-recovery-native.log、draft-recovery-native-second.log。未用固定等待、语义摘要、改回执或放宽测试掩盖。现先将实际日志原文以排他临时文件、sync_all、固定路径安全发布到 MigrationBrowserJournal.json，再持久化原生 pending；提交决定前再次校验副本摘要。副本最多 64 MiB，含草稿正文，仅留工作区、不进日志/外部包，不是用户任选的授权文件。
- recoverNativeDraftImport 按原生不可逆终态恢复：commit 保留/补齐缺失的暂存键，提交浏览器回执后清日志；abort 只删除仍等于本次值的键，保留后来输入。浏览器日志或键尚未落盘时可用精确摘要匹配的原生副本补齐，但目标不同内容/legacy alias 冲突不覆盖；已有而被改的 pending 不强行替换。commit 写入/清理失败保留决定和日志供重试，不使用普通失败回滚撤销已决定提交。
- drafts_recovery 的 finish 请求会再次由原生直接读取真实结果：pending 必须已清；commit 回执、逐键摘要须匹配，abort 不能有完成回执且不能残留未改的导入值。成功后持久化 completed 并解除当前维护，不删除原生权威。每个新 WorkspaceStore 仍阻断后台/组件/读写，直到重新观察已完成记录的浏览器确认；若完成应答也未落盘，再从持久决定与副本恢复。完成回执仍在时尊重已消费/修改草稿，不复活输入；最近记录与副本在下一有效事务时顺序替换。
- 共用主页面在事件传输安装和 App/编辑器挂载前完成恢复。无对应原生记录的孤立浏览器 pending 也保留并阻断，不猜测来源或决定。格式套件保留“测试自行暂存/显式恢复”的范围，正常退出后该孤立日志现在先触发真实启动阻断，夹具再显式恢复并重载；新增仅测试用 expectRecoveryBlock 等待模式，默认成功启动条件不放宽。旧等待器只等 app-shell 导致超时的日志 draft-recovery-final-tauri-draft-format.log 保留。
- 共享格式单测从 27 增至 34 项，覆盖原生 commit/abort、写入和清理失败后的不可逆重试、异步校验竞争、日志/键丢失及完成前后幂等；日志 draft-recovery-shared-unit.log。新增 2 项 Rust 原子绑定/完成记录测试及 3 项原生真实结果验证测试；全部 Rust 204 项与严格全目标 clippy 通过，日志 draft-recovery-rust.log、draft-recovery-clippy.log。
- 升级 tests/tauri-draft-transaction.mjs：真实 Electron 导出、正常退出，Tauri 真实维护及共享暂存后绑定原生记录，覆盖 commit/abort/过期/未决定、浏览器日志或键丢失、持久副本损坏、不同物理 profile、完成应答丢失与已消费草稿不复活。被改浏览器 pending 采用同进程实际渲染器重载验证，避免把尚未刷盘的损坏写入假定为重启后必然存在；此前错误假定的日志 draft-recovery-native-durable.log 保留。9 场景加父测试 10 项通过，报告 draft-transaction-native.json 明确 productionReady=false，日志 draft-recovery-native-final.log。
- 最后重新构建双运行时并跑 11 套共 111 项原生回归全部通过：本轮恢复 10、工作区 13、共用 App 10、组件 10、维护 13、谱系 9、格式 7、所有权 7、主窗回收 15、真实 Electron 当前导出 10 和旧来源导出 7。最终日志 draft-recovery-native-verified.log 与 draft-recovery-verified-*.log；完整 npm run check:silent 通过类型检查、185 项 Node、Electron 构建和 4 项无窗口回归，无跳过，日志 check-silent-draft-recovery.log。Rust 204 项、全目标严格 clippy、fmt、脚本语法与含未跟踪源码的 whitespace 检查通过，原生进程无残留；重新生成接口清单仍为 82/16 项、7 项 isolated-verified、productionReady=false。
- 仍未提供产品文件选择/完整导入与失败重试入口，也未覆盖全部原生副本发布中断、磁盘满/设备断电、孤立记录受控人工恢复、纯托盘启动时无主窗的受控恢复、Electron 对反向事务的识别与生产源/快照移交。当前自动恢复在主页面启动执行，不能据此宣称完整后台/生产切换或反向回退完成；主计划的全 API、物理环境、Release 性能与真实产物门槛继续保留。未切默认入口、改版本/生产目录，未提交、推送或发布。

## 纯托盘启动恢复（当前增量）

- 接通 workspace-recovery 隐藏页与独立 capability，仅允许 drafts_recovery 和 drafts_startup_done；主窗只获得等待/重试权限，组件不能调用恢复工作页的完成命令。Vite 构建包含 recovery.html，恢复页不导入 React 或业务适配器。
- 存在 MigrationTransaction.json 时先恢复并原生复核实际浏览器状态，再销毁工作页、恢复后台维护和布局；主窗即使同时打开，也先显示等待/失败壳，不提前创建业务编辑器或订阅。无原生记录仍维持零 WebView 托盘启动，浏览器孤立 pending 的检查边界不改变。
- 状态区分进行中、原生已验证收尾、就绪和失败，显式重试使用新代次；超时和销毁绑定旧窗口身份/代次，迟到回调不得取消新会话。失败保留原日志，重复失败可再次重试，验证收尾中禁止并发重启。
- 普通原生工作区 operation 在入队和实际执行前检查启动就绪，不能从直接 IPC 提前开启读写。仅原生启动失败且未开放编辑器时允许“退出并保留恢复日志”：不走普通保存、收纳或草稿清理，真实不同 profile 场景验证 exit 0 且两个原生日志与工作区不变。重试和退出串行，进行中/收尾中不开放失败退出捷径，正常编辑后仍走完整退出协议；新增该状态转移单测后 Rust 共 208 项。
- 原生恢复套件增加 tray-commit、tray-abort 和 tray-pending，原 9 场景加 3 个纯托盘场景和父测试共 13 项通过。无组件场景真实 --hidden 启动、不设置调试端口，持久完成后轮询原生进程树确认只剩应用及 Debug conhost；可见组件场景直接恢复任务编辑器且不留主窗/恢复页。损坏原生日志场景额外验证失败重试、实际文件修复后的成功重试及主窗/组件不能伪造完成。最终日志 startup-final-tauri-draft-transaction.log；报告 draft-transaction-native.json 保留 productionReady=false。
- 最终构建后串行通过 11 套共 114 项原生回归（本轮恢复 13，其余 101），另通过无工作区零 WebView 托盘检查；日志 startup-final-*.log。Rust 208 项及全目标严格 clippy 通过，日志 startup-recovery-rust.log、startup-recovery-clippy.log。曾发现新启动检查改变正常“重复退出”错误契约，现保留原正常分支和断言，未放宽测试；失败日志 startup-failed-quit-contract.log 保留。
- 最终 npm run check:silent 通过类型检查、185 项 Node、Electron 构建及 4 项无窗口回归，无失败或跳过，日志 check-silent-startup-recovery.log。fmt、脚本语法及包含未跟踪源码的 whitespace 检查通过；原生测试应用进程无残留。分支保持 codex/tauri-migration，版本和默认 Electron 入口不变。
- 仍缺完整产品文件选择/导入、全部故障时序、孤立日志用户恢复、生产数据/身份接管、反向回退、全 API、物理环境与 Release 产物/性能验收；不切换默认入口，不提交、推送或发布。

## 隔离产品草稿导入（当前增量）

- 隔离主页面新增 Lucide FileInput 导入入口，原生 JSON 文件选择、有界原文读取与预览确认。取消选择/预览不冻结编辑器；坏文件不变成空导入。新权限仅限主窗 drafts_pick 与只读 drafts_import_state，恢复工作页、原型页和组件不获得文件读取权限。
- Rust 复用现有受控 STA 原生对话框，草稿选择不显示“选择当前文件夹”；有界读取复用原生文件身份与重解析点/硬链接检查，拒绝目录、空文件、无效 UTF-8、超过 64 MiB 与身份变化，保持选定原文字节，不重读用户确认期间已改变的源文件。
- 确认后保存所有编辑器并封存当前检查点，校验包与本地原生回执后同步暂存；原生观察实际日志、持久决定，再按决定恢复/原生复核。已有输入不覆盖，已消费/清空输入不因重复包复活；不将普通前端 transaction.commit 用作原生 commit 后恢复。
- 不确定 begin/commit/finish 响应先读取包含 completed 的原生记录；属于本次请求则遵守不可逆决定，pending 受控中止。没有本次原生记录才回滚本次暂存；未知状态或回滚不完整保留日志并重新启动核验，不放行编辑器。准备应答丢失可结束原生 flush 事件记录的维护请求；提示存储失败不改变事务语义。
- 产品维护请求设置 refresh，原生确认完成后通知参与主窗/组件保持 inert 并实际重载，避免旧编辑器覆盖刚导入的草稿；一般取消/失败不强制重载。新组件启动遇到浏览器 pending 直接阻断。初次原生测试暴露旧页面提前删除结果提示，已改为由新页面消费，失败日志 product-import-first-ui-failures.log 保留。
- 新增 3 项 Rust 文件读取边界测试，Rust 共 211 项；新增 12 项导入控制器单测，覆盖来源拒绝、准备/提交应答丢失、租约拒绝、不可逆 commit、回执写入失败、暂存回滚失败与重复输入保护。隔离产品流程不代表生产源/快照接管、全部原生故障时序、孤立日志人工恢复或反向回退已完成，默认 Electron 入口与版本不变。
- 产品原生套件包含正常、目标已有输入、begin 响应丢失、commit 响应丢失、原生 begin 后租约到期、回执写入失败共 6 场景及子测试合计 22 项通过。最初替换只读 invoke 的故障注入未生效，由新增中止断言发现；现拦截实际 IPC fetch 成功响应并转换错误回调，每例断言持久注入标记，失败日志 product-import-failed-fault-injection.log 保留。报告 draft-import-product-native.json 保持 productionReady=false，最终日志 product-import-final-tauri-draft-import.log。
- 最终重新构建后串行通过 12 套共 136 项原生回归，另通过无工作区零 WebView 托盘检查；日志 product-import-final-*.log。211 项 Rust、全目标严格 clippy、fmt、导入脚本语法、类型和含未跟踪源码 whitespace 检查通过。重新生成接口清单仍为 82/16 个成员、7 项 isolated-verified、productionReady=false，不能把本轮导入进展当全 API 完成。
- 完整检查曾出现 Electron 无窗口便签颜色保存超时，保留 product-import-headless-color-timeout.log；不改断言或相关业务代码，单独复核 renderer-headless 通过，日志 product-import-headless-recheck.log。
- 最终 npm run check:silent 全部通过：类型检查、197 项 Node、Electron 构建与 4 项无窗口回归，无失败或跳过，日志 check-silent-product-import.log。原生测试应用进程无残留，分支保持 codex/tauri-migration，未提交、推送或发布。

## 项目 XLSX/CSV 原生导出（当前增量）

- 共用 Projects 页面沿用现有 Lucide 导出按钮，Tauri 适配器连接 projects_export；Rust 通过受控队列读取快照并原生选择目标，前端不传入路径或表格内容。原型/组件能力不变，仅主窗获得 project-export 权限，接口清单 exportProjects 标为 partial，不提升为生产完成。
- rust_xlsxwriter 生成“项目管理”工作表及原九列宽度，按项目/阶段/子事项展开，保留显式/自动进度、空阶段、完成中文和 Unicode。CSV 保留 UTF-8 BOM、CRLF、引号/多行转义与公式前缀保护；XLSX 强制字符串，输入不变为公式或超链接。超过 Excel 行数/单元格长度或 64 MiB 时明确失败，不静默截断。
- 新增真正 IFileSaveDialog：XLSX/CSV 过滤器、Documents 默认目录、保存覆盖确认和取消；整个编码/发布期间保持原生选择会话，退出/维护/主窗销毁可取消。发布前复核工作区可写阶段、窗口身份及会话，临时文件 sync_all 后原子替换；内部工作区/profile 目录、重解析点、多硬链接和目录目标拒绝，不授予通用文件写入。
- 5 项 Rust 导出测试覆盖行/进度、CSV 逃逸、XLSX 单元格限制、文件替换和目标占用后的原文保留/清理/重试，Rust 共 216 项。真实 Electron 先生成基准，Tauri CSV 字节相同，XLSX 表格/工作表/列宽/公式安全一致；原生套件同时覆盖共用页面、取消、角色拒绝、内部目录保护、空项目失败重试、快照不变和退出取消保存框。全部验证仅在隔离目录，实际安装包、物理输入环境和生产切换仍未完成。
- 项目原生套件增补保存选择期间的并发编辑快照一致性、重复导出不创建第二保存会话、迁移维护先取消保存框再等待全编辑器应答，共 14 项通过；列宽逐项验证在字体舍入容差内。报告 project-export-native.json 保持 productionReady=false，日志 project-export-final-tauri-project-export.log；共用原生对话框回归另 11 项通过。
- Rust 依赖 rust_xlsxwriter 0.102.0 已锁定，MIT OR Apache-2.0、MSRV 1.88.0，与项目最低工具链一致；产品导出不需要 Node、Excel 或 PowerShell。UI 自动化辅助脚本增加保存按钮与文件名控件识别，不放宽文件内容或生命周期断言。最初测试误用不存在的导航名称及跨越主动保存操作比较整个文件摘要，现改为真实“项目”入口、仅导出操作前后完整文件摘要比较，保留 project-export-first-navigation-failure.log。
- 本轮串行回归曾有一次既有草稿导入 existing-target 场景出现 Windows 拒绝访问，编辑器保持阻断，日志 project-export-import-access-denied.log 保留；未改草稿恢复逻辑或放宽断言，单独 22 项复核通过。原因尚未定位，不能把该次错误写作已修复，正式切换前仍需排查间歇存储故障。
- 最终逐套核对 14 套共 161 项原生测试全部通过，无失败或跳过，另有无工作区零 WebView 托盘检查；日志 project-export-final-*.log。Rust 216 项及严格全目标 clippy 通过，日志 project-export-rust.log、project-export-clippy.log；类型、fmt、脚本语法及包含未跟踪源码的 whitespace 检查通过。接口清单保持 82/16 个成员、7 项 isolated-verified，exportProjects 仅为 partial，productionReady=false。
- npm run check:silent 最终通过类型检查、197 项 Node、Electron 构建和 4 项无窗口回归，无失败或跳过，日志 check-silent-project-export.log。测试应用进程无残留，仍在 codex/tauri-migration，版本、生产目录和默认 Electron 入口不变，未提交、推送或发布。

## 原生更新检查与共享托盘入口（P4/P7 部分）

- 共用设置页 checkForUpdate 不再返回占位错误，改为主窗口专属 release_check；托盘“检查更新”直接调用同一个 Rust 服务，并发调用共享一次网络请求和一次原生确认。没有主窗口/工作区时也不为检查更新创建 WebView；主窗口隐藏时，正在进行的检查阻止保守回收。
- 固定 Xu-qingsong/DustDesk-Next 的 GitHub API 与 Release 页面，保留 Accept、User-Agent、正式版本校验、可访问空仓库与私有/失效仓库区分、限流/网络/JSON 错误和重试。网络请求及 404 仓库复核共用 15 秒总超时，禁用 HTTP 重定向，响应上限 1 MiB，超过明确报错，不把失败当作最新版本。
- 版本比较覆盖任意精度数字、v 前缀、预发布和构建元数据，保留 Electron 数字预发布段的既有比较行为；说明清理空白后最多 20,000 个 UTF-16 单元，截断不拆开 Unicode 字符。GitHub html_url 不用于导航，Release 地址只从固定仓库和编码后的有效标签构造。
- Windows TaskDialog 显示当前版本、更新说明和“不自动下载或安装”，默认“暂不更新”，只有主动“前往更新”才经 Shell 打开受信页面；不提供 renderer 任意更新地址、下载、安装或通用写文件权限。退出、草稿维护、主窗销毁及主页面导航取消网络/原生对话框，避免等待 tracked 检查造成保存握手死锁；Shell 调度线程再次复核生命周期及调用窗口身份。
- 新增原生回归使用实际本机 HTTP 服务、实际设置页、原生托盘菜单和真实确认按钮/回车；只有 Debug 且标准隔离临时根允许回环夹具，并将实际构造的打开地址记入测试根，不启动用户浏览器。Release 不编译测试来源或打开替身，产品运行不依赖 PowerShell；真实 GitHub、默认浏览器、物理 DPI/托盘及实际打包产物仍未验收，checkForUpdate 仅列 partial，productionReady=false。
- 首轮原生测试的默认按钮查询错误地使用了标准 Dialog 消息；TaskDialog 的 DirectUI 控件并不提供该契约，现改为真实聚焦后回车并断言没有打开页面，不放宽默认拒绝要求。原始日志 update-first-native.log、update-second-native.log 保留。
- 扩展纯托盘用例发现隐藏启动参数会将首个原生 TaskDialog 隐藏：原生枚举确认“发现新版本”的 #32770 窗口实际存在但 visible=false，不是网络或权限错误。对话框定时回调在未取消且确实不可见时显式显示并聚焦，不创建主窗或 WebView；失败日志 update-pure-tray-failure.log 与枚举记录 update-pure-tray-hidden-window.json 保留。最终扩展原生套件 19 项通过，包含导航取消、纯托盘实际菜单/确认、进程树零 WebView 和正常退出，报告 update-native.json 保持 productionReady=false。

- 本轮广泛回归又有一次既有草稿事务 pending 启动恢复出现“拒绝访问（os error 5）”，日志 update-transaction-access-denied.log 保留，编辑器正确保持阻断。仅补充浏览器绑定、工作区打开、原生记录/副本读取、中止决定和完成记录等阶段上下文，并让原生恢复测试在失败时保存事务/副本/工作区现场；未更改恢复决定、添加自动重试、放宽断言或绕过文件保护。随后 13 项事务回归通过仍不足以证明该间歇问题消失，根因未定位，不能写作已修复或放行生产切换。

- 最终按同一构建逐套核验 15 套共 180 项原生/双运行时回归全部通过，无失败或跳过；更新套件 19 项又补充检查完成后隐藏主窗恢复回收、纯托盘不生成 workspace.json，并复核无工作区零 WebView 后台启动。最终日志 update-final-*.log、报告 update-verification.json；早先失败日志仍保留，不代表历史间歇问题已修复。
- Rust 218 项、全目标严格 clippy、fmt、Release 条件编译检查和新增脚本语法/whitespace 通过；日志 update-rust.log、update-clippy.log、update-release-check.log。npm run check:silent 最终通过类型检查、197 项 Node、Electron 构建和 4 项无窗口回归，无失败或跳过，日志 check-silent-updates.log。接口清单仍为 82/16 个成员、7 项 isolated-verified，productionReady=false；版本、生产目录和默认 Electron 入口不变，未提交、推送或发布。

## 草稿拒绝访问故障边界与显式重试（P3 部分）

- 对上一轮间歇拒绝访问进行 5 轮顺序原生事务压力回归，每轮 13 项通过（recovery-stress-1.log 至 recovery-stress-5.log），未自然复现。这些结果不能证明问题已消失，历史 update-transaction-access-denied.log 与 project-export-import-access-denied.log 继续作为未解决风险保留。
- Windows 原子替换失败立即保存 MoveFileExW 的原始错误，显示临时源、目标路径和错误码；有界原生回执读取区分打开、元数据、内容读取、复核路径与文件身份；路径保护失败给出实际失败的祖先路径。未增加重试或放宽身份/重解析点校验，错误信息不包含草稿正文。
- 新增 2 项 Rust 故障测试：在真实只读属性或不允许删除的读句柄下，commit/abort 决定发布失败必须保持 pending 原字节、工作区和写入屏障，并清理本次临时文件；浏览器完成记录写入失败则保持原有不可逆 commit/abort，不得先放行编辑器。解除测试夹具保护后显式重试才成功。Windows 的 MoveFileExW 在目标不允许删除时也可返回 os error 5，不一定是 32；首次夹具错误地只预期 32，现接受该明确占用条件下的 5/32，原日志 recovery-fault-rust-first-code-expectation.log 保留，原字节/决定/清理断言不变。
- 新增 2 个真实 WebView2 启动场景：原生中止决定写入和 commit 后完成记录写入遇到实际只读事务文件，均确认具体 MoveFileExW/目标/error 5、原事务/副本/工作区不变、没有主编辑器或组件；保护仍在时点击“重试启动恢复”依旧失败关闭。只有夹具显式恢复文件属性、用户再次点击重试后才恢复既定数据与编辑器，不把持久 commit 反向改成 abort。扩展事务套件首轮 15 项通过，日志 recovery-fault-native-first.log。本轮没有在恢复实现中新增修改属性/ACL、预删原记录或静默重试。
- 广泛回归另有一次 tray-pending 启动等待超时和一次既有选择框未暴露自定义按钮，保留 recovery-fault-tray-startup-timeout.log、recovery-fault-system-custom-button-failure.log 及对应快照；不能据此推断两者就是历史拒绝访问的同一原因。
- 该超时暴露测试启动器异常清理无条件删除复用目录的缺陷：根目录由调用者提供时，失败仅停止该测试进程树、保留目录交还调用者；启动器自行创建的根仍自动清理。启动失败携带阶段、PID、退出状态、stderr 尾部及页面错误，事务失败快照保留这些结构化信息；缺失页面的两种目录所有权增加独立原生故障套件（npm run e2e:tauri:launch:failure）。原生启动恢复失败/中断也仅在实际当前会话被接受时输出有界诊断，纯托盘无主窗时不再只有等待超时而没有原生错误；状态机与放行条件不变。
- 更新诊断后自然捕获一次 commit 阶段 MigrationTransaction.json 的 MoveFileExW 替换失败，原记录仍为 pending、completed=false，原始事务和副本现场已保存为 recovery-fault-captured-commit-replace-denied.log 与 recovery-fault-captured-commit-state.json；失败步骤已定位到原子替换，不再只有无路径的“拒绝访问”。实际阻止该次替换的句柄/过滤驱动/权限来源尚未确定，不能宣称根因已修复。
- 对读句柄冲突进行独立验证：活动只读回执句柄会阻止替换并保持源/目标；释放后显式替换成功，旧文件身份必须被拒绝。曾验证仅增加 FILE_SHARE_DELETE 仍不能解决该 MoveFileExW 拒绝访问，日志 recovery-reader-delete-sharing-insufficient.log；该假设未被采纳，最终仍保持原来的 FILE_SHARE_READ、不共享写入或删除，不通过放宽读保护消除报错。复核读取路径时额外重检单硬链接与重解析点，新增硬链接在最终复核阶段也会失败关闭。
- 最终构建的故障、事务和谱系原生套件通过后，广泛回归出现共用主页面 QuickNote 持久化超时，日志 recovery-fault-app-note-timeout.log；完整检查另出现既有 Electron 无窗口颜色保存超时，日志 recovery-fault-headless-color-timeout.log。未修改对应业务、重试策略或放宽断言，单独复核结果另记录；不能把这些现象写成已修复。
- 只读和占用是受控同码故障，不是历史偶发错误来源已经查明的证据；间歇原因仍待现场证据定位，生产接管、反向回退、物理输入与全部发布门槛均未放行。

- 最终按当前构建逐套核验 16 套共 185 项原生/双运行时测试通过，无失败或跳过；包含扩展事务 15 项和启动失败所有权 3 项。共用主页面单独 10 项、完整 npm run check:silent 类型/197 项 Node/Electron 构建/4 项无窗口复核通过；前述失败日志保留，不能把单独通过当作已修复历史不稳定。最终结果见 recovery-fault-verification.json、recovery-fault-final-*.log、check-silent-recovery-fault.log。
- Rust 222 项、全目标严格 clippy、fmt、Release 条件检查、新增脚本语法及含未跟踪文件的 whitespace 检查通过；无工作区零 WebView 后台检查通过。接口清单与生产放行条件不因故障覆盖而升级；版本、默认 Electron 入口与生产目录保持不变，未提交、推送或发布。

## 工具箱文本输出与现有 Worker（P5 部分）

- 主窗口专属 toolbox-text capability 仅开放 toolbox_export_text 和 toolbox_copy_text，真实窗口身份、启动恢复与退出/维护状态在原生再次校验；prototype、组件与恢复页不获该权限。共用类型契约不变，renderer 使用 tracked invoke，暂停时拒绝新操作，完整工具箱仍未完成。接口清单首次将 ToolboxApi 的 exportText/copyText 标为 partial，其余图片/局域网接口继续 pending，不升级为生产可用。
- Rust 按 UTF-8 字节验证 40 MiB 上限，空文本、NUL、Unicode 与原始换行不转换、不加 BOM；超过明确失败，不截断。Windows 保存框提供 TXT/JSON 类型和默认 DustDesk-文本.txt，使用系统文档目录、原生覆盖确认与可取消会话，renderer 不能指定任意写路径。
- 将既有项目导出的安全发布内核提取为 export_file，文本与 XLSX/CSV 共用内部目录边界、普通文件/单硬链接/重解析点检查、唯一同目录临时文件、sync_all 和原子替换；目标被占用或写入失败保留原文并清理本次临时文件。复用原生选择排他与持有期，项目与文本不能同时打开保存框。主页面导航现在会取消该窗口的原生文件选择，避免旧页面请求继续占用选择会话。
- 复制复用现有 ClipboardService 的串行许可和原生 CF_UNICODETEXT 写入，使用工具箱独立 40 MiB 输出限制，不改变通用历史剪贴板的既有大小规则。实际调用前复核主窗和生命周期；系统占用明确失败，释放后用户可重试，复制本身不手工伪造历史记录。
- Rust 新增 UTF-8 上限、空/NUL/换行无 BOM 实际落盘、大小写不敏感内部目录边界及暂存后取消不发布共 4 项测试，既有项目导出占用/替换/清理测试继续复用相同发布内核。文本和项目均在暂存前及原子替换前复核原生选择会话、窗口身份和生命周期，取消时仅清理本次临时文件、不替换原文。首轮 16 项原生文本套件通过，验证真实 Electron 文件/剪贴板差分、40 MiB 精确边界、超限/类型拒绝、真实共享页面 JSON/Base64 Worker、角色隔离、并发选择与维护/导航/退出取消，日志 toolbox-text-native-first.log。
- 扩展全部 13 种 Worker 差分时一次通用自动化取消失败，日志 toolbox-text-worker-differential.log 保留。原脚本可能将文件列表里的文件夹编辑控件误判为保存框就绪，现同时等待实际保存/打开按钮、取消按钮和文件名编辑框；未延长等待或放宽业务断言，未就绪时输出具体控件诊断。扩展差分和其他原生选择套件继续复核，不能用首轮文本测试代表全部工具箱验收。
- 扩展原生文本套件 17 项通过：真实 Electron 页面依次运行并导出 13 种工具，真实 WebView2 同样运行并经原生选择保存，逐项文件字节相同，包含格式化/压缩、URL/Base64、正则、差分、去重、自然排序、统计和大小写转换；另验证坏 JSON 禁止导出、页面切换保留输入。日志 toolbox-text-worker-differential-final.log；报告 toolbox-text-native.json 保持 productionReady=false，不将跨运行时差分当成所有 Unicode/区域设置/物理 IME 行为均已穷尽。
- 完整串行回归最初在系统选择、便签背景和主窗回收三套失败，原始 toolbox-text-final-tauri-system.log、toolbox-text-final-tauri-note-images.log、toolbox-text-final-tauri-main-release.log 均保留。隔离原生诊断实际发现无过滤打开框的 Win32 Button（AutomationId=1）被 UIA 暴露为 ControlType.Pane，原脚本仅接受 ControlType.Button 而误报未就绪；同一 ID 的文件列表项则是无 HWND 的 UIItem，不可据 ID 单独认定按钮。证据见 toolbox-text-dialog-primary-probe.json 与 toolbox-text-dialog-primary-identity.json。
- 自动化就绪检查现按实际 Win32 Button 类、非零 HWND、AutomationId=1 与预期操作名称共同识别主按钮，仍同时要求取消按钮和真实文件名编辑框，不增加超时或放宽业务断言。快照及失败诊断保留主按钮实际 UIA 类型和类名，系统套件增加主按钮身份断言；修正后共用脚本的全部七套原生入口串行通过：系统 11 项、便签背景 12 项、主窗回收 15 项、项目导出 14 项、文本工具箱 17 项、草稿导入 22 项和 Shell 图标 7 项。日志 toolbox-text-dialog-final-*.log；此处只修正已证实的自动化类型判断，不宣称解决此前事务访问拒绝、托盘启动或延迟保存不稳定。
- 本轮最终证据为 24 套共 272 项原生/双运行时测试、226 项 Rust、全目标严格 Clippy、fmt 和 Release 条件编译检查通过；完整 npm run check:silent 通过类型检查、197 项 Node、Electron 构建和 4 项无窗口回归，均无失败或跳过。首次全检查曾再次出现既有颜色延迟保存超时，toolbox-text-headless-color-timeout.log 保留，最终未改业务或断言的重跑通过，不视为根因已修复。最终汇总含原始失败、修正后逐套日志、构建时序和相关源码 SHA-256，见 toolbox-text-verification.json；全检查见 check-silent-toolbox-text.log。
- 无工作区零 WebView 后台检查通过，但属于 Debug 隔离观察，不满足五轮 Release 性能门槛；含 201 个未跟踪文本文件的 whitespace 检查及脚本语法检查通过，仓库测试应用进程无残留，见 toolbox-text-process-cleanup.json。接口清单仍为 82/16 个成员、7 项 isolated-verified，工具箱仅两个文本输出接口 partial，productionReady=false；图片工具箱、截图、局域网、生产迁移与回退、物理交互及安装产物验收继续待办。分支、版本、默认 Electron 入口和生产目录不变，未提交、推送或发布。

## 图片工具箱资产与安全批量导出（P5 部分）

- 新增 image_store 与 image_api；主窗口专属 toolbox-images capability 仅开放多选、路径登记、二进制导入/读取、释放及开始/写入/结束图片批次共 8 个命令。原生复核真实主窗、启动恢复、退出/维护和页面 epoch；prototype、组件与恢复页不获权限，不授予通用文件系统或 Shell 权限。图片接口标为 partial，不升级生产放行状态；files/folder/transfer 仍明确拒绝，局域网授权另行迁移。
- Windows 专用 STA 多选仅筛选静态 PNG/JPG/WebP，复用系统选择排他与取消事件。路径登记只接受原生实际选择的精确路径，不继承父目录或相邻文件权限；每次读取重新检查普通文件句柄、路径重解析点、100 MiB 上限与图像头。导入原子登记，任一源无效不会留下部分授权；不以文件扩展名冒充实际格式，不新增模型或抠图服务。
- 图片字节通过 Tauri Raw 请求和二进制 Response 传输，不把整张图转为 Base64/JSON 数字数组；只有有界 UTF-8 文件名编码进入元数据头。保留原有单张 100 MiB、6400 万像素和动画拒绝规则，原生列表最多 10000 项，达到后明确提示释放，不静默淘汰有效资产。浏览器 File 粘贴路径使用受控字节导入，不调用 Electron 专属 getDroppedPaths；WebView2 原生外部文件拖入尚未接通。
- Rust 保留现有导出语义：用户选定目标后才创建唯一同目录暂存，逐张校验、create_new 写入、sync_all，单张原样发布，多张以 Stored ZIP 流式打包，Unicode 名称及同名自动编号保留，真实目标不覆盖。允许部分成功，空批次只清理；ZIP 自有临时名不与 renderer 提交的 output.zip 冲突。发布前重新检查暂存目录、普通源文件、页面 epoch 和生命周期，不接受 renderer 任意写路径或内部数据目标。
- 用户在共享页面取消处理时，保留已完成 Worker 结果并结束为部分 ZIP，其余输入仍在，可再次处理。原生维护/退出先取消选择并丢弃尚未发布的批次，保留源资产以便失败后重试；主页面导航/销毁和工作区恢复撤销旧资产。导航还释放精确文件选择授权，避免新页面继承上一页授权；成功导出只给实际输出与其目录增加原生打开授权。
- 新增 9 项 Rust 内核测试，覆盖静态格式/动画/畸形头/像素和 UTF-8 名称、精确字节上限、释放与 epoch、原子登记与源变化、单图同名不覆盖、ZIP 部分成功与重复名称、空批次、数量溢出、发布前取消和暂存文件被替换为目录。原生套件首轮完整 15 项通过（toolbox-images-native-sixth.log），包含角色拒绝、真实多选、文件/字节差分、覆盖确认、七组真实 Electron/WebView2 Worker、共享页面预览/导出/取消、维护、导航撤权及退出。
- 七组 Worker 保留原实现，覆盖 PNG/JPG/WebP、比例缩放、裁剪、文字/图片水印、圆形头像和 300 DPI 证件照；比较格式、尺寸、透明度与像素，PNG 严格相等，有损输出使用测试预先声明的最大通道差 8/平均差 2 界限，不事后放宽以求通过。该差分不代表所有字体、色彩配置、物理 DPI 或百万样本均已穷尽。
- 自动化过程的失败原样保留：toolbox-images-native-first.log 是未处理原生覆盖确认、人工取消隔离测试对话框后的失败；second.log 是同步 Invoke 等待确认导致的时序死锁；third.log 是将 Node 正常测试完成时的 signal 也误作取消；fourth/fifth.log 是任务侧栏按钮包含计数导致精确名称定位失配，实际页面导出已成功，失败阶段/页面正文/原生输出及截图已捕获。已补有界确认操作、并发驱动同一保存动作的确认、正常完成区分和稳定导航定位，不修改产品行为或放宽业务断言掩盖这些自动化问题。此前事务替换拒绝、托盘启动及延迟保存不稳定仍保持未解决。
- 最终构建后串行覆盖 25 套共 287 项原生/双运行时测试，最终选用的逐套结果均无失败、取消或跳过；图片 15 项包含 8 MiB Raw 二进制逐字节往返、共享页面预览/导出、真实取消后的部分 ZIP，以及维护/导航/退出。Rust 235 项、全目标严格 Clippy、fmt 和 Release 条件编译检查通过；完整 npm run check:silent 通过类型检查、197 项 Node、Electron 构建与 4 项无窗口回归。证据见 toolbox-images-verification.json、toolbox-images-final-*.log、check-silent-toolbox-images.log；原生精确 100 MiB 往返和长期大图资源尚未证明，不以 Rust 边界测试替代该门槛。
- 首次完整串行回归有两套失败：文本保存选择器缺少就绪控件、主窗回收场景未找到实际文件菜单，分别保留在 toolbox-images-final-tauri-toolbox-text.log 与 toolbox-images-final-tauri-main-release.log。未修改相应产品、脚本或断言的独立重跑分别通过 17/15 项，日志 toolbox-images-unchanged-*.log；仅据此记录可重复验证，不宣称找出或修复两次首次失败的根因。原有其他不稳定也不因此升级状态。
- Debug 隔离零 WebView 后台检查、205 个未跟踪文本文件及已跟踪修改的 whitespace、脚本语法与进程清理检查通过；后台观察仍不满足五轮 Release 性能验收。接口仍为 82/16 个成员、7 项 isolated-verified，工具箱 10 项 partial、6 项局域网接口 pending，productionReady=false。分支保持 codex/tauri-migration，版本、默认 Electron 入口和生产目录不变，未提交、推送或发布；原生外部拖放、完整截图/局域网、生产迁移回退、物理交互和安装产物继续待办。

## 截图公共接口与实际窗口角色审计（P5 部分）

- `selectScreenshotRegion` 的当前共享编辑器调用只有矩形参数；Tauri 的实时框选层已通过 `ScreenshotRuntime.selectRegion` 调用 `screenshot_overlay_region/source/adopt`，不是调用主适配器中的同名占位。公共清单现在将该能力记为 partial 并记录实际角色/源文件；主窗不能以此读取或替换其他覆盖层的来源。物理混合 DPI、多屏、长期资源释放及安装产物仍待验收。
- `readPinnedScreenshot`、`savePinnedScreenshot`、`controlPinnedScreenshot` 和两项贴图订阅由 `PinnedScreenshot` 通过传入的 `PinRuntime` 使用，Tauri 对应 `runtime/pin.tsx` 的自身窗口命令和私有 Channel；主适配器中的拒绝或无事件占位不代表贴图 UI 未接通，也不能作为扩大主窗权限的理由。
- `cancelScreenshotOverlay` 在 Electron 覆盖层使用完整 preload；Tauri `runtime/capture.tsx` 直接取消自己的原生覆盖层。`submitScreenshotOverlay`、`onScreenshotOverlaySource`、`saveScreenshot`、`pinScreenshot` 未发现当前 React 业务调用，仍保留旧 Electron 兼容声明/实现，不把无调用的旧别名算作已经实现的 Tauri API。`onScreenshotCaptured` 仍由 App 订阅 Electron 旧 data URL 事件；Tauri 的真实交接走 `onScreenshotDocument`、原生凭据和有界二进制来源。
- `scripts/migration-inventory.mjs` 为这些公共名称增加 `tauriRouting`，保留 legacy 项的 pending 状态，区分真实窄适配器和主窗占位。此次审计没有扩展原生权限、改写 UI 或新增截图副作用；此前原生测试证据和已记录的托盘/持久化不稳定不据此升级为已解决。

## Rust 局域网协议与旧身份/续传状态内核（P6 部分）

- `src-tauri/src/lan` 是独立库内核，尚未连接桌面入口或网络监听。保留协议 1 及 UDP 45892，清单字段、SHA-256 指纹和双方排序后生成六位配对码的算法；文件名按原 Windows 规则检查，包含保留名称、重复/大小写、父级文件冲突、10000 项、JS 安全整数、255/2048 UTF-16 单元和 10 MiB UTF-8 文本限制。续传回复检查令牌、数量、偏移、完整状态和摘要，前缀 SHA-256 以最多 64 KiB 缓冲读取已经授权的句柄，不读取偏移以外的数据；服务层仍须验证原文件与完整摘要，不能仅凭此校验发布文件。
- 只读加载已有 `identity.json`：核对原证书 DER 的 SHA-256、RSA 私钥解析及证书/私钥匹配，拒绝无法核验的密钥。身份类型不提供 Debug/Serialize；私钥不进入报告或日志。缺失身份不创建目录或生成替代身份，损坏/指纹变化/密钥不匹配均保留原文件并失败。新增 Rustls/ring 用于此核验和后续 TLS，不意味着服务已具备 TLS 授权。
- 只读加载已有 `state.json`，保留 peer、manifest、source、mtime、sources、staging、files、原目录/映射及未知本地字段；重启将非终态暂停、清零速率并移除 token/controller/running，完成/取消保留。编码不持久化文本任务；发现包不能替换已配对 ID 的固定指纹。状态中的路径仅作为旧数据保留，不能授权读写或清理；后续服务必须复核实际路径/句柄、重解析点和目录身份。此内核不落盘、不移动/删除部分文件、不解析生产路径、不接管旧身份目录。
- 对畸形输入采用明确收紧：IPv4 末尾空白不沿用旧正则 `$` 的容忍；错误任务身份、重复任务 ID、越界的完成文件索引阻止整份状态加载；未知本地扩展字段在状态中保留，网络 offer 只发已知字段，不传本地扩展/来源路径。这些不是对旧程序缺陷已经修复的声明。
- `npm run test:tauri:lan:compat` 使用仅开发的 Rust `examples/lan-compat.rs` 与两个 Electron LAN 服务模块；模块在同一个 Node 测试进程中运行，不是两个 Electron 应用。全部目录位于临时根、只监听回环且关闭 UDP。先由真实发送任务等待确认并暂停，验证迟到确认不创建接收任务；随后经实际 HTTPS 形成已校验的完整/空文件、空目录与 1 MiB 部分文件。Rust 读取两端真实旧身份和状态，对全部原始输入字节摘要复核无修改，重编码到新文件；测试只将临时两端状态替换为该编码，再由旧模块双端恢复、刷新端口、重新确认接收并从前缀继续，验证最终 SHA-256、已完成文件/空目录和同名不覆盖、临时目录清理。身份、证书、私钥和信任保持不变，不重新配对。
- 该项为 1 项集成测试，包含 741 份清单、252 组配对码、16 个 IPv4、8 份发现包、6 份续传回复、3 类错误身份和 3 份前缀摘要；另有 13 项 Rust 内核单测。报告 `artifacts/tauri-migration/lan-core-compat-verification.json` 明确网络两端均由 Node 测试进程执行旧 Electron 模块、Rust 范围为协议/只读状态内核，并记录源文件/锁文件和实际开发驱动 EXE 指纹，不包含临时私钥。原临时身份在测试结束后删除；报告不能代替 Rust↔Electron 或 Rust↔Rust 服务互通。
- 当前增量的 `check:silent`（204 Node 测试、生产构建、4 项无窗口回归，无跳过）、292 项 Rust 测试（原 279 + 新 13）及 all-target 严格 Clippy 已通过。最终验证日志另行保留在 `artifacts/tauri-migration/lan-core-*`，原有截图检查点报告不改写为本次源文件的整应用认证。尚未为这个未接桌面入口的库增量运行新的 Tauri 窗口套件，不借旧窗口报告宣称新增服务已验证。
- Rust 异步 HTTPS/UDP、初次/固定指纹 TLS 验证策略、原生配对/接收确认、任务流与安全落盘、取消/维护/退出、公共 lan* 接口和共享 UI、Rust↔Electron/Rust↔Rust 双向中断重启及两台物理电脑验收仍未完成。版本仍为 1.0.2、默认 Electron、未提交/推送/发布，也未开放生产数据；整体迁移仍未完成。

## Rust HTTPS 双向传输层与指纹/签名校验（P6 部分）

- 新增 `src-tauri/src/lan/tls.rs` 与 `transport.rs`，仍为独立库，不在 Tauri 启动时自动监听或开放 IPC。复用已经加载并核验的原证书/私钥；自签设备通过完整证书 DER SHA-256 和握手签名证明私钥持有，不依靠公共 CA 或 CN/主机名匹配替代设备配对。Rustls 的 TLS 1.2/1.3 签名验证实际调用密码库，非返回空成功；证书解析失败、额外证书链或大于 64 KiB 的证书拒绝。禁用客户端和服务端会话恢复，避免握手恢复跳过更新后的身份策略。
- 出站无固定指纹仅能由 `Client.discover` 发起一次 GET `/hello`，结果返回同一 TLS 连接的真实指纹，不自动配对或写信任；`hello/json/upload` 对全部后续连接固定该指纹，发送 HTTP 内容前失败。设备地址只接受原有局域网 IPv4 范围并转换为数字 SocketAddr，不进行页面指定域名解析；不跟随重定向。固定连接的 hello 同时复核原设备 ID，响应 JSON 有界读取，错误正文截断到 4096 字符。
- 服务端强制请求并验证客户端证书的握手签名，再从实际连接构造 Peer 地址/指纹和请求取消令牌。GET `/hello` 与 POST `/pair` 可进入对应确认处理器；POST `/offer/file/complete/pause/cancel` 必须先通过当前原生处理器的信任查询。拒绝未知路径、绝对 URI 和错误方法；旧协议对 pause/cancel 的宽松方法处理在此收紧为 POST。传输层的分发检查不代替处理器内的配对批准、任务令牌、设备/任务生命周期或副作用前再次核验，库未给任意页面来源授权。
- 默认连接上限 32，TCP 连接/TLS 握手/请求头分别有 15 秒限制，空闲限制 120 秒；读写进展共同重置空闲时钟，不能用整个传输总时长代替空闲。HTTP 头最多 64 项/64 KiB，JSON 最多 64 MiB；配对处理器使用 4096 字节读取上限。`reader_body` 每帧最多读取 64 KiB 并由网络消费提供背压，调用者仍须先授权源句柄、限制声明大小并负责源文件和完整摘要核验。传输层不自行打开网络传来的路径或发布接收文件。
- 显式取消与普通请求完成都会中止并等待本地 HTTP 连接驱动；直接丢弃请求 Future 仍有 RAII 中止，但完整服务必须另行持有并等待请求/文件任务。服务停止取消所有连接、关闭监听并等待连接任务退出；请求被断开/停止时其取消令牌失效，等待中的处理 Future 被丢弃。此处尚不代替磁盘写入、阻塞读任务、原生维护/退出协议和持久决定收尾。
- `npm run test:tauri:lan:transport` 构建仅开发的 Rust `examples/lan-transport.rs`，在临时身份、回环端口与 Node 进程运行旧 Electron LAN 模块间使用实际 TLS/HTTPS。Rust 出站通过旧模块的真实配对回调，发送 Unicode 文本 offer，并流式上传 8 MiB 文件，旧接收模块校验 SHA-256 后发布文件和空目录；旧模块也实际连接 Rust 的 hello/pair。Rust 入站的文件处理器只计算流摘要，不发布文件或核验业务任务令牌，配对决定/信任存储是明确的开发夹具，不能算作完整 Rust 接收服务或原生确认 UI。
- 同一集成测试覆盖 TLS 1.2/1.3、缺少客户端证书、未信任/撤销指纹、错服务端指纹在 HTTP 前失败、固定指纹但设备 ID 改变、错误方法、过大配对 JSON、重定向/损坏 JSON/停滞响应、握手/请求头超时后的容量释放、持续进展超过空闲时长仍完成、双向请求取消与停止等待。另用实际 TCP 代理分别翻转 TLS 1.2 ServerKeyExchange 和客户端 CertificateVerify 签名的一字节，证书/指纹保持原样，确认两端拒绝握手且未进入 HTTP 处理器；不以单测断言代替这两个实际签名验证。
- 首轮取消夹具在本地取消返回后、远端响应尚未观察关闭时立即释放确认，真实旧模块创建了接收任务，原失败日志 `lan-transport-native-first.log`、原报告与事件位于 `lan-transport-first/`，不删除或改写为通过。现在取消会等待本地驱动结束，夹具另通过旧服务器的只读 response-close 监听确认远端连接实际关闭后再释放批准；两端关闭/迟到批准与后续测试通过。此结果限定为已经关闭的请求，不能宣称改变或修复旧程序在远端尚未观察断开时的确认时序。
- 验证报告 `artifacts/tauri-migration/lan-transport-verification.json` 标记 verified=true、productionReady=false、migrationComplete=false，记录 14 项源码/锁文件指纹和实际 Rust 驱动 EXE 摘要；开发日志不包含私钥。当前 `check:silent` 为 204 项 Node、生产构建和 4 项无窗口回归，Rust 为 295 项（原 279 + 库 16），严格 Clippy 和 release cargo check 已通过；最终日志按 `lan-transport-*` 保留，不把历史截图窗口报告当作本次新服务验证。
- 下一步仍是完整 Rust 任务/配对服务、可信状态安全落盘、源文件/目标目录/续传验证、UDP 发现与保活、身份首次创建、原生确认和主窗/纯托盘的取消维护退出接入、共享 lan* API、应用级 Rust↔Electron/Rust↔Rust 双向中断重启、物理双机/防火墙和发布门槛。默认 Electron 与版本 1.0.2 保持，未提交、推送或发布，未接管生产数据；整体迁移仍未完成。

## Rust 接收任务、安全发布与真实重启续传（P6 部分）

- 新增 `lan/receiver.rs`，通过既有真实双向 TLS/HTTPS 层处理配对、文本/文件 offer、file、complete、pause、cancel；仍是独立原生库，未在 Tauri 启动时自动监听，也未开放任何页面 IPC。宿主通过 `Approvals` 提供配对/接收决定；开发驱动 `examples/lan-receiver.rs` 必须由 stdin 明确批准，不以测试夹具代替原生弹窗或页面身份授权。
- 配对信息取自实际 TLS 指纹及连接地址，六位码由双方证书计算；持久化成功后才更新当前信任缓存。随机 32 字节令牌仅保存在内存，按真实指纹、任务 ID 和恒定时间比较鉴权；拒绝重复查询参数、无效序号/偏移、过期令牌和同时写入同一任务。旧任务恢复必须重新确认保存的原接收目录，不能用默认下载目录静默替代；旧清单变化、已取消任务、完成文件变化均拒绝。
- 新增 Windows `lan/files.rs`，逐级打开普通本地盘目录并持有拒绝删除共享的祖先句柄，拒绝目录联接、其他重解析点、多硬链接部分文件、父级路径和备用数据流。部分文件以独占普通文件句柄追加，逐帧最多 64 KiB，核对实际长度、声明上限及取消；完整大小与 SHA-256 校验后，直接对同一源文件句柄重命名到已固定父目录，禁止覆盖，同名按旧后缀规则避让。固定句柄用于实际操作，非仅先检查路径再按路径重新打开。
- 新增 `StateStore`，持有本服务状态所有权和原子临时写入/替换，失败保持原磁盘及已提交内存；拒绝损坏/多链接旧状态，不预删正式文件。已取消的状态提交在替换前再次检查；文本任务、令牌和执行器不写入重启状态，未完成任务重启为暂停。`.rust-owner.lock` 只排除 Rust 服务双开，旧 Electron 不认识该锁，不能替代生产 profile 的跨运行时进程所有权门槛。
- 新增 `lan/publication.rs`：完整同步/校验部分文件后先持久化 `rustPublicationV1` 意图，再按源句柄无覆盖重命名，最后保存文件映射并清理意图。重启必须同时核对候选路径、原生文件身份、大小和摘要；相同内容但不同身份的文件也不会被认领。文件索引用固定十六进制字符串编码，避免经过 JavaScript JSON 时丢失 64 位精度。若映射保存失败，已发布文件和意图保留，后续恢复补齐同一映射；旧 Electron 不恢复该原生意图，未完成意图的任务仍属于生产回退待解门槛。
- 接收磁盘操作由服务拥有的单一阻塞工作线程串行执行。HTTPS 与进度读取保持异步；有界帧通道提供背压，取消/暂停先撤销对应会话并取消其文件工作，再等待安全清理和保存。停止同时拒绝新操作、撤销会话、取消文件与待确认请求，宿主须关闭并等待 HTTPS 监听，再等待文件线程退出。测试在 `Receiver` 对象仍存活时重新打开原目录的 DELETE 访问，确认停止后目录固定句柄和 profile 状态锁已释放。当前多个文件任务仍共享串行磁盘线程，不能据此宣称并发传输体验已与旧版一致。
- `test:tauri:lan:receive-storage` 构建实际 Windows Rust 驱动，分别在意图落盘和重命名后强制结束进程，再启动新进程恢复；验证无重复发布、同名内容不覆盖、同内容不同身份拒绝、真实目录联接/硬链接拒绝及取消。原生故障测试只操作随机临时 profile/下载目录，报告 `lan-receive-storage/verification.json` 含 7 组验证；另有 14 项新的文件/发布 Rust 单测。
- `test:tauri:lan:receiver` 使用实际 Rust 服务和在 Node 测试进程中运行的旧 Electron LAN 发送模块。验证实际配对及 Unicode 文本；旧模块建立真实发送任务，在 Rust 接收 8 MiB 文件的 1 MiB 前缀后强制结束 Rust，再重建双方服务，经新确认后由旧发送模块完成续传；已完成/空文件跳过、空目录、同名保留、最终 SHA-256 和暂存目录清理均核验。这是实际 Rust↔旧模块服务互通，仍不是两个桌面应用或两台物理电脑验收。
- 同一服务套件通过真实状态文件共享冲突验证批准后保存失败不授信、恢复写权限可重新批准；覆盖原目录确认不符、错误/重复令牌参数、错误偏移、坏摘要后的精确部分文件删除/进度归零与重试、暂停时取消并等待活跃写入、未知暂存文件保留。完成时清理已成功而终态写盘失败后，重新确认会安全重建固定暂存目录、校验已完成映射并重试；不会因暂存目录已不存在而堵死续传。最终停止同时保持一个待确认 offer 和一个实际未结束上传，验证暂停前缀持久化、无令牌、监听关闭、工作线程等待和所有权句柄释放。
- `check:silent` 为 204 项 Node、生产构建和 4 项无窗口回归，无跳过；完整 Rust 309 项、全目标严格 Clippy、release cargo check、fmt 和 4 项串行 LAN 集成（新存储/新服务/旧状态兼容/原 HTTPS 传输）通过。最终报告 `artifacts/tauri-migration/lan-receiver-final-verification.json` 校验源码/锁文件在验证前后不变、各集成报告输入一致及四个实际开发驱动 EXE 指纹；`productionReady=false`、`migrationComplete=false`。新增服务套件 10 组、存储 7 组；首次 Win32 相对重命名的 2 项单测失败保留在 `lan-receiver-files-first.log`，改为完整目标路径并继续固定祖先后通过；首次严格 Clippy 的测试初始化风格错误也保留，未隐藏失败或当作功能缺陷修复。
- 下一步为原生发送任务、UDP 发现/保活、首次身份创建、原生确认/角色权限、主窗及托盘生命周期和公共 lan* API/共享 UI，再完成桌面应用级双向续传、物理双机/防火墙、生产所有权和回退、Release 性能及真实安装/绿色 ZIP 验收。接收路径暂限普通本地盘，尚不支持 UNC、网络映射盘或重解析接收目录；旧程序若中断在完成文件与部分文件暂时共用硬链接的窗口，当前会保守拒绝多链接文件，仍待按原生身份安全整理，不能计为已兼容恢复。默认仍为 Electron、版本 1.0.2，未提交、推送、发布或接管生产数据；整体迁移保持进行中。

## 已验证的基线

- 开始迁移前的 npm run check:silent 通过，无跳过。
- 新增契约测试后重新运行，116 项 Node 测试、4 项无窗口测试全部通过，无跳过；日志在 artifacts/tauri-migration/electron-check.log。
- node tests/memory-regressions.mjs、node tests/widget-linkage-native.mjs、node tests/screenshot-regressions.mjs 通过。
- 本次 Electron 普通进程、托盘加一个任务组件测得 75.29 MiB 专用工作集；这是单次环境测量，不是正式五轮发布性能门槛。
- Tauri 原型真实 WebView2 回归验证窗口状态、越权拒绝、选区 PNG 尺寸、框选/Esc/Enter、失败重试、贴图与正常退出；当前机器为单屏 1920×1080、100% 缩放，不能代表混合 DPI。
- 原型隐藏启动不创建 WebView2 子进程，调试构建可能附带 conhost；结果在 artifacts/tauri-migration/background-prototype.json。
- P1 阶段的 Debug 和 Release 构建均曾通过原生回归；当时 Release 隐藏启动实测仅应用进程，无 conhost 或 WebView2 子进程。新增存储基础现有 20 项 Rust 单元测试及 clippy 全目标零警告检查通过；不据此前原型结果推断完整服务的 Release 性能。
- 框选像素验证使用屏幕颜色标记对照，确认遮罩和边框没有进入结果；编辑器导出验证实际标注颜色像素，而非仅比较 PNG 编码差异。
- 已修正 Tauri 默认全局事件订阅导致主编辑器接收贴图更新并重建的问题，截图事件按 WebviewWindow 标签订阅。
- 隐藏原型没有完整业务服务，其低内存不能与全功能 Electron 等同，也不代表 20% 降幅目标达成。

## Rust 发送任务、并发状态所有者与双端重启（P6 部分）

- 新增 Windows `lan/sources.rs` 和 `lan/sender.rs`，本地文件选择/已保存任务才可进入源扫描，不接受入站清单提供的本地路径。迭代遍历最多 10000 个文件和目录，固定普通本地盘祖先与源句柄，拒绝整个盘符、目录联接、重解析点、硬链接和不安全名称；保留顶层同名后缀、空文件/目录、Unicode 路径及旧格式精确浮点 mtime。新增 `rustSourceV1` 保存原生文件身份、原始 FILETIME 和大小，64 位文件索引用十六进制字符串，公开 offer 清除源路径与私有字段。
- 准备时计算完整 SHA-256，发送前、接收确认后均重新打开并验证源身份、大小、时间和摘要；前缀校验与流式上传共用同一独占源句柄。所有续传偏移/摘要/完成标记和随机令牌先校验，空前缀也核对摘要；实际上传只发送后缀，但源工作线程仍验证完整文件。帧为最多 64 KiB、有界两帧通道，HTTP 驱动和阻塞读工作都由任务拥有并等待，暂停/取消先取消并等待工作，再提交本地状态及请求远端控制。
- 发送/接收共用已有 `StateStore`，不新建竞争的状态写入器；任务准备、检查点、终态和失败均经同一状态工作线程提交。直接连接先观察真实 TLS 指纹/固定设备 ID，明确本地批准，再请求远端批准，最后持久化本地信任。重连取最新相同身份端点，并在 Preparing 提交保留该端点，修复恢复过程中被旧任务端口覆盖的连接失败。文本和会话令牌仍不进入重启状态。
- 接收状态线程不再等待整个网络上传：每个任务以实际独占许可保护文件工作，流写入在受监督的阻塞工作中执行，完成后提交发布/状态。暂停/取消等待该任务的许可，停止禁止新工作并等待所有工作，快照/新 offer/其他任务不被停滞的文件流卡住。独立进度覆盖不会被无关状态提交重置；真实双向并发已通过，但有限的完整摘要、发布与状态提交仍可能暂时占用单一状态线程，未作性能结论。
- 任务在控制操作等待期间继续登记，丢弃等待 Future 不会把工作从服务所有权中移除；重复等待保留原始失败结果。写盘失败保持原磁盘/已提交内存，失败无法落盘时以运行期错误覆盖显示，仍可在恢复权限后重试。控制提交或远端确认失败时保留令牌供重试；远端未确认与本地已暂停分开返回，不能把无效成功体算作已确认。服务停止仍须由宿主同时停止 HTTPS 监听，尚未接入桌面维护/退出协议。
- 扩展仅开发的 `examples/lan-receiver.rs`，通过显式 stdin 连接/发送/控制与批准运行两个实际 Rust 服务进程；没有新增页面 IPC、自动批准或生产目录入口。`test:tauri:lan:sender` 使用真实旧 Electron LAN 模块在 Node 中接收，实际发送 Unicode 文本和 8 MiB 目录，在文件前缀达到 1 MiB 时终止发送进程并重建旧接收服务，再以相同身份、新端点和新批准完成续传、空目录、空文件、完整文件跳过及摘要/暂存清理。
- 同一发送专项以两个实际 Rust 进程互相配对、同时发送 2 MiB 文件，观察每个进程内发送/接收状态重叠并核对最终文件；另在实际部分上传时强杀双方进程，再启动双方、重连新端点和重新批准原目录，完成 8 MiB 前缀续传。这些是回环网络服务验证，不是两个桌面应用或物理双机/防火墙/断网验收。
- 发送专项共 14 组：还覆盖固定指纹但 ID 变化、确认期间源变化、真实缺失源/硬链接/目录联接、实际固定指纹 HTTPS 上七种坏令牌/偏移/完成/前缀回复在上传前失败、Windows 状态文件共享冲突阻止新任务及终态/控制保存、恢复写权限后的暂停/发送重试、无效远端暂停确认的重试，以及实际上传中的暂停、取消和停止。停止后重新命名源目录并以 DELETE 访问打开接收/profile 目录，核验独占源、祖先固定和状态锁释放；报告记录实际进程退出和 EXE 摘要。
- 三项新源扫描单测和三项发送监督/流单测覆盖源固定、旧字段兼容、摘要/后缀，以及等待/停止 Future 被取消后仍可再次回收同一工作。接收专项新增停滞上传期间的另一任务发布/状态/进度验证，现为 11 组；之前接收阶段的串行流限制已由本节变更替代，旧 `lan-receiver-final-verification.json` 保留为历史证据。
- 首轮发送重启联调暴露旧端点恢复错误，日志/报告为 `lan-sender-native-first.log` 与 `lan-sender-first-*`；第二轮为旧模块内存任务先于异步磁盘提交的测试竞态，保留 `lan-sender-native-second.log` 与 `lan-sender-second-*`，改为等待实际已持久任务。扩展专项首轮的错误摘要夹具把数组交给 Node hash，导致连接失败，原日志/报告保留为 `lan-sender-expanded-first-*`；现在明确检查续传错误文本和 HTTP 上传零调用，不能以任意连接失败算作回复校验通过。
- 旧模块在原生服务完全停止后读取/重写发送清单，精确 mtime 和 `rustSourceV1` 结构保持；此项只证明数据结构往返。旧版公开发送清单仅移除 source，不清理新增原生字段；旧版也不能恢复未完成原生发布意图，不能据此直接交还活动任务。生产接管、跨运行时排他所有权、反向转换/回退和旧硬链接发布崩溃间隙仍待解决。
- 最终复核入口为 `artifacts/tauri-migration/verify-lan-sender.mjs`，顺序执行 `check:silent`、全部 Rust/Clippy/release check/fmt，再串行执行发送、接收存储、接收服务、旧状态兼容与 HTTPS 传输五个套件；结果写入 `lan-sender-final-verification.json` 并校验前后源码、集成输入和实际驱动摘要。完整迁移仍未完成；UDP 发现/保活、首次身份创建、真实原生确认/窗口权限、共享 lan* UI、维护/退出、物理双机、生产回退与发布性能/安装门槛继续保留。
- 本阶段最终报告 `lan-sender-final-verification.json` 已 verified=true、productionReady=false、migrationComplete=false：204 项 Node、4 项无窗口回归、315 项 Rust、严格 Clippy、release check 和 fmt 全部通过且无跳过；五个串行集成为发送 14、接收存储 7、接收服务 11、旧状态 7、HTTPS 传输 12 组。复核前后 435 项源码/锁文件、27 项集成输入及实际开发驱动摘要一致；`lan-sender-process-cleanup.json` 核验匹配的测试进程为零并记录到总报告。版本仍为 1.0.2、默认仍为 Electron，未提交/推送/发布，整体目标保持进行中。

## Rust UDP 发现、保活与自动端点续传（P6 部分）

- 新增 `lan/adapters.rs`、`lan/peers.rs`、`lan/discovery.rs`，仍为独立原生服务库，由宿主在 HTTPS 绑定后明确启动，不在桌面入口自动监听。默认保持 UDP 45892、5 秒公告/保活周期、3 秒单次探测上限和 20 秒在线窗口；配置仅用于可信原生宿主，开发驱动使用回环临时端口与较短测试时长，不开放渲染层网络配置权限。
- Windows 通过只读 `GetAdaptersAddresses` 枚举运行中的普通私有 IPv4 适配器和前缀，计算广播地址，附加全局广播并去重；动态刷新在有所有权的阻塞工作中进行，停止等待实际工作结束，不启动 PowerShell/Node 或修改防火墙。专项把实际枚举地址与独立 Node 网络接口结果逐项核对，并核对前缀计算；物理多网卡、广播到达、防火墙与睡眠恢复仍需另验。
- 公告保持旧协议字段和 2048 字节上限，使用数据报真实源 IPv4，不接受载荷提供的 address。广播仅更新候选/在线线索，不能改变持久信任、弹出自动批准、发送文件或为未配对线索启动 HTTPS 探测。未知线索最多保留 256 项，过期清理，接收最多处理每秒 256 包；到额后等待下一窗口，避免持续丢包忙循环。已配对身份单独保留，线上状态使用单调时钟到期，墙钟仅用于兼容 lastSeen 字段。
- 已配对端点变化仍固定原设备 ID/证书指纹，TLS 成功且 hello 身份一致后才算有效保活；错误证书在 HTTP 前拒绝，错误 ID 不刷新在线时刻。周期性相同端点公告不会作废有效探测，端点变化会更新版本，旧端点的迟到成功不能覆盖新端点。探测任务同时最多 8 个、同一指纹不重复并以最后调度时间轮转；服务拥有所有任务，停止取消并等待 HTTPS 驱动收尾，拒绝迟到结果。
- 接收/发送状态线程现在共享该设备目录；只有持久配对成功才加入已配对目录，出站创建/恢复从最新相同身份候选取端点，仍在实际发送前固定 TLS 及 ID 复核。重启只从仍被信任的文件任务恢复端点候选，先视为离线，再主动验证；不是把所有历史可信指纹恢复成在线设备，没保存端点的纯配对仍需发现或手动连接。广播和保活不新增状态写入器、不把网络线索直接写入重启文件。
- UDP 绑定失败明确显示“设备发现受阻…可手动连接”，HTTPS 服务和已配对保活继续；运行期 UDP 收包失败也停止有故障的 UDP 收包而保留保活。宿主可等待发现停止后重启，完整接收服务停止会同时等待发现、适配器工作、发送及接收文件工作；不把 UDP 失败当作全部传输关闭，也不吞掉服务工作异常。
- `test:tauri:lan:discovery` 扩展实际 Rust 驱动，以隔离身份/下载目录、真实回环 UDP 和固定证书 HTTPS 验证 10 组行为：真实公告及适配器参考、旧格式线索/无授信/坏包/过期、手动批准后无 UDP 保活、旧端点迟到回复、错证书与 ID、真实 UDP 地址占用下继续保活、重启自动学新端点续传、双方原生公告、发送进程重启后的无 UDP 探测，以及实际未结束保活期间停止和端口/目录锁释放。旧 Electron 模块在 Node 中运行，受控 HTTPS 服务用于错误/迟到回复；确认仍来自显式开发输入，不代表桌面应用或物理两机验收。
- 自动续传场景先通过节流代理实际上传 8 MiB 文件，在接收端部分文件达到 1 MiB 后终止该 Rust 进程，确认发送失败；重新启动接收进程并由其自己的 UDP 服务公告新 HTTPS 端口，发送方只点击继续，经原目录新批准后完成前缀校验、最终 SHA-256 和新端点持久化。另正常重启发送进程、禁用 UDP且不手动连接，验证原可信文件任务端点经实际 HTTPS 探测重新出现，已完成任务不被重启。
- 新增 7 项 Rust 单测覆盖广播掩码/默认协议时序、未知线索限额与单调过期、已配对指纹固定、端点版本/同端点探测、重启离线候选，以及有界公平调度；没有用单测替代上述实际进程、UDP 或 TLS 验证。新直接依赖 `socket2` 已是既有锁文件中的依赖，用于非阻塞 IPv4 UDP 与兼容地址复用；没有引入 Node/OpenSSL 辅助程序。
- 本轮首次 `check:silent` 在 `renderer-headless.mjs:158` 等待便签正文 `HEADLESS_NOTE` 保存超时，保留 `lan-discovery-check-silent-first.log`；未改便签业务或断言，完整重跑通过，不据此宣称既有间歇保存问题已修复。最终复核脚本 `artifacts/tauri-migration/verify-lan-discovery.mjs` 会保留原失败摘要，再按当前源码运行常规检查、Rust/Clippy/release check/fmt 和六个串行 LAN 套件，校验前后源码、报告输入与实际驱动摘要。
- 首次最终复核的常规检查、322 项 Rust、严格 Clippy、release check、fmt 和发现专项已通过，但发送专项未观察到旧接收端部分文件；原始现场未采集实时任务状态，不能追溯原因，保留 `lan-discovery-sender-native-first-final.log`、`lan-discovery-sender-first-*` 与 `lan-discovery-first-final-verification.json`。仅补充实时失败信息的重跑通过，未将其写成原因已修复。现在两个中断夹具可在实际加密 TCP 字节流达到 2 MiB 后明确停流，确保先观察实际部分文件再结束进程，发送专项还在失败时保留双方实时/磁盘状态；仍核对 1 MiB 部分文件、非完整文件和最终摘要，未加长等待或降低断言。
- 此后只改动发送/发现两个独立网络集成夹具，复核入口用 `--reuse-static-from=artifacts/tauri-migration/lan-discovery-first-final-verification.json` 明确比对覆盖输入，全部 Rust、产品、单元/无窗口测试及构建配置必须与已通过的静态检查一致才复用日志；六个 LAN 专项仍全部重新串行执行。报告记录原始未定因失败、复用原因和日志摘要，不以历史通过覆盖当前源码不匹配。
- 最终 `lan-discovery-final-verification.json` 已 verified=true、productionReady=false、migrationComplete=false：204 项 Node、4 项无窗口回归、322 项 Rust、严格 Clippy、release check、fmt 通过，无跳过；六个 LAN 套件重新串行通过发现 10、发送 14、接收存储 7、接收服务 11、旧状态 7、HTTPS 传输 12 组。前后 439 项源码/锁文件、31 项集成输入和实际开发驱动摘要匹配，`lan-discovery-process-cleanup.json` 匹配测试进程为零；实际停止后的 UDP 端口重绑定及目录/profile 句柄释放已在专项中核验。原始两次失败保持未定因，未将当前通过写成根因修复。
- 首次设备身份生成仍未实现：本阶段仍由显式隔离夹具生成旧格式 RSA 身份，再由 Rust 验证/复用；缺失不静默生成，损坏不覆盖。下一步继续首次原生身份创建、真实原生配对/接收确认、角色/窗口权限及公共 lan* 与共享 UI，随后完成维护退出、物理网络、生产所有权/回退和发布门槛。默认 Electron、版本 1.0.2 保持，整体迁移仍未完成。

## Rust 首次设备身份创建（P6 部分）

- 新增 `lan/identity.rs`，通过 Windows CNG 的未命名临时 RSA 密钥生成 RSA 2048 / SHA-256 自签名证书，使用 rcgen 编码而不手写证书 DER。保留旧版 CN `DustDesk Local Transfer`、3650 天有效期、UUID 与 `id/cert/key/fingerprint` JSON 结构；私钥为标准 PKCS8 PEM，旧模块可直接加载。没有调用 Node/OpenSSL、注册证书、创建持久 CNG 密钥或选择生产路径。
- 首次创建必须由可信宿主持有 `StateStore` 的独占 Rust 所有权后明确调用 `ensure_identity`，在受监督的阻塞工作中执行；不创建 profile 根目录。既有身份校验后原样复用，读取入口 `Identity::load` 仍为只读；损坏、错配、硬链接、重解析路径、被占用文件和缺失身份但仍有任何 state.json 的目录均拒绝，不通过重新生成掩盖原身份丢失。该锁仍不能排除旧 Electron，生产接管门槛不变。
- 使用既有固定祖先目录/精确文件句柄，随机临时文件写完并同步后，以不覆盖重命名发布 identity.json；异常或取消只删除持有的临时句柄。CNG 生成本身不可中断，宿主必须等待工作真正结束；生成前后、写盘后与发布前检查取消，发布后取消不能删除已提交的有效身份。进程崩溃可能留下未发布临时文件，不自动按路径清理未知文件，也不把该暂存副本当作已完成身份恢复。
- 序列化私钥、导出 DER 和加载的原始缓冲采用 zeroize，身份对象不实现 Debug/Serialize，错误与驱动报告不含私钥；这不声明第三方加密实现的所有内部分配都能清零。新增 7 项 Rust 单测覆盖原生创建/重启、取消后重试、孤立状态、损坏与硬链接、外部创建者胜出、实际文件共享失败及精确临时文件清理。
- 开发专用 `lan-identity` 驱动持有 profile 所有权并接受显式初始化/取消/停止，输入线程在结束前加入；`lan-receiver --create-identity` 提供隔离夹具首次启动，不改变默认必须有身份的驱动行为。该夹具生成后会释放并重取状态锁，后续桌面宿主仍须实现同一所有权下的完整初始化和服务启动，以及可等待的取消/退出协调；不能将开发驱动等同桌面接通。
- `test:tauri:lan:identity` 已在独立进程检查原生证书算法/位数/有效期/公私钥一致性及字节复用、并发所有者拒绝、损坏/链接/孤立状态与取消、旧 LAN 模块实际加载新身份并通过 TLS 互传文件，以及两个原生进程双端重启后的反向传输和最终 SHA-256；确认仍来自显式 stdin。首次夹具误把旧版返回 void 的 send() 作为任务 ID，已改取实际接收清单 ID；保留 `lan-identity-integration-first.log`、`lan-identity-first-verification.json` 与 `lan-identity-first-events.log`，这是夹具修正而非产品修复。
- 总复核入口为 `artifacts/tauri-migration/verify-lan-identity.mjs`：先完整 `check:silent`，再全部 Rust、严格 Clippy、release check、fmt，最后串行执行身份、发现、发送、接收存储、接收服务、旧状态和 HTTPS 传输七个套件；校验源码前后、集成输入和实际驱动摘要。历史发现阶段便签超时与未观察到部分文件的失败仍保持未定因，不因本次通过而宣称已修复。
- 最终 `lan-identity-final-verification.json` 已 verified=true、productionReady=false、migrationComplete=false：204 项 Node、4 项无窗口回归、329 项 Rust、严格 Clippy、release check 和 fmt 全部通过且无跳过；七个串行集成为身份 8、发现 10、发送 14、接收存储 7、接收服务 11、旧状态 7、HTTPS 传输 12 组。443 项源码/锁文件、35 项集成输入与实际驱动摘要匹配；`finalize-lan-identity.mjs` 复核日志/报告摘要与 `lan-identity-process-cleanup.json` 的零残留进程。旧发送/发现阶段报告只对应当时源码，当前以本身份阶段总报告为准。
- 当前仍未接通桌面原生配对/接收/目录确认、公共 lan* 适配器及共享 UI、主窗/托盘/维护退出生命周期；物理两机、生产身份所有权/回退、Release 性能及安装产物继续作为门槛。默认仍是 Electron、版本仍为 1.0.2，未提交/推送/发布，整体目标保持进行中。

## Rust 原生 LAN 确认组件（P6 未接入桌面）

- 新增 `lan/dialog.rs`，提供阻塞式 Windows TaskDialog 配对及接收确认组件，尚未实现桌面 `Approvals` 服务、原生目录选择或公共 IPC。配对保留六位码/真实地址及“每次接收仍需同意”，默认按钮为取消；文件接收展示数量/大小及默认目录，续传展示原目录且不能选择其他目录；文本只显示至多 2000 个 UTF-16 单元的完整字符预览，不提供目录选项。设备/文件名称中的控制符与双向覆盖符按字面转义，防止冒充可信提示行。
- 组件只返回显式选择枚举；“选择接收目录”返回 ChooseDirectory，不能据此批准默认目录、创建目录或开始传输。后续宿主必须实际完成原生目录选择，并把最后批准的目录交给既有安全存储入口。非零 owner 只做当前进程有效 HWND 的底层检查，不替代实际 Tauri 窗口身份/角色检查；零 owner 仅供可信原生后台宿主使用，不开放渲染层选择句柄。
- 取消令牌在创建前、定时回调及返回后复核；回调在当前弹窗线程同步取消，不缓存 HWND 后迟到发送关闭消息。调用本身为同步阻塞，后续服务必须拥有工作线程、在请求 future 丢弃时取消，并在维护/退出前等待线程结束；当前独立驱动仅验证一次受控调用及自身输入线程加入，不能代表应用的退出协调完成。
- 首次两次自动化尝试未找到窗口，保留 `lan-dialog-integration-first.log`、`lan-dialog-integration-second.log`、`lan-dialog-first-*` 和 `lan-dialog-second-*`。使用 computer-use 检查独立驱动后发现隐藏启动参数影响首个模态窗口；现在在定时回调中显式显示仍被隐藏的确认窗口，沿用既有更新对话框的处理方式。实际后台启动下已观察到可见窗口和正确内容，并验证默认回车取消、显式配对接受、目录选择仅返回请求、续传只显示原目录、取消关闭弹窗及两进程正常退出；观察记录为 `artifacts/tauri-migration/lan-dialog-manual-native.json`，不把这些局部观察当作完整自动化套件或桌面传输通过。
- 新增 `lan-dialog` 独立驱动及 `test:tauri:lan:dialog` 自动化夹具，补充默认 Enter/Esc、显式选择、文本截断、非法 owner/码、打开前/显示中/停止时取消等场景。夹具首次把 UI Automation 的焦点属性等同默认按钮，已移除该实现细节断言，仍保留实际键盘回车必须拒绝的行为断言；完整自动化重新执行尚待完成。示例 EXE 嵌入 Common Controls v6 清单，不生成运行期 manifest 文件，也不改变应用主入口。
- 当前源码已超过身份阶段基线，`lan-identity-final-verification.json` 只证明当时身份阶段；后续以 `verify-lan-dialog.mjs` 对当前输入重新执行静态检查与全部八个串行 LAN 套件为准。静态检查报告中的 staticVerified 只证明常规检查/Rust/Clippy/release check/fmt，verified=false 表示尚未执行完真实窗口及网络套件；不得把它解释为迁移完成。桌面批准队列、目录选择、实际窗口权限、生命周期、共享 lan* UI、物理网络、生产所有权和回退门槛继续保留。
- 当前 `lan-dialog-static-verification.json` 已 staticVerified=true、verified=false：204 项 Node、4 项无窗口回归、332 项 Rust、严格 Clippy、release check 和 fmt 通过，无跳过，447 项源码/配置前后匹配。`finalize-lan-dialog-static.mjs` 重新核对当前源码、日志摘要、原生观察及前两次自动化失败原件；后续只在全部输入及复核脚本摘要完全一致时，允许 `verify-lan-dialog.mjs --reuse-static-from=artifacts/tauri-migration/lan-dialog-static-verification.json` 复用这些静态检查，八个真实套件仍必须全部串行运行。该记录不将尚未重跑的原生对话框套件标成通过。
- 随后以完全相同的 447 项输入和复核脚本摘要复用上述静态检查，八个真实套件全部重新串行通过：原生确认 8、身份 8、发现 10、发送 14、接收存储 7、接收服务 11、旧状态 7、HTTPS 传输 12 组。`lan-dialog-final-verification.json` 已 verified=true、productionReady=false、migrationComplete=false，40 项集成输入/实际驱动摘要匹配；`finalize-lan-dialog.mjs` 核对原始两次窗口失败、人工观察、全部当前报告/日志和零残留进程。此结果仅证明确认组件与当前 LAN 库，不代表桌面批准队列/目录选择或公共 UI 已接通。

## 原生 LAN 批准队列与目录选择（P6 独立组件阶段）

- 继续上一对话中断的工作，补齐 `lan/approvals.rs` 和对应模块引用。批准请求采用有界串行队列，配对与接收共用一个原生 UI 工作槽，最多等待 8 项；排队时间计入超时。网络调用 future 被丢弃会取消对应请求，超时或停止先通知原生 UI，再等待真实阻塞工作结束，完成前不显示下一项确认。停止等待自身被取消时仍保留原工作句柄，后续停止可以继续等待；不使用 abort 假装原生模态窗口已经关闭。
- 原生 UI 由可信宿主提供并在显示前、确认后与目录选择后复核权限。明确接收才返回默认目录或已保存的续传目录；选择目录必须完成实际原生文件夹选择，取消返回空结果，不回退默认目录。文本和续传拒绝更改目录，错误、迟到确认、相对路径和已撤权宿主均不产生批准。该接口目前只由开发夹具调用，尚未实现实际 Tauri 主窗身份与后台宿主租约，不能将 trait 检查视为桌面角色验证已完成。
- 新增 `lan/folder.rs`，使用 Windows 原生文件夹选择、现有目录与文件系统路径约束，不创建接收目录、授予通用文件访问或写入状态。COM/计时器和窗口操作限选择框所属 STA；计时器使用本模块独立 ID，并保留传入 ID，不将 HWND 模式下 SetTimer 的成功返回值误当计时器 ID。取消通过当前窗口的原生取消按钮处理，结束后清理计时器、事件连接与 COM apartment。
- 11 项 Rust 队列测试通过，覆盖显式接受/拒绝、实际选择步骤的返回语义、取消无默认回退、文本/续传不改目录、错误路径、宿主撤权、有界溢出、丢弃请求、串行不重叠、超时丢弃迟到结果与停止等待真实工作。
- 新增独立开发夹具 `examples/lan-approvals.rs` 和 `test:tauri:lan:approvals`，只在隔离路径显示真实原生 UI；stdin 可模拟请求取消、宿主撤权与停止，不提供自动接受。首两次自动化因前台焦点断言失败，报告保留为 `lan-approvals-native-first-failure.json` 与 `lan-approvals-native-second-failure.json`。队列专项改为实际点击取消/接受，键盘默认行为仍由独立 dialog 专项和 Computer Use 观察覆盖，不把点击取消称为键盘测试通过；完整新自动化套件待复跑。
- Computer Use 实际观察到默认回车拒绝、选择中文目录返回精确路径，以及取消选择返回空值。停止可见目录框时发现线程计时器未完成关闭；诊断和未成功方案日志保留，不能用最终成功抹去这些失败。修正独立窗口计时器 ID 与原生取消入口后，`lan-approvals-manual-timer-id.log` 显示停止请求至进程正常退出约 165 毫秒，原生请求返回取消、窗口无残留；此日志对应带临时诊断输出的构建，移除诊断后的最终构建继续复核。
- 本阶段不接通公共 `lan*` 或共享传输页面，不启动桌面网络监听，也不操作生产身份/下载目录。下一步仍为 Tauri 宿主的真实窗口权限、服务启动与停止、维护/退出协调和共享 API；生产接管、回退、物理双机、Release 性能与安装产物门槛继续保留。默认 Electron 与版本 1.0.2 未变，迁移目标保持未完成。
- 移除诊断输出后的最终构建已通过 Computer Use 四项复核：实际回车拒绝配对、文件夹选择精确返回中文路径、主动取消不回退默认目录，以及目录框可见时停止请求并正常退出。最后一项从停止至退出为 120 毫秒，窗口和测试进程均无残留；观察树、返回值、源码与驱动摘要为 `lan-approvals-manual-final.json`，事件为 `lan-approvals-manual-final-events.log`。完整 `check:silent` 再次通过 204 项 Node 和 4 项无窗口测试，Rust 全目标 343 项、严格 Clippy、Release check 与 fmt 通过，无跳过。该局部原生观察不代替尚待复跑的九组新自动化专项或桌面 LAN 接入验收。
- 随后对同一代码串行复跑身份、发现、发送、接收存储、接收服务、旧状态兼容与 HTTPS 传输七个非界面 LAN 套件，均通过且无跳过，日志为 `lan-approvals-tauri-lan-*-final.log`；仓库构建目录下的 LAN 夹具进程无残留。下一轮先复跑新批准队列自动化和原有确认框专项，再接入桌面宿主；新套件首两次失败报告仍保留，不能将人工四项复核替代全部九组自动化结果。

## 原生 LAN 桌面服务接入（P6 部分，隔离预览）

- 新增 `lan_host.rs`，将现有 Rust LAN 核心接入 Tauri 主程序、共享 React 适配层与主窗专属 `toolbox-lan` 权限。公共 `lanSnapshot/lanEnable/lanConnect/lanSend/lanControl/onLanChanged` 已有真实实现，接口清单标记为 partial；不再以固定拒绝占位，不把本机隔离验证称为生产迁移完成。
- 单一宿主 actor 串行管理初始化、启停和快照，保留并等待真实身份初始化与服务清理。关闭、维护和退出会同步撤销当前代次、取消批准队列，并等待 HTTPS、发现、发送／接收文件工作与状态线程；IPC 等待或维护超时结束不会丢弃宿主实际工作。停服务保留已保存的启用设置，用户明确关闭才写 false；维护结束或退出取消按保存设置恢复。
- LAN 目录位于预览根 `LanTransfers`，快照只读时不创建目录或身份。显式开启才创建身份，沿用同一个 StateStore 所有者至接收工作线程。原生确认采用可信后台宿主，不接收渲染层 HWND；每次操作校验启动恢复、退出阶段及会话令牌。主窗命令校验实际窗口资源身份及每次加载的原生授权令牌，旧令牌在排队调用真正进入服务前也会被拒绝；页面重载取消其待配对调用，后台接收服务继续运行。
- LAN 模态确认与现有系统选择框共享占用槽；停止、维护与恢复可取消并等待真实模态结束。主窗重载／回收只释放主窗选择框，保留后台 LAN 接收。快照定向通知主窗，不向组件、覆盖层、贴图或恢复页开放 LAN 命令与快照。
- 文件／文件夹采用原生多选与现有实际拖入授权登记，渲染层仅持有资产 ID；发送不接受页面任意路径，不能用发送资产读取任意文件字节。资产有数量上限并固定父目录，实际准备与传输继续由 Rust 核验路径、重解析点、源身份与哈希；页面重载、销毁和备份恢复撤权。读取图片仍限图片资产。
- 新增接收端本地暂停／取消／清理：撤销旧网络令牌后等待实际文件工作释放，再处理暂存文件与状态；接收端继续提示由发送电脑发起。服务关闭后仍可清理历史记录，不为此打开监听器。文本任务在同进程维护／关闭／恢复时留在内存，始终不进入重启文件，进程重启后不复活文本。
- 备份恢复先取消主窗 LAN 调用，再冻结并清理服务；恢复仍只覆盖工作区，不覆盖 LAN 身份／配对／续传文件。LAN 请求的拒绝／取消保持对调用者报错，但不被当作编辑保存失败否决退出或备份恢复；保存队列仍保持原有失败保护。
- 上一组件阶段的批准队列九组与原确认八组自动化已串行通过。首次复跑发现 PowerShell 原生输出编码导致中文按钮名乱码，已在对话框夹具显式使用 UTF-8；原失败保留 `lan-approvals-native-encoding-failure.json`。`lan-approvals-stage-verification.json` 对当时输入标记组件 verified=true、approvalAutomationVerified=true，仍为 productionReady=false、migrationComplete=false。
- 新增 `tests/tauri-lan-host.mjs` 和 `npm run e2e:tauri:lan`，真实 WebView2 调用、Windows 原生确认／文件夹选择与旧 Electron LAN 模块通过实际回环 TLS 互传；旧端测试模块运行于 Node，不将其称为两台物理电脑或完整旧版 UI 验收。`DUSTDESK_TAURI_TEST_LAN_LOCAL_ONLY` 仅 Debug 且严格临时测试根可用，限制回环、关闭 UDP 广播并将接收默认目录放入测试根；Release 忽略此入口，不修改防火墙。
- 首次桌面专项的失败是测试误把旧发送任务视图当作带文本的接收视图，已按实际任务 ID 等待，原失败保留 `lan-host-native-fixture-failure.json`。已通过真实原生选择、双向文本、文件／空目录、接收暂停清理、主窗重载／回收后台接收、维护取消确认、显式关闭、同身份重启及双方重建后的发送续传。后续已补验共享 React 实际发送、真实 OLE 文件拖入、备份恢复、旧页面令牌拒绝、关闭后的记录清理，以及实际接收部分文件的退出／重启／原目录确认／前缀哈希续传，当前桌面专项 19 组通过。
- 关闭故障专项真实复现接入初版的提前返回问题：把测试状态文件临时替换为目录后，保存关闭设置失败，但 TCP 仍在监听。原失败保留 `lan-host-disable-fault-before.json` 与 `.log`。已改为同步撤销接收／发送核心、取消批准，并先等待真实监听器与文件工作结束，再保存显式关闭设置；保存失败仍报错，修复存储后可重试。停止不再先排队读取快照，而在状态线程结束后移动内存文本，避免等在磁盘准备之后，也不为此常驻复制文本任务。新故障专项验证真实端口关闭、模态无残留及失败后的恢复重试。接收续传测试曾误用字段名，已按协议的 offsets[size/hash/complete] 修正夹具，原件为 `lan-host-receive-resume-fixture-failure.json`；不是产品协议修复。
- 2026-11-11 最终冻结输入复核通过：470 个源码／测试／配置输入前后 SHA-256 一致；`check:silent` 的 204 项 Node 与 4 项无窗口测试、343 项 Rust 全目标测试、严格全目标 Clippy、Release cargo check、fmt 和实际 Debug 构建通过。随后串行运行 LAN 桌面、接收、发送、系统选择框、图片工具箱、备份、草稿维护、主窗回收共 8 套／67 项原生测试，失败／跳过／取消均为零。`artifacts/tauri-migration/lan-host-final-verification.json` 复核日志、桌面专项 19 组、实际 EXE、截图及保留失败的摘要，标记 verified=true、productionReady=false、migrationComplete=false；本结果只覆盖列明的相关回归，不冒充全量物理或发布验收。
- 本阶段仍不切换正式入口、不接管生产数据、不提交／推送／发布，版本保持 1.0.2。真实 LAN OLE 拖入与同机服务重建续传已有隔离证据；尚需物理双机／广播、更多长时中断／存储故障、完整生产接管和回退、Release 内存及安装／真实绿色 ZIP 验收。


## 旧版 LAN 硬链接发布间隙恢复（P6 兼容增量）

- `lan/publication/legacy.rs` 接入既有接收恢复路径，处理旧版“创建目标硬链接 → 保存文件映射 → 删除暂存链接”的两处中断边界。只有本机重新批准原接收目录、暂存文件恰有两个链接、目标位于原清单的同名避让候选中，且原生文件身份、长度与完整 SHA-256 一致时才恢复；普通接收、源文件与状态文件仍拒绝多链接，不开放通用硬链接读写或页面路径授权。
- 恢复先原子保存含精确身份的 `rustPublicationV1` 意图，再用暂存句柄只删除该任务的链接，最后提交原有目标映射并清除意图。现有映射必须指向同一候选；同内容不同身份、额外第三链接、错误哈希、目录联接、冲突映射和持久化失败均保留现场并拒绝。已持久化意图可在暂存链接或暂存目录已消失时核验原目标继续恢复，不重建无必要的目录、不覆盖目标或另发一个副本。
- 新增 7 项 Rust 测试，包含映射保存前／后、同名目录／文件避让、额外链接、同哈希不同身份、真实状态文件占用、取消、原生记录重启与目标被替换。初版恢复曾误把仅持有暂存句柄或仅属性目标句柄视为目标名称保护；实际改名断言失败，未放宽断言。最终在整个删除与提交阶段保留目标只读句柄，实际写入／改名／删除均被阻止。中间失败保留 `artifacts/tauri-migration/legacy-link-intermediate-failure.log`，不能把初版错误表述为旧 Electron 本身的框架缺陷。
- 新增 `npm run test:tauri:lan:legacy-publication`：旧 Electron LAN 模块运行于单独 Node 进程，夹具仅在实际 `fs.link` 完成后、或实际映射保存完成且 `fs.rm` 尚未执行时暂停，再由父测试强制结束进程。重新创建发送端并启动原生接收服务，先拒绝原目录续传确认，验证双链接未动；重新明确批准后通过真实 TLS 接续剩余文件，保留首个目标、精确哈希和空目录，暂存链接消失且无重复文件。原生服务完全停止后再重建旧模块，实际 `/offer` 和 `/complete` 能读取已完成映射。两组专项已通过，报告为 `artifacts/tauri-migration/lan-legacy-publication/verification.json`。
- 此证据针对同机隔离服务和旧模块文件格式，不是完整旧版 UI、物理两机或生产回退演练。仍有未完成原生发布意图时不能直接交还旧版；发送清单原生字段的回退整理、跨运行时排他所有权、生产一致快照和反向草稿迁移仍须继续完成。默认 Electron、版本 1.0.2 和生产目录保持原状，不提交／推送／发布。
- 最终回归于 2026-11-11 完成，2026-11-12 继续任务时重新核验当前源码、日志和 EXE 摘要一致：480 个输入冻结，`check:silent` 的 204 项 Node 与 4 项无窗口测试、350 项 Rust 全目标测试、严格全目标 Clippy、Release cargo check、fmt 和实际 Debug 构建均通过；14 套相关原生回归共 73 项，无失败／跳过／取消，包含现有 LAN 桌面 19 组与真实旧模块发布中断两组。证据为 `artifacts/tauri-migration/legacy-links-final-verification.json`，verified=true、productionReady=false、migrationComplete=false。回归进程已经结束，无本轮测试端点残留；报告不代替物理网络、生产接管、完整回退、性能或安装产物验收。

## LAN 旧运行时接续与未完成原生意图保护（P6 回退准备增量）

- Electron 准备构建的公开清单改为显式协议字段白名单，清除源路径、`rustSourceV1` 和其他非协议扩展；本地持久化仍保留原生源身份和精确 mtime。此保护仅存在于当前准备构建，不能推断已经发布的旧二进制认识原生状态。
- 初始化先验证完整任务集合，发现任意 `rustPublicationV1` 字段（含 null、false 或已完成任务上的标记）便拒绝加载和开启，不创建新身份、不加载部分任务或启动监听。失败初始化后的停止／dispose 不再把空内存状态写回，原始无效或未完成状态保持原字节。新增两项 Node 测试覆盖标记存在、部分集合、损坏 JSON、损坏清单和失败后的反复调用／销毁。
- 发送专项新增实际反向接续：双方 Rust 服务在真实部分上传时停止并释放句柄后，用同身份、同任务和原部分文件重建 Electron LAN 发送／接收模块，重新连接新端口并完成传输。测试从实际 HTTPS `/offer` 的字节收集清单，断言根与文件条目只有协议字段，最终目标 SHA-256 精确匹配且本地源身份记录未被删除。此证据超出此前“仅格式读写往返”，但仍是 Node 中的旧模块，不能等同完整生产回退／两台电脑验收。
- 2026-11-12 冻结输入回归全部通过：481 个源码／测试／配置输入前后 SHA-256 一致，`check:silent` 为 206 项 Node 与 4 项无窗口测试，Rust 全目标 350 项、严格全目标 Clippy、Release cargo check、fmt、实际 Debug 构建通过。14 套原生回归共 73 项，无失败／跳过／取消；其中 LAN 桌面 19 组、发布中断 2 组与发送专项 15 组包含实际反向接续。随后真实 Electron 工具箱双端回归通过，覆盖 TLS、托盘接收、文件／目录／文本、源占用重试、拖入／截图导入、图片导出及正常退出。证据为 `artifacts/tauri-migration/lan-handoff-final-verification.json`，verified=true、actualSendingHandback=true、productionReady=false、migrationComplete=false；完整生产所有权、一致快照、草稿反向导入、旧安装来源以及物理网络／输入环境、Release 性能和安装产物门槛保持未完成。

## LAN 跨运行时目录所有权（P6 准备构建增量）

- 当前 Electron LAN 模块与 Rust `StateStore` 共用按 Windows 物理目录身份派生的命名管道租约。获取租约后才读取续传状态或生成身份，Rust 也在创建 `.rust-owner.lock` 前取得租约；仍保留该文件锁以兼容此前原生预览。锁文件留在磁盘不表示当前有所有者，不删除所谓“过期锁”。
- Tauri 桌面宿主关闭状态下的快照／启动恢复读取也改为通过 `StateStore` 获得租约，避免只约束实际写入而提前读取其他所有者的活动状态；不存在 LAN 目录时仍返回空状态，不创建目录。桌面专项新增准备模块先占时快照／启用／关闭拒绝及释放后重试，以及实际原生服务先占时准备模块恢复／启用拒绝，检查身份与原始状态字节不变。
- 新增桌面交还夹具初次只关闭从未启用过的旧模块，生成了缺身份的状态，被既有原生孤立状态保护拒绝；记录为 `artifacts/tauri-migration/lan-ownership-host-orphan-fixture-failure.log`。夹具现先实际启用生成原身份，再关闭／销毁并交还，严格验证原身份复用；未放宽缺身份保护。扩展后的真实桌面专项 21 组已通过。
- 未使用且关闭的 LAN 恢复不创建目录、身份或锁文件。已初始化的 Electron 服务在显式关闭后仍持有租约，防止缓存状态覆盖后来接管者；只有销毁并完成网络、接收处理器、任务控制与保存队列收尾后才释放。初始化失败释放临时租约，保留原状态字节，随后可重试；已销毁服务拒绝重新写入。
- 审查发现仅等待 HTTPS 连接关闭不足以证明异步接收文件已经收尾。现已显式等待入站处理器及已接受的控制操作；等待中的接收确认可由服务停止取消。真实 TLS 夹具分别暂停在实际目标硬链接创建后、已接受清理执行前，验证销毁尚未完成时 Rust 仍被拒绝；释放文件操作并完成销毁后，Rust 才能读取原身份和最终状态。未回答的接收确认也可直接退出，不创建接收任务。
- `tests/tauri-lan-ownership.mjs` 的九组场景已通过：未使用恢复、旧模块先占、原生先占、强制退出释放、四轮并发竞争、独立目录、销毁失败重试、文件操作收尾与目录联接拒绝。旧模块运行于独立 Node 进程，原生为实际 `StateStore` 驱动。初次夹具错误读取了原生独占锁文件，失败记录保留在 `artifacts/tauri-migration/lan-ownership/verification-fixture-ebusy.json` 和对应 events；现在记录锁文件存在并哈希所有实际数据文件，不削弱身份／状态不变断言。
- 完整 Node 回归另暴露 `TestContext.after` 按注册顺序执行时的夹具清理问题：原先先删临时根、后销毁服务，目录租约正确拒绝了已消失路径。`toolbox-fixture.mjs` 现在集中跟踪所创建服务，在删除测试根前先完成销毁；未放宽产品所有权校验。失败日志保留 `artifacts/tauri-migration/lan-ownership-check-cleanup-failure.log`，修正后工具箱、交还保护及所有权专项共 29 项串行通过。
- 退出写盘故障专项真实复现本轮初版的重试缺陷：将状态文件临时替换为目录后，销毁报错且租约保留，但“正在销毁”标志未清除，修复存储也无法重新开启。失败报告和事件保留为 `lan-ownership/verification-dispose-retry-before.json`、`events-dispose-retry-before.json`；现已在销毁收尾清除临时标志，只有全部保存／释放成功才标记已销毁。修正后实际写入故障、保持租约拒绝 Rust、修复存储、再次启用及正常销毁通过，三套相关测试合计 30 项通过。
- 2026-11-12 最终冻结输入回归全部通过：484 个源码／测试／配置输入前后 SHA-256 一致；类型检查、206 项 Node、4 项无窗口、生产前端构建、350 项 Rust 全目标测试、严格 Clippy、Release cargo check、fmt 及实际 Debug 构建通过。15 套原生回归共 83 项，失败／跳过／取消均为零；其中 LAN 桌面为 21 组、目录所有权为九组含四轮竞争，旧版发布中断两组及实际发送反向接续均再次通过。随后真实 Electron 工具箱双端传输、托盘接收、图片导出、源占用重试及正常退出通过。证据 `artifacts/tauri-migration/lan-ownership-final-verification.json` 为 verified=true、actualSendingHandback=true、productionReady=false、migrationComplete=false，旧阶段报告保留为历史证据。
- 本增量只约束当前准备构建与当前 Rust，不证明已发布且不识别协议的旧二进制已被排除，也不证明所有同账户恶意路径替换已解决。生产来源检测、一致快照、草稿反向迁移、物理网络／输入、Release 性能和安装产物门槛继续保留。Electron 仍为默认入口，版本保持 1.0.2，未提交／推送／发布，也未将整个迁移标记完成。

## Tauri 原生迁移草稿导出（P2 反向迁移前提）

- 隔离主页面新增“导出迁移草稿”，使用现有 Lucide 与错误／结果状态。窄权限仅授予实际主窗，命令不接受前端自报条目、包头、路径或指纹；原生保存对话框取消后不进入维护、不写文件或回执，内部数据目标明确拒绝。
- 原生复用全编辑器 Ready 检查点，固定实际主 WebView profile/origin，再直接读取白名单 localStorage。Rust 验证所有者、精确字段、未知版本、唯一键、UTF-16 字段上限与总量，保留原始 value 字节；UUID、时间、应用版本与工作区摘要来自原生，不采信前端元数据。
- 审查发现默认 Rust JSON 字符串解析会拒绝 JavaScript 允许的转义未配对代理字符。现以 serde_json 原始字段与字节字符串访问器只计算码元长度，原始 JSON 不解码重写；新增普通中文／emoji、未配对高低代理、完整代理对、字面反斜杠及长度边界测试。原始键与选择状态中不可由 UTF-8 表达的 legacy 标识仍拒绝，保留为完整兼容门槛。
- 持有组件门闩与工作区互斥，原生先暂存文件、原子写入物理目录绑定的来源回执，最后发布外部文件。保留原 Electron workspaceId／历史回执，损坏历史不重置；失败保留目标与输入，成功导出不重载编辑器。外部发布失败可能留下未使用回执，不能把回执存在当作文件交付完成。
- `tests/tauri-draft-export.mjs` 初步七组／8 项原生测试已通过，包含实际脏任务输入、精确白名单原文、正常／取消对话框、未知版本／坏历史、内部路径、真实只读回执失败及显式重试、实际 Tauri 正常退出后准备 Electron 来源核验，以及真实浏览器读取超过 Ready 到期。初次测试误用了夹具字段 Tasks，修正为实际 Todos／SchemaVersion 3，失败记录保留 `draft-export/verification-fixture-fields-failure.json`；未更改产品保护以通过夹具。
- 最终回归中严格 Clippy 发现 `contains_key` 与闭包借用三处写法，修正后通过，原日志保留 `draft-export-clippy-before-fix.log`。事务恢复套件一次 commit 因 Windows `MoveFileExW os error 5` 被拒绝，现场记录仍为 pending、原文件未损坏；`draft-export-transaction-first-failure.json`／`.log` 保留完整现场。未修改产品或断言，单独复跑 15 项全部通过；无法从现场确认占用来源，不将未复现写成已修复，也未加入自动重试提交。
- 2026-11-12 冻结输入回归通过：487 个源码／测试／配置输入前后 SHA-256 一致；类型检查、206 项 Node、4 项无窗口、生产前端构建、356 项 Rust 全目标测试、严格 Clippy、Release cargo check、fmt 与实际 Debug 构建通过。14 套原生回归共 164 项，所采用的成功运行失败／跳过／取消均为零；包含上述七组导出、产品导入、事务恢复、来源核验、全编辑器维护、系统对话框、文本／图片工具箱、备份、主窗回收、截图生命周期、21 组 LAN 桌面观察及真实 Electron 新旧来源导出。
- 首轮记录保存在 `draft-export-final-runs.json`，包含未隐去的事务失败；`continue-draft-export-verification.mjs` 逐一核验原先输入哈希、复用未变源码下已成功的检查及独立事务复跑，再串行完成余下套件。最终证据为 `artifacts/tauri-migration/draft-export-final-verification.json`，记录历史 OS 5 未复现且原因未确认，`verified=true`、`productionReady=false`、`migrationComplete=false`。`draft-export-process-cleanup.json` 确认项目 Debug Tauri 主程序残留为零；不扩大为所有用户进程的清理证明。
- 此前 LAN 所有权报告保留为当时源码的历史证据。当前只完成反向草稿迁移的导出前提；下一步继续准备 Electron 的贯穿提交维护、持久决定、原生结果复核与编辑器启动前恢复。任意 UTF-16 legacy 标识、可信生产源／一致快照移交及其他完整迁移门槛继续保留。Electron 仍为默认入口，版本保持 1.0.2，未提交／推送／发布，也未将整个迁移标记完成。

## Electron 反向持久事务与 Tauri 启动交接（P2 内核增量）

- 新增 `src/main/draftTransaction.ts`，仅原生主进程持有，不开放 renderer IPC。当前尚未导入 Electron 主程序；这是准备反向导入的持久内核，不能将其 Node 测试计作产品反向导入完成。
- 开始时复核实际 Windows 工作区所有权、工作区原始字节和导出来源回执，在原生内存影子上复用共享 alias／空草稿／已保存墓碑保护。独立事务 UUID 的不可变日志先刷盘，再发布 `ElectronMigrationTransaction.json` 的 pending 元数据，真实浏览器此后才可暂存；元数据保存摘要而不含草稿正文，历史副本有界且不自动删旧。
- 决定提交前要求原生观察到匹配的 pending 原文、完整暂存值、仍有效的维护请求及未改变的工作区。过期只能 abort，commit／abort 不可逆。恢复闭包绑定原始代次，复核实际日志清理、完成回执和每键结果后才记录 completed；排队调用在入口复制浏览器观察，调用方后来改动对象不能改变已排队的依据。
- Tauri 新增固定 Electron 记录的严格守卫，在创建 `workspace.lock` 前检查，也保护已打开 store 的所有受控操作；启动发现任一运行时事务元数据先进入隐藏恢复流程。未完成 commit／abort、pending、错目录、未知／未来格式、坏 JSON、多链接、缺绑定或载荷摘要均保留并阻断编辑器／服务；合法 completed 才放行。Tauri 不代替 Electron 恢复其浏览器。
- 共享内核新增 completed-abort 回归：旧规则在完成中止后仍重放原生回滚副本，会删除后来重新输入的相同原文。现仅在事务未完成，或 commit 缺回执时读取恢复副本；原生也将已确认中止且无 pending／冲突回执视为已完成，不能拿旧写入摘要判断后来内容必须删除。
- 初次真实新旧 Debug 验证都在 `localStorage.setItem` 后立即强杀进程，重启观察到该值缺失；不能单凭此夹具区分浏览器尚未刷盘与旧回滚重放。保留 `completed-abort-before-fix.log`、`completed-abort-original-failure.json` 和 `completed-abort-post-fix-immediate-kill-failure.json`，没有把此现象直接归因于框架。共享单测固定旧重放规则；修正后的原生专项分别核验直接恢复、实际页面重载、正常退出 exit 0 后真实重启及再次重载，相同输入均保留。物理断电／强杀后任意最后一次浏览器输入的持久性仍未证明。
- 同一旧 Debug 复现运行中，`tray-pending` 再次遇到原子替换 `MoveFileExW os error 5`，启动仍保持停止、决定仍保留。现场另存 `completed-abort-before-fix-tray-pending-os5.json`，历史首次失败继续保留。后续成功运行不表示占用原因已解决；未增加产品自动提交重试或清除只读属性。
- 新增 9 项 Node 内核测试，使用真实 Windows 目录租约／文件和内存浏览器，覆盖 write-ahead 时序、未观察暂存禁止提交、缺日志／值的 commit 恢复、中止后新输入、快照复制、alias／空值／墓碑、过期、错绑定／工作区／异运行时、损坏／未来／复制／多链接记录，以及真实只读写入失败后显式修复重试。Rust 新增三项异运行时守卫测试；共享新增一项 completed-abort 回归。
- `tests/tauri-electron-draft-handoff.mjs` 四组／5 项实际启动专项通过：真实 Tauri 保存对话框导出并正常退出，准备 Electron 内核先落盘 pending 后实际 Tauri 拒绝启动，显式 abort 并完成结果复核后放行，以及不可逆 commit 尚未完成时继续阻断、完成后再次放行。Electron 内核运行于 Node，目标为内存夹具，绑定也为明确测试值；此证据不包含实际 Electron profile／页面／维护或产品导入。
- 2026-11-12 最终核验通过：490 个源码／测试／配置输入在最终阶段前后 SHA-256 一致，216 项 Node、4 项无窗口、359 项 Rust 全目标测试、严格 Clippy、Release cargo check、fmt 与实际 Debug 构建通过。7 套相关原生回归共 86 项，所采用成功运行失败／跳过／取消均为零；包含 16 项事务恢复、5 项交接、22 项产品导入、8 项导出、13 项维护、15 项主窗回收及 7 项物理目录所有权。证据为 `artifacts/tauri-migration/electron-draft-kernel-final-verification.json`，`verified=true`、`productionReady=false`、`migrationComplete=false`。
- 首轮失败记录保留在 `electron-draft-kernel-first-runs.json` 和 `electron-draft-kernel-first-transaction.log`。后续仅修正两个独立原生夹具与验证编排：恢复用例分别验证直接恢复／重载／正常退出；交接夹具明确等待启动失败界面。编排逐项核对产品源码、单元／无窗口测试及构建输入完全未变后复用已成功检查，采用最终事务夹具的独立 16 项成功运行，再串行完成其他六套原生回归；最终报告列出复用范围与所有日志摘要，没有覆盖失败证据。项目 Debug Tauri 进程残留检查另存 `electron-draft-kernel-process-cleanup.json`。
- 本增量仍需完整准备 Electron 受控空页面、实际 session/profile 与应用 URL 绑定、贯穿暂存／决定／结果复核的全窗口维护，以及编辑器／收纳／服务／IPC 开放前的启动恢复。现有 `collect` 返回时已恢复编辑，不能复用为导入写入授权。原生首次硬链接发布中断等全部崩溃边界、完整生产来源／快照、物理网络／输入、Release 性能及安装／绿色 ZIP 门槛保持未完成。

## Electron 受控草稿导入与启动恢复（P2 产品交接增量）

- `draftBrowser.ts` 使用实际 Electron Session、精确构建 file URL 及配置目录的 Windows 物理身份生成绑定。临时文件协议只返回一次空页面，CSP 禁止脚本、网络、子框架和导航；独立 sandbox preload 不暴露桌面桥接。原生主进程自行读取白名单值、日志和回执，受控请求还核验原生 token、请求编号及真实主框架 sender。关闭后撤销协议处理器并释放目录句柄，不运行该 URL 对应的 HTML 或任意 renderer 提供的路径。
- Electron 文件菜单及托盘新增“导入迁移草稿并退出…”。原生选择后有界读取独立普通 JSON，拒绝链接／重解析点、多硬链接、无效 UTF-8、读取期间变化及超过 64 MiB 的文件。默认取消的确认说明只导入草稿、不包含工作区或附件；源包必须与当前物理工作区原始字节及本地原生导出回执完全匹配。
- `draftMaintenance.run` 复用真实全部编辑窗口的最终保存／队列封存。原生受控阶段开始后锁定门闩：成功、磁盘失败、参与窗口关闭或超时都不再发送 resume，不开放任何普通读写，也不允许普通退出流程绕过；保存前／未获来源授权的失败仍恢复编辑器。受控上下文在结束后失效，迟到任务不能使用保留门闩继续写入。进入受控阶段后本轮必须退出，再手动启动；尚未提供不退出的热重载导入。
- 原生副本与 pending 先落盘，再许可真实浏览器暂存；主进程观察全部原文和摘要后决定 commit，再恢复真实存储、刷新并复核 completed。任何未确认结果保留决定和恢复副本，不擅自回滚 commit。启动在收纳恢复、编辑窗口、业务 IPC、托盘、快捷键和后台服务之前执行受控恢复；错误时只允许明确重试或退出，不运行普通页面或创建默认工作区。
- 受控导入先停止效率工具计时／扫描及剪贴板、提醒轮询，再等待工具箱与 LAN 的连接、传输、文件队列和物理目录所有权交还；成功前不开始浏览器暂存。停止失败保留冻结编辑器和既有事务，不用 `app.exit` 代替这一步。保留 LAN 启用偏好及身份字节，手动重启恢复原身份。LAN 配对／接收确认使用原生 AbortSignal，排队及返回后的结果再次核验；普通文件选择和导出也在返回后核验交互门闩，拒绝维护期间迟到的文件授权或输出。不能取消的文件夹选择框不声称已物理关闭。
- `electron-draft-import-native.json` 的八项原生检查新增真实 Windows 待决配对窗口：导入前由 UI Automation 确认可见，导入完成后确认消失、连接拒绝且 trusted 仍为空；同时验证迟到文件选择拒绝、服务端口关闭、目录所有权释放、身份／启用偏好不变，以及 LAN 状态落盘失败不会开始浏览器写入。`draft-exit-toolbox-native.log` 另验证普通工具箱配对、文件／目录／文本互传、占用文件重试和双方正常退出。首轮 UI 查找失败来自 Playwright 启动器 PID 不等于实际 Electron 主进程 PID，现从真实主进程取 `process.pid`；另一次夹具把待决文本保存延迟到导入完成，正确被现有保存屏障阻止，已改为验证不在保存队列中的文件选择；两次失败分别保留 `draft-exit-pairing-first-failure.*` 与 `draft-exit-pairing-checkpoint-failure.*`，没有放宽保存屏障或超时。
- 延迟 LAN 初始化专项先在未修复构建复现：调用已在维护前进入，但等待原生状态读取期间编辑器冻结；读取返回后仍新开一次真实 TCP 监听，并把原来 false 的启用偏好写成 true。原始结果保留 `draft-exit-late-lan-red.log/.json`。修复在全部 LAN IPC 的异步初始化返回后重新核验交互门闩，并在同一同步段调用业务操作，不仅检查最初入口；专项验证旧请求拒绝、零新 TCP 监听、偏好仍 false、身份不变、目录交还及重启仍禁用。它不是仅靠观察最终端口已关闭而遗漏期间短暂重启。
- 真实 Tauri 原生保存对话框导出的包，经 Tauri 正常退出交还同一隔离工作区后，已由真实 Electron 菜单导入并重启显示任务输入，requestId 和 value 原文保持。实际提交任务、再次重启只保留一个相同 ID 的任务，不复活已消费的输入。Electron 选择／确认对话框在此自动化中截获，不能将它表述为其原生对话框物理验收，也不代表完整生产回退。
- 该双运行时专项发现真实兼容缺陷：Electron 启动用 JSON.stringify 判断规范化相等，Rust 按键排序的相同工作区会被无意义重写，导致原始指纹失配、正确迁移包被拒绝。现仅在读取规范化判断中比较 JSON 语义，不改迁移摘要／谱系规则或普通三方合并；保留原始字节、空白及备份，有实际字段纠正时仍持久化且保留数组顺序。保留 `draft-reverse-initial-failure.json` 及带 `isolatedFailureRoot` 的故障现场，不以改写导出回执绕过校验。
- 故障专项覆盖提交 rename 失败后的 pending→abort 启动恢复，以及浏览器已提交／原生 completed 尚未落盘的真实只读记录失败。后者实际返回 EPERM／EACCES 与路径，启动无普通窗口／业务 IPC／导入菜单；仅由测试恢复只读属性并明确重试后完成 commit。产品不改属性、不删除记录、不自动重试；它证明一种拒绝替换的可复现原因，不能解释此前全部 MoveFileExW os error 5 或宣称偶发占用已修复。立即强杀最后一次输入的磁盘持久性仍未证明。
- 可复核入口为 `npm run check:tauri:drafts:reverse`，输出 `artifacts/tauri-migration/draft-reverse-final/verification.json`，绑定源码／测试／配置输入、构建与每套检查日志。独立证据为 `electron-controlled-drafts/verification.json`、`electron-draft-import-native.json`、`draft-reverse-product-native.json` 和 `draft-reverse-restored-widget.png`。本阶段默认 Electron、版本 1.0.2、生产目录与发布状态均未改变。
- 保留整链检查的中间失败：`draft-reverse-check-first-failure.log/.json` 是无窗口收纳删除等待超时，未改该产品逻辑或测试断言，单独复跑及后一整轮均通过；`draft-reverse-ownership-failure.log/.json` 则明确显示原目录所有权夹具默认启用系统剪贴板采样，造成“退出不改数据”断言被无关后台写入干扰。后者改为夹具启动前提供空剪贴板读源，并关闭该夹具的后台采样／自动备份、保存后取检查点；保留原目录互斥及逐字节／完整对象断言，不删除不同数据来使测试通过。交接字节重排的三份原始文件另存 `draft-reverse-byte-order-failure/evidence.json` 及相邻 JSON。
- 2026-11-12 本阶段历史核验边界：原最终报告已另存 `managed-snapshot-previous-draft-verification.json`（finishedAt=2026-11-12T12:20:58.169Z），当时 verified=true、sourceStable=true，完整串行重跑 19 个步骤，冻结并复核 504 项源码／测试／配置输入，不复用历史成功日志。通过 TypeScript、223 项 Node 单测与 4 项无窗口回归、359 项 Rust 全目标测试、严格 Clippy、Release check、fmt、Debug 构建、十二套／121 项相关原生回归，以及独立普通 Electron 工具箱生命周期检查。当前最终报告及相同路径日志已经由后续快照内核的 506 项输入／378 项 Rust 新运行更新，不将历史报告当作新源码证据。`draft-reverse-lifecycle-process-cleanup.json` 只读核验该阶段项目 Debug Electron／Tauri 及隔离 WebView2 进程残留为零，没有结束无关进程。`draft-reverse-current-summary.json` 与旧 process-cleanup 报告仅是更早的 119 项复用边界记录。
- 中间整链曾在只读故障排除后的夹具选页处失败：临时受控恢复页与普通主界面有相同 URL，夹具过早选中随后正常销毁的恢复页。现等待实际可见 `.app-shell`，保留“恢复前零普通窗口／业务 IPC、显式重试、真实存储与 completed”全部断言；原始失败为 `draft-reverse-lifecycle-recovery-page-failure.log/.json`。另一原生增量的 120 项通过记录保留为 `draft-reverse-before-late-lan-verification.json`，随后确实复现并修复了延迟 LAN 初始化竞态，最终 121 项才覆盖该问题。
- 无窗口便签保存／收纳删除的历史偶发超时仍未定位根因；失败保留 `draft-reverse-check-first-failure.log/.json` 和 `draft-reverse-check-second-failure.log/.json`。只补充最近保存／基线、IPC 错误和页面错误诊断，不修改产品保存逻辑、不延长超时或放宽断言；四次独立诊断运行及后续整链通过，不能据此将历史失败写成已修复。
- 尚需完整生产来源与一致快照／资产／身份接管，全部编辑器和后台服务的正常停止／交还协议、所有崩溃边界与备份回退演练，以及物理输入／网络、Release 内存和安装／绿色 ZIP 门槛；迁移继续进行，不将本阶段的隔离双向草稿交接标为完整迁移或生产回退完成。

## 本地命令

- npm run test:tauri:lan:ownership：构建原生状态驱动，启动独立旧模块／Rust 进程，验证物理目录互斥、正常／强制退出、并发竞争、大小写与目录联接、真实 TLS 文件收尾及未回答确认取消。报告 `artifacts/tauri-migration/lan-ownership/verification.json`；与所有原生／网络和 check:silent 套件串行，不代替已发布旧版检测或完整生产接管。

- npm run test:tauri:lan:legacy-publication：构建隔离 Rust 接收服务，强制结束处于真实发布间隙的旧模块进程，验证原目录重新确认、双链接安全整理、双端重建后实际 TLS 续传及旧模块重新读取完成映射。报告 `artifacts/tauri-migration/lan-legacy-publication/verification.json`；与所有原生／网络及 check:silent 套件串行，不代替生产接管和物理双机验收。

- npm run e2e:tauri:lan：构建隔离 Tauri Debug，使用真实 WebView2 公共 LAN API、原生确认和文件选择，与旧 LAN 模块通过实际回环 TLS 验证互传、传输控制、维护／恢复／退出、主窗回收、同身份重启与续传。报告 `artifacts/tauri-migration/lan-host-native.json`；只允许隔离临时根，不代替物理双机／生产数据接管或 Release 性能，与其他原生／网络和 check:silent 套件串行。


- npm run test:tauri:lan:approvals：构建独立批准队列与目录选择驱动，使用真实原生确认和文件夹选择验证串行请求、显式接收/取消、撤权、超时和停止。报告 `artifacts/tauri-migration/lan-approvals/verification.json`；须与其他原生、网络和 check:silent 套件串行运行。该报告仅 verified=true 时代表本套件通过，不能代替实际桌面宿主与网络互传验收。

- npm run test:tauri:lan:dialog：构建独立 Windows 原生确认驱动，使用隔离夹具验证配对/接收/续传/文本的真实按钮、默认键盘及取消行为；报告 `artifacts/tauri-migration/lan-dialog/verification.json`。先完成 `check:silent`，与所有应用/原生/网络套件串行，不能作为桌面宿主已接通的证明。

- npm run test:tauri:lan:identity：构建独立原生身份/服务驱动，验证 Windows CNG RSA 身份创建、安全保存、原样复用和旧/原生服务实际 TLS 互传及双端重启；报告 `artifacts/tauri-migration/lan-identity/verification.json`。仅使用隔离 profile、回环网络和显式 stdin 确认，与常规无窗口及其他原生/网络套件串行。

- npm run test:tauri:lan:discovery：构建独立 Rust 服务驱动，使用实际回环 UDP/HTTPS、隔离临时身份/文件及较短测试时序验证发现、保活、地址占用、端点重启续传和停止；报告 `artifacts/tauri-migration/lan-discovery/verification.json`。适配器参考来自独立 Node 网络接口；不修改防火墙、不访问生产数据、不代替物理广播/双机或桌面入口，须与所有原生/网络及 check:silent 套件串行。

- npm run test:tauri:lan:sender：构建独立 Rust 服务驱动，以隔离临时 profile 和回环 TLS 验证实际旧模块接收、双端进程重启续传、Rust 双向并发、坏回复/源变化/写盘失败和控制收尾；报告 `artifacts/tauri-migration/lan-sender/verification.json`。旧模块运行于 Node，批准来自显式开发输入，不代表桌面入口、物理双机或生产回退已完成；须与所有原生/网络和 check:silent 套件串行。

- npm run e2e:tauri:screenshot:documents：构建双运行时，验证主窗专属截图文档、四格式源图、二进制/容量边界、首次交付失败清理与已有源图重试、主窗回收否决、维护恢复、共享编辑器真实 PNG 保存、备份恢复及重载撤权；报告为 artifacts/tauri-migration/screenshot-documents-native.json。原生套件须串行运行，不代表完整截图或生产捕获已经完成。
- npm run e2e:tauri:screenshot:output：构建双运行时，验证真实 Electron PNG/JPEG 输出/系统剪贴板差分、原生另存为/覆盖确认、事务去重/失败重试、显式历史及原生序列去重、32 MiB 边界与生命周期；报告为 artifacts/tauri-migration/screenshot-output-native.json。测试会保存并恢复原剪贴板，仅操作隔离临时目录，不能代替物理 DPI、Release 性能或打包验收。
- npm run e2e:tauri:screenshot:drop：构建双运行时，以真实 OLE/CF_HDROP 验证截图四格式文件导入、精确路径授权、32 MiB 边界、失败重试与旧源保留、隐藏/输入/对话框/忙碌落点及维护/备份恢复/重载撤权；报告为 artifacts/tauri-migration/screenshot-drop-native.json。需 MSVC 编译隔离拖入源夹具及可交互 Windows 桌面，须与其他原生及 check:silent 套件串行，不代替手工 Explorer 或物理混合 DPI 验收。
- npm run e2e:tauri:screenshot:window：构建双运行时，以隔离 Electron 实际窗口与真实 WGC 验证窗口列表、共享选择器取消、受控令牌、缩略图/完整截图像素和撤权边界；报告为 artifacts/tauri-migration/window-capture-native.json。仅验证窗口来源和捕获后端，尚非完整 startScreenshot/区域覆盖层/全屏/贴图流程，须串行运行。
- npm run e2e:tauri:screenshot:lifecycle：构建双运行时，验证截图覆盖层的私有检查点、活编辑器状态冻结/恢复、错误令牌与目的拒绝、真实超时、重载撤权、原生另存为与收纳退出取消及正常退出；报告 artifacts/tauri-migration/capture-lifecycle-native.json。须与其他原生及 check:silent 套件串行，仅使用隔离目录；不代表截图主动重载、崩溃或重启持久恢复。
- npm run e2e:tauri:screenshot:capture：构建双运行时，验证 Window/FullScreen 业务启动、独立最小权限覆盖层、真实 Worker 保存/剪贴板及失败重试、原生延迟与撤权、取消/重载/实际保存对话框边界；报告为 artifacts/tauri-migration/capture-overlay-native.json。须与其他原生及 check:silent 套件串行，Region、贴图与维护/退出另有独立专项，本套件不代表物理多屏验收。

- npm run dev：原有 Electron 开发入口。
- npm run e2e:electron:drafts：构建并启动真实隔离 Electron，验证当前 file-origin 下全窗口草稿导出、保存/重载故障与目标文件保护；不使用生产工作区或系统剪贴板。测试替换系统对话框返回值，不能作为真实文件选择 UI 或旧安装路径 origin 兼容证明。
- npm run e2e:electron:drafts:legacy：构建并以真实旧 ASAR、同配置正常退出/重启和恶意页面夹具验证受控旧 file URL 读取、协议/窗口清理、真令牌外来响应拒绝及当前应用回归；不运行旧 EXE，不读取生产数据或解析 LevelDB。使用已安装的 @electron/asar 创建纯测试归档，报告 artifacts/tauri-migration/electron-legacy-drafts-native.json；目录/结果对话框由夹具返回，不能当作真实选择 UI 或不同 profile 兼容验收。
- npm run e2e:migration:ownership：构建 Electron 与 Tauri Debug，验证实际启动拒绝、Node/Rust 目录身份双向互斥、终止后释放及原始工作区保留；两个运行时使用不同临时根，报告 artifacts/tauri-migration/workspace-ownership-native.json。不能作为不识别协议旧版检测或生产切换已完成的证据。
- npm run e2e:tauri:migration:processes：构建 Tauri Debug 并编译只读等待进程夹具，验证标准旧版名称的初始拒绝、保存中出现、Ready 后重启、多窗恢复与任务草稿保留，以及相似名称不误判；报告 artifacts/tauri-migration/legacy-processes-native.json，不运行用户旧安装或终止其他应用。
- npm run e2e:tauri:migration:lineage：构建 Electron 与 Tauri Debug，真实 Electron 导出并正常退出后，由 Rust 在同一隔离物理目录验证原始字节、本地回执、实际主窗角色和 Ready 租约；报告 artifacts/tauri-migration/draft-lineage-native.json。数据目录覆盖仅限显式测试根，原生套件顺序运行；不读写生产数据、不执行浏览器导入，不代表产品迁移入口或同账户恶意篡改防护完成。
- npm run e2e:tauri:migration:transaction：构建双运行时，用真实 Electron 导出/正常退出、真实 WebView2 暂存、原生 profile/日志绑定与持久副本验证重启自动恢复和原生结果确认；报告 artifacts/tauri-migration/draft-transaction-native.json。覆盖日志/键与完成应答丢失、坏副本、不同物理 profile、已消费不复活；改变的浏览器日志以同进程实际页面重载验证。测试直接调用隔离维护/暂存命令，不是产品文件选择导入、物理断电或生产切换验收。
- npm run e2e:tauri:migration:electron-handoff：构建双运行时，实际 Tauri 导出后由准备 Electron 原生内核接收，再验证 pending／未完成决定阻断实际 Tauri 启动及显式恢复完成后放行；报告 artifacts/tauri-migration/electron-draft-handoff/verification.json。Electron 内核在 Node 中使用内存目标和测试绑定，不代表产品 Electron 导入或真实 profile 已实现；与所有原生／网络及 check:silent 套件串行。
- npm run e2e:tauri:drafts:maintenance：构建并验证隔离原生草稿维护检查点、权限/写入屏障、异常恢复与租约；报告 artifacts/tauri-migration/draft-maintenance-native.json。依赖 PowerShell 7 的系统剪贴板夹具，退出测试应用后恢复原内容；不能与其他原生套件并行运行，不是生产迁移或真实 IME 验收。
- npm run dev:tauri：打开隔离的原生验证界面，不读取正式工作区。
- npm run dev:tauri:workspace：直接打开隔离的共用 React 主页面；第一次需明确创建工作区。
- npm run build:tauri -- --debug：构建独立验证 EXE，不生成发布安装包。
- npm run check:tauri：TypeScript、Tauri 前端构建、Rust 单元测试。
- npm run e2e:tauri:prototype：构建并执行真实 WebView2 原型回归与后台启动验证。
- npm run e2e:tauri:workspace：构建并执行隔离工作区的真实多窗口、旧格式及图片资产差分和故障回归，报告位于 artifacts/tauri-migration/workspace-native.json；开始运行时先清除旧成功报告，失败不生成新成功报告。
- npm run e2e:tauri:app：构建并验证直接入口、主页面编辑/重新加载和退出故障；报告位于 artifacts/tauri-migration/app-native.json，仍明确列出未完成的全部生命周期范围。
- npm run e2e:tauri:productivity：构建并验证原子业务的实际 Electron IPC 差分、共用回收站/专注页面，以及无窗口后台检查点恢复和失败重试；报告为 artifacts/tauri-migration/productivity-native.json 和 productivity-background.json。
- npm run e2e:tauri:backup：构建并验证隔离备份双向兼容、共用界面与恢复故障；报告为 artifacts/tauri-migration/backup-native.json，界面截图为 backup-recovery.png 和 backup-shared-app.png。
- npm run e2e:tauri:resources：构建并验证资源检查、Electron IPC 差分、共用页面重新关联、并发取消与恢复/退出清理；报告为 artifacts/tauri-migration/resources-native.json。
- npm run e2e:tauri:system：构建并使用真实原生对话框和 Shell 验证选择/取消、授权打开及模态退出/恢复；Windows 测试还需要 PATH 中的 PowerShell 7（pwsh.exe）和 .NET Framework C# 编译器，报告为 artifacts/tauri-migration/system-native.json。
- npm run migration:inventory：重新从 TypeScript AST 生成完整公共接口清单。
- npm run e2e:tauri:organizer：构建并验证隔离文件的手动收纳/分类转移/恢复/撤销、Electron 差分及共用页面；报告为 artifacts/tauri-migration/organizer-native.json，截图为 organizer-shared-native.png。不访问真实桌面。
- npm run e2e:tauri:organizer:cross-volume：构建并验证实际不同卷上的双向移动与元数据失败自动补偿，要求隔离数据目录和项目 artifacts 目录位于不同卷；不满足时明确失败，不静默跳过。原生套件须串行执行，避免单实例互斥造成测试干扰。
- npm run e2e:tauri:organizer:smart：构建并验证实际 Electron 规则预览/确认批量差分、部分失败、身份与角色限制、真实共用页面和逐项撤销；报告为 artifacts/tauri-migration/organizer-smart-native.json，不访问真实桌面。
- npm run e2e:tauri:organizer:session：构建并操作真实原生退出确认，验证保存/取消/保留/恢复、实际进程重启与 Electron 双向身份兼容；报告为 artifacts/tauri-migration/organizer-session-native.json。测试只复用本套件创建的临时根，并串行运行，不能用于生产数据。
- npm run e2e:tauri:identity：构建并使用 48 个固定分数创建时间的真实 Electron 文件记录验证原生重收纳、严格身份拒绝、3 次进程重启、保存及备份恢复的精确 JSON 数值往返；报告为 artifacts/tauri-migration/identity-native.json。测试依赖 PowerShell 7，仅修改隔离临时文件，不访问真实桌面或剪贴板；原生套件须串行运行。
- npm run e2e:tauri:widgets：构建并验证真实组件窗口、Electron 布局预设差分、权限裁剪、预览零写盘、实际 Win32 移动与保存并发、磁盘故障、任务/便签编辑、全窗口退出确认及重启可见性；报告 artifacts/tauri-migration/widgets-native.json。依赖 PowerShell 7/内置 Add-Type 作为原生移动测试夹具，仅移动按本套件 PID 和已测矩形定位的窗口；工作区和 WebView 均隔离，不访问真实桌面文件或系统剪贴板，原生套件须串行运行。
- npm run e2e:tauri:search：构建并验证真实 Electron 搜索差分、缓存与取消、保存并发、精确结果权限、共用搜索栏与实际 Shell 打开；报告为 artifacts/tauri-migration/search-native.json。AppData/开始菜单与其他文件均为隔离夹具，不访问真实用户搜索目录。
- npm run e2e:tauri:metrics：构建并验证原生系统指标、独立 Windows 参考、真实刷盘负载、并发缓存、共用检测页、退出与权限、句柄释放；报告为 artifacts/tauri-migration/metrics-native.json，截图为 monitor-shared-native.png。测试依赖 PowerShell 7 获取参考值，产品采集不启动辅助进程；仅写本套件临时文件，不修改系统网络、计数器、防火墙或生产工作区。
- npm run e2e:tauri:startup：构建并验证隔离的原生 Run 设置、真实拒写/恢复、共用设置页与隐藏进程重启；报告为 artifacts/tauri-migration/startup-native.json。测试依赖 PowerShell 7，仅操作按测试目录哈希定位的测试注册表子键，不写真实 Run 或模拟 Windows 登录；原生套件须串行运行。
- npm run e2e:tauri:clipboard：构建并验证真实剪贴板读写/位图、按记录授权的缩略图/预览、占用重试、共用界面和生命周期。报告为 artifacts/tauri-migration/clipboard-native.json；测试依赖 PowerShell 7、STA 和 System.Windows.Forms，仅使用测试工作区并保存/恢复原系统剪贴板，原生套件须串行运行。
- npm run e2e:tauri:clipboard:monitor：构建并显式启用隔离测试目录的真实 Windows 更新通知，验证后台入库、失败重试、去重、恢复/退出协调及无 WebView 隐藏重启；报告 artifacts/tauri-migration/clipboard-monitor-native.json。依赖 PowerShell 7/STA，并保存和恢复原系统剪贴板；不得与其他原生套件并发运行。
- npm run e2e:tauri:clipboard:shutdown：构建并验证已接收文本/图片候选的正常退出保存、写盘失败否决/原候选归还、恢复与禁用失效、真实 Win32 延迟渲染超时及重启去重；报告 artifacts/tauri-migration/clipboard-shutdown-native.json。依赖 PowerShell 7/STA 与内置 Add-Type C# 测试夹具，正常测试会故意阻塞一次读取超过 10 秒；保存/恢复原系统剪贴板，原生套件须串行运行。
- npm run e2e:tauri:desktop：构建并验证隔离桌面枚举、真实菜单/Explorer/剪贴板故障及生命周期；报告为 artifacts/tauri-migration/desktop-native.json，共用页面截图为 desktop-shared-native.png。测试需 PowerShell 7、.NET Framework C# 编译器和可交互桌面，产品运行不依赖 PowerShell。
- npm run e2e:tauri:icons：构建并验证 Windows 实际资源/Shell 图标、Electron 像素差分、授权及句柄释放；报告为 artifacts/tauri-migration/icons-native.json，对比图为 icons-native-comparison.png，测试依赖 PowerShell 7，产品运行不依赖 PowerShell/Node 进程提取图标。
- npm run e2e:tauri:note-images：构建并验证原生背景选择、六格式字节与 Electron IPC 差分、共用便签页和恢复/退出；报告为 artifacts/tauri-migration/note-images-native.json，截图为 note-background-shared.png，同样依赖 PowerShell 7。
- npm run e2e:tauri:widgets:business：构建并验证真实组件角色/资源授权、共享业务 UI、原生文件菜单、剪贴板复制与定向通知、按窗口隔离搜索及恢复撤权；报告为 artifacts/tauri-migration/widget-business-native.json。链接正向浏览器导航、全部草稿和生命周期/性能门槛尚未由本套件证明。
- npm run e2e:tauri:widgets:release：构建并验证保守组件回收、草稿/选择状态否决、真实超时、原生文件菜单、磁盘失败、退出竞争及最后 WebView 回收；报告为 artifacts/tauri-migration/widget-release-native.json，不能代替 Release 内存或真实 IME 验收。
- npm run e2e:tauri:widgets:events：构建并验证原生组件事件通道的真实窗口/角色隔离、权限拒绝、大快照、重连与销毁重建；报告为 artifacts/tauri-migration/widget-events-native.json。
- npm run e2e:tauri:widgets:drafts：构建并验证桌面任务输入草稿的实际退出/重启、失败保存保护、清理幂等与工作区错误重试；报告为 artifacts/tauri-migration/task-drafts-native.json，不代表旧浏览器草稿迁移完成。
- npm run e2e:tauri:main:release：构建并验证干净概览的原生回收、同进程布局、实际失败队列/原生会话保护、显示与退出竞争、零主窗后台及单实例重建；报告为 artifacts/tauri-migration/main-release-native.json，不代表编辑页面检查点或 Release 内存门槛完成。
- npm run e2e:tauri:hotkeys：构建双运行时，显式启用测试系统快捷键，验证五类动作、零 WebView 后台、系统占用／写盘失败回滚、配置恢复、窄权限与剪贴板贴图像素／超时；报告 artifacts/tauri-migration/hotkeys-native.json。使用 Windows 原生注册与按键注入、通知区域菜单及延迟剪贴板提供者，保存／恢复原剪贴板；与所有原生及 check:silent 套件串行，不代表物理键盘／IME 或完整迁移验收。
- npm run e2e:tauri:quick-capture：构建双运行时并验证快速记录的窄权限、保存幂等、草稿与窗口检查点、维护／退出及无主窗原生托盘入口；报告 artifacts/tauri-migration/quick-capture-native.json。须与其他原生及 check:silent 套件串行；正常重启通过不代表强杀或电源中断恢复已验证。
- npm run e2e:tauri:drafts:format：构建双运行时，验证共享草稿格式/存储内核、真实 WebView2 写入失败与共用编辑器双向恢复；报告为 artifacts/tauri-migration/draft-format-native.json，不代表生产迁移文件入口或全窗口排他协议已经完成。
- npm run e2e:tauri:drafts:export：构建 Tauri 并验证真实保存对话框、脏编辑器收拢、原生来源回执、写盘失败重试、租约超时及退出后准备 Electron 模块核验；报告 artifacts/tauri-migration/draft-export/verification.json。须与其他原生及 check:silent 套件串行，不代表 Electron 反向导入或生产回退完成。
- npm run e2e:electron:drafts:control：构建并验证真实 Electron 空白受控页面、原生观察／物理 profile 绑定、伪造响应拒绝与取消恢复；不代表普通页面可以自行取得导入授权。
- npm run e2e:electron:drafts:import：构建并验证真实 Electron 菜单和全部编辑器屏障、服务停机、待决配对取消、迟到文件选择与 LAN 初始化拒绝、磁盘故障、只读记录启动阻断／显式重试及已消费输入防重放；该套件截获文件／导入确认对话框，配对专项使用真实 Windows 消息框，需可交互桌面及 PowerShell 7／STA；须与其他原生及 check:silent 套件串行。
- npm run e2e:tauri:migration:reverse：构建两个运行时，验证实际 Tauri 导出、同一隔离物理工作区交还及 Electron 菜单导入／重启／任务实际提交；不操作生产目录或伪造原生导出来源。
- npm run check:tauri:drafts:reverse：串行检查 Node／无窗口、Rust／Clippy／Release check／fmt、Debug 构建及十二套相关原生回归，核对前后源码与执行日志摘要；该命令耗时较长，不能与其他原生套件并发。
- cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings：Rust 严格检查。

- npm run e2e:tauri:screenshot:pins：构建双运行时，验证原生贴图、私有事件连接、共享 Worker PNG/JPG 保存、真实右键菜单与 Windows 通知区域分层菜单点击、统一显示/隐藏/恢复/关闭和空菜单禁用、再编辑与更新、主窗重载/恢复和空闲退出；报告为 artifacts/tauri-migration/pins-native.json。依赖可交互 Windows 桌面、PowerShell 7/STA，保存/恢复系统剪贴板；与其他原生及 check:silent 套件严格串行，不代表其他托盘入口、物理混合 DPI 或完整截图检查点验收。
- npm run e2e:tauri:screenshot:native：构建双运行时，实际点击原生托盘区域／全屏入口，验证已初始化隔离工作区的零 WebView 启动、取消后释放、独立贴图和主页面冷启动交接、真实准备超时重试、重载保留来源及维护拒绝；报告 artifacts/tauri-migration/native-capture-native.json。使用 PowerShell 7/STA 和测试专用调试连接，产品不依赖调试器；须与其他原生及 check:silent 套件串行，不代表全局快捷键或完整截图生命周期通过。

## 隔离与操作说明

- 预览应用标识为 com.dustdesk.tauri.preview，与正式应用分开；WebView 数据使用该预览应用的 LocalAppData 目录。
- 测试通过 DUSTDESK_TEST_USER_DATA_DIR 设置临时绝对路径，关闭后清理，不读写真实桌面或工作区。
- 预览在隔离工作区初始化／恢复就绪后应用其中保存的五类快捷键，冲突明确报告；普通自动化使用 DUSTDESK_TAURI_DISABLE_HOTKEYS 禁用。快捷键专项显式启用，并只使用测试前核验空闲的 Ctrl+Alt+Shift+F13–F24，退出后核验释放。
- 关闭主窗口驻留托盘；明确点击退出或托盘退出才结束。穿透后从主控制窗口或托盘恢复鼠标操作。
- 原生测试仅给所启动的 WebView2 传入本机调试端口，清理时关闭整个测试进程树；不得把调试配置加入正式构建。
- 通用图标继续使用静态导入的 Lucide，沿用主题变量；Shell 文件图标已接入受控原生 API，启动器与收纳/搜索组件调用者已有角色隔离验证，完整主题/DPI/辅助技术及打包验收仍待完成。

## 尚需验收

- 混合 DPI、显示器拔插、睡眠恢复、实际中文输入法组合输入、原生 Shell 文件拖入、物理键盘／睡眠恢复中的快捷键和其他托盘入口；贴图逐项与批量控制已通过本机真实通知区域点击专项，不代替其他入口验收。
- 截图剩余公共适配器、完整物理交互与长期生命周期验收；覆盖层的同进程维护/退出检查点已接入并有隔离专项，原生贴图/再编辑及托盘统一控制、窗口来源、区域/全屏/窗口捕获、转主编辑页和真实截图 OLE 拖入已接入隔离预览，但仍需物理混合 DPI、长期资源释放与安装产物验收，不将隔离 Debug 用例视为全功能通过。
- 更完整的旧格式与规范化样本集、全部主页面功能和完整适配器、生产一致快照／数据和身份接管、完整生产草稿双向交还与全部崩溃边界、全部参与窗口与服务的退出协议。隔离双运行时草稿导入／导出及正常重启恢复已有专项，不等于这些生产门槛完成。
- 五轮 Release 同环境完整业务内存对比、两台物理电脑新旧互传、缺失 WebView2、真实安装 EXE 与实际绿色 ZIP、回退演练。
- 未通过这些条件前，不切换正式入口，不移除 Electron，也不标记迁移完成。
