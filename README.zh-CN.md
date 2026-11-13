# PlayWithAnyone

[English](README.md) · [在线试玩](https://playwithanyone.com) · [MIT 许可](LICENSE)

免费的多人网页游戏平台：打开网页即可随机找人，也能创建房间邀请朋友。无需下载、无需注册。目前可玩四子棋，界面支持简体中文和英文。

## 当前能力

- 游客会话、随机匹配、邀请房间和双方准备后开局。
- 服务器校验轮次、落子及胜负，保存命令回执和结果。
- 每步思考 90 秒、房间最长 30 分钟、掉线保留 60 秒；重连恢复剩余思考时间。
- 匹配结果通过 WebSocket 推送；回合制房间使用 DO 休眠和 Alarm，没有服务器保活循环。
- 游戏 iframe 隔离、统一 SDK、公私资源分离和不可变内容摘要发布。
- 纯 TypeScript 房间内核，通过连接、调度、检查点、结算及规则加载五个接口对接宿主。
- 资源配额、持久事故锁、独立停止/恢复凭据、有界管理扫描和每游戏量化工具。

项目仍是早期试玩版。P2P/TURN、持续 Tick、VPS 宿主、外部结算及定时成本告警尚未启用。本地检查通过不代表已验证高并发容量或完整生产费用保护。

## 无云凭据的本地检查

使用 `.nvmrc` 指定的 Node 22.x，版本至少 22.22.2：

```sh
npm ci --ignore-scripts --no-audit --no-fund
npm run setup:local
npm run check:room-runtime
```

初始化仅从公开示例创建缺失的本地配置，不覆盖已有文件、不创建云资源。检查覆盖类型、前端构建、协议、发布、SDK、对局、成本安全及纯 Node 内核。这些命令用于验证源码，不会启动一套完整的本地游戏服务。

## 自行部署

真实部署配置不在公开仓库内。初始化副本仍有占位值，需要绑定自己的 Cloudflare 账号、域名、D1、R2、构建与有效保护周期；模板不可直接部署。配置对应表见 [英文 README](README.md#deploying-your-own-instance)。

凭据放入独立 Secret store 或私密环境文件，不写进源码或命令参数。预算、应用配额、官方实际用量和最终账单分别管理；脚本不会自动升级付费。发布需运营者明确执行，GitHub CI 只做本地检查。详见 [运营说明](docs/OPERATIONS.md)。

远端开发可复制 `configs/remote.example.json` 为忽略的 `configs/remote.local.json`，填写自己的 SSH 目标和项目目录，再先执行 `npm run sync:preview` 查看同步范围。

## 哪些公开，哪些自留

公开：源码、测试、协议与 SDK、数据库迁移、许可、配置示例和通用方法。

自留：真实云资源配置、个人预算、凭据与通知接收信息、原始对话、运营笔记、构建产物、缓存、日志和原始测量证据。已有自留文件仍在本机原位置；完整边界见 [PUBLICATION.md](PUBLICATION.md)。提交前检查暂存内容：

```sh
git add <准备提交的文件>
npm run check:public
```

`server-private` 仅指运行时不向浏览器提供的资源；对应的开源游戏规则和许可仍公开。

## 开发文档

- [目录与职责](README.md#repository-map)
- [架构与协议规范](docs/PlayWithAnyone_Architecture_Spec_v1.2.md)
- [实施与验证计划](docs/PlayWithAnyone_Implementation_and_Verification_Plan_v1.0.md)
- [成本安全规范](docs/PlayWithAnyone_Cost_and_Safety_Addendum_v1.0.md)
- [每游戏资源画像](docs/RESOURCE_PROFILING.md)
- [参与贡献](CONTRIBUTING.md)、[安全问题报告](SECURITY.md)、[第三方许可](THIRD_PARTY_NOTICES.md)

只改造原本支持联机的游戏。当前四子棋保留 BattleBox 的 MIT 声明与固定上游提交记录。
