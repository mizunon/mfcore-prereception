// test.html から呼ぶ (CSP で inline script を禁じているので別ファイル)
(function () {
  'use strict';
  var summary = document.getElementById('summary');
  var list = document.getElementById('failures');
  document.getElementById('ver').textContent = 'v' + (self.APP_VERSION || '?');
  try {
    var result = self.PreReceptionTests.run(self.PreReceptionCodec, self.PreReceptionStore);
    summary.textContent = 'pass=' + result.pass + ' fail=' + result.failures.length;
    summary.className = 'msg ' + (result.failures.length === 0 ? 'ok' : 'err');
    result.failures.forEach(function (f) {
      var li = document.createElement('li');
      li.textContent = f;
      list.appendChild(li);
    });
  } catch (e) {
    summary.textContent = '検査が例外で止まりました: ' + (e && e.stack ? e.stack : e);
    summary.className = 'msg err';
  }
}());
