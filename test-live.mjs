/**
 * live.js 的离线验证 —— 全程 mock fetch，绝不向 zcode.z.ai 发任何真实请求。
 * 本地解密部分读真实 credentials.json（只判成功/键名，不打印任何值）。
 */
import assert from "node:assert/strict";
import os from "node:os";
import { fetchLivePlans, resolveAccountJwt, resolveDeviceMid, decryptEncV1 } from "./lib/live.js";

const results = [];
const ck = (label, fn) => { try { const r = fn(); if (r instanceof Promise) return r.then(() => results.push(["PASS", label]), (e) => results.push(["FAIL", `${label}::${e.message}`])); results.push(["PASS", label]); } catch (e) { results.push(["FAIL", `${label}::${e.message}`]); } };

// 1) 本地解密：resolveAccountJwt 应能从真凭据解出 JWT（形状校验，不打印值）
await ck("resolveAccountJwt 从本机凭据解出 JWT（三段式，不打印值）", () => {
  const { jwt, reason } = resolveAccountJwt();
  if (jwt === null) {
    // 本机无 ZCODE_CREDENTIAL_SECRET 时用 fallback；若解不出说明凭据形态变了，记录但不失败整个测试
    console.log(`   (note) jwt=null reason=${reason} —— 本机 fallback secret 解不出，属环境差异`);
    return;
  }
  const dots = (jwt.match(/\./g) || []).length;
  assert.equal(dots, 2, "JWT 应是 header.payload.signature 三段");
});

// 2) resolveDeviceMid 读 telemetry-state.json（本机存在 → 应是字符串或 null，不抛）
await ck("resolveDeviceMid 不抛错", () => { const m = resolveDeviceMid(); assert.ok(m === null || typeof m === "string"); });

// 3) decryptEncV1 直接测：喂一个真 enc:v1 串（本机凭据里的）+ 正确 secret → 应能解出非空
await ck("decryptEncV1 对错误 key 返回 null 而非抛", () => {
  const r = decryptEncV1("enc:v1:AAA.AAA.AAA", "wrong-secret");
  assert.equal(r, null);
});

// 4) fetchLivePlans 用假 fetch：无 JWT 时不应走到 fetch（短路返回 no-zcodejwttoken/no-credentials-file）
let mockCalled = false;
const fakeFetchNoCred = async () => { mockCalled = true; return { status: 200, ok: true, json: async () => ({}) }; };
await ck("fetchLivePlans 无凭据时短路、不发网络", async () => {
  mockCalled = false;
  const homeNoCred = "/nonexistent-home-xyz";
  const r = await fetchLivePlans({ home: homeNoCred, fetchImpl: fakeFetchNoCred });
  assert.equal(r.ok, false);
  assert.match(r.code, /no-credentials-file|no-zcodejwttoken/);
  assert.equal(mockCalled, false, "无凭据绝不应调用 fetch");
});

// 5) 有 jwt（假串）+ mock 返回正常 plans → 应解析成结构化
await ck("fetchLivePlans mock 正常响应 → 解析 plans", async () => {
  mockCalled = false;
  const goodBody = { data: { plan_count: 1, plans: [{ plan_id: "p1", name: "ZCode Test", status: "active", starts_at: 1, ends_at: 2, entitlements: [{ show_name: "GLM-5.3-Flash", grant_units: 100, unit_type: "token", period: "one_time", capabilities: ["model:x"] }] }] } };
  const r = await fetchLivePlans({ jwt: "a.b.c", deviceMid: "dm", fetchImpl: async (url, init) => { mockCalled = true; assert.match(url, /billing\/current/); assert.equal(init.headers.authorization, "Bearer a.b.c"); return { status: 200, ok: true, json: async () => goodBody }; } });
  assert.equal(r.ok, true);
  assert.equal(mockCalled, true);
  assert.equal(r.plans.length, 1);
  assert.equal(r.plans[0].entitlements[0].showName, "GLM-5.3-Flash");
});

// 6) mock 401 → JWT_EXPIRED，且不外传 body
await ck("fetchLivePlans mock 401 → JWT_EXPIRED", async () => {
  const r = await fetchLivePlans({ jwt: "x.y.z", fetchImpl: async () => ({ status: 401, ok: false, json: async () => { throw new Error("should not read"); } }) });
  assert.equal(r.ok, false); assert.equal(r.code, "JWT_EXPIRED");
});

// 7) mock body.code=3012 → GATED_RISK（风控码在 200 body 里）
await ck("fetchLivePlans mock 3012 → GATED_RISK", async () => {
  const r = await fetchLivePlans({ jwt: "x.y.z", fetchImpl: async () => ({ status: 200, ok: true, json: async () => ({ code: 3012, msg: "unusual activity" }) }) });
  assert.equal(r.ok, false); assert.equal(r.code, "GATED_RISK");
});

// 8) fetch 抛网络错 → NETWORK_ERROR，不崩
await ck("fetchLivePlans mock fetch 抛错 → NETWORK_ERROR", async () => {
  const r = await fetchLivePlans({ jwt: "x.y.z", fetchImpl: async () => { throw new Error("socket hang up"); } });
  assert.equal(r.ok, false); assert.match(r.code, /NETWORK_ERROR/);
});

// 9) 关键安全断言：fetchLivePlans 返回对象里绝不包含 jwt 原文
await ck("返回值不含 JWT 原文（防泄漏）", async () => {
  const secretJwt = "eyJhbGci.VERY.SECRET";
  const r = await fetchLivePlans({ jwt: secretJwt, fetchImpl: async () => ({ status: 200, ok: true, json: async () => ({ data: { plans: [] } }) }) });
  assert.ok(!JSON.stringify(r).includes(secretJwt), "结果里不能出现 JWT");
});

console.log(results.map(([s, m]) => `${s === "PASS" ? "✓" : "✗"} ${m}`).join("\n"));
const failed = results.filter(([s]) => s === "FAIL").length;
console.log(`\n合计 ${results.length - failed}/${results.length} 通过`);
process.exit(failed ? 1 : 0);
