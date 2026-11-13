# Contributing

Use the Node version in `.nvmrc`, then run the [local checks](README.md#local-checks).
Keep changes focused and describe the resulting behavior and validation in your pull request.
Before committing, stage the intended files and run `npm run check:public`.
Do not commit credentials, real deployment configuration or generated artifacts.

- Keep player-facing text in both Chinese and English.
- Adapt only games that already support multiplayer. Include the exact upstream
  commit, provenance, license notices and a bounded resource profile.
- Preserve protocol compatibility, iframe isolation and server-side validation.
- Use event-driven work and persistent deadlines for turn-based games.

See the [architecture and protocol reference](docs/PlayWithAnyone_Architecture_Spec_v1.2.md)
for SDK and wire contracts, and [operations](docs/OPERATIONS.md) for deployment.
Contributions use the repository's MIT license; retain applicable third-party notices.
