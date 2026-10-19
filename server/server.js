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
 * 可选环境变量：
 *   PORT        监听端口，默认 8080
 *   TOKEN       访问令牌，不填则首次启动自动生成并写入 data/config.json
 *   TZ_OFFSET   公司所在时区偏移（小时），默认 9（韩国）
 *   PUBLIC_DIR  工资通站点目录，默认本文件所在目录的上一级
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = Number(process.env.PORT || 8080);
const TZ_OFFSET = Number(process.env.TZ_OFFSET || 9);
const PUBLIC_DIR = path.resolve(process.env.PUBLIC_DIR || path.join(__dirname, '..'));
const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(__dirname, 'data'));
const DATA_FILE = path.join(DATA_DIR, 'punches.json');
const CFG_FILE = path.join(DATA_DIR, 'config.json');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.txt': 'text/plain; charset=utf-8'
};

/* ---------------- 存储 ---------------- */

function ensureDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}

function loadConfig() {
  ensureDir();
  let cfg = {};
  try { cfg = JSON.parse(fs.readFileSync(CFG_FILE, 'utf8')); } catch (e) { cfg = {}; }
  if (!cfg.token) {
    cfg.token = process.env.TOKEN || crypto.randomBytes(12).toString('hex');
    fs.writeFileSync(CFG_FILE, JSON.stringify(cfg, null, 2));
    console.log('  已生成访问令牌: ' + cfg.token);
  } else if (process.env.TOKEN && process.env.TOKEN !== cfg.token) {
    cfg.token = process.env.TOKEN;
    fs.writeFileSync(CFG_FILE, JSON.stringify(cfg, null, 2));
  }
  return cfg;
}

function loadData() {
  ensureDir();
  try { return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')); } catch (e) { return {}; }
}

function saveData(d) {
  ensureDir();
  fs.writeFileSync(DATA_FILE, JSON.stringify(d, null, 2));
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
function apiPunch(req, res, q) {
  if (q.get('token') !== CFG.token) return sendJSON(res, 401, { ok: false, error: 'token 不对' });

  const type = (q.get('t') || '').toLowerCase();
  if (type !== 'in' && type !== 'out') {
    return sendJSON(res, 400, { ok: false, error: 't 只能是 in 或 out' });
  }

  const now = zonedNow(TZ_OFFSET);
  const day = dayKeyOf(now);
  const stamp = stampOf(now);

  const data = loadData();
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
  saveData(data);

  console.log(`  [打卡] ${day} ${stamp} ${type}${q.get('debug') ? ' (debug)' : ''}`);
  sendJSON(res, 200, { ok: true, day, stamp, type, list });
}

/** 取某月（或全部）记录。GET /api/punches?token=xxx&month=2026-10 */
function apiPunches(req, res, q) {
  if (q.get('token') !== CFG.token) return sendJSON(res, 401, { ok: false, error: 'token 不对' });

  const data = loadData();
  const month = q.get('month');
  let out = data;
  if (month) {
    out = {};
    for (const k of Object.keys(data)) if (k.startsWith(month)) out[k] = data[k];
  }
  sendJSON(res, 200, { ok: true, month: month || 'all', days: out, tzOffset: TZ_OFFSET });
}

/** 连通性自检。GET /api/health?token=xxx */
function apiHealth(req, res, q) {
  if (q.get('token') !== CFG.token) return sendJSON(res, 401, { ok: false, error: 'token 不对' });
  const now = zonedNow(TZ_OFFSET);
  sendJSON(res, 200, {
    ok: true,
    serverTime: stampOf(now),
    serverDay: dayKeyOf(now),
    tzOffset: TZ_OFFSET,
    days: Object.keys(loadData()).length
  });
}

/** 删除某天记录（纠错用）。GET /api/clear?token=xxx&day=2026-10-19 */
function apiClear(req, res, q) {
  if (q.get('token') !== CFG.token) return sendJSON(res, 401, { ok: false, error: 'token 不对' });
  const day = q.get('day');
  const data = loadData();
  if (!day) { saveData({}); return sendJSON(res, 200, { ok: true, cleared: 'all' }); }
  delete data[day];
  saveData(data);
  sendJSON(res, 200, { ok: true, cleared: day });
}

/** 静态文件托管 */
function serveStatic(req, res, pathname) {
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

const CFG = loadConfig();

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

  if (p === '/api/punch') return apiPunch(req, res, u.searchParams);
  if (p === '/api/punches') return apiPunches(req, res, u.searchParams);
  if (p === '/api/health') return apiHealth(req, res, u.searchParams);
  if (p === '/api/clear') return apiClear(req, res, u.searchParams);
  return serveStatic(req, res, p);
});

server.listen(PORT, '0.0.0.0', () => {
  console.log('\n  工资通服务端已启动\n');
  console.log('  站点地址   http://<你的服务器IP>:' + PORT + '/');
  console.log('  打卡接口   http://<你的服务器IP>:' + PORT + '/api/punch?token=' + CFG.token + '&t=in');
  console.log('  同步接口   http://<你的服务器IP>:' + PORT + '/api/punches?token=' + CFG.token + '&month=2026-10');
  console.log('  公司时区   UTC+' + TZ_OFFSET);
  console.log('  数据文件   ' + DATA_FILE + '\n');
  console.log('  把上面「打卡接口」那两行（t=in / t=out）填进 iPhone 快捷指令的「获取 URL 内容」即可\n');
});
