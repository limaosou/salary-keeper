/* E2E 实测：无头浏览器 + 注入式模拟 GPS，验证地理围栏自动打卡与工资核对全流程 */
const path = require('path');
const fs = require('fs');
const { chromium } = require(path.join('C:', 'Users', 'Administrator', '.workbuddy', 'binaries', 'node', 'workspace', 'node_modules', 'playwright'));

const BASE = process.env.BASE || 'http://127.0.0.1:8901/index.html';
const OUT = process.env.OUT ? path.resolve(process.env.OUT) : path.join(__dirname, '..', 'screenshots');
const results = [];
const ok = (name, cond, extra = '') => {
  results.push([name, !!cond]);
  console.log(`${cond ? '✅' : '❌'} ${name}${extra ? '  ' + extra : ''}`);
};

// 在页面脚本执行前注入 GPS 模拟器（无头浏览器不投递 context 级模拟定位）
// 坐标存localStorage，才能跨 reload 保留 —— 否则「打开即校准」拿到的是初始 0,0
const GEO_MOCK = () => {
  if (!localStorage.getItem('__mockgeo')) {
    localStorage.setItem('__mockgeo', JSON.stringify({ lat: 37.5, lng: 127.0 }));
  }
  window.__fireGeo = (lat, lng) => {
    localStorage.setItem('__mockgeo', JSON.stringify({ lat, lng }));
    if (window.__geoCb) window.__geoCb({ coords: { latitude: lat, longitude: lng, accuracy: 10 } });
  };
  const read = () => JSON.parse(localStorage.getItem('__mockgeo'));
  navigator.geolocation.watchPosition = (success) => { window.__geoCb = success; return 1; };
  navigator.geolocation.clearWatch = () => {};
  navigator.geolocation.getCurrentPosition = (s) => {
    const g = read();
    s({ coords: { latitude: g.lat, longitude: g.lng, accuracy: 10 } });
  };
};

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 420, height: 860 }, locale: 'zh-CN' });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  page.on('console', m => { if (m.type() === 'error' && !m.text().includes('favicon')) errors.push(m.text()); });

  await page.addInitScript(GEO_MOCK);
  await page.goto(BASE, { waitUntil: 'networkidle' });
  ok('页面加载无 JS 报错', errors.length === 0, errors.join(';'));

  // ---------- 设置页：经 UI 配置公司与计薪标准 ----------
  await page.click('.tab[data-page="settings"]');
  await page.fill('#set-fence-name', '测试公司');
  await page.fill('#set-fence-lat', '37.5');
  await page.fill('#set-fence-lng', '127.0');
  await page.fill('#set-hourly', '10470');
  await page.fill('#set-monthly-hours', '176');
  await page.screenshot({ path: path.join(OUT, '4-设置.png') });

  // ---------- 全自动打卡引导：锁屏只能「打开 App」，不能「打开 URL」 ----------
  const guide = await page.evaluate(() => {
    const g = document.querySelector('.step-guide');
    return { text: g ? g.textContent.replace(/\s+/g, ' ') : '', openApp: !!document.querySelector('.step-guide') };
  });
  ok('引导要求用「打开 App」而非「打开 URL」', guide.text.includes('打开 App') && !guide.text.includes('添加操作 → 搜索并添加 「打开 URL」'), '');
  ok('引导写明锁屏只能唤起 App', guide.text.includes('只允许自动打开 App'), '');
  ok('引导给出充电器/蓝牙等备选触发器', guide.text.includes('连接充电器时') && guide.text.includes('蓝牙'), '');
  ok('引导写明「打开 App 找不到工资通」的排查', guide.text.includes('找不到「工资通」') && guide.text.includes('添加到主屏幕'), '');

  // 未添加到主屏幕时应亮出自检警示（这是「找不到工资通」的根因）
  ok('浏览器直开时提示「不是主屏幕 App」', await page.evaluate(() =>
    !document.querySelector('#standalone-hint').hidden), '');

  // 刷新使围栏配置进入 GeoPunch（init 时已启动监听）
  await page.reload({ waitUntil: 'networkidle' });

  // ---------- GPS 在公司 → 连续2次定位后自动签到 ----------
  await page.evaluate(() => window.__fireGeo(37.5, 127.0));
  await page.waitForTimeout(300);
  await page.evaluate(() => window.__fireGeo(37.5001, 127.0));   // 微移，仍在圈内
  await page.waitForTimeout(800);
  let state = await page.textContent('#today-status');
  ok('进入公司区域自动签到', state.includes('打卡中'), '状态: ' + state);

  // 默认扣 60 分钟午休，刚打卡几秒会被午休吃掉 → 点 4 次「−」把休息调成 0
  for (let i = 0; i < 4; i++) await page.click('#rest-minus');
  await page.waitForTimeout(200);
  let earned = Number(await page.textContent('#today-earned'));
  const nowH = new Date().getHours() + new Date().getMinutes() / 60;
  if (nowH >= 8.5 && nowH <= 20.5) {
    ok('打卡后今日已赚 > 0', earned > 0, '当前 ' + earned.toFixed(2));
  } else {
    // 深夜/凌晨签到：远超应到时间，按真实时间计（迟到超宽限），未签退 → 不白送整班
    ok('非当班时段签到按真实时间计（不白送整班）', earned === 0, '当前 ' + earned.toFixed(2));
  }
  await page.screenshot({ path: path.join(OUT, '1-今日-打卡中.png') });

  // ---------- GPS 移出公司 → 自动签退 ----------
  await page.evaluate(() => window.__fireGeo(37.6, 127.1));      // 约14公里外
  await page.waitForTimeout(800);
  state = await page.textContent('#today-status');
  ok('离开公司区域自动签退', state.includes('已结束当日考勤'), '状态: ' + state);
  earned = Number(await page.textContent('#today-earned'));
  ok('签退后金额定格', earned > 0, '定格 ' + earned.toFixed(2));
  await page.screenshot({ path: path.join(OUT, '2-今日-已签退.png') });

  // ---------- GPS 漂移进圈不应重复签到（防抖计数归零后需再次连续2次） ----------
  await page.evaluate(() => window.__fireGeo(37.5, 127.0));
  await page.waitForTimeout(500);
  state = await page.textContent('#today-status');
  ok('签退后单次漂移不自动重签', state.includes('已结束'), '状态: ' + state);

  // ---------- 考勤页 ----------
  await page.click('.tab[data-page="attendance"]');
  await page.waitForTimeout(400);
  const attHtml = await page.innerHTML('#att-list');
  ok('考勤页显示当日记录', attHtml.includes('att-item'));
  await page.screenshot({ path: path.join(OUT, '3-考勤.png') });

  // ---------- 注入一个月样本数据（白班/加班/跨午夜夜班/绩效/休息日） ----------
  const sample = {};
  const rec = (day, inT, outT, extra = {}) => {
    const ds = `2026-10-${String(day).padStart(2, '0')}`;
    sample[ds] = {
      shiftType: 'day', restMinutes: 60, perf: 1.0, isRestDay: false,
      segments: [{ in: `${ds}T${inT}`, out: `${ds}T${outT}` }], ...extra
    };
  };
  // 样本（时薪30、标准8h、加班1.5倍、夜班10元/h）：
  // 10-08 白班8h=240 / 10-09 11h=240+3h×45=375 / 10-10 跨午夜夜班8h=240+80=320 / 10-13 绩效1.1=264 / 10-14 休息
  rec(8, '09:00', '18:00');                                    // 240
  rec(9, '09:00', '21:00');                                    // 375
  sample['2026-10-10'] = {                                     // 跨午夜夜班 280
    shiftType: 'night', restMinutes: 0, perf: 1.0, isRestDay: false,
    segments: [{ in: '2026-10-10T22:00', out: '2026-10-11T06:00' }]
  };
  rec(13, '09:00', '18:00', { perf: 1.1 });                    // 220
  rec(14, '09:00', '18:00', { isRestDay: true });              // 休息不计薪

  const cur = JSON.parse(await page.evaluate(() => localStorage.getItem('salary_keeper_v1')));
  const todayKey = Object.keys(cur.attendance).find(k => k === new Date().toISOString().slice(0, 10));
  cur.attendance = { ...sample, ...(todayKey ? { [todayKey]: cur.attendance[todayKey] } : {}) };
  await page.evaluate(v => localStorage.setItem('salary_keeper_v1', v), JSON.stringify(cur));
  await page.reload({ waitUntil: 'networkidle' });

  // ---------- 月薪页 ----------
  await page.click('.tab[data-page="salary"]');
  await page.waitForTimeout(400);
  const num = s => Number(s.replace(/[^\d.]/g, ''));
  const gross = num(await page.textContent('#sal-gross'));
  const deduct = num(await page.textContent('#sal-deduct'));
  const net = num(await page.textContent('#sal-net'));
  console.log(`  月薪页: 应发 ${gross} / 扣除 ${deduct} / 实发 ${net}`);
  // 当月走「按考勤实算」口径：固定项只剩 실액수당 + 직무개발비，
  // 기본급 / 연장근로수당 随出勤天数变动，不再等于工资条上的固定值
  const baseFixed = 366450 + 192000;
  ok('月应发 ≥ 固定津贴合计 558,450', gross >= baseFixed, `实际 ${gross}`);
  ok('应发−扣除=实发', Math.abs(gross - deduct - net) < 1);
  const dedHtml = await page.innerHTML('#sal-deductions');
  ok('扣除项含健康/长期/雇佣保险+所得税',
    dedHtml.includes('국민건강보험') && dedHtml.includes('장기보험')
    && dedHtml.includes('고용보험') && dedHtml.includes('소득세'));
  const bdHtml = await page.innerHTML('#sal-breakdown');
  ok('应发含 기본급/연장근로수당/실액수당/직무개발비',
    bdHtml.includes('기본급') && bdHtml.includes('연장근로수당')
    && bdHtml.includes('실액수당') && bdHtml.includes('직무개발비'));
  ok('当月口径标识为按考勤实算', (await page.textContent('#sal-mode')).includes('예상'));
  ok('显示社保基数（기본급 + 실액수당）',
    /보험료기준/.test(await page.textContent('#sal-base'))
    && /\d/.test(await page.textContent('#sal-base')));
  ok('考勤汇总含总工时/加班/夜班/出勤',
    (await page.innerHTML('#sal-attendance')).includes('총근로시간')
    && (await page.innerHTML('#sal-attendance')).includes('초과근로시간'));
  await page.screenshot({ path: path.join(OUT, '5-月薪.png') });

  // ---------- 核对老板实发 ----------
  await page.fill('#actual-paid', String(net));
  await page.click('#btn-check');
  await page.waitForTimeout(300);
  let checkTxt = await page.textContent('#check-result');
  ok('实发一致时提示无误', checkTxt.includes('完全一致'), checkTxt.trim().slice(0, 24));

  await page.fill('#actual-paid', String(net - 500000));        // 工资条少发 500,000원
  await page.click('#btn-check');
  await page.waitForTimeout(300);
  checkTxt = await page.textContent('#check-result');
  ok('少发 500,000원 时提示差额', checkTxt.includes('500,000') && checkTxt.includes('少发'), checkTxt.trim().slice(0, 30));
  await page.screenshot({ path: path.join(OUT, '6-核对差异.png') });

  ok('全流程无 JS 报错', errors.length === 0, errors.join(';'));

  await browser.close();
  const fail = results.filter(r => !r[1]).length;
  console.log(`\nE2E 结果: ${results.length - fail} 通过, ${fail} 失败`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('E2E 执行异常:', e); process.exit(1); });
