/*
 * 鉄盤戦線 — ルールエンジン
 * 盤面状態は純粋なデータとして扱い、apply / endTurn は常に新しい状態を返す。
 * （AI の探索でも同じ関数をそのまま使う）
 */
(function (global) {
  'use strict';

  const SIZE = 9;
  const N = SIZE * SIZE;
  const MAX_UNITS = 16;
  const MAX_ROUNDS = 80;
  const ACTIONS_PER_TURN = 2;
  // 陣営（0 = シアン・先手 / 1 = マゼンタ・後手）。名前を変えるときはここだけ直せばよい
  const FACTIONS = [
    { name: 'アークライト社', en: 'ARCLIGHT CORP.', desc: '都市を支配する巨大企業。警備部隊と自律兵器で秩序を敷く。' },
    { name: '緋蛇会', en: 'HIDAKAI SYNDICATE', desc: '地下ネットと闇市場を牛耳るサイバー極道。改造兵器で企業支配に抗う。' },
  ];
  const P_NAMES = FACTIONS.map(f => f.name);

  const UNIT_TYPES = {
    infantry: {
      key: 'infantry', name: '歩兵', cost: 2, hp: 1, atk: 1, air: false, vehicle: false,
      move: '縦横に1マス', attack: '周囲8マス（攻撃力1）',
      note: '建物（工場・首都）を占領できる唯一の駒。自マスに塹壕を掘れる。ドローンを攻撃できる。',
    },
    drone: {
      key: 'drone', name: 'ドローン', cost: 3, hp: 1, atk: 1, air: true, vehicle: false,
      move: '距離3以内の好きなマスへ飛行（駒・ビル群を飛び越える）', attack: '周囲8マス（車両に2、他に1）',
      note: '塹壕の防御を無視。戦車・自走砲からは攻撃されない。歩兵に弱い。',
    },
    artillery: {
      key: 'artillery', name: '自走砲', cost: 5, hp: 2, atk: 2, air: false, vehicle: true,
      move: '周囲8方向に1マス', attack: 'ちょうど距離2のマスを砲撃（攻撃力2）',
      note: '間接射撃なので間に駒やビル群があっても撃てる。隣接マスとドローンは撃てない。',
    },
    tank: {
      key: 'tank', name: '戦車', cost: 6, hp: 3, atk: 2, air: false, vehicle: true,
      move: '縦横に最大2マス直進（飛び越え不可）', attack: '周囲8マス（攻撃力2）',
      note: '高耐久の主力。塹壕マスには進入できない。ドローンは攻撃できない。',
    },
    missile: {
      key: 'missile', name: 'ミサイル', cost: 7, hp: 1, atk: 3, air: false, vehicle: true,
      move: '縦横に1マス', attack: '距離4以内の任意のマスへ発射（使い捨て）',
      note: '着弾マスに3ダメージ（塹壕無視・塹壕破壊）、縦横に隣接するマスに1ダメージ。味方も巻き込む。',
    },
  };
  const UNIT_ORDER = ['infantry', 'drone', 'artillery', 'tank', 'missile'];
  // 移動後に続けて攻撃できる駒（自走砲・ミサイルは移動か攻撃のどちらか一方）
  const MOVE_THEN_ATTACK = { infantry: true, drone: true, tank: true };

  const DIR4 = [[0, -1], [1, 0], [0, 1], [-1, 0]];
  const DIR8 = DIR4.concat([[1, -1], [1, 1], [-1, 1], [-1, -1]]);

  // 盤面は (x, y) → (8-x, 8-y) の点対称。陣営 0 が下側（y=8）。
  const MAP = {
    mountains: [[2, 2], [6, 6], [6, 3], [2, 5]],
    neutralFactories: [[1, 4], [4, 4], [7, 4]],
    capitals: [[4, 8], [4, 0]],
    homeFactories: [[6, 7], [2, 1]],
    trenches: [[4, 7], [4, 1]],
    units: [
      ['infantry', 3, 7], ['infantry', 4, 7], ['infantry', 5, 7],
      ['tank', 3, 8], ['artillery', 5, 8], ['drone', 6, 8],
    ],
  };

  const FILES = 'ABCDEFGHI';

  function idx(x, y) { return y * SIZE + x; }
  function inB(x, y) { return x >= 0 && y >= 0 && x < SIZE && y < SIZE; }
  function cheb(ax, ay, bx, by) { return Math.max(Math.abs(ax - bx), Math.abs(ay - by)); }
  function manh(ax, ay, bx, by) { return Math.abs(ax - bx) + Math.abs(ay - by); }
  // 座標表記：列は左から A〜I、行は陣営 0 の側（下）から 1〜9
  function coordName(x, y) { return FILES[x] + (SIZE - y); }

  function newGame() {
    const terrain = new Array(N).fill('P');
    const building = new Array(N).fill(null);
    const owner = new Int8Array(N).fill(-1);
    const trench = new Uint8Array(N);
    for (const [x, y] of MAP.mountains) terrain[idx(x, y)] = 'M';
    for (const [x, y] of MAP.neutralFactories) building[idx(x, y)] = 'F';
    MAP.capitals.forEach(([x, y], p) => { building[idx(x, y)] = 'C'; owner[idx(x, y)] = p; });
    MAP.homeFactories.forEach(([x, y], p) => { building[idx(x, y)] = 'F'; owner[idx(x, y)] = p; });
    for (const [x, y] of MAP.trenches) trench[idx(x, y)] = 1;

    const s = {
      terrain, building, owner, trench,
      capitals: MAP.capitals.map(c => c.slice()),
      units: [], funds: [2, 3], cur: 0, round: 1,
      actionsLeft: 0, actedIds: [], usedB: new Uint8Array(N), movedUid: null, winner: null, result: null,
      nextId: 1, events: [],
    };
    for (const [type, x, y] of MAP.units) {
      s.units.push(makeUnit(s, type, 0, x, y, false));
      s.units.push(makeUnit(s, type, 1, SIZE - 1 - x, SIZE - 1 - y, false));
    }
    startTurn(s);
    return s;
  }

  function makeUnit(s, type, owner, x, y, fresh) {
    return { id: s.nextId++, type, owner, x, y, hp: UNIT_TYPES[type].hp, fresh };
  }

  function clone(s) {
    return {
      terrain: s.terrain, building: s.building, capitals: s.capitals,
      owner: s.owner.slice(), trench: s.trench.slice(),
      units: s.units.map(u => ({ id: u.id, type: u.type, owner: u.owner, x: u.x, y: u.y, hp: u.hp, fresh: u.fresh })),
      funds: s.funds.slice(), cur: s.cur, round: s.round,
      actionsLeft: s.actionsLeft, actedIds: s.actedIds.slice(), usedB: s.usedB.slice(), movedUid: s.movedUid, winner: s.winner, result: s.result,
      nextId: s.nextId, events: [],
    };
  }

  function unitAt(s, x, y) {
    for (const u of s.units) if (u.x === x && u.y === y) return u;
    return null;
  }
  function unitById(s, id) {
    for (const u of s.units) if (u.id === id) return u;
    return null;
  }
  function occGrid(s) {
    const g = new Array(N).fill(null);
    for (const u of s.units) g[idx(u.x, u.y)] = u;
    return g;
  }

  const CAPITAL_INCOME = 2;
  const FACTORY_INCOME = 2;
  function income(s, p) {
    return CAPITAL_INCOME + FACTORY_INCOME * factoryCount(s, p);
  }
  function factoryCount(s, p) {
    let n = 0;
    for (let i = 0; i < N; i++) if (s.building[i] === 'F' && s.owner[i] === p) n++;
    return n;
  }
  function unitCount(s, p) {
    let n = 0;
    for (const u of s.units) if (u.owner === p) n++;
    return n;
  }

  // ---- 移動・攻撃ルール ----

  function moveTargets(s, u, occ) {
    occ = occ || occGrid(s);
    const res = [];
    const T = u.type;
    const ok = (x, y) => inB(x, y) && !occ[idx(x, y)] && (T === 'drone' || s.terrain[idx(x, y)] !== 'M');
    if (T === 'infantry' || T === 'missile') {
      for (const [dx, dy] of DIR4) if (ok(u.x + dx, u.y + dy)) res.push([u.x + dx, u.y + dy]);
    } else if (T === 'artillery') {
      for (const [dx, dy] of DIR8) if (ok(u.x + dx, u.y + dy)) res.push([u.x + dx, u.y + dy]);
    } else if (T === 'tank') {
      for (const [dx, dy] of DIR4) {
        for (let k = 1; k <= 2; k++) {
          const nx = u.x + dx * k, ny = u.y + dy * k;
          if (!ok(nx, ny) || s.trench[idx(nx, ny)]) break;
          res.push([nx, ny]);
        }
      }
    } else if (T === 'drone') {
      for (let dy = -3; dy <= 3; dy++) {
        for (let dx = -3; dx <= 3; dx++) {
          if ((dx || dy) && ok(u.x + dx, u.y + dy)) res.push([u.x + dx, u.y + dy]);
        }
      }
    }
    return res;
  }

  function canHit(attType, def) {
    if (UNIT_TYPES[def.type].air) return attType === 'infantry' || attType === 'drone' || attType === 'missile';
    return true;
  }

  function damageOf(s, attType, def) {
    let d = UNIT_TYPES[attType].atk;
    const DT = UNIT_TYPES[def.type];
    if (attType === 'drone' && DT.vehicle) d = 2;
    if (attType !== 'drone' && attType !== 'missile' && !DT.air && s.trench[idx(def.x, def.y)]) d -= 1;
    return Math.max(0, d);
  }

  function attackTargets(s, u, occ) {
    occ = occ || occGrid(s);
    const res = [];
    const T = u.type;
    if (T === 'missile') return res;
    const consider = (x, y) => {
      if (!inB(x, y)) return;
      const t = occ[idx(x, y)];
      if (!t || t.owner === u.owner || !canHit(T, t)) return;
      if (damageOf(s, T, t) <= 0) return;
      res.push(t);
    };
    if (T === 'artillery') {
      for (let dy = -2; dy <= 2; dy++) {
        for (let dx = -2; dx <= 2; dx++) {
          if (Math.max(Math.abs(dx), Math.abs(dy)) === 2) consider(u.x + dx, u.y + dy);
        }
      }
    } else {
      for (const [dx, dy] of DIR8) consider(u.x + dx, u.y + dy);
    }
    return res;
  }

  function launchTargets(s, u) {
    const res = [];
    if (u.type !== 'missile') return res;
    for (let dy = -4; dy <= 4; dy++) {
      for (let dx = -4; dx <= 4; dx++) {
        if ((dx || dy) && inB(u.x + dx, u.y + dy)) res.push([u.x + dx, u.y + dy]);
      }
    }
    return res;
  }

  // ミサイルが (x, y) に着弾したときのダメージ一覧 [[unit, dmg], ...]
  function missileImpact(s, x, y, occ) {
    occ = occ || occGrid(s);
    const res = [];
    const t = occ[idx(x, y)];
    if (t) res.push([t, UNIT_TYPES.missile.atk]);
    for (const [dx, dy] of DIR4) {
      const nx = x + dx, ny = y + dy;
      if (!inB(nx, ny)) continue;
      const v = occ[idx(nx, ny)];
      if (!v) continue;
      const protectedByTrench = !UNIT_TYPES[v.type].air && s.trench[idx(nx, ny)];
      if (!protectedByTrench) res.push([v, 1]);
    }
    return res;
  }

  function canDig(s, u) {
    const i = idx(u.x, u.y);
    return u.type === 'infantry' && !s.trench[i] && !s.building[i] && s.terrain[i] === 'P';
  }

  // 建物の周囲8マス（建物自身を含む）に敵の駒がいると包囲状態になり生産できない
  function isSieged(s, x, y, p, occ) {
    occ = occ || occGrid(s);
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        if (!inB(x + dx, y + dy)) continue;
        const u = occ[idx(x + dx, y + dy)];
        if (u && u.owner !== p) return true;
      }
    }
    return false;
  }

  // 今ターンまだ生産していない、包囲されていない自軍の建物
  function readyBuildings(s, p, occ) {
    occ = occ || occGrid(s);
    const res = [];
    for (let i = 0; i < N; i++) {
      if (!s.building[i] || s.owner[i] !== p || s.usedB[i]) continue;
      if (isSieged(s, i % SIZE, (i / SIZE) | 0, p, occ)) continue;
      res.push(i);
    }
    return res;
  }

  // 生産可能なマス [x, y, 生産に使う建物の index]
  function placeCells(s, p, type) {
    if (unitCount(s, p) >= MAX_UNITS) return [];
    const occ = occGrid(s);
    const seen = new Uint8Array(N);
    const res = [];
    for (const i of readyBuildings(s, p, occ)) {
      const bx = i % SIZE, by = (i / SIZE) | 0;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const x = bx + dx, y = by + dy;
          if (!inB(x, y)) continue;
          const j = idx(x, y);
          if (seen[j] || occ[j] || s.terrain[j] === 'M') continue;
          if (type === 'tank' && s.trench[j]) continue;
          seen[j] = 1;
          res.push([x, y, i]);
        }
      }
    }
    return res;
  }

  // ---- 合法手の列挙 ----

  function unitActions(s) {
    if (s.actionsLeft <= 0 || s.winner !== null) return [];
    const occ = occGrid(s);
    const res = [];
    if (s.movedUid !== null) {
      // 移動済みの駒は攻撃するか待機するかのみ
      const u = unitById(s, s.movedUid);
      for (const t of attackTargets(s, u, occ)) res.push({ type: 'attack', uid: u.id, x: t.x, y: t.y });
      res.push({ type: 'wait', uid: u.id });
      return res;
    }
    for (const u of s.units) {
      if (u.owner !== s.cur || u.fresh || s.actedIds.includes(u.id)) continue;
      for (const [x, y] of moveTargets(s, u, occ)) res.push({ type: 'move', uid: u.id, x, y });
      for (const t of attackTargets(s, u, occ)) res.push({ type: 'attack', uid: u.id, x: t.x, y: t.y });
      if (canDig(s, u)) res.push({ type: 'dig', uid: u.id });
      for (const [x, y] of launchTargets(s, u)) res.push({ type: 'launch', uid: u.id, x, y });
    }
    return res;
  }

  // AI 用：1ターンの駒の行動を「移動→攻撃」まで含めた手順の列として列挙
  function turnSequences(s) {
    const res = [];
    for (const a of unitActions(s)) {
      if (a.type !== 'move') { res.push([a]); continue; }
      const s1 = apply(s, a);
      if (s1.movedUid === null) { res.push([a]); continue; }
      res.push([a, { type: 'wait', uid: a.uid }]);
      for (const b of unitActions(s1)) if (b.type === 'attack') res.push([a, b]);
    }
    return res;
  }

  function applySeq(s, seq) {
    for (const a of seq) s = apply(s, a);
    return s;
  }

  function produceActions(s) {
    if (s.winner !== null) return [];
    const res = [];
    for (const type of UNIT_ORDER) {
      if (UNIT_TYPES[type].cost > s.funds[s.cur]) continue;
      for (const [x, y, b] of placeCells(s, s.cur, type)) res.push({ type: 'produce', unitType: type, x, y, b });
    }
    return res;
  }

  function canProduceAnything(s) {
    if (s.winner !== null) return false;
    return UNIT_ORDER.some(t => UNIT_TYPES[t].cost <= s.funds[s.cur] && placeCells(s, s.cur, t).length > 0);
  }

  // ---- 状態遷移 ----

  function ev(s, kind, text, x, y, extra) {
    s.events.push(Object.assign({ kind, text, x, y, p: s.cur }, extra || {}));
  }

  function hit(s, target, dmg) {
    if (dmg <= 0) return;
    target.hp -= dmg;
    const nm = `${P_NAMES[target.owner]}の${UNIT_TYPES[target.type].name}`;
    if (target.hp <= 0) {
      s.units = s.units.filter(v => v !== target);
      ev(s, 'kill', `${nm}（${coordName(target.x, target.y)}）を撃破`, target.x, target.y, { dmg });
    } else {
      ev(s, 'hit', `${nm}（${coordName(target.x, target.y)}）に${dmg}ダメージ（残り${target.hp}）`, target.x, target.y, { dmg });
    }
  }

  function apply(s, a) {
    const n = clone(s);
    const p = n.cur;
    const PN = P_NAMES[p];

    if (a.type === 'produce') {
      const T = UNIT_TYPES[a.unitType];
      n.funds[p] -= T.cost;
      n.units.push(makeUnit(n, a.unitType, p, a.x, a.y, true));
      n.usedB[a.b] = 1;
      ev(n, 'produce', `${PN}：${T.name}を${coordName(a.x, a.y)}に生産（-${T.cost}）`, a.x, a.y);
      return n;
    }

    const u = unitById(n, a.uid);
    const UN = UNIT_TYPES[u.type].name;
    n.movedUid = null;

    if (a.type === 'move') {
      const fx = u.x, fy = u.y;
      u.x = a.x; u.y = a.y;
      ev(n, 'move', `${PN}：${UN} ${coordName(fx, fy)}→${coordName(a.x, a.y)}`, a.x, a.y, { fx, fy });
      const i = idx(a.x, a.y);
      if (u.type === 'infantry' && n.building[i] && n.owner[i] !== p) {
        const prev = n.owner[i];
        n.owner[i] = p;
        if (n.building[i] === 'C') {
          n.winner = p;
          n.result = 'capital';
          ev(n, 'capture', `${PN}が${P_NAMES[prev]}の首都を占領！`, a.x, a.y);
        } else {
          ev(n, 'capture', `${PN}が工場（${coordName(a.x, a.y)}）を占領${prev >= 0 ? `（${P_NAMES[prev]}から奪取）` : ''}`, a.x, a.y);
        }
      }
      if (n.winner === null && MOVE_THEN_ATTACK[u.type] && attackTargets(n, u).length) {
        n.movedUid = u.id; // 続けて攻撃するか待機するかを選ぶ
      }
    } else if (a.type === 'attack') {
      const t = unitAt(n, a.x, a.y);
      const dmg = damageOf(n, u.type, t);
      ev(n, 'attack', `${PN}：${UN}（${coordName(u.x, u.y)}）が攻撃`, u.x, u.y, { tx: a.x, ty: a.y });
      hit(n, t, dmg);
    } else if (a.type === 'dig') {
      n.trench[idx(u.x, u.y)] = 1;
      ev(n, 'dig', `${PN}：${UN}が${coordName(u.x, u.y)}に塹壕を構築`, u.x, u.y);
    } else if (a.type === 'launch') {
      n.units = n.units.filter(v => v !== u);
      ev(n, 'boom', `${PN}：ミサイルを${coordName(u.x, u.y)}から${coordName(a.x, a.y)}へ発射！`, a.x, a.y, { fx: u.x, fy: u.y });
      const impacts = missileImpact(n, a.x, a.y);
      const ti = idx(a.x, a.y);
      if (n.trench[ti]) {
        n.trench[ti] = 0;
        ev(n, 'dig', `${coordName(a.x, a.y)}の塹壕が破壊された`, a.x, a.y);
      }
      for (const [v, d] of impacts) hit(n, v, d);
    }
    if (n.movedUid === null) {
      n.actionsLeft--;
      n.actedIds.push(u.id);
    }
    return n;
  }

  function startTurn(s) {
    const p = s.cur;
    const inc = income(s, p);
    s.funds[p] += inc;
    s.actionsLeft = ACTIONS_PER_TURN;
    s.actedIds = [];
    s.usedB = new Uint8Array(N);
    s.movedUid = null;
    for (const u of s.units) {
      if (u.owner !== p) continue;
      const i = idx(u.x, u.y);
      if (s.building[i] && s.owner[i] === p && u.hp < UNIT_TYPES[u.type].hp) {
        u.hp++;
        ev(s, 'heal', `${P_NAMES[p]}の${UNIT_TYPES[u.type].name}（${coordName(u.x, u.y)}）が補給で1回復`, u.x, u.y);
      }
    }
    ev(s, 'turn', `― ${P_NAMES[p]}のターン（収入 +${inc}）―`);
  }

  function score(s, p) {
    let v = s.funds[p] + income(s, p) * 5;
    for (const u of s.units) {
      if (u.owner === p) v += UNIT_TYPES[u.type].cost * u.hp / UNIT_TYPES[u.type].hp;
    }
    return v;
  }

  function endTurn(s) {
    const n = clone(s);
    if (n.winner !== null) return n;
    for (const u of n.units) u.fresh = false;
    n.cur = 1 - n.cur;
    if (n.cur === 0) n.round++;
    if (n.round > MAX_ROUNDS) {
      const a = score(n, 0), b = score(n, 1);
      n.winner = a > b ? 0 : b > a ? 1 : -1;
      n.result = 'judge';
      ev(n, 'turn', `${MAX_ROUNDS}ラウンド経過。判定 ${P_NAMES[0]} ${a.toFixed(1)} : ${P_NAMES[1]} ${b.toFixed(1)}`);
      return n;
    }
    startTurn(n);
    return n;
  }

  function resign(s) {
    const n = clone(s);
    n.winner = 1 - n.cur;
    n.result = 'resign';
    ev(n, 'turn', `${P_NAMES[n.cur]}が投了`);
    return n;
  }

  global.Engine = {
    FACTIONS, SIZE, N, MAX_UNITS, MAX_ROUNDS, ACTIONS_PER_TURN, CAPITAL_INCOME, FACTORY_INCOME, P_NAMES, UNIT_TYPES, UNIT_ORDER, MOVE_THEN_ATTACK, DIR4, DIR8,
    idx, inB, cheb, manh, coordName,
    newGame, clone, unitAt, unitById, occGrid, income, factoryCount, unitCount,
    moveTargets, attackTargets, launchTargets, missileImpact, canDig, canHit, damageOf, placeCells, isSieged, readyBuildings,
    unitActions, turnSequences, applySeq, produceActions, canProduceAnything, apply, endTurn, resign, score,
  };
})(typeof window !== 'undefined' ? window : globalThis);
