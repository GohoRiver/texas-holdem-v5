window.PokerOnline = (function(){
  const SUPABASE_URL = 'https://olmlqguftnmnpyefrokk.supabase.co';
  const SUPABASE_ANON_KEY = 'sb_publishable_QSRZnWEj0nJ1QdxmqBgPcA_0n9fP4oK';

  let supabase = null;
  let channel = null;
  let myId = null;
  let nickname = 'Player';
  let currentRoomId = null;
  let isHost = false;

  let roomPlayers = {};
  let onMessage = null;
  let onPlayersUpdate = null;
  let onRoomsUpdate = null;
  let heartbeatTimer = null;

  let lobbyChannel = null;
  let lobbyRooms = {};
  let hostRoomInfo = null;
  let hostAnnounceTimer = null;
  const ROOM_TTL_MS = 8000;
  const ANNOUNCE_MS = 2000;
  const MAX_SEATS = 7;

  function init(){
    if(!window.supabase){ return Promise.reject(new Error('Supabase SDK not loaded')); }
    supabase = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
    myId = 'p-' + Math.random().toString(36).slice(2, 10);
    nickname = PokerStorage.getNickname() || 'Player';
    console.log('[Supabase] initialized, myId:', myId);
    try { initLobbyChannel(); }
    catch(e){ console.warn('[Supabase] lobby channel init failed', e); }
    return Promise.resolve();
  }

  function setMessageCallback(cb){ onMessage = cb; }
  function setPlayersCallback(cb){ onPlayersUpdate = cb; }
  function setRoomsCallback(cb){ onRoomsUpdate = cb; }

  function initLobbyChannel(){
    if(lobbyChannel) return;
    lobbyChannel = supabase.channel('lobby', { config: { broadcast: { self: false } } });

    lobbyChannel.on('broadcast', { event: 'room_available' }, (payload) => {
      const p = payload && payload.payload;
      if(!p || !p.roomId) return;
      lobbyRooms[p.roomId] = Object.assign({}, p, { _ts: Date.now() });
      if(onRoomsUpdate) onRoomsUpdate(getKnownRooms());
    });

    lobbyChannel.on('broadcast', { event: 'room_closed' }, (payload) => {
      const rid = payload && payload.payload && payload.payload.roomId;
      if(rid && lobbyRooms[rid]){
        delete lobbyRooms[rid];
        if(onRoomsUpdate) onRoomsUpdate(getKnownRooms());
      }
    });

    lobbyChannel.on('broadcast', { event: 'room_list_request' }, () => {
      if(isHost && hostRoomInfo){
        try { lobbyChannel.send({ type:'broadcast', event:'room_available', payload: hostRoomInfo }); } catch(e){}
      }
    });

    lobbyChannel.subscribe(function(status){
      if(status === 'SUBSCRIBED'){
        try { lobbyChannel.send({ type:'broadcast', event:'room_list_request', payload:{} }); } catch(e){}
      }
    });
  }

  function getKnownRooms(){
    const now = Date.now();
    const out = [];
    for(const rid in lobbyRooms){
      const r = lobbyRooms[rid];
      if(now - (r._ts || 0) > ROOM_TTL_MS){ delete lobbyRooms[rid]; continue; }
      out.push(r);
    }
    return out;
  }

  function announceRoom(){
    if(!lobbyChannel || !hostRoomInfo) return;
    hostRoomInfo.count = Object.keys(roomPlayers).length || 1;
    try { lobbyChannel.send({ type:'broadcast', event:'room_available', payload: hostRoomInfo }); } catch(e){}
  }

  function stopAnnounce(){
    if(lobbyChannel && hostRoomInfo){
      try {
        lobbyChannel.send({ type:'broadcast', event:'room_closed', payload: { roomId: hostRoomInfo.roomId } });
      } catch(e){}
    }
    hostRoomInfo = null;
    if(hostAnnounceTimer){ clearInterval(hostAnnounceTimer); hostAnnounceTimer = null; }
  }

  function nextFreeSeat(){
    const used = {};
    Object.keys(roomPlayers).forEach(function(pid){ used[roomPlayers[pid].seat] = true; });
    for(let i = 0; i < MAX_SEATS; i++){ if(!used[i]) return i; }
    return Object.keys(roomPlayers).length;
  }

  function createRoom(roomId, info){
    isHost = true;
    currentRoomId = roomId;
    info = info || {};

    channel = supabase.channel('room-' + roomId, { config: { broadcast: { self: true } } });

    channel.on('broadcast', { event: 'player_join' }, (payload) => {
      if(!isHost) return;
      const p = payload.payload;
      if(!roomPlayers[p.peerId]){
        if(Object.keys(roomPlayers).length >= MAX_SEATS){
          try { channel.send({ type:'broadcast', event:'room_full', payload:{ peerId: p.peerId } }); } catch(e){}
          return;
        }
        roomPlayers[p.peerId] = {
          name: p.name, ready: false,
          seat: nextFreeSeat(),
          isSelf: false
        };
        broadcastPlayerList();
        notifyPlayers();
        announceRoom();
      } else {
        broadcastPlayerList();
      }
    });

    channel.on('broadcast', { event: 'ready' }, (payload) => {
      if(!isHost) return;
      const p = payload.payload;
      if(roomPlayers[p.peerId]) roomPlayers[p.peerId].ready = p.ready;
      broadcastPlayerList();
      notifyPlayers();
      tryStartGame();
    });

    channel.on('broadcast', { event: 'leave' }, (payload) => {
      const p = payload.payload;
      if(roomPlayers[p.peerId]){
        delete roomPlayers[p.peerId];
        broadcastPlayerList();
        notifyPlayers();
        try { channel.send({ type:'broadcast', event:'player_leave', payload: { peerId: p.peerId } }); } catch(e){}
        if(onMessage) onMessage({ type: 'player_leave', peerId: p.peerId });
        announceRoom();
        /* 准备室里有人走，如果之前凑齐了，现在可能不够，检查一下 */
        if(isHost) tryStartGame();
      }
    });

    channel.on('broadcast', { event: 'sync_request' }, (payload) => {
      if(!isHost) return;
      if(onMessage) onMessage({ type: 'sync_request', peerId: payload.payload.peerId });
    });

    channel.on('broadcast', { event: 'player_action' }, (payload) => {
      if(!isHost) return;
      if(onMessage) onMessage({ type: 'player_action', ...payload.payload });
    });

    hostRoomInfo = {
      roomId: roomId,
      level: info.level || 'nano',
      mode: info.mode || 'points',
      hostName: nickname,
      count: 1,
      maxSeats: MAX_SEATS
    };

    return new Promise(function(resolve){
      channel.subscribe(function(status){
        if(status === 'SUBSCRIBED'){
          roomPlayers[myId] = { name: nickname, ready: false, seat: 0, isSelf: true };
          broadcastPlayerList();
          notifyPlayers();
          announceRoom();
          if(hostAnnounceTimer) clearInterval(hostAnnounceTimer);
          hostAnnounceTimer = setInterval(announceRoom, ANNOUNCE_MS);
          resolve();
        }
      });
    });
  }

  function joinRoom(roomId){
    isHost = false;
    currentRoomId = roomId;

    channel = supabase.channel('room-' + roomId, { config: { broadcast: { self: false } } });

    channel.on('broadcast', { event: 'player_list' }, (payload) => {
      roomPlayers = {};
      (payload.payload.players || []).forEach(function(p){
        roomPlayers[p.peerId] = {
          name: p.name, ready: p.ready, seat: p.seat,
          isSelf: p.peerId === myId
        };
      });
      notifyPlayers();
    });

    channel.on('broadcast', { event: 'ready' }, (payload) => {
      const p = payload.payload;
      if(roomPlayers[p.peerId]) roomPlayers[p.peerId].ready = p.ready;
      notifyPlayers();
    });

    channel.on('broadcast', { event: 'leave' }, (payload) => {
      const p = payload.payload;
      if(roomPlayers[p.peerId]){ delete roomPlayers[p.peerId]; notifyPlayers(); }
    });

    channel.on('broadcast', { event: 'player_leave' }, (payload) => {
      if(onMessage) onMessage({ type: 'player_leave', peerId: payload.payload.peerId });
    });

    channel.on('broadcast', { event: 'room_full' }, (payload) => {
      if(payload.payload.peerId === myId){
        if(onMessage) onMessage({ type: 'room_full' });
      }
    });

    channel.on('broadcast', { event: 'host_left' }, () => {
      if(onMessage) onMessage({ type: 'host_left' });
    });

    channel.on('broadcast', { event: 'game_start' }, (payload) => {
      if(onMessage) onMessage({ type: 'game_start', ...payload.payload });
    });

    channel.on('broadcast', { event: 'full_state' }, (payload) => {
      if(onMessage) onMessage({ type: 'full_state', state: payload.payload });
    });

    return new Promise(function(resolve){
      channel.subscribe(function(status){
        if(status === 'SUBSCRIBED'){
          for(let i = 0; i < 3; i++){
            setTimeout(function(){ send('player_join', { peerId: myId, name: nickname }); }, i * 300);
          }
          heartbeatTimer = setInterval(function(){
            if(!channel) return;
            send('sync_request', { peerId: myId });
          }, 12000);
          resolve();
        }
      });
    });
  }

  function broadcastPlayerList(){
    if(!isHost) return;
    const list = Object.keys(roomPlayers).map(function(pid){
      const p = roomPlayers[pid];
      return { peerId: pid, name: p.name, ready: p.ready, seat: p.seat };
    });
    send('player_list', { players: list });
  }

  function notifyPlayers(){
    if(onPlayersUpdate) onPlayersUpdate(Object.keys(roomPlayers).map(function(pid){
      return Object.assign({ peerId: pid }, roomPlayers[pid]);
    }));
  }

  function tryStartGame(){
    const ids = Object.keys(roomPlayers);
    if(ids.length < 2) return;
    const allReady = ids.every(function(pid){ return roomPlayers[pid].ready; });
    if(!allReady) return;
    const order = ids.slice().sort(function(a, b){
      return (roomPlayers[a].seat || 0) - (roomPlayers[b].seat || 0);
    });
    if(onMessage) onMessage({
      type: 'host_start_game',
      playerOrder: order,
      players: order.map(function(pid){
        return { peerId: pid, name: roomPlayers[pid].name, seat: roomPlayers[pid].seat };
      })
    });
  }

  function send(event, payload){
    if(!channel) return;
    try { channel.send({ type: 'broadcast', event: event, payload: payload }); } catch(e){}
  }

  function sendFullState(state){ send('full_state', state); }
  function sendPlayerAction(payload){ send('player_action', payload); }
  function sendGameStart(payload){
    for(let i = 0; i < 3; i++){ setTimeout(function(){ send('game_start', payload); }, i * 300); }
    send('game_start', payload);
  }
  function sendHostLeft(){ send('host_left', { peerId: myId }); }

  function toggleReady(){
    const me = roomPlayers[myId];
    if(!me) return false;
    me.ready = !me.ready;
    send('ready', { peerId: myId, ready: me.ready });
    notifyPlayers();
    return me.ready;
  }

  function leaveRoom(){
    if(heartbeatTimer){ clearInterval(heartbeatTimer); heartbeatTimer = null; }
    if(isHost) stopAnnounce();

    const ch = channel;
    channel = null;
    if(ch){
      try { ch.send({ type: 'broadcast', event: 'leave', payload: { peerId: myId } }); } catch(e){}
      setTimeout(function(){ try { supabase.removeChannel(ch); } catch(e){} }, 250);
    }
    currentRoomId = null;
    isHost = false;
    roomPlayers = {};
  }

  return {
    init, createRoom, joinRoom, leaveRoom, send,
    sendFullState, sendPlayerAction, sendGameStart, sendHostLeft,
    setMessageCallback, setPlayersCallback, setRoomsCallback, toggleReady,
    getMyId: function(){ return myId; },
    getRoomId: function(){ return currentRoomId; },
    getRoomPlayers: function(){ return roomPlayers; },
    getKnownRooms, isHost: function(){ return isHost; }
  };
})();
