#!/usr/bin/env bash
# Test certificates for a TLS-enabled PostgreSQL: a CA, a server certificate for "localhost" only
# (not 127.0.0.1, so host name checks can be tested), and an unrelated CA. Usage: scripts/pg-tls-certs.sh <dir>
set -euo pipefail
dir=${1:?usage: pg-tls-certs.sh <dir>}
mkdir -p "$dir" && cd "$dir"
openssl req -x509 -newkey rsa:2048 -nodes -days 7 -subj "/CN=Qala test CA" -keyout ca.key -out ca.pem 2>/dev/null
openssl req -newkey rsa:2048 -nodes -subj "/CN=localhost" -keyout server.key -out server.csr 2>/dev/null
printf "subjectAltName=DNS:localhost\n" > ext
openssl x509 -req -in server.csr -CA ca.pem -CAkey ca.key -CAcreateserial -days 7 -extfile ext -out server.crt 2>/dev/null
openssl req -x509 -newkey rsa:2048 -nodes -days 7 -subj "/CN=Unrelated CA" -keyout other.key -out other-ca.pem 2>/dev/null
chmod 600 server.key
