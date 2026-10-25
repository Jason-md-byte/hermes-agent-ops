#!/usr/bin/env bash
# Read-only post-change checks. Safe to run any time. Adjust unit names and ports.
set -u

echo "== services"
systemctl is-enabled <APP_UNIT>
systemctl is-active  <APP_UNIT> <GATEWAY_UNIT> <MCP_UNIT> smbd

echo "== app health"
curl -s http://127.0.0.1:3100/api/health; echo

echo "== exposure (expect: tailnet only, no Funnel)"
tailscale serve status

echo "== ssh policy (expect: no)"
sudo sshd -T | grep -i passwordauthentication

echo "== lingering (expect: Linger=yes)"
loginctl show-user <SERVICE_USER> -p Linger

echo "== OAuth: bad redirect refused (expect 400)"
curl -s -o /dev/null -w "%{http_code}\n" -X POST http://127.0.0.1:<OAUTH_PORT>/register \
  -H 'content-type: application/json' -d '{"redirect_uris":["https://evil.example/cb"]}'

echo "== MCP without a token (expect 401)"
curl -s -o /dev/null -w "%{http_code}\n" -X POST http://127.0.0.1:<MCP_PORT>/mcp \
  -H 'content-type: application/json' -d '{}'
