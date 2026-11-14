# 原 LAN 租约与服务存储交接内核

## 当前范围

- `RuntimeOwner::prepare_original_lan_preview` 为原生库提供首轮交接入口，只接受 Debug、专用 `dustdesk-runtime-preview-*` TEMP 根和同级运行 Data／原 profile。来源仍须经过正式旧版代码识别、原运行时绑定、组合准备与运行所有权授予，不从 JSON 回执构造活权限。
- 后续 [原 LAN 隔离运行](ORIGINAL_LAN_RUNTIME.md) 将本内核接入独立 Debug TEMP 菜单与受控原生 stdio；原草稿专用 [Electron 维护会话](ELECTRON_RUNTIME_BOOTSTRAP.md) 保持 `businessServicesStarted=false`。独立 Debug example 的 stdin 确认仍只供内核测试，新桌面宿主使用实际 Windows 配对／接收确认。两者均不等同生产服务接管或整体迁移完成，实际通过范围见执行记录。
- 只接管已经存在的原设备身份和 LAN 目录。原 LAN 从未初始化时明确拒绝，不创建目录、证书或新设备身份；普通数据根和 Release 构建同样拒绝。

## 持久决定与同一租约

- 在运行授予记录的 `Ownership/<所有权 ID>/OriginalLan/` 写入 `intent.json`，绑定原授予 ID、完整授予回执 SHA-256，以及实际原 profile／LAN 物理身份、原状态证明和设备 ID／指纹／身份文件证明。记录不包含证书或私钥。
- 意图以临时文件同步、原子发布、读回完整摘要和保留句柄完成。随后重新核验原来源、完整资产清单、目标快照、实际运行授予和可选浏览器 profile，以及调用者的原生准入回调。
- 发布并读回 `decision.json` 后再次执行上述核验。决定格式为 `dustdesk-original-lan-handover-granted`，绑定意图摘要，始终保留 `productionReady=false` 和 `migrationComplete=false`。只有决定已固定且所有核验通过，才释放原 `state.json` 的不可变固定句柄。
- 冻结器取得的原生命名管道租约由同一 `Arc<Lease>` 交给 `StateStore`，没有释放后按路径抢锁的窗口。原 profile、LAN 根、父目录链和原身份文件继续固定；服务工人和来源对象共同保留 LAN 护栏，任一方提前释放均不会让第二个运行时取得 LAN 目录独占。
- 原身份的读取使用已授权 OS 文件句柄的副本，不按路径重新打开，不扩大原有共享权限。副本共用文件位置，读取在交接期间串行；交接后来源与服务只确认该身份的固定证明。
- `Receiver::start_owned` 直接采用此状态存储及原身份。迁移存储禁止再次初始化身份，接收服务验证的是交接时固定的原设备身份；正常隔离服务的既有身份加载／初始化行为不变。

## 可变状态与撤权

- 交接后 `state.json` 可由现有原子替换路径保存，不再用旧状态字节否定合法服务提交。原组合快照和其 LAN 状态仍保持原始不可变字节；来源检查点仍表示原准备，不能拿它冒充服务已经变化后的当前状态。
- 每次迁移存储提交在准备前及实际替换前检查取消、原物理目录、身份和原生交接记录。取消后保留最后成功提交的数据，拒绝新提交；仍持有目录独占和身份句柄，直至真实对象释放。
- `RuntimeOwner::confirm`／`verify` 发现来源、快照或其他护栏失效时会撤销该服务存储；移除迟到文件不能重新启用已撤销的许可。释放原运行所有者同样撤销服务提交，但不会提前释放尚由工人保留的 LAN 租约。
- 未来桌面宿主仍须持续监督所有者、撤销服务准入并等待 Receiver、发送任务、文件工人、HTTPS 与发现服务真实收尾。本入口没有替代宿主排空，也没有完成服务层的自动取消连接／对话框协议。

## 中断、恢复与剩余工作

- 已存在意图、决定或未知内容时拒绝新交接，保留原记录和实际数据。意图后撤权不会生成成功决定；决定后撤权不会反写中止，也不会放开原状态句柄。两者均不返回可写存储。
- 新增 `FrozenSource::resume_runtime_with_original_lan`：重新取得原物理 Data／profile／LAN 租约并固定当前状态，保留并核验整个原组合快照及原来源绑定，读取原快照检查点与原始状态字节，再恢复原运行授予。普通不可变恢复入口仍严格比对原状态，没有放宽成通用可写恢复。
- 冷恢复只接受恰好包含原 `intent.json`／`decision.json` 的完整原 LAN 成功授予；核验格式、所有权 ID、完整所有权回执摘要、原检查点、意图摘要及两个 false 状态标志。缺失、未决、未知或篡改记录均拒绝，不创建或重写记录。
- 原快照检查点与当前状态证明分开保存。原 profile／LAN 根／身份文件的物理证明须完全一致，即使字节相同但替换了目录或身份也拒绝。恢复授予后仍固定当前状态，直到调用 `RuntimeOwner::resume_original_lan_preview` 显式采用；采用的是最新状态而非旧快照，使用本次已取得的同一租约，不释放后重抢锁。
- 恢复存储沿用取消、来源／目标失效和所有者释放撤权机制；决定文件和原身份继续固定。尚未采用服务就撤权时，当前状态仍保持不可变固定；撤权后不通过删除迟到文件或重复调用重新开放。
- 已新增下节的 LAN 专用持久交还内核，但尚未接入现有“退出宿主后恢复 Electron”的预览流程；仍须串联浏览器／工作区的整体切换和回退。物理双机、防火墙和发布产物验收仍待完成。

## 原 LAN 最新状态持久交还

- 原生专用 `Services` 监督实际 HTTPS、Receiver、发送、发现、文件工人和状态工人的生命周期；只有真实 join 全部成功才返回不可序列化、绑定同一授予的 `Drained` 凭证。丢弃外层服务句柄会通知后台收尾，后台在真实退出前继续持有原 LAN 租约；凭证本身仅持弱引用，不在所有者释放后延长租约。
- 修复 Receiver 首次最终保存失败后重复停止可能误报成功的问题：首次终止结果被锁存，后续停止返回同一失败，不能产生交还排空凭证。测试实际将状态文件设为只读触发失败，并恢复原权限。
- `RuntimeOwner::finish_original_lan_preview` 在真实排空后取得状态排他锁、永久封闭原生写入并固定最新原始状态字节。验证任务身份、信任列表、暂停／完成／取消与零速率，拒绝临时令牌、活动任务和未完成 `rustPublicationV1`；不使用会规范化状态的加载路径，不把旧快照写回当前状态。不兼容时保留当前固定字节且不创建交还记录。
- 在 `OriginalLan/Handback/intent.json` 绑定原成功授予摘要、所有权 ID、完整当前物理检查点及 `dustdesk-electron-lan-protocol-1` 兼容标识，再发布并固定 `decision.json`。两次发布后均复核来源、快照、实际运行所有权与准入；回执保持 `productionReady=false`、`migrationComplete=false`，不能反序列化为租约。
- 开始交还后普通服务冷恢复永久拒绝。仅显式 `FrozenSource::resume_runtime_for_original_lan_handback` 与 `RuntimeOwner::resume_original_lan_handback_preview` 可完成空目录、意图后中断或成功响应丢失；始终保持封闭，不能重新采用为可写服务。已有记录不覆盖，未知／孤立／篡改记录、当前状态内容变化或同字节替换均拒绝。
- 只有真实所有者及相关对象释放，旧运行时才能重新取得原 LAN 物理目录。当前仅为 Debug 专用 TEMP 原生入口；桌面维护菜单、整体浏览器／工作区交还和生产切换均未接入。
- `cargo test --manifest-path src-tauri/Cargo.toml --lib original_lan_handback_ -- --test-threads=1` 覆盖九项原生测试。`node --test tests/tauri-original-lan-handback.mjs` 覆盖活动上传排空并交给当前 Electron LAN 模块续传，以及意图／成功决定落盘后真实 SIGKILL 与显式冷完成；旧官方 EXE／ASAR 仅认证来源，不执行旧 EXE。
- `npm run check:tauri:original-lan-handback` 使用独立 `artifacts/tauri-migration/original-lan-handback-final/` 冻结回归，不覆盖首轮交接或冷恢复基线。

## 验证入口

- `cargo test --manifest-path src-tauri/Cargo.toml --lib original_lan_ -- --test-threads=1` 包含六项冷恢复用例：两次恢复保留最新状态、十四种授予缺失／篡改变体、身份与根替换、来源／目标迟到变更撤权、原生准入撤权后新恢复和采用前取消。
- `node --test tests/tauri-original-lan-recovery.mjs` 使用精确官方绿色包 EXE／ASAR 字节认证来源，启动独立原生 example，当前 Electron LAN 模块在 Node 中提供真实旧发送端。明确 stdin 确认夹具替代原生对话框；回环 HTTPS 在写入真实非零分片时强杀原生进程，再重建双方服务、拒绝旧令牌、确认前缀摘要并重新确认续传。测试还检查二次恢复、篡改授予拒绝，以及原身份、原工作区、组合快照和授予记录不变，不执行旧版 EXE。
- `npm run check:tauri:original-lan-recovery` 执行本轮冻结验证，证据写入独立的 `artifacts/tauri-migration/original-lan-recovery-final/`；首轮交接基线不覆盖。以最终成功报告和独立审计为准，下面首轮记录保留当时的验证范围。
- `cargo test --manifest-path src-tauri/Cargo.toml --lib original_lan_handover -- --test-threads=1` 验证同一租约、真实状态变更、原身份与快照护栏、重复交接拒绝、取消、所有者释放、来源失效撤权、普通根／未初始化拒绝、既有记录保留、意图后／决定后撤权和保守恢复。
- 新增实际服务用例把原存储直接交给 Receiver，与第二个真实 Receiver 建立回环双向 TLS／人工确认夹具配对，验证新增信任落盘、原身份字节不变、全部服务实际停止后来源仍持有租约，最后释放来源才允许新所有者。
- 这十项新测试使用测试内部最小代码信任夹具，验证的是实际原生文件／服务机制。现有正式参考字节、实际 Electron／浏览器回归验证各自已有路径，不等于新交接入口已完成正式来源的端到端接入。
- `npm run check:tauri:original-lan-handover` 冻结源码／配置／测试，执行无窗口检查、主进程 TypeScript、Rust 全目标、实际工作区所有权补验、严格 Clippy、Release 全目标检查、格式、Debug 构建、实际浏览器／Electron 集成和列出的 LAN 回归。证据写入 `artifacts/tauri-migration/original-lan-handover-final/`，以最终报告成功标记和摘要审计为准。
- 首轮新增测试因在冻结期按路径读取零共享文件，以及交接实现尝试重新打开原身份而失败。实现改为复制已授权句柄；测试使用冻结前原字节，交接后的状态在可读阶段检查，固定记录及快照在所有者释放后读取，没有放宽文件共享。失败摘要作为开发记录保留，不能描述为已发布产品故障。

## 持久交还最终记录

- 2026-11-13 22:14（北京时间）最终冻结验证通过：571 项输入、20 个串行步骤，230 项 Node＋4 项无窗口、531 项 Rust（默认两项 ignored 分别显式补验），十一套／50 项真实进程、浏览器、Electron 与 LAN 集成测试。主进程 TypeScript、严格 Clippy、Release 全目标、格式和实际 Debug 构建通过。
- 证据保留于 `artifacts/tauri-migration/original-lan-handback-final/`；最终报告标记 verified=true、sourceStable=true。独立审计复核输入清单、日志／证据／产物摘要、九项新增原生用例、交还及冷恢复进程事件、两项补验与失败归档。首轮交接和冷恢复基线均未覆盖。
- 本轮 Tauri Debug EXE SHA-256 为 `963ec0804627c14c07f940fbdad084652155e3f06db7bb87afeb23d0677af40a`；交还／恢复 example 为 `732e618c921b095ef8c8d27464e9483d73c43efbfc7a5398a00e6f6591c635ee`。Electron 主进程／preload 构建摘要与上一轮冷恢复基线一致。
- 2026-11-13 22:14 的只读清理核验无相关进程或新增 dustdesk-* TEMP 根，冻结开始的 2041 个历史根保留。开发双重 panic 遗留的四个合成夹具根经所有权核验后可恢复地归档于证据目录。首次冻结的夹具字段错误及完整失败日志单独保留，最终通过不覆盖失败记录。
- 本轮只完成 LAN 专用 Debug TEMP 持久交还；桌面原 LAN 启用、整体工作区／浏览器交还、生产切换、完整回退、物理双机与发布产物门槛继续保留。默认 Electron、版本 1.0.2，未提交／推送／发布。

## 冷恢复最终记录

- 2026-11-13 21:25（北京时间）本轮冻结验证通过：566 项输入／19 个串行步骤，230 项 Node、4 项无窗口、522 项 Rust；默认忽略的实际工作区所有权和官方来源字节各一项显式补验通过。十套／46 项原生进程、浏览器、Electron 与 LAN 集成测试通过，严格 Clippy、Release 全目标检查、格式和实际 Debug 构建通过。
- `artifacts/tauri-migration/original-lan-recovery-final/verification.json` 标记 `verified=true`、`sourceStable=true`，绑定逐步日志、证据副本与构建产物。独立 `evidence-audit.json` 复核输入清单、摘要、补验、冷恢复事件和清理结果；`cold-process-*` 保存新进程测试的构建、事件与错误日志，`change-scope.json` 对比首轮交接基线。
- 冷恢复进程用例在活动上传中真实 SIGKILL，退出后核验 1 MiB 前缀摘要，再恢复原授予及最新任务；旧发送模块重新连接、明确接收确认后完成原文件 SHA-256 核验。再次冷恢复保留完成状态；篡改成功决定后拒绝发布服务、保留当前状态，恢复原记录才可重新恢复。原始工作区、身份文件、快照和授予记录保持原字节。
- 该轮 Tauri Debug EXE SHA-256 为 `e3bde78241ffab1d825a64879f3a451c96b4a7f3085618471a4d2abf20d75c38`；独立恢复 example 为 `9e041713e0be7b2fc5c02720e084b162d27ba78694465b0a1fcd87384c6567ca`。Electron 主进程／preload 构建摘要与首轮基线一致。
- 开发期两次进程夹具失败和首轮冻结诊断回归均另行保留；只有冻结失败有完整原始 Rust 日志，详见 `development-failure-summary.json`。21:25 的只读清理核验无相关进程或新增 `dustdesk-*` TEMP 根，冻结开始时的 2041 个历史根无缺失。首轮交接基线未覆盖；桌面原 LAN 启用、持久交还、整体切换及完整回退仍未完成，默认 Electron、版本 1.0.2，未提交／推送／发布。

## 首轮交接基线记录

- 2026-11-13 20:46（北京时间）561 项输入／17 步冻结回归和独立审计通过：230 项 Node、4 项无窗口、516 项 Rust（含新增十项）；默认忽略的实际工作区所有权和正式发布字节测试各一项显式通过。九套／45 项实际浏览器、Electron 和 LAN 回归均通过，严格 Clippy、Release 全目标检查、fmt 与 Debug 构建通过。
- `verification.json` 和 `evidence-audit.json` 绑定输入、逐步日志、证据副本、两项补验与当前构建产物；`change-scope.json` 列出相对上一轮的十一项输入变化。`development-failure-summary.json` 明确首轮失败只有本对话工具输出与摘要，不伪称已归档原始日志。
- `process-cleanup.json` 于 20:46 只读确认相关进程和本轮新建 `dustdesk-*` TEMP 根均无残留，历史目录没有删除。此范围内没有冷恢复／持久交还、桌面原 LAN 服务接管、生产切换或完整回退；正式入口和版本保持不变。
