/*
 * 通しの検査 (PC の Chrome、スマホ不要): 偽カメラに会員 QR の映像を流し、
 *   カメラ読取 → 一覧 → リロードしても残る → まとめ QR の表示 (画面の QR を読み戻して照合) → 消去
 * を実際のページで確かめる。続けて、版を上げたときの切り替え (設定の「最新版に更新」/ 開いた直後の自動切り替え /
 * 作業中の「新しい版があります」) も確かめる。
 *
 *   node test/e2e_chrome.js
 *
 * サイトの写しを作業フォルダに作り、このスクリプト自身が配信する (公開先と同じ Cache-Control: max-age=600 を返す)。
 * 版の切り替えの検査では、その写しの version.js / sw.js を書き換える (リポジトリのファイルは変えない)。
 *
 * 環境変数: CHROME (chrome.exe のパス) / E2E_TMP (作業フォルダ) / E2E_PORT (Chrome の操作用、既定 9333) /
 *   E2E_HTTP_PORT (配信用、既定 8766) / E2E_URL (公開先などを直接検査する。この場合、版の切り替えの検査は省く)
 * Node 22 以上 (組み込みの WebSocket / fetch を使う)。失敗が 1 件でもあれば終了コード 1。
 */
'use strict';
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const qrcode = require(path.join(__dirname, '..', 'vendor', 'qrcode.js'));
const Codec = require(path.join(__dirname, '..', 'codec.js'));

const ROOT = path.join(__dirname, '..');
const EXTERNAL_URL = process.env.E2E_URL || '';
const HTTP_PORT = parseInt(process.env.E2E_HTTP_PORT || '8766', 10);
const URL_BASE = EXTERNAL_URL || `http://127.0.0.1:${HTTP_PORT}/`;
const PORT = parseInt(process.env.E2E_PORT || '9333', 10);
const TMP = process.env.E2E_TMP || fs.mkdtempSync(path.join(os.tmpdir(), 'prereception-e2e-'));
const CHROME = process.env.CHROME || [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  '/usr/bin/google-chrome',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
].find(p => fs.existsSync(p));

let pass = 0;
const failures = [];
function check(cond, what) { if (cond) { pass++; console.log('  ok   ' + what); } else { failures.push(what); console.log('  FAIL ' + what); } }
const sleep = ms => new Promise(r => setTimeout(r, ms));

// ── 偽カメラの映像 (Y4M): 会員 QR を順に映す ──

const W = 480, H = 360, FPS = 30;
const nowSec = Math.floor(Date.now() / 1000);
const SIG = '8f1b9c4e2a7d3f6b5c8e1a9d2f4b6c8e';
const jsonA = JSON.stringify({ user_code: 'RCDR-26-A7K2N5', username: 'yamada', issued_at: nowSec, sig: SIG });
const jsonB = JSON.stringify({ user_code: 'RCDR-26-B3M8Q1', username: '山田 太郎', issued_at: nowSec, sig: '00112233445566778899aabbccddeeff' });
const jsonOld = JSON.stringify({ user_code: 'RCDR-26-C9X4T7', username: 'kinou', issued_at: nowSec - 86400 * 2, sig: SIG });
const jsonD = JSON.stringify({ user_code: 'RCDR-26-D2H6W3', username: '佐藤', sig: 'ffeeddccbbaa99887766554433221100' });   // issued_at 無し、JSON のまま (UTF-8)
const SCENES = [
  { label: 'A (JSON、今日発行)', text: jsonA, mode: 'Byte' },
  { label: 'B (Base32、日本語名)', text: Codec.base32Encode(new TextEncoder().encode(jsonB)), mode: 'Alphanumeric' },
  { label: '一昨日発行', text: jsonOld, mode: 'Byte' },
  { label: '会員 QR でない', text: 'https://example.com/not-a-member', mode: 'Byte' },
  { label: 'D (JSON、日本語名、issued_at 無し)', text: jsonD, mode: 'Byte' },
];

function qrFrame(text, mode) {
  qrcode.stringToBytes = qrcode.stringToBytesFuncs['UTF-8'];
  const q = qrcode(0, 'M');
  q.addData(text, mode);
  q.make();
  const n = q.getModuleCount();
  const px = Math.floor(Math.min(W, H) / (n + 8));
  const size = (n + 8) * px;
  const x0 = Math.floor((W - size) / 2), y0 = Math.floor((H - size) / 2);
  const y = Buffer.alloc(W * H, 110);                    // 灰色の背景
  for (let yy = 0; yy < size; yy++) y.fill(235, (y0 + yy) * W + x0, (y0 + yy) * W + x0 + size);   // 白い余白
  for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) {
    if (!q.isDark(r, c)) continue;
    for (let yy = 0; yy < px; yy++) {
      const row = (y0 + (r + 4) * px + yy) * W + x0 + (c + 4) * px;
      y.fill(16, row, row + px);
    }
  }
  return y;
}

function writeY4m(file) {
  const uv = Buffer.alloc((W / 2) * (H / 2) * 2, 128);
  const blank = Buffer.alloc(W * H, 110);
  const fd = fs.openSync(file, 'w');
  fs.writeSync(fd, `YUV4MPEG2 W${W} H${H} F${FPS}:1 Ip A1:1 C420jpeg\n`);
  const frame = y => { fs.writeSync(fd, 'FRAME\n'); fs.writeSync(fd, y); fs.writeSync(fd, uv); };
  for (const s of SCENES) {
    const y = qrFrame(s.text, s.mode);
    for (let i = 0; i < 36; i++) frame(y);      // 1.2 秒
    for (let i = 0; i < 12; i++) frame(blank);  // 0.4 秒
  }
  fs.closeSync(fd);
}

// ── Chrome DevTools Protocol ──

async function connect() {
  let target = null;
  for (let i = 0; i < 50 && !target; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
      target = list.find(t => t.type === 'page');
    } catch (e) { /* まだ起動中 */ }
    if (!target) await sleep(200);
  }
  if (!target) throw new Error('Chrome に接続できません');
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  let seq = 0;
  const pending = new Map();
  const consoleErrors = [];
  ws.onmessage = ev => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) { const p = pending.get(msg.id); pending.delete(msg.id); msg.error ? p.rej(new Error(msg.error.message)) : p.res(msg.result); }
    else if (msg.method === 'Runtime.exceptionThrown') consoleErrors.push('例外: ' + (msg.params.exceptionDetails.exception?.description || msg.params.exceptionDetails.text));
    else if (msg.method === 'Log.entryAdded' && msg.params.entry.level === 'error') {
      // この検査は実際のタップをしないので、振動 (navigator.vibrate) はブラウザに止められる。実機ではタップ後なので鳴る
      if (!/navigator\.vibrate/.test(msg.params.entry.text)) consoleErrors.push('ログ: ' + msg.params.entry.text);
    }
    else if (msg.method === 'Runtime.consoleAPICalled' && msg.params.type === 'error') consoleErrors.push('console.error: ' + msg.params.args.map(a => a.value || a.description).join(' '));
  };
  const send = (method, params) => new Promise((res, rej) => { const id = ++seq; pending.set(id, { res, rej }); ws.send(JSON.stringify({ id, method, params: params || {} })); });
  const evaluate = async expr => {
    const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error('evaluate: ' + (r.exceptionDetails.exception?.description || r.exceptionDetails.text) + '\n  ' + expr);
    return r.result.value;
  };
  const screenshot = async file => { const r = await send('Page.captureScreenshot', { format: 'png' }); fs.writeFileSync(file, Buffer.from(r.data, 'base64')); };
  return { send, evaluate, screenshot, consoleErrors, close: () => ws.close() };
}

const MEMBERS_JS = `Array.from(document.querySelectorAll('#members li')).map(li => li.querySelector('.name').textContent + '|' + li.querySelector('.code').textContent.split(' ')[0])`;

// ── サイトの写しと配信 ──

const SITE_ITEMS = ['index.html', 'app.css', 'app.js', 'codec.js', 'store.js', 'sw.js', 'version.js', 'manifest.webmanifest', 'vendor', 'icons'];
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.png': 'image/png', '.webmanifest': 'application/manifest+json', '.txt': 'text/plain; charset=utf-8', '.md': 'text/markdown; charset=utf-8',
};

function copySite(dst) {
  fs.rmSync(dst, { recursive: true, force: true });
  fs.mkdirSync(dst, { recursive: true });
  for (const item of SITE_ITEMS) fs.cpSync(path.join(ROOT, item), path.join(dst, item), { recursive: true });
}

/** 公開先 (GitHub Pages) と同じく max-age=600 と ETag を返す静的サーバー。 */
function startServer(dir, port) {
  const server = http.createServer((req, res) => {
    // server.down = true の間は接続を切る (回線なしの再現。Chrome の「オフライン」の模擬はページの通信にしか効かず、
    // Service Worker の更新確認の通信には効かないので、サーバー側でも止める)
    if (server.down) { req.socket.destroy(); return; }
    let rel = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    if (rel.endsWith('/')) rel += 'index.html';
    const file = path.join(dir, rel);
    if (!file.startsWith(dir) || !fs.existsSync(file) || !fs.statSync(file).isFile()) { res.writeHead(404); res.end('not found'); return; }
    const st = fs.statSync(file);
    const etag = `"${st.size}-${Math.round(st.mtimeMs)}"`;
    const headers = { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'max-age=600', ETag: etag };
    if (req.headers['if-none-match'] === etag) { res.writeHead(304, headers); res.end(); return; }
    res.writeHead(200, headers);
    res.end(fs.readFileSync(file));
  });
  return new Promise((resolve, reject) => { server.on('error', reject); server.listen(port, '127.0.0.1', () => resolve(server)); });
}

function siteVersion(dir) {
  return /APP_VERSION\s*=\s*'([^']+)'/.exec(fs.readFileSync(path.join(dir, 'version.js'), 'utf8'))[1];
}

/** 写しの版を上げる (version.js と sw.js の両方 = 実際の公開と同じ)。 */
function setSiteVersion(dir, to) {
  const from = siteVersion(dir);
  for (const f of ['version.js', 'sw.js']) {
    const p = path.join(dir, f);
    fs.writeFileSync(p, fs.readFileSync(p, 'utf8').split(`'${from}'`).join(`'${to}'`));
  }
}

/** 画面の版表示が v<version> になるまで待つ (読み込み直しの間は評価に失敗するので握る)。 */
async function waitVersion(cdp, version, ms) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    try {
      if (await cdp.evaluate(`document.getElementById('ver') ? document.getElementById('ver').textContent : ''`) === 'v' + version) return true;
    } catch (e) { /* 読み込み直しの途中 */ }
    await sleep(300);
  }
  return false;
}

async function waitFor(cdp, expr, ms) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    try { if (await cdp.evaluate(expr)) return true; } catch (e) { /* 読み込み直しの途中 */ }
    await sleep(300);
  }
  return false;
}

async function main() {
  if (!CHROME) throw new Error('Chrome が見つかりません (環境変数 CHROME にパスを指定)');
  fs.mkdirSync(TMP, { recursive: true });
  const siteDir = path.join(TMP, 'site');
  let server = null;
  if (!EXTERNAL_URL) {
    copySite(siteDir);
    server = await startServer(siteDir, HTTP_PORT);
  }
  const y4m = path.join(TMP, 'member_qr.y4m');
  writeY4m(y4m);
  // プロフィールのパスは短く (Windows: 長いと Service Worker のキャッシュのファイル名が 260 文字を超え、
  // cache.addAll が "Entry already exists" で失敗して Service Worker が登録されない)
  const profile = path.join(TMP, 'p' + (Date.now() % 100000));
  const chrome = spawn(CHROME, [
    '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`,
    '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', `--use-file-for-fake-video-capture=${y4m}`,
    '--autoplay-policy=no-user-gesture-required', '--window-size=520,1100', 'about:blank',
  ], { stdio: 'ignore' });

  let cdp;
  try {
    cdp = await connect();
    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');
    await cdp.send('Log.enable');
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 412, height: 915, deviceScaleFactor: 2, mobile: true });

    const open = async () => { await cdp.send('Page.navigate', { url: URL_BASE + 'index.html' }); await sleep(1200); };
    await open();

    console.log('== 最初の画面');
    check(await cdp.evaluate(`document.getElementById('ver').textContent.startsWith('v')`), '版が出ている');
    check((await cdp.evaluate(MEMBERS_JS)).length === 0, '最初は誰もいない');
    check(await cdp.evaluate(`document.getElementById('showBtn').disabled`), '空のグループでは「Host に渡す」を押せない');
    check(await cdp.evaluate(`document.documentElement.scrollWidth <= window.innerWidth`), '横にはみ出していない');
    await cdp.screenshot(path.join(TMP, 'shot_1_first.png'));

    console.log('== カメラ読取 (偽カメラの映像を 2 周ぶん)');
    await cdp.evaluate(`document.getElementById('camBtn').click()`);
    const seen = new Set();
    const until = Date.now() + SCENES.length * 1600 * 2 + 2000;
    while (Date.now() < until) {
      seen.add(await cdp.evaluate(`document.getElementById('scanMsg').textContent`));
      await sleep(150);
    }
    const msgs = Array.from(seen);
    const has = s => msgs.some(m => m.includes(s));
    check(await cdp.evaluate(`document.getElementById('videoWrap').className === 'on'`), 'カメラが動いている');
    check(has('読取 OK: yamada'), '読取 OK (JSON)');
    check(has('読取 OK: 山田 太郎'), '読取 OK (Base32、日本語名)');
    check(has('読取 OK: 佐藤'), '読取 OK (JSON の日本語名、issued_at 無し)');
    check(has('発行日が本日ではありません') && has('kinou'), '一昨日発行の QR は「発行日が本日ではありません」');
    check(has('会員 QR ではありません'), '会員 QR でないものは断る');
    check(has('読取済みです'), '2 周目は「読取済み」');
    let members = await cdp.evaluate(MEMBERS_JS);
    check(JSON.stringify(members) === JSON.stringify(['yamada|RCDR-26-A7K2N5', '山田 太郎|RCDR-26-B3M8Q1', '佐藤|RCDR-26-D2H6W3']), '一覧は読めた 3 人だけ (順番どおり): ' + JSON.stringify(members));
    if (!has('読取 OK')) console.log('     見えた文: ' + JSON.stringify(msgs));
    await cdp.screenshot(path.join(TMP, 'shot_2_scanned.png'));

    console.log('== リロード / 開き直しても残る');
    await cdp.send('Page.reload', { ignoreCache: true });
    await sleep(1200);
    members = await cdp.evaluate(MEMBERS_JS);
    check(members.length === 3, 'リロード後も 3 人: ' + JSON.stringify(members));
    await cdp.send('Page.navigate', { url: 'about:blank' });
    await sleep(300);
    await open();
    check((await cdp.evaluate(MEMBERS_JS)).length === 3, 'ページを閉じて開き直しても 3 人');
    check(await cdp.evaluate(`document.getElementById('videoWrap').className === ''`), '開き直した直後はカメラ停止 (勝手に読まない)');

    console.log('== 発行日の判定を OFF にすると古い QR も受ける');
    await cdp.evaluate(`(() => { const c = document.getElementById('setToday'); c.checked = false; c.dispatchEvent(new Event('change')); })()`);
    await cdp.evaluate(`document.getElementById('camBtn').click()`);
    await sleep(SCENES.length * 1600 + 1500);
    members = await cdp.evaluate(MEMBERS_JS);
    check(members.length === 4 && members.includes('kinou|RCDR-26-C9X4T7'), '判定 OFF なら 4 人目として入る: ' + JSON.stringify(members));
    await cdp.evaluate(`(() => { const c = document.getElementById('setToday'); c.checked = true; c.dispatchEvent(new Event('change')); })()`);
    check(await cdp.evaluate(`!!document.querySelector('#members .stale')`), '判定を ON に戻すと、古い QR の会員に印が付く (消しはしない)');
    check((await cdp.evaluate(MEMBERS_JS)).length === 4, '印が付くだけで 4 人のまま');

    console.log('== まとめ QR (画面の QR を読み戻して照合)');
    await cdp.evaluate(`document.getElementById('camBtn').click()`);   // カメラを止める
    await cdp.evaluate(`document.getElementById('showBtn').click()`);
    await sleep(300);
    check(await cdp.evaluate(`!document.getElementById('qrOverlay').hidden`), 'まとめ QR の画面が開く');
    const readBack = `(() => { const c = document.getElementById('qrCanvas'); const d = c.getContext('2d').getImageData(0, 0, c.width, c.height); const r = jsQR(d.data, c.width, c.height); return r ? r.data : null; })()`;
    const shown = await cdp.evaluate(readBack);
    const expected = await cdp.evaluate(`(() => { const s = JSON.parse(localStorage.getItem(PreReceptionStore.KEY)); const g = s.groups.find(x => x.id === s.currentGroupId); return PreReceptionCodec.encodeGroup(g.members, s.settings.maxPerPart); })()`);
    check(expected.length === 1 && shown === expected[0], '4 人は 1 枚で、画面の QR の中身が符号化した文字列と同じ');
    const decoded = Codec.decodeBatch(shown || '');
    check(decoded.ok && decoded.batch.members.length === 4 && decoded.batch.members[1].username === '山田 太郎' && decoded.batch.members[0].issued_at === nowSec && decoded.batch.members[2].issued_at === 0,
      '読み戻したまとめ QR を復号すると 4 人 (名前 / issued_at がそのまま)');
    check(await cdp.evaluate(`document.getElementById('qrTitle').textContent.includes('4 名')`), '人数の表示');
    await cdp.screenshot(path.join(TMP, 'shot_3_batch_qr.png'));
    await cdp.evaluate(`document.getElementById('qrClose').click()`);
    check(await cdp.evaluate(`!document.getElementById('dialog').hidden && document.getElementById('dialogText').textContent.includes('このグループを削除して閉じますか') && document.getElementById('dialogText').textContent.includes('4 名')`),
      '「閉じる」で「このグループを削除して閉じますか？」が出る');
    check(await cdp.evaluate(`document.getElementById('dialogOk').textContent === '削除して閉じる' && document.getElementById('dialogCancel').textContent === '残して閉じる'`), 'ボタンは「削除して閉じる」「残して閉じる」');
    check(await cdp.evaluate(`!document.getElementById('qrOverlay').hidden`), '選ぶまではまとめ QR を出したまま');
    await cdp.evaluate(`document.getElementById('dialogCancel').click()`);
    check(await cdp.evaluate(`document.getElementById('qrOverlay').hidden && document.getElementById('dialog').hidden`), '「残して閉じる」で閉じる');
    check((await cdp.evaluate(MEMBERS_JS)).length === 4, '「残して閉じる」なら一覧は消えない');
    check(await cdp.evaluate(`document.getElementById('groups').textContent.includes('表示済み')`), 'グループに「表示済み」の印');

    console.log('== 1 枚あたり 2 人にすると 2 枚に分かれて自動で切り替わる');
    await cdp.evaluate(`(() => { const s = document.getElementById('setMax'); s.value = '2'; s.dispatchEvent(new Event('change')); })()`);
    await cdp.evaluate(`document.getElementById('showBtn').click()`);
    await sleep(300);
    const first = await cdp.evaluate(readBack);
    check(await cdp.evaluate(`document.getElementById('qrPart').textContent.startsWith('1 / 2 枚目')`), '1 / 2 枚目');
    await sleep(1700);
    const second = await cdp.evaluate(readBack);
    check(await cdp.evaluate(`document.getElementById('qrPart').textContent.startsWith('2 / 2 枚目')`), '1.5 秒後に 2 / 2 枚目');
    const d1 = Codec.decodeBatch(first || ''), d2 = Codec.decodeBatch(second || '');
    check(d1.ok && d2.ok && d1.batch.members.length === 2 && d2.batch.members.length === 2 && d1.batch.groupId === d2.batch.groupId && d1.batch.partIndex === 0 && d2.batch.partIndex === 1,
      '2 枚とも読み戻せて、2 人ずつ・同じグループ ID');
    await cdp.screenshot(path.join(TMP, 'shot_4_batch_part2.png'));
    await cdp.evaluate(`document.getElementById('qrClose').click()`);
    await cdp.evaluate(`document.getElementById('dialogCancel').click()`);
    await cdp.evaluate(`(() => { const s = document.getElementById('setMax'); s.value = '4'; s.dispatchEvent(new Event('change')); })()`);

    console.log('== 新しいグループ');
    await cdp.evaluate(`document.querySelector('#groups button.add').click()`);
    check((await cdp.evaluate(MEMBERS_JS)).length === 0, '新しいグループは空');
    check(await cdp.evaluate(`document.querySelectorAll('#groups button:not(.add)').length === 2`), 'グループが 2 つ');
    await cdp.evaluate(`document.querySelector('#groups button:not(.add)').click()`);
    check((await cdp.evaluate(MEMBERS_JS)).length === 4, '元のグループに戻ると 4 人');

    console.log('== 消えるのは消去ボタン (確認つき) だけ');
    await cdp.evaluate(`document.querySelector('#members li button').click()`);
    check(await cdp.evaluate(`!document.getElementById('dialog').hidden && document.getElementById('dialogText').textContent.includes('yamada')`), '削除は確認が出る');
    await cdp.evaluate(`document.getElementById('dialogCancel').click()`);
    check((await cdp.evaluate(MEMBERS_JS)).length === 4, 'キャンセルなら消えない');
    await cdp.evaluate(`document.querySelector('#members li button').click()`);
    await cdp.evaluate(`document.getElementById('dialogOk').click()`);
    members = await cdp.evaluate(MEMBERS_JS);
    check(members.length === 3 && !members.includes('yamada|RCDR-26-A7K2N5'), '「削除する」で 1 人だけ消える: ' + JSON.stringify(members));
    await cdp.send('Page.reload', { ignoreCache: true });
    await sleep(1200);
    check((await cdp.evaluate(MEMBERS_JS)).length === 3, '削除した結果もリロード後に同じ');
    await cdp.screenshot(path.join(TMP, 'shot_5_after_delete.png'));
    await cdp.evaluate(`document.getElementById('settings').open = true`);
    await cdp.evaluate(`document.getElementById('clearAllBtn').click()`);
    check(await cdp.evaluate(`document.getElementById('dialogText').textContent.includes('すべてのグループ')`), 'すべて消去も確認が出る');
    await cdp.evaluate(`document.getElementById('dialogOk').click()`);
    check((await cdp.evaluate(MEMBERS_JS)).length === 0 && await cdp.evaluate(`document.querySelectorAll('#groups button:not(.add)').length === 1`), 'すべて消去で空のグループ 1 つに');

    console.log('== まとめ QR を閉じるときに「削除して閉じる」');
    // 2 つのグループに会員を入れておく (保存の API で直接。読取は上で確かめた)
    await cdp.evaluate(`(() => {
      const s = PreReceptionStore.createStore(localStorage);
      const sig = '8f1b9c4e2a7d3f6b5c8e1a9d2f4b6c8e';
      s.addMember({ user_code: 'RCDR-26-K0001', username: 'keep1', issued_at: 0, sig });
      s.newGroup();
      s.addMember({ user_code: 'RCDR-26-H0001', username: 'handed1', issued_at: 0, sig });
      s.addMember({ user_code: 'RCDR-26-H0002', username: 'handed2', issued_at: 0, sig });
    })()`);
    await cdp.send('Page.reload', { ignoreCache: true });
    await sleep(1200);
    check(JSON.stringify(await cdp.evaluate(MEMBERS_JS)) === JSON.stringify(['handed1|RCDR-26-H0001', 'handed2|RCDR-26-H0002']), '渡すグループ (2 人) を選んでいる');
    await cdp.evaluate(`document.getElementById('showBtn').click()`);
    await sleep(300);
    await cdp.evaluate(`document.getElementById('qrClose').click()`);
    check(await cdp.evaluate(`document.getElementById('dialogText').textContent.includes('グループ 2 (2 名)')`), '確認にグループの名前と人数が出る');
    await cdp.screenshot(path.join(TMP, 'shot_6_close_dialog.png'));
    await cdp.evaluate(`document.getElementById('dialogOk').click()`);
    check(await cdp.evaluate(`document.getElementById('qrOverlay').hidden && document.getElementById('dialog').hidden`), '「削除して閉じる」で閉じる');
    check(await cdp.evaluate(`document.querySelectorAll('#groups button:not(.add)').length === 1`), '渡したグループだけ消える (グループが 1 つに)');
    check(JSON.stringify(await cdp.evaluate(MEMBERS_JS)) === JSON.stringify(['keep1|RCDR-26-K0001']), '残りのグループの会員はそのまま');
    check(await cdp.evaluate(`document.getElementById('scanMsg').textContent.includes('グループ 2 を削除しました')`), '削除したことを知らせる');
    await cdp.send('Page.reload', { ignoreCache: true });
    await sleep(1200);
    check(JSON.stringify(await cdp.evaluate(MEMBERS_JS)) === JSON.stringify(['keep1|RCDR-26-K0001']), 'リロード後も同じ');
    await cdp.screenshot(path.join(TMP, 'shot_7_after_close_delete.png'));

    console.log('== Service Worker / 回線なし');
    const sw = await cdp.evaluate(`navigator.serviceWorker.getRegistration().then(r => !!(r && (r.active || r.installing || r.waiting)))`);
    check(sw, 'Service Worker が登録されている');
    const cached = await cdp.evaluate(`caches.keys().then(async ks => { const k = ks.find(x => x.startsWith('prereception-')); if (!k) return -1; return (await (await caches.open(k)).keys()).length; })`);
    check(cached >= 13, 'アプリ一式がキャッシュに入っている (' + cached + ' 件)');
    check(cdp.consoleErrors.length === 0, 'ここまで画面のエラーなし' + (cdp.consoleErrors.length ? ': ' + cdp.consoleErrors.join(' / ') : ''));
    await cdp.send('Network.enable');
    if (server) server.down = true;
    await cdp.send('Network.emulateNetworkConditions', { offline: true, latency: 0, downloadThroughput: 0, uploadThroughput: 0 });
    await cdp.send('Page.reload', {});
    await sleep(1500);
    check(await cdp.evaluate(`!!document.getElementById('camBtn') && document.getElementById('ver').textContent.startsWith('v')`), '回線なしでも開ける');
    check(JSON.stringify(await cdp.evaluate(MEMBERS_JS)) === JSON.stringify(['keep1|RCDR-26-K0001']), '回線なしでも一覧が出る');
    if (server) {
      await cdp.evaluate(`document.getElementById('settings').open = true`);
      await cdp.evaluate(`document.getElementById('updateBtn').click()`);
      const said = await waitFor(cdp, `document.getElementById('updateInfo').textContent.includes('確認できませんでした')`, 15000);
      check(said, '回線なしで「最新版に更新」を押すと「確認できませんでした」: ' + await cdp.evaluate(`document.getElementById('updateInfo').textContent`));
      check(await cdp.evaluate(`!!document.getElementById('camBtn')`) && JSON.stringify(await cdp.evaluate(MEMBERS_JS)) === JSON.stringify(['keep1|RCDR-26-K0001']), '確認に失敗しても今の版のまま使える');
      server.down = false;
    }
    await cdp.send('Network.emulateNetworkConditions', { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
    cdp.consoleErrors.length = 0;   // 回線なしの間の「読み込めません」は想定どおり

    if (!EXTERNAL_URL) {
      const KEEP = JSON.stringify(['keep1|RCDR-26-K0001']);
      const cachesJs = `caches.keys().then(ks => ks.filter(k => k.startsWith('prereception-')).sort().join(','))`;
      const clearGuard = `sessionStorage.removeItem('prereception.applyAt')`;   // 「直前に切り替えた」の 30 秒の歯止めを外す

      console.log('== 版を上げる: 設定の「最新版に更新」');
      await cdp.send('Page.reload', {});
      await sleep(1500);
      const v0 = siteVersion(siteDir);
      check(await waitVersion(cdp, v0, 5000), '今の版 v' + v0 + ' で開いている');
      await cdp.evaluate(`document.getElementById('settings').open = true`);
      await cdp.evaluate(`document.getElementById('updateBtn').click()`);
      check(await waitFor(cdp, `document.getElementById('updateInfo').textContent.includes('最新の版です')`, 8000), '新しい版が無ければ「最新の版です」');
      setSiteVersion(siteDir, '9.9.1');
      await cdp.evaluate(`document.getElementById('updateBtn').click()`);
      check(await waitVersion(cdp, '9.9.1', 25000), '版を上げて「最新版に更新」→ 聞かずに v9.9.1 に切り替わる (配信は max-age=600 のまま)');
      await sleep(800);
      check(JSON.stringify(await cdp.evaluate(MEMBERS_JS)) === KEEP, '切り替えても一覧は残る');
      check(await cdp.evaluate(cachesJs) === 'prereception-9.9.1', '古い版のキャッシュは消えている: ' + await cdp.evaluate(cachesJs));

      console.log('== 版を上げる: 開いた直後 (未操作) は自動で切り替わる');
      await cdp.evaluate(clearGuard);
      setSiteVersion(siteDir, '9.9.2');
      await cdp.send('Page.navigate', { url: 'about:blank' });
      await sleep(300);
      await cdp.send('Page.navigate', { url: URL_BASE + 'index.html' });
      check(await waitVersion(cdp, '9.9.2', 25000), '開き直すだけで v9.9.2 に切り替わる');
      await sleep(800);
      check(JSON.stringify(await cdp.evaluate(MEMBERS_JS)) === KEEP, '自動で切り替わっても一覧は残る');

      console.log('== 版を上げる: 作業中は「新しい版があります」を出して待つ');
      await cdp.evaluate(clearGuard);
      await cdp.evaluate(`document.dispatchEvent(new Event('pointerdown'))`);   // 画面に触れた = 作業中
      setSiteVersion(siteDir, '9.9.3');
      await cdp.evaluate(`navigator.serviceWorker.getRegistration().then(r => r.update()).then(() => true)`);
      check(await waitFor(cdp, `!!document.querySelector('.banner.info button')`, 20000), '「新しい版があります」が出る');
      check(await cdp.evaluate(`document.getElementById('ver').textContent`) === 'v9.9.2', '作業中は勝手に切り替えない (v9.9.2 のまま)');
      await cdp.screenshot(path.join(TMP, 'shot_8_update_banner.png'));
      await cdp.evaluate(`document.querySelector('.banner.info button').click()`);
      check(await waitVersion(cdp, '9.9.3', 15000), '「更新する」で v9.9.3 に切り替わる');
      await sleep(800);
      check(JSON.stringify(await cdp.evaluate(MEMBERS_JS)) === KEEP, '切り替えても一覧は残る (3 回目)');
      check(await cdp.evaluate(cachesJs) === 'prereception-9.9.3', 'キャッシュは最新の版だけ');
    }

    check(cdp.consoleErrors.length === 0, '画面のエラーなし' + (cdp.consoleErrors.length ? ': ' + cdp.consoleErrors.join(' / ') : ''));
  } finally {
    if (cdp) cdp.close();
    chrome.kill();
    if (server) server.close();
  }

  console.log(`\npass=${pass} fail=${failures.length}  (スクリーンショット: ${TMP})`);
  for (const f of failures) console.log('  FAIL ' + f);
  process.exit(failures.length === 0 ? 0 : 1);
}

main().catch(e => { console.error(e); process.exit(1); });
