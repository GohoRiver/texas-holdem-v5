window.PokerOnline = (function(){
  /* ============================================
     你的 Supabase 项目信息（从控制台复制）
     ============================================ */
  const SUPABASE_URL = 'https://olmlqguftnmnpyefrokk.supabase.co';
  const SUPABASE_ANON_KEY = 'sb_publishable_QSRZnWEj0nJ1QdxmqBgPcA_0n9fP4oK';
  /* ============================================ */

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

  /* ====== 大厅房间发现 ====== */
  let lobbyChannel = null;
  let lobbyRooms = {};         // roomId -> room info
  let hostRoomInfo = null;     // 房主自己的房间信息
  let hostAnnounceTimer = null;
  const ROOM_TIMEOUT_MS = 15000; // 房间心跳超时（ms）

  function init(){
    if(!window.supabase){
      return Promise.reject(new Error('Supabase SDK not loaded'));
    }
    supabase = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
    myId = 'p-' + Math.random().toString(36).slice(2, 10);
    nickname = PokerStorage.getNickname() || 'Player';
    console.log('[Supabase] initialized, myId:', myId);

    initLobbyChannel();

    return Promise.resolve();
  }

  function setMessageCallback(cb){ onMessage = cb; }
  function setPlayersCallback(cb){ onPlayersUpdate = cb; }
  function setRoomsCallback(cb){ onRoomsUpdate = cb; }

  /* ====== 大厅频道：房间发现 ====== */
  function initLobbyChannel(){
    if(lobbyChannel) return;
    lobbyChannel = supabase.channel('lobby', {
      config: { broadcast: { self: false } }
    });

    lobbyChannel.on('broadcast', { event: 'room_available' }, (payload) => {
      const p = payload && payload.payload;
      if(!p || !p.roomId) return;
      lobbyRooms[p.roomId] = Object.assign({}, p, { lastSeen: Date.now() });
      if(onRoomsUpdate) onRoomsUpdate(getKnownRooms());
    });

    lobbyChannel.on('broadcast', { event: 'room_closed' }, (payload) => {
      const rid = payload && payload.payload && payload.payload.roomId;
      if(rid && lobbyRooms[rid]){
        delete lobbyRooms[rid];
        if(onRoomsUpdate) onRoomsUpdate(getKnownRooms());
      }
    });

    // 有人进入大厅时，房主响应一下
    lobbyChannel.on('broadcast', { event: 'room_list_request' }, () => {
      if(isHost && hostRoomInfo){
        lobbyChannel.send({ type: 'broadcast', event: 'room_available', payload: hostRoomInfo });
      }
    });

    lobbyChannel.subscribe(function(status){
      if(status === 'SUBSCRIBED'){
        // 一进来就请求一次房间列表
        lobbyChannel.send({ type: 'broadcast', event: 'room_list_request', payload: {} });
      }
    });
  }

  function getKnownRooms(){
    const now = Date.now();
    const out = [];
    for(const rid in lobbyRooms){
      const r = lobbyRooms[rid];
      if(now - (r.lastSeen || 0) > ROOM_TIMEOUT_MS){
        delete lobbyRooms[rid];
        continue;
      }
      out.push(r);
    }
    return out;
  }

  function announceRoom(){
    if(!lobbyChannel || !hostRoomInfo) return;
    hostRoomInfo.count = Object.keys(roomPlayers).length || 1;
    lobbyChannel.send({ type: 'broadcast', event: 'room_available', payload: hostRoomInfo });
  }

  function closeRoomAnnouncement(){
    if(lobbyChannel && hostRoomInfo){
      lobbyChannel.send({
        type: 'broadcast',
        event: 'room_closed',
        payload: { roomId: hostRoomInfo.roomId }
      });
    }
    hostRoomInfo = null;
    if(hostAnnounceTimer){ clearInterval(hostAnnounceTimer); hostAnnounceTimer = null; }
  }

  /* ====== 创建房间（房主） ====== */
  function createRoom(roomId, info){
    isHost = true;
    currentRoomId = roomId;
    info = info || {};

    channel = supabase.channel('room-' + roomId, {
      config: { broadcast: { self: true } }
    });

    channel.on('broadcast', { event: 'player_join' }, (payload) => {
      if(!isHost) return;
      const p = payload.payload;
      if(!roomPlayers[p.peerId]){
        roomPlayers[p.peerId] = {
          name: p.name,
          ready: false,
          seat: Object.keys(roomPlayers).length,
          isSelf: false
        };
        broadcastPlayerList();
        notifyPlayers();
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
      if(!isHost) return;
      const p = payload.payload;
      if(roomPlayers[p.peerId]){
        delete roomPlayers[p.peerId];
        broadcastPlayerList();
        notifyPlayers();
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

    /* 开始广播房间信息到大厅 */
    hostRoomInfo = {
      roomId: roomId,
      level: info.level || 'nano',
      mode: info.mode || 'points',
      hostName: nickname,
      count: 1,
      maxSeats: 7
    };

    return new Promise(function(resolve){
      channel.subscribe(function(status){
        if(status === 'SUBSCRIBED'){
          roomPlayers[myId] = { name: nickname, ready: false, seat: 0, isSelf: true };
          broadcastPlayerList();
          notifyPlayers();
          // 立即广播一次，然后每 4 秒心跳
          announceRoom();
          if(hostAnnounceTimer) clearInterval(hostAnnounceTimer);
          hostAnnounceTimer = setInterval(announceRoom, 4000);
          console.log('[Supabase] room created:', roomId);
          resolve();
        }
      });
    });
  }

  /* ====== 加入房间（客户端） ====== */
  function joinRoom(roomId){
    isHost = false;
    currentRoomId = roomId;

    channel = supabase.channel('room-' + roomId, {
      config: { broadcast: { self: false } }
    });

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

    channel.on('broadcast', { event: 'game_start' }, (payload) => {
      if(onMessage) onMessage({ type: 'game_start', ...payload.payload });
    });

    channel.on('broadcast', { event: 'full_state' }, (payload) => {
      if(onMessage) onMessage({ type: 'full_state', state: payload.payload });
    });

    return new Promise(function(resolve){
      channel.subscribe(function(status){
        if(status === 'SUBSCRIBED'){
          for(let i = 0; i < 5; i++){
            setTimeout(function(){
              send('player_join', { peerId: myId, name: nickname });
            }, i * 300);
          }
          heartbeatTimer = setInterval(function(){
            if(!channel) return;
            send('sync_request', { peerId: myId });
          }, 1500);
          console.log('[Supabase] joined room:', roomId);
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
    const order = ids.slice().sort();
    if(onMessage) onMessage({
      type: 'host_start_game',
      playerOrder: order,
      players: order.map(function(pid){
        return { peerId: pid, name: roomPlayers[pid].name };
      })
    });
  }

  function send(event, payload){
    if(!channel) return;
    channel.send({ type: 'broadcast', event: event, payload: payload });
  }

  function sendFullState(state){ send('full_state', state); }
  function sendPlayerAction(payload){ send('player_action', payload); }
  function sendGameStart(payload){
    for(let i = 0; i < 3; i++){
      setTimeout(function(){ send('game_start', payload); }, i * 300);
    }
    send('game_start', payload);
  }

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

    // 先通知大厅：房间关了
    if(isHost) closeRoomAnnouncement();

    if(channel){
      send('leave', { peerId: myId });
      supabase.removeChannel(channel);
      channel = null;
    }
    currentRoomId = null;
    isHost = false;
    roomPlayers = {};
  }

  return {
    init: init,
    createRoom: createRoom,
    joinRoom: joinRoom,
    leaveRoom: leaveRoom,
    send: send,
    sendFullState: sendFullState,
    sendPlayerAction: sendPlayerAction,
    sendGameStart: sendGameStart,
    setMessageCallback: setMessageCallback,
    setPlayersCallback: setPlayersCallback,
    setRoomsCallback: setRoomsCallback,
    toggleReady: toggleReady,
    getMyId: function(){ return myId; },
    getRoomId: function(){ return currentRoomId; },
    getRoomPlayers: function(){ return roomPlayers; },
    getKnownRooms: getKnownRooms,
    announceRoom: announceRoom,
    isHost: function(){ return isHost; }
  };
})();
