const secretKeys = new Set(['password', 'token', 'authorization']);
function redactSecrets(value) {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(redactSecrets);
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, secretKeys.has(key.toLowerCase()) ? '[REDACTED]' : redactSecrets(item)]));
}
module.exports = { redactSecrets };
