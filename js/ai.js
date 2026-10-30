/*
 * 鉄盤戦線 — CPU 思考ルーチン
 * 評価関数 + 浅い先読み（自分の手 → 相手の最善応手）で手を選ぶ。
 */
(function (global) {
  'use strict';
  const E = global.Engine;
  const T = E.UNIT_TYPES;

  const VALUE = { infantry: 2.6, drone: 3.8, artillery: 6.4, tank: 7.6, missile: 8.4 };
  const LEVELS = {
    easy: { depth: 1, top: 0, noise: 9 },
    normal: { depth: 2, top: 12, noise: 0.4 },
    hard: { depth: 2, top: 28, noise: 0.1 },
  };

  function valueAt(type, hp) {
    if (hp <= 0) return 0;
    return VALUE[type] * (0.4 + 0.6 * hp / T[type].hp);
  }

  // 1手で得られる最大の戦果（相手駒の価値減少量）
  function bestAttackGain(s, p, occ) {
    let best = 0;
    for (const u of s.units) {
      if (u.owner !== p) continue;
      if (u.type === 'missile') {
        for (const v of s.units) {
          if (v.owner === p || E.cheb(u.x, u.y, v.x, v.y) > 4) continue;
          let g = 0;
          for (const [w, d] of E.missileImpact(s, v.x, v.y, occ)) {
            const loss = valueAt(w.type, w.hp) - valueAt(w.type, w.hp - d) + (w.hp - d <= 0 ? 1 : 0);
            g += w.owner === p ? -loss : loss;
          }
          g -= VALUE.missile;
          if (g > best) best = g;
        }
        continue;
      }
      const targets = E.attackTargets(s, u, occ);
      if (E.MOVE_THEN_ATTACK[u.type]) {
        // 移動してから攻撃できる範囲も脅威として数える
        const ox = u.x, oy = u.y;
        for (const [x, y] of E.moveTargets(s, u, occ)) {
          u.x = x; u.y = y;
          for (const t of E.attackTargets(s, u, occ)) targets.push(t);
        }
        u.x = ox; u.y = oy;
      }
      for (const t of targets) {
        const d = E.damageOf(s, u.type, t);
        const g = valueAt(t.type, t.hp) - valueAt(t.type, t.hp - d) + (t.hp - d <= 0 ? 1 : 0);
        if (g > best) best = g;
      }
    }
    return best;
  }

  // p の歩兵が次の一手で敵首都を占領できるか
  function winInOne(s, p, occ) {
    const [cx, cy] = s.capitals[1 - p];
    if (occ[E.idx(cx, cy)]) return false;
    for (const u of s.units) {
      if (u.owner === p && u.type === 'infantry' && !u.fresh && E.manh(u.x, u.y, cx, cy) === 1) return true;
    }
    return false;
  }

  function evaluate(s, p) {
    if (s.winner !== null) return s.winner === p ? 1e6 : s.winner === -1 ? 0 : -1e6;
    const o = 1 - p;
    const occ = E.occGrid(s);
    let sc = 0;

    // 未占領の工場リスト（陣営ごと）
    const targetsFor = [[], []];
    for (let i = 0; i < E.N; i++) {
      if (s.building[i] !== 'F') continue;
      const x = i % E.SIZE, y = (i / E.SIZE) | 0;
      if (s.owner[i] !== 0) targetsFor[0].push([x, y]);
      if (s.owner[i] !== 1) targetsFor[1].push([x, y]);
    }

    // 戦力差に応じて攻撃性を変える（優勢なほど敵首都へ押し込む）
    const mat = [s.funds[0] * 0.5, s.funds[1] * 0.5];
    for (const u of s.units) mat[u.owner] += valueAt(u.type, u.hp);
    const aggr = [0, 1].map(q => Math.max(0.6, Math.min(3, 1 + (mat[q] - mat[1 - q]) / 15)));

    for (const u of s.units) {
      let v = valueAt(u.type, u.hp);
      const [ex, ey] = s.capitals[1 - u.owner];
      const d = E.manh(u.x, u.y, ex, ey);
      const ag = aggr[u.owner];
      if (u.type === 'infantry') {
        v += (16 - d) * 0.32 * ag;
        let fd = 9;
        for (const [fx, fy] of targetsFor[u.owner]) fd = Math.min(fd, E.manh(u.x, u.y, fx, fy));
        v += (9 - fd) * 0.22;
        if (s.trench[E.idx(u.x, u.y)]) v += 0.3;
      } else {
        v += (16 - d) * 0.1 * ag;
      }
      // 敵首都周辺への戦力集中（周囲8マスに入ると敵首都の生産を封じる）
      if (d <= 4) v += (5 - d) * (u.type === 'infantry' ? 0.6 : 0.35) * ag;
      if (E.cheb(u.x, u.y, ex, ey) <= 1) v += 2.5;
      sc += u.owner === p ? v : -v;

      // 首都への接近は脅威として評価
      if (u.type === 'infantry' && d <= 2) {
        const w = d === 1 ? 6 : 2;
        sc += u.owner === p ? w : -w;
      }
    }

    sc += (s.funds[p] - s.funds[o]) * 0.55;
    sc += (E.income(s, p) - E.income(s, o)) * 3;

    const gP = bestAttackGain(s, p, occ);
    const gO = bestAttackGain(s, o, occ);
    if (s.cur === p) {
      sc += 0.7 * gP - 0.25 * gO;
      if (winInOne(s, p, occ)) sc += 5e4;
      if (winInOne(s, o, occ)) sc -= 25;
    } else {
      sc += 0.25 * gP - 0.7 * gO;
      if (winInOne(s, o, occ)) sc -= 5e4;
      if (winInOne(s, p, occ)) sc += 25;
    }
    return sc;
  }

  // 相手（s.cur）の最善応手を仮定したときの p から見た評価値（下限 alpha で枝刈り）
  function replyValue(s, p, alpha) {
    if (s.winner !== null) return evaluate(s, p);
    let worst = evaluate(E.endTurn(s), p);
    if (worst <= alpha) return worst;
    for (const b of E.turnSequences(s)) {
      const s3 = E.applySeq(s, b);
      const v = s3.winner !== null ? evaluate(s3, p) : evaluate(E.endTurn(s3), p);
      if (v < worst) {
        worst = v;
        if (worst <= alpha) break;
      }
    }
    return worst;
  }

  function pickBest(s, cands, level) {
    const p = s.cur;
    const L = LEVELS[level] || LEVELS.normal;
    const opts = [null].concat(cands);
    const scored = [];
    // まだ自分の行動が残る手は、手番を渡さずにそのまま評価する
    const more = s.actionsLeft > 1 && cands.length && cands[0][0].type !== 'produce';
    for (const a of opts) {
      const s1 = a ? E.applySeq(s, a) : s;
      if (s1.winner === p) return a;
      if (more && a) {
        scored.push({ a, s2: null, v: evaluate(s1, p) + (Math.random() - 0.5) * L.noise });
        continue;
      }
      const s2 = E.endTurn(s1);
      scored.push({ a, s2, v: evaluate(s2, p) + (Math.random() - 0.5) * L.noise });
    }
    scored.sort((x, y) => y.v - x.v);
    if (L.depth < 2 || more) return scored[0].a;

    let best = null, bestV = -Infinity;
    for (const c of scored.slice(0, L.top)) {
      const v = replyValue(c.s2, p, bestV) + (Math.random() - 0.5) * L.noise;
      if (v > bestV) { bestV = v; best = c.a; }
    }
    return best;
  }

  // CPU の 1 ターン分の行動（0〜2 個）を返す
  function plan(s, level) {
    const out = [];
    let cur = s;
    while (cur.winner === null && cur.actionsLeft > 0) {
      const seq = pickBest(cur, E.turnSequences(cur), level);
      if (!seq) break;
      for (const a of seq) out.push(a);
      cur = E.applySeq(cur, seq);
    }
    // 生産は建物ごとに1回ずつ。「生産しない」を選ぶまで繰り返す
    while (cur.winner === null) {
      const pa = E.produceActions(cur).map(a => [a]);
      if (!pa.length) break;
      const b = pickBest(cur, pa, level);
      if (!b) break;
      out.push(b[0]);
      cur = E.apply(cur, b[0]);
    }
    return out;
  }

  global.AI = { plan, evaluate, LEVELS };
})(typeof window !== 'undefined' ? window : globalThis);
