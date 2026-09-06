const MONERO_GENESIS = 1397818593;
const MONERO_BLOCK_SEC = 120;
const ZEPHYR_GENESIS = 1685664000;
const ZEPHYR_BLOCK_SEC = 120;
const SAFETY_MARGIN_SEC = 30 * 86400;

function parseDate(dateStr: string): number | null {
  const t = Date.parse(dateStr + "T00:00:00Z");
  return Number.isFinite(t) ? Math.floor(t / 1000) : null;
}

export function dateStringToMoneroHeight(dateStr: string): number {
  if (!dateStr) return 0;
  const unix = parseDate(dateStr);
  if (unix === null) return 0;
  const biased = unix - SAFETY_MARGIN_SEC;
  return Math.max(0, Math.floor((biased - MONERO_GENESIS) / MONERO_BLOCK_SEC));
}

export function dateStringToZephyrHeight(dateStr: string): number {
  if (!dateStr) return 0;
  const unix = parseDate(dateStr);
  if (unix === null) return 0;
  const biased = unix - SAFETY_MARGIN_SEC;
  return Math.max(0, Math.floor((biased - ZEPHYR_GENESIS) / ZEPHYR_BLOCK_SEC));
}
