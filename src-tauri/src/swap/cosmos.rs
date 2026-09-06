//! Cosmos / THORChain / Maya signing — stubbed for v1.
//!
//! Real impl uses `cosmrs::tx::Tx` to build a tx, sign with secp256k1, and
//! return the protobuf bytes ready for `broadcast_tx_async`. Heavy crate
//! pull, deferred until SwapKit's THORChain volume justifies it.

// Intentional v2 placeholders — kept as type stubs so when the v2
// Cosmos branch lands, the public API surface (`CosmosError`,
// `sign_cosmos_msg`) is already named in the codebase. Annotated to
// silence the dead-code lint until a caller exists.
#[allow(dead_code)]
#[derive(Debug, thiserror::Error)]
pub enum CosmosError {
    #[error("cosmos signing not implemented yet (use SwapKit's NEAR Intents route for cross-chain BTC/ETH legs)")]
    NotImplemented,
}

#[allow(dead_code)]
pub fn sign_cosmos_msg(_seed: &[u8], _msg: &str) -> Result<String, CosmosError> {
    Err(CosmosError::NotImplemented)
}
