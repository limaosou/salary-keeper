/* 薪资规则专项测试：班次时间 / 日薪结构(8h+3.5h) / 夜班补助 / 节假日1.5倍
   / 当月按考勤实算 vs 前月固定 / 发薪日17号→周五 / 退职金 / 员工档案可编辑
   用法：先起本地服务 python -m http.server 8901，再 node test/payroll.e2e.js */
const path = require('path');
const fs = require('fs');
const { chromium } = require(path.join('C:', 'Users', 'Administrator', '.workbuddy', 'binaries', 'node', 'workspace', 'node_modules', 'playwright'));

const BASE = process.env.BASE || 'http://127.0.0.1:8901/index.html';
const OUT = path.join(__dirname, '..', 'screenshots');
const FIXED_NOW = '2026-10-15T12:00:00';   // 冻结今天 = 2026-10-15（周四）

const results = [];
const ok = (n, c, e = '') => { results.push([n, !!c]); console.log(`${c ? '✅' : '❌'} ${n}${e ? '  ' + e : ''}`); };
const kr = n => Math.round(Number(n) || 0).toLocaleString('ko-KR');

const GEO_MOCK = () => {
  if (!localStorage.getItem('__mockgeo')) localStorage.setItem('__mockgeo', JSON.stringify({ lat: 37.5, lng: 127.0 }));
  const g = JSON.parse(localStorage.getItem('__mockgeo'));
  navigator.geolocation.watchPosition = () => 1;
  navigator.geolocation.clearWatch = () => {};
  navigator.geolocation.getCurrentPosition = s => s({ coords: { latitude: g.lat, longitude: g.lng, accuracy: 10 } });
};

// 2026-10 工作日出勤（避开 10-03 개천절 / 10-05 대체공휴일 / 10-09 한글날）
const WORK_DAYS = ['2026-10-01', '2026-10-02', '2026-10-06', '2026-10-07', '2026-10-08',
  '2026-10-12', '2026-10-13', '2026-10-14'];

const SEED = () => {
  const KEY = 'salary_keeper_v1';
  const cur = JSON.parse(localStorage.getItem(KEY) || '{}');
  const att = {};
  const DAYS = ['2026-10-01', '2026-10-02', '2026-10-06', '2026-10-07', '2026-10-08',
    '2026-10-12', '2026-10-13', '2026-10-14'];
  const put = (d, i, o, extra = {}) => {
    const dayMs = new Date(`${d}T00:00:00`).getTime();
    const hm = t => { const [h, m] = t.split(':').map(Number); return h * 3600000 + m * 60000; };
    const cross = extra.shiftType === 'night';
    att[d] = Object.assign({
      shiftType: 'day',
      segments: [{ in: new Date(dayMs + hm(i)).toISOString(), out: new Date(dayMs + (cross ? 86400000 : 0) + hm(o)).toISOString() }],
      restMinutes: 30, perf: 1, isRestDay: false, leave: null, makeups: []
    }, extra);
  };
  DAYS.forEach(d => put(d, '08:20', '20:20'));
  cur.attendance = Object.assign(cur.attendance || {}, att);
  localStorage.setItem(KEY, JSON.stringify(cur));
};

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 420, height: 940 }, locale: 'ko-KR' });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  page.on('console', m => { if (m.type() === 'error' && !m.text().includes('favicon')) errors.push(m.text()); });

  await page.addInitScript(`{
    const FIX = new Date('${FIXED_NOW}').getTime();
    const _D = Date;
    class D extends _D {
      constructor(...a){ if(!a.length) super(FIX); else super(...a); }
      static now(){ return FIX; }
    }
    window.Date = D;
  }`);
  await page.addInitScript(GEO_MOCK);

  await page.goto(BASE, { waitUntil: 'networkidle' });
  await page.waitForTimeout(500);
  await page.evaluate(SEED);
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForTimeout(600);

  console.log('\n──── 一、班次时间 ────');
  const win = await page.evaluate(() => ({
    mon: Salary.shiftWindowFor('2026-10-05', 'day'),
    tue: Salary.shiftWindowFor('2026-10-06', 'day'),
    friNight: Salary.shiftWindowFor('2026-10-09', 'night'),
    wedNight: Salary.shiftWindowFor('2026-10-07', 'night'),
    weekly: Store.settings.shift.weeklyWorkDays,
    rest: Store.settings.restMinutes
  }));
  ok('白班 08:20–20:20', win.tue.start === '08:20' && win.tue.end === '20:20', `${win.tue.start}–${win.tue.end}`);
  ok('夜班 20:20–次日 08:20', win.wedNight.start === '20:20' && win.wedNight.end === '08:20',
    `${win.wedNight.start}–${win.wedNight.end}`);
  ok('白班周一晚 2 小时 → 10:20 上班', win.mon.start === '10:20', win.mon.start);
  ok('夜班周五早 2 小时 → 06:20 下班', win.friNight.end === '06:20', win.friNight.end);
  ok('每周上班 5 天', win.weekly === 5, String(win.weekly));
  ok('每日休息扣除 30 分钟', win.rest === 30, `${win.rest} 分`);

  console.log('\n──── 二、日薪结构：标准 8h + 固定加班 3.5h(×1.5) ────');
  const dayPay = await page.evaluate(() => {
    const r = Store.day('2026-11-03');   // 周二，非假日
    r.shiftType = 'day';
    r.segments = [{ in: new Date('2026-11-03T08:20').toISOString(), out: new Date('2026-11-03T20:20').toISOString() }];
    const a = Salary.calcDayPay('2026-11-03');
    const r2 = Store.day('2026-11-04');
    r2.shiftType = 'night';
    r2.segments = [{ in: new Date('2026-11-04T20:20').toISOString(), out: new Date('2026-11-05T08:20').toISOString() }];
    const b = Salary.calcDayPay('2026-11-04');
    return { a, b };
  });
  const H = 10470;
  ok('白班工时 = 12h − 0.5h 休息 = 11.5h', Math.abs(dayPay.a.workHours - 11.5) < 0.01, dayPay.a.workHours.toFixed(2));
  ok('白班标准工资 = 8h × 10,470 = 83,760', dayPay.a.stdPay === 8 * H, kr(dayPay.a.stdPay));
  ok('白班固定加班 = 3.5h × 10,470 × 1.5 = 54,968', dayPay.a.otPay === 54968, kr(dayPay.a.otPay));
  ok('白班合计 138,728', dayPay.a.total === 138728, kr(dayPay.a.total));
  ok('夜班补助 = 3.5h × 10,470 × 0.5 = 18,323', dayPay.b.nightPay === 18323, kr(dayPay.b.nightPay));
  ok('夜班合计 = 白班 + 夜班补助 = 157,051', dayPay.b.total === 138728 + 18323, kr(dayPay.b.total));
  ok('夜班比白班多 18,323원', dayPay.b.total - dayPay.a.total === 18323, kr(dayPay.b.total - dayPay.a.total));

  console.log('\n──── 三、法定节假日出勤全天 1.5 倍 ────');
  const holPay = await page.evaluate(() => {
    const r = Store.day('2026-10-09');   // 한글날
    r.shiftType = 'day';
    r.segments = [{ in: new Date('2026-10-09T08:20').toISOString(), out: new Date('2026-10-09T20:20').toISOString() }];
    const p = Salary.calcDayPay('2026-10-09');
    return { isHoliday: p.isHoliday, name: p.holidayName, extra: p.holidayExtra, total: p.total };
  });
  ok('10-09 被识别为法定假日（한글날）', holPay.isHoliday && holPay.name === '한글날', holPay.name);
  ok('假日加给 = 日薪 × 0.5 = 69,364', holPay.extra === 69364, kr(holPay.extra));
  ok('假日出勤合计 = 138,728 × 1.5 = 208,092', holPay.total === 208092, kr(holPay.total));
  // 清掉这一天的测试数据，避免污染第四章的当月实算
  await page.evaluate(() => { delete Store.attendance['2026-10-09']; Store.save(); });

  console.log('\n──── 四、月薪页：当月按考勤实算（非固定值） ────');
  await page.click('.tab[data-page="salary"]');
  await page.waitForTimeout(500);
  ok('当前月为 2026-10', (await page.textContent('#sal-cur-month')) === '2026-10');
  const modeTxt = await page.textContent('#sal-mode');
  ok('当月标识为「예상 · 按当月考勤实算」', modeTxt.includes('예상') && modeTxt.includes('实算'), modeTxt.replace(/\s+/g, ' ').trim());
  const attTxt = await page.textContent('#sal-attendance');
  ok('考勤汇总显示 8 天出勤', /出勤天数\s*8일/.test(attTxt.replace(/\s+/g, ' ')), attTxt.replace(/\s+/g, ' ').slice(0, 60));
  const gross1 = await page.textContent('#sal-gross');
  ok('应发为按 8 天实算值', gross1 === kr(1668274), `${gross1}（期望 ${kr(1668274)}）`);

  // 非固定值验证：再加一天出勤，应发必须跟着涨
  await page.evaluate(() => {
    const r = Store.day('2026-10-15');
    r.shiftType = 'day';
    r.segments = [{ in: new Date('2026-10-15T08:20').toISOString(), out: new Date('2026-10-15T20:20').toISOString() }];
    Store.save();
  });
  await page.click('.tab[data-page="attendance"]'); await page.waitForTimeout(250);
  await page.click('.tab[data-page="salary"]'); await page.waitForTimeout(350);
  const attTxt2 = await page.textContent('#sal-attendance');
  const gross2 = await page.textContent('#sal-gross');
  ok('加一天出勤后天数变 9일', /出勤天数\s*9일/.test(attTxt2.replace(/\s+/g, ' ')), attTxt2.replace(/\s+/g, ' ').slice(0, 40));
  ok('应发随之增加 138,728（非固定值）',
    Number(gross2.replace(/,/g, '')) - Number(gross1.replace(/,/g, '')) === 138728,
    `${gross1} → ${gross2}`);

  console.log('\n──── 五、前月用工资条固定值 ────');
  await page.click('#sal-prev-month'); await page.waitForTimeout(400);
  ok('切到 2026-09', (await page.textContent('#sal-cur-month')) === '2026-09');
  const modeTxt2 = await page.textContent('#sal-mode');
  ok('前月标识为「확정 · 工资条固定口径」', modeTxt2.includes('확정') && modeTxt2.includes('固定'), modeTxt2.replace(/\s+/g, ' ').trim());
  const grossPrev = await page.evaluate(() => {
    const s = Salary.calcMonth(2026, 9, { mode: 'slip' });
    return { gross: s.gross, base: s.basePay };
  });
  ok('前月 기본급 固定 = 176h × 10,470 = 1,842,720', grossPrev.base === 1842720, kr(grossPrev.base));

  console.log('\n──── 六、发薪日：每月 17 号，逢周末提前周五 ────');
  await page.click('#sal-next-month'); await page.waitForTimeout(400);
  const payTxt10 = (await page.textContent('#sal-payday')).replace(/\s+/g, ' ');
  ok('2026-10 发薪日提前到 10/16(금)', payTxt10.includes('10/16(금)'), payTxt10.trim());
  ok('并说明原因为 17 日逢周末', payTxt10.includes('提前'), payTxt10.trim());
  const payCalc = await page.evaluate(() => {
    const out = {};
    for (let m = 1; m <= 12; m++) {
      const r = Salary.payDateFor(2026, m, 17);
      out[m] = { label: r.label, adj: r.adjusted, wd: r.weekday };
    }
    return out;
  });
  ok('2026-01 逢周末 → 提前', payCalc[1].adj === true && payCalc[1].wd === 5, payCalc[1].label);
  ok('2026-05 逢周末 → 提前', payCalc[5].adj === true && payCalc[5].wd === 5, payCalc[5].label);
  ok('2026-02 正常 17 号', payCalc[2].adj === false, payCalc[2].label);
  ok('提前后一律落在周五', Object.values(payCalc).every(v => !v.adj || v.wd === 5));

  console.log('\n──── 七、退职金（按入职日期） ────');
  const sevTxt = (await page.textContent('#sal-severance')).replace(/\s+/g, ' ');
  ok('显示工龄（근속기간）', /근속/.test(sevTxt), sevTxt.slice(0, 70));
  ok('显示预计退职金', /퇴직금/.test(sevTxt), sevTxt.slice(0, 70));
  const sev = await page.evaluate(() => Salary.severance('2022/06/01', new Date('2026-10-15'), 3354050));
  ok('工龄满 4 年（2022/06/01 起）', sev.years === 4, `${sev.years}년 ${sev.months}개월 / ${sev.days}일`);
  ok('1일 평균임금 = 月应发 ÷ 30', sev.dailyAvgWage === Math.round(3354050 / 30), kr(sev.dailyAvgWage));
  ok('退职金 = 日均 × 30 × 工龄年数',
    sev.amount === Math.round(sev.dailyAvgWage * 30 * (sev.days / 365)), kr(sev.amount));
  const sevNew = await page.evaluate(() => Salary.severance('2026/09/01', new Date('2026-10-15'), 3354050));
  ok('未满 1 年不产生退职金', sevNew.amount === 0 && sevNew.eligible === false, sevNew.note);

  console.log('\n──── 八、员工档案可自由修改并联动 ────');
  await page.click('.tab[data-page="settings"]');
  await page.waitForTimeout(400);
  ok('可编辑 사번', await page.inputValue('#set-emp-no') !== null);
  await page.fill('#set-name', '김테스트');
  await page.dispatchEvent('#set-name', 'change');
  await page.fill('#set-dept', '품질부');
  await page.dispatchEvent('#set-dept', 'change');
  await page.fill('#set-job-title', '주임');
  await page.dispatchEvent('#set-job-title', 'change');
  await page.waitForTimeout(300);
  await page.click('.tab[data-page="salary"]');
  await page.waitForTimeout(400);
  const metaTxt = await page.textContent('#sal-meta');
  ok('姓名改动同步到月薪页', metaTxt.includes('김테스트'), metaTxt.replace(/\s+/g, ' ').trim().slice(0, 70));
  ok('部门改动同步到月薪页', metaTxt.includes('품질부'), '');
  ok('职位显示在月薪页', metaTxt.includes('주임'), '');
  // 改入职日期 → 退职金跟着变
  await page.click('.tab[data-page="settings"]');
  await page.waitForTimeout(300);
  await page.fill('#set-hire-date', '2020/01/01');
  await page.dispatchEvent('#set-hire-date', 'change');
  await page.waitForTimeout(300);
  await page.click('.tab[data-page="salary"]');
  await page.waitForTimeout(400);
  const sevTxt2 = (await page.textContent('#sal-severance')).replace(/\s+/g, ' ');
  ok('改入职日后工龄变 6 年', /6년/.test(sevTxt2), sevTxt2.slice(0, 60));
  // 改发薪日
  await page.click('.tab[data-page="settings"]');
  await page.waitForTimeout(300);
  await page.fill('#set-pay-day', '25');
  await page.dispatchEvent('#set-pay-day', 'change');
  await page.waitForTimeout(300);
  await page.click('.tab[data-page="salary"]');
  await page.waitForTimeout(400);
  const payTxt25 = (await page.textContent('#sal-payday')).replace(/\s+/g, ' ');
  ok('发薪日改为 25 号生效', /10\/2\d/.test(payTxt25), payTxt25.trim());

  await page.screenshot({ path: path.join(OUT, '14-月薪实算.png'), fullPage: true });
  ok('全流程无 JS 报错', errors.length === 0, errors.slice(0, 3).join('; '));

  await browser.close();
  const fail = results.filter(r => !r[1]).length;
  console.log(`\n薪资规则 E2E: ${results.length - fail} 通过, ${fail} 失败`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('执行异常:', e.message); process.exit(1); });
