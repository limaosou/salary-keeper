/* 计薪引擎单测 —— 基准：真实工资条 2026-09
   ┌─────────────┬──────────┐
   │ 지급내역     │金额(KRW)  │
   │ 기본급       │ 1,842,720│ = 176h × 10,470
   │ 기업급여(주수)│   335,040│ = 4일 × 8h × 10,470
   │ 현장근로수당  │   617,840│ = 10,470 × 1.5 × 39.34h
   │ 실액수당│   366,450│
   │ 직무개발비│   192,000│
   │ 지급합계     │ 3,354,050│
   ├─────────────┼──────────┤
   │ 국민건강보험  │   163,020│ = 2,209,170 × 7.379%
   │ 장기보험      │   124,170│ = × 5.621%
   │ 고용보험      │    31,080│ = × 1.407%
   │ 기수사회      │    50,000│
   │ 장기요금보험료 │    16,310│ = × 0.738%
   │ 소득세        │   119,880│ 6级累进
   │ 지방소득세    │    11,980│ = 소득세 × 10%
   │ 공제합계      │   516,440│
   ├─────────────┼──────────┤
   │ 차인지금액    │ 2,837,610│
   └─────────────┴──────────┘
*/
const path = require('path');
const fs = require('fs');
const vm = require('vm');
const root = path.join(__dirname, '..');

const store = {};
const sandbox = {
  console,
  structuredClone,
  localStorage: {
    _d: store,
    getItem(k) { return Object.prototype.hasOwnProperty.call(this._d, k) ? this._d[k] : null; },
    setItem(k, v) { this._d[k] = String(v); }
  }
};
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(path.join(root, 'js/storage.js'), 'utf8'), sandbox);
vm.runInContext(fs.readFileSync(path.join(root, 'js/salary.js'), 'utf8'), sandbox);
vm.runInContext('globalThis.__Store = Store; globalThis.__Salary = Salary;', sandbox);
const { __Store: Store, __Salary: Salary } = sandbox;

let pass = 0, fail = 0;
const eq = (name, got, want) => {
  const okv = Math.abs(Number(got) - Number(want)) < 1;
  if (okv) { pass++; console.log(`✅ ${name}`); }
  else { fail++; console.log(`❌ ${name}\n     期望 ${Number(want).toLocaleString()}，实际 ${Number(got).toLocaleString()}`); }
};

console.log('══════ 一、员工档案（工资条表头）══════');
const p = Store.profile;
eq('사번 = 0581', p.empNo, '0581');
eq('성명 = 이형화', p.name === '이형화', 1);
eq('부서 = 성형부', p.dept === '성형부', 1);
eq('입사일 = 2022/06/01', p.hireDate === '2022/06/01', 1);
eq('시급 = 10,470', Store.settings.hourlyRate, 10470);

console.log('\n══════ 一·五、地理距离（Haversine）══════');
eq('同点距离 = 0 米', Math.round(Salary.distance(37.5, 127.0, 37.5, 127.0)), 0);
eq('纬度差 0.0001 ≈ 11 米', Math.round(Salary.distance(37.5, 127.0, 37.5001, 127.0)), 11);
eq('约 14 公里（超出围栏）', Math.round(Salary.distance(37.5, 127.0, 37.6, 127.1) / 1000), 14);

console.log('\n══════ 二、基础公式 ══════');
eq('月计薪工时 = 176h（= 기본급÷시급）', Salary.monthlyStandardHours(), 176);
eq('주수 = 4일×8h×10470 = 335,040', Salary.weeklyBase(), 335040);
eq('기본급 = 176 × 10,470 = 1,842,720', Math.round(Salary.monthlyStandardHours() * 10470), 1842720);

console.log('\n══════ 三、单日工时（按班次应到/应退计时）══════');
// 新口径：基准是「班次窗口 − 休息」，不是实际打卡时刻。
// 手动签到/补签视同按时出勤；自动打卡迟到/早退才扣；超出窗口的算加班。
Store.settings.lateGrace = 0;      // 测试里关掉宽限，便于精确断言
Store.settings.earlyGrace = 0;
const mk = (dIn, dOut, rest = 60, extra = {}) => ({
  shiftType: 'day', restMinutes: rest, perf: 1, isRestDay: false,
  segments: [{ in: dIn, out: dOut }], ...extra
});
let r = Salary.calcDay(mk('2026-09-01T08:20', '2026-09-01T20:20'), '2026-09-01');
eq('按时出勤 08:20–20:20 扣1h = 11h（标准8h+加班3h）', r.workHours, 11);
eq('加班 = 11 − 8 = 3h', r.otHours, 3);

// 核心规则：12 点才想起来，手动补签 → 仍按整班 11h 算
r = Salary.calcDay(mk('2026-09-02T12:00', '2026-09-02T20:20', 60, {
  segments: [{ in: '2026-09-02T12:00', out: '2026-09-02T20:20', src: 'manual' }]
}), '2026-09-02');
eq('手动补签 12:00–20:20 仍按整班 11h', r.workHours, 11);
eq('不判迟到 → 无扣减', r.otHours, 3);

// 自动打卡：真实迟到 40 分钟 → 扣 40 分钟
r = Salary.calcDay(mk('2026-09-03T09:00', '2026-09-03T20:20'), '2026-09-03');
eq('自动打卡迟到 40 分 → 11h − 40m = 10.33h', r.workHours, 620 / 60);

// 自动打卡：早退 2 小时 → 扣 2 小时
r = Salary.calcDay(mk('2026-09-04T08:20', '2026-09-04T18:20'), '2026-09-04');
eq('自动打卡早退 2h → 11h − 2h = 9h', r.workHours, 9);

// 特殊情况登记：上午外出 2 小时
r = Salary.calcDay(mk('2026-09-06T08:20', '2026-09-06T20:20', 60, {
  adjust: { lateMin: 120, earlyMin: 0, note: '上午外出办事' }
}), '2026-09-06');
eq('登记迟到 120 分 → 11h − 2h = 9h', r.workHours, 9);
r = Salary.calcDay(mk('2026-09-07T08:20', '2026-09-07T20:20', 60, {
  adjust: { lateMin: 0, earlyMin: 30, note: '提前下班' }
}), '2026-09-07');
eq('登记早退 30 分 → 11h − 0.5h = 10.5h', r.workHours, 10.5);

// 超出班次窗口的实际加班照算
r = Salary.calcDay(mk('2026-09-08T08:20', '2026-09-08T23:00'), '2026-09-08');
eq('加班到 23:00 → 11h 班内 + 2.67h 加班 = 13.67h', r.workHours, (11 + 170 / 60));

r = Salary.calcDay({
  shiftType: 'night', restMinutes: 0, perf: 1, isRestDay: false,
  segments: [{ in: '2026-09-10T22:00', out: '2026-09-11T06:00' }]
}, '2026-09-10');
eq('跨午夜夜班 22:00–06:00 = 8h', r.workHours, 8);
eq('夜班重叠 8h（22:00–06:00 全覆盖）', r.nightHours, 8);
eq('夜班超 8h 部分不计加班（跨日归次日）', r.otHours, 0);

// 夜班手动补签：视同整班 20:20–08:20（用周三，避开周五 06:20 早下班的 10h 短班）
r = Salary.calcDay({
  shiftType: 'night', restMinutes: 0, perf: 1, isRestDay: false,
  segments: [{ in: '2026-09-16T23:00', out: '2026-09-17T07:00', src: 'manual' }]
}, '2026-09-16');
eq('夜班补签 23:00–07:00 按整班 12h', r.workHours, 12);

// 周五夜班是 10h 短班（06:20 早下班）
r = Salary.calcDay({
  shiftType: 'night', restMinutes: 0, perf: 1, isRestDay: false,
  segments: [{ in: '2026-09-18T20:20', out: '2026-09-19T06:20', src: 'manual' }]
}, '2026-09-18');
eq('周五夜班按 10h 短班计', r.workHours, 10);

r = Salary.calcDay({ shiftType: 'day', restMinutes: 0, perf: 1, isRestDay: true, segments: [{ in: '2026-09-05T09:00', out: '2026-09-05T18:00' }] }, '2026-09-05');
eq('休息日不计薪', r.workHours, 0);

console.log('\n══════ 四、月度汇总 → 应发逐项 ══════');
// 构造 2026-09：20 个工作日基础 8h + 额外加班日，凑出现场근로수당 617,840
// 617,840 = 10,470 × 1.5 × 39.34h → 加班总时长 39.34h
// 用 6 个加班日实现：4天各 9h(=1h)+1天 3h+1天 4h → 4+3+4 = 11h... 继续分配凑 39.34
// 更稳的做法：5 个加班日，分别 8h/8h/8h/8h/7.34h 超额
const att = {};
const addDay = (d, workH, restMin) => {
  const ds = `2026-09-${String(d).padStart(2, '0')}`;
  const start = 9;
  const totalMin = workH * 60 + restMin;           // 在岗总时长
  const endMin = start * 60 + totalMin;
  const endH = String(Math.floor(endMin / 60)).padStart(2, '0');
  const endM = String(Math.round(endMin % 60)).padStart(2, '0');
  att[ds] = {
    shiftType: 'day', restMinutes: restMin, perf: 1, isRestDay: false,
    segments: [{ in: `${ds}T09:00`, out: `${ds}T${endH}:${endM}` }]
  };
};
// 17 个普通日（8h，无加班）
[1, 2, 3, 4, 7, 8, 9, 10, 11, 14, 15, 16, 17, 18, 21, 22, 23].forEach(d => addDay(d, 8, 60));
// 3 个普通夜班日（22:00-06:00，8h）
[24, 25, 28].forEach(d => {
  const ds = `2026-09-${String(d).padStart(2, '0')}`;
  att[ds] = {
    shiftType: 'night', restMinutes: 0, perf: 1, isRestDay: false,
    segments: [{ in: `${ds}T22:00`, out: `${ds}T23:59` }]
  };
});

Store.replaceMonth('2026-09', att);
const sum = Salary.calcMonth(2026, 9);
console.log(`   工时 ${sum.workHours.toFixed(1)}h  加班 ${sum.otHours.toFixed(2)}h  出勤 ${sum.workDays}天`);

const item = id => sum.grossItems.find(i => i.id === id);
eq('① 기본급 = 1,842,720', item('base')?.amount, 1842720);
eq('② 기업급여(주수) = 335,040', item('a1')?.amount, 335040);
eq('④ 실액수당 = 366,450', item('a3')?.amount, 366450);
eq('⑤ 직무개발비 = 192,000', item('a4')?.amount, 192000);
eq('①+②+④+⑤（不含加班）= 2,736,210', sum.gross - item('a2').amount, 1842720 + 335040 + 366450 + 192000);
eq('加班费 = 시급×1.5×加班工时', item('a2').amount, Math.round(sum.otHours * 10470 * 1.5));

console.log('\n══════ 五、社保与税 ══════');
eq('保险基数 = 기본급 + 실액수당 = 2,209,170', sum.insurableBase, 1842720 + 366450);
const ded = n => sum.deductions.find(d => d.name === n)?.amount;
eq('국민건강보험 = 163,020（工资条实额）', ded('국민건강보험'), 163020);
eq('장기보험 = 124,170（工资条实额）', ded('장기보험'), 124170);
eq('고용보험 = 31,080（工资条实额）', ded('고용보험'), 31080);
eq('장기요금보험료 = 16,310（工资条实额）', ded('장기요금보험료'), 16310);
eq('기수사회 = 固定 50,000', ded('기수사회'), 50000);
eq('지방소득세 = 11,980（十位向下取整）', ded('지방소득세'), 11980);

console.log('\n══════ 六、韩国所得税 6 级累进（估算算法）══════');
eq('0 → 0', Salary.calcKoreanTax(0), 0);
eq('1,000,000 → 60,000 (6%)', Salary.calcKoreanTax(1000000), 60000);
eq('1,200,000 → 72,000（一档上限）', Salary.calcKoreanTax(1200000), 72000);
eq('3,700,000 → 447,000（进二档15%）', Salary.calcKoreanTax(3700000), 72000 + 2500000 * 0.15);
eq('9,200,000 → 1,477,000（进三档19%）', Salary.calcKoreanTax(9200000), 72000 + 3400000 * 0.15 + 4600000 * 0.19);

console.log('\n══════ 七、所得税采用工资条实发额（manual 模式）══════');
// 韩国所得税实际额含소득감면与地方所得税，无法从纸面反推，故默认采用工资条实额核对
Store.settings.taxMode = 'manual';
Store.settings.taxManualAmount = 119880;
const sumTax = Salary.calcMonth(2026, 9);
eq('所得税 = 工资条实额 119,880', sumTax.deductions.find(d => d.name === '소득세').amount, 119880);
eq('地方所得税 = 119,880 × 10% = 11,980', sumTax.deductions.find(d => d.name === '지방소득세').amount, 11980);
eq('扣除合计 = 516,440', sumTax.deductTotal, 516440);
// 切到 auto 模式应给出不同的估算值（说明两种口径可用）
Store.settings.taxMode = 'auto';
const sumAuto = Salary.calcMonth(2026, 9);
console.log(`   auto 估算所得税 ${sumAuto.incomeTax.toLocaleString()}（与实发额不同，属正常）`);
Store.settings.taxMode = 'manual';

console.log('\n══════ 八、恒等式：应发−扣除=实发 ══════');
eq('实发 = 应发 − 扣除', sum.net, sum.gross - sum.deductTotal);
eq('应发 = 各明细之和', sum.gross, sum.grossItems.reduce((s, i) => s + i.amount, 0));
eq('扣除 = 各明细之和', sum.deductTotal, sum.deductions.reduce((s, i) => s + i.amount, 0));

console.log('\n══════ 九、工资条全量复现（关键验收）══════');
// 用工资条的真实加班工时反推现场근로수당是否可复现
const targetOT = 617840 / (10470 * 1.5);
console.log(`   要复现 현장근로수당 617,840，需加班工时 ${targetOT.toFixed(4)}h`);
eq('617,840 ÷ (10470×1.5) = 39.3403h', targetOT.toFixed(4), '39.3403');

// 构造精确场景：按「加班小时数」累加到下班时间，天然跨天也正确
// 起点用当班应到时间 08:20，配合上面关掉的宽限，可精确得到 8h + 加班
const HOUR = 3600000;
function makeAtt(spec) {
  const out = {};
  for (const [d, otH] of spec) {
    const ds = `2026-09-${String(d).padStart(2, '0')}`;
    const inMs = new Date(`${ds}T08:20`).getTime();
    const workMs = (8 + otH) * HOUR;            // 计薪工时 = 8h + 加班
    const endMs = inMs + workMs + 60 * 60000;   // 在岗 = 计薪工时 + 午休
    out[ds] = {
      shiftType: 'day', restMinutes: 60, perf: 1, isRestDay: false,
      segments: [{ in: new Date(inMs).toISOString(), out: new Date(endMs).toISOString() }]
    };
  }
  return out;
}

// 基础：15 个无加班日
const baseSpec = [1, 2, 3, 4, 7, 8, 9, 10, 11, 14, 15, 16, 17, 18, 21].map(d => [d, 0]);
const targetH = 617840 / (10470 * 1.5);

// 场景 A：加班 38h（整数粒度）
Store.replaceMonth('2026-09', makeAtt([...baseSpec, [22, 8], [23, 8], [24, 8], [25, 8], [28, 6]]));
const s2 = Salary.calcMonth(2026, 9);
const ot2 = s2.grossItems.find(i => i.id === 'a2').amount;
console.log(`   场景A 加班 ${s2.otHours.toFixed(2)}h → 현장근로수당 ${ot2.toLocaleString()}`);
console.log(`   工资条对应 ${targetH.toFixed(4)}h → 617,840（差 ${(targetH - s2.otHours).toFixed(2)}h）`);

eq('加班费严格 = 시급×1.5×加班工时', ot2, Math.round(s2.otHours * 10470 * 1.5));
const expectOT = Math.round(targetH * 10470 * 1.5);
eq('与工资条加班费差额 = 工时差×시급×1.5',
  Math.abs(expectOT - ot2), Math.round(Math.abs(targetH - s2.otHours) * 10470 * 1.5));

// 场景 B：按工资条反推工时精确复现全部三个数
const specB = [...baseSpec];
let leftH = targetH, day = 22;
while (leftH > 0.001 && day <= 31) {
  const h = Math.min(leftH, 12);
  specB.push([day, h]);
  leftH -= h; day += 1;
}
Store.replaceMonth('2026-09', makeAtt(specB));
const s3 = Salary.calcMonth(2026, 9);
const ot3 = s3.grossItems.find(i => i.id === 'a2').amount;
console.log(`\n   ── 按工资条工时 ${targetH.toFixed(4)}h 复现 ──`);
console.log(`   应发 ${s3.gross.toLocaleString()}  (工资条 3,354,050)`);
console.log(`   扣除 ${s3.deductTotal.toLocaleString()}  (工资条516,440)`);
console.log(`   실发 ${s3.net.toLocaleString()}  (工资条 2,837,610)`);
eq('加班费完全复现 617,840', ot3, 617840);
eq('应发合计完全复现 3,354,050', s3.gross, 3354050);
eq('保险基数完全复现 2,209,170', s3.insurableBase, 2209170);
eq('社保四项完全复现 334,580',
  s3.deductions.filter(d => ['국민건강보험','장기보험','고용보험','장기요금보험료'].includes(d.name))
    .reduce((a, b) => a + b.amount, 0), 334580);
eq('扣除合计完全复现 516,440', s3.deductTotal, 516440);
eq('实发完全复现 2,837,610', s3.net, 2837610);

console.log(`\n结果: ${pass} 通过, ${fail} 失败`);
process.exit(fail ? 1 : 0);