function parseRetryAfter(value, nowMs = Date.now()) {
  if (typeof value !== 'string') return undefined;
  const seconds = parseInt(value, 10);
  if (seconds) return seconds * 1000;
  const date = Date.parse(value);
  return Number.isNaN(date) ? undefined : Math.max(0, date - nowMs);
}
module.exports = { parseRetryAfter };
