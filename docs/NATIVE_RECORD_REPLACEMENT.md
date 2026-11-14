# 原生草稿记录与共享读取

## 已验证的失败机制

- 2026-11-12 的冻结回归在 tray-abort 和 lost-begin-response 两处遭遇 `MoveFileExW os error 5`。失败后源／目标均非只读，DELETE 探测又可打开；该采样不能证明替换调用时没有读句柄，也不能确定是哪个进程持有瞬时读句柄。
- `artifacts/tauri-migration/replacement-diagnosis/probe.ps1` 在独立临时目录显式控制句柄共享模式：目标只读打开、共享 READ／WRITE／DELETE 时，MoveFileExW 和普通 FileRenameInfo 仍返回 access denied；FileRenameInfoEx 的 REPLACE_IF_EXISTS／POSIX_SEMANTICS 成功，旧读句柄仍指向旧文件。拒绝 DELETE 共享的读句柄继续阻止替换。这是实际 Windows API 实验，不是重新运行失败套件来挑选绿色结果。
- 原生事务新增确定性测试，持有共享只读目标句柄再提交 commit／abort。未修改产品实现前恰好重现原错误及相同即时采样，证据为 `deterministic-before.log`：确实执行一项且失败，不是零测试。修复后该测试通过。原始偶发失败具体的读句柄持有者仍未被识别，不能将此机制证据写成已定位杀毒软件或 ACL 问题。

## 有限范围的实现

- `workspace/native_record_replace.rs` 只用于同一父目录下已经存在的 `MigrationTransaction.json` 和 `MigrationBrowserJournal.json`。首次发布仍不覆盖，新协议、文件名、记录版本和持久决定语义均不改变；普通工作区、备份及用户导出文件的既有替换路径不修改。
- 固定全部实际父目录句柄，拒绝重解析点；固定实际源句柄、拒绝源写入／删除共享，只接受单硬链接普通文件。目标持有只读、共享 READ／DELETE 而不共享 WRITE 的句柄，因而已有实际写句柄（即使它共享 DELETE）或后来的写入都会被拒绝；再次检查目标身份，不能只凭路径的早期观察发布。
- 通过实际源句柄调用一次 FileRenameInfoEx，只有 REPLACE_IF_EXISTS 与 POSIX_SEMANTICS 两个标志。目标的可共享只读观察者可以继续读取完整旧文件，新打开的目标看到完整新文件；发布后复核实际目标身份等于源句柄身份。
- 只读目标明确拒绝，拒绝 DELETE 共享的句柄、源／目标写入占用、硬链接、junction、目录、目标缺失、跨父目录或未知记录名均失败并保留原内容。不清除只读、不改 ACL、不使用 IGNORE_READONLY_ATTRIBUTE、不关闭第三方句柄、不循环重试，也不在新 API 不支持时回退到其他替换方法。
- 调用者仍在发布前刷新完整临时记录并持有工作区所有权、维护／启动恢复门闩。此变更不是任意同账户恶意写入者之间的原子 CAS，也不证明 OS 崩溃／物理断电持久性；失败或响应不确定仍须从原生记录查询不可逆决定，不能猜测回滚。
- 未采用 ReplaceFileW：它在共享读句柄情况下也能成功，但官方列出的某些失败可导致目标原名不存在或被改名；不能在没有相应备份／恢复协议时把它作为“再试一次”的替代品。

## 验证与边界

- 六项文件内核测试覆盖两种记录名、完整旧／新字节、实际源／目标写句柄、拒绝 DELETE 的读句柄、只读、目标缺失、路径限制、硬链接、junction 和非文件目标。既有原生事务只读／占用测试保留，断言仍要求原生决定／工作区字节不变与明确排障后再操作，未放宽为任意成功。
- 实际 Tauri 恢复套件新增 shared-reader-commit／shared-reader-abort：独立 PowerShell 进程真实持有共享只读句柄，跨原生决定与后续实际重启完成分别核对旧句柄摘要不变、当前路径发生合法替换；不靠浏览器模拟读句柄。
- 完整回归必须另有与当前源码一致的冻结报告，不能以这些定向测试或旧版本报告代替。普通文件替换、拒绝共享 DELETE 的真实占用，以及历史无窗口保存／删除超时不在本修复的已解决声明内。
- 初次原生定向运行保留在 `replacement-diagnosis/native-regressions-first.log`：共享读取场景和完整导入已通过，两个只读保护场景因仍匹配旧 API 名而失败。断言只同步新 API 名，未放宽只读、字节保持、启动阻断或明确排障后再恢复的验证；最终是否通过以修正断言后的冻结报告为准。
- 当前完整冻结回归于 2026-11-13T02:12:07.346Z 通过：519 项输入、21 步，223 项 Node、4 项无窗口、418 项 Rust、十四套／137 项原生检查及普通工具箱生命周期；严格 Clippy、Release all-target check、fmt 和实际 Debug 构建通过。十八项原生事务包含两个外部共享读句柄和两个只读保护场景；导入二十二项完整执行，包括历史失败的 lost-begin-response。
- 最终复核与不可依赖活动路径的副本见 `artifacts/tauri-migration/native-record-replacement-final/verification.json`：保留全部日志、原生证据／截图、旧失败和修复前一项确定性失败，绑定当前源码与实际产物摘要。不据此宣称原始瞬时句柄持有者已识别、所有 Windows 替换拒绝均已修复、物理断电安全或整个迁移完成。

## 官方语义参考

- [FILE_RENAME_INFORMATION](https://learn.microsoft.com/en-us/windows-hardware/drivers/ddi/ntifs/ns-ntifs-_file_rename_information)：POSIX_SEMANTICS 的旧句柄行为及独立的 IGNORE_READONLY_ATTRIBUTE 标志。
- [SetFileInformationByHandle](https://learn.microsoft.com/en-us/windows/win32/api/fileapi/nf-fileapi-setfileinformationbyhandle)：按实际源句柄修改文件信息。
- [ReplaceFileW](https://learn.microsoft.com/en-us/windows/win32/api/winbase/nf-winbase-replacefilew)：共享模式、ACL 合并及部分失败的文件名状态。
