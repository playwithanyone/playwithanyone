# PlayWithAnyone

[简体中文](README.zh-CN.md) · [Play online](https://playwithanyone.com) · [MIT license](LICENSE)

Free multiplayer browser games. Match with another player or invite a friend
to a room. No download or account registration required.

This early preview includes **Connect Four**, with Chinese and English interfaces.
The platform is built with TypeScript, Cloudflare Workers, Durable Objects, D1 and R2.

## Local checks

Use Node 22.x, version 22.22.2 or later.

```sh
npm ci --ignore-scripts --no-audit --no-fund
npm run setup:local
npm run check:room-runtime
```

These commands build and test the source; they do not start a complete local game
service. Self-hosting requires your own Cloudflare resources and configuration.

## Repository

- `apps/portal/`: browser interface
- `apps/edge/`: Cloudflare backend
- `packages/`: room runtime, protocol, SDK and release tools
- `games/`: game source and licenses

## Development

[Contributing](CONTRIBUTING.md) · [Operations](docs/OPERATIONS.md) ·
[Security](SECURITY.md) · [Third-party notices](THIRD_PARTY_NOTICES.md)
