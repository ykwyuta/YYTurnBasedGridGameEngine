/*
 * 鉄盤戦線 — 画面表示と操作
 */
(function () {
  'use strict';
  const E = window.Engine;
  const AI = window.AI;
  const UT = E.UNIT_TYPES;
  const $ = id => document.getElementById(id);

  const app = {
    G: null,
    human: [true, false],
    level: 'normal',
    flip: false,
    sel: null,          // {kind:'unit', uid} | {kind:'produce', type} | {kind:'launch', uid} | {kind:'cell', i}
    hover: -1,
    busy: false,
    token: 0,           // 新しいゲームを始めたら古い CPU 処理を破棄するため
    last: [],           // 直前の手で動いたマス
    hl: new Map(),
  };

  const cells = [];

  // ユニット・建物のアイコン（32×32 の線画 SVG）
  const ICON_PATHS = {
    infantry: '<circle cx="14" cy="7" r="3.6"/><path d="M8 29v-9.5a6 6 0 0 1 12 0V29"/><path d="M11 29v-5M17 29v-5"/><path d="M19 17l9-9M25 8l3 3"/>',
    drone: '<rect x="12.5" y="12.5" width="7" height="7" rx="1.5"/><path d="M12.5 12.5 9 9M19.5 12.5 23 9M12.5 19.5 9 23M19.5 19.5 23 23"/><ellipse cx="7" cy="7" rx="4.5" ry="1.6"/><ellipse cx="25" cy="7" rx="4.5" ry="1.6"/><ellipse cx="7" cy="25" rx="4.5" ry="1.6"/><ellipse cx="25" cy="25" rx="4.5" ry="1.6"/><circle cx="16" cy="16" r="1" fill="currentColor"/>',
    artillery: '<rect x="4" y="19" width="22" height="7" rx="3.5"/><path d="M9 19v-4h10v4"/><path d="M17 15 28 5"/><path d="M25 4l4 4"/><circle cx="9" cy="22.5" r="1.3"/><circle cx="15" cy="22.5" r="1.3"/><circle cx="21" cy="22.5" r="1.3"/>',
    tank: '<rect x="3" y="17" width="26" height="9" rx="4.5"/><path d="M8 17v-4l3-3h8l3 3v4"/><path d="M19 12h11"/><circle cx="8" cy="21.5" r="1.5"/><circle cx="16" cy="21.5" r="1.5"/><circle cx="24" cy="21.5" r="1.5"/>',
    missile: '<path d="M16 2.5c4 4 5.5 9 5.5 14V23h-11v-6.5c0-5 1.5-10 5.5-14z"/><path d="M10.5 18 6 23.5V27l4.5-2.5M21.5 18l4.5 5.5V27l-4.5-2.5"/><path d="M13.5 26.5 16 30l2.5-3.5"/><circle cx="16" cy="11.5" r="2"/>',
    factory: '<path d="M3 28V15l7 4.5V15l7 4.5V15l7 4.5V5h4v23z"/><path d="M8 24h3M14 24h3M20 24h3"/>',
    capital: '<path d="M16 2.5 28 9.5v13L16 29.5 4 22.5v-13z"/><path d="M16 9l6 3.5v7L16 23l-6-3.5v-7z"/><circle cx="16" cy="16" r="2" fill="currentColor"/>',
  };
  function icon(key, cls) {
    return `<svg class="ico ${cls || ''}" viewBox="0 0 32 32" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICON_PATHS[key]}</svg>`;
  }
  function token(type, owner, extra) {
    return `<span class="token p${owner}${extra || ''}"><span class="hex">${icon(type)}</span></span>`;
  }

  // ---------- 初期化 ----------

  function init() {
    const board = $('board');
    for (let i = 0; i < E.N; i++) {
      const c = document.createElement('div');
      c.className = 'cell';
      c.dataset.i = i;
      board.appendChild(c);
      cells.push(c);
    }
    const fx = document.createElement('div');
    fx.className = 'fx-layer';
    fx.id = 'fx';
    board.appendChild(fx);

    board.addEventListener('click', e => {
      const c = e.target.closest('.cell');
      if (c) onCell(+c.dataset.i);
    });
    board.addEventListener('mouseover', e => {
      const c = e.target.closest('.cell');
      const i = c ? +c.dataset.i : -1;
      if (i !== app.hover) {
        app.hover = i;
        if (app.sel && app.sel.kind === 'launch') renderBoard();
      }
    });
    board.addEventListener('mouseleave', () => {
      app.hover = -1;
      if (app.sel && app.sel.kind === 'launch') renderBoard();
    });

    $('btn-new').addEventListener('click', () => $('dlg-new').showModal());
    $('btn-rules').addEventListener('click', () => $('dlg-rules').showModal());
    $('btn-end').addEventListener('click', onEndTurn);
    $('btn-resign').addEventListener('click', onResign);
    $('dlg-new').addEventListener('close', () => {
      if ($('dlg-new').returnValue !== 'ok') return;
      const f = $('dlg-new').querySelector('form');
      startGame(f.mode.value, f.level.value);
    });
    $('dlg-result').addEventListener('close', () => {
      if ($('dlg-result').returnValue === 'new') $('dlg-new').showModal();
    });
    document.addEventListener('keydown', e => {
      if (e.key === 'Escape' && !document.querySelector('dialog[open]')) { app.sel = null; render(); }
    });

    fillRules();
    startGame('cpu0', 'normal');
    $('dlg-rules').showModal();
  }

  function fillRules() {
    $('rule-rounds').textContent = E.MAX_ROUNDS;
    $('rule-cap-inc').textContent = E.CAPITAL_INCOME;
    $('rule-fac-inc').textContent = E.FACTORY_INCOME;
    $('rule-actions').textContent = E.ACTIONS_PER_TURN;
    $('mode-cpu0').textContent = `CPU と対戦（あなたが${E.P_NAMES[0]}・先手）`;
    $('mode-cpu1').textContent = `CPU と対戦（あなたが${E.P_NAMES[1]}・後手）`;
    $('rule-factions').innerHTML = E.FACTIONS.map((f, p) =>
      `<li><b class="fc p${p}">${f.name}</b> <small>${f.en}</small>（${p === 0 ? 'シアン・先手' : 'マゼンタ・後手'}）— ${f.desc}</li>`).join('');
    let h = '<thead><tr><th>駒</th><th>コスト</th><th>耐久</th><th>移動</th><th>攻撃</th><th>特徴</th></tr></thead><tbody>';
    for (const k of E.UNIT_ORDER) {
      const t = UT[k];
      h += `<tr><td class="ut-name">${token(k, 0, ' mini')}${t.name}</td><td>${t.cost}</td><td>${t.hp}</td>` +
        `<td>${t.move}</td><td>${t.attack}</td><td>${t.note}</td></tr>`;
    }
    $('unit-table').innerHTML = h + '</tbody>';
  }

  function startGame(mode, level) {
    app.token++;
    app.G = E.newGame();
    app.level = level;
    app.human = mode === 'cpu0' ? [true, false] : mode === 'cpu1' ? [false, true] : mode === 'hot' ? [true, true] : [false, false];
    app.flip = mode === 'cpu1';
    app.sel = null;
    app.busy = false;
    app.last = [];
    $('log').innerHTML = '';
    $('fx').innerHTML = '';
    renderLabels();
    pushLog(app.G.events);
    render();
    proceed();
  }

  // ---------- 座標（盤の向き） ----------

  function viewPos(x, y) { return app.flip ? [E.SIZE - 1 - x, E.SIZE - 1 - y] : [x, y]; }
  function cellFor(x, y) { const [vx, vy] = viewPos(x, y); return cells[vy * E.SIZE + vx]; }
  function boardIndexOfView(vi) {
    const vx = vi % E.SIZE, vy = (vi / E.SIZE) | 0;
    const [x, y] = viewPos(vx, vy);
    return E.idx(x, y);
  }

  function renderLabels() {
    let f = '', r = '';
    for (let v = 0; v < E.SIZE; v++) {
      const x = app.flip ? E.SIZE - 1 - v : v;
      const y = app.flip ? E.SIZE - 1 - v : v;
      f += `<span>${'ABCDEFGHI'[x]}</span>`;
      r += `<span>${E.SIZE - y}</span>`;
    }
    $('files').innerHTML = f;
    $('ranks').innerHTML = r;
  }

  // ---------- 状態の問い合わせ ----------

  function humanTurn() { return app.G.winner === null && app.human[app.G.cur] && !app.busy; }

  function canActWith(u) {
    const G = app.G;
    return humanTurn() && u.owner === G.cur && !u.fresh && G.actionsLeft > 0 &&
      G.movedUid === null && !G.actedIds.includes(u.id);
  }

  function computeHighlights() {
    const G = app.G;
    const hl = new Map();
    const sel = app.sel;
    const pending = G.movedUid !== null && humanTurn() ? E.unitById(G, G.movedUid) : null;

    if (sel && sel.kind === 'produce' && humanTurn()) {
      for (const [x, y] of E.placeCells(G, G.cur, sel.type)) hl.set(E.idx(x, y), 'place');
    } else if (pending) {
      for (const t of E.attackTargets(G, pending)) hl.set(E.idx(t.x, t.y), 'attack');
    } else if (sel && sel.kind === 'launch') {
      const u = E.unitById(G, sel.uid);
      if (u) {
        for (const [x, y] of E.launchTargets(G, u)) hl.set(E.idx(x, y), 'launch');
        if (app.hover >= 0) {
          const bi = boardIndexOfView(app.hover);
          if (hl.has(bi)) {
            const tx = bi % E.SIZE, ty = (bi / E.SIZE) | 0;
            hl.set(bi, 'splash-center');
            for (const [dx, dy] of E.DIR4) {
              if (E.inB(tx + dx, ty + dy)) hl.set(E.idx(tx + dx, ty + dy), 'splash');
            }
          }
        }
      }
    } else if (sel && sel.kind === 'unit') {
      const u = E.unitById(G, sel.uid);
      if (u && canActWith(u)) {
        for (const [x, y] of E.moveTargets(G, u)) hl.set(E.idx(x, y), 'move');
        for (const t of E.attackTargets(G, u)) hl.set(E.idx(t.x, t.y), 'attack');
      } else if (u) {
        // 相手や行動済みの駒は「届く範囲」を薄く表示する
        for (const [x, y] of E.moveTargets(G, u)) hl.set(E.idx(x, y), 'emove');
        for (const [x, y] of reachCells(G, u)) {
          const i = E.idx(x, y);
          if (!hl.has(i)) hl.set(i, 'eatk');
        }
      }
    }
    app.hl = hl;
  }

  // 攻撃が届きうるマス（相手の駒の脅威範囲の表示用）
  function reachCells(G, u) {
    const out = [];
    const add = (x, y) => { if (E.inB(x, y) && !(x === u.x && y === u.y)) out.push([x, y]); };
    if (u.type === 'artillery') {
      for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) if (Math.max(Math.abs(dx), Math.abs(dy)) === 2) add(u.x + dx, u.y + dy);
    } else if (u.type === 'missile') {
      for (let dy = -4; dy <= 4; dy++) for (let dx = -4; dx <= 4; dx++) add(u.x + dx, u.y + dy);
    } else {
      for (const [dx, dy] of E.DIR8) add(u.x + dx, u.y + dy);
    }
    return out;
  }

  // ---------- 描画 ----------

  function render() {
    computeHighlights();
    renderBoard();
    renderBars();
    renderTurn();
    renderProduce();
    renderInfo();
  }

  function renderBoard() {
    if (app.sel && app.sel.kind === 'launch') computeHighlights();
    const G = app.G;
    const occ = E.occGrid(G);
    const selUid = app.sel && (app.sel.kind === 'unit' || app.sel.kind === 'launch') ? app.sel.uid : (G.movedUid !== null ? G.movedUid : null);
    const lastSet = new Set(app.last);
    for (let y = 0; y < E.SIZE; y++) {
      for (let x = 0; x < E.SIZE; x++) {
        const i = E.idx(x, y);
        const c = cellFor(x, y);
        const cls = ['cell'];
        if (G.terrain[i] === 'M') cls.push('mtn');
        if (G.trench[i]) cls.push('trench');
        const b = G.building[i];
        if (b) cls.push(b === 'C' ? 'bld-c' : 'bld-f', G.owner[i] < 0 ? 'own-n' : 'own' + G.owner[i]);
        if (b && G.owner[i] >= 0 && E.isSieged(G, x, y, G.owner[i], occ)) cls.push('sieged');
        if (lastSet.has(i)) cls.push('last');
        const h = app.hl.get(i);
        if (h) cls.push('hl-' + h);
        const u = occ[i];
        if (u && u.id === selUid) cls.push('selected');
        if (app.sel && app.sel.kind === 'cell' && app.sel.i === i) cls.push('selected');
        c.className = cls.join(' ');

        let html = '';
        if (G.terrain[i] === 'M') html += '<span class="tower"></span>';
        if (b) html += `<span class="bld-label">${icon(b === 'C' ? 'capital' : 'factory', 'bld-ico')}<em>${b === 'C' ? 'HQ' : 'FAB'}</em></span>`;
        if (u) {
          const T = UT[u.type];
          const done = u.owner === G.cur && (u.fresh || G.actedIds.includes(u.id)) ? ' done' : '';
          html += `<div class="unit">${token(u.type, u.owner, done + (T.air ? ' air' : ''))}</div>`;
          let pips = '';
          for (let k = 0; k < T.hp; k++) pips += `<i class="${k < u.hp ? 'on' : ''}"></i>`;
          html += `<div class="hp p${u.owner}">${pips}</div>`;
        }
        c.innerHTML = html;
      }
    }
  }

  function renderBars() {
    const G = app.G;
    for (const p of [0, 1]) {
      const bar = $('bar-' + p);
      const who = app.human[p] ? (app.human[1 - p] ? 'プレイヤー' : 'あなた') : 'CPU';
      const active = G.cur === p && G.winner === null;
      bar.className = `player-bar p${p}${active ? ' active' : ''}`;
      bar.innerHTML =
        `<span class="pname">${E.P_NAMES[p]}<small class="en">${E.FACTIONS[p].en}</small><small>${who}</small></span>` +
        `<span class="stat" title="資金">CR <b>${G.funds[p]}</b></span>` +
        `<span class="stat" title="1ターンあたりの収入">収入 <b>+${E.income(G, p)}</b></span>` +
        `<span class="stat" title="所有工場数">工場 <b>${E.factoryCount(G, p)}</b></span>` +
        `<span class="stat" title="駒の数 / 上限">駒 <b>${E.unitCount(G, p)}</b>/${E.MAX_UNITS}</span>`;
    }
    // 自分側のバーを盤の下に
    const area = document.querySelector('.board-area');
    const frame = area.querySelector('.board-frame');
    const bottom = $(app.flip ? 'bar-1' : 'bar-0');
    const top = $(app.flip ? 'bar-0' : 'bar-1');
    if (area.firstElementChild !== top) {
      area.insertBefore(top, frame);
      area.appendChild(bottom);
    }
  }

  function renderTurn() {
    const G = app.G;
    const p = G.cur;
    let hint;
    if (G.winner !== null) {
      hint = '対局終了。「新しいゲーム」で再戦できます。';
    } else if (!app.human[p]) {
      hint = 'CPU が考えています…';
    } else if (G.movedUid !== null) {
      hint = '移動した駒で攻撃する相手（赤い照準）を選ぶか、「待機」を押してください。';
    } else if (app.sel && app.sel.kind === 'produce') {
      hint = `${UT[app.sel.type].name}を置くマス（光っているマス）を選んでください。`;
    } else if (app.sel && app.sel.kind === 'launch') {
      hint = 'ミサイルの着弾地点を選んでください（オレンジ）。縦横に隣接するマスも巻き込みます。';
    } else if (G.actionsLeft > 0) {
      hint = '動かす駒を選ぶか、生産パネルから駒を生産してください。';
    } else {
      hint = '行動は使い切りました。生産を済ませたら「ターン終了」。';
    }
    const dots = Array.from({ length: E.ACTIONS_PER_TURN }, (_, k) => `<i class="${k < G.actionsLeft ? 'on' : ''}"></i>`).join('');
    $('turn-panel').innerHTML =
      `<div class="turn-head p${p}"><span class="turn-name">${E.P_NAMES[p]}の番</span>` +
      `<span class="round">ラウンド ${Math.min(G.round, E.MAX_ROUNDS)} / ${E.MAX_ROUNDS}</span></div>` +
      `<div class="actions-left">残り行動 <span class="dots">${dots}</span></div>` +
      `<p class="hint">${hint}</p>`;
    $('btn-end').disabled = !humanTurn();
    $('btn-resign').disabled = !humanTurn();
  }

  function renderProduce() {
    const G = app.G;
    const p = G.cur;
    const ready = E.readyBuildings(G, p).length;
    $('produce-sub').textContent = G.winner === null ? `生産できる拠点 ${ready}` : '';
    const list = $('produce-list');
    let h = '';
    for (const k of E.UNIT_ORDER) {
      const T = UT[k];
      const can = humanTurn() && T.cost <= G.funds[p] && E.placeCells(G, p, k).length > 0;
      const on = app.sel && app.sel.kind === 'produce' && app.sel.type === k;
      h += `<button type="button" class="prod p${p}${on ? ' on' : ''}" data-type="${k}" ${can ? '' : 'disabled'}>` +
        `${token(k, p, ' mini')}<span class="pn">${T.name}</span><span class="cost">${T.cost}</span></button>`;
    }
    list.innerHTML = h;
    list.querySelectorAll('button.prod').forEach(btn => btn.addEventListener('click', () => {
      const t = btn.dataset.type;
      app.sel = app.sel && app.sel.kind === 'produce' && app.sel.type === t ? null : { kind: 'produce', type: t };
      render();
    }));
  }

  function renderInfo() {
    const G = app.G;
    const info = $('info');
    const acts = $('unit-actions');
    acts.innerHTML = '';
    let u = null, i = -1;
    if (app.sel && (app.sel.kind === 'unit' || app.sel.kind === 'launch')) u = E.unitById(G, app.sel.uid);
    else if (app.sel && app.sel.kind === 'cell') i = app.sel.i;
    else if (app.sel && app.sel.kind === 'produce') {
      const T = UT[app.sel.type];
      info.innerHTML = unitCard(T, null);
      return;
    }
    if (!u && G.movedUid !== null) u = E.unitById(G, G.movedUid);
    if (u) i = E.idx(u.x, u.y);
    if (i < 0) {
      info.innerHTML = '<p class="muted">盤上のマスや駒をクリックすると詳細が表示されます。</p>';
      return;
    }
    let h = u ? unitCard(UT[u.type], u) : '';
    h += `<p class="cellinfo">${cellDesc(G, i)}</p>`;
    info.innerHTML = h;

    if (!u || !humanTurn() || u.owner !== G.cur) return;
    const buttons = [];
    if (G.movedUid === u.id) {
      buttons.push(['wait', '攻撃せず待機']);
    } else if (canActWith(u)) {
      if (E.canDig(G, u)) buttons.push(['dig', '塹壕を掘る']);
      if (u.type === 'missile') buttons.push(['launch', app.sel.kind === 'launch' ? '発射をやめる' : 'ミサイル発射']);
    }
    for (const [k, label] of buttons) {
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = label;
      if (k === 'launch') b.className = 'danger';
      b.addEventListener('click', () => {
        if (k === 'wait') doAction({ type: 'wait', uid: u.id });
        else if (k === 'dig') doAction({ type: 'dig', uid: u.id });
        else if (k === 'launch') { app.sel = app.sel.kind === 'launch' ? { kind: 'unit', uid: u.id } : { kind: 'launch', uid: u.id }; render(); }
      });
      acts.appendChild(b);
    }
    if (u.fresh) acts.insertAdjacentHTML('beforeend', '<p class="muted">生産したばかりの駒は次のターンから動けます。</p>');
    else if (G.actedIds.includes(u.id)) acts.insertAdjacentHTML('beforeend', '<p class="muted">この駒はこのターン行動済みです。</p>');
  }

  function unitCard(T, u) {
    const owner = u ? `<span class="tag p${u.owner}">${E.P_NAMES[u.owner]}</span>` : '<span class="tag">生産</span>';
    const hp = u ? `${u.hp} / ${T.hp}` : `${T.hp}`;
    return `<div class="unit-card"><div class="uc-head">${token(T.key, u ? u.owner : app.G.cur, ' mini')}<b>${T.name}</b>${owner}</div>` +
      `<dl><dt>耐久</dt><dd>${hp}</dd><dt>コスト</dt><dd>${T.cost}</dd><dt>移動</dt><dd>${T.move}</dd><dt>攻撃</dt><dd>${T.attack}</dd></dl>` +
      `<p class="note">${T.note}</p></div>`;
  }

  function cellDesc(G, i) {
    const x = i % E.SIZE, y = (i / E.SIZE) | 0;
    const parts = [E.coordName(x, y)];
    if (G.terrain[i] === 'M') parts.push('ビル群（地上の駒は進入不可）');
    if (G.building[i]) {
      const own = G.owner[i] < 0 ? '中立' : E.P_NAMES[G.owner[i]];
      parts.push(`${G.building[i] === 'C' ? '首都' : '工場'}（${own}）`);
      if (G.owner[i] >= 0 && E.isSieged(G, x, y, G.owner[i])) parts.push('包囲中：生産不可');
      else if (G.owner[i] >= 0 && G.usedB[i] && G.owner[i] === G.cur) parts.push('今ターン生産済み');
    }
    if (G.trench[i]) parts.push('塹壕（地上の駒への通常攻撃 -1）');
    if (parts.length === 1) parts.push('平地');
    return parts.join(' ／ ');
  }

  // ---------- ログと演出 ----------

  function pushLog(events) {
    const log = $('log');
    for (const e of events) {
      const li = document.createElement('li');
      li.className = 'ev-' + e.kind + (e.p === 0 || e.p === 1 ? ' l' + e.p : '');
      li.textContent = e.text;
      log.prepend(li);
    }
    while (log.children.length > 300) log.lastChild.remove();
  }

  function effects(events) {
    const layer = $('fx');
    const marks = [];
    for (const e of events) {
      if (e.fx !== undefined) marks.push(E.idx(e.fx, e.fy));
      if (e.x !== undefined && e.kind !== 'turn') marks.push(E.idx(e.x, e.y));
      if (e.tx !== undefined) marks.push(E.idx(e.tx, e.ty));
      if (e.x === undefined) continue;
      const kind = { hit: 'hit', kill: 'kill', boom: 'boom', capture: 'capture', produce: 'produce', heal: 'heal', dig: 'dig' }[e.kind];
      if (!kind) continue;
      const [vx, vy] = viewPos(e.x, e.y);
      const el = document.createElement('div');
      el.className = 'fx fx-' + kind;
      el.style.left = (vx * 100 / E.SIZE) + '%';
      el.style.top = (vy * 100 / E.SIZE) + '%';
      if (e.dmg) el.innerHTML = `<span>-${e.dmg}</span>`;
      else if (kind === 'heal') el.innerHTML = '<span>+1</span>';
      layer.appendChild(el);
      setTimeout(() => el.remove(), 1100);
    }
    const units = events.filter(e => e.kind !== 'turn' && e.kind !== 'heal');
    if (units.length) app.last = marks;
  }

  // ---------- 操作 ----------

  function onCell(vi) {
    const G = app.G;
    const i = boardIndexOfView(vi);
    const x = i % E.SIZE, y = (i / E.SIZE) | 0;
    const h = app.hl.get(i);
    if (humanTurn() && h) {
      const sel = app.sel;
      if (h === 'place') return doAction(placeAction(sel.type, x, y));
      if (h === 'move') return doAction({ type: 'move', uid: sel.uid, x, y });
      if (h === 'attack') {
        const uid = G.movedUid !== null ? G.movedUid : sel.uid;
        return doAction({ type: 'attack', uid, x, y });
      }
      if (h === 'launch' || h === 'splash-center') {
        return doAction({ type: 'launch', uid: sel.uid, x, y });
      }
    }
    const u = E.unitAt(G, x, y);
    if (u) {
      app.sel = app.sel && app.sel.kind === 'unit' && app.sel.uid === u.id ? null : { kind: 'unit', uid: u.id };
    } else {
      app.sel = { kind: 'cell', i };
    }
    render();
  }

  function placeAction(type, x, y) {
    const c = E.placeCells(app.G, app.G.cur, type).find(([px, py]) => px === x && py === y);
    return { type: 'produce', unitType: type, x, y, b: c[2] };
  }

  function doAction(a) {
    const G2 = E.apply(app.G, a);
    app.G = G2;
    pushLog(G2.events);
    if (a.type === 'produce' && app.sel && app.sel.kind === 'produce' && E.placeCells(G2, G2.cur, a.unitType).length && E.UNIT_TYPES[a.unitType].cost <= G2.funds[G2.cur]) {
      // 同じ駒を続けて生産しやすいよう選択を残す
    } else {
      app.sel = G2.movedUid !== null ? { kind: 'unit', uid: G2.movedUid } : null;
    }
    render();
    effects(G2.events);
    renderBoard();
    if (G2.winner !== null) return finish();
    if (humanTurn() && G2.actionsLeft === 0 && !E.canProduceAnything(G2)) {
      const tk = app.token;
      setTimeout(() => { if (tk === app.token && humanTurn()) onEndTurn(); }, 500);
    }
  }

  function onEndTurn() {
    if (!humanTurn()) return;
    if (app.G.movedUid !== null) app.G = E.apply(app.G, { type: 'wait', uid: app.G.movedUid });
    nextTurn();
  }

  function onResign() {
    if (!humanTurn()) return;
    if (!confirm(`${E.P_NAMES[app.G.cur]}は投了しますか？`)) return;
    app.G = E.resign(app.G);
    pushLog(app.G.events);
    render();
    finish();
  }

  function nextTurn() {
    app.G = E.endTurn(app.G);
    app.sel = null;
    pushLog(app.G.events);
    render();
    effects(app.G.events.filter(e => e.kind === 'heal'));
    if (app.G.winner !== null) return finish();
    proceed();
  }

  function proceed() {
    if (app.G.winner !== null || app.human[app.G.cur]) return;
    app.busy = true;
    render();
    const tk = app.token;
    setTimeout(() => {
      if (tk !== app.token) return;
      const plan = AI.plan(app.G, app.level);
      const step = k => {
        if (tk !== app.token) return;
        if (k >= plan.length || app.G.winner !== null) {
          app.busy = false;
          if (app.G.winner !== null) { render(); return finish(); }
          return nextTurn();
        }
        app.G = E.apply(app.G, plan[k]);
        pushLog(app.G.events);
        render();
        effects(app.G.events);
        renderBoard();
        setTimeout(() => step(k + 1), plan[k].type === 'move' && app.G.movedUid !== null ? 260 : 520);
      };
      step(0);
    }, 380);
  }

  function finish() {
    const G = app.G;
    app.busy = false;
    render();
    let title, text;
    const reason = { capital: '首都を占領しました。', judge: `${E.MAX_ROUNDS}ラウンドが経過したため判定で決着しました。`, resign: '相手が投了しました。' }[G.result] || '';
    if (G.winner === -1) {
      title = '引き分け';
      text = '判定は同点でした。';
    } else {
      const solo = app.human[0] !== app.human[1];
      if (solo) title = app.human[G.winner] ? 'あなたの勝利！' : 'CPU の勝利…';
      else title = `${E.P_NAMES[G.winner]}の勝利！`;
      text = `${E.P_NAMES[G.winner]}が${reason}`;
      if (G.result === 'judge') text += `（${E.P_NAMES[0]} ${E.score(G, 0).toFixed(1)} : ${E.P_NAMES[1]} ${E.score(G, 1).toFixed(1)}）`;
    }
    $('result-title').textContent = title;
    $('result-text').textContent = text;
    setTimeout(() => $('dlg-result').showModal(), 450);
  }

  window.TetsubanApp = app; // デバッグ用
  document.addEventListener('DOMContentLoaded', init);
})();
