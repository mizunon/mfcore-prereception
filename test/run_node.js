// Node での検査: node test/run_node.js  (失敗が 1 件でもあれば終了コード 1)
'use strict';
const path = require('path');
const Codec = require(path.join(__dirname, '..', 'codec.js'));
const Store = require(path.join(__dirname, '..', 'store.js'));
const Tests = require(path.join(__dirname, 'tests.js'));
const qrcode = require(path.join(__dirname, '..', 'vendor', 'qrcode.js'));

const result = Tests.run(Codec, Store);
let pass = result.pass;
const failures = result.failures.slice();
function check(cond, what) { if (cond) pass++; else failures.push(what); }

// QR の大きさ (同梱の qrcode-generator、英数字モード)。app.js の makeQr と同じ選び方: 誤り訂正 M で 57 マス以内なら M、超えたら L
function makeQr(text) {
  let last = null;
  for (const level of ['M', 'L']) {
    try {
      const qr = qrcode(0, level);
      qr.addData(text, 'Alphanumeric');
      qr.make();
      last = { qr, level };
      if (level === 'M' && qr.getModuleCount() > 57) continue;
      return last;
    } catch (e) { /* 入り切らない → 次の水準 */ }
  }
  return last;
}
const nine = [];
for (let n = 0; n < 9; n++) nine.push({ user_code: 'RCDR-26-N0000' + n, username: 'user' + n, issued_at: 1793336730 + n, sig: '8f1b9c4e2a7d3f6b5c8e1a9d2f4b6c8e' });
const sizes = [];
for (const [label, members, max] of [
  ['1 人', nine.slice(0, 1), 4],
  ['4 人 (英数字の名前)', nine.slice(0, 4), 4],
  ['4 人 (日本語 / 絵文字の名前を含む)', Tests.MEMBERS.slice(0, 4), 4],
  ['6 人を 1 枚', nine.slice(0, 6), 8],
  ['8 人を 1 枚', nine.slice(0, 8), 8],
]) {
  const text = Codec.encodeGroup(members, max)[0];
  const made = makeQr(text);
  check(made !== null, label + ' を QR にできる');
  if (made) sizes.push(`${label}: ${text.length} 文字 → ${made.qr.getModuleCount()} マス角 (誤り訂正 ${made.level})`);
}
const typical = makeQr(Codec.encodeGroup(nine.slice(0, 4), 4)[0]);
check(typical && typical.qr.getModuleCount() <= 57, '英数字の名前 4 人は 57 マス角以内');

console.log(sizes.join('\n'));
console.log(`pass=${pass} fail=${failures.length}`);
for (const f of failures) console.log('  FAIL ' + f);
process.exit(failures.length === 0 ? 0 : 1);
