import { DbConnection, type ErrorContext } from './module_bindings';
import { type Identity } from 'spacetimedb';
import { createGame } from './game';
import { COLORS } from './constants';
import { uniqueNamesGenerator, adjectives, animals } from 'unique-names-generator';

const HOST =
  import.meta.env.VITE_SPACETIMEDB_HOST ??
  `${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}`;
const DB_NAME = import.meta.env.VITE_SPACETIMEDB_DB_NAME ?? 'game';

const canvas = document.getElementById('game') as HTMLCanvasElement;
const statusEl = document.getElementById('status')!;
const menuBtn = document.getElementById('menu-btn')!;
const overlay = document.getElementById('overlay')!;
const nameInput = document.getElementById('name-input') as HTMLInputElement;
const colorGrid = document.getElementById('color-grid')!;
const saveBtn = document.getElementById('save-btn')!;
const nukeBtn = document.getElementById('nuke-btn')!;

const game = createGame(canvas);

let selectedColor = 0;

// --- Color palette ---
COLORS.forEach((color, i) => {
  const swatch = document.createElement('div');
  swatch.className = 'color-swatch';
  swatch.style.background = color;
  swatch.dataset.index = String(i);
  swatch.addEventListener('click', () => {
    selectedColor = i;
    updateColorSelection();
  });
  colorGrid.appendChild(swatch);
});

function updateColorSelection() {
  colorGrid.querySelectorAll('.color-swatch').forEach((el) => {
    const swatch = el as HTMLElement;
    swatch.classList.toggle('selected', swatch.dataset.index === String(selectedColor));
  });
}

// --- Menu dialog ---
menuBtn.addEventListener('click', () => {
  overlay.classList.add('open');
});

overlay.addEventListener('click', (e) => {
  if (e.target === overlay) overlay.classList.remove('open');
});

// --- Cursor throttle ---
let cursorThrottleTimer: ReturnType<typeof setTimeout> | null = null;
let lastCursorCol = -1;
let lastCursorY = -1;

// --- Connection ---
const conn = DbConnection.builder()
  .withUri(HOST)
  .withDatabaseName(DB_NAME)
  .withToken(localStorage.getItem('auth_token') || undefined)
  .onConnect((conn: DbConnection, identity: Identity, token: string) => {
    localStorage.setItem('auth_token', token);
    console.log('Connected:', identity.toHexString());
    statusEl.textContent = 'connected';

    conn
      .subscriptionBuilder()
      .onApplied(() => {
        // Load config
        const config = conn.db.config.id.find(0);
        if (config) game.setConfig(config);

        // Set player info from DB
        const player = conn.db.player.identity.find(identity);
        if (player) {
          game.setPlayerColor(player.colorIndex);
          selectedColor = player.colorIndex;
          // Generate a random name if player has none
          if (!player.name) {
            const randomName = uniqueNamesGenerator({
              dictionaries: [adjectives, animals],
              separator: ' ',
              style: 'capital',
              length: 2,
            });
            conn.reducers.setPlayerInfo({ name: randomName, colorIndex: player.colorIndex });
            nameInput.value = randomName;
          } else {
            nameInput.value = player.name;
          }
          updateColorSelection();
        }

        // Load existing squares
        for (const sq of conn.db.square.iter()) {
          game.addSquare(sq);
        }

        // Subscribe to cursor events (event tables need explicit subscription)
        conn
          .subscriptionBuilder()
          .onApplied(() => {})
          .subscribe('SELECT * FROM cursor_event');

        game.start();

        setTimeout(() => {
          statusEl.style.opacity = '0';
          statusEl.style.transition = 'opacity 1s';
        }, 2000);
      })
      .subscribeToAllTables();

    // Live updates — squares
    conn.db.square.onInsert((_ctx, sq) => game.addSquare(sq));
    conn.db.square.onUpdate((_ctx, _old, sq) => game.updateSquare(sq));
    conn.db.square.onDelete((_ctx, sq) => game.removeSquare(sq.id));

    // Live updates — cursor events (event table: only onInsert fires)
    conn.db.cursorEvent.onInsert((_ctx, c) => {
      if (c.identity.toHexString() === identity.toHexString()) return;
      const p = conn.db.player.identity.find(c.identity);
      game.setCursor(c.identity.toHexString(), c.col, c.y, p?.name || '', p?.colorIndex ?? 0);
    });

    // Live updates — player info changes don't need cursor refresh
    // (cursor events will pick up new names on next move)

    conn.db.config.onUpdate((_ctx, _old, config) => game.setConfig(config));
  })
  .onDisconnect(() => {
    console.log('Disconnected');
    statusEl.textContent = 'disconnected';
    statusEl.style.opacity = '1';
    statusEl.style.color = '#e94560';
  })
  .onConnectError((_ctx: ErrorContext, error: Error) => {
    console.error('Connection error:', error);
    // If token is invalid (server was recreated), clear it and reload
    if (error.message?.includes('token') || error.message?.includes('verify')) {
      localStorage.removeItem('auth_token');
      location.reload();
      return;
    }
    statusEl.textContent = 'error: ' + error.message;
    statusEl.style.color = '#e94560';
  })
  .build();

// --- Save player settings ---
saveBtn.addEventListener('click', () => {
  conn.reducers.setPlayerInfo({ name: nameInput.value, colorIndex: selectedColor });
  game.setPlayerColor(selectedColor);
  overlay.classList.remove('open');
});

// --- Nuke ---
nukeBtn.addEventListener('click', () => {
  conn.reducers.clearField({});
  overlay.classList.remove('open');
});

// --- Click to drop ---
canvas.addEventListener('click', (e) => {
  const col = game.colFromX(e.clientX);
  const yStart = game.yStartFromY(e.clientY);
  game.spawnGhost(col, yStart);
  conn.reducers.placeSquare({ col, yStart });
});

// --- Send cursor position (throttled) ---
canvas.addEventListener('mousemove', (e) => {
  const col = game.colFromX(e.clientX);
  const y = game.yStartFromY(e.clientY);
  if (col === lastCursorCol && Math.abs(y - lastCursorY) < 0.3) return;
  lastCursorCol = col;
  lastCursorY = y;
  if (cursorThrottleTimer) return;
  cursorThrottleTimer = setTimeout(() => {
    cursorThrottleTimer = null;
    conn.reducers.updateCursor({ col: lastCursorCol, y: lastCursorY });
  }, 80);
});
