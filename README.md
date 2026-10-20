<div align="center">
  <img src="assets/icon.svg" width="72" alt="dsh-zcode-claim icon">
</div>

# dsh-zcode-claim

**在 macOS 上把 ZCode 的每日免费额度「看板 + 自动领取」接进 DSH（DeepSeek Harness）。**
零 API Key、零反代、零常驻重进程、不做任何风控对抗。

- provider：**无**（不注册 LLM provider，不消费额度去跑对话——只做额度观测与领取触发）
- 平台：**仅 macOS**（驱动 ZCode 桌面客户端 `dev.zcode.app`）
- 数据源：ZCode 客户端自己的日志 `~/.zcode/v2/logs/<日期>.log`（**纯本地读，不发任何上游请求**）

## 它解决什么

ZCode 的免费额度（Start Plan / 活动卡，如 `zcode-v3-start-plan-trust-1004` 的一次性 1 亿
GLM-5.3-Flash token）有三个特点，本机日志实测：

1. **按天派发、当日 24:00 作废**（实测 `ends_at` = 次日 00:00:00 北京时间）。
2. **服务端不主动推送**——要不要给这张卡，取决于客户端有没有上报「活跃信号」。
3. **领取由官方客户端自己在启动时完成**：host 进程跑 `coding-plan-subscription.claimManualPlan`
   （本机每个有日志的日期恰好一次，理由标记 `settings:marketing-plan-claim`）。

⇒ 真正的缺口不是「不会领」，而是「**客户端今天没启动**」。09-29 / 10-02 / 10-03 / 10-05
都没有日志文件 = 当天没跑 = 当天的卡没领。

所以本插件做两件事：**① 被动读日志，把额度卡状态（剩余/到期/今日是否已领/客户端是否在跑）
变成 DSH 里一个 tool + 两条 HTTP 路由；② 用 20 分钟一轮的守卫，在客户端没跑时后台把它拉起
（`open -g -j`，不抢前台、不弹窗口），让官方 claim 流程自己走完。**

## 为什么不自建 HTTP 领取

`billing/claim` 要一次性阿里云 captcha param（只能在真 Electron renderer 里 mint，重复提交
撞 F008）；`billing/balance` 外部查会被设备门拦成 3001/400。复刻这套 = 把 zcode2api 重写一遍，
且随上游风控失效。**借用官方客户端的启动路径，而不是复刻它的请求。**

## 对外接口

| 面 | 说明 |
|---|---|
| tool `zcode_quota` | `{action:"status"}` 只读看板（纯本地读日志）；`{action:"claim"}` 确保今日已领（客户端没跑则后台拉起）；`{action:"plan"}` 实时查 plan（**仅 `config.livePlan:true` 才发上游**，否则返回 `live-plan-disabled`） |
| `GET /dsh-zcode-claim/status` | loopback JSON：额度快照 + config + pid + defineToolSource + toolsRegistered + livePlanEnabled + lastPlan |
| `POST /dsh-zcode-claim/claim` | loopback：手动触发一轮守卫 |
| `POST /dsh-zcode-claim/plan` | loopback：手动触发实时查 plan（同受 `livePlan` 硬闸，默认关→零上游） |

三条路由都带 `isTrusted()` 环回围栏（Host 环回名 + `sec-fetch-site!=cross-site` + Origin 同源）。

## 实时「用 JWT 查 plan」（live.js，默认关闭）

客户端起不来时，另一条**只读**路径是拿账户 JWT GET `billing/current`（ZhaoAndy 实测 current 接受
与 balance 同一个 Bearer JWT；不像 `billing/claim` 需要一次性 captcha）。凭据全程本机：
`~/.zcode/v2/credentials.json` 的 `zcodejwttoken`（enc:v1 = aes-256-gcm，key=`sha256(ZCODE_CREDENTIAL_SECRET`
或官方 fallback 串 `zcode-credential-fallback:<platform>:<home>:<user>`，本机实测 9/9 可解；JWT 为
header.payload.signature 三段且 **claims 无 exp**——服务端按 `token_version` 轮换）；`x-device-mid`
取 `~/.zcode/v2/telemetry-state.json` 的 `deviceMid`；`app_version` 用 `plutil` 探 Info.plist
（本机 3.14.4，失败回退常量）。

⚠ **这是用你的真实账号凭据向 zcode.z.ai 发请求**（bluechonk 免责原话「直接复用凭据调用服务端可能
违反服务条款，请自行评估」），所以 `livePlan` **默认 false**：不开时 `/plan` 路由与 tool 分支都在
`runPlan` 最前面短路、零网络（真宿主实测：POST /plan → `live-plan-disabled`，出站连接 0、诊断无
live-plan 事件）；只有你显式配 `livePlan:true` 才发那一次只读 GET。只 GET、不领、不改账号状态；
返回值绝不含 JWT 原文（test-live.mjs 有脱敏断言）。

## 配置（设置里的插件 config）

```yaml
- id: dsh-zcode-claim
  name: 'dsh-zcode-claim'
  config:
    enabled: true        # 总开关（关=只读看板不跑守卫）
    intervalMs: 1200000  # 守卫轮询间隔（默认 20min；billing/* 连查会撞 WAF，别再调密）
    firstDelayMs: 60000  # 首次延迟
    autoLaunch: true     # 允许后台拉起 ZCode（关=绝不动你的桌面）
    waitForMs: 120000    # 单次领取最长等待
    livePlan: false      # ★默认关。开=允许用账户 JWT 只读 GET billing/current（见上节免责）
    planTimeoutMs: 12000 # 实时查 plan 的超时
```

环境变量覆盖：`ZCODE_CLAIM_ENABLED=0`、`ZCODE_CLAIM_AUTO_LAUNCH=0`、`ZCODE_CLAIM_INTERVAL_MS`、
`ZCODE_CLAIM_WAIT_MS`、`ZCODE_CLAIM_DIAG`（诊断落盘路径）。

## 关键实现约束（踩过，务必保留）

- **顶层 `inject` 必须留空 `[]`，用 `ctx.inject([service], cb)` 惰性注册。** cordis 的顶层
  `inject` 是硬前置，任一服务不在就整条 entry 停在 `pending`、`apply` 永不执行（实测 headless
  报 `dsh-zcode-claim: pending (waiting for service: webServer)` → 路由全 404）。惰性注入后，
  缺哪个服务只少哪半边，另一半照跑。与本机可工作样本 `dsh-theme-manager` / `dsh-memguard` 同形。
- **不能碰 `ctx.log`。** 它是 getter，没有对应 inject 声明就访问（哪怕 `ctx.log?.info?.()`）会抛
  `cannot get property "log" without inject`，连带整条 entry 判 `did not activate`。本插件一律用
  `diag()` 落盘诊断代替 logger（宿主进程 stdout 指向 /dev/null，logger 会吞错）。
- **宿主包 `@deepseek-ai/dsh-tools` 从 `process.resourcesPath` 懒加载。** 本插件是 `link:` 进
  profile 的，Node 按 realpath 解析拿不到打包在 `app.asar/dsh/node_modules/` 的宿主包
  （`ERR_MODULE_NOT_FOUND`）。`defineTool` 有真实行为（把 parameters 转 JSON Schema + 校验），
  不能手搓替代；Electron 的 fs 能透明读 asar。
- **守卫对 `launch-died` 有退避**：客户端连续 2 次启动即死后暂停自动拉起（手动 claim 仍重试）。
- **路由带环回信任围栏 `isTrusted()`**：这些路由不在 DSH 自身 cookie 会话门内（实测无 cookie 打
  `/status` 也 200，而宿主页面 `/` 是 401），故自带 Host 环回名 + `sec-fetch-site!=cross-site` +
  Origin==Host 三重校验（照 `dsh-balance` 同形），挡 DNS-rebinding 打本地端口。伪造非环回 Host → 403，
  cross-site POST → 403（均在 web-app 沙箱实测）。
- **面板双 seam 用 `plugins.bundle.config`（key=包名）+ `settings.plugins.tab`（id=包名，label 是函数）**，
  不用第三方 `settings.section`（记忆 plugin-client-half:L8 警告其按插件归属过滤，写错落空白行）。
- **`readQuota` 比较文件名必须补 `.log` 后缀**：`readdirSync` 给 `2026-10-04.log`，`todayStamp()` 是纯日期，
  漏后缀会让「今日已领」恒判否、守卫每轮白拉客户端（e2e 决策表测试 `test-claim.mjs` 已把这个 bug 钉死）。

## 落盘诊断

`~/.dsh/zcode-claim-diag.ndjson`（追加，可 `ZCODE_CLAIM_DIAG` 覆盖路径）。三段式判据：
无 `boot` → 模块没被加载；有 `boot` 无 `apply-enter` → entry 未激活；
有 `apply-enter` 无 `tool-registered`/`routes-registered` → 对应服务在本宿主不存在（降级）。
诊断路径不依赖 `process.env.HOME`（宿主里可能缺→静默失败→把「没加载」误判成「加载了没写盘」），兜底 /tmp。

## 已验证（真宿主证据 + 端到端领取）

- **领取端到端跑通**：用户 2026-10-06 12:54 打开 ZCode 后，客户端自己的 host RPC
  `coding-plan-subscription.claimManualPlan OK (119.2ms)` 落进 `~/.zcode/v2/logs/2026-10-06.log`，
  领到今天的卡 `zcode-v3-start-plan-trust-1006`（GLM-5.3-Flash，一次性 1 亿 token）。插件读日志得
  `todayClaimed:true / claimCountToday:1 / cardUsable:true`；tool `zcode_quota(claim)` 如实返回
  `already-claimed`（不重复拉起）。
- **实时查 plan 跑通（用户授权 livePlan:true）**：`POST /dsh-zcode-claim/plan` → `ok:true, planCount:1`，
  返回 `zcode-v3-start-plan-trust-1006 [active] → GLM-5.3-Flash 100000000token(one_time)`，
  与日志侧领取互相印证；响应**不含 JWT 原文**（无 `eyJ`）。
- **web-app 沙箱独立 boot（:19489/:19490）**：诊断全链
  `boot→apply-enter→apply-done→loaded→inject-tools-callback→define-tool(asar)→tool-registered→
  inject-webServer-callback→routes-registered`；伪造 Host=403、cross-site POST=403、
  livePlan 关时 /plan→`live-plan-disabled` 且零出站；boot HTML entries 含本插件 client.js → 面板装载就绪。
- **桌面运行实例**：`/status`=200、`livePlanEnabled=true`、诊断链全绿（disabled 翻转热触发 import）。

## 已知边界

- 若 ZCode「今日已启动、但当时 claim 失败」，本模块不二次触发（claim 只在启动流程跑一次），
  返回 `needs_full_restart`，需完全退出 ZCode 再启动才重试。
- **曾出现「ZCode 无法被程序化启动」（165ms exit(0)）** —— 那是当时客户端 prepared-app 恢复不出
  窗口的状态，用户手动开一次后即正常；插件对 `launch-died` 连 2 次退避、如实上报，不假装领取成功。
- **配额解析修过两个真 bug**（都进回归测试并做负向对照验证）：① 空数组 truthy 会让解析器命中
  启动期的空快照报 `totalUnits:0`；② 余额有时只在 `payload.data.balances`、外层 `balances` 为空。
  修复在 `lib/quota.js`（`hasRealBalance`/`pickBalance`/`pickPlan`）。⚠ 运行中的桌面实例仍缓存
  12:55 启动时的旧 quota.js，故 `/status` 的 total 暂显 0；**下次重启 DSH 自动带修复版**（新代码已由
  test-claim 决策表 D/E + 直读日志验证：`totalUnits=100000000 / model=GLM-5.3-Flash`）。
- 额度快照新鲜度判据是「日志日期 == 今天」；拿昨天的快照会被标 `cardUsable:false`（防误报）。

## 自检（四套，全绿）

```
node test.mjs         # host 14 项：惰性注入空 inject / tool 注册 / 三路由 / status 读真实日志 /
                      #   claim(autoLaunch:false) 与真机领取状态解耦的不变式（绝不假成功、绝不拉起）/
                      #   GET-200 POST-405 / 环回围栏(非环回 Host→403、cross-site POST→403) /
                      #   headless 无服务时降级不抛错
node test-claim.mjs   # 领取决策表 + 配额解析回归 5 项：A already-claimed / B needs_full_restart /
                      #   C client-not-running / D 跳过启动期空快照 / E 余额只在 payload.data.balances
                      #   （合成 home 日志，不碰真 ZCode、不发上游）
node test-client.mjs  # client 半边重启前探针 11 项（fake __ModuleLoader__+React，硬断言 apply 不抛错）
node test-live.mjs    # live.js 9 项：JWT 解密 / mock fetch 各分支 / 无凭据短路零网络 / 脱敏断言
```

## 安装

```
cd ~/.dsh/profiles/desktop
~/.dsh/bin/pnpm10 add "dsh-zcode-claim@link:../../local-plugins/dsh-zcode-claim" --ignore-scripts
# 手工把 "dsh-zcode-claim" 追加进 package.json 的 dsh.profile.bundles，再 pnpm10 install
```

---

## ☕ 赞赏支持

如果 dsh-zcode-claim 对你的研究与测试有所帮助，欢迎请作者喝杯咖啡 ☕

<p align="center">
  <img src="assets/sponsor.jpg" width="260" alt="微信赞赏码" />
  <img src="assets/afdian_reward.jpg" width="200" alt="爱发电赞助码" />
</p>

<p align="center">
  <b>给项目点个 Star ⭐</b> 同样是对开发者最大的鼓励！
</p>
