/**
 * 实时「JWT 查 plan」路径 —— opt-in，默认关闭。
 *
 * ## 它是什么 / 为什么默认关
 *
 * `claim` 依赖 ZCode 客户端能起来（本机现状是起不来，见 claim.js）。另一条**只读**路径是
 * 直接问服务端「我现在有哪些 plan」：官方客户端的 `billing/current` 接受账户 Bearer JWT
 * （社区 ZhaoAndy 的实测），不像 `billing/claim` 那样需要一次性 captcha。
 *
 * ⚠ 但这是**用你的真实账号凭据向 zcode.z.ai 发请求**。bluechonk 的 README 免责原话：
 * 「直接复用凭据调用服务端可能违反服务条款，请自行评估」。所以：
 *   · 默认 `livePlan:false` —— 不配就不打上游，插件退回纯本地读日志；
 *   · 只 GET、只读、不 mint、不改任何账号状态、不领额度；
 *   · fetch 可注入（`fetchImpl`），离线测试零副作用。
 * 用户显式开 `livePlan:true` 才真正发起 —— 这是知情选择，不是插件自作主张。
 *
 * ## 凭据来源（全本地，绝不外传）
 *
 * JWT 从 `~/.zcode/v2/credentials.json` 的 `zcodejwttoken` 解密得到（enc:v1 =
 * aes-256-gcm，key=sha256(secret)，secret 取 `ZCODE_CREDENTIAL_SECRET`，否则官方
 * fallback 串 `zcode-credential-fallback:<platform>:<home>:<user>`，实测本机 9/9 可解）。
 * `deviceMid` 从 `~/.zcode/v2/telemetry-state.json` 读（balance 端点的设备门用；
 * current 一般不需要，作为可选 header 带上）。
 *
 * 实测本机（只读探测，未发上游）：`active_provider=bigmodel`、`platform=darwin`、
 * 日志 URL `.../billing/balance?app_version=3.14.4`。
 */
import { existsSync, readFileSync } from "node:fs";
import { createHash, createDecipheriv } from "node:crypto";
import { execFileSync } from "node:child_process";
import { homedir, userInfo } from "node:os";

const PLAN_ORIGIN = "https://zcode.z.ai";
const CURRENT_PATH = "/api/v1/zcode-plan/billing/current";
const APP_INFO_PLIST = "/Applications/ZCode.app/Contents/Info.plist";
const APP_VERSION_FALLBACK = "3.14.4";

let cachedAppVersion;
/** 探测本机 ZCode 版本（billing 请求要带 app_version）。一次性缓存，探测失败回退常量。 */
export function detectAppVersion() {
  if (cachedAppVersion !== undefined) return cachedAppVersion;
  let v = null;
  try {
    v = execFileSync("/usr/bin/plutil", ["-extract", "CFBundleShortVersionString", "raw", APP_INFO_PLIST], { encoding: "utf8", timeout: 4000 }).trim() || null;
  } catch {
    try { v = execFileSync("/usr/bin/defaults", ["read", "/Applications/ZCode.app/Contents/Info", "CFBundleShortVersionString"], { encoding: "utf8", timeout: 4000 }).trim() || null; } catch { v = null; }
  }
  cachedAppVersion = v && /^\d+\.\d+/.test(v) ? v : APP_VERSION_FALLBACK;
  return cachedAppVersion;
}

/** 解密 enc:v1:<b64url(iv)>.<b64url(tag)>.<b64url(ct)>；失败返回 null，不抛。 */
export function decryptEncV1(wrapped, secret) {
  if (typeof wrapped !== "string" || !wrapped.startsWith("enc:v1:")) return null;
  const key = createHash("sha256").update(secret).digest();
  const parts = wrapped.slice(7).split(".");
  if (parts.length !== 3) return null;
  try {
    const d = createDecipheriv("aes-256-gcm", key, Buffer.from(parts[0], "base64url"));
    d.setAuthTag(Buffer.from(parts[1], "base64url"));
    return Buffer.concat([d.update(Buffer.from(parts[2], "base64url")), d.final()]).toString("utf8");
  } catch { return null; }
}

function fallbackSecret() {
  let user = process.env.USER || process.env.LOGNAME || "";
  if (!user) { try { user = userInfo().username; } catch { user = "unknown"; } }
  return `zcode-credential-fallback:${process.platform}:${homedir()}:${user}`;
}

/** 从本机凭据库取账户 JWT（解出即返回，不落盘、不打日志、绝不外传）。 */
export function resolveAccountJwt(home = homedir()) {
  const p = `${home}/.zcode/v2/credentials.json`;
  if (!existsSync(p)) return { jwt: null, reason: "no-credentials-file" };
  let obj;
  try { const o = JSON.parse(readFileSync(p, "utf8")); obj = o && o.data ? o.data : o; }
  catch (e) { return { jwt: null, reason: `credentials-parse-failed:${e.code || e.name}` }; }
  const wrapped = obj["zcodejwttoken"];
  if (typeof wrapped !== "string") return { jwt: null, reason: "no-zcodejwttoken" };
  const secret = (process.env.ZCODE_CREDENTIAL_SECRET || "").trim() || fallbackSecret();
  const jwt = decryptEncV1(wrapped, secret);
  return jwt ? { jwt, reason: null } : { jwt: null, reason: "jwt-decrypt-failed" };
}

/** 设备门 mid（可选 header）。 */
export function resolveDeviceMid(home = homedir()) {
  const p = `${home}/.zcode/v2/telemetry-state.json`;
  try { const d = JSON.parse(readFileSync(p, "utf8")); return typeof d.deviceMid === "string" ? d.deviceMid : null; }
  catch { return null; }
}

/**
 * GET billing/current。fetchImpl 可注入（离线测试用假 fetch）；不注入则用 globalThis.fetch。
 * 错误分型（照 bluechonk 的分类法）：上游 401/403 → JWT_EXPIRED；带 3012/3007 → GATED；
 * 其它 → UPSTREAM_ERROR。原始错误体只回摘要，不回传上游原文（可能含 logid/账号信息）。
 */
export async function fetchLivePlans(opts = {}) {
  const {
    fetchImpl = globalThis.fetch,
    appVersion = detectAppVersion(),
    platform = process.platform,
    home = homedir(),
    origin = PLAN_ORIGIN,
    timeoutMs = 12_000,
  } = opts;
  let jwt = opts.jwt;
  if (!jwt) {
    const r = resolveAccountJwt(home);
    if (!r.jwt) return { ok: false, code: r.reason };
    jwt = r.jwt;
  }
  const deviceMid = opts.deviceMid ?? resolveDeviceMid(home);

  const headers = {
    authorization: `Bearer ${jwt}`,
    "x-zcode-app-version": appVersion,
    "x-platform": platform,
    accept: "application/json",
  };
  if (deviceMid) headers["x-device-mid"] = deviceMid;

  const url = `${origin}${CURRENT_PATH}?${new URLSearchParams({ app_version: appVersion, platform })}`;
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  let res;
  try {
    res = await fetchImpl(url, { method: "GET", headers, signal: ac.signal });
  } catch (e) {
    return { ok: false, code: e?.name === "AbortError" ? "TIMEOUT" : `NETWORK_ERROR:${String(e?.message ?? e).slice(0, 80)}` };
  } finally { clearTimeout(timer); }

  const status = res.status;
  if (status === 401 || status === 403) return { ok: false, code: status === 403 ? "JWT_FORBIDDEN" : "JWT_EXPIRED" };

  let body;
  try { body = await res.json(); }
  catch { return { ok: false, code: `PARSE_FAILED_HTTP_${status}` }; }

  // 上游把风控码塞在 JSON body（HTTP 仍 200/405）：3012 unusual activity / 3007 captcha。
  const ucode = body && body.code;
  if (ucode === 3012 || ucode === 3007) return { ok: false, code: ucode === 3012 ? "GATED_RISK" : "GATED_CAPTCHA", detail: String(body?.msg ?? "").slice(0, 60) };
  if (!res.ok) return { ok: false, code: `UPSTREAM_${status}`, detail: String(body?.msg ?? body?.message ?? "").slice(0, 60) };

  const plans = ((body?.data?.plans) || []).map((p) => ({
    planId: p.plan_id ?? null, name: p.name ?? null, status: p.status ?? null,
    startsAt: p.starts_at ?? null, endsAt: p.ends_at ?? null,
    entitlements: (p.entitlements || []).map((e) => ({
      showName: e.show_name ?? null, grantUnits: e.grant_units ?? null,
      unitType: e.unit_type ?? null, period: e.period ?? null, capabilities: e.capabilities ?? [],
    })),
  }));
  return { ok: true, code: null, fetchedAt: new Date().toISOString(), planCount: body?.data?.plan_count ?? plans.length, plans };
}

export default { fetchLivePlans, resolveAccountJwt, resolveDeviceMid, decryptEncV1 };
