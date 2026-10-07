/**
 * 领取决策表 e2e：用合成 home 的日志目录跑真实的 ensureDailyClaim 分支判定，
 * 不碰真 ZCode、不发任何上游请求、不执行 open。
 *
 * 场景：A 今日已领 → already-claimed 且不拉起；B 今日日志新鲜但无 claim 行 →
 * needs_full_restart；C 无今日日志 + launch:false → client-not-running。
 *
 * 回归动机（2026-10-06 实测踩过）：readQuota 拿 readdirSync 的文件名（带 `.log`）
 * 与 todayStamp()（纯日期）比较，导致 todayClaimed 恒 false —— 守卫每轮白拉一次
 * 客户端。本测试把三个分支的返回值钉死。
 */
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { ensureDailyClaim } from "./lib/claim.js";
import { readQuota, summarize } from "./lib/quota.js";

const nowSec = Math.floor(Date.now() / 1000);
const snapshot = {
  balanceCount: 1,
  balances: [{ entitlement_id: "zcode-syn", show_name: "GLM-5.3-Flash", total_units: 100000000, used_units: 100, remaining_units: 99999900, available_units: 99999900, reserved_units: null }],
  code: 0, msg: "x",
  plans: [{ name: "ZCode Trust Build", plan_id: "zcode-syn", status: "active" }],
  payload: { code: 0, data: { server_time: nowSec, plans: [{ user_plan_id: "upl", plan_id: "zcode-syn", name: "ZCode Trust Build", status: "active", starts_at: nowSec, ends_at: nowSec + 43200, entitlements: [{ entitlement_id: "e1", show_name: "GLM-5.3-Flash", grant_units: 100000000, unit_type: "token", period: "one_time" }] }] } },
  planCount: 1, success: true, url: "x",
};
const d = new Date();
const stamp = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const claimLine = `[${stamp} 09:00:00.000] [info] [x] [zcode-host] [rpc:call] coding-plan-subscription.claimManualPlan OK (132.8ms)`;
const balLine = `[${stamp} 09:00:05.000] [info] [x] [usage-stats] billing/balance 请求完成 ${JSON.stringify(snapshot)}`;

function mkHome(lines) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "zch-"));
  const logs = path.join(home, ".zcode", "v2", "logs");
  fs.mkdirSync(logs, { recursive: true });
  if (lines.length) fs.writeFileSync(path.join(logs, `${stamp}.log`), lines.join("\n") + "\n");
  return home;
}

const homes = [];
const results = [];

// A：今日已领 → already-claimed，不拉起
{
  const h = mkHome([claimLine, balLine]); homes.push(h);
  const s = summarize(readQuota({ home: h }));
  const r = await ensureDailyClaim({ home: h, launch: true });
  results.push([`A 已领快照 todayClaimed=${s.todayClaimed} cardUsable=${s.cardUsable}`, r.code, r.launched,
    s.todayClaimed === true && r.code === "already-claimed" && r.ok === true && r.launched === false]);
}
// B：今日日志新鲜但无 claim 行 → needs_full_restart（不进 open 分支）
{
  const h = mkHome([balLine]); homes.push(h);
  const s = summarize(readQuota({ home: h }));
  const r = await ensureDailyClaim({ home: h, launch: true, waitForMs: 3000, pollMs: 1000 });
  results.push([`B 活客户端未领 clientRunning=${s.clientRunning}`, r.code, r.launched,
    r.code === "needs_full_restart" && r.ok === false && r.launched === false]);
}
// C：无今日日志 + launch:false → client-not-running
{
  const h = mkHome([]); homes.push(h);
  const r = await ensureDailyClaim({ home: h, launch: false });
  results.push(["C 无客户端且不拉起", r.code, r.launched, r.code === "client-not-running" && r.ok === false]);
}
// D：最新一条是启动期空快照（balances:[]/plans:[]）→ 必须跳过它、取更早的真数据。
//   钉死「空数组 truthy」bug：写 obj.balances||obj.plans 会把 totalUnits 报成 0。
{
  const emptySnap = { balanceCount: 0, balances: [], plans: [], payload: { code: 0, data: { server_time: nowSec, plans: [], balances: [] } }, success: true, url: "x" };
  const emptyLine = `[${stamp} 09:10:00.000] [info] [x] [usage-stats] billing/balance 请求完成 ${JSON.stringify(emptySnap)}`;
  const h = mkHome([balLine, emptyLine]); homes.push(h); // 空快照时间更晚 = 从后往前先命中它
  const s = summarize(readQuota({ home: h }));
  results.push([`D 跳过空快照 totalUnits=${s.totalUnits}`, null, null,
    s.ok === true && s.totalUnits === 100000000 && s.cardUsable === true]);
}
// E：余额只在外层的 payload.data.balances（外层 balances 为空）→ 必须能读出真实额度。
//   钉死「数据不在外层」bug（本机今日 12:55 起的快照就是这个形态）。
{
  const outerEmpty = { balanceCount: 0, balances: [], plans: [], payload: { code: 0, data: { server_time: nowSec, plans: [{ plan_id: "zcode-syn", name: "ZCode Trust Build", status: "active", ends_at: nowSec + 43200 }], balances: [{ entitlement_id: "zcode-syn", show_name: "GLM-5.3-Flash", total_units: 100000000, used_units: 0, remaining_units: 100000000, available_units: 100000000 }] } }, success: true, url: "x" };
  const eLine = `[${stamp} 09:20:00.000] [info] [x] [usage-stats] billing/balance 请求完成 ${JSON.stringify(outerEmpty)}`;
  const h = mkHome([eLine]); homes.push(h);
  const s = summarize(readQuota({ home: h }));
  results.push([`E 外层空但 payload.data.balances 有值 model=${s.model} total=${s.totalUnits}`, null, null,
    s.ok === true && s.totalUnits === 100000000 && s.model === "GLM-5.3-Flash" && s.cardUsable === true]);
}

for (const [label, code, launched, pass] of results) {
  console.log(`${pass ? "✓" : "✗"} ${label} → code=${code} launched=${launched}`);
}
const allOk = results.every(([, , , p]) => p);
for (const h of homes) fs.rmSync(h, { recursive: true, force: true });
console.log(allOk ? "决策表全部分支正确" : "★ 有分支不符");
process.exit(allOk ? 0 : 1);
