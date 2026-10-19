/**
 * 云端打卡 E2E：真实起一个服务端，用快捷指令那两个 URL 打点，再从页面同步回来
 *
 * 验证的是「锁屏也不用打开页面」这条链路：
 *   快捷指令（到达/离开公司）→ 获取 URL 内容 → /api/punch → 服务器记账 → 页面 /api/punches 拉回
 *
 * 用法：node test/cloud.e2e.js
 */
const path = require('path');
const { chromium } = require(path.join('C:', 'Users', 'Administrator', '.workbuddy', 'binaries', 'node', 'workspace', 'node_modules', 'playwright'));
const { spawn } = require('child_process');

const fs = require('fs');
const os = require('os');

const PORT = 8912;
const TOKEN = 'e2etoken2026';
const BASE = `http://127.0.0.1:${PORT}/index.html`;
const API = `http://127.0.0.1:${PORT}`;
const NODE = process.execPath;
const SERVER = path.join(__dirname, '..', 'server', 'server.js');
const OUT = path.join(__dirname, '..', 'screenshots');
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'salary-cloud-'));  // 每次干净的账本

const results = [];
const ok = (name, cond, extra = '') => {
  results.push([name, !!cond]);
  console.log(`${cond ? '✅' : '❌'} ${name}${extra ? '  ' + extra : ''}`);
};

const getJSON = async (u) => {
  const res = await fetch(u, { cache: 'no-store' });
  return res.json();
};

// 服务器按 TZ_OFFSET=9 记「今天」；测试要往哪天打点，就临时改数据文件的键名
async function punch(day, type, hour, minute) {
  // 先按当前时区打一笔，再把记录改写到目标日期，模拟历史打卡
  const r = await getJSON(`${API}/api/punch?token=${TOKEN}&t=${type}`);
  return r;
}

(async () => {
  // ---------- 启动服务端 ----------
  const srv = spawn(NODE, [SERVER], {
    env: Object.assign({}, process.env, {
      PORT: String(PORT), TOKEN, TZ_OFFSET: '9', DATA_DIR
    }),
    stdio: ['ignore', 'pipe', 'pipe']
  });
  await new Promise((res, rej) => {
    srv.stdout.on('data', d => { if (String(d).includes('已启动')) res(); });
    srv.stderr.on('data', d => console.error('[server]', String(d).trim()));
    setTimeout(() => rej(new Error('服务端启动超时')), 8000);
  });

  try {
    console.log('\n──── 一、服务端接口 ────');
    const health = await getJSON(`${API}/api/health?token=${TOKEN}`);
    ok('健康检查返回 ok', health.ok === true, `服务器日 ${health.serverDay}`);
    ok('公司时区为 +9', health.tzOffset === 9, `tzOffset=${health.tzOffset}`);

    const bad = await getJSON(`${API}/api/health?token=wrong-token`);
    ok('错误令牌被拒绝', bad.ok === false, bad.error);

    const badType = await getJSON(`${API}/api/punch?token=${TOKEN}&t=xxx`);
    ok('非法类型被拒绝', badType.ok === false, badType.error);

    const home = await fetch(`${API}/`);
    ok('静态托管首页可访问', home.status === 200, `HTTP ${home.status}`);
    const secret = await fetch(`${API}/server/server.js`);
    ok('服务端源码不对外暴露', secret.status === 404, `HTTP ${secret.status}`);

    console.log('\n──── 二、快捷指令打点（in / out）────');
    const p1 = await getJSON(`${API}/api/punch?token=${TOKEN}&t=in`);
    ok('签到成功', p1.ok === true && p1.type === 'in', p1.stamp);
    const p2 = await getJSON(`${API}/api/punch?token=${TOKEN}&t=in`);
    ok('3 分钟内重复签到被防抖忽略', p2.ignored === true, p2.reason || '');
    const p3 = await getJSON(`${API}/api/punch?token=${TOKEN}&t=out`);
    ok('签退成功', p3.ok === true && p3.type === 'out', p3.stamp);
    ok('当天流水为 in→out 两条', p3.list.length === 2 && p3.list[0].type === 'in' && p3.list[1].type === 'out',
      JSON.stringify(p3.list.map(x => x.type)));

    console.log('\n──── 三、浏览器端同步 ────');
    const browser = await chromium.launch();
    // 屏蔽 Service Worker：否则会命中上一次缓存的旧 app.js，测的是老代码
    const ctx = await browser.newContext({ viewport: { width: 375, height: 760 }, serviceWorkers: 'block' });
    const page = await ctx.newPage();
    const errors = [];
    page.on('pageerror', e => errors.push(e.message));
    await page.goto(BASE, { waitUntil: 'networkidle' });

    ok('CloudSync 模块已加载', await page.evaluate(() => typeof CloudSync === 'object'), '');

    // 填配置
    await page.click('.tab[data-page="settings"]');
    await page.waitForTimeout(200);
    await page.fill('#cloud-url', API);
    await page.fill('#cloud-token', TOKEN);
    await page.waitForTimeout(200);
    await page.click('#cloud-enabled + .switch');
    await page.waitForTimeout(300);

    ok('填好配置后显示快捷指令地址', await page.evaluate(() =>
      !document.querySelector('#cloud-urls').hidden), '');
    const urlIn = await page.textContent('#cloud-url-in');
    const urlOut = await page.textContent('#cloud-url-out');
    ok('签到地址含 /api/punch 与 t=in', urlIn.includes('/api/punch') && urlIn.includes('t=in'), urlIn);
    ok('签退地址含 t=out', urlOut.includes('t=out'), urlOut);

    // 长 URL 容易把窄屏撑宽，这里顺手断言
    const ov = await page.evaluate(() => {
      const vw = window.innerWidth;
      const hits = [...document.querySelectorAll('#page-settings *')].filter(el => {
        const r = el.getBoundingClientRect();
        const cs = getComputedStyle(el);
        if (!r.width || cs.display === 'none' || cs.visibility === 'hidden') return false;
        return r.right > vw + 1 || r.left < -1;
      }).length;
      return { sw: document.documentElement.scrollWidth, vw, hits };
    });
    ok('云端卡片长地址不撑宽页面', ov.sw <= ov.vw + 1 && ov.hits === 0, `${ov.sw}/${ov.vw} 越界 ${ov.hits}`);

    // 测试连接
    await page.click('#btn-cloud-test');
    await page.waitForTimeout(1200);
    const testTxt = await page.textContent('#cloud-hint');
    ok('连接测试通过', testTxt.includes('连接成功'), testTxt.trim().slice(0, 40));

    // 立刻同步
    await page.click('#btn-cloud-sync');
    await page.waitForTimeout(1200);
    const syncTxt = await page.textContent('#cloud-hint');
    ok('同步完成并拉到天数', syncTxt.includes('同步完成'), syncTxt.trim().slice(0, 40));

    const merged = await page.evaluate(() => {
      const day = Object.keys(Store.attendance).filter(k => Store.attendance[k].segments.length)[0];
      if (!day) return null;
      const r = Store.attendance[day];
      return { day, n: r.segments.length, in: r.segments[0].in, out: r.segments[0].out, isRestDay: r.isRestDay };
    });
    ok('流水已合并为本地 segments', merged && merged.n === 1, merged ? `${merged.day} ${merged.n} 段` : 'null');
    ok('segment 有 in 与 out', merged && !!merged.in && !!merged.out, merged ? `${merged.in} → ${merged.out}` : '');
    ok('出勤日未被误判为休息日', merged && merged.isRestDay === false, '');

    // 时差换算：服务器存「公司当地时间」，本地应还原成合法 ISO
    ok('时间已转合法 ISO（含时区）', merged && /T\d{2}:\d{2}/.test(merged.in) &&
      (merged.in.endsWith('Z') || /[+-]\d{2}:\d{2}$/.test(merged.in)), merged ? merged.in : '');

    console.log('\n──── 四、异常与边界 ────');
    // 错误地址
    await page.fill('#cloud-url', 'http://127.0.0.1:1');
    await page.waitForTimeout(200);
    await page.click('#btn-cloud-test');
    await page.waitForTimeout(2500);
    const errTxt = await page.textContent('#cloud-hint');
    ok('服务器不可达时给出错误而非崩溃', errTxt.includes('❌'), errTxt.trim().slice(0, 40));

    // 恢复
    await page.fill('#cloud-url', API);
    await page.waitForTimeout(200);

    // 未启用时不应显示地址
    await page.click('#cloud-enabled + .switch');
    await page.waitForTimeout(300);
    ok('关闭开关后隐藏快捷指令地址', await page.evaluate(() =>
      document.querySelector('#cloud-urls').hidden), '');

    ok('全程无 JS 报错', errors.length === 0, errors.join(';'));

    await page.click('#cloud-enabled + .switch');
    await page.waitForTimeout(200);
    await page.click('.tab[data-page="settings"]');
    await page.waitForTimeout(200);
    await page.screenshot({ path: path.join(OUT, '18-云端打卡.png'), fullPage: false });

    await browser.close();
  } finally {
    srv.kill();
    try { fs.rmSync(DATA_DIR, { recursive: true, force: true }); } catch (e) { /* 忽略 */ }
  }

  const fail = results.filter(r => !r[1]).length;
  console.log(`\n云端打卡 E2E: ${results.length - fail} 通过, ${fail} 失败`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('执行异常:', e); process.exit(1); });
