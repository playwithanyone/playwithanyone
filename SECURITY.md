# Security policy

Report vulnerabilities privately through
[GitHub private vulnerability reporting](https://github.com/playwithanyone/playwithanyone/security/advisories/new).
Include the affected commit, a minimal reproduction, expected behavior and impact.
Do not put credentials, personal data or exploit details in a public issue.

This project is an early preview. There is no formal support or response-time SLA.
Security fixes target the current `main` branch.

## Configuration and secrets

- Copy the committed examples into ignored local configuration files.
- Store Cloudflare, room-signing, safety-management and notification credentials
  in the appropriate secret store or private environment files.
- Use independent signing, stop and recovery credentials. Never embed them in
  game frames, WebSocket URLs, build output or Git commits.
- A public Cloudflare account/resource identifier is not an authentication
  credential. Real deployment identifiers are nevertheless excluded here to
  prevent a fork from targeting the project's live environment.
- Run `npm run check:public` before committing or publishing.

If a credential is exposed, revoke or rotate it with the provider first. Removing
it in a later commit does not remove it from Git history or invalidate it.

## Runtime boundaries

Server-side rules are open source but are not shipped in browser resource
manifests. The server validates player authority, commands and outcomes. The
Cloudflare control plane owns admission and result storage; external room
finalization, P2P/TURN and continuous simulation remain disabled by default.

CI runs local checks only. It does not deploy to Cloudflare, send notifications or
use the live site's credentials.
