/*
 * 事前受付: オフラインで動かすための Service Worker。
 * アプリ一式を版ごとのキャッシュに入れ、以後はキャッシュから返す (回線が無くても開ける)。
 * 新しい版は入れて待機し、ページからの合図 (SKIP_WAITING) で切り替える。
 * 読み取ったリストは localStorage にあり、このキャッシュとは無関係 (版を上げても消えない)。
 *
 * 版はこのファイルに直接書く (version.js と同じ値。test/run_node.js が一致を検査する)。
 * ブラウザは「このファイルのバイト列が変わったか」で更新を見つける。版を version.js だけに置いて
 * importScripts で読むと、このファイルは変わらないので、読み込んだファイルの HTTP キャッシュ
 * (公開先は 10 分) が切れるまで更新が見つからない (v1.0.1 で iPhone が更新されなかった)。
 */
var VERSION = '1.0.2';

var CACHE = 'prereception-' + VERSION;
var ASSETS = [
  './',
  'index.html',
  'app.css',
  'app.js',
  'codec.js',
  'store.js',
  'version.js',
  'manifest.webmanifest',
  'vendor/jsQR.js',
  'vendor/qrcode.js',
  'icons/icon-180.png',
  'icons/icon-192.png',
  'icons/icon-512.png'
];

self.addEventListener('install', function (event) {
  event.waitUntil(caches.open(CACHE).then(function (cache) {
    // HTTP キャッシュを通さずに取り直す (古いファイルを新しい版のキャッシュに入れない)
    return cache.addAll(ASSETS.map(function (url) { return new Request(url, { cache: 'reload' }); }));
  }));
});

self.addEventListener('activate', function (event) {
  event.waitUntil(caches.keys().then(function (keys) {
    return Promise.all(keys.filter(function (k) {
      return k.indexOf('prereception-') === 0 && k !== CACHE;
    }).map(function (k) { return caches.delete(k); }));
  }).then(function () { return self.clients.claim(); }));
});

self.addEventListener('message', function (event) {
  if (event.data && event.data.type === 'SKIP_WAITING') self.skipWaiting();
});

self.addEventListener('fetch', function (event) {
  if (event.request.method !== 'GET') return;
  var url = new URL(event.request.url);
  if (url.origin !== self.location.origin) return;
  event.respondWith(caches.open(CACHE).then(function (cache) {
    return cache.match(event.request, { ignoreSearch: true }).then(function (hit) {
      return hit || fetch(event.request);
    });
  }));
});
