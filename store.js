/*
 * 事前受付: 読み取った会員リストの保存 (ブラウザ / Node 共用)。
 *
 * 約束: 読み取ったリストは、消去ボタンを押さない限り消さない。
 *   - 正本は localStorage。変更のたびに「読む → 変える → 書く」を 1 回で行い、メモリだけに持つ時間を作らない
 *     (リロード / タブを閉じる / 別のタブで開いていても失わない)。
 *   - 自動削除はしない (時間が経っても、Host に見せた後でも残す)。
 *   - 書けなかったときは ok=false を返す (呼び出し側が画面に赤く出す)。黙って失わない。
 *   - 保存データが壊れていて読めないときは、上書きする前に別のキーへ退避する。退避もできなければ書き込みを止める。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.PreReceptionStore = factory();
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var KEY = 'mfcore.prereception.v1';
  var DEFAULT_SETTINGS = { maxPerPart: 4, requireToday: true, sound: true };

  function newId(now) {
    return 'g' + now.toString(36) + Math.floor(Math.random() * 0x100000).toString(36);
  }

  function emptyState(now) {
    var g = { id: newId(now), seq: 1, createdAt: now, memo: '', handedAt: 0, members: [] };
    return { v: 1, nextSeq: 2, currentGroupId: g.id, groups: [g], settings: Object.assign({}, DEFAULT_SETTINGS) };
  }

  /** 読んだ値の形を整える (足りない項目を補うだけ。会員は落とさない)。 */
  function normalize(s, now) {
    if (!s || typeof s !== 'object' || !Array.isArray(s.groups)) return null;
    var groups = [];
    var maxSeq = 0;
    s.groups.forEach(function (g) {
      if (!g || typeof g !== 'object') return;
      var members = Array.isArray(g.members) ? g.members.filter(function (m) {
        return m && typeof m.user_code === 'string' && m.user_code.length > 0;
      }).map(function (m) {
        return {
          user_code: m.user_code,
          username: typeof m.username === 'string' ? m.username : '',
          issued_at: typeof m.issued_at === 'number' && m.issued_at > 0 ? m.issued_at : 0,
          sig: typeof m.sig === 'string' ? m.sig : '',
          scannedAt: typeof m.scannedAt === 'number' ? m.scannedAt : now
        };
      }) : [];
      var seq = typeof g.seq === 'number' ? g.seq : maxSeq + 1;
      if (seq > maxSeq) maxSeq = seq;
      groups.push({
        id: typeof g.id === 'string' && g.id ? g.id : newId(now),
        seq: seq,
        createdAt: typeof g.createdAt === 'number' ? g.createdAt : now,
        memo: typeof g.memo === 'string' ? g.memo : '',
        handedAt: typeof g.handedAt === 'number' ? g.handedAt : 0,
        members: members
      });
    });
    var state = {
      v: 1,
      nextSeq: Math.max(typeof s.nextSeq === 'number' ? s.nextSeq : 1, maxSeq + 1),
      currentGroupId: s.currentGroupId,
      groups: groups,
      settings: Object.assign({}, DEFAULT_SETTINGS, s.settings && typeof s.settings === 'object' ? s.settings : {})
    };
    state.settings.maxPerPart = Math.max(1, Math.min(8, Math.floor(Number(state.settings.maxPerPart)) || DEFAULT_SETTINGS.maxPerPart));
    state.settings.requireToday = state.settings.requireToday !== false;
    state.settings.sound = state.settings.sound !== false;
    ensureCurrent(state, now);
    return state;
  }

  /** グループが 1 つも無ければ空のグループを作り、選択中のグループが必ず存在するようにする。 */
  function ensureCurrent(state, now) {
    if (state.groups.length === 0) {
      var g = { id: newId(now), seq: state.nextSeq++, createdAt: now, memo: '', handedAt: 0, members: [] };
      state.groups.push(g);
    }
    var found = state.groups.some(function (g2) { return g2.id === state.currentGroupId; });
    if (!found) state.currentGroupId = state.groups[state.groups.length - 1].id;
  }

  function findGroup(state, id) {
    for (var i = 0; i < state.groups.length; i++) if (state.groups[i].id === id) return state.groups[i];
    return null;
  }

  /**
   * @param storage localStorage と同じ getItem / setItem を持つもの
   * @param nowFn   現在時刻 (ms) を返す関数 (省略時 Date.now)
   */
  function createStore(storage, nowFn) {
    var now = nowFn || function () { return Date.now(); };
    var saveError = null;     // 最後の書き込みの失敗 (成功で null に戻る)
    var loadWarning = null;   // 保存データを読めず退避した
    var blocked = null;       // 読めない保存データを退避できなかった → 上書きしないよう書き込みを止めている
    var fallback = null;      // 保存がまだ無い / 使えない間に返す初期状態 (グループの ID を呼び出しごとに変えないため)

    function initial() {
      if (!fallback) fallback = emptyState(now());
      return JSON.parse(JSON.stringify(fallback));
    }

    function read() {
      var raw;
      try {
        raw = storage.getItem(KEY);
      } catch (e) {
        saveError = '保存領域を読めません: ' + (e && e.message ? e.message : e);
        return initial();
      }
      if (raw === null || raw === undefined || raw === '') return initial();
      var parsed = null;
      try { parsed = normalize(JSON.parse(raw), now()); } catch (e2) { parsed = null; }
      if (parsed) return parsed;

      // 読めない保存データ: 上書きで失わないよう、先に別のキーへ退避する
      if (!blocked) {
        var backupKey = KEY + '.corrupt.' + now();
        try {
          storage.setItem(backupKey, raw);
          storage.setItem(KEY, '');
          loadWarning = '保存データを読めなかったため退避しました (' + backupKey + ')';
        } catch (e3) {
          blocked = '保存データを読めず、退避もできませんでした。上書きを避けるため保存を止めています';
        }
      }
      return initial();
    }

    function write(state) {
      if (blocked) { saveError = blocked; return false; }
      try {
        storage.setItem(KEY, JSON.stringify(state));
        saveError = null;
        return true;
      } catch (e) {
        saveError = '保存に失敗しました: ' + (e && e.message ? e.message : e);
        return false;
      }
    }

    /** 読む → 変える → 書く。mutator の戻り値を result に入れて返す。 */
    function update(mutator) {
      var state = read();
      var result = mutator(state);
      ensureCurrent(state, now());
      var ok = write(state);
      return { ok: ok, result: result };
    }

    return {
      KEY: KEY,

      /** 保存されている最新の状態 (毎回 localStorage から読む)。 */
      getState: function () { return read(); },

      status: function () { return { saveError: saveError, loadWarning: loadWarning, blocked: blocked }; },

      /**
       * 選択中のグループに会員を足す。result.status:
       *   'added' / 'duplicate' (同じ内容で読取済み) / 'updated' (同じ会員の新しい QR に差し替え) /
       *   'other_group' (別のグループに読取済み。result.group にそのグループ)
       * ok=false なら保存できていない (足されていない)。
       */
      addMember: function (member) {
        return update(function (state) {
          for (var i = 0; i < state.groups.length; i++) {
            var g = state.groups[i];
            for (var j = 0; j < g.members.length; j++) {
              var m = g.members[j];
              if (m.user_code !== member.user_code) continue;
              if (g.id !== state.currentGroupId) return { status: 'other_group', group: g };
              if (m.sig === member.sig && m.issued_at === member.issued_at && m.username === member.username) return { status: 'duplicate', group: g };
              m.username = member.username;
              m.issued_at = member.issued_at;
              m.sig = member.sig;
              m.scannedAt = now();
              return { status: 'updated', group: g };
            }
          }
          var cur = findGroup(state, state.currentGroupId);
          cur.members.push({ user_code: member.user_code, username: member.username, issued_at: member.issued_at, sig: member.sig, scannedAt: now() });
          return { status: 'added', group: cur };
        });
      },

      /** [消去ボタン] 会員 1 人を消す。 */
      removeMember: function (groupId, userCode) {
        return update(function (state) {
          var g = findGroup(state, groupId);
          if (!g) return false;
          var before = g.members.length;
          g.members = g.members.filter(function (m) { return m.user_code !== userCode; });
          return g.members.length !== before;
        });
      },

      /** 新しいグループを作って選ぶ。空のグループが既にあればそれを選ぶ (空のグループを増やさない)。 */
      newGroup: function () {
        return update(function (state) {
          for (var i = 0; i < state.groups.length; i++) {
            if (state.groups[i].members.length === 0) { state.currentGroupId = state.groups[i].id; return state.groups[i]; }
          }
          var g = { id: newId(now()), seq: state.nextSeq++, createdAt: now(), memo: '', handedAt: 0, members: [] };
          state.groups.push(g);
          state.currentGroupId = g.id;
          return g;
        });
      },

      selectGroup: function (groupId) {
        return update(function (state) {
          if (findGroup(state, groupId)) state.currentGroupId = groupId;
        });
      },

      /** [消去ボタン] グループを会員ごと消す。 */
      deleteGroup: function (groupId) {
        return update(function (state) {
          var before = state.groups.length;
          state.groups = state.groups.filter(function (g) { return g.id !== groupId; });
          return state.groups.length !== before;
        });
      },

      /** [消去ボタン] 全グループを消す (設定は残す)。 */
      clearAll: function () {
        return update(function (state) {
          state.groups = [];
          state.nextSeq = 1;
          return true;
        });
      },

      setMemo: function (groupId, memo) {
        return update(function (state) {
          var g = findGroup(state, groupId);
          if (g) g.memo = String(memo || '').slice(0, 40);
        });
      },

      /** まとめ QR を表示した時刻を残す (どのグループを Host に見せたかの目印。会員は消さない)。 */
      markHanded: function (groupId) {
        return update(function (state) {
          var g = findGroup(state, groupId);
          if (g) g.handedAt = now();
        });
      },

      setSetting: function (name, value) {
        return update(function (state) {
          state.settings[name] = value;
          var n = normalize(state, now());
          state.settings = n.settings;
        });
      }
    };
  }

  return { createStore: createStore, KEY: KEY, DEFAULT_SETTINGS: DEFAULT_SETTINGS };
}));
