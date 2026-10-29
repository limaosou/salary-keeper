/* 导入备份功能实测：构造备份文件 → 经文件选择器导入 → 验证覆盖生效
   用法：先起本地服务 python -m http.server 8901，再 node test/import.test.js */
const path = require('path');
const fs = require('fs');
const os = require('os');
const { chromium } = require(path.join('C:', 'Users', 'Administrator', '.workbuddy', 'binaries', 'node', 'workspace', 'node_modules', 'playwright'));

const FIXED_NOW = '2026-10-17T12:00:00';   // 冻结今天，保证 2026-10 是「当月」→ 走按考勤实算

let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => { cond ? pass++ : fail++; console.log(`${cond ? '✅' : '❌'} ${name}${extra ? '  ' + extra : ''}`); };

(async () => {
  // 备份文件用当前 schema：班次 + 日薪结构 + 员工档案 + 津贴/扣除
  const backup = {
    app: '工资通', version: 1,
    profile: { name: '导入测试', dept: '导入部门', hireDate: '2020/03/01', payDay: 17 },
    settings: {
      hourlyRate: 12000,
      fence: { lat: 37.1, lng: 127.1, radius: 150, name: '导入的公司' },
      shift: { dayStart: '08:00', dayEnd: '20:00', nightStart: '20:00', nightEnd: '08:00', weeklyWorkDays: 5 },
      dailyPay: { stdHours: 8, fixedOtHours: 3.5, nightAllowHours: 3.5, nightAllowRate: 0.5, holidayMultiplier: 1.5 },
      restMinutes: 60,
      deductions: [
        { id: 'x1', name: '测试保险费', type: 'percentOfBase', value: 5, enabled: true }
      ]
    },
    attendance: {
      '2026-10-06': {
        shiftType: 'day', restMinutes: 60, perf: 1, isRestDay: false, leave: null, makeups: [],
        segments: [{ in: '2026-10-06T09:00', out: '2026-10-06T18:00' }]
      }
    }
  };
  const file = path.join(os.tmpdir(), 'gzt-backup-test.json');
  fs.writeFileSync(file, JSON.stringify(backup));

  const browser = await chromium.launch();
  const page = await (await browser.newContext({ locale: 'ko-KR', viewport: { width: 420, height: 940 } })).newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  page.on('dialog', d => d.accept());   // 自动确认"覆盖"对话框
  await page.addInitScript(`{
    const FIX = new Date('${FIXED_NOW}').getTime();
    const _D = Date;
    class D extends _D {
      constructor(...a){ if(!a.length) super(FIX); else super(...a); }
      static now(){ return FIX; }
    }
    window.Date = D;
  }`);
  await page.goto('http://127.0.0.1:8901/index.html', { waitUntil: 'networkidle' });
  await page.waitForTimeout(400);

  await page.click('.tab[data-page="settings"]');
  await page.setInputFiles('#import-file', file);
  await page.waitForTimeout(600);

  const state = await page.evaluate(() => JSON.parse(localStorage.getItem('salary_keeper_v1')));
  ok('导入后时薪=12000', state.settings.hourlyRate === 12000, String(state.settings.hourlyRate));
  ok('导入后围栏名称', state.settings.fence.name === '导入的公司', state.settings.fence.name);
  ok('导入后扣除项被替换',
    state.settings.deductions.length === 1 && state.settings.deductions[0].name === '测试保险费',
    `${state.settings.deductions.length} 项`);
  ok('导入后班次设置生效', state.settings.shift.dayStart === '08:00', state.settings.shift.dayStart);
  ok('导入后员工档案生效', state.profile.name === '导入测试', state.profile.name);
  ok('导入后每日休息扣除=60 分', state.settings.restMinutes === 60, String(state.settings.restMinutes));

  // 考勤生效 + 按日薪结构实算：
  //   10-06 09:00–18:00 = 9h − 1h 休息 = 8h
  //   기본급 8h × 12,000 = 96,000
  //   연장근로수당 3.5h × 12,000 × 1.5 = 63,000
  //   固定津贴 실액수당 366,450 + 직무개발비 192,000（备份未覆盖 allowances，沿用默认）
  //   공휴일수당 3일（10-03 토 개천절 + 10-05 월 대체 + 10-09 금 한글날，3×96,000 = 288,000；
  //   10-04 일요일是 주휴일 不重复给）→ 应发 1,005,450
  //   保险基数 = 96,000 + 366,450 = 462,450；扣除 5% = 23,123 → 实发 982,327
  await page.click('.tab[data-page="salary"]');
  await page.waitForTimeout(500);
  const num = s => Number(s.replace(/[^\d.]/g, ''));
  const gross = num(await page.textContent('#sal-gross'));
  const deduct = num(await page.textContent('#sal-deduct'));
  const net = num(await page.textContent('#sal-net'));
  ok('导入考勤后应发=1,005,450（含 공휴일수당 3일）', gross === 1005450, '实际 ' + gross);
  ok('扣除=23,123（基数 462,450 × 5%）', deduct === 23123, '实际 ' + deduct);
  ok('实发=982,327', net === 982327, '实际 ' + net);
  ok('应发−扣除=实发', gross - deduct === net, `${gross} − ${deduct} = ${net}`);
  const meta = await page.textContent('#sal-meta');
  ok('员工档案同步到月薪页', meta.includes('导入测试') && meta.includes('导入部门'),
    meta.replace(/\s+/g, ' ').trim().slice(0, 60));
  ok('当月为按考勤实算口径', (await page.textContent('#sal-mode')).includes('예상'));
  ok('无 JS 报错', errors.length === 0, errors.join(';'));

  // 非法文件应提示失败且不破坏现有数据
  const bad = path.join(os.tmpdir(), 'gzt-bad.json');
  fs.writeFileSync(bad, '{"foo":1}');
  await page.click('.tab[data-page="settings"]');
  await page.waitForTimeout(200);
  await page.setInputFiles('#import-file', bad);
  await page.waitForTimeout(500);
  const st2 = await page.evaluate(() => JSON.parse(localStorage.getItem('salary_keeper_v1')).settings);
  ok('非法文件导入被拒绝且数据保留', st2.hourlyRate === 12000, String(st2.hourlyRate));

  fs.unlinkSync(file); fs.unlinkSync(bad);
  await browser.close();
  console.log(`\n导入测试: ${pass} 通过, ${fail} 失败`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('异常:', e); process.exit(1); });
