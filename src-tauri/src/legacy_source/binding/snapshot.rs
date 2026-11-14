use super::{Binding, BoundSource};
use crate::{
    lan::{files::Directory, migration::Frozen},
    managed_snapshot::{
        bundle::{self, DraftProof, Inputs},
        preparation::{require_external_destination, Catalog, Status, VerifiedHandoff},
        source::SourceInventory,
        Entry, Manifest,
    },
};
use sha2::Digest;
use std::{path::Path, sync::Arc};
use tokio_util::sync::CancellationToken;

pub mod application;
pub mod handback;

pub struct FrozenSource {
    source: BoundSource,
    lan: Frozen,
    prepared: Option<PreparedInventory>,
}

struct PreparedInventory {
    id: String,
    target: VerifiedHandoff,
    inventory: SourceInventory,
}

pub struct RuntimeOwner {
    source: FrozenSource,
    active: crate::managed_snapshot::preparation::runtime::ownership::Active,
    cancel: CancellationToken,
    profile: Option<crate::managed_snapshot::preparation::runtime::ownership::profile::Profile>,
    lan_cancel: Option<CancellationToken>,
    handback: Option<handback::Retained>,
    application: Option<application::Retained>,
}

pub struct RuntimeDraftArchive {
    serialized: zeroize::Zeroizing<String>,
    proof: DraftProof,
    ownership_id: String,
    workspace_sha256: String,
}
enum LanRecovery {
    Service,
    Handback,
    Release,
    RuntimeHandback,
}

impl RuntimeDraftArchive {
    pub fn serialized(&self) -> &str {
        &self.serialized
    }

    pub fn proof(&self) -> &DraftProof {
        &self.proof
    }

    pub fn ownership_id(&self) -> &str {
        &self.ownership_id
    }

    pub fn workspace_sha256(&self) -> &str {
        &self.workspace_sha256
    }
}

impl RuntimeOwner {
    pub fn original_lan_enabled_preview(&mut self) -> Result<bool, String> {
        crate::lan::migration::handover::require_preview(
            self.path(),
            self.source.source.user_data.path(),
        )?;
        self.confirm()?;
        self.source
            .lan
            .state_bytes()
            .map(crate::lan::storage::State::parse)
            .transpose()
            .map(|state| state.is_some_and(|state| state.enabled))
    }

    /// Proof of the negative case is made while the actual source/ownership
    /// objects are still held. An existing intent, even empty, is not absence.
    pub fn confirm_original_lan_not_started_preview(
        &mut self,
    ) -> Result<crate::lan::migration::Checkpoint, String> {
        crate::lan::migration::handover::require_preview(
            self.path(),
            self.source.source.user_data.path(),
        )?;
        self.verify()?;
        self.source.lan.confirm_unadopted(&self.active)
    }

    pub fn finish_original_lan_preview(
        &mut self,
        drained: &crate::lan::migration::service::Drained,
        current: impl Fn() -> Result<(), String>,
    ) -> Result<crate::lan::migration::handback::Receipt, String> {
        self.handback_original_lan(Some(drained), false, current)
    }

    pub fn resume_original_lan_handback_preview(
        &mut self,
        current: impl Fn() -> Result<(), String>,
    ) -> Result<crate::lan::migration::handback::Receipt, String> {
        self.handback_original_lan(None, false, current)
    }

    fn handback_original_lan(
        &mut self,
        drained: Option<&crate::lan::migration::service::Drained>,
        terminal: bool,
        current: impl Fn() -> Result<(), String>,
    ) -> Result<crate::lan::migration::handback::Receipt, String> {
        current()?;
        if terminal {
            self.confirm_custody()?;
        } else {
            self.confirm()?;
        }
        let prepared = self
            .source
            .prepared
            .as_ref()
            .ok_or("原 LAN 交还缺少原快照护栏")?;
        let cancel = self.lan_cancel.as_ref().ok_or("原 LAN 交还未建立活授予")?;
        let source = &self.source.source;
        self.source
            .lan
            .finish_handback(&self.active, drained, cancel, || {
                current()?;
                source.assert_pinned(&self.cancel, &|| Ok(()))?;
                prepared.target.confirm(&self.cancel, || Ok(()))?;
                prepared.inventory.confirm(&self.cancel, || Ok(()))?;
                if let Some(profile) = &self.profile {
                    profile.confirm(&self.cancel)?;
                }
                Ok(())
            })
    }

    /// Explicitly adopts current LAN state only after the cold recovery entry
    /// has retained the original native grant and the separate snapshot proof.
    pub fn resume_original_lan_preview(
        &mut self,
        current: impl Fn() -> Result<(), String>,
    ) -> Result<
        (
            crate::lan::state_store::StateStore,
            Arc<crate::lan::storage::Identity>,
        ),
        String,
    > {
        current()?;
        self.confirm()?;
        let source = &self.source.source;
        let prepared = self
            .source
            .prepared
            .as_ref()
            .ok_or("原 LAN 恢复缺少快照护栏")?;
        let cancel = self.lan_cancel.as_ref().ok_or("原 LAN 恢复未建立活授予")?;
        self.source.lan.resume_handover(&self.active, cancel, || {
            current()?;
            source.assert_pinned(&self.cancel, &|| Ok(()))?;
            prepared.target.confirm(&self.cancel, || Ok(()))?;
            prepared.inventory.confirm(&self.cancel, || Ok(()))?;
            if let Some(profile) = &self.profile {
                profile.confirm(&self.cancel)?;
            }
            Ok(())
        })
    }

    /// Native-only isolated kernel seam. No GUI/IPC enables it yet: service
    /// shutdown, desktop recovery and compatible handback are separate gates.
    pub fn prepare_original_lan_preview(
        &mut self,
        current: impl Fn() -> Result<(), String>,
    ) -> Result<
        (
            crate::lan::state_store::StateStore,
            Arc<crate::lan::storage::Identity>,
        ),
        String,
    > {
        current()?;
        self.confirm()?;
        let source = &self.source.source;
        let prepared = self
            .source
            .prepared
            .as_ref()
            .ok_or("原 LAN 移交缺少来源快照护栏")?;
        let cancel = self.cancel.child_token();
        let result = self.source.lan.handover(&self.active, &cancel, || {
            current()?;
            source.assert_pinned(&self.cancel, &|| Ok(()))?;
            prepared.target.confirm(&self.cancel, || Ok(()))?;
            prepared.inventory.confirm(&self.cancel, || Ok(()))?;
            if let Some(profile) = &self.profile {
                profile.confirm(&self.cancel)?;
            }
            Ok(())
        })?;
        self.lan_cancel = Some(cancel);
        Ok(result)
    }

    pub fn prepare_browser_profile(
        &mut self,
    ) -> Result<crate::managed_snapshot::preparation::runtime::ownership::profile::Binding, String>
    {
        self.confirm()?;
        if self.profile.is_none() {
            self.profile = Some(
                crate::managed_snapshot::preparation::runtime::ownership::profile::Profile::create(
                    &self.active,
                    &self.cancel,
                )?,
            );
        }
        self.confirm()?;
        Ok(self
            .profile
            .as_ref()
            .ok_or("浏览器 profile 护栏缺失")?
            .binding()
            .clone())
    }

    pub fn resume_browser_profile(
        &mut self,
    ) -> Result<crate::managed_snapshot::preparation::runtime::ownership::profile::Binding, String>
    {
        self.confirm()?;
        if self.profile.is_none() {
            self.profile = Some(
                crate::managed_snapshot::preparation::runtime::ownership::profile::Profile::resume(
                    &self.active,
                    &self.cancel,
                )?,
            );
        }
        self.confirm()?;
        Ok(self
            .profile
            .as_ref()
            .ok_or("浏览器 profile 护栏缺失")?
            .binding()
            .clone())
    }

    pub fn path(&self) -> &Path {
        self.active.path()
    }

    pub fn receipt(&self) -> &crate::managed_snapshot::preparation::runtime::ownership::Receipt {
        self.active.receipt()
    }

    pub fn runtime_receipt(&self) -> &crate::managed_snapshot::preparation::runtime::Receipt {
        self.active.runtime_receipt()
    }

    pub fn binding(&self) -> &Binding {
        self.source.binding()
    }

    fn terminal_lan_proof(&mut self) -> Result<handback::LanProof, String> {
        self.confirm_custody()?;
        match self.source.lan.confirm_unadopted(&self.active) {
            Ok(checkpoint) => Ok(handback::LanProof {
                checkpoint,
                handback_intent_sha256: None,
            }),
            Err(_) => {
                let receipt = self.handback_original_lan(None, true, || Ok(()))?;
                Ok(handback::LanProof {
                    checkpoint: receipt.checkpoint,
                    handback_intent_sha256: Some(receipt.intent_sha256),
                })
            }
        }
    }

    pub fn seal_runtime_preview(
        &mut self,
        drafts: &[u8],
        workspace_sha256: &str,
        browser_fingerprint: &str,
        current: impl Fn() -> Result<(), String>,
    ) -> Result<handback::Receipt, String> {
        crate::lan::migration::handover::require_preview(
            self.path(),
            self.source.source.user_data.path(),
        )?;
        self.verify()?;
        let browser = self
            .profile
            .as_ref()
            .ok_or("整体交还必须持有实际浏览器配置绑定")?
            .binding()
            .clone();
        if browser.fingerprint() != browser_fingerprint {
            return Err("整体交还草稿不属于实际物理浏览器配置与来源".into());
        }
        let lan = self.terminal_lan_proof()?;
        let source = std::cell::RefCell::new(&mut self.source);
        let check = || {
            source
                .borrow_mut()
                .confirm_runtime_custody(&self.cancel, &current)
        };
        self.handback = Some(handback::Retained::seal(
            &self.active,
            &browser,
            &lan,
            drafts,
            workspace_sha256,
            &self.cancel,
            check,
        )?);
        self.handback
            .as_ref()
            .map(|retained| retained.receipt())
            .ok_or("整体交还未持有终态".into())
    }

    pub fn resume_runtime_handback_preview(
        &mut self,
        current: impl Fn() -> Result<(), String>,
    ) -> Result<handback::Receipt, String> {
        crate::lan::migration::handover::require_preview(
            self.path(),
            self.source.source.user_data.path(),
        )?;
        self.verify_custody()?;
        let browser = self
            .profile
            .as_ref()
            .ok_or("整体交还恢复缺少原物理浏览器绑定")?
            .binding()
            .clone();
        let lan = self.terminal_lan_proof()?;
        let source = std::cell::RefCell::new(&mut self.source);
        let check = || {
            source
                .borrow_mut()
                .confirm_runtime_custody(&self.cancel, &current)
        };
        if self.handback.is_none() {
            self.handback = Some(handback::Retained::load(
                &self.active,
                &browser,
                &lan,
                None,
                &self.cancel,
                check,
            )?);
        }
        let retained = self.handback.as_mut().ok_or("整体交还恢复未取得终态")?;
        retained.complete(&self.cancel, check)?;
        Ok(retained.receipt())
    }

    pub fn browser_archive(&mut self) -> Result<RuntimeDraftArchive, String> {
        self.confirm()?;
        let prepared = self
            .source
            .prepared
            .as_mut()
            .ok_or("原浏览器快照护栏缺失")?;
        if prepared.id != self.active.runtime_receipt().preparation_id {
            return Err("浏览器快照不是当前运行所有权的原准备".into());
        }
        let (bytes, proof) = prepared.target.browser_archive(&self.cancel, || Ok(()))?;
        let serialized = zeroize::Zeroizing::new(
            std::str::from_utf8(&bytes)
                .map_err(|_| "已固定浏览器归档不是 UTF-8")?
                .to_owned(),
        );
        self.confirm()?;
        Ok(RuntimeDraftArchive {
            serialized,
            proof,
            ownership_id: self.receipt().id.clone(),
            workspace_sha256: self.binding().workspace_sha256.clone(),
        })
    }

    pub fn confirm(&mut self) -> Result<(), String> {
        self.active.require_runtime_writable()?;
        let result = self.confirm_custody();
        if result.is_err() {
            self.revoke_lan();
        }
        result
    }

    fn confirm_custody(&mut self) -> Result<(), String> {
        self.source
            .confirm_runtime_custody(&self.cancel, &|| Ok(()))?;
        self.active.confirm(&self.cancel, &|| Ok(()))?;
        if let Some(profile) = &self.profile {
            profile.confirm(&self.cancel)?;
        }
        Ok(())
    }

    pub fn verify(&mut self) -> Result<(), String> {
        self.active.require_runtime_writable()?;
        let result = self.verify_custody();
        if result.is_err() {
            self.revoke_lan();
        }
        result
    }

    fn verify_custody(&mut self) -> Result<(), String> {
        let preparation_id = self.active.runtime_receipt().preparation_id.clone();
        self.source
            .verify_prepared(&preparation_id, &self.cancel, || Ok(()))?;
        self.active.verify(&self.cancel, &|| Ok(()))?;
        if let Some(profile) = &mut self.profile {
            profile.verify(&self.cancel)?;
        }
        Ok(())
    }

    fn revoke_lan(&self) {
        if let Some(cancel) = &self.lan_cancel {
            cancel.cancel();
        }
    }
}

impl Drop for RuntimeOwner {
    fn drop(&mut self) {
        self.revoke_lan();
    }
}

impl BoundSource {
    pub fn freeze(
        mut self,
        cancel: &CancellationToken,
        current: impl Fn() -> Result<(), String>,
    ) -> Result<FrozenSource, String> {
        self.confirm(cancel, &current)?;
        let lan = Frozen::capture(self.user_data.path(), cancel, || {
            self.assert_pinned(cancel, &current)
        })?;
        if lan.checkpoint().app_profile != self.binding.user_data_identity
            || lan.checkpoint().lan_profile != self.binding.lan_storage_identity
        {
            return Err("冻结 LAN 不属于已绑定的实际准备运行时".into());
        }
        self.assert_pinned(cancel, &current)?;
        Ok(FrozenSource {
            source: self,
            lan,
            prepared: None,
        })
    }
}

impl FrozenSource {
    /// Cold recovery deliberately differs from immutable-source replay. Only
    /// a native LAN grant may bridge the snapshot/current-state distinction.
    pub fn resume_runtime_with_original_lan(
        self,
        preparation_id: &str,
        runtime_id: &str,
        id: &str,
        cancel: &CancellationToken,
        current: impl Fn() -> Result<(), String>,
    ) -> Result<RuntimeOwner, String> {
        self.resume_runtime_lan(
            [preparation_id, runtime_id, id],
            LanRecovery::Service,
            cancel,
            current,
        )
        .map(|(owner, _)| owner)
    }

    pub fn resume_runtime_for_original_lan_handback(
        self,
        preparation_id: &str,
        runtime_id: &str,
        id: &str,
        cancel: &CancellationToken,
        current: impl Fn() -> Result<(), String>,
    ) -> Result<RuntimeOwner, String> {
        self.resume_runtime_lan(
            [preparation_id, runtime_id, id],
            LanRecovery::Handback,
            cancel,
            current,
        )
        .map(|(owner, _)| owner)
    }

    pub fn resume_runtime_for_original_lan_release(
        self,
        preparation_id: &str,
        runtime_id: &str,
        id: &str,
        cancel: &CancellationToken,
        current: impl Fn() -> Result<(), String>,
    ) -> Result<(RuntimeOwner, crate::lan::migration::ReleaseKind), String> {
        self.resume_runtime_lan(
            [preparation_id, runtime_id, id],
            LanRecovery::Release,
            cancel,
            current,
        )
    }

    pub fn resume_runtime_for_handback_preview(
        self,
        preparation_id: &str,
        runtime_id: &str,
        id: &str,
        cancel: &CancellationToken,
        current: impl Fn() -> Result<(), String>,
    ) -> Result<RuntimeOwner, String> {
        self.resume_runtime_lan(
            [preparation_id, runtime_id, id],
            LanRecovery::RuntimeHandback,
            cancel,
            current,
        )
        .map(|(owner, _)| owner)
    }

    fn resume_runtime_lan(
        mut self,
        [preparation_id, runtime_id, id]: [&str; 3],
        recovery: LanRecovery,
        cancel: &CancellationToken,
        current: impl Fn() -> Result<(), String>,
    ) -> Result<(RuntimeOwner, crate::lan::migration::ReleaseKind), String> {
        crate::lan::migration::handover::require_preview(
            self.source.data.path(),
            self.source.user_data.path(),
        )?;
        self.confirm(cancel, &current)?;
        if self.prepared.is_some() {
            return Err("原 LAN 冷恢复必须从新取得的来源与当前状态开始".into());
        }
        let (_parent, _root, catalog) = self.catalog()?;
        catalog.recover_active(cancel, || self.source.assert_pinned(cancel, &current))?;
        let mut target = catalog.retain_runtime_source_handoff(
            preparation_id,
            self.source.binding(),
            cancel,
            || self.source.assert_pinned(cancel, &current),
        )?;
        let original =
            target.original_lan(cancel, || self.source.assert_pinned(cancel, &current))?;
        let inventory = SourceInventory::capture(
            self.source.data.clone(),
            target.data().clone(),
            cancel,
            || self.source.assert_pinned(cancel, &current),
        )?;
        self.prepared = Some(PreparedInventory {
            id: preparation_id.to_owned(),
            target,
            inventory,
        });
        let prepared = self.prepared.as_ref().ok_or("原 LAN 冷恢复未固定快照")?;
        let source = &self.source;
        let lan = &mut self.lan;
        let active = prepared.target.resume_runtime_ownership(
            preparation_id,
            runtime_id,
            id,
            cancel,
            || {
                source.assert_pinned(cancel, &current)?;
                prepared.inventory.confirm(cancel, &current)
            },
        )?;
        if matches!(recovery, LanRecovery::RuntimeHandback) {
            active.runtime_handback_record(false)?;
        } else {
            active.require_runtime_writable()?;
        }
        let lan_cancel = cancel.child_token();
        let check = || {
            source.assert_pinned(cancel, &current)?;
            prepared.target.confirm(cancel, &current)?;
            prepared.inventory.confirm(cancel, &current)
        };
        let kind = match recovery {
            LanRecovery::Handback => {
                lan.recover_grant(&active, original, true, &lan_cancel, check)?;
                crate::lan::migration::ReleaseKind::Handback
            }
            LanRecovery::Service => {
                lan.recover_handover(&active, original, &lan_cancel, check)?;
                crate::lan::migration::ReleaseKind::Drain
            }
            LanRecovery::Release | LanRecovery::RuntimeHandback => {
                lan.recover_release(&active, original, &lan_cancel, check)?
            }
        };
        let mut owner = RuntimeOwner {
            source: self,
            active,
            cancel: cancel.clone(),
            profile: None,
            lan_cancel: Some(lan_cancel),
            handback: None,
            application: None,
        };
        if matches!(recovery, LanRecovery::RuntimeHandback) {
            if matches!(kind, crate::lan::migration::ReleaseKind::Drain) {
                return Err("整体交还仍有未交还的原 LAN 授予，未允许重开服务".into());
            }
            owner.verify_custody()?;
            owner.profile = Some(
                crate::managed_snapshot::preparation::runtime::ownership::profile::Profile::resume(
                    &owner.active,
                    &owner.cancel,
                )?,
            );
        } else {
            owner.verify()?;
        }
        Ok((owner, kind))
    }

    pub fn claim_runtime(
        mut self,
        preparation_id: &str,
        runtime_id: &str,
        cancel: &CancellationToken,
        current: impl Fn() -> Result<(), String>,
    ) -> Result<RuntimeOwner, String> {
        self.verify_runtime(preparation_id, runtime_id, cancel, &current)?;
        let runtime = self
            .prepared
            .as_mut()
            .ok_or("运行准备护栏缺失")?
            .target
            .take_runtime(runtime_id)?;
        let active = crate::managed_snapshot::preparation::runtime::ownership::Active::claim(
            runtime,
            cancel,
            &current,
            || {
                self.verify_prepared(preparation_id, cancel, &current)
                    .map(|_| ())
            },
        )?;
        let mut owner = RuntimeOwner {
            source: self,
            active,
            cancel: cancel.clone(),
            profile: None,
            lan_cancel: None,
            handback: None,
            application: None,
        };
        owner.confirm()?;
        Ok(owner)
    }

    pub fn resume_runtime(
        mut self,
        preparation_id: &str,
        runtime_id: &str,
        id: &str,
        cancel: &CancellationToken,
        current: impl Fn() -> Result<(), String>,
    ) -> Result<RuntimeOwner, String> {
        self.verify_prepared(preparation_id, cancel, &current)?;
        let active = self
            .prepared
            .as_ref()
            .ok_or("运行来源护栏缺失")?
            .target
            .resume_runtime_ownership(preparation_id, runtime_id, id, cancel, || {
                self.source.assert_pinned(cancel, &current)
            })?;
        let mut owner = RuntimeOwner {
            source: self,
            active,
            cancel: cancel.clone(),
            profile: None,
            lan_cancel: None,
            handback: None,
            application: None,
        };
        owner.confirm()?;
        Ok(owner)
    }

    pub fn runtime_ownership_statuses(
        &mut self,
        preparation_id: &str,
        runtime_id: &str,
        cancel: &CancellationToken,
        current: impl Fn() -> Result<(), String>,
    ) -> Result<Vec<crate::managed_snapshot::preparation::runtime::ownership::Status>, String> {
        self.verify_prepared(preparation_id, cancel, &current)?;
        let statuses = self
            .prepared
            .as_ref()
            .ok_or("运行来源护栏缺失")?
            .target
            .runtime_ownership_statuses(preparation_id, runtime_id, cancel, || {
                self.source.assert_pinned(cancel, &current)
            })?;
        self.confirm(cancel, &current)?;
        Ok(statuses)
    }

    pub fn runtime_statuses(
        &mut self,
        preparation_id: &str,
        cancel: &CancellationToken,
        current: impl Fn() -> Result<(), String>,
    ) -> Result<Vec<crate::managed_snapshot::preparation::runtime::Status>, String> {
        self.verify_prepared(preparation_id, cancel, &current)?;
        let prepared = self
            .prepared
            .as_ref()
            .ok_or("运行准备状态查询缺少完整源与目标保活")?;
        let statuses = prepared
            .target
            .runtime_statuses(preparation_id, cancel, || {
                self.source.assert_pinned(cancel, &current)
            })?;
        self.confirm(cancel, &current)?;
        Ok(statuses)
    }

    pub fn prepare_runtime(
        &mut self,
        preparation_id: &str,
        destination: &Path,
        cancel: &CancellationToken,
        current: impl Fn() -> Result<(), String>,
    ) -> Result<crate::managed_snapshot::preparation::runtime::Receipt, String> {
        self.verify_prepared(preparation_id, cancel, &current)?;
        for protected in [
            &self.source.installation.root,
            &self.source.data,
            &self.source.user_data,
            &self.source.browser_profile,
        ] {
            require_external_destination(destination, protected.path())?;
        }
        let prepared = self
            .prepared
            .as_mut()
            .ok_or("运行准备缺少完整源与目标保活")?;
        let source = &self.source;
        let lan = &mut self.lan;
        let inventory = &mut prepared.inventory;
        let receipt = prepared.target.prepare_runtime(
            preparation_id,
            destination,
            cancel,
            || source.assert_pinned(cancel, &current),
            || {
                lan.confirm(cancel, || source.assert_pinned(cancel, &current))?;
                inventory.verify(cancel, || source.assert_pinned(cancel, &current))?;
                source.assert_pinned(cancel, &current)
            },
        )?;
        self.confirm(cancel, &current)?;
        Ok(receipt)
    }

    pub fn verify_runtime(
        &mut self,
        preparation_id: &str,
        id: &str,
        cancel: &CancellationToken,
        current: impl Fn() -> Result<(), String>,
    ) -> Result<crate::managed_snapshot::preparation::runtime::Receipt, String> {
        self.verify_prepared(preparation_id, cancel, &current)?;
        let prepared = self
            .prepared
            .as_mut()
            .ok_or("运行准备核验缺少完整源与目标保活")?;
        let receipt = prepared
            .target
            .verify_runtime(preparation_id, id, cancel, || {
                self.source.assert_pinned(cancel, &current)
            })?;
        self.confirm(cancel, &current)?;
        Ok(receipt)
    }

    pub fn binding(&self) -> &Binding {
        self.source.binding()
    }

    pub fn confirm(
        &mut self,
        cancel: &CancellationToken,
        current: impl Fn() -> Result<(), String>,
    ) -> Result<(), String> {
        self.source.confirm(cancel, &current)?;
        self.confirm_runtime_custody(cancel, &current)
    }

    fn confirm_runtime_custody(
        &mut self,
        cancel: &CancellationToken,
        current: &impl Fn() -> Result<(), String>,
    ) -> Result<(), String> {
        self.source.assert_pinned(cancel, current)?;
        self.lan
            .confirm(cancel, || self.source.assert_pinned(cancel, &current))?;
        if let Some(prepared) = &self.prepared {
            prepared
                .target
                .confirm(cancel, || self.source.assert_pinned(cancel, &current))?;
            prepared
                .inventory
                .confirm(cancel, || self.source.assert_pinned(cancel, &current))?;
        }
        self.source.assert_pinned(cancel, &current)
    }

    fn catalog(&self) -> Result<(Arc<Directory>, Arc<Directory>, Catalog), String> {
        let parent = self
            .source
            .user_data
            .child("LegacySnapshotPreparation", true)
            .map_err(|error| error.to_string())?;
        let identity = &self.source.binding.data_identity;
        let root = parent
            .child(
                &format!("{:016x}-{:016x}", identity.volume, identity.index),
                true,
            )
            .map_err(|error| error.to_string())?;
        let catalog = Catalog::open(self.source.data.path(), root.path())?;
        Ok((parent, root, catalog))
    }

    pub fn prepare(
        &mut self,
        destination: &Path,
        request: &str,
        drafts: &[u8],
        cancel: &CancellationToken,
        current: impl Fn() -> Result<(), String>,
    ) -> Result<Status, String> {
        self.confirm(cancel, &current)?;
        if self.prepared.is_some() {
            return Err("当前来源已固定已准备资产，须关闭会话后重新准备".into());
        }
        for protected in [
            &self.source.installation.root,
            &self.source.data,
            &self.source.user_data,
        ] {
            require_external_destination(destination, protected.path())?;
        }
        let (_parent, _root, catalog) = self.catalog()?;
        catalog.recover_active(cancel, || self.source.assert_pinned(cancel, &current))?;
        let inputs = Inputs {
            request_id: request,
            workspace_sha256: &self.source.binding.workspace_sha256,
            drafts,
            browser_binding: &self.source.binding.browser_binding,
            lan: &mut self.lan,
            source: Some(&self.source),
        };
        let status = catalog.prepare_handoff(destination, inputs, cancel, || {
            self.source.assert_pinned(cancel, &current)
        })?;
        self.confirm(cancel, &current)?;
        Ok(status)
    }

    pub fn verify_prepared(
        &mut self,
        id: &str,
        cancel: &CancellationToken,
        current: impl Fn() -> Result<(), String>,
    ) -> Result<bundle::Receipt, String> {
        self.confirm(cancel, &current)?;
        if self
            .prepared
            .as_ref()
            .is_some_and(|prepared| prepared.id != id)
        {
            return Err("当前存活来源资产仅绑定同一原生准备记录".into());
        }
        if let Some(prepared) = &mut self.prepared {
            prepared
                .target
                .verify(self.source.binding(), self.lan.checkpoint(), cancel, || {
                    self.source.assert_pinned(cancel, &current)
                })?;
            prepared
                .inventory
                .verify(cancel, || self.source.assert_pinned(cancel, &current))?;
        } else {
            let (_parent, _root, catalog) = self.catalog()?;
            catalog.recover_active(cancel, || self.source.assert_pinned(cancel, &current))?;
            let target = catalog.retain_source_handoff(
                id,
                self.source.binding(),
                self.lan.checkpoint(),
                cancel,
                || self.source.assert_pinned(cancel, &current),
            )?;
            let inventory = SourceInventory::capture(
                self.source.data.clone(),
                target.data().clone(),
                cancel,
                || self.source.assert_pinned(cancel, &current),
            )?;
            self.prepared = Some(PreparedInventory {
                id: id.to_owned(),
                target,
                inventory,
            });
        }
        self.confirm(cancel, &current)?;
        self.prepared
            .as_ref()
            .map(|prepared| prepared.target.receipt().clone())
            .ok_or("目标保活核验未完成".into())
    }
}

impl Binding {
    pub(crate) fn validate_snapshot(
        &self,
        data: &Manifest,
        drafts: &DraftProof,
        lan: &crate::lan::migration::Checkpoint,
    ) -> Result<(), String> {
        let workspace = data.entries.iter().find_map(|entry| match entry {
            Entry::File { path, stamp, .. } if path == "workspace.json" => Some(stamp),
            _ => None,
        });
        let binding = format!("{:x}", sha2::Sha256::digest(format!(
            "{{\"version\":1,\"runtime\":\"electron\",\"entry\":{},\"profile\":{{\"volume\":\"{:016x}\",\"file\":\"{:016x}\"}}}}",
            serde_json::to_string(&self.browser_entry).map_err(|error| error.to_string())?,
            self.browser_profile_identity.volume, self.browser_profile_identity.index,
        ).as_bytes()));
        if self.format != "dustdesk-live-legacy-source-binding"
            || self.version != 1
            || self.scope != "prepared-electron-runtime"
            || self.production_ready
            || self.migration_complete
            || self.data_identity != data.source_identity
            || self.workspace_sha256 != data.workspace_sha256
            || workspace != Some(&self.workspace)
            || self.browser_binding != drafts.browser_binding
            || self.browser_binding != binding
            || self.user_data_identity != lan.app_profile
            || self.lan_storage_identity != lan.lan_profile
            || self.browser_profile_identity.index == 0
            || self.installation.root_identity.index == 0
            || self.installation.resources_identity.index == 0
            || self.installation.purpose != "installation-identification-only"
            || self.installation.production_ready
            || self.installation.migration_complete
            || self.installation.legacy_executed
            || self.installation.production_data_read
        {
            return Err("组合快照的准备运行时来源与实际 Data／浏览器／冻结 LAN 不匹配".into());
        }
        Ok(())
    }
}
