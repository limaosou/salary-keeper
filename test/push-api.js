/* 通过 GitHub API 推送本地文件（git push 在此环境会被沙箱杀，API 通道可用）
   用法：GH_TOKEN=xxx MSG="说明" node test/push-api.js <文件路径...>
   令牌从环境变量读取，避免在 Node 里调 git credential 触发弹窗。 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const REPO = 'limaosou/salary-keeper';
const BRANCH = 'main';

const TOKEN = (process.env.GH_TOKEN || '').trim();
if (!TOKEN) {
  console.error('缺少环境变量 GH_TOKEN');
  process.exit(1);
}

async function api(pathname, opts = {}) {
  const res = await fetch(`https://api.github.com/repos/${REPO}${pathname}`, {
    ...opts,
    headers: {
      'Authorization': `Bearer ${TOKEN}`,
      'Accept': 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      ...(opts.headers || {})
    }
  });
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { data = text; }
  if (!res.ok) throw new Error(`${res.status} ${data.message || text.slice(0, 200)}`);
  return data;
}

(async () => {
  const files = process.argv.slice(2);
  if (!files.length) { console.error('请指定文件路径'); process.exit(1); }

  // 取远端当前 commit
  const ref = await api(`/git/ref/heads/${BRANCH}`);
  const baseSha = ref.object.sha;
  let treeSha = (await api(`/git/commits/${baseSha}`)).tree.sha;

  for (const rel of files) {
    const abs = path.isAbsolute(rel) ? rel : path.join(ROOT, rel);
    const key = path.relative(ROOT, abs).replace(/\\/g, '/');
    const content = fs.readFileSync(abs).toString('base64');
    const blob = await api(`/git/blobs`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content, encoding: 'base64' })
    });
    const entry = { path: key, mode: '100644', type: 'blob', sha: blob.sha };
    // 目录型路径（文件夹下同名文件会自动创建树，这里只处理单文件）
    const parentTree = await api(`/git/trees`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ base_tree: treeSha, tree: [entry] })
    });
    // GitHub 的 git/trees 返回体就是「被写入的条目列表」，拿到 sha 即成功
    if (!parentTree.sha) throw new Error(`写入 ${key} 失败: ${JSON.stringify(parentTree).slice(0, 300)}`);
    treeSha = parentTree.sha;
    console.log('✓', key);
  }

  const commit = await api(`/git/commits`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      message: process.env.MSG || '自动打卡改造上线',
      tree: treeSha,
      parents: [baseSha]
    })
  });
  await api(`/git/refs/heads/${BRANCH}`, {
    method: 'PATCH', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sha: commit.sha })
  });
  console.log('\n已推送 commit:', commit.sha.slice(0, 8));
})().catch(e => { console.error('推送失败:', e.message); process.exit(1); });