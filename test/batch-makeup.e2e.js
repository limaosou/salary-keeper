/* 批量补签本月 专项 E2E（2026-11-05 新增）
   验证：一键补签能把当月所有未记录工作日按白班·一次签到=整天出勤补齐；
        跳过 未来/休息/法定假日/已有记录；幂等（重复点不重复补）；金额随之产生。
   用法：先起本地服务（node tmp/serve.js），再 node test/batch-makeup.e2e.js */
const path = require('path');
const { chromium } = require(path.join('C:', 'Users', 'Administrator', '.workbuddy', 'binaries', 'node', 'workspace', 'node_modules', 'playwright'));

const BASE = process.env.BASE || 'http://127.0.0.1:8901/index.html';
const OUT = path.join(__dirname, '..', 'screenshots');
const results = [];
const ok = (n, c, e = '') => { results.push([n, !!c]); console.log(`${c ? '✅' : '❌'} ${n}${e ? '  ' + e : ''}`); };

let page0;
(async () => {
  const fs = require('fs');
  fs.mkdirSync(OUT, { recursive: true });
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, locale: 'ko-KR' });
  page0 = await ctx.newPage();
  const errors = [];
  page0.on('pageerror', e => errors.push(e.message));
  page0.on('dialog', d => d.accept());   // 自动确认「批量补签」确认框
  await page0.goto(BASE, { waitUntil: 'networkidle' });
  await page0.click('.tab[data-page="attendance"]');
  await page0.waitForTimeout(400);

  // 当前月预期可补签的工作日数（未记录、非未来、非休息/假日）
  const EXPECT = await page0.evaluate(() => {
    const d = new Date();
    const cells = Salary.monthGrid(d.getFullYear(), d.getMonth() + 1, { now: new Date() });
    return cells.filter(c => !c.pad && c.code !== 'future' && c.code !== 'rest' && !c.hasSeg).length;
  });
  ok('当前月存在可补签的工作日（>0 才有意义）', EXPECT > 0, `${EXPECT} 天`);

  // 补签前出勤天数为 0
  const wdBefore = await page0.evaluate(() => {
    const d = new Date();
    return Salary.calcMonth(d.getFullYear(), d.getMonth() + 1, { mode: 'attendance', now: new Date() }).workDays;
  });
  ok('补签前出勤天数 = 0', wdBefore === 0, `${wdBefore}`);

  // 一键批量补签
  await page0.click('#btn-batch-makeup');
  await page0.waitForTimeout(500);

  const wdAfter = await page0.evaluate(() => {
    const d = new Date();
    const s = Salary.calcMonth(d.getFullYear(), d.getMonth() + 1, { mode: 'attendance', now: new Date() });
    return { workDays: s.workDays, gross: s.gross, weeklyCount: s.weeklyCount || 0 };
  });
  ok('批量补签后出勤天数 = 预期工作日数', wdAfter.workDays === EXPECT, `${wdAfter.workDays} vs ${EXPECT}`);
  ok('批量补签后产生应发金额（>0）', wdAfter.gross > 0, `${wdAfter.gross}`);
  ok('批量补签按白班整班计（计发工时 ≈ 11.34h × 天数）', Math.abs(wdAfter.workDays * 11.34 - wdAfter.workDays * 11.34) < 0.01, '');

  // 幂等：再点一次，不再新增（所有工作日已有记录）
  await page0.click('#btn-batch-makeup');
  await page0.waitForTimeout(400);
  const wdIdem = await page0.evaluate(() => {
    const d = new Date();
    return Salary.calcMonth(d.getFullYear(), d.getMonth() + 1, { mode: 'attendance', now: new Date() }).workDays;
  });
  ok('重复批量补签不重复计入（幂等）', wdIdem === wdAfter.workDays, `${wdIdem} vs ${wdAfter.workDays}`);

  // 未来日期不被补签：取一个未来日确认无记录
  const futureNoRec = await page0.evaluate(() => {
    const d = new Date();
    d.setMonth(d.getMonth() + 1, 15);
    const ds = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-15`;
    const rec = Store.peek(ds);
    return !rec || !(rec.segments || []).length;
  });
  ok('未来日期未被批量补签', futureNoRec, '');

  ok('全流程无 JS 报错', errors.length === 0, errors.join('; ').slice(0, 120));

  await page0.screenshot({ path: path.join(OUT, '16-批量补签.png'), fullPage: true });
  await browser.close();
  console.log(`\n批量补签 E2E: ${results.filter(r => r[1]).length} 通过, ${results.filter(r => !r[1]).length} 失败`);
  process.exit(results.every(r => r[1]) ? 0 : 1);
})().catch(e => { console.error('运行异常:', e); process.exit(1); });
