function parseRetryAfter(value, nowMs = Date.now()) {
  if (typeof value !== 'string') return undefined;
  const input = value.trim();
  if (/^\d+$/.test(input)) {
    const delay = Number(input) * 1000;
    return Number.isSafeInteger(delay) ? delay : undefined;
  }
  if (!/^(Mon|Tue|Wed|Thu|Fri|Sat|Sun), \d{2} (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) \d{4} \d{2}:\d{2}:\d{2} GMT$/.test(input) || !Number.isFinite(nowMs)) return undefined;
  const date = Date.parse(input);
  const delay = Math.max(0, Math.ceil(date - nowMs));
  return Number.isSafeInteger(delay) ? delay : undefined;
}
module.exports = { parseRetryAfter };
