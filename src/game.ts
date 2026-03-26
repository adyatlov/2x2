import {
  BG_COLOR,
  GRID_COLOR,
  COLORS,
  DEFAULT_NUM_COLUMNS,
  DEFAULT_NUM_ROWS,
  DEFAULT_GRAVITY,
} from './constants';

// A local square for rendering. Mirrors DB row + visual state.
interface LocalSquare {
  id: bigint;
  col: number;
  yStart: number;
  tStartMs: number;
  yEnd: number;
  tEndMs: number;
  settled: boolean;
  colorIndex: number;
  visuallySettled: boolean;
  ghost?: boolean; // optimistic client-side square, not yet confirmed by server
}

interface RemoteCursor {
  col: number;
  y: number;
  name: string;
  colorIndex: number;
  lastSeenMs: number; // for fade-out when player stops moving
}

interface GameConfig {
  numColumns: number;
  numRows: number;
  gravity: number;
}

export function createGame(canvas: HTMLCanvasElement) {
  const ctx = canvas.getContext('2d')!;

  let config: GameConfig = {
    numColumns: DEFAULT_NUM_COLUMNS,
    numRows: DEFAULT_NUM_ROWS,
    gravity: DEFAULT_GRAVITY,
  };

  const squares = new Map<bigint, LocalSquare>();
  let running = false;
  let hoverCol = -1;
  let ghostCounter = -1n; // negative IDs for ghosts
  let playerColorIndex = 0;
  const remoteCursors = new Map<string, RemoteCursor>(); // identity hex → cursor

  // --- Public API ---

  function setConfig(c: { numColumns: number; numRows: number; gravity: number }) {
    config.numColumns = c.numColumns;
    config.numRows = c.numRows;
    config.gravity = c.gravity;
  }

  function setPlayerColor(colorIndex: number) {
    playerColorIndex = colorIndex;
  }

  // Spawn a ghost square immediately on click (before server responds)
  function spawnGhost(col: number, yStart: number): bigint {
    const id = ghostCounter--;
    const nowMs = Date.now();
    // Estimate yEnd: count squares in this column + 1
    let count = 0;
    for (const sq of squares.values()) {
      if (sq.col === col) count++;
    }
    const yEnd = config.numRows - 1 - count;

    squares.set(id, {
      id,
      col,
      yStart,
      tStartMs: nowMs,
      yEnd,
      tEndMs: nowMs + Math.sqrt((2 * Math.max(0, yEnd - yStart)) / config.gravity) * 1000,
      settled: false,
      colorIndex: playerColorIndex,
      visuallySettled: false,
      ghost: true,
    });
    return id;
  }

  function addSquare(row: {
    id: bigint;
    col: number;
    yStart: number;
    tStartMs: number;
    yEnd: number;
    tEndMs: number;
    settled: boolean;
    colorIndex: number;
  }) {
    // Try to replace a matching ghost in the same column
    for (const [ghostId, sq] of squares) {
      if (sq.ghost && sq.col === row.col && Math.abs(sq.yStart - row.yStart) < 0.5) {
        squares.delete(ghostId);
        break;
      }
    }
    squares.set(row.id, {
      ...row,
      visuallySettled: row.settled,
    });
  }

  function updateSquare(row: {
    id: bigint;
    col: number;
    yStart: number;
    tStartMs: number;
    yEnd: number;
    tEndMs: number;
    settled: boolean;
    colorIndex: number;
  }) {
    const existing = squares.get(row.id);
    if (existing) {
      existing.yEnd = row.yEnd;
      existing.tEndMs = row.tEndMs;
      existing.settled = row.settled;
      // If the target moved, un-settle visually so animation resumes
      if (row.settled) {
        existing.visuallySettled = true;
      } else {
        existing.visuallySettled = false;
      }
    } else {
      addSquare(row);
    }
  }

  function removeSquare(id: bigint) {
    squares.delete(id);
  }

  function clearAll() {
    squares.clear();
  }

  function setCursor(identityHex: string, col: number, y: number, name: string, colorIndex: number) {
    remoteCursors.set(identityHex, { col, y, name, colorIndex, lastSeenMs: Date.now() });
  }

  function removeCursor(identityHex: string) {
    remoteCursors.delete(identityHex);
  }

  function getColWidth(): number {
    return canvas.width / config.numColumns;
  }

  function getRowHeight(): number {
    return canvas.height / config.numRows;
  }

  function colFromX(clientX: number): number {
    const rect = canvas.getBoundingClientRect();
    const x = clientX - rect.left;
    const col = Math.floor((x / rect.width) * config.numColumns);
    return Math.max(0, Math.min(config.numColumns - 1, col));
  }

  function yStartFromY(clientY: number): number {
    const rect = canvas.getBoundingClientRect();
    const y = clientY - rect.top;
    return (y / rect.height) * config.numRows;
  }

  // --- Hover tracking ---

  canvas.addEventListener('mousemove', (e) => {
    hoverCol = colFromX(e.clientX);
  });

  canvas.addEventListener('mouseleave', () => {
    hoverCol = -1;
  });

  // --- Rendering ---

  function render() {
    const w = canvas.width;
    const h = canvas.height;
    const colW = getColWidth();
    const rowH = getRowHeight();
    const nowMs = Date.now();

    // Background
    ctx.fillStyle = BG_COLOR;
    ctx.fillRect(0, 0, w, h);

    // Subtle grid lines
    ctx.strokeStyle = GRID_COLOR;
    ctx.lineWidth = 1;
    for (let c = 1; c < config.numColumns; c++) {
      const x = c * colW;
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, h);
      ctx.stroke();
    }

    // Hover highlight
    if (hoverCol >= 0) {
      ctx.fillStyle = 'rgba(255, 255, 255, 0.02)';
      ctx.fillRect(hoverCol * colW, 0, colW, h);
    }

    // Draw squares
    for (const sq of squares.values()) {
      let currentY: number;

      if (sq.visuallySettled) {
        currentY = sq.yEnd;
      } else {
        const elapsedSec = (nowMs - sq.tStartMs) / 1000;
        currentY = sq.yStart + 0.5 * config.gravity * elapsedSec * elapsedSec;

        if (currentY >= sq.yEnd) {
          currentY = sq.yEnd;
          sq.visuallySettled = true;
        }
      }

      const pixelX = sq.col * colW;
      const pixelY = currentY * rowH;
      const alpha = sq.ghost ? 0.4 : 1.0;

      // Square body
      const color = COLORS[sq.colorIndex % COLORS.length];
      ctx.globalAlpha = alpha;
      ctx.fillStyle = color;
      ctx.fillRect(pixelX + 1, pixelY + 1, colW - 2, rowH - 2);

      // Subtle inner highlight (top-left)
      ctx.fillStyle = 'rgba(255, 255, 255, 0.15)';
      ctx.fillRect(pixelX + 2, pixelY + 2, colW - 4, 2);
      ctx.fillRect(pixelX + 2, pixelY + 2, 2, rowH - 4);
      ctx.globalAlpha = 1.0;
    }

    // Draw remote cursors (fade out after 3s of no updates)
    const CURSOR_FADE_MS = 3000;
    for (const [id, cursor] of remoteCursors) {
      const age = nowMs - cursor.lastSeenMs;
      if (age > CURSOR_FADE_MS) {
        remoteCursors.delete(id);
        continue;
      }
      const fade = Math.max(0, 1 - age / CURSOR_FADE_MS);
      const cx = cursor.col * colW + colW / 2;
      const cy = cursor.y * rowH;
      const color = COLORS[cursor.colorIndex % COLORS.length];

      // Crosshair
      ctx.globalAlpha = 0.3 * fade;
      ctx.strokeStyle = color;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(cx - 8, cy);
      ctx.lineTo(cx + 8, cy);
      ctx.moveTo(cx, cy - 8);
      ctx.lineTo(cx, cy + 8);
      ctx.stroke();

      // Name label
      if (cursor.name) {
        ctx.globalAlpha = 0.5 * fade;
        ctx.font = '11px -apple-system, system-ui, sans-serif';
        ctx.fillStyle = color;
        ctx.textAlign = 'center';
        ctx.fillText(cursor.name, cx, cy - 12);
      }
      ctx.globalAlpha = 1.0;
    }
  }

  // --- Game Loop ---

  function loop() {
    if (!running) return;
    render();
    requestAnimationFrame(loop);
  }

  function start() {
    if (running) return;
    running = true;
    requestAnimationFrame(loop);
  }

  function resize() {
    canvas.width = window.innerWidth;
    canvas.height = window.innerHeight;
  }

  window.addEventListener('resize', resize);
  resize();

  return {
    setConfig,
    setPlayerColor,
    spawnGhost,
    addSquare,
    updateSquare,
    removeSquare,
    clearAll,
    setCursor,
    removeCursor,
    colFromX,
    yStartFromY,
    start,
    resize,
  };
}
