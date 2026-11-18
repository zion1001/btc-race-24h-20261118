// Dip-harvest bot for the BTC race: buy a deep dip off the running high,
// sell the bounce, and never chase a trade that has no time left to pay.
//
// Why this shape: on one-minute bars this market mean-reverts across the
// hour, so fast trend-following whipsaws itself to death against the ~30 bps
// a full-size round trip costs in fees, slippage and pool impact. Buying
// only after a real dip and selling only after a real recovery keeps the
// trade count low and lets each trade clear its costs. The bot is long-only,
// holds at most one position, and never touches the clock, the environment
// or randomness: every decision is a pure function of the bars the harness
// sent.
//
// What the dev window (24h to the opening, 1,440 bars, BTC drifting down
// 2.8% over the day) taught us — measured with the kit's own grader:
//   - The dips that pay are the deep ones. Buying a 1.5% dip loses money
//     on this window (-$5.34); the whole dip 2.2-2.5% x take 1.0-2.0%
//     region is profitable, peaking at dip 2.5% / take 1.5% (+$17.00
//     before the entry cutoff). Dip 2.8% never fires; dip 1.8% and
//     shallower mostly lose. So the entry waits for a genuine 2.5%
//     wash-out off the highest close seen.
//   - A buy in the last hour is a trap: the day's third 2.5% dip fired at
//     bar 1431 with 8 bars left and was flattened for -$7.89. Entries
//     after bar 1380 are refused, which lifts the same bot to +$24.89
//     (2 trades, both wins) with neighbours at +$16-17 — a plateau, not
//     one lucky cell. The stop (5%) never fired on the dev window.
//   - Fallback buys and late shallow-dip entries both lose on this window
//     (they buy into the downtrend), so there is no fallback: if no 2.5%
//     dip ever comes, the bot stays in cash. A missed day beats a forced
//     losing trade.
//   - Patient take: the two dips behave differently. The first dip snaps
//     back in 17 bars and is gone; the second grinds for 274 bars before
//     its bounce, and when it comes the price runs to +2.76% instead of
//     stopping at +1.5%. So a position held longer than 150 bars waits for
//     a 2.5% recovery instead of selling the first 1.5%: the same bot then
//     grades +$32.66 on the dev window (2 trades, both wins, max drawdown
//     0.65%), and the 100-200 bar threshold range grades identically, so
//     the rule sits on a plateau, not a knife edge. At double fees it
//     still grades +$31.01. Two independent sealed grades of this file
//     agree byte for byte (same action log), and on the previous day's dev
//     window it makes exactly $0 with no trades — the same as the plain
//     1.5% take, so the patient rule adds nothing there and loses nothing.
//   - Entry: the close falls at least 2.5% below the highest close seen
//     so far in the window, and the bar count is at most 1380.
//   - Exit: the close rises 1.5% above the close the buy was decided on
//     (take the bounce), or 2.5% if the position has been held more than
//     150 bars (patient take, above); or falls 5% below it (stop: the day
//     is trending down, not dipping). After a stop the bot stays in cash
//     for the rest of the window, so one bad day can cost at most one stop.
//   - Size: the whole cash balance on every buy; the whole position on
//     every sell. One symbol, one position, at most one order per reply.
//   - Slippage cap 100 bps (1%) past the close the order was decided on,
//     wide enough that a normal fill is never refused for it, tight enough
//     that a fill into a gap is refused and retried next bar instead.

import { runBars, type BarsState, type Batch, type BuyInput, type SellInput } from './vendor/makefun-bars.ts';

const SYMBOL = 'CBBTC';
/** A dip: the close at most 97.5% of the running high. */
const DIP_NUM = 975n;
const DIP_DEN = 1000n;
/** Take profit: the close at least 101.5% of the entry close. */
const TAKE_NUM = 1015n;
const TAKE_DEN = 1000n;
/** Patient take: the close at least 102.5% of the entry close, for a
    position held longer than HOLD_AFTER_BARS bars (see the header). */
const PATIENT_TAKE_NUM = 1025n;
/** A held position older than this many bars waits for the patient take. */
const HOLD_AFTER_BARS = 150;
/** Stop: the close at most 95% of the entry close. */
const STOP_NUM = 95n;
const STOP_DEN = 100n;
/** No new entries after this many bars: a late buy has no time to bounce. */
const LAST_ENTRY_BAR = 1380;
/** Slippage cap on every order, in bps past the close it was decided on. */
const MAX_SLIPPAGE_BPS = 100;

// Highest close seen so far, in the bar's raw price units (integers).
let runHigh: bigint | null = null;
// CBBTC bars seen so far (gaps simply do not count).
let barsSeen = 0;
// Close the last buy was decided on, in raw price units; null while flat.
let entryClose: bigint | null = null;
// Bars since the current buy was decided on; 0 while flat.
let barsHeld = 0;
// Set by a stop-loss exit: no more entries after one.
let stoppedOut = false;
// Whether the exit now in flight was a stop (decided when the sell was
// sent); only applied once the position is actually gone.
let exitWasStop = false;

await runBars({
  onBatch(state: BarsState, batch: Batch) {
    const bar = batch.bars.find((b) => b.symbol === SYMBOL);
    if (bar !== undefined) {
      const close = BigInt(bar.c);
      barsSeen += 1;
      if (runHigh === null || close > runHigh) runHigh = close;
      if (state.warmingUp) return [];
      const held = state.positions.get(SYMBOL);
      const orders: (BuyInput | SellInput)[] = [];
      if (held !== undefined) {
        barsHeld += 1;
        // Patient take: a dip-buy that has not bounced within
        // HOLD_AFTER_BARS bars is a slow grind, not a snap-back, and when
        // its bounce comes it runs further than the fast one — so a
        // long-held position waits for a bigger recovery before selling,
        // while a fresh one still takes the usual 1.5%.
        const takeNum = barsHeld > HOLD_AFTER_BARS ? PATIENT_TAKE_NUM : TAKE_NUM;
        // Holding: exit on the bounce, or on the stop. entryClose is only
        // cleared once the flat branch below sees the position gone, so a
        // sell refused for max slippage is simply sent again on the next
        // bar instead of stranding the position with no exit left.
        if (entryClose !== null) {
          const takeHit = close * TAKE_DEN >= entryClose * takeNum;
          const stopHit = close * STOP_DEN <= entryClose * STOP_NUM;
          if (takeHit || stopHit) {
            exitWasStop = stopHit;
            orders.push({ side: 'sell', symbol: SYMBOL, qty: held.qty, max_slippage_bps: MAX_SLIPPAGE_BPS });
          }
        }
      } else {
        // Flat: if a position we held is gone, its sell filled. A stop
        // exit closes the book for the rest of the window.
        if (entryClose !== null) {
          if (exitWasStop) stoppedOut = true;
          entryClose = null;
          barsHeld = 0;
          exitWasStop = false;
        }
        if (!stoppedOut && runHigh !== null && barsSeen <= LAST_ENTRY_BAR) {
          const dipped = close * DIP_DEN <= runHigh * DIP_NUM;
          if (dipped && state.cash >= BigInt(state.hello.fees.min_notional_quote_units)) {
            entryClose = close;
            orders.push({ side: 'buy', symbol: SYMBOL, notional_quote_units: state.cash, max_slippage_bps: MAX_SLIPPAGE_BPS });
          }
        }
      }
      return orders;
    }
    return [];
  },
});
