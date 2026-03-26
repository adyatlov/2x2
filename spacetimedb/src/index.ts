import { schema, table, t } from 'spacetimedb/server';

// --- Game Constants ---
const NUM_COLUMNS = 48;
const NUM_ROWS = 27; // logical grid height
const GRAVITY = 60.0; // rows/s², tunable for feel
const NUM_COLORS = 12;

const spacetimedb = schema({
  config: table(
    { public: true },
    {
      id: t.u8().primaryKey(),
      numColumns: t.u16(),
      numRows: t.u16(),
      gravity: t.f64(),
    }
  ),

  player: table(
    { public: true },
    {
      identity: t.identity().primaryKey(),
      name: t.string(),
      colorIndex: t.u8(),
      online: t.bool(),
    }
  ),

  square: table(
    { public: true },
    {
      id: t.u64().primaryKey().autoInc(),
      col: t.u16().index('btree'),
      yStart: t.f64(), // row-from-top where dropped (fractional)
      tStartMs: t.f64(), // server timestamp in ms when placed
      yEnd: t.f64(), // row-from-top where it lands
      tEndMs: t.f64(), // server timestamp in ms when it lands
      settled: t.bool(),
      colorIndex: t.u8(),
    }
  ),
  cursorEvent: table(
    { public: true, event: true },
    {
      identity: t.identity(),
      col: t.u16(),
      y: t.f64(),
    }
  ),
});

export default spacetimedb;

// --- Helpers ---

function identityToColorIndex(identity: { toHexString(): string }): number {
  const hex = identity.toHexString();
  let hash = 0;
  for (let i = 0; i < hex.length; i++) {
    hash = (hash * 31 + hex.charCodeAt(i)) | 0;
  }
  return Math.abs(hash) % NUM_COLORS;
}

function timestampToMs(timestamp: { seconds: number; nanoseconds: number } | bigint): number {
  if (typeof timestamp === 'bigint') {
    return Number(timestamp) / 1000;
  }
  return timestamp.seconds * 1000 + timestamp.nanoseconds / 1_000_000;
}

// --- Lifecycle Reducers ---

export const init = spacetimedb.init((ctx) => {
  ctx.db.config.insert({
    id: 0,
    numColumns: NUM_COLUMNS,
    numRows: NUM_ROWS,
    gravity: GRAVITY,
  });
});

export const onConnect = spacetimedb.clientConnected((ctx) => {
  const existing = ctx.db.player.identity.find(ctx.sender);
  if (existing) {
    ctx.db.player.identity.update({ ...existing, online: true });
  } else {
    ctx.db.player.insert({
      identity: ctx.sender,
      name: '',
      colorIndex: identityToColorIndex(ctx.sender),
      online: true,
    });
  }
});

export const onDisconnect = spacetimedb.clientDisconnected((ctx) => {
  const existing = ctx.db.player.identity.find(ctx.sender);
  if (existing) {
    ctx.db.player.identity.update({ ...existing, online: false });
  }
});

// --- Cursor ---

export const updateCursor = spacetimedb.reducer(
  { col: t.u16(), y: t.f64() },
  (ctx, { col, y }) => {
    ctx.db.cursorEvent.insert({ identity: ctx.sender, col, y });
  }
);

// --- Player Settings ---

export const setPlayerInfo = spacetimedb.reducer(
  { name: t.string(), colorIndex: t.u8() },
  (ctx, { name, colorIndex }) => {
    const player = ctx.db.player.identity.find(ctx.sender);
    if (!player) throw new Error('Player not found');
    if (colorIndex >= NUM_COLORS) throw new Error('Invalid color');
    if (name.length > 20) throw new Error('Name too long');
    ctx.db.player.identity.update({
      ...player,
      name: name.trim(),
      colorIndex,
    });
  }
);

// --- Clear Field ---

export const clearField = spacetimedb.reducer((ctx) => {
  for (const sq of [...ctx.db.square.iter()]) {
    ctx.db.square.id.delete(sq.id);
  }
});

// --- Main Reducer ---

export const placeSquare = spacetimedb.reducer(
  { col: t.u16(), yStart: t.f64() },
  (ctx, { col, yStart }) => {
    if (col >= NUM_COLUMNS) throw new Error('Invalid column');
    if (yStart < 0 || yStart >= NUM_ROWS) throw new Error('Invalid yStart');

    const player = ctx.db.player.identity.find(ctx.sender);
    if (!player) throw new Error('Player not found');

    const nowMs = Date.now();

    // 1. Lazy settle: mark landed squares as settled
    const allSquares = [...ctx.db.square.col.filter(col)];
    for (const sq of allSquares) {
      if (!sq.settled && nowMs >= sq.tEndMs) {
        ctx.db.square.id.update({ ...sq, settled: true });
      }
    }

    // 2. Re-read after settling updates
    const columnSquares = [...ctx.db.square.col.filter(col)];
    const settledCount = columnSquares.filter((s) => s.settled).length;
    const unsettled = columnSquares.filter((s) => !s.settled);

    // 3. Check column capacity
    if (settledCount + unsettled.length + 1 > NUM_ROWS) {
      throw new Error('Column is full');
    }

    // 4. Build pool: existing unsettled + new square
    type PoolEntry = {
      id: bigint;
      yStart: number;
      tStartMs: number;
      isNew: boolean;
      originalYEnd?: number;
      originalTEndMs?: number;
    };

    const pool: PoolEntry[] = unsettled.map((s) => ({
      id: s.id,
      yStart: s.yStart,
      tStartMs: s.tStartMs,
      isNew: false,
      originalYEnd: s.yEnd,
      originalTEndMs: s.tEndMs,
    }));

    pool.push({
      id: 0n, // will be assigned by autoInc
      yStart,
      tStartMs: nowMs,
      isNew: true,
    });

    // 5. Greedy slot assignment: for each slot (bottom to top),
    //    find the square that reaches it earliest
    const gravity = GRAVITY;
    const totalSlots = pool.length;
    const remaining = [...pool];
    const assignments: {
      entry: PoolEntry;
      yEnd: number;
      tEndMs: number;
    }[] = [];

    for (let i = 0; i < totalSlots; i++) {
      // Slot i: row from bottom = settledCount + i
      // yEnd in rows-from-top = NUM_ROWS - 1 - (settledCount + i)
      const slotY = NUM_ROWS - 1 - (settledCount + i);

      let bestIdx = -1;
      let bestTReach = Infinity;

      for (let j = 0; j < remaining.length; j++) {
        const sq = remaining[j];
        const dist = slotY - sq.yStart; // distance to fall in grid rows

        let tReach: number;
        if (dist <= 0) {
          // Already at or below this slot
          tReach = sq.tStartMs;
        } else {
          // t = t_start + sqrt(2 * dist / g) * 1000 (convert seconds to ms)
          tReach = sq.tStartMs + Math.sqrt((2 * dist) / gravity) * 1000;
        }

        if (tReach < bestTReach) {
          bestTReach = tReach;
          bestIdx = j;
        }
      }

      const winner = remaining.splice(bestIdx, 1)[0];
      assignments.push({
        entry: winner,
        yEnd: slotY,
        tEndMs: bestTReach,
      });
    }

    // 6. Insert new square
    const newAssignment = assignments.find((a) => a.entry.isNew)!;
    ctx.db.square.insert({
      id: 0n, // autoInc
      col,
      yStart,
      tStartMs: nowMs,
      yEnd: newAssignment.yEnd,
      tEndMs: newAssignment.tEndMs,
      settled: false,
      colorIndex: player.colorIndex,
    });

    // 7. Update existing unsettled squares whose landing changed
    for (const a of assignments) {
      if (!a.entry.isNew) {
        if (
          a.entry.originalYEnd !== a.yEnd ||
          a.entry.originalTEndMs !== a.tEndMs
        ) {
          const original = unsettled.find((s) => s.id === a.entry.id)!;
          ctx.db.square.id.update({
            ...original,
            yEnd: a.yEnd,
            tEndMs: a.tEndMs,
          });
        }
      }
    }
  }
);
