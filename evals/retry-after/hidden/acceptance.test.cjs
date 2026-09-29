const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const workspace = process.env.REVIEWLOOP_WORKSPACE;
if (!workspace) throw new Error('REVIEWLOOP_WORKSPACE must identify the candidate workspace');
const { parseRetryAfter } = require(path.join(workspace, 'src/retry-after.cjs'));
test('zero, whitespace, and invalid numeric forms', () => {
  for (const [input, expected] of [['0',0],[' 15 ',15000],['001',1000],['1.5',undefined],['-1',undefined],['+2',undefined],['1e3',undefined],['',undefined],['  ',undefined],['9007199254740991',undefined],[null,undefined],[15,undefined]]) assert.equal(parseRetryAfter(input, 0), expected, String(input));
});
test('HTTP dates clamp and round correctly', () => {
  const date = 'Wed, 21 Oct 2015 07:28:00 GMT'; const at = Date.parse(date);
  assert.equal(parseRetryAfter(date, at-2000), 2000);
  assert.equal(parseRetryAfter(date, at-0.5), 1);
  assert.equal(parseRetryAfter(date, at+2000), 0);
  assert.equal(parseRetryAfter('not a date', at), undefined);
});
