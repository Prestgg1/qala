# Security policy

Qala implements its own HTTP/1.1 parser, WebSocket protocol, multipart parser and PostgreSQL client, so security reports are especially welcome.

**Please do not open public issues for vulnerabilities.** Report them through [GitHub private advisories](https://github.com/Prestgg1/qala/security/advisories/new). You can expect a first reply within 7 days.

Qala is 0.x: only the latest release receives fixes.

Deployment advice: connect to PostgreSQL with `sslmode=verify-full` (see docs/guide/deployment.md). The default, `prefer`, encrypts when it can but does not verify the server, like libpq. Client certificates are not supported yet.
