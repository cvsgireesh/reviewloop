const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const workspace = process.env.REVIEWLOOP_WORKSPACE;
if (!workspace) throw new Error('REVIEWLOOP_WORKSPACE must identify the candidate workspace');
const fs = require('node:fs'); const source = fs.readFileSync(path.join(workspace,'src/event-catalog.cjs'),'utf8');
const { lookupEvent } = require(path.join(workspace, 'src/event-catalog.cjs'));
test('valid integer IDs include numeric zero and catalog boundary', () => {
  for(const id of [0,1,699,'0','1','699']) assert.match(lookupEvent(id),new RegExp('Event '+String(id).padStart(4,'0')+':'));
  assert.equal(lookupEvent(700),undefined);
});
test('noncanonical inputs never alias valid event IDs', () => {
  for(const id of ['01','1.5','1e2','+1','-1',' 1','1 ',true,false,null,{},1.2,-1,NaN,Infinity,9007199254740992]) assert.equal(lookupEvent(id),undefined,String(id));
});
test('all generated descriptions remain intact', () => {
  for(let i=0;i<700;i++) assert.equal(lookupEvent(i),`Event ${String(i).padStart(4,'0')}: service lifecycle telemetry record; retained for backward-compatible audit display.`);
});
