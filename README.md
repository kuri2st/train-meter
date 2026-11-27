# train-meter

鉄道で移動中に、スマホ (Android の Chrome) の位置情報から次の情報を表示する Web アプリ。

- 現在の速度、過去 n 秒 (30〜1800 秒、既定 180 秒) の速度履歴グラフ
- 現在の路線名 (並走区間では候補をタップで切り替え)
- 種別 (各停・急行など) の停車駅だけを次駅に表示。種別は止まった駅・通過した駅から自動で判定し、ボタンで手動でも選べる (`types.json` にある路線のみ)
- 進行方向の次駅と、その先の駅までの残り距離・到着予想時刻
- トンネル情報 (トンネル内か・名前・全長 / 出口までの距離 / 次のトンネル / 次駅までのトンネル数・合計長)

GPS が途切れた (トンネル内など) ときは、直前の速度のまま線路に沿って進んだと仮定して推定し、橙色で表示する。

ブラウザ版はバックグラウンドでは位置が取れない (戻ったときに測位からやり直す)。
画面を消しても動かしたいときは Android アプリ版 (`android/`) を使う。通知に速度・次駅・到着予想が出る。

## 構成

| パス | 内容 |
|---|---|
| `docs/` | 公開する Web アプリ (GitHub Pages のルート) |
| `docs/data/rail.json` | 路線・駅・トンネルのデータ (build_data.py の出力) |
| `docs/data/types.json` | 路線ごとの種別と停車駅 (手で書く。ダイヤ改正で変わったら直す) |
| `tools/fetch_raw.py` | 元データの取得 (国土数値情報 N02-24、OSM の鉄道トンネル) |
| `tools/build_data.py` | 元データを `rail.json` に加工 |
| `raw/` | 元データ (git 管理外) |
| `android/` | Android アプリ (Capacitor)。中身は `docs/` の Web アプリ |
| `android/app/src/main/java/.../TrainLocationService.java` | GPS を取り続けるフォアグラウンドサービスと通知 |
| `android/app/src/main/java/.../TrainLocationPlugin.java` | 上のサービスを JS (`app.js`) から使うためのプラグイン |

## データの作り直し

Spyder で `tools/fetch_raw.py` → `tools/build_data.py` の順に実行する。
アプリやデータを更新したら `docs/sw.js` の `VERSION` を上げる (端末のキャッシュを更新させるため)。

## Android アプリのビルド

Node.js と Android Studio が必要。リポジトリのルートで:

```
npm install
npx cap sync android     # docs/ の中身をアプリにコピー (docs/ を変えたら毎回)
npx cap open android     # Android Studio で開く (または android/ フォルダを直接開く)
```

Android Studio で端末をつないで ▶ (Run) を押す。初回の「開始」で位置情報と通知の許可を求められる。

- 画面を消す・ほかのアプリに切り替えると、通知に「速度・路線 / 次駅・到着予想」が出て、そのまま測位を続ける
- 「停止」を押すか、最近使ったアプリの一覧からスワイプで消すと止まる
- 機種によっては省電力機能に止められる。そのときは端末の設定でこのアプリの「バッテリー」を「制限なし」にする

## 動作確認 (模擬走行)

`docs` をローカルで配信し、`?sim=路線名の一部` を付けて開くと、その路線を各駅停車で走る模擬走行になる。
トンネル内では GPS を出さないので、推定の動作も確認できる。

```
python -m http.server 8765 -d docs
http://127.0.0.1:8765/?sim=東海道新幹線&x=10
```

- `x`: 早回しの倍率、`v`: 最高速度 [km/h] (既定は新幹線 270、他 100)、`n`: 位置の誤差 [m] (既定 4。5 以上で速度の外れ値も混ぜる)、`t`: 種別 (その停車駅だけに止まる)

## 出典

- 国土数値情報 (鉄道データ N02-24) 国土交通省
- © OpenStreetMap contributors (ODbL)
