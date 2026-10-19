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
   *
   * 计薪口径（2026-10-20 起）：**按班次应到/应退计时，不按实际打卡时刻**
   *   · 基准 = shiftWindowFor 的窗口 − 每日休息扣除
   *   · 自动（地理围栏）打卡按真实时间：迟到/早退超出宽限的部分扣减
   *   · 手动签到 / 补签（seg.src === 'manual'）**视同按时出勤**——
   *     忘了打卡、12 点才想起来，都按当班正常时间算，不扣
   *   · 实际工时超出班次窗口的部分仍按加班计（extraOtHours）
   *   · rec.adjust = { lateMin, earlyMin, note } 为特殊情况手工登记扣减
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
    const shiftType = rec.shiftType || 'day';
    const restMs = (Number(rec.restMinutes) || 0) * 60000;
    const lateGrace = (Number(st.lateGrace) || 0) * 60000;
    const earlyGrace = (Number(st.earlyGrace) || 0) * 60000;

    // ---- ① 实际在岗：各段累加（未签退段封顶到 nowForOpen），再扣每日休息 ----
    const segs = rec.segments.filter(sg => sg.in);
    let rawMs = 0;
    let firstIn = null, lastOut = null, lastOutSeg = null, openSeg = null;
    for (const sg of segs) {
      const s = new Date(sg.in).getTime();
      const e = sg.out ? new Date(sg.out).getTime() : nowForOpen.getTime();
      if (e <= s) continue;
      rawMs += e - s;
      if (firstIn === null || s < firstIn) firstIn = s;
      if (sg.out) {
        if (lastOut === null || e > lastOut) { lastOut = e; lastOutSeg = sg; }
      } else if (!openSeg) {
        openSeg = sg;
      }
    }
    if (firstIn === null) return result;
    const actualMs = Math.max(0, rawMs - restMs);

    // ---- ② 班次窗口（应到 / 应退）----
    const schedStart = shiftBoundary(dateStr, shiftType, 'in', st).getTime();
    const schedEnd = shiftBoundary(dateStr, shiftType, 'out', st).getTime();
    const schedMs = Math.max(0, schedEnd - schedStart - restMs);
    if (schedMs <= 0) {                     // 班次配置异常时退回实际工时
      const wh = Math.max(0, actualMs - restMs) / MS_H;
      return { ...result, workHours: wh, otHours: Math.max(0, wh - (Number(st.dailyHours) || 8)) };
    }

    // ---- ③ 有效在岗区间 ----
    // 手动签到/补签 → 起点视同应到；自动打卡 → 真实时间（宽限内不扣）
    const manualIn = segs[0].src === 'manual';
    const manualOut = !!lastOutSeg && lastOutSeg.src === 'manual';
    let inEff = manualIn
      ? schedStart
      : Math.max(Math.min(firstIn, schedStart), firstIn - lateGrace);
    let outEff = manualOut
      ? schedEnd
      : (lastOut === null
          ? schedEnd
          : Math.min(Math.max(lastOut, schedEnd), lastOut + earlyGrace));

    // ---- ④ 特殊情况手工登记（迟到/早退 + 说明）----
    const adj = rec.adjust;
    if (adj) {
      inEff += (Number(adj.lateMin) || 0) * 60000;
      outEff -= (Number(adj.earlyMin) || 0) * 60000;
    }

    // ---- ⑤ 未签退：最多算到「当前时刻」----
    if (openSeg && !lastOut) outEff = Math.min(outEff, nowForOpen.getTime());

    // ---- ⑥ 计薪工时 = 班次窗口内（封顶）＋ 窗口外实际加班 ----
    const paidMs = Math.max(0, Math.min(outEff - inEff - restMs, schedMs));
    const extraMs = Math.max(0, actualMs - schedMs);
    const workHours = (paidMs + extraMs) / MS_H;

    // 夜班时数按有效在岗区间算（手动补签视同整班在岗）
    const nightEnd = openSeg ? Math.max(nowForOpen.getTime(), inEff) : Math.max(lastOut || inEff, inEff);
    const nightMs = nightOverlapHours(inEff, nightEnd, st.nightStart, st.nightEnd) * MS_H;

    result.workHours = workHours;
    result.otHours = Math.max(0, workHours - (Number(st.dailyHours) || 8));
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

  /**
   * 某天是否法定节假日
   * holidaySource: builtin=内置韩国法定假日表 | custom=仅用户自定义 | both=两者
   */
  function isHoliday(dateStr, st) {
    const src = st.holidaySource || 'builtin';
    if (src !== 'custom' && typeof KR_HOLIDAYS !== 'undefined') {
      const h = KR_HOLIDAYS.get(dateStr, { includeLabour: st.includeLabourDay !== false });
      if (h) return true;
    }
    if (src !== 'builtin' && Array.isArray(st.holidays)) {
      return st.holidays.includes(dateStr);
    }
    return false;
  }

  /** 取某日节假日详情（供月历显示名称），非假日返回 null */
  function holidayInfo(dateStr, st = Store.settings) {
    const src = st.holidaySource || 'builtin';
    if (src !== 'custom' && typeof KR_HOLIDAYS !== 'undefined') {
      const h = KR_HOLIDAYS.get(dateStr, { includeLabour: st.includeLabourDay !== false });
      if (h) return h;
    }
    if (src !== 'builtin' && Array.isArray(st.holidays) && st.holidays.includes(dateStr)) {
      return { name: '공휴일', cn: '法定节假日', type: 'custom', typeLabel: '사용자지정' };
    }
    return null;
  }

  /**
   * 某天的班次窗口（应到 / 应退时间）
   * 白班 08:20–20:20；夜班 20:20–次日 08:20
   * 周上 5 天时：白班周一 10:20 上班；夜班周五 06:20 下班
   * @returns { start, end, crossMidnight, isNight, note }
   */
  function shiftWindowFor(dateStr, shiftType, st = Store.settings) {
    const sh = st.shift || {};
    const d = new Date(`${dateStr}T00:00:00`);
    const wd = d.getDay();                      // 0=周日 … 5=周五
    const fiveDays = (Number(sh.weeklyWorkDays) || 5) >= 5;

    if (shiftType === 'night') {
      const start = sh.nightStart || '20:20';
      let end = sh.nightEnd || '08:20';
      let note = '';
      if (fiveDays && sh.friEarlyEnd && wd === 5 && sh.friNightEnd) {
        end = sh.friNightEnd; note = '금 야근 조퇴근 周五早下班';
      }
      return { start, end, crossMidnight: true, isNight: true, note };
    }
    let start = sh.dayStart || '08:20';
    const end = sh.dayEnd || '20:20';
    let note = '';
    if (fiveDays && sh.monLateStart && wd === 1 && sh.monDayStart) {
      start = sh.monDayStart; note = '월 백근 지각출근 周一晚上班';
    }
    return { start, end, crossMidnight: false, isNight: false, note };
  }

  /** 取某日应到/应退的具体时刻（Date），用于迟到早退判定 */
  function shiftBoundary(dateStr, shiftType, which, st = Store.settings) {
    const w = shiftWindowFor(dateStr, shiftType, st);
    const hm = which === 'in' ? w.start : w.end;
    const [h, m] = hm.split(':').map(Number);
    const d = new Date(`${dateStr}T00:00:00`);
    d.setHours(h, m, 0, 0);
    // 夜班下班跨午夜：归到次日
    if (which === 'out' && w.crossMidnight) d.setDate(d.getDate() + 1);
    return d;
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

    const hi0 = holidayInfo(dateStr, st);
    const base = {
      dateStr, hasSeg: false, segCount: 0, workHours: 0, otHours: 0,
      firstIn: null, lastOut: null, open: false, isRest: false,
      isHoliday: !!hi0, holidayName: hi0 ? hi0.name : '',
      pay: null,
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
    const hi = holiday ? holidayInfo(dateStr, st) : null;
    if (weeklyRest || holiday) {
      // 周休/节假日却出勤了 → 仍按实际出勤统计（节假日全天 1.5 倍），保留来源标识
      if (rec && rec.segments.length) {
        const r = calcDay(rec, dateStr, { nowForOpen: isToday ? now : new Date(`${dateStr}T23:59:59`) });
        return {
          ...base, ...statusFromSegments(rec, dateStr, st, now, isToday),
          hasSeg: true, segCount: rec.segments.length,
          workHours: r.workHours, otHours: r.otHours,
          isHoliday: !!holiday, holidayName: hi ? hi.name : '',
          extra: holiday ? `${hi ? hi.name : '공휴일'} ×1.5` : '주휴'
        };
      }
      return {
        ...base, isRest: true, code: 'rest',
        isHoliday: !!holiday, holidayName: hi ? hi.name : '',
        label: holiday ? `${hi ? hi.name : '공휴일'} 法定假日` : '주휴 周休',
        sym: holiday ? '假' : '休'
      };
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

    // 按当日班次（白班/夜班）与星期例外取应到/应退时刻
    const shiftType = rec.shiftType || 'day';
    const startAt = shiftBoundary(dateStr, shiftType, 'in', st).getTime();
    const endAt = shiftBoundary(dateStr, shiftType, 'out', st).getTime();
    const lateGrace = (Number(st.lateGrace) || 0) * 60000;
    const earlyGrace = (Number(st.earlyGrace) || 0) * 60000;

    // 手动签到 / 补签：视同按时出勤，不因「忘了打卡、事后才补」判迟到早退
    const manualIn = segs[0].src === 'manual';
    let lastOutSeg = null;
    segs.forEach(sg => { if (sg.out && new Date(sg.out).getTime() === segEnd) lastOutSeg = sg; });
    const manualOut = !!lastOutSeg && lastOutSeg.src === 'manual';
    const adj = rec.adjust || null;

    let isLate = !manualIn && segStart > startAt + lateGrace;
    // 今天还在进行中：只要已签到且未签退，不判早退/缺卡
    let isEarly = !manualOut && segEnd !== null && segEnd < endAt - earlyGrace;

    // 特殊情况登记：手工登记的迟到/早退分钟数，直接体现在状态与工时上
    if (adj && ((Number(adj.lateMin) || 0) > 0 || (Number(adj.earlyMin) || 0) > 0)) {
      if ((Number(adj.lateMin) || 0) > 0) isLate = true;
      if ((Number(adj.earlyMin) || 0) > 0) isEarly = true;
    }

    const adjNote = adj && ((Number(adj.lateMin) || 0) > 0 || (Number(adj.earlyMin) || 0) > 0)
      ? `（登记扣减：迟到 ${Number(adj.lateMin) || 0} 分 / 早退 ${Number(adj.earlyMin) || 0} 分${adj.note ? ' · ' + adj.note : ''}）`
      : '';

    if (isLate && isEarly) return { ...line, code: 'lateearly', ...STATUS.lateearly, extra: adjNote };
    if (isLate) return { ...line, code: 'late', ...STATUS.late, extra: adjNote };
    if (isEarly) return { ...line, code: 'early', ...STATUS.early, extra: adjNote };
    if (manualIn || manualOut) {
      return { ...line, code: 'normal', ...STATUS.normal, extra: '补签/手动 · 按当班时间计' };
    }
    return { ...line, code: 'normal', ...STATUS.normal };
  }

  /* ============================================================
   * 日薪计算（新口径）
   *   白班 = 标准 8h × 시급 ＋ 固定加班 3.5h × 시급 × 1.5
   *   夜班 = 白班 ＋ 夜班补助 3.5h × 시급 × 야간가산율(0.5)
   *   实际工时超出「标准 + 固定加班」的部分，仍按加班倍率计
   *   法定节假日出勤 → 当日合计 × holidayMultiplier（全天 1.5 倍）
   * ============================================================ */
  function calcDayPay(dateStr, opts = {}) {
    const st = Store.settings;
    const rec = Store.peek(dateStr);
    const dp = st.dailyPay || {};
    const hourly = Number(st.hourlyRate) || 0;
    const stdH = num(dp.stdHours, 8);
    const fixH = num(dp.fixedOtHours, 3.5);
    const nightH = num(dp.nightAllowHours, 3.5);
    const nightRate = num(dp.nightAllowRate, 0.5);
    const holMul = num(dp.holidayMultiplier, 1.5);
    const otMul = Number(st.overtimeMultiplier || 1.5);
    const hol = holidayInfo(dateStr, st);
    const shiftType = rec ? (rec.shiftType || 'day') : 'day';

    const zero = {
      dateStr, shiftType, kind: 'none', paid: false,
      workHours: 0, otHours: 0, nightHours: 0, extraOtHours: 0,
      isNight: shiftType === 'night',
      isHoliday: !!hol, holidayName: hol ? hol.name : '',
      stdPay: 0, otPay: 0, nightPay: 0, extraOtPay: 0, holidayExtra: 0,
      leavePay: 0, leaveType: '', total: 0
    };
    if (!rec) return zero;
    if (rec.isRestDay) return { ...zero, kind: 'rest' };

    if (rec.leave) {
      const t = rec.leave.type || '기타';
      if (dp.annualLeavePaid !== false && t === '연차') {
        const p = KR(stdH * hourly);
        return { ...zero, kind: 'leave', paid: true, leaveType: t, leavePay: p, total: p };
      }
      return { ...zero, kind: 'leave', leaveType: t };
    }

    const r = calcDay(rec, dateStr, opts);
    if (!r.segCount) return { ...zero, kind: 'none' };

    const isNight = shiftType === 'night';
    const stdPay = KR(stdH * hourly);
    const otPay = KR(fixH * hourly * otMul);
    const nightPay = isNight ? KR(nightH * hourly * nightRate) : 0;
    const extraH = Math.max(0, r.workHours - stdH - fixH);
    const extraOtPay = KR(extraH * hourly * otMul);

    const base = stdPay + otPay + nightPay + extraOtPay;
    const holidayExtra = hol ? KR(base * (holMul - 1)) : 0;

    return {
      ...zero, kind: 'work', paid: true, isNight,
      workHours: r.workHours, otHours: r.otHours, nightHours: r.nightHours,
      extraOtHours: extraH,
      stdPay, otPay, nightPay, extraOtPay, holidayExtra,
      total: base + holidayExtra
    };
  }

  /** 安全取数：null/undefined/NaN 时回落到默认 */
  function num(v, dflt) {
    const n = Number(v);
    return (v === null || v === undefined || Number.isNaN(n)) ? dflt : n;
  }

  /* ============================================================
   * 发薪日：每月 17 日；逢周末提前至前一个周五
   * ============================================================ */
  function payDateFor(year, month, payDay = 17) {
    const day = Math.min(31, Math.max(1, Number(payDay) || 17));
    const d = new Date(year, month - 1, day);
    const dow = d.getDay();
    let adjusted = false;
    if (dow === 6) { d.setDate(d.getDate() - 1); adjusted = true; }   // 周六 → 周五
    else if (dow === 0) { d.setDate(d.getDate() - 2); adjusted = true; } // 周日 → 周五
    const WD = ['일', '월', '화', '수', '목', '금', '토'];
    return {
      date: d,
      dateStr: isoDate(d),
      weekday: d.getDay(),
      weekdayKr: WD[d.getDay()],
      adjusted,
      origin: day,
      label: `${d.getMonth() + 1}/${d.getDate()}(${WD[d.getDay()]})`
    };
  }

  /* ============================================================
   * 退职金（퇴직금）
   *   法定：1일 평균임금 × 30일 × (재직일수 / 365)，需满 1 年
   *   1일 평균임금 = 最近 3 个月工资总额 ÷ 最近 3 个月总天数
   * ============================================================ */
  function parseHireDate(s) {
    if (!s) return null;
    const m = String(s).match(/(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/);
    if (!m) return null;
    const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
    return Number.isNaN(d.getTime()) ? null : d;
  }

  /**
   * 计算工龄与预计退职金
   * @param {string} hireDateStr 'YYYY/MM/DD'
   * @param {Date} asOf
   * @param {number} monthlyGross 月平均应发（用于折算日均工资）
   */
  function severance(hireDateStr, asOf = new Date(), monthlyGross = 0) {
    const hire = parseHireDate(hireDateStr);
    const base = {
      ok: false, hireDate: hireDateStr || '', days: 0, years: 0, months: 0,
      eligible: false, dailyAvgWage: 0, amount: 0, monthlyGross, note: ''
    };
    if (!hire) return { ...base, note: '未填写或无法解析入职日期' };

    const MS_DAY = 86400000;
    const days = Math.floor((asOf.getTime() - hire.getTime()) / MS_DAY);
    if (days < 0) return { ...base, note: '入职日期晚于当前日期' };

    const years = Math.floor(days / 365);
    const months = Math.floor((days % 365) / 30);
    const eligible = days >= 365;

    // 1일 평균임금 ≈ 月平均应发 ÷ 当月天数（30 日基准，韩国实务常用）
    const dailyAvgWage = monthlyGross > 0 ? KR(monthlyGross / 30) : 0;
    const amount = eligible && dailyAvgWage > 0
      ? KR(dailyAvgWage * 30 * (days / 365))
      : 0;

    return {
      ...base, ok: true, days, years, months, eligible,
      dailyAvgWage, amount,
      note: eligible
        ? `근속 ${years}년 ${months}개월（${days}일）`
        : `근속 ${days}일，未满 1 年，尚无法定退职金`
    };
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
    const s = {
      normal: 0, late: 0, early: 0, lateearly: 0, missing: 0, absent: 0,
      leave: 0, rest: 0, holiday: 0, holidayWork: 0, nightDays: 0,
      future: 0, pending: 0, workHours: 0, otHours: 0, makeupCount: 0
    };
    for (const c of cells) {
      if (c.isHoliday) s.holiday++;
      if (c.isHoliday && c.hasSeg) s.holidayWork++;
      if (c.code === 'future') { s.future++; continue; }
      if (c.code === 'pending') { s.pending++; continue; }
      if (c.code === 'rest') { s.rest++; continue; }
      if (c.code === 'leave') { s.leave++; continue; }
      if (c.hasSeg && (Store.peek(c.dateStr) || {}).shiftType === 'night') s.nightDays++;
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
   * 月度计算入口
   *   mode='slip'        → 工资条口径（기본급 按月薪计薪工时固定，前月 / 已归档月份用）
   *   mode='attendance'  → 按当月考勤实算（非固定值，当月用）
   */
  function calcMonth(year, month, opts = {}) {
    const mode = opts.mode || 'slip';
    return mode === 'attendance'
      ? calcMonthAttendance(year, month, opts)
      : calcMonthSlip(year, month, opts);
  }

  /** 某月该用哪种口径：当月按考勤实算，其余月份按工资条固定口径 */
  function payrollModeFor(year, month, now = new Date()) {
    return (now.getFullYear() === year && now.getMonth() + 1 === month)
      ? 'attendance' : 'slip';
  }

  /* ============================================================
   * 按考勤实算（当月）
   *   逐日按「标准 8h + 固定加班 3.5h(×1.5) + 夜班补助」累加，
   *   出勤天数、夜班天数、节假日出勤天数全部由实际打卡推导，非固定值。
   * ============================================================ */
  function calcMonthAttendance(year, month, opts = {}) {
    const st = Store.settings;
    const now = opts.now || new Date();
    const daysInMonth = new Date(year, month, 0).getDate();
    const hourly = Number(st.hourlyRate) || 0;
    const dp = st.dailyPay || {};
    const stdH = Number(dp.stdHours != null ? dp.stdHours : 8);
    const fixH = Number(dp.fixedOtHours != null ? dp.fixedOtHours : 3.5);
    const nightH = Number(dp.nightAllowHours != null ? dp.nightAllowHours : 3.5);
    const nightRate = Number(dp.nightAllowRate != null ? dp.nightAllowRate : 0.5);
    const holMul = Number(dp.holidayMultiplier != null ? dp.holidayMultiplier : 1.5);
    const otMul = Number(st.overtimeMultiplier || 1.5);
    const perf = st.perfMode === 'monthly' ? (Number(st.perfMonthly) || 1) : 1;

    let workDays = 0, nightDays = 0, holidayWorkDays = 0, restDays = 0, leaveDays = 0, annualDays = 0, otDays = 0;
    let workHours = 0, otHours = 0, nightHours = 0, extraOtHours = 0;
    const T = { std: 0, leave: 0, ot: 0, night: 0, extraOt: 0, holiday: 0 };
    const dayList = [];

    for (let d = 1; d <= daysInMonth; d++) {
      const ds = `${year}-${String(month).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
      const isToday = ds === isoDate(now);
      const jd = judgeDay(ds, { now });
      const p = calcDayPay(ds, {
        // 今天按当前时刻实时累计；往日未签退一律封顶到当日 23:59
        nowForOpen: isToday ? now : new Date(`${ds}T23:59:59`)
      });
      const rec = Store.peek(ds);
      // 「每日记录」只列出有实际内容的日期：有打卡 / 请假 / 手标休息，
      // 其余（未来日期、无记录的工作日、纯周休日）不占列表长度
      const meaningful = p.kind === 'work' || p.kind === 'leave'
        || (rec && (rec.isRestDay || (rec.segments || []).length))
        || (!!(rec && rec.makeups && rec.makeups.length));
      if (meaningful) dayList.push({ dateStr: ds, rec, pay: p, rest: jd.code === 'rest' });

      if (jd.code === 'rest') { restDays++; continue; }
      if (jd.code === 'leave') {
        leaveDays++;
        if (p.leavePay > 0) annualDays++;
        T.leave += p.leavePay;
        continue;
      }
      if (jd.code === 'future') continue;
      if (p.kind === 'work') {
        workDays++;
        if (p.isNight) nightDays++;
        if (p.isHoliday) holidayWorkDays++;
        if (p.extraOtHours > 0.01) otDays++;
        workHours += p.workHours; otHours += p.otHours;
        nightHours += p.nightHours; extraOtHours += p.extraOtHours;
      }
      T.std += p.stdPay; T.ot += p.otPay; T.night += p.nightPay;
      T.extraOt += p.extraOtPay; T.holiday += p.holidayExtra;
    }

    // ===== 应发构成 =====
    const stdPay = KR((T.std) * perf);
    const otPay = KR((T.ot + T.extraOt) * perf);
    const nightPay = KR(T.night * perf);
    const holPay = KR(T.holiday * perf);
    const leavePay = KR(T.leave * perf);

    // 实算模式下只保留「固定额 / 按日计发」两类津贴。
    // formulaWeekly / formulaOT / formulaBonus 属于工资条口径（주수、현장근로수당），
    // 在这里会与上面的 연장근로수당 重复计一笔加班费，必须排除。
    const allowances = (st.allowances || [])
      .filter(a => a.enabled && (a.type === 'fixed' || a.type === 'perDay'))
      .map(a => {
      let amount, formula = '';
      if (a.type === 'perDay') {
        amount = KR((Number(a.value) || 0) * (workDays + annualDays));
        formula = `${Number(a.value).toLocaleString()}원 × ${workDays + annualDays}일`;
      } else if (a.type === 'formulaOT') {
        amount = otPay;
        formula = `시급 × ${otMul} × ${(otHours + extraOtHours).toFixed(2)}h`;
      } else if (a.type === 'formulaWeekly') {
        amount = weeklyBase(st);
        formula = `${st.weeklyDays}일 × ${st.dailyHours}h × 시급`;
      } else if (a.type === 'formulaBonus') {
        amount = KR(workHours * hourly * (Number(st.bonusMultiplier) || 0.5));
        formula = `시급 × ${st.bonusMultiplier} × ${workHours.toFixed(1)}h`;
      } else {
        amount = KR(a.value); formula = '고정액 固定额';
      }
      return { ...a, amount, formula };
    });

    const grossItems = [
      { id: 'std', name: '기본급', nameCn: '标准工资(8h×出勤日)', amount: stdPay,
        formula: `${workDays}일 × ${stdH}h × 시급 ${hourly.toLocaleString()}` },
      { id: 'ot', name: '연장근로수당', nameCn: '固定加班', amount: otPay,
        formula: `${workDays}일 × ${fixH}h × 시급 × ${otMul}${extraOtHours > 0.01 ? ` ＋ 超出 ${extraOtHours.toFixed(2)}h` : ''}` },
      { id: 'night', name: '야간근로수당', nameCn: '夜班补助', amount: nightPay,
        formula: `${nightDays}일 × ${nightH}h × 시급 × ${nightRate}` },
      { id: 'hol', name: '휴일근로수당', nameCn: '节假日出勤加给', amount: holPay,
        formula: `${holidayWorkDays}일 × 全天 × ${holMul}` },
      { id: 'annual', name: '유급연차', nameCn: '有薪年假', amount: leavePay,
        formula: `${annualDays}일 × ${stdH}h × 시급` }
    ].filter(it => it.amount > 0).concat(allowances);

    const gross = grossItems.reduce((s, d) => s + d.amount, 0);

    // ===== 扣除：保险基数 = 기본급 + 실액수당 =====
    const stdItem = grossItems.find(i => i.id === 'std');
    const mealItem = grossItems.find(i => i.id === 'a3');
    const insurableBase = (stdItem?.amount || 0) + (mealItem?.amount || 0);
    const incomeTax = calcIncomeTax(st, insurableBase, 0, gross);
    const { deductions, deductTotal } = buildDeductions(st, insurableBase, incomeTax, gross);

    const round2 = n => Math.round(n * 100) / 100;

    return {
      mode: 'attendance',
      gross, net: gross - deductTotal, grossItems, deductions, deductTotal,
      insurableBase, incomeTax, bonusPay: 0, otPay,
      basePay: stdPay, stdHours: stdH, perf,
      workDays, restDays, leaveDays, annualDays,
      nightDays, holidayWorkDays, otDays,
      workHours: round2(workHours), otHours: round2(otHours),
      nightHours: round2(nightHours), extraOtHours: round2(extraOtHours),
      dayList,
      taxIsFixed: (st.taxMode || 'manual') === 'manual',
      perfNote: perf !== 1 ? `（含评价系数 ${perf}）` : ''
    };
  }

  /** 扣除项计算（两种口径共用） */
  function buildDeductions(st, insurableBase, incomeTax, gross) {
    const deductions = (st.deductions || []).filter(d => d.enabled).map(d => {
      let amount = 0, formula = '';
      switch (d.type) {
        case 'percentOfBase':
          amount = KR(insurableBase * (Number(d.value) || 0) / 100);
          formula = `基数 × ${d.value}%`;
          break;
        case 'percentOfGross':
          amount = KR(gross * (Number(d.value) || 0) / 100);
          formula = `应发 × ${d.value}%`;
          break;
        case 'percentOfIncomeTax': {
          const raw = incomeTax * (Number(d.value) || 0) / 100;
          amount = (d.floorTo === 10 && st.localTaxFloor === true)
            ? Math.floor(raw / 10) * 10 : KR(raw);
          formula = `所得税 × ${d.value}%`;
          break;
        }
        case 'percentOfHealthIns':
          amount = KR(insurableBase * (Number(d.value) || 0) / 100);
          formula = `保险基数 × ${d.value}%`;
          break;
        case 'koreanTax':
          amount = incomeTax;
          formula = (st.taxMode || 'manual') === 'manual'
            ? '采用工资条税额' : '累进6级估算';
          break;
        default:
          amount = KR(d.value); formula = '고정액 固定额';
      }
      return { ...d, amount, formula };
    });
    return { deductions, deductTotal: deductions.reduce((s, d) => s + d.amount, 0) };
  }

  /**
   * 月度计算：工资条口径（前月 / 已归档月份）
   * 기본급 按月薪计薪工时固定，加班按实际工时，便于逐笔核对工资条
   */
  function calcMonthSlip(year, month, opts = {}) {
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
      } else if (a.type === 'perDay') {
        amount = KR((Number(a.value) || 0) * workDays);
        formula = `${Number(a.value).toLocaleString()}원 × ${workDays}일`;
      } else {
        amount = KR(a.value); formula = '고정액 固定额';
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
    const { deductions, deductTotal } = buildDeductions(st, insurableBase, incomeTax, gross);

    return {
      mode: 'slip',
      gross, net: gross - deductTotal, grossItems, deductions, deductTotal,
      insurableBase, incomeTax, bonusPay, otPay,
      basePay, stdHours, perf,
      workDays, restDays, leaveDays: 0, annualDays: 0,
      nightDays: 0, holidayWorkDays: 0, otDays: 0, extraOtHours: 0,
      workHours, otHours, nightHours, dayList,
      taxIsFixed: (st.taxMode || 'manual') === 'manual',
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
    distance, nightOverlapHours, calcDay, calcDayPay,
    calcMonth, calcMonthSlip, calcMonthAttendance, payrollModeFor,
    calcTax, calcKoreanTax,
    judgeDay, statusFromSegments, monthGrid, monthStatusStats, STATUS,
    isHoliday, holidayInfo, isWeeklyRest, shiftWindowFor, shiftBoundary,
    monthlyStandardHours, weeklyBase, taxableIncome, isoDate, fmtHM,
    payDateFor, severance, parseHireDate, num
  };
})();