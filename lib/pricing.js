// Token cost estimation for DeepSeek models.
// Default prices: deepseek-flash (DeepSeek-V4.1-Flash), USD per 1M tokens at PEAK rates.
// Off-peak rates are 50% of peak. Peak = 01:00–04:00 and 06:00–10:00 UTC, Monday–Friday.
// (Source: api-docs.deepseek.com/quick_start/pricing, Sept 2026. Editable in Settings.)

export const PRICE_DEFAULTS = { priceHit: 0.006, priceMiss: 0.3, priceOut: 1.2, offPeak: true };

export function isPeak(date = new Date()) {
  const day = date.getUTCDay();
  if (day === 0 || day === 6) return false;
  const h = date.getUTCHours();
  return (h >= 1 && h < 4) || (h >= 6 && h < 10);
}

export function normalizeUsage(u) {
  if (!u) return { hit: 0, miss: 0, out: 0 };
  const prompt = u.prompt_tokens || 0;
  const hit = u.prompt_cache_hit_tokens ?? u.prompt_tokens_details?.cached_tokens ?? 0;
  const miss = u.prompt_cache_miss_tokens ?? Math.max(0, prompt - hit);
  return { hit, miss, out: u.completion_tokens || 0 };
}

export function costOf(usage, settings, date = new Date()) {
  const { hit, miss, out } = normalizeUsage(usage);
  const mult = settings.offPeak && !isPeak(date) ? 0.5 : 1;
  const cost = ((hit * settings.priceHit) + (miss * settings.priceMiss) + (out * settings.priceOut)) / 1e6 * mult;
  return { hit, miss, out, cost };
}

export function addUsage(total, part) {
  return {
    hit: (total?.hit || 0) + part.hit,
    miss: (total?.miss || 0) + part.miss,
    out: (total?.out || 0) + part.out,
    cost: (total?.cost || 0) + part.cost,
    calls: (total?.calls || 0) + 1,
  };
}

export const fmtTokens = n => n >= 1e6 ? (n / 1e6).toFixed(2) + 'M' : n >= 1e3 ? (n / 1e3).toFixed(1) + 'k' : String(n || 0);
export const fmtCost = c => !c ? '$0.00' : c < 0.01 ? '$' + c.toFixed(4) : '$' + c.toFixed(3);
