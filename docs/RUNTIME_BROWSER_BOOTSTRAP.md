# 隔离运行启动与浏览器草稿接入

## 范围

- 此增量把不可序列化 `RuntimeOwner` 接入同一个实际 Tauri 进程，并在持久绑定的全新 WebView2 配置中导入原组合快照的草稿。工作区存储继续采用原来的那一份原生目录独占，不释放后按路径重取。
- 专用入口仅在 Windows Debug 构建存在，且源 Data 与原 profile 必须为系统 TEMP 下 `dustdesk-runtime-preview-*` 专用根的同级目录。普通启动、默认 Electron 入口、版本 1.0.2 和生产数据不改变。本增量不提交、推送或发布。
- 启动仅创建一个隐藏的受控恢复 WebView，不注册普通工作区、窗口、Shell、文件选择、剪贴板或 LAN 业务 IPC，不创建托盘或后台业务服务。`runtimeBrowserReady` 只表示隔离浏览器导入经原生核验，不是允许生产切换或业务服务接管的许可。

## 持久 profile 绑定

- 实际授予记录下 `BrowserProfile/intent.json` 先绑定原生所有权 UUID、授予回执摘要、原输出父目录物理身份、固定来源 `http://tauri.localhost` 及预定目录。仅创建全新空目录，再持久发布带原生目录身份和意图摘要的 `decision.json`。
- 浏览器目录位于输出 Data 的同级，名称由原生授予 UUID 派生。完整运行期固定原目录和两份原生记录，目录内允许 WebView2 正常写入；目录替换、改名、额外绑定记录和撤权会拒绝确认。
- 恢复须显式给出原所有权 ID，重新取得来源、快照、运行准备与原授予后，再核验原 profile 的物理身份和完整绑定记录。相同内容复制目录、只有意图的中断记录、未知内容和已经存在但未经绑定的目录均保留并拒绝，不猜测归属或覆盖旧 profile。

## 导入和恢复屏障

- 专用私有协议的 `launchRuntime` 消费活来源取得所有权，或显式恢复原授予，然后创建受控 WebView。客户端收到 `runtimeBrowserStarting` 后发送同请求 ID 的 `continueRuntime`，才允许该配置执行导入；等待期间不能读取导入来源或请求暂存／提交。连接结束、错误消息或后续关闭请求均撤销本次活权限。
- 页面仅能请求原生固定步骤，不能交付归档、预期摘要、任意目录、浏览器配置或原生事务 ID。原始归档来自持续固定的组合快照句柄；工作区检查点和来源核验继续由实际 `WorkspaceStore` 完成。
- 浏览器使用现有共享白名单和格式内核暂存。原生直接读取实际 localStorage 的日志，核验原始归档来源、固定 profile/origin 和真实日志，再持久保存恢复副本与 pending。提交前重新读取暂存值并与原生摘要逐项比较，唯一原生决定先于浏览器完成回执。
- 完成时再次读取真实浏览器值、回执及 pending 清理结果，确认与原生决定相符后才持久标记完成并输出 `runtimeBrowserReady`。完成后不允许再次请求来源或创建第二次写入；业务服务仍未启动。
- 重启时未决 pending 只中止，不猜测 commit；已有不可逆 commit 从原生副本恢复。原生已完成的 abort 不重放旧回滚副本。孤立浏览器日志、错误配置、冲突或损坏记录保留并阻断，前端失败也不自行猜测回滚。
- 页面重载有原生代次检查，跨重载的迟到存储观察不能继续决定。每次命令和存活监督仍核验原运行所有权；原来源新增等失效会结束隔离宿主，保留已有决定。子进程退出后 WebView2 可能短暂继续收尾，测试等待实际子进程退出后再验证目录释放。

## 验证入口

- `npm run e2e:tauri:runtime-bootstrap`：构建并运行真实 Windows WebView2 专项，使用受信 v1.0.2 发布代码的精确参考字节和隔离源数据；不执行提取的旧 EXE。验证原始草稿导入与读回、IPC 权限、原文件固定、客户端 EOF、真实暂存／提交边界强杀和同 profile 恢复，以及来源迟到新增撤权。
- `npm run check:tauri:runtime-bootstrap`：冻结全部源码／测试／配置输入，串行执行 Node／无窗口、两类 TypeScript、Rust 全目标、真实工作区所有权、严格 Clippy、Release check、fmt、Debug 构建与列出的原生回归，核对执行日志、原生证据和实际产物摘要。只覆盖列出的套件，不等同全迁移验收。

## 本轮验证记录

- 2026-11-13 19:34（北京时间），556 项输入在 13 步限定回归前后保持一致：230 项 Node、4 项无窗口、506 项 Rust、四套原生回归共 57 项及普通隐藏启动生命周期通过；类型检查、严格 Clippy、Release 全目标检查、fmt 和实际 Debug 构建通过。默认 ignored 的两项实际工作区／正式发布字节测试均已显式执行通过。
- 结果归档于 `artifacts/tauri-migration/runtime-bootstrap-final/`。`verification.json` 记录逐步执行与输入／产物摘要，`official-reference-native.json` 记录补验，`evidence-audit.json` 独立核对源码、日志、原生证据和 EXE；`process-cleanup.json` 记录只读残留核验。这里只证明列出的隔离范围，不代表全部既有原生套件、正式打包或生产迁移验收。
- 早期草稿夹具、客户端启动握手、只读 invoke 拦截、WebView2 退出等待和首次 Clippy 失败的原始日志／报告保留；本轮通过不撤销历史 Electron 保存 EPERM 的未定位状态。

## 后续门槛

- 本文原生专项中的原草稿由隔离夹具构造并交给现有原生快照协议；它不是完整旧版 UI 或真实用户历史 profile 的来源认证。后续已增加 [Electron 真实维护会话连接](ELECTRON_RUNTIME_BOOTSTRAP.md)，让原编辑器／LAN 暂停持续覆盖隔离宿主；最终生产业务接管仍须单独完成。
- 原 LAN 身份／服务移交、编辑器与后台服务开放、整体切换的持久决定、原运行时退出与恢复，以及完整回退尚未完成。
- 物理双机／广播、混合 DPI／输入法、长期资源释放、Release 性能、缺少 WebView2 和真实安装包／解压绿色 ZIP 仍须独立验收。`productionReady` 和 `migrationComplete` 保持 false。
