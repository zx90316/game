(() => {
  // --- Socket.IO Setup ---
  const socket = io();
  const connEl = document.getElementById('connection');
  const messagesEl = document.getElementById('messages');
  const roomInput = document.getElementById('roomId');
  const joinBtn = document.getElementById('joinBtn');
  const leaveBtn = document.getElementById('leaveBtn');
  const restartBtn = document.getElementById('restartBtn');
  const hintBtn = document.getElementById('hintBtn');
  const listRoomsBtn = document.getElementById('listRoomsBtn');
  const roomsEl = document.getElementById('rooms');
  const modeSel = document.getElementById('mode');
  const blindEl = document.getElementById('blind');
  const chatInput = document.getElementById('chatInput');
  const chatSend = document.getElementById('chatSend');
  const btnRow = document.getElementById('interfereRow');
  const btnShuffle = document.getElementById('interfereShuffle');
  const btnInvert = document.getElementById('interfereInvert');
  const leaderboardBtn = document.getElementById('leaderboardBtn');
  const scoreDialog = document.getElementById('scoreDialog');
  const scoreSummary = document.getElementById('scoreSummary');
  const playerNameInput = document.getElementById('playerName');
  const submitScoreBtn = document.getElementById('submitScore');
  const leaderboardDialog = document.getElementById('leaderboardDialog');
  const leaderboardList = document.getElementById('leaderboardList');
  const leaderboardClose = document.getElementById('leaderboardClose');

  function pushMsg(text) {
    const line = document.createElement('div');
    line.textContent = text;
    messagesEl.appendChild(line);
    messagesEl.scrollTop = messagesEl.scrollHeight;
  }

  socket.on('connect', () => {
    connEl.textContent = `已連線(${socket.id.slice(0, 5)})`;
    connEl.style.color = '#22c55e';
    pushMsg('系統：已連線到伺服器');
  });
  socket.on('disconnect', () => {
    connEl.textContent = '未連線';
    connEl.style.color = '#eab308';
    pushMsg('系統：連線中斷');
  });
  let currentRoomId = null;
  let inRoom = false;
  let currentSeed = null;
  socket.on('joined', (roomId) => {
    currentRoomId = roomId;
    inRoom = true;
    pushMsg(`系統：你已加入房間 ${roomId}`);
  });
  socket.on('system', (text) => pushMsg(`系統：${text}`));
  socket.on('playerEvent', (evt) => {
    pushMsg(`事件：${JSON.stringify(evt)}`);
    if (!evt || typeof evt !== 'object') return;
    if (evt.type === 'restart') {
      // 伺服器會另外下發 syncSeed，再由 syncSeed 開新局
      return;
    }
    if (evt.type === 'removePair' && Array.isArray(evt.path) === false) {
      // 遠端移除配對：不加分
      removePair(evt.a.x, evt.a.y, evt.b.x, evt.b.y, false);
    }
    if (evt.type === 'interfere' && evt.kind === 'blind') {
      // 接收端做冷卻與淡入淡出
      const now = Date.now();
      if (now >= blindCooldownUntil) {
        blindCooldownUntil = now + 2000; // 接收端冷卻
        if (blindEl) {
          blindEl.style.display = 'block';
          requestAnimationFrame(() => { blindEl.style.opacity = '1'; });
          setTimeout(() => {
            blindEl.style.opacity = '0';
            setTimeout(() => { blindEl.style.display = 'none'; }, 180);
          }, (evt.ms || 1200));
        }
      }
    }
    if (evt.type === 'gameOver') {
      toast(evt.win ? '對手完成了棋盤！' : '對手時間到結束', evt.win ? '#22c55e' : '#ef4444');
    }
    if (evt.type === 'chat' && evt.text) {
      pushMsg(`對手：${evt.text}`);
    }
    if (evt.type === 'interfere' && evt.kind === 'row') {
      addRandomRow();
    }
    if (evt.type === 'interfere' && evt.kind === 'shuffle') {
      shuffleSome();
    }
    if (evt.type === 'interfere' && evt.kind === 'invert') {
      invertBoardTemp();
    }
  });
  socket.on('syncSeed', ({ seed, config }) => {
    currentSeed = seed;
    setSeed(seed);
    toast('房間棋盤已同步');
    startNewGame();
  });

  joinBtn.addEventListener('click', () => {
    const roomId = (roomInput.value || '').trim();
    if (!roomId) return toast('請輸入房號');
    socket.emit('joinRoom', roomId);
  });
  leaveBtn.addEventListener('click', () => {
    const roomId = (roomInput.value || '').trim();
    if (!roomId) return;
    socket.emit('leaveRoom', roomId);
    inRoom = false;
    currentRoomId = null;
  });

  listRoomsBtn?.addEventListener('click', async () => {
    try {
      const res = await fetch('/api/rooms');
      const data = await res.json();
      roomsEl.innerHTML = '';
      (data.rooms || []).forEach(r => {
        const div = document.createElement('div');
        div.textContent = `房號: ${r.roomId} ｜ 人數: ${r.size}`;
        roomsEl.appendChild(div);
      });
    } catch (e) {
      toast('取得房間列表失敗', '#ef4444');
    }
  });

  chatSend?.addEventListener('click', () => {
    const text = (chatInput?.value || '').trim();
    if (!text) return;
    if (!currentRoomId) return toast('請先加入房間', '#f59e0b');
    socket.emit('playerEvent', currentRoomId, { type: 'chat', text });
    pushMsg(`你：${text}`);
    chatInput.value = '';
  });
  chatInput?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') chatSend?.click();
  });

  // --- UI helpers ---
  function toast(text, color = '#22c55e') {
    const el = document.createElement('div');
    el.className = 'toast';
    el.textContent = text;
    el.style.background = color;
    document.body.appendChild(el);
    setTimeout(() => el.remove(), 1400);
  }

  // --- Game Config ---
  const COLS = 14; // 必須偶數
  const ROWS = 10; // 必須偶數
  const TILE = 48;
  const KINDS = 12; // 不同圖案種類
  const PADDING = 24;
  const BOARD_W = COLS * TILE + PADDING * 2;
  const BOARD_H = ROWS * TILE + PADDING * 2;
  const DURATION_SEC = 180; // 3 分鐘
  const HINT_MAX = 3;
  const HINT_COOLDOWN_MS = 3000;
  const EMOJI_SET = [
    '🍎','🍌','🍇','🍓','🍒','🍉','🍍','🥝','🥥','🍑','🥕','🍆',
    '🍋','🌽','🥦','🧀','🍪','🍭','🍩','🍔'
  ];

  const timerEl = document.getElementById('timer');
  const scoreEl = document.getElementById('score');

  let remainingSec = DURATION_SEC;
  let score = 0;

  function updateTimerText() {
    const m = Math.floor(remainingSec / 60).toString().padStart(2, '0');
    const s = (remainingSec % 60).toString().padStart(2, '0');
    timerEl.textContent = `時間：${m}:${s}`;
  }

  function updateScoreText() {
    const label = (modeSel && modeSel.value === 'coop') ? '隊伍分數' : '分數';
    scoreEl.textContent = `${label}：${score}`;
  }

  function addScore(points) {
    score += points;
    updateScoreText();
  }

  // --- Board Utils ---
  // 可重現隨機數
  let rng = Math.random;
  function xmur3(str) {
    let h = 1779033703 ^ str.length;
    for (let i = 0; i < str.length; i++) {
      h = Math.imul(h ^ str.charCodeAt(i), 3432918353);
      h = (h << 13) | (h >>> 19);
    }
    return function() {
      h = Math.imul(h ^ (h >>> 16), 2246822507);
      h = Math.imul(h ^ (h >>> 13), 3266489909);
      h ^= h >>> 16;
      return h >>> 0;
    };
  }
  function mulberry32(a) {
    return function() {
      let t = (a += 0x6D2B79F5) >>> 0;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  function setSeed(seedStr) {
    if (!seedStr) { rng = Math.random; return; }
    const seedFn = xmur3(seedStr);
    const a = seedFn();
    rng = mulberry32(a);
  }
  function shuffled(array) {
    const a = array.slice();
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  }

  function makeBoard(cols, rows, kinds) {
    const total = cols * rows;
    const pairCount = total / 2;
    const values = [];
    for (let i = 0; i < pairCount; i++) {
      const value = (i % kinds) + 1;
      values.push(value, value);
    }
    const shuffledValues = shuffled(values);
    const board = [];
    let idx = 0;
    for (let y = 0; y < rows; y++) {
      const row = [];
      for (let x = 0; x < cols; x++) {
        row.push(shuffledValues[idx++]);
      }
      board.push(row);
    }
    return board; // board[y][x]
  }

  // 擴充邊界 (外圍一圈 0)
  function extendWithBorder(board) {
    const rows = board.length;
    const cols = board[0].length;
    const ext = Array.from({ length: rows + 2 }, () => Array(cols + 2).fill(0));
    for (let y = 0; y < rows; y++) {
      for (let x = 0; x < cols; x++) {
        ext[y + 1][x + 1] = board[y][x];
      }
    }
    return ext; // ext[Y][X]
  }

  const DIRS = [
    { dx: 0, dy: -1 }, // 上
    { dx: 1, dy: 0 },  // 右
    { dx: 0, dy: 1 },  // 下
    { dx: -1, dy: 0 }, // 左
  ];

  // BFS 最多兩次轉彎，回傳拐點座標 (含起訖)
  function findPath(board, sx, sy, ex, ey) {
    if (sx === ex && sy === ey) return null;
    if (board[sy][sx] !== board[ey][ex]) return null;

    const rows = board.length;
    const cols = board[0].length;
    const ext = extendWithBorder(board);

    const S = { x: sx + 1, y: sy + 1 };
    const E = { x: ex + 1, y: ey + 1 };

    // 障礙：非 0 且不是 S/E 的位置
    const isBlocked = (X, Y) => {
      if (X === S.x && Y === S.y) return false;
      if (X === E.x && Y === E.y) return false;
      return ext[Y][X] !== 0;
    };

    // visited[Y][X][dir] = 最少轉彎數
    const visited = Array.from({ length: rows + 2 }, () =>
      Array.from({ length: cols + 2 }, () => Array(4).fill(Infinity))
    );

    const key = (x, y, dir) => `${x},${y},${dir}`;
    const parent = new Map();
    const queue = [];

    // 從起點向四個方向擴散
    for (let d = 0; d < 4; d++) {
      const nx = S.x + DIRS[d].dx;
      const ny = S.y + DIRS[d].dy;
      if (nx < 0 || ny < 0 || nx >= cols + 2 || ny >= rows + 2) continue;
      if (isBlocked(nx, ny)) continue;
      visited[ny][nx][d] = 0;
      parent.set(key(nx, ny, d), { x: S.x, y: S.y, dir: -1 });
      queue.push({ x: nx, y: ny, dir: d, turns: 0 });
    }

    while (queue.length) {
      const cur = queue.shift();
      const { x, y, dir, turns } = cur;

      // 抵達終點周邊 (E 本身亦可)
      if (x === E.x && y === E.y) {
        // 回溯路徑
        const points = [];
        let node = cur;
        points.push({ x: E.x, y: E.y });
        while (true) {
          const p = parent.get(key(node.x, node.y, node.dir));
          if (!p) break;
          points.push({ x: node.x, y: node.y });
          if (p.dir === -1) {
            points.push({ x: S.x, y: S.y });
            break;
          }
          node = { x: p.x, y: p.y, dir: p.dir, turns: 0 };
        }
        points.reverse();
        // 壓縮為拐點 (方向改變處)
        const bends = [points[0]];
        for (let i = 1; i < points.length - 1; i++) {
          const a = points[i - 1], b = points[i], c = points[i + 1];
          if ((a.x - b.x) * (b.y - c.y) !== (a.y - b.y) * (b.x - c.x)) {
            bends.push(b);
          }
        }
        bends.push(points[points.length - 1]);
        // 轉回原本無邊框座標系
        return bends.map(p => ({ x: p.x - 1, y: p.y - 1 }));
      }

      // 繼續往同方向前進
      {
        const nx = x + DIRS[dir].dx;
        const ny = y + DIRS[dir].dy;
        if (
          nx >= 0 && ny >= 0 && nx < cols + 2 && ny < rows + 2 &&
          !isBlocked(nx, ny) && visited[ny][nx][dir] > turns
        ) {
          visited[ny][nx][dir] = turns;
          parent.set(key(nx, ny, dir), { x, y, dir });
          queue.push({ x: nx, y: ny, dir, turns });
        }
      }

      // 嘗試轉彎 (左右兩個方向) - 最多兩次
      if (turns < 2) {
        for (let nd = 0; nd < 4; nd++) {
          if (nd === dir) continue;
          // 禁止 180 度回頭，避免無效狀態膨脹
          if ((nd + 2) % 4 === dir) continue;
          const nx = x + DIRS[nd].dx;
          const ny = y + DIRS[nd].dy;
          if (
            nx >= 0 && ny >= 0 && nx < cols + 2 && ny < rows + 2 &&
            !isBlocked(nx, ny) && visited[ny][nx][nd] > turns + 1
          ) {
            visited[ny][nx][nd] = turns + 1;
            parent.set(key(nx, ny, nd), { x, y, dir });
            queue.push({ x: nx, y: ny, dir: nd, turns: turns + 1 });
          }
        }
      }
    }

    return null; // 無路徑
  }

  // 找提示：任一可連線配對
  function findAnyHint(board) {
    const rows = board.length, cols = board[0].length;
    for (let y1 = 0; y1 < rows; y1++) {
      for (let x1 = 0; x1 < cols; x1++) {
        const v = board[y1][x1];
        if (v === 0) continue;
        for (let y2 = y1; y2 < rows; y2++) {
          for (let x2 = 0; x2 < cols; x2++) {
            if (y2 === y1 && x2 <= x1) continue;
            if (board[y2][x2] !== v) continue;
            const path = findPath(board, x1, y1, x2, y2);
            if (path) return { x1, y1, x2, y2, path };
          }
        }
      }
    }
    return null;
  }

  // --- Phaser Scene ---
  let gameInstance = null;
  let scene = null;
  let graphics = null;
  let board = null; // 2D array
  let tiles = null; // 2D array of { rect, label }
  let selected = null; // {x,y}
  let timerEvent = null;
  let combo = 0;
  let comboTimeout = null;
  let comboBadge = null;
  let blindCooldownUntil = 0; // ms timestamp
  let hintUsesRemaining = HINT_MAX;
  let hintCooldownUntil = 0;

  function emojiForValue(v) {
    return EMOJI_SET[(v - 1) % EMOJI_SET.length];
  }

  function createTile(x, y, value) {
    const rx = PADDING + x * TILE + TILE / 2;
    const ry = PADDING + y * TILE + TILE / 2;
    const rect = scene.add.rectangle(rx, ry, TILE - 6, TILE - 6, colorForValue(value), 1);
    rect.setStrokeStyle(2, 0x0ea5e9, 0.6);
    rect.setInteractive({ useHandCursor: true });
    rect.on('pointerdown', () => onTileClick(x, y));

    const label = scene.add.text(rx, ry, emojiForValue(value), {
      fontFamily: 'system-ui, Segoe UI Emoji, Apple Color Emoji, Noto Color Emoji, sans-serif',
      fontSize: Math.floor(TILE * 0.6),
    });
    label.setOrigin(0.5);

    return { rect, label };
  }

  function destroyTile(t) {
    if (!t) return;
    if (t.rect && !t.rect.destroyed) t.rect.destroy();
    if (t.label && !t.label.destroyed) t.label.destroy();
  }

  function startNewGame() {
    score = 0;
    remainingSec = DURATION_SEC;
    updateScoreText();
    updateTimerText();
    if (timerEvent) timerEvent.remove(false);
    if (graphics) graphics.clear();

    board = makeBoard(COLS, ROWS, KINDS);
    if (!scene) return;

    // 清除舊的
    if (tiles) {
      for (const row of tiles) for (const t of row) destroyTile(t);
    }
    tiles = Array.from({ length: ROWS }, () => Array(COLS).fill(null));

    // 畫格子
    for (let y = 0; y < ROWS; y++) {
      for (let x = 0; x < COLS; x++) {
        const value = board[y][x];
        tiles[y][x] = createTile(x, y, value);
      }
    }

    // 倒數計時
    timerEvent = scene.time.addEvent({
      delay: 1000,
      loop: true,
      callback: () => {
        remainingSec -= 1;
        updateTimerText();
        if (remainingSec <= 0) {
          timerEvent.remove(false);
          gameOver(false);
        }
      },
    });

    // 初始化 Combo badge
    if (!comboBadge) {
      comboBadge = document.createElement('div');
      comboBadge.className = 'combo-badge';
      comboBadge.id = 'comboBadge';
      document.querySelector('.right')?.appendChild(comboBadge);
    }
    hideCombo();
    resetCombo();
    // 提示重置
    hintUsesRemaining = HINT_MAX;
    hintCooldownUntil = 0;
    updateHintUI();
  }

  function colorForValue(v) {
    // 伪隨機色板
    const palette = [
      0xf43f5e, 0x22c55e, 0x3b82f6, 0xf59e0b, 0x8b5cf6, 0x14b8a6,
      0x10b981, 0x06b6d4, 0x84cc16, 0xec4899, 0x6366f1, 0xfb923c,
    ];
    return palette[(v - 1) % palette.length];
  }

  function onTileClick(x, y) {
    if (board[y][x] === 0) return;
    if (!selected) {
      selected = { x, y };
      tiles[y][x].rect.setStrokeStyle(3, 0xfbbf24, 1);
      return;
    }

    const a = selected; const b = { x, y };
    // 如果點同一格 -> 取消選取
    if (a.x === b.x && a.y === b.y) {
      tiles[a.y][a.x].rect.setStrokeStyle(2, 0x0ea5e9, 0.6);
      selected = null;
      return;
    }

    const path = findPath(board, a.x, a.y, b.x, b.y);
    if (!path) {
      // 取消原選取，改選新格
      tiles[a.y][a.x].rect.setStrokeStyle(2, 0x0ea5e9, 0.6);
      selected = { x, y };
      tiles[y][x].rect.setStrokeStyle(3, 0xfbbf24, 1);
      return;
    }

    // 成功配對
    drawPath(path);
    // 先同步給同房玩家
    emitRemovePair(a, b);
    // 再本機消除
    scene.time.delayedCall(220, () => {
      const isCoop = modeSel && modeSel.value === 'coop';
      removePair(a.x, a.y, b.x, b.y, !isCoop);
      onLocalPairMatched();
    });
  }

  function drawPath(points) {
    graphics.clear();
    graphics.lineStyle(4, 0xfbbf24, 1);
    const toPx = (gx, gy) => ({
      x: PADDING + gx * TILE + TILE / 2,
      y: PADDING + gy * TILE + TILE / 2,
    });
    const p0 = toPx(points[0].x, points[0].y);
    graphics.beginPath();
    graphics.moveTo(p0.x, p0.y);
    for (let i = 1; i < points.length; i++) {
      const p = toPx(points[i].x, points[i].y);
      graphics.lineTo(p.x, p.y);
    }
    graphics.strokePath();
    scene.time.delayedCall(180, () => graphics.clear());
  }

  function removePair(x1, y1, x2, y2, awardScore = true) {
    board[y1][x1] = 0;
    board[y2][x2] = 0;
    const t1 = tiles[y1][x1];
    const t2 = tiles[y2][x2];
    // 動畫隱藏矩形與 emoji
    scene.tweens.add({ targets: [t1.rect, t1.label], alpha: 0, duration: 150, onComplete: () => { t1.rect.setVisible(false); t1.label.setVisible(false); } });
    scene.tweens.add({ targets: [t2.rect, t2.label], alpha: 0, duration: 150, onComplete: () => { t2.rect.setVisible(false); t2.label.setVisible(false); } });

    t1.rect.disableInteractive();
    t2.rect.disableInteractive();

    t1.rect.setStrokeStyle(2, 0x0ea5e9, 0.0);
    t2.rect.setStrokeStyle(2, 0x0ea5e9, 0.0);

    if (selected) {
      tiles[selected.y][selected.x].rect.setStrokeStyle(2, 0x0ea5e9, 0.6);
      selected = null;
    }

    if (awardScore) {
      addScore(10);
    }

    // 檢查是否完成
    if (isBoardCleared()) {
      gameOver(true);
      return;
    }
    // 若仍有棋子但無可消配對，則自動重排
    const hint = findAnyHint(board);
    if (!hint) {
      shuffleSome();
      toast('無解，自動重排');
    }
  }

  function onLocalPairMatched() {
    // 連消計數（2 秒內連續消除累積）
    combo += 1;
    showCombo(combo);
    if (comboTimeout) clearTimeout(comboTimeout);
    comboTimeout = setTimeout(() => { resetCombo(); }, 2000);

    // 干擾：對戰模式下，3 連消起可使用隨機干擾一種（降低煩躁感，增加變化）
    if (inRoom && currentRoomId && modeSel && modeSel.value === 'vs' && combo >= 3) {
      const now = Date.now();
      if (now >= blindCooldownUntil) {
        const ms = Math.min(800 + (combo - 2) * 300, 2500);
        blindCooldownUntil = now + 4000; // 4 秒冷卻
        const kinds = ['blind','row','shuffle','invert'];
        const kind = kinds[Math.floor(Math.random() * kinds.length)];
        const payload = { type: 'interfere', kind, ms };
        socket.emit('playerEvent', currentRoomId, payload);
      }
    }
  }

  function resetCombo() { combo = 0; hideCombo(); }
  function showCombo(n) {
    if (!comboBadge) return;
    comboBadge.style.display = 'block';
    comboBadge.textContent = n >= 2 ? `COMBO x${n}` : 'GOOD!';
  }
  function hideCombo() { if (comboBadge) comboBadge.style.display = 'none'; }

  // showBlind 已由事件接收端直接處理為淡入淡出與冷卻，移除原函式

  function isBoardCleared() {
    for (let y = 0; y < ROWS; y++) {
      for (let x = 0; x < COLS; x++) {
        if (board[y][x] !== 0) return false;
      }
    }
    return true;
  }

  // --- 干擾/合作工具 ---
  function addRandomRow() {
    // 產生一列隨機值，推到棋盤頂部，底部掉出（0 保留為空）
    const values = [];
    for (let x = 0; x < COLS; x++) {
      // 用既有種類生成，避免無解概率過高
      const v = ((Math.floor(Math.random() * KINDS)) % KINDS) + 1;
      values.push(v);
    }
    // 下移一行
    for (let y = ROWS - 1; y > 0; y--) {
      for (let x = 0; x < COLS; x++) {
        board[y][x] = board[y - 1][x];
      }
    }
    // 設定第一行
    for (let x = 0; x < COLS; x++) board[0][x] = values[x];

    // 視覺重繪（簡單處理：銷毀並重建）
    for (const row of tiles) for (const t of row) destroyTile(t);
    for (let y = 0; y < ROWS; y++) {
      for (let x = 0; x < COLS; x++) {
        const v = board[y][x];
        if (v !== 0) tiles[y][x] = createTile(x, y, v);
        else tiles[y][x] = createTile(x, y, ((x + y) % KINDS) + 1), tiles[y][x].rect.setAlpha(0), tiles[y][x].label.setAlpha(0); // 佔位不可見
      }
    }
  }

  function shuffleSome() {
    // 隨機挑選若干非零位置重洗
    const coords = [];
    for (let y = 0; y < ROWS; y++) for (let x = 0; x < COLS; x++) if (board[y][x] !== 0) coords.push({ x, y });
    const take = Math.min(coords.length, Math.max(6, Math.floor(coords.length * 0.2)));
    for (let i = 0; i < take; i++) {
      const a = coords[Math.floor(Math.random() * coords.length)];
      const b = coords[Math.floor(Math.random() * coords.length)];
      const tmp = board[a.y][a.x]; board[a.y][a.x] = board[b.y][b.x]; board[b.y][b.x] = tmp;
    }
    // 重新渲染
    for (let y = 0; y < ROWS; y++) for (let x = 0; x < COLS; x++) {
      const t = tiles[y][x];
      if (!t || !t.rect.visible) continue;
      t.label.setText(emojiForValue(board[y][x]));
      t.rect.fillColor = colorForValue(board[y][x]);
    }
  }

  function invertBoardTemp() {
    const wrap = document.getElementById('game');
    if (!wrap) return;
    wrap.classList.add('invert-filter');
    setTimeout(() => wrap.classList.remove('invert-filter'), 1500);
  }

  function gameOver(win) {
    if (timerEvent) timerEvent.remove(false);
    toast(win ? '恭喜完成！' : '時間到，挑戰結束', win ? '#22c55e' : '#ef4444');
    if (inRoom && currentRoomId) {
      socket.emit('playerEvent', currentRoomId, { type: 'gameOver', win });
    }
    // 顯示提交分數對話框
    if (typeof scoreDialog?.showModal === 'function') {
      scoreSummary.textContent = `你的分數：${score}`;
      const prev = localStorage.getItem('playerName') || '';
      if (playerNameInput) playerNameInput.value = prev;
      scoreDialog.showModal();
    }
  }

  // --- Phaser Boot ---
  const config = {
    type: Phaser.AUTO,
    width: BOARD_W,
    height: BOARD_H,
    backgroundColor: '#0b1220',
    parent: 'game',
    scene: {
      create() {
        scene = this;
        graphics = this.add.graphics();
        startNewGame();
      },
    },
  };

  gameInstance = new Phaser.Game(config);

  // --- Buttons ---
  restartBtn.addEventListener('click', () => {
    if (inRoom && currentRoomId) {
      socket.emit('requestRestart', currentRoomId);
    } else {
      setSeed(null);
      startNewGame();
    }
  });
  hintBtn.addEventListener('click', () => {
    const now = Date.now();
    if (hintUsesRemaining <= 0) return toast('提示次數已用完', '#f59e0b');
    if (now < hintCooldownUntil) return toast('提示冷卻中', '#f59e0b');
    const hint = findAnyHint(board);
    if (!hint) {
      shuffleSome();
      toast('無解，已自動重排', '#f59e0b');
      return;
    }
    drawPath(hint.path);
    hintUsesRemaining -= 1;
    hintCooldownUntil = now + HINT_COOLDOWN_MS;
    updateHintUI();
  });

  // 干擾按鈕（本端測試或戰術用）
  btnRow?.addEventListener('click', () => {
    if (inRoom && currentRoomId && modeSel && modeSel.value === 'vs') {
      socket.emit('playerEvent', currentRoomId, { type: 'interfere', kind: 'row' });
    } else {
      addRandomRow();
    }
  });
  btnShuffle?.addEventListener('click', () => {
    if (inRoom && currentRoomId && modeSel && modeSel.value === 'vs') {
      socket.emit('playerEvent', currentRoomId, { type: 'interfere', kind: 'shuffle' });
    } else {
      shuffleSome();
    }
  });
  btnInvert?.addEventListener('click', () => {
    if (inRoom && currentRoomId && modeSel && modeSel.value === 'vs') {
      socket.emit('playerEvent', currentRoomId, { type: 'interfere', kind: 'invert' });
    } else {
      invertBoardTemp();
    }
  });

  leaderboardBtn?.addEventListener('click', async () => {
    try {
      const res = await fetch('/api/leaderboard');
      const data = await res.json();
      leaderboardList.innerHTML = '';
      (data.top || []).forEach((r, i) => {
        const li = document.createElement('li');
        li.textContent = `#${i + 1} ${r.name} - ${r.score}`;
        leaderboardList.appendChild(li);
      });
      leaderboardDialog.showModal();
    } catch (e) {
      toast('讀取排行榜失敗', '#ef4444');
    }
  });
  leaderboardClose?.addEventListener('click', () => leaderboardDialog.close());

  submitScoreBtn?.addEventListener('click', async (e) => {
    e.preventDefault();
    try {
      const name = (playerNameInput?.value || '玩家').slice(0, 20);
      localStorage.setItem('playerName', name);
      await fetch('/api/leaderboard', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name, score }) });
      scoreDialog.close();
      toast('已提交分數');
    } catch (err) {
      toast('提交失敗', '#ef4444');
    }
  });

  // 模式切換時，同步到伺服器並更新分數標籤
  modeSel?.addEventListener('change', () => {
    updateScoreText();
    if (inRoom && currentRoomId) {
      socket.emit('setMode', currentRoomId, modeSel.value);
    }
  });

  function updateHintUI() {
    if (!hintBtn) return;
    const left = Math.max(0, hintUsesRemaining);
    hintBtn.textContent = `提示 (${left})`;
    const now = Date.now();
    const onCooldown = now < hintCooldownUntil;
    hintBtn.disabled = left <= 0 || onCooldown;
  }

  // 當地成功配對後，同步房間
  function emitRemovePair(a, b) {
    if (inRoom && currentRoomId) {
      socket.emit('playerEvent', currentRoomId, { type: 'removePair', a, b });
    }
  }
  // 改寫 onTileClick 的成功配對流程：先畫線，再移除並廣播
})();


