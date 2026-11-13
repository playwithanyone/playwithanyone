# 部署与运行

当前实现使用 Cloudflare Workers、SQLite Durable Objects、D1 和 R2。
四子棋采用可休眠 WebSocket 与 Alarm；匹配、会话、存储和发布由 Cloudflare 控制面处理。

## 配置

执行 `npm run setup:local` 后，填写生成的本地副本；已有配置不会被覆盖。

| 配置 | 用途 |
| --- | --- |
| `configs/cloud/resources.json` | 账号、域名、Worker、D1 和 R2 资源 |
| `configs/safety.preview.json` | 房间、创建量、消息、数据库和存储配额，以及有效保护周期 |
| `configs/room-routing.preview.json` | 已注册构建、WebSocket 端点和同步策略 |
| `configs/resource-profiles/connect-four.json` | 有界测量的目标与工作负载 |
| `configs/safety.watchdog.preview.json` | 可选巡检、阈值和通知渠道 |

占位配置不可部署。密钥放入独立 Secret store 或私密环境文件，分开使用发布、
指标读取、停止、恢复及通知凭据。P2P/TURN、持续 Tick、VPS 和定时告警默认未启用。

## 发布与检查

`scripts/prepare-connect-four.mjs` 准备游戏产物，`scripts/build-cloud.mjs` 生成 Worker 配置，
`scripts/publish-preview.mjs` 通过 Wrangler 执行发布。发布前核对目标、不可变产物和许可；
结果不明时先查实际云状态，保留发布 journal，避免重复操作。

`scripts/safety-status.mjs` 查看状态，`scripts/cost-watchdog/` 提供采集、阈值预演、
停止与恢复工具。管理结果每页最多 8 房；跟随同次扫描的 `nextCursor` 到完整结果，
使用最后一页累计数，不叠加各页计数。

## 配额与保护

供应商免费额度、应用配额和实际账单是不同口径。免费额度由账号共享，
应用计数不会覆盖其他服务费用。部署前核对 [Workers](https://developers.cloudflare.com/workers/platform/pricing/)、
[DO](https://developers.cloudflare.com/durable-objects/platform/pricing/)、
[D1](https://developers.cloudflare.com/d1/platform/pricing/) 和 [R2](https://developers.cloudflare.com/r2/pricing/) 的规则。

应用限制并发、创建速率、日/周期累计、消息、数据库操作及存储。
D1 普通读取使用最多 512 行、最长 60 秒的预付块；预扣量与官方实际读写分开统计。
调整限额前建立对应游戏的 [资源画像](RESOURCE_PROFILING.md)，保留已有账本。

保护状态按 `NORMAL`、`WARNING`、`DRAINING`、`BLOCKED` 持久保存。
停止覆盖新请求、已有连接和后台工作，业务数据保留；恢复需要独立认证及验证记录。
日切换、重启或换配置不会自动解除事故锁。

可选 watchdog 需另行配置运行环境、只读指标凭据和通知渠道，验证送达、停止与恢复后启用。
GitHub CI 执行源码检查，线上发布仍手动执行。
