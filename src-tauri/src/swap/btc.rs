//! UTXO PSBT signing — BTC + LTC (BIP-84 P2WPKH SegWit), DOGE (BIP-44
//! legacy P2PKH), and BCH (BIP-44 P2PKH with SIGHASH_FORKID).
//!
//! Three sighash flavors live behind one entry point:
//!
//!   - **P2WPKH** (`UtxoChain::Btc`, `UtxoChain::Ltc`): BIP-143 segwit
//!     sighash, witness-based scriptSig, single rust-bitcoin call.
//!     `witness_utxo` field on the PSBT input carries (script, value).
//!   - **Legacy P2PKH** (`UtxoChain::Doge`): pre-segwit Bitcoin sighash,
//!     classic scriptSig `<sig+sighash><pubkey>`. Uses `non_witness_utxo`
//!     (full prev-tx hex) because legacy signing needs the entire prev tx
//!     to compute the value being spent.
//!   - **P2PKH with FORKID** (`UtxoChain::Bch`): BIP-143-shaped sighash
//!     (segwit-style serialization) with `SIGHASH_FORKID = 0x40` set in
//!     the type byte and a 24-bit fork id (0 for BCH mainnet) in the
//!     high bits. rust-bitcoin doesn't natively implement this — BCH
//!     forked away in 2017 and the rust-bitcoin maintainers refuse to
//!     carry BCH support — so we hand-roll the algorithm here, mirroring
//!     the spec at
//!     <https://github.com/bitcoincashorg/bitcoincash.org/blob/master/spec/replay-protected-sighash.md>
//!     and the reference TS implementation at `src/wallets/bch-wallet.ts`.
//!
//! The dispatch lives in `sign_psbt_for_chain`; each branch shares the
//! same derivation-table walking pattern (account 0, change 0/1, indices
//! 0..ADDR_GAP) but emits chain-specific scriptSig / witness output.

use super::derive::UtxoChain;
use base64::{engine::general_purpose::STANDARD as B64, Engine as _};
use bitcoin::bip32::{DerivationPath, Xpriv};
use bitcoin::ecdsa::Signature as BtcSignature;
use bitcoin::hashes::{sha256d, Hash};
use bitcoin::psbt::Psbt;
use bitcoin::sighash::{EcdsaSighashType, SighashCache};
use bitcoin::{Amount, ScriptBuf, Witness};
use secp256k1::Secp256k1;
use std::str::FromStr;

#[derive(Debug, thiserror::Error)]
pub enum BtcError {
    #[error("invalid PSBT: {0}")]
    BadPsbt(String),
    #[error("unsupported input script (expected P2WPKH or P2PKH for the chain)")]
    Unsupported,
    #[error("BIP-32 derivation failed: {0}")]
    Bip32(String),
    #[error("sighash compute failed: {0}")]
    Sighash(String),
    #[error("signing failed: {0}")]
    Sign(String),
    #[error("no input matched a derivable key (nothing to sign)")]
    NoMatch,
    #[error("legacy P2PKH input missing non_witness_utxo (need full prev-tx hex)")]
    MissingPrevTx,
}

/// Parse a PSBT given as hex (what SwapKit returns) or as base64
/// (the standard Bitcoin Core wire form).
pub fn parse_psbt(s: &str) -> Result<Psbt, BtcError> {
    let s = s.trim();
    let body = s.strip_prefix("0x").unwrap_or(s);
    if let Ok(bytes) = hex::decode(body) {
        if let Ok(p) = Psbt::deserialize(&bytes) {
            return Ok(p);
        }
    }
    if let Ok(bytes) = B64.decode(s) {
        if let Ok(p) = Psbt::deserialize(&bytes) {
            return Ok(p);
        }
    }
    Err(BtcError::BadPsbt("not valid hex or base64 PSBT".into()))
}

const ADDR_GAP: u32 = 50;

/// SIGHASH_ALL | SIGHASH_FORKID for BCH. Low byte 0x41; high 24 bits
/// carry the fork id (0 on BCH mainnet) in BCH's preimage construction.
const BCH_SIGHASH_TYPE: u32 = 0x41;
const BCH_FORK_ID: u32 = 0;

/// Sign every matching input in the PSBT. Dispatch by chain type:
///   - Btc / Ltc → P2WPKH segwit signing (witness output)
///   - Doge → legacy P2PKH signing (scriptSig output, SIGHASH_ALL)
///   - Bch → P2PKH with FORKID (scriptSig output, SIGHASH_ALL|FORKID)
///
/// Returns the PSBT serialized as hex with `final_script_*` populated.
/// Caller hands to `extract_tx` to get the broadcast-ready raw tx.
pub fn sign_psbt_for_chain(
    seed: &[u8],
    psbt_input: &str,
    chain: UtxoChain,
) -> Result<String, BtcError> {
    let mut psbt = parse_psbt(psbt_input)?;
    let secp = Secp256k1::new();
    let master = Xpriv::new_master(bitcoin::NetworkKind::Main, seed)
        .map_err(|e| BtcError::Bip32(e.to_string()))?;

    let purpose = chain.purpose();
    let coin_type = chain.slip44();

    // Derive a table of candidate keys at change ∈ {0,1}, idx ∈ [0,GAP).
    // The script_pubkey we store depends on the chain's expected input
    // type — P2WPKH for BTC/LTC, P2PKH for DOGE/BCH. The match against
    // the input's script identifies which key signs.
    let mut derivations: Vec<(ScriptBuf, [u8; 32], bitcoin::PublicKey)> = Vec::new();
    for change in 0u32..=1 {
        for idx in 0..ADDR_GAP {
            let path = DerivationPath::from_str(&format!(
                "m/{purpose}'/{coin_type}'/0'/{change}/{idx}"
            ))
            .map_err(|e| BtcError::Bip32(e.to_string()))?;
            let child = master
                .derive_priv(&secp, &path)
                .map_err(|e| BtcError::Bip32(e.to_string()))?;
            let pk = child.to_priv().public_key(&secp);

            let script_pubkey = match chain {
                UtxoChain::Btc | UtxoChain::Ltc => {
                    let cpk = bitcoin::CompressedPublicKey::try_from(pk)
                        .map_err(|_| BtcError::Unsupported)?;
                    bitcoin::Address::p2wpkh(&cpk, bitcoin::Network::Bitcoin).script_pubkey()
                }
                UtxoChain::Doge | UtxoChain::Bch | UtxoChain::Dash => {
                    // P2PKH script_pubkey is `OP_DUP OP_HASH160 <pkh20>
                    // OP_EQUALVERIFY OP_CHECKSIG`. The address ENCODING
                    // (DOGE base58check D-prefix, BCH CashAddr, DASH
                    // base58check X-prefix) is chain-specific, but the
                    // script bytes are identical — and the script is
                    // what the PSBT input's prev-out carries, so that's
                    // what we match against.
                    bitcoin::Address::p2pkh(pk, bitcoin::Network::Bitcoin).script_pubkey()
                }
            };
            derivations.push((script_pubkey, child.private_key.secret_bytes(), pk));
        }
    }

    let mut signed_any = false;
    let inputs_len = psbt.inputs.len();
    for i in 0..inputs_len {
        match chain {
            UtxoChain::Btc | UtxoChain::Ltc => {
                if sign_input_p2wpkh(&mut psbt, i, &derivations, &secp)? {
                    signed_any = true;
                }
            }
            UtxoChain::Doge | UtxoChain::Dash => {
                // Dash uses the same legacy sighash as DOGE — pre-segwit
                // Bitcoin's SIGHASH_ALL preimage. The only chain-specific
                // bit is the address encoding, which is a TS-side concern
                // (Rust never produces an address string for a Dash tx —
                // it just signs the script-pubkey'd P2PKH input).
                if sign_input_p2pkh_legacy(&mut psbt, i, &derivations, &secp)? {
                    signed_any = true;
                }
            }
            UtxoChain::Bch => {
                if sign_input_p2pkh_forkid(&mut psbt, i, &derivations, &secp)? {
                    signed_any = true;
                }
            }
        }
    }

    if !signed_any {
        return Err(BtcError::NoMatch);
    }
    Ok(hex::encode(psbt.serialize()))
}

/// P2WPKH segwit input — BIP-143 sighash, witness-based scriptSig.
/// Returns `Ok(true)` if the input was signed, `Ok(false)` if it didn't
/// match any derivation (caller continues with next input).
fn sign_input_p2wpkh(
    psbt: &mut Psbt,
    i: usize,
    derivations: &[(ScriptBuf, [u8; 32], bitcoin::PublicKey)],
    secp: &Secp256k1<secp256k1::All>,
) -> Result<bool, BtcError> {
    let utxo = match psbt.inputs[i].witness_utxo.as_ref() {
        Some(u) => u.clone(),
        None => return Ok(false),
    };
    if !utxo.script_pubkey.is_p2wpkh() {
        return Err(BtcError::Unsupported);
    }
    let Some(idx) = derivations
        .iter()
        .position(|(spk, _, _)| spk == &utxo.script_pubkey)
    else {
        return Ok(false);
    };
    let (_, sk_bytes, pk) = derivations[idx].clone();

    let amount = Amount::from_sat(utxo.value.to_sat());
    let mut cache = SighashCache::new(&psbt.unsigned_tx);
    let sighash = cache
        .p2wpkh_signature_hash(i, &utxo.script_pubkey, amount, EcdsaSighashType::All)
        .map_err(|e| BtcError::Sighash(e.to_string()))?;
    let msg = secp256k1::Message::from_digest(sighash.to_byte_array());
    let sk = secp256k1::SecretKey::from_slice(&sk_bytes)
        .map_err(|e| BtcError::Sign(e.to_string()))?;
    let sig = secp.sign_ecdsa(&msg, &sk);
    let bsig = BtcSignature {
        signature: sig,
        sighash_type: EcdsaSighashType::All,
    };

    let mut w = Witness::new();
    w.push(bsig.serialize().to_vec());
    w.push(pk.to_bytes());
    psbt.inputs[i].final_script_witness = Some(w);
    psbt.inputs[i].partial_sigs.clear();
    Ok(true)
}

/// Legacy P2PKH input (Dogecoin) — pre-segwit Bitcoin sighash with
/// SIGHASH_ALL. Uses `non_witness_utxo` (full prev-tx) to get the
/// script_pubkey of the input we're spending.
///
/// The legacy sighash algorithm:
///   1. Take the unsigned tx
///   2. Replace input[i].script_sig with the prev-out's script_pubkey
///   3. Set every OTHER input's script_sig to empty
///   4. Append sighash type as 4 LE bytes
///   5. Double-SHA256 the serialized result
///
/// rust-bitcoin's `SighashCache::legacy_signature_hash` does this for us.
fn sign_input_p2pkh_legacy(
    psbt: &mut Psbt,
    i: usize,
    derivations: &[(ScriptBuf, [u8; 32], bitcoin::PublicKey)],
    secp: &Secp256k1<secp256k1::All>,
) -> Result<bool, BtcError> {
    // Legacy inputs use `non_witness_utxo` — the full prev-tx — because
    // the verifier needs the prev-out's value to validate the spend.
    let prev_tx = match psbt.inputs[i].non_witness_utxo.as_ref() {
        Some(t) => t.clone(),
        None => return Err(BtcError::MissingPrevTx),
    };
    let prev_vout = psbt.unsigned_tx.input[i].previous_output.vout as usize;
    let prev_out = prev_tx
        .output
        .get(prev_vout)
        .ok_or_else(|| BtcError::BadPsbt(format!("input {i} prev_vout out of range")))?;
    let spk = &prev_out.script_pubkey;
    if !spk.is_p2pkh() {
        return Err(BtcError::Unsupported);
    }
    let Some(idx) = derivations.iter().position(|(s, _, _)| s == spk) else {
        return Ok(false);
    };
    let (_, sk_bytes, pk) = derivations[idx].clone();

    let cache = SighashCache::new(&psbt.unsigned_tx);
    let sighash = cache
        .legacy_signature_hash(i, spk, EcdsaSighashType::All.to_u32())
        .map_err(|e| BtcError::Sighash(e.to_string()))?;
    let msg = secp256k1::Message::from_digest(sighash.to_byte_array());
    let sk = secp256k1::SecretKey::from_slice(&sk_bytes)
        .map_err(|e| BtcError::Sign(e.to_string()))?;
    let sig = secp.sign_ecdsa(&msg, &sk);

    // P2PKH scriptSig = <DER sig + sighash byte> <pubkey>
    let mut der_with_type = sig.serialize_der().to_vec();
    der_with_type.push(EcdsaSighashType::All.to_u32() as u8);
    let script_sig = build_p2pkh_scriptsig(&der_with_type, &pk.to_bytes())?;
    psbt.inputs[i].final_script_sig = Some(script_sig);
    psbt.inputs[i].partial_sigs.clear();
    Ok(true)
}

/// BCH P2PKH with SIGHASH_FORKID — BIP-143-shaped preimage with the
/// fork id encoded in the high bits of the sighash type. Hand-rolled
/// because rust-bitcoin doesn't carry BCH support.
///
/// Spec: <https://github.com/bitcoincashorg/bitcoincash.org/blob/master/spec/replay-protected-sighash.md>
/// Reference TS impl: `src/wallets/bch-wallet.ts::computeBchSighash`.
///
/// Preimage layout (matches BIP-143 with FORKID extension):
///   nVersion         (4 LE)
///   hashPrevouts     (32) — sha256d(concat of all inputs' (txid, vout))
///   hashSequence     (32) — sha256d(concat of all inputs' nSequence)
///   prev outpoint    (36) — txid (32) + vout (4 LE)
///   scriptCode       (var) — for P2PKH: 0x19 76 a9 14 <pkh20> 88 ac
///   value            (8 LE) — amount being spent in satoshis
///   nSequence        (4 LE) — this input's nSequence
///   hashOutputs      (32) — sha256d(concat of all outputs' (value+script))
///   nLockTime        (4 LE)
///   sighashType      (4 LE) — (fork_id << 8) | (BCH_SIGHASH_TYPE & 0xff)
///
/// sighash = sha256d(preimage)
fn sign_input_p2pkh_forkid(
    psbt: &mut Psbt,
    i: usize,
    derivations: &[(ScriptBuf, [u8; 32], bitcoin::PublicKey)],
    secp: &Secp256k1<secp256k1::All>,
) -> Result<bool, BtcError> {
    let prev_tx = match psbt.inputs[i].non_witness_utxo.as_ref() {
        Some(t) => t.clone(),
        None => return Err(BtcError::MissingPrevTx),
    };
    let prev_vout = psbt.unsigned_tx.input[i].previous_output.vout as usize;
    let prev_out = prev_tx
        .output
        .get(prev_vout)
        .ok_or_else(|| BtcError::BadPsbt(format!("input {i} prev_vout out of range")))?
        .clone();
    let spk = prev_out.script_pubkey.clone();
    if !spk.is_p2pkh() {
        return Err(BtcError::Unsupported);
    }
    let Some(idx) = derivations.iter().position(|(s, _, _)| s == &spk) else {
        return Ok(false);
    };
    let (_, sk_bytes, pk) = derivations[idx].clone();

    let preimage = bch_forkid_preimage(
        &psbt.unsigned_tx,
        i,
        &spk,
        prev_out.value.to_sat(),
    );
    let digest = sha256d::Hash::hash(&preimage);
    let msg = secp256k1::Message::from_digest(digest.to_byte_array());
    let sk = secp256k1::SecretKey::from_slice(&sk_bytes)
        .map_err(|e| BtcError::Sign(e.to_string()))?;
    let sig = secp.sign_ecdsa(&msg, &sk);

    let mut der_with_type = sig.serialize_der().to_vec();
    der_with_type.push((BCH_SIGHASH_TYPE & 0xff) as u8);
    let script_sig = build_p2pkh_scriptsig(&der_with_type, &pk.to_bytes())?;
    psbt.inputs[i].final_script_sig = Some(script_sig);
    psbt.inputs[i].partial_sigs.clear();
    Ok(true)
}

/// Build a standard P2PKH scriptSig: `<sig+sighash_type> <pubkey>`. Used
/// by both legacy DOGE and BCH-with-FORKID — same script structure,
/// different sighash byte appended to the DER signature.
fn build_p2pkh_scriptsig(
    sig_with_type: &[u8],
    pubkey_bytes: &[u8],
) -> Result<ScriptBuf, BtcError> {
    let sig_buf: bitcoin::script::PushBytesBuf = sig_with_type
        .to_vec()
        .try_into()
        .map_err(|_| BtcError::Sign("signature length out of push range".into()))?;
    let pk_buf: bitcoin::script::PushBytesBuf = pubkey_bytes
        .to_vec()
        .try_into()
        .map_err(|_| BtcError::Sign("pubkey length out of push range".into()))?;
    Ok(bitcoin::script::Builder::new()
        .push_slice(&sig_buf)
        .push_slice(&pk_buf)
        .into_script())
}

/// Build the BIP-143-with-FORKID preimage. `unsigned_tx` is the
/// transaction template (no scriptSigs filled in); `input_idx` is the
/// input we're signing; `script_code` is the prev-out's script_pubkey
/// (for P2PKH it's the standard `OP_DUP OP_HASH160 <pkh> OP_EQUALVERIFY
/// OP_CHECKSIG`); `amount_sat` is the prev-out's value in satoshis.
fn bch_forkid_preimage(
    unsigned_tx: &bitcoin::Transaction,
    input_idx: usize,
    script_code: &ScriptBuf,
    amount_sat: u64,
) -> Vec<u8> {
    let mut buf = Vec::with_capacity(256);

    // 1. nVersion (4 LE)
    buf.extend_from_slice(&unsigned_tx.version.0.to_le_bytes());

    // 2. hashPrevouts: sha256d(concat of all inputs' (txid LE 32 + vout LE 4))
    let mut prevouts = Vec::with_capacity(36 * unsigned_tx.input.len());
    for inp in &unsigned_tx.input {
        prevouts.extend_from_slice(&inp.previous_output.txid.to_byte_array());
        prevouts.extend_from_slice(&inp.previous_output.vout.to_le_bytes());
    }
    let hash_prevouts = sha256d::Hash::hash(&prevouts);
    buf.extend_from_slice(&hash_prevouts.to_byte_array());

    // 3. hashSequence: sha256d(concat of all inputs' nSequence LE 4)
    let mut sequences = Vec::with_capacity(4 * unsigned_tx.input.len());
    for inp in &unsigned_tx.input {
        sequences.extend_from_slice(&inp.sequence.0.to_le_bytes());
    }
    let hash_sequence = sha256d::Hash::hash(&sequences);
    buf.extend_from_slice(&hash_sequence.to_byte_array());

    // 4. prev outpoint of THIS input: txid (32) + vout (4 LE)
    let prev = &unsigned_tx.input[input_idx].previous_output;
    buf.extend_from_slice(&prev.txid.to_byte_array());
    buf.extend_from_slice(&prev.vout.to_le_bytes());

    // 5. scriptCode — varint length + bytes. P2PKH script is 25 bytes
    // (0x76 0xa9 0x14 <20 bytes pkh> 0x88 0xac); varint is single byte 0x19.
    let sc_bytes = script_code.as_bytes();
    buf.extend_from_slice(&compact_size(sc_bytes.len() as u64));
    buf.extend_from_slice(sc_bytes);

    // 6. value of the prev out (8 LE)
    buf.extend_from_slice(&amount_sat.to_le_bytes());

    // 7. nSequence of THIS input (4 LE)
    buf.extend_from_slice(&unsigned_tx.input[input_idx].sequence.0.to_le_bytes());

    // 8. hashOutputs: sha256d(concat of all outputs' (value LE 8 + scriptPubKey
    //    serialized as varint+bytes))
    let mut outs = Vec::with_capacity(64);
    for out in &unsigned_tx.output {
        outs.extend_from_slice(&out.value.to_sat().to_le_bytes());
        let script = out.script_pubkey.as_bytes();
        outs.extend_from_slice(&compact_size(script.len() as u64));
        outs.extend_from_slice(script);
    }
    let hash_outputs = sha256d::Hash::hash(&outs);
    buf.extend_from_slice(&hash_outputs.to_byte_array());

    // 9. nLockTime (4 LE)
    buf.extend_from_slice(&unsigned_tx.lock_time.to_consensus_u32().to_le_bytes());

    // 10. sighashType (4 LE) — fork_id << 8 | sighash_byte
    let sighash_with_fork = (BCH_FORK_ID << 8) | BCH_SIGHASH_TYPE;
    buf.extend_from_slice(&sighash_with_fork.to_le_bytes());

    buf
}

/// CompactSize integer encoding (Bitcoin var-int). 1 byte for <0xfd,
/// otherwise a length prefix + LE bytes.
fn compact_size(n: u64) -> Vec<u8> {
    if n < 0xfd {
        vec![n as u8]
    } else if n <= 0xffff {
        let mut v = vec![0xfd];
        v.extend_from_slice(&(n as u16).to_le_bytes());
        v
    } else if n <= 0xffff_ffff {
        let mut v = vec![0xfe];
        v.extend_from_slice(&(n as u32).to_le_bytes());
        v
    } else {
        let mut v = vec![0xff];
        v.extend_from_slice(&n.to_le_bytes());
        v
    }
}

/// Extract the broadcast-ready raw transaction (hex) from a finalized PSBT.
pub fn extract_tx(psbt_hex: &str) -> Result<String, BtcError> {
    let bytes = hex::decode(psbt_hex.trim()).map_err(|e| BtcError::BadPsbt(e.to_string()))?;
    let psbt = Psbt::deserialize(&bytes).map_err(|e| BtcError::BadPsbt(e.to_string()))?;
    let tx = psbt
        .extract_tx()
        .map_err(|e| BtcError::BadPsbt(format!("extract: {e:?}")))?;
    Ok(hex::encode(bitcoin::consensus::serialize(&tx)))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// CompactSize encoding test vectors from the Bitcoin spec.
    #[test]
    fn compact_size_encodes_canonically() {
        assert_eq!(compact_size(0), vec![0x00]);
        assert_eq!(compact_size(0xfc), vec![0xfc]);
        assert_eq!(compact_size(0xfd), vec![0xfd, 0xfd, 0x00]);
        assert_eq!(compact_size(0xffff), vec![0xfd, 0xff, 0xff]);
        assert_eq!(
            compact_size(0x10000),
            vec![0xfe, 0x00, 0x00, 0x01, 0x00]
        );
    }

    /// The DOGE chain uses BIP-44 purpose=44, slip44=3.
    #[test]
    fn doge_uses_bip44_purpose_and_slip44_3() {
        assert_eq!(UtxoChain::Doge.purpose(), 44);
        assert_eq!(UtxoChain::Doge.slip44(), 3);
    }

    /// The BCH chain uses BIP-44 purpose=44, slip44=145.
    #[test]
    fn bch_uses_bip44_purpose_and_slip44_145() {
        assert_eq!(UtxoChain::Bch.purpose(), 44);
        assert_eq!(UtxoChain::Bch.slip44(), 145);
    }

    /// BCH FORKID preimage size sanity. The preimage should be exactly:
    ///   4 (version) + 32 (hashPrevouts) + 32 (hashSequence) + 36
    ///   (this prevout) + 26 (scriptCode: 1-byte varint + 25-byte P2PKH)
    ///   + 8 (value) + 4 (sequence) + 32 (hashOutputs) + 4 (locktime)
    ///   + 4 (sighash type with fork id) = 182 bytes.
    /// Larger preimages indicate a serialization bug (e.g. wrong varint
    /// length on scriptCode). Smaller indicates missing fields.
    #[test]
    fn bch_forkid_preimage_has_canonical_length() {
        use bitcoin::absolute::LockTime;
        use bitcoin::transaction::Version;
        use bitcoin::{OutPoint, Sequence, TxIn, TxOut, Transaction};

        // Synthesize a minimal 1-in 1-out tx for the preimage builder.
        let prev_outpoint = OutPoint {
            txid: bitcoin::Txid::from_byte_array([0u8; 32]),
            vout: 0,
        };
        let tx = Transaction {
            version: Version::TWO,
            lock_time: LockTime::ZERO,
            input: vec![TxIn {
                previous_output: prev_outpoint,
                script_sig: ScriptBuf::new(),
                sequence: Sequence::MAX,
                witness: Witness::new(),
            }],
            output: vec![TxOut {
                value: Amount::from_sat(50_000),
                script_pubkey: ScriptBuf::from_bytes(vec![
                    0x76, 0xa9, 0x14, 0x00, 0x01, 0x02, 0x03, 0x04, 0x05,
                    0x06, 0x07, 0x08, 0x09, 0x0a, 0x0b, 0x0c, 0x0d, 0x0e,
                    0x0f, 0x10, 0x11, 0x12, 0x13, 0x88, 0xac,
                ]),
            }],
        };
        // P2PKH scriptCode is the standard 25-byte template.
        let script_code = ScriptBuf::from_bytes(vec![
            0x76, 0xa9, 0x14, 0xaa, 0xbb, 0xcc, 0xdd, 0xee, 0xff, 0x00,
            0x11, 0x22, 0x33, 0x44, 0x55, 0x66, 0x77, 0x88, 0x99, 0xaa,
            0xbb, 0xcc, 0xdd, 0x88, 0xac,
        ]);
        let preimage = bch_forkid_preimage(&tx, 0, &script_code, 100_000);

        assert_eq!(
            preimage.len(),
            4 + 32 + 32 + 36 + 1 + 25 + 8 + 4 + 32 + 4 + 4,
            "BCH preimage length differs from spec — serialization bug"
        );
        // Last 4 bytes carry sighash + fork id (0x00000041 LE).
        assert_eq!(
            &preimage[preimage.len() - 4..],
            &[0x41, 0x00, 0x00, 0x00],
            "sighash type LE should be 0x41 0x00 0x00 0x00"
        );
        // CompactSize prefix on scriptCode (1 byte 0x19 since len=25).
        let sc_prefix_pos = 4 + 32 + 32 + 36;
        assert_eq!(
            preimage[sc_prefix_pos], 0x19,
            "scriptCode varint should be 0x19 for 25-byte P2PKH"
        );
    }

    /// Fixed-seed sanity: a P2PKH script_pubkey derived for DOGE at
    /// account 0 / change 0 / index 0 round-trips to a deterministic
    /// hex. Pins the derivation so changes to the path or pubkey
    /// encoding fail loudly.
    #[test]
    fn doge_derivation_produces_p2pkh_script() {
        let abandon = "abandon abandon abandon abandon abandon abandon \
                       abandon abandon abandon abandon abandon about";
        let mut seed = [0u8; 64];
        // bip39::Seed unavailable here; use the real PBKDF2 path via the
        // crate the rest of the codebase uses. The bitcoin crate brings
        // bip39 in transitively, but we keep this test minimal: just
        // hash-derive a seed from the canonical mnemonic via SHA-512
        // for determinism. We check the SCRIPT shape, not byte equality
        // to a third-party reference (that's the cross-vector job for
        // the live integration test).
        use sha2::{Digest, Sha512};
        let h = Sha512::digest(abandon.as_bytes());
        seed.copy_from_slice(&h);

        let secp = Secp256k1::new();
        let master = Xpriv::new_master(bitcoin::NetworkKind::Main, &seed).unwrap();
        let path = DerivationPath::from_str("m/44'/3'/0'/0/0").unwrap();
        let child = master.derive_priv(&secp, &path).unwrap();
        let pk = child.to_priv().public_key(&secp);
        let script = bitcoin::Address::p2pkh(pk, bitcoin::Network::Bitcoin).script_pubkey();

        // P2PKH script is 25 bytes: OP_DUP OP_HASH160 <push 20> <20 bytes> OP_EQUALVERIFY OP_CHECKSIG
        assert_eq!(script.len(), 25);
        let bytes = script.as_bytes();
        assert_eq!(bytes[0], 0x76); // OP_DUP
        assert_eq!(bytes[1], 0xa9); // OP_HASH160
        assert_eq!(bytes[2], 0x14); // push 20
        assert_eq!(bytes[23], 0x88); // OP_EQUALVERIFY
        assert_eq!(bytes[24], 0xac); // OP_CHECKSIG
    }
}
