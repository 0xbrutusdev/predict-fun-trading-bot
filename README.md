# Predict.fun CT4 量化研究机器人

基于 TypeScript 的预测市场研究与模拟交易系统，包含闭合 K 线指标、策略注册表、Predict WebSocket/REST 行情采集、OKX K 线采集、CT4 检查点执行、持久化账本、历史回放及前端 API。

**当前版本为研究和模拟交易版本，不支持实盘下单。** 模拟余额与 PnL 不代表链上钱包资产；代码通过测试也不代表策略具有盈利能力。原始规格、实施计划和本地文档不随当前分支发布。

## 环境与启动

要求 Node.js 22.13 或更新版本，并使用 MongoDB Atlas 或兼容 MongoDB 部署。启动时会建立连接、创建项目集合及索引，并通过数据库租约确保同一交易数据库只有一个执行 Worker。

```powershell
npm ci
Copy-Item .env.example .env
# 编辑 .env，设置至少 32 字符的随机 API_TOKEN。
npm run build
node --env-file=.env dist/server.js
```

默认监听 `127.0.0.1:3000`。必须使用 `--env-file` 或由运行环境注入配置，程序不会自动读取 `.env`。

- `API_TOKEN`：管理凭证，控制本实例中的所有账户。
- `API_READ_TOKEN`：可选只读凭证，至少 32 字符，且必须与管理凭证不同。
- `ALLOWED_ORIGIN`：允许的前端来源，默认 `http://localhost:5173`。
- `MONGODB_URI`：服务端 MongoDB 连接字符串，不得提交到 Git 或暴露给浏览器。
- `MONGODB_DB_NAME`：交易数据库名称，默认 `predict_fun_trading_bot`。
- `MONGODB_HISTORY_DB_NAME`：独立历史补录数据库名称，默认 `predict_fun_history`。
- `PREDICT_API_KEY`：服务端行情 API 密钥。
- `COLLECTOR_ENABLED=true`：启用行情采集；默认关闭。

启动不会授权代币、转账或提交实盘订单。采集器抓取最近的已闭合 OKX K 线并持续积累历史，不会在启动时自动补齐 60 天历史；可用下方独立命令补录。当前主周期与 H1 指标均要求至少 200 根 K 线。

## 模拟交易流程

1. 调用 `POST /v1/accounts` 创建模拟账户，初始状态为暂停。
2. 查看 `GET /v1/strategies`，通过 `PUT /v1/accounts/{id}/strategies` 选择策略槽位。
3. 查看 `GET /v1/markets/discovery`，核对窗口、代币、方向映射和结算规则，再通过 `POST /v1/markets` 注册市场。每个新窗口都需要集成服务注册，发现市场不等于批准交易。
4. 数据齐全后，通过 `PATCH /v1/accounts/{id}` 设置 `enabled=true`。
5. 查看指标、信号、持仓、成交、PnL 和事件。窗口结束后，通过结算接口提交已核实的最终派彩及证据链接。

系统按市场分配风险预算，而不是将多个相关策略的份额简单相加。出现方向冲突时跳过，检查点要求三个新鲜样本，重试受价格追逐上限约束。这些行为是明确的模拟策略选择，不应称为与原系统完全一致。

20 个原始槽位均已注册，13 个策略函数已实现。V9 consensus gate 和两个 V19 策略因原始特征定义缺失而禁用。原引擎的参考输入/输出样本仍是确认数值一致性的必要条件。

## 前端集成

项目现包含 `web/` 下的 Next.js 16 中文控制台和 Next.js API 网关：账户创建/启停、风险配置、策略槽位、市场盘口、持仓、成交、PnL、运行事件和数据时效监控。页面只展示连接的 Worker 数据；断线或超过 30 秒未同步时保留上次结果并禁用交易配置操作。

### 本地运行控制台

先按上文启动 Worker，再开一个终端：

```powershell
npm ci --prefix web
Copy-Item web/.env.example web/.env.local
# BOT_API_URL=http://127.0.0.1:3000
# BOT_API_TOKEN 填入 Worker 的 API_TOKEN；只读控制台可使用 API_READ_TOKEN。
# DASHBOARD_ACCESS_KEY 使用独立的至少 32 字符随机密钥，不能复用交易所密钥。
npm run web:dev
```

访问 `http://localhost:3001`，使用控制台访问密钥登录。密钥不写入浏览器本地存储；会话为有效期 8 小时的 HttpOnly、SameSite=Strict Cookie，生产环境额外设置 Secure。修改请求校验同源 Origin。轮换 `DASHBOARD_ACCESS_KEY` 会使现有会话失效。

多租户入口可选用 Auth.js GitHub OAuth。配置 `AUTH_SECRET`、`AUTH_GITHUB_ID`、`AUTH_GITHUB_SECRET` 后，服务通过服务器端 `BOT_TENANTS_JSON` 将 Auth.js 用户邮箱或用户 ID 映射到独立的 Worker URL 和 Token。每个映射的 Worker 应使用独立 MongoDB 数据库名称；浏览器不能提交或切换租户 ID。未配置 Auth.js 时保留原单所有者访问密钥流程，用于本地运行与向后兼容。当前租户注册表由环境变量管理，尚未包含团队成员角色、自助注册或计费。

### Vercel 部署边界

Vercel 项目的 Root Directory 设置为 `web`，Framework 选择 Next.js，Node 选择 22.x。单所有者部署设置服务端变量 `DASHBOARD_ACCESS_KEY`、`BOT_API_URL`（Worker 的 HTTPS 根地址）、`BOT_API_TOKEN`。Auth.js 多租户部署改用 `AUTH_SECRET`、GitHub OAuth 变量及 `BOT_TENANTS_JSON`。这些变量都不能使用 `NEXT_PUBLIC_` 前缀。登录或 Worker 未配置时显示明确错误，不使用演示收益替代。

Next.js 在 Vercel 提供前端、登录和 `/api/bot/*` 后端网关。250ms 持续执行循环和行情连接仍在独立持久化 Node Worker 运行；不能直接放入短时 Vercel 请求函数。Worker 使用 MongoDB 进行持久化，并通过原子租约阻止同一数据库的重复执行进程。尚未配置 Worker 主机时，部署成功仅代表控制台在线，不代表机器人在生产执行。

### 自动市场生命周期（可选）

默认继续使用人工市场注册和结算，保持现有部署行为。设置 `AUTO_MARKETS_ENABLED=true` 后，Worker 会分页发现 Predict `CRYPTO_UP_DOWN` 市场，并仅注册 `AUTO_MARKET_SYMBOLS`、`AUTO_MARKET_DURATIONS`、`AUTO_MARKET_PROVIDERS` 和前瞻时间范围允许的市场。默认策略为 BTC/ETH、5m/15m、Chainlink、提前 30 分钟。

自动注册要求精确窗口、可见且开放的市场、Up/Down 两个唯一链上 outcome ID、费用、价格精度、condition/oracle ID、完整规则文本和价格源元数据。规则哈希变化或契约字段无效会关闭该市场并记录阻断原因，不会继续交易。自动结算只接受 Predict 已标记 `RESOLVED`、唯一 outcome 为 `WON`、另一 outcome 为 `LOST`，且 winner ID 与注册时链上 ID 完全一致的证据。平局或任何模糊状态继续等待现有人工结算接口，不根据结束价格自行推断。

`GET /v1/markets/automation` 返回当前策略和最近一轮发现/注册统计。人工 `POST /v1/markets` 与 `POST /v1/markets/{id}/resolution` 接口保持兼容。此功能只完善模拟市场生命周期，不会启用实盘提交。

GitHub 自动部署还需要 Vercel GitHub App 有权访问本仓库。在 Vercel 项目 Settings → Git 连接 `0xbrutusdev/predict-fun-trading-bot`，生产分支选择 `main`。回滚控制台可在 Vercel 提升上一成功部署；Worker 更新前创建 MongoDB Atlas 快照或等价备份，并保持数据库租约和应用版本兼容。

### 可观测性与验证

- `GET /api/health`：仅检查 Next.js 服务存活，不代表 Worker 就绪。
- `GET /v1/observability`（Worker）或 `/api/bot/observability`（登录后）：引擎心跳、单轮耗时、异常计数、行情开关、活跃市场、过期盘口、缺失 K 线源及最近 50 条操作事件。不包含高流量的原始盘口/K 线事件。
- 网关日志包含请求 ID、方法、路径、上游状态、耗时；该 ID 传递到 Worker 日志。日志不包含访问密钥、Token 或请求体。
- `npm test` 覆盖账本/执行/采集和网关到真实 Worker HTTP 集成；`npm run web:build` 后运行 `npm run test:e2e`，使用 Chromium 和独立内存数据库验证登录、配置、暂停、移动端布局和退出。测试不会打开运营数据库。
- 就绪表示已覆盖的运行条件满足，不代表策略获利、全部特征连续性已通过或已允许实盘。市场审核与最终派彩仍需通过 Worker API 提交核实结果。

- 使用 `npm run api:export` 生成本地 OpenAPI 3.1 规范（`docs/openapi.json`，不提交到 Git）。
- [服务端/BFF TypeScript 客户端](src/client.ts)
- 在线规范：`GET /v1/openapi.json`

API 提供账户信息、策略配置、特征与信号、持仓、成交、已实现 PnL、市场状态、订单簿、事件游标与全局暂停功能。当前不提供真实钱包资产，也不接受浏览器提交私钥；`walletAddress` 仅用于展示。

默认配置仍是单所有者服务。可选 Auth.js 网关提供用户身份和按用户选择独立 Worker 的隔离边界；每个 Worker 内仍由其管理或只读 Token 决定权限。所有 Token 只放在 BFF 服务端，不能打包进公开前端或保存在浏览器本地存储中。团队角色、自助租户配置和集中计费仍未实现；公网部署需配置 TLS 和明确的允许来源。

所有财务 API 数值以 USDT 为单位，时间戳为 UTC 毫秒。未结算的 PnL 为 `null`，不要在前端当作零；`conservativeEquity` 将未结算持仓按零估值。

## 风控与账本

默认单市场最大投入风险为初始权益的 0.25%，总未结算投入为 1%，日亏损预算为 1%。下单还受剩余现金、当日已实现损益和未结算风险共同限制。该预算不能消除已有持仓的损失，也不是实盘收益保证。

模拟撮合使用限价范围内订单簿深度的一部分，同一快照的已消费深度不会重复使用。费用使用显式的保守假设：`paperFeeBps` 默认 200，按名义金额收取；**这不是已经验证的 Predict 实际费用公式**。

账本使用整数 micro-USDT，SDK 签名使用 18 位小数 bigint；模拟份额使用浮点数，不能直接复用为实盘结算账本。结算支持胜、负及 50–50，重复相同派彩不会重复入账，冲突派彩会被拒绝。

## 测试和回放

```powershell
npm run check
npm test
python -m unittest discover -s tests -p '*_test.py'
npm run build
npm run format:check
npm run api:export
npx tsx src/replay.ts events.jsonl > replay-result.json
python research/evaluate.py replay-result.json
```

回放 JSONL 使用 `{time,type,data}`，事件必须按接收时间升序排列。支持 `setup.account`、`setup.market`、`candles`、`book`、`clock`、`resolution`。重复账户或市场初始化会被拒绝，防止覆盖已发生的交易状态。应在检查点及重试时刻提供 `clock` 事件；禁止用未来快照填补历史缺口。

回放输出的成交账本金额使用整数 micro-USDT；HTTP API 会转换为 USDT。重定向 JSON 时直接使用 `npx tsx`，避免 npm 的脚本标题混入输出。

`research/evaluate.py` 提供初步的按日区块 bootstrap 报告，纳入首末结算日之间的无交易日。它尚未实现完整滚动训练、概率校准、成本压力测试或容量研究，也不会自动授权实盘。

## 运行与恢复

MongoDB 持久化账户、市场、执行状态、事件、成交、结算和 K 线观测版本。启动时自动创建 `documents`、`events`、`fills`、`candle_observations`、`leases`、`counters` 集合及必要索引。重启后从账本恢复已成交数量，过期检查点不会补单。采集器关闭时会中止请求并等待正在执行的任务结束，再关闭数据库连接。

`POST /v1/kill-switch` 暂停所有账户的新交易，保留持仓。备份应使用 Atlas 快照、连续备份或兼容 MongoDB 的一致性备份机制。长期采集还需要部署存储容量报警、索引监控与事件归档策略。

## 本次实现检查与修复

- 拒绝未来时间的成交快照、非有限下单参数及无效派彩。
- 在结算层统一检查市场身份与冲突派彩，使回放和 API 遵守相同规则。
- 日亏损预算计入已经承诺的未结算风险，结算统计截止当前决策时间。
- 防止过时交易状态消息将已结算市场重新开放。
- 采集器优雅退出，避免关闭数据库后继续写入。
- 防止回放重复初始化重置账户余额；研究报告纳入无交易日并正确处理时间戳零。
- 只读凭证与管理凭证强制分离。

## 尚未完成的实盘条件

- 补齐缺失特征定义及原始策略参考样本。
- 验证立即成交、部分成交、最小订单、到期和取消语义。
- 实现并验证实际现金/份额手续费、钱包及链上对账。
- 实盘认证、持久化提交和未知订单恢复。
- 自动且可信的市场规则映射、结算采集与赎回。
- 完整历史数据、样本外概率校准、延迟/成本/容量验证。
- 明确本金和损失额度，通过限额实盘试运行。

以上属于仍需继续实现或取得外部证据的工作，不会因文档更新或单元测试通过而自动满足。

## 历史数据补录（计划阶段 1）

```powershell
# 免费公开行情；默认写入独立研究库，避免与运行中的交易进程争用数据库。
npm run backfill -- --symbol BTC --duration 60 --days 60
```

支持周期 `60/300/900/3600` 秒；每次请求 100 根，按 `after` 向过去分页，限制请求频率并重试暂时错误。使用 `--end <UTC毫秒>` 固定区间后，再次执行相同参数会从已保存游标恢复。中断后可在数据库 `history_job` 中找到原始区间和游标。返回缺失数量与前 20 个缺失时间，数据不齐时退出码为 2。

观测版本保存原始开盘时间和实际接收时间。`historyAt()` 只返回决策时刻已经收到的版本；补录历史不会被当成当时已知的数据。历史库与交易运行库默认分离，不会自动替换正在运行的指标缓存。当前回放输入只接受显式接收时间事件；补录样本不能直接作为过去的可用性证据。

接口语义参见 [OKX 官方文档](https://www.okx.com/docs-v5/en/#order-book-trading-market-data-get-candlesticks-history)。分页、恢复、闭合标志、OHLC 校验、时间可用性及缺口报告均有离线测试。尚未在本次会话下载真实的 60 天数据。
