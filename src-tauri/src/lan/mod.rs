//! Protocol-1 native components. The binary lan_host owns desktop integration.
//! No production data locations or file permissions are chosen by this module.
#[cfg(windows)]
pub mod adapters;
#[cfg(windows)]
pub mod approvals;
#[cfg(windows)]
pub mod dialog;
#[cfg(windows)]
pub mod discovery;
#[cfg(windows)]
pub mod files;
#[cfg(windows)]
pub mod folder;
#[cfg(windows)]
mod identity;
#[cfg(windows)]
pub mod migration;
#[cfg(windows)]
pub(crate) mod ownership;
#[cfg(windows)]
mod peers;
pub mod protocol;
#[cfg(windows)]
pub mod publication;
#[cfg(windows)]
pub mod receiver;
#[cfg(windows)]
pub mod sender;
#[cfg(windows)]
pub mod sources;
#[cfg(windows)]
pub mod state_store;
pub mod storage;
pub mod tls;
pub mod transport;
