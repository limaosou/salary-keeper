/**
 * 云端同步：把自建服务器上的打卡流水，合并成本地考勤记录
 *
 * 背景：iPhone 锁屏会拦截「打开 App / 打开 URL」，但「获取 URL 内容」
 * （纯网络请求）不受限制。所以快捷指令在到达/离开公司时，只发一个 HTTP 请求
 * 把 in/out 记到服务器；这里负责在你看工资时把流水拉回来，还原成 segments。
 *
 * 服务器那边的数据结构（按天分组的流水）：
 *   { "2026-10-19": [ {t:"2026-10-19T08:22:31", type:"in"},
 *                     {t:"2026-10-19T20:25:02", type:"out"} ] }
 */
(function (global) {
  'use strict';

  // 注意：storage.js 里的 Store 是顶层 const，只存在于全局词法环境，
  // 不会成为 window 的属性（window.Store === undefined）。这里必须直接引用。
  const S = () => (typeof Store !== 'undefined' ? Store : null);
  const cfg = () => {
    const s = S();
    return (s && s.settings && s.settings.cloud) || {};
  };

  const isOn = () => {
    const c = cfg();
    return !!(c.enabled && c.url && c.token);
  };

  const baseUrl = () => String(cfg().url || '').replace(/\/+$/, '');
  const token = () => String(cfg().token || '');

  /** 服务器存的是「公司当地时间」字符串，转成本地 Date 需补上时区偏移 */
  function toDate(stamp, tzOffset) {
    const s = String(stamp).trim().replace(' ', 'T');
    // 已带时区（Z 或 ±hh:mm）就直接解析
    if (/[Zz]$|[+-]\d{2}:?\d{2}$/.test(s)) return new Date(s);
    const off = Number.isFinite(Number(tzOffset)) ? Number(tzOffset) : 9;
    const sign = off < 0 ? '-' : '+';
    const hh = String(Math.abs(Math.trunc(off))).padStart(2, '0');
    const mm = String(Math.round((Math.abs(off) % 1) * 60)).padStart(2, '0');
    return new Date(`${s}${sign}${hh}:${mm}`);
  }

  /** 流水 → segments：in 开一段，out 闭合最近未闭合的一段 */
  function toSegments(list, tzOffset) {
    const arr = (list || []).slice().sort((a, b) => String(a.t).localeCompare(String(b.t)));
    const segs = [];
    let cur = null;
    for (const it of arr) {
      const type = String(it.type || '').toLowerCase();
      const iso = toDate(it.t, tzOffset).toISOString();
      if (type === 'in') {
        if (cur) segs.push(cur);          // 上一个 in 没配到 out，先收起来
        cur = { in: iso, out: null };
      } else if (type === 'out') {
        if (cur && !cur.out) { cur.out = iso; segs.push(cur); cur = null; }
        // 孤立的 out 直接丢弃，无法配对
      }
    }
    if (cur) segs.push(cur);               // 没签退的那段保留（页面会显示打卡中）
    return segs.filter(s => s.in);
  }

  async function request(path, params = {}) {
    const qs = Object.assign({ token: token() }, params);
    const query = Object.keys(qs)
      .filter(k => qs[k] !== undefined && qs[k] !== '')
      .map(k => `${encodeURIComponent(k)}=${encodeURIComponent(qs[k])}`)
      .join('&');
    const url = `${baseUrl()}${path}?${query}`;

    const res = await fetch(url, { method: 'GET', cache: 'no-store', mode: 'cors' });
    if (!res.ok) throw new Error(`服务器返回 ${res.status}`);
    const json = await res.json();
    if (json && json.ok === false) throw new Error(json.error || '服务器拒绝');
    return json;
  }

  /** 连通性自检 */
  async function ping() {
    if (!isOn()) return { ok: false, error: '还没填服务器地址和令牌' };
    try {
      const r = await request('/api/health');
      return { ok: true, serverDay: r.serverDay, serverTime: r.serverTime, days: r.days };
    } catch (e) {
      return { ok: false, error: e.message || String(e) };
    }
  }

  /**
   * 拉取某月（不传月份则拉全部）并合并到本地考勤。
   * 合并策略：云端流水是真实进出记录，覆盖当天的 segments；
   * 但保留本地的手工补签、请假、绩效、班次等字段，避免覆盖人工设定。
   */
  async function sync(month) {
    if (!isOn()) return { ok: false, error: '还没填服务器地址和令牌', changed: 0 };

    let json;
    try {
      json = await request('/api/punches', month ? { month } : {});
    } catch (e) {
      return { ok: false, error: e.message || String(e), changed: 0 };
    }

    const days = (json && json.days) || {};
    const tz = Number.isFinite(Number(cfg().tzOffset)) ? Number(cfg().tzOffset) : 9;
    let changed = 0;

    for (const dayKey of Object.keys(days)) {
      const list = days[dayKey];
      if (!Array.isArray(list) || !list.length) continue;
      const segs = toSegments(list, tz);
      if (!segs.length) continue;

      const rec = S().day(dayKey);
      const before = JSON.stringify(rec.segments || []);
      rec.segments = segs;
      if (JSON.stringify(rec.segments) !== before) changed++;
      // 打卡流水来自真实进出，说明这天是出勤日
      if (rec.isRestDay && !rec.manualRest) rec.isRestDay = false;
    }

    const c = cfg();
    c.lastSyncAt = new Date().toISOString();
    c.lastSyncCount = Object.keys(days).length;
    S().save();

    return { ok: true, changed, days: Object.keys(days).length, month: month || 'all' };
  }

  /**
   * 多人模式自助领令牌：POST /api/register?invite=xxx
   * 领到后直接写进设置并开启同步，不用再手抄一遍。
   */
  async function register(invite) {
    const base = baseUrl();
    if (!base) return { ok: false, error: '先填服务器地址' };

    const inv = String(invite || '').trim();
    const url = `${base}/api/register` + (inv ? `?invite=${encodeURIComponent(inv)}` : '');
    try {
      const res = await fetch(url, { method: 'POST', cache: 'no-store', mode: 'cors' });
      const json = await res.json().catch(() => null);
      if (!res.ok) return { ok: false, error: (json && json.error) || `服务器返回 ${res.status}` };
      if (!json || json.ok === false) return { ok: false, error: (json && json.error) || '服务器拒绝' };
      if (!json.token) return { ok: false, error: '服务器没返回令牌' };

      const c = cfg();
      c.token = json.token;
      c.enabled = true;
      S().save();
      return { ok: true, token: json.token };
    } catch (e) {
      return { ok: false, error: e.message || String(e) };
    }
  }

  /** 给快捷指令用的两个地址（t=in / t=out） */
  function punchUrls() {
    if (!isOn()) return { in: '', out: '' };
    const q = `?token=${encodeURIComponent(token())}&t=`;
    return { in: `${baseUrl()}/api/punch${q}in`, out: `${baseUrl()}/api/punch${q}out` };
  }

  global.CloudSync = { isOn, ping, sync, punchUrls, register, toSegments, toDate, cfg };
})(window);
