const { fetchAll } = require('./pagination.cjs');
async function listOrders(fetchPage, limit = 100) {
  const rows = await fetchAll(fetchPage, limit);
  return rows.filter(row => row.id).map(row => {
    row.total = row.totalCents;
    return row;
  });
}
module.exports = { listOrders };
