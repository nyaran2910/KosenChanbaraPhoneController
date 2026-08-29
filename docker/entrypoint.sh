#!/bin/sh
set -eu

port=${PORT:-8080}

if [ -n "${PUBLIC_BASE_URL:-}" ]; then
  exec node dist/index.js
fi

host_key=${HOST_KEY:-$(node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))")}
unity_config=${UNITY_CONFIG_PATH:-/unity-config/controller-connection.json}
tunnel_log=$(mktemp)
tunnel_pid=
server_pid=

cleanup() {
  [ -z "$server_pid" ] || kill "$server_pid" 2>/dev/null || true
  [ -z "$tunnel_pid" ] || kill "$tunnel_pid" 2>/dev/null || true
  rm -f "$tunnel_log"
}
trap cleanup EXIT HUP INT TERM

cloudflared tunnel --no-autoupdate --url "http://127.0.0.1:$port" >"$tunnel_log" 2>&1 &
tunnel_pid=$!

public_url=
count=0
while [ "$count" -lt 120 ]; do
  if ! kill -0 "$tunnel_pid" 2>/dev/null; then
    cat "$tunnel_log" >&2
    exit 1
  fi
  public_url=$(sed -nE 's|.*(https://[a-z0-9-]+\.trycloudflare\.com).*|\1|p' "$tunnel_log" | head -n 1)
  [ -z "$public_url" ] || break
  sleep 0.25
  count=$((count + 1))
done

if [ -z "$public_url" ]; then
  cat "$tunnel_log" >&2
  exit 1
fi

unity_dir=$(dirname "$unity_config")
if [ -d "$unity_dir" ] && [ -w "$unity_dir" ]; then
  config_tmp=$(mktemp "$unity_config.tmp.XXXXXX")
  {
    printf '{\n'
    printf '  "signalingUrl": "ws://127.0.0.1:%s/signal",\n' "$port"
    printf '  "hostKey": "%s"\n' "$host_key"
    printf '}\n'
  } >"$config_tmp"
  mv "$config_tmp" "$unity_config"
else
  echo "Unity設定の保存先へ書き込めません: $unity_dir" >&2
  exit 1
fi

HOST_KEY="$host_key" PUBLIC_BASE_URL="$public_url" PORT="$port" node dist/index.js &
server_pid=$!

count=0
while [ "$count" -lt 40 ]; do
  if node -e "fetch('http://127.0.0.1:$port/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"; then
    break
  fi
  if ! kill -0 "$server_pid" 2>/dev/null; then
    exit 1
  fi
  sleep 0.25
  count=$((count + 1))
done

echo "スマホ用URL: $public_url"
echo "Unity設定: $unity_config"

while kill -0 "$server_pid" 2>/dev/null && kill -0 "$tunnel_pid" 2>/dev/null; do
  sleep 1
done

cat "$tunnel_log" >&2
exit 1
