# -*- coding: utf-8 -*-
"""
train-meter 元データ取得スクリプト

1. 国土数値情報 鉄道データ (N02-24) の zip を取得して展開
2. OpenStreetMap の鉄道トンネル (tunnel=*) を Overpass API から日本を分割して取得
3. OpenStreetMap の運転系統 (route relation) と停車駅を同じく分割して取得

Spyder で実行する想定。取得済みのファイルはスキップするので、途中で止めても再実行で続きから取れる。
出力先: <リポジトリ>/raw/  (git 管理外)
"""
import json
import os
import time
import urllib.error
import urllib.parse
import urllib.request
import zipfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
RAW = os.path.join(ROOT, "raw")
OSM_DIR = os.path.join(RAW, "osm_tunnels")

N02_URL = "https://nlftp.mlit.go.jp/ksj/gml/data/N02/N02-24/N02-24_GML.zip"
N02_ZIP = os.path.join(RAW, "N02-24_GML.zip")
N02_DIR = os.path.join(RAW, "N02-24")

# 本家が混んでいるときは次のサーバーを試す (どれも同じ OSM データ)
OVERPASS_URLS = [
    "https://overpass-api.de/api/interpreter",
    "https://overpass.private.coffee/api/interpreter",
    "https://maps.mail.ru/osm/tools/overpass/api/interpreter",
]
USER_AGENT = "train-meter-build/0.1"

# 鉄道のある 4度 x 4度 のタイル (南端の緯度, 西端の経度)。海だけのタイルは除く
TILES = [
    (24, 122), (24, 126),
    (28, 130),
    (32, 126), (32, 130), (32, 134), (32, 138),
    (36, 134), (36, 138),
    (40, 138), (40, 142),
    (44, 138), (44, 142),
]

QUERY = """[out:json][timeout:300];
way["railway"~"^(rail|subway|light_rail|monorail|narrow_gauge|funicular)$"]["tunnel"]["tunnel"!="no"]({s},{w},{n},{e});
out tags geom;"""


def http_get(url, data=None, timeout=360):
    req = urllib.request.Request(url, data=data, headers={"User-Agent": USER_AGENT})
    with urllib.request.urlopen(req, timeout=timeout) as res:
        return res.read()


def fetch_n02():
    os.makedirs(RAW, exist_ok=True)
    if not os.path.exists(N02_ZIP):
        print("国土数値情報 N02-24 を取得中 ...")
        body = http_get(N02_URL)
        with open(N02_ZIP, "wb") as f:
            f.write(body)
        print(f"  {len(body) / 1e6:.1f} MB 保存")
    else:
        print("N02-24 zip は取得済み")
    if not os.path.isdir(N02_DIR):
        with zipfile.ZipFile(N02_ZIP) as z:
            z.extractall(N02_DIR)
        print("  展開しました:", N02_DIR)


def fetch_osm_tunnels():
    os.makedirs(OSM_DIR, exist_ok=True)
    for i, (s, w) in enumerate(TILES, 1):
        n, e = s + 4, w + 4
        path = os.path.join(OSM_DIR, f"tunnel_{s}_{w}.json")
        if os.path.exists(path):
            continue
        q = QUERY.format(s=s, w=w, n=n, e=e)
        data = urllib.parse.urlencode({"data": q}).encode()
        js = None
        for attempt in range(6):
            url = OVERPASS_URLS[attempt % len(OVERPASS_URLS)]
            try:
                body = http_get(url, data=data, timeout=240)
                js = json.loads(body)
                if "remark" in js and not js.get("elements"):
                    raise RuntimeError(js["remark"])   # サーバー側のタイムアウトなど
                break
            except Exception as ex:
                js = None
                print(f"  タイル {s},{w} {url} 失敗 ({ex})", flush=True)
                time.sleep(15)
        if js is None:
            raise RuntimeError(f"タイル {s},{w} を取得できませんでした")
        with open(path, "w", encoding="utf-8") as f:
            json.dump(js, f, ensure_ascii=False)
        print(f"[{i}/{len(TILES)}] {s}-{n}N {w}-{e}E: {len(js.get('elements', []))} 本", flush=True)
        time.sleep(5)  # Overpass への負荷を抑える


ROUTE_DIR = os.path.join(RAW, "osm_routes")

# 運転系統 (route relation) と、その停車駅 (直接のメンバーの node と、platform の way の中心)
ROUTE_QUERY = """[out:json][timeout:300];
rel["type"="route"]["route"~"^(train|subway|light_rail|monorail)$"]({s},{w},{n},{e})->.r;
.r out body;
node(r.r);
out;
way(r.r:"platform");
out tags center;"""


def overpass(query, label):
    data = urllib.parse.urlencode({"data": query}).encode()
    for attempt in range(9):
        url = OVERPASS_URLS[attempt % len(OVERPASS_URLS)]
        try:
            js = json.loads(http_get(url, data=data, timeout=300))
            if "remark" in js and not js.get("elements"):
                raise RuntimeError(js["remark"])   # サーバー側のタイムアウトなど
            if "remark" in js:
                raise RuntimeError("途中で打ち切られた: " + js["remark"])
            return js
        except Exception as ex:
            print(f"  {label} {url} 失敗 ({ex})", flush=True)
            time.sleep(20)
    raise RuntimeError(f"{label} を取得できませんでした")


def fetch_osm_routes():
    os.makedirs(ROUTE_DIR, exist_ok=True)
    for i, (s, w) in enumerate(TILES, 1):
        path = os.path.join(ROUTE_DIR, f"route_{s}_{w}.json")
        if os.path.exists(path):
            continue
        js = overpass(ROUTE_QUERY.format(s=s, w=w, n=s + 4, e=w + 4), f"タイル {s},{w}")
        with open(path, "w", encoding="utf-8") as f:
            json.dump(js, f, ensure_ascii=False)
        nrel = sum(1 for el in js["elements"] if el["type"] == "relation")
        print(f"[{i}/{len(TILES)}] {s}N {w}E: route {nrel} 件", flush=True)
        time.sleep(5)


if __name__ == "__main__":
    fetch_n02()
    fetch_osm_tunnels()
    fetch_osm_routes()
    print("完了")
