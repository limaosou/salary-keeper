/* 考勤月历专项测试：状态判定 / 自动出结果 / 手工补签 / 月切换 / 边界处理
   用法：先起本地服务 python -m http.server 8901，再 node test/calendar.e2e.js */
const path = require('path');
const fs = require('fs');
const { chromium } = require(path.join('C:', 'Users', 'Administrator', '.workbuddy', 'binaries', 'node', 'workspace', 'node_modules', 'playwright'));

const BASE = process.env.BASE || 'http://127.0.0.1:8901/index.html';
const OUT = path.join(__dirname, '..', 'screenshots');
const MONTH = '2026-10';   // 目标月份
const FIXED_NOW = '2026-10-15T12:00:00';  // 冻结"今天"，保证判定稳定

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
const SEED = (ds => {
  const KEY = 'salary_keeper_v1';
  const cur = JSON.parse(localStorage.getItem(KEY) || '{}');
  const att = {};
  const seg = (d, i, o) => ({
    in: new Date(`${d}T${i}`).toISOString(),
    out: o ? new Date(`${d}T${o}`).toISOString() : null
  });
  // 5 正常 / 6 迟到 / 7 早退 / 8 迟到+早退 / 9 缺卡(未签退) / 12 请假 / 13 休息日
  att['2026-10-05'] = { shiftType: 'day', segments: [seg('2026-10-05', '09:02', '18:05')], restMinutes: 60, perf: 1, isRestDay: false, leave: null, makeups: [] };
  att['2026-10-06'] = { shiftType: 'day', segments: [seg('2026-10-06', '09:20', '18:05')], restMinutes: 60, perf: 1, isRestDay: false, leave: null, makeups: [] };
  att['2026-10-07'] = { shiftType: 'day', segments: [seg('2026-10-07', '08:55', '17:00')], restMinutes: 60, perf: 1, isRestDay: false, leave: null, makeups: [] };
  att['2026-10-08'] = { shiftType: 'day', segments: [seg('2026-10-08', '09:30', '16:30')], restMinutes: 60, perf: 1, isRestDay: false, leave: null, makeups: [] };
  att['2026-10-09'] = { shiftType: 'day', segments: [seg('2026-10-09', '09:00', null)], restMinutes: 60, perf: 1, isRestDay: false, leave: null, makeups: [] };
  att['2026-10-12'] = { shiftType: 'day', segments: [], restMinutes: 60, perf: 1, isRestDay: false, leave: { type: '연차', note: '休年假' }, makeups: [] };
  att['2026-10-13'] = { shiftType: 'day', segments: [], restMinutes: 60, perf: 1, isRestDay: true, leave: null, makeups: [] };
  cur.attendance = Object.assign(cur.attendance || {}, att);
  localStorage.setItem(KEY, JSON.stringify(cur));
});

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

  console.log('\n──── 一、月历渲染与状态 ────');
  ok('月历容器已渲染', (await page.$$(cellSel(5))).length === 1);
  // 2026-10-01 是周四，前补 4 格 + 31 天 = 35 格
  const cellCount = await page.$$eval('.cal-cell', els => els.length);
  ok('格子数为整周 35 格', cellCount === 35, `实际 ${cellCount}`);
  const realDays = await page.$$eval('.cal-cell:not(.pad)', els => els.length);
  ok('2026-10 共 31 天', realDays === 31, `实际 ${realDays}`);
  ok('月首前补白正确（10-01 是周四）',
    (await page.$$eval('.cal-cell.pad', e => e.length)) === 4,
    `补白 ${await page.$$eval('.cal-cell.pad', e => e.length)} 格`);
  ok('今天高亮标记为 15 号', (await page.$$(cellSel(15) + '.today')).length === 1);

  const code = async d => page.getAttribute(cellSel(d), 'data-code');
  ok('05 正常出勤 → normal', await code(5) === 'normal', await code(5));
  ok('06 迟到     → late', await code(6) === 'late', await code(6));
  ok('07 早退     → early', await code(7) === 'early', await code(7));
  ok('08 迟到早退 → lateearly', await code(8) === 'lateearly', await code(8));
  ok('09 缺卡     → missing', await code(9) === 'missing', await code(9));
  ok('12 请假     → leave', await code(12) === 'leave', await code(12));
  ok('13 休息日   → rest', await code(13) === 'rest', await code(13));
  ok('11 周休日   → rest', await code(11) === 'rest', await code(11));
  ok('02 无记录工作日 → absent', await code(2) === 'absent', await code(2));
  ok('15 今天未打卡 → pending（不误判旷工）', await code(15) === 'pending', await code(15));
  ok('20 未来日期 → future', await code(20) === 'future', await code(20));

  console.log('\n──── 二、自动出结果（无需人工） ────');
  ok('未人工录入即有状态', ['normal', 'late', 'early', 'missing', 'absent'].includes(await code(6)));
  const chipTxt = await page.textContent('#att-stat');
  ok('统计胶囊显示出勤天数', chipTxt.includes('出勤'), chipTxt.replace(/\s+/g, ' ').trim().slice(0, 60));
  ok('统计含迟到计数', /迟到\s*1/.test(chipTxt.replace(/\s+/g, ' ')), '');
  ok('统计含旷工计数', /旷工/.test(chipTxt), '');
  ok('请假计入统计', /请假\s*1/.test(chipTxt.replace(/\s+/g, ' ')), '');

  console.log('\n──── 三、未来日期与边界 ────');
  ok('未来日期不可点击补签', (await page.$$(cellSel(20) + '.tappable')).length === 0);
  ok('未来日期不显示状态字', (await page.textContent(cellSel(20))).trim() === '20');
  const fut = await page.$$eval('.cal-cell.s-future', e => e.length);
  // 10-16~10-31 共 16 天，其中周日 18/25 应显示为「休」而非「未来」
  ok('未来工作日为 future（16 天去掉 2 个周日）', fut === 14, `future ${fut} 格`);
  ok('未来的周休日显示为休息', await code(18) === 'rest' && await code(25) === 'rest',
    `18→${await code(18)} 25→${await code(25)}`);
  ok('未来的普通工作日仍为 future', await code(21) === 'future', await code(21));

  console.log('\n──── 四、手工补签 ────');
  // 给 09 号（缺卡：有签到无签退）补签退
  await page.click(cellSel(9));
  await page.waitForTimeout(350);
  ok('点击格子打开补签面板', !(await page.getAttribute('#mk-mask', 'hidden') === ''));
  ok('面板标题显示日期', (await page.textContent('#mk-title')) === '2026-10-09');
  ok('面板状态徽标显示缺卡', (await page.textContent('#mk-status')).includes('缺卡'));
  const detail0 = await page.textContent('#mk-detail');
  ok('明细展示现有打卡段', detail0.includes('09:00') && detail0.includes('未签退'));
  ok('明细标注来源为自动打卡', detail0.includes('自动打卡'));

  // 切到"补签退"
  await page.click('.seg-btn[data-type="out"]');
  await page.waitForTimeout(150);
  await page.fill('#mk-time', '18:30');
  await page.fill('#mk-note', '忘打卡补签');
  await page.click('#mk-submit');
  await page.waitForTimeout(400);
  const msg1 = await page.textContent('#mk-msg');
  ok('补签退提交成功', msg1.includes('成功'), msg1);
  ok('补签后状态自动刷新为 normal', await code(9) === 'normal', `实际 ${await code(9)}`);
  ok('明细已含补签时间', (await page.textContent('#mk-detail')).includes('18:30'));
  ok('明细标注来源为手工补签', (await page.textContent('#mk-detail')).includes('手工补签'));
  ok('补签记录已留痕', (await page.textContent('#mk-logs')).includes('忘打卡补签'));
  ok('日历格子出现补签圆点', (await page.$$(cellSel(9) + ' .mkdot')).length === 1);
  ok('统计胶囊出现补签计数', (await page.textContent('#att-stat')).includes('补签'));

  console.log('\n──── 五、合法性校验 ────');
  await page.click('.seg-btn[data-type="in"]');
  await page.waitForTimeout(120);
  await page.fill('#mk-time', '10:00');
  await page.fill('#mk-note', '');
  await page.click('#mk-submit');
  await page.waitForTimeout(300);
  const msg2 = await page.textContent('#mk-msg');
  ok('重复补签到被拒绝', msg2.includes('已有签到') || msg2.includes('无需'), msg2);

  // 未来日期不可补签（通过引擎侧直接验证）
  const futureRes = await page.evaluate(() => Store.addMakeup('2026-10-20', { type: 'in', time: '2026-10-20T09:00' }));
  ok('未来日期补签被拒绝', futureRes.ok === false, futureRes.msg);
  const outOfRange = await page.evaluate(() => Store.addMakeup('2026-10-05', { type: 'in', time: '2026-10-06T09:00' }));
  ok('跨日时间被拒绝', outOfRange.ok === false, outOfRange.msg);
  const badType = await page.evaluate(() => Store.addMakeup('2026-10-05', { type: 'x', time: '2026-10-05T09:00' }));
  ok('非法补签类型被拒绝', badType.ok === false, badType.msg);

  console.log('\n──── 六、补签可追溯与撤销 ────');
  await page.click('.seg-btn[data-type="out"]');
  await page.waitForTimeout(150);
  page.once('dialog', d => d.accept());
  await page.click('#mk-logs .lx');
  await page.waitForTimeout(400);
  ok('撤销后回到缺卡状态', await code(9) === 'missing', `实际 ${await code(9)}`);
  ok('撤销后补签记录清空', (await page.textContent('#mk-logs')).includes('暂无'));
  ok('撤销后明细回到未签退', (await page.textContent('#mk-detail')).includes('未签退'));
  await page.click('#mk-close'); await page.waitForTimeout(200);

  console.log('\n──── 七、请假 / 休息日 ────');
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

  console.log('\n──── 八、月切换与历史月份 ────');
  const m0 = await page.textContent('#cur-month');
  await page.click('#prev-month'); await page.waitForTimeout(350);
  const m1 = await page.textContent('#cur-month');
  ok('上一月切换生效', m1 === '2026-09', `${m0} → ${m1}`);
  const grid9 = await page.$$eval('.cal-cell:not(.pad)', e => e.length);
  ok('2026-09 渲染 30 天', grid9 === 30, `实际 ${grid9}`);
  // 无数据但已过去的月份：工作日应如实判为旷工，而不是笼统显示"暂无"
  const stat9 = (await page.textContent('#att-stat')).replace(/\s+/g, ' ').trim();
  ok('无数据月份如实判为旷工', /旷工\s*26/.test(stat9), stat9);
  // 2026-09 全是过去日期且无记录 → 应判为旷工/休息，而不是 future
  const codes9 = await page.$$eval('.cal-cell[data-code]', e => e.map(x => x.dataset.code));
  ok('历史月无记录按旷工/休息判定', codes9.filter(c => c === 'future').length === 0,
    `future 格数 ${codes9.filter(c => c === 'future').length}`);

  await page.click('#prev-month'); await page.waitForTimeout(300);
  ok('可继续切到更早月份', (await page.textContent('#cur-month')) === '2026-08');
  await page.click('#next-month'); await page.waitForTimeout(300);
  ok('下一月切回 2026-09', (await page.textContent('#cur-month')) === '2026-09');
  await page.click('#next-month'); await page.waitForTimeout(300);
  ok('再下一月回到 2026-10', (await page.textContent('#cur-month')) === '2026-10');
  ok('切回后数据仍在', await page.$$(cellSel(5) + '.s-normal') !== null);

  console.log('\n──── 九、跨年切换 ────');
  // 连点到 2026-01 再往前 → 2025-12
  for (let i = 0; i < 9; i++) { await page.click('#prev-month'); await page.waitForTimeout(80); }
  const mx = await page.textContent('#cur-month');
  ok('跨年往前切正常', mx === '2026-01', `实际 ${mx}`);
  await page.click('#prev-month'); await page.waitForTimeout(300);
  const my = await page.textContent('#cur-month');
  ok('2026-01 再往前到 2025-12', my === '2025-12', `实际 ${my}`);
  const dec = await page.$$eval('.cal-cell:not(.pad)', e => e.length);
  ok('2025-12 渲染 31 天', dec === 31, `实际 ${dec}`);

  console.log('\n──── 十、出勤规则配置联动 ────');
  // 第九章末尾停在 2025-12，先切回 2026-10
  for (let i = 0; i < 14; i++) {
    if ((await page.textContent('#cur-month')) === MONTH) break;
    await page.click('#next-month');
    await page.waitForTimeout(90);
  }
  ok('已切回 2026-10', (await page.textContent('#cur-month')) === MONTH, await page.textContent('#cur-month'));

  await page.click('.tab[data-page="settings"]');
  await page.waitForTimeout(400);
  ok('设置页有上班时间字段', (await page.inputValue('#set-work-start')) === '09:00');
  ok('设置页有下班时间字段', (await page.inputValue('#set-work-end')) === '18:00');
  ok('设置页有迟到宽限字段', (await page.inputValue('#set-late-grace')) === '5');
  ok('周休日选择器已渲染 7 天', (await page.$$('#set-rest-weekdays button')).length === 7);
  ok('默认周休为周日', (await page.$$eval('#set-rest-weekdays button', els => els.filter(b => b.classList.contains('on')).map(b => b.dataset.wd).join(','))) === '0');

  // 把周休改成 周日+周六，月历上的周六应变为休息
  await page.click('#set-rest-weekdays button[data-wd="6"]');
  await page.waitForTimeout(300);
  await page.click('.tab[data-page="attendance"]');
  await page.waitForTimeout(350);
  ok('改周休后过去与未来的周六都变休息',
    await code(3) === 'rest' && await code(17) === 'rest',
    `03→${await code(3)} / 17→${await code(17)}`);

  // 把上班时间提前到 08:30，原本迟到的 06 号（09:20）仍迟到，但 05 号（09:02）变迟到
  await page.click('.tab[data-page="settings"]');
  await page.waitForTimeout(300);
  await page.fill('#set-work-start', '08:30');
  await page.dispatchEvent('#set-work-start', 'change');
  await page.waitForTimeout(300);
  await page.click('.tab[data-page="attendance"]');
  await page.waitForTimeout(350);
  ok('改上班时间后 05 号转迟到', await code(5) === 'late', `实际 ${await code(5)}`);

  // 还原，避免影响后续断言
  await page.click('.tab[data-page="settings"]');
  await page.waitForTimeout(300);
  await page.fill('#set-work-start', '09:00');
  await page.dispatchEvent('#set-work-start', 'change');
  await page.waitForTimeout(200);
  await page.click('#set-rest-weekdays button[data-wd="6"]');
  await page.waitForTimeout(200);
  await page.click('.tab[data-page="attendance"]');
  await page.waitForTimeout(350);
  ok('还原后 05 号回到正常', await code(5) === 'normal', `实际 ${await code(5)}`);

  ok('全流程无 JS 报错', errors.length === 0, errors.slice(0, 3).join('; '));

  await browser.close();
  const fail = results.filter(r => !r[1]).length;
  console.log(`\n考勤月历 E2E: ${results.length - fail} 通过, ${fail} 失败`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('执行异常:', e.message); process.exit(1); });
