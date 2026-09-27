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
  check('タイトルの絵を、オフライン用に先読みする', /'\.\/title-bg\.jpg'/.test(sw) && /'\.\/title-logo\.png'/.test(sw));

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
