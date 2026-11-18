# Security policy

Qala implements its own HTTP/1.1 parser, WebSocket protocol, multipart parser and PostgreSQL client, so security reports are especially welcome.

**Please do not open public issues for vulnerabilities.** Report them through [GitHub private advisories](https://github.com/Prestgg1/qala/security/advisories/new). You can expect a first reply within 7 days.

Qala is 0.x: only the latest release receives fixes.

Known limitations (not vulnerabilities, but relevant to deployment): the PostgreSQL client does not support TLS yet, so keep the database on a private network.
