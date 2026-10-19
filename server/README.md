# 工资通 · 自建服务器版

一套东西解决两件事：**托管工资通页面** + **接收手机打卡请求**。

关键在于绕开 iOS 的锁屏限制：锁屏会拦截「打开 App / 打开 URL」这类需要界面的动作，
但**不拦网络请求**。所以快捷指令在到达/离开公司时只发一个 HTTP 请求，压根不打开任何页面。

---

## 一、部署（3 步）

### 1. 把整个项目拷到服务器

```bash
# 在服务器上，比如放到 /opt/salary-keeper
scp -r ./小程序 user@你的服务器:/opt/salary-keeper
```

目录里要有 `index.html`、`js/`、`css/`，以及 `server/server.js`。

### 2. 启动

服务器上需要 **Node 18+**（`node -v` 确认）。

```bash
cd /opt/salary-keeper
TOKEN=自己设一个长口令 PORT=8080 node server/server.js
```

启动后终端会打印三行地址，**把 token 抄下来**：

```
站点地址   http://<你的服务器IP>:8080/
打卡接口   http://<你的服务器IP>:8080/api/punch?token=xxxx&t=in
同步接口   http://<你的服务器IP>:8080/api/punches?token=xxxx&month=2026-10
```

不传 `TOKEN` 也会自动生成一个随机口令，存在 `server/data/config.json` 里。

### 3. 常驻运行（关掉终端也不停）

```bash
# 用 pm2（推荐）
npm i -g pm2
cd /opt/salary-keeper
TOKEN=你的口令 PORT=8080 pm2 start server/server.js --name salary
pm2 save && pm2 startup
```

或者用 systemd：`/etc/systemd/system/salary.service`

```ini
[Unit]
Description=Salary Keeper
After=network.target

[Service]
WorkingDirectory=/opt/salary-keeper
Environment=PORT=8080
Environment=TOKEN=你的口令
Environment=TZ_OFFSET=9
ExecStart=/usr/bin/node server/server.js
Restart=always

[Install]
WantedBy=multi-user.target
```

```bash
systemctl daemon-reload && systemctl enable --now salary
```

---

## 二、配置项

| 环境变量 | 默认 | 说明 |
|---|---|---|
| `PORT` | 8080 | 监听端口 |
| `TOKEN` | 自动生成 | 访问口令，**必须保密**，泄露了别人就能替你打卡 |
| `TZ_OFFSET` | 9 | 公司所在时区偏移，韩国填 9（北京时间也是 8） |
| `PUBLIC_DIR` | 上一级目录 | 工资通静态文件所在目录 |
| `DATA_DIR` | `server/data` | 打卡数据存放目录 |

数据就是一个 JSON 文件 `server/data/punches.json`，直接备份这个文件即可。

---

## 三、手机端配置

### 1. 用服务器地址打开工资通

在 Safari 打开 `http://<你的服务器IP>:8080/`，然后**添加到主屏幕**。

> ⚠️ 不要再用 GitHub Pages 那个地址去连 HTTP 服务器：HTTPS 页面请求 HTTP 接口会被浏览器
> 按「混合内容」拦掉。**页面和接口必须在同一个地址下**（都由这个服务端托管最省事）。
>
> 如果你的服务器配了域名和 HTTPS 证书，那两边都安全，用哪个都行。

### 2. 在工资通里填配置

`设置 → 云端打卡`：

- 启用云端打卡：开
- 服务器地址：`http://<你的服务器IP>:8080`（末尾不要带斜杠）
- 访问令牌：启动时打印的那个 token
- 公司时区：9

点「**测试连接**」，出现 `✅ 连接成功 · 服务器当前 …` 就通了。

### 3. 配快捷指令（关键：用「获取 URL 内容」）

打开「快捷指令」App → 底部 **自动化** → 新建：

| 项 | 填什么 |
|---|---|
| 触发 | **到达** → 地点选公司 → 范围小一点（如 200 米） |
| 动作 | **获取 URL 内容**（不是「打开 URL」，也不是「打开 App」） |
| URL | 设置页里「签到地址」那一行，点复制 |
| 运行前询问 | **关掉** |

再建一个一模一样的，触发改成 **离开**，URL 用「签退地址」。

> **为什么必须是「获取 URL 内容」**：它是纯网络请求，不需要界面，所以锁屏、口袋、深夜里
> 都能静默跑完。「打开 URL」和「打开 App」都需要唤起界面，锁屏下会被系统拦。

### 4. 验证

把手机拿到公司门口待一会儿，然后回工资通点「立即同步打卡」，
应该能看到今天的签到时间。

---

## 四、接口说明（备用/排错）

```bash
# 探活
curl "http://IP:8080/api/health?token=口令"
# → {"ok":true,"serverDay":"2026-10-19","serverTime":"2026-10-19T17:11:03","tzOffset":9,"days":0}

# 打一笔卡
curl "http://IP:8080/api/punch?token=口令&t=in"
curl "http://IP:8080/api/punch?token=口令&t=out"

# 取某月流水
curl "http://IP:8080/api/punches?token=口令&month=2026-10"

# 清掉某天（打错时用）
curl "http://IP:8080/api/clear?token=口令&day=2026-10-19"
```

内置两个防错：

- **3 分钟防抖**：同类型打卡间隔不到 3 分钟视为快捷指令重复触发，直接忽略
- **连续同类型自动补齐**：连着两次 `in` 会补一条 `out`，避免时间配对错位

---

## 五、常见问题

**Q：快捷指令跑了，但工资通里没数据？**
按顺序查：① 手机上用浏览器打开 `/api/health?token=口令` 看能不能访问（服务器防火墙/端口是否放行）；
② `TZ_OFFSET` 对不对（错了会记到昨天/明天）；③ 点「立即同步打卡」时选的月份对不对。

**Q：能在外网访问吗？**
需要服务器有公网 IP 且端口放行。家里宽带通常没有公网 IP，可以用 Cloudflare Tunnel
把 HTTP 服务映射成 HTTPS 域名，免费且不用改代码。

**Q：token 泄露了怎么办？**
改 `TOKEN` 环境变量重启，然后在手机上改快捷指令里的 URL 和工资通设置里的令牌。

**Q：想换端口/换机器？**
数据只在 `server/data/punches.json` 一个文件里，拷走即可。
