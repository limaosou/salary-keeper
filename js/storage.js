/* ========== 数据层：localStorage 存取与默认值 ========== */
const Store = (() => {
  const KEY = 'salary_keeper_v1';

  const DEFAULTS = {
    settings: {
      currency: '¥',
      hourlyRate: 25,
      standardHours: 8,
      overtimeMultiplier: 1.5,
      // 夜班
      nightStart: '22:00',
      nightEnd: '06:00',
      nightMode: 'perHour',      // perHour | fixed
      nightAmount: 10,           // 元/小时 或 元/班
      // 绩效
      perfMode: 'daily',         // daily | monthly
      perfMonthly: 1.0,
      // 地理围栏
      fence: { lat: 0, lng: 0, radius: 200, name: '公司' },
      autoPunch: true,
      punchConfirmCount: 2,      // 连续 N 次在圈内才自动签到（防 GPS 漂移）
      // 扣除项
      deductions: [
        { id: 'd1', name: '健康保险费', type: 'percent', value: 3 },
        { id: 'd2', name: '养老保险费', type: 'percent', value: 8 },
        { id: 'd3', name: '个人所得税', type: 'tax', value: 0 }
      ],
      taxBrackets: [
        { min: 0,     max: 5000,  rate: 0 },
        { min: 5000,  max: 12000, rate: 0.10 },
        { min: 12000, max: 25000, rate: 0.20 },
        { min: 25000, max: 35000, rate: 0.25 },
        { min: 35000, max: 55000, rate: 0.30 },
        { min: 55000, max: 80000, rate: 0.35 },
        { min: 80000, max: null,  rate: 0.45 }
      ]
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
      // 合并默认值，兼容旧数据
      const s = structuredClone(DEFAULTS);
      s.settings = Object.assign(s.settings, parsed.settings || {});
      s.settings.fence = Object.assign(DEFAULTS.settings.fence, (parsed.settings || {}).fence || {});
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

    save,

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
      s.settings = Object.assign(s.settings, data.settings || {});
      s.settings.fence = Object.assign(DEFAULTS.settings.fence, (data.settings || {}).fence || {});
      s.attendance = data.attendance || {};
      state = s;
      save();
    },

    exportJSON() {
      return JSON.stringify({ app: '工资通', version: 1, exportedAt: new Date().toISOString(), ...state }, null, 2);
    }
  };
})();
