/* ========== 韩国法定节假日（공휴일 / 대체공휴일 / 임시공휴일） ==========
   数据来源：관공서의 공휴일에 관한 규정（公务机关假日规定）+ 各年度国务会议公告
   包含 설날·추석 三连休的前后日，以及「假日逢周末 → 次一工作日」的 대체공휴일。
   覆盖 2025–2027。跨出此范围的年份返回空表，可在设置里自行补录。

   注意：근로자의 날(5/1) 属 근로기준법 上的有薪休日，工厂实际是否放假以公司为准，
   默认纳入但可在设置中关闭。
================================================================= */
const KR_HOLIDAYS = (() => {
  // [MM-DD, 한국어명, 中文名, 类型]
  // 类型：public=法定公休日 / sub=代替休日(补休) / temp=临时公休 / election=选举日 / labour=劳动节
  const DATA = {
    '2025': [
      ['01-01', '신정', '元旦', 'public'],
      ['01-27', '임시공휴일', '临时公休', 'temp'],
      ['01-28', '설날 연휴', '春节前日', 'public'],
      ['01-29', '설날', '春节', 'public'],
      ['01-30', '설날 연휴', '春节次日', 'public'],
      ['03-01', '삼일절', '三一节', 'public'],
      ['03-03', '대체공휴일', '补休', 'sub'],
      ['05-01', '근로자의 날', '劳动节', 'labour'],
      ['05-05', '어린이날·석가탄신일', '儿童节·佛诞日', 'public'],
      ['05-06', '대체공휴일', '补休', 'sub'],
      ['06-03', '대통령선거일', '总统选举日', 'election'],
      ['06-06', '현충일', '显忠日', 'public'],
      ['08-15', '광복절', '光复节', 'public'],
      ['10-03', '개천절', '开天节', 'public'],
      ['10-05', '추석 연휴', '中秋前日', 'public'],
      ['10-06', '추석', '中秋', 'public'],
      ['10-07', '추석 연휴', '中秋次日', 'public'],
      ['10-08', '대체공휴일', '补休', 'sub'],
      ['10-09', '한글날', '韩文节', 'public'],
      ['12-25', '기독탄신일', '圣诞节', 'public']
    ],
    '2026': [
      ['01-01', '신정', '元旦', 'public'],
      ['02-16', '설날 연휴', '春节前日', 'public'],
      ['02-17', '설날', '春节', 'public'],
      ['02-18', '설날 연휴', '春节次日', 'public'],
      ['03-01', '삼일절', '三一节', 'public'],
      ['03-02', '대체공휴일', '补休', 'sub'],
      ['05-01', '근로자의 날', '劳动节', 'labour'],
      ['05-05', '어린이날', '儿童节', 'public'],
      ['05-24', '석가탄신일', '佛诞日', 'public'],
      ['05-25', '대체공휴일', '补休', 'sub'],
      ['06-03', '지방선거일', '地方选举日', 'election'],
      ['06-06', '현충일', '显忠日', 'public'],
      ['07-17', '제헌절', '制宪节', 'public'],
      ['08-15', '광복절', '光复节', 'public'],
      ['08-17', '대체공휴일', '补休', 'sub'],
      ['09-24', '추석 연휴', '中秋前日', 'public'],
      ['09-25', '추석', '中秋', 'public'],
      ['09-26', '추석 연휴', '中秋次日', 'public'],
      ['10-03', '개천절', '开天节', 'public'],
      ['10-05', '대체공휴일', '补休', 'sub'],
      ['10-09', '한글날', '韩文节', 'public'],
      ['12-25', '기독탄신일', '圣诞节', 'public']
    ],
    '2027': [
      ['01-01', '신정', '元旦', 'public'],
      ['02-06', '설날 연휴', '春节前日', 'public'],
      ['02-07', '설날', '春节', 'public'],
      ['02-08', '설날 연휴', '春节次日', 'public'],
      ['02-09', '대체공휴일', '补休', 'sub'],
      ['03-01', '삼일절', '三一节', 'public'],
      ['05-01', '근로자의 날', '劳动节', 'labour'],
      ['05-03', '대체공휴일', '补休', 'sub'],
      ['05-05', '어린이날', '儿童节', 'public'],
      ['05-13', '석가탄신일', '佛诞日', 'public'],
      ['06-06', '현충일', '显忠日', 'public'],
      ['07-17', '제헌절', '制宪节', 'public'],
      ['07-19', '대체공휴일', '补休', 'sub'],
      ['08-15', '광복절', '光复节', 'public'],
      ['08-16', '대체공휴일', '补休', 'sub'],
      ['09-14', '추석 연휴', '中秋前日', 'public'],
      ['09-15', '추석', '中秋', 'public'],
      ['09-16', '추석 연휴', '中秋次日', 'public'],
      ['10-03', '개천절', '开天节', 'public'],
      ['10-04', '대체공휴일', '补休', 'sub'],
      ['10-09', '한글날', '韩文节', 'public'],
      ['10-11', '대체공휴일', '补休', 'sub'],
      ['12-25', '기독탄신일', '圣诞节', 'public'],
      ['12-27', '대체공휴일', '补休', 'sub']
    ]
  };

  const TYPE_LABEL = {
    public: '공휴일', sub: '대체공휴일', temp: '임시공휴일',
    election: '선거일', labour: '근로자의 날', custom: '사용자지정'
  };

  /**
   * 查某日是否法定节假日
   * @param {string} dateStr 'YYYY-MM-DD'
   * @param {object} opts { includeLabour:boolean, custom:string[] }
   * @returns {null | {name, cn, type, typeLabel}}
   */
  function get(dateStr, opts = {}) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(dateStr))) return null;
    const year = dateStr.slice(0, 4);
    const md = dateStr.slice(5);
    const hit = (DATA[year] || []).find(x => x[0] === md);
    if (hit) {
      if (hit[3] === 'labour' && opts.includeLabour === false) return null;
      return { name: hit[1], cn: hit[2], type: hit[3], typeLabel: TYPE_LABEL[hit[3]] || hit[3] };
    }
    // 用户自定义（设置里手动补录的日期）
    if (Array.isArray(opts.custom) && opts.custom.includes(dateStr)) {
      return { name: '공휴일', cn: '法定节假日', type: 'custom', typeLabel: TYPE_LABEL.custom };
    }
    return null;
  }

  /** 列出某年的全部假日（'YYYY-MM-DD' → 信息） */
  function list(year, opts = {}) {
    const out = {};
    (DATA[String(year)] || []).forEach(([md, name, cn, type]) => {
      if (type === 'labour' && opts.includeLabour === false) return;
      out[`${year}-${md}`] = { name, cn, type, typeLabel: TYPE_LABEL[type] || type };
    });
    if (Array.isArray(opts.custom)) {
      opts.custom.filter(d => d.startsWith(String(year))).forEach(d => {
        out[d] = { name: '공휴일', cn: '法定节假日', type: 'custom', typeLabel: TYPE_LABEL.custom };
      });
    }
    return out;
  }

  /** 某月有多少个法定假日 */
  function countInMonth(year, month, opts = {}) {
    const pre = `${year}-${String(month).padStart(2, '0')}-`;
    return Object.keys(list(year, opts)).filter(d => d.startsWith(pre)).length;
  }

  return { get, list, countInMonth, years: Object.keys(DATA), TYPE_LABEL };
})();
