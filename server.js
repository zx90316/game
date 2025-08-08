const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const Database = require('better-sqlite3');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PUBLIC_DIR = path.join(__dirname, 'public');

// 簡易記憶體房間狀態（開發用）
const rooms = new Map(); // roomId -> { seed: string, mode?: 'vs'|'coop', hostId?: string }
const names = new Map(); // socketId -> displayName
const MAX_ROOM_SIZE = Number(process.env.MAX_ROOM_SIZE || 4);

app.use(express.json());
app.use(express.static(PUBLIC_DIR));

app.get('/health', (req, res) => {
  res.json({ ok: true });
});

// 提供房間清單 (開發/大廳用)
app.get('/api/rooms', (req, res) => {
  let data = [];
  for (const [roomId, state] of rooms.entries()) {
    const size = io.sockets.adapter.rooms.get(roomId)?.size || 0;
    if (size > 0) {
      data.push({ roomId, size, seed: state.seed, mode: state.mode || 'solo', maxSize: MAX_ROOM_SIZE });
    }
  }
  const sort = req.query.sort || 'players_desc';
  if (sort === 'players_asc') data.sort((a,b)=>a.size-b.size);
  else if (sort === 'name_asc') data.sort((a,b)=>a.roomId.localeCompare(b.roomId));
  else data.sort((a,b)=>b.size-a.size);
  const page = Math.max(1, Number(req.query.page || 1));
  const size = Math.max(1, Math.min(50, Number(req.query.size || 20)));
  const start = (page-1)*size;
  const slice = data.slice(start, start+size);
  res.json({ rooms: slice, total: data.length, page, size });
});

// SQLite 永久排行榜
const db = new Database(path.join(__dirname, 'leaderboard.db'));
db.pragma('journal_mode = WAL');
db.exec(`CREATE TABLE IF NOT EXISTS leaderboard (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  score INTEGER NOT NULL,
  ts INTEGER NOT NULL
)`);
const stmtInsert = db.prepare('INSERT INTO leaderboard (name, score, ts) VALUES (?, ?, ?)');
const stmtTop = db.prepare('SELECT name, score, ts FROM leaderboard ORDER BY score DESC, ts ASC LIMIT 20');

app.get('/api/leaderboard', (req, res) => {
  try {
    const rows = stmtTop.all();
    res.json({ top: rows });
  } catch (e) {
    res.status(500).json({ top: [] });
  }
});
app.post('/api/leaderboard', (req, res) => {
  try {
    const { name, score } = req.body || {};
    if (typeof name !== 'string' || typeof score !== 'number') {
      return res.status(400).json({ ok: false });
    }
    stmtInsert.run(name, score, Date.now());
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ ok: false });
  }
});

io.on('connection', (socket) => {
  console.log('client connected', socket.id);

  socket.on('setName', (displayName) => {
    if (typeof displayName !== 'string') return;
    names.set(socket.id, displayName.slice(0, 20));
  });

  socket.on('joinRoom', (roomId) => {
    if (typeof roomId !== 'string' || roomId.length === 0) return;
    // 房間容量限制
    const size = io.sockets.adapter.rooms.get(roomId)?.size || 0;
    if (size >= MAX_ROOM_SIZE) {
      socket.emit('system', `房間 ${roomId} 已滿`);
      return;
    }
    socket.join(roomId);
    socket.emit('joined', roomId);
    socket.to(roomId).emit('system', `玩家 ${socket.id} 加入房間 ${roomId}`);

    // 初始化或取得房間的棋盤種子
    let state = rooms.get(roomId);
    if (!state) {
      state = { seed: `${Date.now()}-${Math.random().toString(36).slice(2)}`, mode: 'vs', hostId: socket.id };
      rooms.set(roomId, state);
    }
    // 若沒有 host 指派第一位進來的玩家為 host
    if (!state.hostId) {
      state.hostId = socket.id;
      rooms.set(roomId, state);
    }
    // 僅同步給新加入的玩家（包含目前房間模式）
    socket.emit('syncSeed', { seed: state.seed, config: { cols: 14, rows: 10, kinds: 12 }, mode: state.mode });
    // 廣播房內名單
    emitRoomRoster(roomId);
  });

  socket.on('leaveRoom', (roomId) => {
    socket.leave(roomId);
    socket.to(roomId).emit('system', `玩家 ${socket.id} 離開房間 ${roomId}`);
    // 若房間人數歸零則清理
    const size = io.sockets.adapter.rooms.get(roomId)?.size || 0;
    if (size === 0) {
      rooms.delete(roomId);
    } else {
      // 若 host 離開，指派新的 host
      const state = rooms.get(roomId);
      if (state && state.hostId === socket.id) {
        const members = Array.from(io.sockets.adapter.rooms.get(roomId) || []);
        state.hostId = members[0] || null;
        rooms.set(roomId, state);
        io.to(roomId).emit('system', `新房主為 ${state.hostId?.slice(0,5)}`);
      }
      emitRoomRoster(roomId);
    }
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
    if (!['vs', 'coop'].includes(mode)) return;
    const state = rooms.get(roomId);
    if (!state) return;
    state.mode = mode;
    rooms.set(roomId, state);
    io.to(roomId).emit('system', `房間模式設定為 ${mode}`);
    io.to(roomId).emit('playerEvent', { type: 'modeChanged', mode });
  });

  // 權威重排：由任一客戶端請求，伺服器決定新 seed 並廣播
  socket.on('requestShuffle', (roomId) => {
    const state = rooms.get(roomId) || { seed: '' };
    state.seed = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    rooms.set(roomId, state);
    io.to(roomId).emit('playerEvent', { type: 'shuffleSeed', seed: state.seed });
  });

  // 無解上報（僅房主可觸發）
  socket.on('reportNoMoves', (roomId) => {
    const state = rooms.get(roomId);
    if (!state) return;
    if (state.hostId !== socket.id) return; // 僅房主可
    state.seed = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    rooms.set(roomId, state);
    io.to(roomId).emit('playerEvent', { type: 'shuffleSeed', seed: state.seed });
    io.to(roomId).emit('system', '房主上報無解，已權威重排');
  });

  // 快速配對：加入人數最少且未滿之房，否則建立新房
  socket.on('findMatch', () => {
    let target = null;
    for (const [roomId] of rooms.entries()) {
      const size = io.sockets.adapter.rooms.get(roomId)?.size || 0;
      if (size > 0 && size < MAX_ROOM_SIZE) {
        if (!target || size < target.size) target = { roomId, size };
      }
    }
    if (!target) {
      const newId = `R${Math.random().toString(36).slice(2, 8)}`;
      rooms.set(newId, { seed: `${Date.now()}-${Math.random().toString(36).slice(2)}`, mode: 'vs' });
      target = { roomId: newId, size: 0 };
    }
    socket.emit('matchFound', target.roomId);
  });

  socket.on('disconnect', () => {
    console.log('client disconnected', socket.id);
    // 嘗試清理該用戶所在房間
    // 注意：socket.rooms 在 disconnect 後未必可用，保守做法是遍歷已知房間
    for (const roomId of rooms.keys()) {
      const size = io.sockets.adapter.rooms.get(roomId)?.size || 0;
      if (size === 0) rooms.delete(roomId);
      else emitRoomRoster(roomId);
    }
    names.delete(socket.id);
  });
});

function emitRoomRoster(roomId) {
  const room = io.sockets.adapter.rooms.get(roomId);
  if (!room) return;
  const list = Array.from(room).map((sid) => ({ id: sid, name: names.get(sid) || sid.slice(0,5) }));
  const hostId = rooms.get(roomId)?.hostId || null;
  io.to(roomId).emit('playerEvent', { type: 'roomRoster', list, hostId });
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Server listening on http://localhost:${PORT}`);
});


