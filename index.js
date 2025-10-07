// index.js
// Exact implementation of the Trading Bot Specification (BOS + pullback + engulf + MTF filters)
// Uses M15 (execution) and M5 (pullback + entry).
// Fixed SL = 300, TP = 600.

import fs from "fs";
import Papa from "papaparse";
import { EMA, ATR, SMA } from "technicalindicators";

// ---------- CONFIG ----------
const DATA_DIR = "./data";
const M5_FILE = `${DATA_DIR}/R_75_5m.csv`;
const M15_FILE = `${DATA_DIR}/R_75_15m.csv`;

const START_BALANCE = 10000;
const PIVOT_LEFT = 5;   // pivot left bars
const PIVOT_RIGHT = 5;  // pivot right bars
const MIN_RETRACE_PCT = 0.20; // 20%
const MAX_RETRACE_PCT = 0.60; // 60%
const ATR_PERIOD = 14;
const ATR_SMA_LEN = 50; // for strength test
const FIXED_SL = 300; // points
const FIXED_TP = 600; // points
const MAX_LOOKAHEAD_M5_BARS = 10000; // increased limit for scanning

// ---------- HELPERS ----------
const fmt = (n) => (typeof n === "number" ? n.toFixed(4) : n);
const epochISO = (e) => new Date(e * 1000).toISOString().replace("T", " ").slice(0, 19);

function loadCSV(path) {
    if (!fs.existsSync(path)) {
        console.error("Missing file:", path);
        process.exit(1);
    }
    const text = fs.readFileSync(path, "utf8");
    const parsed = Papa.parse(text, { header: true, dynamicTyping: true }).data;
    return parsed
        .map(r => {
            if (!r || !r.epoch) return null;
            return {
                epoch: Number(r.epoch),
                open: Number(r.open),
                high: Number(r.high),
                low: Number(r.low),
                close: Number(r.close)
            };
        })
        .filter(Boolean);
}

function padLeft(arr, total, pad = null) {
    return Array(Math.max(0, total - arr.length)).fill(pad).concat(arr);
}

// binary search last index <= epoch
function findLastIndexLeq(candles, epoch) {
    let lo = 0, hi = candles.length - 1, ans = -1;
    while (lo <= hi) {
        const mid = Math.floor((lo + hi) / 2);
        if (candles[mid].epoch <= epoch) { ans = mid; lo = mid + 1; }
        else hi = mid - 1;
    }
    return ans;
}

// pivot detection (confirmed pivot with left/right, strict on both sides)
function detectPivots(candles, left = PIVOT_LEFT, right = PIVOT_RIGHT) {
    const pivots = []; // { idx, epoch, type: 'H'|'L', price }
    for (let i = left; i < candles.length - right; i++) {
        const cur = candles[i];
        let isHigh = true, isLow = true;
        for (let l = 1; l <= left; l++) {
            if (candles[i - l].close >= cur.close) isHigh = false;
            if (candles[i - l].close <= cur.close) isLow = false;
        }
        for (let r = 1; r <= right; r++) {
            if (candles[i + r].close >= cur.close) isHigh = false;
            if (candles[i + r].close <= cur.close) isLow = false;
        }
        if (isHigh) pivots.push({ idx: i, epoch: cur.epoch, type: "H", price: cur.close });
        if (isLow) pivots.push({ idx: i, epoch: cur.epoch, type: "L", price: cur.close });
    }
    return pivots;
}

// full engulfing (body + wicks), close higher/lower than prev close
function isEngulfing(curr, prev, bullish) {
    if (!curr || !prev) return false;
    if (!(curr.high >= prev.high && curr.low <= prev.low)) return false; // full wick+body engulf
    if (bullish) return curr.close > prev.close;
    return curr.close < prev.close;
}

// ---------- LOAD DATA ----------
const m5 = loadCSV(M5_FILE);
const m15 = loadCSV(M15_FILE);

if (!m5.length || !m15.length) {
    console.error("Missing one of M5/M15 CSV files in ./data");
    process.exit(1);
}

// ---------- INDICATORS ----------
// M15 ATR and ATR SMA(50)
const m15High = m15.map(c => c.high);
const m15Low = m15.map(c => c.low);
const m15Close = m15.map(c => c.close);
const m15ATRraw = ATR.calculate({ period: ATR_PERIOD, high: m15High, low: m15Low, close: m15Close });
const m15ATR = padLeft(m15ATRraw, m15.length, null);
const m15ATRSMA50 = padLeft(SMA.calculate({ period: ATR_SMA_LEN, values: m15ATRraw }), m15.length, null);

// EMA50/EMA200 on M15
const m15EMA50 = padLeft(EMA.calculate({ period: 50, values: m15Close }), m15.length, null);
const m15EMA200 = padLeft(EMA.calculate({ period: 200, values: m15Close }), m15.length, null);

// ---------- PIVOTS on M15 ----------
const m15Pivots = detectPivots(m15, PIVOT_LEFT, PIVOT_RIGHT);

// ---------- BACKTEST LOOP (M15 execution) ----------
let balance = START_BALANCE;
const trades = [];
let lastTrade = { time: 0, direction: null };

for (let m15i = 0; m15i < m15.length; m15i++) {
    const bar = m15[m15i];

    // 1) last confirmed pivots before this M15 bar
    const pivBefore = m15Pivots.filter(p => p.idx < m15i);
    if (!pivBefore.length) continue;

    // get last H and last L before this bar
    let lastH = null, lastL = null;
    for (let k = pivBefore.length - 1; k >= 0; k--) {
        if (!lastH && pivBefore[k].type === "H") lastH = pivBefore[k];
        if (!lastL && pivBefore[k].type === "L") lastL = pivBefore[k];
        if (lastH && lastL) break;
    }

    // 2) BOS: M15 candle CLOSE beyond last confirmed swing (close only)
    let bos = null;
    if (lastH && bar.close > lastH.price) bos = { type: "BULL", brokenSwing: lastH };
    else if (lastL && bar.close < lastL.price) bos = { type: "BEAR", brokenSwing: lastL };
    else continue;

    // 3) M15 EMA50/EMA200 trend
    const m15trend = (m15EMA50[m15i] !== null && m15EMA200[m15i] !== null)
        ? (m15EMA50[m15i] > m15EMA200[m15i] ? "BULL" : (m15EMA50[m15i] < m15EMA200[m15i] ? "BEAR" : null))
        : null;
    if (!m15trend) continue;
    // BOS direction must match trend
    if ((bos.type === "BULL" && m15trend !== "BULL") || (bos.type === "BEAR" && m15trend !== "BEAR")) continue;

    // 4) Measure BOS range
    const bosRange = Math.abs(bar.close - bos.brokenSwing.price);
    if (bosRange <= 0) continue;

    // 5) Monitor M5 for pullback (combined with engulf search): must reach 20-60% without exceeding 60%
    const m5StartIdx = findLastIndexLeq(m5, bar.epoch) + 1;
    if (m5StartIdx <= 0 || m5StartIdx >= m5.length) continue;

    let engulfIdx = -1;
    for (let j = m5StartIdx; j < m5.length && (j - m5StartIdx) < MAX_LOOKAHEAD_M5_BARS; j++) {
        const m5c = m5[j];
        const prev = (j > 0) ? m5[j - 1] : null;
        if (!prev) continue;

        let retracePct;
        if (bos.type === "BULL") {
            retracePct = (bar.close - m5c.close) / bosRange;
        } else {
            retracePct = (m5c.close - bar.close) / bosRange;
        }
        if (retracePct > MAX_RETRACE_PCT) continue; // too deep -> skip this candle

        const bullEngulf = isEngulfing(m5c, prev, true);
        const bearEngulf = isEngulfing(m5c, prev, false);

        if (bos.type === "BULL" && bullEngulf && retracePct >= MIN_RETRACE_PCT && retracePct <= MAX_RETRACE_PCT) {
            engulfIdx = j;
            break;
        }
        if (bos.type === "BEAR" && bearEngulf && retracePct >= MIN_RETRACE_PCT && retracePct <= MAX_RETRACE_PCT) {
            engulfIdx = j;
            break;
        }
    }
    if (engulfIdx === -1) continue;

    // 6) Re-check EMA alignment & strength at engulf time
    const engulfEpoch = m5[engulfIdx].epoch;
    const m15idxAtEngulf = findLastIndexLeq(m15, engulfEpoch);
    if (m15idxAtEngulf < 0) continue;

    const m15trendNow = (m15EMA50[m15idxAtEngulf] !== null && m15EMA200[m15idxAtEngulf] !== null)
        ? (m15EMA50[m15idxAtEngulf] > m15EMA200[m15idxAtEngulf] ? "BULL" : (m15EMA50[m15idxAtEngulf] < m15EMA200[m15idxAtEngulf] ? "BEAR" : null))
        : null;
    if (!m15trendNow) continue;
    if ((bos.type === "BULL" && m15trendNow !== "BULL") || (bos.type === "BEAR" && m15trendNow !== "BEAR")) continue;

    const m15AtrNow = m15ATR[m15idxAtEngulf];
    const m15AtrSMA50Now = m15ATRSMA50[m15idxAtEngulf];
    const strengthNow = (m15AtrNow !== null && m15AtrSMA50Now !== null && m15AtrNow > m15AtrSMA50Now);
    if (!strengthNow) continue;

    // Prevent repeated trades within same candle timestamp
    if (engulfEpoch === lastTrade.time) continue;

    // 7) Place trade at close of engulfing M5 candle, with FIXED SL/TP
    const entryPrice = m5[engulfIdx].close;
    let stopPrice, targetPrice;
    if (bos.type === "BULL") {
        stopPrice = entryPrice - FIXED_SL;
        targetPrice = entryPrice + FIXED_TP;
    } else {
        stopPrice = entryPrice + FIXED_SL;
        targetPrice = entryPrice - FIXED_TP;
    }

    // 8) Monitor forward on M5 for SL/TP (intrabar via high/low)
    let result = "NO_EXIT";
    let exitEpoch = null;
    let exitPrice = null;
    for (let t = engulfIdx + 1; t < m5.length && (t - engulfIdx) < MAX_LOOKAHEAD_M5_BARS; t++) {
        const f = m5[t];
        // check TP/SL by candle high/low
        if (bos.type === "BULL") {
            if (f.low <= stopPrice) { result = "LOSS"; exitEpoch = f.epoch; exitPrice = stopPrice; break; }
            if (f.high >= targetPrice) { result = "WIN"; exitEpoch = f.epoch; exitPrice = targetPrice; break; }
        } else {
            if (f.high >= stopPrice) { result = "LOSS"; exitEpoch = f.epoch; exitPrice = stopPrice; break; }
            if (f.low <= targetPrice) { result = "WIN"; exitEpoch = f.epoch; exitPrice = targetPrice; break; }
        }
    }

    if (result === "NO_EXIT") {
        const lastIdx = Math.min(m5.length - 1, engulfIdx + MAX_LOOKAHEAD_M5_BARS - 1);
        exitEpoch = m5[lastIdx].epoch;
        exitPrice = m5[lastIdx].close;
    }

    // compute PnL (direction-aware)
    let pnl;
    if (bos.type === "BULL") pnl = exitPrice - entryPrice;
    else pnl = entryPrice - exitPrice;
    balance += pnl;

    const trade = {
        type: "BOS Pullback",
        direction: bos.type === "BULL" ? "LONG" : "SHORT",
        bosEpoch: bar.epoch,
        brokenSwingEpoch: bos.brokenSwing.epoch,
        brokenSwingPrice: bos.brokenSwing.price,
        bosClose: bar.close,
        engulfM5Epoch: engulfEpoch,
        entryEpoch: engulfEpoch,
        entryPrice,
        stopPrice,
        targetPrice,
        exitEpoch,
        exitPrice,
        result,
        pnl,
        balance
    };
    trades.push(trade);

    // Update last trade memory
    lastTrade = { time: engulfEpoch, direction: bos.type };

    console.log(`${epochISO(trade.entryEpoch)} | ${trade.type} | ${trade.direction} | entry ${fmt(trade.entryPrice)} | SL ${fmt(trade.stopPrice)} | TP ${fmt(trade.targetPrice)} | ${trade.result} | PnL ${trade.pnl.toFixed(4)} | Bal ${trade.balance.toFixed(2)}`);
}

// ---------- SUMMARY ----------
const wins = trades.filter(t => t.result === "WIN").length;
const losses = trades.filter(t => t.result === "LOSS").length;
const noex = trades.filter(t => t.result === "NO_EXIT").length;

console.log("\n===== SUMMARY =====");
console.log(`Start balance: ${START_BALANCE}`);
console.log(`Final balance: ${balance.toFixed(2)}`);
console.log(`Trades: ${trades.length} | Wins: ${wins} | Losses: ${losses} | NoExit: ${noex}`);
console.log(`Win rate: ${trades.length ? (wins / trades.length * 100).toFixed(2) + "%" : "0.00%"}`);

// save results
fs.writeFileSync(`${DATA_DIR}/backtest_bos_exact_fixedSLTP.json`, JSON.stringify({ start: START_BALANCE, end: balance, trades }, null, 2));
console.log(`Saved ${DATA_DIR}/backtest_bos_exact_fixedSLTP.json`);