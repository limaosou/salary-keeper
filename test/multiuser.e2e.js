/**
 * 多人共享 E2E：一个后端给多个人用，各自领令牌、互相看不到
 *
 * 验证顺序就是同事真实会走的那条路：
 *   领到令牌 → 令牌自动填进设置 → 打卡记账 → 页面同步回来 → 换个人领，看不到对方的
 *
 * 用法：node test/multiuser.e2e.js
 */
const path = require('path');
const fs = require('fs');
const os = require('os');
const { chromium } = require(path.join('C:', 'Users', 'Administrator', '.workbuddy', 'binaries', 'node', 'workspace', 'node_modules', 'playwright'));
const { spawn } = require('child_process');

const PORT = 8914;
const INVITE = 'colleague2026';
const BASE = `http://127.0.0.1:${PORT}/index.html`;
const API = `http://127.0.0.1:${PORT}`;
const NODE = process.execPath;
const SERVER = path.join(__dirname, '..', 'server', 'server.js');
const OUT = path.join(__dirname, '..', 'screenshots');
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'salary-multi-'));

const results = [];
const ok = (name, cond, extra = '') => {
  results.push([name, !!cond]);
  console.log(`${cond ? '✅' : '❌'} ${name}${extra ? '  ' + extra : ''}`);
};

const getJSON = async (u, opts) => {
  const res = await fetch(u, Object.assign({ cache: 'no-store' }, opts));
  return res.json();
};

/** 起服务端并等它打印「已启动」 */
async function startServer(env) {
  const srv = spawn(NODE, [SERVER], {
    env: Object.assign({}, process.env, { PORT: String(PORT), DATA_DIR }, env),
    stdio: ['ignore', 'pipe', 'pipe']
  });
  await new Promise((res, rej) => {
    srv.stdout.on('data', d => { if (String(d).includes('已启动')) res(); });
    srv.stderr.on('data', d => console.error('[server]', String(d).trim()));
    setTimeout(() => rej(new Error('服务端启动超时')), 8000);
  });
  return srv;
}

/** 打开页面并切到设置页；上下文隔离 localStorage，用来模拟「另一个人的手机」 */
async function openSettings(browser) {
  const ctx = await browser.newContext({ viewport: { width: 375, height: 760 }, serviceWorkers: 'block' });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.goto(BASE, { waitUntil: 'networkidle' });
  await page.click('.tab[data-page="settings"]');
  await page.waitForTimeout(300);
  return { ctx, page, errors };
}

(async () => {
  const srv = await startServer({ INVITE, TZ_OFFSET: '9' });

  try {
    console.log('\n──── 一、服务端处于多人模式 ────');
    // 故意用 GET 去领：应当是 405 + 友好提示，而不是拿到一个令牌
    const getreg = await fetch(`${API}/api/register?invite=${INVITE}`, { cache: 'no-store' });
    const getregBody = await getreg.json();
    ok('GET 领令牌被拒（必须 POST）', getreg.status === 405 && getregBody.ok === false,
      `${getreg.status} ${getregBody.error}`);

    const wrong = await getJSON(`${API}/api/register?invite=bad`, { method: 'POST' });
    ok('邀请码不对被拒', wrong.ok === false, wrong.error);

    const shortTok = await getJSON(`${API}/api/health?token=123`);
    ok('过短的令牌不能进', shortTok.ok === false, shortTok.error);

    console.log('\n──── 二、甲这部手机：点按钮领令牌 ────');
    const browser = await chromium.launch();

    const a = await openSettings(browser);
    await a.page.fill('#cloud-url', API);
    await a.page.fill('#cloud-invite', INVITE);
    await a.page.waitForTimeout(200);
    await a.page.click('#btn-cloud-register');
    await a.page.waitForTimeout(600);

    const hintA = (await a.page.textContent('#cloud-hint')).trim();
    ok('按钮给出成功提示', hintA.startsWith('✅'), hintA);

    const tokA = await a.page.inputValue('#cloud-token');
    ok('令牌自动填进输入框', /^[0-9a-f]{32}$/.test(tokA), tokA);

    const stateA = await a.page.evaluate(() => JSON.parse(JSON.stringify(Store.settings.cloud)));
    ok('令牌已存进本地存储', stateA.token === tokA, '');
    ok('自动开启同步开关', stateA.enabled === true, String(stateA.enabled));

    const healthA = await getJSON(`${API}/api/health?token=${tokA}`);
    ok('服务端认这个令牌', healthA.ok === true && healthA.mode === 'multi', JSON.stringify(healthA.mode));

    console.log('\n──── 三、乙这部手机：另一个人拿不同令牌 ────');
    const b = await openSettings(browser);
    await b.page.fill('#cloud-url', API);
    await b.page.fill('#cloud-invite', INVITE);
    await b.page.waitForTimeout(200);
    await b.page.click('#btn-cloud-register');
    await b.page.waitForTimeout(600);

    const tokB = await b.page.inputValue('#cloud-token');
    ok('乙拿到的是另一串令牌', tokB !== tokA && /^[0-9a-f]{32}$/.test(tokB), tokB);

    console.log('\n──── 四、打卡与隔离 ────');
    await getJSON(`${API}/api/punch?token=${tokA}&t=in`);
    await getJSON(`${API}/api/punch?token=${tokA}&t=out`);

    const daysA = await getJSON(`${API}/api/punches?token=${tokA}`);
    const daysB = await getJSON(`${API}/api/punches?token=${tokB}`);
    ok('甲这边有今天的打卡', Object.keys(daysA.days).length === 1, JSON.stringify(Object.keys(daysA.days)));
    ok('乙那边一条都看不到', Object.keys(daysB.days).length === 0, JSON.stringify(Object.keys(daysB.days)));

    const healthB = await getJSON(`${API}/api/health?token=${tokB}`);
    ok('乙的账本依然是 0 天', healthB.days === 0, String(healthB.days));

    console.log('\n──── 五、甲把打卡同步进页面 ────');
    await a.page.click('#btn-cloud-sync');
    await a.page.waitForTimeout(800);
    const syncHint = (await a.page.textContent('#cloud-hint')).trim();
    ok('同步成功并提示拉到流水', syncHint.startsWith('✅') && syncHint.includes('1 天'), syncHint);

    await a.page.click('.tab[data-page="attendance"]');
    await a.page.waitForTimeout(400);
    const rows = await a.page.locator('#att-list .att-item').count();

    ok('考勤列表出现今天的打卡记录', rows >= 1, `${rows} 行`);
    const hasSeg = await a.page.evaluate(() => {
      const d = new Date();
      const k = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
      const rec = Store.attendance[k] || {};
      return (rec.segments || []).filter(s => s.in && s.out).length;
    });
    ok('同步出来的是完整的一进一出', hasSeg >= 1, `${hasSeg} 段`);

    console.log('\n──── 六、窄屏不溢出 ────');
    const overflow = await a.page.evaluate(() => {
      const vw = innerWidth;
      const hits = [];
      document.querySelectorAll('*').forEach(el => {
        const r = el.getBoundingClientRect();
        if (!r.width && !r.height) return;
        const cs = getComputedStyle(el);
        if (cs.visibility === 'hidden' || cs.display === 'none') return;
        if (r.right - vw > 1 || r.left < -1) hits.push(el.tagName + '#' + el.id);
      });
      return hits;
    });
    ok('375 宽下没有元素越界', overflow.length === 0, overflow.slice(0, 4).join(','));

    ok('甲全程无 JS 报错', a.errors.length === 0, a.errors.join(';'));
    ok('乙全程无 JS 报错', b.errors.length === 0, b.errors.join(';'));

    await a.page.click('.tab[data-page="settings"]');
    await a.page.waitForTimeout(300);
    await a.page.evaluate(() => {
      const el = document.querySelector('#btn-cloud-register');
      if (el) el.scrollIntoView({ block: 'center' });
    });
    await a.page.waitForTimeout(300);
    await a.page.screenshot({ path: path.join(OUT, '19-多人共享领令牌.png'), fullPage: false });

    await browser.close();
  } finally {
    srv.kill();
    try { fs.rmSync(DATA_DIR, { recursive: true, force: true }); } catch (e) { /* 忽略 */ }
  }

  const fail = results.filter(r => !r[1]).length;
  console.log(`\n多人共享 E2E: ${results.length - fail} 通过, ${fail} 失败`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('执行异常:', e); process.exit(1); });
