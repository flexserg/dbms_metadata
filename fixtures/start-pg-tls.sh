#!/bin/sh
# Disposable local/CI source; generated private keys stay in a Docker volume.
set -eu
docker volume create metadata-pg-tls-fixture >/dev/null
docker run --rm --entrypoint sh -v metadata-pg-tls-fixture:/certs postgres:17-bookworm -ceu '
  umask 077
  openssl req -x509 -newkey rsa:2048 -nodes -days 2 -subj /CN=localhost \
    -addext subjectAltName=DNS:localhost -keyout /certs/server.key -out /certs/server.crt >/dev/null 2>&1
  chown 999:999 /certs/server.key /certs/server.crt
  chmod 600 /certs/server.key
  chmod 644 /certs/server.crt
'
docker run -d --name metadata-pg-tls-test -p 127.0.0.1:55433:5432 \
  -e POSTGRES_USER=metadata -e POSTGRES_DB=metadata -e POSTGRES_PASSWORD=integration-password \
  -v metadata-pg-tls-fixture:/certs:ro postgres:17-bookworm \
  -c ssl=on -c ssl_cert_file=/certs/server.crt -c ssl_key_file=/certs/server.key
docker exec metadata-pg-tls-test cat /certs/server.crt > /tmp/dbms-pg-ca.crt
attempt=0
until docker exec metadata-pg-tls-test pg_isready -U metadata -d metadata >/dev/null 2>&1; do
  attempt=$((attempt + 1))
  if [ "$attempt" -ge 60 ]; then
    echo 'TLS PostgreSQL fixture did not become ready' >&2
    exit 1
  fi
  sleep 1
done
