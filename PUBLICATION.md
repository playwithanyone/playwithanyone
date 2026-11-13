# 公开与自留资料

本仓库公开平台实现和复用方法；运行中的账号、个人资料与原始运营证据留在维护者自己的环境。

| 内容 | 是否提交 | 位置或方式 |
| --- | --- | --- |
| 平台源码、游戏源码、SDK、协议和测试 | 公开 | `apps/`、`packages/`、`games/` |
| 第三方来源、许可、锁文件 | 公开 | `LICENSE`、`THIRD_PARTY_NOTICES.md`、游戏许可、`package-lock.json` |
| 架构、贡献指南、通用成本与量化方法 | 公开 | `docs/`、`CONTRIBUTING.md`、`SECURITY.md` |
| 配置模板与纯本地测试配置 | 公开 | `*.example.json`、`configs/safety.dev.json`、`configs/fixtures/` |
| 实际 Cloudflare 账号、域名绑定、数据库和 Worker 清单 | 自留 | `configs/cloud/resources.json`，已忽略 |
| 实际线上配额、路由、通知配置和画像 | 自留 | `configs/safety.preview.json`、`configs/safety.entries.json`、`configs/safety.watchdog.preview.json`、`configs/room-routing.preview.json`、`configs/resource-profiles/connect-four.json` |
| 个人预算和远端目标 | 自留 | `configs/budget.authorized.json`、`configs/remote.local.json` |
| 原始点子、个人协作说明、运营记录和原始测量 | 自留 | `原始点子/`、`AGENTS.md`、`private/`、原运营与测量文档、`artifacts/` |
| 密钥、环境文件、凭据备份 | 自留 | Secret store 或项目外；`.env*` / `.dev.vars*` 仅允许公开空白示例 |
| 安装依赖、构建、缓存、日志、存档 | 不提交 | `node_modules/`、`dist/`、`.build/`、`.generated/`、`.wrangler/` 等 |

`server-private` 表示发布到游戏运行环境时的可见性边界：规则不打包给浏览器。
它不是源码保密协议，已开源游戏的规则和必要许可仍在公开仓库。

## 本机保留

忽略文件仍留在原位置供当前部署使用，不会因为初始化 Git 而删除。
完整个人运营 README 与成本补充规范另保存在 `private/docs/`；该目录不进 Git，
也不随源码同步。原始云端报告和截图继续留在 `artifacts/`。

`.gitignore` 与 `.remote-sync.exclude` 是两个不同的边界：Git 忽略规则控制公开提交，
远端同步黑名单控制本项目开发机器之间的传输，不能互相替代。

## 提交前

```sh
git status --short
git add <intended-files>
npm run check:public
git diff --cached --stat
```

检查器扫描 Git 索引中的实际 blob，拒绝受保护路径、常见真实凭据格式、个人绝对路径，
并可利用本机私有配置检查真实部署标识是否误入公开文件。测试用的明确假数据可以保留。
CI 会检查已提交文件，并执行本地类型、构建和组件检查；它不会发布线上站点。

这类检查不能保证识别所有秘密。新增配置、附件或运营资料时仍需检查具体内容；
不要用 `git add -f` 绕过边界，也不要把凭据仅通过后续提交删除来处理泄漏。
