# -*- coding: utf-8 -*-
"""
運転系統 (京浜東北線・埼京線・JR神戸線 新快速 など) を OSM の route から作り、種別データにする

入力:
  raw/osm_routes/route_*.json      OSM の route relation と停車駅 (fetch_raw.py で取得)
  raw/N02-24/**/N02-24_Station.geojson
  tools/types_manual.json          手作りの種別と停車駅
  tools/route_joins.json           直通の対応表 (OSM では別の route になっている直通運転をつなぐ)
  tools/routes_manual.json         手作りの系統 (OSM に無いもの)。停車駅の並びを駅名で書く
出力:
  docs/data/types.json             路線 (会社 路線名) ごとの種別と停車駅。
                                   手作りがある路線は手作りを残し、OSM のうちほかの路線へ乗り入れる系統だけを後ろに足す
  docs/data/routes.json            系統ごとの停車駅の並び [[路線, 駅名], ...] (正式路線をまたいで次駅を出すため)

まとめ方
  - route 名から先頭の「JR」、行き先 (…)、上り/下り などを外したものを系統名とする
  - 末尾が種別 (新快速・快速・各駅停車 など) なら、系統名と種別に分ける。
    1 つの系統に種別が複数あるときだけ「系統名 種別」、1 つなら系統名だけを種別の名前にする
  - 停車駅は、route の停車駅の位置から 300 m 以内の国土数値情報の駅に当てはめる。
    同じ場所に複数路線の駅があるとき (東京駅など) は、路線の乗り換えが少なくなる並びを選ぶ

Spyder で実行する想定。
"""
import glob
import json
import os
import re
from collections import defaultdict

import numpy as np
from scipy.spatial import cKDTree

import build_data as bd

ROOT = bd.ROOT
ROUTE_DIR = os.path.join(bd.RAW, "osm_routes")
MANUAL = os.path.join(ROOT, "tools", "types_manual.json")
JOINS = os.path.join(ROOT, "tools", "route_joins.json")
ROUTES_MANUAL = os.path.join(ROOT, "tools", "routes_manual.json")
OUT_TYPES = os.path.join(ROOT, "docs", "data", "types.json")
OUT_ROUTES = os.path.join(ROOT, "docs", "data", "routes.json")

MATCH_M = 300.0
TYPE_WORDS = ["快速急行", "通勤特急", "通勤快速", "特別快速", "区間快速", "通勤急行", "区間急行",
              "各駅停車", "新快速", "特急", "急行", "準急", "快速", "普通", "各停"]
DIR_WORDS = r"(上り|下り|北行|南行|東行|西行|内回り|外回り|上り線|下り線)"


def normalize(name):
    """route 名 → (系統名, 種別 or None)"""
    n = name.strip().replace("　", " ")
    n = re.sub(r"^(JR|ＪＲ)\s*", "", n)
    n = re.split(r"\s*[\(（\[［]", n)[0]                 # 行き先などの括弧以降
    n = re.sub(r"\s*[:：].*$", "", n)
    base = re.split(r"\s*\S+\s*(?:→|=>|->|⇒|＝＞)\s*\S+.*$", n)[0]   # 「A → B」(行き先だけの名前は空になり使わない)
    base = re.sub(r"\s*" + DIR_WORDS + r"$", "", base).strip()
    base = base.strip(",、・ ")
    base = re.sub(r"(?<=線)[A-Z]{1,3}$", "", base)       # 路線記号 (中央線JC など)
    typ = None
    for w in TYPE_WORDS:
        if base.endswith(w) and len(base) > len(w):
            typ = "各駅停車" if w == "各停" else w
            base = base[: -len(w)].strip()
            break
    return base, typ


def load_routes():
    rels, nodes, ways = {}, {}, {}
    for path in glob.glob(os.path.join(ROUTE_DIR, "route_*.json")):
        with open(path, encoding="utf-8") as f:
            js = json.load(f)
        for el in js["elements"]:
            if el["type"] == "relation":
                rels[el["id"]] = el
            elif el["type"] == "node":
                nodes[el["id"]] = el
            elif el["type"] == "way" and "center" in el:
                ways[el["id"]] = el
    print(f"route {len(rels)} 件, 停車駅の点 {len(nodes)} + {len(ways)}")
    return rels, nodes, ways


def stop_points(rel, nodes, ways):
    """route の停車駅の位置を順に [(lon, lat)]"""
    pts = []
    mem = rel.get("members", [])
    stops = [m for m in mem if m["role"].startswith("stop") and m["type"] == "node"]
    if len(stops) < 2:
        stops = [m for m in mem if m["role"].startswith("platform")]
    for m in stops:
        if m["type"] == "node" and m["ref"] in nodes:
            pts.append((nodes[m["ref"]]["lon"], nodes[m["ref"]]["lat"]))
        elif m["type"] == "way" and m["ref"] in ways:
            c = ways[m["ref"]]["center"]
            pts.append((c["lon"], c["lat"]))
    return pts


def main():
    # 国土数値情報の駅 (路線ラベル付き)
    st_raw = bd.load_stations()
    recs = []
    for (lname, comp), sts in st_raw.items():
        label = f"{bd.short_company(comp)} {lname}"
        for sname, lon, lat, *_ in sts:
            recs.append((label, sname, lon, lat))
    xy = bd.to_xy([r[2] for r in recs], [r[3] for r in recs])
    tree = cKDTree(xy)
    line_all = defaultdict(set)
    for label, sname, _, _ in recs:
        line_all[label].add(sname)

    rels, nodes, ways = load_routes()

    groups = defaultdict(list)    # 系統名 -> [(種別, [(路線, 駅名)...]), ...]
    n_skip = 0
    for rel in rels.values():
        tags = rel.get("tags", {})
        name = tags.get("name:ja") or tags.get("name")
        if not name or "貨物" in name or tags.get("disused") or tags.get("abandoned"):
            n_skip += 1
            continue
        pts = stop_points(rel, nodes, ways)
        cand = []
        for lon, lat in pts:
            q = bd.to_xy([lon], [lat])[0]
            hit = tree.query_ball_point(q, MATCH_M)
            best = {}
            for i in hit:
                d = float(np.hypot(*(xy[i] - q)))
                lab = recs[i][0]
                if lab not in best or d < best[lab][1]:
                    best[lab] = (recs[i][1], d)
            if best:
                cand.append([(lab, nm, d) for lab, (nm, d) in best.items()])
        seq = viterbi(cand)
        # 同じ駅が続くもの (ホームと停止位置が両方入っているなど) を除く
        ded = []
        for e in seq:
            if not ded or ded[-1] != e:
                ded.append(e)
        if len(ded) < 2:
            n_skip += 1
            continue
        base, typ = normalize(name)
        if not base:
            n_skip += 1
            continue
        groups[base].append((typ, ded))
    print(f"系統 {len(groups)} 個 (使えなかった route {n_skip} 件)")

    # 系統名 (+種別) ごとに、各路線の停車駅と、停車駅の並び (最も多くの路線・駅を通る route のもの)
    labels = {}    # 種別名 -> (路線ごとの停車駅, 並び)
    for base, items in groups.items():
        typs = {t for t, _ in items}
        for typ in sorted(typs, key=lambda x: (x is not None, x or "")):
            label = base if len(typs) == 1 or typ is None else f"{base} {typ}"
            seqs = [s for t, s in items if t == typ]
            per_line = defaultdict(set)
            for s in seqs:
                for lab, nm in s:
                    per_line[lab].add(nm)
            longest = max(seqs, key=lambda s: (len({lab for lab, _ in s}), len(s)))
            labels[label] = (per_line, [tuple(x) for x in longest])

    # 手作りの系統 (OSM に無いもの。湘南新宿ラインの特別快速など)
    with open(ROUTES_MANUAL, encoding="utf-8") as f:
        rman = {k: v for k, v in json.load(f).items() if not k.startswith("_")}
    for label, names in rman.items():
        seq = resolve_names(names, recs, xy)
        if len(seq) < 2:
            print(f"  手作りの系統 {label}: 駅が見つからない")
            continue
        per_line = defaultdict(set)
        for lab, nm in seq:
            per_line[lab].add(nm)
        labels[label] = (per_line, seq)
        found = {nm for _, nm in seq}
        miss = [n for n in names if kana_key(n) not in {kana_key(x) for x in found}]
        print(f"  手作りの系統 {label}: {len(names)} 駅 → 路線 {sorted(per_line)}" + (f" 見つからない駅 {miss}" if miss else ""))

    # 直通の対応表 (OSM では別の route になっている直通運転をつなぐ)
    with open(JOINS, encoding="utf-8") as f:
        joins = {k: v for k, v in json.load(f).items() if not k.startswith("_")}
    for joined, parts in joins.items():
        if not all(p in labels for p in parts):
            print(f"  直通 {joined}: 系統が見つからない {[p for p in parts if p not in labels]}")
            continue
        per_line = defaultdict(set)
        seq = list(labels[parts[0]][1])
        for p in parts:
            for lab, names in labels[p][0].items():
                per_line[lab] |= names
        for p in parts[1:]:
            seq = join_seq(seq, list(labels[p][1]))
        for p in parts:
            del labels[p]
        labels[joined] = (per_line, seq)
        print(f"  直通 {joined}: {seq[0][1]} 〜 {seq[-1][1]} ({len(seq)} 駅)")

    with open(MANUAL, encoding="utf-8") as f:
        manual = json.load(f)
    gen = defaultdict(lambda: {"order": [], "types": {}})
    routes = {}
    for label, (per_line, seq) in labels.items():
        routes[label] = [[lab, nm] for lab, nm in seq]
        multi = len([lab for lab, names in per_line.items() if len(names) >= 2]) >= 2
        for lab, names in per_line.items():
            # 手作りの種別がある路線には、ほかの路線へ乗り入れる系統だけを足す
            if lab in manual and not multi:
                continue
            if len(names) < 2:
                continue
            g = gen[lab]
            g["order"].append(label)
            g["types"][label] = "all" if names >= line_all[lab] else sorted(names)

    # 種別の並び: 特急は後ろ、ほかは止まる駅が多い順 (各駅停車が先)。どれが特急かもアプリに渡す
    for lab, g in gen.items():
        def nstop(ty):
            v = g["types"][ty]
            return len(line_all[lab]) if v == "all" else len(v)
        g["order"].sort(key=lambda ty: (is_express(ty), -nstop(ty), ty))
        ex = [ty for ty in g["order"] if is_express(ty)]
        if ex:
            g["express"] = ex
        # 駅名の並びを路線の駅の並び (国土数値情報) に合わせる必要はない (アプリは含まれるかだけ見る)

    out = dict(manual)
    out["_説明"] = (manual.get("_説明", "") + " 手作りの種別が無い路線は build_routes.py が OSM の運転系統 (route) から作り、"
                   "手作りの種別がある路線には OSM のうちほかの路線へ乗り入れる系統だけを後ろに足している。")
    replaced = [lab for lab in gen if lab in manual]
    for lab, g in gen.items():
        if lab in manual:
            m = manual[lab]
            add = [ty for ty in g["order"] if ty not in m["types"]]
            out[lab] = {**m, "order": m["order"] + add, "types": {**m["types"], **{ty: g["types"][ty] for ty in add}}}
            ex = [ty for ty in add if is_express(ty)]
            if ex:
                out[lab]["express"] = ex
        else:
            out[lab] = g
    with open(OUT_TYPES, "w", encoding="utf-8") as f:
        json.dump(out, f, ensure_ascii=False, indent=1)
    with open(OUT_ROUTES, "w", encoding="utf-8") as f:
        json.dump(routes, f, ensure_ascii=False, separators=(",", ":"))
    print(f"出力: 種別のある路線 {len(out) - 1} (OSM {len(gen)}, 手作りに乗り入れ系統を追加 {len(replaced)}: {replaced})")
    print(f"  {OUT_TYPES} ({os.path.getsize(OUT_TYPES) / 1e3:.0f} kB), {OUT_ROUTES} ({os.path.getsize(OUT_ROUTES) / 1e3:.0f} kB)")


def kana_key(name):
    """駅名の比較用 (「ヶ」「ケ」「が」の書き分けを区別しない)"""
    return name.replace("ヶ", "ケ").replace("ケ", "ケ")


def resolve_names(names, recs, xy):
    """駅名の並び → [(路線, 駅名)]。同じ駅名の駅が各地にあるので、隣の駅との距離が短く、
    路線の乗り換えが少ない並びを選ぶ。乗り換え駅は両方の路線の駅として入れる"""
    by_name = defaultdict(list)
    for i, r in enumerate(recs):
        by_name[kana_key(r[1])].append(i)
    cand = [by_name.get(kana_key(n), []) for n in names]
    cand = [c for c in cand if c]
    if not cand:
        return []
    INF = 1e18
    cost = [{i: 0.0 for i in cand[0]}]
    back = [{}]
    for k in range(1, len(cand)):
        cur, bk = {}, {}
        for j in cand[k]:
            best, arg = INF, None
            for i, pc in cost[-1].items():
                d_km = float(np.hypot(*(xy[i] - xy[j]))) / 1000
                v = pc + (0 if recs[i][0] == recs[j][0] else 1.0) + d_km / 3
                if v < best:
                    best, arg = v, i
            cur[j], bk[j] = best, arg
        cost.append(cur)
        back.append(bk)
    j = min(cost[-1], key=cost[-1].get)
    path = [j]
    for k in range(len(cand) - 1, 0, -1):
        j = back[k][j]
        path.append(j)
    path.reverse()
    seq = []
    for k, i in enumerate(path):
        lab, nm = recs[i][0], recs[i][1]
        if k > 0 and recs[path[k - 1]][0] != lab:
            # 乗り換え: 前の駅が新しい路線にもあれば (同じ場所に) 新しい路線の駅としても入れる
            p = path[k - 1]
            for q in by_name[kana_key(recs[p][1])]:
                if recs[q][0] == lab and np.hypot(*(xy[q] - xy[p])) < MATCH_M:
                    seq.append((lab, recs[q][1]))
                    break
        seq.append((lab, nm))
        if k + 1 < len(path) and recs[path[k + 1]][0] != lab:
            n = path[k + 1]
            for q in by_name[kana_key(recs[n][1])]:
                if recs[q][0] == lab and np.hypot(*(xy[q] - xy[n])) < MATCH_M:
                    seq.append((lab, recs[q][1]))
                    break
    out = []
    for e in seq:
        if not out or out[-1] != e:
            out.append(e)
    return out


def is_express(label):
    """特急らしい系統か。OSM の route には特急を示すタグがほとんど無いので名前で判断する:
    「特急」を含むか、「線」「ライン」「Line」を含まず種別名 (急行・快速 など) でも終わらない名前
    (ひたち・あずさ・踊り子・つばさ列車・成田エクスプレス など)"""
    if "特急" in label:
        return True
    if any(w in label for w in ("線", "ライン", "Line", "line")):
        return False
    return not any(label.endswith(w) for w in TYPE_WORDS)


def join_seq(a, b):
    """2 つの系統の停車駅の並びを、共通の駅 (端) でつなぐ。向きはつながるように合わせる"""
    for aa in (a, a[::-1]):
        for bb in (b, b[::-1]):
            if aa[-1][1] == bb[0][1]:
                return aa + bb
    for aa in (a, a[::-1]):     # 端どうしが同じ駅名でなければ、端の駅名が相手のどこかにあるもの
        for bb in (b, b[::-1]):
            names = [nm for _, nm in bb]
            if aa[-1][1] in names:
                return aa + bb[names.index(aa[-1][1]):]
    print(f"  つなげない: {a[0][1]}〜{a[-1][1]} と {b[0][1]}〜{b[-1][1]}")
    return a + b


def viterbi(cand):
    """停車駅ごとの候補 [(路線, 駅名, 距離)] から、路線の乗り換えが少ない並びを選ぶ。
    乗り換え地点の駅 (東京など) は両方の路線の駅として入れる"""
    if not cand:
        return []
    INF = 1e18
    cost = [{c[0]: (c[2] / MATCH_M) ** 2 for c in cand[0]}]
    back = [{}]
    for i in range(1, len(cand)):
        cur, bk = {}, {}
        for lab, _, d in cand[i]:
            best, arg = INF, None
            for plab, pc in cost[-1].items():
                v = pc + (0 if plab == lab else 1.0)
                if v < best:
                    best, arg = v, plab
            cur[lab] = best + (d / MATCH_M) ** 2
            bk[lab] = arg
        cost.append(cur)
        back.append(bk)
    lab = min(cost[-1], key=cost[-1].get)
    path = [lab]
    for i in range(len(cand) - 1, 0, -1):
        lab = back[i][lab]
        path.append(lab)
    path.reverse()
    name_of = [{c[0]: c[1] for c in cs} for cs in cand]
    seq = []
    for i, lab in enumerate(path):
        if i > 0 and path[i - 1] != lab:
            # 乗り換え: 前の駅が新しい路線にもあれば新しい路線の駅としても入れる
            if lab in name_of[i - 1]:
                seq.append((lab, name_of[i - 1][lab]))
        seq.append((lab, name_of[i][lab]))
        if i + 1 < len(path) and path[i + 1] != lab and lab in name_of[i + 1]:
            seq.append((lab, name_of[i + 1][lab]))   # 次の駅が今の路線にもあれば今の路線の駅としても入れる
    return seq


if __name__ == "__main__":
    main()
