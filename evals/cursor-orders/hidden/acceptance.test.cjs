const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const workspace = process.env.REVIEWLOOP_WORKSPACE;
if (!workspace) throw new Error('REVIEWLOOP_WORKSPACE must identify the candidate workspace');
const { fetchAll } = require(path.join(workspace, 'src/pagination.cjs'));
const { listOrders } = require(path.join(workspace, 'src/orders.cjs'));
test('short and empty pages continue, zero IDs survive, first duplicate wins, input untouched', async () => {
  const rows = [Object.freeze({id:0,totalCents:125}),Object.freeze({id:1,totalCents:250}),Object.freeze({id:1,totalCents:999}),Object.freeze({id:2,totalCents:0})];
  const pages = [{items:rows.slice(0,2),nextCursor:'a'},{items:[],nextCursor:'b'},{items:rows.slice(2),nextCursor:null}]; const calls=[];
  const actual = await listOrders(async args => { calls.push(args); assert.ok(calls.length<=3,'pagination did not terminate'); return pages[calls.length-1]; },10);
  assert.deepEqual(calls,[{cursor:undefined,limit:10},{cursor:'a',limit:10},{cursor:'b',limit:10}]);
  assert.deepEqual(actual, [{id:0,totalCents:125,total:1.25},{id:1,totalCents:250,total:2.5},{id:2,totalCents:0,total:0}]);
  assert.equal('total' in rows[0],false);
});
test('repeated cursors reject before a repeated request', async () => {
  let calls=0;
  await assert.rejects(fetchAll(async()=>{ if(++calls>2) throw new Error('too many requests'); return {items:[1],nextCursor:'again'}; },1), /cursor/i);
  assert.equal(calls,2);
});
