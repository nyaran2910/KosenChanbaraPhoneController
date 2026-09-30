#!/bin/sh
set -eu

container_name=${PHONE_CONTROLLER_CONTAINER:-kosen-chanbara-phone-controller}
image=${PHONE_CONTROLLER_IMAGE:-ghcr.io/nyaran336699/kosen-chanbara-phone-controller:latest}
unity_config=${UNITY_CONFIG:-../unity/Assets/StreamingAssets/controller-connection.json}
port=${LOCAL_PORT:-8080}

if [ ! -x "$(command -v docker 2>/dev/null || true)" ]; then
  echo "Dockerが見つかりません。Docker Desktopをインストールしてください。" >&2
  exit 1
fi

unity_dir=$(dirname "$unity_config")
mkdir -p "$unity_dir"
case "$unity_dir" in
  /*) ;;
  *) unity_dir="$(pwd)/$unity_dir" ;;
esac

show_status() {
  running=$(docker inspect --format '{{.State.Running}}' "$container_name" 2>/dev/null || true)
  if [ "$running" = true ]; then
    echo "スマホコントローラー: 稼働中 ($container_name)"
    docker logs "$container_name" 2>&1 | sed -n '/スマホ用URL:/p; /Unity設定:/p' | tail -n 2
  else
    echo "スマホコントローラー: 停止中"
  fi
}

case "${1:-up}" in
  up)
    docker info >/dev/null 2>&1 || {
      echo "Docker Desktopを起動してから、もう一度 make を実行してください。" >&2
      exit 1
    }
    echo "Dockerイメージを取得しています: $image"
    docker pull "$image"
    docker rm -f "$container_name" >/dev/null 2>&1 || true
    rm -f "$unity_dir/controller-connection.json"
    docker run --detach --name "$container_name" --restart unless-stopped \
      --publish "127.0.0.1:$port:$port" \
      --volume "$unity_dir:/unity-config" \
      --env "PORT=$port" \
      --env UNITY_CONFIG_PATH=/unity-config/controller-connection.json \
      "$image" >/dev/null

    count=0
    while [ "$count" -lt 120 ]; do
      if [ -s "$unity_dir/controller-connection.json" ] && \
         curl -fsS --max-time 2 "http://127.0.0.1:$port/healthz" >/dev/null 2>&1; then
        echo "スマホコントローラーを起動しました。"
        docker logs "$container_name" 2>&1 | sed -n '/スマホ用URL:/p; /Unity設定:/p' | tail -n 2
        echo "UnityでPlayするとQRコードが表示されます。"
        echo "停止: make phone-controller-stop"
        exit 0
      fi
      running=$(docker inspect --format '{{.State.Running}}' "$container_name" 2>/dev/null || true)
      if [ "$running" != true ]; then
        docker logs "$container_name" >&2 || true
        echo "コントローラーコンテナが起動できませんでした。" >&2
        exit 1
      fi
      sleep 0.5
      count=$((count + 1))
    done
    docker logs "$container_name" >&2 || true
    echo "起動を確認できませんでした。" >&2
    exit 1
    ;;
  stop)
    docker rm -f "$container_name" >/dev/null 2>&1 || true
    echo "スマホコントローラーを停止しました。"
    ;;
  status)
    docker info >/dev/null 2>&1 || {
      echo "Docker Desktopが停止しています。"
      exit 1
    }
    show_status
    ;;
  logs)
    docker logs --follow --tail=100 "$container_name"
    ;;
  *)
    echo "使い方: $0 {up|stop|status|logs}" >&2
    exit 2
    ;;
esac
