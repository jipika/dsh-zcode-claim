/**
 * client 半边的重启前验证（记忆 plugin-client-half.md L10 的 fake-loader 方法论）。
 * client 声明是新增半边 → 必须完全重启才装载，不能拿当前运行的桌面实例做实验
 * （那会杀掉会话）。这套探针在 Node 里 stub 出 __ModuleLoader__/document/React，
 * 真跑 factory → apply() → 组件主渲染路径，硬断言 apply 全程不抛错。
 *
 * ⚠ 关键：必须断言 applyError===null，而不是只看 CSS 注入 —— apply 中途抛错时，
 * 抛错点之前的样式照样注入，视觉"看起来正常"，会放过注册失败。
 */
import fs from "node:fs";

const captured = { spec: null };
const doc = {
  head: { children: [], appendChild(el) { this.children.push(el); } },
  createElement(tag) { const el = { tag, dataset: {}, textContent: "", removed: false, remove() { el.removed = true; } }; return el; },
};
globalThis.window = {
  __ModuleLoader__: { load: (spec) => { captured.spec = spec; } },
  setInterval: () => 1, clearInterval: () => {}, setTimeout: () => 1, clearTimeout: () => {},
  confirm: () => true, addEventListener() {}, removeEventListener() {},
};
globalThis.document = doc;
globalThis.fetch = async () => { throw new Error("network disabled in probe"); };

const src = fs.readFileSync(new URL("./lib/client.js", import.meta.url), "utf8");
// client.js 是 classic script（顶层 window.*），用 Function 包一层执行
// eslint-disable-next-line no-new-func
new Function("window", "document", "fetch", "setInterval", "clearInterval", "console", src)(
  globalThis.window, globalThis.document, globalThis.fetch, window.setInterval, window.clearInterval, console,
);

if (!captured.spec) { console.error("✗ factory 未被 __ModuleLoader__.load 捕获"); process.exit(1); }
console.log("✓ load 捕获 id =", captured.spec.id);

// React stub：createElement 就地记录；useState 用初值；useEffect 不跑副作用；useCallback 直返
let createCount = 0;
const React = {
  createElement: (type, props, ...children) => { createCount++; return { type, props: props || {}, children: children.flat(Infinity) }; },
  useState: (init) => [typeof init === "function" ? init() : init, () => {}],
  useEffect: () => {},
  useCallback: (fn) => fn,
  useMemo: (fn) => fn(),
};
const requireStub = (spec) => (spec === "react" ? React : {});
const { apply, inject } = captured.spec.factory(requireStub);
console.log("✓ factory 返回 apply =", typeof apply, "| exports.inject =", JSON.stringify(inject));

// 假 ctx：slots 提供 inject/register，记录注册参数
const registered = [];
const slotInjects = [];
const disposers = [];
const ctx = {
  _services: { slots: {
    inject: (name, cb) => { slotInjects.push(name); const d = cb(); if (typeof d === "function") disposers.push(d); return () => {}; },
    register: (meta, Comp) => { registered.push({ meta, Comp }); return () => {}; },
  } },
  get: (k) => (k === "slots" ? ctx._services.slots : undefined),
  effect: (fn) => { const d = fn(); if (typeof d === "function") disposers.push(d); return () => {}; },
  log: { info() {}, warn() {}, debug() {} },
};

let applyError = null;
try { apply(ctx); } catch (e) { applyError = e; }
console.log(applyError ? `✗ apply 抛错：${applyError.message}` : "✓ apply 全程未抛错");

// 收集断言
const checks = [];
const ck = (label, ok, extra = "") => { checks.push([label, ok]); console.log(`${ok ? "✓" : "✗"} ${label}${extra ? " — " + extra : ""}`); };

ck("注入 style 且带 data-plugin", doc.head.children.length === 1 && doc.head.children[0].dataset.plugin === "dsh-zcode-claim");
ck("两个 seam 都尝试注册", slotInjects.length === 2, JSON.stringify(slotInjects));
const bundleCfg = registered.find((r) => r.meta.name === "plugins.bundle.config");
const pluginTab = registered.find((r) => r.meta.name === "settings.plugins.tab");
ck("plugins.bundle.config 的 key===包名", !!bundleCfg && bundleCfg.meta.key === "dsh-zcode-claim");
ck("settings.plugins.tab 的 id===包名（避开空白坑）", !!pluginTab && pluginTab.meta.id === "dsh-zcode-claim");
ck("settings.plugins.tab 的 label 是函数（官方样本形态）", !!pluginTab && typeof pluginTab.meta.label === "function");

// 真渲染组件主路径（首帧全 null），必须不抛错且产出一棵树
let renderErr = null, tree = null;
try { tree = pluginTab.Comp(); } catch (e) { renderErr = e; }
ck("ClaimPanel 首渲染未抛错", renderErr === null, renderErr ? String(renderErr.message) : `createElement 调用 ${createCount} 次`);
const flat = JSON.stringify(tree, (k, v) => (k === "props" && v.style ? undefined : v));
ck("渲染含面板根 class zcc-panel", typeof flat === "string" && flat.includes("zcc-panel"));
ck("含'立即领取'按钮（首帧 todayClaimed=false 分支）", typeof flat === "string" && flat.includes("立即领取"));
ck("含 zcode_quota 提示文案", typeof flat === "string" && flat.includes("zcode_quota"));

// dispose 应移除 style 且不抛错
let dispErr = null;
try { for (const d of disposers) { try { d(); } catch {} } } catch (e) { dispErr = e; }
ck("dispose 链未抛错", dispErr === null);
ck("dispose 后 style 被移除", doc.head.children[0] && doc.head.children[0].removed === true);

const failed = checks.filter(([, ok]) => !ok).length;
console.log(`\n合计 ${checks.length - failed}/${checks.length} 通过${applyError ? "（apply 抛错 = 硬失败）" : ""}`);
process.exit((failed || applyError) ? 1 : 0);
