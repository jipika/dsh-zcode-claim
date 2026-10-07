/**
 * 「让 ZCode 官方客户端自己去领每日额度」——macOS 专用，零风控对抗。
 *
 * ## 为什么是这个形态（三条本地实测证据）
 *
 * ① **领取是官方客户端自己在启动时做的**。本机 `~/.zcode/v2/logs/*.log` 里，
 *    `coding-plan-subscription.claimManualPlan` 这条 host RPC **每个有日志的日期
 *    恰好一次**（09-24 / 09-28 / 09-30 / 10-01 / 10-04 各 1 条），紧跟在
 *    `marketing-touch.query` 之后，理由标记是 `settings:marketing-plan-claim`。
 *    ⇒ 「每天点一次左下角卡片」这件事，官方已经自动化了。
 * ② **真正的缺口只是「客户端今天没启动」**。09-29 / 10-02 / 10-03 / 10-05 没有日志
 *    文件 = 客户端没跑 = 当天的卡没领。额度按天发、当日 24:00 作废（实测
 *    plan `zcode-v3-start-plan-trust-1004` 的 ends_at = 次日 00:00:00 北京时间）。
 * ③ **自建 HTTP 领取走不通**：`billing/claim` 要一次性阿里云 captcha param（只能在
 *    真 Electron renderer 里 mint，重复提交撞 F008），`billing/balance` 外部查会被
 *    设备门拦成 3001/400。⇒ 借用官方客户端的启动路径，而不是复刻它的请求。
 *
 * 所以本模块只做一件事：**以不抢前台的方式把 ZCode 拉起来（`open -g`），
 * 然后在它的日志里确认今天那条 claim 记录出现**。客户端在跑就什么都不用做。
 *
 * ⚠ 诚实边界：若 ZCode 在「今天已经启动过、但当时领失败」的状态下运行，
 * 本模块不会二次触发（claim 只在启动流程里跑一次）；此时返回
 * `needs_full_restart`，由用户决定是否重启客户端。
 */
import { execFile } from "node:child_process";
import { statSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir, platform } from "node:os";
import { readQuota, logsDir } from "./quota.js";

export const BUNDLE_ID = "dev.zcode.app";
export const APP_NAME = "ZCode";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 今天是否已有 claim 记录（读日志，零网络）。 */
function claimState(home) {
  const q = readQuota({ home, maxFiles: 1 });
  return { todayClaimed: q.todayClaimed === true, claimCountToday: q.claimCountToday ?? 0, lastClaimAt: q.lastClaimAt ?? null };
}

/** 今天的日志文件是否已出现（客户端起来的最早信号）。 */
function todayLog(home) {
  const d = new Date();
  const stamp = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  const p = join(logsDir(home), `${stamp}.log`);
  try { const st = statSync(p); return { exists: true, path: p, mtimeMs: st.mtimeMs, ageMs: Date.now() - st.mtimeMs, size: st.size }; }
  catch { return { exists: false, path: p }; }
}

/** 主进程 pid（不在则 null）。只匹配 app bundle 内的主二进制，不误伤 helper/CLI。 */
export function zcodeMainPid() {
  return new Promise((resolve) => {
    execFile("/bin/pgrep", ["-x", "ZCode"], { timeout: 3_000 }, (err, out) => {
      const pid = err ? null : (out.trim().split("\n")[0] ?? "");
      resolve(pid && /^\d+$/.test(pid) ? Number(pid) : null);
    });
  });
}

/** 后台拉起 ZCode：-g 不抢前台，-j 隐藏窗口（仍会走完启动流程）。 */
function openBackground() {
  return new Promise((resolve) => {
    execFile("/usr/bin/open", ["-g", "-j", "-b", BUNDLE_ID], { timeout: 15_000 }, (err) => {
      if (!err) return resolve({ ok: true, how: "open -g -j -b dev.zcode.app" });
      // bundle id 解析失败时退回应用名
      execFile("/usr/bin/open", ["-g", "-j", "-a", APP_NAME], { timeout: 15_000 }, (err2) =>
        resolve(err2 ? { ok: false, error: `${err.message} | ${err2.message}`, how: "open" } : { ok: true, how: `open -g -j -a ${APP_NAME}` }));
    });
  });
}

/**
 * 确保今天的额度被领到。
 * @param {{home?:string, waitForMs?:number, pollMs?:number, launch?:boolean, signal?:{aborted:boolean}}} opts
 */
export async function ensureDailyClaim(opts = {}) {
  const home = opts.home ?? homedir();
  const waitForMs = opts.waitForMs ?? 90_000;
  const pollMs = opts.pollMs ?? 2_000;
  const allowLaunch = opts.launch !== false;

  if (platform() !== "darwin") {
    return { ok: false, code: "unsupported-platform", message: `本模块只在 macOS 上驱动 ZCode 桌面客户端（当前 ${platform()}）` };
  }

  const before = claimState(home);
  if (before.todayClaimed) {
    return { ok: true, code: "already-claimed", launched: false, message: `今天已领取（${before.lastClaimAt ?? "记录存在"}，共 ${before.claimCountToday} 次）`, before };
  }

  const log0 = todayLog(home);
  if (log0.exists && log0.ageMs < 130_000) {
    // 客户端正在跑，但今天的 claim 记录还没出现：可能刚起来，也可能启动时那次没走到。
    const t0 = Date.now();
    while (Date.now() - t0 < waitForMs) {
      await sleep(pollMs);
      const st = claimState(home);
      if (st.todayClaimed) return { ok: true, code: "claimed-while-waiting", launched: false, message: `领取记录已出现（${st.lastClaimAt}）`, before, after: st };
      if (opts.signal?.aborted) return { ok: false, code: "aborted", message: "等待被中止", before };
    }
    return { ok: false, code: "needs_full_restart", launched: false, message: "ZCode 正在运行但今天没有 claimManualPlan 记录 —— 该 RPC 只在启动流程里跑一次，需完全退出 ZCode 再启动才会重试。", before };
  }

  if (!allowLaunch) return { ok: false, code: "client-not-running", launched: false, message: "ZCode 未运行，且本次禁止拉起（launch:false）", before };

  const launch = await openBackground();
  if (!launch.ok) return { ok: false, code: "launch-failed", launched: false, message: `拉起 ZCode 失败：${launch.error}`, before };

  // 先判进程是否真的活着：本机实测 ZCode 起来 165ms 就干净 exit(0)（launchd 记
  // "exited due to exit(0), ran for 165ms"），此时 open 的 exit code 仍是 0，
  // 所以「open 成功」不等于「客户端活着」—— 必须独立探测，否则错误会被吞掉。
  const aliveAt = [];
  for (let i = 0; i < 4; i++) { aliveAt.push(await zcodeMainPid()); await sleep(1_500); }
  const everAlive = aliveAt.some((p) => p !== null);
  if (!everAlive) {
    return { ok: false, code: "launch-died", launched: true, how: launch.how, pids: aliveAt,
      message: `已执行后台拉起（${launch.how}），但 ZCode 主进程始终没有出现 —— 进程启动即退出（本机日志形态为 launchd "exited due to exit(0), ran for ~165ms"）。客户端起不来时领取无从发生，需先修复 ZCode 本身。`, before };
  }

  // 等今天的日志出现（进程起来）→ 再等 claim 记录
  const t0 = Date.now();
  let logAppeared = false;
  while (Date.now() - t0 < waitForMs) {
    await sleep(pollMs);
    const lg = todayLog(home);
    if (!logAppeared && lg.exists) logAppeared = true;
    const st = claimState(home);
    if (st.todayClaimed) {
      return { ok: true, code: "claimed-after-launch", launched: true, how: launch.how, waitedMs: Date.now() - t0, message: `已后台拉起 ZCode 并完成领取（${st.lastClaimAt}，等待 ${Math.round((Date.now() - t0) / 1000)}s）`, before, after: st };
    }
    if (opts.signal?.aborted) return { ok: false, code: "aborted", launched: true, message: "等待被中止（ZCode 已拉起）", before };
  }
  return { ok: false, code: "timeout", launched: true, how: launch.how, logAppeared, pidNow: await zcodeMainPid(), message: `已后台拉起 ZCode，但 ${Math.round(waitForMs / 1000)}s 内没有出现今天的 claim 记录${logAppeared ? "" : "（连今天的日志文件都还没生成，客户端可能没起来）"}`, before };
}

export default { ensureDailyClaim, BUNDLE_ID, APP_NAME };
