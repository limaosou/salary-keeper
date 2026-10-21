/* 计薪计时规则专项 E2E（2026-10-20 新口径）
   验证：
   ① 手动签到 / 补签 → 无论几点都按整班计时（晚点打卡、忘打卡不扣时间，防少算）
   ② 地理围栏自动打卡 → 按真实时间，迟到/早退自动扣减
   ③ 特殊情况登记 → 迟到/早退按登记分钟扣减；增加时间用于干超过 12 小时的特殊情况
   ④ 超出班次窗口的实际加班照算
   用法：先起本地服务（node tmp/serve.js 或 python -m http.server 8901），再 node test/punch-rule.e2e.js */
const path = require('path');
const fs = require('fs');
const { chromium } = require(path.join('C:', 'Users', 'Administrator', '.workbuddy', 'binaries', 'node', 'workspace', 'node_modules', 'playwright'));

const BASE = process.env.BASE || 'http://127.0.0.1:8901/index.html';
const OUT = path.join(__dirname, '..', 'screenshots');
const results = [];
const ok = (n, c, e = '') => { results.push([n, !!c]); console.log(`${c ? '✅' : '❌'} ${n}${e ? '  ' + e : ''}`); };

const GEO_MOCK = () => {
  if (!localStorage.getItem('__mockgeo')) localStorage.setItem('__mockgeo', JSON.stringify({ lat: 37.5, lng: 127.0 }));
  const g = JSON.parse(localStorage.getItem('__mockgeo'));
  navigator.geolocation.watchPosition = () => 1;
  navigator.geolocation.clearWatch = () => {};
  navigator.geolocation.getCurrentPosition = s => s({ coords: { latitude: g.lat, longitude: g.lng, accuracy: 10 } });
};

// 白班窗口 08:20–20:20，休息 30 分钟 → 整班 11.5h
// 注意：addInitScript 会序列化函数，模块作用域变量不会一起带过去，必须用参数传
const DAY = '2026-10-14';   // 周三，普通白班日
const WORK = 11.5;

const SEED = (day) => {
  const KEY = 'salary_keeper_v1';
  const cur = JSON.parse(localStorage.getItem(KEY) || '{}');
  const seg = (dIn, i, dOut, o, extra = {}) => Object.assign({
    in: new Date(`${dIn}T${i}`).toISOString(),
    out: o ? new Date(`${dOut}T${o}`).toISOString() : null
  }, extra);
  cur.attendance = cur.attendance || {};
  // 关掉迟到/早退宽限，让断言可以精确到分钟
  cur.settings = Object.assign(cur.settings || {}, { lateGrace: 0, earlyGrace: 0 });
  // ① 按时出勤的自动打卡 → 整班
  cur.attendance[day] = { shiftType: 'day', segments: [seg(day, '08:20', day, '20:20', { src: 'auto' })], restMinutes: 30, perf: 1, isRestDay: false, leave: null, makeups: [] };
  // ② 前一天：12 点才想起来，手动补签 → 仍按整班
  cur.attendance['2026-10-13'] = { shiftType: 'day', segments: [seg('2026-10-13', '12:00', '2026-10-13', '20:20', { src: 'manual', makeup: true })], restMinutes: 30, perf: 1, isRestDay: false, leave: null, makeups: [] };
  // ③ 自动打卡迟到 1 小时（周四，应到 08:20）→ 扣 1 小时
  cur.attendance['2026-10-15'] = { shiftType: 'day', segments: [seg('2026-10-15', '09:20', '2026-10-15', '20:20', { src: 'auto' })], restMinutes: 30, perf: 1, isRestDay: false, leave: null, makeups: [] };
  // ④ 自动打卡早退 2 小时 → 扣 2 小时
  cur.attendance['2026-10-08'] = { shiftType: 'day', segments: [seg('2026-10-08', '08:20', '2026-10-08', '18:20', { src: 'auto' })], restMinutes: 30, perf: 1, isRestDay: false, leave: null, makeups: [] };
  // ⑤ 登记特殊情况：迟到 90 分钟 + 说明 → 扣 1.5h
  cur.attendance['2026-10-07'] = { shiftType: 'day', segments: [seg('2026-10-07', '08:20', '2026-10-07', '20:20', { src: 'manual' })], restMinutes: 30, perf: 1, isRestDay: false, leave: null, makeups: [], adjust: { lateMin: 90, earlyMin: 0, note: '上午外出办事' } };
  // ⑥ 加班到 23:00 → 整班 11.5h + 加班 2.67h
  cur.attendance['2026-10-06'] = { shiftType: 'day', segments: [seg('2026-10-06', '08:20', '2026-10-06', '23:00', { src: 'auto' })], restMinutes: 30, perf: 1, isRestDay: false, leave: null, makeups: [] };
  // ⑦ 夜班（10-09 周五 20:20 → 10-10 周六 06:20，10h 短班）手动补签
  cur.attendance['2026-10-09'] = { shiftType: 'night', segments: [seg('2026-10-09', '22:00', '2026-10-10', '06:20', { src: 'manual' })], restMinutes: 30, perf: 1, isRestDay: false, leave: null, makeups: [] };
  // ⑧ 登记增加时间：干超过一班（12 小时）→ 整班 11.5h + 1h = 12.5h（用 10-01 周四普通白班日，避开 10-05 韩国替代公休日）
  cur.attendance['2026-10-01'] = { shiftType: 'day', segments: [seg('2026-10-01', '08:20', '2026-10-01', '20:20', { src: 'manual' })], restMinutes: 30, perf: 1, isRestDay: false, leave: null, makeups: [], adjust: { lateMin: 0, earlyMin: 0, addMin: 60, note: '通宵加班' } };
  localStorage.setItem(KEY, JSON.stringify(cur));
};

const hours = ds => page0.evaluate(d => {
  const rec = Store.peek(d);
  if (!rec) return null;
  const r = Salary.calcDay(rec, d, { nowForOpen: new Date(`${d}T23:59:59`) });
  return { w: r.workHours, ot: r.otHours };
}, ds);

let page0;
(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, locale: 'ko-KR' });
  page0 = await ctx.newPage();
  const errors = [];
  page0.on('pageerror', e => errors.push(e.message));
  await page0.addInitScript(GEO_MOCK);
  await page0.addInitScript(SEED, DAY);
  await page0.goto(BASE, { waitUntil: 'networkidle' });
  await page0.click('.tab[data-page="attendance"]');
  await page0.waitForTimeout(500);

  // ── ① 按时出勤 ──
  let h = await hours(DAY);
  ok('按时出勤 → 整班 11.5h', h && Math.abs(h.w - WORK) < 0.01, h ? h.w.toFixed(2) : 'null');
  ok('按时出勤 → 加班 3.5h', h && Math.abs(h.ot - 3.5) < 0.01, h ? h.ot.toFixed(2) : 'null');

  // ── ② 晚点手动补签 ──
  h = await hours('2026-10-13');
  ok('12 点才手动补签 → 仍按整班 11.5h', h && Math.abs(h.w - WORK) < 0.01, h ? h.w.toFixed(2) : 'null');
  const st13 = await page0.evaluate(() => Salary.judgeDay('2026-10-13', { now: new Date('2026-10-15T12:00:00') }));
  ok('补签日不判迟到（状态 normal）', st13.code === 'normal', st13.code);
  ok('补签日有「按当班时间计」标注', (st13.extra || '').includes('按当班时间计'), st13.extra || '');

  // ── ③ 自动打卡迟到 ──
  h = await hours('2026-10-15');
  ok('自动打卡迟到 1h → 10.5h', h && Math.abs(h.w - 10.5) < 0.01, h ? h.w.toFixed(2) : 'null');
  const st12 = await page0.evaluate(() => Salary.judgeDay('2026-10-15', { now: new Date('2026-10-20T12:00:00') }));
  ok('迟到日月历标记 late', st12.code === 'late', st12.code);

  // ── ④ 自动打卡早退 ──
  h = await hours('2026-10-08');
  ok('自动打卡早退 2h → 9.5h', h && Math.abs(h.w - 9.5) < 0.01, h ? h.w.toFixed(2) : 'null');
  const st08 = await page0.evaluate(() => Salary.judgeDay('2026-10-08', { now: new Date('2026-10-15T12:00:00') }));
  ok('早退日月历标记 early', st08.code === 'early', st08.code);

  // ── ⑤ 特殊情况登记 ──
  h = await hours('2026-10-07');
  ok('登记迟到 90 分 → 11.5 − 1.5 = 10h', h && Math.abs(h.w - 10) < 0.01, h ? h.w.toFixed(2) : 'null');
  const st07 = await page0.evaluate(() => Salary.judgeDay('2026-10-07', { now: new Date('2026-10-15T12:00:00') }));
  ok('登记扣减后标记 late', st07.code === 'late', st07.code);
  ok('说明文字出现在明细', (st07.extra || '').includes('上午外出办事'), st07.extra || '');

  // ── ⑥ 超出窗口的加班 ──
  h = await hours('2026-10-06');
  ok('加班到 23:00 → 11.5h + 2.67h = 14.17h', h && Math.abs(h.w - (11.5 + 160 / 60)) < 0.01, h ? h.w.toFixed(2) : 'null');

  // ── ⑦ 夜班手动补签按短班 ──
  h = await hours('2026-10-09');
  ok('周五夜班补签按 10h 短班 − 30m 休息 = 9.5h', h && Math.abs(h.w - 9.5) < 0.01, h ? h.w.toFixed(2) : 'null');

  // ── ⑧ 登记增加时间（干超过 12 小时的特殊情况） ──
  h = await hours('2026-10-01');
  ok('登记增加 60 分 → 11.5 + 1 = 12.5h', h && Math.abs(h.w - 12.5) < 0.01, h ? h.w.toFixed(2) : 'null');
  const st01 = await page0.evaluate(() => Salary.judgeDay('2026-10-01', { now: new Date('2026-10-15T12:00:00') }));
  ok('只登记增加不误标迟到早退', st01.code === 'normal', st01.code);
  ok('明细说明含增加分钟', (st01.extra || '').includes('增加 60'), st01.extra || '');

  // ── UI：补签面板能登记并回显扣减 ──
  await page0.click('#cal-grid .cal-cell.tappable[data-date="2026-10-13"]');
  await page0.waitForTimeout(400);
  const panelVisible = await page0.isVisible('#mk-mask');
  ok('点日期打开补签面板', panelVisible);
  const hintTxt = await page0.textContent('#page-settings, #mk-mask');
  await page0.fill('#mk-late', '60');
  await page0.fill('#mk-adjust-note', '睡过头');
  await page0.click('#mk-adjust-save');
  await page0.waitForTimeout(500);
  let adjMsg = await page0.textContent('#mk-adjust-msg');
  ok('保存扣减有成功提示', adjMsg.includes('迟到 60'), adjMsg.trim());
  h = await hours('2026-10-13');
  ok('登记后工时变为 11.5 − 1 = 10.5h', h && Math.abs(h.w - 10.5) < 0.01, h ? h.w.toFixed(2) : 'null');
  const st13b = await page0.evaluate(() => Salary.judgeDay('2026-10-13', { now: new Date('2026-10-15T12:00:00') }));
  ok('登记后月历改标 late', st13b.code === 'late', st13b.code);
  let detailTxt = await page0.textContent('#mk-detail');
  ok('面板明细显示扣减说明', detailTxt.includes('睡过头') || detailTxt.includes('迟到 60'), detailTxt.slice(0, 80));

  // 清除扣减 → 回到整班
  await page0.click('#mk-adjust-clear');
  await page0.waitForTimeout(500);
  h = await hours('2026-10-13');
  ok('清除扣减后回到整班 11.5h', h && Math.abs(h.w - WORK) < 0.01, h ? h.w.toFixed(2) : 'null');

  // 登记「增加时间」→ 干超过 12 小时的特殊情况
  await page0.fill('#mk-add', '60');
  await page0.fill('#mk-adjust-note', '通宵加班');
  await page0.click('#mk-adjust-save');
  await page0.waitForTimeout(500);
  adjMsg = await page0.textContent('#mk-adjust-msg');
  ok('保存增加有成功提示', adjMsg.includes('增加 60'), adjMsg.trim());
  h = await hours('2026-10-13');
  ok('登记增加后工时变为 11.5 + 1 = 12.5h', h && Math.abs(h.w - 12.5) < 0.01, h ? h.w.toFixed(2) : 'null');
  detailTxt = await page0.textContent('#mk-detail');
  ok('面板明细显示增加说明', detailTxt.includes('通宵加班') || detailTxt.includes('增加 60'), detailTxt.slice(0, 80));

  await page0.click('#mk-adjust-clear');
  await page0.waitForTimeout(500);
  h = await hours('2026-10-13');
  ok('清除增加后回到整班 11.5h', h && Math.abs(h.w - WORK) < 0.01, h ? h.w.toFixed(2) : 'null');
  await page0.click('#mk-close');

  // ── 页面无报错 ──
  ok('全流程无 JS 报错', errors.length === 0, errors.join('; ').slice(0, 120));

  await page0.screenshot({ path: path.join(OUT, '15-计薪计时规则.png'), fullPage: true });
  await browser.close();
  console.log(`\n计薪计时规则 E2E: ${results.filter(r => r[1]).length} 通过, ${results.filter(r => !r[1]).length} 失败`);
  process.exit(results.every(r => r[1]) ? 0 : 1);
})().catch(e => { console.error('运行异常:', e); process.exit(1); });
