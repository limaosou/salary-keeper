# 工资通 · Cloudflare Workers 版（不用自己的域名，还能共享给同事）

这是**给别人用**时推荐的部署方式。相比自己 VPS 那套（`server/README.md`）：

| | Workers 版 | 自己的 VPS |
|---|---|---|
| 域名 | Cloudflare 免费给 `xxx.workers.dev` | 要掏自己的域名 |
| HTTPS | 自带证书 | 要申请 Let's Encrypt |
| 费用 | 0 元，免信用卡 | 服务器已经在花钱 |
| 运维 | 无（不用装 node、不用 pm2、不用 nginx 反代） | 要自己守着 |
| 服务器负载 | 不占你的机器 | 占 |

**免费额度（2026-10 核对，Cloudflare 可能调整，以官网为准）**：

- Workers 请求：**10 万次/天**
- Workers KV：读 **10 万次/天**、写 **1000 次/天**、存储 **1 GB**

每个人一天只有 2 次打卡请求（进出各一次），月底同步一次。粗略算：
**二三百个人用才会摸到 KV 写入上限**，普通同事圈远远到不了。

---

## 架构一句话

```
手机（锁屏，什么都不打开）
  └─ 快捷指令「获取 URL 内容」→ https://salary-keeper.xxx.workers.dev/api/punch?token=每人不同&t=in
                                     │
                          Cloudflare 全球边缘节点
                                     │
                                     ▼
                       Workers KV（按令牌哈希分桶存放）
```

页面本身**不用部署**，继续用 GitHub Pages 那份：
`https://limaosou.github.io/salary-keeper/`

> 服务器上**只有打卡时间戳**，没有任何工资数据（工资全在手机本地算）。
> 这也是敢把它共享出去的底气。

---

## 第 1 步：注册 Cloudflare 并建 Worker

不用装命令行，全程网页点：

1. 打开 `https://dash.cloudflare.com/sign-up` 注册（免费账号即可，**不用填信用卡**）
2. 左侧 **Workers 和 Pages**（英文界面是 Workers & Pages）→ **创建** → **创建 Worker**
3. 名字填 `salary-keeper`，点 **部署**
4. 部署完点 **编辑代码**，把 `worker.js` 里的内容**全选替换**进去，点右上角 **部署**

做完会拿到一个地址，记下来：

```
https://salary-keeper.<你的子域>.workers.dev
```

浏览器打开它，看到一段 JSON（`{"ok":true,"service":"工资通打卡接口"...}`）就说明跑起来了。

---

## 第 2 步：建 KV 并绑定

打卡流水存在 Workers KV 里，得先开一个：

1. 左侧 **存储和数据库** → **Workers KV** → **创建命名空间**
2. 名字填 `salary-keeper-punches` → 创建 → 复制它的 **命名空间 ID**
3. 回到你的 Worker → **设置** → **变量和机密** → **绑定** → **添加绑定**
   - 类型选 **KV 命名空间**
   - 变量名必须叫 **`PUNCHES`**（代码里写死的，一个字母都不能差）
   - KV 命名空间选刚建的那个
4. 保存 → 回到 **概览** 确认已生效

---

## 第 3 步：设环境变量和邀请码

还在 **设置 → 变量和机密** 页面：

| 名称 | 类型 | 值 | 说明 |
|---|---|---|---|
| `TZ_OFFSET` | 变量（Plaintext） | `9` | 韩国是 9，中国是 8。**错了会把打卡记到前一天** |
| `INVITE` | **机密（Secret）** | 自己编一串，如 `woxxim2026` | 别人领令牌要输这个；设成机密，面板上看不到明文 |
| `SINGLE_TOKEN` | 机密 | **不要填** | 填了就变单人模式，只你自己能用 |

> 只有 `INVITE` 用「机密」类型才安全——填成明文变量的话，任何拿到 Cloudflare 面板的人都能看见。

---

## 第 4 步：自己先验证一遍

在自己电脑上跑（把域名换成你的）：

```bash
W=https://salary-keeper.<你的子域>.workers.dev

# 1) 服务活着吗（不用带 token）
curl "$W/"
#    期望 {"ok":true,"service":"工资通打卡接口","mode":"multi",...}

# 2) 领一个令牌（把 woxxim2026 换成你设的邀请码）
curl -X POST "$W/api/register?invite=woxxim2026"
#    期望 {"ok":true,"token":"<32位十六进制>",...}

# 3) 用这个令牌打一次卡，再查回来验证隔离
TOK=上一步拿到的token
curl "$W/api/punch?token=$TOK&t=in"
curl "$W/api/health?token=$TOK"
#    期望 days=1
```

顺手确认一下：

```bash
# 不存在的令牌应当被拒
curl "$W/api/health?token=nope"
#    期望 {"ok":false,"error":"token 不对或太短（至少要 12 位）"}
```

---

## 第 5 步：发给同事三样东西

就这三行，复制给他就行：

```
页面：https://limaosou.github.io/salary-keeper/
服务器地址：https://salary-keeper.<你的子域>.workers.dev
邀请码：woxxim2026
```

**同事那边要做的**（约 5 分钟）：

1. Safari 打开上面的「页面」→ 分享 → **添加到主屏幕**（名字保持「工资通」）
2. 打开工资通 → **设置 → 云端打卡**：
   - 服务器地址：粘贴上面第二行
   - 邀请码：粘贴上面第三行
   - 点 **🔑 申领令牌** → 令牌自动填好并开启同步
3. 点 **测试连接** → 出现 `✅ 连接成功` 就通了
4. 页面会自动生成「签到地址 / 签退地址」两行，各点一次复制
5. 快捷指令 → **自动化** → 到达/离开公司 → 动作选 **「获取 URL 内容」** → 各贴一条 → **关掉「运行前询问」**

> ⚠️ 令牌只存在他自己的手机里。**提醒他导出一次备份**（设置最下面「数据 → 导出备份」），
> 否则换了手机或清了 Safari 数据，服务器上的打卡流水就取不回来了——App 里已经有一条红色提示盯着这事。

---

## 第 6 步：日常维护

**看有几个人在用 / 想导出数据**（需要命令行 `wrangler`，或有它的朋友帮忙）：

```bash
npx wrangler kv key list --binding=PUNCHES --namespace-id=<命名空间ID>
# 每个 key 形如 u:<令牌哈希>，就是一个人

npx wrangler kv key get "u:<某个key>" --binding=PUNCHES --namespace-id=<ID> --text
```

**更新代码**：Worker 编辑页里改完点「部署」即可，10 秒内全球生效。

**把某个人踢出去**：光改邀请码没用（他已经拿到令牌了）。要真踢：删掉他那个 KV key。

**换邀请码**：就算 invalidating 旧的，也只影响以后新人。所以邀请码别到处贴。

**备份**：整个账本就是 KV 里的那些 key。想备份就用上面的 `wrangler kv key get` 逐个拉下来存文件。

---

## 常见问题

**Q：Workers 的免费额度会不会突然用完？**
一个人一天 2 次打卡请求。二三百人才摸到 KV 写入上限（1000/天）。
真超了 Cloudflare 会返回错误而非扣费——免费账号不会被意外收费。

**Q：同事说「测试连接」失败？**
按顺序查：① 服务器地址有没有多粘斜杠（结尾不要带 `/`）；
② 手机浏览器直接打开 `<服务器地址>/` 能看到 JSON 吗（看不到就是地址或 DNS 问题）；
③ `TZ_OFFSET` 是不是设成了 `9`。

**Q：快捷指令跑了但服务器没记录？**
三点：自动化是不是设成「立即运行」（勾了「运行前询问」就会卡在弹窗）；
动作是不是「获取 URL 内容」（不能是打开 URL / 打开 App）；
以及 iOS 的「到达」判定本身有几十米误差，围栏范围别设太小。

**Q：页面会不会被别人看到我的数据？**
不会。所有工资数据都在各自手机浏览器里；服务器上只有时间戳，
而且按令牌哈希分桶，没令牌连自己的都读不出来。

**Q：不想用 Cloudflare，还能怎么办？**
看 `server/README.md`——自建服务器那份同样支持多人模式（`MODE=multi` + `INVITE`），
接口完全一样，App 那边操作也完全一样，只是要你自己出域名和服务器。

---

## 附：命令行部署（可选）

习惯用命令的话，`workers/` 目录下配一次就行：

```bash
npx wrangler login
# 把 wrangler.toml 里的 id 换成你的 KV 命名空间 ID
npx wrangler secret put INVITE        # 交互式输入邀请码
npx wrangler deploy
```
