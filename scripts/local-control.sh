#!/bin/sh
set -eu

root_dir=$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)
state_dir="$root_dir/.local"
tunnel_pid_file="$state_dir/tunnel.pid"
server_pid_file="$state_dir/server.pid"
tunnel_log="$state_dir/tunnel.log"
server_log="$state_dir/server.log"
url_file="$state_dir/public-url"
host_key_file="$state_dir/host-key"
ready_file="$state_dir/ready"
supervisor_log="$state_dir/supervisor.log"
supervisor_pid_file="$state_dir/supervisor.pid"
session_name=phone_controller_signal
script_path="$root_dir/scripts/local-control.sh"
port=${LOCAL_PORT:-8080}
unity_config=${UNITY_CONFIG:-"$root_dir/../unity/Assets/StreamingAssets/controller-connection.json"}
case "$unity_config" in
  /*) ;;
  *) unity_config="$root_dir/$unity_config" ;;
esac
export UNITY_CONFIG="$unity_config" LOCAL_PORT="$port"
wrangler="$root_dir/node_modules/.bin/wrangler"

pid_is_running() {
  pid_file=$1
  [ -f "$pid_file" ] || return 1
  pid=$(sed -n '1p' "$pid_file")
  case "$pid" in
    '' | *[!0-9]*) return 1 ;;
  esac
  kill -0 "$pid" 2>/dev/null
}

stop_process() {
  pid_file=$1
  label=$2
  if ! pid_is_running "$pid_file"; then
    rm -f "$pid_file"
    return
  fi

  pid=$(sed -n '1p' "$pid_file")
  kill "$pid" 2>/dev/null || true
  count=0
  while kill -0 "$pid" 2>/dev/null && [ "$count" -lt 20 ]; do
    sleep 0.25
    count=$((count + 1))
  done
  if kill -0 "$pid" 2>/dev/null; then
    kill -9 "$pid" 2>/dev/null || true
  fi
  rm -f "$pid_file"
  echo "$label を停止しました。"
}

stop_all() {
  stop_process "$server_pid_file" "ローカルサーバー"
  stop_process "$tunnel_pid_file" "HTTPSトンネル"
  rm -f "$url_file" "$ready_file"
}

show_status() {
  if pid_is_running "$server_pid_file"; then
    echo "ローカルサーバー: 稼働中 (PID $(sed -n '1p' "$server_pid_file"))"
  else
    echo "ローカルサーバー: 停止中"
  fi

  if pid_is_running "$tunnel_pid_file"; then
    echo "HTTPSトンネル: 稼働中 (PID $(sed -n '1p' "$tunnel_pid_file"))"
  else
    echo "HTTPSトンネル: 停止中"
  fi

  if [ -s "$url_file" ]; then
    echo "スマホ用URL: $(sed -n '1p' "$url_file")"
  fi
}

fail_start() {
  message=$1
  echo "$message" >&2
  [ ! -f "$tunnel_log" ] || tail -n 20 "$tunnel_log" >&2
  [ ! -f "$server_log" ] || tail -n 20 "$server_log" >&2
  stop_all >/dev/null 2>&1 || true
  exit 1
}

write_unity_config() {
  host_key=$1
  unity_dir=$(dirname "$unity_config")
  [ -d "$unity_dir" ] || mkdir -p "$unity_dir"
  config_tmp=$(mktemp "$unity_config.tmp.XXXXXX")
  trap 'rm -f "$config_tmp"' EXIT HUP INT TERM
  # Unity runs on this PC, so it should never depend on the public tunnel or DNS.
  # The phone still uses the trusted HTTPS URL printed by this script.
  signaling_url=${UNITY_SIGNALING_URL:-"ws://127.0.0.1:$port/signal"}
  {
    printf '{\n'
    printf '  "signalingUrl": "%s",\n' "$signaling_url"
    printf '  "hostKey": "%s"\n' "$host_key"
    printf '}\n'
  } >"$config_tmp"
  mv "$config_tmp" "$unity_config"
  trap - EXIT HUP INT TERM
}

public_health_is_ok() {
  public_url=$1
  if curl -fsS --max-time 3 "$public_url/healthz" >/dev/null 2>&1; then
    return 0
  fi

  # Some routers advertise an IPv6 DNS server that refuses newly-created
  # trycloudflare.com names. Resolve through Cloudflare DNS for this check.
  command -v dig >/dev/null 2>&1 || return 1
  public_host=$(printf '%s' "$public_url" | sed 's|^https://||; s|/.*||')
  public_ip=$(dig +short A "$public_host" @1.1.1.1 2>/dev/null | sed -n '/^[0-9][0-9.]*$/p' | head -n 1)
  [ -n "$public_ip" ] || return 1
  curl -fsS --max-time 3 --resolve "$public_host:443:$public_ip" \
    "$public_url/healthz" >/dev/null 2>&1
}

start_services() {
  if pid_is_running "$server_pid_file" && pid_is_running "$tunnel_pid_file" && [ -s "$url_file" ] && [ -s "$host_key_file" ]; then
    write_unity_config "$(sed -n '1p' "$host_key_file")"
    echo "すでに起動しています。"
    show_status
    echo "Unity設定を同期しました: $unity_config"
    return
  fi

  stop_all >/dev/null 2>&1 || true
  mkdir -p "$state_dir"
  chmod 700 "$state_dir"

  command -v node >/dev/null 2>&1 || fail_start "Node.jsが見つかりません。"
  command -v npm >/dev/null 2>&1 || fail_start "npmが見つかりません。"
  command -v curl >/dev/null 2>&1 || fail_start "curlが見つかりません。"
  command -v openssl >/dev/null 2>&1 || fail_start "opensslが見つかりません。"

  cd "$root_dir"
  if [ ! -x "$wrangler" ]; then
    echo "依存パッケージを準備しています..."
    npm install
  fi
  echo "サーバーをビルドしています..."
  npm run build >/dev/null

  if [ ! -s "$host_key_file" ]; then
    umask 077
    openssl rand -hex 32 >"$host_key_file"
  fi
  host_key=$(sed -n '1p' "$host_key_file")

  : >"$tunnel_log"
  echo "一時HTTPS URLを発行しています..."
  CI=1 NO_COLOR=1 nohup "$wrangler" tunnel quick-start "http://127.0.0.1:$port" \
    >"$tunnel_log" 2>&1 </dev/null &
  echo "$!" >"$tunnel_pid_file"

  public_url=
  count=0
  while [ "$count" -lt 120 ]; do
    if ! pid_is_running "$tunnel_pid_file"; then
      fail_start "HTTPSトンネルの起動に失敗しました。"
    fi
    public_url=$(sed -nE 's|.*(https://[a-z0-9-]+\.trycloudflare\.com).*|\1|p' "$tunnel_log" | head -n 1)
    [ -z "$public_url" ] || break
    sleep 0.25
    count=$((count + 1))
  done
  [ -n "$public_url" ] || fail_start "一時HTTPS URLを取得できませんでした。"
  printf '%s\n' "$public_url" >"$url_file"

  write_unity_config "$host_key"

  : >"$server_log"
  HOST_KEY="$host_key" PUBLIC_BASE_URL="$public_url" PORT="$port" \
    nohup node dist/src/index.js >"$server_log" 2>&1 </dev/null &
  echo "$!" >"$server_pid_file"

  count=0
  while [ "$count" -lt 40 ]; do
    if curl -fsS --max-time 2 "http://127.0.0.1:$port/healthz" >/dev/null 2>&1; then
      break
    fi
    if ! pid_is_running "$server_pid_file"; then
      fail_start "ローカルサーバーの起動に失敗しました。"
    fi
    sleep 0.25
    count=$((count + 1))
  done
  curl -fsS --max-time 2 "http://127.0.0.1:$port/healthz" >/dev/null 2>&1 || \
    fail_start "ローカルサーバーが応答しません。"

  count=0
  while [ "$count" -lt 60 ]; do
    if public_health_is_ok "$public_url"; then
      touch "$ready_file"
      echo "起動しました。"
      echo "スマホ用URL: $public_url"
      echo "Unity設定: $unity_config"
      echo "停止: ${LOCAL_STOP_COMMAND:-make stop}"
      return
    fi
    sleep 0.5
    count=$((count + 1))
  done
  fail_start "公開HTTPS URLからサーバーへ接続できませんでした。"
}

supervise() {
  trap 'stop_all >/dev/null 2>&1 || true; rm -f "$supervisor_pid_file"' EXIT
  trap 'exit 0' HUP INT TERM
  while true; do
    start_services
    failed_health_checks=0

    while pid_is_running "$server_pid_file" && pid_is_running "$tunnel_pid_file"; do
      public_url=$(sed -n '1p' "$url_file" 2>/dev/null || true)
      if [ -n "$public_url" ] && public_health_is_ok "$public_url"; then
        failed_health_checks=0
      else
        failed_health_checks=$((failed_health_checks + 1))
      fi

      if [ "$failed_health_checks" -ge 3 ]; then
        echo "HTTPS URLが応答しないため自動再発行します。" >>"$tunnel_log"
        stop_all >/dev/null 2>&1 || true
        break
      fi
      sleep 10
    done

    if pid_is_running "$server_pid_file" || pid_is_running "$tunnel_pid_file"; then
      stop_all >/dev/null 2>&1 || true
    fi
    sleep 1
  done
}

start_detached() {
  if pid_is_running "$server_pid_file" && pid_is_running "$tunnel_pid_file" && [ -f "$ready_file" ] && [ -s "$host_key_file" ]; then
    write_unity_config "$(sed -n '1p' "$host_key_file")"
    echo "すでに起動しています。"
    show_status
    echo "Unity設定を同期しました: $unity_config"
    return
  fi

  stop_process "$supervisor_pid_file" "監視プロセス" >/dev/null 2>&1 || true
  stop_all >/dev/null 2>&1 || true
  mkdir -p "$state_dir"
  rm -f "$ready_file"

  if command -v tmux >/dev/null 2>&1; then
    tmux kill-session -t "$session_name" >/dev/null 2>&1 || true
    # An existing tmux server does not inherit the caller's exported settings.
    tmux new-session -d -s "$session_name" \
      -e "UNITY_CONFIG=$unity_config" \
      -e "LOCAL_PORT=$port" \
      -e "UNITY_SIGNALING_URL=${UNITY_SIGNALING_URL:-}" \
      -e "LOCAL_STOP_COMMAND=${LOCAL_STOP_COMMAND:-make stop}" \
      "$script_path" supervise
  elif command -v screen >/dev/null 2>&1; then
    screen -S "$session_name" -X quit >/dev/null 2>&1 || true
    screen -DmS "$session_name" "$script_path" supervise
  else
    nohup "$script_path" supervise >"$supervisor_log" 2>&1 </dev/null &
    echo "$!" >"$supervisor_pid_file"
  fi

  count=0
  while [ "$count" -lt 240 ]; do
    if [ -f "$ready_file" ] && pid_is_running "$server_pid_file" && pid_is_running "$tunnel_pid_file"; then
      echo "起動しました。"
      echo "スマホ用URL: $(sed -n '1p' "$url_file")"
      echo "Unity設定: $unity_config"
      echo "停止: ${LOCAL_STOP_COMMAND:-make stop}"
      return
    fi
    sleep 0.25
    count=$((count + 1))
  done

  echo "起動を確認できませんでした。" >&2
  [ ! -f "$tunnel_log" ] || tail -n 20 "$tunnel_log" >&2
  [ ! -f "$server_log" ] || tail -n 20 "$server_log" >&2
  stop_detached >/dev/null 2>&1 || true
  exit 1
}

stop_detached() {
  if [ -z "${TMUX:-}" ] && command -v tmux >/dev/null 2>&1; then
    tmux kill-session -t "$session_name" >/dev/null 2>&1 || true
  fi
  if command -v screen >/dev/null 2>&1; then
    screen -S "$session_name" -X quit >/dev/null 2>&1 || true
  fi
  stop_process "$supervisor_pid_file" "監視プロセス"
  stop_all
}

action=${1:-start}
case "$action" in
  start) start_detached ;;
  stop) stop_detached ;;
  restart)
    stop_detached
    start_detached
    ;;
  supervise) supervise ;;
  status) show_status ;;
  logs)
    mkdir -p "$state_dir"
    touch "$server_log" "$tunnel_log"
    tail -n 100 -f "$server_log" "$tunnel_log"
    ;;
  *)
    echo "使い方: $0 {start|stop|restart|status|logs}" >&2
    exit 2
    ;;
esac
