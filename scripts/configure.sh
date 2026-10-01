#!/bin/sh
set -eu

env_file=${ENV_FILE:-.env}
unity_config=${UNITY_CONFIG:-../unity/Assets/StreamingAssets/controller-connection.json}
domain=${DOMAIN:-}
host_key=
env_tmp=
config_tmp=

cleanup() {
  [ -z "$env_tmp" ] || rm -f "$env_tmp"
  [ -z "$config_tmp" ] || rm -f "$config_tmp"
}
trap cleanup EXIT HUP INT TERM

if [ -f "$env_file" ]; then
  saved_domain=$(sed -n 's/^CONTROLLER_DOMAIN=//p' "$env_file" | head -n 1)
  host_key=$(sed -n 's/^HOST_KEY=//p' "$env_file" | head -n 1)
  [ -n "$domain" ] || domain=$saved_domain
fi

[ "$host_key" != "replace-with-at-least-24-random-characters" ] || host_key=

if [ -z "$domain" ]; then
  echo "初回だけ make DOMAIN=controller.example.jp のようにドメインを指定してください。" >&2
  exit 2
fi

if [ "$domain" = "controller.example.jp" ]; then
  echo "DOMAINを実際に使用するドメインへ置き換えてください。" >&2
  exit 2
fi

case "$domain" in
  *[!A-Za-z0-9.-]* | .* | *.)
    echo "DOMAINにはホスト名だけを指定してください（例: controller.example.jp）。" >&2
    exit 2
    ;;
esac

if [ -z "$host_key" ]; then
  command -v openssl >/dev/null 2>&1 || {
    echo "秘密鍵の生成にopensslが必要です。" >&2
    exit 1
  }
  host_key=$(openssl rand -hex 32)
fi

if [ "${#host_key}" -lt 24 ]; then
  echo "$env_file のHOST_KEYは24文字以上にしてください。" >&2
  exit 2
fi

case "$host_key" in
  *[!A-Za-z0-9._~+/-]*)
    echo "$env_file のHOST_KEYに使用できない文字があります。" >&2
    exit 2
    ;;
esac

umask 077
env_tmp=$(mktemp "${env_file}.tmp.XXXXXX")
{
  printf 'CONTROLLER_DOMAIN=%s\n' "$domain"
  printf 'PUBLIC_BASE_URL=https://%s\n' "$domain"
  printf 'HOST_KEY=%s\n' "$host_key"
} >"$env_tmp"
mv "$env_tmp" "$env_file"
env_tmp=
echo "設定: https://$domain"

unity_dir=$(dirname "$unity_config")
if [ -d "$unity_dir" ]; then
  config_tmp=$(mktemp "${unity_config}.tmp.XXXXXX")
  {
    printf '{\n'
    printf '  "signalingUrl": "wss://%s/signal",\n' "$domain"
    printf '  "hostKey": "%s"\n' "$host_key"
    printf '}\n'
  } >"$config_tmp"
  mv "$config_tmp" "$unity_config"
  config_tmp=
  echo "Unity設定も同期しました: $unity_config"
fi
