#!/usr/bin/env node
/**
 * 工资通 · 自建服务器版
 *
 * 一个文件做两件事：
 *   1. 静态托管「工资通」站点（index.html / css / js / icons / sw.js）
 *   2. 提供打卡记账接口，供 iPhone 快捷指令在「到达/离开公司」时调用
 *
 * 为什么这样就不用打开 App 了：
 *   iOS 锁屏会拦截「打开 App / 打开 URL」这类需要界面的动作，
 *   但「获取 URL 内容」是纯网络请求，锁屏下照样执行。
 *   所以快捷指令不打开任何东西，只发一个 HTTP 请求把打卡记下来。
 *
 * 零依赖，Node 18+ 直接跑：
 *   node server.js
 *
 * ── 两种运行模式 ──
 *
 *   single（单人）：环境变量给了 TOKEN，或 config.json 里已有 token。
 *                   只有这一个令牌能用，数据落在 punches.json。适合自己用。
 *
 *   multi（多人）：既没给 TOKEN、config.json 里也没有历史 token。
 *                  每个人用 POST /api/register 领一个随机令牌，
 *                  数据按令牌哈希分桶落在 users/<hash>.json，互相读不到。
 *                  适合把同一个后端共享给同事。
 *
 * 环境变量：
 *   MODE        single | multi，不填则按上面规则自动判定
 *   PORT        监听端口，默认 8080
 *   HOST        监听地址，默认 127.0.0.1（只允许本机反代，公网打不开，更安全）
 *   TOKEN       单人模式的访问令牌
 *   INVITE      多人模式的邀请码；不填则任何人都能领令牌（会打印警告）
 *   TZ_OFFSET   公司所在时区偏移（小时），默认 9（韩国）
 *   PUBLIC_DIR  工资通站点目录，默认本文件所在目录的上一级
 *   DATA_DIR    打卡数据目录，建议放在网站根目录之外，避免被 nginx 直接下载
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = Number(process.env.PORT || 8080);
const HOST = process.env.HOST || '127.0.0.1';
const TZ_OFFSET = Number(process.env.TZ_OFFSET || 9);
const PUBLIC_DIR = path.resolve(process.env.PUBLIC_DIR || path.join(__dirname, '..'));
const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(__dirname, 'data'));
const USERS_DIR = path.join(DATA_DIR, 'users');
const DATA_FILE = path.join(DATA_DIR, 'punches.json');
const CFG_FILE = path.join(DATA_DIR, 'config.json');
const INVITE = process.env.INVITE || '';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.txt': 'text/plain; charset=utf-8'
};

/** 多人模式下令牌的最短长度，防止有人拿 "123" 这种当令牌撞进别人的桶 */
const MIN_TOKEN_LEN = 12;

/* ---------------- 运行模式判定 ---------------- */

function readRootConfig() {
  try { return JSON.parse(fs.readFileSync(CFG_FILE, 'utf8')) || {}; }
  catch (e) { return {}; }
}

function writeRootConfig(cfg) {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(CFG_FILE, JSON.stringify(cfg, null, 2));
}

// 单点模式往下兼容：历史上 config.json 里已经有 token 的安装，升级后仍然是单人模式，
// 不会静默切换导致原来记的数据读不出来。
const MODE = (() => {
  const forced = String(process.env.MODE || '').toLowerCase();
  if (forced === 'single' || forced === 'multi') return forced;
  if (process.env.TOKEN) return 'single';
  return readRootConfig().token ? 'single' : 'multi';
})();

let SINGLE_TOKEN = '';
if (MODE === 'single') {
  const root = readRootConfig();
  SINGLE_TOKEN = process.env.TOKEN || root.token || crypto.randomBytes(12).toString('hex');
  if (SINGLE_TOKEN !== root.token) {
    writeRootConfig(Object.assign({}, root, { token: SINGLE_TOKEN }));
    console.log('  已生成访问令牌: ' + SINGLE_TOKEN);
  }
}

/** 令牌 → 存储桶。返回 null 表示鉴权失败 */
function bucketOf(rawToken) {
  const t = String(rawToken || '');
  if (MODE === 'single') return t && t === SINGLE_TOKEN ? 'default' : null;
  // 多人模式：任意一个够长的令牌都天然是一个桶，不需要事先注册到名单里
  return t.length >= MIN_TOKEN_LEN
    ? crypto.createHash('sha256').update('salary-keeper:' + t).digest('hex').slice(0, 32)
    : null;
}

/* ---------------- 存储 ---------------- */

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function fileOf(bucket) {
  return bucket === 'default' ? DATA_FILE : path.join(USERS_DIR, bucket + '.json');
}

function loadData(bucket) {
  ensureDir(path.dirname(fileOf(bucket)));
  try { return JSON.parse(fs.readFileSync(fileOf(bucket), 'utf8')) || {}; }
  catch (e) { return {}; }
}

function saveData(bucket, d) {
  ensureDir(path.dirname(fileOf(bucket)));
  fs.writeFileSync(fileOf(bucket), JSON.stringify(d, null, 2));
}

/* ---------------- 时间：按公司时区算「今天」 ---------------- */

function zonedNow(offsetHours) {
  const now = new Date();
  const utc = now.getTime() + now.getTimezoneOffset() * 60000;
  return new Date(utc + offsetHours * 3600000);
}

const p2 = n => String(n).padStart(2, '0');

function stampOf(d) {
  return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}` +
    `T${p2(d.getHours())}:${p2(d.getMinutes())}:${p2(d.getSeconds())}`;
}

function dayKeyOf(d) {
  return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`;
}

/* ---------------- HTTP ---------------- */

const sendJSON = (res, code, obj) => {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Cache-Control': 'no-store'
  });
  res.end(body);
};

/** 记一笔打卡。GET /api/punch?token=xxx&t=in|out */
function apiPunch(bucket, res, q) {
  const type = (q.get('t') || '').toLowerCase();
  if (type !== 'in' && type !== 'out') {
    return sendJSON(res, 400, { ok: false, error: 't 只能是 in 或 out' });
  }

  const now = zonedNow(TZ_OFFSET);
  const day = dayKeyOf(now);
  const stamp = stampOf(now);

  const data = loadData(bucket);
  const list = data[day] || (data[day] = []);

  // 防抖：同一天最后一笔同类型且间隔 < 3 分钟，视为快捷指令重复触发，忽略
  const last = list.length ? list[list.length - 1] : null;
  if (last && last.type === type) {
    const lastMs = Date.parse(last.t.replace(' ', 'T'));
    const nowMs = Date.parse(stamp);
    if (!isNaN(lastMs) && Math.abs(nowMs - lastMs) < 3 * 60 * 1000) {
      return sendJSON(res, 200, { ok: true, ignored: true, reason: '3 分钟内重复，已忽略', day, list });
    }
  }

  // 连续两次 in（或两次 out）时，自动补上反向记录，避免配对错位
  if (last && last.type === type) {
    list.push({ t: stamp, type: type === 'in' ? 'out' : 'in', auto: true });
  }

  list.push({ t: stamp, type });
  saveData(bucket, data);

  console.log(`  [打卡] ${bucket.slice(0, 8)} ${day} ${stamp} ${type}`);
  sendJSON(res, 200, { ok: true, day, stamp, type, list });
}

/** 取某月（或全部）记录。GET /api/punches?token=xxx&month=2026-10 */
function apiPunches(bucket, res, q) {
  const data = loadData(bucket);
  const month = q.get('month');
  let out = data;
  if (month) {
    out = {};
    for (const k of Object.keys(data)) if (k.startsWith(month)) out[k] = data[k];
  }
  sendJSON(res, 200, { ok: true, month: month || 'all', days: out, tzOffset: TZ_OFFSET });
}

/** 连通性自检。GET /api/health?token=xxx */
function apiHealth(bucket, res) {
  const now = zonedNow(TZ_OFFSET);
  sendJSON(res, 200, {
    ok: true,
    mode: MODE,
    serverTime: stampOf(now),
    serverDay: dayKeyOf(now),
    tzOffset: TZ_OFFSET,
    days: Object.keys(loadData(bucket)).length
  });
}

/** 删除某天记录（纠错用）。GET /api/clear?token=xxx&day=2026-10-19 */
function apiClear(bucket, res, q) {
  const day = q.get('day');
  const data = loadData(bucket);
  if (!day) { saveData(bucket, {}); return sendJSON(res, 200, { ok: true, cleared: 'all' }); }
  delete data[day];
  saveData(bucket, data);
  sendJSON(res, 200, { ok: true, cleared: day });
}

/** 多人模式领令牌。POST /api/register?invite=xxx */
function apiRegister(res, q) {
  if (MODE === 'single') {
    return sendJSON(res, 403, { ok: false, error: '当前服务端是单人模式，不发放令牌' });
  }
  const invite = q.get('invite') || '';
  if (INVITE && invite !== INVITE) {
    return sendJSON(res, 401, { ok: false, error: '邀请码不对' });
  }
  // 32 位十六进制 ≈ 128 bit，撞不出别人的桶
  const token = crypto.randomBytes(16).toString('hex');
  console.log(`  [注册] 新令牌 ${token.slice(0, 8)}… 已发放`);
  sendJSON(res, 200, { ok: true, token, note: '请立刻保存，丢失无法找回' });
}

/** 静态文件托管 */
function serveStatic(res, pathname) {
  let rel = decodeURIComponent(pathname);
  if (rel === '/' || rel === '') rel = '/index.html';

  const target = path.join(PUBLIC_DIR, path.normalize(rel).replace(/^([/\\])+/, ''));
  // 防目录穿越
  if (!target.startsWith(PUBLIC_DIR)) { res.writeHead(403); return res.end('forbidden'); }
  // 不暴露源码与隐私目录
  if (/(^|[\\/])(\.git|\.workbuddy|server|node_modules|tmp)([\\/]|$)/.test(rel)) {
    res.writeHead(404); return res.end('not found');
  }

  fs.readFile(target, (err, buf) => {
    if (err) {
      // SPA 兜底：未知路径回首页
      return fs.readFile(path.join(PUBLIC_DIR, 'index.html'), (e2, b2) => {
        if (e2) { res.writeHead(404); return res.end('not found'); }
        res.writeHead(200, { 'Content-Type': MIME['.html'] });
        res.end(b2);
      });
    }
    const ext = path.extname(target).toLowerCase();
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Cache-Control': ext === '.html' ? 'no-cache' : 'public, max-age=3600'
    });
    res.end(buf);
  });
}

/** 令牌无效时的统一答复。单人/多人的提示不同，便于排查 */
function denyHint() {
  return MODE === 'single'
    ? 'token 不对'
    : `token 不对或太短（至少要 ${MIN_TOKEN_LEN} 位）`;
}

const server = http.createServer((req, res) => {
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Access-Control-Allow-Methods': 'GET,POST,OPTIONS'
    });
    return res.end();
  }

  const u = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const p = u.pathname;
  const q = u.searchParams;

  // 领令牌不需要带 token
  if (p === '/api/register') {
    if (req.method !== 'POST') {
      return sendJSON(res, 405, { ok: false, error: '请用 POST 请求 /api/register' });
    }
    return apiRegister(res, q);
  }

  if (!p.startsWith('/api/')) return serveStatic(res, p);   // 静态页面不看令牌

  const bucket = bucketOf(q.get('token'));
  if (!bucket) return sendJSON(res, 401, { ok: false, error: denyHint() });

  if (p === '/api/punch') return apiPunch(bucket, res, q);
  if (p === '/api/punches') return apiPunches(bucket, res, q);
  if (p === '/api/health') return apiHealth(bucket, res);
  if (p === '/api/clear') return apiClear(bucket, res, q);
  return serveStatic(res, p);
});

server.listen(PORT, HOST, () => {
  const shown = HOST === '0.0.0.0' ? '<你的服务器IP>' : HOST;
  const base = `http://${shown}:${PORT}`;
  console.log('\n  工资通服务端已启动\n');
  console.log('  运行模式   ' + (MODE === 'single' ? '单人（一个令牌）' : '多人（各自令牌，互不可见）'));
  console.log('  监听地址   ' + HOST + ':' + PORT + (HOST === '0.0.0.0' ? '  ← 公网可直接访问' : '  ← 公网请让 nginx 反代过来'));
  console.log('  站点地址   ' + base + '/');
  if (MODE === 'single') {
    console.log('  打卡接口   ' + base + '/api/punch?token=' + SINGLE_TOKEN + '&t=in');
    console.log('  同步接口   ' + base + '/api/punches?token=' + SINGLE_TOKEN + '&month=2026-10');
  } else {
    console.log('  领令牌     POST ' + base + (INVITE ? '/api/register?invite=<邀请码>' : '/api/register'));
    console.log('  邀请码     ' + (INVITE ? '已设置' : '未设置 —— 任何人都能领令牌，建议设置环境变量 INVITE'));
  }
  console.log('  公司时区   UTC+' + TZ_OFFSET);
  console.log('  数据文件   ' + (MODE === 'single' ? DATA_FILE : USERS_DIR + '/<令牌哈希>.json'));
  console.log('\n  把「打卡接口」那两行（t=in / t=out）填进 iPhone 快捷指令的「获取 URL 内容」即可\n');

  if (MODE === 'multi' && !INVITE) {
    console.log('  ⚠  多人模式没设 INVITE，任何人都能领令牌。共享给同事前请先设置邀请码\n');
  }
});
