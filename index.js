import fs from "fs";
import { EMA, BollingerBands } from "technicalindicators";

/* ===== CONFIG ===== */
const CSV_5M = "./data/R_75_5m.csv";
const CSV_15M = "./data/R_75_15m.csv";
const CSV_1H = "./data/R_75_1h.csv";
const CSV_2H = "./data/R_75_2h.csv";

const HTF_EMA = 50;
const BB_PERIOD = 20;
const BB_STDDEV = 2;
const MAX_TRADES_PER_DAY = 2;
const RISK_PCT = 0.01;
const RR_TARGET = 2;

/* ===== HELPERS ===== */
const fmt = (n, d = 4) => (typeof n === "number" ? n.toFixed(d) : String(n));
const epochToISO = e => new Date(e * 1000).toISOString().replace("T", " ").split(".")[0];
const getYYYYMMDD = e => {
    const d = new Date(e * 1000);
    return `${d.getUTCFullYear()}-${(d.getUTCMonth() + 1).toString().padStart(2, '0')}-${d.getUTCDate().toString().padStart(2, '0')}`;
};
function parseCSV(path) {
    const lines = fs.readFileSync(path, "utf8").trim().split("\n").slice(1);
    return lines.map(l => {
        const [epoch, open, high, low, close] = l.split(",").map(Number);
        return { epoch, open, high, low, close };
    });
}
function isBullishEngulf(curr, prev) {
    return curr.close > curr.open && prev.close < prev.open && curr.close >= prev.open && curr.open <= prev.close;
}
function isBearishEngulf(curr, prev) {
    return curr.close < curr.open && prev.close > prev.open && curr.open >= prev.close && curr.close <= prev.open;
}
function computeEMAArray(closes, period) {
    if (closes.length < period) return [];
    return EMA.calculate({ period, values: closes });
}
function computeBBArray(closes, period, stdDev) {
    if (closes.length < period) return [];
    return BollingerBands.calculate({ period, stdDev, values: closes });
}
function findLatestAtOrBefore(candles, epoch) {
    let lo = 0, hi = candles.length - 1, ans = null;
    while (lo <= hi) {
        const mid = Math.floor((lo + hi) / 2);
        if (candles[mid].epoch <= epoch) { ans = candles[mid]; lo = mid + 1; }
        else hi = mid - 1;
    }
    return ans;
}

/* ===== LOAD DATA ===== */
const candles5m = parseCSV(CSV_5M);
const candles15m = parseCSV(CSV_15M);
const candles1h = parseCSV(CSV_1H);
const candles2h = parseCSV(CSV_2H);

/* ===== BUILD INDICATORS ===== */
function buildIndicatorMaps(candles, emaPeriod, bbPeriod, stdDev) {
    const closes = candles.map(c => c.close);
    const emaArr = computeEMAArray(closes, emaPeriod);
    const bbArr = computeBBArray(closes, bbPeriod, stdDev);
    const emaMap = new Map(), bbMap = new Map();
    for (let i = 0; i < candles.length; i++) {
        const e = candles[i].epoch;
        if (i >= emaPeriod - 1) emaMap.set(e, emaArr[i - (emaPeriod - 1)]);
        if (i >= bbPeriod - 1 && bbArr[i - (bbPeriod - 1)]) bbMap.set(e, bbArr[i - (bbPeriod - 1)]);
    }
    return { emaMap, bbMap };
}
const tf2h_inds = buildIndicatorMaps(candles2h, HTF_EMA, BB_PERIOD, BB_STDDEV);
const tf1h_inds = buildIndicatorMaps(candles1h, HTF_EMA, BB_PERIOD, BB_STDDEV);

/* ===== BACKTEST STATE ===== */
let account = 10000, position = null, trades = [], dailyTrades = 0, lastTradeDay = null, consecLosses = 0;
const executedSignals = new Set();

/* ===== SIGNAL DETECTION ===== */
function detectHTFSignal(epoch) {
    const c2h = findLatestAtOrBefore(candles2h, epoch);
    const c1h = findLatestAtOrBefore(candles1h, epoch);
    const chosen = c2h && tf2h_inds.bbMap.has(c2h.epoch) ? { candle: c2h, bbMap: tf2h_inds.bbMap, emaMap: tf2h_inds.emaMap, tfName: '2H', arr: candles2h } :
        c1h && tf1h_inds.bbMap.has(c1h.epoch) ? { candle: c1h, bbMap: tf1h_inds.bbMap, emaMap: tf1h_inds.emaMap, tfName: '1H', arr: candles1h } : null;
    if (!chosen) return null;
    const idx = chosen.arr.findIndex(c => c.epoch === chosen.candle.epoch);
    if (idx <= 0) return null;
    const prev = chosen.arr[idx - 1];
    const bb = chosen.bbMap.get(chosen.candle.epoch);
    const ema = chosen.emaMap.get(chosen.candle.epoch);
    if (!bb || !ema) return null;
    const overbought = chosen.candle.close >= bb.upper;
    const oversold = chosen.candle.close <= bb.lower;
    const bullEng = isBullishEngulf(chosen.candle, prev);
    const bearEng = isBearishEngulf(chosen.candle, prev);

    if (overbought && bearEng) return { module: 'MR', bias: 'SHORT', htfCandle: chosen.candle, bb, ema, tfName: chosen.tfName };
    if (oversold && bullEng) return { module: 'MR', bias: 'LONG', htfCandle: chosen.candle, bb, ema, tfName: chosen.tfName };
    if (bullEng && chosen.candle.close > ema) return { module: 'CONT', bias: 'LONG', htfCandle: chosen.candle, bb, ema, tfName: chosen.tfName };
    if (bearEng && chosen.candle.close < ema) return { module: 'CONT', bias: 'SHORT', htfCandle: chosen.candle, bb, ema, tfName: chosen.tfName };
    return null;
}

/* ===== TRADE LOGIC ===== */
function tryEnterTrade(epoch) {
    if (position) return;
    const today = getYYYYMMDD(epoch);
    if (lastTradeDay !== today) { dailyTrades = 0; lastTradeDay = today; }
    if (dailyTrades >= MAX_TRADES_PER_DAY || consecLosses >= 2) return;

    const htfSig = detectHTFSignal(epoch);
    if (!htfSig) return;

    const c5 = findLatestAtOrBefore(candles5m, epoch);
    if (!c5) return;
    const idx5 = candles5m.findIndex(c => c.epoch === c5.epoch);
    if (idx5 <= 0) return;
    const prev5 = candles5m[idx5 - 1];

    const etfBias = htfSig.bias === 'LONG' ? (c5.close > c5.open ? 'LONG' : null) : (c5.close < c5.open ? 'SHORT' : null);
    if (!etfBias || etfBias !== htfSig.bias) return;

    const sigKey = `${htfSig.tfName}_${htfSig.htfCandle.epoch}_${htfSig.bias}`;
    if (executedSignals.has(sigKey)) return;
    executedSignals.add(sigKey);

    const entry = c5.close, H = htfSig.htfCandle.high, L = htfSig.htfCandle.low;
    let stop, target;
    if (htfSig.module === 'MR') { stop = htfSig.bias === 'LONG' ? L : H; target = htfSig.bias === 'LONG' ? htfSig.bb.middle : htfSig.bb.middle; }
    else { stop = htfSig.bias === 'LONG' ? L : H; target = htfSig.bias === 'LONG' ? entry + RR_TARGET * (entry - L) : entry - RR_TARGET * (H - entry); }
    const riskPerTrade = account * RISK_PCT;
    const riskPerUnit = Math.abs(entry - stop);
    if (riskPerUnit <= 0) return;
    const qty = riskPerTrade / riskPerUnit;
    if (!isFinite(qty) || qty <= 0) return;

    position = { side: htfSig.bias, entry, stop, target, qty, module: htfSig.module, htfRef: { tf: htfSig.tfName, epoch: htfSig.htfCandle.epoch }, timeEnter: epochToISO(epoch) };
    dailyTrades += 1;
    console.log(`✅ ENTER ${position.side} | ${htfSig.module} | Entry ${fmt(entry)} | Stop ${fmt(stop)} | Target ${fmt(target)} | Qty ${fmt(qty, 2)} | @ ${epochToISO(epoch)}`);
}

/* ===== MANAGE POSITION ===== */
function managePosition(epoch) {
    if (!position) return;
    const c5 = findLatestAtOrBefore(candles5m, epoch);
    if (!c5) return;
    const px = c5.close;
    let exit = null;
    if (position.side === 'LONG') {
        if (px <= position.stop) exit = { price: position.stop, reason: 'STOP' };
        else if (px >= position.target) exit = { price: position.target, reason: 'TARGET' };
    } else {
        if (px >= position.stop) exit = { price: position.stop, reason: 'STOP' };
        else if (px <= position.target) exit = { price: position.target, reason: 'TARGET' };
    }
    if (exit) {
        const pnl = position.side === 'LONG' ? exit.price - position.entry : position.entry - exit.price;
        const tradePnL = pnl * position.qty;
        account += tradePnL;
        trades.push({ ...position, exit: exit.price, reason: exit.reason, pnl: tradePnL, timeExit: epochToISO(epoch) });
        console.log(`🏁 EXIT ${position.side} | ${exit.reason} | PnL ${tradePnL.toFixed(2)} | Balance ${account.toFixed(2)} | @ ${epochToISO(epoch)}`);
        if (tradePnL < 0) consecLosses += 1; else consecLosses = 0;
        position = null;
    }
}

/* ===== BACKTEST LOOP ===== */
for (let i = 0; i < candles5m.length; i++) {
    const epoch = candles5m[i].epoch;
    managePosition(epoch);
    if (!position) tryEnterTrade(epoch);
}

/* ===== FORCE CLOSE ===== */
if (position) {
    const lastPx = candles5m[candles5m.length - 1].close;
    const pnl = position.side === 'LONG' ? lastPx - position.entry : position.entry - lastPx;
    const tradePnL = pnl * position.qty;
    account += tradePnL;
    trades.push({ ...position, exit: lastPx, reason: 'FORCE_CLOSE_END', pnl: tradePnL, timeExit: epochToISO(candles5m[candles5m.length - 1].epoch) });
    console.log(`🏁 FORCE CLOSE ${position.side} | PnL ${tradePnL.toFixed(2)} | Balance ${account.toFixed(2)}`);
}

/* ===== SUMMARY ===== */
const wins = trades.filter(t => t.pnl > 0).length;
const losses = trades.filter(t => t.pnl <= 0).length;
const winRate = trades.length ? wins / trades.length * 100 : 0;
let equity = 10000, peak = 10000, maxDD = 0;
for (const tr of trades) { equity += tr.pnl; peak = Math.max(peak, equity); maxDD = Math.max(maxDD, (peak - equity) / peak); }
console.log("\n===== BACKTEST RESULT =====");
console.log(`Trades: ${trades.length} | Wins: ${wins} | Losses: ${losses} | WinRate: ${winRate.toFixed(2)}%`);
console.log(`Start Balance: $10000 | Final Balance: $${account.toFixed(2)}`);
console.log(`Max Drawdown: ${(maxDD * 100).toFixed(2)}%`);
console.log("==============================\n");

/* ===== SAVE CSV ===== */
fs.writeFileSync("./data/backtest_trades_strict.csv", "timeEnter,htf_tf,htf_epoch,side,entry,stop,target,qty,exit,reason,pnl\n" +
    trades.map(t => `${t.timeEnter},${t.htfRef?.tf || ''},${t.htfRef?.epoch || ''},${t.side},${t.entry},${t.stop},${t.target},${t.qty},${t.exit},${t.reason},${t.pnl}`).join("\n"));
console.log("Total 5M candles:", candles5m.length);
