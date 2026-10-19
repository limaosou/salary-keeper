# 工资通 · 宝塔服务器部署

针对**宝塔面板（BT Panel）+ `/www/wwwroot/` 多站点**的环境写成。同一个服务器上已有其他网站和域名时，
按本文的目录、端口、反代三处安排就能共存，不影响已有站点。

一句话架构：

```
手机（锁屏状态）
   └─ iPhone 快捷指令「获取 URL 内容」→ https://你的域名/api/punch?token=xxx&t=in
                                            │
                          nginx（宝塔现有站点）80/443
                                            │ 反代
                                            ▼
                            node 工资通服务端 127.0.0.1:8080  ← 只监听本机，公网打不到
                                            │
                                            ▼
                    /www/wwwroot/salary-keeper-data/punches.json
```

**关键点**：node 只监听 `127.0.0.1`，公网只能经 nginx 进来。这样既不用开放新端口，
也不用担心别人绕过 nginx 直接扫端口；`punches.json` 放在 `wwwroot` **之外**，nginx 根本看不到它。

---

## 第 1 步：先看服务器现状（别跳过）

面板里确认三件事，避免后面返工：

| 查什么 | 在哪看 | 记下来 |
|---|---|---|
| 已占用的端口 | 终端 `ss -tlnp \| grep LISTEN` | 8080 是否被占；被占就换（如 8091） |
| 有没有可用子域名 | 面板 → 网站 → 现有站点的域名 | 有的话直接用它的子域，如 `gz.example.com` |
| 面板与系统 | 终端 `cat /etc/os-release` | 后续命令按你的系统调整 |

> ⚠️ **端口冲突是最常见的翻车点**。宝塔自身默认占用 8888（面板）、80、443、3306、6379 等。
> 用 `ss -tlnp` 看一眼 8080 是否空闲，被占就换端口，别硬起。

---

## 第 2 步：放代码（目录安排）

`/www/wwwroot/` 下的每个子目录通常对应一个站点。我们的代码**只占一个独立目录**，
数据另放一处，避免和已有站点的静态文件混在一起。

```bash
# 1) 建站点目录并放代码（假设你已有域名，指向这个目录）
#    面板 → 网站 → 添加站点，目录填 /www/wwwroot/salary-keeper
cd /www/wwwroot/salary-keeper

# 2) 上传文件：只要这些，不要把整个 git 历史和其他站点文件拖进来
#    index.html  js/  css/  icons/  sw.js  manifest.json  server/
#    最省事：在你自己的电脑上推 GitHub，然后服务器上
#      git clone https://github.com/limaosou/salary-keeper.git /www/wwwroot/salary-keeper
```

**目录结构应该是这样：**

```
/www/wwwroot/
├── (你原来的站点目录…)          ← 不要动
├── salary-keeper/               ← 工资通站点根（nginx 指向这里）
│   ├── index.html
│   ├── js/  css/  icons/
│   ├── sw.js  manifest.json
│   └── server/server.js
└── (其他站点…)

/www/wwwroot/salary-keeper-data/   ← 单独放这里，见第 3 步
└── punches.json  config.json
```

> **为什么要把数据放外面**：`/www/wwwroot/salary-keeper/` 是站点根目录，
> nginx 会把里面任何文件都当静态文件发出去。虽然 `server.js` 内部已经拦截了
> `server/` 目录的访问，但宝塔还会给站点配「防跨站攻击」和默认的目录规则，
> 多一层目录隔离最保险。

---

## 第 3 步：常驻运行（宝塔两种方式，选一种）

### 方式 A：宝塔「Node 项目」插件（推荐，图形化）

装了 Node 版本管理器的话，用这个最省心：

1. 面板左侧 **Node 项目**（或「网站 → Node 项目」）→ 添加项目
2. 项目目录：`/www/wwwroot/salary-keeper/server`
3. 启动选项：`server.js`
4. 项目端口：`8080`
5. 环境变量（点「添加」，一行一个）：

   ```
   PORT=8080
   HOST=127.0.0.1
   TZ_OFFSET=9
   TOKEN=你自己设的一串长口令
   DATA_DIR=/www/wwwroot/salary-keeper-data
   ```

   > 这一组是**单人模式**（只有你自己能用）。要让同事一起用，
   > 把 `TOKEN` 换成 `INVITE=邀请码` 并加上 `MODE=multi`，见下面「进阶：共享给同事」。

6. 保存后点 **启动**，日志里会打印 token 和三行地址

> Node 版本要选 **18 或以上**。宝塔的 Node 项目插件能直接选版本，不用自己编译。

### 方式 B：PM2（如果服务器上有 PM2，或你习惯命令行）

```bash
# 宝塔的 node 常常不在 /usr/bin/node，先找出来
which node || ls -d /www/server/nodejs/*/bin/node

# 用绝对路径启动（宝塔环境不要用 `node` 裸命令）
cd /www/wwwroot/salary-keeper
HOST=127.0.0.1 PORT=8080 TZ_OFFSET=9 \
DATA_DIR=/www/wwwroot/salary-keeper-data \
TOKEN=你自己设的长口令 \
pm2 start server/server.js --name salary-keeper --cwd /www/wwwroot/salary-keeper

pm2 save && pm2 startup   # 保存并开机自启
pm2 logs salary-keeper   # 看日志
```

启动成功后日志会打印（把 `你的域名` 换成实际值）：

```
  站点地址   http://127.0.0.1:8080/
  打卡接口   http://127.0.0.1:8080/api/punch?token=xxxx&t=in
  数据文件   /www/wwwroot/salary-keeper-data/punches.json
```

**token 自己设**：在终端 `openssl rand -hex 16` 生成一串，记下来，手机配置要用。

---

## 第 4 步：给现有域名加反向代理

这是让手机能访问的关键。两种情况：

### 情况 1：用子域名（推荐，如 `gz.example.com`）

1. 面板 → **网站** → 添加站点
   - 域名：`gz.example.com`
   - 根目录：随便填 `/www/wwwroot/salary-keeper`（反代后根目录不参与实际服务）
   - PHP 版本：**纯静态**
2. 站点设置 → **反向代理** → 添加反向代理
   - 代理名称：`salary`
   - 目标 URL：`http://127.0.0.1:8080`
   - 发送域名：`$host`
3. 保存后浏览器打开 `http://gz.example.com/` 应该能看到工资通首页

### 情况 2：挂在已有站点的子路径上

比如已有 `example.com`，想用 `example.com/gz/`：

在**已有站点**的配置里加一个 location（面板 → 站点设置 → 配置文件，或直接编辑
`/www/server/panel/vhost/nginx/<你的站点>.conf`）：

```nginx
location /gz/ {
    proxy_pass http://127.0.0.1:8080/;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
}
```

> 注意 `proxy_pass` 末尾**带斜杠**：`/gz/` + `http://127.0.0.1:8080/` 会把前缀剥掉，
> node 那边收到的就是 `/`。少了斜杠会 404。

子路径方案会改动已有站点的配置，**改前先备份**（面板有「配置备份」，或
`cp <站点>.conf <站点>.conf.bak`）。**能用子域名就别用子路径**，互相不干扰。

改完必须重载：

```bash
nginx -t && bt reload      # 宝塔的 nginx 是这个路径
# 或：/www/server/nginx/sbin/nginx -t && /www/server/nginx/sbin/nginx -s reload
```

`nginx -t` 报错就**不要 reload**，先改对。

---

## 第 5 步：HTTPS（iPhone 强烈建议）

iOS 对混合内容限制很严：**HTTPS 页面不能请求 HTTP 接口**。
你现有域名多半已经有证书，直接用就行。

- 已有 HTTPS → 直接 `https://你的域名/`
- 没配 → 面板 → 站点 → **SSL** → Let's Encrypt 免费证书 → 一键申请

服务端不用改任何代码，nginx 反代后自动就是 HTTPS 了。

---

## 第 6 步：手机端配置

1. Safari 打开 `https://你的域名/` → 添加到主屏幕（名字填「工资通」）
2. 工资通 → 设置 → **云端打卡**：

   | 字段 | 填什么 |
   |---|---|
   | 启用云端打卡 | 开 |
   | 服务器地址 | `https://你的域名`（**不带路径、不带斜杠**） |
   | 访问令牌 | 第 3 步里的 token |
   | 公司时区 | `9` |

3. 点「**测试连接**」→ 出现 `✅ 连接成功` 就通了
4. 页面会自动生成「签到地址 / 签退地址」两行，各点一次复制

> ⚠️ 不要再用 GitHub Pages 那个地址去连这个服务器：两个域名不同源，
> 而且一个是 HTTPS、一个可能是 HTTP，会被浏览器拦。**页面和接口同源最省事。**

---

## 第 7 步：配快捷指令（锁屏能跑的关键）

快捷指令 App → **自动化** → 新建：

| 项 | 填什么 |
|---|---|
| 触发 | **到达** → 地点选公司 → 范围 200 米左右 |
| 动作 | **获取 URL 内容**（不是「打开 URL」，也不是「打开 App」） |
| URL | 工资通设置页里「签到地址」那一行 |
| 运行前询问 | **关掉** |

再建一个一模一样的，触发改成 **离开**，URL 用「签退地址」。

> **为什么必须是「获取 URL 内容」**：它是纯网络请求，不需要唤起界面，
> 锁屏、锁屏口袋、深夜都能静默执行。「打开 URL」「打开 App」都要界面，锁屏必被系统拦。

---

## 第 8 步：验收清单

在服务器终端逐条跑，全过才算部署好：

```bash
TOKEN=你的token
# 1) 服务活着吗
curl "http://127.0.0.1:8080/api/health?token=$TOKEN"
#    期望 {"ok":true,...}

# 2) 反代通了吗（把域名换成你的）
curl "https://你的域名/api/health?token=$TOKEN"
#    同样返回 ok:true —— 这步过了才说明 nginx 配对了

# 3) 首页能打开吗
curl -s -o /dev/null -w "%{http_code}\n" "https://你的域名/"
#    期望 200

# 4) 数据文件没被 nginx 暴露（必须 404 或 403）
curl -s -o /dev/null -w "%{http_code}\n" "https://你的域名/server/data/punches.json"
#    期望 404/403；如果返回 200，说明数据目录暴露了，回头检查目录安排

# 5) 打卡能写进去吗
curl "https://你的域名/api/punch?token=$TOKEN&t=in"
curl "https://你的域名/api/punches?token=$TOKEN&month=$(date +%Y-%m)"
```

然后真机验证：拿手机到公司门口等一会儿，回工资通点「立即同步打卡」，看到今天的签到时间就算成功。

---

## 第 9 步：备份与维护

**数据备份**（就一个目录，建议加到宝塔的计划任务）：

```bash
# 手动备份
tar czf ~/salary-backup-$(date +%F).tar.gz -C /www/wwwroot salary-keeper-data

# 每天凌晨 3:17 自动备份（避免整点与其他任务撞车）
# 面板 → 计划任务 → Shell 脚本 → 填上面那条命令
```

**更新代码**（GitHub 有更新时）：

```bash
cd /www/wwwroot/salary-keeper
git pull
# 静态文件刷新即生效；node 服务端若改过，重启一下
pm2 restart salary-keeper      # 或在 Node 项目面板点「重启」
```

数据在 `/www/wwwroot/salary-keeper-data/`，`git pull` 不会碰它。

**同服务器多站点的注意事项**：

- 端口要唯一（`ss -tlnp` 查），别撞上面已有的服务
- 别把 8080 加进宝塔防火墙的放行列表——反代走 80/443，不需要额外端口
- 别改 nginx 的 `default.conf` / `nginx.conf` 主配置，只动自己站点的 `.conf`
- 改任何配置前先备份：`cp x.conf x.conf.bak`

---

## 进阶：把这个后端共享给同事（多人模式）

一台服务器可以很多人共用，**每个人一个令牌，数据互相读不到**。不用改代码，只换启动参数：

```bash
# 关键：不要设 TOKEN，改设 INVITE；MODE 显式写 multi 最保险
MODE=multi INVITE=你编的邀请码 PORT=8080 \
DATA_DIR=/www/wwwroot/salary-keeper-data \
node server/server.js
```

启动日志会变成：

```
运行模式   多人（各自令牌，互不可见）
领令牌     POST http://127.0.0.1:8080/api/register?invite=<邀请码>
```

**同事那边**：设置 → 云端打卡 → 填服务器地址 + 邀请码 → 点「🔑 申领令牌」，
令牌自动填好。之后跟着做快捷指令就行，和你自己配的流程一模一样。

数据落在 `DATA_DIR/users/<令牌哈希>.json`，一个人一个文件：

```bash
ls /www/wwwroot/salary-keeper-data/users/     # 有几个人就有几个文件
```

> ⚠️ **令牌丢了就取不回来**（服务器上只存哈希，反推不出原值）。
> 让每个人在 App 里至少导出一次备份。
>
> ⚠️ 邀请码只影响「新人能不能领令牌」，**改邀请码不会让已领的人失效**。
> 真要停掉某个人，删掉他那个 `users/<hash>.json`（他就看不到自己的历史了，
> 但还能继续写入新记录——对付恶意用户得在 nginx 层封 IP）。

**不想自己维护服务器**？用 `workers/README.md` 那套 Cloudflare 版：
免费 `xxx.workers.dev` 域名、免运维、免信用卡，接口和这里完全一致。

---

## 常见问题

**Q：反代后打开是 502 Bad Gateway？**
node 没起来，或端口不对。`pm2 logs salary-keeper` 看日志；`ss -tlnp | grep 8080`
确认端口在听。宝塔 Node 项目面板里也要看「项目日志」有没有启动报错。

**Q：`nginx -t` 报 `location directive is not allowed here`？**
粘贴位置不对——location 不能写在 `server` 块外面。子路径方案建议改用子域名。

**Q：手机能打开首页，但「测试连接」失败？**
多半是服务器地址填错了。必须是 `https://你的域名`，不能带 `/gz/` 这种路径
（子路径方案下要填 `https://你的域名/gz`，且子路径反代要确认前缀剥掉）。

**Q：快捷指令跑了但没数据？**
按序查：① 手机浏览器打开 `https://你的域名/api/health?token=你的token` 能通吗
（不通就是反代或防火墙问题）；② `TZ_OFFSET=9` 对不对（错了会记错日期）；
③ 工资通点同步时选的月份对不对。

**Q：token 泄露了？**
改环境变量里的 `TOKEN`，重启服务；然后同步改手机工资通设置和两个快捷指令的 URL。
泄露意味着别人能替你打卡。

**Q：一定要开公网端口吗？**
不用。反代走 80/443，服务端只听 127.0.0.1 公网打不到，这是最安全的形态。

**Q：宝塔面板里「Node 项目」找不到？**
说明没装 Node 版本管理器插件。走方式 B（PM2），前提是服务器已有 node ≥ 18：
`node -v` 确认，没有就用宝塔「软件商店 → Node 版本管理器」装一个。