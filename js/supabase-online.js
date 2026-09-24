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
  let heartbeatTimer = null;

  function init(){
    if(!window.supabase){
      return Promise.reject(new Error('Supabase SDK not loaded'));
    }
    supabase = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
    myId = 'p-' + Math.random().toString(36).slice(2, 10);
    nickname = PokerStorage.getNickname() || 'Player';
    console.log('[Supabase] initialized, myId:', myId);
    return Promise.resolve();
  }

  function setMessageCallback(cb){ onMessage = cb; }
  function setPlayersCallback(cb){ onPlayersUpdate = cb; }

  /* ====== 创建房间（房主） ====== */
  function createRoom(roomId, info){
    isHost = true;
    currentRoomId = roomId;

    channel = supabase.channel('room-' + roomId, {
      config: { broadcast: { self: true } }
    });

    /* 有玩家申请加入 */
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
        /* 重复请求，重发列表 */
        broadcastPlayerList();
      }
    });

    /* 玩家切换准备状态 */
    channel.on('broadcast', { event: 'ready' }, (payload) => {
      if(!isHost) return;
      const p = payload.payload;
      if(roomPlayers[p.peerId]) roomPlayers[p.peerId].ready = p.ready;
      broadcastPlayerList();
      notifyPlayers();
      tryStartGame();
    });

    /* 玩家离开 */
    channel.on('broadcast', { event: 'leave' }, (payload) => {
      if(!isHost) return;
      const p = payload.payload;
      if(roomPlayers[p.peerId]){
        delete roomPlayers[p.peerId];
        broadcastPlayerList();
        notifyPlayers();
      }
    });

    /* 客户端请求同步 */
    channel.on('broadcast', { event: 'sync_request' }, (payload) => {
      if(!isHost) return;
      if(onMessage) onMessage({ type: 'sync_request', peerId: payload.payload.peerId });
    });

    /* 客户端发来的动作 */
    channel.on('broadcast', { event: 'player_action' }, (payload) => {
      if(!isHost) return;
      if(onMessage) onMessage({ type: 'player_action', ...payload.payload });
    });

    return new Promise(function(resolve){
      channel.subscribe(function(status){
        if(status === 'SUBSCRIBED'){
          roomPlayers[myId] = { name: nickname, ready: false, seat: 0, isSelf: true };
          broadcastPlayerList();
          notifyPlayers();
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

    /* 收到玩家列表 */
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

    /* 收到准备状态更新 */
    channel.on('broadcast', { event: 'ready' }, (payload) => {
      const p = payload.payload;
      if(roomPlayers[p.peerId]) roomPlayers[p.peerId].ready = p.ready;
      notifyPlayers();
    });

    /* 玩家离开 */
    channel.on('broadcast', { event: 'leave' }, (payload) => {
      const p = payload.payload;
      if(roomPlayers[p.peerId]){ delete roomPlayers[p.peerId]; notifyPlayers(); }
    });

    /* 游戏开始 */
    channel.on('broadcast', { event: 'game_start' }, (payload) => {
      if(onMessage) onMessage({ type: 'game_start', ...payload.payload });
    });

    /* 房主广播完整状态 */
    channel.on('broadcast', { event: 'full_state' }, (payload) => {
      if(onMessage) onMessage({ type: 'full_state', state: payload.payload });
    });

    return new Promise(function(resolve){
      channel.subscribe(function(status){
        if(status === 'SUBSCRIBED'){
          /* 连发 5 次 join，确保房主收到 */
          for(let i = 0; i < 5; i++){
            setTimeout(function(){
              send('player_join', { peerId: myId, name: nickname });
            }, i * 300);
          }
          /* 每 1.5 秒发一次 sync_request */
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

  /* 房主广播玩家列表 */
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

  /* 房主检查是否所有玩家准备 */
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

  /* 底层发送 */
  function send(event, payload){
    if(!channel) return;
    channel.send({ type: 'broadcast', event: event, payload: payload });
  }

  function sendFullState(state){ send('full_state', state); }
  function sendPlayerAction(payload){ send('player_action', payload); }
  function sendGameStart(payload){
    /* 广播 3 次确保到达 */
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
    toggleReady: toggleReady,
    getMyId: function(){ return myId; },
    getRoomId: function(){ return currentRoomId; },
    getRoomPlayers: function(){ return roomPlayers; },
    isHost: function(){ return isHost; }
  };
})();