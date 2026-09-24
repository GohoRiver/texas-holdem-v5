(function(){
'use strict';

const G = {
  players: [], deck: [], community: [], pot: 0, currentBet: 0,
  lastRaiseAmount: 20, stage: 'preflop', dealerIndex: 0, currentPlayerIndex: 0,
  smallBlind: 1, bigBlind: 2, tableMode: 'nano', tableLabel: 'Nano',
  gameMode: 'ai',
  handNumber: 0, totalPlayers: 6,
  aiSeats: 6,
  gameOver: false, busy: false, soundOn: true,
  playerHandStartChips: 0, sessionBuyIn: 0, sessionHands: 0,
  raiseMin: 0, raiseMax: 0, seatPositions: [],
  _renderedCards: new WeakSet(), turnTimer: null, turnTimeLeft: 30,
  online: {
    active: false, isHost: false, roomId: '',
    mySeat: 0, started: false, broadcastTimer: null
  },
  _lastStateSig: '', _lastActionSig: '', _lastBoardSig: '', _lastHandSig: '',
  _timerKey: null,
  /* ★ 新增：倒计时时间戳 */
  _hostTimeout: null,
  _nextHandTimer: null,
  _nextHandEndsAt: 0,
  _turnEndsAt: 0,
  _nextHandToastTimer: null,
  _turnTickTimer: null
};

const STAGE_KEYS = {
  preflop:"stagePreflop", flop:"stageFlop", turn:"stageTurn",
  river:"stageRiver", showdown:"stageShowdown"
};

const LEVELS = [
  { key:"nano",  name:"Nano",  sb:1,     bb:2,     buyMin:100,    buyMax:500 },
  { key:"micro", name:"Micro", sb:100,   bb:200,   buyMin:4000,   buyMax:20000 },
  { key:"low",   name:"Low",   sb:500,   bb:1000,  buyMin:20000,  buyMax:100000 },
  { key:"mid",   name:"Mid",   sb:2500,  bb:5000,  buyMin:100000, buyMax:500000 },
  { key:"high",  name:"High",  sb:10000, bb:20000, buyMin:400000, buyMax:2000000 }
];

const ONLINE_MAX_SEATS = 7;
const ONLINE_MIN_SEATS = 2;
const CHIP_TO_BEM = 0.0001;
const NEXT_HAND_DELAY = 8;      // ★ 秒

/* ===== 牌对象缓存（消频闪） ===== */
const _cardCache = new Map();
function normalizeCard(c){
  if(!c || !c.rank || !c.suit) return c;
  const key = c.suit + c.rank;
  let card = _cardCache.get(key);
  if(card) return card;
  card = { rank:c.rank, suit:c.suit, value:c.value, display:c.display || (c.rank+' '+c.suit), red:!!c.red };
  _cardCache.set(key, card);
  return card;
}
function normalizeCards(arr){ return arr && arr.length ? arr.map(normalizeCard) : []; }

/* ===== 状态指纹 ===== */
function cardKey(c){ return c ? String(c.suit||'')+String(c.rank||'') : ''; }
function cardsSig(arr){ return arr && arr.length ? arr.map(cardKey).join(',') : ''; }
function buildStateSig(state){
  if(!state) return '';
  const players = (state.players || []).map(function(p){
    return [
      p.peerId || p.id, p.chips, p.folded?1:0, p.allIn?1:0,
      p.seated === false ? 0 : 1,
      p.currentBet||0, p.lastAction||'', p.position||'',
      p.revealCards?1:0, cardsSig(p.holeCards)
    ].join(':');
  }).join('|');
  return [
    state.handNumber, state.stage, state.currentPlayerIndex,
    state.pot, state.currentBet, state.dealerIndex,
    state.gameOver?1:0, state.phase || '', state.nextHandEndsAt || 0,
    cardsSig(state.community), players
  ].join('/');
}
function buildActionSig(){
  const me = G.players[myIndex()];
  if(!me) return '';
  const toCall = Math.max(0, G.currentBet - (me.currentBet || 0));
  return [
    G.handNumber, G.stage, G.currentPlayerIndex, myIndex(),
    me.folded?1:0, me.allIn?1:0, me.chips, toCall, G.currentBet
  ].join(':');
}

function $(id){ return document.getElementById(id); }
function t(k,v){ return window.PokerI18n.t(k,v); }
function sleep(ms){ return new Promise(r => setTimeout(r, ms)); }
function fmtNum(n){ return (Math.floor(n)||0).toLocaleString('en-US'); }
function toBem(chips){ return (chips * CHIP_TO_BEM).toFixed(4); }
function isEn(){ return PokerI18n.getLang() === 'en'; }

function log(msg, cls){
  const el = $("logArea"); if(!el) return;
  const div = document.createElement("div");
  div.className = "log-line" + (cls ? " " + cls : "");
  div.textContent = msg;
  el.appendChild(div); el.scrollTop = el.scrollHeight;
  updateHandInfo();
}
function clearLog(){ const e = $("logArea"); if(e) e.innerHTML = ""; }

function showScreen(name){
  ["lobbyScreen","rulesScreen","myNumbersScreen","gameScreen"].forEach(function(id){
    const el = $(id); if(el) el.classList.add("hidden");
  });
  const target = $(name + "Screen");
  if(target) target.classList.remove("hidden");
  document.querySelectorAll(".nav-link").forEach(function(a){
    a.classList.toggle("active", a.getAttribute("data-nav") === name);
  });
  if(name === "lobby") refreshBalanceUI();
  if(name === "myNumbers") renderNumbers();
}

function refreshBalanceUI(){
  const r = PokerStorage.getRealChips();
  const pts = PokerStorage.getPoints();
  const ai = PokerStorage.getAiChips();
  const rEl = $("realBalance"); if(rEl) rEl.textContent = fmtNum(r);
  const pEl = $("pointsBalance"); if(pEl) pEl.textContent = fmtNum(pts);
  const aiEl = $("aiTotalChips"); if(aiEl) aiEl.textContent = fmtNum(ai);
  const aiWon = $("aiTotalWon");
  if(aiWon){
    const s = PokerStorage.getStats();
    aiWon.textContent = (s.netGain >= 0 ? "+" : "") + fmtNum(s.netGain);
    aiWon.style.color = s.netGain >= 0 ? 'var(--green)' : 'var(--red)';
  }
  const streakEl = $("pointsStreak");
  if(streakEl){
    const st = PokerStorage.getPointsStreak();
    streakEl.textContent = isEn()
      ? (st > 0 ? "Day " + st : "Day 1")
      : (st > 0 ? "第 " + st + " 天" : "第 1 天");
  }
  if(window.PokerWallet && PokerWallet.isConnected()) PokerWallet.updateUI();
}

function renderNumbers(){
  const s = PokerStorage.getStats();
  const th = $("numTotalHands"); if(th) th.textContent = s.hands;
  const twr = $("numWinRate");
  if(twr) twr.textContent = s.hands > 0 ? Math.round(s.wins / s.hands * 100) + "%" : "0%";
  const tb = $("numBiggest"); if(tb) tb.textContent = fmtNum(s.biggestPot);
  const tn = $("numNet");
  if(tn){
    tn.textContent = (s.netGain >= 0 ? "+" : "") + fmtNum(s.netGain);
    tn.classList.toggle('positive', s.netGain >= 0);
    tn.classList.toggle('negative', s.netGain < 0);
  }
  const sessions = s.sessions || [];
  let totalBuyIn = 0, totalCashout = 0;
  sessions.forEach(function(r){
    totalBuyIn += (r.buyIn || 0);
    totalCashout += (r.buyIn || 0) + (r.pnl || 0);
  });
  const tt = $("numTables"); if(tt) tt.textContent = sessions.length;
  const tbi = $("numTotalBuyIn"); if(tbi) tbi.textContent = fmtNum(totalBuyIn);
  const tco = $("numTotalCashout"); if(tco) tco.textContent = fmtNum(totalCashout);

  const wa = $("numbersWallet");
  if(wa){
    if(window.PokerWallet && PokerWallet.isConnected()){
      const a = PokerWallet.getAddress();
      wa.textContent = a.slice(0,6) + '...' + a.slice(-4);
    } else {
      wa.textContent = isEn() ? "Not connected" : "未连接";
    }
  }

  const body = $("sessionsBody");
  if(!body) return;
  body.innerHTML = "";
  if(sessions.length === 0){
    const empty = document.createElement("div");
    empty.className = "session-empty";
    empty.textContent = isEn() ? "No sessions yet" : "还没坐过桌";
    body.appendChild(empty);
    return;
  }
  sessions.forEach(function(rec){
    const row = document.createElement("div");
    row.className = "session-row";
    const pnlCls = rec.pnl >= 0 ? "pos" : "neg";
    const pnlText = (rec.pnl >= 0 ? "+" : "") + fmtNum(rec.pnl);
    const cashout = (rec.buyIn || 0) + (rec.pnl || 0);
    const modeTag = rec.mode === 'real' ? (isEn() ? ' · Chain' : ' · 链上')
                    : (rec.mode === 'points' ? (isEn() ? ' · Points' : ' · 积分') : ' · AI');
    row.innerHTML =
      '<span>' + rec.table + modeTag + '</span>' +
      '<span>' + rec.blinds + '</span>' +
      '<span>' + fmtNum(rec.buyIn) + '</span>' +
      '<span>' + fmtNum(cashout) + '</span>' +
      '<span class="' + pnlCls + '">' + pnlText + '</span>' +
      '<span>' + (rec.hands || 0) + '</span>' +
      '<span>' + (rec.pnl > 0 ? '✓' : '—') + '</span>' +
      '<span>' + (isEn() ? 'Left' : '已离桌') + '</span>';
    body.appendChild(row);
  });
}

/* ========== 会话生命周期 ========== */
function resetSessionState(){
  if(G.turnTimer){ clearInterval(G.turnTimer); G.turnTimer = null; }
  if(G._hostTimeout){ clearTimeout(G._hostTimeout); G._hostTimeout = null; }
  if(G._nextHandTimer){ clearInterval(G._nextHandTimer); G._nextHandTimer = null; }
  if(G._nextHandToastTimer){ clearInterval(G._nextHandToastTimer); G._nextHandToastTimer = null; }
  if(G._turnTickTimer){ clearInterval(G._turnTickTimer); G._turnTickTimer = null; }
  if(G.online.broadcastTimer){ clearInterval(G.online.broadcastTimer); G.online.broadcastTimer = null; }

  G.players = [];
  G.community = [];
  G.deck = [];
  G.pot = 0;
  G.currentBet = 0;
  G.lastRaiseAmount = G.bigBlind;
  G.stage = 'preflop';
  G.handNumber = 0;
  G.dealerIndex = 0;
  G.currentPlayerIndex = 0;
  G.gameOver = false;
  G.busy = false;
  G.seatPositions = [];
  G.raiseMin = 0;
  G.raiseMax = 0;
  G.sessionBuyIn = 0;
  G.sessionHands = 0;
  G.playerHandStartChips = 0;
  G._renderedCards = new WeakSet();
  G._lastStateSig = '';
  G._lastActionSig = '';
  G._lastBoardSig = '';
  G._lastHandSig = '';
  G._timerKey = null;
  G._nextHandEndsAt = 0;
  G._turnEndsAt = 0;
}

function resetTableDom(){
  ['seatsLayer','boardCards','handCardsLarge','logArea','humanActions'].forEach(function(id){
    const el = document.getElementById(id); if(el) el.innerHTML = '';
  });
  const pot = document.getElementById('potMain'); if(pot) pot.textContent = '0';
  const psw = document.getElementById('potSideWrap'); if(psw) psw.classList.add('hidden');
  const ps = document.getElementById('potSide'); if(ps) ps.textContent = '0';
  const panel = document.getElementById('raisePanel'); if(panel) panel.classList.add('hidden');
  const nextBtn = document.getElementById('nextHandBtn'); if(nextBtn) nextBtn.classList.add('hidden');
  const timer = document.getElementById('turnTimer'); if(timer) timer.classList.add('hidden');
  const stage = document.getElementById('stageLabel'); if(stage) stage.textContent = '';
  const hand = document.getElementById('gameHandLabel'); if(hand) hand.textContent = '';
  const handInfo = document.getElementById('handInfo'); if(handInfo) handInfo.innerHTML = '';
  /* 移除动态节点 */
  const toast = document.getElementById('nextHandToast'); if(toast) toast.remove();
  const tng = document.getElementById('turnRing'); if(tng) tng.remove();
}

/* ★ 隐藏操作栏 */
function hideHumanActions(){
  const box = $("humanActions"); if(box) box.innerHTML = "";
  const panel = $("raisePanel"); if(panel) panel.classList.add("hidden");
  G._lastActionSig = "";
  if(G.turnTimer) stopTurnTimer();
}

/* ★ 无人跟注把底池给最后没弃牌的人 */
function awardUncontestedPot(){
  const alive = G.players.filter(function(p){ return p.seated !== false && !p.folded; });
  const pot = G.pot;
  if(alive.length === 1 && pot > 0){
    const w = alive[0];
    w.chips += pot;
    log(t("winsPot", { name: w.name, pot: fmtNum(pot) }), "win");
    PokerAudio.play("win");
  }
  G.pot = 0;
  G.stage = "showdown";
  G.busy = false;
}

/* ============ 等待栏（准备室） ============ */
function ensureWaitingBar(){
  let bar = document.getElementById('waitingBar');
  if(bar) return bar;
  bar = document.createElement('div');
  bar.id = 'waitingBar';
  bar.className = 'waiting-bar hidden';
  const tableArea = document.querySelector('.table-area');
  if(tableArea) tableArea.appendChild(bar);
  return bar;
}

function showWaitingBar(){
  const bar = ensureWaitingBar();
  if(!bar) return;
  const code = (window.PokerOnline && PokerOnline.getRoomId) ? PokerOnline.getRoomId() : '';
  bar.innerHTML =
    '<div class="waiting-room">' + (isEn() ? 'Room ' : '房间号 ') + '<b>' + (code || '—') + '</b></div>' +
    '<div class="waiting-info" id="waitingInfo">0 / 7</div>' +
    '<button class="mini-btn" id="waitingReadyBtn" type="button">' + (isEn() ? 'Ready' : '准备好了') + '</button>' +
    '<button class="mini-btn ghost" id="waitingLeaveBtn" type="button">' + (isEn() ? 'Leave' : '离桌') + '</button>';
  bar.classList.remove('hidden');

  const readyBtn = document.getElementById('waitingReadyBtn');
  if(readyBtn){
    /* 根据当前 ready 状态初始化文案 */
    const me = (window.PokerOnline && PokerOnline.getRoomPlayers) ? PokerOnline.getRoomPlayers()[PokerOnline.getMyId()] : null;
    if(me && me.ready) readyBtn.textContent = isEn() ? 'Cancel ready' : '取消准备';
    readyBtn.onclick = function(){
      const isReady = PokerOnline.toggleReady();
      readyBtn.textContent = isReady ? (isEn() ? 'Cancel ready' : '取消准备') : (isEn() ? 'Ready' : '准备好了');
      updateWaitingBar();
    };
  }
  const leaveBtn = document.getElementById('waitingLeaveBtn');
  if(leaveBtn) leaveBtn.onclick = function(){ backToLobby(); };
  updateWaitingBar();
}

function updateWaitingBar(){
  const info = document.getElementById('waitingInfo');
  if(!info) return;
  const players = (window.PokerOnline && PokerOnline.getRoomPlayers) ? PokerOnline.getRoomPlayers() : {};
  const ids = Object.keys(players);
  const ready = ids.filter(function(id){ return players[id].ready; }).length;
  info.textContent = ids.length + ' / ' + ONLINE_MAX_SEATS + ' · ' + ready + (isEn() ? ' ready' : ' 已准备');
}

function hideWaitingBar(){
  const bar = document.getElementById('waitingBar');
  if(bar) bar.classList.add('hidden');
}

/* ★ 从 roomPlayers 同步等待界面的座位 */
function syncWaitingSeatsFromRoom(){
  if(!G.online.active) return;
  if(G.online.started && G.stage !== 'waiting') return;

  const players = (window.PokerOnline && PokerOnline.getRoomPlayers) ? PokerOnline.getRoomPlayers() : {};
  const myId = window.PokerOnline ? PokerOnline.getMyId() : null;
  const ids = Object.keys(players);
  ids.sort(function(a, b){
    return (players[a].seat || 0) - (players[b].seat || 0);
  });

  const existing = {};
  G.players.forEach(function(p){ if(p.peerId) existing[p.peerId] = p; });

  G.players = ids.map(function(pid){
    const info = players[pid];
    const isSelf = pid === myId;
    const old = existing[pid];
    if(old){
      old.id = info.seat;
      old.name = info.name;
      old.isHuman = isSelf;
      old.ready = !!info.ready;
      old.seated = true;
      old.holeCards = [];
      old.folded = false;
      old.allIn = false;
      old.currentBet = 0;
      old.lastAction = '';
      old.revealCards = false;
      old._highlight = null;
      return old;
    }
    return {
      id: info.seat, peerId: pid, name: info.name,
      emoji: isSelf ? PokerAvatars.HUMAN.emoji : '🎮',
      bg: isSelf ? PokerAvatars.HUMAN.bg : 'linear-gradient(135deg,#a855f7,#6d28d9)',
      isHuman: isSelf,
      chips: 10000, seated: true,
      holeCards: [], folded: false, allIn: false,
      currentBet: 0, totalContributed: 0, needsToAct: false,
      position:'', positionKey:'', lastAction:'', styleKey:null,
      revealCards:false, _highlight:null, preflopOrder:0, postflopOrder:0,
      ready: !!info.ready
    };
  });

  G.online.mySeat = G.players.findIndex(function(p){ return p.peerId === myId; });
  G.seatPositions = computeSeatPositions(ONLINE_MAX_SEATS);
  render();
}

/* ★ 回到等待状态 */
function returnToWaiting(){
  if(G._nextHandTimer){ clearInterval(G._nextHandTimer); G._nextHandTimer = null; }
  if(G._hostTimeout){ clearTimeout(G._hostTimeout); G._hostTimeout = null; }
  if(G._nextHandToastTimer){ clearInterval(G._nextHandToastTimer); G._nextHandToastTimer = null; }
  stopTurnTimer();
  hideNextHandToast();

  G.online.started = false;
  G.stage = 'waiting';
  G.pot = 0;
  G.currentBet = 0;
  G.community = [];
  G.handNumber = 0;
  G.gameOver = false;
  G.busy = false;
  G.dealerIndex = 0;
  G.currentPlayerIndex = 0;
  G._nextHandEndsAt = 0;
  G._turnEndsAt = 0;

  G.players.forEach(function(p){
    p.holeCards = [];
    p.folded = false;
    p.allIn = false;
    p.currentBet = 0;
    p.totalContributed = 0;
    p.lastAction = '';
    p.revealCards = false;
    p._highlight = null;
    p.needsToAct = false;
  });

  syncWaitingSeatsFromRoom();
  showWaitingBar();
  hideHumanActions();

  const bc = document.getElementById('boardCards'); if(bc) bc.innerHTML = '';
  const pm = document.getElementById('potMain'); if(pm) pm.textContent = '0';
  const handArea = document.getElementById('handCardsLarge'); if(handArea) handArea.innerHTML = '';

  render();
  if(G.online.active && G.online.isHost) broadcastFullState();
}

/* ★ 8 秒下一手：房主起跳，客户端同步可见 */
function beginNextHandCountdown(startFn){
  if(G._nextHandTimer){ clearInterval(G._nextHandTimer); G._nextHandTimer = null; }

  const seated = G.players.filter(function(p){ return p.seated !== false; });
  if(seated.length < 2){
    if(G.online.active && G.online.isHost){
      log(isEn() ? "Not enough players — waiting" : "人数不足，等待更多玩家", "hl");
    }
    returnToWaiting();
    return;
  }

  const duration = NEXT_HAND_DELAY * 1000;
  G._nextHandEndsAt = Date.now() + duration;
  showNextHandToast(G._nextHandEndsAt);
  if(G.online.active && G.online.isHost) broadcastFullState();

  /* 房主端也显示按钮，允许提前点击 */
  const btn = $("nextHandBtn");
  if(btn){
    btn.classList.remove('hidden');
    btn.disabled = false;
    btn.onclick = fire;
  }

  function fire(){
    if(G._nextHandTimer){ clearInterval(G._nextHandTimer); G._nextHandTimer = null; }
    G._nextHandEndsAt = 0;
    if(btn) btn.classList.add('hidden');
    hideNextHandToast();
    const still = G.players.filter(function(p){ return p.seated !== false && p.chips > 0; });
    if(still.length < 2){ returnToWaiting(); return; }
    rotateDealerAndStart(startFn);
  }

  function tick(){
    const left = Math.max(0, Math.ceil((G._nextHandEndsAt - Date.now()) / 1000));
    if(btn) btn.textContent = '▶ ' + (isEn() ? ('Next (' + left + 's)') : ('下一手（' + left + 's）'));
    if(left <= 0){ fire(); }
  }
  tick();
  G._nextHandTimer = setInterval(tick, 500);
}

function rotateDealerAndStart(startFn){
  if(!G.players.length) return;
  let tries = 0;
  do {
    G.dealerIndex = (G.dealerIndex + 1) % G.players.length;
    tries++;
  } while(
    (G.players[G.dealerIndex].seated === false || G.players[G.dealerIndex].chips <= 0) &&
    tries < G.players.length
  );
  startFn();
}

/* ★ 桌面中央「下一手 8」toast */
function showNextHandToast(endsAt){
  let toast = document.getElementById('nextHandToast');
  if(!toast){
    toast = document.createElement('div');
    toast.id = 'nextHandToast';
    toast.className = 'next-hand-toast';
    const center = document.querySelector('.table-center');
    if(center) center.appendChild(toast);
    else document.body.appendChild(toast);
  }
  toast.classList.remove('hidden');
  if(G._nextHandToastTimer){ clearInterval(G._nextHandToastTimer); }
  const update = function(){
    const left = Math.max(0, Math.ceil((endsAt - Date.now()) / 1000));
    toast.textContent = (isEn() ? 'Next hand ' : '下一手 ') + left;
    if(left <= 0){
      clearInterval(G._nextHandToastTimer);
      G._nextHandToastTimer = null;
      toast.classList.add('hidden');
    }
  };
  update();
  G._nextHandToastTimer = setInterval(update, 200);
}
function hideNextHandToast(){
  const toast = document.getElementById('nextHandToast');
  if(toast) toast.classList.add('hidden');
  if(G._nextHandToastTimer){ clearInterval(G._nextHandToastTimer); G._nextHandToastTimer = null; }
}

/* ★ 玩家/房主离桌 */
function handlePlayerLeave(peerId){
  const idx = G.players.findIndex(function(p){ return p.peerId === peerId; });
  if(idx < 0) return;
  const p = G.players[idx];
  if(p.seated === false) return;

  p.seated = false;
  p.folded = true;
  p.needsToAct = false;
  p.holeCards = [];
  p._highlight = null;
  p.revealCards = false;
  p.lastAction = isEn() ? 'Left' : '已离桌';

  log((p.name || 'Player') + (isEn() ? " left the table" : " 离桌了"), "action");

  if(G.currentPlayerIndex === idx){
    stopTurnTimer();
    if(G._hostTimeout){ clearTimeout(G._hostTimeout); G._hostTimeout = null; }
  }

  render();

  if(G.online.isHost && G.online.started && G.stage !== 'showdown'){
    const still = G.players.filter(function(x){ return x.seated !== false && !x.folded; });
    if(still.length <= 1){
      const pot = G.pot;
      awardUncontestedPot();
      render();
      if(G.online.isHost) broadcastFullState();
      endHandHost(pot);
      return;
    }
    broadcastFullState();
    runHostTurn();
  } else if(G.online.isHost){
    /* 还在等待状态，直接广播新玩家列表 */
    if(G.online.isHost) broadcastFullState();
  }
}

/* ========== 大厅 ========== */
function renderLobby(){
  renderTableGrid("aiTableGrid", "ai");
  renderTableGrid("pointsTableGrid", "points");
  renderTableGrid("realTableGrid", "real");
  renderRoomLists();
  refreshBalanceUI();
}

function renderRoomLists(){
  if(!window.PokerOnline || !PokerOnline.getKnownRooms) return;
  const currentId = PokerOnline.getRoomId();
  const rooms = PokerOnline.getKnownRooms().filter(function(r){ return r.roomId !== currentId; });
  const pointsRooms = rooms.filter(function(r){ return r.mode === 'points'; });
  const realRooms   = rooms.filter(function(r){ return r.mode === 'real'; });
  fillRoomList('pointsRoomList', pointsRooms);
  fillRoomList('realRoomList',   realRooms);
  updateRoomCount('pointsRoomCount', pointsRooms.length);
  updateRoomCount('realRoomCount',   realRooms.length);
  const total = pointsRooms.length + realRooms.length;
  const sl = document.getElementById('statusLabel');
  if(sl) sl.textContent = isEn() ? (total + (total === 1 ? ' table' : ' tables')) : (total + ' 桌开放');
}

function updateRoomCount(id, n){
  const el = document.getElementById(id);
  if(!el) return;
  el.innerHTML = '<span class="pulse"></span><span>' + n + (isEn() ? (n === 1 ? ' table' : ' tables') : ' 桌') + '</span>';
  if(n > 0) el.classList.remove('zero'); else el.classList.add('zero');
}

function fillRoomList(containerId, rooms){
  const el = document.getElementById(containerId);
  if(!el) return;
  el.innerHTML = "";
  if(!rooms.length) return;
  rooms.forEach(function(r){
    const lv = LEVELS.find(function(l){ return l.key === r.level; }) || LEVELS[0];
    const item = document.createElement('div');
    item.className = 'room-item';
    const initial = (r.hostName || 'R').charAt(0).toUpperCase();
    const isFull = (r.count || 1) >= (r.maxSeats || 7);
    item.innerHTML =
      '<div class="room-item-avatar">' + initial + '</div>' +
      '<div class="room-item-info">' +
        '<div class="room-item-name">' + (r.hostName || 'Host') + (isEn() ? "'s room" : ' 的房间') + '</div>' +
        '<div class="room-item-meta">' + lv.name + ' · ' + lv.sb + '/' + lv.bb + ' · ' + r.roomId + '</div>' +
      '</div>' +
      '<div class="room-item-players">' + (r.count || 1) + '/' + (r.maxSeats || 7) + '</div>' +
      '<button class="room-item-join"' + (isFull ? ' disabled' : '') + '>' +
        (isFull ? (isEn() ? 'Full' : '已满') : (isEn() ? 'Join' : '加入')) +
      '</button>';
    if(!isFull){
      const handler = function(e){
        if(e && e.stopPropagation) e.stopPropagation();
        doJoinRoom(lv, r.mode, r.roomId);
      };
      item.querySelector('.room-item-join').onclick = handler;
      item.onclick = handler;
    }
    el.appendChild(item);
  });
}

function renderTableGrid(containerId, mode){
  const grid = $(containerId);
  if(!grid) return;
  grid.innerHTML = "";

  LEVELS.forEach(function(lv){
    const card = document.createElement("div");
    card.className = "table-card";

    let totalSeats = mode === 'ai' ? G.aiSeats : ONLINE_MAX_SEATS;
    let seatDots = "";
    for(let i = 0; i < totalSeats; i++){
      const angle = -90 + (360 / totalSeats) * i;
      const rad = angle * Math.PI / 180;
      const x = 50 + 40 * Math.cos(rad);
      const y = 50 + 40 * Math.sin(rad);
      const isEmpty = mode === 'ai' ? (i >= totalSeats - 1) : true;
      seatDots += '<div class="dot-seat' + (isEmpty ? ' empty' : '') + '" style="left:' + x + '%;top:' + y + '%;transform:translate(-50%,-50%);"></div>';
    }

    const preview =
      '<div class="table-card-preview">' +
        '<div class="seats">' + seatDots + '</div>' +
        '<div class="card-row">' +
          '<div class="mini-blank"></div><div class="mini-blank"></div>' +
          '<div class="mini-blank"></div><div class="mini-blank"></div>' +
          '<div class="mini-blank"></div>' +
        '</div>' +
      '</div>';

    const nameText = lv.name + (isEn() ? ' Table' : ' 桌');
    const blindsLabel = isEn() ? ('Blinds ' + lv.sb + '/' + lv.bb) : ('盲注 ' + lv.sb + '/' + lv.bb);
    const buyInLabel = isEn() ? 'Buy-in' : '买入';
    const buyInText = fmtNum(lv.buyMin) + '–' + fmtNum(lv.buyMax);
    const rightText = mode === 'real' ? ('≈ ' + toBem(lv.buyMin) + ' BEM') : (mode === 'points' ? (isEn() ? 'Points' : '积分') : (isEn() ? 'Free' : '免费'));

    let actionsHtml;
    if(mode === 'ai'){
      actionsHtml = '<button class="btn-seat">' + (isEn() ? 'Take a seat' : '立即入座') + '</button>';
    } else {
      actionsHtml =
        '<button class="btn-create">' + (isEn() ? 'Create room' : '创建房间') + '</button>' +
        '<button class="btn-join">' + (isEn() ? 'Join room' : '加入房间') + '</button>';
    }

    card.innerHTML =
      '<div class="table-card-head">' +
        '<div class="table-card-avatar">' + lv.name.charAt(0) + '</div>' +
        '<div class="table-card-title">' +
          '<div class="table-card-name">' + nameText + '</div>' +
          '<div class="table-card-blinds">' + blindsLabel + '</div>' +
        '</div>' +
      '</div>' + preview +
      '<div class="table-card-meta">' +
        '<span>' + buyInLabel + ' <strong>' + buyInText + '</strong></span>' +
        '<span>' + rightText + '</span>' +
      '</div>' +
      '<div class="table-card-actions">' + actionsHtml + '</div>';

    if(mode === 'ai'){
      card.querySelector(".btn-seat").onclick = function(){ openAiLevel(lv); };
    } else {
      card.querySelector(".btn-create").onclick = function(){ createRoom(lv, mode); };
      card.querySelector(".btn-join").onclick = function(){ joinRoomByCode(lv, mode); };
    }
    grid.appendChild(card);
  });
}

/* ========== AI 场 ========== */
function openAiLevel(lv){
  resetSessionState();
  resetTableDom();
  hideWaitingBar();

  G.gameMode = 'ai';
  let ai = PokerStorage.getAiChips();
  if(ai < lv.buyMin){ PokerStorage.addAiChips(10000); ai = PokerStorage.getAiChips(); }
  const buyIn = Math.min(lv.buyMax, ai);
  PokerStorage.setAiChips(ai - buyIn);
  G.sessionBuyIn = buyIn;
  G.totalPlayers = G.aiSeats;
  G.tableMode = lv.key;
  G.tableLabel = lv.name;
  G.smallBlind = lv.sb;
  G.bigBlind = lv.bb;
  G.lastRaiseAmount = lv.bb;
  G.sessionHands = 0;
  G.online.active = false;

  const human = PokerAvatars.HUMAN;
  G.players = [{
    id:0, name:PokerStorage.getNickname() || human.name, emoji:human.emoji, bg:human.bg,
    isHuman:true, chips:G.sessionBuyIn, seated:true,
    holeCards:[], folded:false, allIn:false, currentBet:0,
    totalContributed:0, needsToAct:false,
    position:"", positionKey:"", lastAction:"", styleKey:null,
    revealCards:false, _highlight:null, preflopOrder:0, postflopOrder:0
  }];

  const profiles = PokerAvatars.pickProfiles(G.totalPlayers - 1);
  const styleKeys = Object.keys(PokerAI.STYLES);
  const shuffled = styleKeys.slice().sort(function(){ return Math.random() - 0.5; });
  for(let i = 1; i < G.totalPlayers; i++){
    const aiBuy = Math.floor(lv.buyMin + Math.random() * (lv.buyMax - lv.buyMin));
    G.players.push({
      id:i, name:profiles[i-1].name, emoji:profiles[i-1].emoji, bg:profiles[i-1].bg,
      isHuman:false, chips:aiBuy, seated:true,
      holeCards:[], folded:false, allIn:false, currentBet:0,
      totalContributed:0, needsToAct:false,
      position:"", positionKey:"", lastAction:"", styleKey:shuffled[(i-1) % shuffled.length],
      revealCards:false, _highlight:null, preflopOrder:0, postflopOrder:0
    });
  }

  G.seatPositions = computeSeatPositions(G.players.length);
  G.dealerIndex = Math.floor(Math.random() * G.players.length);
  G.handNumber = 0;
  G.gameOver = false;

  $("lobbyScreen").classList.add("hidden");
  $("gameScreen").classList.remove("hidden");
  $("onlineLobby").classList.add("hidden");
  if($("gameLevelLabel")) $("gameLevelLabel").textContent = lv.name + " " + lv.sb + "/" + lv.bb + " · " + G.players.length + (isEn() ? "P" : "人");
  if($("gameModeLabel")){ $("gameModeLabel").textContent = isEn() ? "AI" : "AI 练习"; $("gameModeLabel").classList.remove('real'); }
  if($("gameWalletPill")) $("gameWalletPill").innerHTML = '<span class="dot"></span><span>' + (isEn() ? "AI practice" : "AI 练习模式") + '</span>';

  startNewHandAi();
}

/* ========== 联机创建/加入 ========== */
function checkOnlinePreconditions(lv, mode){
  if(mode === 'real'){
    if(!window.PokerWallet || !PokerWallet.isConnected()){
      alert(isEn() ? "Connect wallet first" : "请先连接钱包");
      $("walletOverlay").classList.remove("hidden");
      return false;
    }
    if(PokerStorage.getRealChips() < lv.buyMin){
      alert(isEn() ? "Not enough chips. Deposit BEM first." : "对战场筹码不足，请先充值 BEM");
      return false;
    }
  } else {
    if(PokerStorage.getPoints() < lv.buyMin){
      alert(isEn() ? "Not enough points." : "积分不足，请先领取每日积分");
      return false;
    }
  }
  return true;
}

function generateRoomId(lv, mode){
  const rand = Math.random().toString(36).slice(2, 7);
  return lv.key + '-' + (mode === 'real' ? 'ch' : 'pt') + '-' + rand;
}

function createRoom(lv, mode){
  if(!checkOnlinePreconditions(lv, mode)) return;
  const roomId = generateRoomId(lv, mode);

  PokerOnline.createRoom(roomId, { level: lv.key, mode: mode }).then(function(){
    enterOnlineRoom(lv, mode, roomId, true);
  }).catch(function(err){
    console.error(err);
    alert(isEn() ? "Connection failed" : "连接失败");
  });
}

function joinRoomByCode(lv, mode){
  if(!checkOnlinePreconditions(lv, mode)) return;
  const overlay = $("joinRoomOverlay");
  overlay.classList.remove("hidden");
  const input = $("joinRoomInput");
  input.value = '';
  $("joinRoomConfirmBtn").onclick = function(){
    const code = input.value.trim();
    if(!code){ alert(isEn() ? "Enter a room code" : "请输入房间号"); return; }
    overlay.classList.add("hidden");
    doJoinRoom(lv, mode, code);
  };
  $("joinRoomCancelBtn").onclick = function(){ overlay.classList.add("hidden"); };
  setTimeout(function(){ input.focus(); }, 100);
}

function doJoinRoom(lv, mode, roomId){
  PokerOnline.joinRoom(roomId).then(function(){
    enterOnlineRoom(lv, mode, roomId, false);
  }).catch(function(err){
    console.error(err);
    alert(isEn() ? "Connection failed" : "连接失败");
  });
}

/* ★ 进房：进桌 → 清残局 → 显示等待栏 */
function enterOnlineRoom(lv, mode, roomId, isHost){
  resetSessionState();
  resetTableDom();

  G.gameMode = mode;
  G.tableMode = lv.key;
  G.tableLabel = lv.name;
  G.smallBlind = lv.sb;
  G.bigBlind = lv.bb;
  G.lastRaiseAmount = lv.bb;
  G.gameOver = false;
  G.stage = 'waiting';
  G.sessionBuyIn = 10000;
  G.sessionHands = 0;
  G.online = {
    active: true, isHost: isHost, roomId: roomId,
    mySeat: 0, started: false, broadcastTimer: null
  };
  G._lastStateSig = ''; G._lastActionSig = ''; G._lastBoardSig = ''; G._lastHandSig = '';
  G._timerKey = null; G._nextHandEndsAt = 0; G._turnEndsAt = 0;

  $("lobbyScreen").classList.add("hidden");
  $("gameScreen").classList.remove("hidden");
  /* ★ 不再显示旧版等待室遮罩 */
  $("onlineLobby").classList.add("hidden");

  if($("gameLevelLabel")) $("gameLevelLabel").textContent = lv.name + " " + lv.sb + "/" + lv.bb + " · " + (isEn() ? "Online" : "联机");
  if($("gameModeLabel")){
    if(mode === 'real'){ $("gameModeLabel").textContent = isEn() ? "On-chain" : "链上"; $("gameModeLabel").classList.add('real'); }
    else { $("gameModeLabel").textContent = isEn() ? "Points" : "积分"; $("gameModeLabel").classList.remove('real'); }
  }
  if($("gameWalletPill")) $("gameWalletPill").innerHTML = '<span class="dot" style="background:#a855f7;"></span><span>' + (isEn() ? "Waiting" : "等待中") + '</span>';

  clearLog();
  log((isEn() ? "Room: " : "房间号：") + roomId, "hl");
  log(isEn() ? "Waiting for players..." : "等待其他玩家加入...", "hl");

  showWaitingBar();
  syncWaitingSeatsFromRoom();
  hideHumanActions();
}

function updateOnlineLobbyUI(){
  /* 保留以兼容旧调用 —— 现在准备室在桌面底部条里 */
  updateWaitingBar();
}

/* ========== 房主开始游戏 ========== */
function hostStartGame(playerOrder, playersInfo){
  if(!G.online.isHost) return;
  if(G.online.started) return;

  const myId = PokerOnline.getMyId();

  /* 按 seat 排序，保留座位号 */
  const ordered = playerOrder.slice().sort(function(a, b){
    const ia = playersInfo.find(function(p){ return p.peerId === a; });
    const ib = playersInfo.find(function(p){ return p.peerId === b; });
    return (ia && ia.seat || 0) - (ib && ib.seat || 0);
  });

  G.players = ordered.map(function(pid){
    const info = playersInfo.find(function(p){ return p.peerId === pid; }) || { name:'Player', seat: 0 };
    const isSelf = pid === myId;
    return {
      id: info.seat || 0, peerId: pid,
      name: info.name,
      emoji: isSelf ? PokerAvatars.HUMAN.emoji : '🎮',
      bg: isSelf ? PokerAvatars.HUMAN.bg : 'linear-gradient(135deg,#a855f7,#6d28d9)',
      isHuman: isSelf,
      chips: 10000, seated: true,
      holeCards: [], folded:false, allIn:false, currentBet:0,
      totalContributed:0, needsToAct:false,
      position:"", positionKey:"", lastAction:"", styleKey:null,
      revealCards:false, _highlight:null, preflopOrder:0, postflopOrder:0
    };
  });
  G.online.mySeat = G.players.findIndex(function(p){ return p.peerId === myId; });
  G.totalPlayers = G.players.length;
  G.seatPositions = computeSeatPositions(ONLINE_MAX_SEATS);
  G.dealerIndex = Math.floor(Math.random() * G.players.length);
  G.handNumber = 0;
  G.gameOver = false;
  G.online.started = true;
  G.stage = 'preflop';

  G._lastStateSig = ''; G._lastActionSig = ''; G._lastBoardSig = ''; G._lastHandSig = '';

  hideWaitingBar();
  if($("gameWalletPill")) $("gameWalletPill").innerHTML = '<span class="dot" style="background:#a855f7;"></span><span>' + G.players.length + (isEn() ? " players" : " 人联机") + '</span>';

  const startPayload = {
    playerOrder: ordered,
    players: G.players.map(function(p){ return { id: p.id, peerId: p.peerId, name: p.name, seat: p.id }; })
  };
  PokerOnline.sendGameStart(startPayload);

  startNewHandHost();
}

/* ========== 房主发一手 ========== */
async function startNewHandHost(){
  if(G._nextHandTimer){ clearInterval(G._nextHandTimer); G._nextHandTimer = null; }
  if(G._nextHandToastTimer){ clearInterval(G._nextHandToastTimer); G._nextHandToastTimer = null; }
  hideNextHandToast();

  G.handNumber++;
  G.sessionHands++;
  G.pot = 0; G.community = [];
  G.currentBet = 0; G.lastRaiseAmount = G.bigBlind;
  G.stage = "preflop"; G.busy = false;
  G._nextHandEndsAt = 0;
  G.deck = PokerDeck.create();
  PokerDeck.shuffle(G.deck);
  G._renderedCards = new WeakSet();
  G._lastBoardSig = ''; G._lastHandSig = ''; G._lastActionSig = '';
  stopTurnTimer();

  G.players.forEach(function(p){
    p.folded = p.chips <= 0 || p.seated === false;
    p.allIn = false;
    p.currentBet = 0;
    p.totalContributed = 0;
    p.needsToAct = false;
    p.lastAction = "";
    p.holeCards = [];
    p.revealCards = false;
    p._highlight = null;
    p._score = null;
  });

  assignPositions();
  computeActionOrders();

  const n = G.players.length;
  for(let r = 0; r < 2; r++){
    for(let i = 1; i <= n; i++){
      const idx = (G.dealerIndex + i) % n;
      const p = G.players[idx];
      if(!p.folded) p.holeCards.push(G.deck.pop());
    }
  }

  clearLog();
  log(t("handNum", { n:G.handNumber }) + " · " + t("dealerIs", { name:G.players[G.dealerIndex].name }), "hl");
  log(t("blindsAre", { sb:G.smallBlind, bb:G.bigBlind }), "hl");

  const gh = $("gameHandLabel");
  if(gh) gh.textContent = t("handShortLabel", { n:G.handNumber });

  render();
  await playDealAnimation();
  postBlinds();
  render();

  startPreflopHost();
  broadcastFullState();
  runHostTurn();
}

function startPreflopHost(){
  const n = G.players.length;
  G.players.forEach(function(p){
    p.needsToAct = p.seated !== false && !p.folded && !p.allIn && p.chips > 0;
  });
  let idx = n === 2 ? G.dealerIndex : (G.dealerIndex + 3) % n;
  let tries = 0;
  while((G.players[idx].folded || G.players[idx].allIn) && tries < n){ idx = (idx + 1) % n; tries++; }
  G.currentPlayerIndex = idx;
  render();
}

function runHostTurn(){
  if(G.gameOver) return;

  /* 无人跟注 → 立即结算 */
  if(countActive() <= 1){
    const pot = G.pot;
    awardUncontestedPot();
    render();
    if(G.online.isHost) broadcastFullState();
    endHandHost(pot);
    return;
  }

  const notAllIn = G.players.filter(function(p){ return p.seated !== false && !p.folded && !p.allIn; });
  if(notAllIn.length === 0){ advanceStageHost(); return; }
  if(notAllIn.length === 1 && notAllIn.every(function(p){ return !p.needsToAct; })){ advanceStageHost(); return; }
  if(!findNextToAct()){ advanceStageHost(); return; }

  const p = G.players[G.currentPlayerIndex];
  G._turnEndsAt = Date.now() + 30000;
  render();
  broadcastFullState();

  if(p.isHuman){
    showHumanControls();
    startTurnTimer(p);
  } else {
    stopTurnTimer();
    if(G._hostTimeout) clearTimeout(G._hostTimeout);
    G._hostTimeout = setTimeout(function(){
      const cur = G.players[G.currentPlayerIndex];
      if(cur === p && !p.folded && !p.allIn && p.needsToAct){
        log(p.name + (isEn() ? " timed out, auto-fold" : " 超时自动弃牌"), "action");
        executeAction(p, { type: 'fold' });
        render();
        broadcastFullState();
        runHostTurn();
      }
    }, 30000);
  }
}

function advanceStageHost(){
  stopTurnTimer();
  if(countActive() <= 1){
    const pot = G.pot;
    awardUncontestedPot();
    render();
    if(G.online.isHost) broadcastFullState();
    endHandHost(pot);
    return;
  }

  G.players.forEach(function(p){ p.currentBet = 0; p.lastAction = ""; });
  G.currentBet = 0; G.lastRaiseAmount = G.bigBlind;

  if(G.stage === "preflop"){
    G.stage = "flop";
    G.community.push(G.deck.pop(), G.deck.pop(), G.deck.pop());
    log(t("flopIs",{cards:G.community.map(function(c){return c.display;}).join("  ")}), "hl");
  } else if(G.stage === "flop"){
    G.stage = "turn";
    G.community.push(G.deck.pop());
    log(t("turnIs",{card:G.community[G.community.length-1].display}), "hl");
  } else if(G.stage === "turn"){
    G.stage = "river";
    G.community.push(G.deck.pop());
    log(t("riverIs",{card:G.community[G.community.length-1].display}), "hl");
  } else if(G.stage === "river"){
    showdownHost();
    return;
  }

  PokerAudio.play('deal');
  G.players.forEach(function(p){
    p.currentBet = 0; p.lastAction = "";
    p.needsToAct = p.seated !== false && !p.folded && !p.allIn && p.chips > 0;
  });
  G.currentBet = 0; G.lastRaiseAmount = G.bigBlind;
  const n = G.players.length;
  let idx = (G.dealerIndex + 1) % n;
  let tries = 0;
  while((G.players[idx].folded || G.players[idx].allIn) && tries < n){ idx = (idx + 1) % n; tries++; }
  G.currentPlayerIndex = idx;

  render();
  broadcastFullState();
  runHostTurn();
}

function showdownHost(){
  stopTurnTimer();
  G.stage = "showdown";
  G.busy = true;
  log(t("showdownHeader"), "hl");
  PokerAudio.play('showdown');
  const cont = G.players.filter(function(p){ return p.seated !== false && !p.folded; });
  cont.forEach(function(p){ p.revealCards = false; p._highlight = null; });
  render();
  broadcastFullState();
  let idx = 0;
  function next(){
    if(idx >= cont.length){ setTimeout(function(){ resolveHost(cont); }, 800); return; }
    const p = cont[idx];
    p.revealCards = true;
    render();
    broadcastFullState();
    PokerAudio.play('deal');
    log(t("reveals",{name:p.name,cards:p.holeCards.map(function(c){return c.display;}).join("  ")}), "showdown");
    idx++;
    setTimeout(next, 650);
  }
  next();
}

function resolveHost(cont){
  cont.forEach(function(p){
    const r = PokerEval.bestHand(p.holeCards.concat(G.community));
    p._score = r.score; p._bestCards = r.cards;
    log(t("handResult",{
      name:p.name,
      cards:p.holeCards.map(function(c){return c.display;}).join(" "),
      hand:PokerEval.nameOf(r.score)
    }), "showdown");
  });
  const pots = calculateSidePots();
  const n = pots.length;
  pots.forEach(function(pot, i){
    if(!pot.eligible.length) return;
    let best = null, ws = [];
    pot.eligible.forEach(function(p){
      if(best === null || PokerEval.compare(p._score, best) > 0){ best = p._score; ws = [p]; }
      else if(PokerEval.compare(p._score, best) === 0) ws.push(p);
    });
    const each = Math.floor(pot.amount / ws.length);
    const rem = pot.amount - each * ws.length;
    ws.forEach(function(w, k){ w.chips += each + (k === 0 ? rem : 0); });
    const lbl = n === 1 ? t("pot") : (i === 0 ? t("mainPot") : t("sidePot") + " " + i);
    log(t("winsPotSide",{
      name:ws.map(function(x){return x.name;}).join(", "),
      potLabel:lbl, amt:fmtNum(pot.amount), hand:PokerEval.nameOf(best)
    }), "win");
    if(!ws[0]._highlight && ws[0]._bestCards) ws[0]._highlight = new Set(ws[0]._bestCards);
  });
  const totalPot = pots.reduce(function(s,p){ return s + p.amount; }, 0);
  G.pot = 0; G.busy = false;
  PokerAudio.play('win');
  render();
  if(G.online.isHost) broadcastFullState();
  endHandHost(totalPot);
}

function endHandHost(totalPot){
  const me = G.players[G.online.mySeat];
  if(me) PokerStorage.recordHand(me.chips - G.playerHandStartChips, totalPot || 0);
  render();
  if(G.online.isHost) broadcastFullState();
  /* 房主 8 秒倒计时下一手 */
  beginNextHandCountdown(startNewHandHost);
}

function broadcastFullState(){
  if(!G.online.isHost) return;
  const state = {
    players: G.players.map(function(p){
      return {
        id: p.id, peerId: p.peerId, name: p.name,
        chips: p.chips, folded: p.folded, allIn: p.allIn,
        seated: p.seated !== false,
        currentBet: p.currentBet,
        holeCards: p.holeCards,
        lastAction: p.lastAction,
        position: p.position, positionKey: p.positionKey,
        revealCards: p.revealCards,
        preflopOrder: p.preflopOrder, postflopOrder: p.postflopOrder,
        _highlight: p._highlight ? Array.from(p._highlight) : null
      };
    }),
    pot: G.pot, currentBet: G.currentBet, stage: G.stage,
    dealerIndex: G.dealerIndex, currentPlayerIndex: G.currentPlayerIndex,
    community: G.community, handNumber: G.handNumber,
    smallBlind: G.smallBlind, bigBlind: G.bigBlind,
    gameOver: G.gameOver,
    /* ★ 新增时间戳与阶段 */
    phase: G.online.started ? 'playing' : 'waiting',
    nextHandEndsAt: G._nextHandEndsAt || 0,
    turnEndsAt: G._turnEndsAt || 0
  };
  PokerOnline.sendFullState(state);
}

/* ========== 客户端：应用状态 ========== */
function applyFullState(state){
  if(!state || !state.players) return;

  const sig = buildStateSig(state);
  if(sig && sig === G._lastStateSig && G.players.length === state.players.length){
    /* 状态没变，但倒计时可能要继续，交给下面 tick 处理 */
    syncCountdownFromState(state);
    return;
  }
  G._lastStateSig = sig;

  /* ★ 等待阶段：走等待界面渲染 */
  if(state.phase === 'waiting' || (!G.online.started && !state.handNumber)){
    G.stage = 'waiting';
    G.online.started = false;
    showWaitingBar();
    syncCountdownFromState(state);
    return;
  }

  const myId = PokerOnline.getMyId();

  /* ★ 用 peerId 判断阵容是否变化，而不是长度 */
  const sameRoster =
    G.players.length === state.players.length &&
    G.players.every(function(p, i){
      return state.players[i] && state.players[i].peerId === p.peerId;
    });

  if(!sameRoster){
    const existingByPeer = {};
    G.players.forEach(function(p){ if(p.peerId) existingByPeer[p.peerId] = p; });

    G.players = state.players.map(function(p){
      const isSelf = p.peerId === myId;
      const existing = existingByPeer[p.peerId];
      if(existing){
        existing.id = p.id;
        existing.name = p.name;
        existing.isHuman = isSelf;
        return existing;
      }
      return {
        id: p.id, peerId: p.peerId, name: p.name,
        emoji: isSelf ? PokerAvatars.HUMAN.emoji : '🎮',
        bg: isSelf ? PokerAvatars.HUMAN.bg : 'linear-gradient(135deg,#a855f7,#6d28d9)',
        isHuman: isSelf,
        chips: p.chips, seated: p.seated !== false,
        holeCards: [], folded:false, allIn:false, currentBet:0,
        totalContributed:0, needsToAct:false,
        position:"", positionKey:"", lastAction:"", styleKey:null,
        revealCards:false, _highlight:null, preflopOrder:0, postflopOrder:0
      };
    });
    G.online.mySeat = G.players.findIndex(function(p){ return p.peerId === myId; });
    G.totalPlayers = G.players.length;
    G.seatPositions = computeSeatPositions(ONLINE_MAX_SEATS);
    G.online.started = true;
    hideWaitingBar();
    if($("gameWalletPill")) $("gameWalletPill").innerHTML = '<span class="dot" style="background:#a855f7;"></span><span>' + G.players.length + (isEn() ? " players" : " 人联机") + '</span>';
    G._lastBoardSig = ''; G._lastHandSig = ''; G._lastActionSig = '';
  }

  if(state.handNumber !== G.handNumber){
    G._renderedCards = new WeakSet();
    G._lastBoardSig = ''; G._lastHandSig = ''; G._lastActionSig = '';
  }

  state.players.forEach(function(sp, i){
    if(!G.players[i]) return;
    const p = G.players[i];
    p.chips = sp.chips;
    p.folded = sp.folded;
    p.allIn = sp.allIn;
    p.seated = sp.seated !== false;
    p.currentBet = sp.currentBet;
    p.holeCards = normalizeCards(sp.holeCards);
    p.lastAction = sp.lastAction;
    p.position = sp.position;
    p.positionKey = sp.positionKey;
    p.revealCards = sp.revealCards;
    p.preflopOrder = sp.preflopOrder;
    p.postflopOrder = sp.postflopOrder;
    if(sp._highlight) p._highlight = new Set(normalizeCards(sp._highlight));
    else p._highlight = null;
  });

  G.pot = state.pot;
  G.currentBet = state.currentBet;
  G.stage = state.stage;
  G.dealerIndex = state.dealerIndex;
  G.currentPlayerIndex = state.currentPlayerIndex;
  G.community = normalizeCards(state.community);
  G.handNumber = state.handNumber;
  G.smallBlind = state.smallBlind;
  G.bigBlind = state.bigBlind;
  G.gameOver = state.gameOver || false;

  const gh = $("gameHandLabel");
  if(gh) gh.textContent = t("handShortLabel", { n:G.handNumber });

  syncCountdownFromState(state);
  render();

  const meIdx = G.online.mySeat;
  if(G.currentPlayerIndex === meIdx && !G.gameOver && G.stage !== 'showdown'){
    const me = G.players[meIdx];
    if(me && me.seated !== false && !me.folded && !me.allIn){
      G._lastActionSig = "";
      showHumanControls();
      const timerKey = G.handNumber + ':' + G.currentPlayerIndex + ':' + G.stage;
      if(!G.turnTimer || G._timerKey !== timerKey){
        G._timerKey = timerKey;
        startTurnTimer(me);
      }
    } else {
      hideHumanActions();
    }
  } else {
    hideHumanActions();
  }
}

/* ★ 从 state 里同步倒计时 UI */
function syncCountdownFromState(state){
  /* 下一手倒计时 */
  if(state.nextHandEndsAt && state.nextHandEndsAt > Date.now()){
    G._nextHandEndsAt = state.nextHandEndsAt;
    showNextHandToast(state.nextHandEndsAt);
  } else {
    if(G._nextHandEndsAt){ G._nextHandEndsAt = 0; hideNextHandToast(); }
  }
  /* 房主的思考倒计时，也同步给所有客户端 */
  if(state.turnEndsAt && state.turnEndsAt > Date.now() && !G.turnTimer){
    const el = document.getElementById('turnTimer');
    if(el) el.classList.remove('hidden');
    if(G._turnTickTimer){ clearInterval(G._turnTickTimer); }
    const endAt = state.turnEndsAt;
    const update = function(){
      const left = Math.max(0, endAt - Date.now());
      const f = document.getElementById('timerFill');
      const txt = document.getElementById('timerText');
      if(f) f.style.width = (left / 30000 * 100) + '%';
      if(txt) txt.textContent = Math.ceil(left / 1000) + 's';
      if(left <= 0){
        clearInterval(G._turnTickTimer);
        G._turnTickTimer = null;
        const el2 = document.getElementById('turnTimer');
        if(el2) el2.classList.add('hidden');
      }
    };
    update();
    G._turnTickTimer = setInterval(update, 200);
  }
}

/* ========== 消息处理 ========== */
function handleOnlineMessage(msg){
  if(!msg || !msg.type) return;

  if(G.online.isHost){
    switch(msg.type){
      case 'host_start_game':
        hostStartGame(msg.playerOrder, msg.players);
        break;
      case 'player_action':
        const player = G.players.find(function(p){ return p.peerId === msg.playerId; });
        if(!player) return;
        if(G.players[G.currentPlayerIndex] !== player) return;
        if(G._hostTimeout){ clearTimeout(G._hostTimeout); G._hostTimeout = null; }
        executeAction(player, msg.action);
        render();
        broadcastFullState();
        runHostTurn();
        break;
      case 'sync_request':
        if(G.online.started) broadcastFullState();
        break;
      case 'player_leave':
        handlePlayerLeave(msg.peerId);
        break;
    }
    return;
  }

  switch(msg.type){
    case 'game_start':
      break;
    case 'full_state':
      applyFullState(msg.state);
      break;
    case 'player_leave': {
      const p = G.players.find(function(x){ return x.peerId === msg.peerId; });
      if(p){
        p.seated = false;
        p.folded = true;
        p.holeCards = [];
        p._highlight = null;
        p.revealCards = false;
        p.lastAction = isEn() ? 'Left' : '已离桌';
        render();
      }
      break;
    }
    case 'host_left': {
      alert(isEn() ? "Host left the room" : "房主已离开房间");
      /* 客户端不再主动 leaveRoom，避免重复 */
      G.online.active = false;
      resetSessionState();
      resetTableDom();
      hideWaitingBar();
      $("gameScreen").classList.add("hidden");
      $("lobbyScreen").classList.remove("hidden");
      showScreen("lobby");
      renderRoomLists();
      break;
    }
    case 'room_full': {
      alert(isEn() ? "Room is full (max 7)" : "房间已满（最多 7 人）");
      /* 客户端主动退房 */
      try { PokerOnline.leaveRoom(); } catch(e){}
      G.online.active = false;
      resetSessionState();
      resetTableDom();
      hideWaitingBar();
      $("gameScreen").classList.add("hidden");
      $("lobbyScreen").classList.remove("hidden");
      showScreen("lobby");
      break;
    }
  }
}

/* ========== 座位 ========== */
function computeSeatPositions(n){
  const pos = [{ x:50, y:50 + 40 }];
  const ai = n - 1;
  if(ai === 0) return pos;
  const R = 40;
  const right = Math.ceil(ai / 2);
  const left = ai - right;
  if(right === 1){ pos.push({ x:50 + R, y:50 }); }
  else {
    for(let i = 0; i < right; i++){
      const tt = i / (right - 1);
      const d = -60 + tt * 120;
      const r = d * Math.PI / 180;
      pos.push({ x:50 + R*Math.cos(r), y:50 + R*Math.sin(r) });
    }
  }
  if(left === 1){ pos.push({ x:50 - R, y:50 }); }
  else if(left > 1){
    for(let i = 0; i < left; i++){
      const tt = i / (left - 1);
      const d = 120 + tt * 120;
      const r = d * Math.PI / 180;
      pos.push({ x:50 + R*Math.cos(r), y:50 + R*Math.sin(r) });
    }
  }
  return pos;
}

function computeActionOrders(){
  const n = G.players.length; if(!n) return;
  let start = (n === 2) ? G.dealerIndex : (G.dealerIndex + 3) % n;
  for(let i = 0; i < n; i++) G.players[(start+i)%n].preflopOrder = i + 1;
  if(n === 2){
    G.players[(G.dealerIndex+1)%n].postflopOrder = 1;
    G.players[G.dealerIndex].postflopOrder = 2;
  } else {
    const s = (G.dealerIndex + 1) % n;
    for(let i = 0; i < n; i++) G.players[(s+i)%n].postflopOrder = i + 1;
  }
}

/* ========== AI 单机部分 ========== */
function flyCard(from, to, delay){
  return new Promise(function(res){
    setTimeout(function(){
      if(!from || !to){ res(); return; }
      const a = from.getBoundingClientRect();
      const b = to.getBoundingClientRect();
      const el = document.createElement('div');
      el.className = 'flying-card';
      el.style.left = (a.left + a.width/2 - 12) + 'px';
      el.style.top = (a.top + a.height/2 - 17) + 'px';
      document.body.appendChild(el);
      void el.offsetWidth;
      const dx = (b.left + b.width/2) - (a.left + a.width/2);
      const dy = (b.top + b.height/2) - (a.top + a.height/2);
      el.style.transform = 'translate(' + dx + 'px,' + dy + 'px) scale(.65)';
      el.style.opacity = '0';
      setTimeout(function(){ el.remove(); res(); }, 520);
    }, delay || 0);
  });
}
async function playDealAnimation(){
  const dealer = $("dealerSeat");
  const deck = $("shuffleDeck");
  if(!dealer) return;
  if(deck){
    deck.classList.add("shuffling");
    PokerAudio.play('deal');
    await sleep(560);
    deck.classList.remove("shuffling");
  }
  const proms = [];
  let idx = 0;
  for(let r = 0; r < 2; r++){
    for(let i = 0; i < G.players.length; i++){
      const p = G.players[i];
      if(p.folded) continue;
      const tgt = document.querySelector('.seat[data-pid="' + p.id + '"]');
      if(tgt) proms.push(flyCard(dealer, tgt, idx * 60));
      idx++;
    }
  }
  await Promise.all(proms);
  await sleep(100);
}

async function startNewHandAi(){
  if(G._nextHandTimer){ clearInterval(G._nextHandTimer); G._nextHandTimer = null; }
  if(G._nextHandToastTimer){ clearInterval(G._nextHandToastTimer); G._nextHandToastTimer = null; }
  hideNextHandToast();

  G.handNumber++;
  G.sessionHands++;
  G.pot = 0; G.community = [];
  G.currentBet = 0; G.lastRaiseAmount = G.bigBlind;
  G.stage = "preflop"; G.busy = false;
  G._nextHandEndsAt = 0;
  G.deck = PokerDeck.create();
  PokerDeck.shuffle(G.deck);
  G._renderedCards = new WeakSet();
  G._lastBoardSig = ''; G._lastHandSig = ''; G._lastActionSig = '';
  stopTurnTimer();

  G.players.forEach(function(p){
    p.folded = p.chips <= 0; p.allIn = false; p.currentBet = 0;
    p.totalContributed = 0; p.needsToAct = false; p.lastAction = "";
    p.holeCards = []; p.revealCards = false; p._highlight = null; p._score = null;
  });

  G.playerHandStartChips = G.players[0].chips;
  assignPositions();
  computeActionOrders();

  const n = G.players.length;
  for(let r = 0; r < 2; r++){
    for(let i = 1; i <= n; i++){
      const idx = (G.dealerIndex + i) % n;
      const p = G.players[idx];
      if(!p.folded) p.holeCards.push(G.deck.pop());
    }
  }

  clearLog();
  log(t("handNum", { n:G.handNumber }) + " · " + t("dealerIs", { name:G.players[G.dealerIndex].name }), "hl");
  log(t("blindsAre", { sb:G.smallBlind, bb:G.bigBlind }), "hl");

  const gh = $("gameHandLabel");
  if(gh) gh.textContent = t("handShortLabel", { n:G.handNumber });

  render();
  await playDealAnimation();
  postBlinds();
  render();
  startPreflopAi();
}

function startPreflopAi(){
  const n = G.players.length;
  G.players.forEach(function(p){ p.needsToAct = !p.folded && !p.allIn && p.chips > 0; });
  let idx = n === 2 ? G.dealerIndex : (G.dealerIndex + 3) % n;
  let tries = 0;
  while((G.players[idx].folded || G.players[idx].allIn) && tries < n){ idx = (idx + 1) % n; tries++; }
  G.currentPlayerIndex = idx;
  render();
  runTurnAi();
}

function assignPositions(){
  const n = G.players.length;
  const names = {
    2:["posBTNSB","posBB"], 3:["posBTN","posSB","posBB"],
    4:["posBTN","posSB","posBB","posUTG"],
    5:["posBTN","posSB","posBB","posUTG","posCO"],
    6:["posBTN","posSB","posBB","posUTG","posHJ","posCO"],
    7:["posBTN","posSB","posBB","posUTG","posUTG1","posHJ","posCO"]
  }[n] || ["posBTN","posSB","posBB","posUTG","posUTG1","posHJ","posCO"];
  for(let i = 0; i < n; i++){
    const idx = (G.dealerIndex + i) % n;
    G.players[idx].positionKey = names[i];
    G.players[idx].position = t(names[i]);
  }
}

function postBlinds(){
  const n = G.players.length;
  const sbIdx = n === 2 ? G.dealerIndex : (G.dealerIndex + 1) % n;
  const bbIdx = n === 2 ? (G.dealerIndex + 1) % n : (G.dealerIndex + 2) % n;
  const sbP = G.players[sbIdx], bbP = G.players[bbIdx];
  const sb = Math.min(G.smallBlind, sbP.chips);
  sbP.chips -= sb; sbP.currentBet = sb; sbP.totalContributed += sb; G.pot += sb;
  if(sbP.chips === 0) sbP.allIn = true;
  const bb = Math.min(G.bigBlind, bbP.chips);
  bbP.chips -= bb; bbP.currentBet = bb; bbP.totalContributed += bb; G.pot += bb;
  if(bbP.chips === 0) bbP.allIn = true;
  G.currentBet = bb; G.lastRaiseAmount = G.bigBlind;
  log(t("sbBet", { name:sbP.name, amt:sb, name2:bbP.name, amt2:bb }), "action");
}

function countActive(){
  return G.players.filter(function(p){ return p.seated !== false && !p.folded; }).length;
}
function findNextToAct(){
  const n = G.players.length;
  for(let k = 0; k < n; k++){
    const idx = (G.currentPlayerIndex + k) % n;
    const p = G.players[idx];
    if(p.seated !== false && !p.folded && !p.allIn && p.needsToAct && p.chips > 0){
      G.currentPlayerIndex = idx; return true;
    }
  }
  return false;
}

function myIndex(){
  if(G.online.active) return G.online.mySeat;
  return 0;
}

function runTurnAi(){
  if(G.gameOver || G.busy) return;
  if(countActive() <= 1){
    const pot = G.pot;
    awardUncontestedPot();
    render();
    endHandAi(pot);
    return;
  }
  const notAllIn = G.players.filter(function(p){ return !p.folded && !p.allIn; });
  if(notAllIn.length === 0){ advanceStageAi(); return; }
  if(!findNextToAct()){ advanceStageAi(); return; }
  const p = G.players[G.currentPlayerIndex];
  render();
  if(p.isHuman){
    showHumanControls();
    PokerAudio.play('turn');
    startTurnTimer(p);
  } else {
    stopTurnTimer();
    G.busy = true;
    const ms = 800 + Math.random() * 2200;
    setTimeout(function(){
      G.busy = false;
      if(G.gameOver) return;
      const action = PokerAI.decide(p, G);
      executeAction(p, action);
      render(); runTurnAi();
    }, ms);
  }
}

function advanceStageAi(){
  stopTurnTimer();
  if(countActive() <= 1){
    const pot = G.pot;
    awardUncontestedPot();
    render();
    endHandAi(pot);
    return;
  }
  G.players.forEach(function(p){ p.currentBet = 0; p.lastAction = ""; });
  G.currentBet = 0; G.lastRaiseAmount = G.bigBlind;
  if(G.stage === "preflop"){
    G.stage = "flop";
    G.community.push(G.deck.pop(), G.deck.pop(), G.deck.pop());
    log(t("flopIs",{cards:G.community.map(function(c){return c.display;}).join("  ")}), "hl");
  } else if(G.stage === "flop"){
    G.stage = "turn";
    G.community.push(G.deck.pop());
    log(t("turnIs",{card:G.community[G.community.length-1].display}), "hl");
  } else if(G.stage === "turn"){
    G.stage = "river";
    G.community.push(G.deck.pop());
    log(t("riverIs",{card:G.community[G.community.length-1].display}), "hl");
  } else if(G.stage === "river"){ showdownAi(); return; }
  PokerAudio.play('deal');
  G.players.forEach(function(p){
    p.currentBet = 0; p.lastAction = "";
    p.needsToAct = !p.folded && !p.allIn && p.chips > 0;
  });
  G.currentBet = 0; G.lastRaiseAmount = G.bigBlind;
  const n = G.players.length;
  let idx = (G.dealerIndex + 1) % n;
  let tries = 0;
  while((G.players[idx].folded || G.players[idx].allIn) && tries < n){ idx = (idx + 1) % n; tries++; }
  G.currentPlayerIndex = idx;
  render();
  runTurnAi();
}

function executeAction(player, action){
  if(player.folded || player.allIn || player.seated === false) return;
  if(action.type === "fold"){
    player.folded = true; player.needsToAct = false;
    player.lastAction = t("actionFold");
    log(t("playerFolds", { name:player.name }), "action");
    PokerAudio.play('fold'); return;
  }
  if(action.type === "check"){
    player.needsToAct = false;
    player.lastAction = t("actionCheck");
    log(t("playerChecks", { name:player.name }), "action");
    PokerAudio.play('check'); return;
  }
  if(action.type === "call"){
    const toCall = Math.min(player.chips, G.currentBet - player.currentBet);
    player.chips -= toCall; player.currentBet += toCall; player.totalContributed += toCall;
    G.pot += toCall;
    if(player.chips === 0) player.allIn = true;
    player.needsToAct = false;
    player.lastAction = toCall === 0 ? t("actionCheck") : (t("actionCall") + " " + fmtNum(toCall));
    log(toCall === 0 ? t("playerChecks",{name:player.name}) : t("playerCalls",{name:player.name,amt:fmtNum(toCall)}), "action");
    PokerAudio.play(toCall === 0 ? 'check' : 'call'); return;
  }
  if(action.type === "raise"){
    const oldBet = G.currentBet;
    const max = player.chips + player.currentBet;
    let target;
    if(action.target != null){ target = Math.min(action.target, max); }
    else if(G.currentBet === 0){ target = Math.max(G.bigBlind, Math.floor(G.pot * 0.5)); }
    else {
      const minT = G.currentBet + Math.max(G.lastRaiseAmount, G.bigBlind);
      const potT = G.currentBet + Math.floor(G.pot * 0.6);
      target = Math.min(max, Math.max(minT, potT));
    }
    if(target <= G.currentBet){
      const toCall = Math.min(player.chips, G.currentBet - player.currentBet);
      player.chips -= toCall; player.currentBet += toCall; player.totalContributed += toCall;
      G.pot += toCall;
      if(player.chips === 0) player.allIn = true;
      player.needsToAct = false;
      player.lastAction = t("actionCall") + " " + fmtNum(toCall);
      log(t("playerCalls",{name:player.name,amt:fmtNum(toCall)}), "action");
      PokerAudio.play('call'); return;
    }
    const delta = target - player.currentBet;
    if(delta <= 0 || delta > player.chips) return;
    player.chips -= delta;
    player.currentBet = target;
    player.totalContributed += delta;
    G.pot += delta;
    if(player.chips === 0) player.allIn = true;
    if(target - oldBet > G.lastRaiseAmount) G.lastRaiseAmount = target - oldBet;
    if(target > G.currentBet) G.currentBet = target;
    player.needsToAct = false;
    player.lastAction = (oldBet === 0 ? t("actionBet") : t("actionRaiseTo")) + " " + fmtNum(target);
    log(oldBet === 0 ? t("playerBets",{name:player.name,amt:fmtNum(target)}) : t("playerRaises",{name:player.name,amt:fmtNum(target)}), "action");
    PokerAudio.play('raise');
    G.players.forEach(function(p){
      if(p !== player && !p.folded && !p.allIn && p.chips > 0 && p.seated !== false) p.needsToAct = true;
    });
  }
}

function endHandAi(totalPot){
  stopTurnTimer();
  const alive = G.players.filter(function(p){ return p.seated !== false && !p.folded; });
  const w = alive[0];
  if(!w) return;
  const pot = G.pot;
  if(pot > 0){
    w.chips += pot;
    log(t("winsPot",{name:w.name,pot:fmtNum(pot)}), "win");
    PokerAudio.play('win');
  }
  G.pot = 0; G.stage = "showdown";
  const me = G.players[0];
  PokerStorage.recordHand(me.chips - G.playerHandStartChips, (totalPot || pot));
  render();
  if(me.chips <= 0){ setTimeout(showRebuy, 800); return; }
  beginNextHandCountdown(startNewHandAi);
}

function calculateSidePots(){
  const c = G.players
    .filter(function(p){ return (p.totalContributed||0) > 0; })
    .map(function(p){ return { player:p, amount:p.totalContributed, folded:p.folded }; });
  const pots = [];
  let guard = 0;
  while(c.some(function(x){ return x.amount > 0; }) && guard < 20){
    guard++;
    const a = c.filter(function(x){ return x.amount > 0; });
    if(!a.length) break;
    const minA = Math.min.apply(null, a.map(function(x){ return x.amount; }));
    let amt = 0; const el = [];
    a.forEach(function(x){
      amt += minA; x.amount -= minA;
      if(!x.folded) el.push(x.player);
    });
    pots.push({ amount:amt, eligible:el });
  }
  return pots;
}

function showdownAi(){
  stopTurnTimer();
  G.stage = "showdown";
  G.busy = true;
  log(t("showdownHeader"), "hl");
  PokerAudio.play('showdown');
  const cont = G.players.filter(function(p){ return !p.folded; });
  cont.forEach(function(p){ p.revealCards = false; p._highlight = null; });
  render();
  let idx = 0;
  function next(){
    if(idx >= cont.length){ setTimeout(function(){ resolveAi(cont); }, 800); return; }
    const p = cont[idx];
    p.revealCards = true;
    render();
    PokerAudio.play('deal');
    log(t("reveals",{name:p.name,cards:p.holeCards.map(function(c){return c.display;}).join("  ")}), "showdown");
    idx++;
    setTimeout(next, 650);
  }
  next();
}

function resolveAi(cont){
  cont.forEach(function(p){
    const r = PokerEval.bestHand(p.holeCards.concat(G.community));
    p._score = r.score; p._bestCards = r.cards;
    log(t("handResult",{name:p.name,cards:p.holeCards.map(function(c){return c.display;}).join(" "),hand:PokerEval.nameOf(r.score)}), "showdown");
  });
  const pots = calculateSidePots();
  const n = pots.length;
  pots.forEach(function(pot, i){
    if(!pot.eligible.length) return;
    let best = null, ws = [];
    pot.eligible.forEach(function(p){
      if(best === null || PokerEval.compare(p._score, best) > 0){ best = p._score; ws = [p]; }
      else if(PokerEval.compare(p._score, best) === 0) ws.push(p);
    });
    const each = Math.floor(pot.amount / ws.length);
    const rem = pot.amount - each * ws.length;
    ws.forEach(function(w, k){ w.chips += each + (k === 0 ? rem : 0); });
    const lbl = n === 1 ? t("pot") : (i === 0 ? t("mainPot") : t("sidePot") + " " + i);
    log(t("winsPotSide",{name:ws.map(function(x){return x.name;}).join(", "),potLabel:lbl,amt:fmtNum(pot.amount),hand:PokerEval.nameOf(best)}), "win");
    if(!ws[0]._highlight && ws[0]._bestCards) ws[0]._highlight = new Set(ws[0]._bestCards);
  });
  const totalPot = pots.reduce(function(s,p){ return s + p.amount; }, 0);
  G.pot = 0; G.busy = false;
  PokerAudio.play('win');
  const me = G.players[0];
  PokerStorage.recordHand(me.chips - G.playerHandStartChips, totalPot);
  render();
  if(me.chips <= 0){ setTimeout(showRebuy, 800); return; }
  beginNextHandCountdown(startNewHandAi);
}

function showRebuy(){
  stopTurnTimer();
  const lv = LEVELS.find(function(l){ return l.key === G.tableMode; }) || LEVELS[0];
  const amount = lv.buyMin;
  $("rebuyOverlay").classList.remove("hidden");
  $("rebuyMsg").textContent = isEn()
    ? "Out of chips. Rebuy amount: " + fmtNum(amount)
    : "你的筹码用完了。补码额度 " + fmtNum(amount);
  $("rebuyGameBtn").onclick = function(){
    $("rebuyOverlay").classList.add("hidden");
    const me = G.players[myIndex()];
    if(G.gameMode === 'ai'){
      let ai = PokerStorage.getAiChips();
      if(ai < amount){ PokerStorage.addAiChips(amount - ai + 5000); ai = PokerStorage.getAiChips(); }
      PokerStorage.setAiChips(ai - amount);
    }
    me.chips = amount;
    G.sessionBuyIn += amount;
    PokerAudio.play('chip');
    rotateDealerAndStart(function(){
      if(G.gameMode === 'ai') startNewHandAi(); else startNewHandHost();
    });
  };
  $("leaveGameBtn").onclick = function(){
    $("rebuyOverlay").classList.add("hidden");
    backToLobby();
  };
}

/* ★ 离桌：清状态 + 清 DOM + 通知房主 */
function backToLobby(){
  stopTurnTimer();

  /* 房主：先广播 host_left */
  if(G.online.active && G.online.isHost && G.online.started && window.PokerOnline.sendHostLeft){
    try { PokerOnline.sendHostLeft(); } catch(e){}
  }

  const me = G.players[myIndex()];
  if(me && G.sessionBuyIn > 0){
    const pnl = me.chips - G.sessionBuyIn;
    if(G.gameMode === 'ai') PokerStorage.addAiChips(me.chips);
    else if(G.gameMode === 'points') PokerStorage.addPoints(me.chips);
    else if(G.gameMode === 'real') PokerStorage.addRealChips(me.chips);
    PokerStorage.addSession({
      table: G.tableLabel, blinds: G.smallBlind + "/" + G.bigBlind,
      buyIn: G.sessionBuyIn, pnl: pnl, hands: G.sessionHands,
      status: 'left', mode: G.gameMode
    });
  }

  if(G.online.active){
    try { PokerOnline.leaveRoom(); } catch(e){}
    G.online.active = false;
  }

  /* ★ 彻底清掉牌桌层 + DOM */
  resetSessionState();
  resetTableDom();
  hideWaitingBar();
  hideNextHandToast();

  G.gameOver = true;
  $("gameScreen").classList.add("hidden");
  $("lobbyScreen").classList.remove("hidden");
  $("onlineLobby").classList.add("hidden");
  $("nextHandBtn").classList.add("hidden");
  $("humanActions").innerHTML = "";
  $("raisePanel").classList.add("hidden");
  $("handCardsLarge").innerHTML = "";
  showScreen("lobby");
  renderRoomLists();
}

/* ========== 渲染 ========== */
function renderCardEl(card, mini, hl){
  const d = document.createElement("div");
  const isNew = !G._renderedCards.has(card);
  if(isNew) G._renderedCards.add(card);
  const cls = "face " + (card.red ? "red" : "black") + (hl ? " highlight" : "") + (isNew ? " card-new" : "");
  if(mini){
    d.className = "mini-card " + cls;
    d.innerHTML = '<div class="v">' + card.rank + '</div><div class="s">' + card.suit + '</div>';
  } else {
    d.className = "card " + (card.red ? "red" : "black") + (hl ? " highlight" : "") + (isNew ? " card-new" : "");
    d.innerHTML = '<div class="v">' + card.rank + '</div><div class="s">' + card.suit + '</div>';
  }
  return d;
}
function renderCardBackMini(){ const d = document.createElement("div"); d.className = "mini-card"; return d; }
function posCls(k){
  if(!k) return "";
  if(k === "posBTNSB" || k === "posBTN") return "btn";
  if(k === "posSB") return "sb";
  if(k === "posBB") return "bb";
  return "";
}

function render(){
  const container = $("seatsLayer");
  if(!container) return;

  /* ★ 等待状态：渲染固定 7 座，空格子画虚线 */
  if(G.online.active && G.stage === 'waiting'){
    renderWaitingTable(container);
    /* 底池/公共牌/手牌区清空 */
    const bc = document.getElementById('boardCards'); if(bc) bc.innerHTML = '';
    const pm = document.getElementById('potMain'); if(pm) pm.textContent = '0';
    const ps = document.getElementById('potSideWrap'); if(ps) ps.classList.add('hidden');
    const handArea = document.getElementById('handCardsLarge'); if(handArea) handArea.innerHTML = '';
    const sl = document.getElementById('stageLabel');
    if(sl) sl.textContent = isEn() ? 'Waiting' : '等待中';
    return;
  }

  if(!G.players.length) return;

  for(let i = 0; i < G.players.length; i++){
    const p = G.players[i];
    const style = p.isHuman ? null : PokerAI.STYLES[p.styleKey];
    let seat = container.querySelector('.seat[data-pid="' + p.id + '"]');
    const pos = G.seatPositions[p.id] || { x:50, y:50 };

    if(!seat){
      seat = document.createElement("div");
      seat.className = "seat";
      seat.setAttribute("data-pid", p.id);
      container.appendChild(seat);
    }

    seat.style.left = pos.x + "%";
    seat.style.top = pos.y + "%";
    seat.classList.toggle("folded", !!p.folded || p.seated === false);
    seat.classList.toggle("reveal", !!p.revealCards);
    seat.classList.toggle("empty", p.seated === false);
    seat.classList.toggle("active", G.currentPlayerIndex === i && !G.gameOver && !p.folded && G.stage !== "showdown");

    let betInfo = "";
    if(p.seated === false){
      betInfo = isEn() ? "Left" : "已离桌";
    } else {
      if(p.currentBet > 0) betInfo = t("actionBet") + " " + fmtNum(p.currentBet);
      if(p.lastAction) betInfo += (betInfo ? " · " : "") + p.lastAction;
    }

    const posHtml = p.position ? '<span class="pos-badge ' + posCls(p.positionKey) + '">' + p.position + '</span>' : '';
    let styleHtml = '';
    if(G.online.active){
      styleHtml = '<span class="seat-style">P2P</span>';
    } else if(style){
      styleHtml = '<span class="seat-style">' + t(style.name) + '</span>';
    } else {
      styleHtml = '<span class="seat-style">' + t("handShort") + '</span>';
    }

    let avatarHtml;
    if(G.online.active){
      const initial = (p.name || 'P').charAt(0).toUpperCase();
      avatarHtml = '<div class="avatar-wrap" style="background:' + p.bg + '">' + initial + '</div>';
    } else {
      avatarHtml = '<div class="avatar-wrap" style="background:' + p.bg + '">' + p.emoji + '</div>';
    }

    const metaSig = [p.name, p.chips, betInfo, p.position, styleHtml, avatarHtml, p.seated === false ? 1 : 0].join('|');
    if(seat.getAttribute('data-meta') !== metaSig){
      seat.setAttribute('data-meta', metaSig);
      seat.innerHTML =
        '<div class="seat-head">' + avatarHtml +
          '<div class="seat-meta">' +
            '<div class="seat-name">' + p.name + '</div>' +
            '<div>' + posHtml + styleHtml + '</div>' +
          '</div>' +
        '</div>' +
        '<div class="seat-chips">' + fmtNum(p.chips) + ' ' + t("chips") + '</div>' +
        '<div class="seat-bet">' + betInfo + '</div>' +
        '<div class="seat-cards"></div>';
      seat.removeAttribute('data-card-sig');
    }

    const cards = seat.querySelector(".seat-cards");
    let nextCards = [];
    let showFace = false;
    if(p.seated === false || p.folded || p.holeCards.length < 2){
      nextCards = [null, null];
    } else if(p.revealCards || i === myIndex()){
      nextCards = p.holeCards;
      showFace = true;
    } else {
      nextCards = [null, null];
    }
    const cardSig = (showFace ? 'F:' : 'B:') + cardsSig(nextCards);
    if(cards && seat.getAttribute('data-card-sig') !== cardSig){
      seat.setAttribute('data-card-sig', cardSig);
      cards.innerHTML = "";
      if(!showFace){
        const a = renderCardBackMini();
        const b = renderCardBackMini();
        if(p.seated === false || p.folded || p.holeCards.length < 2){
          a.style.opacity = ".2"; b.style.opacity = ".2";
        }
        cards.appendChild(a); cards.appendChild(b);
      } else {
        p.holeCards.forEach(function(c){
          cards.appendChild(renderCardEl(c, true, p._highlight && p._highlight.has(c)));
        });
      }
    }
  }

  /* 移除已不存在的座位 */
  Array.prototype.slice.call(container.querySelectorAll('.seat')).forEach(function(el){
    const pid = el.getAttribute('data-pid');
    const exists = G.players.some(function(p){ return String(p.id) === String(pid); });
    if(!exists) el.remove();
  });

  const bc = $("boardCards");
  if(bc){
    const hlSet = new Set();
    G.players.forEach(function(p){ if(p._highlight) p._highlight.forEach(function(c){ hlSet.add(c); }); });
    const boardSig = cardsSig(G.community) + '|' + G.community.map(function(c){ return hlSet.has(c) ? 1 : 0; }).join('');
    if(G._lastBoardSig !== boardSig){
      G._lastBoardSig = boardSig;
      bc.innerHTML = "";
      G.community.forEach(function(c){ bc.appendChild(renderCardEl(c, false, hlSet.has(c))); });
    }
  }

  renderHumanHand();

  const pots = calculateSidePots();
  const pm = $("potMain"), psw = $("potSideWrap"), ps = $("potSide");
  if(pm){
    if(!pots.length){ pm.textContent = fmtNum(G.pot); if(psw) psw.classList.add("hidden"); }
    else {
      pm.textContent = fmtNum(pots[0].amount);
      if(pots.length > 1){
        const s = pots.slice(1).reduce(function(a, p){ return a + p.amount; }, 0);
        if(ps) ps.textContent = fmtNum(s);
        if(psw) psw.classList.remove("hidden");
      } else if(psw) psw.classList.add("hidden");
    }
  }
  const sl = $("stageLabel");
  if(sl) sl.textContent = t(STAGE_KEYS[G.stage] || "stagePreflop");
  updateHandInfo();
}

/* ★ 等待状态下的 7 座渲染 */
function renderWaitingTable(container){
  /* 保留等待栏相关的兄弟节点，先清空座位 */
  Array.prototype.slice.call(container.querySelectorAll('.seat')).forEach(function(el){ el.remove(); });
  /* 特殊：清理旧座位上可能挂的 ready badge */
  Array.prototype.slice.call(container.querySelectorAll('.seat-empty-slot')).forEach(function(el){ el.remove(); });

  const myId = window.PokerOnline ? PokerOnline.getMyId() : null;
  const players = window.PokerOnline ? PokerOnline.getRoomPlayers() : {};
  const mySeat = G.online.mySeat;

  for(let seatIdx = 0; seatIdx < ONLINE_MAX_SEATS; seatIdx++){
    /* 找占用这个座位的玩家 */
    let p = null;
    for(const pid in players){
      if(players[pid].seat === seatIdx){ p = { peerId: pid, info: players[pid] }; break; }
    }
    const pos = G.seatPositions[seatIdx] || { x:50, y:50 };

    if(!p){
      /* 空格子 */
      const empty = document.createElement("div");
      empty.className = "seat empty seat-empty-slot";
      empty.setAttribute("data-seat", seatIdx);
      empty.style.left = pos.x + "%";
      empty.style.top = pos.y + "%";
      empty.innerHTML = '<div class="empty-label">' + (isEn() ? 'Empty' : '空位') + '</div>';
      container.appendChild(empty);
      continue;
    }

    const isSelf = p.peerId === myId;
    const seat = document.createElement("div");
    seat.className = "seat";
    seat.setAttribute("data-seat", seatIdx);
    seat.style.left = pos.x + "%";
    seat.style.top = pos.y + "%";
    if(isSelf) seat.classList.add("active");

    const initial = (p.info.name || 'P').charAt(0).toUpperCase();
    const bg = isSelf ? PokerAvatars.HUMAN.bg : 'linear-gradient(135deg,#a855f7,#6d28d9)';
    const readyBadge = p.info.ready
      ? '<div class="ready-badge">✓ ' + (isEn() ? 'Ready' : '已准备') + '</div>'
      : '<div class="not-ready-badge">' + (isEn() ? 'Waiting' : '未准备') + '</div>';

    seat.innerHTML =
      readyBadge +
      '<div class="seat-head">' +
        '<div class="avatar-wrap" style="background:' + bg + '">' + initial + '</div>' +
        '<div class="seat-meta">' +
          '<div class="seat-name">' + p.info.name + (isSelf ? (isEn() ? ' (you)' : ' (你)') : '') + '</div>' +
          '<div><span class="seat-style">P2P</span></div>' +
        '</div>' +
      '</div>' +
      '<div class="seat-chips">10,000 ' + t("chips") + '</div>' +
      '<div class="seat-bet">' + (isEn() ? 'Seat ' : '座位 ') + (seatIdx + 1) + '</div>';
    container.appendChild(seat);
  }
}

function renderHumanHand(){
  const me = G.players[myIndex()];
  if(!me){
    const c = $("handCardsLarge"); if(c) c.innerHTML = "";
    return;
  }
  const c = $("handCardsLarge");
  if(!c) return;
  const bem = $("handBem");
  if(bem) bem.textContent = G.gameMode === 'real' ? "≈ " + toBem(me.chips) + " BEM" : fmtNum(me.chips) + (isEn() ? " chips" : " 筹码");

  let sig;
  if(!me || me.folded || me.holeCards.length < 2 || G.stage === 'waiting'){
    sig = 'empty';
  } else {
    sig = cardsSig(me.holeCards) + '|' + (me._highlight ? cardsSig(Array.from(me._highlight)) : '');
  }
  if(G._lastHandSig === sig) return;
  G._lastHandSig = sig;

  c.innerHTML = "";
  if(sig === 'empty'){
    const a = document.createElement("div"); a.className = "card"; a.style.opacity = ".2";
    const b = document.createElement("div"); b.className = "card"; b.style.opacity = ".2";
    c.appendChild(a); c.appendChild(b);
    return;
  }
  me.holeCards.forEach(function(card){
    const d = document.createElement("div");
    d.className = "card " + (card.red ? "red" : "black") + (me._highlight && me._highlight.has(card) ? " highlight" : "");
    d.innerHTML = '<div class="v">' + card.rank + '</div><div class="s">' + card.suit + '</div>';
    c.appendChild(d);
  });
}

function updateHandInfo(){
  const el = $("handInfo");
  if(!el) return;
  if(!G.players.length){ el.innerHTML = ""; return; }
  const me = G.players[myIndex()];
  if(!me) return;
  const toCall = Math.max(0, G.currentBet - (me.currentBet || 0));
  el.innerHTML =
    '<div class="row"><span>' + t("infoHand") + '</span><strong>#' + G.handNumber + '</strong></div>' +
    '<div class="row"><span>' + t("infoStage") + '</span><strong>' + t(STAGE_KEYS[G.stage] || "stagePreflop") + '</strong></div>' +
    '<div class="row"><span>' + t("infoPot") + '</span><strong>' + fmtNum(G.pot) + '</strong></div>' +
    '<div class="row"><span>' + t("infoYourBet") + '</span><strong>' + fmtNum(me.currentBet || 0) + '</strong></div>' +
    '<div class="row"><span>' + t("infoToCall") + '</span><strong>' + fmtNum(toCall) + '</strong></div>';
}

function showHumanControls(){
  const me = G.players[myIndex()];
  if(!me) return;
  const box = $("humanActions");
  const panel = $("raisePanel");
  if(!box || !panel) return;

  if(G.stage === 'waiting' || me.seated === false || me.folded || me.allIn || me.chips <= 0 || G.currentPlayerIndex !== myIndex()){
    hideHumanActions();
    return;
  }

  const sig = buildActionSig();
  const raiseOpen = !panel.classList.contains("hidden");
  if(raiseOpen) return;
  if(G._lastActionSig === sig && box.childNodes.length) return;
  G._lastActionSig = sig;

  box.innerHTML = "";

  const toCall = Math.max(0, G.currentBet - me.currentBet);
  const canCheck = toCall === 0;

  const foldBtn = document.createElement("button");
  foldBtn.className = "danger";
  foldBtn.textContent = t("actionFold");
  foldBtn.onclick = function(){ doHumanAction({ type:"fold" }); };
  box.appendChild(foldBtn);

  const callBtn = document.createElement("button");
  callBtn.textContent = canCheck ? t("actionCheck") : (t("actionCall") + " " + fmtNum(Math.min(me.chips, toCall)));
  callBtn.onclick = function(){ doHumanAction({ type:"call" }); };
  box.appendChild(callBtn);

  if(me.chips > toCall){
    const raiseBtn = document.createElement("button");
    raiseBtn.textContent = canCheck ? t("actionBetMenu") : t("actionRaise");
    raiseBtn.onclick = openRaisePanel;
    box.appendChild(raiseBtn);
  }
}

function openRaisePanel(){
  const me = G.players[myIndex()];
  const panel = $("raisePanel");
  const oldBet = G.currentBet;
  const max = me.chips + me.currentBet;
  let minT = oldBet === 0 ? G.bigBlind * 2 : oldBet * 2;
  const std = oldBet === 0 ? G.bigBlind : (oldBet + Math.max(G.lastRaiseAmount, G.bigBlind));
  if(std > minT) minT = std;
  if(minT > max) minT = max;
  if(max <= oldBet) return;
  G.raiseMin = minT; G.raiseMax = max;
  const sl = $("raiseSlider"); if(sl) sl.value = 0;
  const a = $("raiseMinLabel"), b = $("raiseMaxLabel");
  if(a) a.textContent = fmtNum(minT);
  if(b) b.textContent = fmtNum(max);
  updateRaiseAmount();
  panel.classList.remove("hidden");
}

function updateRaiseAmount(){
  const sl = $("raiseSlider"), d = $("raiseAmountValue");
  if(!sl || !d) return;
  const pct = parseInt(sl.value, 10) / 1000;
  d.textContent = fmtNum(Math.round(G.raiseMin + (G.raiseMax - G.raiseMin) * pct));
}

function applyRaisePreset(preset){
  const me = G.players[myIndex()];
  const oldBet = G.currentBet;
  const max = G.raiseMax;
  const toCall = Math.max(0, oldBet - me.currentBet);
  let target;
  if(preset === 'allin') target = max;
  else {
    const potAfter = G.pot + toCall;
    let amt;
    if(preset === 'half') amt = Math.floor(potAfter * 0.5);
    else if(preset === 'threeQuarter') amt = Math.floor(potAfter * 0.75);
    else amt = potAfter;
    target = oldBet === 0 ? Math.max(G.bigBlind, amt) : (oldBet + amt);
  }
  if(target < G.raiseMin) target = G.raiseMin;
  if(target > max) target = max;
  const range = max - G.raiseMin;
  const pct = range <= 0 ? 0 : (target - G.raiseMin) / range;
  const sl = $("raiseSlider"); if(sl) sl.value = Math.round(pct * 1000);
  updateRaiseAmount();
}

function doHumanAction(action){
  const me = G.players[myIndex()];
  if(!me || me.folded || me.allIn || me.seated === false) return;
  if(G.stage === 'waiting') return;
  if(G.currentPlayerIndex !== myIndex()) return;
  stopTurnTimer();
  hideHumanActions();

  if(G.online.active && !G.online.isHost){
    PokerOnline.sendPlayerAction({
      playerId: PokerOnline.getMyId(),
      action: action
    });
    return;
  }

  executeAction(me, action);
  render();
  if(G.online.active && G.online.isHost){
    broadcastFullState();
    runHostTurn();
  } else {
    runTurnAi();
  }
}

function startTurnTimer(player){
  if(!player || !player.isHuman) return;
  if(G.turnTimer) return;
  G.turnTimeLeft = 30;
  updateTimerUI();
  const tt = $("turnTimer"); if(tt) tt.classList.remove("hidden");
  G.turnTimer = setInterval(function(){
    G.turnTimeLeft -= 0.1;
    if(G.turnTimeLeft <= 0){
      stopTurnTimer();
      const me = G.players[myIndex()];
      if(me && !me.folded && !me.allIn && me.seated !== false){
        log(t("timeoutFold", { name:me.name }), "action");
        doHumanAction({ type:"fold" });
      }
      return;
    }
    updateTimerUI();
  }, 100);
}
function stopTurnTimer(){
  if(G.turnTimer){ clearInterval(G.turnTimer); G.turnTimer = null; }
  if(G._turnTickTimer){ clearInterval(G._turnTickTimer); G._turnTickTimer = null; }
  G._timerKey = null;
  const tt = $("turnTimer"); if(tt) tt.classList.add("hidden");
}
function updateTimerUI(){
  const f = $("timerFill"), t2 = $("timerText");
  if(!f || !t2) return;
  const pct = Math.max(0, G.turnTimeLeft / 30) * 100;
  f.style.width = pct + "%";
  t2.textContent = Math.ceil(Math.max(0, G.turnTimeLeft)) + "s";
  if(G.turnTimeLeft <= 5){ f.classList.add("warn"); t2.classList.add("warn"); }
  else { f.classList.remove("warn"); t2.classList.remove("warn"); }
}

/* ========== 初始化 ========== */
document.addEventListener("DOMContentLoaded", function(){
  const saved = (function(){
    try { return localStorage.getItem('neon_holdem_lang') || 'zh'; }
    catch(e){ return 'zh'; }
  })();
  PokerI18n.setLang(saved);
  const ls = $("langSelect"); if(ls) ls.value = saved;

  if(ls) ls.addEventListener("change", function(){
    PokerI18n.setLang(this.value);
    try { localStorage.setItem('neon_holdem_lang', this.value); } catch(e){}
    PokerI18n.apply(document);
    renderLobby();
    renderNumbers();
    if(G.players.length && !$("gameScreen").classList.contains("hidden")){
      render();
    }
  });

  document.querySelectorAll(".nav-link").forEach(function(a){
    a.addEventListener("click", function(){ showScreen(a.getAttribute("data-nav")); });
  });

  document.querySelectorAll(".mode-tab").forEach(function(tab){
    tab.addEventListener("click", function(){
      document.querySelectorAll(".mode-tab").forEach(function(x){ x.classList.remove("active"); });
      tab.classList.add("active");
      const mode = tab.getAttribute("data-mode");
      ["aiSection","pointsSection","realSection"].forEach(function(id){
        const el = $(id); if(el) el.classList.add("hidden");
      });
      if(mode === "ai") $("aiSection").classList.remove("hidden");
      else if(mode === "points") $("pointsSection").classList.remove("hidden");
      else {
        $("realSection").classList.remove("hidden");
        if(window.PokerWallet) PokerWallet.updateUI();
      }
      renderRoomLists();
    });
  });

  document.querySelectorAll(".seats-btn").forEach(function(btn){
    btn.addEventListener("click", function(){
      document.querySelectorAll(".seats-btn").forEach(function(x){ x.classList.remove("active"); });
      btn.classList.add("active");
      G.aiSeats = parseInt(btn.getAttribute("data-seats"), 10);
      renderTableGrid("aiTableGrid", "ai");
    });
  });

  if(window.PokerOnline){
    PokerOnline.init().then(function(){
      PokerOnline.setMessageCallback(handleOnlineMessage);
      PokerOnline.setPlayersCallback(function(){
        updateWaitingBar();
        /* ★ 名单变化时同步等待座位 */
        if(G.online.active && (G.stage === 'waiting' || !G.online.started)){
          syncWaitingSeatsFromRoom();
        }
      });
      PokerOnline.setRoomsCallback(function(){ renderRoomLists(); });
      renderLobby();
    }).catch(function(err){
      console.warn('Supabase init failed', err);
      renderLobby();
    });
  } else {
    renderLobby();
  }

  const qs = $("quickAiBtn");
  if(qs) qs.onclick = function(){ openAiLevel(LEVELS[0]); };

  const aiRb = $("aiRebuyBtn");
  if(aiRb) aiRb.onclick = function(){
    const amt = parseInt($("aiRebuyAmount").value, 10);
    PokerStorage.addAiChips(amt);
    refreshBalanceUI();
  };

  const cp = $("claimPointsBtn");
  if(cp) cp.onclick = function(){
    const res = PokerStorage.claimDailyPoints();
    if(res.ok){
      alert(isEn() ? ("Claimed! +" + res.amount.toLocaleString()) : ("领取成功！+" + res.amount.toLocaleString()));
      refreshBalanceUI();
    } else {
      alert(isEn() ? "Already claimed today." : "今天已经领过了");
    }
  };

  const sn = $("saveNicknameBtn");
  if(sn) sn.onclick = function(){
    const v = $("nicknameInput").value.trim();
    if(!v){ alert(isEn() ? "Enter a nickname" : "请输入昵称"); return; }
    PokerStorage.setNickname(v);
    alert(isEn() ? ("Saved: " + v) : ("已保存：" + v));
  };

  const cw = $("connectWalletBtn");
  const rc = $("realConnectBtn");
  const doConnect = async function(){
    try {
      const res = await PokerWallet.connect();
      if(res){ $("walletOverlay").classList.add("hidden"); refreshBalanceUI(); }
      else { alert(isEn() ? "Connect failed" : "连接失败"); }
    } catch(e){ console.error(e); alert(isEn() ? "Connect failed" : "连接失败"); }
  };
  if(cw) cw.onclick = doConnect;
  if(rc) rc.onclick = doConnect;

  const db = $("depositBtn");
  if(db) db.onclick = async function(){
    if(!PokerWallet.isConnected()){ alert(isEn() ? "Connect wallet first" : "请先连接钱包"); return; }
    const amt = parseFloat($("depositAmount").value);
    if(!amt || amt <= 0){ alert(isEn() ? "Enter an amount" : "请输入充值数量"); return; }
    if(amt < 1){ alert(isEn() ? "Minimum 1 BEM" : "最低充值 1 BEM"); return; }
    try {
      const res = await PokerWallet.depositBem(amt);
      if(res && res.netChips > 0){
        PokerStorage.setRealChips(PokerStorage.getRealChips() + res.netChips);
        refreshBalanceUI();
        $("depositAmount").value = "";
        alert(isEn() ? ("Deposited +" + res.netChips.toLocaleString()) : ("充值成功 +" + res.netChips.toLocaleString()));
      }
    } catch(err){ console.error(err); alert(isEn() ? "Deposit failed" : "充值失败"); }
  };

  const wcb = $("walletConnectBtn");
  if(wcb) wcb.onclick = doConnect;
  const wcl = $("walletCloseBtn");
  if(wcl) wcl.onclick = function(){ $("walletOverlay").classList.add("hidden"); };

  const rnb = $("resetNumbersBtn");
  if(rnb) rnb.onclick = function(){
    if(confirm(isEn() ? "Reset all numbers?" : "确定清空所有战绩记录吗？")){
      PokerStorage.resetStats();
      renderNumbers();
    }
  };

  const back = $("backToLobbyBtn");
  if(back) back.onclick = function(){
    if(confirm(isEn() ? "Leave the table?" : "确定离桌吗？")) backToLobby();
  };
  const ngb = $("newGameBtn");
  if(ngb) ngb.onclick = function(){ $("gameOverOverlay").classList.add("hidden"); backToLobby(); };

  const rs = $("raiseSlider"); if(rs) rs.addEventListener("input", updateRaiseAmount);
  const crb = $("cancelRaiseBtn");
  if(crb) crb.onclick = function(){ $("raisePanel").classList.add("hidden"); };
  const cfr = $("confirmRaiseBtn");
  if(cfr) cfr.onclick = function(){
    const sl = $("raiseSlider");
    const pct = parseInt(sl.value, 10) / 1000;
    const amt = Math.round(G.raiseMin + (G.raiseMax - G.raiseMin) * pct);
    doHumanAction({ type:"raise", target:amt });
  };
  const rp = $("raisePresets");
  if(rp) rp.addEventListener("click", function(e){
    const b = e.target.closest('button[data-preset]');
    if(b) applyRaisePreset(b.getAttribute('data-preset'));
  });
});
})();
