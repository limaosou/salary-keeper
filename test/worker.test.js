/* Cloudflare Workers 版后端实测
 *
 * worker.js 是 ESM（export default），项目里没有 package.json 声明 module，
 * 所以这里把源码复制成一个临时的 .mjs 再 import — 靠扩展名让 Node 按 ESM 解析，
 * 既不用在仓库里加构建配置，也不会污染源码目录。KV 用内存 Map 模拟。
 *
 * 用法： node test/worker.test.js
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

let tmpMjs = '';
function cleanup() { try { tmpMjs && fs.unlinkSync(tmpMjs); } catch (e) { /* 已删就不管 */ } }
process.on('exit', cleanup);

let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => {
  cond ? pass++ : fail++;
  console.log(`${cond ? '✅' : '❌'} ${name}${extra ? '  ' + extra : ''}`);
};

/** 模拟 Cloudflare KV：get(k,{type:'json'}) / put / delete */
function fakeKV() {
  const m = new Map();
  return {
    _m: m,
    async get(k, opts) {
      const v = m.get(k);
      if (v === undefined) return null;
      return (opts && opts.type === 'json') ? JSON.parse(v) : v;
    },
    async put(k, v) { m.set(k, String(v)); },
    async delete(k) { m.delete(k); }
  };
}

async function loadWorker() {
  const src = fs.readFileSync(path.join(__dirname, '..', 'workers', 'worker.js'), 'utf8');
  tmpMjs = path.join(os.tmpdir(), `salary-keeper-worker-${process.pid}.mjs`);
  fs.writeFileSync(tmpMjs, src);
  const mod = await import('file:///' + tmpMjs.replace(/\\/g, '/'));
  return mod.default;
}

async function call(worker, env, url, opts = {}) {
  const res = await worker.fetch(new Request(url, opts), env);
  const text = await res.text();
  let body = null;
  try { body = JSON.parse(text); } catch (e) { body = text; }
  return { status: res.status, body };
}

(async () => {
  const worker = await loadWorker();
  const API = 'https://sk.example.workers.dev';
  const INVITE = 'hi2026';

  console.log('\n──── 一、服务与跨域 ────');
  {
    const env = { PUNCHES: fakeKV(), INVITE, TZ_OFFSET: '9' };
    const root = await call(worker, env, API + '/');
    ok('根路径返回服务说明', root.body && root.body.service === '工资通打卡接口', JSON.stringify(root.body).slice(0, 60));
    ok('根路径标出多人模式', root.body && root.body.mode === 'multi', root.body && root.body.mode);
    const pre = await call(worker, env, API + '/api/punch', { method: 'OPTIONS' });
    ok('OPTIONS 预检返回 204', pre.status === 204, String(pre.status));
    const unknown = await call(worker, env, API + '/api/nope?token=0123456789abcdef');
    ok('未知接口返回 404', unknown.status === 404, String(unknown.status));
  }

  console.log('\n──── 二、领令牌 ────');
  let t1 = '', t2 = '';
  {
    const env = { PUNCHES: fakeKV(), INVITE, TZ_OFFSET: '9' };
    const getTry = await call(worker, env, API + '/api/register?invite=' + INVITE);
    ok('GET 领令牌被拒（必须 POST）', getTry.status === 405, String(getTry.status));

    const bad = await call(worker, env, API + '/api/register?invite=wrong', { method: 'POST' });
    ok('邀请码不对 → 401', bad.status === 401, bad.body.error);

    const a = await call(worker, env, API + '/api/register?invite=' + INVITE, { method: 'POST' });
    const b = await call(worker, env, API + '/api/register?invite=' + INVITE, { method: 'POST' });
    ok('领令牌成功并返回 32 位十六进制', /^[0-9a-f]{32}$/.test(a.body.token || ''), a.body.token);
    ok('两个人拿到不同令牌', a.body.token !== b.body.token, `${a.body.token.slice(0, 8)} vs ${b.body.token.slice(0, 8)}`);
    t1 = a.body.token; t2 = b.body.token;
  }

  console.log('\n──── 三、数据按令牌隔离 ────');
  {
    const env = { PUNCHES: fakeKV(), INVITE, TZ_OFFSET: '9' };
    await call(worker, env, `${API}/api/punch?token=${t1}&t=in`);
    await call(worker, env, `${API}/api/punch?token=${t1}&t=out`);

    const mine = await call(worker, env, `${API}/api/health?token=${t1}`);
    const other = await call(worker, env, `${API}/api/health?token=${t2}`);
    ok('甲这边能看到 1 天记录', mine.body.days === 1, String(mine.body.days));
    ok('乙这边是 0 天', other.body.days === 0, String(other.body.days));

    const leak = await call(worker, env, `${API}/api/punches?token=${t2}`);
    ok('乙拉不到甲的任何打卡流水', Object.keys(leak.body.days).length === 0, JSON.stringify(leak.body.days));

    // KV 的 key 里不能出现原始令牌，否则 Cloudflare 面板上一眼就能看到别人的密钥
    const keys = Array.from(env.PUNCHES._m.keys());
    ok('KV 的 key 不含原始令牌', !keys.some(k => k.includes(t1)), keys.join(',').slice(0, 60));
  }

  console.log('\n──── 四、鉴权与参数校验 ────');
  {
    const env = { PUNCHES: fakeKV(), INVITE, TZ_OFFSET: '9' };
    const short = await call(worker, env, `${API}/api/health?token=abc`);
    ok('令牌太短被拒', short.status === 401, short.body.error);
    const none = await call(worker, env, `${API}/api/health`);
    ok('不带令牌被拒', none.status === 401, none.body.error);
    const badType = await call(worker, env, `${API}/api/punch?token=${t1}&t=xxx`);
    ok('t 参数非法 → 400', badType.status === 400, badType.body.error);
  }

  console.log('\n──── 五、时区与流水 ────');
  {
    // TZ_OFFSET=0 时，服务端算出的「今天」应当正好是 UTC 日期
    const env = { PUNCHES: fakeKV(), INVITE, TZ_OFFSET: '0' };
    const h = await call(worker, env, `${API}/api/health?token=${t1}`);
    const utcDay = new Date().toISOString().slice(0, 10);
    ok('TZ_OFFSET=0 时按 UTC 计日', h.body.serverDay === utcDay, `${h.body.serverDay} vs ${utcDay}`);
    ok('health 回显 tzOffset', h.body.tzOffset === 0, String(h.body.tzOffset));
  }
  {
    const env = { PUNCHES: fakeKV(), INVITE, TZ_OFFSET: '9' };
    const p = await call(worker, env, `${API}/api/punch?token=${t1}&t=in`);
    ok('打卡返回当天日期与时间戳', /^\d{4}-\d{2}-\d{2}$/.test(p.body.day) && /T\d{2}:\d{2}:\d{2}$/.test(p.body.stamp),
      `${p.body.day} ${p.body.stamp}`);
    const again = await call(worker, env, `${API}/api/punch?token=${t1}&t=in`);
    ok('3 分钟内重复打卡被忽略', again.body.ignored === true, again.body.reason);

    const list = await call(worker, env, `${API}/api/punches?token=${t1}&month=${p.body.day.slice(0, 7)}`);
    ok('按月筛选能拉到当天', Object.keys(list.body.days).length >= 1, JSON.stringify(Object.keys(list.body.days)));
    const wrongMonth = await call(worker, env, `${API}/api/punches?token=${t1}&month=1999-01`);
    ok('查不存在的月份返回空', Object.keys(wrongMonth.body.days).length === 0, '');
  }

  console.log('\n──── 六、纠错与清空 ────');
  {
    const env = { PUNCHES: fakeKV(), INVITE, TZ_OFFSET: '9' };
    const p = await call(worker, env, `${API}/api/punch?token=${t1}&t=in`);
    const cleared = await call(worker, env, `${API}/api/clear?token=${t1}&day=${p.body.day}`);
    ok('清指定某天返回该日期', cleared.body.cleared === p.body.day, cleared.body.cleared);
    const after = await call(worker, env, `${API}/api/health?token=${t1}`);
    ok('清完这天就没数据了', after.body.days === 0, String(after.body.days));
  }

  console.log('\n──── 七、单人模式（只给自己用）────');
  {
    const env = { PUNCHES: fakeKV(), SINGLE_TOKEN: 'myPrivateToken', TZ_OFFSET: '9' };
    const health = await call(worker, env, `${API}/api/health?token=myPrivateToken`);
    ok('单人模式 health 正常', health.status === 200 && health.body.mode === 'single', String(health.status));
    const wrong = await call(worker, env, `${API}/api/health?token=nope`);
    ok('单人模式错误令牌被拒', wrong.status === 401, String(wrong.status));
    const reg = await call(worker, env, API + '/api/register', { method: 'POST' });
    ok('单人模式不发放令牌 → 403', reg.status === 403, reg.body.error);
    await call(worker, env, `${API}/api/punch?token=myPrivateToken&t=in`);
    ok('单人模式数据落在 default 桶', Array.from(env.PUNCHES._m.keys()).some(k => k.includes('default')),
      Array.from(env.PUNCHES._m.keys()).join(','));
  }

  console.log(`\n结果: ${pass} 通过, ${fail} 失败`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('测试异常:', e); process.exit(1); });
