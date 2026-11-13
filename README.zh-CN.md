# PlayWithAnyone

[English](README.md) · [在线试玩](https://playwithanyone.com) · [MIT 许可](LICENSE)

免费的多人网页游戏平台。打开网页随机找人，或创建房间邀请朋友，无需下载、无需注册。

目前是早期试玩版，已提供 **四子棋**，界面支持简体中文和英文。
使用 TypeScript、Cloudflare Workers、Durable Objects、D1 和 R2 构建。

## 本地检查

使用 Node 22.x，版本至少 22.22.2。

```sh
npm ci --ignore-scripts --no-audit --no-fund
npm run setup:local
npm run check:room-runtime
```

这些命令用于构建和测试源码，不会启动完整的本地游戏服务。
自行部署需要配置自己的 Cloudflare 资源和凭据。

## 项目目录

- `apps/portal/`：网页界面
- `apps/edge/`：Cloudflare 后端
- `packages/`：房间内核、协议、SDK 和发布工具
- `games/`：游戏源码与许可

## 参与开发

[贡献指南](CONTRIBUTING.md) · [运营说明](docs/OPERATIONS.md) ·
[安全问题报告](SECURITY.md) · [第三方许可](THIRD_PARTY_NOTICES.md)
