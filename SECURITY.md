# Security Policy

## 脅威モデル

docker-server-list は **Docker ホストのインベントリを閲覧する** ためのツールです。
設計上、アクセスできる人には次の情報がすべて見えます。

- コンテナ名・compose プロジェクト名・サービス名・イメージ名とタグ
- ホストに公開されているポート番号と、そこで動いているサービスのページタイトル
- compose ファイルと作業ディレクトリの**絶対パス**
- ホスト名・OS・Docker のバージョン・CPU コア数・搭載メモリ量

つまり **このダッシュボードに到達できること自体が、サーバ構成の開示** になります。
公開範囲は運用者が決める前提で、既定値は最も狭くしてあります。

## 構成と信頼境界

```
ブラウザ ──▶ web ──▶ collector ──▶ socket-proxy ──▶ docker.sock
             (A)      (B)           (C)
        └ internet ┘└ internal ┘└ docker-api ┘
```

- **(A) web** — 静的ファイル 4 つの配信、Basic 認証、collector からのスナップショット中継。
  **Docker の資格情報も socket-proxy への経路も持たない。**
- **(B) collector** — Docker API を叩く唯一のプロセス。応答から画面に必要なフィールドだけを
  取り出して web に返す。`Config.Env`・`Mounts`・`HostConfig` は境界を越えない。
- **(C) socket-proxy** — `POST` を全拒否。collector すら変更系 API を呼べない。

web は `internal` ネットワークにしか属さず、socket-proxy は `docker-api` にしか属さないため、
**web から Docker API への経路は存在しません**（DNS だけでなく IP 直指定でも到達不能）。

これは重要な性質です。socket-proxy の `CONTAINERS=1` は list / inspect / stats だけを
許可する設定ではなく、`/containers/{id}/` 配下の GET を一括で通します。実際に確認すると:

```
GET /containers/{id}/archive?path=/etc/passwd  -> 200  # 任意コンテナの任意ファイル
GET /containers/{id}/logs                       -> 200
GET /containers/{id}/export                     -> 200
GET /containers/{id}/json                       -> 200  # Config.Env に他プロジェクトの
                                                        # POSTGRES_PASSWORD などが入る
```

`tecnativa/docker-socket-proxy` にこれらだけを個別に拒否する設定はありません。そのため
**proxy の設定ではなく、web を Docker API から切り離すこと**で対処しています。
web で RCE が起きても、得られるのは画面に表示されているスナップショットだけです。

## 設計上の防御

| 対象 | 対策 |
| --- | --- |
| Docker API への経路 | web は socket-proxy と同じネットワークに属さない。IP 直指定でも到達不能 |
| 機密の越境 | collector が `Config.Env` / `Mounts` / `HostConfig` を落とし、必要なフィールドだけ返す |
| 変更系 API | socket-proxy が `POST=0`。start / stop / exec / rm / build は 403 |
| ソケットのマウント | socket-proxy 側で `:ro`。ただし下記のとおり **API を読み取り専用にする効果はない** |
| サプライチェーン | ベースイメージ・socket-proxy はダイジェスト固定、GitHub Actions は commit SHA 固定 |
| 固定の陳腐化 | Dependabot が weekly で 3 エコシステムを監視し、固定値を上げる PR を出す |
| 既定の公開範囲 | `127.0.0.1:8080`。広げるのは `.env` での明示的な操作 |
| 認証 | `AUTH_USER` と `AUTH_PASSWORD` の両方を設定すると HTTP Basic。ハッシュ後に `timingSafeEqual` で定数時間比較 |
| 総当たり | 既定は接続元アドレス単位で 10 回失敗 / 60 秒ロックアウト。リバースプロキシ配下では `TRUST_PROXY=1` で X-Forwarded-For の最終ホップ単位に切り替える |
| XSS | DOM 生成は `textContent` / `createTextNode` のみ。`innerHTML` を一切使わない |
| CSP | `default-src 'none'` ベース。外部リソース・インラインスクリプト・iframe 埋め込みを全て禁止 |
| パストラバーサル | 静的配信は URL からパスを組み立てず、4 経路の固定アロウリスト |
| プローブ入力 | 他サービスから受け取る `<title>` は制御文字を除去し 90 文字で切り詰め。数値実体参照は範囲検査してから復号 |
| 外部通信の停止 | Docker API・プローブとも **wall-clock の絶対期限**と応答サイズ上限を持つ。相手が少しずつ応答し続けても収集は止まらない |
| 設定ミス | 数値環境変数は起動時に整数・範囲を検証し、不正なら変数名と期待範囲を出して fail-fast |
| 障害検知 | `/healthz` は「最後の**成功した**収集からの経過時間」で判定。一度成功したら常に 200、にはならない |
| リクエスト制限 | GET / HEAD のみ。ヘッダ数・ヘッダ待ち・リクエスト全体・keep-alive・同時接続数に上限 |
| コンテナ | 3 つとも `cap_drop: ALL` / `no-new-privileges` / PID・メモリ上限。web と collector は非 root・`read_only`（socket-proxy は下記の理由で `read_only` なし） |

## 残存リスクと、そこから来る設計判断

### `:ro` マウントは Docker API を読み取り専用にしない

よくある誤解ですが、`-v /var/run/docker.sock:/var/run/docker.sock:ro` が守るのは
**ソケットファイル自体**（削除・置換）だけで、そこに接続して変更系 API を叩くことは
一切防ぎません。手元で確認できます。

```console
$ docker run --rm --user 0:0 -v /var/run/docker.sock:/var/run/docker.sock:ro curlimages/curl \
    -s -o /dev/null -w '%{http_code}\n' --unix-socket /var/run/docker.sock \
    -X POST http://localhost/containers/definitely-no-such-id/stop
404      # ← daemon がリクエストを処理している = 書ける

$ docker run --rm --user 0:0 -v /var/run/docker.sock:/var/run/docker.sock:ro \
    --entrypoint sh curlimages/curl -c 'touch /var/run/docker.sock'
touch: /var/run/docker.sock: Read-only file system
```

したがって **`POST=0` の socket-proxy だけが実効的な変更系の防壁**です。

### collector と socket-proxy は依然として高い権限を持つ

- **collector** が侵害された場合、`/containers/{id}/archive` と inspect を通じて、
  同一ホスト上の他コンテナのファイルと環境変数を読めます。変更はできません。
- **socket-proxy** が侵害された場合、haproxy の ACL を迂回してソケットに直接接続できるため、
  Docker への完全なアクセスを得ます。`read_only` を足してもこの結論は変わりません
  （防げるのはファイルの永続化だけ）。

この前提から、外部入力に触れるプロセスほど権限を下げる構成にしています。

| | 外部入力 | Docker API | 権限 |
| --- | --- | --- | --- |
| web | ブラウザからの HTTP | なし | 最小 |
| collector | collector 自身のプローブ応答のみ | 読み取り | 中 |
| socket-proxy | なし（collector からのみ） | 素通し | 高 |

socket-proxy には自前のアプリケーションコードを一切置かず、ダイジェスト固定し、
ポートを公開せず、collector からのみ到達できるネットワークに隔離しています。

### `read_only` を socket-proxy に付けていない理由

上流の entrypoint が起動時に `haproxy.cfg` をテンプレートと同じディレクトリへ生成するため、
そこに tmpfs を被せるとテンプレートが隠れて起動しません。回避するには派生イメージで
entrypoint を差し替える必要がありますが、上のとおり **このコンテナで守るべきものは
ファイルではなくソケット**であり、`read_only` は実効的な防御になりません。
`cap_drop: ALL` などの他の制約で代替しています。

## 運用側で必要な判断

- **インターネットに直接公開しない。** ポート開放やリバースプロキシで外に出す場合は、
  TLS 終端と認証を必ず前段に置く。Basic 認証は平文 HTTP 上では盗聴に耐えない。
- **`LISTEN_ADDR=0.0.0.0` は、ルータのポート開放があると外部到達になる。**
  LAN 限定にしたいなら LAN 側 NIC の IP を明示する。
- **HTTP プローブは公開ポートに `GET /` を送る。** 送信先は Docker が公開している
  ポートに限られるが、リクエストが相手のアクセスログに残る。不要なら `HTTP_PROBE=0`。
- **`TRUST_PROXY=1` はリバースプロキシがある場合のみ。** プロキシ無しで有効にすると、
  X-Forwarded-For を詐称してロックアウトを回避できてしまう。

## 脆弱性の報告

セキュリティ上の問題を見つけた場合は、公開 issue ではなく
[GitHub Security Advisories](https://github.com/astail/docker-server-list/security/advisories/new)
から非公開で報告してください。
