/* E2E（专项）：验证「打开即校准」自动打卡
   模拟 iOS 快捷指令自动化场景：页面被系统唤起 → 取一次定位 → 自动对齐状态
   重点：页面不需要常驻常开，一次定位就要完成签到或签退 */
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

// 定位模拟：可动态设定当前坐标。
// 注意：坐标必须存 localStorage 才能跨 reload 保留 —— 模拟「快捷指令重新唤起页面」
const GEO_MOCK = () => {
  if (!localStorage.getItem('__mockgeo')) {
    localStorage.setItem('__mockgeo', JSON.stringify({ lat: 37.5, lng: 127.0, accuracy: 10 }));
  }
  window.__setGeo = (lat, lng, accuracy = 10) => {
    localStorage.setItem('__mockgeo', JSON.stringify({ lat, lng, accuracy }));
  };
  const read = () => JSON.parse(localStorage.getItem('__mockgeo'));
  navigator.geolocation.getCurrentPosition = (s) => {
    const g = read();
    s({ coords: { latitude: g.lat, longitude: g.lng, accuracy: g.accuracy } });
  };
  // watchPosition 保持挂起回调，供连续监听路径使用（测试中不触发）
  navigator.geolocation.watchPosition = () => 1;
  navigator.geolocation.clearWatch = () => {};
};

// 预置一份带围栏配置的 localStorage，避免依赖 UI 填写。
// 仅在应用数据不存在时写入 —— 否则每次刷新都会把测试设好的坐标/状态冲掉
const seed = () => {
  if (localStorage.getItem('salary_keeper_v1')) return;
  const d = structuredClone({
    settings: {
      currency: '¥', hourlyRate: 30, standardHours: 8, overtimeMultiplier: 1.5,
      nightStart: '22:00', nightEnd: '06:00', nightMode: 'perHour', nightAmount: 10,
      perfMode: 'daily', perfMonthly: 1,
      fence: { lat: 37.5, lng: 127.0, radius: 200, name: '测试公司' },
      autoPunch: true, punchConfirmCount: 2, autoSyncOnOpen: true, reentryGuard: 30,
      issues: [], deductions: [], taxBrackets: []
    },
    attendance: {}, actualPaid: {}
  });
  localStorage.setItem('salary_keeper_v1', JSON.stringify(d));
};

const readState = page => page.evaluate(() => JSON.parse(localStorage.getItem('salary_keeper_v1')));
const today = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};
const activeOf = st => {
  const rec = st.attendance[today()];
  if (!rec) return null;
  return rec.segments.find(s => s.out === null) || null;
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
  await page.addInitScript(seed);

  /* ===== 场景1：人在公司内打开页面 → 应自动签到 ===== */
  await page.goto(BASE, { waitUntil: 'networkidle' });
  await page.waitForTimeout(1200);
  let st = await readState(page);
  let seg = activeOf(st);
  ok('场景1 人在公司内打开 → 自动签到', !!seg, seg ? `签到于 ${seg.in}` : '没有产生打卡记录');
  ok('场景1 记录标记为自动', seg?.auto === true && seg?.reason === 'auto-sync-in',
    seg ? `auto=${seg.auto} reason=${seg.reason}` : '');
  let syncTxt = await page.textContent('#sync-status');
  ok('场景1 校准状态条显示已签到', syncTxt.includes('自动签到'), syncTxt.trim().slice(0, 30));

  /* ===== 场景2：离开公司后再次打开 → 应自动签退 ===== */
  await page.evaluate(() => window.__setGeo(37.6, 127.1));   // 约14公里外
  await page.reload({ waitUntil: 'networkidle' });            // 快捷指令重新唤起页面
  await page.waitForTimeout(1200);
  st = await readState(page);
  seg = activeOf(st);
  ok('场景2 离开后打开 → 自动签退', !seg, seg ? '仍处于打卡中' : '已结束');
  const segs = st.attendance[today()]?.segments || [];
  const last = segs[segs.length - 1];
  ok('场景2 签退原因标记为离开', last?.outReason === 'leave', `outReason=${last?.outReason}`);
  ok('场景2 签退时间已写入', !!last?.out, last?.out || '缺失');
  syncTxt = await page.textContent('#sync-status');
  ok('场景2 状态条显示已签退', syncTxt.includes('自动签退'), syncTxt.trim().slice(0, 30));
  await page.screenshot({ path: path.join(OUT, '7-自动签退.png') });

  /* ===== 场景3：防抖 —— 离开后短时间回到公司，不应立刻重签 ===== */
  await page.evaluate(() => window.__setGeo(37.5, 127.0));   // 立刻回公司
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForTimeout(1200);
  st = await readState(page);
  ok('场景3 离开后立即回公司 → 防抖不重签', !activeOf(st),
    activeOf(st) ? '被错误地重新签到了' : '正确保持已签退');

  /* ===== 场景4：防抖期过后（模拟 reentryGuard=0）应能正常重签 ===== */
  await page.evaluate(() => {
    const s = JSON.parse(localStorage.getItem('salary_keeper_v1'));
    s.settings.reentryGuard = 0;
    localStorage.setItem('salary_keeper_v1', JSON.stringify(s));
  });
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForTimeout(1200);
  st = await readState(page);
  ok('场景4 防抖期为0 → 回到公司正常重签', !!activeOf(st),
    activeOf(st) ? '已重新签到' : '未签到');
  const segs2 = st.attendance[today()].segments;
  ok('场景4 当天形成两段打卡', segs2.length === 2, `共 ${segs2.length} 段`);

  /* ===== 场景5：页面关闭状态下由快捷指令唤起，也能签退 ===== */
  await page.evaluate(() => window.__setGeo(37.7, 127.2));   // 先走远
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForTimeout(1000);
  ok('场景5 走远后自动签退', !activeOf(await readState(page)));

  /* ===== 场景6：未配置围栏坐标时不应误打卡 ===== */
  await page.evaluate(() => {
    const s = JSON.parse(localStorage.getItem('salary_keeper_v1'));
    s.attendance = {};
    s.settings.fence.lat = 0; s.settings.fence.lng = 0;
    localStorage.setItem('salary_keeper_v1', JSON.stringify(s));
  });
  await page.evaluate(() => window.__setGeo(37.5, 127.0));
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForTimeout(1200);
  st = await readState(page);
  ok('场景6 未配置坐标 → 不误打卡', !Object.keys(st.attendance).length,
    Object.keys(st.attendance).length ? '产生了记录' : '无记录');
  syncTxt = await page.textContent('#sync-status');
  ok('场景6 状态条提示需配置坐标', syncTxt.includes('配置公司坐标'), syncTxt.trim().slice(0, 30));

  /* ===== 场景7：设置页向导与异常记录 ===== */
  await page.evaluate(() => {
    const s = JSON.parse(localStorage.getItem('salary_keeper_v1'));
    s.settings.fence.lat = 37.5; s.settings.fence.lng = 127.0;
    localStorage.setItem('salary_keeper_v1', JSON.stringify(s));
  });
  await page.reload({ waitUntil: 'networkidle' });   // 让恢复的坐标进入内存
  await page.waitForTimeout(1000);
  await page.click('.tab[data-page="settings"]');
  await page.waitForTimeout(400);
  const guide = await page.innerHTML('#page-settings');
  ok('设置页含快捷指令向导', guide.includes('打开 URL') && guide.includes('立即运行'));
  const urlTxt = await page.textContent('#sync-url');
  ok('向导展示可复制的唤醒地址', /^https?:\/\/.+index\.html$/.test(urlTxt.trim()), urlTxt.trim());

  await page.click('#btn-test-sync');
  await page.waitForTimeout(1500);
  const hint = await page.textContent('#test-hint');
  ok('测试按钮能返回校准结果', hint.includes('测试通过'), hint.trim().slice(0, 40));
  await page.screenshot({ path: path.join(OUT, '8-自动打卡设置.png') });

  ok('全流程无 JS 报错', errors.length === 0, errors.join(';'));

  await browser.close();
  const fail = results.filter(r => !r[1]).length;
  console.log(`\n自动校准专项 E2E: ${results.length - fail} 通过, ${fail} 失败`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('E2E 执行异常:', e); process.exit(1); });