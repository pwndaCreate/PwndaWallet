//! EVM transaction signing — legacy (EIP-155) and EIP-1559.
//!
//! We deliberately avoid the full `alloy` umbrella crate to keep build time
//! tractable. RLP is hand-rolled (it's ~40 lines for what we need) and we
//! call `secp256k1` directly for the same primitive `alloy-consensus` calls
//! under the hood.
//!
//! Track 4 vector #4 is covered in the unit tests using the canonical
//! EIP-155 reference vector from the EIP itself.

use secp256k1::{Message, Secp256k1, SecretKey};
use serde::{Deserialize, Serialize};
use sha3::{Digest, Keccak256};

#[derive(Debug, thiserror::Error)]
pub enum EvmError {
    #[error("invalid secret key")]
    BadKey,
    /// Reserved for future hex-decoding paths in tx field parsing. Not
    /// produced today (every numeric field is parsed leniently in
    /// `parse_u256`); kept so additions don't have to touch the enum.
    #[allow(dead_code)]
    #[error("invalid hex: {0}")]
    BadHex(String),
    #[error("invalid address (must be 20 bytes hex)")]
    BadAddress,
    #[error("incompatible fee fields — provide either gasPrice (legacy) or maxFeePerGas+maxPriorityFeePerGas (1559)")]
    BadFeeFields,
    /// Reserved for future signature-failure surfaces. The current path
    /// uses `secp256k1::Error` directly so this never fires.
    #[allow(dead_code)]
    #[error("signature failed")]
    Sign,
}

/// Unsigned EVM tx as accepted from the proxy's /api/swapkit/swap response.
/// Fields are decoded leniently: every numeric field accepts hex strings
/// (`"0x..."`), decimal strings, or numbers.
#[derive(Debug, Clone, Deserialize, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct UnsignedEvmTx {
    pub chain_id: u64,
    pub nonce: HexOrInt,
    pub from: Option<String>,
    pub to: String,
    #[serde(default)]
    pub value: HexOrInt,
    #[serde(default, alias = "input")]
    pub data: HexBytes,
    #[serde(alias = "gasLimit", alias = "gas")]
    pub gas: HexOrInt,
    /// Legacy txs only.
    #[serde(default)]
    pub gas_price: Option<HexOrInt>,
    /// EIP-1559 only.
    #[serde(default)]
    pub max_fee_per_gas: Option<HexOrInt>,
    /// EIP-1559 only.
    #[serde(default)]
    pub max_priority_fee_per_gas: Option<HexOrInt>,
}

/// Number-or-hex-string scalar.
#[derive(Debug, Clone, Default)]
pub struct HexOrInt(pub u128);

impl<'de> Deserialize<'de> for HexOrInt {
    fn deserialize<D: serde::Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        use serde::de::Error;
        let v = serde_json::Value::deserialize(d)?;
        match v {
            serde_json::Value::Number(n) => {
                let u = n
                    .as_u64()
                    .ok_or_else(|| D::Error::custom("non-integer numeric"))?;
                Ok(HexOrInt(u as u128))
            }
            serde_json::Value::String(s) => parse_u128(&s).map(HexOrInt).map_err(D::Error::custom),
            serde_json::Value::Null => Ok(HexOrInt(0)),
            _ => Err(D::Error::custom("expected integer or hex string")),
        }
    }
}
impl Serialize for HexOrInt {
    fn serialize<S: serde::Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        s.serialize_str(&format!("0x{:x}", self.0))
    }
}

/// Hex-encoded (`"0x..."`) variable-length byte buffer, e.g. `data`/`input`.
#[derive(Debug, Clone, Default)]
pub struct HexBytes(pub Vec<u8>);

impl<'de> Deserialize<'de> for HexBytes {
    fn deserialize<D: serde::Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        use serde::de::Error;
        let v = serde_json::Value::deserialize(d)?;
        let s = match v {
            serde_json::Value::Null => return Ok(HexBytes(Vec::new())),
            serde_json::Value::String(s) => s,
            _ => return Err(D::Error::custom("expected hex string for byte field")),
        };
        if s.is_empty() {
            return Ok(HexBytes(Vec::new()));
        }
        let body = s.strip_prefix("0x").unwrap_or(&s);
        if body.is_empty() {
            return Ok(HexBytes(Vec::new()));
        }
        let bytes = hex::decode(body).map_err(D::Error::custom)?;
        Ok(HexBytes(bytes))
    }
}
impl Serialize for HexBytes {
    fn serialize<S: serde::Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        s.serialize_str(&format!("0x{}", hex::encode(&self.0)))
    }
}

fn parse_u128(s: &str) -> Result<u128, String> {
    let s = s.trim();
    if let Some(hex) = s.strip_prefix("0x").or_else(|| s.strip_prefix("0X")) {
        if hex.is_empty() {
            return Ok(0);
        }
        u128::from_str_radix(hex, 16).map_err(|e| e.to_string())
    } else if s.is_empty() {
        Ok(0)
    } else {
        s.parse::<u128>().map_err(|e| e.to_string())
    }
}

fn parse_address(s: &str) -> Result<[u8; 20], EvmError> {
    let body = s.strip_prefix("0x").unwrap_or(s);
    if body.len() != 40 {
        return Err(EvmError::BadAddress);
    }
    let bytes = hex::decode(body).map_err(|_| EvmError::BadAddress)?;
    let mut out = [0u8; 20];
    out.copy_from_slice(&bytes);
    Ok(out)
}

/// Big-endian minimal encoding of a u128 (no leading zeros). RLP-friendly.
fn be_min(v: u128) -> Vec<u8> {
    if v == 0 {
        return Vec::new();
    }
    let bytes = v.to_be_bytes();
    let first = bytes.iter().position(|b| *b != 0).unwrap_or(bytes.len() - 1);
    bytes[first..].to_vec()
}

// ---------- minimal RLP encoder (length-prefixed bytes + lists) ----------

fn rlp_bytes(out: &mut Vec<u8>, b: &[u8]) {
    if b.len() == 1 && b[0] < 0x80 {
        out.push(b[0]);
    } else if b.len() <= 55 {
        out.push(0x80 + b.len() as u8);
        out.extend_from_slice(b);
    } else {
        let len_be = (b.len() as u64).to_be_bytes();
        let i = len_be.iter().position(|x| *x != 0).unwrap();
        let len_bytes = &len_be[i..];
        out.push(0xb7 + len_bytes.len() as u8);
        out.extend_from_slice(len_bytes);
        out.extend_from_slice(b);
    }
}

fn rlp_int(out: &mut Vec<u8>, v: u128) {
    rlp_bytes(out, &be_min(v));
}

fn rlp_list_payload(out: &mut Vec<u8>, payload: &[u8]) {
    if payload.len() <= 55 {
        out.push(0xc0 + payload.len() as u8);
        out.extend_from_slice(payload);
    } else {
        let len_be = (payload.len() as u64).to_be_bytes();
        let i = len_be.iter().position(|x| *x != 0).unwrap();
        let len_bytes = &len_be[i..];
        out.push(0xf7 + len_bytes.len() as u8);
        out.extend_from_slice(len_bytes);
        out.extend_from_slice(payload);
    }
}

fn keccak(bytes: &[u8]) -> [u8; 32] {
    let mut hasher = Keccak256::new();
    hasher.update(bytes);
    let h = hasher.finalize();
    let mut out = [0u8; 32];
    out.copy_from_slice(&h);
    out
}

// ---------- signing ----------

/// Sign `tx` with the given 32-byte secret key. Returns `0x`-prefixed lowercase
/// raw signed transaction hex.
pub fn sign_tx(tx: &UnsignedEvmTx, secret: &[u8; 32]) -> Result<String, EvmError> {
    let to = parse_address(&tx.to)?;

    let raw = if tx.max_fee_per_gas.is_some() && tx.max_priority_fee_per_gas.is_some() {
        sign_eip1559(tx, &to, secret)?
    } else if tx.gas_price.is_some() {
        sign_legacy(tx, &to, secret)?
    } else {
        return Err(EvmError::BadFeeFields);
    };
    Ok(format!("0x{}", hex::encode(raw)))
}

fn sign_legacy(
    tx: &UnsignedEvmTx,
    to: &[u8; 20],
    secret: &[u8; 32],
) -> Result<Vec<u8>, EvmError> {
    let gp = tx.gas_price.as_ref().expect("checked").0;
    // Pre-image: rlp([nonce, gasPrice, gasLimit, to, value, data, chainId, 0, 0])
    let mut payload = Vec::with_capacity(128);
    rlp_int(&mut payload, tx.nonce.0);
    rlp_int(&mut payload, gp);
    rlp_int(&mut payload, tx.gas.0);
    rlp_bytes(&mut payload, to);
    rlp_int(&mut payload, tx.value.0);
    rlp_bytes(&mut payload, &tx.data.0);
    rlp_int(&mut payload, tx.chain_id as u128);
    rlp_int(&mut payload, 0);
    rlp_int(&mut payload, 0);
    let mut buf = Vec::with_capacity(payload.len() + 4);
    rlp_list_payload(&mut buf, &payload);
    let hash = keccak(&buf);

    let secp = Secp256k1::new();
    let sk = SecretKey::from_slice(secret).map_err(|_| EvmError::BadKey)?;
    let msg = Message::from_digest(hash);
    let sig = secp.sign_ecdsa_recoverable(&msg, &sk);
    let (rec_id, ser) = sig.serialize_compact();
    let rec_int = rec_id.to_i32() as u64;
    let v = tx.chain_id * 2 + 35 + rec_int;

    let r = strip_leading_zeros(&ser[..32]);
    let s = strip_leading_zeros(&ser[32..]);

    let mut signed_payload = Vec::with_capacity(128);
    rlp_int(&mut signed_payload, tx.nonce.0);
    rlp_int(&mut signed_payload, gp);
    rlp_int(&mut signed_payload, tx.gas.0);
    rlp_bytes(&mut signed_payload, to);
    rlp_int(&mut signed_payload, tx.value.0);
    rlp_bytes(&mut signed_payload, &tx.data.0);
    rlp_int(&mut signed_payload, v as u128);
    rlp_bytes(&mut signed_payload, r);
    rlp_bytes(&mut signed_payload, s);

    let mut out = Vec::with_capacity(signed_payload.len() + 4);
    rlp_list_payload(&mut out, &signed_payload);
    Ok(out)
}

fn sign_eip1559(
    tx: &UnsignedEvmTx,
    to: &[u8; 20],
    secret: &[u8; 32],
) -> Result<Vec<u8>, EvmError> {
    let mp = tx.max_priority_fee_per_gas.as_ref().expect("checked").0;
    let mf = tx.max_fee_per_gas.as_ref().expect("checked").0;
    // Pre-image bytes: 0x02 || rlp([chainId, nonce, maxPriorityFeePerGas, maxFeePerGas,
    //                              gasLimit, to, value, data, accessList])
    let mut payload = Vec::with_capacity(128);
    rlp_int(&mut payload, tx.chain_id as u128);
    rlp_int(&mut payload, tx.nonce.0);
    rlp_int(&mut payload, mp);
    rlp_int(&mut payload, mf);
    rlp_int(&mut payload, tx.gas.0);
    rlp_bytes(&mut payload, to);
    rlp_int(&mut payload, tx.value.0);
    rlp_bytes(&mut payload, &tx.data.0);
    rlp_list_payload(&mut payload, &[]); // empty access list
    let mut list = Vec::with_capacity(payload.len() + 4);
    rlp_list_payload(&mut list, &payload);

    let mut to_hash = Vec::with_capacity(1 + list.len());
    to_hash.push(0x02);
    to_hash.extend_from_slice(&list);
    let hash = keccak(&to_hash);

    let secp = Secp256k1::new();
    let sk = SecretKey::from_slice(secret).map_err(|_| EvmError::BadKey)?;
    let msg = Message::from_digest(hash);
    let sig = secp.sign_ecdsa_recoverable(&msg, &sk);
    let (rec_id, ser) = sig.serialize_compact();
    let y_parity = rec_id.to_i32() as u8;
    let r = strip_leading_zeros(&ser[..32]);
    let s = strip_leading_zeros(&ser[32..]);

    // Signed list = [chainId, nonce, maxPriorityFeePerGas, maxFeePerGas,
    //                gasLimit, to, value, data, accessList, yParity, r, s]
    let mut signed_payload = Vec::with_capacity(128);
    rlp_int(&mut signed_payload, tx.chain_id as u128);
    rlp_int(&mut signed_payload, tx.nonce.0);
    rlp_int(&mut signed_payload, mp);
    rlp_int(&mut signed_payload, mf);
    rlp_int(&mut signed_payload, tx.gas.0);
    rlp_bytes(&mut signed_payload, to);
    rlp_int(&mut signed_payload, tx.value.0);
    rlp_bytes(&mut signed_payload, &tx.data.0);
    rlp_list_payload(&mut signed_payload, &[]); // empty access list
    rlp_int(&mut signed_payload, y_parity as u128);
    rlp_bytes(&mut signed_payload, r);
    rlp_bytes(&mut signed_payload, s);

    let mut out = Vec::with_capacity(1 + signed_payload.len() + 4);
    out.push(0x02);
    rlp_list_payload(&mut out, &signed_payload);
    Ok(out)
}

fn strip_leading_zeros(b: &[u8]) -> &[u8] {
    let start = b.iter().position(|x| *x != 0).unwrap_or(b.len());
    &b[start..]
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Canonical EIP-155 reference vector (from the EIP itself).
    /// https://eips.ethereum.org/EIPS/eip-155
    #[test]
    fn vector4_eip155_reference() {
        let secret_hex = "4646464646464646464646464646464646464646464646464646464646464646";
        let secret_bytes = hex::decode(secret_hex).unwrap();
        let mut sk = [0u8; 32];
        sk.copy_from_slice(&secret_bytes);

        let tx = UnsignedEvmTx {
            chain_id: 1,
            nonce: HexOrInt(9),
            from: None,
            to: "0x3535353535353535353535353535353535353535".to_string(),
            value: HexOrInt(1_000_000_000_000_000_000), // 1 ETH
            data: HexBytes(Vec::new()),
            gas: HexOrInt(21000),
            gas_price: Some(HexOrInt(20_000_000_000)),
            max_fee_per_gas: None,
            max_priority_fee_per_gas: None,
        };

        let raw = sign_tx(&tx, &sk).unwrap();
        let expected = "0xf86c098504a817c800825208943535353535353535353535353535353535353535880de0b6b3a76400008025a028ef61340bd939bc2195fe537567866003e1a15d3c71ff63e1590620aa636276a067cbe9d8997f761aecb703304b3800ccf555c9f3dc64214b297fb1966a3b6d83";
        assert_eq!(raw, expected);
    }
}
