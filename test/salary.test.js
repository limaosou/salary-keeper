/* 计薪引擎单测：Node 环境加载 storage.js + salary.js 后验证 */
const vm = require('vm');
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..');

const sandbox = {
  console,
  structuredClone,
  localStorage: { _d: {}, getItem(k) { return this._d[k] ?? null; }, setItem(k, v) { this._d[k] = v; } }
};
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(path.join(root, 'js/storage.js'), 'utf8'), sandbox);
vm.runInContext(fs.readFileSync(path.join(root, 'js/salary.js'), 'utf8'), sandbox);
vm.runInContext('globalThis.__Store = Store; globalThis.__Salary = Salary;', sandbox);

const Store = sandbox.__Store, Salary = sandbox.__Salary;
let pass = 0, fail = 0;
function eq(name, actual, expect, tol = 0.001) {
  const ok = Math.abs(actual - expect) < tol;
  ok ? pass++ : fail++;
  console.log(`${ok ? '✅' : '❌'} ${name}: ${typeof actual === 'number' ? actual.toFixed(2) : actual}${ok ? '' : '  期望 ' + expect}`);
}

// 基准设置：时薪25、标准8h、加班1.5倍、夜班22:00-06:00补助10元/h、按日绩效
const S = Store.settings;
S.hourlyRate = 25; S.standardHours = 8; S.overtimeMultiplier = 1.5;
S.nightStart = '22:00'; S.nightEnd = '06:00'; S.nightMode = 'perHour'; S.nightAmount = 10;
S.perfMode = 'daily';

const seg = (inT, outT) => ({ in: `2026-10-16T${inT}`, out: outT ? `2026-10-16T${outT}` : null });
const rec = (inT, outT, extra = {}) => ({
  shiftType: 'day', restMinutes: 0, perf: 1.0, isRestDay: false,
  segments: [seg(inT, outT)], ...extra
});

// 1. 09:00-18:00 无休息 → 9h = 8h正常(200) + 1h加班(37.5)
let r = Salary.calcDay(rec('09:00', '18:00'), '2026-10-16');
eq('09-18无休息 合计', r.total, 237.5); eq('  加班1h', r.otHours, 1);

// 2. 09:00-18:00 扣60分钟午休 → 8h 全额 200
r = Salary.calcDay(rec('09:00', '18:00', { restMinutes: 60 }), '2026-10-16');
eq('扣1h午休', r.total, 200); eq('  工时', r.workHours, 8); eq('  无加班', r.otHours, 0);

// 3. 09:00-21:00 无休息 → 12h = 200 + 4h×37.5 = 350
r = Salary.calcDay(rec('09:00', '21:00'), '2026-10-16');
eq('加班4h 合计', r.total, 350); eq('  加班费', r.otPay, 150);

// 4. 跨午夜夜班 22:00→次日06:00 → 8h正常200 + 夜班8h×10 = 280
r = Salary.calcDay({
  shiftType: 'night', restMinutes: 0, perf: 1, isRestDay: false,
  segments: [{ in: '2026-10-16T22:00', out: '2026-10-17T06:00' }]
}, '2026-10-16');
eq('夜班8h 合计', r.total, 280); eq('  夜班工时', r.nightHours, 8);

// 5. 跨午夜加班 18:00→次日03:00 → 200 + 1h×37.5 + 夜班5h×10 = 287.5
r = Salary.calcDay({
  shiftType: 'day', restMinutes: 0, perf: 1, isRestDay: false,
  segments: [{ in: '2026-10-16T18:00', out: '2026-10-17T03:00' }]
}, '2026-10-16');
eq('跨午夜加班', r.total, 287.5); eq('  夜班重叠5h', r.nightHours, 5);

// 6. 绩效 1.1 → 8×25×1.1 = 220
r = Salary.calcDay(rec('09:00', '18:00', { restMinutes: 60, perf: 1.1 }), '2026-10-16');
eq('绩效1.1', r.total, 220);

// 7. 休息日 → 0
r = Salary.calcDay(rec('09:00', '18:00', { isRestDay: true }), '2026-10-16');
eq('休息日', r.total, 0);

// 8. 夜班固定补助模式：夜班标签 → +50
S.nightMode = 'fixed'; S.nightAmount = 50;
r = Salary.calcDay(rec('09:00', '18:00', { restMinutes: 60, shiftType: 'night' }), '2026-10-16');
eq('固定夜班补助', r.nightPay, 50); eq('  合计', r.total, 250);
S.nightMode = 'perHour'; S.nightAmount = 10;

// 9. 个税累进
eq('个税 3000', Salary.calcTax(3000), 0);
eq('个税 10000', Salary.calcTax(10000), 500);           // 5000×10%
eq('个税 20000', Salary.calcTax(20000), 700 + 8000 * 0.2); // 700+1600=2300
eq('个税 100000', Salary.calcTax(100000),
  700 + 13000 * 0.2 + 10000 * 0.25 + 20000 * 0.3 + 25000 * 0.35 + 20000 * 0.45);

// 10. 多段打卡：上午3h + 下午5h，中间休息扣除 → 8h
r = Salary.calcDay({
  shiftType: 'day', restMinutes: 0, perf: 1, isRestDay: false,
  segments: [{ in: '2026-10-16T09:00', out: '2026-10-16T12:00' }, { in: '2026-10-16T13:00', out: '2026-10-16T18:00' }]
}, '2026-10-16');
eq('多段打卡 合计', r.total, 200); eq('  打卡段数', r.segCount, 2);

// 11. 月度汇总 + 扣除核对（直接改 attendance 对象，getter 只读）
const att = Store.attendance;
att['2026-10-15'] = rec('09:00', '18:00', { restMinutes: 60 });
att['2026-10-16'] = { shiftType: 'night', restMinutes: 0, perf: 1, isRestDay: false, segments: [{ in: '2026-10-16T22:00', out: '2026-10-17T06:00' }] };
att['2026-10-17'] = rec('10:00', '15:00', { isRestDay: true });
const sum = Salary.calcMonth(2026, 10);
eq('月应发 = 200+280', sum.gross, 480);
eq('月出勤天数', sum.workDays, 2);
eq('月休息日', sum.restDays, 1);
eq('健康保险 3%', sum.deductions[0].amount, 14.4);
eq('养老保险 8%', sum.deductions[1].amount, 38.4);
eq('个税(480<5000)', sum.deductions[2].amount, 0);
eq('扣除合计', sum.deductTotal, 52.8);
eq('实发', sum.net, 427.2);

// 12. 未签退段实时计算：00:00 起算到 12:00 → 12h = 正常200 + OT4h(150) + 夜班6h(60)
att['2026-10-18'] = {
  shiftType: 'day', restMinutes: 0, perf: 1, isRestDay: false,
  segments: [{ in: '2026-10-18T00:00', out: null }]
};
r = Salary.calcDay(att['2026-10-18'], '2026-10-18', { nowForOpen: new Date('2026-10-18T12:00') });
eq('未签退算到12点', r.total, 410);

// 13. 凌晨班 02:00-10:00 → 8h正常200 + 夜班重叠4h(02-06)×10 = 240
r = Salary.calcDay(rec('02:00', '10:00'), '2026-10-16');
eq('凌晨班夜班补助', r.total, 240); eq('  夜班重叠', r.nightHours, 4);

console.log(`\n结果: ${pass} 通过, ${fail} 失败`);
process.exit(fail ? 1 : 0);
