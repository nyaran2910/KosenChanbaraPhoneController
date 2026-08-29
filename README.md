# Kosen Chanbara Phone Controller

スマホ用ページと、UnityとのWebRTC接続を確立するシグナリングサーバーです。センサーデータはサーバーを通らず、スマホからUnityへLAN内で直接送られます。

## Docker配布版

Unityプロジェクト直下のPowerShellで実行します。

```powershell
docker load -i .\kosen-chanbara-phone-controller-amd64.tar.gz
docker run --rm --name kosen-controller -p 127.0.0.1:8080:8080 --mount "type=bind,source=$($PWD.Path)\Assets\StreamingAssets,target=/unity-config" kosen-chanbara-phone-controller:1.0.0
```

起動時に一時HTTPS URLと `Assets/StreamingAssets/controller-connection.json` を自動生成します。停止は `Ctrl+C` です。

## ソースから起動・検証

```sh
make
npm test
npm run build
```

`make stop` で停止します。固定ドメインとVPSを使う場合だけ `make production DOMAIN=controller.example.jp` を使います。
