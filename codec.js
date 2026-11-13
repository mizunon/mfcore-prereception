/*
 * 事前受付: 会員 QR の解析と「まとめ QR」の符号化 (ブラウザ / Node 共用、依存なし)。
 *
 * まとめ QR の文字列 = "MFPR1" + Base32 (RFC 4648、A-Z2-7、パディングなし)。Base32 の中身:
 *   [0]     形式の版 (1)
 *   [1..2]  グループ ID (u16 BE。グループ全体の会員レコード列の CRC16 = 全ての分割で同じ値)
 *   [3]     分割の番号 (0 始まり)
 *   [4]     分割の総数 (1..15)
 *   [5]     この QR の人数 (1..16)
 *   人数分  len(1) + user_code(UTF-8) / len(1) + username(UTF-8) / issued_at(u32 BE、0 = 無し) / sig(16 B)
 *   末尾 2  CRC-16/CCITT-FALSE (ここまでの全バイト、BE)
 *
 * 読み取る側 (Host) の実装と同じ規則・同じ固定ベクタで検査している (test/tests.js)。片方だけ変えないこと。
 * このページは署名の鍵を持たない。会員 QR の署名は Host が検証する (ここでは形式だけ見る)。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.PreReceptionCodec = factory();
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var PREFIX = 'MFPR1';
  var FORMAT_VERSION = 1;
  var MAX_PARTS = 15;
  var MAX_MEMBERS_PER_PART = 16;
  var SIG_BYTES = 16;
  var HEADER_BYTES = 6;
  var B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

  var encoder = new TextEncoder();
  var looseDecoder = new TextDecoder('utf-8');
  var strictDecoder = new TextDecoder('utf-8', { fatal: true });

  function utf8(s) { return encoder.encode(s); }

  // ── Base32 / Base64 ──

  function base32Encode(bytes) {
    var out = '';
    var value = 0;
    var bits = 0;
    for (var i = 0; i < bytes.length; i++) {
      value = ((value << 8) | bytes[i]) & 0xFFFF;
      bits += 8;
      while (bits >= 5) {
        bits -= 5;
        out += B32[(value >> bits) & 31];
      }
    }
    if (bits > 0) out += B32[(value << (5 - bits)) & 31];
    return out;
  }

  /** 大文字小文字を問わず、'=' は無視。字母に無い文字があれば null。 */
  function base32Decode(s) {
    var bytes = [];
    var value = 0;
    var bits = 0;
    for (var i = 0; i < s.length; i++) {
      var c = s.charCodeAt(i);
      if (c === 61) continue;                       // '='
      if (c >= 97 && c <= 122) c -= 32;             // a-z → A-Z
      var v;
      if (c >= 65 && c <= 90) v = c - 65;           // A-Z
      else if (c >= 50 && c <= 55) v = c - 50 + 26; // 2-7
      else return null;
      value = ((value << 5) | v) & 0xFFFF;
      bits += 5;
      if (bits >= 8) {
        bits -= 8;
        bytes.push((value >> bits) & 0xFF);
      }
    }
    return new Uint8Array(bytes);
  }

  /** 標準 Base64 / Base64URL、パディング有無を受理。字母に無い文字・あり得ない長さは null。 */
  function base64Decode(s) {
    var vals = [];
    for (var i = 0; i < s.length; i++) {
      var c = s.charCodeAt(i);
      var v;
      if (c === 61) continue;                        // '='
      if (c >= 65 && c <= 90) v = c - 65;            // A-Z
      else if (c >= 97 && c <= 122) v = c - 97 + 26; // a-z
      else if (c >= 48 && c <= 57) v = c - 48 + 52;  // 0-9
      else if (c === 43 || c === 45) v = 62;         // + -
      else if (c === 47 || c === 95) v = 63;         // / _
      else return null;
      vals.push(v);
    }
    if (vals.length % 4 === 1) return null;
    var bytes = [];
    for (var j = 0; j + 1 < vals.length; j += 4) {
      var a = vals[j], b = vals[j + 1], c2 = vals[j + 2], d = vals[j + 3];
      bytes.push(((a << 2) | (b >> 4)) & 0xFF);
      if (c2 !== undefined) bytes.push(((b << 4) | (c2 >> 2)) & 0xFF);
      if (d !== undefined) bytes.push(((c2 << 6) | d) & 0xFF);
    }
    return new Uint8Array(bytes);
  }

  /** CRC-16/CCITT-FALSE (poly 0x1021、初期値 0xFFFF、反転なし)。"123456789" → 0x29B1。 */
  function crc16(bytes, offset, count) {
    var crc = 0xFFFF;
    for (var i = offset; i < offset + count; i++) {
      crc ^= bytes[i] << 8;
      for (var b = 0; b < 8; b++) crc = (crc & 0x8000) ? ((crc << 1) ^ 0x1021) & 0xFFFF : (crc << 1) & 0xFFFF;
    }
    return crc;
  }

  // ── 会員 QR の解析 (Host の MemberAuth.TryParse と同じ 3 形式: JSON / Base64 / Base32) ──

  function tryParseJson(text) {
    if (text.charAt(0) !== '{' || text.charAt(text.length - 1) !== '}') return null;
    var obj;
    try { obj = JSON.parse(text); } catch (e) { return null; }
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return null;
    if (typeof obj.user_code !== 'string' || obj.user_code.length === 0) return null;
    return obj;
  }

  function decodeToJson(text) {
    var trimmed = text.trim();
    if (trimmed.charAt(0) === '{') {
      var direct = tryParseJson(trimmed);
      return direct ? { obj: direct, format: 'JSON' } : null;
    }
    if (trimmed.length >= 8) {
      var b64 = base64Decode(trimmed);
      if (b64) {
        var o1 = tryParseJson(looseDecoder.decode(b64).trim());
        if (o1) return { obj: o1, format: 'Base64' };
      }
      var b32 = base32Decode(trimmed);
      if (b32 && b32.length > 0) {
        var o2 = tryParseJson(looseDecoder.decode(b32).trim());
        if (o2) return { obj: o2, format: 'Base32' };
      }
    }
    return null;
  }

  function isBatchText(text) {
    if (typeof text !== 'string') return false;
    var t = text.trim();
    return t.length > PREFIX.length && t.slice(0, PREFIX.length).toUpperCase() === PREFIX;
  }

  /**
   * 読み取った文字列を会員 QR として解析する。
   * 成功: { ok: true, member: { user_code, username, issued_at, sig }, format }
   * 失敗: { ok: false, reason }  reason = 'batch' (まとめ QR) / 'not_member' / 'bad_sig' / 'bad_issued_at' / 'too_long'
   */
  function parseMemberQr(text) {
    if (typeof text !== 'string' || text.length === 0) return { ok: false, reason: 'not_member' };
    if (isBatchText(text)) return { ok: false, reason: 'batch' };
    var decoded = decodeToJson(text);
    if (!decoded) return { ok: false, reason: 'not_member' };
    var o = decoded.obj;

    var username = '';
    if (typeof o.username === 'string') username = o.username;
    else if (o.username !== undefined && o.username !== null) return { ok: false, reason: 'not_member' };

    // issued_at: 正の整数だけが「あり」。無い / 0 以下 / 数値でないものは「無し」(Host と同じ扱い)
    var issuedAt = 0;
    if (typeof o.issued_at === 'number') {
      if (!Number.isFinite(o.issued_at) || Math.floor(o.issued_at) !== o.issued_at || o.issued_at > 0xFFFFFFFF) return { ok: false, reason: 'bad_issued_at' };
      if (o.issued_at > 0) issuedAt = o.issued_at;
    }

    var sig = typeof o.sig === 'string' ? o.sig.trim().toLowerCase() : '';
    if (!/^[0-9a-f]{32}$/.test(sig)) return { ok: false, reason: 'bad_sig' };

    var member = { user_code: o.user_code, username: username, issued_at: issuedAt, sig: sig };
    if (memberError(member)) return { ok: false, reason: 'too_long' };
    return { ok: true, member: member, format: decoded.format };
  }

  /** まとめ QR に入れられない会員なら理由 (文字列)、入れられるなら null。名前は署名対象なので切り詰めない。 */
  function memberError(m) {
    if (!m || typeof m.user_code !== 'string' || typeof m.username !== 'string') return '会員の形式が不正';
    var uc = utf8(m.user_code).length;
    if (uc < 1 || uc > 255) return 'user_code は 1〜255 バイト';
    if (utf8(m.username).length > 255) return 'username は 255 バイトまで';
    if (typeof m.issued_at !== 'number' || m.issued_at < 0 || m.issued_at > 0xFFFFFFFF || Math.floor(m.issued_at) !== m.issued_at) return 'issued_at は 0〜4294967295';
    if (typeof m.sig !== 'string' || !/^[0-9a-fA-F]{32}$/.test(m.sig)) return 'sig は 32 桁の 16 進';
    return null;
  }

  // ── まとめ QR ──

  function appendMemberRecord(out, m) {
    var err = memberError(m);
    if (err) throw new Error(err);
    var uc = utf8(m.user_code);
    var un = utf8(m.username);
    var i;
    out.push(uc.length);
    for (i = 0; i < uc.length; i++) out.push(uc[i]);
    out.push(un.length);
    for (i = 0; i < un.length; i++) out.push(un[i]);
    out.push(Math.floor(m.issued_at / 0x1000000) & 0xFF, (m.issued_at >>> 16) & 0xFF, (m.issued_at >>> 8) & 0xFF, m.issued_at & 0xFF);
    for (i = 0; i < SIG_BYTES; i++) out.push(parseInt(m.sig.substr(i * 2, 2), 16));
  }

  /** グループ ID = グループ全体 (全ての分割) の会員レコード列の CRC16。 */
  function computeGroupId(members) {
    var bytes = [];
    for (var i = 0; i < members.length; i++) appendMemberRecord(bytes, members[i]);
    return crc16(bytes, 0, bytes.length);
  }

  function encodePart(members, groupId, partIndex, partTotal) {
    if (!members || members.length < 1 || members.length > MAX_MEMBERS_PER_PART) throw new Error('人数は 1〜' + MAX_MEMBERS_PER_PART + ' 人');
    if (partTotal < 1 || partTotal > MAX_PARTS || partIndex < 0 || partIndex >= partTotal) throw new Error('分割の番号が不正');
    var bytes = [FORMAT_VERSION, (groupId >> 8) & 0xFF, groupId & 0xFF, partIndex, partTotal, members.length];
    for (var i = 0; i < members.length; i++) appendMemberRecord(bytes, members[i]);
    var crc = crc16(bytes, 0, bytes.length);
    bytes.push((crc >> 8) & 0xFF, crc & 0xFF);
    return PREFIX + base32Encode(bytes);
  }

  /**
   * グループ全体を QR の文字列の列にする。maxPerPart 人を超えたら分割し、人数は枚数で均等に割る
   * (5 人 / 最大 4 → 3 + 2。1 枚あたりのマス目を小さく保つ)。
   */
  function encodeGroup(members, maxPerPart) {
    if (!members || members.length === 0) throw new Error('会員がいません');
    var max = Math.max(1, Math.min(MAX_MEMBERS_PER_PART, Math.floor(maxPerPart) || 1));
    var parts = Math.ceil(members.length / max);
    if (parts > MAX_PARTS) throw new Error('会員が多すぎます (最大 ' + (MAX_PARTS * max) + ' 人)');
    var groupId = computeGroupId(members);
    var perPart = Math.ceil(members.length / parts);
    var result = [];
    for (var p = 0; p < parts; p++) result.push(encodePart(members.slice(p * perPart, (p + 1) * perPart), groupId, p, parts));
    return result;
  }

  /** まとめ QR を復号する (検査用。本番で復号するのは Host)。{ ok, batch } / { ok: false, error }。 */
  function decodeBatch(text) {
    if (!isBatchText(text)) return { ok: false, error: 'まとめ QR ではありません' };
    var data = base32Decode(text.trim().slice(PREFIX.length));
    if (!data) return { ok: false, error: '文字が欠けています' };
    if (data.length < HEADER_BYTES + 2) return { ok: false, error: '短すぎます' };
    var crcPos = data.length - 2;
    if (crc16(data, 0, crcPos) !== ((data[crcPos] << 8) | data[crcPos + 1])) return { ok: false, error: '読み取りが欠けています (CRC 不一致)' };
    if (data[0] !== FORMAT_VERSION) return { ok: false, error: '新しい版のまとめ QR です (版 ' + data[0] + ')' };
    var partIndex = data[3], partTotal = data[4], count = data[5];
    if (partTotal < 1 || partTotal > MAX_PARTS || partIndex >= partTotal) return { ok: false, error: '分割の番号が不正です' };
    if (count < 1 || count > MAX_MEMBERS_PER_PART) return { ok: false, error: '人数が不正です' };

    var members = [];
    var pos = HEADER_BYTES;
    function readString() {
      if (pos >= crcPos) return null;
      var len = data[pos];
      if (pos + 1 + len > crcPos) return null;
      var s;
      try { s = strictDecoder.decode(data.subarray(pos + 1, pos + 1 + len)); } catch (e) { return null; }
      pos += 1 + len;
      return s;
    }
    for (var i = 0; i < count; i++) {
      var userCode = readString();
      var username = userCode === null ? null : readString();
      if (userCode === null || username === null || pos + 4 + SIG_BYTES > crcPos) return { ok: false, error: '中身の長さが合いません' };
      if (userCode.length === 0) return { ok: false, error: '会員コードが空です' };
      var issuedAt = data[pos] * 0x1000000 + (data[pos + 1] << 16) + (data[pos + 2] << 8) + data[pos + 3];
      pos += 4;
      var sig = '';
      for (var k = 0; k < SIG_BYTES; k++) sig += (data[pos + k] < 16 ? '0' : '') + data[pos + k].toString(16);
      pos += SIG_BYTES;
      members.push({ user_code: userCode, username: username, issued_at: issuedAt, sig: sig });
    }
    if (pos !== crcPos) return { ok: false, error: '中身の長さが合いません' };
    return { ok: true, batch: { groupId: (data[1] << 8) | data[2], partIndex: partIndex, partTotal: partTotal, members: members } };
  }

  // ── 発行日 ──

  /** issued_at (UNIX 秒) が、now (Date) と同じ端末ローカルの日付か。issued_at が無い (0 以下) は false。 */
  function isIssuedOnLocalDate(issuedAtUnix, now) {
    if (typeof issuedAtUnix !== 'number' || issuedAtUnix <= 0) return false;
    var d = new Date(issuedAtUnix * 1000);
    if (isNaN(d.getTime())) return false;
    return d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth() && d.getDate() === now.getDate();
  }

  return {
    PREFIX: PREFIX,
    MAX_MEMBERS_PER_PART: MAX_MEMBERS_PER_PART,
    MAX_PARTS: MAX_PARTS,
    base32Encode: base32Encode,
    base32Decode: base32Decode,
    base64Decode: base64Decode,
    crc16: crc16,
    isBatchText: isBatchText,
    parseMemberQr: parseMemberQr,
    memberError: memberError,
    computeGroupId: computeGroupId,
    encodePart: encodePart,
    encodeGroup: encodeGroup,
    decodeBatch: decodeBatch,
    isIssuedOnLocalDate: isIssuedOnLocalDate
  };
}));
