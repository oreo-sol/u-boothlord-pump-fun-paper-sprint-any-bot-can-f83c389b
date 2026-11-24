// Pump.fun paper sprint bot: launch sniper with a rug filter.
//
// Idea: on a 6-hour window most pump.fun coins die fast and a few run hard,
// so the edge is getting in BEFORE the crowd, not chasing a rise. This bot
// buys a coin in its first few slots of life, only when the launch looks
// clean (creator has not sold, only a handful of other buyers so far, real
// SOL already on the curve), takes profit fast (+12%) or cuts the loss
// (-8%), and never holds past 8 slots. Small stakes, huge breadth: the
// 20-coin guardrail is cleared by volume, and no single rug can hurt.
//
// Deterministic: no clock, no randomness, no network. All state comes from
// the hello/batch/slot stream the harness feeds in.

import { LAMPORTS_PER_SOL, runBot, type Batch, type BotState, type OrderInput, type Pubkey } from './vendor/makefun-bot.ts';

// ---- tunables ----
const MAX_AGE_SLOTS = 3; // buy only within the first 3 slots of a coin's life
const MAX_BUYERS = 3; // distinct non-creator buyers seen before entry, at most
const MIN_REAL_SOL = 0.3; // curve real SOL at entry, at least
const MAX_DEV_BUY_SOL = 2.5; // creator's own buy at launch, at most
const MAX_SELL_RATIO = 0.5; // SOL sold by others / SOL bought, at most
const STAKE_SOL = 0.1; // target SOL per coin
const MIN_BUY_SOL = 0.01; // smallest buy worth the fees (also the guardrail size)
const TAKE_PROFIT = 0.12; // sell all once value >= cost * (1 + TAKE_PROFIT)
const STOP_LOSS = 0.08; // sell all once value <= cost * (1 - STOP_LOSS)
const MAX_HOLD_SLOTS = 8; // never hold past this many slots
const BUY_SLIPPAGE_BPS = 10_000;
const SELL_SLIPPAGE_BPS = 10_000;
const CURVE_FEE = 0.0125; // protocol 95 bps + creator 30 bps

const LAMPORTS = 1e9;

interface Coin {
  created: number;
  creator: Pubkey;
  devBuySol: number;
  devSold: boolean;
  buyers: Set<Pubkey>;
  boughtSol: number;
  soldSol: number;
  done: boolean; // decided for good (bought, filtered out, or exited)
}

interface Held {
  opened: number;
  cost: number; // SOL, from the account's cost_lamports once the buy lands
  exiting: boolean;
}

const coins = new Map<Pubkey, Coin>();
const held = new Map<Pubkey, Held>();

/** Mark-to-market value of a position in SOL, curve + tx fees deducted. */
function positionValue(state: BotState, batch: Batch, mint: Pubkey, tokens: bigint): number {
  const curve = state.curves.get(mint);
  if (curve === undefined) return 0;
  const mark = batch.marks.find((m) => m.mint === mint);
  const vq = mark ? Number(mark.virtual_quote_reserves) : Number(curve.virtual_quote_reserves);
  const vt = mark ? Number(mark.virtual_token_reserves) : Number(curve.virtual_token_reserves);
  const t = Number(tokens);
  const tx = Number(state.txFeeLamports()) / LAMPORTS;
  return ((t * vq) / (vt + t) / LAMPORTS) * (1 - CURVE_FEE) - tx;
}

await runBot({
  onBatch(state: BotState, batch: Batch): OrderInput[] {
    const now = batch.slot;
    const fresh = new Set<Pubkey>();
    for (const e of batch.events) {
      if (e.event === 'CreateEvent') {
        coins.set(e.mint, {
          created: e.slot,
          creator: e.creator,
          devBuySol: 0,
          devSold: false,
          buyers: new Set(),
          boughtSol: 0,
          soldSol: 0,
          done: false,
        });
        fresh.add(e.mint);
      } else if (e.event === 'TradeEvent') {
        const c = coins.get(e.mint);
        if (c === undefined) continue;
        const sol = Number(e.sol_amount) / LAMPORTS;
        if (e.is_buy) {
          c.boughtSol += sol;
          if (e.user === c.creator) c.devBuySol += sol;
          else c.buyers.add(e.user);
        } else {
          c.soldSol += sol;
          if (e.user === c.creator) c.devSold = true;
        }
        fresh.add(e.mint);
      } else if (e.event === 'CompleteEvent') {
        const c = coins.get(e.mint);
        if (c !== undefined) c.done = true;
      }
    }

    const cap = state.hello.caps.max_orders_per_batch;
    const tx = Number(state.txFeeLamports()) / LAMPORTS;
    const orders: OrderInput[] = [];
    const pendingByMint = new Map<Pubkey, boolean>();
    let pendingSell = new Set<Pubkey>();
    for (const po of state.pending.values()) {
      pendingByMint.set(po.order.mint, true);
      if (po.order.side === 'sell') pendingSell.add(po.order.mint);
    }
    pendingSell = new Set(pendingSell);

    // Exits first: take profit, stop loss, max hold, creator sold.
    for (const [mint, h] of held) {
      const pos = state.positions.get(mint);
      const curve = state.curves.get(mint);
      if (pos === undefined) {
        if (!pendingByMint.has(mint)) {
          held.delete(mint);
          const c = coins.get(mint);
          if (c !== undefined) c.done = true;
        }
        continue;
      }
      if (curve === undefined || curve.complete) continue;
      const cost = Number(pos.cost_lamports) / LAMPORTS;
      if (cost > 0) h.cost = cost;
      const value = positionValue(state, batch, mint, BigInt(pos.token_amount));
      const c = coins.get(mint);
      let exit = h.exiting;
      if (!exit && h.cost > 0 && value >= h.cost * (1 + TAKE_PROFIT)) exit = true;
      if (!exit && h.cost > 0 && value <= h.cost * (1 - STOP_LOSS)) exit = true;
      if (!exit && now - h.opened > MAX_HOLD_SLOTS) exit = true;
      if (!exit && c !== undefined && c.devSold) exit = true;
      if (!exit) continue;
      h.exiting = true;
      if (pendingSell.has(mint)) continue;
      if (orders.length >= cap) break;
      orders.push({ side: 'sell', mint, token_amount: pos.token_amount, max_slippage_bps: SELL_SLIPPAGE_BPS });
    }

    // Entries: coins created in the last few slots whose launch looks clean.
    let free = Number(state.freeCashLamports()) / LAMPORTS;
    let slotsLeft = state.hello.caps.max_open_positions - state.committedPositionCount();
    for (const mint of fresh) {
      if (orders.length >= cap || slotsLeft <= 0) break;
      const c = coins.get(mint);
      if (c === undefined || c.done || held.has(mint) || pendingByMint.has(mint)) continue;
      const age = now - c.created;
      if (age < 0 || age > MAX_AGE_SLOTS) {
        if (age > MAX_AGE_SLOTS) c.done = true;
        continue;
      }
      const curve = state.curves.get(mint);
      if (curve === undefined || curve.complete) {
        c.done = true;
        continue;
      }
      // Rug filter: creator must not have sold, few buyers yet, bounded dev buy.
      if (c.devSold) {
        c.done = true;
        continue;
      }
      if (c.buyers.size > MAX_BUYERS) {
        c.done = true;
        continue;
      }
      if (c.devBuySol > MAX_DEV_BUY_SOL) {
        c.done = true;
        continue;
      }
      if (c.boughtSol > 0 && c.soldSol / c.boughtSol > MAX_SELL_RATIO) {
        c.done = true;
        continue;
      }
      const realSol = Number(curve.real_quote_reserves) / LAMPORTS;
      if (realSol < MIN_REAL_SOL) continue; // too early: wait a slot or two for buys to land
      const capSol = Math.floor(Number(state.maxBuyLamports(mint))) / LAMPORTS;
      let amount = Math.min(capSol, STAKE_SOL);
      if (amount > free - tx) amount = free - tx;
      if (amount < MIN_BUY_SOL) continue;
      const lamports = BigInt(Math.floor(amount * LAMPORTS));
      orders.push({ side: 'buy', mint, quote_lamports: lamports, max_slippage_bps: BUY_SLIPPAGE_BPS });
      free -= amount + tx;
      slotsLeft--;
      c.done = true;
      held.set(mint, { opened: now, cost: 0, exiting: false });
    }
    return orders;
  },
});
