/* ========== 数据层：localStorage 存取与默认值 ==========
   计薪口径对齐韩国月薪制 + 周工时制工资条：
     시급(时薪) × 법정월소정근로시간(法定月工时209h) = 월급(月薪)
     주수(周薪) = 시급 × 주당근로시간(每周40h)
   加班按 법정근로수입여 = 시급 × 1.5 计算                      */
const Store = (() => {
  const KEY = 'salary_keeper_v1';

  const DEFAULTS = {
    // ===== 员工档案（按 2026-09 工资条；可在设置页随意修改）=====
    profile: {
      empNo: '0581',           // 사번
      name: '이형화',           // 성명
      dept: '성형부',           // 부서
      jobTitle: '',            // 직급
      position: '',            // 직위（备用）
      hireDate: '2022/06/01',  // 입사일（退职金按此计算工龄）
      payDay: 17               // 급여일：每月 17 日，逢周末提前至周五
    },

    settings: {
      currency: '₩',
      // ===== 韩国月薪制核心参数（按实测工资条反推）=====
      hourlyRate: 10470,         // 시급 时薪 (KRW)
      weeklyHours: 40,           // 주당법정근로시간 每周法定工时
      monthlyHoursMode: 'fixed', // fixed(按签约工时) | auto(40×52/12) | custom(手填)
      monthlyHours: 176,         // 월급여시간 月薪计薪工时（= 기본급 ÷ 시급）
      monthlyHoursCustom: 176,
      weeklyDays: 4,             // 주당일수 每周工作天数（주수 = 일수 × 일근로 × 시급）
      dailyHours: 8,             // 일근로시간 每日工时
      overtimeMultiplier: 1.5,   // 법정근로수입여 = 시급 × 1.5
      bonusMultiplier: 0.5,      // 상여수당 = 시급 × 0.5
      perfMode: 'monthly',       // daily | monthly
      perfMonthly: 1.0,          // 평가계수 绩效系数

      // 所得税：manual=直接采用工资条实际税额（核对优先）；auto=按6级累进估算
      taxMode: 'manual',
      taxManualAmount: 119880,   // 2026-09 工资条소득세
      // 地方所得税取整方式：true=向下取整到10位（韩国实务，与工资条一致）
      localTaxFloor: true,

      // 津贴补贴（对应工资条지급내역）
      allowances: [
        { id: 'a1', name: '기업급여(주수)', nameCn: '周薪', value: 0, type: 'formulaWeekly', enabled: true },
        { id: 'a2', name: '현장근로수당', nameCn: '现场劳动补贴(加班)', value: 0, type: 'formulaOT', enabled: true },
        { id: 'a3', name: '실액수당', nameCn: '实物补贴', value: 366450, type: 'fixed', enabled: true },
        { id: 'a4', name: '직무개발비', nameCn: '职务开发费', value: 192000, type: 'fixed', enabled: true }
      ],

      // 扣除项：社保 + 税（比例按实测工资条反推，基数 = 기본급 + 실액수당 = 2,209,170）
      deductions: [
        { id: 'd1', name: '국민건강보험', nameCn: '国民健康保险', type: 'percentOfBase', value: 7.379242, enabled: true, note: '2,209,170 × 7.379242% = 163,020' },
        { id: 'd2', name: '장기보험', nameCn: '长期保险(养老)', type: 'percentOfBase', value: 5.620663, enabled: true, note: '2,209,170 × 5.620663% = 124,170' },
        { id: 'd3', name: '고용보험', nameCn: '雇佣保险', type: 'percentOfBase', value: 1.406863, enabled: true, note: '2,209,170 × 1.406863% = 31,080' },
        { id: 'd4', name: '기수사회', nameCn: '技法社会(公司分担)', type: 'fixed', value: 50000, enabled: true, note: '固定 50,000' },
        { id: 'd5', name: '장기요금보험료', nameCn: '长期保费', type: 'percentOfBase', value: 0.738286, enabled: true, note: '2,209,170 × 0.738286% = 16,310' },
        { id: 'd6', name: '소득세', nameCn: '所得税', type: 'koreanTax', value: 0, enabled: true, note: '默认采用工资条实发税额 119,880' },
        { id: 'd7', name: '지방소득세', nameCn: '地方所得税', type: 'percentOfIncomeTax', value: 10, floorTo: 10, enabled: true, note: '所得税×10%，十位向下取整 = 11,980' }
      ],

      // 韩国所得税 6 段累进表（ taxable income 韩元, rate, localRate ）
      taxBrackets: [
        { min: 0,        max: 1200000,   rate: 0.06, localRate: 0.10 },
        { min: 1200000,  max: 4600000,   rate: 0.15, localRate: 0.10 },
        { min: 4600000,  max: 9200000,   rate: 0.19, localRate: 0.10 },
        { min: 9200000,  max: 15000000,  rate: 0.20, localRate: 0.10 },
        { min: 15000000, max: 30000000,  rate: 0.30, localRate: 0.10 },
        { min: 30000000, max: null,      rate: 0.45, localRate: 0.10 }
      ],

      // ===== 班次时间（白班 / 夜班）=====
      // 白班 08:20–20:20；夜班 20:20–次日 08:20（正好相反）
      // 周上 5 天时：白班周一晚 2 小时上班（10:20）；夜班周五早 2 小时下班（06:20）
      shift: {
        dayStart: '08:20',       // 백근 출근
        dayEnd: '20:20',         // 백근 퇴근
        nightStart: '20:20',     // 야근 출근
        nightEnd: '08:20',       // 야근 퇴근（次日）
        weeklyWorkDays: 5,       // 주당 근무일수
        monLateStart: true,      // 白班周一晚 2 小时上班
        monDayStart: '10:20',
        friEarlyEnd: true,       // 夜班周五早 2 小时下班
        friNightEnd: '06:20'
      },

      // ===== 日薪结构：标准 8h + 固定加班 3.5h(×1.5)；夜班再加 3.5h 夜班补助 =====
      dailyPay: {
        stdHours: 8,             // 기준근로 标准工时
        fixedOtHours: 3.5,       // 고정연장근로 每日固定加班
        nightAllowHours: 3.5,    // 야간수당 지급시간 夜班补助计发小时
        nightAllowRate: 0.5,     // 야간수당 가산율（韩国法定 +50%）
        holidayMultiplier: 1.5,  // 휴일근로 节假日出勤全天倍率
        annualLeavePaid: true    // 연차 年假是否带薪（按标准工时计）
      },

      // ===== 出勤判定规则（迟到/早退/请假，供月历状态用）=====
      workStart: '08:20',        // 표준출근 标准上班时间
      workEnd: '20:20',          // 표준퇴근 标准下班时间
      lateGrace: 5,              // 지각허용 迟到宽限（分钟）
      earlyGrace: 5,             // 조퇴허용 早退宽限（分钟）
      restWeekdays: [0],         // 주휴일 每周休息日（0=周日）
      holidays: [],              // 공휴일 自定义节假日 ['2026-10-01', ...]
      holidaySource: 'builtin',  // builtin=内置韩国法定假日 | custom=仅自定义 | both=两者
      includeLabourDay: true,    // 是否把 근로자의 날(5/1) 计入假日

      // 夜班时段（법정 야간근로 22:00–06:00，用于统计 야간근로시간）
      nightStart: '22:00',
      nightEnd: '06:00',

      // 每日休息扣除时间（分钟）
      restMinutes: 30,

      // 地理围栏
      fence: { lat: 0, lng: 0, radius: 200, name: '公司' },
      autoPunch: true,
      punchConfirmCount: 2,      // 连续 N 次在圈内才自动签到（防 GPS 漂移）
      autoSyncOnOpen: true,      // 打开即校准
      lastSync: null,
      issues: [],
      reentryGuard: 30
    },
    attendance: {},   // { 'YYYY-MM-DD': { shiftType, segments:[{in,out}], restMinutes, perf, isRestDay } }
    actualPaid: {},   // { 'YYYY-MM': amount } 工资条实发（核对用）
    payslips: {},     // { 'YYYY-MM': {gross, deduct, net, at} } 已归档的工资条固定值
    curMonthOffset: 0
  };

  let state = load();

  // 只读取某日记录：不存在返回 null，**不会创建**
  // 月历要遍历整月每一天，若用 day() 会把空日期也落成记录，污染数据
  /**
   * 获取/新建某日考勤记录。
   * 注意：这个函数会**创建**记录，查询场景请一律用 peek()，
   * 否则遍历整月会把空日期也落成记录，污染数据。
   */
  const day = dateStr => {
    if (!state.attendance[dateStr]) {
      state.attendance[dateStr] = {
        shiftType: 'day',
        segments: [],
        restMinutes: (state.settings && state.settings.restMinutes != null)
          ? state.settings.restMinutes : 30,
        perf: 1.0,
        isRestDay: false,
        leave: null,     // { type, note } 请假
        makeups: []      // [{ id, type:'in'|'out', time, note, at }] 补签留痕
      };
    }
    const rec = state.attendance[dateStr];
    // 兜底：兼容没有这些字段的历史数据
    if (rec.leave === undefined) rec.leave = null;
    if (rec.adjust === undefined) rec.adjust = null;
    if (!Array.isArray(rec.makeups)) rec.makeups = [];
    if (!Array.isArray(rec.segments)) rec.segments = [];
    return rec;
  };

  const peek = dateStr => state.attendance[dateStr] || null;

  /** 某日是否已有落地的数据（有记录 / 请假 / 补签 / 标休息） */
  const hasAnyRecord = dateStr => {
    const rec = state.attendance[dateStr];
    if (!rec) return false;
    return rec.segments.length > 0 || !!rec.leave
      || !!rec.isRestDay || (rec.makeups && rec.makeups.length > 0);
  };

  /** 写入请假（연차/병가/경조사/기타） */
  const setLeave = (dateStr, { type = '연차', note = '' } = {}) => {
    const rec = day(dateStr);
    rec.leave = { type: String(type).slice(0, 20), note: String(note).slice(0, 100) };
    save();
    return true;
  };

  /** 取消请假 */
  const clearLeave = dateStr => {
    const rec = state.attendance[dateStr];
    if (!rec || !rec.leave) return false;
    rec.leave = null;
    save();
    return true;
  };

  /**
   * 手工补签：带合法性校验，返回 { ok, msg }
   * 校验点：日期合法 / 非未来 / 时间落在当日 / 不超前于此刻 / 不重复签到 / 签退须晚于签到
   */
  const addMakeup = (dateStr, { type, time, note = '', now = new Date() } = {}) => {
    if (!dateStr || !/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) return { ok: false, msg: '日期格式不正确' };
    if (type !== 'in' && type !== 'out') return { ok: false, msg: '补签类型须为签到或签退' };

    const dayStart = new Date(`${dateStr}T00:00:00`);
    if (Number.isNaN(dayStart.getTime())) return { ok: false, msg: '日期无效' };
    if (dayStart.getTime() > now.getTime()) return { ok: false, msg: '不能为未来日期补签' };

    const timeMs = new Date(time).getTime();
    if (Number.isNaN(timeMs)) return { ok: false, msg: '补签时间无效' };
    const dayEnd = new Date(`${dateStr}T23:59:59`).getTime();
    if (timeMs < dayStart.getTime() || timeMs > dayEnd) {
      return { ok: false, msg: '补签时间须在当日 00:00–23:59 之间' };
    }
    if (timeMs > now.getTime()) return { ok: false, msg: '补签时间不能超过当前时刻' };

    const rec = day(dateStr);
    const segs = rec.segments.filter(sg => sg.in);

    if (type === 'in') {
      if (segs.length > 0) return { ok: false, msg: '当日已有签到记录，无需补签到' };
      rec.segments.push({ in: new Date(timeMs).toISOString(), out: null, makeup: true, src: 'manual' });
    } else {
      const open = rec.segments.find(sg => sg.out === null) || null;
      if (!open) return { ok: false, msg: '当日没有未签退的签到，无法补签退' };
      const inMs = new Date(open.in).getTime();
      if (timeMs <= inMs) return { ok: false, msg: '签退时间须晚于签到时间' };
      open.out = new Date(timeMs).toISOString();
      open.makeup = true;
      open.src = 'manual';
    }

    rec.makeups.push({
      id: 'mk' + now.getTime().toString(36) + Math.random().toString(36).slice(2, 6),
      type,
      time: new Date(timeMs).toISOString(),
      note: String(note).slice(0, 100),
      at: now.toISOString()
    });
    save();
    return { ok: true, msg: type === 'in' ? '补签到成功' : '补签退成功' };
  };

  /** 撤销一条补签，并回滚它产生的打卡数据（补签必须是可撤销的） */
  const removeMakeup = (dateStr, id) => {
    const rec = state.attendance[dateStr];
    if (!rec || !Array.isArray(rec.makeups)) return { ok: false, msg: '记录不存在' };
    const idx = rec.makeups.findIndex(m => m.id === id);
    if (idx < 0) return { ok: false, msg: '补签记录不存在' };

    const mk = rec.makeups[idx];
    const mkMs = new Date(mk.time).getTime();
    if (mk.type === 'in') {
      rec.segments = rec.segments.filter(sg => new Date(sg.in).getTime() !== mkMs);
    } else {
      rec.segments.forEach(sg => { if (sg.out && new Date(sg.out).getTime() === mkMs) sg.out = null; });
    }
    rec.makeups.splice(idx, 1);
    save();
    return { ok: true, msg: '已撤销该补签' };
  };

  /**
   * 登记当日「特殊情况」扣减：迟到 / 早退分钟数 + 说明
   * 手动签到/补签默认视同按时出勤；真有偏差（如上午外出 2 小时）时在这里登记，
   * 工时按「班次时间 − 登记分钟」扣减，月历同步标记迟到/早退。
   */
  const setAdjust = (dateStr, { lateMin = 0, earlyMin = 0, note = '' } = {}) => {
    const rec = day(dateStr);
    const late = Math.max(0, Math.min(600, Math.round(Number(lateMin) || 0)));
    const early = Math.max(0, Math.min(600, Math.round(Number(earlyMin) || 0)));
    const txt = String(note || '').slice(0, 100);
    if (!late && !early && !txt) { rec.adjust = null; save(); return { ok: true, msg: '已清除扣减登记' }; }
    rec.adjust = { lateMin: late, earlyMin: early, note: txt, at: new Date().toISOString() };
    save();
    return { ok: true, msg: (late || early) ? `已登记扣减：迟到 ${late} 分 / 早退 ${early} 分` : '已保存说明' };
  };

  /** 读取当日扣减登记 */
  const getAdjust = dateStr => {
    const rec = state.attendance[dateStr];
    return (rec && rec.adjust) || null;
  };

  function load() {
    try {
      const raw = localStorage.getItem(KEY);
      if (!raw) return structuredClone(DEFAULTS);
      const parsed = JSON.parse(raw);
      const s = structuredClone(DEFAULTS);
      // 合并默认值，兼容旧数据（旧版无 profile / allowances）
      s.profile = Object.assign(s.profile, parsed.profile || {});
      s.settings = Object.assign(s.settings, parsed.settings || {});
      // 嵌套对象也要合并，否则老数据升级后会丢掉新增的子字段
      // 用户本地可能还留着旧的 cloud 字段，读进来直接忽略即可
      ['fence', 'shift', 'dailyPay'].forEach(k => {
s.settings[k] = Object.assign(DEFAULTS.settings[k], (parsed.settings || {})[k] || {});
      });
      if (parsed.settings && parsed.settings.cloud) delete s.settings.cloud;
      // 数组类配置：以存量数据为准（用户可能已增删），缺省才回落到默认
      ['allowances', 'deductions', 'taxBrackets', 'restWeekdays', 'holidays'].forEach(k => {
        const v = (parsed.settings || {})[k];
        if (Array.isArray(v)) s.settings[k] = v;
      });
      if (parsed.settings?.issues) s.settings.issues = parsed.settings.issues;
      s.attendance = parsed.attendance || {};
      s.actualPaid = parsed.actualPaid || {};
      s.payslips = parsed.payslips || {};
      return s;
    } catch (e) {
      console.error('读取本地数据失败', e);
      return structuredClone(DEFAULTS);
    }
  }

  function save() {
    try {
      localStorage.setItem(KEY, JSON.stringify(state));
      return true;
    } catch (e) {
      console.error('保存失败', e);
      return false;
    }
  }

  return {
    get settings() { return state.settings; },
    get attendance() { return state.attendance; },
    get profile() { return state.profile; },
    get actualPaid() { return state.actualPaid; },
    get payslips() { return state.payslips; },

    save,
    day,
    peek,
    hasAnyRecord,

    /* ---------- 工资条归档（前月固定值） ---------- */
    /** 归档某月工资条固定值；传 null 表示取消归档 */
    setPayslip(monthKey, data) {
      if (!data) { delete state.payslips[monthKey]; }
      else {
        state.payslips[monthKey] = {
          gross: Math.round(Number(data.gross) || 0),
          deduct: Math.round(Number(data.deduct) || 0),
          net: Math.round(Number(data.net) || 0),
          items: Array.isArray(data.items) ? data.items : [],
          at: new Date().toISOString()
        };
      }
      save();
    },

    getPayslip(monthKey) { return state.payslips[monthKey] || null; },

    /** 覆盖某月考勤（键形如 'YYYY-MM'），用于按工资条导入/校准 */
    replaceMonth(monthKey, records) {
      Object.keys(state.attendance).forEach(k => {
        if (k.startsWith(monthKey + '-')) delete state.attendance[k];
      });
      Object.assign(state.attendance, records);
      save();
    },

    setLeave,
    clearLeave,
    addMakeup,
    removeMakeup,
    setAdjust,
    getAdjust,

    /** 正在打卡中的 segment（out 为 null） */
    activeSegment(rec) {
      return (rec && rec.segments.find(sg => sg.out === null)) || null;
    },

    reset() {
      state = structuredClone(DEFAULTS);
      save();
    },

    /** 导入备份：整体覆盖本机数据（先合并默认值保证字段完整） */
    importData(data) {
      const s = structuredClone(DEFAULTS);
      s.profile = Object.assign(s.profile, data.profile || {});
      s.settings = Object.assign(s.settings, data.settings || {});
      s.settings.fence = Object.assign(DEFAULTS.settings.fence, (data.settings || {}).fence || {});
      s.attendance = data.attendance || {};
      s.actualPaid = data.actualPaid || {};
      s.payslips = data.payslips || {};
      state = s;
      save();
    },

    /** 载入工资条档案（从模板或备份中恢复员工信息与津贴/扣除配置） */
    applyProfile(patch) {
      if (patch.profile) state.profile = Object.assign(state.profile, patch.profile);
      if (patch.settings) {
        if (patch.settings.allowances) state.settings.allowances = patch.settings.allowances;
        if (patch.settings.deductions) state.settings.deductions = patch.settings.deductions;
        const keep = ['hourlyRate', 'weeklyHours', 'overtimeMultiplier', 'bonusMultiplier',
          'perfMode', 'perfMonthly', 'taxBrackets', 'currency'];
        keep.forEach(k => { if (patch.settings[k] != null) state.settings[k] = patch.settings[k]; });
      }
      save();
    },

    exportJSON() {
      return JSON.stringify({ app: '工资通', version: 1, exportedAt: new Date().toISOString(), ...state }, null, 2);
    }
  };
})();
