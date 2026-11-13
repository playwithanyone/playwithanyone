# Security policy

Report vulnerabilities through
[GitHub private vulnerability reporting](https://github.com/playwithanyone/playwithanyone/security/advisories/new).
Include the affected commit, a minimal reproduction and impact. Keep credentials,
personal data and exploit details out of public issues.

Security fixes target `main`. This project is an early preview without a formal response-time SLA.

Store deployment credentials in secret stores or ignored local configuration.
Use separate room-signing, stop and recovery credentials. If a credential is exposed,
revoke or rotate it first; deleting it from the latest commit does not invalidate it.
