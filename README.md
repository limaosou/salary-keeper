# 工资通 · 考勤计薪核对小程序

基于考勤打卡与绩效考核，帮你清晰核对每个月的工资条。纯前端实现（原生 HTML/CSS/JS），数据全部存在本机 localStorage，**不上传任何服务器**，零依赖、双击即用。

## 功能对照

| 需求 | 实现 |
|---|---|
| 地理围栏自动打卡 | 进入公司区域连续 2 次定位确认后自动签到；离开区域自动签退并结束当日考勤 |
| 白班/夜班模式 | 今日页右上角一键切换；夜班按「时段 × 补助」或「每班固定额」计 |
| 绩效计薪 | 支持按日绩效（每日填）或整月统一系数，作用于正常工时工资 |
| 首页实时今日已赚 | 打卡中每 15 秒按当前时刻实时跳动，未签退段持续累计 |
| 月度汇总与核对 | 应发构成（正常工资/加班费/夜班补助）→ 逐项扣除（健康保险/养老/个税等）→ 实发；输入老板实发金额自动比对差额 |

## 快速开始

1. 首次使用进【设置】：
   - 填时薪、标准日工时、加班倍率（如 1.5）
   - 夜班时段与补助方式（默认 22:00–06:00，10 元/小时）
   - **到公司门口点「📍 获取当前位置为公司坐标」**（半径默认 200 米，误触发就加大）
   - 检查扣除项目：默认带健康保险费 3%、养老保险费 8%、个人所得税（累进），可增删改
2. 日常使用：手机浏览器打开页面保持前台，进公司自动签到、离公司自动签退；也可随时手动签到/签退兜底。
3. 月底进【月薪】页：看应发构成与扣除明细，输入老板实发金额点「核对」，一致/差额一目了然。

## 计薪规则

- 当日工时 = 签退−签到 − 休息扣除（默认 60 分钟午休，可调）
- 正常工资 = 标准工时内时长 × 时薪 × 绩效系数
- 加班费 = 超出标准工时部分 × 时薪 × 加班倍率
- 夜班补助 = 与夜班时段重叠的工时 × 补助（或夜班标签 + 固定额）
- 跨午夜班次（如 22:00–06:00）自动拆分计算；凌晨班（02:00 上班）也算夜班重叠
- 休息日不计薪；往日忘记签退的记录，在【考勤】页点该日期可按 23:59 补结算

## 本地运行与测试

```bash
# 任选其一启动静态服务（定位 API 需要 localhost 或 HTTPS 环境）
python -m http.server 8901
# 手机与电脑同局域网时，访问 http://<电脑IP>:8901

# 回归测试（Node）
node test/salary.test.js   # 计薪引擎单测：32 项
node test/e2e.js           # 无头浏览器 E2E：含模拟 GPS 自动签到/签退，14 项
```

测试截图在 `screenshots/`。

## 打包成安卓 APP

本目录是纯静态站点，用 WebView 套壳即可（和老爷的 ReMan 同路）：

- 定位权限需在 APP 里申请 `ACCESS_FINE_LOCITION`，并引导用户选「使用期间允许」
- 系统省电策略可能挂起后台定位，自动打卡依赖页面保持前台；手动打卡不受影响
- 页面本身无外部请求，可整体打进 APK assets

## 线上地址（已部署，直接可用）

**https://limaosou.github.io/salary-keeper/**

仓库：https://github.com/limaosou/salary-keeper （公开仓库，Pages 已开启：main 分支 / 根目录）

HTTPS 安全上下文已验证：`isSecureContext=true`、定位 API 可用 → 手机上地理围栏自动打卡全功能可用。

**以后更新代码**（本机已配好 GitHub 凭证，直接推即可，约 1 分钟自动上线）：

```bash
cd E:/workbuddy目录/小程序
git add -A && git commit -m "描述" && git push
```

> 凭证管理器（Git Credential Manager）在**沙箱内**执行 `git push` 会被杀掉（静默 SIGTERM，无报错）；
> 让 WorkBuddy 代推时需关闭沙箱（会弹浏览器授权，选「在浏览器中登录」）。凭证已缓存，之后正常推送不再弹窗。

<details>
<summary>换机器 / 换仓库时如何重新部署（备用方案）</summary>

**方式 A：网页拖拽（最简单，无需命令行）**

1. 解压 `salary-keeper-deploy.zip`
2. 打开 github.com →右上角 **+** → New repository → 名称填 `salary-keeper` → 选 **Public**（免费版 Pages 要求公开；代码内无隐私数据）→ Create
3. 点 **uploading an existing file** → 把解压出的文件（index.html、css、js、README.md）拖进去 → Commit changes
4. 仓库 **Settings → Pages → Source 选 `main` 分支、`/(root)` 目录 → Save**
5. 等约 1 分钟，访问 `https://你的用户名.github.io/salary-keeper/`

**方式 B：命令行**

```bash
winget install --id GitHub.cli        # 装 gh（只需一次）
gh auth login                          # 浏览器授权（只需一次）
gh repo create salary-keeper --public --source=. --push
gh api -X POST repos/{owner}/salary-keeper/pages -f source[branch]=main -f source[path]=/
```

</details>

**手机使用（iOS/Android 通用）**

- Safari/Chrome 打开上面的地址 → 菜单选「添加到主屏幕」→ 桌面出现图标，点开全屏运行
- 首次进【设置】填时薪等；**在公司门口时**点「📍 获取当前位置」配置围栏
- 自动打卡需页面保持前台（锁屏/切 APP 会暂停计时，这是手机系统的限制，iOS 安卓皆然）
- 换手机/换设备：旧设备【设置】导出备份 → 新设备导入

## 目录结构

```
index.html          页面骨架（今日/考勤/月薪/设置 四个 Tab）
css/style.css       移动端样式
js/storage.js       数据层（localStorage 存取、默认值、备份导出）
js/salary.js        计薪引擎（工时/加班/夜班重叠/绩效/个税累进/月度汇总）
js/geo.js           地理围栏（持续定位、Haversine 距离、防抖状态机）
js/app.js           页面渲染与交互
test/               单测 + E2E
```

## 已知限制

- 自动打卡需要页面保持前台（浏览器/WebView 的后台定位受限），离开区域自动签退同样如此；锁屏期间不会记录
- H5 定位在 localhost 或 HTTPS 下可用，http + 非 localhost 会被浏览器拒绝（打包进 APP 无此问题）
- 数据存在本机浏览器/APP 内，清缓存前请先在【设置】导出备份 JSON
