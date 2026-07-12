/* =====================================================================
   ピュアット週間予定表  クラウド同期モジュール  (puatto-sync.js)
   ---------------------------------------------------------------------
   Google スプレッドシート + Apps Script(GAS) をデータ保存先にして、
   複数の端末で同じ予定を共有します。

   ■ できること
     - 各端末の入力を、自動でスプレッドシートに保存（数百ミリ秒ごと）
     - 他の端末の変更を、5秒ごとに自動で取り込み
     - セル単位の差分同期（別々のマスの同時編集は消し合いません）

   ■ 使い方
     1) 付属の手順書に沿って GAS を「ウェブアプリ」として公開する
     2) 発行された URL を、画面右下の「同期」ピルをクリックして貼り付ける
        （または下の GAS_URL に直接記入してもOK）
   ===================================================================== */
(function () {
  'use strict';
  if (window.__puattoSync) return;            // 二重読み込み防止

  // ▼▼ ここに GAS ウェブアプリの URL を貼り付けてもOK（右下ピルからでも設定可）▼▼
  var GAS_URL = '';
  // ▲▲ 例: 'https://script.google.com/macros/s/AKfy..../exec' ▲▲

  var URL_KEY   = 'puatto-sync-url';
  var PREFIX    = 'puatto-';
  var NO_SYNC   = { 'puatto-session': 1, 'puatto-sync-url': 1 }; // 端末ごと・同期しない
  var POLL_MS   = 5000;
  var PUSH_MS   = 700;

  function getUrl() {
    try { return (localStorage.getItem(URL_KEY) || GAS_URL || '').trim(); } catch (e) { return GAS_URL; }
  }

  // ---- 元の localStorage メソッドを退避 --------------------------------
  var _set = localStorage.setItem.bind(localStorage);
  var _rem = localStorage.removeItem.bind(localStorage);

  var snapshot = {};          // key -> 前回把握したオブジェクト（差分計算用）
  var pending  = {};          // key -> { set:{field:val}, del:[field] }
  var applying = false;       // pull適用中の再送を防ぐ
  var pushTimer = null;
  var status = 'idle';        // idle | ok | offline | error | unset

  function parse(v) { try { return v ? JSON.parse(v) : {}; } catch (e) { return {}; } }

  function shouldSync(key) { return key && key.indexOf(PREFIX) === 0 && !NO_SYNC[key]; }

  // 初期スナップショット
  function initSnapshot() {
    try {
      for (var i = 0; i < localStorage.length; i++) {
        var k = localStorage.key(i);
        if (shouldSync(k)) snapshot[k] = parse(localStorage.getItem(k));
      }
    } catch (e) {}
  }

  // ---- 差分計算（トップレベルのフィールド単位）------------------------
  function diff(oldObj, newObj) {
    var set = {}, del = [], changed = false;
    for (var k in newObj) {
      if (JSON.stringify(newObj[k]) !== JSON.stringify(oldObj[k])) { set[k] = newObj[k]; changed = true; }
    }
    for (var k2 in oldObj) {
      if (!(k2 in newObj)) { del.push(k2); changed = true; }
    }
    return changed ? { set: set, del: del } : null;
  }

  function queuePush(key, d) {
    var p = pending[key] || (pending[key] = { set: {}, del: [] });
    for (var f in d.set) p.set[f] = d.set[f];
    d.del.forEach(function (f) { if (p.del.indexOf(f) < 0) p.del.push(f); delete p.set[f]; });
    schedulePush();
  }

  function schedulePush() {
    if (pushTimer) return;
    pushTimer = setTimeout(flushPush, PUSH_MS);
  }

  function flushPush() {
    pushTimer = null;
    var url = getUrl();
    if (!url) { setStatus('unset'); return; }
    var keys = Object.keys(pending);
    if (!keys.length) return;
    var ops = keys.map(function (k) { return { key: k, set: pending[k].set, del: pending[k].del }; });
    pending = {};
    fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' }, // preflight回避
      body: JSON.stringify({ action: 'push', ops: ops })
    }).then(function () { setStatus('ok'); })
      .catch(function () {
        setStatus('offline');
        // 失敗分を戻して再送
        ops.forEach(function (op) { queuePush(op.key, { set: op.set, del: op.del }); });
      });
  }

  // ---- setItem / removeItem を横取り ----------------------------------
  localStorage.setItem = function (key, value) {
    _set(key, value);
    if (applying || !shouldSync(key)) return;
    var next = parse(value);
    var prev = snapshot[key] || {};
    var d = diff(prev, next);
    snapshot[key] = next;
    if (d) queuePush(key, d);
  };
  localStorage.removeItem = function (key) {
    _rem(key);
    if (applying || !shouldSync(key)) return;
    var prev = snapshot[key] || {};
    var del = Object.keys(prev);
    snapshot[key] = {};
    if (del.length) queuePush(key, { set: {}, del: del });
  };

  // ---- Pull（JSONPでCORSを回避）--------------------------------------
  var jsonpN = 0;
  function pull() {
    var url = getUrl();
    if (!url) { setStatus('unset'); return; }
    var cb = '__puattoJsonp' + (++jsonpN);
    var s = document.createElement('script');
    var timer = setTimeout(function () { cleanup(); setStatus('offline'); }, 12000);
    function cleanup() { clearTimeout(timer); delete window[cb]; if (s.parentNode) s.parentNode.removeChild(s); }
    window[cb] = function (resp) {
      cleanup();
      try { applyRemote((resp && resp.data) || {}); setStatus('ok'); }
      catch (e) { setStatus('error'); }
    };
    s.onerror = function () { cleanup(); setStatus('offline'); };
    s.src = url + (url.indexOf('?') < 0 ? '?' : '&') + 'action=pull&callback=' + cb + '&t=' + Date.now();
    document.head.appendChild(s);
  }

  function applyRemote(data) {
    var changed = false;
    applying = true;
    try {
      for (var key in data) {
        if (!shouldSync(key)) continue;
        var remote = data[key] || {};
        // まだ送信していないローカル変更(pending)は remote に上書きされないよう再適用
        var pend = pending[key];
        var merged = remote;
        if (pend) {
          merged = {};
          for (var rk in remote) merged[rk] = remote[rk];
          for (var f in pend.set) merged[f] = pend.set[f];
          for (var di = 0; di < pend.del.length; di++) delete merged[pend.del[di]];
        }
        var local = parse(localStorage.getItem(key));
        if (JSON.stringify(merged) !== JSON.stringify(local)) {
          _set(key, JSON.stringify(merged));
          changed = true;
        }
        snapshot[key] = merged;
      }
    } finally { applying = false; }
    if (changed) window.dispatchEvent(new Event('puatto-synced'));
  }

  // ---- 右下ステータスピル --------------------------------------------
  var pill, dot, label;
  function buildPill() {
    pill = document.createElement('div');
    pill.setAttribute('data-puatto-sync', '1');
    pill.style.cssText = 'position:fixed;right:14px;bottom:14px;z-index:99999;display:flex;align-items:center;gap:7px;' +
      'background:#fff;border:1px solid #E2DFD6;border-radius:999px;padding:6px 12px 6px 10px;' +
      'box-shadow:0 4px 14px rgba(60,55,40,.14);font:600 11.5px/1 -apple-system,"Noto Sans JP",sans-serif;' +
      'color:#3a403c;cursor:pointer;user-select:none';
    dot = document.createElement('span');
    dot.style.cssText = 'width:8px;height:8px;border-radius:50%;background:#c2c6c0;flex-shrink:0';
    label = document.createElement('span');
    pill.appendChild(dot); pill.appendChild(label);
    pill.title = 'クリックで同期先(スプレッドシート)のURLを設定';
    pill.addEventListener('click', promptUrl);
    // 印刷時は隠す
    pill.className = 'noprint';
    var mq = window.matchMedia('print');
    (document.body || document.documentElement).appendChild(pill);
    renderStatus();
  }

  function promptUrl() {
    var cur = getUrl();
    var v = window.prompt(
      'Google Apps Script（ウェブアプリ）の URL を貼り付けてください。\n' +
      '※ 末尾が /exec の URL を貼ってください。\n' +
      '例: https://script.google.com/macros/s/****/exec\n\n' +
      '空欄で保存すると同期を停止します。',
      cur
    );
    if (v === null) return;
    v = v.trim();
    // ブラウザのアドレス欄からコピーした echo URL は誤り → 注意
    if (v && v.indexOf('/exec') < 0) {
      if (v.indexOf('script.googleusercontent.com') > -1 || v.indexOf('/echo') > -1) {
        window.alert(
          'これはブラウザで開いた時の URL（echo）で、登録には使えません。\n\n' +
          'Apps Script の「デプロイを管理」を開き、末尾が /exec の\n' +
          '「ウェブアプリ URL」をコピーして貼り付けてください。'
        );
        return;
      }
      if (!window.confirm('末尾が /exec ではありません。このまま登録しますか？')) return;
    }
    try { if (v) localStorage.setItem(URL_KEY, v); else localStorage.removeItem(URL_KEY); } catch (e) {}
    if (v) { setStatus('idle'); pull(); flushPush(); }
    else setStatus('unset');
  }

  function setStatus(s) { status = s; renderStatus(); }
  function renderStatus() {
    if (!dot) return;
    var map = {
      idle:    ['#d8b24a', '接続中…'],
      ok:      ['#3E8F86', '同期中'],
      offline: ['#C0392B', 'オフライン'],
      error:   ['#C0392B', '同期エラー'],
      unset:   ['#b0704a', '同期未設定']
    };
    var m = map[status] || map.idle;
    dot.style.background = m[0];
    label.textContent = m[1];
  }

  // ---- 起動 -----------------------------------------------------------
  function start() {
    initSnapshot();
    buildPill();
    if (getUrl()) { pull(); } else { setStatus('unset'); }
    setInterval(function () { if (getUrl()) pull(); }, POLL_MS);
    // 予定を書いた直後に他端末へ早く出す
    window.addEventListener('beforeunload', flushPush);
  }

  window.__puattoSync = { pull: pull, push: flushPush, setUrl: function (u) { try { localStorage.setItem(URL_KEY, u); } catch (e) {} pull(); } };

  if (document.body) start();
  else document.addEventListener('DOMContentLoaded', start);
})();
