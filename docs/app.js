/* train-meter: 鉄道移動中の速度・路線・次駅・トンネル表示
 *
 * 位置の流れ
 *   GPS (watchPosition) か模擬走行 (?sim=路線名)
 *     → onFix: 近くの線路 (パス) に当てはめ、パス上の位置 s [m] と進行方向 dir を決める
 *     → GPS が 3 秒以上来なければ tick で直前の速度のまま s を進める (推定)
 *     → render: 速度・グラフ・次駅・トンネル・路線図を描く
 *
 * Android アプリ (android/, Capacitor) の中では、GPS をネイティブのフォアグラウンドサービス
 * (TrainLocationPlugin) から受け取るので、画面を消しても動き続け、通知に次駅を出す。
 * ブラウザではバックグラウンドで位置が取れないので、戻ったときに測位からやり直す。
 */
'use strict';

const R_LAT = 110574, R_LON = 111320;   // 1 度あたりの距離 [m] (build_data.py と同じ)
const CELL = 0.01;                      // 空間索引の格子 [度]
const DECEL = 0.7;                      // 到着予想で使う減速度 [m/s^2]
const ACCEL = 0.6;                      // 到着予想で使う加速度 [m/s^2]
const SMOOTH_HALF_S = 4;                // なめらかな速度グラフの平均幅 (前後この秒数、表示はこの分遅れる)
const GPS_LOST_MS = 3000;               // これ以上 GPS が来なければ推定に切り替え
const ACC_LIMIT = 150;                  // これより精度が悪い測位は捨てる [m]
const A_MAX = 1.5;                      // 速度の変化として許す加減速度 [m/s^2] (列車は通常 1 前後)
const ISOLATED_ACC = 20;                // 推定中に単発で届いた測位で、これより精度が悪ければ速度を使わない [m]
const STOP_V = 1.5;                     // これ未満を停止とみなす [m/s]
const STOP_HOLD_MS = 3000;              // この時間停止が続いたら駅に着いたとみなす
const STOP_MARGIN = 40;                 // 駅 (ホーム) の範囲からこの距離までは駅とみなす [m] (+ GPS 精度、最大 +100)
const STOP_RADIUS = 200;                // 範囲の無い古いデータ用: 駅の中心からの距離 [m] (+ GPS 精度)
const HIST_MAX_SEC = 1800;

const DEFAULTS = { histSec: 180, tnInside: true, tnExit: true, tnNext: true, tnSection: true };
const TN_KEYS = ['tnInside', 'tnExit', 'tnNext', 'tnSection'];

const $ = (id) => document.getElementById(id);

// ------------------------------------------------------------ 設定
let settings = loadSettings();
function loadSettings() {
  try { return { ...DEFAULTS, ...JSON.parse(localStorage.getItem('tm-settings') || '{}') }; }
  catch { return { ...DEFAULTS }; }
}
function saveSettings() { localStorage.setItem('tm-settings', JSON.stringify(settings)); }

// ------------------------------------------------------------ 時計 (模擬走行では早回し)
const params = new URLSearchParams(location.search);
const SIM = params.get('sim');
const SIM_X = Math.max(1, Number(params.get('x')) || 1);
const t0Perf = performance.now(), t0Wall = Date.now();
const now = () => t0Wall + (performance.now() - t0Perf) * (SIM ? SIM_X : 1);

// ------------------------------------------------------------ Android アプリ (Capacitor) の中か
const CAP = window.Capacitor;
const NATIVE = !!(CAP && CAP.isNativePlatform && CAP.isNativePlatform() && CAP.Plugins && CAP.Plugins.TrainLocation);
const TrainLocation = NATIVE ? CAP.Plugins.TrainLocation : null;
const BG_GAP_MS = 10000;                // ブラウザでこれ以上バックグラウンドにいたら測位からやり直す

// ------------------------------------------------------------ データ
let LINES = [], PATHS = [];
// 種別と停車駅: 路線名 → {order: [種別], short?: {種別: 略称}, types: {種別: "all" | [停車駅]}}
// data/types.json が初期値で、ブラウザで編集したもの (localStorage) がそれを路線ごとに上書きする
let BUILTIN_TYPES = {}, USER_TYPES = loadUserTypes(), TYPES = {};
function loadUserTypes() {
  try { return JSON.parse(localStorage.getItem('tm-types') || '{}') || {}; } catch { return {}; }
}
function saveUserTypes() {
  try { localStorage.setItem('tm-types', JSON.stringify(USER_TYPES)); } catch (e) { alert('保存できませんでした: ' + e.message); }
  rebuildTypes();
}
function rebuildTypes() {
  TYPES = { ...BUILTIN_TYPES, ...USER_TYPES };
  S.typeLine = null;   // 判定をやり直す
  $('typeChips').dataset.k = '';
}
const GRID = new Map();
const cellKey = (ix, iy) => ix * 100000 + iy;

async function loadData() {
  const res = await fetch('data/rail.json');
  if (!res.ok) throw new Error('rail.json を読めませんでした: ' + res.status);
  const js = await res.json();
  LINES = js.lines;
  $('attrib').textContent = '出典: ' + js.attribution;
  try {   // 種別と停車駅 (無くても動く)
    const tr = await fetch('data/types.json');
    if (tr.ok) BUILTIN_TYPES = await tr.json();
  } catch (e) { console.warn('types.json', e); }
  rebuildTypes();
  const sc = js.scale;
  PATHS = js.paths.map((p, pi) => {
    const n = p.c.length / 2;
    const lon = new Float64Array(n), lat = new Float64Array(n), cd = new Float64Array(n);
    let x = 0, y = 0;
    for (let i = 0; i < n; i++) {
      x += p.c[2 * i]; y += p.c[2 * i + 1];
      lon[i] = x / sc; lat[i] = y / sc;
      if (i > 0) {
        const cl = Math.cos((lat[i] + lat[i - 1]) / 2 * Math.PI / 180);
        cd[i] = cd[i - 1] + Math.hypot((lon[i] - lon[i - 1]) * R_LON * cl, (lat[i] - lat[i - 1]) * R_LAT);
      }
    }
    for (let k = 0; k < n - 1; k++) {
      const ix0 = Math.floor(Math.min(lon[k], lon[k + 1]) / CELL), ix1 = Math.floor(Math.max(lon[k], lon[k + 1]) / CELL);
      const iy0 = Math.floor(Math.min(lat[k], lat[k + 1]) / CELL), iy1 = Math.floor(Math.max(lat[k], lat[k + 1]) / CELL);
      for (let ix = ix0; ix <= ix1; ix++) for (let iy = iy0; iy <= iy1; iy++) {
        const key = cellKey(ix, iy);
        let arr = GRID.get(key);
        if (!arr) GRID.set(key, arr = []);
        arr.push(pi * 1048576 + k);
      }
    }
    return {
      line: p.l, lon, lat, cd, len: cd[n - 1], loop: !!p.o,
      st: p.s.map(([nm, s, a, b]) => ({ n: nm, s, a: a ?? s, b: b ?? s })),   // a〜b: 駅 (ホーム) の範囲
      tn: p.t.map(([a, b, nm]) => ({ a, b, n: nm || null })),
    };
  });
}

const lineLabel = (li) => `${LINES[li].c} ${LINES[li].n}`;

/** 点の近くにあるパスを探し、パスごとに最も近い投影を返す */
function candidates(lat, lon, radius) {
  const cl = Math.cos(lat * Math.PI / 180);
  const cx = Math.floor(lon / CELL), cy = Math.floor(lat / CELL);
  const best = new Map();
  for (let ix = cx - 1; ix <= cx + 1; ix++) for (let iy = cy - 1; iy <= cy + 1; iy++) {
    const arr = GRID.get(cellKey(ix, iy));
    if (!arr) continue;
    for (const code of arr) {
      const pi = Math.floor(code / 1048576), k = code % 1048576;
      const P = PATHS[pi];
      const ax = (P.lon[k] - lon) * R_LON * cl, ay = (P.lat[k] - lat) * R_LAT;
      const bx = (P.lon[k + 1] - lon) * R_LON * cl, by = (P.lat[k + 1] - lat) * R_LAT;
      const dx = bx - ax, dy = by - ay, L2 = dx * dx + dy * dy;
      let t = L2 > 0 ? -(ax * dx + ay * dy) / L2 : 0;
      t = Math.max(0, Math.min(1, t));
      const d = Math.hypot(ax + t * dx, ay + t * dy);
      if (d > radius) continue;
      const cur = best.get(pi);
      if (!cur || d < cur.d) {
        best.set(pi, {
          pi, line: P.line, d,
          s: P.cd[k] + t * (P.cd[k + 1] - P.cd[k]),
          bearing: (Math.atan2(dx, dy) * 180 / Math.PI + 360) % 360,
        });
      }
    }
  }
  return [...best.values()];
}

/** パス上の距離 s の経緯度 (模擬走行用) */
function pointAt(P, s) {
  const cd = P.cd;
  let lo = 0, hi = cd.length - 1;
  while (hi - lo > 1) { const m = (lo + hi) >> 1; if (cd[m] <= s) lo = m; else hi = m; }
  const f = cd[hi] > cd[lo] ? (s - cd[lo]) / (cd[hi] - cd[lo]) : 0;
  return { lat: P.lat[lo] + f * (P.lat[hi] - P.lat[lo]), lon: P.lon[lo] + f * (P.lon[hi] - P.lon[lo]) };
}

// ------------------------------------------------------------ 状態
const S = {
  running: false,
  pi: -1, s: 0, dir: 0,        // パス, パス上の位置 [m], 進行方向 (+1 / -1 / 0=未定)
  speed: 0,                    // [m/s] (外れ値除去・加減速制限後)
  sVar: 0,                     // s の推定分散 [m^2]
  anchorS: 0,                  // 進行方向を移動量から決めるときの基準位置
  lastRawAt: 0,                // 最後に測位が届いた時刻 (捨てたものも含む)
  noClampUntil: 0,             // GPS 復帰直後、この時刻までは加減速の制限をかけない
  fixes: [],                   // 直近 6 秒の測位 (速度の食い違い確認用)
  vRaw: [],                    // 直近の生の速度 (中央値フィルタ用)
  estDecel: 0,                 // 推定中に続ける減速度 [m/s^2]
  slowSince: 0,                // 停止し始めた時刻
  stopSt: null,                // 停車中の駅 {pi, s, n}
  typeLine: null,              // 種別を判定している路線 (line index)
  typeSel: null,               // 手動で選んだ種別 (null = 自動)
  typeCands: null,             // 自動判定: まだ可能性のある種別の配列
  passCheck: null,             // 駅を通過したか調べるための直前の位置 {pi, s}
  afterGap: false,             // バックグラウンドから戻った直後 (次の測位で位置を取り直す)
  hiddenAt: 0,
  acc: null,
  est: false,                  // 推定中か
  lastFixAt: 0, lastFix: null, lastTick: 0, lastMatchAt: 0,
  alts: [],                    // 区別できない路線の候補 (line index)
  pinnedLine: null, pinnedSeen: 0,
  hist: [],                    // [{t, v, est}]
};

function angDiff(a, b) { const d = Math.abs(a - b) % 360; return d > 180 ? 360 - d : d; }

function onFix(fix) {
  const t = now();
  const { lat, lon, accuracy } = fix;
  S.acc = accuracy;
  if (accuracy > ACC_LIMIT) return;      // 精度が悪い (トンネル内の基地局測位など)

  // 速度: GPS の値を優先、無ければ前回位置との差
  let v = fix.speed;
  if ((v == null || Number.isNaN(v)) && S.lastFix) {
    const dt = (t - S.lastFix.t) / 1000;
    if (dt > 0.5) {
      const cl = Math.cos(lat * Math.PI / 180);
      v = Math.hypot((lon - S.lastFix.lon) * R_LON * cl, (lat - S.lastFix.lat) * R_LAT) / dt;
    }
  }
  if (v == null || Number.isNaN(v)) v = S.speed;
  // GPS が走行中に 0 付近を返すことがあるので、直近数秒の移動距離と食い違えば移動距離の方を使う
  S.fixes.push({ t, lat, lon, acc: accuracy });
  while (S.fixes.length && S.fixes[0].t < t - 6000) S.fixes.shift();
  const f0 = S.fixes[0];
  if (f0 && t - f0.t >= 2500) {
    const cl = Math.cos(lat * Math.PI / 180);
    const dist = Math.hypot((lon - f0.lon) * R_LON * cl, (lat - f0.lat) * R_LAT);
    const vPos = dist / ((t - f0.t) / 1000);
    if (dist > 2 * (accuracy + f0.acc) && vPos > 4 && v < vPos * 0.5) v = vPos;
  }
  const dtPrev = S.lastFixAt ? (t - S.lastFixAt) / 1000 : 0;
  // GPS が途切れている間にぽつんと届く精度の悪い測位 (屋根のある駅など) は速度が当てにならない。
  // 位置だけ使い、推定は続ける。続けて届いたか精度が良ければ復帰とみなす
  const isolated = S.est && accuracy > ISOLATED_ACC && t - S.lastRawAt > 2500;
  S.lastRawAt = t;
  if (isolated) v = S.speed;
  else if (S.est) { S.vRaw = []; S.noClampUntil = t + 3000; }   // 復帰: 推定値からなだらかにせず測った速度をそのまま使う
  if (!isolated) v = filterSpeed(v, dtPrev, t);
  // 予測位置 (推定中は tick が既に進めている)
  const pred = S.est ? S.s : S.s + S.dir * S.speed * dtPrev;

  const radius = Math.min(250, Math.max(40, accuracy * 2));
  const cands = candidates(lat, lon, radius);
  let chosen = null;
  if (cands.length) {
    const sig = Math.max(accuracy, 10);
    for (const c of cands) {
      let cost = (c.d / sig) ** 2;
      if (S.pi >= 0) {
        if (c.pi === S.pi) cost += (Math.abs(c.s - pred) / 200) ** 2;
        else cost += c.line === PATHS[S.pi].line ? 1 : 2.5;
      }
      if (v > 3 && fix.heading != null && !Number.isNaN(fix.heading)) {
        const ad = Math.min(angDiff(fix.heading, c.bearing), angDiff(fix.heading, c.bearing + 180));
        cost += (ad / 25) ** 2;
      }
      if (PATHS[c.pi].len < 2000) cost += 1.5;   // 駅構内の引込線などの短いパスは選びにくく
      if (S.pinnedLine != null && c.line === S.pinnedLine) cost -= 4;
      c.cost = cost;
    }
    cands.sort((a, b) => a.cost - b.cost);
    chosen = cands[0];

    // 区別できない路線 (候補が近く、評価も僅差) を手動選択用に並べる
    const alts = [];
    for (const c of cands) {
      if (c.d > Math.max(accuracy, 30) + 25) continue;
      if (S.pinnedLine == null && c.cost > chosen.cost + 3) continue;
      if (!alts.includes(c.line)) alts.push(c.line);
    }
    S.alts = alts.length > 1 ? alts : [];
    if (S.pinnedLine != null) {
      if (cands.some((c) => c.line === S.pinnedLine)) S.pinnedSeen = t;
      else if (t - S.pinnedSeen > 30000) S.pinnedLine = null;
    }
  }

  if (chosen) {
    const P = PATHS[chosen.pi];
    let s, dir = S.dir;
    if (S.afterGap) {
      // バックグラウンドから戻った: 位置は測位をそのまま使い、進行方向は同じパスなら引き継ぐ
      s = chosen.s; S.sVar = Math.max(accuracy, 5) ** 2; S.anchorS = s;
      if (chosen.pi !== S.pi) dir = 0;
    } else if (chosen.pi === S.pi) {
      // パス上の位置を予測と測位の加重平均で滑らかにする (1 次元カルマンフィルタ)
      const pv = S.sVar + (3 * dtPrev) ** 2 + 4;
      const rv = Math.max(accuracy, 5) ** 2;
      const innov = ringDiff(P, chosen.s, pred);
      if (Math.abs(innov) > 300) { s = chosen.s; S.sVar = rv; }
      else {
        const k = pv / (pv + rv);
        s = wrapS(P, pred + k * innov);
        S.sVar = (1 - k) * pv;
      }
    } else {
      s = chosen.s; S.sVar = Math.max(accuracy, 5) ** 2;
      dir = 0; S.anchorS = s; S.stopSt = null;
    }
    // 進行方向: 走行中なら GPS の向き、向きが無ければ一定距離動いた向き。停止中は変えない
    if (v <= 1) S.anchorS = s;
    else if (v > 2 && fix.heading != null && !Number.isNaN(fix.heading)) {
      dir = Math.cos((fix.heading - chosen.bearing) * Math.PI / 180) >= 0 ? 1 : -1;
      S.anchorS = s;
    } else {
      const ds = ringDiff(P, s, S.anchorS);
      if (Math.abs(ds) > 25) { dir = Math.sign(ds); S.anchorS = s; }
    }
    S.pi = chosen.pi; S.s = s; S.dir = dir;
    S.lastMatchAt = t;
    checkPassing(P, v);
    S.afterGap = false;
  } else if (S.lastMatchAt && t - S.lastMatchAt > 30000) {
    S.pi = -1; S.dir = 0; S.alts = [];   // 線路から離れた
  }
  S.speed = v;
  if (isolated) { updateStop(t); return; }
  S.est = false;
  S.lastFixAt = t;
  S.lastFix = { t, lat, lon };
  pushHist(t, v, false);
  updateStop(t);
  if (NATIVE) updateNotification(t);
}

/** ブラウザでバックグラウンドから戻ったとき: 離れていた間の推定は当てにならないので測位からやり直す */
function resetAfterGap() {
  S.lastFixAt = 0; S.lastFix = null; S.est = false;
  S.vRaw = []; S.fixes = []; S.stopSt = null; S.slowSince = 0;
  S.afterGap = true;
}

/** 生の速度から外れ値を除く: 直近 3 点の中央値 → 前回からの変化を加減速度の上限で制限 */
function filterSpeed(raw, dt, t) {
  raw = Math.max(0, raw);
  S.vRaw.push(raw);
  if (S.vRaw.length > 3) S.vRaw.shift();
  if (dt > 10) S.vRaw = [raw];               // 長く途切れた後は過去を使わない
  const med = [...S.vRaw].sort((a, b) => a - b)[Math.floor(S.vRaw.length / 2)];
  // 推定中・復帰直後は直前の速度が当てにならないので、加減速の制限をかけない
  if (S.est || !S.lastFixAt || dt > 10 || t < S.noClampUntil) return med < 0.3 ? 0 : med;
  const lim = A_MAX * dt + 0.5;
  const v = Math.max(S.speed - lim, Math.min(S.speed + lim, med));
  return v < 0.3 ? 0 : v;
}

/** パス上の 2 点の差 a - b (環状線は近い向きで) */
function ringDiff(P, a, b) {
  let d = a - b;
  if (P.loop) { d = ((d % P.len) + P.len) % P.len; if (d > P.len / 2) d -= P.len; }
  return d;
}
function wrapS(P, s) {
  return P.loop ? ((s % P.len) + P.len) % P.len : Math.max(0, Math.min(P.len, s));
}

/** 駅の近くで一定時間止まったら、その駅に着いたとみなす (次駅の表示をその先の駅にする) */
function updateStop(t) {
  const P = PATHS[S.pi];
  if (!P) { S.stopSt = null; return; }
  const acc = Math.min(S.acc || 0, 100);
  if (S.stopSt && (S.stopSt.pi !== S.pi || stationGap(P, S.stopSt, acc) > 200)) S.stopSt = null;
  if (S.speed >= STOP_V) { S.slowSince = 0; return; }
  if (!S.slowSince) S.slowSince = t;
  if (t - S.slowSince < STOP_HOLD_MS) return;
  let best = null, bd = Infinity;
  for (const st of P.st) {
    const g = stationGap(P, st, acc);
    const d = Math.abs(ringDiff(P, st.s, S.s));
    if (g <= 0 && d < bd) { best = st; bd = d; }
  }
  if (best) {
    S.stopSt = { pi: S.pi, s: best.s, a: best.a, b: best.b, n: best.n };
    typeEvidence(best.n, true);
  }
}

// ------------------------------------------------------------ 種別 (停車駅のパターン)
/** 今の路線の種別データ (無ければ null) */
function lineTypes() {
  const P = PATHS[S.pi];
  if (!P) return null;
  const T = TYPES[lineLabel(P.line)];
  if (!T || !T.order || !T.order.length) return null;
  if (S.typeLine !== P.line) {   // 路線が変わったら判定をやり直す
    S.typeLine = P.line; S.typeSel = null; S.typeCands = [...T.order];
  }
  return T;
}
const typeStops = (T, ty, name) => T.types[ty] === 'all' || T.types[ty].includes(name);
const typeShort = (T, ty) => (T.short && T.short[ty]) || ty;

/** 表示に使う種別: 手動で選んだもの、自動で 1 つに絞れたもの、どちらでもなければ null */
function currentType(T) {
  if (!T) return null;
  if (S.typeSel) return S.typeSel;
  return S.typeCands.length === 1 ? S.typeCands[0] : null;
}

/** その駅に止まるか (種別が決まっていなければ、候補のどれかが止まれば止まる扱い) */
function stopsAt(name) {
  const T = lineTypes();
  if (!T) return true;
  const ty = currentType(T);
  if (ty) return typeStops(T, ty, name);
  return S.typeCands.some((c) => typeStops(T, c, name));
}

/** 駅に止まった (stopped=true) / 通過した (false) ことから種別の候補を絞る */
function typeEvidence(name, stopped) {
  const T = lineTypes();
  if (!T || !S.typeCands) return;
  if (!Object.values(T.types).some((v) => v === 'all' || v.includes(name)) && !stopped) return;
  const next = S.typeCands.filter((c) => typeStops(T, c, name) === stopped);
  // どれにも当てはまらない (臨時停車・データの誤りなど) ときは候補を全部に戻す
  S.typeCands = next.length ? next : [...T.order];
}

/** 駅の範囲 (ホーム ± 50 m。範囲の無いデータでは中心 ± 170 m) を、一度も 30 km/h 未満に
 *  ならずに抜けたら通過とみなす。止まる列車も先頭車ならホームの中心は速いまま過ぎるので、範囲全体で見る */
const PASS_V = 8;
function checkPassing(P, v) {
  if (S.dir === 0) { S.passCheck = null; return; }
  const inside = P.st.find((st) => {
    const lo = st.b - st.a > 20 ? st.a - 50 : st.s - 170, hi = st.b - st.a > 20 ? st.b + 50 : st.s + 170;
    return S.s >= lo && S.s <= hi;
  });
  const pc = S.passCheck;
  if (pc && (pc.pi !== S.pi || pc.n !== (inside && inside.n))) {
    // 範囲を出た: 進行方向の先へ抜け、ずっと速く、推定も挟まず、そこで停車もしていなければ通過
    const ahead = (S.s - pc.s) * S.dir > 0;
    if (pc.pi === S.pi && ahead && pc.minV > PASS_V && !pc.est && !(S.stopSt && S.stopSt.n === pc.n)) typeEvidence(pc.n, false);
    S.passCheck = null;
  }
  if (inside) {
    if (!S.passCheck) S.passCheck = { pi: S.pi, n: inside.n, s: inside.s, minV: v, est: false };
    else S.passCheck.minV = Math.min(S.passCheck.minV, v);
  }
}

/** 現在位置が駅とみなす範囲からどれだけ外れているか [m] (0 以下なら範囲内)
 *  長い編成の端に乗っていると駅の中心から 150 m 以上離れるので、ホームの範囲で判定する */
function stationGap(P, st, acc) {
  const d = ringDiff(P, S.s, st.s);           // 駅の中心から見た現在位置 (パスの向き)
  if (st.b - st.a > 20) {
    const m = STOP_MARGIN + acc;
    return Math.max((st.a - st.s) - m - d, d - (st.b - st.s) - m);
  }
  return Math.abs(d) - (STOP_RADIUS + acc);
}

/** 推定に入るとき、直前に減速していたらその減速を続ける (駅に止まる途中で GPS が途切れた場合) */
function recentDecel() {
  const pts = S.hist.filter((h) => !h.est && h.t >= S.lastFixAt - 8000);
  if (pts.length < 3) return 0;
  const mt = pts.reduce((a, h) => a + h.t, 0) / pts.length, mv = pts.reduce((a, h) => a + h.v, 0) / pts.length;
  let num = 0, den = 0;
  for (const h of pts) { num += (h.t - mt) / 1000 * (h.v - mv); den += ((h.t - mt) / 1000) ** 2; }
  const slope = den > 0 ? num / den : 0;
  return slope < -0.15 ? Math.min(-slope, 1.2) : 0;
}

/** GPS が途切れている間、直前の速度のまま線路上を進める */
function tick() {
  const t = now();
  const dt = S.lastTick ? (t - S.lastTick) / 1000 : 0;
  S.lastTick = t;
  if (!S.running) return;
  if (!NATIVE && document.hidden) return;   // ブラウザは裏で位置が来ないので推定もしない
  if (S.lastFixAt && t - S.lastFixAt > GPS_LOST_MS) {
    if (!S.est) S.estDecel = recentDecel();
    if (S.passCheck) S.passCheck.est = true;
    S.est = true;
    if (S.estDecel) S.speed = Math.max(0, S.speed - S.estDecel * dt);
    if (S.pi >= 0 && S.dir !== 0) {
      const P = PATHS[S.pi];
      S.s = wrapS(P, S.s + S.dir * S.speed * dt);
    }
    S.sVar += (3 * dt) ** 2;
    const last = S.hist[S.hist.length - 1];
    if (!last || t - last.t >= 1000) pushHist(t, S.speed, true);
    updateStop(t);
  }
}

function pushHist(t, v, est) {
  S.hist.push({ t, v, est });
  while (S.hist.length && S.hist[0].t < t - HIST_MAX_SEC * 1000) S.hist.shift();
}

// ------------------------------------------------------------ 計算
/** 進行方向の先にある駅 [{n, dist}] */
/** 進行方向の先にある、止まる駅 n 個 [{n, dist}] */
function stationsAhead(n) {
  return stationsAheadAll(n).filter((a) => a.stop);
}

/** 進行方向の先にある駅を、止まる駅が n 個になるまで通過駅も含めて [{n, dist, stop}] */
function stationsAheadAll(n) {
  const P = PATHS[S.pi];
  if (!P || S.dir === 0) return [];
  const out = [];
  let stops = 0;
  const list = S.dir > 0 ? P.st : [...P.st].reverse();
  const here = S.stopSt && S.stopSt.pi === S.pi ? S.stopSt.s : null;
  const push = (st, d) => {
    if (d <= 0 || st.s === here || stops >= n) return;
    const stop = stopsAt(st.n);
    out.push({ n: st.n, dist: d, stop });
    if (stop) stops++;
  };
  for (const st of list) push(st, (st.s - S.s) * S.dir);
  if (P.loop) for (const st of list) push(st, (st.s - S.s) * S.dir + P.len);   // 環状線は一周して続ける
  return out;
}

/** 停車中の駅 (updateStop で着いたと判定した駅) */
function stationHere() {
  return S.stopSt && S.stopSt.pi === S.pi ? S.stopSt : null;
}

/** 巡航速度: 直近 5 分の走行中 (10 km/h 超) の速度の上位 15% 点と現在速度の大きい方。
 *  平均にすると停車前後の加減速の遅い区間に引きずられて遅めに出るので、上位の値を使う */
function cruiseSpeed() {
  const t = now();
  const vs = S.hist.filter((h) => h.t > t - 300000 && h.v > 3).map((h) => h.v).sort((a, b) => a - b);
  const hi = vs.length ? vs[Math.floor(vs.length * 0.85)] : 0;
  return Math.max(S.speed, hi);
}

/** 距離 D [m] 先の駅に止まるまでの所要時間 [s]。
 *  今の速度 → 巡航速度まで加速 → 巡航 → 一定減速で停止、とする */
function etaSec(D) {
  const vc = cruiseSpeed();
  if (vc < 1) return null;
  const v0 = Math.min(S.speed, vc);
  const da = (vc * vc - v0 * v0) / (2 * ACCEL), db = vc * vc / (2 * DECEL);
  if (da + db <= D) return (vc - v0) / ACCEL + (D - da - db) / vc + vc / DECEL;
  // 巡航速度に届かない: 加速して最高 vp に達したらすぐ減速
  const vp = Math.sqrt((D + v0 * v0 / (2 * ACCEL)) / (1 / (2 * ACCEL) + 1 / (2 * DECEL)));
  if (vp <= v0) return v0 > 0 ? 2 * D / v0 : null;    // もう減速中
  return (vp - v0) / ACCEL + vp / DECEL;
}

/** 次の停車駅の到着予想 [s]。減速中は、減速を始める前 (巡航中) に出した到着予想時刻を使い続ける
 *  (減速が始まってから出し直すより、巡航中の予想の方が当たりやすいため) */
const etaHold = { n: null, at: 0 };
function nextEtaSec(nx, t) {
  const e = etaSec(nx.dist);
  if (isStopped()) { etaHold.n = null; return e; }
  const braking = S.est ? S.estDecel > 0 : accelNow() < -0.15;
  if (braking && etaHold.n === nx.n && etaHold.at > t) return (etaHold.at - t) / 1000;
  if (!braking && e != null) { etaHold.n = nx.n; etaHold.at = t + e * 1000; }
  return e;
}

/** 直近 5 秒の加速度 [m/s^2] (測位の速度の回帰直線の傾き) */
function accelNow() {
  const t = now();
  const pts = S.hist.filter((h) => !h.est && h.t >= t - 5000);
  if (pts.length < 3) return 0;
  const mt = pts.reduce((a, h) => a + h.t, 0) / pts.length, mv = pts.reduce((a, h) => a + h.v, 0) / pts.length;
  let num = 0, den = 0;
  for (const h of pts) { num += (h.t - mt) / 1000 * (h.v - mv); den += ((h.t - mt) / 1000) ** 2; }
  return den > 0 ? num / den : 0;
}

/** 通過駅 x [m] 先に着くまでの時間 [s]。減速は考えず、巡航速度まで加速して巡航する */
function passSec(x) {
  const vc = cruiseSpeed();
  if (vc < 1) return null;
  const v0 = Math.min(S.speed, vc);
  const da = (vc * vc - v0 * v0) / (2 * ACCEL);
  if (x <= da) return (-v0 + Math.sqrt(v0 * v0 + 2 * ACCEL * x)) / ACCEL;
  return (vc - v0) / ACCEL + (x - da) / vc;
}

/** 停車中か (到着予想を時刻ではなく「発車後 約 X 分」で出す) */
const isStopped = () => S.speed < STOP_V;

function tunnelInfo(nextDist) {
  const P = PATHS[S.pi];
  if (!P || S.dir === 0) return null;
  const s = S.s, dir = S.dir;
  const inside = P.tn.find((tn) => s >= tn.a && s <= tn.b) || null;
  let next = null;
  for (const tn of P.tn) {
    const d = dir > 0 ? tn.a - s : s - tn.b;
    if (d > 0 && (!next || d < next.dist)) next = { tn, dist: d };
  }
  let count = 0, total = 0;
  if (nextDist != null) {
    const lo = dir > 0 ? s : s - nextDist, hi = dir > 0 ? s + nextDist : s;
    for (const tn of P.tn) {
      const ov = Math.min(hi, tn.b) - Math.max(lo, tn.a);
      if (ov > 0) { count++; total += ov; }
    }
  }
  return {
    inside, exit: inside ? (dir > 0 ? inside.b - s : s - inside.a) : null,
    next, count, total,
  };
}

// ------------------------------------------------------------ 表示
const fmtDist = (m) => m >= 1000 ? (m / 1000).toFixed(m >= 10000 ? 1 : 2) + ' km' : Math.round(m) + ' m';
const fmtClock = (ms) => new Date(ms).toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
const fmtDur = (s) => s >= 3600 ? `${Math.floor(s / 3600)}時間${Math.round(s % 3600 / 60)}分`
  : `${Math.floor(s / 60)}分${String(Math.round(s % 60)).padStart(2, '0')}秒`;

function render() {
  const t = now();
  $('clock').textContent = fmtClock(t);
  // 速度
  const speedSec = $('speed').parentElement.parentElement;
  speedSec.classList.toggle('est', S.est);
  $('speed').textContent = S.running && (S.lastFixAt || S.est) ? Math.round(S.speed * 3.6) : '--';
  let status;
  if (!S.running) status = '停止中';
  else if (!S.lastFixAt) status = '測位待ち…';
  else if (S.est) status = `GPS 途切れ ${Math.round((t - S.lastFixAt) / 1000)} 秒 — 直前の速度で推定中`;
  else status = `GPS 精度 ±${Math.round(S.acc)} m` + (SIM ? `（模擬走行 ×${SIM_X}）` : '');
  $('status').textContent = status;

  // 路線
  const P = PATHS[S.pi];
  $('lineName').textContent = P ? lineLabel(P.line) : (S.running ? '線路の近くにいません' : '路線未判定');
  renderAlts(P);
  renderTypes();

  // 次駅 (次に止まる駅)。その手前の通過駅は距離と通過予想時刻、その先の停車駅は距離だけ
  const aheadAll = stationsAheadAll(5);
  const ahead = aheadAll.filter((a) => a.stop);
  const here = stationHere();
  $('dirLabel').textContent = !P ? '' : S.dir === 0 ? '進行方向を判定中' :
    (here && S.speed < 2 ? `${here.n} 停車中` : '');
  const estCls = S.est ? 'est-val' : '';
  if (ahead.length) {
    const nx = ahead[0];
    $('nextName').textContent = nx.n;
    $('nextDist').textContent = fmtDist(nx.dist);
    $('nextDist').className = 'big ' + estCls;
    const e = nextEtaSec(nx, t);
    // 停車中はいつ発車するか分からないので、時刻ではなく発車後の所要時間を出す
    $('nextEta').textContent = e == null ? '--'
      : isStopped() ? `発車後 約${fmtDur(e)}` : `${fmtClock(t + e * 1000)}（${fmtDur(e)}）`;
  } else {
    $('nextName').textContent = '--';
    $('nextDist').textContent = '--';
    $('nextEta').textContent = '--';
  }
  const when = (e) => e == null ? '--' : isStopped() ? `発車後 約${fmtDur(e)}` : fmtClock(t + e * 1000);
  // 次の停車駅の手前の通過駅 (近い順)、続いてその先の停車駅を、合わせて 4 件まで
  const FOLLOW_MAX = 4;
  const passing = ahead.length ? aheadAll.filter((a) => !a.stop && a.dist < ahead[0].dist).slice(0, FOLLOW_MAX) : [];
  // 2 つ先以降の停車駅は、途中の停車時間が分からないので距離だけ
  $('following').innerHTML =
    passing.map((a) => `<li class="pass"><span><em>通過</em>${esc(a.n)}</span>` +
      `<span>${fmtDist(a.dist)}　${when(passSec(a.dist))}</span></li>`).join('') +
    ahead.slice(1, 1 + FOLLOW_MAX - passing.length)
      .map((a) => `<li><span>${esc(a.n)}</span><span>${fmtDist(a.dist)}</span></li>`).join('');

  // トンネル
  const ti = tunnelInfo(ahead.length ? ahead[0].dist : null);
  for (const k of TN_KEYS) $(k).parentElement.classList.toggle('hide', !settings[k]);
  $('tunnelCard').style.display = TN_KEYS.some((k) => settings[k]) ? '' : 'none';
  if (ti) {
    $('tnInside').textContent = ti.inside
      ? `トンネル内: ${ti.inside.n || '名称不明'}（全長 ${fmtDist(ti.inside.b - ti.inside.a)}）` : '地上';
    $('tnExit').textContent = ti.exit != null ? fmtDist(ti.exit) : '--';
    $('tnNext').textContent = ti.next
      ? `${fmtDist(ti.next.dist)} 先 ${ti.next.tn.n || ''}（${fmtDist(ti.next.tn.b - ti.next.tn.a)}）` : 'なし';
    $('tnSection').textContent = ahead.length ? `${ti.count} 本・計 ${fmtDist(ti.total)}` : '--';
  } else {
    for (const k of TN_KEYS) $(k).textContent = '--';
  }

  drawChart(t);
  drawStrip(ahead);
}

/** Android アプリの通知 (速度・次駅・到着予想) を更新する。2 秒に 1 回まで */
let lastNotif = { t: 0, key: '' };
function updateNotification(t) {
  if (!NATIVE || !S.running || t - lastNotif.t < 2000) return;
  const P = PATHS[S.pi];
  const spd = S.lastFixAt || S.est ? `${Math.round(S.speed * 3.6)} km/h` : '測位待ち';
  const title = `${spd}${S.est ? '（推定）' : ''}　${P ? lineLabel(P.line) : '線路の近くにいません'}`;
  let text = '';
  const ahead = P ? stationsAhead(2) : [];
  const here = stationHere();
  if (here) text += `${here.n} 停車中　`;
  if (ahead.length) {
    const e = nextEtaSec(ahead[0], t);
    text += `次は ${ahead[0].n} ${fmtDist(ahead[0].dist)}` + (e == null ? ''
      : isStopped() ? `（発車後 約${fmtDur(e)}）` : `（${fmtClock(t + e * 1000).slice(0, 5)} 着予想）`);
    if (ahead[1]) text += `\nその次 ${ahead[1].n} ${fmtDist(ahead[1].dist)}`;
  } else if (P) text += S.dir === 0 ? '進行方向を判定中' : '';
  const key = title + text;
  if (key === lastNotif.key) return;
  lastNotif = { t, key };
  TrainLocation.setNotification({ title, text }).catch(() => {});
}

/** 種別の選択ボタン。「自動」は判定中の候補を表示 */
function renderTypes() {
  const box = $('typeChips');
  const T = lineTypes();
  const want = T ? `${S.typeLine}|${S.typeSel}|${S.typeCands.join(',')}` : '';
  if (box.dataset.k === want) return;
  box.dataset.k = want;
  box.innerHTML = '';
  if (!T) {
    if (PATHS[S.pi]) {
      const add = document.createElement('button');
      add.textContent = '＋ 種別と停車駅を設定';
      add.onclick = () => openTypeEditor();
      box.appendChild(add);
    }
    return;
  }
  const auto = document.createElement('button');
  const guess = S.typeCands.length === 1 ? typeShort(T, S.typeCands[0])
    : S.typeCands.length < T.order.length ? S.typeCands.map((c) => typeShort(T, c)).join('/') + '?' : '判定中';
  auto.textContent = `自動: ${guess}`;
  if (!S.typeSel) auto.classList.add('on');
  auto.onclick = () => { S.typeSel = null; box.dataset.k = ''; };
  box.appendChild(auto);
  for (const ty of T.order) {
    const b = document.createElement('button');
    b.textContent = typeShort(T, ty);
    if (S.typeSel === ty) b.classList.add('on');
    b.onclick = () => { S.typeSel = ty; box.dataset.k = ''; };
    box.appendChild(b);
  }
  const ed = document.createElement('button');
  ed.textContent = '✎';
  ed.title = '種別と停車駅を編集';
  ed.onclick = () => openTypeEditor();
  box.appendChild(ed);
}

function renderAlts(P) {
  const box = $('lineAlts');
  const want = S.alts.map((li) => `${li}:${li === S.pinnedLine}`).join(',');
  if (box.dataset.k === want) return;
  box.dataset.k = want;
  box.innerHTML = '';
  for (const li of S.alts) {
    const b = document.createElement('button');
    b.textContent = lineLabel(li);
    if (li === S.pinnedLine || (S.pinnedLine == null && P && P.line === li)) b.classList.add('on');
    b.onclick = () => { S.pinnedLine = li; S.pinnedSeen = now(); box.dataset.k = ''; };
    box.appendChild(b);
  }
}

function esc(s) { return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }

function setupCanvas(cv) {
  const dpr = window.devicePixelRatio || 1;
  const w = cv.clientWidth, h = cv.clientHeight;
  if (cv.width !== Math.round(w * dpr) || cv.height !== Math.round(h * dpr)) {
    cv.width = Math.round(w * dpr); cv.height = Math.round(h * dpr);
  }
  const ctx = cv.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);
  return { ctx, w, h };
}

function drawChart(t) {
  const sec = settings.histSec;
  $('histLabel').textContent = `過去 ${sec} 秒`;
  const { ctx, w, h } = setupCanvas($('chart'));
  const L = 34, R = 6, T = 6, B = 18;
  const pts = S.hist.filter((p) => p.t >= t - sec * 1000);
  const vmax = Math.max(40, Math.ceil(Math.max(0, ...pts.map((p) => p.v * 3.6)) * 1.1 / 20) * 20);
  const X = (tt) => L + (w - L - R) * (1 - (t - tt) / (sec * 1000));
  const Y = (kmh) => T + (h - T - B) * (1 - kmh / vmax);
  ctx.font = '11px system-ui'; ctx.fillStyle = '#8b97a3'; ctx.strokeStyle = '#2a323a'; ctx.lineWidth = 1;
  const step = vmax <= 80 ? 20 : vmax <= 200 ? 40 : 100;
  for (let k = 0; k <= vmax; k += step) {
    ctx.beginPath(); ctx.moveTo(L, Y(k)); ctx.lineTo(w - R, Y(k)); ctx.stroke();
    ctx.textAlign = 'right'; ctx.fillText(k, L - 4, Y(k) + 4);
  }
  ctx.textAlign = 'center';
  for (const frac of [0, 0.5, 1]) {
    const lab = frac === 1 ? '現在' : `-${Math.round(sec * (1 - frac))}s`;
    ctx.fillText(lab, L + (w - L - R) * frac, h - 4);
  }
  // 測位ごとの速度 (細く薄く)
  ctx.lineWidth = 1.2;
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1], b = pts[i];
    if (b.t - a.t > 30000) continue;   // 長い空白はつながない
    ctx.strokeStyle = b.est ? 'rgba(255,183,77,0.6)' : 'rgba(79,195,247,0.45)';
    ctx.setLineDash(b.est ? [4, 3] : []);
    ctx.beginPath(); ctx.moveTo(X(a.t), Y(a.v * 3.6)); ctx.lineTo(X(b.t), Y(b.v * 3.6)); ctx.stroke();
  }
  ctx.setLineDash([]);
  // なめらかな速度 (太く)
  const sm = smoothHist(pts);
  ctx.lineWidth = 2.5; ctx.lineJoin = 'round';
  for (let i = 1; i < sm.length; i++) {
    const a = sm[i - 1], b = sm[i];
    if (b.t - a.t > 30000) continue;
    ctx.strokeStyle = b.est ? '#ffb74d' : '#e8edf2';
    ctx.beginPath(); ctx.moveTo(X(a.t), Y(a.v * 3.6)); ctx.lineTo(X(b.t), Y(b.v * 3.6)); ctx.stroke();
  }
}

/** 速度履歴を前後 SMOOTH_HALF_S 秒のガウス重みで平均する。
 *  後ろ側のデータがそろった点だけを返すので、最新から SMOOTH_HALF_S 秒遅れる */
function smoothHist(pts) {
  const H = SMOOTH_HALF_S * 1000, sig = H / 2;
  const out = [];
  if (!pts.length) return out;
  const tEnd = pts[pts.length - 1].t;
  let lo = 0;
  for (let i = 0; i < pts.length; i++) {
    const ti = pts[i].t;
    if (ti > tEnd - H) break;
    while (pts[lo].t < ti - H) lo++;
    let sw = 0, sv = 0;
    for (let j = lo; j < pts.length && pts[j].t <= ti + H; j++) {
      const w = Math.exp(-0.5 * ((pts[j].t - ti) / sig) ** 2);
      sw += w; sv += w * pts[j].v;
    }
    out.push({ t: ti, v: sv / sw, est: pts[i].est });
  }
  return out;
}

/** 進行方向を右にした直線の路線図 (駅・トンネル・現在位置) */
function drawStrip(ahead) {
  const { ctx, w, h } = setupCanvas($('strip'));
  const P = PATHS[S.pi];
  if (!P || S.dir === 0) {
    ctx.fillStyle = '#8b97a3'; ctx.font = '13px system-ui'; ctx.textAlign = 'center';
    ctx.fillText('路線と進行方向が決まると表示します', w / 2, h / 2);
    return;
  }
  const span = Math.min(60000, Math.max(2000, ahead.length ? ahead[Math.min(2, ahead.length - 1)].dist * 1.1 : 3000));
  const behind = span * 0.18;
  const pad = 14, y = 40;
  const X = (s) => pad + (w - 2 * pad) * (((s - S.s) * S.dir + behind) / (span + behind));
  const inView = (s) => { const d = (s - S.s) * S.dir; return d >= -behind && d <= span; };
  ctx.strokeStyle = '#5b6875'; ctx.lineWidth = 4;
  ctx.beginPath(); ctx.moveTo(pad, y); ctx.lineTo(w - pad, y); ctx.stroke();
  // トンネル
  ctx.strokeStyle = '#a1887f'; ctx.lineWidth = 10;
  for (const tn of P.tn) {
    const xa = X(tn.a), xb = X(tn.b);
    const x0 = Math.max(pad, Math.min(xa, xb)), x1 = Math.min(w - pad, Math.max(xa, xb));
    if (x1 > x0) { ctx.beginPath(); ctx.moveTo(x0, y); ctx.lineTo(x1, y); ctx.stroke(); }
  }
  // 駅
  ctx.font = '11px system-ui'; ctx.textAlign = 'center';
  let lastX = -1e9, row = 0;
  const sts = P.st.filter((st) => inView(st.s)).sort((a, b) => X(a.s) - X(b.s));
  for (const st of sts) {
    const x = X(st.s);
    const stop = stopsAt(st.n);
    ctx.beginPath(); ctx.arc(x, y, stop ? 5 : 3.5, 0, Math.PI * 2);
    if (stop) { ctx.fillStyle = '#e8edf2'; ctx.fill(); }
    else { ctx.fillStyle = '#101418'; ctx.fill(); ctx.strokeStyle = '#8b97a3'; ctx.lineWidth = 1.5; ctx.stroke(); }
    row = x - lastX < 70 ? 1 - row : 0;
    lastX = x;
    ctx.fillStyle = stop ? '#e8edf2' : '#6b7680';   // 通過駅は暗く
    ctx.fillText(st.n, x, row ? y + 36 : y + 22);
  }
  // 現在位置
  const cx = X(S.s);
  ctx.fillStyle = S.est ? '#ffb74d' : '#4fc3f7';
  ctx.beginPath(); ctx.moveTo(cx - 7, y - 20); ctx.lineTo(cx + 7, y - 20); ctx.lineTo(cx, y - 8); ctx.closePath(); ctx.fill();
  ctx.fillStyle = '#8b97a3'; ctx.textAlign = 'right';
  ctx.fillText(`→ ${fmtDist(span)} 先まで`, w - pad, 12);
}

// ------------------------------------------------------------ 位置の取得
let watchId = null, simTimer = null, wakeLock = null;

async function requestWakeLock() {
  try {
    if ('wakeLock' in navigator) wakeLock = await navigator.wakeLock.request('screen');
  } catch (e) { console.warn('wake lock', e); }
}
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') { S.hiddenAt = now(); return; }
  if (!S.running) return;
  if (!NATIVE) {
    requestWakeLock();
    if (!SIM && S.hiddenAt && now() - S.hiddenAt > BG_GAP_MS) resetAfterGap();
  }
  render();
});

let nativeSubs = [];
async function startNative() {
  const sub = (ev, fn) => TrainLocation.addListener(ev, fn).then((h) => nativeSubs.push(h));
  await sub('location', (l) => onFix({
    lat: l.lat, lon: l.lon, accuracy: l.accuracy, speed: l.speed, heading: l.heading,
  }));
  // 裏ではタイマーが間引かれるので、サービスからの 1 秒ごとの合図で推定と通知を進める
  await sub('tick', () => { tick(); updateNotification(now()); });
  try {
    await TrainLocation.start();
  } catch (e) {
    stop();
    $('status').textContent = '位置情報を開始できません: ' + (e.message || e);
  }
}

function start() {
  S.running = true;
  $('startBtn').textContent = '停止';
  if (SIM) { requestWakeLock(); startSim(SIM); return; }
  if (NATIVE) { startNative(); return; }
  requestWakeLock();
  if (!('geolocation' in navigator)) { alert('この端末では位置情報が使えません'); return; }
  watchId = navigator.geolocation.watchPosition(
    (pos) => onFix({
      lat: pos.coords.latitude, lon: pos.coords.longitude, accuracy: pos.coords.accuracy,
      speed: pos.coords.speed, heading: pos.coords.heading,
    }),
    (err) => { $('status').textContent = '位置情報エラー: ' + err.message; },
    { enableHighAccuracy: true, maximumAge: 0, timeout: 15000 },
  );
}

function stop() {
  S.running = false;
  $('startBtn').textContent = '開始';
  if (watchId != null) navigator.geolocation.clearWatch(watchId);
  watchId = null;
  clearInterval(simTimer);
  if (NATIVE) {
    for (const h of nativeSubs) h.remove();
    nativeSubs = [];
    TrainLocation.stop().catch(() => {});
  }
  if (wakeLock) { wakeLock.release().catch(() => {}); wakeLock = null; }
}

/** 模擬走行: ?sim=路線名の一部 [&x=早回し倍率] [&v=最高速度km/h] [&n=位置の誤差m] [&t=種別]
 *  各駅に停車し、トンネル内では GPS を出さない (推定の動作確認用) */
function startSim(q) {
  let best = null;
  PATHS.forEach((P, pi) => {
    const nm = lineLabel(P.line);
    if (nm.includes(q) && P.st.length >= 2 && (!best || P.len > PATHS[best].len)) best = pi;
  });
  if (best == null) { alert(`模擬走行: 「${q}」を含む路線が見つかりません`); return; }
  const P = PATHS[best];
  const vmax = (Number(params.get('v')) || (lineLabel(P.line).includes('新幹線') ? 270 : 100)) / 3.6;
  const SIM_NOISE = Number(params.get('n')) || 4;   // 位置の誤差 [m]
  // t=種別名 で、その種別の停車駅だけに止まる (種別の自動判定の確認用)
  const T = TYPES[lineLabel(P.line)], ty = params.get('t');
  const stops = T && T.types[ty] ? P.st.filter((st) => typeStops(T, ty, st.n)) : P.st;
  const sim = { s: stops[0].s, v: 0, dwell: 15, idx: 1 };
  const dt = 1;   // 模擬時間で 1 秒ごと
  simTimer = setInterval(() => {
    const target = stops[sim.idx];
    if (!target) { stop(); return; }
    if (sim.dwell > 0) { sim.dwell -= dt; }
    else {
      const D = target.s - sim.s;
      if (sim.v * sim.v / (2 * DECEL) >= D - sim.v * dt) sim.v = Math.max(0.5, sim.v - DECEL * dt);
      else sim.v = Math.min(vmax, sim.v + 0.8 * dt);
      sim.s += sim.v * dt;
      if (sim.s >= target.s) { sim.s = target.s; sim.v = 0; sim.dwell = 20; sim.idx++; }
    }
    const inTunnel = P.tn.some((tn) => sim.s >= tn.a && sim.s <= tn.b);
    if (inTunnel) return;
    // 屋根のある駅を模す: 停車中は GPS がほぼ入らず、たまに精度の悪い測位がでたらめな速度で届く
    if (SIM_NOISE > 4 && sim.dwell > 0) {
      sim.bad = (sim.bad || 0) + 1;
      if (sim.bad % 8) return;
      const q = pointAt(P, sim.s);
      onFix({ lat: q.lat + 30 / R_LAT, lon: q.lon, accuracy: 45, speed: Math.random() * 17, heading: null });
      return;
    }
    const p = pointAt(P, sim.s);
    const p2 = pointAt(P, Math.min(P.len, sim.s + 5));
    const cl = Math.cos(p.lat * Math.PI / 180);
    const heading = (Math.atan2((p2.lon - p.lon) * cl * R_LON, (p2.lat - p.lat) * R_LAT) * 180 / Math.PI + 360) % 360;
    const noise = () => (Math.random() - 0.5) * 2 * SIM_NOISE / R_LAT;
    const spike = SIM_NOISE > 4 && Math.random() < 0.05 ? Math.random() * 15 : 0;   // 時々出る速度の外れ値
    if (SIM_NOISE > 4 && !sim.drop && Math.random() < 0.02) sim.drop = 2 + Math.floor(Math.random() * 4);
    const drop = sim.drop > 0 && sim.drop--;   // 走行中に数秒間 0 を返す
    onFix({
      lat: p.lat + noise(), lon: p.lon + noise(), accuracy: SIM_NOISE * 1.5 + Math.random() * 6,
      speed: drop ? 0 : Math.max(0, sim.v + (Math.random() - 0.5) * 0.5 + spike), heading: sim.v > 1 ? heading : null,
    });
  }, 1000 / SIM_X);
}

// ------------------------------------------------------------ 設定画面
function openSettings() {
  $('setHist').value = settings.histSec;
  for (const k of TN_KEYS) $('set_' + k).checked = settings[k];
  $('settings').showModal();
}
$('settings').addEventListener('close', () => {
  if ($('settings').returnValue !== 'save') return;
  const h = Math.round(Number($('setHist').value));
  settings.histSec = Math.min(1800, Math.max(30, Number.isFinite(h) ? h : DEFAULTS.histSec));
  for (const k of TN_KEYS) settings[k] = $('set_' + k).checked;
  saveSettings();
  render();
});

// ------------------------------------------------------------ 種別と停車駅の編集
// 路線を選び、種別を追加・名前変更・削除し、縦の路線図で駅をタップして停車/通過を切り替える
const TED = { line: null, work: {}, sel: null };

/** 路線の駅の並び。パスが分かれている路線 (江ノ島線の藤沢〜片瀬江ノ島など) は、
 *  長いパスから順に、近い方の端へ向きをそろえてつなぐ */
const lineStCache = new Map();
function lineStations(label) {
  if (lineStCache.has(label)) return lineStCache.get(label);
  const li = LINES.findIndex((l) => `${l.c} ${l.n}` === label);
  const ps = PATHS.filter((P) => P.line === li).sort((a, b) => b.len - a.len);
  let out = [];   // [{n, lat, lon}]
  const dist = (a, b) => Math.hypot((a.lon - b.lon) * R_LON * Math.cos(a.lat * Math.PI / 180), (a.lat - b.lat) * R_LAT);
  for (const P of ps) {
    const add = P.st.filter((st) => !out.some((o) => o.n === st.n)).map((st) => ({ n: st.n, ...pointAt(P, st.s) }));
    if (!add.length) continue;
    if (!out.length) { out = add; continue; }
    const f = add[0], l = add[add.length - 1], F = out[0], L = out[out.length - 1];
    const opts = [[dist(L, f), 'end'], [dist(L, l), 'endRev'], [dist(F, l), 'start'], [dist(F, f), 'startRev']];
    const how = opts.sort((x, y) => x[0] - y[0])[0][1];
    if (how === 'end') out = out.concat(add);
    else if (how === 'endRev') out = out.concat(add.reverse());
    else if (how === 'start') out = add.concat(out);
    else out = add.reverse().concat(out);
  }
  const names = out.map((o) => o.n);
  lineStCache.set(label, names);
  return names;
}

/** 編集用の作業コピー (停車駅は必ず配列にする) */
function tedData(label) {
  if (!TED.work[label]) {
    const src = TYPES[label] || { order: [], types: {} };
    const all = lineStations(label);
    const types = {};
    for (const ty of src.order || []) types[ty] = src.types[ty] === 'all' ? [...all] : [...(src.types[ty] || [])];
    TED.work[label] = { order: [...(src.order || [])], short: { ...(src.short || {}) }, types, dirty: false };
  }
  return TED.work[label];
}

function openTypeEditor() {
  TED.work = {};
  const P = PATHS[S.pi];
  TED.line = P ? lineLabel(P.line) : TED.line;
  TED.sel = null;
  $('tedFilter').value = '';
  tedLineOptions();
  tedRender();
  $('typeEd').showModal();
}

function tedLineOptions() {
  const q = $('tedFilter').value.trim();
  const labels = [...new Set(PATHS.filter((P) => P.st.length >= 2).map((P) => lineLabel(P.line)))]
    .filter((l) => !q || l.includes(q) || l === TED.line)
    .sort((a, b) => a.localeCompare(b, 'ja'));
  if (!TED.line && labels.length) TED.line = labels[0];
  $('tedLine').innerHTML = labels.map((l) =>
    `<option value="${esc(l)}"${l === TED.line ? ' selected' : ''}>${TYPES[l] && TYPES[l].order && TYPES[l].order.length ? '★ ' : ''}${esc(l)}</option>`).join('');
}

function tedRender() {
  if (!TED.line) return;
  const D = tedData(TED.line);
  if (!D.order.includes(TED.sel)) TED.sel = D.order[0] || null;
  // 種別のボタン
  const box = $('tedTypes');
  box.innerHTML = '';
  for (const ty of D.order) {
    const b = document.createElement('button');
    b.textContent = ty;
    if (ty === TED.sel) b.classList.add('on');
    b.onclick = () => { TED.sel = ty; tedRender(); };
    box.appendChild(b);
  }
  const add = document.createElement('button');
  add.textContent = '＋ 追加';
  add.onclick = () => {
    let k = D.order.length + 1, name;
    do name = `種別${k++}`; while (D.order.includes(name));
    D.order.push(name); D.types[name] = lineStations(TED.line); D.dirty = true;
    TED.sel = name; tedRender();
    $('tedName').focus(); $('tedName').select();
  };
  box.appendChild(add);
  // 選んだ種別の名前・操作
  const has = !!TED.sel;
  $('tedEditRow').classList.toggle('hide', !has);
  $('tedName').value = has ? TED.sel : '';
  $('tedUp').disabled = !has || D.order.indexOf(TED.sel) === 0;
  // 縦の路線図
  const stops = has ? new Set(D.types[TED.sel]) : null;
  const sts = lineStations(TED.line);
  $('tedHint').textContent = has ? `駅をタップで 停車 ⇔ 通過（停車 ${sts.filter((n) => stops.has(n)).length} / ${sts.length} 駅）`
    : '「＋ 追加」で種別を作ってください';
  $('tedStations').innerHTML = sts.map((n, i) => {
    const on = has && stops.has(n);
    return `<li data-i="${i}" class="${has ? (on ? 'stop' : 'pass') : 'none'}"><span class="dot"></span><span class="nm">${esc(n)}</span>` +
      `<span class="tag">${has ? (on ? '停車' : '通過') : ''}</span></li>`;
  }).join('');
  $('tedReset').disabled = !USER_TYPES[TED.line] && !D.dirty;
}

$('tedStations').addEventListener('click', (e) => {
  const li = e.target.closest('li');
  if (!li || !TED.sel) return;
  const D = tedData(TED.line);
  const n = lineStations(TED.line)[Number(li.dataset.i)];
  const arr = D.types[TED.sel];
  const k = arr.indexOf(n);
  if (k >= 0) arr.splice(k, 1); else arr.push(n);
  D.dirty = true;
  tedRender();
});
$('tedFilter').addEventListener('input', tedLineOptions);
$('tedLine').addEventListener('change', () => { TED.line = $('tedLine').value; TED.sel = null; tedRender(); });
$('tedName').addEventListener('change', () => {
  const D = tedData(TED.line);
  const nm = $('tedName').value.trim();
  if (!nm || nm === TED.sel || D.order.includes(nm)) { $('tedName').value = TED.sel; return; }
  D.order[D.order.indexOf(TED.sel)] = nm;
  D.types[nm] = D.types[TED.sel]; delete D.types[TED.sel];
  if (D.short[TED.sel]) { D.short[nm] = D.short[TED.sel]; delete D.short[TED.sel]; }
  TED.sel = nm; D.dirty = true; tedRender();
});
$('tedUp').onclick = () => {
  const D = tedData(TED.line), i = D.order.indexOf(TED.sel);
  if (i > 0) { [D.order[i - 1], D.order[i]] = [D.order[i], D.order[i - 1]]; D.dirty = true; tedRender(); }
};
$('tedDel').onclick = () => {
  if (!confirm(`「${TED.sel}」を削除しますか？`)) return;
  const D = tedData(TED.line);
  D.order = D.order.filter((t) => t !== TED.sel); delete D.types[TED.sel];
  TED.sel = null; D.dirty = true; tedRender();
};
$('tedAll').onclick = () => { const D = tedData(TED.line); D.types[TED.sel] = lineStations(TED.line); D.dirty = true; tedRender(); };
$('tedNone').onclick = () => { const D = tedData(TED.line); D.types[TED.sel] = []; D.dirty = true; tedRender(); };
$('tedReset').onclick = () => {
  if (!confirm(`${TED.line} の種別をこのブラウザで編集する前の状態（初期値${BUILTIN_TYPES[TED.line] ? '' : ': 種別なし'}）に戻しますか？`)) return;
  delete USER_TYPES[TED.line]; delete TED.work[TED.line];
  saveUserTypes(); tedLineOptions(); tedRender();
};
$('tedCancel').onclick = () => $('typeEd').close();
$('tedSave').onclick = () => {
  for (const [label, D] of Object.entries(TED.work)) {
    if (!D.dirty) continue;
    const all = lineStations(label);
    const types = {};
    // 駅の並び順で保存。全駅停車なら "all"
    for (const ty of D.order) types[ty] = D.types[ty].length === all.length ? 'all' : all.filter((n) => D.types[ty].includes(n));
    const short = Object.fromEntries(Object.entries(D.short).filter(([k]) => D.order.includes(k)));
    USER_TYPES[label] = { order: D.order, ...(Object.keys(short).length ? { short } : {}), types };
  }
  saveUserTypes();
  $('typeEd').close();
  render();
};
// 書き出し・読み込み (端末の移し替えやバックアップ用)
$('tedExport').onclick = () => {
  $('tedJson').value = JSON.stringify(USER_TYPES, null, 1);
  $('tedJson').select();
  if (navigator.clipboard) navigator.clipboard.writeText($('tedJson').value).then(() => { $('tedJsonMsg').textContent = 'コピーしました'; }, () => {});
};
$('tedImport').onclick = () => {
  let js;
  try { js = JSON.parse($('tedJson').value); } catch (e) { $('tedJsonMsg').textContent = 'JSON として読めません: ' + e.message; return; }
  const ok = js && typeof js === 'object' && Object.values(js).every((v) => v && Array.isArray(v.order) && v.types &&
    v.order.every((t) => v.types[t] === 'all' || Array.isArray(v.types[t])));
  if (!ok) { $('tedJsonMsg').textContent = '形式が違います ({"会社 路線名": {"order": [...], "types": {...}}})'; return; }
  Object.assign(USER_TYPES, js);
  saveUserTypes();
  TED.work = {};
  tedLineOptions(); tedRender();
  $('tedJsonMsg').textContent = `${Object.keys(js).length} 路線を読み込みました`;
};

// ------------------------------------------------------------ 起動
$('startBtn').onclick = () => (S.running ? stop() : start());
$('settingsBtn').onclick = openSettings;
$('setTypes').onclick = () => { $('settings').close(); openTypeEditor(); };

(async () => {
  try {
    await loadData();
    $('loading').classList.add('hide');
  } catch (e) {
    $('loading').textContent = '読み込み失敗: ' + e.message;
    return;
  }
  setInterval(() => { tick(); if (!document.hidden) render(); }, 250);
  render();
  const local = ['localhost', '127.0.0.1'].includes(location.hostname);
  if ('serviceWorker' in navigator && !local) navigator.serviceWorker.register('sw.js');
})();
