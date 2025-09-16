/**
 * Synthetic Continuation + Mean Reversion Backtester
 *
 * - LTF: 15M
 * - Uses Bollinger Bands (20, 2) and ATR(14)
 * - Continuation & Mean Reversion logic implemented
 * - Session limits respected
 * - Logs each trade with timestamp, type, result, balance
 */

import fs from "fs";
import { SMA, ATR, BollingerBands } from "technicalindicators";
import Papa from "papaparse";

// ===== CONFIG ======
const FILE = "./data/R_75_15m.csv"; // LTF candles
const RISK_REWARD_CONT = 2; // 1:2 fixed for MR/Continuation
const RISK_REWARD_MR = 2;
const ATR_PERIOD = 14;
const BB_PERIOD = 20;
const MAX_TRADES_PER_SESSION = 2;
const SESSIONS = [
    { label: "London", start: 8, end: 11 }, // UTC
    { label: "NewYork", start: 13, end: 16 },
];

// ===== LOAD CSV ======
function loadCSV(path) {
    const text = fs.readFileSync(path, "utf8");
    const parsed = Papa.parse(text, { header: true, dynamicTyping: false }).data;
    return parsed
        .map(r => {
            if (!r || !r.epoch) return null;
            return {
                epoch: Number(r.epoch),
                open: Number(r.open),
                high: Number(r.high),
                low: Number(r.low),
                close: Number(r.close),
            };
        })
        .filter(Boolean);
}

const candles = loadCSV(FILE);
if (!candles.length) {
    console.error("❌ No LTF candles loaded.");
    process.exit(1);
}

// ===== INDICATORS ======
const closes = candles.map(c => c.close);
const highs = candles.map(c => c.high);
const lows = candles.map(c => c.low);

const atrValues = ATR.calculate({ period: ATR_PERIOD, high: highs, low: lows, close: closes });
const atrPadded = Array(ATR_PERIOD).fill(null).concat(atrValues);

const bbValues = BollingerBands.calculate({
    period: BB_PERIOD,
    values: closes,
    stdDev: 2
});
const bbPadded = Array(BB_PERIOD - 1).fill(null).concat(bbValues);

// ===== BACKTEST ======
let balance = 10000;
let trades = [];

function getSession(epoch) {
    const hour = new Date(epoch * 1000).getUTCHours();
    return SESSIONS.find(s => hour >= s.start && hour <= s.end);
}

for (let i = Math.max(ATR_PERIOD, BB_PERIOD); i < candles.length - 1; i++) {
    const c = candles[i];
    const nextC = candles[i + 1];
    const atr = atrPadded[i];
    const bb = bbPadded[i];
    if (!atr || !bb) continue;

    const session = getSession(c.epoch);
    if (!session) continue;

    const today = new Date(c.epoch * 1000).toISOString().split("T")[0];
    const tradesToday = trades.filter(t => t.date === today && t.session === session.label);
    if (tradesToday.length >= MAX_TRADES_PER_SESSION) continue;

    let tradeType = null;
    let entry, sl, tp;

    // ===== Continuation (Trend Following) =====
    if ((c.close > bb.upper && atr > atrPadded.slice(i - 10, i).reduce((a, b) => a + b, 0) / 10) ||
        (c.close < bb.lower && atr > atrPadded.slice(i - 10, i).reduce((a, b) => a + b, 0) / 10)) {

        // Confirmation: next candle closes in same direction
        if ((c.close > bb.upper && nextC.close > c.close) || (c.close < bb.lower && nextC.close < c.close)) {
            tradeType = "Continuation";
            entry = nextC.close;
            sl = c.close > bb.upper ? c.close - atr : c.close + atr;
            tp = c.close > bb.upper ? entry + atr * RISK_REWARD_CONT : entry - atr * RISK_REWARD_CONT;
        }
    }

    // ===== Mean Reversion (Snap Back) =====
    if (!tradeType && ((c.high > bb.upper && c.close < bb.upper) || (c.low < bb.lower && c.close > bb.lower))) {
        // ATR stable or falling
        const atrWindow = atrPadded.slice(i - 10, i);
        const atrAvg = atrWindow.reduce((a, b) => a + b, 0) / atrWindow.length;
        if (atr <= atrAvg) {
            // Confirmation: next candle reverses
            if ((c.close > bb.upper && nextC.close < c.close) || (c.close < bb.lower && nextC.close > c.close)) {
                tradeType = "MeanReversion";
                entry = nextC.close;
                sl = c.high > bb.upper ? c.high + atr : c.low - atr;
                tp = c.high > bb.upper ? (bb.middle ?? closes[i]) : (bb.middle ?? closes[i]);
            }
        }
    }

    if (tradeType) {
        // Execute naive: next 50 candles
        let result = "NoExit";
        for (let j = i + 1; j < i + 51 && j < candles.length; j++) {
            const f = candles[j];
            if (tradeType === "Continuation") {
                if (entry < tp && f.high >= tp) { result = "win"; break; }
                if (entry > tp && f.low <= tp) { result = "win"; break; }
                if (entry < sl && f.low <= sl) { result = "loss"; break; }
                if (entry > sl && f.high >= sl) { result = "loss"; break; }
            } else {
                // Mean Reversion
                if (entry < tp && f.high >= tp) { result = "win"; break; }
                if (entry > tp && f.low <= tp) { result = "win"; break; }
                if (entry < sl && f.low <= sl) { result = "loss"; break; }
                if (entry > sl && f.high >= sl) { result = "loss"; break; }
            }
        }
        const pnl = result === "win" ? Math.abs(tp - entry) : (result === "loss" ? -Math.abs(entry - sl) : 0);
        balance += pnl;
        trades.push({
            date: today,
            time: new Date(c.epoch * 1000).toISOString(),
            session: session.label,
            type: tradeType,
            entry,
            sl,
            tp,
            result,
            pnl,
            balance
        });
    }
}

// ===== OUTPUT ======
trades.forEach(t => {
    console.log(`${t.time} | ${t.type} | Entry: ${t.entry.toFixed(2)} | SL: ${t.sl.toFixed(2)} | TP: ${t.tp.toFixed(2)} | ${t.result.toUpperCase()} | Bal: ${t.balance.toFixed(2)}`);
});

console.log("\n===== SUMMARY =====");
console.log(`Start balance: 10000`);
console.log(`Final balance: ${balance.toFixed(2)}`);
console.log(`Net PnL: ${(balance - 10000).toFixed(2)}`);
console.log(`Trades: ${trades.length} | Wins: ${trades.filter(t => t.result === 'win').length} | Losses: ${trades.filter(t => t.result === 'loss').length}`);
console.log(`Win rate: ${(trades.filter(t => t.result === 'win').length / trades.length * 100).toFixed(2)}%`);

fs.writeFileSync("./data/backtest_trades_br.json", JSON.stringify(trades, null, 2));
console.log("Saved ./data/backtest_trades_br.json");
