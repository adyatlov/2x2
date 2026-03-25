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

  // --- Public API ---

  function setConfig(c: { numColumns: number; numRows: number; gravity: number }) {
    config.numColumns = c.numColumns;
    config.numRows = c.numRows;
    config.gravity = c.gravity;
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

      // Square body
      const color = COLORS[sq.colorIndex % COLORS.length];
      ctx.fillStyle = color;
      ctx.fillRect(pixelX + 1, pixelY + 1, colW - 2, rowH - 2);

      // Subtle inner highlight (top-left)
      ctx.fillStyle = 'rgba(255, 255, 255, 0.15)';
      ctx.fillRect(pixelX + 2, pixelY + 2, colW - 4, 2);
      ctx.fillRect(pixelX + 2, pixelY + 2, 2, rowH - 4);
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
    addSquare,
    updateSquare,
    colFromX,
    yStartFromY,
    start,
    resize,
  };
}
