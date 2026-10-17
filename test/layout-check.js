/* 布局回归测试：多窄视口 × 四个页面 + 补签浮层 + 满月长明细
   断言：documentElement.scrollWidth 不得超出视口（不允许横向滚动），且不得有元素右边越界。
   背景：设置页 .field input 写死 width:150px，而表单控件默认 min-width:auto 不肯收缩 → 375px 下整页可横向滚动。 */
const path = require('path');
const fs = require('fs');
const { chromium } = require(path.join('C:', 'Users', 'Administrator', '.workbuddy', 'binaries', 'node', 'workspace', 'node_modules', 'playwright'));

const BASE = process.env.BASE || 'http://127.0.0.1:8901/index.html';
const OUT = process.env.OUT ? path.resolve(process.env.OUT) : path.join(__dirname, '..', 'screenshots');
const KEY = 'salary_keeper_v1';
const results = [];
const ok = (msg, cond, extra = '') => {
  results.push([msg, !!cond]);
  console.log(`${cond ? '✅' : '❌'} ${msg}${extra ? '  ' + extra : ''}`);
};

const VIEWPORTS = [
  { name: 'iPhone SE 375', width: 375, height: 667 },
  { name: 'iPhone 14 390', width: 390, height: 844 },
  { name: 'Galaxy S20 360', width: 360, height: 800 },
];
const PAGES = [['today', '首页'], ['attendance', '考勤'], ['salary', '月薪'], ['settings', '设置']];

// 在页面里跑一遍：返回横向溢出详情
const probe = () => {
  const vw = window.innerWidth;
  const hits = [];
  for (const el of document.querySelectorAll('*')) {
    const r = el.getBoundingClientRect();
    if (!r.width && !r.height) continue;
    const cs = getComputedStyle(el);
    if (cs.visibility === 'hidden' || cs.display === 'none') continue;
    const overRight = r.right - vw;
    const overLeft = r.left < -1 ? -r.left : 0;
    if (overRight > 1 || overLeft > 1) {
      hits.push(`<${el.tagName.toLowerCase()}${el.id ? '#' + el.id : ''}> ` +
        `超右=${Math.round(overRight)} 超左=${Math.round(overLeft)} | ` +
        `"${(el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 30)}"`);
    }
  }
  return { vw, docScroll: document.documentElement.scrollWidth, hits };
};

// 灌一个月满数据 + 超长名称，模拟真实使用的最坏情况
// 注意：这个函数会被序列化后注入页面，不能引用 Node 作用域的变量
const SEED = () => {
  const K = 'salary_keeper_v1';
  const HOUR = 3600000;
  const cur = JSON.parse(localStorage.getItem(K) || '{}');
  const att = {};
  [1, 2, 3, 4, 7, 8, 9, 10, 11, 14, 15, 16, 17, 18, 21, 22, 23, 24, 25, 28, 29, 30].forEach((d, i) => {
    const ds = `2026-09-${String(d).padStart(2, '0')}`;
    const inM = new Date(`${ds}T${i % 5 === 0 ? '20:20' : '08:20'}`).getTime();
    att[ds] = {
      shiftType: i % 5 === 0 ? 'night' : 'day', restMinutes: 30, perf: 1, isRestDay: false,
      segments: [{ in: new Date(inM).toISOString(), out: new Date(inM + (11.5 + (i % 3 === 0 ? 1.5 : 0)) * HOUR).toISOString() }]
    };
  });
  cur.attendance = Object.assign(cur.attendance || {}, att);
  cur.settings = cur.settings || {};
  cur.settings.allowances = (cur.settings.allowances || []).map((a, i) => ({ ...a, name: (a.name || '') + '초장초장'.repeat(i % 3) }));
  cur.settings.deductions = (cur.settings.deductions || []).map((d, i) => ({ ...d, name: (d.name || '') + '초장'.repeat(i % 3) }));
  cur.profile = { ...(cur.profile || {}), name: '김초장초장초장초장테스트', dept: '성형외과초장초장부', jobTitle: '수석연구원초장' };
  cur.settings.holidays = ['2026-10-09', '2026-10-10', '2026-10-11', '2026-10-12', '2026-10-13', '2026-10-14', '2026-10-15'];
  localStorage.setItem(K, JSON.stringify(cur));
};

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const browser = await chromium.launch();

  for (const vp of VIEWPORTS) {
    const page = await browser.newPage({ viewport: { width: vp.width, height: vp.height } });
    const errors = [];
    page.on('pageerror', e => errors.push(e.message));

    await page.goto(BASE, { waitUntil: 'networkidle' });
    // load() 首次不写盘，先落盘再改，避免 undefined 覆盖默认数组
    await page.evaluate(() => Store.save());
    await page.reload({ waitUntil: 'networkidle' });
    await page.evaluate(SEED);
    await page.reload({ waitUntil: 'networkidle' });
    await page.waitForTimeout(400);

    console.log(`\n──── ${vp.name}（${vp.width}px，满月数据 + 超长名称）────`);
    for (const [tab, label] of PAGES) {
      await page.click(`.tab[data-page="${tab}"]`);
      await page.waitForTimeout(300);
      if (tab === 'salary') { await page.click('#sal-prev-month'); await page.waitForTimeout(300); }
      if (tab === 'attendance') { await page.click('#prev-month'); await page.waitForTimeout(300); }
      const info = await page.evaluate(probe);
      const scrollable = info.docScroll > info.vw + 1;
      ok(`${vp.width}px ${label}页不可横向滚动`, !scrollable,
        scrollable ? `docScrollWidth=${info.docScroll} > vw=${info.vw}` : `docScrollWidth=${info.docScroll}`);
      ok(`${vp.width}px ${label}页无越界元素`, info.hits.length === 0,
        info.hits.slice(0, 3).join(' ; '));
    }

    // 补签浮层 + 超长备注
    await page.click('.tab[data-page="attendance"]');
    await page.waitForTimeout(300);
    await page.click('.cal-cell.tappable');
    await page.waitForTimeout(300);
    await page.fill('#mk-note', '门禁故障导致忘打卡'.repeat(6));
    await page.waitForTimeout(200);
    const sheet = await page.evaluate(probe);
    ok(`${vp.width}px 补签面板不可横向滚动`, sheet.docScroll <= sheet.vw + 1,
      `docScrollWidth=${sheet.docScroll} vw=${sheet.vw}`);
    ok(`${vp.width}px 补签面板无越界元素`, sheet.hits.length === 0, sheet.hits.slice(0, 3).join(' ; '));
    await page.screenshot({ path: path.join(OUT, `17-布局${vp.width}-补签面板.png`), fullPage: true });
    await page.close();
  }

  await browser.close();
  const fail = results.filter(r => !r[1]).length;
  console.log(`\n布局回归: ${results.length - fail} 通过, ${fail} 失败`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('执行异常:', e.message); process.exit(1); });
