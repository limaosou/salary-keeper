/* ========== 主逻辑：页面渲染与交互 ========== */
(() => {
  const $ = id => document.getElementById(id);
  const st = () => Store.settings;
  const todayStr = () => Salary.isoDate(new Date());
  const cur = () => Salary.isoDate(new Date()).slice(0, 7);
  let salMonth = cur();
  let tickTimer = null;

  /* ---------- 通用 ---------- */
  function toast(msg, ms = 2200) {
    const t = $('toast');
    t.textContent = msg; t.hidden = false;
    clearTimeout(t._timer);
    t._timer = setTimeout(() => t.hidden = true, ms);
  }

  const money = n => Number(n || 0).toFixed(2);
  const curSym = () => st().currency || '¥';
  const M = n => curSym() + money(n);   // 带货币符号

  /* ---------- 打卡动作 ---------- */
  function punchIn(auto = false, reason = '') {
    const ds = todayStr();
    const rec = Store.day(ds);
    if (Store.activeSegment(rec)) { toast('当前已在打卡中'); return false; }
    rec.segments.push({ in: new Date().toISOString(), out: null, auto, reason });
    rec.isRestDay = false;
    Store.save();
    refreshToday();
    toast(auto ? '📍 已进入公司区域，自动签到' : '✅ 已签到');
    return true;
  }

  function punchOut(auto = false, reason = '') {
    const ds = todayStr();
    const rec = Store.attendance[ds];
    const seg = rec && Store.activeSegment(rec);
    if (!seg) { toast('当前未在打卡中'); return false; }
    seg.out = new Date().toISOString();
    seg.outReason = reason;
    Store.save();
    refreshToday();
    const r = Salary.calcDay(rec, ds, { nowForOpen: new Date() });
    const s = st();
    const kr = n => Math.round(Number(n) || 0).toLocaleString('ko-KR');
    const dayPay = r.workHours * s.hourlyRate + r.otHours * s.hourlyRate * s.overtimeMultiplier;
    toast(auto
      ? `\u{1F4CD} 已离开公司区域，自动签退 · 今日 ${r.workHours.toFixed(1)}h · ${kr(dayPay)}원`
      : `✅ 已签退 · 今日 ${r.workHours.toFixed(1)}h · ${kr(dayPay)}원`);
    return true;
  }

  function logIssue(text) {
    st().issues.unshift({ at: new Date().toISOString(), text });
    st().issues = st().issues.slice(0, 30);      // 只留最近 30 条
    Store.save();
  }

  /* ---------- 打开即校准：不依赖页面常驻，一次定位对齐状态 ----------
     适用场景：iOS 锁屏会冻结网页，故改用「快捷指令自动化 → 到达/离开公司
     时打开本页」的方式，由系统负责唤起，本页取一次定位就把状态对齐。 */
  let syncing = false;

  function syncState(trigger = 'open') {
    if (syncing) return Promise.resolve(null);
    syncing = true;
    return GeoPunch.checkOnce().then(res => {
      const s = st();
      s.lastSync = { at: new Date().toISOString(), dist: Math.round(res.dist), inside: res.inside };
      Store.save();

      const ds = todayStr();
      const rec = Store.attendance[ds];
      const active = rec && Store.activeSegment(rec);
      let acted = null;

      if (res.inside) {
        if (!active) {
          // 防抖：刚签退（离场）后短时间内不重签，避免围栏边缘抖动反复打卡
          const guard = (s.reentryGuard || 0) * 60000;
          const last = rec && rec.segments[rec.segments.length - 1];
          const recentlyLeft = last && last.out && last.outReason === 'leave'
            && (Date.now() - new Date(last.out).getTime()) < guard;
          if (!recentlyLeft) acted = punchIn(true, 'auto-sync-in') ? 'in' : null;
        } else {
          acted = null;   // 已在打卡中，无需动作
        }
      } else {
        if (active) acted = punchOut(true, 'leave') ? 'out' : null;
      }

      renderSyncStatus(res, acted, trigger);
      return { res, acted };
    }).catch(err => {
      const msg = err.code === 1 ? '定位权限被拒绝'
        : err.code === 'nofence' ? '尚未配置公司坐标'
        : err.code === 3 ? '定位超时' : (err.message || '定位失败');
      $('sync-status').innerHTML = `<span class="sync-dot bad"></span>⚠️ 校准失败：${msg}`;
      if (err.code === 1) logIssue('定位权限被拒绝，自动打卡无法执行');
      return null;
    }).finally(() => { syncing = false; });
  }

  function renderSyncStatus(res, acted, trigger) {
    const box = $('sync-status');
    if (!box) return;
    const d = Math.round(res.dist);
    let msg;
    if (acted === 'in') msg = `✅ ${res.inside ? '在公司内' : ''}已自动签到 · 距公司 ${d} 米`;
    else if (acted === 'out') msg = `📍 已离开公司区域，自动签退 · 距公司 ${d} 米`;
    else if (res.inside) msg = `🏢 在公司区域内（距 ${d} 米）· 当前打卡中`;
    else msg = `📍 当前位置在公司外（距 ${d} 米）`;
    box.innerHTML = `<span class="sync-dot ok"></span>${msg}<i>${new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}</i>`;
    if (acted) renderAttendance(), renderSalary();
  }

  /* ---------- 全自动打卡：快捷指令配置 ---------- */
  // 快捷指令要打开的地址：用当前站点 origin，兼容本地/线上
  function syncUrl() {
    return location.origin + location.pathname;
  }

  function renderSyncUrl() {
    const el = $('sync-url');
    if (el) el.textContent = syncUrl();
  }

  function renderIssues() {
    const box = $('issue-list');
    if (!box) return;
    const list = st().issues || [];
    box.innerHTML = list.length ? list.map(it => {
      const d = new Date(it.at);
      return `<div class="issue-item"><b>${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}</b><span>${it.text}</span></div>`;
    }).join('') : '<div class="att-empty">暂无异常记录 · 一切正常</div>';
  }

  /* ---------- 今日页 ---------- */
  function refreshToday() {
    const ds = todayStr();
    const rec = Store.attendance[ds];
    const active = rec && Store.activeSegment(rec);
    const r = Salary.calcDay(rec || { segments: [], restMinutes: 0, isRestDay: false }, ds, { nowForOpen: new Date() });
    const s = st();
    const kr = n => Math.round(Number(n) || 0).toLocaleString('ko-KR');

    // 月薪制下当日金额 = 基本工资折算时薪 × 工时 + 加班（时薪×倍率）
    const dailyBase = r.workHours * s.hourlyRate;
    const dailyOT = r.otHours * s.hourlyRate * s.overtimeMultiplier;

    $('today-earned').textContent = kr(dailyBase + dailyOT);
    $('today-currency').textContent = '₩';
    $('today-worked').textContent = Salary.fmtHM(r.workHours * 3600000);
    $('today-ot').textContent = Salary.fmtHM(r.otHours * 3600000);
    $('today-segments').textContent = r.segCount;

    // 状态文案
    if (!rec || !rec.segments.length) {
      $('today-status').textContent = '尚未打卡';
      $('punch-title').textContent = GeoPunch.running() ? '监听中 · 等待进入区域' : '地理围栏待机中';
      $('punch-desc').textContent = s.fence.lat ? '进入公司区域自动签到' : '请先到【设置】配置公司位置';
    } else if (active) {
      const t = new Date(active.in);
      $('today-status').textContent = `打卡中 · ${String(t.getHours()).padStart(2, '0')}:${String(t.getMinutes()).padStart(2, '0')} 起`;
      $('punch-title').textContent = '正在计时';
      $('punch-desc').textContent = '离开公司区域将自动签退';
    } else {
      $('today-status').textContent = '已结束当日考勤';
      $('punch-title').textContent = '今日已签退';
      $('punch-desc').textContent = '当日工时已定格';
    }

    // 打卡状态点
    const ps = $('punch-state');
    ps.className = 'punch-state ' + (active ? 'in' : 'out');
    $('btn-manual-in').disabled = !!active;
    $('btn-manual-out').disabled = !active;

    // 当日明细（时薪折算）
    $('d-base').textContent = kr(dailyBase);
    $('d-ot').textContent = kr(dailyOT);
    $('d-night').textContent = `${r.nightHours.toFixed(1)}h`;
    $('d-total').textContent = kr(dailyBase + dailyOT);
    $('d-ot-rate').textContent = s.overtimeMultiplier;

    // 休息分钟
    if (rec) $('rest-value').textContent = `${rec.restMinutes} 分钟`;
    $('shift-label').textContent = rec && rec.shiftType === 'night' ? '夜班' : '白班';
  }

  function bindToday() {
    $('btn-manual-in').onclick = () => punchIn(false);
    $('btn-manual-out').onclick = () => punchOut(false);

    $('btn-sync').onclick = () => {
      $('sync-status').innerHTML = '<span class="sync-dot"></span>正在校准位置…';
      syncState('manual');
    };

    $('shift-toggle').onclick = () => {
      const ds = todayStr();
      const rec = Store.day(ds);
      rec.shiftType = rec.shiftType === 'night' ? 'day' : 'night';
      Store.save(); refreshToday();
      toast(rec.shiftType === 'night' ? '🌙 已切换为夜班' : '☀️ 已切换为白班');
    };

    $('rest-minus').onclick = () => adjustRest(-15);
    $('rest-plus').onclick = () => adjustRest(15);

    $('auto-punch-switch').checked = st().autoPunch;
    $('auto-punch-switch').onchange = e => {
      st().autoPunch = e.target.checked; Store.save();
      e.target.checked ? GeoPunch.start() : GeoPunch.stop();
      toast(e.target.checked ? '自动打卡已开启' : '自动打卡已关闭');
    };
  }

  function adjustRest(delta) {
    const ds = todayStr();
    const rec = Store.day(ds);
    rec.restMinutes = Math.max(0, Math.min(480, rec.restMinutes + delta));
    Store.save(); refreshToday();
  }

  /* ---------- 考勤页 ---------- */
  let attMonth = cur();
  function renderAttendance() {
    const [y, m] = attMonth.split('-').map(Number);
    $('cur-month').textContent = attMonth;
    const sum = Salary.calcMonth(y, m);
    $('m-days').textContent = `${sum.workDays} 天`;
    $('m-hours').textContent = `${sum.workHours.toFixed(1)}h`;
    $('m-earn').textContent = money(sum.gross);

    const box = $('att-list');
    if (!sum.dayList.length) {
      box.innerHTML = '<div class="att-empty">本月暂无考勤记录</div>';
      return;
    }
    box.innerHTML = sum.dayList.map(({ dateStr, rec, r, rest }) => {
      const d = new Date(dateStr + 'T00:00:00');
      const wk = ['日', '一', '二', '三', '四', '五', '六'][d.getDay()];
      const open = !!Store.activeSegment(rec);
      const times = rec.segments.map(sg =>
        `${fmtTime(sg.in)}–${sg.out ? fmtTime(sg.out) : '未签退'}`).join('　');
      const krN = n => Math.round(Number(n) || 0).toLocaleString('ko-KR');
      const dayPay = (r.workHours || 0) * st().hourlyRate
        + (r.otHours || 0) * st().hourlyRate * st().overtimeMultiplier;
      const tag = rest ? '<span class="tag rest">休息日</span>'
        : `<span class="tag ${rec.shiftType}">${rec.shiftType === 'night' ? '夜班' : '白班'}</span>`;
      return `<div class="att-item" data-date="${dateStr}" data-open="${open}">
        <div class="att-date"><b>${d.getDate()}</b><i>周${wk}</i></div>
        <div class="att-info"><b>${times || '未打卡'}${tag}</b>
          <span>${rest ? '休息不计薪' : `工时 ${r.workHours.toFixed(1)}h · 加班 ${r.otHours.toFixed(1)}h${r.perf !== 1 ? ` · 绩效 ${r.perf}` : ''}`}${open ? ' · 点击补结算' : ''}</span></div>
        <div class="att-money">${rest ? '—' : krN(dayPay)}</div>
      </div>`;
    }).reverse().join('');

    // 往日有未签退记录时，点击按当日 23:59 补结算
    box.querySelectorAll('.att-item[data-open="true"]').forEach(el => el.onclick = () => {
      const ds = el.dataset.date;
      if (confirm(`${ds} 有未签退的打卡记录，是否按当日 23:59 结算？`)) {
        const seg = Store.activeSegment(Store.attendance[ds]);
        if (seg) seg.out = new Date(ds + 'T23:59:59').toISOString();
        Store.save(); renderAttendance(); refreshToday();
        toast('已补结算');
      }
    });
  }

  const fmtTime = iso => {
    const d = new Date(iso);
    return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  };

  /* ---------- 月薪页 ---------- */
  function renderSalary() {
    const [y, m] = salMonth.split('-').map(Number);
    $('sal-cur-month').textContent = salMonth;
    const sum = Salary.calcMonth(y, m);
    const p = Store.profile;

    // 韩元无小数，用千分位
    const kr = n => Math.round(Number(n) || 0).toLocaleString('ko-KR');

    $('sal-gross').textContent = kr(sum.gross);
    $('sal-deduct').textContent = kr(sum.deductTotal);
    $('sal-net').textContent = kr(sum.net);

    // 工资条表头信息
    $('sal-meta').innerHTML = [
      p.empNo && `사번<b>${p.empNo}</b>`,
      p.name && `성명<b>${p.name}</b>`,
      p.dept && `부서<b>${p.dept}</b>`,
      p.hireDate && `입사일<b>${p.hireDate}</b>`,
      p.position && `직급<b>${p.position}</b>`,
      `시급<b>${kr(st().hourlyRate)}원</b>`
    ].filter(Boolean).map(t => `<span>${t}</span>`).join('');

    // 지급내역
    $('sal-breakdown').innerHTML = (sum.perfNote ? `<div class="hint" style="margin:0 0 8px">${sum.perfNote}</div>` : '') +
      sum.grossItems.map(it => `<div class="rowline">
        <span>${it.name} <i>${it.nameCn || ''}</i><em class="f">${it.formula || ''}</em></span>
        <b>${kr(it.amount)}</b></div>`).join('')
      + `<div class="rowline total"><span>지급합계 · 应发合计</span><b>${kr(sum.gross)}</b></div>`;

    // 공제내역（去掉重复的「保险基数」前缀，公式文本里已含基数说明）
    $('sal-deductions').innerHTML = sum.deductions.length
      ? sum.deductions.map(d => `<div class="rowline">
          <span>${d.name} <i>${d.nameCn || ''}</i><em class="f">${d.formula || ''}</em></span>
          <b>−${kr(d.amount)}</b></div>`).join('')
        + `<div class="rowline total"><span>공제합계 · 扣除合计</span><b>−${kr(sum.deductTotal)}</b></div>`
      : '<div class="att-empty">未配置扣除项目</div>';

    $('sal-base').innerHTML = `보험료기준（社保基数）= 기본급 + 실액수당 = <b>${kr(sum.insurableBase)}원</b>`;

    // 근태내역
    $('sal-attendance').innerHTML = [
      ['총근로시간 总工时', `${sum.workHours.toFixed(1)}h`],
      ['초과근로시간 加班', `${sum.otHours.toFixed(1)}h`],
      ['야간근로시간 夜班', `${sum.nightHours.toFixed(1)}h`],
      ['출근일수 出勤', `${sum.workDays}일`],
      ['휴식일 休息', `${sum.restDays}일`]
    ].map(([k, v]) => `<div class="rowline"><span>${k}</span><b>${v}</b></div>`).join('');
  }

  /* ---------- 核对 ---------- */
  function bindSalary() {
    $('btn-check').onclick = () => {
      const [y, m] = salMonth.split('-').map(Number);
      const sum = Salary.calcMonth(y, m);
      const input = Number($('actual-paid').value);
      const box = $('check-result');
      box.hidden = false;
      if (!input) { toast('请输入工资条上的 차인지급액'); return; }
      const kr = n => Math.round(Number(n) || 0).toLocaleString('ko-KR');
      const diff = Math.round(input) - Math.round(sum.net);
      if (Math.abs(diff) === 0) {
        box.className = 'check-result ok';
        box.innerHTML = `✅ <b>完全一致</b><br>工资条 실수령 ${kr(input)}원 = 系统实发 ${kr(sum.net)}원，工资无误。`;
      } else {
        // 差异定位信息：保险基数、所得税、加班工时是核对重点
        box.className = 'check-result bad';
        box.innerHTML = `⚠️ <b>存在差额 ${kr(Math.abs(diff))}원</b>（工资条${diff > 0 ? '多发' : '少发'}了）<br>
          系统：应发 ${kr(sum.gross)} − 扣除 ${kr(sum.deductTotal)} = 实发 ${kr(sum.net)}<br>
          工资条：实发 ${kr(input)}원<br>
          保险基数 ${kr(sum.insurableBase)}원 · 所得税 ${kr(sum.incomeTax)}원 · 加班 ${sum.otHours.toFixed(1)}h`;
      }
    };

    $('sal-prev-month').onclick = () => shiftMonth(-1);
    $('sal-next-month').onclick = () => shiftMonth(1);
  }

  function shiftMonth(delta) {
    const [y, m] = salMonth.split('-').map(Number);
    const d = new Date(y, m - 1 + delta, 1);
    salMonth = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
    renderSalary();
  }

  /* ---------- 设置页 ---------- */
  function renderSettings() {
    const s = st();
    const p = Store.profile;

    // 员工档案
    $('set-emp-no').value = p.empNo || '';
    $('set-name').value = p.name || '';
    $('set-dept').value = p.dept || '';
    $('set-job-title').value = p.jobTitle || '';
    $('set-hire-date').value = p.hireDate || '';
    $('set-pay-day').value = p.payDay || 16;

    // 劳动条件
    $('set-hourly').value = s.hourlyRate;
    $('set-monthly-mode').value = s.monthlyHoursMode || 'fixed';
    $('set-monthly-hours').value = s.monthlyHours || 176;
    $('set-weekly-hours').value = s.weeklyHours;
    $('set-weekly-days').value = s.weeklyDays;
    $('set-daily-hours').value = s.dailyHours;
    $('set-ot').value = s.overtimeMultiplier;
    $('set-bonus').value = s.bonusMultiplier;
    $('set-night-start').value = s.nightStart;
    $('set-night-end').value = s.nightEnd;
    $('set-perf-mode').value = s.perfMode;
    $('set-perf').value = s.perfMonthly;
    $('perf-monthly-field').style.display = s.perfMode === 'monthly' ? 'flex' : 'none';
    $('monthly-hours-field').style.display = (s.monthlyHoursMode || 'fixed') === 'auto' ? 'none' : 'flex';

    // 所得税
    $('set-tax-mode').value = s.taxMode || 'manual';
    $('set-tax-amount').value = s.taxManualAmount || 0;
    $('tax-manual-field').style.display = (s.taxMode || 'manual') === 'manual' ? 'flex' : 'none';
    $('set-local-tax-floor').checked = s.localTaxFloor !== false;

    $('set-fence-name').value = s.fence.name;
    $('set-fence-lat').value = s.fence.lat || '';
    $('set-fence-lng').value = s.fence.lng || '';
    $('set-fence-radius').value = s.fence.radius;
    $('fence-radius-label').textContent = `${s.fence.radius} 米`;
    $('set-reentry-guard').value = s.reentryGuard;
    $('sync-on-open-switch').checked = s.autoSyncOnOpen;
    renderSyncUrl();
    renderIssues();

    renderAllowList();
    renderDeductList();
    renderTaxTable();
  }

  /** 津贴列表：显示公式说明与开关 */
  function renderAllowList() {
    const list = st().allowances || [];
    $('allow-list').innerHTML = list.length ? list.map(a => {
      const typeTxt = { fixed: '固定额', formulaWeekly: '周薪公式', formulaOT: '加班公式', formulaBonus: '奖金公式' }[a.type] || a.type;
      const valTxt = a.type === 'fixed' ? `${Number(a.value || 0).toLocaleString()}원`
        : `<em>${typeTxt}</em>`;
      return `<div class="issue-item">
        <b>${a.name}</b>
        <span style="flex:1">${a.nameCn || ''} ${valTxt}</span>
        <button class="del" data-id="${a.id}">×</button></div>`;
    }).join('') : '<div class="att-empty">暂无津贴项</div>';
    $('allow-list').querySelectorAll('.del').forEach(btn => btn.onclick = () => {
      st().allowances = st().allowances.filter(a => a.id !== btn.dataset.id);
      Store.save(); renderAllowList(); renderSalary();
    });
  }

  /** 扣除列表：显示计算基数说明 */
  function renderDeductList() {
    const list = st().deductions || [];
    const typeTxt = {
      percentOfBase: '保险基数%', percentOfGross: '应发%',
      percentOfIncomeTax: '所得税%', koreanTax: '累进', fixed: '固定额'
    };
    $('deduct-list').innerHTML = list.length ? list.map(d => {
      const val = d.type === 'percentOfBase' || d.type === 'percentOfGross' || d.type === 'percentOfIncomeTax'
        ? `${Number(d.value || 0)}%`
        : d.type === 'fixed' ? `${Number(d.value || 0).toLocaleString()}원`
          : '累进';
      return `<div class="issue-item">
        <b>${d.name}</b>
        <span style="flex:1">${d.nameCn || ''} · ${typeTxt[d.type] || d.type} ${val}</span>
        <button class="del" data-id="${d.id}">×</button></div>`;
    }).join('') : '<div class="att-empty">暂无扣除项</div>';
    $('deduct-list').querySelectorAll('.del').forEach(btn => btn.onclick = () => {
      st().deductions = st().deductions.filter(d => d.id !== btn.dataset.id);
      Store.save(); renderDeductList(); renderSalary();
    });
  }

  function bindSettings() {
    // input + change 双保险：手机端输完立即保存，避免切页面/锁屏丢最后一个字段
    const bindField = (id, fn) => {
      const el = $(id);
      el.addEventListener('input', fn);
      el.addEventListener('change', fn);
    };
    const bindNum = (id, key, after) => bindField(id, e => {
      const v = Number(e.target.value);
      if (Number.isFinite(v) && v >= 0) { st()[key] = v; Store.save(); after && after(); }
      else toast('请输入有效数值');
    });
    const bindProfile = (id, key) => bindField(id, e => {
      Store.profile[key] = e.target.value; Store.save();
    });

    // 员工档案
    bindProfile('set-emp-no', 'empNo');
    bindProfile('set-name', 'name');
    bindProfile('set-dept', 'dept');
    bindProfile('set-job-title', 'jobTitle');
    bindProfile('set-hire-date', 'hireDate');
    bindNum('set-pay-day', 'payDay');

    // 劳动条件
    bindNum('set-hourly', 'hourlyRate', renderSalary);
    bindNum('set-monthly-hours', 'monthlyHours', renderSalary);
    bindNum('set-weekly-hours', 'weeklyHours', renderSalary);
    bindNum('set-weekly-days', 'weeklyDays', renderSalary);
    bindNum('set-daily-hours', 'dailyHours', renderSalary);
    bindField('set-monthly-mode', e => {
      st().monthlyHoursMode = e.target.value; Store.save();
      $('monthly-hours-field').style.display = e.target.value === 'auto' ? 'none' : 'flex';
      renderSalary();
    });
    bindNum('set-ot', 'overtimeMultiplier', renderSalary);
    bindNum('set-bonus', 'bonusMultiplier', renderSalary);
    bindNum('set-tax-amount', 'taxManualAmount', renderSalary);
    bindNum('set-perf', 'perfMonthly', renderSalary);

    bindField('set-tax-mode', e => {
      st().taxMode = e.target.value; Store.save();
      $('tax-manual-field').style.display = e.target.value === 'manual' ? 'flex' : 'none';
      renderSalary();
    });
    $('set-local-tax-floor').onchange = e => {
      st().localTaxFloor = e.target.checked; Store.save(); renderSalary();
    };

    bindField('set-night-start', e => { st().nightStart = e.target.value; Store.save(); renderSalary(); });
    bindField('set-night-end', e => { st().nightEnd = e.target.value; Store.save(); renderSalary(); });
    bindField('set-perf-mode', e => {
      st().perfMode = e.target.value; Store.save();
      $('perf-monthly-field').style.display = e.target.value === 'monthly' ? 'flex' : 'none';
      renderSalary();
    });

    bindField('set-fence-name', e => { st().fence.name = e.target.value; Store.save(); });
    bindField('set-fence-lat', e => { st().fence.lat = Number(e.target.value) || 0; Store.save(); });
    bindField('set-fence-lng', e => { st().fence.lng = Number(e.target.value) || 0; Store.save(); });
    $('set-fence-radius').addEventListener('input', e => {
      st().fence.radius = Number(e.target.value);
      $('fence-radius-label').textContent = `${e.target.value} 米`;
      Store.save();
    });

    // ---- 全自动打卡配置 ----
    bindNum('set-reentry-guard', 'reentryGuard');

    $('sync-on-open-switch').onchange = e => {
      st().autoSyncOnOpen = e.target.checked; Store.save();
      if (e.target.checked) syncState('toggle');
    };

    $('btn-copy-url').onclick = async () => {
      const url = syncUrl();
      try {
        await navigator.clipboard.writeText(url);
        toast('✅ 地址已复制，粘贴到快捷指令的「打开 URL」里');
      } catch (err) {
        toast('复制失败，请手动长按选中上方地址');
      }
    };

    $('btn-test-sync').onclick = async () => {
      const hint = $('test-hint');
      hint.textContent = '正在测试…';
      const r = await syncState('test');
      if (!r) { hint.textContent = '❌ 校准失败，请检查定位权限与公司坐标配置'; return; }
      hint.textContent = r.acted === 'in' ? '✅ 测试通过：已在公司内，自动签到成功'
        : r.acted === 'out' ? '✅ 测试通过：已离开公司区域，自动签退成功'
        : r.res.inside ? '✅ 测试通过：当前位置在公司内（状态已对齐，无需打卡）'
        : '✅ 测试通过：当前位置在公司外（状态已对齐，无需打卡）';
    };

    $('btn-clear-issues').onclick = () => {
      st().issues = []; Store.save(); renderIssues();
      toast('已清空异常记录');
    };

    $('btn-locate').onclick = () => {
      if (!navigator.geolocation) return toast('本设备不支持定位');
      toast('正在获取位置…');
      navigator.geolocation.getCurrentPosition(pos => {
        st().fence.lat = Number(pos.coords.latitude.toFixed(6));
        st().fence.lng = Number(pos.coords.longitude.toFixed(6));
        Store.save(); renderSettings(); refreshToday();
        toast('✅ 已获取当前位置为公司坐标');
      }, () => toast('定位失败，请检查权限'), { enableHighAccuracy: true, timeout: 10000 });
    };

    $('btn-add-deduct').onclick = () => {
      const name = $('new-deduct-name').value.trim();
      const type = $('new-deduct-type').value;
      const value = Number($('new-deduct-value').value);
      if (!name) return toast('请输入扣除项名称');
      if (type !== 'koreanTax' && !(value >= 0)) return toast('请输入有效数值');
      st().deductions.push({ id: 'd' + Date.now(), name, nameCn: '', type, value: type === 'koreanTax' ? 0 : value, enabled: true });
      Store.save(); renderDeductList(); renderSalary();
      $('new-deduct-name').value = $('new-deduct-value').value = '';
      toast('已添加扣除项');
    };

    $('btn-add-allow').onclick = () => {
      const name = $('new-allow-name').value.trim();
      const type = $('new-allow-type').value;
      const value = Number($('new-allow-value').value);
      if (!name) return toast('请输入津贴项名称');
      if (type === 'fixed' && !(value >= 0)) return toast('请输入有效金额');
      st().allowances.push({ id: 'a' + Date.now(), name, nameCn: '', value: type === 'fixed' ? value : 0, type, enabled: true });
      Store.save(); renderAllowList(); renderSalary();
      $('new-allow-name').value = $('new-allow-value').value = '';
      toast('已添加津贴项');
    };

    $('btn-edit-tax').onclick = () => {
      const editing = $('tax-table').classList.toggle('editing');
      $('btn-edit-tax').textContent = editing ? '完成编辑' : '编辑税率表';
      renderTaxTable();
    };

    $('btn-export').onclick = () => {
      const blob = new Blob([Store.exportJSON()], { type: 'application/json' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `工资通备份_${todayStr()}.json`;
      a.click();
      toast('已导出备份文件');
    };

    $('btn-import').onclick = () => $('import-file').click();
    $('import-file').onchange = e => {
      const file = e.target.files[0];
      e.target.value = '';   // 允许重复选同一文件
      if (!file) return;
      const reader = new FileReader();
      reader.onload = () => {
        try {
          const data = JSON.parse(reader.result);
          if (!data.settings || !data.attendance) throw new Error('不是有效的备份文件');
          if (!confirm('导入将覆盖本机全部数据，确定继续？')) return;
          Store.importData(data);
          renderSettings(); refreshToday(); renderAttendance(); renderSalary();
          toast('✅ 导入成功');
        } catch (err) {
          toast('导入失败：' + err.message);
        }
      };
      reader.readAsText(file);
    };

    $('btn-reset').onclick = () => {
      if (confirm('确定清空全部考勤与设置数据？此操作不可恢复！')) {
        Store.reset(); renderSettings(); refreshToday(); renderAttendance(); renderSalary();
        toast('已清空全部数据');
      }
    };
  }

  function renderDeductList() {
    const list = st().deductions;
    $('deduct-list').innerHTML = list.length ? list.map(d => {
      const val = d.type === 'percent' ? `${d.value}%` : d.type === 'fixed' ? `¥${d.value}` : '累进税率';
      return `<div class="deduct-item"><span class="name">${d.name}</span><span class="val">${val}</span>
        <button class="del" data-id="${d.id}">×</button></div>`;
    }).join('') : '<div class="att-empty">暂无扣除项目</div>';
    $('deduct-list').querySelectorAll('.del').forEach(btn => btn.onclick = () => {
      st().deductions = st().deductions.filter(d => d.id !== btn.dataset.id);
      Store.save(); renderDeductList();
    });
  }

  function renderTaxTable() {
    const brackets = st().taxBrackets;
    const editing = $('tax-table').classList.contains('editing');
    $('tax-table').innerHTML =
      `<div class="tax-row head"><span>下限（元）</span><span>上限（元）</span><span>税率</span></div>` +
      brackets.map((b, i) => `<div class="tax-row" data-i="${i}">
        <span>${editing ? `<input type="number" data-k="min" value="${b.min}">` : b.min}</span>
        <span>${editing ? `<input type="number" data-k="max" value="${b.max == null ? '' : b.max}" placeholder="∞">` : (b.max == null ? '∞' : b.max)}</span>
        <span>${editing ? `<input type="number" step="0.01" data-k="rate" value="${b.rate}">` : (b.rate * 100) + '%'}</span>
      </div>`).join('');
    if (editing) {
      $('tax-table').querySelectorAll('input').forEach(inp => inp.addEventListener('input', () => {
        const row = inp.closest('.tax-row'); const i = Number(row.dataset.i);
        const k = inp.dataset.k;
        const b = st().taxBrackets[i];
        if (k === 'max') b.max = inp.value === '' ? null : Number(inp.value);
        else b[k] = Number(inp.value) || 0;
        Store.save();
      }));
    }
  }

  /* ---------- Tab 切换 ---------- */
  function switchPage(name) {
    document.querySelectorAll('.page').forEach(p => p.hidden = p.id !== `page-${name}`);
    document.querySelectorAll('.tab').forEach(t => t.classList.toggle('active', t.dataset.page === name));
    if (name === 'attendance') renderAttendance();
    if (name === 'salary') renderSalary();
    if (name === 'settings') renderSettings();
    if (name === 'today') refreshToday();
  }

  /* ---------- 地理围栏事件 ---------- */
  GeoPunch.setHandler((type, payload) => {
    if (type === 'enter' && st().autoPunch) punchIn(true);
    else if (type === 'leave' && st().autoPunch) punchOut(true);
    else if (type === 'enter') $('punch-desc').textContent = '已在公司区域内';
    else if (type === 'error') toast('📍 ' + payload);
    else if (type === 'nofence') $('punch-desc').textContent = '请先到【设置】配置公司位置';
  });

  /* ---------- 启动 ---------- */
  function init() {
    bindToday(); bindSalary(); bindSettings();
    document.querySelectorAll('.tab').forEach(t => t.onclick = () => switchPage(t.dataset.page));

    $('prev-month').onclick = () => {
      const [y, m] = attMonth.split('-').map(Number);
      const d = new Date(y, m - 2, 1);
      attMonth = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
      renderAttendance();
    };
    $('next-month').onclick = () => {
      const [y, m] = attMonth.split('-').map(Number);
      const d = new Date(y, m, 1);
      attMonth = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
      renderAttendance();
    };

    // 页面隐藏时 GPS 监听可能被系统挂起，回到前台恢复
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) return;
      if (st().autoPunch && !GeoPunch.running()) GeoPunch.start();
      // 每次回到前台都校准一次状态（锁屏后回来、iOS 快捷指令唤起都靠它）
      if (st().autoSyncOnOpen) syncState('resume');
    });

    if (st().autoPunch) GeoPunch.start();

    // 打开即校准：让「快捷指令自动化打开本页」能自动对齐签到/签退
    if (st().autoSyncOnOpen) syncState('open');
    refreshToday();

    // 实时跳动：每 15 秒刷新今日已赚
    tickTimer = setInterval(() => { if (!document.querySelector('#page-today').hidden) refreshToday(); }, 15000);
  }

  document.addEventListener('DOMContentLoaded', init);
})();
