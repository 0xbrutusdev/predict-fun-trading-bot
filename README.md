# Predict.fun CT4 量化研究机器人

基于 TypeScript 的预测市场研究与模拟交易系统，包含闭合 K 线指标、策略注册表、Predict WebSocket/REST 行情采集、OKX K 线采集、CT4 检查点执行、持久化账本、历史回放及前端 API。

**当前版本为研究和模拟交易版本，不支持实盘下单。** 模拟余额与 PnL 不代表链上钱包资产；代码通过测试也不代表策略具有盈利能力。原始 `b.md` 已从当前分支删除，实施方案保留在 [实施计划](PREDICT_FUN_IMPLEMENTATION_PLAN.md)。

## 环境与启动

要求 Node.js 22.13 或更新版本。Node 22 的 `node:sqlite` 仍为实验性功能。每个数据库仅运行一个交易进程，数据库必须位于本地磁盘；目前尚未实现计划中的 PostgreSQL 和多主机部署。

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
- `DATABASE_PATH`：SQLite 路径，默认 `data/bot.db`。
- `PREDICT_API_KEY`：服务端行情 API 密钥。
- `COLLECTOR_ENABLED=true`：启用行情采集；默认关闭。

启动不会授权代币、转账或提交实盘订单。采集器抓取最近的已闭合 OKX K 线并持续积累历史，不会自动补齐 60 天历史。当前主周期与 H1 指标均要求至少 200 根 K 线。

## 模拟交易流程

1. 调用 `POST /v1/accounts` 创建模拟账户，初始状态为暂停。
2. 查看 `GET /v1/strategies`，通过 `PUT /v1/accounts/{id}/strategies` 选择策略槽位。
3. 查看 `GET /v1/markets/discovery`，核对窗口、代币、方向映射和结算规则，再通过 `POST /v1/markets` 注册市场。每个新窗口都需要集成服务注册，发现市场不等于批准交易。
4. 数据齐全后，通过 `PATCH /v1/accounts/{id}` 设置 `enabled=true`。
5. 查看指标、信号、持仓、成交、PnL 和事件。窗口结束后，通过结算接口提交已核实的最终派彩及证据链接。

系统按市场分配风险预算，而不是将多个相关策略的份额简单相加。出现方向冲突时跳过，检查点要求三个新鲜样本，重试受价格追逐上限约束。这些行为是明确的模拟策略选择，不应称为与原系统完全一致。

20 个原始槽位均已注册，13 个策略函数已实现。V9 consensus gate 和两个 V19 策略因原始特征定义缺失而禁用。原引擎的参考输入/输出样本仍是确认数值一致性的必要条件。

## 前端集成

- [API 使用说明](docs/API.md)
- [OpenAPI 3.1 规范](docs/openapi.json)
- [服务端/BFF TypeScript 客户端](src/client.ts)
- 在线规范：`GET /v1/openapi.json`

API 提供账户信息、策略配置、特征与信号、持仓、成交、已实现 PnL、市场状态、订单簿、事件游标与全局暂停功能。当前不提供真实钱包资产，也不接受浏览器提交私钥；`walletAddress` 仅用于展示。

这是单所有者服务，不是多租户平台。管理及只读 Token 应放在 BFF 服务端，不能打包进公开前端或保存在浏览器本地存储中。多用户应用需要在 BFF 增加登录会话、账户权限与 CSRF 防护；公网部署需配置 TLS 和明确的允许来源。

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

SQLite WAL 持久化账户、市场、执行状态、原始事件、成交及结算。重启后从账本恢复已成交数量，过期检查点不会补单。采集器关闭时会中止请求并等待正在执行的任务结束，再关闭数据库。

`POST /v1/kill-switch` 暂停所有账户的新交易，保留持仓。备份应使用 SQLite 备份机制，或停进程后复制数据库；WAL 写入期间只复制主文件可能丢失数据。长期采集还需要部署监控、磁盘容量报警与事件归档策略。

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
