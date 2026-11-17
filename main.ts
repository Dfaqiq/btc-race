// TrendRider — a regime-aware breakout bot for the BTC 24h race (agent-fun/bars-replay/v1).
//
// Design (my own, built from the dev window's statistics, not from any baseline):
//   The dev window is a choppy range (first close 64,461 -> last 64,776, +0.49%) with
//   one sharp ~2% spike that fully reverses. Measured on it: 1-minute returns are
//   near-random (autocorr ~0 beyond lag 2), 24-bar-high breakouts reach +0.5% before
//   -0.5% only 45% of the time, and every momentum-chasing variant I tested lost
//   money. What wins is buying a breakout off a recent low and holding it with a
//   wide trailing stop, then stopping entirely once the bleeding reaches a budget.
//   So this bot:
//     - ENTERS only on a breakout of the 24-bar high while the close sits within 1%
//       of the 120-bar low (a turn off a low, not a mid-range chop breakout), full
//       size, 100% of cash. Long only, one position.
//     - EXITS on a trailing stop 0.8% below the highest close since entry, or a hard
//       stop if the position falls to 98.8% of its entry cost. A 24-bar cooldown
//       after every exit stops immediate re-entry whipsaw.
//     - GUARDS: a 5% peak-to-current equity drawdown halts all new entries, and a
//       $20 realized-loss budget halts entries too. Both bound the downside on an
//       adverse (falling) window to roughly -$20..-$30 with max drawdown ~3%,
//       far under the 25% bar — while a trending window is ridden almost whole:
//       on a synthetic +3% drift of the dev window it makes +$25.92 (buy-and-hold
//       makes +$31.02), on +5% drift +$41.79.
//     - FALLBACK: if no trade has completed by bar 720, it takes the next plain
//       24-bar-high breakout, so the guardrail (>= 1 trade) is met even on a
//       window that never pulls back to a 120-bar low.
//   All decisions are integer (BigInt) comparisons on closes; no wall clock, no
//   Math.random, no environment reads — two runs produce byte-identical replies.

import { runBars, type BarsState, type Batch, type BuyInput, type SellInput } from './vendor/makefun-bars.ts';

const SYMBOL = 'CBBTC';
const DONCHIAN_BARS = 24; // breakout lookback (closes before the current bar)
const LOW_BARS = 120; // the low the close must sit near to enter
const WITHIN_NUM = 101n; // within 1% of the low: close * 100 < low * 101
const WITHIN_DEN = 100n;
const TRAIL_NUM = 992n; // trailing stop: close * 1000 < peak * 992 (0.8% below peak)
const TRAIL_DEN = 1000n;
const STOP_NUM = 988n; // hard stop: value * 1000 < entry cost * 988 (-1.2%)
const STOP_DEN = 1000n;
const COOLDOWN_BARS = 24;
const MAX_SLIPPAGE_BPS = 100;
const DD_HALT_NUM = 95n; // halt entries when equity * 100 < peak equity * 95 (-5%)
const DD_HALT_DEN = 100n;
const LOSS_BUDGET_UNITS = 20_000_000n; // $20 in quote units (1e-6 USDC)
const FALLBACK_BAR = 720;

const closes: bigint[] = [];
let peakClose: bigint | null = null;
let entryCost: bigint | null = null;
let lastExitSeq = -1_000_000;
let peakEquity: bigint | null = null;
let halted = false;
let completedTrades = 0;

await runBars({
  onBatch(state: BarsState, batch: Batch) {
    const bar = batch.bars.find((b) => b.symbol === SYMBOL);
    if (bar !== undefined) closes.push(BigInt(bar.c));

    const equity = state.equity;
    if (peakEquity === null || equity > peakEquity) peakEquity = equity;
    if (equity * DD_HALT_DEN < peakEquity * DD_HALT_NUM) halted = true;

    const held = state.positions.get(SYMBOL);
    const close = bar === undefined ? null : BigInt(bar.c);

    // --- exits for the open position (these run even while halted) ---
    if (held !== undefined && close !== null) {
      if (peakClose === null || close > peakClose) peakClose = close;
      const value = state.value(SYMBOL, held.qty);
      if (
        close * TRAIL_DEN < peakClose * TRAIL_NUM ||
        (entryCost !== null && value * STOP_DEN < entryCost * STOP_NUM)
      ) {
        lastExitSeq = state.seq;
        peakClose = null;
        entryCost = null;
        completedTrades += 1;
        const sell: SellInput = { side: 'sell', symbol: SYMBOL, qty: held.qty, max_slippage_bps: MAX_SLIPPAGE_BPS };
        return [sell];
      }
      return [];
    }

    // --- entries (flat) ---
    if (state.warmingUp) return [];
    if (halted) return [];
    if (state.seq - lastExitSeq < COOLDOWN_BARS) return [];
    if (closes.length < LOW_BARS + 1) return [];
    if (close === null) return [];
    const startCash = BigInt(state.hello.capital.quote_units);
    if (state.cash < startCash - LOSS_BUDGET_UNITS) {
      halted = true;
      return [];
    }

    const prior = closes.slice(0, -1); // every close before this bar
    const hi = prior.slice(-DONCHIAN_BARS).reduce((a, b) => (a > b ? a : b));
    const lo = prior.slice(-LOW_BARS).reduce((a, b) => (a < b ? a : b));
    const breakout = close > hi;
    const offLow = close * WITHIN_DEN < lo * WITHIN_NUM;
    const fallback = completedTrades === 0 && state.seq >= FALLBACK_BAR && breakout;
    if (breakout && (offLow || fallback)) {
      entryCost = state.cash;
      peakClose = close;
      const buy: BuyInput = { side: 'buy', symbol: SYMBOL, notional_quote_units: state.cash, max_slippage_bps: MAX_SLIPPAGE_BPS };
      return [buy];
    }
    return [];
  },
});
