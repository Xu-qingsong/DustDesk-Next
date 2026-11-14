//! Native-only service lifetime. A drain witness is produced only after all
//! listener/receiver/discovery/sender/file tasks have actually been joined.
use super::handover::Custody;
use crate::lan::{
    receiver::{Approvals, Receiver},
    state_store::StateStore,
    storage::Identity,
    transport::{Limits, Server},
};
use std::{
    net::SocketAddrV4,
    sync::{Arc, Weak},
};
use tokio_util::sync::CancellationToken;

pub struct Services {
    receiver: Receiver,
    address: SocketAddrV4,
    stop: CancellationToken,
    task: Option<tokio::task::JoinHandle<Result<Drained, String>>>,
}

/// No serialization or public constructor. This binds a real joined lifetime
/// to the exact native grant, rather than accepting an IPC shutdown assertion.
pub struct Drained {
    pub(super) custody: Weak<Custody>,
}

impl Services {
    /// Cold recovery has already obtained the real cross-runtime lease. Run
    /// the actual serial worker's restart/final save without opening a socket.
    pub async fn drain_recovered(
        store: StateStore,
        identity: Arc<Identity>,
    ) -> Result<Drained, String> {
        struct Closed;
        impl Approvals for Closed {
            fn pair(
                &self,
                _: crate::lan::protocol::Device,
                _: String,
            ) -> crate::lan::receiver::Decision<bool> {
                Box::pin(async { Err("恢复排空不接受网络请求".into()) })
            }
            fn receive(
                &self,
                _: crate::lan::receiver::ReceivePrompt,
            ) -> crate::lan::receiver::Decision<Option<std::path::PathBuf>> {
                Box::pin(async { Err("恢复排空不接受网络请求".into()) })
            }
        }
        let custody = store.original_custody()?;
        let receiver = Receiver::start_owned(
            store,
            identity,
            "LAN recovery drain".into(),
            Arc::new(Closed),
        )
        .await?;
        receiver.stop().await?;
        custody.confirm()?;
        Ok(Drained {
            custody: Arc::downgrade(&custody),
        })
    }
    pub async fn start(
        store: StateStore,
        identity: Arc<Identity>,
        name: String,
        address: SocketAddrV4,
        approvals: Arc<dyn Approvals>,
    ) -> Result<Self, String> {
        let custody = store.original_custody()?;
        let receiver = Receiver::start_owned(store, identity.clone(), name, approvals).await?;
        let server = match Server::bind(
            identity,
            address,
            Limits::default(),
            Arc::new(receiver.clone()),
        )
        .await
        {
            Ok(server) => server,
            Err(error) => {
                let _ = receiver.stop().await;
                return Err(error);
            }
        };
        let address = server.address();
        receiver.set_port(address.port());
        let stop = CancellationToken::new();
        let signal = stop.clone();
        let worker = receiver.clone();
        // This task, not the outer handle, retains custody during asynchronous
        // drop cleanup. Dropping the handle cannot release the LAN lease early.
        let task = tokio::spawn(async move {
            signal.cancelled().await;
            worker.cancel();
            let (network, files) = tokio::join!(server.stop(), worker.stop());
            network?;
            files?;
            custody.confirm()?;
            Ok(Drained {
                custody: Arc::downgrade(&custody),
            })
        });
        Ok(Self {
            receiver,
            address,
            stop,
            task: Some(task),
        })
    }

    pub fn receiver(&self) -> Receiver {
        self.receiver.clone()
    }
    pub fn address(&self) -> SocketAddrV4 {
        self.address
    }

    pub async fn stop(mut self) -> Result<Drained, String> {
        self.stop.cancel();
        self.task
            .take()
            .ok_or("原 LAN 服务停止任务缺失")?
            .await
            .map_err(|_| "原 LAN 服务监督任务未正常结束".to_owned())?
    }
}

impl Drop for Services {
    fn drop(&mut self) {
        self.stop.cancel();
    }
}
