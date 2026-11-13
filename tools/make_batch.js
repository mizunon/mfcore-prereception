/*
 * 会員 QR の中身 (JSON / Base64 / Base32) から、まとめ QR の文字列を作る (Host 側の検査用。スマホもカメラも要らない)。
 * 出てきた "MFPR1…" の行を、Host の受付パネルの「QR リーダー入力」欄に貼ると、まとめ QR を読んだのと同じ動きになる。
 *
 *   node tools/make_batch.js [--max 4] <会員 QR の中身を 1 行ずつ書いたファイル>
 *   node tools/make_batch.js [--max 4] "<会員 QR の中身>" "<会員 QR の中身>" ...
 *
 * 引数がファイルならその各行、そうでなければ引数そのものを会員 QR の中身として読む。
 */
'use strict';
const fs = require('fs');
const path = require('path');
const Codec = require(path.join(__dirname, '..', 'codec.js'));

let max = 4;
const inputs = [];
const args = process.argv.slice(2);
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--max') { max = parseInt(args[++i], 10); continue; }
  if (fs.existsSync(args[i]) && fs.statSync(args[i]).isFile()) {
    for (const line of fs.readFileSync(args[i], 'utf8').split(/\r?\n/)) if (line.trim()) inputs.push(line.trim());
  } else {
    inputs.push(args[i]);
  }
}
if (inputs.length === 0) {
  console.error('使い方: node tools/make_batch.js [--max 4] <ファイル | 会員 QR の中身 ...>');
  process.exit(2);
}

const members = [];
for (const text of inputs) {
  const r = Codec.parseMemberQr(text);
  if (!r.ok) {
    console.error(`会員 QR として読めません (${r.reason}): ${text.slice(0, 60)}`);
    process.exit(1);
  }
  members.push(r.member);
}

const parts = Codec.encodeGroup(members, max);
console.error(`${members.length} 名 → ${parts.length} 枚 (グループ ID ${Codec.computeGroupId(members).toString(16).toUpperCase().padStart(4, '0')})`);
for (const p of parts) console.log(p);
