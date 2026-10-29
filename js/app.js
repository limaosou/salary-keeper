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
  // 2026-10-28 起：一次签到 = 一整天出勤，没有签退这个动作。
  // 迟到/早退/加班都到【考勤】的「特殊情况登记」里填，计薪不受打卡时刻影响。
  function punchIn(auto = false, reason = '') {
    const ds = todayStr();
    const rec = Store.day(ds);
    if (rec.segments.length) {
      if (!auto) toast('今天已签到 · 一次签到代表一整天');
      return false;
    }
    rec.segments.push({ in: new Date().toISOString(), out: null, auto, src: auto ? 'auto' : 'manual', reason });
    rec.isRestDay = false;
    Store.save();
    refreshToday();
    toast(auto ? '📍 已进入公司区域，自动签到（今日按整班计薪）' : '✅ 已签到 · 今日按整班计薪');
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
      let acted = null;

      if (res.inside) {
        // 一次签到 = 一整天：当天已有签到就不再动作（天然防抖，离开再回来也不会重复打）
        if (!rec || !rec.segments.length) acted = punchIn(true, 'auto-sync-in') ? 'in' : null;
      }
      // 离开公司区域不做事：没有签退概念，考勤已按整班锁定

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
  // 自检：是否正以「主屏幕 App（PWA）」模式运行。
  // 只有在 Safari 里直接打开时才为 false —— 这正是「打开 App 列表里找不到工资通」的根因。
  function isStandaloneApp() {
    if (window.navigator.standalone === true) return true;              // iOS Safari Web Clip
    try { return window.matchMedia('(display-mode: standalone)').matches; } catch (e) { return false; }
  }

  function renderStandaloneHint() {
    const el = $('standalone-hint');
    if (el) el.hidden = isStandaloneApp();
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
    const r = Salary.calcDay(rec || { segments: [], restMinutes: 0, isRestDay: false }, ds, { nowForOpen: new Date() });
    const s = st();
    const kr = n => Math.round(Number(n) || 0).toLocaleString('ko-KR');

    // 当日金额 = 「标准 8h + 固定加班 3.5h(×1.5) + 夜班补助」：
    // 一次签到即按整班锁定，迟到/早退/加班的增减走「特殊情况登记」
    const dp = s.dailyPay || {};
    const stdH = Number(dp.stdHours != null ? dp.stdHours : 8);
    const fixH = Number(dp.fixedOtHours != null ? dp.fixedOtHours : 3.5);
    const nightH = Number(dp.nightAllowHours != null ? dp.nightAllowHours : 3.5);
    const nightRate = Number(dp.nightAllowRate != null ? dp.nightAllowRate : 0.5);
    const holMul = Number(dp.holidayMultiplier != null ? dp.holidayMultiplier : 1.5);
    const otMul = Number(s.overtimeMultiplier || 1.5);
    const hourly = Number(s.hourlyRate) || 0;

    const h = Math.max(0, r.workHours);
    const hStd = Math.min(h, stdH);
    const hOT = Math.min(Math.max(h - stdH, 0), fixH);
    const hExtra = Math.max(h - stdH - fixH, 0);
    let earned = hStd * hourly + (hOT + hExtra) * hourly * otMul;

    const isNight = !!(rec && rec.shiftType === 'night');
    const totalShift = stdH + fixH;
    if (isNight && totalShift > 0) {
      earned += Math.min(h / totalShift, 1) * nightH * hourly * nightRate;
    }
    const holInfo = Salary.holidayInfo(ds, s);
    if (holInfo) earned *= holMul;

    $('today-earned').textContent = kr(earned);
    $('today-currency').textContent = '₩';
    $('today-worked').textContent = Salary.fmtHM(r.workHours * 3600000);
    $('today-ot').textContent = Salary.fmtHM(r.otHours * 3600000);
    $('today-segments').textContent = r.segCount;

    // 班次 / 假日提示
    const shiftTag = $('today-shift');
    if (shiftTag) {
      const w = Salary.shiftWindowFor(ds, isNight ? 'night' : 'day', s);
      const tags = [
        `<span class="tag ${isNight ? 'night' : 'day'}">${isNight ? '夜班' : '白班'} ${w.start}–${w.end}</span>`
      ];
      if (w.note) tags.push(`<span class="tag holiday">${w.note}</span>`);
      if (holInfo) tags.push(`<span class="tag holiday">${holInfo.name} ×${holMul}</span>`);
      shiftTag.innerHTML = tags.join('');
    }
    // 状态文案：一次签到 = 一整天，没有"打卡中/已签退"之分
    if (!rec || !rec.segments.length) {
      $('today-status').textContent = '尚未签到';
      $('punch-title').textContent = GeoPunch.running() ? '监听中 · 等待进入区域' : '地理围栏待机中';
      $('punch-desc').textContent = s.fence.lat ? '进入公司区域自动签到，或点下方手动签到' : '请先到【设置】配置公司位置';
    } else {
      const t = new Date(rec.segments[0].in);
      $('today-status').textContent = `已签到 · ${String(t.getHours()).padStart(2, '0')}:${String(t.getMinutes()).padStart(2, '0')}`;
      $('punch-title').textContent = '今日出勤已记录';
      $('punch-desc').textContent = '一次签到代表一整天，按整班计薪；迟到/早退到【考勤】登记';
    }

    // 打卡状态点
    const hasSeg = !!(rec && rec.segments.length);
    const ps = $('punch-state');
    ps.className = 'punch-state ' + (hasSeg ? 'in' : 'out');
    $('btn-manual-in').disabled = hasSeg;

    // 当日明细：与 hero 的「已赚」同口径，按完成进度逐项累计
    const stdEarn = hStd * hourly;
    const otEarn = (hOT + hExtra) * hourly * otMul;
    const nightEarn = (isNight && totalShift > 0)
      ? Math.min(h / totalShift, 1) * nightH * hourly * nightRate : 0;
    const holEarn = holInfo ? (stdEarn + otEarn + nightEarn) * (holMul - 1) : 0;

    $('d-base').textContent = `${kr(stdEarn)}  (${Math.min(h, stdH).toFixed(1)}h / ${stdH}h)`;
    $('d-ot').textContent = `${kr(otEarn)}  (${Math.min(hOT + hExtra, fixH).toFixed(1)}h / ${fixH}h)`;
    $('d-night').textContent = isNight
      ? `${kr(nightEarn)}  (${(nightH * Math.min(h / totalShift, 1)).toFixed(1)}h / ${nightH}h × ${nightRate})`
      : '—';
    $('d-total').textContent = kr(earned);
    $('d-ot-rate').textContent = otMul;
    const dHol = $('d-holiday');
    if (dHol) {
      dHol.parentElement.hidden = !holInfo;
      if (holInfo) dHol.textContent = `${holInfo.name} × ${holMul} → +${kr(holEarn)}`;
    }

    // 满班日薪参考（口径说明，跟实时的已赚区分开）
    const fullBase = Math.round(stdH * hourly) + Math.round(fixH * hourly * otMul)
      + (isNight ? Math.round(nightH * hourly * nightRate) : 0);
    const fullDay = Math.round(fullBase * (holInfo ? holMul : 1));
    const rateNote = $('today-rate');
    if (rateNote) {
      rateNote.textContent = `满班日薪 ${kr(fullDay)}원 = 标准 ${kr(stdH * hourly)}`
        + ` + 固定加班 ${kr(fixH * hourly * otMul)}`
        + (isNight ? ` + 夜班补助 ${kr(nightH * hourly * nightRate)}` : '')
        + (holInfo ? `，${holInfo.name} 全天 ×${holMul}` : '');
    }

    // 休息分钟
    if (rec) $('rest-value').textContent = `${rec.restMinutes} 分钟`;
    else $('rest-value').textContent = `${s.restMinutes ?? 30} 分钟`;
    $('shift-label').textContent = isNight ? '夜班' : '白班';
  }

  function bindToday() {
    $('btn-manual-in').onclick = () => punchIn(false);

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
    const cur = Number(rec.restMinutes);
    rec.restMinutes = Math.max(0, Math.min(480, (Number.isFinite(cur) ? cur : (st().restMinutes ?? 30)) + delta));
    Store.save(); refreshToday();
  }

  /* ---------- 考勤页 ---------- */
  let attMonth = cur();

  /* ---------- 考勤月历 ---------- */
  function renderCalendar() {
    const [y, m] = attMonth.split('-').map(Number);
    const cells = Salary.monthGrid(y, m, { now: new Date() });
    const todayKey = todayStr();
    const box = $('cal-grid');

    box.innerHTML = cells.map(c => {
      if (c.pad) return '<div class="cal-cell pad"></div>';
      const code = c.code;
      const tappable = code !== 'future';
      const cls = ['cal-cell', 's-' + code];
      // 法定节假日：单独配色 + 显示假日名，便于一眼看出哪天休息
      if (c.isHoliday) cls.push('s-holiday');
      // 夜班：格子加靛蓝描边 + 「夜」角标，与白班一眼区分
      const isNight = c.shiftType === 'night';
      if (isNight) cls.push('is-night');
      if (c.dateStr === todayKey) cls.push('today');
      if (tappable) cls.push('tappable');
      const sub = c.code === 'future' ? '' : `<span class="cs">${c.sym}</span>`;
      const ntag = isNight ? '<span class="cnight">夜</span>' : '';
      const hours = (c.code !== 'future' && c.workHours > 0) ? `<span class="ch">${c.workHours.toFixed(1)}h</span>` : '';
      const dot = (c.makeups && c.makeups.length) ? '<span class="mkdot"></span>' : '';
      const title = c.isHoliday ? ` title="${c.holidayName || '공휴일'}${c.hasSeg ? ' · 出勤全天×1.5' : ''}"` : '';
      return `<div class="${cls.join(' ')}" data-date="${c.dateStr}" data-code="${code}"${title}${tappable ? ' role="button" tabindex="0"' : ''}>
        <span class="cd">${c.date}</span>${sub}${ntag}${hours}${dot}
      </div>`;
    }).join('');

    box.querySelectorAll('.cal-cell.tappable').forEach(el => {
      el.onclick = () => openMakeup(el.dataset.date);
    });

    // 状态统计胶囊
    const s = Salary.monthStatusStats(y, m, { now: new Date() });
    const chips = [
      ['出勤', s.workDays], ['正常', s.normal], ['迟到', s.late],
      ['早退', s.early], ['缺卡', s.missing], ['旷工', s.absent],
      ['请假', s.leave], ['休息', s.rest], ['法定假日', s.holiday],
      ['假日出勤', s.holidayWork], ['夜班', s.nightDays], ['待出勤', s.pending]
    ].filter(([, v]) => v > 0).map(([k, v]) => `<span class="chip">${k} <b>${v}</b></span>`);
    $('att-stat').innerHTML = chips.length
      ? chips.join('') + (s.makeupCount ? `<span class="chip">补签 <b>${s.makeupCount}</b></span>` : '')
      : '<span class="chip">本月暂无考勤数据</span>';
  }

  /* ---------- 补签 / 请假面板 ---------- */
  let mkDate = null;

  function openMakeup(dateStr) {
    mkDate = dateStr;
    $('mk-title').textContent = dateStr;
    $('mk-note').value = '';
    $('mk-msg').textContent = '';
    $('mk-msg').className = 'hint';
    $('mk-leave-type').value = ((Store.peek(dateStr) || {}).leave && Store.peek(dateStr).leave.type) || '연차';
    syncMkShift();
    syncMkTime();
    renderMakeupPanel();
    $('mk-mask').hidden = false;
  }

  function closeMakeup() { $('mk-mask').hidden = true; mkDate = null; }

  // 一次补签 = 那天整天出勤，时间只作留痕，计薪按班次整班算。
  // 默认时间取该日班次的上班时刻（白班 08:20 / 夜班 20:20），纯留痕不影响钱
  function syncMkTime() {
    if (!mkDate) return;
    const rec = Store.peek(mkDate);
    const isNight = !!(rec && rec.shiftType === 'night');
    const w = Salary.shiftWindowFor(mkDate, isNight ? 'night' : 'day', Store.settings);
    $('mk-time').value = w.start || '08:20';
  }

  /** 补签面板：班次选择（白班/夜班）——决定该日按哪个整班窗口计薪 */
  function syncMkShift() {
    if (!mkDate) return;
    const rec = Store.peek(mkDate);
    const isNight = !!(rec && rec.shiftType === 'night');
    $('mk-shift-day').classList.toggle('active', !isNight);
    $('mk-shift-night').classList.toggle('active', isNight);
    const w = Salary.shiftWindowFor(mkDate, isNight ? 'night' : 'day', Store.settings);
    const restMin = (rec && rec.restMinutes != null) ? rec.restMinutes
      : (Store.settings.restMinutes != null ? Store.settings.restMinutes : 30);
    const start = new Date(`${mkDate}T${w.start}:00`);
    const end = new Date(`${mkDate}T${w.end}:00`);
    if (w.crossMidnight) end.setDate(end.getDate() + 1);
    const hrs = ((end - start - restMin * 60000) / 3600000).toFixed(1);
    $('mk-shift-info').innerHTML =
      `该日按 <b>${isNight ? '🌙 夜班' : '☀️ 白班'}</b> 计：${w.start} – ${w.crossMidnight ? '次日 ' : ''}${w.end}` +
      `（扣休 ${restMin} 分，整班 <b>${hrs}h</b>）${w.note ? ' · ' + w.note : ''}`;
  }

  function setMkShift(type) {
    if (!mkDate) return;
    const rec = Store.day(mkDate);
    if (rec.shiftType === type) return;
    rec.shiftType = type;
    Store.save();
    toast(type === 'night' ? '🌙 该日已按夜班计薪' : '☀️ 该日已按白班计薪');
    syncMkShift();
    syncMkTime();
    renderMakeupPanel();
    refreshAll();
  }

  function renderMakeupPanel() {
    if (!mkDate) return;
    const st = Salary.judgeDay(mkDate, { now: new Date() });
    const rec = Store.peek(mkDate);

    const badge = $('mk-status');
    badge.className = 'lg s-' + st.code;
    badge.textContent = st.label;

    // 打卡明细（首行固定显示该日班次）
    const segs = rec && rec.segments ? rec.segments : [];
    const isNightRec = !!(rec && rec.shiftType === 'night');
    const srcTag = sg => sg.src === 'manual' ? '手动/补签' : (sg.src === 'auto' ? '自动打卡' : (sg.makeup ? '手工补签' : '自动打卡'));
    $('mk-detail').innerHTML =
      `<div class="mk-seg"><span>班次</span><b>${isNightRec ? '🌙 夜班' : '☀️ 白班'}</b></div>` +
      (segs.length
      ? segs.map((sg, i) => `<div class="mk-seg">
          <span>第 ${i + 1} 段 <i class="opic">${srcTag(sg)}</i></span>
          <b>${fmtTime(sg.in)}${sg.out ? ' – ' + fmtTime(sg.out) : ''}</b>
        </div>`).join('') +
        `<div class="mk-seg"><span>工时 / 加班</span><b>${st.workHours.toFixed(1)}h / ${st.otHours.toFixed(1)}h</b></div>` +
        (st.extra ? `<div class="mk-seg"><span>说明</span><b class="mk-note">${st.extra}</b></div>` : '')
      : `<div class="mk-empty">当日无打卡记录${st.leave ? `（已登记请假：${st.leave.type}）` : ''}</div>`);

    // 补签留痕
    const logs = (rec && rec.makeups) || [];
    $('mk-logs').innerHTML = logs.length
      ? logs.slice().reverse().map(mk => `<div class="mk-log">
          <span class="lt">${mk.type === 'in' ? '签到' : '签退'}</span>
          <span class="ln">${fmtTime(mk.time)}　${mk.note || '—'}</span>
          <button class="lx" data-id="${mk.id}">撤销</button>
        </div>`).join('')
      : '<div class="mk-empty">暂无补签记录</div>';
    $('mk-logs').querySelectorAll('.lx').forEach(b => {
      b.onclick = () => {
        if (!confirm('确定撤销这条补签？该次打卡将一并回滚。')) return;
        const r = Store.removeMakeup(mkDate, b.dataset.id);
        toast(r.msg);
        if (r.ok) { renderMakeupPanel(); refreshAll(); }
      };
    });

    // 已登记的特殊情况回填到表单
    const adj = Store.getAdjust(mkDate);
    $('mk-late').value = adj && adj.lateMin ? adj.lateMin : '';
    $('mk-early').value = adj && adj.earlyMin ? adj.earlyMin : '';
    $('mk-add').value = adj && adj.addMin ? adj.addMin : '';
    $('mk-adjust-note').value = (adj && adj.note) || '';
    const adjParts = [];
    if (adj) {
      if (adj.lateMin) adjParts.push(`迟到 ${adj.lateMin} 分`);
      if (adj.earlyMin) adjParts.push(`早退 ${adj.earlyMin} 分`);
      if (adj.addMin) adjParts.push(`增加 ${adj.addMin} 分`);
      if (adj.note) adjParts.push(adj.note);
    }
    $('mk-adjust-msg').textContent = adjParts.length ? `当前已登记：${adjParts.join(' · ')}` : '';
    $('mk-adjust-msg').className = 'hint';

    // 请假按钮文案随状态切换
    $('mk-leave').textContent = st.leave ? '取消请假' : '登记请假';
    $('mk-rest').textContent = (rec && rec.isRestDay) ? '取消休息日' : '标记休息日';
  }

  function bindCalendar() {
    $('mk-close').onclick = closeMakeup;
    $('mk-mask').onclick = e => { if (e.target === $('mk-mask')) closeMakeup(); };

    // 班次切换：白班 / 夜班（影响该日整班计薪窗口）
    $('mk-shift-day').onclick = () => setMkShift('day');
    $('mk-shift-night').onclick = () => setMkShift('night');

    $('mk-submit').onclick = () => {
      if (!mkDate) return;
      const t = $('mk-time').value;
      if (!t) return showMkMsg('请填写时间', false);
      const time = new Date(`${mkDate}T${t}:00`).getTime();
      const res = Store.addMakeup(mkDate, {
        type: 'in',                 // 一次补签 = 那天整天出勤
        time: new Date(time).toISOString(),
        note: $('mk-note').value.trim()
      });
      showMkMsg(res.msg, res.ok);
      if (res.ok) {
        $('mk-note').value = '';
        renderMakeupPanel();
        refreshAll();
      }
    };

    $('mk-leave').onclick = () => {
      const st = Salary.judgeDay(mkDate, { now: new Date() });
      if (st.leave) {
        Store.clearLeave(mkDate);
        toast('已取消请假');
      } else {
        Store.setLeave(mkDate, { type: $('mk-leave-type').value });
        toast('已登记请假');
      }
      renderMakeupPanel(); refreshAll();
    };

    $('mk-rest').onclick = () => {
      const rec = Store.day(mkDate);
      rec.isRestDay = !rec.isRestDay;
      Store.save();
      toast(rec.isRestDay ? '已标记为休息日' : '已取消休息日');
      renderMakeupPanel(); refreshAll();
    };

    const saveAdjust = () => {
      if (!mkDate) return;
      const r = Store.setAdjust(mkDate, {
        lateMin: $('mk-late').value,
        earlyMin: $('mk-early').value,
        addMin: $('mk-add').value,
        note: $('mk-adjust-note').value
      });
      const msg = $('mk-adjust-msg');
      msg.textContent = r.msg;
      msg.className = 'hint ' + (r.ok ? 'ok' : 'err');
      renderMakeupPanel(); refreshAll();
    };
    $('mk-adjust-save').onclick = saveAdjust;
    $('mk-adjust-clear').onclick = () => {
      if (!mkDate) return;
      $('mk-late').value = ''; $('mk-early').value = ''; $('mk-add').value = ''; $('mk-adjust-note').value = '';
      saveAdjust();
    };
  }

  function showMkMsg(msg, ok) {
    const el = $('mk-msg');
    el.textContent = msg;
    el.className = 'hint ' + (ok ? 'ok' : 'err');
  }

  /** 补签/请假后统一刷新（月历 + 列表 + 统计 + 首页 + 月薪） */
  function refreshAll() {
    renderCalendar();
    renderAttendance();
    renderSalary();
    refreshToday();
  }

  function renderAttendance() {
    const [y, m] = attMonth.split('-').map(Number);
    $('cur-month').textContent = attMonth;
    renderCalendar();
    const sum = Salary.calcMonth(y, m, { mode: Salary.payrollModeFor(y, m) });
    $('m-days').textContent = `${sum.workDays} 天`;
    $('m-hours').textContent = `${sum.workHours.toFixed(1)}h`;
    $('m-earn').textContent = money(sum.gross);

    const box = $('att-list');
    if (!sum.dayList.length) {
      box.innerHTML = '<div class="att-empty">本月暂无考勤记录</div>';
      return;
    }
    const krN = n => Math.round(Number(n) || 0).toLocaleString('ko-KR');
    const todayKey = todayStr();

    box.innerHTML = sum.dayList.map(({ dateStr, rec, rest }) => {
      const d = new Date(dateStr + 'T00:00:00');
      const wk = ['日', '一', '二', '三', '四', '五', '六'][d.getDay()];
      const times = rec.segments.map(sg =>
        `${fmtTime(sg.in)}${sg.out ? '–' + fmtTime(sg.out) : ''}`).join('　');
      // 日薪统一走「标准 8h + 固定加班 3.5h + 夜班补助 + 假日 1.5 倍」口径
      const pay = Salary.calcDayPay(dateStr, {
        nowForOpen: dateStr === todayKey ? new Date() : new Date(`${dateStr}T23:59:59`)
      });
      const isNight = rec.shiftType === 'night';
      const tag = rest ? '<span class="tag rest">休息日</span>'
        : `<span class="tag ${isNight ? 'night' : 'day'}">${isNight ? '夜班' : '白班'}</span>`;
      const holTag = pay.isHoliday
        ? `<span class="tag holiday">${pay.holidayName || '공휴일'} ×1.5</span>` : '';
      const satTag = (!pay.isHoliday && pay.isSaturday && pay.kind === 'work')
        ? '<span class="tag holiday">토요일 ×1.5</span>' : '';

      let detail;
      if (rest || pay.kind === 'rest') detail = '休息不计薪';
      else if (pay.kind === 'leave') detail = pay.paid ? `연차 有薪年假 ${krN(pay.total)}원` : `${pay.leaveType || '请假'} 不计薪`;
      else if (pay.kind === 'none') detail = '未打卡';
      else {
        const parts = [`工时 ${pay.workHours.toFixed(1)}h`, `加班 ${Math.max(pay.otHours, 0).toFixed(1)}h`];
        if (pay.nightPay > 0) parts.push(`夜补 ${krN(pay.nightPay)}`);
        if (pay.holidayExtra > 0) parts.push(`假日加给 ${krN(pay.holidayExtra)}`);
        detail = parts.join(' · ');
      }
      return `<div class="att-item" data-date="${dateStr}">
        <div class="att-date"><b>${d.getDate()}</b><i>周${wk}</i></div>
        <div class="att-info"><b>${times || '未签到'}${tag}${holTag}${satTag}</b>
          <span>${detail}</span></div>
        <div class="att-money">${pay.total > 0 ? krN(pay.total) : '—'}</div>
      </div>`;
    }).reverse().join('');
  }

  const fmtTime = iso => {
    const d = new Date(iso);
    return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  };

  /* ---------- 月薪页 ---------- */
  function renderSalary() {
    const [y, m] = salMonth.split('-').map(Number);
    $('sal-cur-month').textContent = salMonth;
    const now = new Date();
    // 当月按考勤实算（非固定值）；前月按工资条固定口径
    const mode = Salary.payrollModeFor(y, m, now);
    const sum = Salary.calcMonth(y, m, { mode, now });
    const p = Store.profile;

    // 韩元无小数，用千分位
    const kr = n => Math.round(Number(n) || 0).toLocaleString('ko-KR');

    $('sal-gross').textContent = kr(sum.gross);
    $('sal-deduct').textContent = kr(sum.deductTotal);
    $('sal-net').textContent = kr(sum.net);

    // 口径标识：让用户清楚看到这个月是「实算」还是「工资条固定值」
    $('sal-mode').innerHTML = mode === 'attendance'
      ? `<span class="mode-tag live">예상 · 按当月考勤实算</span>
         <em>出勤天数、加班、夜班补助、扣除均随考勤变动，非固定值</em>`
      : `<span class="mode-tag fixed">확정 · 工资条固定口径</span>
         <em>기본급 按月薪计薪工时固定，用于与工资条逐笔核对</em>`;

    // 发薪日：每月 17 日，逢周末提前至周五
    const pd = Salary.payDateFor(y, m, p.payDay || 17);
    $('sal-payday').innerHTML = `<span>급여일 发薪日</span>
      <b>${y}년 ${pd.label}</b>
      <em>${pd.adjusted
        ? `원래 ${m}/${pd.origin} 이 주말 → 앞당김（原 ${pd.origin} 日逢周末，提前发放）`
        : `정상 正常（매월 ${pd.origin}일）`}</em>`;

    // 工资条表头信息
    $('sal-meta').innerHTML = [
      p.empNo && `사번<b>${p.empNo}</b>`,
      p.name && `성명<b>${p.name}</b>`,
      p.dept && `부서<b>${p.dept}</b>`,
      (p.jobTitle || p.position) && `직급<b>${p.jobTitle || p.position}</b>`,
      p.hireDate && `입사일<b>${p.hireDate}</b>`,
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
    const attRows = [
      ['출근일수 出勤天数', `${sum.workDays}일`],
      ['총근로시간 总工时', `${sum.workHours.toFixed(1)}h`],
      ['초과근로시간 加班', `${sum.otHours.toFixed(1)}h`]
    ];
    if (mode === 'attendance') {
      attRows.push(
        ['야간근로일 夜班天数', `${sum.nightDays}일`],
        ['야간근로시간 夜班工时', `${sum.nightHours.toFixed(1)}h`],
        ['휴일근로 节假日出勤', `${sum.holidayWorkDays}일`],
        ['공휴일수당 法定假日工资', `${sum.holidayPayDays || 0}일`],
        ['주휴수당 周差', `${sum.weeklyCount || 0}회`],
        ['연차 有薪年假', `${sum.annualDays}일`],
        ['휴식·결근 休息/缺勤', `${sum.restDays}일`]
      );
    } else {
      attRows.push(
        ['야간근로시간 夜班', `${sum.nightHours.toFixed(1)}h`],
        ['휴식일 休息', `${sum.restDays}일`]
      );
    }
    $('sal-attendance').innerHTML = attRows
      .map(([k, v]) => `<div class="rowline"><span>${k}</span><b>${v}</b></div>`).join('');

    // 퇴직금（평균임금 = 最近 3 个完整月应发总额 ÷ 3 个月实际天数，法定口径）
    let sevTotal = 0, sevDays = 0;
    for (let i = 1; i <= 3; i++) {
      const d0 = new Date(now.getFullYear(), now.getMonth() - i, 1);
      const yy = d0.getFullYear(), mm = d0.getMonth() + 1;
      const mk = `${yy}-${String(mm).padStart(2, '0')}`;
      const slip = Store.getPayslip(mk);
      const g = slip ? Number(slip.gross) || 0
        : Salary.calcMonth(yy, mm, { mode: 'slip' }).gross;
      sevTotal += g;
      sevDays += new Date(yy, mm, 0).getDate();
    }
    const sev = Salary.severance(p.hireDate, now, { total: sevTotal, days: sevDays });
    $('sal-severance').innerHTML = sev.ok
      ? `<div class="rowline"><span>근속기간 工龄</span><b>${sev.note}</b></div>
         <div class="rowline"><span>최근 3개월 最近 3 个月应发</span><b>${kr(sevTotal)}원 / ${sevDays}일</b></div>
         <div class="rowline"><span>1일 평균임금 日均工资</span><b>${kr(sev.dailyAvgWage)}원</b></div>
         <div class="rowline total"><span>예상 퇴직금 预计退职金</span><b>${sev.eligible ? kr(sev.amount) + '원' : '—'}</b></div>
         <div class="hint">${sev.eligible
          ? '法定口径：1일 평균임금（最近 3 个月应发 ÷ 实际天数）× 30일 × 재직일수 ÷ 365。实际金额以公司结算为准。'
          : '需在司满 1 年（365 日）才产生法定退职金。'}</div>`
      : `<div class="hint">${sev.note}。请到【设置 → 직원档案】填写 입사일 入职日期。</div>`;

    // 当月按考勤实算时，若所得税仍是「采用工资条固定税额」，给个明确提示
    if (mode === 'attendance' && sum.taxIsFixed) {
      $('sal-deductions').insertAdjacentHTML('afterbegin',
        `<div class="hint warn">所得税沿用工资条固定值 ${kr(sum.incomeTax)}원；
         当月预估建议到【设置 → 소득세】改为「按 6 级累进估算」。</div>`);
    }
  }

  /* ---------- 核对 ---------- */
  function bindSalary() {
    $('btn-check').onclick = () => {
      const [y, m] = salMonth.split('-').map(Number);
      const now = new Date();
      const sum = Salary.calcMonth(y, m, { mode: Salary.payrollModeFor(y, m, now), now });
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
    $('set-pay-day').value = p.payDay || 17;

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

    // 班次时间
    const sh = s.shift || {};
    $('set-weekly-work-days').value = sh.weeklyWorkDays ?? 5;
    $('set-day-start').value = sh.dayStart || '08:20';
    $('set-day-end').value = sh.dayEnd || '20:20';
    $('set-night-shift-start').value = sh.nightStart || '20:20';
    $('set-night-shift-end').value = sh.nightEnd || '08:20';
    $('set-rest-minutes').value = s.restMinutes ?? 30;
    $('set-mon-late').checked = sh.monLateStart !== false;
    $('set-mon-start').value = sh.monDayStart || '10:20';
    $('set-fri-early').checked = sh.friEarlyEnd !== false;
    $('set-fri-end').value = sh.friNightEnd || '06:20';
    $('mon-start-field').style.display = $('set-mon-late').checked ? 'flex' : 'none';
    $('fri-end-field').style.display = $('set-fri-early').checked ? 'flex' : 'none';

    // 日薪结构
    const dp = s.dailyPay || {};
    $('set-std-hours').value = dp.stdHours ?? 8;
    $('set-fixed-ot').value = dp.fixedOtHours ?? 3.5;
    $('set-night-allow-h').value = dp.nightAllowHours ?? 3.5;
    $('set-night-allow-rate').value = dp.nightAllowRate ?? 0.5;
    $('set-holiday-mul').value = dp.holidayMultiplier ?? 1.5;
    $('set-annual-paid').checked = dp.annualLeavePaid !== false;

    // 出勤判定
    $('set-holiday-source').value = s.holidaySource || 'builtin';
    $('set-include-labour').checked = s.includeLabourDay !== false;
    $('set-late-grace').value = s.lateGrace ?? 5;
    $('set-early-grace').value = s.earlyGrace ?? 5;
    $('set-holidays').value = (s.holidays || []).join(',');
    const rw = Array.isArray(s.restWeekdays) ? s.restWeekdays : [0];
    if (!$('set-rest-weekdays').children.length) {
      $('set-rest-weekdays').innerHTML = ['日', '一', '二', '三', '四', '五', '六']
        .map((t, i) => `<button data-wd="${i}">${t}</button>`).join('');
    }
    $('set-rest-weekdays').querySelectorAll('button').forEach(b => {
      b.classList.toggle('on', rw.includes(Number(b.dataset.wd)));
    });
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
    renderStandaloneHint();
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
    const bindProfile = (id, key, after) => bindField(id, e => {
      Store.profile[key] = e.target.value; Store.save(); after && after();
    });
    const bindProfileNum = (id, key, min, max, after) => bindField(id, e => {
      const v = Number(e.target.value);
      if (!Number.isFinite(v) || v < min || v > max) { toast(`请输入 ${min}–${max} 之间的数值`); return; }
      Store.profile[key] = v; Store.save(); after && after();
    });
    /** 写入 settings 的嵌套对象（如 shift.* / dailyPay.*） */
    const bindSub = (id, group, key, cast, after) => bindField(id, e => {
      const g = st()[group] || (st()[group] = {});
      g[key] = cast === 'num' ? Number(e.target.value) : e.target.value;
      Store.save(); after && after();
    });

    // 员工档案（全部可自由修改）
    bindProfile('set-emp-no', 'empNo', renderSalary);
    bindProfile('set-name', 'name', renderSalary);
    bindProfile('set-dept', 'dept', renderSalary);
    bindProfile('set-job-title', 'jobTitle', renderSalary);
    // 入职日期关联退职金，改动后要刷新月薪页
    bindProfile('set-hire-date', 'hireDate', renderSalary);
    bindProfileNum('set-pay-day', 'payDay', 1, 31, renderSalary);

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

    // ---- 班次时间 ----
    const refreshAtt = () => { renderCalendar(); renderAttendance(); };
    const refreshAll = () => { renderCalendar(); renderAttendance(); renderSalary(); };
    bindSub('set-weekly-work-days', 'shift', 'weeklyWorkDays', 'num', refreshAtt);
    bindSub('set-day-start', 'shift', 'dayStart', 'str', refreshAtt);
    bindSub('set-day-end', 'shift', 'dayEnd', 'str', refreshAtt);
    bindSub('set-night-shift-start', 'shift', 'nightStart', 'str', refreshAtt);
    bindSub('set-night-shift-end', 'shift', 'nightEnd', 'str', refreshAtt);
    bindNum('set-rest-minutes', 'restMinutes', () => {
      // 休息扣除改动要同步到历史记录，否则旧记录仍按旧值算工时
      Object.keys(Store.attendance).forEach(k => { Store.attendance[k].restMinutes = st().restMinutes; });
      Store.save(); refreshAll();
    });
    $('set-mon-late').onchange = e => {
      st().shift.monLateStart = e.target.checked; Store.save();
      $('mon-start-field').style.display = e.target.checked ? 'flex' : 'none';
      refreshAtt();
    };
    bindSub('set-mon-start', 'shift', 'monDayStart', 'str', refreshAtt);
    $('set-fri-early').onchange = e => {
      st().shift.friEarlyEnd = e.target.checked; Store.save();
      $('fri-end-field').style.display = e.target.checked ? 'flex' : 'none';
      refreshAtt();
    };
    bindSub('set-fri-end', 'shift', 'friNightEnd', 'str', refreshAtt);

    // ---- 日薪结构 ----
    bindSub('set-std-hours', 'dailyPay', 'stdHours', 'num', renderSalary);
    bindSub('set-fixed-ot', 'dailyPay', 'fixedOtHours', 'num', renderSalary);
    bindSub('set-night-allow-h', 'dailyPay', 'nightAllowHours', 'num', renderSalary);
    bindSub('set-night-allow-rate', 'dailyPay', 'nightAllowRate', 'num', renderSalary);
    bindSub('set-holiday-mul', 'dailyPay', 'holidayMultiplier', 'num', renderSalary);
    $('set-annual-paid').onchange = e => {
      st().dailyPay.annualLeavePaid = e.target.checked; Store.save(); renderSalary();
    };

    // ---- 出勤判定规则 ----
    bindField('set-holiday-source', e => {
      st().holidaySource = e.target.value; Store.save(); refreshAtt();
    });
    $('set-include-labour').onchange = e => {
      st().includeLabourDay = e.target.checked; Store.save(); refreshAtt();
    };
    bindNum('set-late-grace', 'lateGrace', refreshAtt);
    bindNum('set-early-grace', 'earlyGrace', refreshAtt);
    bindField('set-holidays', e => {
      st().holidays = e.target.value.split(/[,，\s]+/).map(s => s.trim())
        .filter(s => /^\d{4}-\d{2}-\d{2}$/.test(s));
      Store.save(); refreshAtt();
    });
    // 周休日：按钮由 renderSettings 动态生成，这里用事件委托绑定
    $('set-rest-weekdays').onclick = e => {
      const b = e.target.closest('button[data-wd]');
      if (!b) return;
      const wd = Number(b.dataset.wd);
      const cur = Array.isArray(st().restWeekdays) ? st().restWeekdays.slice() : [];
      const i = cur.indexOf(wd);
      if (i >= 0) cur.splice(i, 1); else cur.push(wd);
      st().restWeekdays = cur.sort((x, y) => x - y);
      Store.save(); renderSettings(); refreshAtt();
    };
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
  // 离开公司区域不做事：一次签到 = 一整天，没有签退概念
  GeoPunch.setHandler((type, payload) => {
    if (type === 'enter' && st().autoPunch) punchIn(true);
    else if (type === 'enter') $('punch-desc').textContent = '已在公司区域内';
    else if (type === 'error') toast('📍 ' + payload);
    else if (type === 'nofence') $('punch-desc').textContent = '请先到【设置】配置公司位置';
  });

  /* ---------- 启动 ---------- */
  function init() {
    bindToday(); bindSalary(); bindSettings(); bindCalendar();
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
