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

  check('エラーが出ない', errs.length === 0, errs.join(' | '));
  await b.close(); srv.close();
  console.log(fails ? fails + ' 件 落ちた' : 'すべて通った');
  process.exit(fails ? 1 : 0);
})();
