"use client";
import { useCallback, useEffect, useRef, useState } from "react";

type Account = {
  id: string;
  name: string;
  enabled: boolean;
  cash: number;
  walletAddress?: string;
  maxMarketRisk: number;
  maxTotalRisk: number;
  dailyLossLimit: number;
  fixedShares: number;
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
  obs: Observation;
  accountId: string;
  pnl: Pnl | null;
  positions: Row[];
  fills: Row[];
  features: unknown[];
  selected: string[];
};
const money = (v: number) =>
  new Intl.NumberFormat("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(v);
const time = (v: number) =>
  new Date(v).toLocaleString("zh-CN", { hour12: false });
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
const tabs = ["总览", "策略配置", "市场行情", "成交与持仓", "运行监控"];
const labels: Record<string, string> = {
  worker_not_configured:
    "尚未配置生产 Worker。请设置服务端 BOT_API_URL 与 BOT_API_TOKEN。",
  worker_unreachable: "无法连接 Worker，请检查服务状态与网络。",
  unauthorized: "登录已过期，请重新登录。",
  engine_heartbeat_missing: "引擎心跳缺失",
  recent_engine_error: "近期引擎错误",
  collector_disabled: "行情采集未开启",
  no_active_registered_markets: "没有已审核的活跃市场",
  stale_order_books: "订单簿已过期",
  recent_collector_error: "近期行情采集错误",
  insufficient_or_stale_candles: "K 线历史不足或已过期",
};

export default function Dashboard() {
  const [auth, setAuth] = useState<boolean | null>(null),
    [configured, setConfigured] = useState(true),
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
  useEffect(() => {
    fetch("/api/session")
      .then((r) => r.json())
      .then((x) => {
        setAuth(x.data.authenticated);
        setConfigured(x.data.configured);
      })
      .catch(() => {
        setAuth(false);
        setError("无法连接控制台服务");
      });
  }, []);
  const refresh = useCallback(async () => {
    const seq = ++request.current;
    try {
      const [accounts, slots, markets, obs] = await Promise.all([
        api<Account[]>("accounts"),
        api<Slot[]>("strategies"),
        api<Market[]>("markets"),
        api<Observation>("observability"),
      ]);
      const id = accountId || accounts[0]?.id || "";
      const [pnl, positions, fills, features, config] = id
        ? await Promise.all([
            api<Pnl>(`accounts/${id}/pnl`),
            api<Row[]>(`accounts/${id}/positions`),
            api<Row[]>(`accounts/${id}/fills?limit=50`),
            api<unknown[]>(`accounts/${id}/features`),
            api<{ enabledSlots: string[] }>(`accounts/${id}/strategies`),
          ])
        : [null, [], [], [], { enabledSlots: [] }];
      if (seq !== request.current) return;
      setSnapshot({
        accounts,
        slots,
        markets,
        obs,
        accountId: id,
        pnl,
        positions,
        fills,
        features,
        selected: config.enabledSlots,
      });
      if (!dirtyRef.current) setSelection(config.enabledSlots);
      setUpdated(Date.now());
      setError("");
    } catch (e) {
      if (seq === request.current) {
        const message = (e as Error).message;
        setError(labels[message] ?? message);
        if (message === "unauthorized") setAuth(false);
      }
    }
  }, [accountId]);
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
      setNotice("已保存，变更已提交到 Worker。");
      await refresh();
    } catch (e) {
      setError(labels[(e as Error).message] ?? (e as Error).message);
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
  return (
    <div className="shell">
      <aside className="sidebar">
        <a className="brand" href="/" aria-label="Predict 控制台">
          <span className="brand-icon">↗</span>predict
          <span className="brand-dot">.</span>
          <small>CONTROL ROOM</small>
        </a>
        <div className="workspace-label">量化交易工作台</div>
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
          <p>模拟执行 · 实盘未开放</p>
          <small>Predict.fun / BNB Chain</small>
        </div>
      </aside>
      <main>
        <header>
          <div className="breadcrumb">
            工作台 <span>/</span> {tabs[tab]}
          </div>
          <div className="header-actions">
            <span className="badge muted">USDT</span>
            {auth && (
              <button
                className="text-button"
                onClick={async () => {
                  const r = await fetch("/api/session", { method: "DELETE" });
                  if (r.ok) {
                    request.current++;
                    setAuth(false);
                    setSnapshot(null);
                    setUpdated(0);
                  }
                }}
              >
                退出登录
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
              <p>从策略信号到成交结果，每一步都有据可查。</p>
            </div>
            {auth && (
              <div className="actions">
                <button disabled={busy} onClick={() => void refresh()}>
                  ↻ 刷新
                </button>
                <button
                  className="danger"
                  disabled={disabled}
                  onClick={() => {
                    if (confirm("暂停全部模拟账户？现有持仓将保留。"))
                      void mutate("kill-switch", "POST", {});
                  }}
                >
                  暂停全部账户
                </button>
              </div>
            )}
          </div>
          {error && (
            <div className="alert error" role="alert">
              {error}
              {updated > 0 && " · 当前显示上次成功同步的数据"}
            </div>
          )}
          {notice && (
            <div className="alert" role="status">
              {notice}
            </div>
          )}
          {auth === null ? (
            <div className="empty">正在检查会话…</div>
          ) : !auth ? (
            <section className="login panel">
              <div className="eyebrow">SECURE ACCESS</div>
              <h2>连接你的交易工作台</h2>
              <p>使用独立控制台访问密钥登录。交易所密钥仅保存在服务端。</p>
              <form onSubmit={signIn}>
                <label>
                  控制台访问密钥
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
                  进入控制台 →
                </button>
              </form>
              {!configured && (
                <div className="alert">
                  尚未配置登录：在 Vercel 设置 DASHBOARD_ACCESS_KEY（至少 32
                  位随机字符）。
                </div>
              )}
              <div className="login-note">
                模拟账户 / 风险管理 / 运行监控
                <br />
                没有模拟收益展示，所有数据均来自已连接的 Worker。
              </div>
            </section>
          ) : (
            <>
              <div className="connection">
                <span>
                  <i className={`dot ${!stale ? "green" : ""}`} />
                  {!stale ? "Worker 已连接" : "等待 Worker 连接"}
                </span>
                <span>
                  15 秒自动同步 ·{" "}
                  {updated ? `最近同步 ${time(updated)}` : "尚未同步"}
                </span>
                <span className="badge">仅模拟交易</span>
              </div>
              <div className="account-bar">
                <label>
                  账户
                  <select
                    aria-label="选择账户"
                    value={accountId || snapshot?.accountId || ""}
                    onChange={(e) => {
                      request.current++;
                      activeId.current = e.target.value;
                      setAccountId(e.target.value);
                      dirtyRef.current = false;
                      setDirty(false);
                      setNotice("");
                    }}
                  >
                    <option value="" disabled>
                      选择模拟账户
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
                      className={`badge ${account.enabled ? "positive" : "muted"}`}
                    >
                      {account.enabled ? "运行中" : "已暂停"}
                    </span>
                    <button
                      disabled={disabled}
                      onClick={() =>
                        void mutate(`accounts/${account.id}`, "PATCH", {
                          enabled: !account.enabled,
                        })
                      }
                    >
                      {account.enabled ? "暂停账户" : "启动模拟账户"}
                    </button>
                    <small className="mono">
                      {account.walletAddress || "未关联钱包 · 模拟资金"}
                    </small>
                  </>
                )}
              </div>
              {!snapshot ? (
                <div className="panel empty">
                  <h2>等待真实运行数据</h2>
                  <p>
                    连接持久化 Worker 后，账户、策略、市场和运行指标将在此显示。
                  </p>
                  <p>Next.js 服务在线不代表交易引擎已就绪。</p>
                </div>
              ) : (
                <>
                  {tab === 0 && (
                    <>
                      <div className="stats">
                        {[
                          [
                            "已实现盈亏",
                            snapshot.pnl?.realizedPnl,
                            "结算后净收益，已扣费用",
                          ],
                          [
                            "可用资金",
                            snapshot.pnl?.cash,
                            "USDT · 模拟账户现金",
                          ],
                          [
                            "持仓占用",
                            snapshot.pnl?.committed,
                            "未结算成本 + 费用",
                          ],
                          [
                            "累计费用",
                            snapshot.pnl?.fees,
                            `${snapshot.pnl?.fills ?? 0} 笔成交`,
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
                              {typeof value === "number" ? money(value) : "—"}
                              <small> USDT</small>
                            </strong>
                            <p>{note}</p>
                          </section>
                        ))}
                      </div>
                      <div className="two-col">
                        <section className="panel">
                          <div className="panel-title">
                            <h2>执行概况</h2>
                            <span className="badge">实时状态</span>
                          </div>
                          <div className="metric-row">
                            <span>活跃市场</span>
                            <strong>{snapshot.obs.activeMarkets}</strong>
                          </div>
                          <div className="metric-row">
                            <span>过期订单簿</span>
                            <strong
                              className={
                                snapshot.obs.staleBooks ? "warning" : ""
                              }
                            >
                              {snapshot.obs.staleBooks}
                            </strong>
                          </div>
                          <div className="metric-row">
                            <span>已启用策略槽位</span>
                            <strong>
                              {snapshot.selected.length} /{" "}
                              {snapshot.slots.length}
                            </strong>
                          </div>
                          <div className="metric-row">
                            <span>未实现盈亏</span>
                            <strong>—</strong>
                          </div>
                          <p className="footnote">
                            未提供可执行平仓估值，未实现盈亏不计为零。模拟成交不能代表实盘收益。
                          </p>
                        </section>
                        <section className="panel">
                          <div className="panel-title">
                            <h2>运行检查</h2>
                            <span
                              className={`badge ${snapshot.obs.readiness === "ready" ? "positive" : ""}`}
                            >
                              {snapshot.obs.readiness === "ready"
                                ? "就绪"
                                : "需要关注"}
                            </span>
                          </div>
                          {snapshot.obs.reasons.length ? (
                            snapshot.obs.reasons.map((r) => (
                              <div className="check" key={r}>
                                <span className="warning">△</span>
                                {labels[r] ?? r}
                              </div>
                            ))
                          ) : (
                            <div className="check">
                              ✓ 引擎和市场数据检查通过
                            </div>
                          )}
                          <p className="footnote">
                            就绪检查仅覆盖运行健康度，实盘仍处于关闭状态。
                          </p>
                        </section>
                      </div>
                      <section className="panel">
                        <h2>新建模拟账户</h2>
                        <form
                          className="inline-form"
                          onSubmit={(e) => {
                            e.preventDefault();
                            const f = new FormData(e.currentTarget);
                            void mutate("accounts", "POST", {
                              name: f.get("name"),
                              initialEquity: Number(f.get("equity")),
                            });
                          }}
                        >
                          <label>
                            账户名称
                            <input
                              name="name"
                              required
                              maxLength={80}
                              placeholder="例如：BTC 趋势策略"
                            />
                          </label>
                          <label>
                            初始资金（USDT）
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
                            创建暂停账户
                          </button>
                        </form>
                      </section>
                      {account && (
                        <section className="panel" key={account.id}>
                          <h2>风险参数</h2>
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
                              });
                            }}
                          >
                            {[
                              [
                                "单市场风险 %",
                                "market",
                                account.maxMarketRisk * 100,
                                1,
                              ],
                              [
                                "总风险 %",
                                "total",
                                account.maxTotalRisk * 100,
                                5,
                              ],
                              [
                                "日亏损限额 %",
                                "daily",
                                account.dailyLossLimit * 100,
                                5,
                              ],
                              [
                                "每市场目标份额",
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
                            <button disabled={disabled}>保存风险参数</button>
                          </form>
                        </section>
                      )}
                    </>
                  )}
                  {tab === 1 && (
                    <section className="panel">
                      <div className="panel-title">
                        <div>
                          <h2>策略槽位</h2>
                          <p>置信分数不是胜率。缺少源定义的策略禁止启用。</p>
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
                                { enabledSlots: selection },
                              );
                              dirtyRef.current = false;
                              setDirty(false);
                              setNotice("策略已保存；仅影响新意图。");
                              await refresh();
                            } catch (e) {
                              setError((e as Error).message);
                            } finally {
                              setBusy(false);
                            }
                          }}
                        >
                          保存策略 {dirty ? "•" : ""}
                        </button>
                      </div>
                      <div className="table-wrap">
                        <table>
                          <thead>
                            <tr>
                              <th>启用</th>
                              <th>策略</th>
                              <th>标的 / 周期</th>
                              <th>阈值</th>
                              <th>状态</th>
                            </tr>
                          </thead>
                          <tbody>
                            {snapshot.slots.map((s) => (
                              <tr key={s.id}>
                                <td>
                                  <input
                                    aria-label={`策略 ${s.id}`}
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
                                      源定义缺失
                                    </span>
                                  ) : (
                                    <span className="badge positive">可用</span>
                                  )}
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                      <details>
                        <summary>最近特征与信号</summary>
                        <pre>{JSON.stringify(snapshot.features, null, 2)}</pre>
                      </details>
                    </section>
                  )}
                  {tab === 2 && (
                    <section className="panel">
                      <div className="panel-title">
                        <h2>已审核市场</h2>
                        <span>{snapshot.markets.length} 个市场</span>
                      </div>
                      <p className="footnote">
                        市场需通过 Worker API
                        审核注册；自动发现结果不会直接参与交易。订单簿超过 1
                        秒视为过期。
                      </p>
                      {!snapshot.markets.length ? (
                        <div className="empty">
                          没有已注册市场，当前不会产生交易。
                        </div>
                      ) : (
                        <div className="table-wrap">
                          <table>
                            <thead>
                              <tr>
                                <th>市场</th>
                                <th>周期</th>
                                <th>状态</th>
                                <th>结束时间</th>
                                <th>盘口时效</th>
                                <th>盘口</th>
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
                                      {m.status === "OPEN" && now >= m.end
                                        ? "EXPIRED"
                                        : m.status}
                                    </td>
                                    <td>{time(m.end)}</td>
                                    <td
                                      className={
                                        age === null || age > 1000
                                          ? "warning"
                                          : "profit"
                                      }
                                    >
                                      {age === null
                                        ? "无数据"
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
                                        查看
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
                            YES 方向盘口 · {book.id}（手动快照）
                          </summary>
                          <pre>{JSON.stringify(book.data, null, 2)}</pre>
                        </details>
                      )}
                    </section>
                  )}
                  {tab === 3 && (
                    <>
                      <section className="panel">
                        <h2>未结算持仓</h2>
                        <DataTable
                          rows={snapshot.positions}
                          columns={[
                            "market",
                            "direction",
                            "quantity",
                            "cost",
                            "fees",
                          ]}
                        />
                      </section>
                      <section className="panel">
                        <h2>成交账本</h2>
                        <p className="footnote">
                          按时间升序显示前 50 笔，完整历史可通过游标 API
                          查询。金额单位 USDT。
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
                        />
                      </section>
                    </>
                  )}
                  {tab === 4 && (
                    <>
                      <div className="stats">
                        <section className="panel stat">
                          <div>引擎单轮耗时</div>
                          <strong>
                            {snapshot.obs.runtime?.lastTickMs?.toFixed(2) ??
                              "—"}
                            <small> ms</small>
                          </strong>
                        </section>
                        <section className="panel stat">
                          <div>引擎累计异常</div>
                          <strong>
                            {snapshot.obs.runtime?.engineErrors ?? "—"}
                          </strong>
                        </section>
                        <section className="panel stat">
                          <div>行情采集</div>
                          <strong>
                            {snapshot.obs.runtime?.collectorEnabled
                              ? "已开启"
                              : "未开启"}
                          </strong>
                        </section>
                        <section className="panel stat">
                          <div>K 线数据源</div>
                          <strong>{snapshot.obs.candleFeeds.length}</strong>
                        </section>
                      </div>
                      <section className="panel">
                        <h2>最近运行事件</h2>
                        <p className="footnote">
                          最新 50 条非订单簿事件 · 时间为本地时区
                        </p>
                        {snapshot.obs.events.length ? (
                          snapshot.obs.events.map((e) => (
                            <details key={e.seq} className="event">
                              <summary>
                                <span className="mono">{time(e.time)}</span>
                                <span>{e.type}</span>
                                <small>#{e.seq}</small>
                              </summary>
                              <pre>{JSON.stringify(e.data, null, 2)}</pre>
                            </details>
                          ))
                        ) : (
                          <div className="empty">暂无事件</div>
                        )}
                      </section>
                      <section className="panel">
                        <h2>K 线历史状态</h2>
                        <DataTable
                          rows={snapshot.obs.candleFeeds as unknown as Row[]}
                          columns={["id", "bars", "latest"]}
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
            <span>模拟交易 · 数据可追溯 · 风险有边界</span>
          </footer>
        </div>
      </main>
    </div>
  );
}
function DataTable({ rows, columns }: { rows: Row[]; columns: string[] }) {
  return rows.length ? (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>
            {columns.map((c) => (
              <th key={c}>
                {(
                  {
                    market: "市场",
                    direction: "方向",
                    quantity: "份额",
                    cost: "成本",
                    fees: "费用",
                    fee: "费用",
                    pnl: "已实现盈亏",
                    time: "时间",
                    id: "数据源",
                    bars: "K 线数",
                    latest: "最新 K 线起点",
                  } as Record<string, string>
                )[c] ?? c}
              </th>
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
                      ? time(Number(row[c]))
                      : typeof row[c] === "number"
                        ? money(row[c] as number)
                        : String(row[c])}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  ) : (
    <div className="empty">暂无记录。策略触发并完成模拟执行后显示。</div>
  );
}
