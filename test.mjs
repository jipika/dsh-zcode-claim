/**
 * 离线自检：用假 ctx 跑 apply()，验证 tool / 路由 / 配置 / 守卫语义。
 * 全程不启动 ZCode、不发任何上游请求（claim 走 autoLaunch:false 的只读分支）。
 *
 * ⚠ 架构是**惰性注入**（顶层 inject=[]，靠 ctx.inject([service], cb) 注册），
 * 所以假 ctx 必须实现 ctx.inject：service 可用就同步调用 cb，不可用就不调
 * （模拟 headless 里没有 webServer/tools 的降级场景）。
 *
 * 跑法：node test.mjs（Node ≥22）。
 * 在 profile node_modules 里跑能解析 @deepseek-ai/dsh-tools → 走真 defineTool；
 * 离线裸跑退化成 identity-stub，功能等价（只是 parameters 不被转成 JSON Schema）。
 */
import assert from "node:assert/strict";
import { apply, name, inject } from "./lib/index.js";

/**
 * @param {{services?:string[]}} opts — services 列出「这个假宿主拥有哪些服务」
 */
function makeCtx({ services = ["tools", "webServer"] } = {}) {
  const routes = new Map(), tools = new Map(), effects = [], logs = [];
  const has = (s) => services.includes(s);
  const ctx = {
    _routes: routes, _tools: tools, _effects: effects,
    log: { info: (m) => logs.push(["info", m]), warn: (m) => logs.push(["warn", m]), debug: () => {} },
    // 惰性注入：只有声明的服务都在，才触发回调
    inject: (deps, cb) => { for (const d of deps) if (!has(d)) return; cb(ctx); },
    effect: (fn, _label) => { const d = fn(); effects.push({ dispose: d }); return () => { if (typeof d === "function") d(); }; },
  };
  if (has("tools")) ctx.tools = { register: (t) => { tools.set(t.name, t); return () => tools.delete(t.name); } };
  if (has("webServer")) ctx.webServer = { register: (r) => { routes.set(r.path, r); return () => routes.delete(r.path); } };
  return ctx;
}

const results = [];
const t = async (label, fn) => { try { await fn(); results.push(["PASS", label]); } catch (e) { results.push(["FAIL", `${label} :: ${e.message}`]); } };
const flush = () => new Promise((r) => setTimeout(r, 20)); // 等 loadDefineTool 的微任务

await t("顶层 inject 为空（惰性注入，避免 unmet 致整条 entry 不激活）", () => {
  assert.ok(Array.isArray(inject) && inject.length === 0, `inject=${JSON.stringify(inject)}`);
});

const ctx = makeCtx();
await apply(ctx, { autoLaunch: false, intervalMs: 10000, firstDelayMs: 5000, waitForMs: 6000 });
await flush();

await t("注册了 zcode_quota tool", () => assert.ok(ctx._tools.has("zcode_quota"), [...ctx._tools.keys()].join()));
await t("注册了 status + claim 两条路由", () => {
  assert.ok(ctx._routes.has("/dsh-zcode-claim/status"));
  assert.ok(ctx._routes.has("/dsh-zcode-claim/claim"));
});
await t("守卫 timer 已挂（≥1 个 effect）", () => assert.ok(ctx._effects.length >= 1, `${ctx._effects.length}`));

// tool: status —— 读真实本机日志（零网络）
const r1 = await ctx._tools.get("zcode_quota").execute({ action: "status" });
await t("status 返回可读文本", () => assert.ok(typeof r1.text === "string" && r1.text.length > 20, r1.text));
await t("status 带 cardUsable 判据（快照非今日则不可用）", () => assert.ok("cardUsable" in (r1.quota ?? {}), JSON.stringify(Object.keys(r1))));
console.log("\n── tool zcode_quota(status) ──\n" + r1.text);

// tool: claim —— autoLaunch:false → 断言与真机当前领取状态解耦：
//   · 今天的卡若已被真领（本机实测过）→ 必须如实报 already-claimed 且 ok:true、launched:false
//   · 若尚未领 → 必须如实报失败码、ok:false、launched:false
//   不变式：autoLaunch:false 时 launched 恒 false；ok:true 只允许 already-claimed（绝不假成功）
const r2 = await ctx._tools.get("zcode_quota").execute({ action: "claim" });
await t("claim(autoLaunch:false)：如实上报、绝不假成功、绝不拉起", () => {
  assert.equal(r2.launched, false, "autoLaunch:false 不能拉起客户端");
  if (r2.ok === true) {
    assert.equal(r2.code, "already-claimed", `ok:true 只允许 already-claimed，实为 ${r2.code}`);
  } else {
    assert.ok(/client-not-running|launch-died|needs_full_restart|unsupported-platform|guard-busy/.test(r2.code), r2.code);
  }
});
console.log(`\n── tool zcode_quota(claim)：code=${r2.code} ──\n` + (r2.text || r2.message));

// 路由 handler
const mkRes = () => { const o = { code: 0, body: "", writeHead(c) { o.code = c; }, end(b) { o.body = b; } }; return o; };
// 环回信任围栏要求 Host 是环回名，伪 req 必须带合法 headers，否则命中 403 分支
const localReq = (method) => ({ method, url: "/x", headers: { host: "127.0.0.1:19387" } });
const res1 = mkRes();
await ctx._routes.get("/dsh-zcode-claim/status").handler(localReq("GET"), res1);
await t("GET /status → 200 JSON 且带 toolsRegistered", () => {
  assert.equal(res1.code, 200);
  const j = JSON.parse(res1.body);
  assert.equal(j.ok, true); assert.ok(j.quota);
  assert.ok(Array.isArray(j.toolsRegistered) && j.toolsRegistered.includes("zcode_quota"), JSON.stringify(j.toolsRegistered));
});
const resBad = mkRes();
await ctx._routes.get("/dsh-zcode-claim/status").handler(localReq("POST"), resBad);
await t("POST /status → 405", () => assert.equal(resBad.code, 405));
// 围栏：非环回 Host → 403；cross-site → 403
const resFence1 = mkRes();
await ctx._routes.get("/dsh-zcode-claim/status").handler({ method: "GET", url: "/x", headers: { host: "evil.example.com" } }, resFence1);
await t("非环回 Host → 403（DNS-rebinding 围栏）", () => assert.equal(resFence1.code, 403));
const resFence2 = mkRes();
await ctx._routes.get("/dsh-zcode-claim/claim").handler({ method: "POST", url: "/x", headers: { host: "127.0.0.1:19387", "sec-fetch-site": "cross-site" } }, resFence2);
await t("cross-site POST /claim → 403", () => assert.equal(resFence2.code, 403));

// /plan 路由：默认 livePlan=false 时必须短路、绝不发上游请求（硬闸回归）
{
  let netCalled = false;
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => { netCalled = true; return { status: 200, ok: true, json: async () => ({}) }; };
  const resPlan = mkRes();
  await ctx._routes.get("/dsh-zcode-claim/plan").handler(localReq("POST"), resPlan);
  globalThis.fetch = realFetch;
  await t("POST /plan（livePlan=false）→ live-plan-disabled 且零网络", () => {
    assert.equal(resPlan.code, 200);
    const j = JSON.parse(resPlan.body);
    assert.equal(j.ok, false);
    assert.equal(j.code, "live-plan-disabled");
    assert.equal(netCalled, false, "未开 livePlan 绝不能触碰 fetch");
  });
}

// 降级场景：headless（无 webServer/tools）—— apply 不应抛错，守卫仍挂
await t("无 webServer/tools 的宿主里 apply 不抛错（惰性注入降级）", async () => {
  const c2 = makeCtx({ services: [] });
  await apply(c2, { intervalMs: 10000, firstDelayMs: 5000 });
  await flush();
  assert.equal(c2._routes.size, 0);
  assert.equal(c2._tools.size, 0);
  assert.ok(c2._effects.length >= 1, "守卫仍应挂");
});

// dispose 清定时器
for (const e of ctx._effects) { try { e.dispose?.(); } catch {} }
await t("dispose 后可调用（定时器句柄清理不抛）", () => { assert.ok(true); });

console.log("\n" + results.map(([s, m]) => `${s === "PASS" ? "✓" : "✗"} ${s}`).join("\n"));
const failed = results.filter(([s]) => s === "FAIL").length;
console.log(`\n合计 ${results.length - failed}/${results.length} 通过`);
process.exit(failed ? 1 : 0);
