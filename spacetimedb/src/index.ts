import { schema, table, t } from 'spacetimedb/server';
import { ScheduleAt } from 'spacetimedb';

// --- Game Constants ---
const NUM_COLUMNS = 48;
const NUM_ROWS = 27; // logical grid height
const GRAVITY = 60.0; // rows/s², tunable for feel
const NUM_COLORS = 12;

// --- Schedule table (defined before schema so rowType is available) ---
const settleSchedule = table(
  { name: 'settle_schedule', scheduled: (): any => settleSquare },
  {
    scheduledId: t.u64().primaryKey().autoInc(),
    scheduledAt: t.scheduleAt(),
    squareId: t.u64(),
  }
);

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
      yStart: t.f64(),
      tStartMs: t.f64(),
      yEnd: t.f64(),
      tEndMs: t.f64(),
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

  settleSchedule,
});

export default spacetimedb;

// --- Settle scheduled reducer ---

export const settleSquare = spacetimedb.reducer(
  { arg: settleSchedule.rowType },
  (ctx, { arg }) => {
    const sq = ctx.db.square.id.find(arg.squareId);
    if (sq && !sq.settled) {
      ctx.db.square.id.update({ ...sq, settled: true });
    }
  }
);

// --- Helpers ---

function identityToColorIndex(identity: { toHexString(): string }): number {
  const hex = identity.toHexString();
  let hash = 0;
  for (let i = 0; i < hex.length; i++) {
    hash = (hash * 31 + hex.charCodeAt(i)) | 0;
  }
  return Math.abs(hash) % NUM_COLORS;
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
    if (name.length > 30) throw new Error('Name too long');
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
  // Also clear pending settle schedules
  for (const s of [...ctx.db.settleSchedule.iter()]) {
    ctx.db.settleSchedule.scheduledId.delete(s.scheduledId);
  }
});

// --- Helper: schedule settling ---

function scheduleSettle(ctx: any, squareId: bigint, tEndMs: number) {
  const delayMs = Math.max(0, Math.ceil(tEndMs - Date.now()));
  ctx.db.settleSchedule.insert({
    scheduledId: 0n,
    scheduledAt: ScheduleAt.interval(BigInt(delayMs) * 1000n), // microseconds
    squareId,
  });
}

// --- Main Reducer ---

export const placeSquare = spacetimedb.reducer(
  { col: t.u16(), yStart: t.f64() },
  (ctx, { col, yStart }) => {
    if (col >= NUM_COLUMNS) throw new Error('Invalid column');
    if (yStart < 0 || yStart >= NUM_ROWS) throw new Error('Invalid yStart');

    const player = ctx.db.player.identity.find(ctx.sender);
    if (!player) throw new Error('Player not found');

    const nowMs = Date.now();

    // 1. Count settled and unsettled squares in this column
    const columnSquares = [...ctx.db.square.col.filter(col)];
    const settledCount = columnSquares.filter((s) => s.settled).length;
    const unsettled = columnSquares.filter((s) => !s.settled);

    // 2. Check column capacity
    if (settledCount + unsettled.length + 1 > NUM_ROWS) {
      throw new Error('Column is full');
    }

    // 3. Build pool: existing unsettled + new square
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
      id: 0n,
      yStart,
      tStartMs: nowMs,
      isNew: true,
    });

    // 4. Greedy slot assignment
    const gravity = GRAVITY;
    const totalSlots = pool.length;
    const remaining = [...pool];
    const assignments: {
      entry: PoolEntry;
      yEnd: number;
      tEndMs: number;
    }[] = [];

    for (let i = 0; i < totalSlots; i++) {
      const slotY = NUM_ROWS - 1 - (settledCount + i);

      let bestIdx = -1;
      let bestTReach = Infinity;

      for (let j = 0; j < remaining.length; j++) {
        const sq = remaining[j];
        const dist = slotY - sq.yStart;

        let tReach: number;
        if (dist <= 0) {
          tReach = sq.tStartMs;
        } else {
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

    // 5. Insert new square and schedule its settling
    const newAssignment = assignments.find((a) => a.entry.isNew)!;
    const newSquare = ctx.db.square.insert({
      id: 0n,
      col,
      yStart,
      tStartMs: nowMs,
      yEnd: newAssignment.yEnd,
      tEndMs: newAssignment.tEndMs,
      settled: false,
      colorIndex: player.colorIndex,
    });
    scheduleSettle(ctx, newSquare.id, newAssignment.tEndMs);

    // 6. Update existing unsettled squares whose landing changed
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
          // Reschedule settling for the new tEndMs
          scheduleSettle(ctx, a.entry.id, a.tEndMs);
        }
      }
    }
  }
);
