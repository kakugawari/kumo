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
      for (let i = 12; i <= n - 12; i++) { const t = i / n - 0.5, L = hk.R * 1.7; let mx = 0;
        for (let o = -0.08; o <= 0.08; o += 0.01) { const wx = hk.x + Math.cos(a) * L * t - Math.sin(a) * hk.R * o, wy = hk.y + Math.sin(a) * L * t + Math.cos(a) * hk.R * o;
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
    const sea = document.getElementById('sea');
    return { n: tools.length, uniq: new Set(pos).size, cells: n, cornerMax: Math.max(...corners), dockH: Math.round(dock.height),
      seaOk: sea.complete && sea.naturalWidth > 0, seaPE: getComputedStyle(sea).pointerEvents, seaBottom: Math.round(sea.getBoundingClientRect().bottom) };
  });
  check('道具10個が、それぞれ別の絵を使う', dk.n === 10 && dk.uniq === 10 && dk.cells === 10, dk.n + '個 / 絵' + dk.uniq + '種');
  check('道具の絵の四隅が透明 (市松模様が残っていない)', dk.cornerMax === 0, 'alpha最大=' + dk.cornerMax);
  check('道具箱が低い (空を広く見せる)', dk.dockH <= 150, dk.dockH + 'px');
  check('雲海が画面の下に敷かれ、指を通す', dk.seaOk && dk.seaPE === 'none' && dk.seaBottom === 932, JSON.stringify(dk));
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
  check('診断が 描ける932 / 窓932 / vh932', /描ける932 \/ 窓932 \/ vh932/.test(g.ver), g.ver);

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
  check('元に戻すで、ひとなぞりぶん (' + perf.sameG + '個) がまとめて消える', perf.sameG > 1 && perf.n0 - perf.n1 === perf.sameG, perf.n0 + '→' + perf.n1);
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
