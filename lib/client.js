/**
 * dsh-zcode-claim 客户端半边（零构建手写，React 由宿主静态模块表提供）。
 *
 * 通过 `window.__ModuleLoader__.load({id, factory})` 注册进 DSH 客户端模块系统。
 * 双 seam 各取所需、独立降级：
 *   · `plugins.bundle.config`（DSH 0.2.0+「插件 → 已安装 → 点进本插件」详情页；
 *     槽按包名分发，key 必须与 package.json 的 name 逐字一致）
 *   · `settings.section`（0.1.x 世代设置对话框；宿主未声明该槽时 inject 永不触发，注册无害）
 *
 * 数据全部走同源 fetch 打本插件的 host 路由（浏览器自动带会话 cookie）：
 *   GET  /dsh-zcode-claim/status  只读看板
 *   POST /dsh-zcode-claim/claim   触发一轮领取（会后台拉起 ZCode）
 *
 * ⚠ 新增 client 半边必须**完全重启**应用才生效（不是刷新）—— 它改的是
 * package.json 的 dsh.client / exports 声明，boot HTML 的模块清单要重算。
 */
window.__ModuleLoader__.load({
  id: "dsh-zcode-claim",
  factory: (require) => {
    const React = require("react");
    const h = React.createElement;

    const PLUGIN_ID = "dsh-zcode-claim";
    const STATUS_URL = "/dsh-zcode-claim/status";
    const CLAIM_URL = "/dsh-zcode-claim/claim";
    const PLAN_URL = "/dsh-zcode-claim/plan";
    const POLL_MS = 60_000;

    const CSS = `
.zcc-panel{display:flex;flex-direction:column;gap:10px;padding:14px 16px;
  border-radius:var(--dsw-radius-lg,16px);background:var(--dsw-alias-bg-layer-2,rgba(127,127,127,.08));
  font-size:13px;line-height:1.6;color:var(--dsw-alias-label-secondary,inherit)}
.zcc-row{display:flex;align-items:center;gap:8px}
.zcc-dot{flex:none;width:8px;height:8px;border-radius:50%;background:var(--dsw-alias-label-tertiary,#888)}
.zcc-dot.ok{background:#34c759}.zcc-dot.bad{background:#ff5d5d}.zcc-dot.warn{background:#f5a623}
.zcc-title{font-weight:600;color:var(--dsw-alias-label-primary,inherit)}
.zcc-hint{color:var(--dsw-alias-label-tertiary,#999);font-size:12px}
.zcc-btn{margin-left:auto;padding:2px 10px;border:none;border-radius:var(--dsw-radius-sm,8px);cursor:pointer;
  background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.15));
  color:var(--dsw-alias-label-primary,inherit);font-size:12px}
.zcc-btn:hover{filter:brightness(1.2)}
.zcc-btn:disabled{opacity:.55;cursor:default;filter:none}
.zcc-bar{flex:1;height:6px;border-radius:3px;background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.15));overflow:hidden}
.zcc-fill{height:100%;border-radius:3px;background:var(--dsw-alias-brand-primary,#5b8cff)}
.zcc-num{flex:none;min-width:170px;text-align:right;font-variant-numeric:tabular-nums;font-size:12px}
.zcc-err{color:var(--dsw-alias-label-tertiary,#999);font-size:12px}
`;

    async function fetchJson(url, init) {
      const res = await fetch(url, Object.assign({ cache: "no-store" }, init || {}));
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json();
    }

    function fmtTokens(n) {
      if (!Number.isFinite(n)) return "—";
      if (n >= 1e8) return `${(n / 1e8).toFixed(2)} 亿`;
      if (n >= 1e4) return `${(n / 1e4).toFixed(1)} 万`;
      return String(n);
    }

    /** 卡的真实状态：可用 / 已过期 / 快照非今日 / 无数据。 */
    function cardState(q) {
      if (!q || q.ok !== true) return { cls: "warn", text: "无额度记录（ZCode 至少跑过一次才会有）" };
      if (q.expired) return { cls: "bad", text: "已过期（额度卡当日 24:00 作废）" };
      if (!q.cardUsable) return { cls: "warn", text: "快照不是今天的，不可用" };
      return { cls: "ok", text: "可用" };
    }

    function fmtCountdown(sec) {
      if (!Number.isFinite(sec) || sec <= 0) return "—";
      const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60);
      return h > 0 ? `${h} 小时 ${m} 分` : `${m} 分`;
    }

    function ClaimPanel() {
      const [data, setData] = React.useState(null);
      const [error, setError] = React.useState(null);
      const [updatedAt, setUpdatedAt] = React.useState(null);
      const [busy, setBusy] = React.useState(false);
      const [claimMsg, setClaimMsg] = React.useState(null);

      const refresh = React.useCallback(() => {
        fetchJson(STATUS_URL)
          .then((d) => { setData(d); setError(null); setUpdatedAt(new Date()); })
          .catch((e) => setError(String(e && e.message ? e.message : e)));
      }, []);

      React.useEffect(() => {
        refresh();
        const t = setInterval(refresh, POLL_MS);
        return () => clearInterval(t);
      }, [refresh]);

      const onClaim = React.useCallback(() => {
        setBusy(true);
        setClaimMsg(null);
        fetchJson(CLAIM_URL, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })
          .then((r) => { setClaimMsg({ ok: r.ok === true, code: r.code, text: r.message || "" }); refresh(); })
          .catch((e) => setClaimMsg({ ok: false, code: "request-failed", text: String(e && e.message ? e.message : e) }))
          .finally(() => setBusy(false));
      }, [refresh]);

      // 实时查 plan：仅当后端 config.livePlan=true 时按钮才出现（点了才发上游只读 GET）
      const [planData, setPlanData] = React.useState(null);
      const [planBusy, setPlanBusy] = React.useState(false);
      const onPlan = React.useCallback(() => {
        setPlanBusy(true);
        fetchJson(PLAN_URL, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })
          .then((r) => setPlanData({ ok: r.ok === true, code: r.code, plans: r.plans || [], fetchedAt: r.fetchedAt, message: r.message || "" }))
          .catch((e) => setPlanData({ ok: false, code: "request-failed", plans: [], message: String(e && e.message ? e.message : e) }))
          .finally(() => setPlanBusy(false));
      }, []);

      const q = data && data.quota ? data.quota : null;
      const st = cardState(q);
      const total = q ? Number(q.totalUnits) || 0 : 0;
      const used = q ? Number(q.usedUnits) || 0 : 0;
      const pct = total > 0 ? Math.min(100, (used / total) * 100) : 0;
      const cfg = data && data.config;
      const liveOn = !!(data && (data.livePlanEnabled || (cfg && cfg.livePlan)));

      return h(
        "div",
        { className: "zcc-panel" },
        h(
          "div",
          { className: "zcc-row" },
          h("span", { className: "zcc-title" }, "ZCode 每日额度"),
          h("span", { className: "zcc-hint" }, "被动读客户端日志 · 官方启动领取"),
          h("button", { className: "zcc-btn", onClick: onClaim, disabled: busy || !!(q && q.todayClaimed) },
            busy ? "领取中…" : (q && q.todayClaimed ? "今日已领取" : "立即领取")),
        ),

        error
          ? h("div", { className: "zcc-row" }, h("span", { className: "zcc-err" }, `宿主状态不可达（${error}）`))
          : null,

        h(
          "div",
          { className: "zcc-row" },
          h("span", { className: `zcc-dot ${st.cls}` }),
          h("span", { className: "zcc-title" }, st.text),
          q && q.planId ? h("span", { className: "zcc-hint" }, q.planId) : null,
        ),

        q && q.ok
          ? h(
            "div",
            { className: "zcc-row" },
            h("span", { style: { flex: "none", width: 120, overflow: "hidden", textOverflow: "ellipsis" } }, q.model || "(unknown)"),
            h("div", { className: "zcc-bar" }, h("div", { className: "zcc-fill", style: { width: `${pct.toFixed(1)}%` } })),
            h("span", { className: "zcc-num" }, `${fmtTokens(q.remainingUnits)} / ${fmtTokens(q.totalUnits)} 剩余 · 已用 ${(q.usedPercent ?? 0).toFixed(1)}%`),
          )
          : null,

        q && q.ok && q.endsAtLocal
          ? h("div", { className: "zcc-row" },
            h("span", { className: "zcc-hint" }, `到期 ${q.endsAtLocal}`),
            Number.isFinite(q.secondsToExpiry) && q.secondsToExpiry > 0
              ? h("span", { className: "zcc-hint" }, `（剩 ${fmtCountdown(q.secondsToExpiry)}）`)
              : null)
          : null,

        q && q.ok
          ? h("div", { className: "zcc-row" },
            h("span", { className: "zcc-hint" },
              `客户端进程：${q.clientRunning ? "在跑" : "未运行"}`,
              " · 今日领取次数：", String(q.claimCountToday ?? 0),
              q.sourceFile ? ` · 快照 ${q.sourceFile}` : ""))
          : null,

        data && data.pid
          ? h("div", { className: "zcc-row" }, h("span", { className: "zcc-hint" }, `ZCode pid ${data.pid}`))
          : null,

        cfg
          ? h("div", { className: "zcc-row" },
            h("span", { className: "zcc-hint" },
              `守卫：${cfg.enabled ? `每 ${Math.round((cfg.intervalMs || 0) / 60000)} 分钟` : "已关闭"}`,
              " · 自动拉起：", cfg.autoLaunch ? "开" : "关"))
          : null,

        claimMsg
          ? h("div", { className: "zcc-row" },
            h("span", { className: `zcc-dot ${claimMsg.ok ? "ok" : "warn"}` }),
            h("span", { className: claimMsg.ok ? "zcc-title" : "zcc-err" },
              `${claimMsg.ok ? "领取完成" : "领取未完成"}（${claimMsg.code}）${claimMsg.text ? ` — ${claimMsg.text}` : ""}`))
          : null,

        // 实时查 plan：仅后端 config.livePlan=true 时才出现（点了才用账户 JWT 发只读 GET）
        liveOn
          ? h(
            "div",
            { className: "zcc-row" },
            h("span", { className: "zcc-hint" }, "实时查 plan（用账户 JWT 只读 billing/current）"),
            h("button", { className: "zcc-btn", onClick: onPlan, disabled: planBusy }, planBusy ? "查询中…" : "查实时"),
          )
          : null,

        liveOn && planData
          ? h("div", { className: "zcc-row" },
            h("span", { className: `zcc-dot ${planData.ok ? "ok" : "warn"}` }),
            h("span", { className: planData.ok ? "zcc-title" : "zcc-err" },
              planData.ok
                ? `实时 plan ${planData.plans.length} 个${planData.fetchedAt ? ` @ ${new Date(planData.fetchedAt).toLocaleTimeString()}` : ""}`
                : `查询未完成（${planData.code}）${planData.message ? ` — ${planData.message}` : ""}`))
          : null,

        liveOn && planData && planData.ok && planData.plans.length
          ? planData.plans.map((p, i) => h("div", { className: "zcc-row", key: p.planId || i },
            h("span", { className: "zcc-hint" }, `· ${p.name || p.planId || "?"} [${p.status || "-"}] ${(p.entitlements || []).map((e) => `${e.showName || "?"} ${e.grantUnits != null ? fmtTokens(e.grantUnits) : "?"}${e.period ? `(${e.period})` : ""}`).join(" / ") || "（无权益）"}`)))
          : null,

        h("div", { className: "zcc-row" },
          h("span", { className: "zcc-hint" },
            updatedAt ? `更新于 ${updatedAt.toLocaleTimeString()} · 每 ${Math.round(POLL_MS / 1000)} 秒自动刷新` : "加载中…")),

        // 常驻提示：不依赖 updatedAt（首帧就有），让任何时刻都能看到「模型侧也有入口」
        h("div", { className: "zcc-row" },
          h("span", { className: "zcc-hint" }, "模型侧可用工具 zcode_quota（status / claim / plan）")),
      );
    }

    // 每条注册独立降级：slot 形态变化或宿主未声明该槽，只损失那一条，
    // 不把异常抛进装载器（那会连带整条 entry 判未激活）。
    const NOOP_DISPOSER = () => {};
    const pendingDisposers = [];
    function guardContribution(label, fn) {
      try { return fn(); } catch (e) { console.error(`[dsh-zcode-claim] 客户端注册失败（${label}）: ${e}`); return undefined; }
    }

    function apply(ctx) {
      const style = document.createElement("style");
      style.dataset.plugin = PLUGIN_ID;
      style.textContent = CSS;
      document.head.appendChild(style);

      const slots = ctx.get("slots");
      if (!slots || typeof slots.inject !== "function") {
        console.warn("[dsh-zcode-claim] slots 服务不可用，面板未注册");
        ctx.effect(() => () => style.remove());
        return;
      }

      guardContribution("plugins.bundle.config", () => {
        const dispose = slots.inject("plugins.bundle.config", () =>
          guardContribution("plugins.bundle.config register", () =>
            slots.register({ name: "plugins.bundle.config", key: PLUGIN_ID }, ClaimPanel)) ?? NOOP_DISPOSER,
        );
        pendingDisposers.push(dispose);
      });

      guardContribution("settings.plugins.tab", () => {
        const dispose = slots.inject("settings.plugins.tab", () =>
          guardContribution("settings.plugins.tab register", () =>
            slots.register({ name: "settings.plugins.tab", id: PLUGIN_ID, order: 45, label: () => "ZCode 额度" }, ClaimPanel)) ?? NOOP_DISPOSER,
        );
        pendingDisposers.push(dispose);
      });

      ctx.effect(() => () => {
        for (const dispose of pendingDisposers) { try { dispose && dispose(); } catch { /* 卸载容错 */ } }
        style.remove();
      });
    }

    const module = { exports: {} };
    module.exports.apply = apply;
    // 等 slots 服务就绪再 materialize：apply 提前跑时 ctx.get("slots") 为 undefined，
    // 面板会静默丢失（inject 声明让装载器等待服务启动）。
    module.exports.inject = ["slots"];
    return module.exports;
  },
});
