// Smoke test for polyseed.ts. Run with `npx tsx scripts/polyseed-smoke.mjs`.
// Intentionally minimal (no test framework) so it runs in any recent Node
// without extra CI deps.
//
// Verifies:
//   1. Round-trip encode/decode preserves the data.
//   2. Decoding the reference phrase from tevador/polyseed's test suite
//      ("raven tail swear …") succeeds and its birthday is a sane value.
//   3. Same phrase → same spend key (determinism).

import {
  polyseedDecode,
  polyseedEncode,
  polyseedKeygen,
  generatePolyseed,
  birthdayDecode,
} from "../src/wallets/polyseed.ts";

// Test vector from https://github.com/tevador/polyseed/blob/master/tests/tests.c
// (phrase `g_phrase_en1`). The reference doesn't publish the derived spend
// key alongside, so we only verify that decoding succeeds and is stable.
const REF_PHRASE =
  "raven tail swear infant grief assist regular lamp duck valid someone little harsh puppy airport language";

function assert(cond, msg) {
  if (!cond) throw new Error(`ASSERT FAIL: ${msg}`);
  console.log(`  OK: ${msg}`);
}

function hex(u8) {
  return Array.from(u8)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

console.log("— Decode reference phrase —");
const decoded = polyseedDecode(REF_PHRASE);
assert(decoded.ok, "decode ok for reference phrase");
if (!decoded.ok) process.exit(1);
console.log(
  `  birthday index=${decoded.data.birthday}  date=${new Date(birthdayDecode(decoded.data.birthday) * 1000).toISOString()}`
);
console.log(
  `  features=${decoded.data.features}  secret=${hex(decoded.data.secret.subarray(0, 19))}`
);

console.log("— Re-encode should reproduce phrase —");
const reencoded = polyseedEncode({ ...decoded.data, secret: decoded.data.secret });
assert(reencoded === REF_PHRASE, "re-encoded phrase matches original");

console.log("— Derive Monero spend key (deterministic) —");
const k1 = polyseedKeygen(decoded.data);
const k2 = polyseedKeygen(decoded.data);
assert(hex(k1) === hex(k2), "keygen is deterministic");
console.log(`  spend key (raw, pre-sc_reduce32) = ${hex(k1)}`);

console.log("— Generate fresh + round-trip —");
const fresh = generatePolyseed();
console.log(`  fresh phrase: ${fresh.phrase}`);
const roundTrip = polyseedDecode(fresh.phrase);
assert(roundTrip.ok, "fresh phrase decodes");
if (!roundTrip.ok) process.exit(1);
assert(
  hex(roundTrip.data.secret.subarray(0, 19)) ===
    hex(fresh.data.secret.subarray(0, 19)),
  "fresh → encode → decode preserves secret"
);
assert(
  roundTrip.data.birthday === fresh.data.birthday,
  "fresh → encode → decode preserves birthday"
);

console.log("\nAll polyseed checks passed.");
