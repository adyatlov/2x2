import { DbConnection, type ErrorContext } from './module_bindings';
import { type Identity } from 'spacetimedb';
import { createGame } from './game';

const HOST = import.meta.env.VITE_SPACETIMEDB_HOST ?? 'ws://localhost:3000';
const DB_NAME = import.meta.env.VITE_SPACETIMEDB_DB_NAME ?? 'game';

const canvas = document.getElementById('game') as HTMLCanvasElement;
const statusEl = document.getElementById('status')!;

const game = createGame(canvas);

const conn = DbConnection.builder()
  .withUri(HOST)
  .withDatabaseName(DB_NAME)
  .withToken(localStorage.getItem('auth_token') || undefined)
  .onConnect((conn: DbConnection, identity: Identity, token: string) => {
    localStorage.setItem('auth_token', token);
    console.log('Connected:', identity.toHexString());
    statusEl.textContent = 'connected';

    // Subscribe to all tables
    conn
      .subscriptionBuilder()
      .onApplied(() => {
        // Load config
        const config = conn.db.config.id.find(0);
        if (config) {
          game.setConfig(config);
        }

        // Load existing squares
        for (const sq of conn.db.square.iter()) {
          game.addSquare(sq);
        }

        // Start rendering
        game.start();

        // Hide status after a moment
        setTimeout(() => {
          statusEl.style.opacity = '0';
          statusEl.style.transition = 'opacity 1s';
        }, 2000);
      })
      .subscribeToAllTables();

    // Live updates
    conn.db.square.onInsert((_ctx, sq) => {
      game.addSquare(sq);
    });

    conn.db.square.onUpdate((_ctx, _old, sq) => {
      game.updateSquare(sq);
    });

    conn.db.square.onDelete((_ctx, sq) => {
      game.removeSquare(sq.id);
    });

    conn.db.config.onUpdate((_ctx, _old, config) => {
      game.setConfig(config);
    });
  })
  .onDisconnect(() => {
    console.log('Disconnected');
    statusEl.textContent = 'disconnected';
    statusEl.style.opacity = '1';
    statusEl.style.color = '#e94560';
  })
  .onConnectError((_ctx: ErrorContext, error: Error) => {
    console.error('Connection error:', error);
    statusEl.textContent = 'error: ' + error.message;
    statusEl.style.color = '#e94560';
  })
  .build();

// Nuke button
document.getElementById('nuke')!.addEventListener('click', () => {
  conn.reducers.clearField();
});

// Click to drop a square
canvas.addEventListener('click', (e) => {
  const col = game.colFromX(e.clientX);
  const yStart = game.yStartFromY(e.clientY);
  conn.reducers.placeSquare({ col, yStart });
});
