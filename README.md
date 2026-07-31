# docker-server-list

Docker ホストで動いているものを 1 画面で棚卸しする、**閲覧専用**のダッシュボード。

「このサーバ、結局なにが動いてたんだっけ」を数秒で答えるためのツールです。
起動・停止・編集はできません。できないように作ってあります。

![MIT](https://img.shields.io/badge/license-MIT-blue) ![deps](https://img.shields.io/badge/dependencies-0-brightgreen)

- **アクセス** — LAN から開けるサービスをタイルで一覧。クリックで飛べる
- コンテナ名 / compose プロジェクト・サービス / イメージ
- ポート（ホスト公開・localhost のみ・コンテナ内部のみ を区別）
- CPU 使用率・メモリ使用量 / 上限比・ネットワーク I/O
- 稼働時間、ヘルスチェック状態、再起動ポリシーと再起動回数
- 行をクリックすると compose ファイルのパス・作業ディレクトリ・所属ネットワークを展開
- 停止中のコンテナも表示するので、放置されたスタックも見つかる

npm 依存パッケージは **0 個**。Node.js 標準ライブラリだけで動きます。

## 起動

```bash
git clone https://github.com/astail/docker-server-list.git
cd docker-server-list
cp .env.example .env
docker compose up -d --build
```

http://127.0.0.1:8080/ で開きます。

> **既定は localhost のみです。** このダッシュボードはサーバの構成情報を認証なしで
> 見せるため、公開範囲を広げるのは意図的な操作にしてあります。LAN からも見たい場合は
> `.env` を編集してください。
>
> ```bash
> LISTEN_ADDR=192.168.1.10   # LAN 側 NIC の IP。0.0.0.0 は全インタフェース
> HTTP_PORT=80
> ```

## 構成

```
ブラウザ ──▶ web ──▶ collector ──▶ socket-proxy ──▶ docker.sock
              └ internal ┘   └ docker-api ┘
```

- **web** (`src/server.js`) — 静的ファイルの配信、Basic 認証、スナップショットの中継。
  フロントは素の HTML/CSS/JS（ビルド不要）。
- **collector** (`src/collector.js`) — Docker API を叩く唯一のプロセス。5 秒ごとに収集し、
  画面に必要なフィールドだけに絞って web に返す。
- **socket-proxy** — [tecnativa/docker-socket-proxy](https://github.com/Tecnativa/docker-socket-proxy)。
  `CONTAINERS` と `INFO` の GET だけを通し、`POST` は全て拒否する。

**web は socket-proxy と同じネットワークに属していません。** そのため web で任意コード実行が
起きても Docker API には届かず、得られるのは画面に出ているスナップショットだけです。
これは飾りではなく実効的な境界で、詳しい理由は [SECURITY.md](SECURITY.md) にあります
（`CONTAINERS=1` は `/containers/{id}/archive` や `logs` も通してしまうため、
proxy の設定調整では塞げない）。

## セキュリティ

**このダッシュボードに到達できること自体が、サーバ構成の開示です。**
コンテナ名・イメージ・ポート・compose ファイルの絶対パス・ホスト名が見えます。
インターネットに直接公開しないでください。

詳細な脅威モデルと対策の一覧は [SECURITY.md](SECURITY.md) にあります。要点だけ:

- **web は Docker API への経路を持たない**。名前解決だけでなく IP 直指定でも到達不能
- collector が返すのは整形済みのスナップショットのみ。**`Config.Env` や `Mounts` は境界を越えない**
- socket-proxy は `POST=0`。**start / stop / exec / rm / build は API レベルで 403**
- 既定の待ち受けは `127.0.0.1:8080`
- `AUTH_USER` と `AUTH_PASSWORD` を両方設定すると HTTP Basic 認証が有効になる
  （定数時間比較、10 回失敗で 60 秒ロックアウト。リバースプロキシ配下では `TRUST_PROXY=1`）
- CSP は `default-src 'none'` ベース、DOM 生成は `textContent` のみで `innerHTML` 不使用
- 3 コンテナとも `cap_drop: ALL` / `no-new-privileges` / PID・メモリ上限。
  web と collector は非 root・`read_only`

手元で確認できます:

```bash
# web から Docker API に到達できない（両方とも失敗する）
docker exec dsl-web wget -q -T 5 -O - http://socket-proxy:2375/containers/json
ip=$(docker inspect dsl-socket-proxy --format '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}')
docker exec dsl-web wget -q -T 5 -O - "http://$ip:2375/containers/json"

# 変更系 API が拒否される
NET=docker-server-list_docker-api
CID=$(docker ps -q -f name=dsl-socket-proxy)
run() { docker run --rm --network $NET curlimages/curl -s -o /dev/null -w "%{http_code}\n" "$@"; }

run http://socket-proxy:2375/containers/json               # 200
run -X POST http://socket-proxy:2375/containers/$CID/stop   # 403
run -X POST http://socket-proxy:2375/containers/$CID/exec   # 403
run -X DELETE http://socket-proxy:2375/containers/$CID      # 403
run http://socket-proxy:2375/images/json                    # 403
```

同じ検証は CI でも毎回走ります（`.github/workflows/ci.yml`）。

## 設定

| 変数 | 既定値 | 説明 |
| --- | --- | --- |
| `LISTEN_ADDR` | `127.0.0.1` | バインドするアドレス。LAN 公開なら LAN 側 IP を指定 |
| `HTTP_PORT` | `8080` | ホスト側の公開ポート |
| `AUTH_USER` | （空） | 両方設定したときだけ Basic 認証が有効 |
| `AUTH_PASSWORD` | （空） | 〃 |
| `TRUST_PROXY` | `0` | リバースプロキシ配下でのみ `1`。ロックアウトを X-Forwarded-For の最終ホップ単位で数える |
| `REFRESH_INTERVAL_MS` | `5000` | 収集間隔（ミリ秒） |
| `HEALTH_MAX_AGE_MS` | 収集間隔×6（最低 30000） | 最終収集からこの時間を超えると `/healthz` が 503 |
| `HTTP_PROBE` | `1` | 公開ポートへの HTTP プローブ。`0` で無効 |
| `PROBE_TTL_MS` | `30000` | 同じポートを再プローブするまでの間隔（ミリ秒） |

数値は起動時に整数と範囲を検証します。不正な値は変数名と期待範囲を表示して即座に終了するので、
タイプミスで Docker API を高速ループさせることはありません。

### リバースプロキシ配下に置く場合

`X-Forwarded-Proto: https` が付いていれば `Cross-Origin-Opener-Policy` も送ります。
HSTS はプロキシ側で付けてください。

## 画面の見方

### アクセスタイル

稼働中かつホストの全インタフェースに公開されているポートを、compose プロジェクト名で
タイル表示します。リンク先は**ブラウザで開いているホスト名をそのまま使う**ので、
`http://192.168.1.10/` で開けばタイルも `http://192.168.1.10:8001/` を指します。

サーバ側が各ポートに `GET /` を投げて HTTP かどうかを判定しており、

- HTTP で応答 → リンクになり、`<title>` をサブタイトルに表示
- HTTP 以外 → `TCP` バッジ付きでリンクなし（例: Minecraft の 25565）
- HTTP だが 4xx/5xx → リンクのまま `HTTP 404` バッジ（ルートを持たない API など）

プローブ先は Docker が公開しているポートに限られますが、リクエストは相手の
アクセスログに残ります。不要なら `HTTP_PROBE=0`。`127.0.0.1` にのみバインドされた
ポートと停止中コンテナは対象外です。

### ポートのバッジ

| 表示 | 意味 |
| --- | --- |
| `8080→80/tcp`（リンク） | ホストに公開されていて HTTP で応答した |
| `25565/tcp`（リンクなし） | ホストに公開されているが HTTP ではない |
| `🔒 18000→8000/tcp` | `127.0.0.1` にのみバインド。このサーバ内からのみ到達可能 |
| `8188/tcp`（破線） | コンテナ内部のみ。ホストには未公開 |
| 薄い表示 | 停止中コンテナの設定上のポート |

### CPU とメモリ

**CPU** は `docker stats` と同じ計算（コンテナの CPU 時間 ÷ システム全体の CPU 時間
× コア数）。バーはホストの全コアに対する割合なので `100%` = 全コア使い切り。

**メモリ** はカーネルが回収可能なページキャッシュ（`inactive_file`）を引いた値で、
これも `docker stats` と一致します。バーはコンテナのメモリ上限に対する割合。

ヘッダの数値は稼働中コンテナの合計です。ホストの空きメモリそのものではありません。

## API

`GET /api/containers` が UI と同じ JSON を返します。

```bash
curl -s http://127.0.0.1:8080/api/containers | jq '.containers[] | {name, state, cpuPercent, memUsed}'
```

`GET /healthz` は**最後に成功した収集からの経過時間**で判定します。Docker API が落ちて
収集が止まれば、古いスナップショットが手元に残っていても `HEALTH_MAX_AGE_MS` 経過後に 503 に
なります。healthcheck から使うため、認証を有効にしてもこのパスだけは認証不要です
（`{"ok":true|false}` 以外は返しません）。

## 既製 OSS との比較

要件は「名前・ポート・CPU・メモリを 1 つの表で見る、閲覧専用」でした。
2026 年 8 月時点で調べた範囲では次のようなギャップがあります。

| ツール | ポート | CPU/メモリ | 備考 |
| --- | --- | --- | --- |
| [Portainer CE](https://github.com/portainer/portainer) | ○ | △ 一覧には出ず個別画面 | フル管理 UI。停止・exec も可能になる |
| [Dozzle](https://github.com/amir20/dozzle) | △ | ○ | 本質はログビューア |
| [Dockhand](https://github.com/Finsys/dockhand) | ○ | ○ | 高機能だが BSL 1.1、DB + 認証必須、docker.sock 書き込み権限が要る |
| [Beszel](https://github.com/henrygd/beszel) | ✕ | ○ | 履歴メトリクス向け。hub + agent 構成 |
| cAdvisor / Glances | ✕ | ○ | メトリクス専用 |
| lazydocker / ctop | ○ | ○ | TUI のみ |

管理操作が必要なら Dockhand や Portainer を別ポートで併設し、こちらは閲覧用として
残すのが素直です。**このツールは意図的に「見るだけ」に留めています。**

## ライセンス

[MIT](LICENSE) © astail
