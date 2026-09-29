const secretKeys = new Set(['password', 'token', 'authorization']);
function redactSecrets(value) {
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, secretKeys.has(key) ? '[REDACTED]' : item]));
}
module.exports = { redactSecrets };
