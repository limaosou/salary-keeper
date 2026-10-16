/* ========== 计薪引擎 ========== */
const Salary = (() => {

  const HM = s => { const [h, m] = s.split(':').map(Number); return h * 3600000 + m * 60000; };
  const MS_H = 3600000;

  /** Haversine 距离（米） */
  function distance(lat1, lng1, lat2, lng2) {
    const R = 6371000, rad = Math.PI / 180;
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
   * 计算单日收入
   * @param rec 当日考勤记录
   * @param dateStr 'YYYY-MM-DD'
   * @param opts { nowForOpen: Date|null } 未签退段的截止时间（实时计算用）
   */
  function calcDay(rec, dateStr, opts = {}) {
    const st = Store.settings;
    const result = {
      workHours: 0, otHours: 0, nightHours: 0,
      basePay: 0, otPay: 0, nightPay: 0, perf: 1, total: 0, segCount: rec.segments.length
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

    grossMs = Math.max(0, grossMs - rec.restMinutes * 60000);
    const workHours = grossMs / MS_H;
    const otHours = Math.max(0, workHours - st.standardHours);
    const normalHours = Math.min(workHours, st.standardHours);
    const nightHours = nightMs / MS_H;

    // 绩效系数：按日 or 按月
    const perf = st.perfMode === 'monthly'
      ? Number(st.perfMonthly) || 1
      : (rec.perf == null ? 1 : Number(rec.perf));

    const basePay = normalHours * st.hourlyRate * perf;
    const otPay = otHours * st.hourlyRate * st.overtimeMultiplier;
    const nightPay = st.nightMode === 'fixed'
      ? (rec.shiftType === 'night' ? st.nightAmount : 0)
      : nightHours * st.nightAmount;

    return {
      workHours, otHours, nightHours, perf,
      basePay, otPay, nightPay,
      total: basePay + otPay + nightPay,
      segCount: rec.segments.length
    };
  }

  /** 月度汇总：应发、扣除、实发 */
  function calcMonth(year, month) {
    const st = Store.settings;
    const days = Store.attendance;
    let gross = 0, workHours = 0, otHours = 0, nightHours = 0, workDays = 0, restDays = 0;
    let baseSum = 0, otSum = 0, nightSum = 0;
    const today = new Date(); today.setHours(0, 0, 0, 0);
    const isCurrentMonth = today.getFullYear() === year && today.getMonth() + 1 === month;

    const dayList = [];
    for (const dateStr of Object.keys(days).sort()) {
      const [y, m] = dateStr.split('-').map(Number);
      if (y !== year || m !== month) continue;
      const rec = days[dateStr];
      if (rec.isRestDay) { restDays++; dayList.push({ dateStr, rec, rest: true }); continue; }
      const r = calcDay(rec, dateStr, {
        // 今日未签退段算到当前时刻；往日未签退段按当日 23:59 封顶，避免无限累计
        nowForOpen: (isCurrentMonth && dateStr === isoDate(today))
          ? new Date()
          : new Date(dateStr + 'T23:59:59')
      });
      dayList.push({ dateStr, rec, r });
      if (r.segCount > 0) {
        workDays++; workHours += r.workHours; otHours += r.otHours; nightHours += r.nightHours;
        baseSum += r.basePay; otSum += r.otPay; nightSum += r.nightPay;
      }
      gross += r.total;
    }

    // 扣除项
    const perf = st.perfMode === 'monthly' ? (Number(st.perfMonthly) || 1) : 1;
    const perfNote = st.perfMode === 'monthly' && perf !== 1 ? `（含整月绩效系数 ${perf}）` : '';
    const deductions = st.deductions.map(d => {
      let amount = 0, label = d.name;
      if (d.type === 'percent') { amount = gross * (Number(d.value) || 0) / 100; label = `${d.name}（${d.value}%）`; }
      else if (d.type === 'fixed') { amount = Number(d.value) || 0; label = `${d.name}`; }
      else if (d.type === 'tax') { amount = calcTax(gross); label = `${d.name}（累进）`; }
      return { ...d, amount, label };
    });
    const deductTotal = deductions.reduce((s, d) => s + d.amount, 0);

    return {
      gross, net: gross - deductTotal, deductions, deductTotal,
      workDays, restDays, workHours, otHours, nightHours,
      baseSum, otSum, nightSum, perfNote, dayList
    };
  }

  /** 个税累进计算 */
  function calcTax(income) {
    const brackets = Store.settings.taxBrackets || [];
    let tax = 0;
    for (const b of brackets) {
      if (income > b.min) {
        const top = b.max == null ? income : Math.min(income, b.max);
        tax += (top - b.min) * b.rate;
      }
    }
    return tax;
  }

  function isoDate(d) {
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  }

  /** 毫秒 → "2h05m" */
  function fmtHM(ms) {
    const t = Math.max(0, Math.round(ms / 60000));
    return `${Math.floor(t / 60)}h${String(t % 60).padStart(2, '0')}m`;
  }

  return { distance, nightOverlapHours, calcDay, calcMonth, calcTax, isoDate, fmtHM };
})();
