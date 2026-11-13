/*
 * codec.js / store.js の検査 (ブラウザの test.html と Node の run_node.js の両方から呼ぶ)。
 * 固定ベクタは読み取る側 (Host) のテストと同じ値。片方だけ変えないこと。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.PreReceptionTests = factory();
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var MEMBERS = [
    { user_code: 'RCDR-26-A7K2N5', username: 'yamada', issued_at: 1793336730, sig: '8f1b9c4e2a7d3f6b5c8e1a9d2f4b6c8e' },
    { user_code: 'RCDR-26-B3M8Q1', username: '山田 太郎', issued_at: 1793336731, sig: '00112233445566778899aabbccddeeff' },
    { user_code: 'RCDR-26-C9X4T7', username: 'sato', issued_at: 0, sig: 'ffeeddccbbaa99887766554433221100' },
    { user_code: 'RCDR-26-D2H6W3', username: 'Élodie \u{1F3AE}', issued_at: 1793336733, sig: '0123456789abcdef0123456789abcdef' },
    { user_code: 'RCDR-26-E5P1Z8', username: '', issued_at: 1793336734, sig: 'a0b1c2d3e4f5a6b7c8d9e0f1a2b3c4d5' }
  ];
  var VECTOR_1 = 'MFPR1AF4H2AABAEHFEQ2EKIWTENRNIE3UWMSOGUDHSYLNMFSGC2XEEWNI6G44JYVH2P3LLSHBVHJPJNWI467Y';
  var VECTOR_4 = 'MFPR1AGSXSAABAQHFEQ2EKIWTENRNIE3UWMSOGUDHSYLNMFSGC2XEEWNI6G44JYVH2P3LLSHBVHJPJNWI4DSSINCFELJSGYWUEM2NHBITCDPFWGY6PFFQEDS2JKXJQOHGVZBFTMABCIRTIRKWM54ITGVLXTG5537Q4USDIRJC2MRWFVBTSWBUKQ3QI43BORXQAAAAAD765XOMXOVJTCDXMZKUIMZCCEAA4USDIRJC2MRWFVCDESBWK4ZQZQ4JNRXWI2LFEDYJ7DVONLSCLHIBENCWPCNLZXXQCI2FM6E2XTPPVWDQ';
  var VECTOR_5A = 'MFPR1AENHEAACAMHFEQ2EKIWTENRNIE3UWMSOGUDHSYLNMFSGC2XEEWNI6G44JYVH2P3LLSHBVHJPJNWI4DSSINCFELJSGYWUEM2NHBITCDPFWGY6PFFQEDS2JKXJQOHGVZBFTMABCIRTIRKWM54ITGVLXTG5537Q4USDIRJC2MRWFVBTSWBUKQ3QI43BORXQAAAAAD765XOMXOVJTCDXMZKUIMZCCEAA34Y';
  var VECTOR_5B = 'MFPR1AENHEAICAIHFEQ2EKIWTENRNIQZEQNSXGMGMHCLMN5SGSZJA6CPY5LTK4QSZ2AJDIVTYTK6N54ASGRLHRGV433YOKJBUIURNGI3C2RJVKAYVUOAANLSCLHVAWHBNHZHVU234RWPA6GRLHRGVE6KQ';

  function fakeStorage() {
    var map = {};
    return {
      map: map,
      failWrites: false,
      getItem: function (k) { return Object.prototype.hasOwnProperty.call(map, k) ? map[k] : null; },
      setItem: function (k, v) { if (this.failWrites) throw new Error('QuotaExceededError'); map[k] = String(v); }
    };
  }

  /** @returns {{pass:number, failures:string[]}} */
  function run(Codec, Store) {
    var pass = 0;
    var failures = [];
    function check(cond, what) { if (cond) pass++; else failures.push(what); }
    function eq(expected, actual, what) {
      if (expected === actual) pass++;
      else failures.push(what + ': expected <' + expected + '> actual <' + actual + '>');
    }
    function throws(fn) { try { fn(); return false; } catch (e) { return true; } }

    // ── CRC / Base32 ──
    var enc = new TextEncoder();
    eq(0x29B1, Codec.crc16(enc.encode('123456789'), 0, 9), 'CRC-16/CCITT-FALSE の検査値');
    eq('MZXW6YTBOI', Codec.base32Encode(enc.encode('foobar')), 'Base32 (RFC 4648 の例、パディングなし)');
    eq('foobar', new TextDecoder().decode(Codec.base32Decode('mzxw6ytboi')), 'Base32 の復号 (小文字)');
    check(Codec.base32Decode('MFPR1') === null, "接頭辞の '1' は Base32 の字母に無い");

    // ── 固定ベクタ (Host のテストと同じ値) ──
    eq(VECTOR_1, Codec.encodeGroup(MEMBERS.slice(0, 1), 4)[0], '固定ベクタ: 1 人');
    var four = Codec.encodeGroup(MEMBERS.slice(0, 4), 4);
    eq(1, four.length, '4 人 / 最大 4 は 1 枚');
    eq(VECTOR_4, four[0], '固定ベクタ: 4 人');
    var five = Codec.encodeGroup(MEMBERS, 4);
    eq(2, five.length, '5 人 / 最大 4 は 2 枚');
    eq(VECTOR_5A, five[0], '固定ベクタ: 5 人の 1 枚目');
    eq(VECTOR_5B, five[1], '固定ベクタ: 5 人の 2 枚目');
    check(/^[A-Z0-9]+$/.test(four[0]), '英数字だけ (QR の英数字モード)');

    // ── 復号 (往復) ──
    var d4 = Codec.decodeBatch(four[0]);
    check(d4.ok, '4 人を復号できる');
    if (d4.ok) {
      eq(4, d4.batch.members.length, '4 人');
      eq(Codec.computeGroupId(MEMBERS.slice(0, 4)), d4.batch.groupId, 'グループ ID');
      for (var i = 0; i < 4; i++) {
        eq(MEMBERS[i].user_code, d4.batch.members[i].user_code, 'user_code[' + i + ']');
        eq(MEMBERS[i].username, d4.batch.members[i].username, 'username[' + i + ']');
        eq(MEMBERS[i].issued_at, d4.batch.members[i].issued_at, 'issued_at[' + i + ']');
        eq(MEMBERS[i].sig, d4.batch.members[i].sig, 'sig[' + i + ']');
      }
    }
    var p0 = Codec.decodeBatch(five[0]), p1 = Codec.decodeBatch(five[1]);
    check(p0.ok && p1.ok, '5 人の 2 枚を復号できる');
    if (p0.ok && p1.ok) {
      eq(3, p0.batch.members.length, '1 枚目は 3 人');
      eq(2, p1.batch.members.length, '2 枚目は 2 人');
      eq(p0.batch.groupId, p1.batch.groupId, 'グループ ID は同じ');
      eq(2, p1.batch.partTotal, '総数 2');
      eq(1, p1.batch.partIndex, '2 枚目の番号');
    }
    check(!Codec.decodeBatch(four[0].slice(0, 20) + (four[0][20] === 'A' ? 'B' : 'A') + four[0].slice(21)).ok, '1 文字違いは CRC 不一致');
    check(!Codec.decodeBatch(four[0].slice(0, -8)).ok, '途中で切れた');

    // ── 分割 ──
    var nine = [];
    for (var n = 0; n < 9; n++) nine.push({ user_code: 'RCDR-26-N0000' + n, username: 'user' + n, issued_at: 1793336730 + n, sig: '8f1b9c4e2a7d3f6b5c8e1a9d2f4b6c8e' });
    eq(3, Codec.encodeGroup(nine, 4).length, '9 人 / 最大 4 は 3 枚');
    eq(2, Codec.encodeGroup(nine.slice(0, 8), 4).length, '8 人 / 最大 4 は 2 枚');
    eq(1, Codec.encodeGroup(nine.slice(0, 8), 8).length, '8 人 / 最大 8 は 1 枚');
    check(Codec.encodeGroup(nine.slice(0, 4), 4)[0].length <= 335, '英数字の名前 4 人は 335 文字以内 (QR 9 版)');
    check(throws(function () { Codec.encodeGroup([], 4); }), '空のグループは符号化できない');
    check(throws(function () { Codec.encodeGroup([{ user_code: 'U', username: 'n', issued_at: 0, sig: 'abc' }], 4); }), 'sig が 32 桁でない');
    check(throws(function () { Codec.encodeGroup([{ user_code: 'U', username: new Array(87).join('あ'), issued_at: 0, sig: MEMBERS[0].sig }], 4); }), 'username が 255 バイト超');

    // ── 会員 QR の解析 (JSON / Base64 / Base32) ──
    var json = '{"user_code":"RCDR-26-A7K2N5","username":"yamada","issued_at":1793336730,"sig":"8f1b9c4e2a7d3f6b5c8e1a9d2f4b6c8e"}';
    var r = Codec.parseMemberQr(json);
    check(r.ok && r.format === 'JSON', '会員 QR (JSON)');
    if (r.ok) {
      eq('RCDR-26-A7K2N5', r.member.user_code, 'user_code');
      eq('yamada', r.member.username, 'username');
      eq(1793336730, r.member.issued_at, 'issued_at');
      eq('8f1b9c4e2a7d3f6b5c8e1a9d2f4b6c8e', r.member.sig, 'sig');
    }
    var jsonJa = '{"user_code":"RCDR-26-B3M8Q1","username":"山田 太郎","sig":"00112233445566778899AABBCCDDEEFF"}';
    var bytesJa = enc.encode(jsonJa);
    var b32 = Codec.base32Encode(bytesJa);
    var r32 = Codec.parseMemberQr(b32);
    check(r32.ok && r32.format === 'Base32', '会員 QR (Base32、日本語名)');
    if (r32.ok) {
      eq('山田 太郎', r32.member.username, 'Base32 の日本語名');
      eq(0, r32.member.issued_at, 'issued_at 無しは 0');
      eq('00112233445566778899aabbccddeeff', r32.member.sig, 'sig は小文字にそろえる');
    }
    check(Codec.parseMemberQr(b32.toLowerCase()).ok, '会員 QR (Base32 小文字)');
    var bin = '';
    for (var bi = 0; bi < bytesJa.length; bi++) bin += String.fromCharCode(bytesJa[bi]);
    var b64 = typeof btoa === 'function' ? btoa(bin) : Buffer.from(bytesJa).toString('base64');
    var r64 = Codec.parseMemberQr(b64);
    check(r64.ok && r64.format === 'Base64', '会員 QR (Base64)');
    check(Codec.parseMemberQr(b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')).ok, '会員 QR (Base64URL、パディングなし)');
    check(Codec.parseMemberQr('  ' + json + '\n').ok, '前後の空白つき');

    eq('not_member', Codec.parseMemberQr('https://example.com/').reason, 'URL は会員 QR ではない');
    eq('not_member', Codec.parseMemberQr('{"foo":1}').reason, 'user_code の無い JSON');
    eq('not_member', Codec.parseMemberQr('{"user_code":"","username":"a","sig":"' + MEMBERS[0].sig + '"}').reason, 'user_code が空');
    eq('not_member', Codec.parseMemberQr('').reason, '空文字');
    eq('batch', Codec.parseMemberQr(VECTOR_4).reason, 'まとめ QR を読んだ');
    eq('bad_sig', Codec.parseMemberQr('{"user_code":"U-1","username":"a","sig":"xyz"}').reason, 'sig の形式が違う');
    eq('bad_sig', Codec.parseMemberQr('{"user_code":"U-1","username":"a"}').reason, 'sig が無い');
    eq('bad_issued_at', Codec.parseMemberQr('{"user_code":"U-1","username":"a","issued_at":1.5,"sig":"' + MEMBERS[0].sig + '"}').reason, 'issued_at が整数でない');
    eq('bad_issued_at', Codec.parseMemberQr('{"user_code":"U-1","username":"a","issued_at":4294967296,"sig":"' + MEMBERS[0].sig + '"}').reason, 'issued_at が大きすぎる');
    var noName = Codec.parseMemberQr('{"user_code":"U-1","sig":"' + MEMBERS[0].sig + '"}');
    check(noName.ok && noName.member.username === '', 'username が無ければ空文字');
    var zeroIssued = Codec.parseMemberQr('{"user_code":"U-1","username":"a","issued_at":0,"sig":"' + MEMBERS[0].sig + '"}');
    check(zeroIssued.ok && zeroIssued.member.issued_at === 0, 'issued_at 0 は無し扱い');
    eq('too_long', Codec.parseMemberQr('{"user_code":"U-1","username":"' + new Array(87).join('あ') + '","sig":"' + MEMBERS[0].sig + '"}').reason, '名前が 255 バイト超');

    // 解析 → まとめ QR → 復号で値が変わらない
    var viaParse = Codec.decodeBatch(Codec.encodeGroup([r.member, r32.member], 4)[0]);
    check(viaParse.ok && viaParse.batch.members[1].username === '山田 太郎' && viaParse.batch.members[0].issued_at === 1793336730, '解析した会員をまとめ QR に入れて復号');

    // ── 発行日 (端末のローカル日付) ──
    var now = new Date(2026, 10, 13, 15, 0, 0);
    function at(y, mo, d, h, mi, s) { return Math.floor(new Date(y, mo, d, h, mi, s).getTime() / 1000); }
    check(Codec.isIssuedOnLocalDate(at(2026, 10, 13, 0, 0, 0), now), '今日の 0:00:00');
    check(Codec.isIssuedOnLocalDate(at(2026, 10, 13, 23, 59, 59), now), '今日の 23:59:59');
    check(!Codec.isIssuedOnLocalDate(at(2026, 10, 12, 23, 59, 59), now), '前日の 23:59:59');
    check(!Codec.isIssuedOnLocalDate(at(2026, 10, 14, 0, 0, 0), now), '翌日の 0:00:00');
    check(!Codec.isIssuedOnLocalDate(at(2025, 10, 13, 15, 0, 0), now), '1 年前の同じ月日');
    check(!Codec.isIssuedOnLocalDate(0, now), 'issued_at 無し');

    // ── 保存 (ボタンで消すまで消えない) ──
    var t = 1000000;
    var storage = fakeStorage();
    var store = Store.createStore(storage, function () { return t++; });
    var s0 = store.getState();
    eq(1, s0.groups.length, '最初は空のグループが 1 つ');
    eq(s0.currentGroupId, store.getState().currentGroupId, '保存前でもグループの ID は変わらない');
    eq(4, s0.settings.maxPerPart, '既定は 1 枚 4 人');
    check(s0.settings.requireToday === true, '発行日の判定は既定 ON');

    var a1 = store.addMember(MEMBERS[0]);
    check(a1.ok && a1.result.status === 'added', '1 人目を追加');
    store.addMember(MEMBERS[1]);
    store.addMember(MEMBERS[2]);
    eq(3, store.getState().groups[0].members.length, '3 人');

    // リロード = 同じ localStorage から別のストアを作る
    var reloaded = Store.createStore(storage, function () { return t++; });
    eq(3, reloaded.getState().groups[0].members.length, 'リロードしても 3 人残る');
    eq('山田 太郎', reloaded.getState().groups[0].members[1].username, 'リロード後も名前はそのまま');
    eq(s0.currentGroupId, reloaded.getState().currentGroupId, 'リロード後も同じグループを選んでいる');

    eq('duplicate', store.addMember(MEMBERS[0]).result.status, '同じ QR は読取済み');
    eq(3, store.getState().groups[0].members.length, '読取済みでは増えない');
    var newer = { user_code: MEMBERS[0].user_code, username: 'yamada', issued_at: 1793336999, sig: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' };
    eq('updated', store.addMember(newer).result.status, '同じ会員の新しい QR は差し替え');
    eq(1793336999, store.getState().groups[0].members[0].issued_at, '差し替え後の issued_at');
    eq(3, store.getState().groups[0].members.length, '差し替えでは増えない');

    // 別のタブ (同じ localStorage の別のストア) で足した分も失わない
    var otherTab = Store.createStore(storage, function () { return t++; });
    otherTab.addMember(MEMBERS[3]);
    store.setMemo(s0.currentGroupId, '14:20 の回');
    var merged = store.getState().groups[0];
    eq(4, merged.members.length, '別のタブで足した会員が残る');
    eq('14:20 の回', merged.memo, 'メモ');

    // グループ
    var g2 = store.newGroup().result;
    eq(2, store.getState().groups.length, '新しいグループ');
    eq(g2.id, store.getState().currentGroupId, '新しいグループを選んでいる');
    eq(g2.id, store.newGroup().result.id, '空のグループがあれば増やさない');
    eq('other_group', store.addMember(MEMBERS[1]).result.status, '別のグループに読取済みの会員');
    eq(0, store.getState().groups[1].members.length, '別のグループの会員は足さない');
    check(store.addMember(MEMBERS[4]).result.status === 'added', '新しいグループに追加');
    store.markHanded(s0.currentGroupId);
    eq(4, store.getState().groups[0].members.length, 'Host に見せても会員は消えない');
    check(store.getState().groups[0].handedAt > 0, '見せた時刻が残る');

    // 時間が経っても消えない (自動削除なし)
    t += 1000 * 60 * 60 * 24 * 30;
    var later = Store.createStore(storage, function () { return t++; });
    eq(4, later.getState().groups[0].members.length, '30 日後に開いても残る');
    eq(1, later.getState().groups[1].members.length, '30 日後に開いても 2 つ目のグループも残る');

    // 設定の変更で会員は消えない
    store.setSetting('maxPerPart', 2);
    store.setSetting('requireToday', false);
    eq(2, store.getState().settings.maxPerPart, '設定: 1 枚 2 人');
    check(store.getState().settings.requireToday === false, '設定: 発行日の判定 OFF');
    eq(4, store.getState().groups[0].members.length, '設定を変えても会員は残る');
    store.setSetting('maxPerPart', 99);
    eq(8, store.getState().settings.maxPerPart, '設定: 上限 8');

    // 消えるのは消去の操作だけ
    check(store.removeMember(s0.currentGroupId, MEMBERS[2].user_code).result === true, '1 人を消す');
    eq(3, store.getState().groups[0].members.length, '1 人減った');
    check(store.deleteGroup(g2.id).result === true, 'グループを消す');
    eq(1, store.getState().groups.length, 'グループが 1 つに');
    eq(s0.currentGroupId, store.getState().currentGroupId, '残ったグループを選ぶ');
    store.clearAll();
    var cleared = store.getState();
    eq(1, cleared.groups.length, 'すべて消去の後は空のグループが 1 つ');
    eq(0, cleared.groups[0].members.length, 'すべて消去');
    eq(8, cleared.settings.maxPerPart, 'すべて消去でも設定 (1 枚の人数) は残る');
    check(cleared.settings.requireToday === false, 'すべて消去でも設定は残る');

    // 書けなかったら ok=false (黙って失わない)
    var st2 = fakeStorage();
    var store2 = Store.createStore(st2, function () { return t++; });
    store2.addMember(MEMBERS[0]);
    st2.failWrites = true;
    var failed = store2.addMember(MEMBERS[1]);
    check(failed.ok === false, '書けなければ ok=false');
    check(store2.status().saveError !== null, '失敗が status に出る');
    eq(1, store2.getState().groups[0].members.length, '書けなかった会員は一覧に出ない (保存されている内容だけを見せる)');
    st2.failWrites = false;
    check(store2.addMember(MEMBERS[1]).ok === true && store2.status().saveError === null, '書けるようになれば失敗表示は消える');

    // 壊れた保存データは上書きの前に退避する
    var st3 = fakeStorage();
    st3.map[Store.KEY] = '{"groups":[{"members":[{"user_code":"RCDR-26-A7K2N5"';
    var store3 = Store.createStore(st3, function () { return t++; });
    eq(0, store3.getState().groups[0].members.length, '壊れた保存データは空として開く');
    check(store3.status().loadWarning !== null, '退避したことを知らせる');
    var backupKeys = Object.keys(st3.map).filter(function (k) { return k.indexOf(Store.KEY + '.corrupt.') === 0; });
    eq(1, backupKeys.length, '退避キーが 1 つ');
    check(st3.map[backupKeys[0]].indexOf('RCDR-26-A7K2N5') >= 0, '退避した中身は元のまま');
    store3.addMember(MEMBERS[0]);
    eq(1, store3.getState().groups[0].members.length, '退避の後は普通に使える');
    eq(1, Object.keys(st3.map).filter(function (k) { return k.indexOf('.corrupt.') >= 0; }).length, '退避は 1 回だけ');

    // 退避できなければ上書きしない
    var st4 = fakeStorage();
    st4.map[Store.KEY] = 'not json';
    st4.failWrites = true;
    var store4 = Store.createStore(st4, function () { return t++; });
    store4.getState();
    check(store4.status().blocked !== null, '退避できなければ保存を止める');
    st4.failWrites = false;
    check(store4.addMember(MEMBERS[0]).ok === false, '止めている間は書かない');
    eq('not json', st4.map[Store.KEY], '元の保存データは上書きされていない');

    // 古い形 / 項目の欠けた保存データも会員を落とさず開く
    var st5 = fakeStorage();
    st5.map[Store.KEY] = JSON.stringify({ groups: [{ members: [{ user_code: 'RCDR-26-A7K2N5', username: 'yamada', issued_at: 5, sig: MEMBERS[0].sig }] }] });
    var store5 = Store.createStore(st5, function () { return t++; });
    var old = store5.getState();
    eq(1, old.groups[0].members.length, '項目の欠けた保存データの会員も残る');
    eq(old.groups[0].id, old.currentGroupId, '選択中のグループを補う');
    eq(4, old.settings.maxPerPart, '設定が無ければ既定値');

    return { pass: pass, failures: failures };
  }

  return { run: run, MEMBERS: MEMBERS, VECTOR_4: VECTOR_4, VECTOR_5A: VECTOR_5A, VECTOR_5B: VECTOR_5B };
}));
