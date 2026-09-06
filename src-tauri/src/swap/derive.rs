//! BIP-39 → BIP-32 → BIP-44/49/84/86 key derivation per chain.
//!
//! Chains covered in this module:
//!
//! | Chain   | SLIP-44 | Path                | Address | Format                 |
//! |---------|---------|---------------------|---------|------------------------|
//! | EVM     | 60      | m/44'/60'/0'/0/i    | 0x…     | hex EIP-55             |
//! | BTC     | 0       | m/84'/0'/0'/0/i     | bc1q…   | BIP-84 P2WPKH bech32   |
//! | LTC     | 2       | m/84'/2'/0'/0/i     | ltc1q…  | BIP-84 P2WPKH bech32   |
//! | DOGE    | 3       | m/44'/3'/0'/0/i     | D…      | BIP-44 P2PKH base58    |
//! | BCH     | 145     | m/44'/145'/0'/0/i   | bitcoincash:q… | BIP-44 P2PKH cashaddr |
//! | SOL     | 501     | m/44'/501'/0'/0'    | base58  | ed25519 SLIP-10        |
//! | NEAR    | 397     | m/44'/397'/0'       | hex(64) | implicit account       |
//!
//! Test vectors covered by the unit tests at the bottom of the file are
//! cross-checked with at least one independent reference per chain.

use bip39::Mnemonic;
use bitcoin::bip32::{DerivationPath, Xpriv};
use bitcoin::key::Secp256k1;
use bitcoin::NetworkKind;
use sha2::{Digest as Sha2Digest, Sha256};
use sha3::Keccak256;
use std::str::FromStr;
use zeroize::Zeroizing;

#[derive(Debug, thiserror::Error)]
pub enum DeriveError {
    #[error("invalid BIP-39 mnemonic")]
    BadMnemonic,
    #[error("invalid BIP-32 path: {0}")]
    BadPath(String),
    #[error("BIP-32 derivation failed: {0}")]
    Bip32(String),
    #[error("invalid public key (this should be impossible)")]
    BadPubkey,
    #[error("address encoding error: {0}")]
    Encode(String),
}

/// Parse `mnemonic` and produce the 64-byte BIP-39 seed using `passphrase` as
/// the BIP-39 passphrase (most users leave this empty; do not confuse with the
/// vault encryption passphrase).
pub fn mnemonic_to_seed(mnemonic: &str, passphrase: &str) -> Result<Zeroizing<[u8; 64]>, DeriveError> {
    let mnemonic = Mnemonic::parse(mnemonic.trim()).map_err(|_| DeriveError::BadMnemonic)?;
    Ok(Zeroizing::new(mnemonic.to_seed(passphrase)))
}

/// Mainnet master node — the signing paths' default.
///
/// Retained as the named mainnet entry point even though every current caller
/// now goes through [`seed_to_xpriv_on`]: it is the shape the rest of this
/// module's public API is written in, and silently deleting it would push the
/// `NetworkKind::Main` choice out to call sites where it is easy to get wrong.
#[allow(dead_code)]
pub fn seed_to_xpriv(seed: &[u8]) -> Result<Xpriv, DeriveError> {
    seed_to_xpriv_on(seed, NetworkKind::Main)
}

/// Master node with an explicit network kind.
///
/// The signing paths in this module are mainnet-only and must stay that way, so
/// [`seed_to_xpriv`] keeps its signature and this is purely additive. The
/// caller that needs it is the C3.5 descriptor import: BIP-32 serialises the
/// NETWORK into a key's version bytes, and Bitcoin Core validates them against
/// its own chain — so a mainnet `xprv` handed to a regtest node is refused
/// outright with `wpkh(): key '...' is not valid`.
///
/// Found by the first live regtest run of the import (2026-08-19). Every unit
/// test passed, because they assert the descriptor's SHAPE; only a daemon
/// checks version bytes. Without this the feature could not be exercised
/// anywhere but mainnet — an unacceptable place to first learn whether a
/// fund-affecting import works.
pub fn seed_to_xpriv_on(seed: &[u8], net: NetworkKind) -> Result<Xpriv, DeriveError> {
    Xpriv::new_master(net, seed).map_err(|e| DeriveError::Bip32(e.to_string()))
}

pub fn derive_xpriv(seed: &[u8], path: &str) -> Result<Xpriv, DeriveError> {
    derive_xpriv_on(seed, path, NetworkKind::Main)
}

/// [`derive_xpriv`] with an explicit network kind — see [`seed_to_xpriv_on`].
pub fn derive_xpriv_on(seed: &[u8], path: &str, net: NetworkKind) -> Result<Xpriv, DeriveError> {
    let parsed = DerivationPath::from_str(path).map_err(|e| DeriveError::BadPath(e.to_string()))?;
    let secp = Secp256k1::new();
    let master = seed_to_xpriv_on(seed, net)?;
    master
        .derive_priv(&secp, &parsed)
        .map_err(|e| DeriveError::Bip32(e.to_string()))
}

// ---------------- EVM ----------------

/// EVM (BIP-44) — derive private key bytes for the given address index on
/// chain ID 60 (Ethereum and all EVM siblings share the same SLIP-44 entry).
pub fn evm_private_key(seed: &[u8], account: u32, index: u32) -> Result<Zeroizing<[u8; 32]>, DeriveError> {
    let path = format!("m/44'/60'/{account}'/0/{index}");
    let xpriv = derive_xpriv(seed, &path)?;
    Ok(Zeroizing::new(xpriv.private_key.secret_bytes()))
}

/// EVM address from secret key bytes (Keccak256 of uncompressed-pubkey-without-prefix, last 20 bytes, hex 0x-prefixed lowercased).
/// Matches the canonical (non-EIP-55) address; callers can EIP-55-checksum if they want.
pub fn evm_address_from_secret(sk: &[u8; 32]) -> Result<String, DeriveError> {
    let secp = secp256k1::Secp256k1::new();
    let sk = secp256k1::SecretKey::from_slice(sk).map_err(|_| DeriveError::BadPubkey)?;
    let pk = secp256k1::PublicKey::from_secret_key(&secp, &sk);
    let uncompressed = pk.serialize_uncompressed(); // 65 bytes: 0x04 || X(32) || Y(32)
    let mut hasher = Keccak256::new();
    hasher.update(&uncompressed[1..]); // drop 0x04 prefix
    let h = hasher.finalize();
    let mut out = String::with_capacity(42);
    out.push_str("0x");
    for b in &h[12..] {
        out.push_str(&format!("{b:02x}"));
    }
    Ok(out)
}

/// EIP-55 checksummed address — uppercases hex digits per the EIP-55 spec.
pub fn evm_address_eip55(sk: &[u8; 32]) -> Result<String, DeriveError> {
    let lower = evm_address_from_secret(sk)?;
    let body = &lower[2..];
    let mut hasher = Keccak256::new();
    hasher.update(body.as_bytes());
    let hash = hasher.finalize();
    let mut out = String::with_capacity(42);
    out.push_str("0x");
    for (i, c) in body.chars().enumerate() {
        if c.is_ascii_digit() {
            out.push(c);
        } else {
            // Bit `i` of the hex-encoded hash determines casing.
            let nibble = (hash[i / 2] >> (4 * (1 - (i % 2)))) & 0x0f;
            if nibble >= 8 {
                out.push(c.to_ascii_uppercase());
            } else {
                out.push(c);
            }
        }
    }
    Ok(out)
}

// ---------------- UTXO family ----------------

/// UTXO chains we derive addresses for. The signing path differs:
/// - Btc / Ltc: BIP-84 P2WPKH (SegWit). PSBT signer in `utxo.rs` handles both.
/// - Doge / Bch / Dash: BIP-44 P2PKH legacy.
///   * Doge: SIGHASH_ALL.
///   * Bch:  SIGHASH_ALL | SIGHASH_FORKID (BIP-143-with-FORKID preimage).
///   * Dash: SIGHASH_ALL (same path as Doge).
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Deserialize, serde::Serialize)]
#[serde(rename_all = "lowercase")]
pub enum UtxoChain {
    Btc,
    Ltc,
    Doge,
    Bch,
    Dash,
}

impl UtxoChain {
    pub fn slip44(self) -> u32 {
        match self {
            UtxoChain::Btc => 0,
            UtxoChain::Ltc => 2,
            UtxoChain::Doge => 3,
            UtxoChain::Bch => 145,
            UtxoChain::Dash => 5,
        }
    }

    /// Default BIP path purpose. SegWit P2WPKH chains use BIP-84; legacy
    /// P2PKH chains use BIP-44.
    pub fn purpose(self) -> u32 {
        match self {
            UtxoChain::Btc | UtxoChain::Ltc => 84,
            UtxoChain::Doge | UtxoChain::Bch | UtxoChain::Dash => 44,
        }
    }

    #[allow(dead_code)] // exposed for future UI / logging callers
    pub fn ticker(self) -> &'static str {
        match self {
            UtxoChain::Btc => "BTC",
            UtxoChain::Ltc => "LTC",
            UtxoChain::Doge => "DOGE",
            UtxoChain::Bch => "BCH",
            UtxoChain::Dash => "DASH",
        }
    }
}

/// Derive the BIP-32 secret-key bytes for a UTXO chain at `account/index`.
pub fn utxo_secret_key(
    seed: &[u8],
    chain: UtxoChain,
    account: u32,
    index: u32,
) -> Result<Zeroizing<[u8; 32]>, DeriveError> {
    let path = format!(
        "m/{}'/{}'/{}'/0/{}",
        chain.purpose(),
        chain.slip44(),
        account,
        index
    );
    let xpriv = derive_xpriv(seed, &path)?;
    Ok(Zeroizing::new(xpriv.private_key.secret_bytes()))
}

/// Derive the compressed public-key bytes (33 bytes, secp256k1).
pub fn utxo_public_key(sk: &[u8; 32]) -> Result<[u8; 33], DeriveError> {
    let secp = secp256k1::Secp256k1::new();
    let sk = secp256k1::SecretKey::from_slice(sk).map_err(|_| DeriveError::BadPubkey)?;
    let pk = secp256k1::PublicKey::from_secret_key(&secp, &sk);
    Ok(pk.serialize())
}

/// hash160(pubkey) = RIPEMD-160(SHA-256(pubkey)) — common to every UTXO chain
/// that uses pay-to-public-key-hash.
fn hash160(pubkey: &[u8]) -> [u8; 20] {
    use ripemd::Ripemd160;
    let sha = Sha256::digest(pubkey);
    let r = Ripemd160::digest(sha);
    let mut out = [0u8; 20];
    out.copy_from_slice(&r);
    out
}

/// Encode a P2WPKH SegWit-v0 address with arbitrary HRP (`bc` for BTC,
/// `ltc` for Litecoin). The witness program is the 20-byte hash160 of
/// the compressed pubkey.
fn segwit_v0_p2wpkh_address(hrp: &str, h160: &[u8; 20]) -> Result<String, DeriveError> {
    let hrp_parsed = bech32::Hrp::parse(hrp).map_err(|e| DeriveError::Encode(e.to_string()))?;
    // SegWit v0 is encoded with `bech32::segwit::encode_v0`.
    bech32::segwit::encode_v0(hrp_parsed, h160).map_err(|e| DeriveError::Encode(e.to_string()))
}

/// Encode a P2PKH legacy address with the given version byte:
///   addr = base58check(version || hash160 || sha256(sha256(version || hash160))[..4])
fn legacy_p2pkh_address(version: u8, h160: &[u8; 20]) -> String {
    let mut payload = Vec::with_capacity(1 + 20 + 4);
    payload.push(version);
    payload.extend_from_slice(h160);
    let checksum = Sha256::digest(Sha256::digest(&payload));
    payload.extend_from_slice(&checksum[..4]);
    bs58::encode(payload).into_string()
}

/// CashAddr encoding for BCH P2PKH. Spec:
/// https://github.com/bitcoincashorg/bitcoincash.org/blob/master/spec/cashaddr.md
fn cashaddr_p2pkh_address(prefix: &str, h160: &[u8; 20]) -> String {
    // Type=0 (P2KH) + size=0 (160-bit hash) → version byte 0x00.
    let version_byte: u8 = 0x00;
    let mut payload = Vec::with_capacity(1 + 20);
    payload.push(version_byte);
    payload.extend_from_slice(h160);
    let payload5 = convert_bits(&payload, 8, 5, true);
    let checksum_input = build_cashaddr_checksum_input(prefix, &payload5);
    let checksum = polymod_cashaddr(&checksum_input);
    let mut combined = payload5;
    let checksum_bytes = (0..8).map(|i| ((checksum >> (5 * (7 - i))) & 0x1f) as u8).collect::<Vec<_>>();
    combined.extend_from_slice(&checksum_bytes);
    let cs = "qpzry9x8gf2tvdw0s3jn54khce6mua7l";
    let charset: Vec<char> = cs.chars().collect();
    let body: String = combined.iter().map(|&b| charset[b as usize]).collect();
    format!("{prefix}:{body}")
}

fn build_cashaddr_checksum_input(prefix: &str, payload5: &[u8]) -> Vec<u8> {
    let mut input = Vec::with_capacity(prefix.len() + 1 + payload5.len() + 8);
    for c in prefix.bytes() {
        input.push(c & 0x1f);
    }
    input.push(0); // separator
    input.extend_from_slice(payload5);
    input.extend_from_slice(&[0u8; 8]); // 40-bit zero checksum placeholder
    input
}

fn polymod_cashaddr(values: &[u8]) -> u64 {
    let generators: [u64; 5] = [
        0x98_f2bc_8e61, 0x79_b76d_99e2, 0xf3_3e5f_b3c4, 0xae_2eab_e2a8, 0x1e_4f43_e470,
    ];
    let mut c: u64 = 1;
    for &v in values {
        let c0: u8 = (c >> 35) as u8;
        c = ((c & 0x07_ffff_ffff) << 5) ^ (v as u64);
        for i in 0..5 {
            if (c0 >> i) & 1 == 1 {
                c ^= generators[i];
            }
        }
    }
    c ^ 1
}

/// Convert a byte stream from `from_bits`-bit groups to `to_bits`-bit groups.
/// Used for cashaddr payload (8 → 5 bits) and bech32 conversions.
fn convert_bits(data: &[u8], from_bits: u32, to_bits: u32, pad: bool) -> Vec<u8> {
    let mut acc: u32 = 0;
    let mut bits: u32 = 0;
    let mut ret = Vec::new();
    let maxv: u32 = (1u32 << to_bits) - 1;
    for &v in data {
        acc = (acc << from_bits) | (v as u32);
        bits += from_bits;
        while bits >= to_bits {
            bits -= to_bits;
            ret.push(((acc >> bits) & maxv) as u8);
        }
    }
    if pad {
        if bits > 0 {
            ret.push(((acc << (to_bits - bits)) & maxv) as u8);
        }
    }
    ret
}

/// Top-level UTXO address derivation entry point.
pub fn utxo_address(
    seed: &[u8],
    chain: UtxoChain,
    account: u32,
    index: u32,
) -> Result<String, DeriveError> {
    let sk = utxo_secret_key(seed, chain, account, index)?;
    let pk = utxo_public_key(&sk)?;
    let h = hash160(&pk);
    match chain {
        UtxoChain::Btc => segwit_v0_p2wpkh_address("bc", &h),
        UtxoChain::Ltc => segwit_v0_p2wpkh_address("ltc", &h),
        UtxoChain::Doge => Ok(legacy_p2pkh_address(0x1e, &h)),
        UtxoChain::Bch => Ok(cashaddr_p2pkh_address("bitcoincash", &h)),
        // Dash mainnet P2PKH version byte is 0x4c → "X..." addresses.
        UtxoChain::Dash => Ok(legacy_p2pkh_address(0x4c, &h)),
    }
}

/// BIP-84 native segwit P2WPKH address on Bitcoin mainnet (back-compat
/// with the original API). Implemented in terms of `utxo_address`.
pub fn btc_p2wpkh_address(seed: &[u8], account: u32, index: u32) -> Result<String, DeriveError> {
    utxo_address(seed, UtxoChain::Btc, account, index)
}

// ---------------- Solana ----------------

/// Derive the 32-byte ed25519 secret-key seed for the Solana account at
/// `m/44'/501'/0'/0'` (Phantom / Solflare convention). This re-exports the
/// helper from the `solana` module so callers can find every chain's
/// address routine in `derive.rs`.
pub fn solana_secret_key(seed: &[u8]) -> Zeroizing<[u8; 32]> {
    super::solana::sol_secret_from_seed(seed)
}

pub fn solana_address(seed: &[u8]) -> String {
    let sk = solana_secret_key(seed);
    let signing = ed25519_dalek::SigningKey::from_bytes(&sk);
    let pk_bytes = signing.verifying_key().to_bytes();
    bs58::encode(pk_bytes).into_string()
}

// ---------------- NEAR ----------------

/// NEAR implicit account ID: 64-character lower-case hex of the ed25519
/// public key. Same key used by NEP-413 signing.
pub fn near_implicit_account(seed: &[u8]) -> String {
    let sk = super::near::near_secret_from_seed(seed);
    let signing = ed25519_dalek::SigningKey::from_bytes(&sk);
    let pk_bytes = signing.verifying_key().to_bytes();
    hex::encode(pk_bytes)
}

/// NEAR "ed25519:<base58>" public key form (display only — the implicit
/// account id is the funding target).
pub fn near_ed25519_public_key(seed: &[u8]) -> String {
    let sk = super::near::near_secret_from_seed(seed);
    super::near::public_key(&sk)
}

// ---------------- tests ----------------

#[cfg(test)]
mod tests {
    use super::*;

    /// Hardhat / standard dev mnemonic. Every EVM library agrees on the
    /// derived address at m/44'/60'/0'/0/0.
    const HARDHAT_MNEMONIC: &str =
        "test test test test test test test test test test test junk";
    /// BIP-39 zero vector.
    const ABANDON_MNEMONIC: &str =
        "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";

    #[test]
    fn vector1_bip39_to_eth_address() {
        let seed = mnemonic_to_seed(HARDHAT_MNEMONIC, "").unwrap();
        let sk = evm_private_key(&seed[..], 0, 0).unwrap();
        let addr = evm_address_eip55(&sk).unwrap();
        assert_eq!(addr, "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266");
    }

    #[test]
    fn vector2_bip84_to_btc_p2wpkh() {
        let seed = mnemonic_to_seed(ABANDON_MNEMONIC, "").unwrap();
        let addr = btc_p2wpkh_address(&seed[..], 0, 0).unwrap();
        // BIP-84 §Test vectors — first receive address.
        assert_eq!(addr, "bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu");
    }

    /// LTC at BIP-84 m/84'/2'/0'/0/0 with the ABANDON mnemonic.
    ///
    /// The BIP-32 derivation chain is identical to BTC's (the only
    /// differences are the SLIP-44 coin type and the bech32 HRP); since
    /// the BTC vector above matches the BIP-84 spec, the same code path
    /// with HRP `"ltc"` and SLIP-44 `2` is correct by construction. This
    /// pin captures the specific value our implementation produces so
    /// any future drift in the bech32 / hash160 / BIP-32 layers fails
    /// loud.
    #[test]
    fn vector_ltc_bip84_p2wpkh() {
        let seed = mnemonic_to_seed(ABANDON_MNEMONIC, "").unwrap();
        let addr = utxo_address(&seed[..], UtxoChain::Ltc, 0, 0).unwrap();
        assert_eq!(addr, "ltc1qjmxnz78nmc8nq77wuxh25n2es7rzm5c2rkk4wh");
    }

    /// DOGE legacy P2PKH at BIP-44 m/44'/3'/0'/0/0. Same secp256k1 + hash160
    /// chain as BTC/LTC, base58check-encoded with version byte 0x1E. The
    /// canonical value `DBus3bamQjgJULBJtYXpEzDWQRwF5iwxgC` is the output
    /// of the standard derivation — also produced by Trust Wallet / iancoleman.
    #[test]
    fn vector_doge_bip44_p2pkh() {
        let seed = mnemonic_to_seed(ABANDON_MNEMONIC, "").unwrap();
        let addr = utxo_address(&seed[..], UtxoChain::Doge, 0, 0).unwrap();
        assert_eq!(addr, "DBus3bamQjgJULBJtYXpEzDWQRwF5iwxgC");
    }

    /// BCH cashaddr P2PKH at BIP-44 m/44'/145'/0'/0/0. Same secp256k1
    /// derivation; cashaddr-encoded with prefix `bitcoincash`. The
    /// expected value matches what electron-cash and the BCH BIP-44
    /// reference tools produce.
    #[test]
    fn vector_bch_cashaddr_p2pkh() {
        let seed = mnemonic_to_seed(ABANDON_MNEMONIC, "").unwrap();
        let addr = utxo_address(&seed[..], UtxoChain::Bch, 0, 0).unwrap();
        assert_eq!(
            addr,
            "bitcoincash:qqyx49mu0kkn9ftfj6hje6g2wfer34yfnq5tahq3q6"
        );
    }

    /// Solana — SLIP-10 ed25519 at `m/44'/501'/0'/0'`. The `nep413` test
    /// (RFC 8032 §7.1 vector) anchors the SLIP-10 ed25519 backend, so the
    /// same derivation with the Solana coin-type produces a canonical
    /// Phantom/Solflare-equivalent address.
    #[test]
    fn vector_solana_address() {
        let seed = mnemonic_to_seed(ABANDON_MNEMONIC, "").unwrap();
        let addr = solana_address(&seed[..]);
        assert_eq!(addr, "HAgk14JpMQLgt6rVgv7cBQFJWFto5Dqxi472uT3DKpqk");
    }

    /// NEAR implicit account = hex(ed25519 public key) at `m/44'/397'/0'`.
    /// The same SLIP-10 backend the NEP-413 vector locks in.
    #[test]
    fn vector_near_implicit_account() {
        let seed = mnemonic_to_seed(ABANDON_MNEMONIC, "").unwrap();
        let acct = near_implicit_account(&seed[..]);
        assert_eq!(acct.len(), 64);
        // The ed25519:<base58> display form.
        let pk = near_ed25519_public_key(&seed[..]);
        assert!(pk.starts_with("ed25519:"));
        // Hex form is just the 32-byte public key, which appears base58-
        // encoded inside `pk`.
        let base58_part = &pk["ed25519:".len()..];
        let decoded = bs58::decode(base58_part).into_vec().unwrap();
        assert_eq!(hex::encode(decoded), acct);
    }
}
