# 整体运行工作区与浏览器交还

## 当前实现范围

- 当前实现 Debug 专用 TEMP 的原生终态内核，以及隔离宿主的显式 stdio 封存与只读冷恢复；真实浏览器专项已通过。新增 Electron 整体封存维护入口、持久启动屏障和退出后独立原生复核已通过本轮冻结回归与独立审计；向原 Data／Session 应用新内容仍未接入。默认入口仍为 Electron，版本 1.0.2；普通业务仍未在迁移所有权下开放。
- `RuntimeOwner::seal_runtime_preview` 要求实际运行所有权、原组合快照护栏和已经持有的物理浏览器绑定。内核接收宿主提供的归档，核验包格式、Tauri 来源、工作区摘要及物理 profile/origin 指纹，本身不读取 WebView2。现有隔离宿主在排空服务后从实际隐藏 WebView2 收集白名单原文，再调用该内核；内核单元测试仍采用构造归档，不等于普通编辑器最终保存验收。
- 当前 Data 全量枚举与固定复用既有原生文件机制，包含合法新文件、未知字段、资产和空目录；只排除普通 `workspace.lock`。工作区采用当前字节摘要，不回放原快照。每个文件保存实际身份、大小、时间、只读属性和完整 SHA-256，保留句柄直到所有者释放，新增／缺失条目或替换均拒绝确认。这里固定实际运行 Data，未另外复制一份资产备份。
- 原 LAN 未采用时核验原检查点；已采用时必须先完成同一授予的真实服务排空和持久交还。终态绑定实际最新 LAN 检查点与专用交还意图摘要，活动服务不能直接封存，也不能通过整体恢复重新开启网络服务。

## 持久记录与恢复

- 记录位于原运行授予的 `Ownership/<UUID>/RuntimeHandback/`，独占创建该目录立即阻断普通权限确认、原浏览器归档读取、普通可写恢复、LAN 服务恢复和旧 LAN 专用恢复路径。
- 先刷盘发布 `intent.json`，绑定原授予完整回执摘要、最新工作区／Data 清单摘要、草稿归档证明、原物理浏览器绑定及 LAN 终态；然后分别发布有界 `data.json` 和 `browser-drafts.json`，最后发布绑定意图摘要的 `decision.json`。完成决定仍声明 productionReady=false、migrationComplete=false，不构成生产激活许可。
- 发布采用既有原生目录／文件句柄和不可覆盖发布；载荷各限 64 MiB，记录元数据限 128 KiB。失败不删除记录、不回滚最新 Data，也不把返回的 JSON 视作仍持有目录独占的权限。
- `resume_runtime_for_handback_preview` 只重新取得原来源／快照／授予、同一输出 Data 和原物理浏览器配置，继而由 `resume_runtime_handback_preview` 验证记录与当前完整清单。完整载荷但缺决定时可继续发布同一决定；已有成功决定只核验，不改写意图、草稿或资产。
- 空目录、仅意图、缺载荷、孤立决定、未知临时文件、篡改或物理身份不符均保持阻断并保留现场。当前没有为缺失载荷推断完成、自动重建浏览器归档或重新授予写入的修复入口。
- 此恢复只核验已保存的归档及配置绑定，不证明重启后实际 localStorage 与归档一致；也不替代关闭实际子进程后由接收运行时重新取得并核验当前文件的交接握手。

## 验证入口

- `cargo test --manifest-path src-tauri/Cargo.toml --lib runtime_handback`：六项原生测试验证最新 Data／资产／空目录、草稿原文保留、普通恢复阻断、实际 LAN 服务排空、决定前中断与成功响应丢失、未知／损坏／换 profile／同大小同时间资产篡改拒绝。它们复用测试内最小可信代码夹具；中断由原生回调故障注入，不是真实进程 SIGKILL 或物理断电。
- `node scripts/verify-runtime-handback.mjs`：冻结全部源码／配置／测试／脚本，串行执行 Node／无窗口、主进程 TypeScript、Rust 全目标、两项 ignored 的正式字节补验、严格 Clippy、Release check、fmt、实际 Debug 构建，以及原 LAN 运行／交还／冷恢复和双运行时启动五套既有回归。新接口尚未由这些既有 GUI 场景调用，不能将它们写成新交还入口的端到端验收。
- 内核历史结果保留于 `artifacts/tauri-migration/runtime-handback-kernel-final/verification.json`；浏览器阶段结果保留于 `runtime-handback-browser-final/verification.json`，当前桌面封存与屏障的结果为 `runtime-handback-desktop-final/verification.json`。上一轮完整 LAN 验收继续保留于 `original-lan-runtime-final/`，不覆盖为新源码结果。
- 内核阶段最终于 2026-11-14 09:33:42（北京时间）通过 14 步冻结回归：581 项输入保持一致，235 项 Node、4 项无窗口、542 项 Rust 和五套／24 项实际进程集成测试通过；两项默认 ignored 的真实工作区／正式字节测试分别显式补验。主进程 TypeScript、严格 Clippy、Release 全目标、fmt 与实际 Debug 构建通过。09:34 独立 `evidence-audit.json` 复核完整输入、日志、原生证据、产物摘要及 2,041 个历史 TEMP 根不变；项目测试进程只读核验无残留。该批结果是接入浏览器前的历史内核验收，不能计作下列新入口已通过。

## 隔离宿主浏览器封存

- 在已收到同请求 `continueRuntime` 后，客户端可显式发送 `sealRuntime`。普通 EOF 保持原行为，不隐式封存。新请求立即停止浏览器导入及 LAN 准入，串行排空实际服务和原生确认，再要求本次浏览器已达到原生 Ready。
- 原生固定实际 WebView2 配置／来源和页面代次，读取当前工作区原始字节与白名单 localStorage，复用既有 UTF-16 值验证和归档生成。客户端不提供条目、归档、预期摘要、profile 或输出路径；pending 日志、未知草稿版本和读取中重载会阻断。当前只有隐藏恢复页，因此本路径不代表普通编辑器的最终保存屏障已实现。
- 整体决定完成后销毁恢复 WebView，返回 `runtimeHandbackSealed` 元数据；原所有权、Data 文件／目录及物理 profile 仍被固定，持续核验来源与终态，直到客户端关闭连接或发送最终消息，再退出真实宿主。返回的 JSON 不是可写许可，接收方仍须等待实际进程退出并重新核验。
- 新连接显式发送 `recoverRuntimeHandback` 及原准备／运行／所有权 ID，只取得原终态并核验同一 Data／profile／LAN，返回后保持独占至关闭。该路径不创建 WebView、可写 WorkspaceStore 或网络服务，只能关闭；普通 `launchRuntime` 不能重新开放已封存授予。
- 新增真实浏览器／进程用例位于 `tests/tauri-runtime-bootstrap.mjs`，完整运行于 2026-11-14 10:29:41（北京时间）通过 10 个子场景／11 项测试，无过滤、失败、取消或跳过。验证最新 Data／资产／空目录、精确草稿原文与空值／墓碑、保持原 Data 不变、正常关闭及封存决定后真实 SIGKILL、各两次不改写的冷恢复、实际原 LAN 监听关闭与身份保留，以及 pending 日志、未来版本、读取中重载拒绝且不生成终态记录；保留原导入／强杀恢复／来源撤权回归。
- 封存前最新 Data 变更由隔离文件夹具写入，不能算普通编辑器保存；冷恢复核验归档和 profile 身份，尚未读取重启后实际 localStorage。新增真实 SIGKILL 仅覆盖封存决定之后，内核其他写入边界仍为回调注入。此入口未连接原 Electron Session 应用事务或整体维护结束。
- `npm run check:tauri:runtime-handback` 冻结本轮源码／配置／脚本／测试，执行 14 步串行验证，包括上述完整浏览器套件和既有 Electron／LAN 回归。开发失败与定向诊断由最终目录的 `history.json` 绑定，定向成功不替代完整验收；开发阶段两次普通 Electron 保存重命名 EPERM 仍未定位，不因本轮无窗口通过而计为已修复。
- 最终于 2026-11-14 10:35:02（北京时间）完成全部 14 步：583 项输入保持一致，235 项 Node＋4 项无窗口、542 项 Rust、五套／30 项集成测试全部通过，两项默认 ignored 分别显式补验。主进程 TypeScript、严格 Clippy、Release 全目标检查、fmt 和实际 Debug 构建通过；报告标记 verified=true、sourceStable=true，productionReady=false、migrationComplete=false。
- 10:35 的独立 `runtime-handback-browser-final/evidence-audit.json` 重算完整输入、命令日志、原生证据、产物、历史内核报告及 12 份开发记录摘要，核对完整浏览器无过滤参数、两类关闭后各两次恢复、LAN 监听关闭和重载拒绝。冻结前后与当前 2,041 个严格小写 `dustdesk-*` TEMP 根完全相同；`process-cleanup.json` 只读核验项目测试进程无残留。重载场景实际诊断为草稿回调无效／超出白名单，证明拒绝且不发布终态，不单独证明该次由页面代次检查拒绝。

## Electron 整体封存维护入口（已验收）

- 新增开发菜单“验证整体运行交还（开发临时数据）”，沿用实际 Electron Session、全编辑器保存与维护、工作区独占和可信组合准备。原草稿／原 LAN 专用验证菜单继续保留原语义。
- 在确认本次原生运行 Data／浏览器绑定后、发送 `continueRuntime` 和启动 LAN 之前，刷盘并不可覆盖发布原 profile 中的 `RuntimeHandbackPreview.json`。屏障绑定原准备／运行／所有权 ID、原来源位置和摘要、输出 Data 身份及物理浏览器绑定；它只阻断准入，不提供原生权限。
- 屏障存在后即保留全编辑器维护。显式结束发送 `sealRuntime`，等待服务排空、原生最终读取和封存，再等待实际子进程正常退出；随后启动独立原生进程重新取得同一授予，以 `recoverRuntimeHandback` 核验完整当前 Data／profile／LAN 和同一回执，等待该恢复进程正常退出。
- 成功复核仍不恢复旧编辑器、原 LAN 或解除屏障。取消、异常、未知／缺失终态及资产变更也保留屏障；核验菜单仅重试原生只读恢复。退出绕过普通保存／收纳恢复，保留最新内容与现场，不把旧快照回放成当前状态。
- 重启首先处理整体屏障，早于草稿恢复、普通窗口和后台服务；持有屏障时只取得已存在的原 Data，不补建缺失目录。当前启动入口只能“退出并保留记录”或“核验整体交还后退出”，完整 Data／Session 应用事务接通前不能继续打开旧编辑器。
- `npm run e2e:electron:runtime-handback` 为实际 Electron／WebView2 专项；`npm run check:electron:runtime-handback` 冻结输入并执行 15 步回归。测试的最新运行 Data 变更仍为文件夹具，封存读取的草稿来自实际 WebView2；不计普通 Tauri 编辑器最终保存、向原 Data／Session 应用事务或生产回退已完成。
- 开发轮实际专项三个场景／4 项全部通过：正常封存、真实 LAN 排空、宿主退出后的独立接收方复核及启动零普通窗口；封存后真实 SIGKILL 与显式只读恢复；最终读取前取消后保留屏障并拒绝缺失终态。正常场景还验证更改已封存资产后重启恢复拒绝，原 Data／Session 不改写。首次夹具格式失败和成功轮报告／当时夹具分别保留于 `runtime-handback-desktop-development/attempt-1/`、`attempt-2/`，与最终冻结结果分别保存。
- 最终于 2026-11-14 11:32:59（北京时间）完成 15 步冻结回归，真实进程退出码为 0：587 项输入保持一致，239 项 Node＋4 项无窗口、542 项 Rust、六套／34 项集成测试全部通过，两项默认 ignored 分别显式补验。主进程 TypeScript、严格 Clippy、Release 全目标检查、fmt 与实际 Debug 构建通过；`runtime-handback-desktop-final/verification.json` 标记 verified=true、sourceStable=true，productionReady=false、migrationComplete=false。新增专项三个场景／4 项全部通过，包含最终增加的精确草稿原文／空值、Data 清单与归档摘要、实际宿主退出先后、重启记录字节不变和取消后终态目录缺失断言。
- 11:34 独立 `runtime-handback-desktop-final/evidence-audit.json` 重算完整输入、每步日志、原生证据、产物、旧基线及 12 份开发记录摘要；六次导入／LAN 准入命令前屏障均存在，实际宿主 close 早于独立接收方恢复，重启提示时普通窗口为零，并核验一次封存后真实 SIGKILL。2,041 个严格小写历史 TEMP 根前后与审计时完全一致，`process-cleanup.json` 只读核验无项目测试进程残留；Rust 输入相对上一浏览器基线未改变。
- 独立审计首次因脚本将两项 LAN helper 的摘要与 Tauri 主程序比较而失败；两项测试实际构建、启动和计算摘要的均为 `original-lan-recovery.exe`。仅修正审计的可执行文件映射后完整重审通过，源码、测试报告和产物字节未改；原审计脚本／失败日志及修正说明保留为 `audit-first-failure.mjs`、`audit-first-failure.log` 和 `audit-correction.json`，修正说明摘要绑定于成功审计。

## 接续工作

- 当前接续实现整体应用的持久输入准备，尚未向原 Data／Session 写入。`prepareRuntimeApplication` 与 `resumeRuntimeApplication` 只在 Debug 专用 TEMP 的 `recoverRuntimeHandback` 已重新取得同一封存所有权之后接受；IPC 不接收路径、草稿、清单或预期摘要。原整体屏障保持，准备目录不能成为普通可写运行目录。
- 原授予旁的 `RuntimeApplication/` 先刷盘发布 `preparing.json`，绑定原来源、完整封存回执、原／新清单摘要和原草稿证明；从最新 Data 实际固定句柄复制 `Incoming/`，保留完整文件／空目录、大小、时间、只读属性与 SHA-256，再保存原／新清单、两份草稿归档、精确差异计划和副本物理清单。最后不可覆盖发布准备决定；回执的 applicationReady、originalDataApplied、sessionApplied、productionReady、migrationComplete 均为 false。
- 草稿计划复用原生白名单校验，按 UTF-16 键排序，区分键缺失、空字符串、墓碑与原始 JSON 文本，包含覆盖、新增与缺失键删除；不包含无关存储。复制的 `MigrationTransaction.json`、`ElectronMigrationTransaction.json`、`MigrationLineage/lineage.json` 仅为历史原字节证明，不重绑定、不采用，也不放宽物理 Data 身份验证。
- 完整载荷但缺准备决定时，显式恢复只能续发同一准备决定；仅初始标记、缺载荷、未知文件、目录替换或完整摘要不符保持阻断并保留现场。两套源和副本均保持固定，实际输入准备进程退出后才允许后续进程重新取得。当前没有从部分复制推断应用成功的路径。
- 开发轮 7 项新增 Rust 测试和严格 Clippy 已通过，覆盖只读元数据、三类控制记录原字节、精确草稿计划、原数据仍固定、决定前回调中断、两次冷恢复、未知内容、同大小同时间篡改和空目录替换拒绝。真实进程专项与新冻结入口 `npm run check:tauri:runtime-application-inputs` 尚在验证，不能将上方 587 项输入／542 项 Rust 的旧桌面基线算作当前 Rust 源码已验收。
- 独立 Windows 句柄探针确认：目录内仍持有拒绝 DELETE 共享的文件或子目录句柄时，即使顶层目录具备 DELETE 权限，按原生目录句柄重命名也返回错误 5；无子句柄时成功。证据保存在 `runtime-application-directory-probe.ps1/.json`，仅是隔离文件系统探针，不是应用或断电恢复验收。真正替换须在持久原检查点和最新决定成立后显式转移固定权，不能假定保留全部旧句柄仍可整体移动目录。

- 桌面封存与重启屏障的实际专项、冻结回归及独立审计已通过；接续实现整体 Data／Session 应用事务。普通 Tauri 编辑器最终保存仍待后续开放业务时验证。
- 完成整体资产／工作区与草稿应用事务，验证失败及真实强杀边界；原工作区和原 Session 在成功决定与原生结果复核前继续保持冻结。当前封存不是向原 Electron Data／Session 应用新内容，也不是完整生产回退。
- 整体应用须使用同一已核验终态，包含最新文件／资产／空目录及删除语义，并在实际 Electron Session 中精确保留草稿原文、空值和墓碑；旧草稿单独导入的同名保留策略不能代替整体覆盖／删除决定。Data 与浏览器任一侧未完成时，屏障不能解除或开放编辑。
- 已有 `MigrationTransaction.json`、`ElectronMigrationTransaction.json` 与 `MigrationLineage/lineage.json` 绑定 Data 的物理目录身份；直接复制到另一目录后不能作为新目录的有效控制记录。应用协议须保留原记录证明并建立当前目录的新绑定，不能通过放宽现有身份校验、忽略未决记录或删除历史来绕过恢复。
- 应用继续保留正式 Data 路径，不能以临时运行目录替代。释放原来源的文件固定句柄前，须持久绑定原检查点与最新封存决定；开始应用后可能已有部分原文件改变，恢复入口须先核验应用记录，再执行适用于该阶段的检查，不能把合法的部分应用误判为原旧摘要变化，也不能把未知内容猜成已完成。
- 随后开放采用同一迁移所有权的普通编辑器与后台业务，验证跨会话继续；生产来源、持久切换、物理双机／输入法、Release 性能、安装 EXE／实际绿色 ZIP 与完整回退继续保留。
