/**
 * 工资通 · Cloudflare Workers 版（纯接口，不托管页面）
 *
 * 给自己用、或者共享给同事用，只要这一个小段代码：
 *   - 免费额度足够：Workers 每天 10 万次请求，KV 每天 10 万次读 + 1000 次写（详见 Cloudflare 官方限额）
 *     一个人一天只有 2 次打卡请求，几百个人用都还在免费档
 *   - 自带 https://xxx.workers.dev 域名和 HTTPS 证书，不用自己的域名
 *   - 免信用卡、不用运维、没有冷启动
 *
 * 页面本身继续用 GitHub Pages 那份（纯静态），这里只管记账。
 * 两边都是 HTTPS，跨域靠 Access-Control-Allow-Origin: * 放行。
 *
 * 数据隔离：每个人的令牌不同 → 哈希不同 → KV 里的 key 不同，互相读不到。
 * 服务器上从来只有打卡时间戳，没有任何工资数据。
 *
 * 需要的绑定（wrangler.toml 或面板里配）：
 *   PUNCHES        KV 命名空间，用来存打卡流水
 *   SINGLE_TOKEN   可选。填了就是「单人模式」；不填是「多人模式」，可自助领令牌
 *   INVITE         多人模式的邀请码（建议设，用 Secret 存）
 *   TZ_OFFSET      公司所在时区偏移，默认 9（韩国）
 */

const MIN_TOKEN_LEN = 12;

/* ---------------- 工具 ---------------- */

const json = (obj, status = 200) => new Response(JSON.stringify(obj), {
  status,
  headers: {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    'Cache-Control': 'no-store'
  }
});

async function sha256Hex(s) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
}

/** 令牌 → 存储桶名。返回 null 表示鉴权失败 */
function bucketOf(rawToken, mode, env) {
  const t = String(rawToken || '');
  if (mode === 'single') return t && t === env.SINGLE_TOKEN ? 'default' : null;
  return t.length >= MIN_TOKEN_LEN ? t : null;   // 多人模式下直接拿令牌本身参与哈希
}

/** 多人模式：桶名再过一层哈希，避免原始令牌出现在 key 里 */
async function keyOf(bucket, mode) {
  return 'u:' + (mode === 'single' ? 'default' : (await sha256Hex('salary-keeper:' + bucket)).slice(0, 32));
}

const loadData = async (env, bucket, mode) =>
  (await env.PUNCHES.get(await keyOf(bucket, mode), { type: 'json' })) || {};

const saveData = async (env, bucket, mode, d) =>
  env.PUNCHES.put(await keyOf(bucket, mode), JSON.stringify(d));

/* ---------------- 时间：按公司时区算「今天」 ---------------- */

function zonedNow(offsetHours) {
  const now = new Date();
  const utc = now.getTime() + now.getTimezoneOffset() * 60000;
  return new Date(utc + offsetHours * 3600000);
}

const p2 = n => String(n).padStart(2, '0');

const stampOf = d => `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}` +
  `T${p2(d.getHours())}:${p2(d.getMinutes())}:${p2(d.getSeconds())}`;

const dayKeyOf = d => `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`;

/* ---------------- 接口 ---------------- */

async function apiRegister(env, mode, q) {
  if (mode === 'single') return json({ ok: false, error: '当前服务端是单人模式，不发放令牌' }, 403);
  if (env.INVITE && q.get('invite') !== env.INVITE) {
    return json({ ok: false, error: '邀请码不对' }, 401);
  }
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  const token = Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
  return json({ ok: true, token, note: '请立刻保存，丢失无法找回' });
}

async function apiPunch(env, bucket, mode, q, tzOffset) {
  const type = (q.get('t') || '').toLowerCase();
  if (type !== 'in' && type !== 'out') {
    return json({ ok: false, error: 't 只能是 in 或 out' }, 400);
  }

  const now = zonedNow(tzOffset);
  const day = dayKeyOf(now);
  const stamp = stampOf(now);

  const data = await loadData(env, bucket, mode);
  const list = data[day] || (data[day] = []);

  // 防抖：同一天最后一笔同类型且间隔 < 3 分钟，视为快捷指令重复触发，忽略
  const last = list.length ? list[list.length - 1] : null;
  if (last && last.type === type) {
    const lastMs = Date.parse(String(last.t).replace(' ', 'T'));
    const nowMs = Date.parse(stamp);
    if (!isNaN(lastMs) && Math.abs(nowMs - lastMs) < 3 * 60 * 1000) {
      return json({ ok: true, ignored: true, reason: '3 分钟内重复，已忽略', day, list });
    }
  }

  // 连续两次 in（或两次 out）时，自动补上反向记录，避免配对错位
  if (last && last.type === type) {
    list.push({ t: stamp, type: type === 'in' ? 'out' : 'in', auto: true });
  }

  list.push({ t: stamp, type });
  await saveData(env, bucket, mode, data);

  return json({ ok: true, day, stamp, type, list });
}

async function apiPunches(env, bucket, mode, q, tzOffset) {
  const data = await loadData(env, bucket, mode);
  const month = q.get('month');
  let out = data;
  if (month) {
    out = {};
    for (const k of Object.keys(data)) if (k.startsWith(month)) out[k] = data[k];
  }
  return json({ ok: true, month: month || 'all', days: out, tzOffset });
}

async function apiHealth(env, bucket, mode, tzOffset) {
  const now = zonedNow(tzOffset);
  const data = await loadData(env, bucket, mode);
  return json({
    ok: true,
    mode,
    serverTime: stampOf(now),
    serverDay: dayKeyOf(now),
    tzOffset,
    days: Object.keys(data).length
  });
}

async function apiClear(env, bucket, mode, q) {
  const day = q.get('day');
  const data = await loadData(env, bucket, mode);
  if (!day) { await saveData(env, bucket, mode, {}); return json({ ok: true, cleared: 'all' }); }
  delete data[day];
  await saveData(env, bucket, mode, data);
  return json({ ok: true, cleared: day });
}

/* ---------------- 入口 ---------------- */

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        status: 204,
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Headers': 'Content-Type',
          'Access-Control-Allow-Methods': 'GET,POST,OPTIONS'
        }
      });
    }

    const mode = env.SINGLE_TOKEN ? 'single' : 'multi';
    const tzOffset = Number(env.TZ_OFFSET || 9);
    const u = new URL(request.url);
    const p = u.pathname;
    const q = u.searchParams;

    // 领令牌不需要带 token
    if (p === '/api/register') {
      if (request.method !== 'POST') {
        return json({ ok: false, error: '请用 POST 请求 /api/register' }, 405);
      }
      return apiRegister(env, mode, q);
    }

    if (!p.startsWith('/api/')) {
      return json({
        ok: true,
        service: '工资通打卡接口',
        mode,
        hint: mode === 'multi'
          ? '页面请用 https://limaosou.github.io/salary-keeper/ ，在这里 POST /api/register 领令牌'
          : '页面请在你自己的服务器上打开'
      });
    }

    const bucket = bucketOf(q.get('token'), mode, env);
    if (!bucket) {
      return json({
        ok: false,
        error: mode === 'single'
          ? 'token 不对'
          : `token 不对或太短（至少要 ${MIN_TOKEN_LEN} 位）`
      }, 401);
    }

    if (p === '/api/punch') return apiPunch(env, bucket, mode, q, tzOffset);
    if (p === '/api/punches') return apiPunches(env, bucket, mode, q, tzOffset);
    if (p === '/api/health') return apiHealth(env, bucket, mode, tzOffset);
    if (p === '/api/clear') return apiClear(env, bucket, mode, q);

    return json({ ok: false, error: '没有这个接口' }, 404);
  }
};
