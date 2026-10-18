/* 考勤月历专项测试：状态判定 / 自动出结果 / 手工补签 / 月切换 / 边界处理 / 韩国法定假日
   用法：先起本地服务 python -m http.server 8901，再 node test/calendar.e2e.js */
const path = require('path');
const fs = require('fs');
const { chromium } = require(path.join('C:', 'Users', 'Administrator', '.workbuddy', 'binaries', 'node', 'workspace', 'node_modules', 'playwright'));

const BASE = process.env.BASE || 'http://127.0.0.1:8901/index.html';
const OUT = path.join(__dirname, '..', 'screenshots');
const MONTH = '2026-10';   // 目标月份
const FIXED_NOW = '2026-10-15T12:00:00';  // 冻结"今天"，保证判定稳定

// 班次：白班 08:20–20:20（周一 10:20 上班）；夜班 20:20–次日 08:20（周五 06:20 下班）
// 2026-10 星期分布：01 四 / 02 五 / 03 六 / 04 日 / 05 一 / … / 15 四 / 31 六
// 法定假日：10-03 개천절(六)、10-05 대체공휴일(一)、10-09 한글날(五)

const results = [];
const ok = (n, c, e = '') => { results.push([n, !!c]); console.log(`${c ? '✅' : '❌'} ${n}${e ? '  ' + e : ''}`); };

const GEO_MOCK = () => {
  if (!localStorage.getItem('__mockgeo')) localStorage.setItem('__mockgeo', JSON.stringify({ lat: 37.5, lng: 127.0 }));
  const g = JSON.parse(localStorage.getItem('__mockgeo'));
  navigator.geolocation.watchPosition = () => 1;
  navigator.geolocation.clearWatch = () => {};
  navigator.geolocation.getCurrentPosition = s => s({ coords: { latitude: g.lat, longitude: g.lng, accuracy: 10 } });
};

// 灌入覆盖各类状态的考勤（2026-10）
const SEED = () => {
  const KEY = 'salary_keeper_v1';
  const cur = JSON.parse(localStorage.getItem(KEY) || '{}');
  const att = {};
  const seg = (d, i, o) => ({
    in: new Date(`${d}T${i}`).toISOString(),
    out: o ? new Date(`${d}T${o}`).toISOString() : null
  });
  const mk = (d, i, o, extra = {}) => Object.assign({
    shiftType: 'day', segments: (i === null || i === undefined) ? [] : [seg(d, i, o)],
    restMinutes: 30, perf: 1, isRestDay: false, leave: null, makeups: []
  }, extra);

  att['2026-10-02'] = mk('2026-10-02');                        // 无记录工作日 → absent
  att['2026-10-05'] = mk('2026-10-05');                        // 法定假日无记录 → rest + 假日标
  att['2026-10-06'] = mk('2026-10-06', '08:22', '20:20');      // 正常
  att['2026-10-07'] = mk('2026-10-07', '09:30', '20:20');      // 迟到（应到 08:20）
  att['2026-10-08'] = mk('2026-10-08', '08:20', '19:00');      // 早退（应退 20:20）
  att['2026-10-09'] = mk('2026-10-09', '08:20', '20:20');      // 法定假日出勤 → 全天 1.5 倍
  att['2026-10-12'] = mk('2026-10-12', '10:30', '19:00');      // 周一迟到+早退（应到 10:20）
  att['2026-10-13'] = mk('2026-10-13', '08:20', null);         // 缺卡（有签到无签退）
  att['2026-10-14'] = mk('2026-10-14', null, null, { leave: { type: '연차', note: '休年假' } });
  att['2026-10-16'] = mk('2026-10-16', null, null, { isRestDay: true });
  cur.attendance = Object.assign(cur.attendance || {}, att);
  localStorage.setItem(KEY, JSON.stringify(cur));
};

const cellSel = d => `.cal-cell[data-date="${MONTH}-${String(d).padStart(2, '0')}"]`;

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 420, height: 940 }, locale: 'ko-KR' });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  page.on('console', m => { if (m.type() === 'error' && !m.text().includes('favicon')) errors.push(m.text()); });
  // 冻结 Date，让"今天"固定为 2026-10-15 12:00
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
  await page.waitForTimeout(500);
  await page.click('.tab[data-page="attendance"]');
  await page.waitForTimeout(400);

  const code = async d => page.getAttribute(cellSel(d), 'data-code');

  console.log('\n──── 一、月历渲染与状态（新班次 08:20–20:20） ────');
  ok('月历容器已渲染', (await page.$$(cellSel(6))).length === 1);
  const cellCount = await page.$$eval('.cal-cell', els => els.length);
  ok('格子数为整周 35 格', cellCount === 35, `实际 ${cellCount}`);
  const realDays = await page.$$eval('.cal-cell:not(.pad)', els => els.length);
  ok('2026-10 共 31 天', realDays === 31, `实际 ${realDays}`);
  ok('月首前补白正确（10-01 是周四）',
    (await page.$$eval('.cal-cell.pad', e => e.length)) === 4,
    `补白 ${await page.$$eval('.cal-cell.pad', e => e.length)} 格`);
  ok('今天高亮标记为 15 号', (await page.$$(cellSel(15) + '.today')).length === 1);

  ok('06 正常出勤 → normal', await code(6) === 'normal', await code(6));
  ok('07 迟到 09:30 → late', await code(7) === 'late', await code(7));
  ok('08 早退 19:00 → early', await code(8) === 'early', await code(8));
  ok('12 周一 10:30 到（应到 10:20）→ lateearly', await code(12) === 'lateearly', await code(12));
  ok('13 缺卡（未签退）→ missing', await code(13) === 'missing', await code(13));
  ok('14 请假 → leave', await code(14) === 'leave', await code(14));
  ok('16 休息日 → rest', await code(16) === 'rest', await code(16));
  ok('02 无记录工作日 → absent', await code(2) === 'absent', await code(2));
  ok('15 今天未打卡 → pending（不误判旷工）', await code(15) === 'pending', await code(15));
  ok('20 未来日期 → future', await code(20) === 'future', await code(20));
  ok('周一例外：10:22 到不算迟到', await page.evaluate(() => {
    const r = Store.day('2026-10-19');
    r.segments = [{ in: new Date('2026-10-19T10:22').toISOString(), out: new Date('2026-10-19T20:20').toISOString() }];
    return Salary.judgeDay('2026-10-19', { now: new Date('2026-10-20') }).code;
  }) === 'normal');
  ok('周二同样 10:22 到则算迟到', await page.evaluate(() => {
    const r = Store.day('2026-10-20');
    r.segments = [{ in: new Date('2026-10-20T10:22').toISOString(), out: new Date('2026-10-20T20:20').toISOString() }];
    return Salary.judgeDay('2026-10-20', { now: new Date('2026-10-25') }).code;
  }) === 'late');
  // 周五夜班：20:20 上班 → 周六 06:20 下班（跨午夜归次日）
  ok('周五夜班周六 06:20 退 → normal', await page.evaluate(() => {
    const r = Store.day('2026-10-23');
    r.shiftType = 'night';
    r.segments = [{ in: new Date('2026-10-23T20:20').toISOString(), out: new Date('2026-10-24T06:20').toISOString() }];
    return Salary.judgeDay('2026-10-23', { now: new Date('2026-10-24T23:59:59') }).code;
  }) === 'normal');
  ok('周五夜班周六 06:00 退 → early（按 06:20 算早退）', await page.evaluate(() => {
    const r = Store.day('2026-10-23');
    r.shiftType = 'night';
    r.segments = [{ in: new Date('2026-10-23T20:20').toISOString(), out: new Date('2026-10-24T06:00').toISOString() }];
    return Salary.judgeDay('2026-10-23', { now: new Date('2026-10-24T23:59:59') }).code;
  }) === 'early');

  console.log('\n──── 二、韩国法定假日标识 ────');
  const holidayDays = await page.$$eval('.cal-cell.s-holiday', els => els.map(e => e.dataset.date));
  ok('10 月标出 3 个法定假日', holidayDays.length === 3, holidayDays.join(' '));
  ok('含 개천절 10-03', holidayDays.includes('2026-10-03'));
  ok('含 대체공휴일 10-05', holidayDays.includes('2026-10-05'));
  ok('含 한글날 10-09', holidayDays.includes('2026-10-09'));
  ok('10-05 无记录 → 判定为休息', await code(5) === 'rest', await code(5));
  ok('10-09 假日出勤 → 仍判为出勤', ['normal', 'late', 'early'].includes(await code(9)), await code(9));
  ok('10-09 出勤格带金边（全天 1.5 倍）',
    (await page.$$(cellSel(9) + '.s-holiday:not(.s-rest)')).length === 1);
  const statHol = (await page.textContent('#att-stat')).replace(/\s+/g, ' ');
  ok('统计含「法定假日」计数', /法定假日\s*3/.test(statHol), statHol.slice(0, 70));
  ok('统计含「假日出勤」计数', /假日出勤\s*1/.test(statHol), statHol.slice(0, 70));

  console.log('\n──── 三、自动出结果（无需人工） ────');
  ok('未人工录入即有状态', ['normal', 'late', 'early', 'missing', 'absent'].includes(await code(6)));
  const chipTxt = await page.textContent('#att-stat');
  ok('统计胶囊显示出勤天数', chipTxt.includes('出勤'), chipTxt.replace(/\s+/g, ' ').trim().slice(0, 60));
  ok('统计含迟到计数', /迟到\s*1/.test(chipTxt.replace(/\s+/g, ' ')), '');
  ok('统计含旷工计数', /旷工/.test(chipTxt), '');
  ok('请假计入统计', /请假\s*1/.test(chipTxt.replace(/\s+/g, ' ')), '');

  console.log('\n──── 四、未来日期与边界 ────');
  ok('未来日期不可点击补签', (await page.$$(cellSel(20) + '.tappable')).length === 0);
  ok('未来日期不显示状态字', (await page.textContent(cellSel(20))).trim() === '20');
  const fut = await page.$$eval('.cal-cell.s-future', e => e.length);
  // 10-16~10-31 共 16 天：减去周日 18/25 与手动休息日 16 → 13 格 future
  ok('未来工作日为 future（16 天 − 2 个周日 − 1 个休息日）', fut === 13, `future ${fut} 格`);
  ok('未来的周休日显示为休息', await code(18) === 'rest' && await code(25) === 'rest',
    `18→${await code(18)} 25→${await code(25)}`);
  ok('未来的普通工作日仍为 future', await code(21) === 'future', await code(21));

  console.log('\n──── 五、手工补签 ────');
  await page.click(cellSel(13));   // 缺卡：有签到无签退
  await page.waitForTimeout(350);
  ok('点击格子打开补签面板', !(await page.getAttribute('#mk-mask', 'hidden') === ''));
  ok('面板标题显示日期', (await page.textContent('#mk-title')) === '2026-10-13');
  ok('面板状态徽标显示缺卡', (await page.textContent('#mk-status')).includes('缺卡'));
  const detail0 = await page.textContent('#mk-detail');
  ok('明细展示现有打卡段', detail0.includes('08:20') && detail0.includes('未签退'));
  ok('明细标注来源为自动打卡', detail0.includes('自动打卡'));

  await page.click('.seg-btn[data-type="out"]');
  await page.waitForTimeout(150);
  await page.fill('#mk-time', '20:20');
  await page.fill('#mk-note', '忘打卡补签');
  await page.click('#mk-submit');
  await page.waitForTimeout(400);
  const msg1 = await page.textContent('#mk-msg');
  ok('补签退提交成功', msg1.includes('成功'), msg1);
  ok('补签后状态自动刷新为 normal', await code(13) === 'normal', `实际 ${await code(13)}`);
  ok('明细已含补签时间', (await page.textContent('#mk-detail')).includes('20:20'));
  ok('明细标注来源为手工补签', (await page.textContent('#mk-detail')).includes('手工补签'));
  ok('补签记录已留痕', (await page.textContent('#mk-logs')).includes('忘打卡补签'));
  ok('日历格子出现补签圆点', (await page.$$(cellSel(13) + ' .mkdot')).length === 1);
  ok('统计胶囊出现补签计数', (await page.textContent('#att-stat')).includes('补签'));

  console.log('\n──── 六、合法性校验 ────');
  await page.click('.seg-btn[data-type="in"]');
  await page.waitForTimeout(120);
  await page.fill('#mk-time', '10:00');
  await page.fill('#mk-note', '');
  await page.click('#mk-submit');
  await page.waitForTimeout(300);
  const msg2 = await page.textContent('#mk-msg');
  ok('重复补签到被拒绝', msg2.includes('已有签到') || msg2.includes('无需'), msg2);

  const futureRes = await page.evaluate(() => Store.addMakeup('2026-10-20', { type: 'in', time: '2026-10-20T09:00' }));
  ok('未来日期补签被拒绝', futureRes.ok === false, futureRes.msg);
  const outOfRange = await page.evaluate(() => Store.addMakeup('2026-10-06', { type: 'in', time: '2026-10-07T09:00' }));
  ok('跨日时间被拒绝', outOfRange.ok === false, outOfRange.msg);
  const badType = await page.evaluate(() => Store.addMakeup('2026-10-06', { type: 'x', time: '2026-10-06T09:00' }));
  ok('非法补签类型被拒绝', badType.ok === false, badType.msg);

  console.log('\n──── 七、补签可追溯与撤销 ────');
  await page.click('.seg-btn[data-type="out"]');
  await page.waitForTimeout(150);
  page.once('dialog', d => d.accept());
  await page.click('#mk-logs .lx');
  await page.waitForTimeout(400);
  ok('撤销后回到缺卡状态', await code(13) === 'missing', `实际 ${await code(13)}`);
  ok('撤销后补签记录清空', (await page.textContent('#mk-logs')).includes('暂无'));
  ok('撤销后明细回到未签退', (await page.textContent('#mk-detail')).includes('未签退'));
  await page.click('#mk-close'); await page.waitForTimeout(200);

  console.log('\n──── 八、请假 / 休息日 ────');
  await page.click(cellSel(2));           // 02 是无记录 → 旷工
  await page.waitForTimeout(350);
  await page.selectOption('#mk-leave-type', '병가');
  await page.click('#mk-leave');
  await page.waitForTimeout(350);
  ok('登记请假后状态变 leave', await code(2) === 'leave', `实际 ${await code(2)}`);
  await page.click('#mk-leave');
  await page.waitForTimeout(350);
  ok('再次点击取消请假', await code(2) === 'absent', `实际 ${await code(2)}`);
  await page.click('#mk-rest');
  await page.waitForTimeout(350);
  ok('标记休息日后状态变 rest', await code(2) === 'rest', `实际 ${await code(2)}`);
  await page.click('#mk-rest');
  await page.waitForTimeout(350);
  ok('取消休息日回到 absent', await code(2) === 'absent', `实际 ${await code(2)}`);
  await page.click('#mk-close');
  await page.waitForTimeout(200);
  ok('面板可关闭', (await page.getAttribute('#mk-mask', 'hidden')) === '');
  await page.screenshot({ path: path.join(OUT, '11-考勤月历.png'), fullPage: true });

  console.log('\n──── 九、月切换与历史月份 ────');
  const m0 = await page.textContent('#cur-month');
  await page.click('#prev-month'); await page.waitForTimeout(350);
  const m1 = await page.textContent('#cur-month');
  ok('上一月切换生效', m1 === '2026-09', `${m0} → ${m1}`);
  const grid9 = await page.$$eval('.cal-cell:not(.pad)', e => e.length);
  ok('2026-09 渲染 30 天', grid9 === 30, `实际 ${grid9}`);
  const stat9 = (await page.textContent('#att-stat')).replace(/\s+/g, ' ').trim();
  // 2026-09 无记录：工作日如实判旷工；추석 09-24/25/26 三个法定假日判休息
  ok('无数据月份如实判为旷工', /旷工/.test(stat9), stat9.slice(0, 80));
  ok('历史月标出 추석 三个法定假日', /法定假日\s*3/.test(stat9), stat9.slice(0, 80));
  const codes9 = await page.$$eval('.cal-cell[data-code]', e => e.map(x => x.dataset.code));
  ok('历史月无记录按旷工/休息判定', codes9.filter(c => c === 'future').length === 0,
    `future 格数 ${codes9.filter(c => c === 'future').length}`);

  await page.click('#prev-month'); await page.waitForTimeout(300);
  ok('可继续切到更早月份', (await page.textContent('#cur-month')) === '2026-08');
  await page.click('#next-month'); await page.waitForTimeout(300);
  ok('下一月切回 2026-09', (await page.textContent('#cur-month')) === '2026-09');
  await page.click('#next-month'); await page.waitForTimeout(300);
  ok('再下一月回到 2026-10', (await page.textContent('#cur-month')) === '2026-10');
  ok('切回后数据仍在', (await page.$$(cellSel(6) + '.s-normal')).length === 1);

  console.log('\n──── 十、跨年切换 ────');
  for (let i = 0; i < 9; i++) { await page.click('#prev-month'); await page.waitForTimeout(80); }
  ok('跨年往前切正常', (await page.textContent('#cur-month')) === '2026-01', await page.textContent('#cur-month'));
  await page.click('#prev-month'); await page.waitForTimeout(300);
  ok('2026-01 再往前到 2025-12', (await page.textContent('#cur-month')) === '2025-12', await page.textContent('#cur-month'));
  const dec = await page.$$eval('.cal-cell:not(.pad)', e => e.length);
  ok('2025-12 渲染 31 天', dec === 31, `实际 ${dec}`);
  const decHol = await page.$$eval('.cal-cell.s-holiday', e => e.map(x => x.dataset.date));
  ok('2025-12 标出圣诞节', decHol.includes('2025-12-25'), decHol.join(' '));

  console.log('\n──── 十一、班次 / 日薪 / 假日配置联动 ────');
  for (let i = 0; i < 14; i++) {
    if ((await page.textContent('#cur-month')) === MONTH) break;
    await page.click('#next-month');
    await page.waitForTimeout(90);
  }
  ok('已切回 2026-10', (await page.textContent('#cur-month')) === MONTH, await page.textContent('#cur-month'));

  await page.click('.tab[data-page="settings"]');
  await page.waitForTimeout(400);
  ok('班次：白班上班 08:20', (await page.inputValue('#set-day-start')) === '08:20');
  ok('班次：白班下班 20:20', (await page.inputValue('#set-day-end')) === '20:20');
  ok('班次：夜班上班 20:20', (await page.inputValue('#set-night-shift-start')) === '20:20');
  ok('班次：夜班下班 08:20', (await page.inputValue('#set-night-shift-end')) === '08:20');
  ok('班次：周一晚上班开关默认开', await page.isChecked('#set-mon-late'));
  ok('班次：周一上班 10:20', (await page.inputValue('#set-mon-start')) === '10:20');
  ok('班次：周五早下班开关默认开', await page.isChecked('#set-fri-early'));
  ok('班次：周五下班 06:20', (await page.inputValue('#set-fri-end')) === '06:20');
  ok('班次：每周上班 5 天', (await page.inputValue('#set-weekly-work-days')) === '5');
  ok('休息扣除为 30 分钟', (await page.inputValue('#set-rest-minutes')) === '30');
  ok('日薪：标准 8 小时', (await page.inputValue('#set-std-hours')) === '8');
  ok('日薪：固定加班 3.5 小时', (await page.inputValue('#set-fixed-ot')) === '3.5');
  ok('日薪：夜班补助 3.5 小时', (await page.inputValue('#set-night-allow-h')) === '3.5');
  ok('日薪：节假日倍率 1.5', (await page.inputValue('#set-holiday-mul')) === '1.5');
  ok('假日来源默认内置表', (await page.inputValue('#set-holiday-source')) === 'builtin');
  ok('迟到宽限 5 分钟', (await page.inputValue('#set-late-grace')) === '5');
  ok('周休日选择器已渲染 7 天', (await page.$$('#set-rest-weekdays button')).length === 7);
  ok('默认周休为周日', (await page.$$eval('#set-rest-weekdays button', els => els.filter(b => b.classList.contains('on')).map(b => b.dataset.wd).join(','))) === '0');

  // 把白班上班时间提前到 08:00，原本正常的 06 号（08:22 到）应变迟到
  await page.fill('#set-day-start', '08:00');
  await page.dispatchEvent('#set-day-start', 'change');
  await page.waitForTimeout(300);
  await page.click('.tab[data-page="attendance"]');
  await page.waitForTimeout(350);
  ok('改白班上班时间后 06 号转迟到', await code(6) === 'late', `实际 ${await code(6)}`);

  await page.click('.tab[data-page="settings"]');
  await page.waitForTimeout(300);
  await page.fill('#set-day-start', '08:20');
  await page.dispatchEvent('#set-day-start', 'change');
  await page.waitForTimeout(250);
  // 关闭内置假日表 → 假日标记应消失
  await page.selectOption('#set-holiday-source', 'custom');
  await page.dispatchEvent('#set-holiday-source', 'change');
  await page.waitForTimeout(300);
  await page.click('.tab[data-page="attendance"]');
  await page.waitForTimeout(350);
  ok('关闭内置假日表后 10-09 不再标为假日',
    (await page.$$(cellSel(9) + '.s-holiday')).length === 0);
  await page.click('.tab[data-page="settings"]');
  await page.waitForTimeout(250);
  await page.selectOption('#set-holiday-source', 'builtin');
  await page.dispatchEvent('#set-holiday-source', 'change');
  await page.waitForTimeout(250);
  await page.click('.tab[data-page="attendance"]');
  await page.waitForTimeout(350);
  ok('还原后 10-09 重新标为假日', (await page.$$(cellSel(9) + '.s-holiday')).length === 1);
  ok('还原后 06 号回到正常', await code(6) === 'normal', `实际 ${await code(6)}`);

  ok('全流程无 JS 报错', errors.length === 0, errors.slice(0, 3).join('; '));

  await browser.close();
  const fail = results.filter(r => !r[1]).length;
  console.log(`\n考勤月历 E2E: ${results.length - fail} 通过, ${fail} 失败`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('执行异常:', e.message); process.exit(1); });
