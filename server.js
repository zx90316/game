const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PUBLIC_DIR = path.join(__dirname, 'public');

// 簡易記憶體房間狀態（開發用）
const rooms = new Map(); // roomId -> { seed: string, mode?: 'solo'|'vs'|'coop' }

app.use(express.json());
app.use(express.static(PUBLIC_DIR));

app.get('/health', (req, res) => {
  res.json({ ok: true });
});

// 提供房間清單 (開發/大廳用)
app.get('/api/rooms', (req, res) => {
  const data = [];
  for (const [roomId, state] of rooms.entries()) {
    const size = io.sockets.adapter.rooms.get(roomId)?.size || 0;
    if (size > 0) {
      data.push({ roomId, size, seed: state.seed });
    }
  }
  res.json({ rooms: data });
});

// 簡易排行榜（記憶體）
const leaderboard = [];
app.get('/api/leaderboard', (req, res) => {
  const top = leaderboard
    .sort((a, b) => b.score - a.score)
    .slice(0, 20);
  res.json({ top });
});
app.post('/api/leaderboard', (req, res) => {
  const { name, score } = req.body || {};
  if (typeof name !== 'string' || typeof score !== 'number') {
    return res.status(400).json({ ok: false });
  }
  leaderboard.push({ name, score, ts: Date.now() });
  res.json({ ok: true });
});

io.on('connection', (socket) => {
  console.log('client connected', socket.id);

  socket.on('joinRoom', (roomId) => {
    if (typeof roomId !== 'string' || roomId.length === 0) return;
    socket.join(roomId);
    socket.emit('joined', roomId);
    socket.to(roomId).emit('system', `玩家 ${socket.id} 加入房間 ${roomId}`);

    // 初始化或取得房間的棋盤種子
    let state = rooms.get(roomId);
    if (!state) {
      state = { seed: `${Date.now()}-${Math.random().toString(36).slice(2)}`, mode: 'solo' };
      rooms.set(roomId, state);
    }
    // 僅同步給新加入的玩家
    socket.emit('syncSeed', { seed: state.seed, config: { cols: 14, rows: 10, kinds: 12 } });
  });

  socket.on('leaveRoom', (roomId) => {
    socket.leave(roomId);
    socket.to(roomId).emit('system', `玩家 ${socket.id} 離開房間 ${roomId}`);
    // 若房間人數歸零則清理
    const size = io.sockets.adapter.rooms.get(roomId)?.size || 0;
    if (size === 0) rooms.delete(roomId);
  });

  socket.on('playerEvent', (roomId, payload) => {
    // 轉發玩家事件給同房間其他用戶
    socket.to(roomId).emit('playerEvent', { from: socket.id, ...payload });

    // 合作模式由伺服器授權加分，避免客戶端作弊
    const state = rooms.get(roomId);
    if (state && state.mode === 'coop' && payload && payload.type === 'removePair') {
      io.to(roomId).emit('playerEvent', { type: 'scoreDelta', value: 10 });
    }
  });

  // 可選：請求重新開局（產生新種子）
  socket.on('requestRestart', (roomId) => {
    const state = rooms.get(roomId) || { seed: '' };
    state.seed = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    rooms.set(roomId, state);
    io.to(roomId).emit('syncSeed', { seed: state.seed, config: { cols: 14, rows: 10, kinds: 12 } });
    io.to(roomId).emit('playerEvent', { type: 'restart' });
  });

  // 房間模式設定（供大廳或 UI 切換時使用）
  socket.on('setMode', (roomId, mode) => {
    if (typeof roomId !== 'string') return;
    if (!['solo', 'vs', 'coop'].includes(mode)) return;
    const state = rooms.get(roomId);
    if (!state) return;
    state.mode = mode;
    rooms.set(roomId, state);
    io.to(roomId).emit('system', `房間模式設定為 ${mode}`);
  });

  socket.on('disconnect', () => {
    console.log('client disconnected', socket.id);
    // 嘗試清理該用戶所在房間
    // 注意：socket.rooms 在 disconnect 後未必可用，保守做法是遍歷已知房間
    for (const roomId of rooms.keys()) {
      const size = io.sockets.adapter.rooms.get(roomId)?.size || 0;
      if (size === 0) rooms.delete(roomId);
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Server listening on http://localhost:${PORT}`);
});


