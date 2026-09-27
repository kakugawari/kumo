/* ブラウザで実際に動かす見張り。 node browser-test.js (要 playwright)
   手もとの chromium では iOS の「ホーム画面から開くと下に帯」は起きないので、
   その原因になる作り(fixed で置く・窓の高さを使う)が戻っていないかを見る */
const http = require('http'), fs = require('fs'), path = require('path');
let pw; try { pw = require('playwright'); } catch (e) {
  pw = require(require('child_process').execSync('npm root -g').toString().trim() + '/playwright'); }

const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.png': 'image/png', '.webmanifest': 'application/manifest+json' };
const srv = http.createServer((q, r) => {
  const f = path.join(__dirname, decodeURIComponent(q.url.split('?')[0]).replace(/\/$/, '/index.html'));
  fs.readFile(f, (e, d) => { if (e) { r.writeHead(404); return r.end(); }
    r.writeHead(200, { 'Content-Type': TYPES[path.extname(f)] || 'application/octet-stream' }); r.end(d); });
});

let fails = 0;
// 線引きは、直す前と後を6回ずつ測って、その間に置いた
const HIKOU_EVEN = 0.40;   // 直す前 0.18〜0.36 / 今 0.45〜0.81
function check(name, ok, info) { console.log((ok ? 'ok   ' : 'FAIL ') + name + (info ? '  ' + info : '')); if (!ok) fails++; }

(async () => {
  await new Promise(r => srv.listen(0, r));
  const url = 'http://localhost:' + srv.address().port + '/';
  const b = await pw.chromium.launch();
  const ctx = await b.newContext({ viewport: { width: 430, height: 932 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, serviceWorkers: 'block' });
  const p = await ctx.newPage();
  const errs = []; p.on('pageerror', e => errs.push(e.message));
  await p.goto(url); await p.waitForTimeout(500);

  // --- タイトル ---
  const t = await p.evaluate(async () => {
    const bg = document.querySelector('#title .bg'), logo = document.querySelector('#title .logo-art');
    await bg.decode(); await logo.decode();
    const r = bg.getBoundingClientRect(), lr = logo.getBoundingClientRect();
    const btns = ['tStart', 'tHow', 'tSet'].map(id => { const e = document.getElementById(id), b = e.getBoundingClientRect(), cs = getComputedStyle(e);
      return { text: e.textContent.trim(), color: cs.color, top: b.top, bottom: b.bottom, left: b.left, right: b.right }; });
    return { shown: getComputedStyle(document.getElementById('title')).display !== 'none',
      ratio: (bg.naturalWidth / bg.naturalHeight) / (r.width / r.height),
      logoRatio: (logo.naturalWidth / logo.naturalHeight) / (lr.width / lr.height), logoBottom: lr.bottom, btns };
  });
  check('開くとタイトルが出る', t.shown);
  check('タイトルの空が縦横比を保って敷かれる (差 1% 未満)', Math.abs(t.ratio - 1) < 0.01, t.ratio.toFixed(4));
  check('題字が縦横比を保って置かれる (差 1% 未満)', Math.abs(t.logoRatio - 1) < 0.01, t.logoRatio.toFixed(4));
  // ボタンは絵ではなく本物: 名前が字で出ていて、画面の中にあり、題字と重ならない
  check('ボタンの名前が字で出ている', t.btns.map(b => b.text).join('/') === 'はじめる/あそびかた/設定' && t.btns.every(b => b.color !== 'rgba(0, 0, 0, 0)'), t.btns.map(b => b.text).join('/'));
  check('ボタンが画面の中にあり、題字と重ならない', t.btns.every(b => b.left >= 0 && b.right <= 430 && b.bottom <= 932 && b.top > t.logoBottom), JSON.stringify(t.btns.map(b => [Math.round(b.top), Math.round(b.bottom)])));
  // タイトルの上から空に触れても、雲は置かれない (指はタイトルが受け止める)
  await p.touchscreen.tap(215, 300); await p.waitForTimeout(100);
  const n0 = await p.evaluate(() => window.__app.strokes().length);
  check('タイトルの間は、空に触れても雲が置かれない', n0 === 0, 'n=' + n0);
  await p.tap('#tSet'); await p.tap('#setSound');
  const snd = await p.evaluate(() => [document.getElementById('setSound').textContent, document.getElementById('soundState').textContent]);
  check('設定の環境音と、メニューの表示がそろう', snd[0] === '入' && snd[1] === '環境音 — 入', JSON.stringify(snd));
  await p.tap('#setSound'); await p.tap('#setClose');
  await p.tap('#tStart'); await p.waitForTimeout(900);
  await p.touchscreen.tap(215, 300); await p.waitForTimeout(100);
  const after = await p.evaluate(() => ({ disp: getComputedStyle(document.getElementById('title')).display, n: window.__app.strokes().length }));
  check('はじめるでタイトルが消え、空に触れると雲が置ける', after.disp === 'none' && after.n > 0, JSON.stringify(after));
  const sw = fs.readFileSync(path.join(__dirname, 'sw.js'), 'utf8');
  check('絵をすべて、オフライン用に先読みする', ['title-bg.jpg', 'title-logo.png', 'tools.webp', 'sea-gold.jpg', 'sea-day.jpg', 'sea-night.jpg'].every(f => sw.includes("'./" + f + "'")));

  // --- プレイ画面の空は、タイトルの空と同じ世界 (雲の上) ---
  const sky = await p.evaluate(async () => {
    const bg = document.querySelector('#title .bg'); await bg.decode();
    const c = document.createElement('canvas'); c.width = 430; c.height = 932; const g = c.getContext('2d');
    g.drawImage(bg, 0, 0, 430, 932);
    const cv = document.getElementById('cv'), cg = cv.getContext('2d'), k = cv.width / 430;
    // 雲や太陽が無い左端の帯で、高さごとの色を比べる
    const band = (ctx, y, sc) => { const d = ctx.getImageData(Math.round(10 * sc), Math.round(y * 932 * sc), Math.round(30 * sc), Math.round(6 * sc)).data;
      let r = 0, gg = 0, bb = 0, n = d.length / 4; for (let i = 0; i < d.length; i += 4) { r += d[i]; gg += d[i + 1]; bb += d[i + 2]; } return [r / n, gg / n, bb / n]; };
    const dist = (a, b) => Math.round(Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]));
    const ys = [0.08, 0.2, 0.3];
    const d = ys.map(y => dist(band(g, y, 1), band(cg, y, k)));
    // 1コマで、画面いっぱいの層に丸いグラデーションを何回作るか (太陽の照りを毎コマ塗っていないか)
    const C = CanvasRenderingContext2D.prototype, rg = C.createRadialGradient; let n = 0;
    C.createRadialGradient = function () { if (this === cg) n++; return rg.apply(this, arguments); };
    await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
    n = 0; await new Promise(r => requestAnimationFrame(r)); const per = n;
    C.createRadialGradient = rg;
    return { theme: window.__app.S.theme, d, per, sunLabel: document.querySelector('[data-t=sun] small').textContent };
  });
  check('はじめの空は「雲の上」', sky.theme === 'kumoue', sky.theme);
  check('プレイ画面の空の色が、タイトルの空に近い (上・中)', sky.d.every(v => v < 60), JSON.stringify(sky.d));
  check('雲の上の空で、太陽が月にならない', sky.sunLabel === '太陽', sky.sunLabel);
  check('太陽の照りを毎コマ塗らない (空の下地に焼き付け)', sky.per <= 1, 'radialGradient/コマ=' + sky.per);

  // --- タップした所に雲ができる (キャンバスが画面の上端からずれて置かれていても) ---
  const tp = await p.evaluate(async () => {
    const cv = document.getElementById('cv'), A = window.__app, out = [];
    const w = document.getElementById('windR'); w.value = 0; w.dispatchEvent(new Event('input'));
    for (const shift of [0, 40]) {
      document.body.style.paddingTop = '0'; cv.style.top = shift + 'px'; cv.style.height = (932 - shift) + 'px';
      window.dispatchEvent(new Event('resize')); await new Promise(r => requestAnimationFrame(r));
      document.querySelector('[data-t=cumulus]').click();
      const x = 215, y = 400, t = new Touch({ identifier: 1, target: cv, clientX: x, clientY: y });
      cv.dispatchEvent(new TouchEvent('touchstart', { touches: [t], changedTouches: [t], bubbles: true, cancelable: true }));
      cv.dispatchEvent(new TouchEvent('touchend', { touches: [], changedTouches: [t], bubbles: true, cancelable: true }));
      const s = A.strokes()[A.strokes().length - 1], r = cv.getBoundingClientRect();
      // 雲の中心 (キャンバスの中の位置) を、画面の位置に戻して、指との差を見る
      out.push(Math.round(r.top + s.y - y));
    }
    cv.style.top = ''; cv.style.height = ''; window.dispatchEvent(new Event('resize'));
    document.getElementById('clearBtn').click(); document.getElementById('clearBtn').click();
    return out;
  });
  check('タップした所に雲ができる (キャンバスが 40px 下に置かれていても)', tp.every(v => Math.abs(v) <= 1), '指との縦のずれ=' + JSON.stringify(tp));

  // --- 写真から (色と太陽を取る / 下絵にする) ---
  // 確かめ用の写真 (3:4 の縦長。画面に合わせると左右が切られる): 上 #1a3d7a → 中 #5f8fc8 → 地平線 #f0c89a、
  // 右上に光のにじむ太陽、左に雲 (真っ白な回と、少し灰色の回)、下 28% は暗い地面とビル
  const photo = async (white) => { const b64 = await p.evaluate((white) => { const c = document.createElement('canvas'); c.width = 600; c.height = 800; const g = c.getContext('2d');
      const gr = g.createLinearGradient(0, 0, 0, 576); gr.addColorStop(0, '#1a3d7a'); gr.addColorStop(0.5, '#5f8fc8'); gr.addColorStop(1, '#f0c89a'); g.fillStyle = gr; g.fillRect(0, 0, 600, 576);
      const sg = g.createRadialGradient(420, 200, 0, 420, 200, 160); sg.addColorStop(0, 'rgba(255,250,235,1)'); sg.addColorStop(0.15, 'rgba(255,240,210,.85)'); sg.addColorStop(1, 'rgba(255,230,200,0)');
      g.fillStyle = sg; g.fillRect(0, 0, 600, 576); g.fillStyle = '#fffef8'; g.beginPath(); g.arc(420, 200, 22, 0, 7); g.fill();
      g.fillStyle = white ? '#ffffff' : '#f3f3f1'; for (const [x, y, r] of [[120, 300, 40], [160, 290, 50], [200, 305, 38], [380, 420, 30], [420, 410, 40]]) { g.beginPath(); g.arc(x, y, r, 0, 7); g.fill(); }
      g.fillStyle = '#2a2420'; g.fillRect(0, 576, 600, 224); for (let x = 0; x < 600; x += 40) g.fillRect(x, 576 - ((x * 7) % 90), 30, 100);
      return c.toDataURL('image/png').split(',')[1]; }, white);
    const f = path.join(require('os').tmpdir(), 'kumo-photo-' + (white ? 'w' : 'g') + '.png'); fs.writeFileSync(f, Buffer.from(b64, 'base64')); return f; };
  const pickPhoto = async (btn, file) => { await p.evaluate(() => document.getElementById('sheet').classList.add('open'));
    const [fc] = await Promise.all([p.waitForEvent('filechooser'), p.click(btn)]); await fc.setFiles(file); await p.waitForTimeout(700); };
  const hexd = (a, b) => { const h = x => [1, 3, 5].map(i => parseInt(x.slice(i, i + 2), 16)); const A = h(a), B = h(b); return Math.round(Math.hypot(A[0] - B[0], A[1] - B[1], A[2] - B[2])); };
  const ph = {};
  for (const white of [false, true]) {
    await pickPhoto('#phColor', await photo(white));
    ph[white ? 'w' : 'g'] = await p.evaluate(() => { const S = window.__app.S; return { theme: S.theme, top: S.top, hz: S.hz, sx: S.sunX, sy: S.sunY, sheet: document.getElementById('sheet').classList.contains('open') }; });
  }
  // 太陽の正解は、写真を画面に合わせて切ったときの位置: 横 (420*932/800 - 134.5)/430 = 0.826、縦 0.25
  check('写真から空の色を取る (上の色が写真に近く、地平線ぎわは地面の暗い色でなく明るい)', ph.g.theme === 'photo' && hexd(ph.g.top, '#1a3d7a') < 30 && hexd(ph.g.hz, '#2a2420') > 150, JSON.stringify(ph.g));
  check('写真の太陽の位置に太陽を置く (雲が真っ白に飛んでいても、雲と取り違えない)', ['g', 'w'].every(k => Math.abs(ph[k].sx - 0.826) < 0.03 && Math.abs(ph[k].sy - 0.25) < 0.03), ['g', 'w'].map(k => ph[k].sx.toFixed(3) + ',' + ph[k].sy.toFixed(3)).join(' / '));
  check('写真を選んだら、結果が見えるようシートを閉じる', !ph.g.sheet && !ph.w.sheet);
  // 下絵: 空に写真が敷かれ、保存する絵には入らず、外すと消える。測るのは写真の雲 (160,290) が画面に来る所 (52,338)
  const skyPx = () => p.evaluate(() => { const c = document.getElementById('cv'), k = c.width / 430; return [...c.getContext('2d').getImageData(Math.round(52 * k), Math.round(338 * k), 1, 1).data].slice(0, 3); });
  const hiddenBefore = await p.evaluate(() => ['phOff', 'phRow'].map(id => getComputedStyle(document.getElementById(id)).display));
  check('下絵を敷く前は「下絵を外す」と「濃さ」を出さない', hiddenBefore.every(d => d === 'none'), JSON.stringify(hiddenBefore));
  const skyBefore = await skyPx();
  await pickPhoto('#phUnder', await photo(true)); await p.waitForTimeout(200);
  const withU = await skyPx();
  const snap = await p.evaluate(async () => { const cv = document.getElementById('cv'), k = cv.width / 430; document.getElementById('saveBtn').click();
    const im = new Image(); im.src = document.getElementById('veilImg').src; await im.decode(); document.getElementById('veilClose').click();
    const c = document.createElement('canvas'); c.width = cv.width; c.height = cv.height; const g = c.getContext('2d'); g.drawImage(im, 0, 0);
    return [...g.getImageData(Math.round(52 * k), Math.round(338 * k), 1, 1).data].slice(0, 3); });
  await p.evaluate(() => document.getElementById('phOff').click()); await p.waitForTimeout(200);
  const off = await skyPx(); const has = await p.evaluate(() => !!window.__app.under());
  const dd = (a, b) => Math.round(Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]));
  check('下絵にすると、写真 (白い雲) が空に薄く敷かれる', dd(skyBefore, withU) > 40, JSON.stringify([skyBefore, withU]));
  check('保存する絵には下絵を入れない', dd(snap, skyBefore) < 12, JSON.stringify([snap, skyBefore]));
  check('下絵を外すと消える', !has && dd(off, skyBefore) < 12, JSON.stringify(off));
  await p.evaluate(() => document.querySelector('.preset[data-k=kumoue]').click());

  // --- なぞって描く雲 (ハンコのように並べない) ---
  const br = await p.evaluate(async () => {
    const cv = document.getElementById('cv'), A = window.__app, out = {};
    const w = document.getElementById('windR'); w.value = 0; w.dispatchEvent(new Event('input'));
    function T(type, x, y) { const t = new Touch({ identifier: 1, target: cv, clientX: x, clientY: y });
      cv.dispatchEvent(new TouchEvent(type, { touches: /end|cancel/.test(type) ? [] : [t], changedTouches: [t], bubbles: true, cancelable: true })); }
    const seedRand = (sd) => { let s = sd; Math.random = () => { s = (s * 1103515245 + 12345) % 2147483648; return s / 2147483648; }; };
    const rnd0 = Math.random;
    // 同じ乱数・同じ線を、指の動きの知らせ 60 回 (ゆっくり) と 6 回 (速く) でなぞる
    async function draw(tool, n, keepOpen) { document.querySelector('[data-t=' + tool + ']').click(); seedRand(777);
      T('touchstart', 60, 420); for (let i = 1; i <= n; i++) T('touchmove', 60 + 310 * i / n, 420);
      const s = A.strokes()[A.strokes().length - 1];
      if (keepOpen) { await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))); return s; }
      T('touchend', 0, 0); Math.random = rnd0; return s; }
    const cover = s => { const d = s.pc.lit.data; let c = 0; for (let i = 3; i < d.length; i += 4) if (d[i] > 128) c++; return c / (s.pc.q * s.pc.q); };
    // なぞった線に沿って、横幅の中でいちばん濃い所の並び。いちばん薄い所 ÷ 真ん中
    const along = s => { const pc = s.pc, d = pc.lit.data, prof = [];
      for (let x = 100; x <= 330; x += 3) { let mx = 0; for (let y = 420 - s.R * 0.9; y <= 420 + s.R * 0.4; y += 1.5) {
        const X = Math.round((x - pc.ox) * pc.q), Y = Math.round((y - pc.oy) * pc.q); if (X < 0 || Y < 0 || X >= pc.w || Y >= pc.h) continue; mx = Math.max(mx, d[(Y * pc.w + X) * 4 + 3]); } prof.push(mx); }
      const so = prof.slice().sort((a, b) => a - b); return so[0] / (so[so.length >> 1] || 1); };
    for (const tool of ['cumulus', 'cirrus']) {
      const n0 = A.strokes().length, slow = await draw(tool, 60), n1 = A.strokes().length;
      const cs = cover(slow), es = along(slow); document.getElementById('undoBtn').click();
      const fast = await draw(tool, 6), cf = cover(fast), ef = along(fast); document.getElementById('undoBtn').click();
      out[tool] = { perDrag: n1 - n0, ratio: +(cf / cs).toFixed(2), evenSlow: +es.toFixed(2), evenFast: +ef.toFixed(2) };
    }
    // なぞっている最中にも雲が見える (指を離す前に、画面の線の上が変わっている)
    const k = cv.width / 430, px = () => [...cv.getContext('2d').getImageData(Math.round(215 * k), Math.round(405 * k), 1, 1).data].slice(0, 3);
    // 直前に元に戻した雲が、まだ描き直し前のコマに残っていることがある。描き直されてから測る
    await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
    const before = px(); const live = await draw('cumulus', 30, true); await new Promise(r => setTimeout(r, 300)); const during = px();
    T('touchend', 0, 0); Math.random = rnd0; document.getElementById('undoBtn').click();
    out.liveDiff = Math.abs(before[0] - during[0]) + Math.abs(before[1] - during[1]) + Math.abs(before[2] - during[2]);
    return out;
  });
  check('ひとなぞりで雲は 1 つ (綿雲・筋雲)', br.cumulus.perDrag === 1 && br.cirrus.perDrag === 1, JSON.stringify([br.cumulus.perDrag, br.cirrus.perDrag]));
  check('指の速さで雲の量が変わらない (速く ÷ ゆっくり 0.85〜1.18)', ['cumulus', 'cirrus'].every(t => br[t].ratio >= 0.85 && br[t].ratio <= 1.18), JSON.stringify([br.cumulus.ratio, br.cirrus.ratio]));
  check('速くなぞっても切れ目ができない (線に沿った濃さ: 薄い所 ÷ 真ん中 > 0.45)', ['cumulus', 'cirrus'].every(t => br[t].evenFast > 0.45), JSON.stringify(br));
  check('なぞっている最中にも雲が見える', br.liveDiff > 30, '画面の差=' + br.liveDiff);

  // --- 雲の形と細かさ ---
  const cl = await p.evaluate(async () => {
    const cv = document.getElementById('cv'), A = window.__app;
    function T(type, x, y) { const t = new Touch({ identifier: 1, target: cv, clientX: x, clientY: y });
      cv.dispatchEvent(new TouchEvent(type, { touches: /end|cancel/.test(type) ? [] : [t], changedTouches: [t], bubbles: true, cancelable: true })); }
    function drag(tool, x0, y0, x1, y1) { document.querySelector('[data-t=' + tool + ']').click(); T('touchstart', x0, y0);
      for (let i = 1; i <= 12; i++) T('touchmove', x0 + (x1 - x0) * i / 12, y0 + (y1 - y0) * i / 12); T('touchend', 0, 0);
      return A.strokes().filter(s => s.t === tool && s.pc).pop(); }
    const out = {};
    // 筋雲は細かく作る (0.62 だとふちが階段状にガタついた)。なぞった向きに流れる
    const cv1 = drag('cirrus', 215, 150, 225, 500);
    out.cirrusQ = cv1.pc.q; out.cirrusTall = cv1.pc.bb.h / cv1.pc.bb.w;
    // 飛行機雲は途切れない: 中心の線に沿って濃さを測り、薄い所が無い
    const hk = drag('hikou', 60, 600, 380, 520);
    { const pc = hk.pc, a = hk.a, n = 60; let gaps = 0; const prof = [];
      // 先頭では2本のエンジンの跡が左右に分かれるので、真ん中の線ではなく、横幅の中でいちばん濃い所を見る。
      // 両端はわざと細く消しているので、真ん中 6 割だけを見る
      // ひとなぞりで 1 本の雲なので、なぞった線 (始点 hk.x,hk.y から 320 右・80 上) に沿って測る
      const ex = 320, ey = -80, a2 = Math.atan2(ey, ex), L2 = Math.hypot(ex, ey);
      for (let i = 12; i <= n - 12; i++) { const t = i / n; let mx = 0;
        for (let o = -0.08; o <= 0.08; o += 0.01) { const wx = hk.x + ex * t - Math.sin(a2) * hk.R * o, wy = hk.y + ey * t + Math.cos(a2) * hk.R * o;
          const x = Math.round((wx - pc.bb.x) * pc.q), y = Math.round((wy - pc.bb.y) * pc.q); mx = Math.max(mx, pc.D[y * pc.w + x] || 0); }
        if (!(mx > 0.1)) gaps++; prof.push(mx); }
      // 玉の連なりだと、線に沿って濃い・薄いが波打つ。いちばん薄い所 ÷ 真ん中の値
      const sorted = prof.slice().sort((p, q) => p - q);
      out.hikouGaps = gaps; out.hikouEven = sorted[0] / sorted[sorted.length >> 1]; }
    // 鱗雲は水玉ではなく、つながった鱗: 見えている画素のうち、いちばん大きなかたまりが占める割合
    document.querySelector('[data-t=scale]').click(); T('touchstart', 215, 320); T('touchend', 0, 0);
    { const sc = A.strokes().filter(s => s.t === 'scale' && s.pc).pop(), im = sc.pc.lit, w = im.width, h = im.height, d = im.data;
      const seen = new Uint8Array(w * h); let total = 0, best = 0;
      for (let k = 0; k < w * h; k++) if (d[k * 4 + 3] > 128) total++;
      for (let k = 0; k < w * h; k++) { if (seen[k] || d[k * 4 + 3] <= 128) continue; let n = 0; const st = [k]; seen[k] = 1;
        while (st.length) { const q = st.pop(); n++; const x = q % w, y = (q / w) | 0;
          for (const nb of [x > 0 ? q - 1 : -1, x < w - 1 ? q + 1 : -1, y > 0 ? q - w : -1, y < h - 1 ? q + w : -1])
            if (nb >= 0 && !seen[nb] && d[nb * 4 + 3] > 128) { seen[nb] = 1; st.push(nb); } }
        if (n > best) best = n; }
      out.scaleMain = Math.round(100 * best / total); }
    document.getElementById('clearBtn').click(); document.getElementById('clearBtn').click();
    return out;
  });
  check('筋雲は細かく作る (画面の点1つあたり 1 画素以上)', cl.cirrusQ >= 1, 'q=' + cl.cirrusQ);
  check('筋雲は、なぞった向きに流れる (縦になぞると縦長)', cl.cirrusTall > 0.9, '縦/横=' + cl.cirrusTall.toFixed(2));
  check('飛行機雲が途切れず、玉の連なりに見えない (線に沿った濃さのむら)', cl.hikouGaps === 0 && cl.hikouEven > HIKOU_EVEN, '薄い所=' + cl.hikouGaps + ' むら=' + cl.hikouEven.toFixed(2));
  check('鱗雲は水玉ではなく、ひとつながり (いちばん大きなかたまりが 4割以上)', cl.scaleMain >= 40, cl.scaleMain + '%');

  // --- 光の筋: 太陽についていき、雲の陰には差さない ---
  const ry = await p.evaluate(async () => {
    const cv = document.getElementById('cv'), A = window.__app, S = A.S;
    function T(type, x, y) { const t = new Touch({ identifier: 1, target: cv, clientX: x, clientY: y });
      cv.dispatchEvent(new TouchEvent(type, { touches: /end|cancel/.test(type) ? [] : [t], changedTouches: [t], bubbles: true, cancelable: true })); }
    const raf = () => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
    const w = document.getElementById('windR'); w.value = 0; w.dispatchEvent(new Event('input'));
    S.sunX = 0.5; S.sunY = 100 / 932; A.rebuild(); await raf();
    // 光の筋の重心を、太陽から見た位置で測る (太陽を動かしても、筋が同じ形のままついてくるか)
    function rayCentroid() { const c = A.rays(), g = c.getContext('2d'), d = g.getImageData(0, 0, c.width, c.height).data, k = c.width / 430;
      let sx = 0, sy = 0, n = 0; for (let y = 0; y < c.height; y += 4) for (let x = 0; x < c.width; x += 4) { const a = d[(y * c.width + x) * 4 + 3]; sx += x * a; sy += y * a; n += a; }
      return [sx / n / k - S.sunX * 430, sy / n / k - S.sunY * 932]; }
    // 筋が画面の外まで伸びると、切れ方で重心が動くので、画面に収まる短い筋で測る
    document.querySelector('[data-t=ray]').click(); T('touchstart', 190, 180); T('touchend', 0, 0);
    const c0 = rayCentroid();
    S.sunX = 0.8; S.sunY = 160 / 932; A.rebuild(); await raf();
    const c1 = rayCentroid();
    document.getElementById('undoBtn').click();
    // 太陽 (215,100) と、なぞった光のあいだの左側にだけ綿雲を置く。雲の先 (陰) と、左右で対になる所 (日なた) の光を比べる
    S.sunX = 0.5; S.sunY = 100 / 932; A.rebuild();
    document.querySelector('[data-t=cumulus]').click(); T('touchstart', 150, 280); T('touchend', 0, 0);
    document.querySelector('[data-t=ray]').click(); T('touchstart', 20, 620);
    for (let i = 1; i <= 30; i++) T('touchmove', 20 + i * 13, 620); T('touchend', 0, 0);
    await raf(); await raf();
    const L = A.raysLit(), lg = L.getContext('2d');
    function box(x, y) { const d = lg.getImageData(x - 8, y - 8, 16, 16).data; let s = 0; for (let i = 3; i < d.length; i += 4) s += d[i]; return s / (d.length / 4); }
    const shade = box(80, 470), sun = box(350, 470);
    document.getElementById('clearBtn').click(); document.getElementById('clearBtn').click();
    S.sunX = 0.80; S.sunY = 0.15; A.rebuild();
    return { move: Math.round(Math.hypot(c1[0] - c0[0], c1[1] - c0[1])), shade: Math.round(shade), sun: Math.round(sun) };
  });
  // 前の作りでは、置いた点を軸に筋が回った (太陽を 135pt 動かすと、重心が 100pt 以上ずれる)
  check('光の筋は太陽についていく (太陽から見た筋の重心のずれ 3pt 以下)', ry.move <= 3, 'ずれ=' + ry.move + 'pt');
  check('雲の陰には光が差さない (雲の先 ÷ 日なた 0.5 未満)', ry.sun > 10 && ry.shade / ry.sun < 0.5, '陰' + ry.shade + ' / 日なた' + ry.sun);

  // --- 道具箱・雲海 ---
  const dk = await p.evaluate(async () => {
    const tools = [...document.querySelectorAll('.tool')];
    const pos = tools.map(t => t.querySelector('i').style.backgroundPosition);
    const im = new Image(); im.src = 'tools.webp'; await im.decode();
    // 絵の中の各アイコンの四隅が透明か (市松模様が残っていないか)
    const c = document.createElement('canvas'); c.width = im.naturalWidth; c.height = im.naturalHeight; const g = c.getContext('2d'); g.drawImage(im, 0, 0);
    const Z = im.naturalHeight, n = im.naturalWidth / Z, corners = [];
    for (let i = 0; i < n; i++) for (const [x, y] of [[2, 2], [Z - 3, 2], [2, Z - 3], [Z - 3, Z - 3]]) corners.push(g.getImageData(i * Z + x, y, 1, 1).data[3]);
    const dock = document.querySelector('.dock').getBoundingClientRect();
    const sea = document.getElementById('sea'), seaDefault = getComputedStyle(sea).display, groundDefault = getComputedStyle(document.getElementById('ground')).display;
    document.querySelector('.gchip[data-g=sea]').click();
    return { n: tools.length, uniq: new Set(pos).size, cells: n, cornerMax: Math.max(...corners), dockH: Math.round(dock.height),
      seaDefault, groundDefault, seaOk: sea.complete && sea.naturalWidth > 0, seaPE: getComputedStyle(sea).pointerEvents, seaBottom: Math.round(sea.getBoundingClientRect().bottom) };
  });
  // 直前に指を離していると、道具箱が戻るまで (0.35秒) 引っ込んでいる。戻ってから測る
  await p.waitForFunction(() => !document.body.classList.contains('drawing')); await p.waitForTimeout(350);
  const vis = await p.evaluate(() => {
    // 道具10個が、横に送らなくても全部見えている (1列で送る作りにしたら右の4つが画面の外に隠れた)
    const hidden = [...document.querySelectorAll('.tool')].filter(t => { const b = t.getBoundingClientRect(), box = t.parentElement.getBoundingClientRect();
      return b.left < Math.max(0, box.left) - 1 || b.right > Math.min(430, box.right) + 1 || b.bottom > 932; }).map(t => t.textContent);
    const over = document.getElementById('tools').scrollWidth - document.getElementById('tools').clientWidth;
    // 押すボタンは 44pt 以上 (幅も高さも)
    const small = [...document.querySelectorAll('.dock button, .top > button')].map(e => [e.textContent.trim() || e.id, Math.round(e.getBoundingClientRect().width), Math.round(e.getBoundingClientRect().height)])
      .filter(q => q[1] < 44 || q[2] < 44);
    return { hidden, over, small };
  });
  check('道具10個が、横に送らなくても全部見えている', vis.hidden.length === 0 && vis.over <= 0, JSON.stringify(vis.hidden) + ' はみ出し=' + vis.over);
  check('押すボタンは 44pt 以上', vis.small.length === 0, JSON.stringify(vis.small));
  check('道具10個が、それぞれ別の絵を使う', dk.n === 10 && dk.uniq === 10 && dk.cells === 10, dk.n + '個 / 絵' + dk.uniq + '種');
  check('道具の絵の四隅が透明 (市松模様が残っていない)', dk.cornerMax === 0, 'alpha最大=' + dk.cornerMax);
  check('道具箱が低い (空を広く見せる。3段だった頃は 233px)', dk.dockH <= 165, dk.dockH + 'px');
  check('はじめの足もとは「なし」(雲海もシルエットも出さない)', dk.seaDefault === 'none' && dk.groundDefault === 'none', dk.seaDefault + '/' + dk.groundDefault);
  check('雲海を選ぶと画面の下に敷かれ、指を通す', dk.seaOk && dk.seaPE === 'none' && dk.seaBottom === 932, JSON.stringify(dk));
  // 雲海は空に合わせて絵を替える。金の絵の空の部分はマゼンタだったので、残っていないこと
  const seaSw = await p.evaluate(async () => {
    const pick = k => { document.querySelector('.preset[data-k=' + k + ']').click(); return document.getElementById('sea').getAttribute('src'); };
    const r = { hiruma: pick('hiruma'), yoru: pick('yoru'), kumoue: pick('kumoue') };
    let mg = 0;
    for (const f of ['sea-gold.jpg', 'sea-day.jpg', 'sea-night.jpg']) { const im = new Image(); im.src = f; await im.decode();
      const c = document.createElement('canvas'); c.width = im.naturalWidth; c.height = im.naturalHeight; const g = c.getContext('2d'); g.drawImage(im, 0, 0);
      const d = g.getImageData(0, 0, c.width, c.height).data; for (let i = 0; i < d.length; i += 4) if (d[i] > 200 && d[i + 2] > 180 && d[i + 1] < 120) mg++; }
    r.magenta = mg; return r;
  });
  check('雲海の絵が空に合わせて替わる (昼・夜・雲の上)', seaSw.hiruma === 'sea-day.jpg' && seaSw.yoru === 'sea-night.jpg' && seaSw.kumoue === 'sea-gold.jpg', JSON.stringify(seaSw));
  check('雲海の絵にマゼンタが残っていない', seaSw.magenta === 0, 'px=' + seaSw.magenta);
  // 描いている間は道具箱が引っ込み、離すと戻る (途中で指が取り消されても戻る)
  const dr = await p.evaluate(async () => {
    const cv = document.getElementById('cv');
    function T(type, x, y) { const t = new Touch({ identifier: 1, target: cv, clientX: x, clientY: y });
      cv.dispatchEvent(new TouchEvent(type, { touches: /end|cancel/.test(type) ? [] : [t], changedTouches: [t], bubbles: true, cancelable: true })); }
    T('touchstart', 100, 820); const during = document.body.classList.contains('drawing');   // 雲海の上に触れても描ける
    T('touchcancel', 0, 0); await new Promise(r => setTimeout(r, 500));
    return { during, after: document.body.classList.contains('drawing') };
  });
  check('描いている間は道具箱が引っ込み、指が取り消されても戻る', dr.during && !dr.after, JSON.stringify(dr));
  // 保存する絵に雲海も入る
  const sv = await p.evaluate(async () => {
    const cv = document.getElementById('cv'), k = cv.width / 430;
    const snapImg = new Image(); document.getElementById('saveBtn').click(); snapImg.src = document.getElementById('veilImg').src; await snapImg.decode();
    document.getElementById('veilClose').click();
    const c = document.createElement('canvas'); c.width = cv.width; c.height = cv.height; const g = c.getContext('2d'); g.drawImage(snapImg, 0, 0);
    let diff = 0; for (const x of [60, 215, 370]) { const a = g.getImageData(x * k, 900 * k, 1, 1).data, b = cv.getContext('2d').getImageData(x * k, 900 * k, 1, 1).data; diff += Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]) + Math.abs(a[2] - b[2]); }
    return diff;
  });
  check('保存する絵に雲海も入る', sv > 30, '下端の差=' + sv);
  // 空の色や足もとを選んだ直後は、シートを薄くして裏を見せ、少しして戻す
  const pk = await p.evaluate(async () => { const sh = document.getElementById('sheet'); sh.classList.add('open');
    // 直前に空の色を選んだ名残で薄いままのことがあるので、元の濃さに戻るまで待ってから選ぶ
    while (sh.classList.contains('peek') || +getComputedStyle(sh).opacity < 0.99) await new Promise(r => setTimeout(r, 100));
    document.querySelector('.gchip[data-g=mount]').click(); await new Promise(r => setTimeout(r, 400)); const during = +getComputedStyle(sh).opacity;
    await new Promise(r => setTimeout(r, 1500)); const after = +getComputedStyle(sh).opacity;
    document.querySelector('.gchip[data-g=none]').click(); await new Promise(r => setTimeout(r, 1500)); sh.classList.remove('open'); return [during, after]; });
  check('足もとを選んだ直後はシートが薄くなり、裏が見える。少しして戻る', pk[0] < 0.3 && pk[1] > 0.95, JSON.stringify(pk));
  // --- 足もとのシルエット ---
  const gd = await p.evaluate(async () => {
    const el = document.getElementById('ground'), sea = document.getElementById('sea'), out = {};
    const pick = (g, th) => { if (th) document.querySelector('.preset[data-k=' + th + ']').click(); document.querySelector('.gchip[data-g=' + g + ']').click(); };
    const px = (x, yFromBottom) => { const k = el.width / 430; return [...el.getContext('2d').getImageData(Math.round(x * k), Math.round(el.height - yFromBottom * k), 1, 1).data]; };
    // 選ぶと出て、雲海は消える。どれも画面の下端に付き、指は通す
    out.shown = ['mount', 'city', 'hill', 'shore'].map(g => { pick(g, 'kumoue'); const r = el.getBoundingClientRect();
      return getComputedStyle(el).display === 'block' && getComputedStyle(sea).display === 'none' && Math.round(r.bottom) === 932 && getComputedStyle(el).pointerEvents === 'none' && px(215, 5)[3] > 200; });
    // シルエットの色は空に合わせて変わる (同じ山を、雲の上・昼・夜で)
    const cols = ['kumoue', 'hiruma', 'yoru'].map(th => { pick('mount', th); return px(215, 5).slice(0, 3); });
    const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
    out.colDiff = Math.round(Math.min(dist(cols[0], cols[1]), dist(cols[0], cols[2]), dist(cols[1], cols[2])));
    // 夜の街には灯りがともる (明るい画素がある)
    pick('city', 'yoru'); { const d = el.getContext('2d').getImageData(0, 0, el.width, el.height).data; let n = 0; for (let i = 0; i < d.length; i += 4) if (d[i + 3] > 200 && d[i] > 200 && d[i + 1] > 150) n++; out.lights = n; }
    pick('city', 'kumoue'); { const d = el.getContext('2d').getImageData(0, 0, el.width, el.height).data; let n = 0; for (let i = 0; i < d.length; i += 4) if (d[i + 3] > 200 && d[i] > 200 && d[i + 1] > 150) n++; out.dayLights = n; }
    // 保存する絵にシルエットも入る
    pick('mount', 'kumoue');
    const cv = document.getElementById('cv'), k = cv.width / 430;
    const snapImg = new Image(); document.getElementById('saveBtn').click(); snapImg.src = document.getElementById('veilImg').src; await snapImg.decode();
    document.getElementById('veilClose').click();
    const c = document.createElement('canvas'); c.width = cv.width; c.height = cv.height; const g = c.getContext('2d'); g.drawImage(snapImg, 0, 0);
    const a = g.getImageData(215 * k, 925 * k, 1, 1).data, b = el.getContext('2d').getImageData(Math.round(215 * el.width / 430), el.height - Math.round(7 * el.width / 430), 1, 1).data;
    out.saveDiff = Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]) + Math.abs(a[2] - b[2]);
    pick('none', 'kumoue');
    return out;
  });
  check('足もと (山・街・丘・海辺) を選ぶと、画面の下に出る', gd.shown.every(Boolean), JSON.stringify(gd.shown));
  check('足もとの色が空に合わせて変わる (雲の上・昼・夜)', gd.colDiff > 12, '差の最小=' + gd.colDiff);
  check('夜の街には灯りがともり、昼はともらない', gd.lights > 30 && gd.dayLights === 0, gd.lights + ' / ' + gd.dayLights);
  check('保存する絵に足もとも入る', gd.saveDiff < 30, '差=' + gd.saveDiff);

  // 1. 全画面のものが fixed で置かれていない (fixed だと iOS の短い枠に合わせて下が空く)
  const fixed = await p.evaluate(() => [...document.querySelectorAll('body *')]
    .filter(e => getComputedStyle(e).position === 'fixed').map(e => e.id || e.className));
  check('fixed で置いた要素が無い', fixed.length === 0, JSON.stringify(fixed));

  // 2. 根っこが 100vh で、基準になれる (position: relative)
  const root = await p.evaluate(() => ['html', 'body'].map(t => {
    const s = getComputedStyle(document.querySelector(t)); return s.position + ' ' + s.height; }));
  check('html, body が relative で 932px', root.every(s => s === 'relative 932px'), JSON.stringify(root));

  // 3. 描ける高さ = キャンバスの実寸 = 100vh、下の操作盤はキャンバスの下端にそろう
  const g = await p.evaluate(() => {
    const c = document.getElementById('cv').getBoundingClientRect(), d = document.querySelector('.dock').getBoundingClientRect();
    document.getElementById('logo').click();
    return { cv: c.height, dock: d.bottom, H: window.__kumoH, ver: document.getElementById('ver').textContent };
  });
  check('キャンバスが 932 いっぱい', g.cv === 932, 'cv=' + g.cv);
  check('操作盤の下端がキャンバスの下端', Math.abs(g.dock - g.cv) < 1, 'dock=' + g.dock);
  check('診断が 描ける932 / 窓932 / vh932 / 上端0', /描ける932 \/ 窓932 \/ vh932 \/ 上端0/.test(g.ver), g.ver);

  // 4. 版の番号が sw.js の CACHE と同じ (上げ忘れると端末に届かない)
  const ver = (g.ver.match(/^v\d+/) || [''])[0];
  const cache = (fs.readFileSync(path.join(__dirname, 'sw.js'), 'utf8').match(/kumo-sketch-(v\d+)/) || [])[1];
  check('版の番号と sw.js の CACHE がそろう', ver && ver === cache, ver + ' / ' + cache);

  // 5. 安全域(iPhone 16 Plus 縦: 上59・下34)を差し込んでも、中身が 932 に収まる
  const fit = await p.evaluate(async () => {
    const st = document.createElement('style');
    st.textContent = '.top{padding-top:69px!important}.dock{padding-bottom:44px!important}.sheet{padding-bottom:52px!important}';
    document.head.appendChild(st);
    document.getElementById('sheet').classList.add('open');
    await new Promise(r => setTimeout(r, 600));   // シートが上がりきるのを待つ (transition .38s)
    const out = ['.top', '.dock', '#sheet'].map(s => document.querySelector(s).getBoundingClientRect())
      .map(r => [Math.round(r.top), Math.round(r.bottom)]);
    const sh = document.documentElement.scrollHeight;
    st.remove(); document.getElementById('sheet').classList.remove('open');
    return { out, sh };
  });
  await p.waitForTimeout(500);
  check('安全域を足しても 0〜932 に収まる', fit.sh <= 932 && fit.out.every(r => r[0] >= 0 && r[1] <= 932), JSON.stringify(fit));

  // 6. 大きさが一瞬 0 で渡っても、前の大きさのまま (0 で組み直すと雲が全部画面の外になる)
  const z = await p.evaluate(() => {
    const cv = document.getElementById('cv'), w0 = cv.width;
    cv.style.display = 'none'; window.dispatchEvent(new Event('resize'));
    const w1 = cv.width; cv.style.display = ''; window.dispatchEvent(new Event('resize'));
    return [w0, w1];
  });
  check('大きさ 0 のときは組み直さない', z[0] === z[1] && z[0] > 0, JSON.stringify(z));

  // --- 重さの見張り: 同じ作りに戻っていないかを、作りそのもので見る ---
  await p.reload(); await p.waitForTimeout(400);
  const perf = await p.evaluate(async () => {
    const cv = document.getElementById('cv'), A = window.__app;
    function T(type, x, y) { const t = new Touch({ identifier: 1, target: cv, clientX: x, clientY: y });
      cv.dispatchEvent(new TouchEvent(type, { touches: type === 'touchend' ? [] : [t], changedTouches: [t], bubbles: true, cancelable: true })); }
    function drag(y) { T('touchstart', 40, y); for (let i = 1; i <= 40; i++) T('touchmove', 40 + i * 9, y); T('touchend', 0, 0); }
    // 描いている最中・描き直しで、画面いっぱいの層にぼかし(filter)を掛けた回数と、画面いっぱいの絵を写した回数を数える
    const C = CanvasRenderingContext2D.prototype, dI = C.drawImage;
    let blurDraws = 0, fullDraws = 0, watch = false;
    C.drawImage = function () { if (watch) { if (this.filter && this.filter !== 'none' && this.canvas.width >= cv.width * 0.9) blurDraws++;
      const w = arguments[0].width; if (w >= cv.width * 0.9) fullDraws++; } return dI.apply(this, arguments); };
    const tools = ['cumulus', 'nyudo', 'haze'];
    watch = true;
    for (let d = 0; d < 3; d++) { document.querySelector('[data-t=' + tools[d] + ']').click(); drag(200 + d * 150); }
    const drawBlur = blurDraws, drawFull = fullDraws;
    blurDraws = 0; A.rebuild(); const rebuildBlur = blurDraws;
    watch = false; C.drawImage = dI;
    // 元に戻すは、ひとなぞりぶんをまとめて戻す
    const n0 = A.strokes().length, lastG = A.strokes()[n0 - 1].g;
    const sameG = A.strokes().filter(s => s.g === lastG).length;
    document.getElementById('undoBtn').click();
    const n1 = A.strokes().length;
    // 形は取っておき、描き直しでは作り直さない。太陽が動いたら、少しずつでも全部塗り直し終わる
    const pcs = A.strokes().filter(s => s.pc).map(s => s.pc);
    A.rebuild(); const kept = A.strokes().filter(s => s.pc).every((s, i) => s.pc === pcs[i]);
    A.S.sunX = 0.15; A.S.sunY = 0.2;
    let frames = 0; while (A.rebuild(1) && frames < 500) frames++;
    const key = A.lightKey(), fresh = A.strokes().filter(s => s.pc).every(s => s.pc.key === key);
    return { drawBlur, drawFull, rebuildBlur, n0, n1, sameG, kept, frames, fresh };
  });
  check('描いている最中に画面いっぱいの絵を写さない', perf.drawFull === 0, 'full=' + perf.drawFull);
  check('画面いっぱいの層にぼかしを掛けない (後光は雲ごとに作り置き)', perf.rebuildBlur === 0 && perf.drawBlur === 0, 'rebuild=' + perf.rebuildBlur + ' draw=' + perf.drawBlur);
  check('ひとなぞりで雲は 1 つ (ハンコのように並べない)。元に戻すで、ひとなぞりぶんが消える', perf.sameG === 1 && perf.n0 - perf.n1 === 1, 'ひとなぞりの雲の数=' + perf.sameG + ' ' + perf.n0 + '→' + perf.n1);
  check('描き直しで雲の形を作り直さない', perf.kept);
  check('太陽を動かしたら、少しずつでも全部塗り直し終わる', perf.fresh && perf.frames > 0, 'frames=' + perf.frames);

  // --- 横にされたら幕を出し、描いた空はずらさない (縦で使うアプリ) ---
  const before = await p.evaluate(() => ({ n: window.__app.strokes().length, W: document.getElementById('cv').width,
    xs: window.__app.strokes().filter(s => s.pc).map(s => s.pc.box.x).join(',') }));
  await p.setViewportSize({ width: 932, height: 430 }); await p.waitForTimeout(300);
  const side = await p.evaluate(() => ({ turn: getComputedStyle(document.getElementById('turn')).display,
    W: document.getElementById('cv').width }));
  await p.setViewportSize({ width: 430, height: 932 }); await p.waitForTimeout(300);
  const back = await p.evaluate(() => ({ turn: getComputedStyle(document.getElementById('turn')).display,
    n: window.__app.strokes().length, W: document.getElementById('cv').width, H: window.__kumoH,
    xs: window.__app.strokes().filter(s => s.pc).map(s => s.pc.box.x).join(',') }));
  check('横にすると「縦に持って」の幕が出る', side.turn === 'flex', side.turn);
  check('横のあいだは組み直さない', side.W === before.W, before.W + '→' + side.W);
  check('縦に戻すと幕が消え、描いた雲は同じ位置のまま', back.turn === 'none' && back.H === 932 && back.n === before.n && back.xs === before.xs, JSON.stringify({ turn: back.turn, H: back.H, n: back.n }));
  const man = JSON.parse(fs.readFileSync(path.join(__dirname, 'manifest.webmanifest'), 'utf8'));
  check('マニフェストが縦固定', man.orientation === 'portrait', man.orientation);

  check('エラーが出ない', errs.length === 0, errs.join(' | '));
  await b.close(); srv.close();
  console.log(fails ? fails + ' 件 落ちた' : 'すべて通った');
  process.exit(fails ? 1 : 0);
})();
