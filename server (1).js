/**
 * MT5 Competition Signal Desk
 * ----------------------------
 * A MANUAL signal advisor for a specific MT5 trading competition.
 *
 * IMPORTANT: this is explicitly NOT an auto-trading bot / Expert
 * Advisor. The competition rules this was built for state "EA's are
 * not allowed" — this tool only suggests signals and tracks risk
 * against the competition's rules; every trade must be placed by hand
 * in your own MT5 terminal. It has no connection to your broker
 * account, so it can only track REALIZED P&L from the signals it
 * suggests, not your actual live floating P&L — you are responsible
 * for watching your own open positions against the daily 5% rule
 * (which explicitly includes floating losses).
 *
 * Reuses the same proven indicator/strategy engine as the XAUUSD
 * signal desk, wrapped in a different risk engine calibrated to this
 * competition's specific rules (percentage-based loss limits, lot
 * caps, multi-position tracking, daily trade cap, min trading days).
 */

const express = require("express");
const path = require("path");

// ---------------- Config ----------------
const TWELVE_DATA_API_KEY = process.env.TWELVE_DATA_API_KEY || "";
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || "";
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID || "";

const SYMBOL = process.env.SYMBOL || "XAU/USD";
const INTERVAL = process.env.INTERVAL || "15min";
const HIGH_INTERVAL = process.env.HIGH_INTERVAL || "4h";
const PORT = process.env.PORT || 3000;

const EMA_FAST = 9;
const EMA_SLOW = 21;
const RSI_PERIOD = 14;
const ATR_PERIOD = 14;
const RSI_OVERBOUGHT = 75;
const RSI_OVERSOLD = 25;
const SWING_WINDOW = 2;
const REQUIRE_TREND_ALIGNMENT = process.env.REQUIRE_TREND_ALIGNMENT !== "false";
const REQUIRE_REGIME_MATCH = process.env.REQUIRE_REGIME_MATCH !== "false";
const COOLDOWN_MINUTES = parseInt(process.env.COOLDOWN_MINUTES || "30", 10);
const BREAKEVEN_TRIGGER_PIPS = parseFloat(process.env.BREAKEVEN_TRIGGER_PIPS || "20");
const BREAKEVEN_TRIGGER_USD = BREAKEVEN_TRIGGER_PIPS * 0.1;
const XAU_LOT_USD_PER_POINT = 100;

const TIMEZONE_OFFSET_HOURS = parseFloat(process.env.TIMEZONE_OFFSET_HOURS || "5");
const POLL_MS = 15 * 60 * 1000;
const LIVE_POLL_MS = 3 * 60 * 1000;

// ---- Competition rules (from the rulebook this tool is built for) ----
const ACCOUNT_SIZE = parseFloat(process.env.ACCOUNT_SIZE || "100000");
const DAILY_LOSS_PCT = parseFloat(process.env.DAILY_LOSS_PCT || "5");
const MAX_LOSS_PCT = parseFloat(process.env.MAX_LOSS_PCT || "10");
const DAILY_LOSS_LIMIT = (ACCOUNT_SIZE * DAILY_LOSS_PCT) / 100;
const MAX_LOSS_LIMIT = (ACCOUNT_SIZE * MAX_LOSS_PCT) / 100;
const MAX_LOT_METALS = parseFloat(process.env.MAX_LOT_METALS || "3"); // XAUUSD = metal/commodity
const MAX_OPEN_POSITIONS = parseInt(process.env.MAX_OPEN_POSITIONS || "5", 10);
const MAX_TRADES_PER_DAY = parseInt(process.env.MAX_TRADES_PER_DAY || "50", 10);
const MIN_TRADING_DAYS = parseInt(process.env.MIN_TRADING_DAYS || "5", 10);
const COMMISSION_PER_LOT = parseFloat(process.env.COMMISSION_PER_LOT || "3"); // Forex & Commodities
const RISK_PER_TRADE = parseFloat(process.env.RISK_PER_TRADE || "1000"); // 1% of $100k default
const COMPETITION_START_DATE = process.env.COMPETITION_START_DATE || ""; // "YYYY-MM-DD", optional

function localDateKeyFor(date) {
  const local = new Date(date.getTime() + TIMEZONE_OFFSET_HOURS * 3600 * 1000);
  return local.toISOString().slice(0, 10);
}

function competitionHasStarted() {
  if (!COMPETITION_START_DATE) return true;
  return localDateKeyFor(new Date()) >= COMPETITION_START_DATE;
}

function isMarketClosed(now = new Date()) {
  const day = now.getUTCDay();
  const hour = now.getUTCHours();
  if (day === 6) return true;
  if (day === 0 && hour < 22) return true;
  if (day === 5 && hour >= 22) return true;
  return false;
}

// ---------------- State ----------------
const state = {
  status: "starting",
  lastChecked: null,
  lastError: null,
  symbol: SYMBOL,
  interval: INTERVAL,
  price: null,
  rsi: null,
  emaFast: null,
  emaSlow: null,
  atr: null,
  lastSignal: null,
  lastSignalTime: null,
  lastSignalPrice: null,
  lastSignalStrategy: null,
  lastSignalReason: null,
  history: [],
  sparkline: [],
  livePrice: null,
  liveCheckedAt: null,
  regime: null,
  htfBias: null,
  strategySignals: { emaCross: null, pullback: null, srBounce: null, breakout: null, rsiReversal: null },
  competition: {
    accountSize: ACCOUNT_SIZE,
    dailyLossLimit: DAILY_LOSS_LIMIT,
    maxLossLimit: MAX_LOSS_LIMIT,
    maxLotMetals: MAX_LOT_METALS,
    maxOpenPositions: MAX_OPEN_POSITIONS,
    maxTradesPerDay: MAX_TRADES_PER_DAY,
    minTradingDays: MIN_TRADING_DAYS,
    commissionPerLot: COMMISSION_PER_LOT,
    riskPerTrade: RISK_PER_TRADE,
    startDate: COMPETITION_START_DATE || null,
    started: competitionHasStarted(),
    dailyPnL: 0,
    totalPnL: 0,
    tradesToday: 0,
    dayKey: null,
    halted: false,
    haltReason: null,
    tradingDays: [], // distinct local date keys with at least 1 trade
    openPositions: [], // up to MAX_OPEN_POSITIONS
    log: [],
  },
};

function todayKey() {
  return new Date().toISOString().slice(0, 10);
}

function resetDailyIfNeeded() {
  const key = todayKey();
  if (state.competition.dayKey !== key) {
    state.competition.dayKey = key;
    state.competition.dailyPnL = 0;
    state.competition.tradesToday = 0;
    if (state.competition.haltReason === "daily") {
      state.competition.halted = false;
      state.competition.haltReason = null;
    }
  }
}

function evaluateHalt() {
  if (state.competition.totalPnL <= -MAX_LOSS_LIMIT) {
    state.competition.halted = true;
    state.competition.haltReason = "max";
  } else if (state.competition.dailyPnL <= -DAILY_LOSS_LIMIT) {
    state.competition.halted = true;
    state.competition.haltReason = "daily";
  }
}

function recordTradingDay() {
  const key = localDateKeyFor(new Date());
  if (!state.competition.tradingDays.includes(key)) {
    state.competition.tradingDays.push(key);
  }
}

// Lot size sized so a full stop-out costs RISK_PER_TRADE, capped at the
// competition's max lot for metals/commodities.
function computeLotSize(slDistance) {
  if (!slDistance || slDistance <= 0) return null;
  const raw = RISK_PER_TRADE / (slDistance * XAU_LOT_USD_PER_POINT);
  const sized = Math.max(0.01, Math.round(raw * 100) / 100);
  return Math.min(sized, MAX_LOT_METALS);
}

async function applyTradeResult(result, lot, details) {
  const commission = (lot || 0) * COMMISSION_PER_LOT;
  const gross = result === "win" ? RISK_PER_TRADE * (2.5 / 1.5) : result === "breakeven" ? 0 : -RISK_PER_TRADE;
  const amount = gross - commission;

  state.competition.dailyPnL += amount;
  state.competition.totalPnL += amount;
  state.competition.log.unshift({
    time: new Date().toISOString(),
    result,
    amount,
    commission,
    lot,
    signal: details?.signal || null,
    strategy: details?.strategy || null,
  });
  state.competition.log = state.competition.log.slice(0, 80);
  recordTradingDay();
  evaluateHalt();

  if (details) {
    const emoji = result === "win" ? "✅" : result === "breakeven" ? "⚪" : "❌";
    const label = result === "win" ? "WIN" : result === "breakeven" ? "BREAKEVEN" : "LOSS";
    const exitPrice = result === "win" ? details.tp : details.sl;
    const msg =
      `${emoji} *${label}* — ${details.signal} ${SYMBOL} _(${details.strategy || "signal"})_\n` +
      `Entry ${details.entryPrice.toFixed(2)} → Exit ~${exitPrice.toFixed(2)} · Lot ${lot?.toFixed(2) || "—"}\n` +
      `P&L after $${commission.toFixed(2)} commission: ${amount >= 0 ? "+" : ""}$${amount.toFixed(2)}\n` +
      `Daily: ${state.competition.dailyPnL >= 0 ? "+" : ""}$${state.competition.dailyPnL.toFixed(2)} / -$${DAILY_LOSS_LIMIT} · ` +
      `Total: ${state.competition.totalPnL >= 0 ? "+" : ""}$${state.competition.totalPnL.toFixed(2)} / -$${MAX_LOSS_LIMIT}`;
    await sendTelegram(msg);
  }

  return amount;
}

// Resolves each open position independently against its own SL/TP,
// with the same breakeven-at-20-pips logic as the gold dashboard.
async function resolveOpenPositions(entryCandles) {
  if (state.competition.openPositions.length === 0) return;

  const stillOpen = [];
  for (const pos of state.competition.openPositions) {
    const after = entryCandles.filter((c) => c.datetime > pos.entryTime);
    let resolved = false;

    for (const c of after) {
      if (!pos.beMoved && BREAKEVEN_TRIGGER_USD > 0) {
        const favorableMove = pos.signal === "BUY" ? c.high - pos.entryPrice : pos.entryPrice - c.low;
        if (favorableMove >= BREAKEVEN_TRIGGER_USD) {
          pos.sl = pos.entryPrice;
          pos.beMoved = true;
          await sendTelegram(
            `🔒 *Breakeven* — ${pos.signal} ${SYMBOL} _(${pos.strategy})_ stop moved to entry ${pos.entryPrice.toFixed(2)} after +${BREAKEVEN_TRIGGER_PIPS} pips.`
          );
        }
      }

      const hitSL = pos.signal === "BUY" ? c.low <= pos.sl : c.high >= pos.sl;
      const hitTP = pos.signal === "BUY" ? c.high >= pos.tp : c.low <= pos.tp;

      if (hitSL || hitTP) {
        const result = hitSL ? (pos.beMoved ? "breakeven" : "loss") : "win";
        await applyTradeResult(result, pos.lot, {
          signal: pos.signal,
          entryPrice: pos.entryPrice,
          sl: pos.sl,
          tp: pos.tp,
          strategy: pos.strategy,
        });
        resolved = true;
        break;
      }
    }

    if (!resolved) stillOpen.push(pos);
  }
  state.competition.openPositions = stillOpen;
}

async function fetchCandles(interval, n = 100) {
  const url = new URL("https://api.twelvedata.com/time_series");
  url.searchParams.set("symbol", SYMBOL);
  url.searchParams.set("interval", interval);
  url.searchParams.set("outputsize", n);
  url.searchParams.set("apikey", TWELVE_DATA_API_KEY);
  url.searchParams.set("order", "ASC");
  url.searchParams.set("timezone", "UTC");

  const res = await fetch(url);
  const data = await res.json();
  if (!data.values) {
    throw new Error(`Twelve Data error (${interval}): ${JSON.stringify(data)}`);
  }
  return data.values.map((v) => ({
    datetime: v.datetime,
    open: parseFloat(v.open),
    high: parseFloat(v.high),
    low: parseFloat(v.low),
    close: parseFloat(v.close),
  }));
}

// Lightweight current-price poll (no candle recompute) so the ticker
// visibly moves between the full 15-min structural checks.
async function fetchQuote() {
  const url = new URL("https://api.twelvedata.com/price");
  url.searchParams.set("symbol", SYMBOL);
  url.searchParams.set("apikey", TWELVE_DATA_API_KEY);
  const res = await fetch(url);
  const data = await res.json();
  if (!data.price) {
    throw new Error(`Twelve Data quote error: ${JSON.stringify(data)}`);
  }
  return parseFloat(data.price);
}

// ---------------- Indicators ----------------
function ema(values, period) {
  const k = 2 / (period + 1);
  const out = [values[0]];
  for (let i = 1; i < values.length; i++) {
    out.push(values[i] * k + out[i - 1] * (1 - k));
  }
  return out;
}

function rsi(values, period) {
  const out = new Array(values.length).fill(null);
  let gains = 0;
  let losses = 0;
  for (let i = 1; i <= period; i++) {
    const diff = values[i] - values[i - 1];
    if (diff >= 0) gains += diff;
    else losses -= diff;
  }
  let avgGain = gains / period;
  let avgLoss = losses / period;
  out[period] = 100 - 100 / (1 + avgGain / (avgLoss || 1e-10));

  for (let i = period + 1; i < values.length; i++) {
    const diff = values[i] - values[i - 1];
    const gain = diff > 0 ? diff : 0;
    const loss = diff < 0 ? -diff : 0;
    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;
    out[i] = 100 - 100 / (1 + avgGain / (avgLoss || 1e-10));
  }
  return out;
}

function atr(candles, period) {
  const trs = candles.map((c, i) => {
    if (i === 0) return c.high - c.low;
    const prevClose = candles[i - 1].close;
    return Math.max(
      c.high - c.low,
      Math.abs(c.high - prevClose),
      Math.abs(c.low - prevClose)
    );
  });
  const out = new Array(trs.length).fill(null);
  for (let i = period - 1; i < trs.length; i++) {
    const slice = trs.slice(i - period + 1, i + 1);
    out[i] = slice.reduce((a, b) => a + b, 0) / period;
  }
  return out;
}

// ---------------- Trendline detection ----------------
function findSwingHighs(candles, window = SWING_WINDOW) {
  const pts = [];
  for (let i = window; i < candles.length - window; i++) {
    const h = candles[i].high;
    let isSwing = true;
    for (let w = 1; w <= window; w++) {
      if (candles[i - w].high >= h || candles[i + w].high >= h) {
        isSwing = false;
        break;
      }
    }
    if (isSwing) pts.push({ index: i, price: h });
  }
  return pts;
}

function findSwingLows(candles, window = SWING_WINDOW) {
  const pts = [];
  for (let i = window; i < candles.length - window; i++) {
    const l = candles[i].low;
    let isSwing = true;
    for (let w = 1; w <= window; w++) {
      if (candles[i - w].low <= l || candles[i + w].low <= l) {
        isSwing = false;
        break;
      }
    }
    if (isSwing) pts.push({ index: i, price: l });
  }
  return pts;
}

function linearRegression(points) {
  const n = points.length;
  if (n < 2) return null;
  const sumX = points.reduce((a, p) => a + p.index, 0);
  const sumY = points.reduce((a, p) => a + p.price, 0);
  const sumXY = points.reduce((a, p) => a + p.index * p.price, 0);
  const sumXX = points.reduce((a, p) => a + p.index * p.index, 0);
  const denom = n * sumXX - sumX * sumX;
  if (denom === 0) return null;
  const slope = (n * sumXY - sumX * sumY) / denom;
  const intercept = (sumY - slope * sumX) / n;
  return { slope, intercept };
}

// Fits a resistance line through swing highs (downtrend) or a support
// line through swing lows (uptrend), spanning the full candle window.
function buildTrendline(candles, bias) {
  const pts = bias === "down" ? findSwingHighs(candles) : findSwingLows(candles);
  const usable = pts.length >= 2 ? pts : bias === "down" ? findSwingHighs(candles, 1) : findSwingLows(candles, 1);
  const reg = linearRegression(usable);
  if (!reg) return null;

  const firstIndex = 0;
  const lastIndex = candles.length - 1;
  return {
    p1: { index: firstIndex, price: reg.slope * firstIndex + reg.intercept },
    p2: { index: lastIndex, price: reg.slope * lastIndex + reg.intercept },
    slope: reg.slope,
    intercept: reg.intercept,
  };
}

function trendlineValueAt(trendline, index) {
  return trendline.slope * index + trendline.intercept;
}

// Overall bias for a candle set: slope of a regression through closes.
function closesBias(candles) {
  const pts = candles.map((c, i) => ({ index: i, price: c.close }));
  const reg = linearRegression(pts);
  if (!reg) return "flat";
  return reg.slope < 0 ? "down" : "up";
}

// Classifies the market into one of 3 regimes (per the "know the
// environment" framework: same setup, different odds depending on
// regime): trending-up, trending-down, or ranging — plus a separate
// volatility-expansion flag. Trend-following strategies should only
// fire with a matching trend regime; mean-reversion strategies should
// only fire while ranging.
function classifyRegime(candles, emaSlowArr, atrArr, i, lookback = 30) {
  const start = Math.max(0, i - lookback);
  const slice = candles.slice(start, i + 1);
  const emaSlice = emaSlowArr.slice(start, i + 1);

  let aboveCount = 0;
  for (let k = 0; k < slice.length; k++) {
    if (slice[k].close > emaSlice[k]) aboveCount++;
  }
  const aboveRatio = aboveCount / slice.length;
  const bias = closesBias(slice);

  let trend;
  if (bias === "up" && aboveRatio >= 0.58) trend = "trending-up";
  else if (bias === "down" && aboveRatio <= 0.42) trend = "trending-down";
  else trend = "ranging";

  const priorATRs = atrArr.slice(start, i).filter((v) => v !== null);
  const avgATR = priorATRs.length ? priorATRs.reduce((a, b) => a + b, 0) / priorATRs.length : atrArr[i];
  const volatilityExpansion = atrArr[i] !== null && avgATR ? atrArr[i] > avgATR * 1.3 : false;

  return { trend, volatilityExpansion };
}

// ---------------- Strategies ----------------
// Each evaluator looks only at the entry timeframe and returns either
// null (no setup right now) or { signal, sl, tp, reason }. Every
// strategy targets a 2:1 reward:risk minimum per the entry/stop/target
// framework (risk ATR*1.0, target ATR*2.0, scaled per strategy).

function evaluateEmaCross(entryCandles, emaFastArr, emaSlowArr, rsiArr, atrArr, i) {
  const prevI = i - 1;
  const price = entryCandles[i].close;
  const atrVal = atrArr[i];
  if (!atrVal) return null;

  const crossedUp = emaFastArr[prevI] <= emaSlowArr[prevI] && emaFastArr[i] > emaSlowArr[i];
  const crossedDown = emaFastArr[prevI] >= emaSlowArr[prevI] && emaFastArr[i] < emaSlowArr[i];

  if (crossedUp && rsiArr[i] < RSI_OVERBOUGHT) {
    return {
      signal: "BUY",
      sl: price - atrVal * 1.5,
      tp: price + atrVal * 3.0,
      reason: `EMA${EMA_FAST} crossed above EMA${EMA_SLOW} with RSI at ${rsiArr[i].toFixed(1)} — bullish momentum confirmed.`,
    };
  }
  if (crossedDown && rsiArr[i] > RSI_OVERSOLD) {
    return {
      signal: "SELL",
      sl: price + atrVal * 1.5,
      tp: price - atrVal * 3.0,
      reason: `EMA${EMA_FAST} crossed below EMA${EMA_SLOW} with RSI at ${rsiArr[i].toFixed(1)} — bearish momentum confirmed.`,
    };
  }
  return null;
}

// Price pulls back to the EMA21 ("the 20 EMA") inside an established
// trend and closes back in the trend's direction — the classic
// pullback-entry setup, only valid while the regime is actually trending.
function evaluatePullback(entryCandles, emaSlowArr, atrArr, i, regime) {
  const c = entryCandles[i];
  const atrVal = atrArr[i];
  if (!atrVal) return null;
  const emaMid = emaSlowArr[i];
  const tolerance = atrVal * 0.5;

  if (regime.trend === "trending-up") {
    const touchedEma = c.low <= emaMid + tolerance && c.low >= emaMid - tolerance * 1.5;
    const closedAboveEma = c.close > emaMid;
    const bullishClose = c.close > c.open;
    if (touchedEma && closedAboveEma && bullishClose) {
      const sl = c.low - atrVal * 0.5;
      const tp = c.close + (c.close - sl) * 2.0;
      return {
        signal: "BUY",
        sl,
        tp,
        reason: `Price pulled back to EMA${EMA_SLOW} near ${emaMid.toFixed(2)} in an uptrend and closed bullish — trend pullback entry.`,
      };
    }
  }
  if (regime.trend === "trending-down") {
    const touchedEma = c.high >= emaMid - tolerance && c.high <= emaMid + tolerance * 1.5;
    const closedBelowEma = c.close < emaMid;
    const bearishClose = c.close < c.open;
    if (touchedEma && closedBelowEma && bearishClose) {
      const sl = c.high + atrVal * 0.5;
      const tp = c.close - (sl - c.close) * 2.0;
      return {
        signal: "SELL",
        sl,
        tp,
        reason: `Price pulled back to EMA${EMA_SLOW} near ${emaMid.toFixed(2)} in a downtrend and closed bearish — trend pullback entry.`,
      };
    }
  }
  return null;
}

// Rejection off an auto-drawn support or resistance trendline. Requires
// two candles: the wick-and-close rejection, THEN a follow-through
// candle that closes further in the rejection direction — filters out
// single-candle noise that immediately reverses.
function evaluateSRBounce(entryCandles, atrArr, i, supportLine, resistanceLine) {
  if (i - 1 < 0) return null;
  const rejection = entryCandles[i - 1];
  const confirm = entryCandles[i];
  const atrVal = atrArr[i];
  if (!atrVal) return null;
  const tolerance = atrVal * 0.6;

  if (supportLine) {
    const lineVal = trendlineValueAt(supportLine, i - 1);
    const wickedThrough = rejection.low <= lineVal + tolerance;
    const closedAbove = rejection.close > lineVal;
    const bullishRejection = rejection.close > rejection.open;
    const followsThrough = confirm.close > rejection.close;

    if (wickedThrough && closedAbove && bullishRejection && followsThrough) {
      const sl = rejection.low - atrVal * 0.5;
      const tp = confirm.close + (confirm.close - sl) * 2.0;
      return {
        signal: "BUY",
        sl,
        tp,
        reason: `Price wicked into the support trendline near ${lineVal.toFixed(2)}, closed back above it, and the next candle followed through higher — confirmed rejection bounce.`,
      };
    }
  }

  if (resistanceLine) {
    const lineVal = trendlineValueAt(resistanceLine, i - 1);
    const wickedThrough = rejection.high >= lineVal - tolerance;
    const closedBelow = rejection.close < lineVal;
    const bearishRejection = rejection.close < rejection.open;
    const followsThrough = confirm.close < rejection.close;

    if (wickedThrough && closedBelow && bearishRejection && followsThrough) {
      const sl = rejection.high + atrVal * 0.5;
      const tp = confirm.close - (sl - confirm.close) * 2.0;
      return {
        signal: "SELL",
        sl,
        tp,
        reason: `Price wicked into the resistance trendline near ${lineVal.toFixed(2)}, closed back below it, and the next candle followed through lower — confirmed rejection.`,
      };
    }
  }

  return null;
}

// Close breaks beyond the recent N-candle range with volatility clearly
// expanding (well above its own recent average) — trend continuation.
// Longer lookback + higher expansion bar = fewer, more meaningful breaks.
function evaluateBreakout(entryCandles, atrArr, i, lookback = 40) {
  if (i - lookback < 0) return null;
  const atrVal = atrArr[i];
  if (!atrVal) return null;

  const priorCandles = entryCandles.slice(i - lookback, i);
  const highestHigh = Math.max(...priorCandles.map((c) => c.high));
  const lowestLow = Math.min(...priorCandles.map((c) => c.low));

  const priorATRs = atrArr.slice(i - lookback, i).filter((v) => v !== null);
  const avgATR = priorATRs.length ? priorATRs.reduce((a, b) => a + b, 0) / priorATRs.length : atrVal;
  const expanding = atrVal > avgATR * 1.4;

  const c = entryCandles[i];
  if (c.close > highestHigh && expanding) {
    return {
      signal: "BUY",
      sl: c.close - atrVal * 1.2,
      tp: c.close + atrVal * 2.4,
      reason: `Price closed above the ${lookback}-candle high (${highestHigh.toFixed(2)}) with volatility well above average — breakout continuation.`,
    };
  }
  if (c.close < lowestLow && expanding) {
    return {
      signal: "SELL",
      sl: c.close + atrVal * 1.2,
      tp: c.close - atrVal * 2.4,
      reason: `Price closed below the ${lookback}-candle low (${lowestLow.toFixed(2)}) with volatility well above average — breakdown continuation.`,
    };
  }
  return null;
}

// RSI crossing back out of an extreme (oversold/overbought) — a momentum
// reversal call, distinct from the trend-following strategies above.
function evaluateRsiReversal(entryCandles, rsiArr, atrArr, i) {
  if (i - 1 < 0) return null;
  const prevRsi = rsiArr[i - 1];
  const currRsi = rsiArr[i];
  const atrVal = atrArr[i];
  const price = entryCandles[i].close;
  if (prevRsi === null || currRsi === null || !atrVal) return null;

  if (prevRsi < 30 && currRsi >= 30) {
    return {
      signal: "BUY",
      sl: price - atrVal * 1.3,
      tp: price + atrVal * 2.6,
      reason: `RSI crossed back above 30 (from ${prevRsi.toFixed(1)} to ${currRsi.toFixed(1)}) out of oversold — momentum reversal.`,
    };
  }
  if (prevRsi > 70 && currRsi <= 70) {
    return {
      signal: "SELL",
      sl: price + atrVal * 1.3,
      tp: price - atrVal * 2.6,
      reason: `RSI crossed back below 70 (from ${prevRsi.toFixed(1)} to ${currRsi.toFixed(1)}) out of overbought — momentum reversal.`,
    };
  }
  return null;
}

// ---------------- Telegram ----------------
async function sendTelegram(message) {
  const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      chat_id: TELEGRAM_CHAT_ID,
      text: message,
      parse_mode: "Markdown",
    }),
  });
  if (!res.ok) {
    console.error("Telegram send failed:", await res.text());
  }
}

function formatSignalMessage(strategyName, signal, price, rsiVal, time, lot, reason, sl, tp) {
  const remainingDaily = DAILY_LOSS_LIMIT + state.competition.dailyPnL;
  const remainingTotal = MAX_LOSS_LIMIT + state.competition.totalPnL;
  return (
    `*${signal} SIGNAL — ${SYMBOL}* _(${strategyName})_\n` +
    `Time: ${time}\n` +
    `Price: ${price.toFixed(2)} · RSI(${RSI_PERIOD}): ${rsiVal.toFixed(1)}\n` +
    `${reason}\n` +
    `SL ${sl.toFixed(2)} · TP ${tp.toFixed(2)} · Lot ${lot ? lot.toFixed(2) : "—"} (capped at ${MAX_LOT_METALS})\n` +
    `Open positions: ${state.competition.openPositions.length}/${MAX_OPEN_POSITIONS} · Trades today: ${state.competition.tradesToday}/${MAX_TRADES_PER_DAY}\n` +
    `Daily buffer left: $${remainingDaily.toFixed(2)} · Overall buffer left: $${remainingTotal.toFixed(2)}\n` +
    `_Manual signal only — place this yourself in MT5. Not an EA, not financial advice._`
  );
}

function formatReason(price, rsiVal, bias) {
  return `No active crossover — price is ${
    bias === "down" ? "testing resistance" : "testing support"
  } near ${price.toFixed(2)}, EMA${EMA_FAST}/${EMA_SLOW} still trending ${bias === "down" ? "down" : "up"}.`;
}


// ---------------- Core check ----------------
let startupMessageSent = false;

async function checkOnce() {
  if (!competitionHasStarted()) {
    state.status = "not-started";
    console.log(`[${new Date().toISOString()}] Competition hasn't started yet (starts ${COMPETITION_START_DATE})`);
    return;
  }

  if (isMarketClosed()) {
    state.status = "closed";
    state.lastError = null;
    console.log(`[${new Date().toISOString()}] Market closed — skipping check`);
    return;
  }

  const [entryCandles, contextCandles] = await Promise.all([
    fetchCandles(INTERVAL, 100),
    fetchCandles(HIGH_INTERVAL, 80),
  ]);

  const closes = entryCandles.map((c) => c.close);
  const emaFastArr = ema(closes, EMA_FAST);
  const emaSlowArr = ema(closes, EMA_SLOW);
  const rsiArr = rsi(closes, RSI_PERIOD);
  const atrArr = atr(entryCandles, ATR_PERIOD);

  const i = closes.length - 1;
  const price = closes[i];
  const time = entryCandles[i].datetime;

  state.price = price;
  state.rsi = rsiArr[i];
  state.emaFast = emaFastArr[i];
  state.emaSlow = emaSlowArr[i];
  state.atr = atrArr[i];
  state.lastChecked = new Date().toISOString();
  state.status = "ok";
  state.lastError = null;
  state.sparkline = closes.slice(-40);

  if (!startupMessageSent) {
    startupMessageSent = true;
    await sendTelegram(
      `✅ MT5 Competition Signal Desk is live — watching *${SYMBOL}* on ${INTERVAL} candles.\n` +
        `Account: $${ACCOUNT_SIZE} · Daily cap: $${DAILY_LOSS_LIMIT} (${DAILY_LOSS_PCT}%) · Max cap: $${MAX_LOSS_LIMIT} (${MAX_LOSS_PCT}%)\n` +
        `This is a MANUAL signal tool, not an EA — place every trade yourself in MT5.`
    );
  }

  resetDailyIfNeeded();
  await resolveOpenPositions(entryCandles);
  evaluateHalt();

  const supportLine = buildTrendline(entryCandles, "up");
  const resistanceLine = buildTrendline(entryCandles, "down");
  const htfBias = closesBias(contextCandles);
  const entryRegime = classifyRegime(entryCandles, emaSlowArr, atrArr, i);
  state.regime = entryRegime;
  state.htfBias = htfBias;

  const strategies = [
    { key: "emaCross", name: "EMA Cross", type: "trend", result: evaluateEmaCross(entryCandles, emaFastArr, emaSlowArr, rsiArr, atrArr, i) },
    { key: "pullback", name: "Pullback", type: "trend", result: evaluatePullback(entryCandles, emaSlowArr, atrArr, i, entryRegime) },
    { key: "srBounce", name: "S/R Bounce", type: "reversion", result: evaluateSRBounce(entryCandles, atrArr, i, supportLine, resistanceLine) },
    { key: "breakout", name: "Breakout", type: "trend", result: evaluateBreakout(entryCandles, atrArr, i) },
    { key: "rsiReversal", name: "RSI Reversal", type: "reversion", result: evaluateRsiReversal(entryCandles, rsiArr, atrArr, i) },
  ];

  const nowMs = Date.now();
  let anyFired = false;

  for (const strat of strategies) {
    if (!strat.result) continue;
    const { signal, sl, tp, reason } = strat.result;

    if (REQUIRE_REGIME_MATCH && strat.type === "trend") {
      const ok = (signal === "BUY" && entryRegime.trend === "trending-up") || (signal === "SELL" && entryRegime.trend === "trending-down");
      if (!ok) continue;
    } else if (REQUIRE_REGIME_MATCH && strat.type === "reversion" && entryRegime.trend !== "ranging") {
      continue;
    }

    if (REQUIRE_TREND_ALIGNMENT && strat.type === "trend") {
      const aligned = (signal === "BUY" && htfBias === "up") || (signal === "SELL" && htfBias === "down");
      if (!aligned) continue;
    }

    const prev = state.strategySignals[strat.key];
    if (prev && prev.lastSignal === signal) {
      const elapsedMin = (nowMs - new Date(prev.firedAtMs || 0).getTime()) / 60000;
      if (elapsedMin < COOLDOWN_MINUTES) continue;
    }

    // Competition-specific gates
    if (state.competition.halted) {
      console.log(`[${new Date().toISOString()}] ${strat.name} ${signal} suppressed — halted (${state.competition.haltReason})`);
      continue;
    }
    if (state.competition.tradesToday >= MAX_TRADES_PER_DAY) {
      console.log(`[${new Date().toISOString()}] ${strat.name} ${signal} suppressed — daily trade cap (${MAX_TRADES_PER_DAY}) reached`);
      continue;
    }
    if (state.competition.openPositions.length >= MAX_OPEN_POSITIONS) {
      console.log(`[${new Date().toISOString()}] ${strat.name} ${signal} suppressed — max open positions (${MAX_OPEN_POSITIONS}) reached`);
      continue;
    }

    state.strategySignals[strat.key] = { lastSignal: signal, lastTime: time, firedAtMs: new Date(nowMs).toISOString() };
    anyFired = true;

    const lot = computeLotSize(Math.abs(price - sl));

    state.lastSignal = signal;
    state.lastSignalTime = time;
    state.lastSignalPrice = price;
    state.lastSignalStrategy = strat.name;
    state.lastSignalReason = reason;
    state.history.unshift({ time, signal, price, strategy: strat.name });
    state.history = state.history.slice(0, 30);

    const msg = formatSignalMessage(strat.name, signal, price, rsiArr[i], time, lot, reason, sl, tp);
    await sendTelegram(msg);
    state.competition.tradesToday += 1;
    state.competition.openPositions.push({ signal, entryPrice: price, sl, tp, entryTime: time, strategy: strat.name, lot, beMoved: false });

    console.log(`[${new Date().toISOString()}] Sent ${strat.name} ${signal} @ ${price}`);
  }

  if (!anyFired) console.log(`[${new Date().toISOString()}] No new signal from any strategy`);

  const entryBias = state.lastSignal === "SELL" ? "down" : state.lastSignal === "BUY" ? "up" : closesBias(entryCandles);
  const entryTrendline = entryBias === "down" ? resistanceLine : supportLine;

  state.chartMap = {
    reason: state.lastSignal && state.lastSignalReason
      ? `${state.lastSignalReason} (${state.lastSignalStrategy})`
      : formatReason(price, rsiArr[i], entryBias),
    entry: {
      interval: INTERVAL,
      candles: entryCandles.map((c) => ({ o: c.open, h: c.high, l: c.low, c: c.close, t: c.datetime })),
      emaFast: emaFastArr,
      emaSlow: emaSlowArr,
      trendline: entryTrendline,
      bias: entryBias,
      signalIndex: null,
      signalType: state.lastSignal,
    },
    context: {
      interval: HIGH_INTERVAL,
      candles: contextCandles.map((c) => ({ o: c.open, h: c.high, l: c.low, c: c.close, t: c.datetime })),
      trendline: buildTrendline(contextCandles, htfBias),
      bias: htfBias,
    },
  };
}

async function pollLoop() {
  try {
    await checkOnce();
    setTimeout(pollLoop, POLL_MS);
  } catch (err) {
    state.status = "error";
    state.lastError = err.message;
    console.error("Check failed:", err.message);
    setTimeout(pollLoop, 60 * 1000);
  }
}

async function liveLoop() {
  try {
    if (competitionHasStarted() && !isMarketClosed()) {
      const price = await fetchQuote();
      state.livePrice = price;
      state.liveCheckedAt = new Date().toISOString();
    }
  } catch (err) {
    console.error("Live quote failed:", err.message);
  } finally {
    setTimeout(liveLoop, LIVE_POLL_MS);
  }
}

// ---------------- Web server ----------------
const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

app.get("/api/status", (req, res) => {
  res.json(state);
});

app.post("/api/close-position", async (req, res) => {
  const { index, result } = req.body || {};
  const pos = state.competition.openPositions[index];
  if (!pos) return res.status(404).json({ error: "position not found" });

  await applyTradeResult(result === "win" ? "win" : result === "breakeven" ? "breakeven" : "loss", pos.lot, {
    signal: pos.signal,
    entryPrice: pos.entryPrice,
    sl: pos.sl,
    tp: pos.tp,
    strategy: pos.strategy,
  });
  state.competition.openPositions.splice(index, 1);
  res.json({ ok: true, competition: state.competition });
});

app.post("/api/reset-day", (req, res) => {
  state.competition.dailyPnL = 0;
  state.competition.tradesToday = 0;
  state.competition.dayKey = todayKey();
  if (state.competition.haltReason === "daily") {
    state.competition.halted = false;
    state.competition.haltReason = null;
  }
  res.json({ ok: true, competition: state.competition });
});

app.post("/api/reset-competition", (req, res) => {
  state.competition.dailyPnL = 0;
  state.competition.totalPnL = 0;
  state.competition.tradesToday = 0;
  state.competition.halted = false;
  state.competition.haltReason = null;
  state.competition.log = [];
  state.competition.openPositions = [];
  state.competition.tradingDays = [];
  state.competition.dayKey = todayKey();
  state.strategySignals = { emaCross: null, pullback: null, srBounce: null, breakout: null, rsiReversal: null };
  res.json({ ok: true, competition: state.competition });
});

app.listen(PORT, () => {
  console.log(`MT5 Competition Signal Desk running on port ${PORT}`);

  const missing = [
    ["TWELVE_DATA_API_KEY", TWELVE_DATA_API_KEY],
    ["TELEGRAM_BOT_TOKEN", TELEGRAM_BOT_TOKEN],
    ["TELEGRAM_CHAT_ID", TELEGRAM_CHAT_ID],
  ].filter(([, v]) => !v);

  if (missing.length) {
    state.status = "error";
    state.lastError = `Missing config: ${missing.map(([n]) => n).join(", ")}`;
    console.error(state.lastError);
    return;
  }

  pollLoop();
  liveLoop();
});
