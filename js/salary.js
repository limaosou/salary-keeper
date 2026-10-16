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
    monthlyStandardHours, weeklyBase, taxableIncome, isoDate, fmtHM
  };
})();