/**
 * ZCode 额度解析 —— 纯本地，零上游请求。
 *
 * 唯一可靠的数据源是 ZCode 客户端自己的日志：它每隔几分钟就打一次
 * `GET /api/v1/zcode-plan/billing/balance` 并把完整响应记进日志（本机实测
 * 2026-10-04 一天 11 条、近 14 天共 397 条）。而外部直接查该端点会被设备门
 * 拦（`3001 parameter error` / `400`，见 bluechonk 与 ZhaoAndy 的实测记录），
 * 所以「读日志」不是偷懒，是唯一不需要风控对抗的取数路径。
 *
 * 日志行形状（外层 Electron 主日志套内层 host 日志，不是整行 JSON）：
 *   [2026-10-04 12:15:27.980] [info] [pid:11768] [main] [host-log] (local-1) [host]
 *   [...] [pid:11826] [usage-stats] billing/balance 请求完成 {"balanceCount":1,"balances":[...],"plans":[...]}
 * ⇒ 取「请求完成」之后的第一个 `{` 做花括号配平，才是可靠的边界（不能 split）。
 */
import { readdirSync, statSync, openSync, readSync, closeSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

/** 读文件尾部 limit 字节，绝不整文件吞进内存（日志可达数 MB）。 */
function readTail(path, limit) {
  let stat;
  try { stat = statSync(path); } catch { return null; }
  if (!stat.isFile() || stat.size === 0) return null;
  const length = Math.min(limit, stat.size);
  let fd = null;
  try {
    fd = openSync(path, "r");
    const buf = Buffer.allocUnsafe(length);
    const read = readSync(fd, buf, 0, length, stat.size - length);
    return buf.subarray(0, read).toString("utf8");
  } catch { return null; }
  finally { if (fd !== null) { try { closeSync(fd); } catch {} } }
}

/** 从「请求完成」锚点后取花括号配平的 JSON；失败返回 null（不抛）。 */
function extractJson(line, anchor) {
  const a = line.indexOf(anchor);
  if (a === -1) return null;
  const start = line.indexOf("{", a);
  if (start === -1) return null;
  let depth = 0, inStr = false, esc = false;
  for (let i = start; i < line.length; i++) {
    const ch = line[i];
    if (esc) { esc = false; continue; }
    if (ch === "\\") { if (inStr) esc = true; continue; }
    if (ch === "\"") { inStr = !inStr; continue; }
    if (inStr) continue;
    if (ch === "{") depth++;
    else if (ch === "}") { if (--depth === 0) { try { return JSON.parse(line.slice(start, i + 1)); } catch { return null; } } }
  }
  return null;
}

const LOG_STAMP = /^\d{4}-\d{2}-\d{2}\.log$/;

export function logsDir(home = homedir()) { return join(home, ".zcode", "v2", "logs"); }

function todayStamp(d = new Date()) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/** 客户端进程在不在跑（pgrep 之外的低成本判据：日志文件是否仍在被追加）。 */
export function isClientRunning(home = homedir()) {
  const p = join(logsDir(home), `${todayStamp()}.log`);
  try { return Date.now() - statSync(p).mtimeMs < 130_000; } catch { return false; }
}

/**
 * ⚠ 判断一条 balance 日志里**有没有真实额度数据**（两个坑，本机实测都踩过）：
 *   · 写 `obj.balances || obj.plans` 是错的 —— **空数组在 JS 是 truthy**。客户端启动瞬间
 *     会先打几条 `balances:[]` / `plans:[]` 的空快照（实测今日 12:54:34~35 连续 5 条），
 *     「取最新一条」就会命中空快照、报出 `totalUnits:0` ⇒ 看板显示"剩余 0"的假象。
 *   · 数据**不一定在外层**：外层 `balances` 为空时，真实余额在
 *     `payload.data.balances[0]`（实测今日最新几条快照就是这个形态）。
 * ⇒ 只有任一位置存在**带 units 的余额条目**才算有数据。
 */
function hasRealBalance(obj) {
  const list = (obj.balances || []).concat((obj.payload && obj.payload.data && obj.payload.data.balances) || []);
  return list.some((b) => b && (Number(b.total_units) > 0 || Number(b.remaining_units) > 0 || Number(b.available_units) > 0));
}

/** 取余额条目：外层优先，空则退到 payload.data.balances。 */
function pickBalance(obj) {
  const outer = obj.balances || [];
  const inner = (obj.payload && obj.payload.data && obj.payload.data.balances) || [];
  return outer.find((b) => b && (b.total_units != null || b.remaining_units != null)) || inner[0] || outer[0] || {};
}

/** 取 plan：外层 plans 是摘要版（无 ends_at），payload.data.plans 才含时间，合并取全。 */
function pickPlan(obj) {
  const inner = (obj.payload && obj.payload.data && obj.payload.data.plans) || [];
  const outer = obj.plans || [];
  return { ...outer[0], ...inner[0] };
}

/**
 * 扫最近 maxFiles 个日志，找最新的额度快照 + 领取/启动痕迹。
 * @returns {{snapshot:?object, todayClaimed:boolean, lastClaimAt:?string,
 *            todayLogExists:boolean, scannedFiles:string[], sourceFile:?string}}
 */
export function readQuota({ home = homedir(), maxFiles = 3, tailBytes = 8 * 1024 * 1024 } = {}) {
  const dir = logsDir(home);
  // ⚠ readdirSync 给的是带 `.log` 后缀的文件名，与 todayStamp()（纯日期）比较必须补
  // 后缀 —— 漏掉会让「今日已领」永远判否、`todayLogExists` 永远 false（e2e 实测踩过：
  // 明明当天已领，守卫仍每轮白拉一次客户端）。
  const todayFile = `${todayStamp()}.log`;
  const out = { home, snapshot: null, todayClaimed: false, lastClaimAt: null, todayLogExists: false, scannedFiles: [], sourceFile: null, claimCountToday: 0 };
  if (!existsSync(dir)) { out.error = "no-log-dir"; return out; }
  let names = [];
  try { names = readdirSync(dir).filter((n) => LOG_STAMP.test(n)).sort().reverse(); } catch (e) { out.error = "readdir-failed"; return out; }
  out.todayLogExists = names[0] === todayFile;
  const files = names.slice(0, Math.max(1, maxFiles));
  out.scannedFiles = files;
  for (const f of files) {
    const text = readTail(join(dir, f), tailBytes);
    if (text === null) continue;
    const lines = text.split("\n");
    // 从后往前：先找 balance 快照，再找 claim 痕迹
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i];
      if (out.snapshot === null && line.includes("billing/balance") && line.includes("请求完成")) {
        const obj = extractJson(line, "请求完成");
        // ⚠ 不能用 `obj.balances || obj.plans`（空数组 truthy，会命中启动期的空快照）。
        if (obj && hasRealBalance(obj)) {
          const stamp = (line.match(/^\[([\d-]+ [\d:.]+)\]/) || [])[1] || null;
          out.snapshot = { at: stamp, file: f, ...obj };
          out.sourceFile = f;
        }
      }
      // 领取证据：官方 host 侧 RPC `coding-plan-subscription.claimManualPlan`
      if (line.includes("coding-plan-subscription.claimManualPlan")) {
        // ⚠ f 带 `.log` 后缀，必须与 todayFile 比（不是 todayStamp()）。
        if (f === todayFile) out.claimCountToday++;
        if (out.lastClaimAt === null) out.lastClaimAt = (line.match(/^\[([\d-]+ [\d:.]+)\]/) || [])[1] || f;
        out.todayClaimed = out.todayClaimed || f === todayFile;
      }
    }
    if (out.snapshot !== null && out.lastClaimAt !== null) break;
  }
  return out;
}

/** 把快照整理成人/模型都好看的一行。 */
export function summarize(q) {
  const s = q && q.snapshot;
  if (!s) return { ok: false, reason: (q && q.error) || "no-balance-record-in-logs", message: "本地日志里还没有额度记录（ZCode 客户端需要至少跑过一次）" };
  const bal = pickBalance(s);
  // plan 合并两份：外层 plans[0] 是摘要版（name/plan_id/status，**没有** ends_at），
  // payload.data.plans[0] 才含 starts_at/ends_at/entitlements（实测踩过：只读前者
  // endsAt 恒 null）。注意 brief 放后面会覆盖 inner 的时间字段，所以 outer 在前。
  const plan = pickPlan(s);
  const total = Number(bal.total_units ?? 0), used = Number(bal.used_units ?? 0), remain = Number(bal.remaining_units ?? bal.available_units ?? 0);
  const ends = Number(plan.ends_at ?? plan.period_end ?? bal.expires_at ?? 0);
  const endsLocal = ends > 0 ? new Date(ends * 1000).toLocaleString("zh-CN", { hour12: false, timeZone: "Asia/Shanghai" }) : null;
  const nowSec = Math.floor(Date.now() / 1000);
  return {
    ok: true,
    planId: plan.plan_id ?? bal.entitlement_id ?? null,
    planName: plan.name ?? null,
    status: plan.status ?? null,
    model: bal.show_name ?? null,
    totalUnits: total, usedUnits: used, remainingUnits: remain,
    usedPercent: total > 0 ? Math.round((used / total) * 1000) / 10 : null,
    endsAt: ends || null, endsAtLocal: endsLocal,
    expired: ends > 0 && nowSec > ends,
    secondsToExpiry: ends > 0 ? ends - nowSec : null,
    logSnapshotAt: s.at ?? null, sourceFile: q.sourceFile ?? null,
    // ⚠ 快照新鲜度：额度卡当日 24:00 作废（实测 ends_at = 次日 00:00:00），
    // 而日志里的 balance 是客户端**当时**的快照。拿昨天的快照当「今天还有额度」
    // 是误报（实测踩过：10-04 的 1 亿卡在 10-05 仍被报成 active）。
    snapshotIsFromToday: (s.at ?? "").slice(0, 10) === todayStamp(),
    snapshotAgeMs: s.at ? Date.now() - new Date(s.at.replace(" ", "T") + "+08:00").getTime() : null,
    todayClaimed: q.todayClaimed === true, claimCountToday: q.claimCountToday ?? 0,
    clientRunning: isClientRunning(q.home),
    // 卡的真实可用性 = 未过期 且 快照来自今天
    cardUsable: ends > 0 ? (nowSec < ends) : ((s.at ?? "").slice(0, 10) === todayStamp()),
  };
}

export default { readQuota, summarize, logsDir, isClientRunning };
