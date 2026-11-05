"use client";
import { useCallback, useEffect, useRef, useState } from "react";

type Account = {
  id: string;
  name: string;
  enabled: boolean;
  cash: number;
  initialEquity: number;
  walletAddress?: string;
  maxMarketRisk: number;
  maxTotalRisk: number;
  dailyLossLimit: number;
  fixedShares: number;
  revision?: number;
};
type Slot = {
  id: string;
  symbol: string;
  duration: number;
  strategy: string;
  threshold: number;
  blockedReason: string | null;
};
type Market = {
  id: string;
  symbol: string;
  duration: number;
  status: string;
  end: number;
  bookAgeMs: number | null;
  source?: "manual" | "predict-auto-v1";
  resolutionProvider?: string;
  resolutionSource?: string;
  blockedReason?: string;
};
type MarketAutomation = {
  enabled: boolean;
  symbols: string[];
  durations: number[];
  providers: string[];
  lastRefreshAt: number | null;
  discovered: number;
  eligible: number;
  registered: number;
  rejected: number;
};
type Pnl = {
  realizedPnl: number;
  cash: number;
  committed: number;
  fees: number;
  fills: number;
  initialEquity: number;
};
type Row = Record<string, unknown>;
type Observation = {
  time: number;
  readiness: string;
  reasons: string[];
  activeMarkets: number;
  staleBooks: number;
  runtime: {
    lastTickMs: number | null;
    engineErrors: number;
    collectorEnabled: boolean;
  } | null;
  events: { seq: number; time: number; type: string; data: unknown }[];
  candleFeeds: { id: string; bars: number; latest: number | null }[];
};
type Snapshot = {
  accounts: Account[];
  slots: Slot[];
  markets: Market[];
  automation: MarketAutomation;
  obs: Observation;
  accountId: string;
  pnl: Pnl | null;
  positions: Row[];
  fills: Row[];
  features: unknown[];
  selected: string[];
  configRevision: number;
};
type Locale = "en" | "zh";
const money = (v: number, locale: Locale) =>
  new Intl.NumberFormat(locale === "zh" ? "zh-CN" : "en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(v);
const time = (v: number, locale: Locale) =>
  new Date(v).toLocaleString(locale === "zh" ? "zh-CN" : "en-US", {
    hour12: false,
  });
async function api<T>(
  path: string,
  method = "GET",
  body?: unknown,
): Promise<T> {
  const r = await fetch(`/api/bot/${path}`, {
    method,
    headers:
      body === undefined ? undefined : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
    cache: "no-store",
    signal: AbortSignal.timeout(12000),
  });
  const data = await r.json();
  if (!r.ok) throw new Error(data.error?.code ?? `http_${r.status}`);
  return data.data as T;
}
const tabLabels = {
  en: ["Overview", "Strategies", "Markets", "Fills & positions", "Operations"],
  zh: ["总览", "策略配置", "市场行情", "成交与持仓", "运行监控"],
} satisfies Record<Locale, string[]>;
const labels: Record<string, Record<Locale, string>> = {
  worker_not_configured: {
    en: "The production Worker is not configured. Set BOT_API_URL and BOT_API_TOKEN on the server.",
    zh: "尚未配置生产 Worker。请设置服务端 BOT_API_URL 与 BOT_API_TOKEN。",
  },
  worker_unreachable: {
    en: "The Worker is unreachable. Check its status and network connection.",
    zh: "无法连接 Worker，请检查服务状态与网络。",
  },
  unauthorized: {
    en: "Your session has expired. Sign in again.",
    zh: "登录已过期，请重新登录。",
  },
  dashboard_unreachable: {
    en: "The control-room service is unreachable.",
    zh: "无法连接控制台服务",
  },
  invalid_access_key: {
    en: "Invalid dashboard access key.",
    zh: "控制台访问密钥无效。",
  },
  origin_rejected: {
    en: "The request origin was rejected. Reload this page and try again.",
    zh: "请求来源被拒绝。请刷新此页面后重试。",
  },
  dashboard_not_configured: {
    en: "Dashboard login is not configured.",
    zh: "控制台登录尚未配置。",
  },
  tenant_not_configured: {
    en: "Your identity is not assigned to a trading workspace. Contact the service operator.",
    zh: "当前身份尚未分配交易工作区，请联系服务运营方。",
  },
  engine_heartbeat_missing: {
    en: "Engine heartbeat missing",
    zh: "引擎心跳缺失",
  },
  recent_engine_error: { en: "Recent engine error", zh: "近期引擎错误" },
  writer_lease_missing: {
    en: "This Worker does not own the execution lease",
    zh: "此 Worker 未持有执行租约",
  },
  collector_disabled: { en: "Market collector disabled", zh: "行情采集未开启" },
  no_active_registered_markets: {
    en: "No active approved markets",
    zh: "没有已审核的活跃市场",
  },
  stale_order_books: { en: "Order books are stale", zh: "订单簿已过期" },
  recent_collector_error: {
    en: "Recent collector error",
    zh: "近期行情采集错误",
  },
  insufficient_or_stale_candles: {
    en: "Candle history is insufficient or stale",
    zh: "K 线历史不足或已过期",
  },
  revision_conflict: {
    en: "This configuration changed elsewhere. Refresh and review before saving again.",
    zh: "此配置已在其他位置更新。请刷新并重新检查后再保存。",
  },
  historical_settlement_time_unknown: {
    en: "This account has legacy settlements with unknown timing and cannot be activated until reconciled.",
    zh: "此账户存在结算时间未知的历史记录，完成对账前无法启动。",
  },
};

export default function Dashboard() {
  const [locale, setLocale] = useState<Locale>("zh");
  const [auth, setAuth] = useState<boolean | null>(null),
    [configured, setConfigured] = useState(true),
    [authMode, setAuthMode] = useState<"legacy" | "authjs">("legacy"),
    [key, setKey] = useState("");
  const [tab, setTab] = useState(0),
    [accountId, setAccountId] = useState(""),
    [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [error, setError] = useState(""),
    [notice, setNotice] = useState(""),
    [busy, setBusy] = useState(false),
    [updated, setUpdated] = useState(0);
  const [selection, setSelection] = useState<string[]>([]),
    [dirty, setDirty] = useState(false),
    [now, setNow] = useState(Date.now());
  const dirtyRef = useRef(false),
    request = useRef(0),
    activeId = useRef(accountId);
  const [book, setBook] = useState<{ id: string; data: unknown } | null>(null);
  const tabs = tabLabels[locale];
  const tx = useCallback(
    (zh: string, en: string) => (locale === "zh" ? zh : en),
    [locale],
  );
  const label = useCallback(
    (code: string) => labels[code]?.[locale] ?? code,
    [locale],
  );
  useEffect(() => {
    const saved = window.localStorage.getItem("predict_locale");
    const next = saved === "en" || saved === "zh" ? saved : "zh";
    setLocale(next);
    setAccountId(window.localStorage.getItem("predict_account_id") ?? "");
    document.documentElement.lang = next === "zh" ? "zh-CN" : "en";
  }, []);
  const changeLocale = (next: Locale) => {
    setLocale(next);
    window.localStorage.setItem("predict_locale", next);
    document.documentElement.lang = next === "zh" ? "zh-CN" : "en";
  };
  useEffect(() => {
    fetch("/api/session")
      .then((r) => r.json())
      .then((x) => {
        setAuth(x.data.authenticated);
        setConfigured(x.data.configured);
        setAuthMode(x.data.authMode ?? "legacy");
      })
      .catch(() => {
        setAuth(false);
        setError("dashboard_unreachable");
      });
  }, []);
  const refresh = useCallback(
    async (preferredId?: string) => {
      const seq = ++request.current;
      try {
        const [accounts, slots, markets, obs, automation] = await Promise.all([
          api<Account[]>("accounts"),
          api<Slot[]>("strategies"),
          api<Market[]>("markets"),
          api<Observation>("observability"),
          api<MarketAutomation>("markets/automation"),
        ]);
        const savedAccountId =
            window.localStorage.getItem("predict_account_id"),
          id =
            preferredId ||
            accountId ||
            accounts.find((candidate) => candidate.id === savedAccountId)?.id ||
            accounts[0]?.id ||
            "";
        const [pnl, positions, fills, features, config] = id
          ? await Promise.all([
              api<Pnl>(`accounts/${id}/pnl`),
              api<Row[]>(`accounts/${id}/positions`),
              api<Row[]>(`accounts/${id}/fills?limit=50`),
              api<unknown[]>(`accounts/${id}/features`),
              api<{ enabledSlots: string[]; revision: number }>(
                `accounts/${id}/strategies`,
              ),
            ])
          : [null, [], [], [], { enabledSlots: [], revision: 0 }];
        if (seq !== request.current) return;
        setSnapshot({
          accounts,
          slots,
          markets,
          automation,
          obs,
          accountId: id,
          pnl,
          positions,
          fills,
          features,
          selected: config.enabledSlots,
          configRevision: config.revision,
        });
        if (!dirtyRef.current) setSelection(config.enabledSlots);
        setUpdated(Date.now());
        setError("");
      } catch (e) {
        if (seq === request.current) {
          const message = (e as Error).message;
          setError(message);
          if (message === "unauthorized") setAuth(false);
        }
      }
    },
    [accountId],
  );
  useEffect(() => {
    if (!auth) return;
    void refresh();
    const timer = setInterval(() => {
      if (document.visibilityState === "visible") void refresh();
    }, 15000);
    return () => {
      clearInterval(timer);
      request.current++;
    };
  }, [auth, refresh]);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  async function mutate(path: string, method: string, body: unknown) {
    setBusy(true);
    setNotice("");
    try {
      await api(path, method, body);
      setNotice("saved");
      await refresh();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function createPaperAccount(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setBusy(true);
    setNotice("");
    setError("");
    try {
      const form = new FormData(e.currentTarget),
        created = await api<Account>("accounts", "POST", {
          name: form.get("name"),
          initialEquity: Number(form.get("equity")),
        });
      activeId.current = created.id;
      setAccountId(created.id);
      window.localStorage.setItem("predict_account_id", created.id);
      dirtyRef.current = false;
      setDirty(false);
      setNotice("saved");
      await refresh(created.id);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function signIn(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      const r = await fetch("/api/session", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ key }),
      });
      const x = await r.json();
      if (!r.ok) throw Error(x.error.code);
      setKey("");
      setAuth(true);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  const account = snapshot?.accounts.find((a) => a.id === snapshot.accountId);
  const stale = !updated || now - updated > 30000 || !!error;
  const current =
    snapshot?.accountId === (accountId || snapshot?.accounts[0]?.id || "");
  const disabled = busy || stale || !current;
  const accountControlDisabled = busy || !current;
  return (
    <div className="shell">
      <aside className="sidebar">
        <a
          className="brand"
          href="/"
          aria-label={tx("Predict 控制台", "Predict control room")}
        >
          <span className="brand-icon">↗</span>predict
          <span className="brand-dot">.</span>
          <small>CONTROL ROOM</small>
        </a>
        <div className="workspace-label">
          {tx("量化交易工作台", "QUANT TRADING WORKSPACE")}
        </div>
        <nav>
          {tabs.map((t, i) => (
            <button
              key={t}
              className={tab === i ? "nav active" : "nav"}
              onClick={() => setTab(i)}
            >
              <span>{["◫", "⌘", "◈", "⇄", "◉"][i]}</span>
              {t}
              {i === 4 && (
                <i
                  className={
                    snapshot?.obs.readiness === "ready" ? "dot green" : "dot"
                  }
                />
              )}
            </button>
          ))}
        </nav>
        <div className="side-bottom">
          <span className="badge">PAPER TRADING</span>
          <p>
            {tx(
              "模拟执行 · 实盘未开放",
              "Simulation only · Live trading disabled",
            )}
          </p>
          <small>Predict.fun / BNB Chain</small>
        </div>
      </aside>
      <main>
        <header>
          <div className="breadcrumb">
            {tx("工作台", "Workspace")} <span>/</span> {tabs[tab]}
          </div>
          <div className="header-actions">
            <span className="badge muted">USDT</span>
            <div className="locale-switch" aria-label={tx("语言", "Language")}>
              <button
                className={locale === "en" ? "active" : ""}
                aria-pressed={locale === "en"}
                onClick={() => changeLocale("en")}
              >
                EN
              </button>
              <button
                className={locale === "zh" ? "active" : ""}
                aria-pressed={locale === "zh"}
                onClick={() => changeLocale("zh")}
              >
                中文
              </button>
            </div>
            {auth && (
              <button
                className="text-button"
                onClick={async () => {
                  if (authMode === "authjs") {
                    window.location.href = "/api/auth/signout";
                    return;
                  }
                  const r = await fetch("/api/session", { method: "DELETE" });
                  if (r.ok) {
                    request.current++;
                    setAuth(false);
                    setSnapshot(null);
                    setUpdated(0);
                  }
                }}
              >
                {tx("退出登录", "Sign out")}
              </button>
            )}
            <span className="avatar">P</span>
          </div>
        </header>
        <div className="content">
          <div className="heading">
            <div>
              <div className="eyebrow">PREDICT.FUN / OPERATIONS</div>
              <h1>{tabs[tab]}</h1>
              <p>
                {tx(
                  "从策略信号到成交结果，每一步都有据可查。",
                  "Trace every step from strategy signal to execution result.",
                )}
              </p>
            </div>
            {auth && (
              <div className="actions">
                <button disabled={busy} onClick={() => void refresh()}>
                  ↻ {tx("刷新", "Refresh")}
                </button>
                <button
                  className="danger"
                  disabled={busy}
                  onClick={() => {
                    if (
                      confirm(
                        tx(
                          "暂停全部模拟账户？现有持仓将保留。",
                          "Pause all paper accounts? Existing positions will remain open.",
                        ),
                      )
                    )
                      void mutate("kill-switch", "POST", {});
                  }}
                >
                  {tx("暂停全部账户", "Pause all accounts")}
                </button>
              </div>
            )}
          </div>
          {error && (
            <div className="alert error" role="alert">
              {label(error)}
              {updated > 0 &&
                tx(
                  " · 当前显示上次成功同步的数据",
                  " · Showing data from the last successful sync",
                )}
            </div>
          )}
          {notice && (
            <div className="alert" role="status">
              {notice === "saved"
                ? tx(
                    "已保存，变更已提交到 Worker。",
                    "Saved. Changes were submitted to the Worker.",
                  )
                : notice === "strategy_saved"
                  ? tx(
                      "策略已保存；仅影响新意图。",
                      "Strategies saved; only new intents are affected.",
                    )
                  : notice}
            </div>
          )}
          {auth === null ? (
            <div className="empty">
              {tx("正在检查会话…", "Checking session…")}
            </div>
          ) : !auth ? (
            <section className="login panel">
              <div className="eyebrow">SECURE ACCESS</div>
              <h2>
                {tx("连接你的交易工作台", "Connect to your trading workspace")}
              </h2>
              <p>
                {tx(
                  authMode === "authjs"
                    ? "使用已分配到交易工作区的账户登录。交易凭证仅保存在服务端。"
                    : "使用独立控制台访问密钥登录。交易所密钥仅保存在服务端。",
                  authMode === "authjs"
                    ? "Sign in with an account assigned to a trading workspace. Trading credentials remain server-side."
                    : "Sign in with the dedicated dashboard access key. Exchange credentials remain server-side.",
                )}
              </p>
              {authMode === "authjs" ? (
                <button
                  className="primary"
                  disabled={!configured}
                  onClick={() => {
                    window.location.href = "/api/auth/signin";
                  }}
                >
                  {tx("使用账户登录 →", "Sign in with account →")}
                </button>
              ) : (
                <form onSubmit={signIn}>
                  <label>
                    {tx("控制台访问密钥", "Dashboard access key")}
                    <input
                      type="password"
                      autoComplete="current-password"
                      value={key}
                      onChange={(e) => setKey(e.target.value)}
                      required
                      minLength={32}
                    />
                  </label>
                  <button className="primary" disabled={busy || !configured}>
                    {tx("进入控制台 →", "Enter control room →")}
                  </button>
                </form>
              )}
              {!configured && (
                <div className="alert">
                  {tx(
                    "尚未配置登录：在 Vercel 设置 DASHBOARD_ACCESS_KEY（至少 32 位随机字符）。",
                    "Login is not configured. Set DASHBOARD_ACCESS_KEY in Vercel to at least 32 random characters.",
                  )}
                </div>
              )}
              <div className="login-note">
                {tx(
                  "模拟账户 / 风险管理 / 运行监控",
                  "Paper accounts / Risk controls / Operations",
                )}
                <br />
                {tx(
                  "没有模拟收益展示，所有数据均来自已连接的 Worker。",
                  "No fabricated returns. All data comes from the connected Worker.",
                )}
              </div>
            </section>
          ) : (
            <>
              <div className="connection">
                <span>
                  <i className={`dot ${!stale ? "green" : ""}`} />
                  {!stale
                    ? tx("Worker 已连接", "Worker connected")
                    : tx("等待 Worker 连接", "Waiting for Worker")}
                </span>
                <span>
                  {tx("15 秒自动同步", "Auto-sync every 15 seconds")} ·{" "}
                  {updated
                    ? `${tx("最近同步", "Last synced")} ${time(updated, locale)}`
                    : tx("尚未同步", "Not yet synced")}
                </span>
                <span className="badge">{tx("仅模拟交易", "PAPER ONLY")}</span>
              </div>
              <div className="account-bar">
                <label>
                  {tx("账户", "Account")}
                  <select
                    aria-label={tx("选择账户", "Select account")}
                    value={accountId || snapshot?.accountId || ""}
                    onChange={(e) => {
                      if (
                        dirtyRef.current &&
                        !confirm(
                          tx(
                            "放弃尚未保存的策略变更并切换账户？",
                            "Discard unsaved strategy changes and switch accounts?",
                          ),
                        )
                      )
                        return;
                      request.current++;
                      activeId.current = e.target.value;
                      setAccountId(e.target.value);
                      window.localStorage.setItem(
                        "predict_account_id",
                        e.target.value,
                      );
                      dirtyRef.current = false;
                      setDirty(false);
                      setNotice("");
                    }}
                  >
                    <option value="" disabled>
                      {tx("选择模拟账户", "Select a paper account")}
                    </option>
                    {snapshot?.accounts.map((a) => (
                      <option value={a.id} key={a.id}>
                        {a.name}
                      </option>
                    ))}
                  </select>
                </label>
                {account && (
                  <>
                    <span
                      className={`badge ${account.enabled && snapshot?.obs.readiness === "ready" ? "positive" : "muted"}`}
                    >
                      {account.enabled
                        ? snapshot?.obs.readiness === "ready"
                          ? tx("运行中", "Running")
                          : tx(
                              "已启用 · 当前受阻",
                              "Enabled · currently blocked",
                            )
                        : tx("已暂停", "Paused")}
                    </span>
                    <button
                      disabled={
                        account.enabled ? accountControlDisabled : disabled
                      }
                      onClick={() =>
                        void mutate(`accounts/${account.id}`, "PATCH", {
                          enabled: !account.enabled,
                          expectedRevision: account.revision ?? 0,
                        })
                      }
                    >
                      {account.enabled
                        ? tx("暂停账户", "Pause account")
                        : tx("启动模拟账户", "Start paper account")}
                    </button>
                    <small className="mono">
                      {account.walletAddress ||
                        tx(
                          "未关联钱包 · 模拟资金",
                          "No wallet linked · Paper funds",
                        )}
                    </small>
                  </>
                )}
              </div>
              {!snapshot ? (
                <div className="panel empty">
                  <h2>
                    {tx(
                      "等待真实运行数据",
                      "Waiting for live operational data",
                    )}
                  </h2>
                  <p>
                    {tx(
                      "连接持久化 Worker 后，账户、策略、市场和运行指标将在此显示。",
                      "Accounts, strategies, markets, and runtime metrics appear after a persistent Worker is connected.",
                    )}
                  </p>
                  <p>
                    {tx(
                      "Next.js 服务在线不代表交易引擎已就绪。",
                      "An online Next.js service does not mean the trading engine is ready.",
                    )}
                  </p>
                </div>
              ) : (
                <>
                  {tab === 0 && (
                    <>
                      <div className="stats">
                        {[
                          [
                            tx("已实现盈亏", "Realized P&L"),
                            snapshot.pnl?.realizedPnl,
                            tx(
                              "结算后净收益，已扣费用",
                              "Net settled return after fees",
                            ),
                          ],
                          [
                            tx("可用资金", "Available funds"),
                            snapshot.pnl?.cash,
                            tx(
                              "USDT · 模拟账户现金",
                              "USDT · Paper account cash",
                            ),
                          ],
                          [
                            tx("持仓占用", "Committed capital"),
                            snapshot.pnl?.committed,
                            tx("未结算成本 + 费用", "Unsettled cost + fees"),
                          ],
                          [
                            tx("累计费用", "Total fees"),
                            snapshot.pnl?.fees,
                            `${snapshot.pnl?.fills ?? 0} ${tx("笔成交", "fills")}`,
                          ],
                        ].map(([title, value, note], i) => (
                          <section className="panel stat" key={String(title)}>
                            <div>
                              {title}
                              <span>↗</span>
                            </div>
                            <strong
                              className={
                                i === 0 && Number(value) > 0 ? "profit" : ""
                              }
                            >
                              {typeof value === "number"
                                ? money(value, locale)
                                : "—"}
                              <small> USDT</small>
                            </strong>
                            <p>{note}</p>
                          </section>
                        ))}
                      </div>
                      <div className="two-col">
                        <section className="panel">
                          <div className="panel-title">
                            <h2>{tx("执行概况", "Execution overview")}</h2>
                            <span className="badge">
                              {tx("实时状态", "LIVE STATUS")}
                            </span>
                          </div>
                          <div className="metric-row">
                            <span>{tx("活跃市场", "Active markets")}</span>
                            <strong>{snapshot.obs.activeMarkets}</strong>
                          </div>
                          <div className="metric-row">
                            <span>{tx("过期订单簿", "Stale order books")}</span>
                            <strong
                              className={
                                snapshot.obs.staleBooks ? "warning" : ""
                              }
                            >
                              {snapshot.obs.staleBooks}
                            </strong>
                          </div>
                          <div className="metric-row">
                            <span>
                              {tx("已启用策略槽位", "Enabled strategy slots")}
                            </span>
                            <strong>
                              {snapshot.selected.length} /{" "}
                              {snapshot.slots.length}
                            </strong>
                          </div>
                          <div className="metric-row">
                            <span>{tx("未实现盈亏", "Unrealized P&L")}</span>
                            <strong>—</strong>
                          </div>
                          <p className="footnote">
                            {tx(
                              "未提供可执行平仓估值，未实现盈亏不计为零。模拟成交不能代表实盘收益。",
                              "No executable close valuation is available, so unrealized P&L is not treated as zero. Paper fills do not represent live returns.",
                            )}
                          </p>
                        </section>
                        <section className="panel">
                          <div className="panel-title">
                            <h2>{tx("运行检查", "Readiness checks")}</h2>
                            <span
                              className={`badge ${snapshot.obs.readiness === "ready" ? "positive" : ""}`}
                            >
                              {snapshot.obs.readiness === "ready"
                                ? tx("就绪", "Ready")
                                : tx("需要关注", "Attention needed")}
                            </span>
                          </div>
                          {snapshot.obs.reasons.length ? (
                            snapshot.obs.reasons.map((r) => (
                              <div className="check" key={r}>
                                <span className="warning">△</span>
                                {label(r)}
                              </div>
                            ))
                          ) : (
                            <div className="check">
                              ✓{" "}
                              {tx(
                                "引擎和市场数据检查通过",
                                "Engine and market-data checks passed",
                              )}
                            </div>
                          )}
                          <p className="footnote">
                            {tx(
                              "就绪检查仅覆盖运行健康度，实盘仍处于关闭状态。",
                              "Readiness covers runtime health only. Live trading remains disabled.",
                            )}
                          </p>
                        </section>
                      </div>
                      <section className="panel">
                        <h2>{tx("新建模拟账户", "Create paper account")}</h2>
                        <form
                          className="inline-form"
                          onSubmit={(e) => void createPaperAccount(e)}
                        >
                          <label>
                            {tx("账户名称", "Account name")}
                            <input
                              name="name"
                              required
                              maxLength={80}
                              placeholder={tx(
                                "例如：BTC 趋势策略",
                                "Example: BTC trend strategy",
                              )}
                            />
                          </label>
                          <label>
                            {tx("初始资金（USDT）", "Initial equity (USDT)")}
                            <input
                              name="equity"
                              type="number"
                              defaultValue={10000}
                              min={100}
                              max={1e9}
                              required
                            />
                          </label>
                          <button className="primary" disabled={disabled}>
                            {tx("创建暂停账户", "Create paused account")}
                          </button>
                        </form>
                      </section>
                      {account && (
                        <section
                          className="panel"
                          key={`${account.id}:${account.revision ?? 0}`}
                        >
                          <h2>{tx("风险参数", "Risk parameters")}</h2>
                          <form
                            className="inline-form"
                            onSubmit={(e) => {
                              e.preventDefault();
                              const f = new FormData(e.currentTarget);
                              void mutate(`accounts/${account.id}`, "PATCH", {
                                maxMarketRisk: Number(f.get("market")) / 100,
                                maxTotalRisk: Number(f.get("total")) / 100,
                                dailyLossLimit: Number(f.get("daily")) / 100,
                                fixedShares: Number(f.get("shares")),
                                expectedRevision: account.revision ?? 0,
                              });
                            }}
                          >
                            {[
                              [
                                tx("单市场风险 %", "Per-market risk %"),
                                "market",
                                account.maxMarketRisk * 100,
                                1,
                              ],
                              [
                                tx("总风险 %", "Total risk %"),
                                "total",
                                account.maxTotalRisk * 100,
                                5,
                              ],
                              [
                                tx("日亏损限额 %", "Daily loss limit %"),
                                "daily",
                                account.dailyLossLimit * 100,
                                5,
                              ],
                              [
                                tx(
                                  "每市场目标份额",
                                  "Target shares per market",
                                ),
                                "shares",
                                account.fixedShares,
                                10000,
                              ],
                            ].map(([label, name, value, max]) => (
                              <label key={String(name)}>
                                {label}
                                <input
                                  name={String(name)}
                                  type="number"
                                  min={name === "shares" ? 1 : 0.01}
                                  max={Number(max)}
                                  step={name === "shares" ? 1 : 0.01}
                                  defaultValue={Number(value)}
                                  required
                                />
                              </label>
                            ))}
                            <button disabled={disabled}>
                              {tx("保存风险参数", "Save risk parameters")}
                            </button>
                          </form>
                          {account.initialEquity * account.maxMarketRisk <
                            1.02 && (
                            <p className="footnote warning">
                              {tx(
                                "当前单市场风险预算低于模拟撮合的最低 1 USDT 名义金额加费用；账户不会成交。",
                                "The per-market risk budget is below the paper minimum of 1 USDT notional plus fees; this account cannot fill.",
                              )}
                            </p>
                          )}
                        </section>
                      )}
                    </>
                  )}
                  {tab === 1 && (
                    <section className="panel">
                      <div className="panel-title">
                        <div>
                          <h2>{tx("策略槽位", "Strategy slots")}</h2>
                          <p>
                            {tx(
                              "置信分数不是胜率。缺少源定义的策略禁止启用。",
                              "Confidence scores are not win probabilities. Strategies with missing source definitions cannot be enabled.",
                            )}
                          </p>
                        </div>
                        <button
                          className="primary"
                          disabled={disabled || !account || !dirty}
                          onClick={async () => {
                            if (!account) return;
                            setBusy(true);
                            try {
                              await api(
                                `accounts/${account.id}/strategies`,
                                "PUT",
                                {
                                  enabledSlots: selection,
                                  expectedRevision: snapshot.configRevision,
                                },
                              );
                              dirtyRef.current = false;
                              setDirty(false);
                              setNotice("strategy_saved");
                              await refresh();
                            } catch (e) {
                              setError((e as Error).message);
                            } finally {
                              setBusy(false);
                            }
                          }}
                        >
                          {tx("保存策略", "Save strategies")} {dirty ? "•" : ""}
                        </button>
                      </div>
                      <div className="table-wrap">
                        <table>
                          <thead>
                            <tr>
                              <th>{tx("启用", "Enabled")}</th>
                              <th>{tx("策略", "Strategy")}</th>
                              <th>{tx("标的 / 周期", "Symbol / interval")}</th>
                              <th>{tx("阈值", "Threshold")}</th>
                              <th>{tx("状态", "Status")}</th>
                            </tr>
                          </thead>
                          <tbody>
                            {snapshot.slots.map((s) => (
                              <tr key={s.id}>
                                <td>
                                  <input
                                    aria-label={`${tx("策略", "Strategy")} ${s.id}`}
                                    type="checkbox"
                                    checked={selection.includes(s.id)}
                                    disabled={
                                      !!s.blockedReason || !account || disabled
                                    }
                                    onChange={(e) => {
                                      dirtyRef.current = true;
                                      setDirty(true);
                                      setSelection((prev) =>
                                        e.target.checked
                                          ? [...prev, s.id]
                                          : prev.filter((id) => id !== s.id),
                                      );
                                    }}
                                  />
                                </td>
                                <td>
                                  <span className="slot-id">
                                    {s.id.padStart(2, "0")}
                                  </span>
                                  {s.strategy}
                                </td>
                                <td>
                                  {s.symbol} <small>{s.duration / 60}m</small>
                                </td>
                                <td className="mono">
                                  {s.threshold.toFixed(3)}
                                </td>
                                <td>
                                  {s.blockedReason ? (
                                    <span
                                      className="warning"
                                      title={s.blockedReason}
                                    >
                                      {tx(
                                        "源定义缺失",
                                        "Source definition missing",
                                      )}
                                    </span>
                                  ) : (
                                    <span className="badge positive">
                                      {tx("可用", "Available")}
                                    </span>
                                  )}
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                      <details>
                        <summary>
                          {tx("最近特征与信号", "Recent features and signals")}
                        </summary>
                        <pre>{JSON.stringify(snapshot.features, null, 2)}</pre>
                      </details>
                    </section>
                  )}
                  {tab === 2 && (
                    <section className="panel">
                      <div className="panel-title">
                        <h2>{tx("已审核市场", "Approved markets")}</h2>
                        <span
                          className={`badge ${snapshot.automation.enabled ? "positive" : "muted"}`}
                        >
                          {snapshot.automation.enabled
                            ? tx(
                                "自动注册已开启",
                                "Automatic registration enabled",
                              )
                            : tx("手动注册模式", "Manual registration mode")}
                        </span>
                      </div>
                      {snapshot.automation.enabled && (
                        <div className="stats compact-stats">
                          {[
                            [
                              tx("发现", "Discovered"),
                              snapshot.automation.discovered,
                            ],
                            [
                              tx("符合策略", "Eligible"),
                              snapshot.automation.eligible,
                            ],
                            [
                              tx("本轮注册", "Registered"),
                              snapshot.automation.registered,
                            ],
                            [
                              tx("拒绝", "Rejected"),
                              snapshot.automation.rejected,
                            ],
                          ].map(([name, value]) => (
                            <div className="metric-row" key={String(name)}>
                              <span>{name}</span>
                              <strong>{value}</strong>
                            </div>
                          ))}
                        </div>
                      )}
                      <p className="footnote">
                        {snapshot.automation.enabled
                          ? tx(
                              `仅自动注册策略允许的 ${snapshot.automation.symbols.join("/")}、${snapshot.automation.durations.map((duration) => `${duration / 60}m`).join("/")} 市场；规则或结算证据含糊时自动关闭并等待人工处理。`,
                              `Only policy-approved ${snapshot.automation.symbols.join("/")} ${snapshot.automation.durations.map((duration) => `${duration / 60}m`).join("/")} markets are registered. Ambiguous rules or settlement evidence fail closed for manual review.`,
                            )
                          : tx(
                              "市场继续通过 Worker API 人工审核注册；订单簿超过 1 秒视为过期。",
                              "Markets continue to use manual Worker API registration. Order books older than one second are stale.",
                            )}
                      </p>
                      {!snapshot.markets.length ? (
                        <div className="empty">
                          {tx(
                            "没有已注册市场，当前不会产生交易。",
                            "No markets are registered, so no trades can be created.",
                          )}
                        </div>
                      ) : (
                        <div className="table-wrap">
                          <table>
                            <thead>
                              <tr>
                                <th>{tx("市场", "Market")}</th>
                                <th>{tx("周期", "Interval")}</th>
                                <th>{tx("状态", "Status")}</th>
                                <th>{tx("注册来源", "Registration")}</th>
                                <th>{tx("结束时间", "End time")}</th>
                                <th>{tx("盘口时效", "Book age")}</th>
                                <th>{tx("盘口", "Order book")}</th>
                              </tr>
                            </thead>
                            <tbody>
                              {snapshot.markets.map((m) => {
                                const age =
                                  m.bookAgeMs === null
                                    ? null
                                    : m.bookAgeMs + Math.max(0, now - updated);
                                return (
                                  <tr key={m.id}>
                                    <td>
                                      <strong>{m.symbol}</strong>
                                      <small className="block mono">
                                        {m.id}
                                      </small>
                                    </td>
                                    <td>{m.duration / 60}m</td>
                                    <td>
                                      {m.blockedReason
                                        ? `BLOCKED · ${m.blockedReason}`
                                        : m.status === "OPEN" && now >= m.end
                                          ? "EXPIRED"
                                          : m.status}
                                    </td>
                                    <td>
                                      {m.source === "predict-auto-v1"
                                        ? tx(
                                            "Predict 自动",
                                            "Predict automatic",
                                          )
                                        : tx("人工", "Manual")}
                                    </td>
                                    <td>{time(m.end, locale)}</td>
                                    <td
                                      className={
                                        age === null || age > 1000
                                          ? "warning"
                                          : "profit"
                                      }
                                    >
                                      {age === null
                                        ? tx("无数据", "No data")
                                        : `${(age / 1000).toFixed(1)}s`}
                                    </td>
                                    <td>
                                      <button
                                        onClick={async () => {
                                          try {
                                            setBook({
                                              id: m.id,
                                              data: await api(
                                                `markets/${m.id}/book`,
                                              ),
                                            });
                                          } catch (e) {
                                            setError((e as Error).message);
                                          }
                                        }}
                                      >
                                        {tx("查看", "View")}
                                      </button>
                                    </td>
                                  </tr>
                                );
                              })}
                            </tbody>
                          </table>
                        </div>
                      )}
                      {book && (
                        <details open>
                          <summary>
                            {tx("YES 方向盘口", "YES-side order book")} ·{" "}
                            {book.id}
                            {tx("（手动快照）", " (manual snapshot)")}
                          </summary>
                          <pre>{JSON.stringify(book.data, null, 2)}</pre>
                        </details>
                      )}
                    </section>
                  )}
                  {tab === 3 && (
                    <>
                      <section className="panel">
                        <h2>{tx("未结算持仓", "Open positions")}</h2>
                        <DataTable
                          rows={snapshot.positions}
                          columns={[
                            "market",
                            "direction",
                            "quantity",
                            "cost",
                            "fees",
                          ]}
                          locale={locale}
                        />
                      </section>
                      <section className="panel">
                        <h2>{tx("成交账本", "Fill ledger")}</h2>
                        <p className="footnote">
                          {tx(
                            "按时间升序显示前 50 笔，完整历史可通过游标 API 查询。金额单位 USDT。",
                            "Shows the first 50 fills in chronological order. Query the cursor API for complete history. Amounts are in USDT.",
                          )}
                        </p>
                        <DataTable
                          rows={snapshot.fills}
                          columns={[
                            "market",
                            "direction",
                            "quantity",
                            "cost",
                            "fee",
                            "pnl",
                            "time",
                          ]}
                          locale={locale}
                        />
                      </section>
                    </>
                  )}
                  {tab === 4 && (
                    <>
                      <div className="stats">
                        <section className="panel stat">
                          <div>
                            {tx("引擎单轮耗时", "Engine tick duration")}
                          </div>
                          <strong>
                            {snapshot.obs.runtime?.lastTickMs?.toFixed(2) ??
                              "—"}
                            <small> ms</small>
                          </strong>
                        </section>
                        <section className="panel stat">
                          <div>{tx("引擎累计异常", "Engine errors")}</div>
                          <strong>
                            {snapshot.obs.runtime?.engineErrors ?? "—"}
                          </strong>
                        </section>
                        <section className="panel stat">
                          <div>{tx("行情采集", "Market collector")}</div>
                          <strong>
                            {snapshot.obs.runtime?.collectorEnabled
                              ? tx("已开启", "Enabled")
                              : tx("未开启", "Disabled")}
                          </strong>
                        </section>
                        <section className="panel stat">
                          <div>{tx("K 线数据源", "Candle feeds")}</div>
                          <strong>{snapshot.obs.candleFeeds.length}</strong>
                        </section>
                      </div>
                      <section className="panel">
                        <h2>{tx("最近运行事件", "Recent runtime events")}</h2>
                        <p className="footnote">
                          {tx(
                            "最新 50 条非订单簿事件 · 时间为本地时区",
                            "Latest 50 non-order-book events · Times use your local timezone",
                          )}
                        </p>
                        {snapshot.obs.events.length ? (
                          snapshot.obs.events.map((e) => (
                            <details key={e.seq} className="event">
                              <summary>
                                <span className="mono">
                                  {time(e.time, locale)}
                                </span>
                                <span>{e.type}</span>
                                <small>#{e.seq}</small>
                              </summary>
                              <pre>{JSON.stringify(e.data, null, 2)}</pre>
                            </details>
                          ))
                        ) : (
                          <div className="empty">
                            {tx("暂无事件", "No events")}
                          </div>
                        )}
                      </section>
                      <section className="panel">
                        <h2>{tx("K 线历史状态", "Candle history status")}</h2>
                        <DataTable
                          rows={snapshot.obs.candleFeeds as unknown as Row[]}
                          columns={["id", "bars", "latest"]}
                          locale={locale}
                        />
                      </section>
                    </>
                  )}
                </>
              )}
            </>
          )}
          <footer>
            <span>
              Predict Control Room <span className="muted-text">/ v0.1</span>
            </span>
            <span>
              {tx(
                "模拟交易 · 数据可追溯 · 风险有边界",
                "Paper trading · Traceable data · Bounded risk",
              )}
            </span>
          </footer>
        </div>
      </main>
    </div>
  );
}
function DataTable({
  rows,
  columns,
  locale,
}: {
  rows: Row[];
  columns: string[];
  locale: Locale;
}) {
  const names: Record<string, Record<Locale, string>> = {
    market: { en: "Market", zh: "市场" },
    direction: { en: "Direction", zh: "方向" },
    quantity: { en: "Shares", zh: "份额" },
    cost: { en: "Cost", zh: "成本" },
    fees: { en: "Fees", zh: "费用" },
    fee: { en: "Fee", zh: "费用" },
    pnl: { en: "Realized P&L", zh: "已实现盈亏" },
    time: { en: "Time", zh: "时间" },
    id: { en: "Feed", zh: "数据源" },
    bars: { en: "Candles", zh: "K 线数" },
    latest: { en: "Latest candle start", zh: "最新 K 线起点" },
  };
  return rows.length ? (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>
            {columns.map((c) => (
              <th key={c}>{names[c]?.[locale] ?? c}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, i) => (
            <tr key={String(row.id ?? i)}>
              {columns.map((c) => (
                <td className="mono" key={c}>
                  {row[c] === null || row[c] === undefined
                    ? "—"
                    : c === "time" || c === "latest"
                      ? time(Number(row[c]), locale)
                      : typeof row[c] === "number"
                        ? money(row[c] as number, locale)
                        : String(row[c])}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  ) : (
    <div className="empty">
      {locale === "zh"
        ? "暂无记录。策略触发并完成模拟执行后显示。"
        : "No records yet. Results appear after a strategy triggers and completes a paper execution."}
    </div>
  );
}
