# 2x2 — Multiplayer Falling Squares

![2x2 gameplay](screenshot.webp)

A real-time multiplayer game where players click to drop colored squares that fall with gravity and stack. Built as a demo of [SpacetimeDB](https://spacetimedb.com) — a database that doubles as a server.

**Live demo:** [2x2.dyatlov.net](https://2x2.dyatlov.net)

## What This Demos

Traditional multiplayer games need a game server that runs a tick loop, manages connections, serializes state, and broadcasts updates. SpacetimeDB replaces all of that. The database **is** the server:

- **Tables are the game state.** Each square is a row. Insert a row = place a square.
- **Reducers are the game logic.** The `placeSquare` reducer computes physics (landing positions and times) inside a database transaction.
- **Subscriptions are the networking.** Clients subscribe to the `square` table. When a row is inserted or updated, every client gets the change automatically.
- **Event tables are pub/sub.** Cursor positions use a transient event table — data is broadcast to subscribers and immediately deleted. No permanent storage for ephemeral data.

There is no game server. There is no WebSocket management code. There is no state synchronization layer. The database handles all of it.

## The Hard Problem: Concurrent Physics

The interesting complexity is what happens when multiple players drop squares simultaneously in the same column.

Imagine: Player A drops a square from the top. While it's falling, Player B drops a square near the bottom of the same column. Player B's square lands first (shorter fall), and Player A's square must now land **on top** of it — even though A's square was placed first.

The server resolves this with a **greedy slot assignment algorithm** that runs inside the `placeSquare` reducer:

1. For each landing slot (bottom to top), compute which in-flight square reaches it earliest using `t = t_start + √(2·distance/gravity)`
2. The earliest square claims that slot
3. All other squares in the column get recalculated — their landing positions shift up and their landing times change
4. Updated rows are broadcast to all clients, which adjust animations mid-flight

This runs in O(n²) where n is the number of in-flight squares in one column — typically 1–5. Each reducer call is a single atomic transaction, so concurrent drops are serialized by the database.

## Scheduled Settling: The Database as a Timer

When a square is placed, we know exactly when it will land: `t_end = t_start + √(2·distance/gravity)`. But how do we mark it as `settled: true` at that exact moment?

SpacetimeDB has **schedule tables** — a table with a `ScheduleAt` field that triggers a reducer when the time arrives. When a square is placed, we insert a row into the `settle_schedule` table with a delay equal to the fall duration:

```typescript
const delayMs = Math.ceil(tEndMs - Date.now());
ctx.db.settleSchedule.insert({
  scheduledId: 0n,
  scheduledAt: ScheduleAt.interval(BigInt(delayMs) * 1000n),
  squareId: newSquare.id,
});
```

The database waits, then calls the `settleSquare` reducer at the right moment. The reducer marks the square as settled, the `onUpdate` broadcasts to all clients, and any new client joining sees the square in its final state immediately — no animation replay.

**Rescheduling on conflict:** When a new square enters a column and shifts other in-flight squares up, their landing times change. We insert new schedule rows for the updated times. The old schedules still fire, but the reducer is idempotent — it checks `if (!sq.settled)` and skips squares that were already settled by an earlier schedule. Duplicate schedules are harmless.

In a traditional stack, you'd need an external timer (cron, `setTimeout` in an app server, Redis key expiration) that lives outside your transaction model. Here, the timer is a database row — same transactional guarantees, same subscription broadcasts, no external coordination.

## Why SpacetimeDB — Could This Be Done with Postgres?

The physics algorithm itself is portable — it's just math inside a transaction. You could run the same `placeSquare` logic in a Postgres stored procedure or an app server. **The difference is what happens after the transaction commits.**

With a traditional stack (app server + Postgres + WebSocket layer), the write path and the notification path are separate systems:

1. App server receives the click, opens a DB transaction, computes positions, commits
2. App server then serializes the changed rows and pushes them over WebSockets to connected clients
3. You need to handle: What if the broadcast fails after the commit? What if a client reconnects between commit and notification? What if two transactions commit simultaneously and broadcasts arrive out of order? What about new clients that join mid-game — how do they get the current state?

Each of these is solvable, but each requires code: a pub/sub layer (Redis?), a WebSocket connection manager, a state serialization protocol, a reconnection/replay mechanism.

**SpacetimeDB collapses all of this into one primitive.** There is no network between the logic and the data — reducers run inside the database process, reading and writing rows in the same memory space. No query serialization, no connection pooling, no round-trips. Then the transaction commit **is** the broadcast. Subscribers see every committed change, in order, automatically. A new client subscribing gets the current state as a snapshot, then a live stream of changes. There is no gap between "data written" and "clients notified" — they're the same operation.

For this demo, that means:
- The `placeSquare` reducer inserts/updates rows → clients see squares appear and adjust mid-flight. Zero notification code.
- The `cursorEvent` table inserts a transient row → all clients see the cursor move → the row is deleted. Zero pub/sub code.
- A player refreshes the page → subscription replays the full `square` table → the world rebuilds itself. Zero state-sync code.

In a traditional stack, the `placeSquare` operation would involve 3 database round-trips (read column → compute → write results), each adding latency from network, serialization, and query parsing. Here, it's a single in-process function call with direct memory access to the tables.

The space-time model (spatial data + temporal subscriptions) turns what would be ~500 lines of server infrastructure into a database schema and a few reducers.

## Client Architecture

The client is intentionally simple — a full-screen HTML canvas with no framework:

- **Optimistic rendering:** Clicking spawns a semi-transparent "ghost" square immediately, before the server responds. When the real data arrives, the ghost is replaced. This eliminates perceived latency.
- **Clock calibration:** The client estimates the offset between its clock and the server's using timestamps from incoming events. This ensures consistent animation speed across devices.
- **Time-based interpolation:** Animation uses quadratic ease-in between server-provided start/end times, not pixel-based physics. Same visual speed on a phone and a 4K monitor.
- **Event table cursors:** Other players' cursor positions are broadcast via SpacetimeDB event tables (transient, fire-and-forget) and rendered as fading crosshairs with player names.

## Running Locally

```bash
# Install SpacetimeDB CLI
curl -sSf https://install.spacetimedb.com | sh

# Install dependencies
npm install

# Start SpacetimeDB, publish the module, generate bindings
spacetime start
spacetime publish --module-path spacetimedb --server local my-game --yes
spacetime generate --lang typescript --out-dir src/module_bindings --module-path spacetimedb

# Start the dev server
npm run dev
```

Open http://localhost:5173. Open a second tab to see multiplayer in action.

## Docker Deployment

```bash
docker compose up
```

This starts three services:
- **spacetimedb** — the database server (port 3000)
- **init** — publishes the game module, then exits
- **client** — nginx serving the built static files (port 80)

For production behind a reverse proxy (e.g., Caddy), the containers join an external `proxy` network with no host port mappings. See `docker-compose.yml`.

## Tech Stack

- **Server:** SpacetimeDB v2 with TypeScript module
- **Client:** Vanilla TypeScript + HTML Canvas, bundled by Vite
- **Deployment:** Docker Compose
