# -*- coding: utf-8 -*-
"""
train-meter 配信用データ作成スクリプト

入力 (fetch_raw.py で取得):
  raw/N02-24/**/N02-24_RailroadSection.geojson   国土数値情報 鉄道 (路線)
  raw/N02-24/**/N02-24_Station.geojson           国土数値情報 鉄道 (駅)
  raw/osm_tunnels/tunnel_*.json                  OSM 鉄道トンネル (Overpass)
出力:
  docs/data/rail.json                            アプリが読むデータ

処理の流れ
  1. 路線ごとに区間をつなぎ、分岐点ではまっすぐ続く方をつないで「パス」(一本の折れ線) を作る
  2. 折れ線を間引く (Douglas-Peucker, 許容 3 m)
  3. 駅をパス上に投影し、起点からの距離 [m] を持たせる
  4. OSM のトンネルをパスに重ね、パス上の区間 [開始 m, 終了 m] として持たせる

Spyder で実行する想定。
"""
import glob
import json
import math
import os
from collections import defaultdict

import numpy as np
from scipy.spatial import cKDTree

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
RAW = os.path.join(ROOT, "raw")
OUT = os.path.join(ROOT, "docs", "data", "rail.json")

SIMPLIFY_TOL_M = 3.0      # 折れ線の間引き許容誤差
SAMPLE_STEP_M = 10.0      # トンネル照合用にパスを刻む間隔
TUNNEL_MATCH_M = 30.0     # トンネルとパスを同一とみなす距離
TUNNEL_COVER = 0.6        # トンネル点のうちこの割合以上がパス近傍なら採用
STATION_MATCH_M = 150.0   # 駅をパスに載せる最大距離
COORD_SCALE = 1e5         # 座標を整数化する倍率 (約 1 m)

COMPANY_SHORT = {
    "北海道旅客鉄道": "JR北海道",
    "東日本旅客鉄道": "JR東日本",
    "東海旅客鉄道": "JR東海",
    "西日本旅客鉄道": "JR西日本",
    "四国旅客鉄道": "JR四国",
    "九州旅客鉄道": "JR九州",
    "日本貨物鉄道": "JR貨物",
}

R_LAT = 110574.0   # 緯度 1 度あたり [m]
R_LON = 111320.0   # 経度 1 度あたり (赤道) [m]


# ---------------------------------------------------------------- 幾何
def to_xy(lon, lat):
    """経緯度を局所的な平面座標 [m] に (近傍の距離計算用)"""
    lat = np.asarray(lat, dtype=float)
    lon = np.asarray(lon, dtype=float)
    return np.column_stack([lon * R_LON * np.cos(np.radians(lat)), lat * R_LAT])


def seg_lengths(coords):
    """折れ線 (N,2: lon,lat) の各区間長 [m]。アプリ側と同じ式"""
    c = np.asarray(coords)
    lat_m = np.radians((c[1:, 1] + c[:-1, 1]) / 2)
    dx = (c[1:, 0] - c[:-1, 0]) * R_LON * np.cos(lat_m)
    dy = (c[1:, 1] - c[:-1, 1]) * R_LAT
    return np.hypot(dx, dy)


def cumdist(coords):
    return np.concatenate([[0.0], np.cumsum(seg_lengths(coords))])


def simplify(coords, tol):
    """Douglas-Peucker (平面近似)"""
    c = np.asarray(coords)
    if len(c) <= 2:
        return c
    lat0 = np.radians(c[:, 1].mean())
    xy = np.column_stack([c[:, 0] * R_LON * math.cos(lat0), c[:, 1] * R_LAT])
    keep = np.zeros(len(c), dtype=bool)
    keep[0] = keep[-1] = True
    stack = [(0, len(c) - 1)]
    while stack:
        i, j = stack.pop()
        if j <= i + 1:
            continue
        a, b = xy[i], xy[j]
        ab = b - a
        L2 = ab @ ab
        p = xy[i + 1:j] - a
        if L2 == 0:
            d = np.hypot(p[:, 0], p[:, 1])
        else:
            t = np.clip((p @ ab) / L2, 0, 1)
            d = np.hypot(*(p - np.outer(t, ab)).T)
        k = int(np.argmax(d))
        if d[k] > tol:
            m = i + 1 + k
            keep[m] = True
            stack.append((i, m))
            stack.append((m, j))
    return c[keep]


def resample(coords, step):
    """折れ線を step [m] 間隔の点列にする。(点の経緯度, 起点からの距離) を返す"""
    c = np.asarray(coords)
    cd = cumdist(c)
    total = cd[-1]
    if total == 0:
        return c[:1], np.array([0.0])
    s = np.arange(0, total, step)
    s = np.append(s, total)
    lon = np.interp(s, cd, c[:, 0])
    lat = np.interp(s, cd, c[:, 1])
    return np.column_stack([lon, lat]), s


# ---------------------------------------------------------------- 入力
def find_one(pattern):
    hits = glob.glob(os.path.join(RAW, "**", pattern), recursive=True)
    if not hits:
        raise FileNotFoundError(pattern)
    return hits[0]


def load_lines():
    path = find_one("*RailroadSection*.geojson")
    with open(path, encoding="utf-8") as f:
        gj = json.load(f)
    segs = defaultdict(list)   # (路線名, 会社) -> [coords]
    meta = {}
    for ft in gj["features"]:
        p = ft["properties"]
        key = (p["N02_003"], p["N02_004"])
        meta[key] = (p.get("N02_001"), p.get("N02_002"))
        g = ft["geometry"]
        parts = g["coordinates"] if g["type"] == "MultiLineString" else [g["coordinates"]]
        for part in parts:
            if len(part) >= 2:
                segs[key].append(np.asarray(part, dtype=float))
    print(f"路線 {len(segs)} 本, 区間 {sum(len(v) for v in segs.values())} 個")
    return segs, meta


def load_stations():
    path = find_one("*Station*.geojson")
    with open(path, encoding="utf-8") as f:
        gj = json.load(f)
    st = defaultdict(list)     # (路線名, 会社) -> [(駅名, lon, lat)]
    for ft in gj["features"]:
        p = ft["properties"]
        c = np.asarray(ft["geometry"]["coordinates"], dtype=float)
        if c.ndim == 3:
            c = np.concatenate(c)
        # 駅の線分の中点
        cd = cumdist(c)
        half = cd[-1] / 2
        lon = float(np.interp(half, cd, c[:, 0]))
        lat = float(np.interp(half, cd, c[:, 1]))
        st[(p["N02_003"], p["N02_004"])].append((p["N02_005"], lon, lat))
    print(f"駅 {sum(len(v) for v in st.values())} 件")
    return st


def load_tunnels():
    ways = {}
    for path in glob.glob(os.path.join(RAW, "osm_tunnels", "tunnel_*.json")):
        with open(path, encoding="utf-8") as f:
            js = json.load(f)
        for el in js.get("elements", []):
            if el.get("type") != "way" or "geometry" not in el:
                continue
            ways[el["id"]] = el   # タイル境界で重複するので id で一意化
    print(f"OSM トンネル way {len(ways)} 本")
    return list(ways.values())


# ---------------------------------------------------------------- 1. パス作成
def nk(pt):
    return (round(pt[0], 6), round(pt[1], 6))


def contract(seg_list):
    """分岐のない節点 (次数 2) を挟んだ区間をつなぎ、分岐点どうしを結ぶ線にする"""
    node_ends = defaultdict(list)
    for i, c in enumerate(seg_list):
        node_ends[nk(c[0])].append((i, 0))
        node_ends[nk(c[-1])].append((i, 1))
    deg = {k: len(v) for k, v in node_ends.items()}
    visited = set()
    out = []

    def walk(i, entry):
        parts = []
        while True:
            visited.add(i)
            c = seg_list[i] if entry == 0 else seg_list[i][::-1]
            parts.append(c if not parts else c[1:])
            node = nk(c[-1])
            if deg[node] != 2:
                break
            nxt = [e for e in node_ends[node] if e[0] != i or e[1] != 1 - entry]
            if not nxt or nxt[0][0] in visited:
                break
            i, entry = nxt[0]
        return np.concatenate(parts)

    for i, c in enumerate(seg_list):
        if i in visited:
            continue
        if deg[nk(c[0])] != 2:
            out.append(walk(i, 0))
        elif deg[nk(c[-1])] != 2:
            out.append(walk(i, 1))
    for i in range(len(seg_list)):      # 分岐の無い環状線
        if i not in visited:
            out.append(walk(i, 0))
    return out


def remove_parallel(seg_list):
    """同じ 2 つの分岐点を結ぶ線が複数ある (上下線が分かれた区間など) ときは短い方だけ残す"""
    for _ in range(20):
        chains = contract(seg_list)
        groups = defaultdict(list)
        for c in chains:
            a, b = nk(c[0]), nk(c[-1])
            groups[(min(a, b), max(a, b))].append(c)
        kept = []
        changed = False
        for (a, b), cs in groups.items():
            if a == b and len(chains) > 1 and all(cumdist(c)[-1] < 5000 for c in cs):
                # 分岐点から出て戻ってくる短い輪 (折返し線など) は捨てる
                changed = True
                continue
            if len(cs) > 1:
                cs = [min(cs, key=lambda c: cumdist(c)[-1])]
                changed = True
            kept.extend(cs)
        seg_list = kept
        if not changed:
            break
    return seg_list


def build_paths(seg_list):
    """区間の集合を、分岐点でまっすぐ続く方をつないだ折れ線の集合にする"""
    seg_list = remove_parallel(seg_list)

    # 各区間の両端 (区間番号, 端 0/1)
    node_ends = defaultdict(list)
    for i, c in enumerate(seg_list):
        node_ends[nk(c[0])].append((i, 0))
        node_ends[nk(c[-1])].append((i, 1))

    seg_len = [cumdist(c)[-1] for c in seg_list]

    def out_dir(i, end):
        """端から区間の内側へ約 150 m 進んだ点への方向 (単位ベクトル)"""
        c = seg_list[i] if end == 0 else seg_list[i][::-1]
        cd = cumdist(c)
        k = min(len(c) - 1, max(1, int(np.searchsorted(cd, 150.0))))
        a, b = c[0], c[k]
        lat = math.radians(a[1])
        v = np.array([(b[0] - a[0]) * math.cos(lat), b[1] - a[1]])
        n = np.hypot(*v)
        return v / n if n > 0 else v

    # 節点ごとに、まっすぐ続く端どうしを対にする。
    # 費用 = 曲がり角 [度] + 1 km 未満の短い線には 40 (引込線より本線どうしを優先)
    partner = {}
    for node, ends in node_ends.items():
        if len(ends) < 2:
            continue
        dirs = [out_dir(i, e) for i, e in ends]
        cand = []
        for a in range(len(ends)):
            for b in range(a + 1, len(ends)):
                if ends[a][0] == ends[b][0]:
                    continue
                cos = float(np.clip(dirs[a] @ dirs[b], -1, 1))
                turn = 180 - math.degrees(math.acos(cos))   # まっすぐなら 0
                if turn > 60:
                    continue
                cost = turn + 40 * (seg_len[ends[a][0]] < 1000) + 40 * (seg_len[ends[b][0]] < 1000)
                cand.append((cost, a, b))
        cand.sort()
        used = set()
        for cost, a, b in cand:
            if a in used or b in used:
                continue
            used.update((a, b))
            partner[ends[a]] = ends[b]
            partner[ends[b]] = ends[a]

    # つないで折れ線にする
    visited = set()
    paths = []
    order = sorted(range(len(seg_list)),
                   key=lambda i: ((i, 0) in partner) + ((i, 1) in partner))
    for start in order:
        if start in visited:
            continue
        # 片方の端が自由な方から辿り始める (環状線なら任意)
        chain = []
        i, entry = start, 0
        if (start, 0) in partner and (start, 1) not in partner:
            entry = 1
        # 逆向きに戻れるだけ戻る
        cur = (start, entry)
        seen = {start}
        while cur in partner:
            j, e = partner[cur]
            if j in seen:
                break
            seen.add(j)
            cur = (j, 1 - e)
        i, entry = cur
        loop = False
        while True:
            if i in visited:
                loop = True
                break
            visited.add(i)
            c = seg_list[i]
            c = c if entry == 0 else c[::-1]
            chain.append(c if not chain else c[1:])
            exit_end = (i, 1 - entry)
            if exit_end not in partner:
                break
            i, entry = partner[exit_end]
        coords = np.concatenate(chain)
        loop = nk(coords[0]) == nk(coords[-1]) and cumdist(coords)[-1] > 5000
        paths.append((coords, loop))
    return paths


# ---------------------------------------------------------------- メイン
def short_company(name):
    return COMPANY_SHORT.get(name, name)


def main():
    segs, meta = load_lines()
    stations = load_stations()
    tunnels = load_tunnels()

    lines = []          # [{n, c, k1, k2}]
    paths = []          # dict
    for key in sorted(segs):
        name, comp = key
        li = len(lines)
        k1, k2 = meta[key]
        lines.append({"n": name, "c": short_company(comp), "k1": k1, "k2": k2})
        for coords, loop in build_paths(segs[key]):
            sc = simplify(coords, SIMPLIFY_TOL_M)
            # 整数化してから距離を計算 (アプリ側と一致させる)
            ic = np.round(sc * COORD_SCALE).astype(np.int64)
            dedup = np.concatenate([[True], np.any(np.diff(ic, axis=0) != 0, axis=1)])
            ic = ic[dedup]
            if len(ic) < 2:
                continue
            fc = ic / COORD_SCALE
            paths.append({"line": li, "ic": ic, "fc": fc, "cd": cumdist(fc),
                          "loop": bool(loop), "st": [], "tn": []})
    print(f"パス {len(paths)} 本, 頂点 {sum(len(p['ic']) for p in paths)} 個")

    # ---- 3. 駅
    by_line = defaultdict(list)
    for pi, p in enumerate(paths):
        by_line[p["line"]].append(pi)
    line_index = {key: i for i, key in enumerate(sorted(segs))}
    n_unplaced = 0
    for key, sts in stations.items():
        li = line_index.get(key)
        if li is None:
            n_unplaced += len(sts)
            continue
        for sname, lon, lat in sts:
            placed = False
            for pi in by_line[li]:
                p = paths[pi]
                s, d = project(p["fc"], p["cd"], lon, lat)
                if d <= STATION_MATCH_M:
                    p["st"].append((sname, s))
                    placed = True
            n_unplaced += not placed
    for p in paths:
        p["st"].sort(key=lambda x: x[1])
        ded = []
        for nm, s in p["st"]:
            if ded and ded[-1][0] == nm and s - ded[-1][1] < 500:
                continue
            ded.append((nm, s))
        p["st"] = ded
    print(f"駅: パスに載らなかったもの {n_unplaced} 件")

    # ---- 4. トンネル
    samp_xy, samp_path, samp_s = [], [], []
    for pi, p in enumerate(paths):
        pts, s = resample(p["fc"], SAMPLE_STEP_M)
        samp_xy.append(to_xy(pts[:, 0], pts[:, 1]))
        samp_path.append(np.full(len(s), pi))
        samp_s.append(s)
    samp_xy = np.concatenate(samp_xy)
    samp_path = np.concatenate(samp_path)
    samp_s = np.concatenate(samp_s)
    tree = cKDTree(samp_xy)
    print(f"照合用サンプル点 {len(samp_s)} 個")

    n_used = 0
    for w in tunnels:
        g = np.array([[q["lon"], q["lat"]] for q in w["geometry"]], dtype=float)
        if len(g) < 2:
            continue
        tags = w.get("tags", {})
        pts, ts = resample(g, SAMPLE_STEP_M)
        tlen = float(ts[-1])
        txy = to_xy(pts[:, 0], pts[:, 1])
        hits = tree.query_ball_point(txy, TUNNEL_MATCH_M)
        per_path = defaultdict(list)
        for k, h in enumerate(hits):
            seen = {}
            for idx in h:
                pi = samp_path[idx]
                d = np.hypot(*(samp_xy[idx] - txy[k]))
                if pi not in seen or d < seen[pi][0]:
                    seen[pi] = (d, samp_s[idx])
            for pi, (d, s) in seen.items():
                per_path[pi].append(s)
        name = tunnel_name(tags)
        used = False
        for pi, ss in per_path.items():
            if len(ss) < TUNNEL_COVER * len(pts):
                continue
            a, b = min(ss), max(ss)
            if b - a > 1.5 * tlen + 50:      # 環状などで変な所に当たった
                continue
            if b - a < 1:
                continue
            paths[pi]["tn"].append([a, b, name])
            used = True
        n_used += used
    print(f"トンネル: パスに載ったもの {n_used} / {len(tunnels)} 本")

    for p in paths:
        p["tn"] = merge_intervals(p["tn"])

    # ---- 出力
    out_paths = []
    for p in paths:
        ic = p["ic"]
        d = np.diff(ic, axis=0)
        flat = [int(ic[0, 0]), int(ic[0, 1])] + d.ravel().astype(int).tolist()
        out_paths.append({
            "l": p["line"],
            "c": flat,
            **({"o": 1} if p["loop"] else {}),
            "s": [[nm, round(s, 1)] for nm, s in p["st"]],
            "t": [[round(a, 1), round(b, 1)] + ([nm] if nm else []) for a, b, nm in p["tn"]],
        })
    out = {
        "v": 1,
        "scale": COORD_SCALE,
        "attribution": "国土数値情報 (鉄道データ N02-24) 国土交通省 / © OpenStreetMap contributors (ODbL)",
        "lines": [{"n": l["n"], "c": l["c"]} for l in lines],
        "paths": out_paths,
    }
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    with open(OUT, "w", encoding="utf-8") as f:
        json.dump(out, f, ensure_ascii=False, separators=(",", ":"))
    n_tn = sum(len(p["t"]) for p in out_paths)
    tn_len = sum(b - a for p in paths for a, b, _ in p["tn"]) / 1000
    print(f"出力: {OUT} ({os.path.getsize(OUT) / 1e6:.1f} MB)")
    print(f"  路線 {len(lines)}, パス {len(out_paths)}, 駅 {sum(len(p['s']) for p in out_paths)}, "
          f"トンネル区間 {n_tn} (計 {tn_len:.0f} km)")


def tunnel_name(tags):
    for k in ("tunnel:name", "tunnel_name"):
        if tags.get(k):
            return tags[k]
    nm = tags.get("name", "")
    if any(w in nm for w in ("トンネル", "隧道", "ずい道", "隧")):
        return nm
    return None


def merge_intervals(iv, gap=20.0):
    iv = sorted(iv, key=lambda x: x[0])
    out = []
    for a, b, nm in iv:
        if out and a <= out[-1][1] + gap:
            out[-1][1] = max(out[-1][1], b)
            if not out[-1][2] and nm:
                out[-1][2] = nm
        else:
            out.append([a, b, nm])
    return out


def project(fc, cd, lon, lat):
    """点を折れ線に投影し (起点からの距離, 垂線の長さ) [m] を返す"""
    lat0 = math.radians(lat)
    cx = R_LON * math.cos(lat0)
    x = (fc[:, 0] - lon) * cx
    y = (fc[:, 1] - lat) * R_LAT
    ax, ay, bx, by = x[:-1], y[:-1], x[1:], y[1:]
    dx, dy = bx - ax, by - ay
    L2 = dx * dx + dy * dy
    t = np.where(L2 > 0, -(ax * dx + ay * dy) / np.where(L2 > 0, L2, 1), 0)
    t = np.clip(t, 0, 1)
    px, py = ax + t * dx, ay + t * dy
    d = np.hypot(px, py)
    k = int(np.argmin(d))
    seglen = cd[k + 1] - cd[k]
    return float(cd[k] + t[k] * seglen), float(d[k])


if __name__ == "__main__":
    main()
