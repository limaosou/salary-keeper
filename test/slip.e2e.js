/* 端到端验证：把真实工资条（2026-09）的考勤灌进页面，
   检查 UI 显示的应发/扣除/实发是否与工资条一致 */
const path = require('path');
const fs = require('fs');
const { chromium } = require(path.join('C:', 'Users', 'Administrator', '.workbuddy', 'binaries', 'node', 'workspace', 'node_modules', 'playwright'));

const BASE = process.env.BASE || 'http://127.0.0.1:8901/index.html';
const OUT = process.env.OUT ? path.resolve(process.env.OUT) : path.join(__dirname, '..', 'screenshots');
const results = [];
const ok = (n, c, e = '') => { results.push([n, !!c]); console.log(`${c ? '✅' : '❌'} ${n}${e ? '  ' + e : ''}`); };

const GEO_MOCK = () => {
  if (!localStorage.getItem('__mockgeo')) {
    localStorage.setItem('__mockgeo', JSON.stringify({ lat: 37.5, lng: 127.0 }));
  }
  const r = () => JSON.parse(localStorage.getItem('__mockgeo'));
  navigator.geolocation.watchPosition = () => 1;
  navigator.geolocation.clearWatch = () => {};
  navigator.geolocation.getCurrentPosition = s => {
    const g = r(); s({ coords: { latitude: g.lat, longitude: g.lng, accuracy: 10 } });
  };
};

// 灌入工资条对应考勤：凑出现场근로수당 617,840 = 시급 10,470 × 1.5 × 39.3403h 加班
// 2026-10-28 口径：每天只签一次到（整班），加班/扣减通过 rec.adjust 登记实现。
// 白班（周二~五）整班 11h：目标加班 otH ≤ 3 → 登记迟到 (3−otH)×60 分；
// otH > 3 → 登记增加 (otH−3)×60 分。日期全部避开周一 10:20 / 周五夜班短班窗口。
// 注意：首次访问时 storage.js 的 load() 不写盘，所以这里不能依赖已存在的 key，
// 直接写入 { attendance }，其余字段由 storage.js 的 DEFAULTS 合并补齐。
const SEED = () => {
  const KEY = 'salary_keeper_v1';
  const cur = JSON.parse(localStorage.getItem(KEY) || '{}');
  const att = {};
  const targetH = 617840 / (10470 * 1.5);
  const days = [1, 2, 3, 4, 8, 9, 10, 11, 15, 16, 17, 18, 22, 23, 24, 25, 29, 30]; // 周二~五共 18 天
  const perDay = targetH / days.length;      // 每天摊 2.1856h 加班（< 3 → 走迟到登记）
  const lateMin = (3 - perDay) * 60;
  days.forEach(d => {
    const ds = `2026-09-${String(d).padStart(2, '0')}`;
    att[ds] = {
      shiftType: 'day', restMinutes: 60, perf: 1, isRestDay: false,
      segments: [{ in: `${ds}T08:20`, out: `${ds}T20:20` }],
      adjust: { lateMin, earlyMin: 0, addMin: 0, note: '' }
    };
  });

  Object.keys(cur.attendance || {}).forEach(k => { if (k.startsWith('2026-09')) delete cur.attendance[k]; });
  cur.attendance = Object.assign(cur.attendance || {}, att);
  cur.actualPaid = cur.actualPaid || {};
  localStorage.setItem(KEY, JSON.stringify(cur));
  return Object.keys(cur.attendance).filter(k => k.startsWith('2026-09')).length;
};

const num = s => Number(String(s).replace(/[^\d]/g, ''));

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 420, height: 920 }, locale: 'ko-KR' });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  page.on('console', m => { if (m.type() === 'error' && !m.text().includes('favicon')) errors.push(m.text()); });
  await page.addInitScript(GEO_MOCK);

  await page.goto(BASE, { waitUntil: 'networkidle' });
  await page.waitForTimeout(600);
  await page.evaluate(SEED);
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForTimeout(600);

  const seeded = await page.evaluate(() =>
    Object.keys((JSON.parse(localStorage.getItem('salary_keeper_v1')) || {}).attendance || {})
      .filter(k => k.startsWith('2026-09')).length);
  ok('工资条考勤注入成功', seeded > 15, `2026-09 共 ${seeded} 天`);

  // 切到 2026-09
  await page.click('.tab[data-page="salary"]');
  await page.waitForTimeout(400);
  for (let i = 0; i < 14; i++) {
    const cur = await page.textContent('#sal-cur-month');
    if (cur === '2026-09') break;
    await page.click('#sal-prev-month');
    await page.waitForTimeout(120);
  }
  await page.waitForTimeout(500);

  const gross = num(await page.textContent('#sal-gross'));
  const deduct = num(await page.textContent('#sal-deduct'));
  const net = num(await page.textContent('#sal-net'));

  console.log(`\n 页面显示：应发 ${gross.toLocaleString()} / 扣除 ${deduct.toLocaleString()} / 实发 ${net.toLocaleString()}`);
  console.log(` 工资条  ：应发 3,354,050 / 扣除 516,440 / 实发 2,837,610\n`);

  ok('应发合计 = 工资条 3,354,050', gross === 3354050, `实际 ${gross.toLocaleString()}`);
  ok('扣除合计 = 工资条 516,440', deduct === 516440, `实际 ${deduct.toLocaleString()}`);
  ok('实发合计 = 工资条 2,837,610', net === 2837610, `实际 ${net.toLocaleString()}`);

  const bd = await page.innerHTML('#sal-breakdown');
  ['1,842,720', '335,040', '617,840', '366,450', '192,000'].forEach(v => {
    ok(`应发明细含 ${v}`, bd.includes(v));
  });
  const dd = await page.innerHTML('#sal-deductions');
  ['163,020', '124,170', '31,080', '50,000', '16,310', '119,880', '11,980'].forEach(v => {
    ok(`扣除明细含 ${v}`, dd.includes(v));
  });
  ok('显示社保基数 2,209,170', (await page.textContent('#sal-base')).includes('2,209,170'));
  ok('显示员工档案（사번/성명/부서）',
    (await page.textContent('#sal-meta')).includes('0581')
    && (await page.textContent('#sal-meta')).includes('이형화')
    && (await page.textContent('#sal-meta')).includes('성형부'));

  const attHtml = await page.innerHTML('#sal-attendance');
  ok('考勤汇总显示总工时', attHtml.includes('총근로시간') && !attHtml.includes('총근로시간</span><b>0.0h'));
  await page.screenshot({ path: path.join(OUT, '9-工资条.png'), fullPage: true });

  // 用工资条实发额核对
  await page.fill('#actual-paid', '2837610');
  await page.click('#btn-check');
  await page.waitForTimeout(300);
  let txt = await page.textContent('#check-result');
  ok('与工资条实发核对 → 完全一致', txt.includes('完全一致'), txt.trim().slice(0, 40));

  await page.fill('#actual-paid', '2800000');   // 少发 37,610
  await page.click('#btn-check');
  await page.waitForTimeout(300);
  txt = await page.textContent('#check-result');
  ok('少发 37,610원 时报差额', txt.includes('37,610') && txt.includes('少发'), txt.trim().slice(0, 40));

  // 设置页档案
  await page.click('.tab[data-page="settings"]');
  await page.waitForTimeout(400);
  ok('设置页显示 사번 0581', (await page.inputValue('#set-emp-no')) === '0581');
  ok('设置页显示 시급 10,470', (await page.inputValue('#set-hourly')) === '10470');
  ok('设置页显示 월급여시간 176', (await page.inputValue('#set-monthly-hours')) === '176');
  await page.screenshot({ path: path.join(OUT, '10-员工档案.png'), fullPage: true });

  ok('全流程无 JS 报错', errors.length === 0, errors.join(';'));

  await browser.close();
  const fail = results.filter(r => !r[1]).length;
  console.log(`\n工资条核对 E2E: ${results.length - fail} 通过, ${fail} 失败`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('执行异常:', e); process.exit(1); });