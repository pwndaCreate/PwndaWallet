/**
 * XELIS seed/address vectors PRODUCED BY THE REAL BINARY.
 *
 * Generated mechanically from `scratchpad/xelis-spike/vectors.json` (the P0
 * spike, 2026-09-15) by `scratchpad/gen-xelis-vectors.mjs` — never hand-typed,
 * because a mistyped vector is a test that certifies the wrong codec.
 *
 * Source binary:
 * xelis_wallet 1.25.0-b149b57a (official release v1.25.0, x86_64-pc-windows-msvc, sha256 9aa47e316889ca386c819b7dfb8d3fbcfeb403bf5a88c6925a2566f4094b577a)
 *
 * How the positive rows were produced (spike B2): the binary created a random
 * wallet on testnet; its seed was read out of the interactive `seed` command and
 * its address out of `display_address`; each seed was then RESTORED by the binary
 * on BOTH networks and the address read back over RPC. So every row is
 * binary-create == binary-restore == our derivation, not one implementation
 * agreeing with itself.
 *
 * The negative rows carry the binary's VERBATIM stderr, so a change that starts
 * accepting one of them fails against what the binary actually says rather than
 * against a paraphrase. Three of them the binary ACCEPTS (24 words, mixed case,
 * and a u32-overflow triple) — those are recorded as accepted, with the address
 * it produced, because 'surprising but true' is exactly what a fixture is for.
 *
 * The private keys are JS-derived: no CLI command or RPC method prints one. They
 * are confirmed only indirectly, by the addresses matching the binary's.
 */

export interface XelisVector {
  id: string;
  seed: string;
  checksumWord: string;
  testnetAddress: string;
  mainnetAddress: string;
  privateKeyHex: string;
  publicKeyHex: string;
}

export interface XelisNegativeVector {
  case: string;
  seed: string;
  /** Did the real binary ACCEPT this seed? */
  binaryAccepted: boolean;
  /** The binary's stderr, verbatim (empty when it accepted the seed). */
  binaryStderr: string;
  /** The address the binary derived, when it accepted the seed. */
  binaryTestnetAddress: string | null;
}

/** Positive vectors: 25 words, binary-created AND binary-restored. */
export const XELIS_VECTORS: readonly XelisVector[] = [
  {
    id: "vec-trial",
    seed: "gutter slug fancy iguana drowning fewest bemused buckets pouch down ribbon bumper payment newt aztec gearbox fewest point hounded oncoming ongoing soapy tacit thaw thaw",
    checksumWord: "thaw",
    testnetAddress: "xet:qc3hdkmsc0nqks7jqz8cpnzv5c3ur7my6yy7ct6ulf5kuexv53pqq2vh883",
    mainnetAddress: "xel:qc3hdkmsc0nqks7jqz8cpnzv5c3ur7my6yy7ct6ulf5kuexv53pqqjlaht0",
    privateKeyHex: "1a7f4b7ebc735a13d4c8ba8c4374816971f90b84e0748a61ea8659005b699304",
    publicKeyHex: "062376db70c3e60b43d2008f80cc4ca623c1fb64d109ec2f5cfa696e64cca442",
  },
  {
    id: "vec-1",
    seed: "etched gypsy plywood guarded behind gels mighty mayor sulking pedantic dogs asked badge having emit sniff godfather offend wonders biology niece railway segments sieve behind",
    checksumWord: "behind",
    testnetAddress: "xet:ym3qntl80esaae92u6ac4dk0nq2lle8scy03f8xknud9at29w3csqth4wpx",
    mainnetAddress: "xel:ym3qntl80esaae92u6ac4dk0nq2lle8scy03f8xknud9at29w3csqnyl7dc",
    privateKeyHex: "d8aea64e3b110e3ba0997b4be33ededcd23006e280c41d422412af766d277a03",
    publicKeyHex: "26e209afe77e61dee4aae6bb8ab6cf9815ffe4f0c11f149cd69f1a5ead457471",
  },
  {
    id: "vec-2",
    seed: "fizzle hashing tutor lending number adopt inquest cuddled omission vats erected hoax hounded mostly enmity idiom axle goldfish baffles sighting mews much onboard oust cuddled",
    checksumWord: "cuddled",
    testnetAddress: "xet:mt3nxs8tfwehpddz0gkdqsvne39uega9qjn8rdkjc7xqx64l5slqqv32y95",
    mainnetAddress: "xel:mt3nxs8tfwehpddz0gkdqsvne39uega9qjn8rdkjc7xqx64l5slqq5zq5f2",
    privateKeyHex: "a1998a84ce1b116dad657a708ff0911fa4a509b6b1633d43dd2419c22415e504",
    publicKeyHex: "dae33340eb4bb370b5a27a2cd04193cc4bcca3a504a671b6d2c78c036abfa43e",
  },
  {
    id: "vec-3",
    seed: "rodent catch violin lymph sulking necklace dazed bevel amply gather whipped pivot idiom inflamed rodent dolphin junk withdrawn thumbs toyed goat enjoy leopard lied bevel",
    checksumWord: "bevel",
    testnetAddress: "xet:56nk0ephwsayjrxafxcyugp3p6t0m49guf47yx7wmpy62z8umvxqq2wucg6",
    mainnetAddress: "xel:56nk0ephwsayjrxafxcyugp3p6t0m49guf47yx7wmpy62z8umvxqqjakgyy",
    privateKeyHex: "1b1b9dccb9370bbf899891f10bd62cb2755f005108f80a854a14307946194c01",
    publicKeyHex: "a6a767e437743a490cdd49b04e20310e96fdd4a8e26be21bced849a508fcdb0c",
  },
  {
    id: "vec-4",
    seed: "criminal mechanic glass yearbook oozed tequila custom odds apart diode auburn duration altitude launching comb textbook problems oxidant sack swagger roped woven usage wield auburn",
    checksumWord: "auburn",
    testnetAddress: "xet:5nfjck8peacf055s79r0dp67veg5lz6h33dnp3p2skmnmudu65xqq8nw35n",
    mainnetAddress: "xel:5nfjck8peacf055s79r0dp67veg5lz6h33dnp3p2skmnmudu65xqqlqypcd",
    privateKeyHex: "eb6a8bd01b58093ba1430d7482736e26edb876afb8e83bf49fe3c4e848d0030e",
    publicKeyHex: "a4d32c58e1cf7097d290f146f6875e66514f8b578c5b30c42a85b73df1bcd50c",
  },
  {
    id: "vec-5",
    seed: "grunt kickoff huts powder voice lending ability geometry pastry imbalance hover innocent drowning actress vegan organs zigzags ardent vulture queen welders artistic folding geek lending",
    checksumWord: "lending",
    testnetAddress: "xet:ss8sq9ql430n0jv36m73amzp4xh89vqspmkusf6kffvdtulpx4zqqd8dq6t",
    mainnetAddress: "xel:ss8sq9ql430n0jv36m73amzp4xh89vqspmkusf6kffvdtulpx4zqq458sk4",
    privateKeyHex: "ee7264ef78c7168a9eca794f59be9d06abe4b7eb5ec77210d5de9c4583a90606",
    publicKeyHex: "840f00141fac5f37c991d6fd1eec41a9ae72b0100eedc827564a58d5f3e13544",
  },
];

/** Seeds the binary REJECTED, plus the three it surprisingly ACCEPTED. */
export const XELIS_NEGATIVE_VECTORS: readonly XelisNegativeVector[] = [
  {
    case: "wrong_checksum_word",
    seed: "etched gypsy plywood guarded behind gels mighty mayor sulking pedantic dogs asked badge having emit sniff godfather offend wonders biology niece railway segments sieve abbey",
    binaryAccepted: false,
    binaryStderr: "Error: Invalid checksum",
    binaryTestnetAddress: null,
  },
  {
    case: "unknown_word_position0",
    seed: "notaword gypsy plywood guarded behind gels mighty mayor sulking pedantic dogs asked badge having emit sniff godfather offend wonders biology niece railway segments sieve behind",
    binaryAccepted: false,
    binaryStderr: "Error: No indices found",
    binaryTestnetAddress: null,
  },
  {
    case: "unknown_word_position5",
    seed: "etched gypsy plywood guarded behind notaword mighty mayor sulking pedantic dogs asked badge having emit sniff godfather offend wonders biology niece railway segments sieve behind",
    binaryAccepted: false,
    binaryStderr: "Error: Unknown word: notaword at position 5",
    binaryTestnetAddress: null,
  },
  {
    case: "monero_style_3char_prefix",
    seed: "etc gypsy plywood guarded behind gels mighty mayor sulking pedantic dogs asked badge having emit sniff godfather offend wonders biology niece railway segments sieve behind",
    binaryAccepted: false,
    binaryStderr: "Error: No indices found",
    binaryTestnetAddress: null,
  },
  {
    case: "words_23",
    seed: "etched gypsy plywood guarded behind gels mighty mayor sulking pedantic dogs asked badge having emit sniff godfather offend wonders biology niece railway segments",
    binaryAccepted: false,
    binaryStderr: "Error: Invalid words count",
    binaryTestnetAddress: null,
  },
  {
    case: "words_26",
    seed: "etched gypsy plywood guarded behind gels mighty mayor sulking pedantic dogs asked badge having emit sniff godfather offend wonders biology niece railway segments sieve behind abbey",
    binaryAccepted: false,
    binaryStderr: "Error: Invalid words count",
    binaryTestnetAddress: null,
  },
  {
    case: "words_24_no_checksum",
    seed: "etched gypsy plywood guarded behind gels mighty mayor sulking pedantic dogs asked badge having emit sniff godfather offend wonders biology niece railway segments sieve",
    binaryAccepted: true,
    binaryStderr: "",
    binaryTestnetAddress: "xet:ym3qntl80esaae92u6ac4dk0nq2lle8scy03f8xknud9at29w3csqth4wpx",
  },
  {
    case: "mixed_case_25",
    seed: "ETCHED gypsy PLYWOOD guarded BEHIND gels MIGHTY mayor SULKING pedantic DOGS asked BADGE having EMIT sniff GODFATHER offend WONDERS biology NIECE railway SEGMENTS sieve BEHIND",
    binaryAccepted: true,
    binaryStderr: "",
    binaryTestnetAddress: "xet:ym3qntl80esaae92u6ac4dk0nq2lle8scy03f8xknud9at29w3csqth4wpx",
  },
  {
    case: "zero_key_25",
    seed: "abbey abbey abbey abbey abbey abbey abbey abbey abbey abbey abbey abbey abbey abbey abbey abbey abbey abbey abbey abbey abbey abbey abbey abbey abbey",
    binaryAccepted: false,
    binaryStderr: "Error: Invalid key from bytes",
    binaryTestnetAddress: null,
  },
  {
    case: "non_canonical_ff_key_25",
    seed: "foamy solved soggy foamy solved soggy foamy solved soggy foamy solved soggy foamy solved soggy foamy solved soggy foamy solved soggy foamy solved soggy soggy",
    binaryAccepted: false,
    binaryStderr: "Error: Invalid key from bytes",
    binaryTestnetAddress: null,
  },
  {
    case: "u32_overflow_triple_24",
    seed: "zoom zones zombie guarded behind gels mighty mayor sulking pedantic dogs asked badge having emit sniff godfather offend wonders biology niece railway segments sieve",
    binaryAccepted: true,
    binaryStderr: "",
    binaryTestnetAddress: "xet:wpgfewrwtc80ulng9c8fsc2jwqe0wk08tkc8k0dhwnex0yzttfnqqs7feav",
  },
];
