/* ========== 数据层：localStorage 存取与默认值 ==========
   计薪口径对齐韩国月薪制 + 周工时制工资条：
     시급(时薪) × 법정월소정근로시간(法定月工时209h) = 월급(月薪)
     주수(周薪) = 시급 × 주당근로시간(每周40h)
   加班按 법정근로수입여 = 시급 × 1.5 计算                      */
const Store = (() => {
  const KEY = 'salary_keeper_v1';

  const DEFAULTS = {
    // ===== 员工档案（按 2026-09 工资条）=====
    profile: {
      empNo: '0581',        // 사번
      name: '이형화',        // 성명
      dept: '성형부',        // 부서
      jobTitle: '',         // 직급
      hireDate: '2022/06/01', // 입사일
      payDay: 16// 급여일（每月16日发薪）
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

      // 夜班时段（用于统计 야간근로시간）
      nightStart: '22:00',
      nightEnd: '06:00',

      // 地理围栏
      fence: { lat: 0, lng: 0, radius: 200, name: '公司' },
      autoPunch: true,
      punchConfirmCount: 2,      // 连续 N 次在圈内才自动签到（防 GPS 漂移）
      autoSyncOnOpen: true,      // 打开即校准
      lastSync: null,
      issues: [],
      reentryGuard: 30,
    },
    attendance: {},   // { 'YYYY-MM-DD': { shiftType, segments:[{in,out}], restMinutes, perf, isRestDay } }
    actualPaid: {},   // { 'YYYY-MM': amount }
    curMonthOffset: 0
  };

  let state = load();

  function load() {
    try {
      const raw = localStorage.getItem(KEY);
      if (!raw) return structuredClone(DEFAULTS);
      const parsed = JSON.parse(raw);
      const s = structuredClone(DEFAULTS);
      // 合并默认值，兼容旧数据（旧版无 profile / allowances）
      s.profile = Object.assign(s.profile, parsed.profile || {});
      s.settings = Object.assign(s.settings, parsed.settings || {});
      s.settings.fence = Object.assign(DEFAULTS.settings.fence, (parsed.settings || {}).fence || {});
      if (parsed.settings?.issues) s.settings.issues = parsed.settings.issues;
      s.attendance = parsed.attendance || {};
      s.actualPaid = parsed.actualPaid || {};
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

    save,

    /** 覆盖某月考勤（键形如 'YYYY-MM'），用于按工资条导入/校准 */
    replaceMonth(monthKey, records) {
      Object.keys(state.attendance).forEach(k => {
        if (k.startsWith(monthKey + '-')) delete state.attendance[k];
      });
      Object.assign(state.attendance, records);
      save();
    },

    /** 获取/新建某日考勤记录 */
    day(dateStr) {
      if (!state.attendance[dateStr]) {
        state.attendance[dateStr] = {
          shiftType: 'day',
          segments: [],
          restMinutes: 60,
          perf: 1.0,
          isRestDay: false
        };
      }
      return state.attendance[dateStr];
    },

    /** 正在打卡中的 segment（out 为 null） */
    activeSegment(rec) {
      return rec.segments.find(sg => sg.out === null) || null;
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
