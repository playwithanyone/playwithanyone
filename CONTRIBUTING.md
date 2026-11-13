# Contributing

1. Use the Node version in `.nvmrc` and install with `npm ci`.
2. Run `npm run setup:local`. It creates missing local files from committed
   examples and never overwrites an existing configuration.
3. Keep a change focused and run `npm run check:room-runtime` for protocol,
   gameplay, safety or runtime changes.
4. Stage the intended files and run `npm run check:public` before committing.
5. Open a pull request describing the problem, resulting behavior and relevant
   verification. Clearly distinguish local checks from actual cloud tests.

Do not commit personal operator notes, credentials, real deployment configuration,
generated releases, dependency trees, raw logs or measurement artifacts. See
[PUBLICATION.md](PUBLICATION.md) for the public/private boundary.

## Games

Only adapt games that already support multiplayer. Include provenance, an exact
upstream commit and all applicable license notices. Integrate identity, transport
and authoritative outcomes through the platform; do not add third-party tracking
or payment dependencies. Each game needs its own bounded resource profile.

## Product and implementation

- Keep player-facing text in the Chinese and English localization system.
- Preserve the binary protocol and isolate browser game frames from platform
  credentials.
- Keep Cloudflare D1/R2, matching and the control plane in their current roles.
  Extend the room runtime through its host ports where appropriate.
- Prefer event-driven work and persistent deadlines for turn-based games.
- Do not change billing plans or enable paid services as part of a code change.

Contributions are provided under this repository's MIT license; retain any
third-party notices that apply to your contribution.
