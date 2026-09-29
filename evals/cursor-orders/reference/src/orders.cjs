const { fetchAll } = require('./pagination.cjs');
async function listOrders(fetchPage, limit = 100) {
  const rows = await fetchAll(fetchPage, limit); const seen = new Set(); const result = [];
  for (const row of rows) {
    if (seen.has(row.id)) continue;
    seen.add(row.id); result.push({ ...row, total: row.totalCents / 100 });
  }
  return result;
}
module.exports = { listOrders };
