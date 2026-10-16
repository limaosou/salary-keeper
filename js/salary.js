/* ========== 计薪引擎（韩国月薪制· 周工时制） ==========
   对齐真实工资条（2026-09）反推的准确口径：
     법정월급여시간(月薪计薪工时) = 176h   ← 由 기본급 1,842,720 ÷ 시급 10,470 反推
     기업급여(주수)  = 일수(4일) × 일근로(8h) × 시급 = 335,040（工资条计算方法明写）
     현장근로수당(加班) = 시급 × 1.5 × 加班工时     = 617,840
     상여수당(奖金)   = 시급 × 0.5 × 工时
     기본급 + 실액수당 = 보험료기준(社保基数) = 2,209,170
     장기요금보험료 ≈ 국민건강보험료 × 10%（工资条实为 16,310 / 163,020 = 10.005%）
   扣除：
     국민건강보험 7.379% / 장기보험 5.621% / 고용보험 1.407% / 장기요금보험료 0.738%
     소득세 = 6级累进；지방소득세 = 소득세 × 10%
============================================================= */
const Salary = (() => {

  const HM = s => { const [h, m] = s.split(':').map(Number); return h * 3600000 + m * 60000; };
  const MS_H = 3600000;
  const KR = n => Math.round(Number(n) || 0);   // 韩元取整（工资条无小数）

  /** Haversine 距离（米） */
  function distance(lat1, lng1, lat2, lng2) {
    const R = 6371000, rad = Math.PI / 180;
    // 注意：dLng 必须用 lng1，之前误写成 lat1，会让任意两点都算出数千公里
    const dLat = (lat2 - lat1) * rad, dLng = (lng2 - lng1) * rad;
    const a = Math.sin(dLat / 2) ** 2 +
      Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(dLng / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(a));
  }

  /** 夜班时段与工作区间的重叠小时数（夜班窗口可跨午夜） */
  function nightOverlapHours(startMs, endMs, nightStart, nightEnd) {
    if (endMs <= startMs) return 0;
    let total = 0;
    const day0 = new Date(startMs); day0.setHours(0, 0, 0, 0);
    // 从前一天 0 点起算：凌晨时段属于前一晚的夜班窗口（如前日22:00→当日06:00）
    for (let d = day0.getTime() - 86400000; d <= endMs; d += 86400000) {
      const winS = d + HM(nightStart);
      const winE = d + 86400000 + HM(nightEnd);
      const os = Math.max(startMs, winS), oe = Math.min(endMs, winE);
      if (oe > os) total += oe - os;
    }
    return total / MS_H;
  }

  /**
   * 月薪计薪工时（月급여시간）
   * 工资条实测为 176h = 기본급 ÷ 시급。韩国实务常见两种口径：
   *   40h × 52주 ÷ 12 = 173.33h（标准） 或 签约工时制的 176h
   * 此处默认按实测值 176h，可在设置中改为 auto(173.33) 或手填。
   */
  function monthlyStandardHours(st = Store.settings) {
    const mode = st.monthlyHoursMode || 'fixed';
    if (mode === 'auto') return (Number(st.weeklyHours) || 40) * 52 / 12;
    if (mode === 'custom') return Number(st.monthlyHoursCustom) || 176;
    return Number(st.monthlyHours) || 176;
  }

  /** 企业급여(주수) = 주당일수 × 일근로시간 × 시급（工资条：4일 × 8h × 시급） */
  function weeklyBase(st = Store.settings) {
    return KR((Number(st.weeklyDays) || 4) * (Number(st.dailyHours) || 8) * (Number(st.hourlyRate) || 0));
  }

  /**
   * 计算单日出勤数据（工时/夜班时/加班时）
   * 不直接算钱——月薪制下钱按月总额算，日结只统计工时
   */
  function calcDay(rec, dateStr, opts = {}) {
    const st = Store.settings;
    const result = {
      workHours: 0, otHours: 0, nightHours: 0,
      perf: 1, segCount: rec ? rec.segments.length : 0,
      isRestDay: rec ? !!rec.isRestDay : false
    };
    if (!rec || rec.isRestDay || !rec.segments.length) return result;

    const nowForOpen = opts.nowForOpen || new Date();
    let grossMs = 0, nightMs = 0;

    for (const sg of rec.segments) {
      const s = new Date(sg.in).getTime();
      const e = sg.out ? new Date(sg.out).getTime() : nowForOpen.getTime();
      if (e <= s) continue;
      grossMs += e - s;
      nightMs += nightOverlapHours(s, e, st.nightStart, st.nightEnd) * MS_H;
    }

    grossMs = Math.max(0, grossMs - (rec.restMinutes || 0) * 60000);
    const workHours = grossMs / MS_H;

    // 日加班判定：超过「일근로시간 + 午休」算加班
    // 工资条现场근로수당 = 617,840 ÷ (시급×1.5) = 39.34h，
    // 与「平日总工时 − 计薪工时」口径吻合，故加班 = 工时 − 日计薪工时
    const dailyStd = Number(st.dailyHours) || 8;
    const otHours = Math.max(0, workHours - dailyStd);

    result.workHours = workHours;
    result.otHours = otHours;
    result.nightHours = nightMs / MS_H;
    result.perf = st.perfMode === 'monthly'
      ? (Number(st.perfMonthly) || 1)
      : (rec.perf == null ? 1 : Number(rec.perf));
    return result;
  }

  /* ============================================================
   * 出勤状态判定（月历视图用）
   * ------------------------------------------------------------
   * 优先级：未来 > 休息日/请假 > 旷工(无记录) > 缺卡 > 迟到/早退 > 正常
   * 返回 { code, label, sym, workHours, otHours, firstIn, lastOut, open }
   * ============================================================ */
  const STATUS = {
    future:  { label: '未来',   sym: '·' },
    pending: { label: '待出勤', sym: '待' },
    empty:   { label: '无记录', sym: '' },
    rest:    { label: '休息',   sym: '休' },
    leave:   { label: '请假',   sym: '假' },
    absent:  { label: '旷工',   sym: '旷' },
    missing: { label: '缺卡',   sym: '缺' },
    late:    { label: '迟到',   sym: '迟' },
    early:   { label: '早退',   sym: '退' },
    lateearly: { label: '迟到早退', sym: '迟' },
    normal:  { label: '正常',   sym: '' }
  };

  /** 把 'HH:mm' 转成当天 0 点起的毫秒数 */
  function hmToMs(hm, baseMs) {
    const [h, m] = String(hm || '00:00').split(':').map(Number);
    const d = new Date(baseMs);
    d.setHours(h || 0, m || 0, 0, 0);
    return d.getTime();
  }

  /** 某天是否法定节假日 */
  function isHoliday(dateStr, st) {
    return Array.isArray(st.holidays) && st.holidays.includes(dateStr);
  }

  /** 某天是否周休日 */
  function isWeeklyRest(dateStr, st) {
    const d = new Date(`${dateStr}T00:00:00`);
    return (st.restWeekdays || []).includes(d.getDay());
  }

  /**
   * 判定某日状态
   * @param {string} dateStr 'YYYY-MM-DD'
   * @param {Date}   now     用于「未来日期」与「今天尚未结束」的判断
   */
  function judgeDay(dateStr, opts = {}) {
    const st = Store.settings;
    const now = opts.now || new Date();
    const rec = Store.peek(dateStr);
    const dayStart = new Date(`${dateStr}T00:00:00`).getTime();
    const isToday = isoDate(now) === dateStr;

    const base = {
      dateStr, hasSeg: false, segCount: 0, workHours: 0, otHours: 0,
      firstIn: null, lastOut: null, open: false, isRest: false,
      leave: rec && rec.leave ? rec.leave : null, makeups: (rec && rec.makeups) || []
    };

    // ① 休息日（手动标注 / 周休 / 法定节假日）
    //    放在「未来」之前：休息是确定的，不分过去未来。
    //    否则月底的周休日会被显示成"未来"，月历就没法用来规划排班了。
    if (rec && rec.isRestDay) {
      return { ...base, isRest: true, code: 'rest', ...STATUS.rest };
    }
    const weeklyRest = isWeeklyRest(dateStr, st);
    const holiday = isHoliday(dateStr, st);
    if (weeklyRest || holiday) {
      // 周休/节假日却出勤了 → 仍按实际出勤统计（算加班），保留来源标识
      if (rec && rec.segments.length) {
        const r = calcDay(rec, dateStr, { nowForOpen: isToday ? now : new Date(`${dateStr}T23:59:59`) });
        return {
          ...base, ...statusFromSegments(rec, dateStr, st, now, isToday),
          hasSeg: true, segCount: rec.segments.length,
          workHours: r.workHours, otHours: r.otHours,
          extra: weeklyRest ? '주휴' : '공휴일'
        };
      }
      return { ...base, isRest: true, code: 'rest', label: weeklyRest ? '주휴 周休' : '공휴일 节假日', sym: weeklyRest ? '休' : '假' };
    }

    // ② 请假：允许提前登记，所以同样优先于「未来」
    if (base.leave) {
      return { ...base, code: 'leave', ...STATUS.leave, label: `${base.leave.type} 请假` };
    }

    // ③ 未来日期：未到，不判定、不计缺勤
    if (dayStart > now.getTime()) {
      return { ...base, code: 'future', ...STATUS.future };
    }

    // ④ 无任何记录：已过去的工作日才算旷工；今天还没结束，只是「待出勤」
    if (!rec || !rec.segments.length) {
      if (isToday) return { ...base, code: 'pending', ...STATUS.pending };
      return { ...base, code: 'absent', ...STATUS.absent };
    }

    return { ...base, ...statusFromSegments(rec, dateStr, st, now, isToday), hasSeg: true, segCount: rec.segments.length };
  }

  /** 从打卡段判定 迟到/早退/缺卡/正常 */
  function statusFromSegments(rec, dateStr, st, now, isToday) {
    const dayMs = new Date(`${dateStr}T00:00:00`).getTime();
    const segs = rec.segments.filter(sg => sg.in);
    const segStart = segs[0] ? new Date(segs[0].in).getTime() : null;
    const openSeg = Store.activeSegment(rec);
    // 最后签退时间（未签退则 null）
    let segEnd = null;
    segs.forEach(sg => {
      if (sg.out) {
        const t = new Date(sg.out).getTime();
        if (segEnd === null || t > segEnd) segEnd = t;
      }
    });

    const r = calcDay(rec, dateStr, {
      // 只有「今天」才按当前时刻实时累计；往日未签退一律按当日 23:59 封顶，
      // 否则会从那天一路算到今天，工时虚高几十倍
      nowForOpen: isToday ? now : new Date(`${dateStr}T23:59:59`)
    });
    const line = {
      workHours: r.workHours, otHours: r.otHours,
      firstIn: segStart, lastOut: segEnd, open: !!openSeg
    };

    // 缺卡：完全没有签到，或有签到却没有签退且当天已结束
    if (!segStart) return { ...line, code: 'missing', ...STATUS.missing };
    if (openSeg && !isToday) return { ...line, code: 'missing', ...STATUS.missing };

    const startAt = hmToMs(st.workStart, dayMs);
    const endAt = hmToMs(st.workEnd, dayMs);
    const lateGrace = (Number(st.lateGrace) || 0) * 60000;
    const earlyGrace = (Number(st.earlyGrace) || 0) * 60000;

    const isLate = segStart > startAt + lateGrace;
    // 今天还在进行中：只要已签到且未签退，不判早退/缺卡
    const isEarly = segEnd !== null && segEnd < endAt - earlyGrace;

    if (isLate && isEarly) return { ...line, code: 'lateearly', ...STATUS.lateearly };
    if (isLate) return { ...line, code: 'late', ...STATUS.late };
    if (isEarly) return { ...line, code: 'early', ...STATUS.early };
    return { ...line, code: 'normal', ...STATUS.normal };
  }

  /** 生成某月完整日历（含前后补白），每格附带判定结果 */
  function monthGrid(year, month, opts = {}) {
    const now = opts.now || new Date();
    const first = new Date(year, month - 1, 1);
    const daysInMonth = new Date(year, month, 0).getDate();
    const lead = first.getDay();          // 月首前需要补几格空白

    const cells = [];
    for (let i = 0; i < lead; i++) cells.push({ pad: true });

    for (let d = 1; d <= daysInMonth; d++) {
      const ds = `${year}-${String(month).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
      cells.push({ pad: false, date: d, dateStr: ds, ...judgeDay(ds, { now }) });
    }
    // 尾部补白到整周
    while (cells.length % 7 !== 0) cells.push({ pad: true });
    return cells;
  }

  /** 月度统计：按月历口径汇总各类出勤状态天数 */
  function monthStatusStats(year, month, opts = {}) {
    const cells = monthGrid(year, month, opts).filter(c => !c.pad);
    const s = { normal: 0, late: 0, early: 0, lateearly: 0, missing: 0, absent: 0, leave: 0, rest: 0, future: 0, pending: 0, workHours: 0, otHours: 0, makeupCount: 0 };
    for (const c of cells) {
      if (c.code === 'future') { s.future++; continue; }
      if (c.code === 'pending') { s.pending++; continue; }
      if (c.code === 'rest') { s.rest++; continue; }
      if (c.code === 'leave') { s.leave++; continue; }
      if (s[c.code] != null) s[c.code]++;
      if (c.hasSeg) { s.workHours += c.workHours; s.otHours += c.otHours; }
      s.makeupCount += (c.makeups || []).length;
    }
    s.workDays = s.normal + s.late + s.early + s.lateearly + s.missing;
    s.workHours = Math.round(s.workHours * 100) / 100;
    s.otHours = Math.round(s.otHours * 100) / 100;
    return s;
  }

  /**
   * 月度计算：应发构成 → 扣除 → 实发
   * 完全按工资条口径，逐项对应，便于逐笔核对
   */
  function calcMonth(year, month) {
    const st = Store.settings;
    const days = Store.attendance;
    const perf = st.perfMode === 'monthly' ? (Number(st.perfMonthly) || 1) : 1;

    // ===== 1. 考勤汇总 =====
    let workHours = 0, otHours = 0, nightHours = 0, workDays = 0, restDays = 0;
    const dayList = [];
    const today = new Date(); today.setHours(0, 0, 0, 0);
    const isCurrentMonth = today.getFullYear() === year && today.getMonth() + 1 === month;

    for (const dateStr of Object.keys(days).sort()) {
      const [y, m] = dateStr.split('-').map(Number);
      if (y !== year || m !== month) continue;
      const rec = days[dateStr];
      if (rec.isRestDay) { restDays++; dayList.push({ dateStr, rec, rest: true }); continue; }
      const r = calcDay(rec, dateStr, {
        nowForOpen: (isCurrentMonth && dateStr === isoDate(today))
          ? new Date()
          : new Date(dateStr + 'T23:59:59')
      });
      dayList.push({ dateStr, rec, r });
      if (r.segCount > 0) {
        workDays++; workHours += r.workHours; otHours += r.otHours; nightHours += r.nightHours;
      }
    }

    // ===== 2. 应发构成（对应工资条 지급내역）=====
    const hourly = Number(st.hourlyRate) || 0;
    const stdHours = monthlyStandardHours(st);
    const weekly = weeklyBase(st);

    // 기본급 = 시급 × 월급여시간（绩效/评价系数作用于此）
    const basePay = KR(stdHours * hourly * perf);
    // 현장근로수당 = 시급 × 1.5 × 实际加班工时
    const otPay = KR(otHours * hourly * (Number(st.overtimeMultiplier) || 1.5));
    // 상여수당 = 시급 × 0.5 × 结算工时
    const bonusPay = KR(workHours * hourly * (Number(st.bonusMultiplier) || 0.5));

    // 津贴项：按配置逐项生成（fixed 固定额 / formulaWeekly,formulaOT,formulaBonus 引擎算）
    const allowances = (st.allowances || []).filter(a => a.enabled).map(a => {
      let amount, formula = '';
      if (a.type === 'formulaWeekly') {
        amount = weekly;
        formula = `${st.weeklyDays}일 × ${st.dailyHours}h × 시급`;
      } else if (a.type === 'formulaOT') {
        amount = otPay;
        formula = `시급 × ${st.overtimeMultiplier} × ${otHours.toFixed(2)}h`;
      } else if (a.type === 'formulaBonus') {
        amount = bonusPay;
        formula = `시급 × ${st.bonusMultiplier} × ${workHours.toFixed(1)}h`;
      } else {
        amount = KR(a.value); formula = '固定额';
      }
      return { ...a, amount, formula };
    });

    // 기본급 单独作为一项（引擎算的，不在 allowances 里）
    const grossItems = [
      { id: 'base', name: '기본급', nameCn: '基本工资(月薪)', amount: basePay, formula: `시급 ${hourly.toLocaleString()} × ${stdHours}h` }
    ].concat(allowances);
    const gross = grossItems.reduce((s, d) => s + d.amount, 0);

    // ===== 3. 扣除（对应工资条 공제내역）=====
    // 보험료기준(社保基数) = 기본급 + 실액수당（非保险收入项不计）
    const salaryItem = grossItems.find(i => i.id === 'base');
    const mealItem = grossItems.find(i => i.id === 'a3');   // 실액수당
    const insurableBase = (salaryItem?.amount || 0) + (mealItem?.amount || 0);

    const incomeTax = calcIncomeTax(st, insurableBase, bonusPay, gross);

    const deductions = (st.deductions || []).filter(d => d.enabled).map(d => {
      let amount = 0, formula = '';
      switch (d.type) {
        case 'percentOfBase':
          amount = KR(insurableBase * (Number(d.value) || 0) / 100);
          formula = `× ${d.value}%`;
          break;
        case 'percentOfGross':
          amount = KR(gross * (Number(d.value) || 0) / 100);
          formula = `应发 × ${d.value}%`;
          break;
        case 'percentOfIncomeTax': {
          // 韩国地方所得税 = 所得税 × rate，但工资条实务是「先按10%取整到十位」
          // 119,880 × 10% = 11,988 → 工资条为 11,980（十位向下取整）
          const raw = incomeTax * (Number(d.value) || 0) / 100;
          amount = (d.floorTo === 10 && st.localTaxFloor === true)
            ? Math.floor(raw / 10) * 10
            : KR(raw);
          formula = `所得税 × ${d.value}%`;
          break;
        }
        case 'percentOfHealthIns':
          // 장기요금보험료 ≈ 건강보험료的 10%
          amount = KR(insurableBase * (Number(d.value) || 0) / 100);
          formula = `保险基数 × ${d.value}%`;
          break;
        case 'koreanTax':
          amount = incomeTax;
          formula = (st.taxMode || 'manual') === 'manual'
            ? '采用工资条实发税额'
            : '累进6级估算';
          break;
        default:
          amount = KR(d.value); formula = '固定额';
      }
      return { ...d, amount, formula };
    });
    const deductTotal = deductions.reduce((s, d) => s + d.amount, 0);

    return {
      gross, net: gross - deductTotal, grossItems, deductions, deductTotal,
      insurableBase, incomeTax, bonusPay, otPay,
      basePay, stdHours, perf,
      workDays, restDays, workHours, otHours, nightHours, dayList,
      perfNote: perf !== 1 ? `（含评价系数 ${perf}）` : ''
    };
  }

  /** 应税所得 = 保险基数（韩国：全年所得的1/12，上奖金另计） */
  function taxableIncome(insurableBase, bonusPay, st) {
    return insurableBase + bonusPay;
  }

  /**
   * 所得税计算
   * 说明：韩国所得税的实际税额 = 累进税额 − 25% 减除（소득감면）+ 地方所得税，
   * 且「月所得200万 이하 6%」的适用条件是「月总所得 200万 이하、연봉 4,500万 이하」，
   * 无法仅凭工资条表面数字反推出确切还原式。
   * 因此策略是：
   *   taxMode = 'auto'  → 按累进算法估算（供日常参考）
   *   taxMode = 'manual'→ 使用工资条上手工录入的实际税额（核对优先，默认为 manual）
   * 这样既能算，也能与工资条逐分核对，不会因为算法简化而误判被少发。
   */
  function calcIncomeTax(st, insurableBase, bonusPay, gross) {
    const mode = st.taxMode || 'manual';
    if (mode === 'manual') {
      const manual = Number(st.taxManualAmount) || 0;
      if (manual > 0) return KR(manual);
    }
    return calcKoreanTax(taxableIncome(insurableBase, bonusPay, st), st);
  }

  /** 韩国所得税累进（6 级，估算用） */
  function calcKoreanTax(taxable, st = Store.settings) {
    const brackets = st.taxBrackets || [];
    let tax = 0;
    for (const b of brackets) {
      if (taxable > b.min) {
        const top = b.max == null ? taxable : Math.min(taxable, b.max);
        tax += (top - b.min) * b.rate;
      }
    }
    return KR(tax);
  }

  /** 通用累进（保留，兼容旧调用） */
  function calcTax(income) { return calcKoreanTax(income); }

  function isoDate(d) {
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  }

  /** 毫秒→ "2h05m" */
  function fmtHM(ms) {
    const t = Math.max(0, Math.round(ms / 60000));
    return `${Math.floor(t / 60)}h${String(t % 60).padStart(2, '0')}m`;
  }

  return {
    distance, nightOverlapHours, calcDay, calcMonth, calcTax, calcKoreanTax,
    judgeDay, statusFromSegments, monthGrid, monthStatusStats, STATUS, isHoliday, isWeeklyRest,
    monthlyStandardHours, weeklyBase, taxableIncome, isoDate, fmtHM
  };
})();