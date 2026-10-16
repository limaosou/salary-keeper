/* 导入备份功能实测：构造备份文件 → 经文件选择器导入 → 验证覆盖生效 */
const path = require('path');
const fs = require('fs');
const os = require('os');
const { chromium } = require(path.join('C:', 'Users', 'Administrator', '.workbuddy', 'binaries', 'node', 'workspace', 'node_modules', 'playwright'));

let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => { cond ? pass++ : fail++; console.log(`${cond ? '✅' : '❌'} ${name}${extra ? '  ' + extra : ''}`); };

(async () => {
  const backup = {
    app: '工资通', version: 1,
    settings: {
      hourlyRate: 99, standardHours: 8, overtimeMultiplier: 1.5,
      fence: { lat: 37.1, lng: 127.1, radius: 150, name: '导入的公司' },
      deductions: [{ id: 'x1', name: '测试保险费', type: 'percent', value: 5 }]
    },
    attendance: {
      '2026-10-06': {
        shiftType: 'day', restMinutes: 60, perf: 1, isRestDay: false,
        segments: [{ in: '2026-10-06T09:00', out: '2026-10-06T18:00' }]
      }
    }
  };
  const file = path.join(os.tmpdir(), 'gzt-backup-test.json');
  fs.writeFileSync(file, JSON.stringify(backup));

  const browser = await chromium.launch();
  const page = await (await browser.newContext({ locale: 'zh-CN' })).newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  page.on('dialog', d => d.accept());   // 自动确认"覆盖"对话框
  await page.goto('http://127.0.0.1:8901/index.html', { waitUntil: 'networkidle' });

  await page.click('.tab[data-page="settings"]');
  await page.setInputFiles('#import-file', file);
  await page.waitForTimeout(500);

  const st = await page.evaluate(() => JSON.parse(localStorage.getItem('salary_keeper_v1')).settings);
  ok('导入后时薪=99', st.hourlyRate === 99);
  ok('导入后围栏名称', st.fence.name === '导入的公司');
  ok('导入后扣除项被替换', st.deductions.length === 1 && st.deductions[0].name === '测试保险费');

  // 考勤数据生效：月薪页应发 = 8h × 99 = 792，扣除 5% = 39.6，实发 752.4
  await page.click('.tab[data-page="salary"]');
  await page.waitForTimeout(400);
  const num = s => Number(s.replace(/[^\d.]/g, ''));
  const gross = num(await page.textContent('#sal-gross'));
  const net = num(await page.textContent('#sal-net'));
  ok('导入考勤后应发=792', Math.abs(gross - 792) < 0.01, '实际 ' + gross);
  ok('实发=752.4', Math.abs(net - 752.4) < 0.01, '实际 ' + net);
  ok('无 JS 报错', errors.length === 0, errors.join(';'));

  // 非法文件应提示失败且不破坏现有数据
  const bad = path.join(os.tmpdir(), 'gzt-bad.json');
  fs.writeFileSync(bad, '{"foo":1}');
  await page.click('.tab[data-page="settings"]');
  await page.setInputFiles('#import-file', bad);
  await page.waitForTimeout(400);
  const st2 = await page.evaluate(() => JSON.parse(localStorage.getItem('salary_keeper_v1')).settings);
  ok('非法文件导入被拒绝且数据保留', st2.hourlyRate === 99);

  fs.unlinkSync(file); fs.unlinkSync(bad);
  await browser.close();
  console.log(`\n导入测试: ${pass} 通过, ${fail} 失败`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('异常:', e); process.exit(1); });
