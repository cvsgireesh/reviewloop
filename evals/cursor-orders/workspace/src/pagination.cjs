async function fetchAll(fetchPage, limit = 100) {
  let cursor; const items = [];
  while (true) {
    const page = await fetchPage({ cursor, limit });
    items.push(...page.items);
    if (page.items.length < limit) return items;
    cursor = page.nextCursor;
  }
}
module.exports = { fetchAll };
