async function fetchAll(fetchPage, limit = 100) {
  let cursor; const items = []; const seen = new Set();
  while (true) {
    const page = await fetchPage({ cursor, limit });
    items.push(...page.items);
    const next = page.nextCursor;
    if (next === null || next === undefined || next === '') return items;
    if (seen.has(next)) throw new Error('Repeated pagination cursor');
    seen.add(next); cursor = next;
  }
}
module.exports = { fetchAll };
