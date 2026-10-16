/* 线上环境体检：确认 HTTPS 安全上下文 + 定位 API 可用 + localStorage 持久化可用 */
const path = require('path');
const { chromium } = require(path.join('C:', 'Users', 'Administrator', '.workbuddy', 'binaries', 'node', 'workspace', 'node_modules', 'playwright'));

const BASE = process.env.BASE || 'https://limaosou.github.io/salary-keeper/index.html';

(async () => {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({
    viewport: { width: 420, height: 860 },
    locale: 'zh-CN',
    permissions: []            // 不预先授予定位权限，模拟真实首次进入
  });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  page.on('console', m => { if (m.type() === 'error' && !m.text().includes('favicon')) errors.push(m.text()); });

  await page.goto(BASE, { waitUntil: 'networkidle' });

  const env = await page.evaluate(() => ({
    secure: window.isSecureContext,
    geo: typeof navigator.geolocation?.watchPosition === 'function',
    ls: (() => { try { localStorage.setItem('__t', '1'); localStorage.removeItem('__t'); return true; } catch (e) { return false; } })(),
    ua: navigator.userAgent.includes('Mobile') ? 'mobile' : 'desktop'
  }));

  console.log('地址              :', BASE);
  console.log('isSecureContext   :', env.secure, env.secure ? '✅ HTTPS 安全上下文' : '❌ 非安全上下文');
  console.log('geolocation API   :', env.geo ? '✅ watchPosition 可用（自动打卡能生效）' : '❌ 不可用');
  console.log('localStorage 读写 :', env.ls ? '✅ 可用（数据能存本机）' : '❌ 不可用');
  console.log('UA 判定           :', env.ua);

  // 权限未授予时，页面应给出可读的提示而不是静默失败
  const perm = await ctx.clearPermissions();
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForTimeout(1500);
  const bodyTxt = await page.textContent('body');
  const hint = /定位|权限|设置/.test(bodyTxt) ? '有定位/权限相关提示' : '无提示';
  console.log('未授权定位时页面  :', hint);
  console.log('JS 报错           :', errors.length ? errors.join(';') : '无 ✅');

  await browser.close();
  const bad = !env.secure || !env.geo || !env.ls || errors.length;
  process.exit(bad ? 1 : 0);
})().catch(e => { console.error('体检异常:', e.message); process.exit(1); });