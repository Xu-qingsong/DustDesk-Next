//! Native components shared by the desktop runtime and compatibility tests.
pub mod lan;
#[cfg(windows)]
pub mod legacy_source;
#[cfg(windows)]
pub mod managed_snapshot;
