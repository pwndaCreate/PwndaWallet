//! The only module in this subsystem that moves money.
//!
//! Deliberately thin. The withdraw path already exists and is tested:
//! `swap_bridge::execute_shared_withdraw_with` → `privileged_wallet_path` +
//! `shared_withdraw_body` (`{address, value, subfee:false}`) →
//! `api_post_privileged`. Re-implementing any of that here would be a second
//! copy of a money path that can disagree with the first.
//!
//! `subfee: false` is the correct semantic for a fee and not an accident: we
//! receive **exactly** the fee and the user pays the chain cost to send it. That
//! is a disclosure obligation — the pre-trade line item must show both numbers.
//!
//! # What this module refuses
//!
//! Every guard fires **before a socket is opened**, so a test can assert *no
//! request was issued* rather than the much weaker *the request failed*. That
//! distinction is the reason `EnginePoster` exists at all.

use crate::swap_bridge::{execute_shared_withdraw_with, EnginePoster};

use super::schedule::{fee_address_for, format_amount};

/// Issue one fee payment. Returns the txid.
///
/// `amount` is atomic units. The address is **re-derived from the compiled-in
/// schedule** rather than taken from the caller: a fee address that could be
/// passed in is a fee address that could be substituted, and the whole point of
/// compiling it in is that changing it needs a rebuild.
pub async fn settle_with(
    poster: &dyn EnginePoster,
    ticker: &str,
    amount: u64,
) -> Result<String, String> {
    if amount == 0 {
        return Err("refusing to send a zero-value fee".to_string());
    }
    let address = fee_address_for(ticker)
        .ok_or_else(|| format!("no fee address is compiled in for {ticker}"))?;
    let amount_str = format_amount(amount);
    execute_shared_withdraw_with(poster, ticker, address, &amount_str).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::{json, Value};
    use std::future::Future;
    use std::pin::Pin;
    use std::sync::Mutex;

    /// Records every call so a test can assert on what was — or was not — sent.
    struct Recorder {
        calls: Mutex<Vec<(String, Value)>>,
        reply: Value,
    }
    impl Recorder {
        fn new(reply: Value) -> Self {
            Self { calls: Mutex::new(Vec::new()), reply }
        }
        fn calls(&self) -> Vec<(String, Value)> {
            self.calls.lock().unwrap().clone()
        }
    }
    impl EnginePoster for Recorder {
        fn post<'a>(
            &'a self,
            path: &'a str,
            body: Value,
        ) -> Pin<Box<dyn Future<Output = Result<Value, String>> + Send + 'a>> {
            self.calls.lock().unwrap().push((path.to_string(), body));
            let reply = self.reply.clone();
            Box::pin(async move { Ok(reply) })
        }
    }

    fn block_on<F: Future>(f: F) -> F::Output {
        tauri::async_runtime::block_on(f)
    }

    #[test]
    fn posts_to_the_privileged_withdraw_path_with_subfee_false() {
        let rec = Recorder::new(json!({"txid": "abc123"}));
        let txid = block_on(settle_with(&rec, "LTC", 22_738)).expect("should settle");
        assert_eq!(txid, "abc123");

        let calls = rec.calls();
        assert_eq!(calls.len(), 1, "exactly one request");
        assert_eq!(calls[0].0, "wallets/LTC/withdraw");
        assert_eq!(calls[0].1["subfee"], json!(false), "a fee is not a sweep");
        assert_eq!(calls[0].1["value"], json!("0.00022738"));
        assert_eq!(
            calls[0].1["address"],
            json!("ltc1q5rm7yppfc7yf7zh0ua9lm4cr6vgd5veppzalkk")
        );
    }

    /// The address comes from the compiled-in schedule, per coin.
    #[test]
    fn each_coin_goes_to_its_own_address() {
        for (ticker, want) in [
            ("LTC", "ltc1q5rm7yppfc7yf7zh0ua9lm4cr6vgd5veppzalkk"),
            ("BTC", "bc1q34ra2es97g8pdudkg7raqwd8ecen3rww0604l0"),
            ("BCH", "bitcoincash:qrppd4xmtha3ys5cmpyus0decthtw69v8u4pntv8xc"),
        ] {
            let rec = Recorder::new(json!({"txid": "t"}));
            block_on(settle_with(&rec, ticker, 100_000)).unwrap();
            assert_eq!(rec.calls()[0].1["address"], json!(want), "{ticker}");
        }
    }

    /// The important negative: a refusal must issue NO request at all. A test
    /// that only asserted "returns Err" could not tell a guard that refused
    /// apart from a network that happened to be down.
    #[test]
    fn a_zero_amount_is_refused_before_any_socket() {
        let rec = Recorder::new(json!({"txid": "t"}));
        let err = block_on(settle_with(&rec, "LTC", 0)).expect_err("must refuse");
        assert!(err.contains("zero-value"), "{err}");
        assert!(rec.calls().is_empty(), "NO request may be issued for a refused fee");
    }

    #[test]
    fn a_coin_with_no_compiled_address_is_refused_before_any_socket() {
        let rec = Recorder::new(json!({"txid": "t"}));
        let err = block_on(settle_with(&rec, "DOGE", 1_000)).expect_err("must refuse");
        assert!(err.contains("no fee address"), "{err}");
        assert!(rec.calls().is_empty(), "NO request may be issued");
    }
}
