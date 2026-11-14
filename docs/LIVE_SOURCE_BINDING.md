# 实际准备运行时的旧安装来源绑定

## 当前能力

- 准备 Electron 的“从旧安装目录导出草稿…”不再把安装目录字符串当成来源证明。保存全部实际编辑窗口并封存工作区后，启动本构建的临时 Rust 来源租约进程，原生核对正式旧版 EXE／ASAR，并贯穿受控浏览器读取、原生谱系记录和文件发布。
- 旧页面仍由当前准备 Electron 的空白、严格 CSP 页面截获，只运行当前受信 preload；不执行旧 EXE、旧主进程或旧 renderer。正式绿色 ZIP 必须精确匹配编译信任目录，已修改的 ASAR 在建立私有读取窗口之前拒绝。
- 实际路径来自 Electron 主进程的 `WorkspaceOwnership.root`、`app.getPath('userData')` 和当前 `Session.storagePath`，不是 renderer 参数、默认目录推测或旧包自报值。Rust 固定全部物理目录、`workspace.json` 身份／原始摘要、正式代码和存在的 LAN 目录，原生构造固定旧安装 file URL。Electron 主进程再次核对实际 Session、工作区独占所有权及真实目录身份。
- 这绑定的是用户当前启动的准备运行时，而不是证明旧程序历史上一定使用过该 Data／profile。实际 file-origin 必须可识别地读到草稿，空结果仍拒绝。不存在自动发现任意历史 profile 或跨 profile 猜测读取。

## 临时 Rust 进程

- 同一个 Tauri 可执行文件在唯一参数 `--legacy-source-lease-v1` 下，进入私有 stdin／stdout 协议并跳过普通 Tauri 启动，不创建 WebView、托盘或单实例窗口服务。正常启动入口不变。
- 开发路径固定为 `src-tauri/target/debug/dustdesk-tauri.exe`；准备 Electron 打包路径固定为 `resources/migration/dustdesk-tauri.exe`。不接受 renderer／环境变量指定 helper，不在找不到 helper 时回退为未认证读取。当前正式发布物未增加此 helper，打包与分发仍待后续验收，不宣称现有安装包已提供此功能。
- 每次操作使用随机请求 ID，只接受 `open`、同 ID 的 `confirm` 和 `close`，未知字段、阶段错误和伪确认均拒绝。消息每行最多 64 KiB，待处理队列有界；摘要逐 64 KiB 检查私有通道取消。父 stdin EOF、错误、超时、维护取消或主窗失效均关闭来源租约；结束导出后必须退出 helper，不作为常驻侧车。
- 这是当前受信主进程的私有子进程协作，不是本机其他原生进程的权限提升或安全隔离服务。普通 renderer 没有启动／访问该 stdio 通道的权限。JSON 展示信息不是可转交的来源授权，不能作为未来切换凭据。

## 目录与文件约束

- 安装、实际 Data 和实际 userData 必须为分离的本地盘物理目录；browser profile 必须等于或真实位于 userData 内，不能指向独立外部目录或 LAN 存储。拒绝重解析、硬链接文件、设备／网络路径和父级跳转；不创建缺失的运行时目录。
- 正式 EXE／ASAR 仍采用零共享只读句柄。工作区采用允许读取、拒绝写入与删除的单链接普通文件句柄，供当前受信主进程核对谱系，不允许既有写入者；检查前后比对身份、大小、修改时间及摘要。64 MiB 工作区上限是当前边界，不是完整大工作区迁移支持。
- 新测试实证发现，只有属性访问的目录句柄无法独立保证目录不被重命名，之前带打开子文件的测试不能证明空目录本身。底层 `Directory` 现在额外请求 `FILE_LIST_DIRECTORY`，保持原有共享和重解析拒绝规则；没有子文件句柄的目录及其祖先也必须阻止重命名。代价是所有固定目录需有实际目录读取权限；访问不足明确失败，不放宽 ACL 或退回属性句柄。
- 修复前两项实际绑定测试确实失败，日志为 `artifacts/tauri-migration/live-source-binding/directory-pin-before.log`；新增独立空目录回归。此修改影响共享 LAN／快照内核，因此除完整 Rust 与草稿／快照回归外，冻结验证器还增加实际 LAN 主机和跨运行时目录所有权检查。
- 当前仅固定 LAN 目录，**没有取得 LAN 排他租约或冻结其状态／原身份**；状态文件仍可由当前服务更新，测试显式保留这一事实。不创建状态、身份或锁文件；原先不存在的 LAN 目录若迟到初始化，则本次绑定失效，不悄悄省略。

## 导出与生命周期

- 旧安装分支使用 `draftMaintenance.run`，直到来源确认、谱系记录、临时导出文件落盘及发布结束后才恢复编辑器。保留原生维护超时与窗口丢失取消，不延长全局超时或自动重试。
- 发布临时文件前再次重新散列正式代码并核对原生工作区、目录和当前 Session；发布前检查观察到 helper 丢失或检查失败时，不覆盖既有导出文件，清理临时输出。已完成的原子发布不会因之后取消而自动撤销，不能把取消等同于“磁盘上没有输出”。保留现有 `draftExportWrite` 对归档构造、谱系和写入全阶段的退出排空行为。
- 导出目标额外禁止落在所选旧安装目录内；实际 Data 和 userData 保护不变。普通当前来源导出及 v1 草稿／谱系格式不变。
- Rust helper 对这些源只读，但准备 Electron 仍按既有行为保存当前编辑器和原生谱系。这不是“整个旧 profile 零写入”的工具；测试只使用已显式隔离的临时 Data／profile，不接管本机生产目录。

## 验证与未完成门槛

- 后续已新增存活来源与冻结 LAN 的原生组合准备内核及独立 Electron 维护菜单，并加入完整活源资产复核、完整目标对象和实际原生决定保活；本节原有只读租约及 v1 草稿导出不变，不自动升级为组合快照。当前 Session 的不同 file URL 可能共享存储，仍不证明历史 profile；源／目标护栏尚未贯穿正式切换／恢复／回退。见 [存活来源组合快照](LIVE_SOURCE_SNAPSHOT.md)、[活源资产复核](LIVE_SOURCE_FRESHNESS.md) 和 [目标与原生决定保活](RETAINED_SNAPSHOT_TARGET.md)。

- 2026-11-13 11:52（北京时间）完成冻结回归：530 项源码输入、25 步，225 项 Node、4 项无窗口、448 项 Rust（默认另有 1 项 ignored）、十八套／168 项原生测试和普通工具箱生命周期；严格 Clippy、Release check、fmt 与 Debug 构建通过。正式参考字节的来源内核另行显式执行，30 项全部通过。稳定证据目录为 `artifacts/tauri-migration/live-source-binding-final/`，保留首次冻结失败、目录固定失败与测试工具失败；Release check 不是 Release 产物或性能验收。
- `npm run e2e:electron:drafts:legacy`：构建准备 Electron 和 Rust helper，再用正式绿色包及重启后的真实 Electron Session 验证受控原始草稿、白名单、持有期间的实际写入拒绝、篡改拒绝、helper 中断不发布、编辑器和协议恢复、异源 IPC 拒绝，以及无常驻 helper。
- `npm run e2e:tauri:migration:source-lease`：实际 stdio 子进程验证正式代码、真实物理绑定、工作区摘要错误、外部 browser profile、迟到 LAN 目录、伪请求、EOF 和强制终止后锁释放。它不启动旧代码，也不声称覆盖真实系统选择框。
- 单元测试另覆盖共享读取、拒绝实际写入者／硬链接／目录替换、原始 JSON 保留、profile 分区、目录重叠、取消、跨语言浏览器绑定序列化和发布前拒绝的临时文件清理。
- 首轮原生 Electron 测试的测试回调曾因 Playwright 无动态 import 回调失败，已改为隔离 bootstrap 提供测试工具；不是产品来源故障。原始失败日志保留，不改写为成功。
- 首次完整冻结因共享无窗口 harness 尚未导出新增 `spawn` 模拟而在 Node 阶段失败；已保留报告和日志，补齐默认禁止系统进程的边界并增加直接回归。没有让无窗口测试调用真实 helper 或以跳过测试绕过。
- 后续仍需把这批存活证明接到同一维护内的完整 Data 资产清单、实际浏览器原始草稿和取得独占后的 LAN `Frozen` 状态；加入持久源决定、准备运行时的中断恢复、正式切换和完整回退。不能把当前源绑定或单独 v1 草稿导出当作组合生产快照。
- 正式 helper 的可信打包分发、未知／改名旧运行时处理、任意历史 profile 明确选择、外部传输文件及分片、物理双机、Release 性能、安装 EXE 和实际绿色 ZIP 验收均未完成。默认仍为 Electron，整体迁移目标未完成。
