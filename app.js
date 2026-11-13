/*
 * 事前受付: 画面 (カメラ読取 → グループの一覧 → まとめ QR の表示)。
 * 会員リストの正本は store.js (localStorage)。画面は毎回そこから描き直す。
 */
(function () {
  'use strict';

  var Codec = self.PreReceptionCodec;
  var VERSION = self.APP_VERSION || '?';

  // localStorage に触れない環境 (Cookie を全拒否など) でも画面は出し、保存できないことを赤く知らせる
  var storage;
  try {
    storage = window.localStorage;
    storage.getItem('probe');
  } catch (e) {
    var storageError = e;
    storage = {
      getItem: function () { throw storageError; },
      setItem: function () { throw storageError; }
    };
  }
  var store = self.PreReceptionStore.createStore(storage);

  function $(id) { return document.getElementById(id); }
  var el = {
    ver: $('ver'), banners: $('banners'), groups: $('groups'),
    videoWrap: $('videoWrap'), video: $('video'), scanMsg: $('scanMsg'), camBtn: $('camBtn'),
    groupTitle: $('groupTitle'), memo: $('memo'), members: $('members'), emptyHint: $('emptyHint'),
    showBtn: $('showBtn'), delGroupBtn: $('delGroupBtn'),
    setMax: $('setMax'), setToday: $('setToday'), setSound: $('setSound'), storageInfo: $('storageInfo'), clearAllBtn: $('clearAllBtn'),
    updateInfo: $('updateInfo'), updateBtn: $('updateBtn'),
    qrOverlay: $('qrOverlay'), qrTitle: $('qrTitle'), qrCanvas: $('qrCanvas'), qrPart: $('qrPart'), qrNames: $('qrNames'), qrClose: $('qrClose'),
    dialog: $('dialog'), dialogText: $('dialogText'), dialogCancel: $('dialogCancel'), dialogOk: $('dialogOk')
  };

  var scanning = false;
  var stream = null;
  var detector = null;
  var detectorChecked = false;
  var workCanvas = document.createElement('canvas');
  var workCtx = null;
  var lastText = '';
  var lastAt = 0;
  var audioCtx = null;
  var persisted = null;        // navigator.storage.persisted() の結果 (null = 不明)
  var persistAsked = false;
  var updateWorker = null;     // 待機中の新しい Service Worker
  var qr = null;               // 表示中のまとめ QR { parts, index, paused, slices, title }
  var qrTimer = null;
  var wakeLock = null;
  var cameraWasOn = false;     // まとめ QR の表示 / 画面が隠れた間に止めたカメラを戻すか
  var dialogOnOk = null;
  var dialogOnCancel = null;
  var swReg = null;            // Service Worker の登録 (更新の確認に使う)
  var pageLoadedAt = Date.now();
  var userInteracted = false;  // 開いてから一度でも画面に触れたか
  var applyingUpdate = false;
  var manualUpdate = false;    // 設定の「最新版に更新」を押した (見つかったら聞かずに切り替える)
  var lastUpdateCheck = 0;
  var updateInfoText = '';

  // ── 小物 ──

  function pad2(n) { return (n < 10 ? '0' : '') + n; }

  function fmtTime(ms) {
    var d = new Date(ms);
    return pad2(d.getHours()) + ':' + pad2(d.getMinutes());
  }

  /** 発行日時の表示: 今日なら "12:03"、別の日なら "11/12 12:03"。 */
  function fmtIssued(unix) {
    var d = new Date(unix * 1000);
    var hm = pad2(d.getHours()) + ':' + pad2(d.getMinutes());
    return Codec.isIssuedOnLocalDate(unix, new Date()) ? hm : (d.getMonth() + 1) + '/' + d.getDate() + ' ' + hm;
  }

  function displayName(m) { return m.username ? m.username : '(名前なし)'; }

  function groupLabel(g) { return 'グループ ' + g.seq + (g.memo ? ' (' + g.memo + ')' : ''); }

  function currentGroup(state) {
    for (var i = 0; i < state.groups.length; i++) if (state.groups[i].id === state.currentGroupId) return state.groups[i];
    return state.groups[0];
  }

  function totalMembers(state) {
    var n = 0;
    state.groups.forEach(function (g) { n += g.members.length; });
    return n;
  }

  function setMsg(kind, text) {
    el.scanMsg.className = 'msg' + (kind ? ' ' + kind : '');
    el.scanMsg.textContent = text;
  }

  function clear(node) { while (node.firstChild) node.removeChild(node.firstChild); }

  function make(tag, className, text) {
    var n = document.createElement(tag);
    if (className) n.className = className;
    if (text !== undefined) n.textContent = text;
    return n;
  }

  // ── 音 / 振動 ──

  function ensureAudio() {
    if (audioCtx) return;
    var Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return;
    try { audioCtx = new Ctx(); } catch (e) { audioCtx = null; }
  }

  function beep(kind, soundOn) {
    try {
      if (navigator.vibrate) navigator.vibrate(kind === 'ok' ? 60 : [80, 60, 80]);
    } catch (e) { /* 振動なしの端末 */ }
    if (!soundOn || !audioCtx) return;
    var tones = kind === 'ok' ? [[880, 0, 0.12]] : kind === 'warn' ? [[440, 0, 0.1], [440, 0.16, 0.1]] : [[220, 0, 0.35]];
    try {
      if (audioCtx.state === 'suspended') audioCtx.resume();
      tones.forEach(function (t) {
        var osc = audioCtx.createOscillator();
        var gain = audioCtx.createGain();
        osc.frequency.value = t[0];
        gain.gain.value = 0.2;
        osc.connect(gain);
        gain.connect(audioCtx.destination);
        osc.start(audioCtx.currentTime + t[1]);
        osc.stop(audioCtx.currentTime + t[1] + t[2]);
      });
    } catch (e) { /* 音が出せなくても読取は続ける */ }
  }

  // ── 確認ダイアログ (消去の操作は必ずここを通す) ──

  /**
   * 消去の確認。赤いボタン (okLabel) を押したときだけ onOk を呼ぶ。
   * もう一方のボタンは既定で「キャンセル」(何もしない)。cancelLabel / onCancel で文言と動きを変えられる。
   */
  function confirmDanger(text, okLabel, onOk, cancelLabel, onCancel) {
    el.dialogText.textContent = text;
    el.dialogOk.textContent = okLabel;
    el.dialogCancel.textContent = cancelLabel || 'キャンセル';
    dialogOnOk = onOk;
    dialogOnCancel = onCancel || null;
    el.dialog.hidden = false;
  }

  function closeDialog() {
    el.dialog.hidden = true;
    dialogOnOk = null;
    dialogOnCancel = null;
  }

  el.dialogCancel.addEventListener('click', function () {
    var fn = dialogOnCancel;
    closeDialog();
    if (fn) fn();
  });
  el.dialogOk.addEventListener('click', function () {
    var fn = dialogOnOk;
    closeDialog();
    if (fn) fn();
  });

  // ── 描画 ──

  function renderBanners() {
    clear(el.banners);
    var st = store.status();
    if (st.blocked || st.saveError) {
      el.banners.appendChild(make('div', 'banner err',
        (st.blocked || st.saveError) + '\nこのままでは読み取った内容が残りません。シークレットウィンドウを使っていないか、端末の空き容量を確認してください。'));
    }
    if (st.loadWarning) el.banners.appendChild(make('div', 'banner warn', st.loadWarning));
    if (!window.isSecureContext) {
      el.banners.appendChild(make('div', 'banner warn', 'このページは HTTPS で開かれていません。カメラが使えない場合は https:// の URL で開いてください。'));
    }
    if (updateWorker) {
      var b = make('div', 'banner info');
      b.appendChild(make('span', '', '新しい版があります (読み取ったリストは残ります)'));
      var btn = make('button', '', '更新する');
      btn.type = 'button';
      btn.addEventListener('click', function () { applyUpdate(updateWorker); });
      b.appendChild(btn);
      el.banners.appendChild(b);
    }
  }

  function renderGroups(state) {
    clear(el.groups);
    state.groups.forEach(function (g) {
      var b = make('button', g.id === state.currentGroupId ? 'current' : '');
      b.type = 'button';
      b.appendChild(document.createTextNode('グループ ' + g.seq + ' (' + g.members.length + ' 名)'));
      var sub = g.memo ? g.memo : fmtTime(g.createdAt) + ' 作成';
      if (g.handedAt) sub += ' ・表示済み ' + fmtTime(g.handedAt);
      b.appendChild(make('span', 'chipSub', sub));
      b.addEventListener('click', function () {
        store.selectGroup(g.id);
        render();
      });
      el.groups.appendChild(b);
    });
    var add = make('button', 'add', '+ 新しいグループ');
    add.type = 'button';
    add.addEventListener('click', function () {
      store.newGroup();
      setMsg('', '新しいグループです。会員 QR を写してください');
      render();
    });
    el.groups.appendChild(add);
  }

  function renderMembers(state) {
    var g = currentGroup(state);
    el.groupTitle.textContent = 'グループ ' + g.seq + ' (' + g.members.length + ' 名)';
    if (document.activeElement !== el.memo) el.memo.value = g.memo;
    clear(el.members);
    var now = new Date();
    g.members.forEach(function (m, i) {
      var li = make('li');
      li.appendChild(make('span', 'no', String(i + 1)));
      var who = make('div', 'who');
      who.appendChild(make('div', 'name', displayName(m)));
      var code = make('div', 'code', m.user_code + (m.issued_at > 0 ? ' ・発行 ' + fmtIssued(m.issued_at) : ''));
      who.appendChild(code);
      if (state.settings.requireToday && m.issued_at > 0 && !Codec.isIssuedOnLocalDate(m.issued_at, now)) {
        who.appendChild(make('div', 'code stale', '発行日が本日ではありません (Host で断られます。読み直してください)'));
      }
      li.appendChild(who);
      var del = make('button', 'danger', '削除');
      del.type = 'button';
      del.addEventListener('click', function () {
        confirmDanger('「' + displayName(m) + '」(' + m.user_code + ') をこのグループから削除しますか？', '削除する', function () {
          var r = store.removeMember(g.id, m.user_code);
          if (!r.ok) setMsg('err', '保存できませんでした — 削除されていません');
          else setMsg('', '削除しました: ' + displayName(m));
          render();
        });
      });
      li.appendChild(del);
      el.members.appendChild(li);
    });
    el.emptyHint.hidden = g.members.length > 0;
    el.showBtn.disabled = g.members.length === 0;
    el.showBtn.textContent = g.members.length === 0
      ? 'Host に渡す (まとめ QR を表示)'
      : 'Host に渡す (' + g.members.length + ' 名のまとめ QR を表示)';
    el.delGroupBtn.hidden = g.members.length === 0 && state.groups.length <= 1;
  }

  function renderSettings(state) {
    el.setMax.value = String(state.settings.maxPerPart);
    if (el.setMax.value !== String(state.settings.maxPerPart)) el.setMax.value = '4';
    el.setToday.checked = state.settings.requireToday;
    el.setSound.checked = state.settings.sound;
    el.storageInfo.textContent = '保存: この端末のブラウザ' +
      (persisted === true ? ' (ブラウザが自動で消さない設定になっています)'
        : persisted === false ? ' (長く使わないとブラウザが消すことがあります。ホーム画面に追加して使ってください)' : '') +
      ' ・合計 ' + totalMembers(state) + ' 名';
    el.clearAllBtn.disabled = totalMembers(state) === 0 && state.groups.length <= 1;
    el.updateInfo.textContent = 'v' + VERSION + (updateInfoText ? ' — ' + updateInfoText : '');
  }

  function render() {
    var state = store.getState();
    el.ver.textContent = 'v' + VERSION;
    renderBanners();
    renderGroups(state);
    renderMembers(state);
    renderSettings(state);
  }

  // ── 読み取った文字列の処理 ──

  function handleText(text) {
    var nowMs = Date.now();
    if (text === lastText && nowMs - lastAt < 3000) return;   // 写したままの同じ QR を繰り返し処理しない
    lastText = text;
    lastAt = nowMs;

    var state = store.getState();
    var soundOn = state.settings.sound;
    var parsed = Codec.parseMemberQr(text);
    if (!parsed.ok) {
      var why = parsed.reason === 'batch' ? 'これは「まとめ QR」です。会員の QR を写してください'
        : parsed.reason === 'bad_sig' ? '会員 QR の形式が違います (署名がありません)。会員ページの QR を写してください'
          : parsed.reason === 'bad_issued_at' ? '会員 QR の形式が違います (発行日時)。会員ページの QR を写してください'
            : parsed.reason === 'too_long' ? 'この会員の名前は長すぎて、まとめ QR に入れられません。Host の受付カメラで直接読んでください'
              : '会員 QR ではありません';
      setMsg('err', why);
      beep('err', soundOn);
      return;
    }

    var m = parsed.member;
    if (state.settings.requireToday && m.issued_at > 0 && !Codec.isIssuedOnLocalDate(m.issued_at, new Date())) {
      setMsg('err', '発行日が本日ではありません (発行 ' + fmtIssued(m.issued_at) + ')\n会員ページで QR を表示し直してもらってください\n' + displayName(m) + ' (' + m.user_code + ')');
      beep('err', soundOn);
      return;
    }

    var res = store.addMember(m);
    if (!res.ok) {
      setMsg('err', '保存できませんでした — この会員は追加されていません\n' + displayName(m) + ' (' + m.user_code + ')');
      beep('err', soundOn);
      render();
      return;
    }
    var g = res.result.group;
    switch (res.result.status) {
      case 'added':
        setMsg('ok', '読取 OK: ' + displayName(m) + '\n' + m.user_code + (m.issued_at > 0 ? ' ・発行 ' + fmtIssued(m.issued_at) : '') +
          '\nグループ ' + g.seq + ' の ' + g.members.length + ' 人目');
        beep('ok', soundOn);
        requestPersist();
        break;
      case 'updated':
        setMsg('ok', '読取済みの会員です — 新しい QR に差し替えました\n' + displayName(m) + ' (' + m.user_code + ')');
        beep('ok', soundOn);
        break;
      case 'duplicate':
        setMsg('warn', '読取済みです: ' + displayName(m) + '\n' + m.user_code);
        beep('warn', soundOn);
        break;
      case 'other_group':
        setMsg('warn', '別のグループ (' + groupLabel(g) + ') に読取済みです: ' + displayName(m) +
          '\nこちらのグループに入れるなら、先にそのグループから削除してください');
        beep('warn', soundOn);
        break;
    }
    render();
  }

  // ── カメラ ──

  function cameraErrorText(e) {
    var name = e && e.name ? e.name : '';
    if (name === 'NotAllowedError' || name === 'SecurityError') return 'カメラの使用が許可されていません。ブラウザのサイト設定でカメラを「許可」にして、もう一度「カメラを開始」を押してください';
    if (name === 'NotFoundError' || name === 'OverconstrainedError') return 'カメラが見つかりません';
    if (name === 'NotReadableError') return 'カメラをほかのアプリが使っています。ほかのアプリを閉じて、もう一度「カメラを開始」を押してください';
    return 'カメラを開始できません: ' + (e && e.message ? e.message : name);
  }

  function initDetector() {
    if (detectorChecked) return Promise.resolve();
    detectorChecked = true;
    if (!('BarcodeDetector' in window)) return Promise.resolve();
    return window.BarcodeDetector.getSupportedFormats().then(function (formats) {
      if (formats.indexOf('qr_code') >= 0) detector = new window.BarcodeDetector({ formats: ['qr_code'] });
    }).catch(function () { detector = null; });
  }

  function decodeFrame() {
    if (detector) {
      return detector.detect(el.video).then(function (codes) {
        var out = [];
        codes.forEach(function (c) { if (c && c.rawValue) out.push(c.rawValue); });
        return out;
      });
    }
    var vw = el.video.videoWidth;
    var vh = el.video.videoHeight;
    var scale = Math.min(1, 960 / Math.max(vw, vh));
    var w = Math.round(vw * scale);
    var h = Math.round(vh * scale);
    if (workCanvas.width !== w || workCanvas.height !== h) {
      workCanvas.width = w;
      workCanvas.height = h;
      workCtx = null;
    }
    if (!workCtx) workCtx = workCanvas.getContext('2d', { willReadFrequently: true });
    workCtx.drawImage(el.video, 0, 0, w, h);
    var img = workCtx.getImageData(0, 0, w, h);
    var found = self.jsQR(img.data, w, h, { inversionAttempts: 'dontInvert' });
    return Promise.resolve(found && found.data ? [found.data] : []);
  }

  function tick() {
    if (!scanning) return;
    var started = Date.now();
    var busy = !el.dialog.hidden || !el.qrOverlay.hidden;   // 確認中 / まとめ QR の表示中は読まない
    var work = (!busy && el.video.readyState >= 2 && el.video.videoWidth > 0)
      ? decodeFrame().then(function (texts) { texts.forEach(handleText); })
      : Promise.resolve();
    work.catch(function () {
      detector = null;   // BarcodeDetector が失敗したら以後は同梱のデコーダで読む
    }).then(function () {
      if (scanning) setTimeout(tick, Math.max(60, 150 - (Date.now() - started)));
    });
  }

  function updateCameraUi() {
    el.videoWrap.className = scanning ? 'on' : '';
    el.camBtn.textContent = scanning ? 'カメラを止める' : 'カメラを開始';
    el.camBtn.className = scanning ? '' : 'primary';
  }

  function startCamera() {
    if (scanning) return Promise.resolve();
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      setMsg('err', 'このブラウザではカメラを使えません。https:// の URL を Chrome か Safari で開いてください');
      return Promise.resolve();
    }
    return navigator.mediaDevices.getUserMedia({
      video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } },
      audio: false
    }).then(function (s) {
      stream = s;
      el.video.srcObject = s;
      var played = el.video.play();
      return (played && played.catch ? played.catch(function () {}) : Promise.resolve()).then(initDetector);
    }).then(function () {
      scanning = true;
      updateCameraUi();
      if (el.scanMsg.className === 'msg' || el.scanMsg.className === 'msg err') setMsg('', '会員 QR を写してください');
      tick();
    }).catch(function (e) {
      stopCamera();
      setMsg('err', cameraErrorText(e));
    });
  }

  function stopCamera() {
    scanning = false;
    if (stream) stream.getTracks().forEach(function (t) { t.stop(); });
    stream = null;
    el.video.srcObject = null;
    updateCameraUi();
  }

  el.camBtn.addEventListener('click', function () {
    ensureAudio();
    if (scanning) stopCamera();
    else startCamera();
  });

  // ── 保存の永続化の要求 (ブラウザが空き容量の都合で消さないようにする) ──

  function refreshPersisted() {
    if (!navigator.storage || !navigator.storage.persisted) return;
    navigator.storage.persisted().then(function (p) {
      persisted = p;
      render();
    }).catch(function () {});
  }

  function requestPersist() {
    if (persistAsked || !navigator.storage || !navigator.storage.persist) return;
    persistAsked = true;
    navigator.storage.persist().then(function (p) {
      persisted = p;
      render();
    }).catch(function () {});
  }

  // ── まとめ QR ──

  /** 誤り訂正 M で 57 マス角以内なら M、超えるなら L (マス目を細かくしすぎない)。 */
  function makeQr(text) {
    var last = null;
    var levels = ['M', 'L'];
    for (var i = 0; i < levels.length; i++) {
      try {
        var q = self.qrcode(0, levels[i]);
        q.addData(text, 'Alphanumeric');
        q.make();
        last = q;
        if (levels[i] === 'M' && q.getModuleCount() > 57) continue;
        return q;
      } catch (e) { /* 入り切らない → 次の水準 */ }
    }
    return last;
  }

  function drawQr() {
    if (!qr) return;
    var q = makeQr(qr.parts[qr.index]);
    if (!q) {
      el.qrPart.textContent = 'まとめ QR を作れません (設定で 1 枚あたりの人数を減らしてください)';
      return;
    }
    var count = q.getModuleCount();
    var quiet = 4;
    var total = count + quiet * 2;
    var dpr = window.devicePixelRatio || 1;
    var cssMax = Math.min(window.innerWidth - 24, window.innerHeight * 0.62);
    var px = Math.max(1, Math.floor(cssMax * dpr / total));
    var size = total * px;
    el.qrCanvas.width = size;
    el.qrCanvas.height = size;
    el.qrCanvas.style.width = (size / dpr) + 'px';
    el.qrCanvas.style.height = (size / dpr) + 'px';
    var ctx = el.qrCanvas.getContext('2d');
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, size, size);
    ctx.fillStyle = '#000000';
    for (var r = 0; r < count; r++) {
      for (var c = 0; c < count; c++) {
        if (q.isDark(r, c)) ctx.fillRect((c + quiet) * px, (r + quiet) * px, px, px);
      }
    }
    el.qrTitle.textContent = qr.title;
    el.qrPart.textContent = qr.parts.length > 1
      ? (qr.index + 1) + ' / ' + qr.parts.length + ' 枚目' + (qr.paused ? ' (停止中 — QR をタップで再開)' : ' (自動で切り替わります — QR をタップで止める)')
      : '';
    el.qrNames.textContent = qr.slices[qr.index].map(displayName).join(' / ');
  }

  function requestWakeLock() {
    if (!('wakeLock' in navigator)) return;
    navigator.wakeLock.request('screen').then(function (lock) { wakeLock = lock; }).catch(function () {});
  }

  function releaseWakeLock() {
    if (wakeLock) {
      try { wakeLock.release(); } catch (e) { /* 既に外れている */ }
      wakeLock = null;
    }
  }

  function openQr() {
    var state = store.getState();
    var g = currentGroup(state);
    if (!g || g.members.length === 0) return;
    var parts;
    try {
      parts = Codec.encodeGroup(g.members, state.settings.maxPerPart);
    } catch (e) {
      setMsg('err', 'まとめ QR を作れません: ' + (e && e.message ? e.message : e));
      return;
    }
    var perPart = Math.ceil(g.members.length / parts.length);   // codec.js の分け方と同じ
    var slices = [];
    for (var p = 0; p < parts.length; p++) slices.push(g.members.slice(p * perPart, (p + 1) * perPart));

    cameraWasOn = scanning;
    stopCamera();
    store.markHanded(g.id);
    qr = {
      parts: parts, slices: slices, index: 0, paused: false,
      title: groupLabel(g) + ' — ' + g.members.length + ' 名',
      groupId: g.id, groupName: groupLabel(g), count: g.members.length
    };
    el.qrOverlay.hidden = false;
    drawQr();
    if (parts.length > 1) {
      qrTimer = setInterval(function () {
        if (!qr || qr.paused) return;
        qr.index = (qr.index + 1) % qr.parts.length;
        drawQr();
      }, 1500);
    }
    requestWakeLock();
  }

  function closeQr() {
    el.qrOverlay.hidden = true;
    if (qrTimer) clearInterval(qrTimer);
    qrTimer = null;
    qr = null;
    releaseWakeLock();
    render();
    if (cameraWasOn) startCamera();
    cameraWasOn = false;
  }

  /**
   * 「閉じる」: Host に渡し終えたグループをここで片付けられるように、削除するか残すかを聞く。
   * 消すのは「削除して閉じる」を押したときだけ (「残して閉じる」は今までどおり一覧に残る)。
   */
  function askCloseQr() {
    if (!qr) { closeQr(); return; }
    var groupId = qr.groupId;
    var groupName = qr.groupName;
    confirmDanger('このグループを削除して閉じますか？\n' + groupName + ' (' + qr.count + ' 名)\n削除すると元に戻せません。', '削除して閉じる', function () {
      var r = store.deleteGroup(groupId);
      setMsg(r.ok ? '' : 'err', r.ok ? groupName + ' を削除しました' : '保存できませんでした — ' + groupName + ' は削除されていません');
      closeQr();
    }, '残して閉じる', closeQr);
  }

  el.showBtn.addEventListener('click', openQr);
  el.qrClose.addEventListener('click', askCloseQr);
  el.qrCanvas.addEventListener('click', function () {
    if (!qr || qr.parts.length <= 1) return;
    qr.paused = !qr.paused;
    drawQr();
  });
  window.addEventListener('resize', drawQr);

  // ── グループ / 設定の操作 ──

  el.memo.addEventListener('input', function () {
    var state = store.getState();
    store.setMemo(state.currentGroupId, el.memo.value);
    renderBanners();
    renderGroups(store.getState());
  });

  el.delGroupBtn.addEventListener('click', function () {
    var state = store.getState();
    var g = currentGroup(state);
    confirmDanger(groupLabel(g) + ' (' + g.members.length + ' 名) を消去しますか？\n元に戻せません。', '消去する', function () {
      var r = store.deleteGroup(g.id);
      setMsg(r.ok ? '' : 'err', r.ok ? 'グループを消去しました' : '保存できませんでした — 消去されていません');
      render();
    });
  });

  el.clearAllBtn.addEventListener('click', function () {
    var state = store.getState();
    confirmDanger('すべてのグループ (' + state.groups.length + ' グループ、合計 ' + totalMembers(state) + ' 名) を消去しますか？\n元に戻せません。', 'すべて消去する', function () {
      var r = store.clearAll();
      setMsg(r.ok ? '' : 'err', r.ok ? 'すべて消去しました' : '保存できませんでした — 消去されていません');
      render();
    });
  });

  el.setMax.addEventListener('change', function () {
    store.setSetting('maxPerPart', parseInt(el.setMax.value, 10));
    render();
  });
  el.setToday.addEventListener('change', function () {
    store.setSetting('requireToday', el.setToday.checked);
    render();
  });
  el.setSound.addEventListener('change', function () {
    store.setSetting('sound', el.setSound.checked);
    render();
  });

  // ── 画面が隠れた / 戻った、別のタブでの変更 ──

  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState === 'hidden') {
      if (scanning) {
        cameraWasOn = true;
        stopCamera();
      }
      return;
    }
    render();   // 別のタブ / 日付の変わり目の表示を取り込む
    if (Date.now() - lastUpdateCheck > 60000) checkForUpdate(false);   // 裏から戻ったときも新しい版を確かめる
    if (!el.qrOverlay.hidden) requestWakeLock();
    else if (cameraWasOn) {
      cameraWasOn = false;
      startCamera();
    }
  });

  window.addEventListener('storage', function (e) {
    if (e.key === null || e.key === store.KEY) render();
  });

  // ── Service Worker と更新 ──
  //
  // オフラインで動かすために、アプリ一式は Service Worker のキャッシュから返している。新しい版への切り替えは:
  //   - 開くたび / 画面に戻るたびに、アプリから更新を確かめる (ブラウザ任せにしない。ホーム画面のアプリは裏から戻っただけでは確かめない)
  //   - 開いた直後でまだ何も操作していなければ、聞かずに切り替える (読み込み直すだけ。リストは localStorage にあるので残る)
  //   - 作業中に見つかったら上に「新しい版があります」を出し、「更新する」で切り替える
  //   - 設定の「最新版に更新」は、その場で確かめて、あれば聞かずに切り替える

  var AUTO_APPLY_WINDOW_MS = 15000;   // 開いてからこの時間内 (かつ未操作) なら聞かずに切り替える
  var APPLY_GUARD_KEY = 'prereception.applyAt';

  ['pointerdown', 'keydown'].forEach(function (type) {
    document.addEventListener(type, function () { userInteracted = true; }, { capture: true, passive: true });
  });

  function setUpdateInfo(text) {
    updateInfoText = text;
    el.updateInfo.textContent = 'v' + VERSION + (text ? ' — ' + text : '');
  }

  /** 直前 (30 秒以内) に切り替えを試みたか。切り替えられずに読み込み直しを繰り返すのを防ぐ。 */
  function recentlyApplied() {
    try { return Date.now() - Number(sessionStorage.getItem(APPLY_GUARD_KEY) || 0) < 30000; } catch (e) { return false; }
  }

  function applyUpdate(worker) {
    if (applyingUpdate || !worker) return;
    applyingUpdate = true;
    try { sessionStorage.setItem(APPLY_GUARD_KEY, String(Date.now())); } catch (e) { /* 使えなくても切り替えはする */ }
    setUpdateInfo('新しい版に切り替えています…');
    worker.postMessage({ type: 'SKIP_WAITING' });
    // 切り替わると controllerchange で読み込み直す。合図が届かなかったときのために、少し待ってから読み込み直す
    setTimeout(function () { window.location.reload(); }, 4000);
  }

  /** 新しい版の取得が終わった (待機中の Service Worker がある)。 */
  function onUpdateReady(worker) {
    updateWorker = worker;
    var idle = !userInteracted && Date.now() - pageLoadedAt < AUTO_APPLY_WINDOW_MS &&
      !scanning && el.qrOverlay.hidden && el.dialog.hidden;
    if (manualUpdate || (idle && !recentlyApplied())) {
      applyUpdate(worker);
    } else {
      setUpdateInfo('新しい版があります');
      renderBanners();
    }
  }

  function watchWorker(worker) {
    if (!worker) return;
    worker.addEventListener('statechange', function () {
      if (worker.state === 'installed' && navigator.serviceWorker.controller) {
        onUpdateReady(worker);
      } else if (worker.state === 'redundant' && manualUpdate && !applyingUpdate) {
        manualUpdate = false;
        setUpdateInfo('新しい版を取得できませんでした (回線を確認してください)。今の版のまま使えます');
      }
    });
  }

  /** 更新を確かめる。manual = 設定の「最新版に更新」(あれば聞かずに切り替え、無ければ「最新の版です」と出す)。 */
  function checkForUpdate(manual) {
    if (!swReg) {
      if (manual) window.location.reload();   // Service Worker の無い環境は読み込み直すだけ
      return;
    }
    if (manual) {
      manualUpdate = true;
      setUpdateInfo('確認しています…');
      var ready = updateWorker || swReg.waiting;
      if (ready) { applyUpdate(ready); return; }
    }
    lastUpdateCheck = Date.now();
    swReg.update().then(function () {
      if (swReg.installing) {            // 続きは watchWorker の statechange で
        if (manual) setUpdateInfo('新しい版を取得しています…');
        return;
      }
      if (swReg.waiting && navigator.serviceWorker.controller) { onUpdateReady(swReg.waiting); return; }
      if (manual) {
        manualUpdate = false;
        setUpdateInfo('最新の版です');
      }
    }).catch(function () {
      if (manual) {
        manualUpdate = false;
        setUpdateInfo('確認できませんでした (回線を確認してください)。今の版のまま使えます');
      }
    });
  }

  el.updateBtn.addEventListener('click', function () { checkForUpdate(true); });

  if ('serviceWorker' in navigator) {
    var reloading = false;
    var hadController = !!navigator.serviceWorker.controller;   // 初回の登録 (まだ制御されていない) では読み込み直さない
    navigator.serviceWorker.addEventListener('controllerchange', function () {
      if (reloading || (!hadController && !applyingUpdate)) return;
      reloading = true;
      window.location.reload();   // リストは localStorage にあるので、読み込み直しても残る
    });
    // updateViaCache 'none': 更新の確認で HTTP キャッシュを使わない (公開先は 10 分のキャッシュを返す)
    navigator.serviceWorker.register('sw.js', { updateViaCache: 'none' }).then(function (reg) {
      swReg = reg;
      reg.addEventListener('updatefound', function () { watchWorker(reg.installing); });
      watchWorker(reg.installing);
      if (reg.waiting && navigator.serviceWorker.controller) onUpdateReady(reg.waiting);
      else if (navigator.serviceWorker.controller) checkForUpdate(false);
    }).catch(function () { /* Service Worker なしでも動く (オフラインでは開けないだけ) */ });
  }

  render();
  refreshPersisted();
}());
