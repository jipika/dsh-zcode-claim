/**
 * dsh-zcode-claim —— ZCode 每日额度自动领取 + 额度看板（macOS）
 *
 * 只做三件事，全部零风控对抗、零常驻重进程：
 *   ① 读 ZCode 客户端自己的日志解析额度卡（外部查 billing/balance 会被设备门拦）
 *   ② 后台拉起 ZCode，让官方 host 的 `coding-plan-subscription.claimManualPlan` 自己跑
 *   ③ 定时守卫 + 一个模型可调的 tool + 两个 loopback HTTP 路由
 *
 * 不注册 LLM provider、不持有 API key、不 fork Electron（依据见 lib/claim.js 顶部）。
 *
 * ⚠ 宿主包 `@deepseek-ai/dsh-tools` **不能 top-level 裸 import**：本插件是 `link:` 进
 * profile 的，Node 按 realpath 解析，拿不到打包在 `app.asar/dsh/node_modules/` 里的
 * 宿主包（实测 `ERR_MODULE_NOT_FOUND`）。正解是从 `process.resourcesPath` 懒加载
 * —— Electron 的 fs 能透明读 asar。
 */
import { pathToFileURL } from "node:url";
import { appendFileSync, mkdirSync } from "node:fs";
import { readQuota, summarize } from "./quota.js";
import { ensureDailyClaim, zcodeMainPid } from "./claim.js";
import { fetchLivePlans } from "./live.js";

/**
 * 三段式落盘诊断。记忆方法论：验证插件改动要用落盘诊断，不要只用 logger ——
 * 宿主进程 stdout 不落地（主进程指向 /dev/null），logger 吞错时你只会看到路由 404
 * 而不知其所以然。
 *   无 boot 行       → 模块根本没被宿主加载
 *   有 boot 无 apply-enter → 模块加载了，apply 没被调用（多为 entry 未激活）
 *   有 apply-enter 无 apply-done → apply 中途抛错，看 apply-THREW
 */
const DIAG = process.env.ZCODE_CLAIM_DIAG
  || ((process.env.HOME ?? "").length > 1 ? `${process.env.HOME}/.dsh/zcode-claim-diag.ndjson` : "/tmp/zcode-claim-diag.ndjson");

function diag(event, extra = {}) {
  try {
    mkdirSync(DIAG.slice(0, DIAG.lastIndexOf("/")), { recursive: true });
    appendFileSync(DIAG, JSON.stringify({ at: new Date().toISOString(), event, pid: process.pid, ...extra }) + "\n");
  } catch { /* 诊断绝不能拖垮插件 */ }
}
diag("boot", { version: "0.1.0", resourcesPath: process.resourcesPath ?? null });

export const name = "dsh-zcode-claim";

/**
 * ⚠ 必须留空。cordis 的顶层 `inject` 是**硬前置**：任一服务不在，整条 entry 停在
 * pending、apply 永不执行。实测（headless 沙箱 boot）报
 * `dsh-zcode-claim: pending (waiting for service: webServer)` → 路由全 404、诊断只有 boot。
 * 改成 `ctx.inject([...])` 惰性注册后，缺哪个服务只少哪半边，另一半照跑。
 * 与本机两个可工作样本同形：dsh-theme-manager（inject=[] + ctx.inject(["webServer"])）、
 * dsh-memguard（ctx.inject(["webServer"])）。
 */
export const inject = [];

const DEFAULTS = {
  enabled: true,
  /** 守卫轮询间隔（毫秒）。默认 20 分钟 —— 第三方实测 `billing/*` 连查会撞 WAF。 */
  intervalMs: 20 * 60 * 1000,
  /** 首次延迟：给 DSH 启动后的其它初始化让路。 */
  firstDelayMs: 60 * 1000,
  /** 是否允许守卫自动后台拉起 ZCode。关掉 = 只读看板，绝不动你的桌面。 */
  autoLaunch: true,
  /** 单次领取最长等待。 */
  waitForMs: 120_000,
  /**
   * 实时「用 JWT 查 plan」总闸。⚠ 默认 false = 零上游请求。
   * 开了之后 tool action=plan 与面板「查实时 plan」按钮才会用本机解密的账户 JWT
   * GET zcode.z.ai/billing/current —— 这是以你真实账号身份向外部服务器发请求，
   * bluechonk 的免责原话「直接复用凭据调用服务端可能违反服务条款，请自行评估」，
   * 所以知情选择才开。JWT 只从本机 credentials.json 解密、只在内存里用、绝不落日志。
   */
  livePlan: false,
  /** billing/current 请求带的 app_version（默认让 live.js 从本机 Info.plist 探测，探不到用 3.14.4）。 */
  appVersion: null,
  /** 实时查 plan 的超时（毫秒）。 */
  planTimeoutMs: 12_000,
};

function resolveConfig(config = {}) {
  const cfg = { ...DEFAULTS, ...(config || {}) };
  const num = (v, lo, hi) => { const n = Number(v); return Number.isFinite(n) ? Math.min(hi, Math.max(lo, Math.trunc(n))) : undefined; };
  const env = process.env;
  cfg.intervalMs = num(env.ZCODE_CLAIM_INTERVAL_MS, 60_000, 24 * 3600_000) ?? cfg.intervalMs;
  cfg.waitForMs = num(env.ZCODE_CLAIM_WAIT_MS, 5_000, 600_000) ?? cfg.waitForMs;
  if (env.ZCODE_CLAIM_AUTO_LAUNCH === "0") cfg.autoLaunch = false;
  if (env.ZCODE_CLAIM_ENABLED === "0") cfg.enabled = false;
  cfg.enabled = cfg.enabled !== false;
  return cfg;
}

/** 从 Electron 的 app.asar 取 defineTool；非 Electron 退回裸 import，再退化为恒等标注。 */
async function loadDefineTool() {
  const rp = process.resourcesPath;
  if (rp) {
    const p = `${rp}/app.asar/dsh/node_modules/@deepseek-ai/dsh-tools/lib/index.js`;
    try {
      const m = await import(pathToFileURL(p).href);
      if (typeof m.defineTool === "function") { lastDefineToolSource = "asar"; return m.defineTool; }
    } catch (e) { lastDefineToolSource = `asar-fail(${e?.code ?? e?.message})`; }
  }
  try {
    const m = await import("@deepseek-ai/dsh-tools");
    if (typeof m.defineTool === "function") { lastDefineToolSource = "bare-import"; return m.defineTool; }
  } catch { /* 非宿主环境 */ }
  lastDefineToolSource = "identity-stub";
  return (t) => t;
}
export let lastDefineToolSource = "unresolved";

const writeJson = (res, code, obj) => {
  res.writeHead(code, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  res.end(JSON.stringify(obj));
};

/**
 * 环回信任围栏（照本机可工作样本 dsh-balance 的 isTrusted 同形）。
 *
 * 本插件的路由**不在 DSH 自身的 cookie 会话门内**（实测无 cookie 打 /dsh-zcode-claim/status
 * 也能拿到 200，而宿主页面 `/` 是 401），所以必须自带围栏：
 *   · Host 必须是环回名（挡 DNS rebinding 打本地端口）
 *   · `sec-fetch-site: cross-site` 直接拒
 *   · 有 Origin 时必须与 Host 同源
 *   · 无 Origin 放行（本机 curl / 脚本用户）
 * `/claim` 是状态变更（会后台拉起 ZCode），因此额外拒绝「无 Origin 的跨站表单」形态：
 * 浏览器发起的写请求必带 Origin/sec-fetch-site，缺失即视为非浏览器本机调用，仍放行但记诊断。
 */
const LOOPBACK_HOSTNAMES = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);
function isTrusted(req) {
  const host = req.headers?.host;
  if (!host) return false;
  if (!LOOPBACK_HOSTNAMES.has(host.split(":")[0])) return false;
  if (req.headers?.["sec-fetch-site"] === "cross-site") return false;
  const origin = req.headers?.origin;
  if (origin === undefined) return true;
  try { return new URL(origin).host === host; } catch { return false; }
}

/**
 * ⚠ cordis 的 ctx 服务属性是 **getter**：没有对应的 inject 声明就访问（哪怕写成
 * `ctx.log?.info?.()`，可选链也拦不住属性读取）会抛
 * `cannot get property "log" without inject`，导致整条 entry 被判
 * `did not activate`，连带 ctx.inject 回调永不触发（实测踩过，路由全 404）。
 * 所以本插件一律用 diag() 落盘，不碰 ctx.log。
 */
export function apply(ctx, rawConfig) {
  diag("apply-enter", { config: rawConfig ?? null });
  const cfg = resolveConfig(rawConfig);
  const registered = { routes: [], tools: [] };

  /** 最近一次守卫结果（供 status 路由与 tool 复用，避免每次都跑领取）。 */
  let lastGuard = null;
  let guardRunning = false;
  /** 连续 launch-died 计数：客户端启动即死时别再每 20 分钟重复拉起（纯噪音 + 浪费）。 */
  let launchDiedStreak = 0;

  async function snapshot() {
    const q = readQuota();
    const s = summarize(q);
    return {
      quota: s,
      claim: q.todayClaimed
        ? { todayClaimed: true, claimCountToday: q.claimCountToday, lastClaimAt: q.lastClaimAt }
        : { todayClaimed: false, lastClaimAt: q.lastClaimAt ?? null },
      todayLogExists: q.todayLogExists,
      scannedFiles: q.scannedFiles,
      lastGuard,
    };
  }

  async function runGuard(reason) {
    if (guardRunning) return { skipped: "guard-busy", ok: null, code: "guard-busy", message: "上一轮守卫仍在进行" };
    guardRunning = true;
    try {
      const launch = cfg.autoLaunch && launchDiedStreak < 2;
      const r = await ensureDailyClaim({ waitForMs: cfg.waitForMs, launch });
      if (r.code === "launch-died") { launchDiedStreak++; if (launchDiedStreak === 2) diag("guard-backoff", { streak: launchDiedStreak, note: "连续 2 次启动即死，自动拉起暂停；手动 action=claim 仍会重试" }); }
      else if (r.ok || r.code === "already-claimed") launchDiedStreak = 0;
      lastGuard = { at: new Date().toISOString(), reason, ...r };
      return lastGuard;
    } catch (e) {
      lastGuard = { at: new Date().toISOString(), reason, ok: false, code: "exception", message: String(e?.message ?? e) };
      return lastGuard;
    } finally { guardRunning = false; }
  }

  /**
   * 实时查 plan（用 JWT GET billing/current）。⚠ 受 `cfg.livePlan` 硬闸约束：
   * 未开则**绝不发上游请求**，返回明确原因。开了才用本机解密的账户 JWT 发一次只读 GET。
   * 结果里绝不含 JWT 原文（live.js 已保证；这里再兜一层脱敏）。
   */
  let lastPlan = null;
  async function runPlan(reason) {
    if (!cfg.livePlan) {
      return { ok: false, code: "live-plan-disabled", message: "实时查 plan 未启用（config.livePlan:false）。开它 = 同意用你的 ZCode 账户 JWT 向 zcode.z.ai 发只读请求，可能触及服务条款，请自行评估。" };
    }
    try {
      const r = await fetchLivePlans({ appVersion: cfg.appVersion ?? undefined, timeoutMs: cfg.planTimeoutMs });
      lastPlan = { at: new Date().toISOString(), reason, ...r };
      diag("live-plan", { ok: r.ok, code: r.code ?? null, plans: r.ok ? (r.plans || []).length : 0 });
      return lastPlan;
    } catch (e) {
      lastPlan = { at: new Date().toISOString(), reason, ok: false, code: "exception", message: String(e?.message ?? e) };
      return lastPlan;
    }
  }

  try {
    // ── 定时器（ctx.effect 里挂，插件卸载即清，不留悬空句柄） ──────────────
    ctx.effect(() => {
      if (!cfg.enabled) return () => {};
      const first = setTimeout(() => { void runGuard("startup"); }, cfg.firstDelayMs);
      const tick = setInterval(() => { void runGuard("scheduled"); }, cfg.intervalMs);
      return () => { clearTimeout(first); clearInterval(tick); };
    }, `${name}: daily claim guard`);

    // ── HTTP 路由（loopback；只读 status + 显式触发 claim） ────────────────
    ctx.inject(["webServer"], (wctx) => {
      diag("inject-webServer-callback", { hasService: !!wctx?.webServer, registerType: typeof wctx?.webServer?.register });
      const status = {
        kind: "exact", path: "/dsh-zcode-claim/status",
        handler: async (req, res) => {
          if (!isTrusted(req)) return writeJson(res, 403, { ok: false, error: "forbidden" });
          if (req.method !== "GET") return writeJson(res, 405, { ok: false, error: "GET required" });
          const s = await snapshot();
          s.pid = await zcodeMainPid();
          s.defineToolSource = lastDefineToolSource;
          s.toolsRegistered = registered.tools.slice();
          s.livePlanEnabled = cfg.livePlan === true;
          s.lastPlan = lastPlan;
          writeJson(res, 200, { ok: true, config: cfg, ...s });
        },
      };
      const claim = {
        kind: "exact", path: "/dsh-zcode-claim/claim",
        handler: async (req, res) => {
          if (!isTrusted(req)) return writeJson(res, 403, { ok: false, error: "forbidden" });
          if (req.method !== "POST") return writeJson(res, 405, { ok: false, error: "POST required" });
          writeJson(res, 200, await runGuard("manual-http"));
        },
      };
      const plan = {
        kind: "exact", path: "/dsh-zcode-claim/plan",
        handler: async (req, res) => {
          if (!isTrusted(req)) return writeJson(res, 403, { ok: false, error: "forbidden" });
          if (req.method !== "POST") return writeJson(res, 405, { ok: false, error: "POST required" });
          // runPlan 内部按 cfg.livePlan 硬闸：未开则绝不发上游请求。
          writeJson(res, 200, await runPlan("manual-http"));
        },
      };
      ctx.effect(() => wctx.webServer.register(status), `${name}: /status`);
      ctx.effect(() => wctx.webServer.register(claim), `${name}: /claim`);
      ctx.effect(() => wctx.webServer.register(plan), `${name}: /plan`);
      registered.routes.push(status.path, claim.path, plan.path);
      diag("routes-registered", { paths: registered.routes });
    });

    // ── 模型可调的 tool ────────────────────────────────────────────────────
    ctx.inject(["tools"], (tctx) => {
      diag("inject-tools-callback", { hasService: !!tctx?.tools, registerType: typeof tctx?.tools?.register });
      void loadDefineTool().then((defineTool) => {
        diag("define-tool", { source: lastDefineToolSource });
        tctx.tools.register(defineTool({
          name: "zcode_quota",
          description:
            "Check the ZCode (Z.ai) daily free quota card (Start Plan / marketing grant) on this machine, and optionally " +
            "trigger today's claim. 'status' and 'claim' take NO upstream network request — status parses the ZCode client's " +
            "own local logs, claim relies on the official client. 'plan' does a live read of billing/current using your " +
            "account JWT, but only if the plugin's config.livePlan is enabled (off by default). " +
            "action='status' inspects the local view; action='claim' makes sure today's card is claimed (launches ZCode in " +
            "the background if it is not running); action='plan' fetches live plans when enabled.",
          parameters: {
            action: { type: "string", description: "status (default, local read-only) | claim (may launch ZCode in background) | plan (live JWT read, only if config.livePlan is on).", enum: ["status", "claim", "plan"] },
          },
          output: {
            schema: { type: "object", additionalProperties: true },
            render(_args, value) { return [{ type: "text", text: typeof value?.text === "string" ? value.text : JSON.stringify(value) }]; },
          },
          execute: async (args) => {
            const action = String(args?.action ?? "status");
            if (action === "claim") {
              const r = await runGuard("manual-tool");
              const s = await snapshot();
              const q = s.quota;
              const card = q.ok
                ? `${q.planName ?? q.planId} / ${q.model} / 剩余 ${q.remainingUnits} of ${q.totalUnits}${q.cardUsable ? "" : "（已过期或快照非今日，不可用）"}`
                : (q.message ?? "无数据");
              return { text: `领取${r.ok ? "完成" : "未完成"}：${r.code}\n${r.message ?? ""}\n\n当前额度卡：${card}`, ...r, quota: q };
            }
            if (action === "plan") {
              const r = await runPlan("manual-tool");
              if (!r.ok) return { text: `实时查 plan：${r.code}\n${r.message ?? ""}`, ...r };
              const lines = (r.plans || []).map((p) => `· ${p.name ?? p.planId} [${p.status ?? "-"}] ${(p.entitlements || []).map((e) => `${e.showName ?? "?"} ${e.grantUnits ?? "?"}${e.unitType ?? ""}(${e.period ?? "-"})`).join(" / ") || "（无权益）"}`);
              return { text: `实时 plan（${(r.plans || []).length} 个 @ ${r.fetchedAt ?? ""}）：\n${lines.join("\n") || "（无）"}`, ...r };
            }
            const s = await snapshot();
            const q = s.quota;
            if (!q.ok) return { text: `额度看板无数据：${q.message ?? q.reason}`, ...s };
            const lines = [
              `额度卡 ${q.planId}（${q.planName ?? "-"}）状态=${q.status ?? "-"}`,
              `模型 ${q.model}：剩余 ${q.remainingUnits} / ${q.totalUnits}（已用 ${q.usedPercent}%）`,
              `到期 ${q.endsAtLocal ?? "-"}${q.expired ? " ← 已过期" : `，还剩 ${Math.max(0, Math.round((q.secondsToExpiry ?? 0) / 3600))} 小时`}`,
              `卡可用：${q.cardUsable ? "是" : "否"}（快照来自 ${q.sourceFile}，${q.snapshotIsFromToday ? "今日" : `约 ${Math.round((q.snapshotAgeMs ?? 0) / 3.6e6 * 10) / 10} 小时前`}）`,
              `今日已领取：${q.todayClaimed ? `是（${q.claimCountToday} 次）` : "否"} | ZCode 进程：${q.clientRunning ? "在跑" : "未运行"} | 守卫：${s.lastGuard ? `${s.lastGuard.code}${s.lastGuard.ok ? "" : "（未完成）"}` : "尚未运行"}`,
            ];
            return { text: lines.join("\n"), ...s };
          },
        }));
        registered.tools.push("zcode_quota");
        diag("tool-registered", { tools: registered.tools });
      }).catch((e) => diag("tool-fatal", { message: String(e?.message ?? e), stack: String(e?.stack ?? "").split("\n").slice(0, 4).join(" | ") }));
    });

    diag("apply-done", { routes: registered.routes, tools: registered.tools, config: cfg });
  } catch (e) {
    diag("apply-THREW", { message: String(e?.message ?? e), name: e?.name, stack: String(e?.stack ?? "").split("\n").slice(0, 6).join(" | ") });
    throw e;
  }
  diag("loaded", { guard: cfg.enabled ? `every ${Math.round(cfg.intervalMs / 60000)}min` : "disabled", autoLaunch: cfg.autoLaunch });
}

export default { name, inject, apply };
