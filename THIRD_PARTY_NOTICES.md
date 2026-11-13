# Third-party notices

Original PlayWithAnyone code and assets are covered by the root [MIT license](LICENSE).
Third-party code retains its own notices and license terms.

## Connect Four

The gravity and four-direction win detection were adapted from the existing
multiplayer game in [BattleBox](https://github.com/assishmoncs/battlebox), commit
`072659ace68261e05ce0d7b8f3d4e2fc2c9970a7`, `games/connectfour.js`.

- Copyright (c) 2026 BattleBox Contributors.
- License: [MIT](games/connect-four/LICENSE).
- Scope and changes: [provenance.json](games/connect-four/provenance.json).
- Upstream networking, room state, rewards and timers were replaced with the
  platform's own protocol, room runtime and result handling.

The release preparation script generates public license information and private
runtime notices. A `server-private` artifact is kept away from browser downloads;
it does not make its corresponding MIT-licensed source confidential.

## Candidate games

[GameNest](https://github.com/absswds/GameNest) has been evaluated as a candidate
source. No GameNest game is included in this release. Before importing any game,
verify its multiplayer implementation and retain its applicable license, notices
and modification history.

## Dependencies

Dependencies are declared in `package.json` and pinned in `package-lock.json`.
Their original licenses apply. Installed dependency trees and generated bundles
are not committed to this repository.
