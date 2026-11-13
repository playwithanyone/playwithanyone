# PlayWithAnyone

[简体中文](README.zh-CN.md) · [Play online](https://playwithanyone.com) · [MIT license](LICENSE)

Free multiplayer browser games. Open a page, meet another player, or share a room with a friend. No download or account registration required.

The first playable game is **Connect Four**, adapted from an existing open-source multiplayer implementation. The platform has Chinese and English interfaces.

## Implemented

- Guest sessions, random matching, invitation rooms and an explicit ready step.
- Server-authoritative turns, legal-move checks, receipts and persistent results.
- A 90-second turn deadline, a 30-minute room lifetime and a 60-second reconnect grace. Reconnecting restores the remaining thinking time.
- Match updates over WebSocket; turn-based rooms use Durable Object hibernation and persistent Alarms rather than server keepalive loops.
- An isolated game iframe, a platform SDK and immutable, content-addressed releases.
- A portable TypeScript room core with transport, scheduler, checkpoint, result sink and rule loader ports.
- Resource quotas, persistent incident locks, separate stop/recovery credentials, bounded management scans and per-game measurement tools.

This is an early preview. P2P/TURN, continuous Tick simulation, a VPS host, external result finalization and scheduled cost alerts are **disabled or reserved**. Local tests do not certify production billing protection or high concurrency.

## Local checks — no cloud credentials

Use Node **22.22.2 or later in the 22.x series**, as specified in `.nvmrc` and `package.json`:

```sh
npm ci --ignore-scripts --no-audit --no-fund
npm run setup:local
npm run check:room-runtime
```

`setup:local` creates missing ignored configurations from public examples. It does not overwrite existing files or create cloud resources. Checks cover types, the portal build, protocol, release, SDK, gameplay, safety and the pure Node room runtime, using local components and explicit fixtures.

These commands verify the source; they do not start a complete local game service. The GitHub workflow runs the same checks and never deploys the live site.

## Deploying your own instance

Deployment is an explicit operator action. Configure your own Cloudflare resources and domain in the ignored copies before running a publisher:

| Public template | Private operator copy |
| --- | --- |
| `configs/cloud/resources.example.json` | `configs/cloud/resources.json` |
| `configs/safety.preview.example.json` | `configs/safety.preview.json` |
| `configs/room-routing.preview.example.json` | `configs/room-routing.preview.json` |
| `configs/safety.watchdog.preview.example.json` | `configs/safety.watchdog.preview.json` |
| `configs/resource-profiles/connect-four.example.json` | `configs/resource-profiles/connect-four.json` |
| `configs/budget.example.json` | `configs/budget.authorized.json` |

Placeholders are not deployable. Set a valid protection period, quotas, registered build hashes and independent server secrets. Example values are not an approved budget. Paid upgrades are not automatic.

The tools prepare releases, build Worker configurations and publish via Wrangler. Review [operations](docs/OPERATIONS.md) before using them. For remote development, copy `configs/remote.example.json` to ignored `configs/remote.local.json`, then preview `npm run sync:preview` before syncing.

## Repository map

| Path | Responsibility |
| --- | --- |
| `apps/portal/` | Bilingual portal, matching and game iframe host |
| `apps/edge/` | Cloudflare sessions, matching, room adapter, D1 and safety |
| `packages/room-runtime/` | Host-independent room core and Node tests |
| `packages/protocol/`, `packages/sdk/` | Binary/control protocol and browser SDK |
| `packages/release/`, `apps/release-cli/` | Immutable release identity and packaging |
| `packages/conformance/` | Protocol, security, gameplay and safety checks |
| `games/` | Game source, provenance and licenses |
| `scripts/resource-profile/` | Bounded workloads and official resource snapshots |
| `scripts/cost-watchdog/` | Explicit metric, protection and notification tools |

The control plane stays on Cloudflare. Portability focuses on the room runtime rather than a cross-cloud database abstraction.

## Public and private material

Source, tests, schemas, safe examples and reusable methods are public. Real deployment configuration, personal budgets, credentials, recipients, operator notes, raw conversations, generated releases and logs remain local. See [PUBLICATION.md](PUBLICATION.md) for the exact boundary.

Before committing:

```sh
git add <intended-files>
npm run check:public
```

The publication check scans the actual Git index blobs. It complements review and does not guarantee detection of every possible secret.

## Documentation and contributions

- [Architecture and SDK/protocol specification](docs/PlayWithAnyone_Architecture_Spec_v1.2.md)
- [Implementation and verification plan](docs/PlayWithAnyone_Implementation_and_Verification_Plan_v1.0.md)
- [Cost and safety specification](docs/PlayWithAnyone_Cost_and_Safety_Addendum_v1.0.md)
- [Operations](docs/OPERATIONS.md) and [per-game resource profiling](docs/RESOURCE_PROFILING.md)
- [Contributing](CONTRIBUTING.md), [security reporting](SECURITY.md) and [third-party notices](THIRD_PARTY_NOTICES.md)

Only games that already support multiplayer are eligible for adaptation. Retain their licenses and record the exact upstream commit. The current game retains the [BattleBox MIT notice](games/connect-four/LICENSE); `server-private` means runtime download visibility, not confidential source code.
