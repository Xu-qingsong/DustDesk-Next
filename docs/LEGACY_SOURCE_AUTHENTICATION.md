# 正式旧版安装来源识别

## 范围

- Windows 原生 `legacy_source::PinnedInstallation` 只识别已编译支持的正式发行版安装代码；当前仅支持 Windows x64 `v1.0.2`。未知版、重打包版、开发构建、仅有同名文件或自报版本均不受信任。
- 这是识别内核和隔离主窗的只读检查入口，不是生产迁移器。不会启动旧 EXE、加载旧 JS、读取旧 Data／浏览器／LAN 状态、创建迁移意图或切换入口。
- 只覆盖 `DustDesk.exe` 和 `resources/app.asar`，不是 Authenticode 验签，也不是整个安装树的安全认证；其他 DLL、运行环境和潜在旁加载文件未核验，绝不能据此执行旧程序。

## 信任来源

- 编译内置 `src-tauri/trust/legacy-windows-x64.json`，仓库固定为 `Xu-qingsong/DustDesk-Next`，不从 renderer、所选安装目录或外部 JSON 接收信任条目。
- 正式 Release `v1.0.2` 的 `SHA256SUMS.txt` 原始字节 SHA-256 为 `3a34683506d8b75bdcf2af628cf55bfb9803e18cfd8ce6d2c22acb17e69cb53c`，其中绿色 ZIP 为 `336a0be3d3843e0c65d58718ce6b44b4215d0ab79b04d43427d446b15ea81759`。本地历史绿色 ZIP 已与其核对，再流式提取这两个文件，从未运行。
- `DustDesk.exe`：204596736 字节，SHA-256 `f8f294df3836fa9559630bb7f40f71573a6ff9dd10ba636ec042976a8480ebc2`。
- `resources/app.asar`：65068711 字节，SHA-256 `311bdd4495d47bb62a803c48793b5b5c6d47826318787277fbb492ccbd0ea27b`。
- 来源地址为该仓库的 `releases/download/v1.0.2/SHA256SUMS.txt` 和 `releases/download/v1.0.2/DustDesk-1.0.2-x64-green.zip`；本次原始校验文本、ZIP 条目、提取字节摘要及旧主进程文本保存在 `artifacts/tauri-migration/source-authentication/`。这依赖正式 GitHub 发布渠道及人工维护的编译信任根，不宣称提供独立签名或不可被同权限／管理员攻击者篡改的系统保证。
- 从 ASAR 只提取文本核对：包名 `dustdesk-electron`，入口 `out/main/index.js`，页面 `out/renderer/index.html`，默认 Data 为 `appData/DustDesk.Next/Data`，LAN 存储为实际 `userData/LanTransfers`。旧构建含测试环境覆盖，故这些相对路径不能替代实际 profile 和数据物理来源绑定。
- 最初在 Windows 上使用正斜线提取 ASAR 入口失败，改用原生分隔符后确认入口确实存在；不把工具路径差异误判为损坏发行包。

## 原生证明边界

- 复用本地盘句柄固定内核，固定安装根、`resources` 及所有祖先，拒绝 UNC／映射网络盘、设备路径、父级跳转和重解析目录。两个文件均必须是单链接普通文件。
- 两文件同时持有只读、零共享句柄；既有读取者或写入者会明确阻断，不关闭第三方句柄，不修改 ACL／只读属性，不重试或降级。校验期间阻止普通路径替换、重命名和写入，目录也不能被换向。
- 先与受信任文件大小匹配，再按 64 KiB 块计算 SHA-256；块间检查取消及原生调用窗口有效性，前后核对句柄身份、大小、修改时间和单链接状态。EXE 与 ASAR 必须同时匹配同一个内置发行版，不能拼装不同发行版的文件。
- `confirm` 在同一批存活句柄上重新完整散列，不接受路径字符串、renderer 摘要或序列化回执作为证明。原生对象不实现反序列化或克隆。
- `Inspection` 仅用于展示，始终返回 `purpose=installation-identification-only`，`productionReady`、`migrationComplete`、`legacyExecuted`、`productionDataRead` 均为 false。检查结束立即释放所有句柄；后续迁移必须由原生端重新打开并持续固定来源，不能复用展示信息授权。

## 验证

- `cargo test --manifest-path src-tauri/Cargo.toml --lib legacy_source::` 运行合成边界测试；合成正例只能进入模块私有的测试路径，不能通过正式编译信任根。
- 真实字节专项显式设置 `DUSTDESK_LEGACY_REFERENCE` 为已校验绿色 ZIP 的提取目录，再运行 `cargo test --manifest-path src-tauri/Cargo.toml --lib legacy_source:: -- --include-ignored --nocapture`。默认测试中的真实字节用例为 ignored，不把跳过当成验证通过。
- `npm run e2e:tauri:migration:source` 使用真实原生目录选择和共享主页面；要求 `release/DustDesk-1.0.2-x64-green.zip` 或环境变量 `DUSTDESK_LEGACY_RELEASE_ZIP` 指定的精确官方 ZIP。每次先流式校验整个 ZIP，再只提取两个固定文件到隔离临时目录，从不运行它们。
- 原生专项覆盖权限拒绝、伪路径／伪回执不能跳过选择、真实取消、任意安装拒绝、正式字节与展示、检查后的锁释放、同尺寸 ASAR 替换拒绝和没有新建迁移／LAN 身份；报告为 `artifacts/tauri-migration/legacy-source-native/report.json`。
- 2026-11-13 已显式执行全部 16 项内核专项（含真实正式包）、8 项原生专项，并通过 525 输入／22 步完整冻结：223 项 Node、4 项无窗口、433 项 Rust、十五套／145 项原生检查和普通工具箱生命周期。默认 Rust 的 1 项真实包 ignored 单列说明，不计为通过；它由前述显式内核运行及真实包原生专项另行覆盖。封存副本为 `artifacts/tauri-migration/source-authentication-final/`，源码与日志／执行文件摘要均核对。

## 后续门槛

- 新增实际准备 Electron 运行时的存活来源绑定：旧安装导出现在持有临时 Rust 来源租约，绑定真实 Data／Session／userData 和 LAN 目录，贯穿受控草稿导出；它不是历史 profile 证明，也未冻结 LAN 状态或完成生产接管。临时 helper、目录读取权限修复及未完成分发门槛见 [实际运行时来源绑定](LIVE_SOURCE_BINDING.md)。

- 将存活的原生安装证明与实际旧 `userData`、浏览器 file-origin、Data、LAN 身份／状态、工作区独占所有权及全部编辑器维护检查点绑定，不能靠默认目录或版本名推测。
- 标准进程名检测仍不是完整旧运行时枚举；重命名程序、通用 Electron、既有浏览器上下文等必须在实际交接协议中处理。
- 接入持久的跨运行时切换和明确回退；验证外部发送／接收文件及续传分片的实际位置与所有权。当前组合快照仍为隔离、原 profile 身份引用模式，不能直接替代生产接管或灾难恢复。
- 全部业务／生命周期、物理输入与双机网络、Release 内存对比、安装 EXE 和实际解压绿色 ZIP 的启动验收仍未完成；正式入口保持 Electron。
