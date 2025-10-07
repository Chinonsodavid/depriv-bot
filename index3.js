// index.js
import fs from "fs";
import path from "path";
import csv from "csv-parser";

// === CONFIG ===
const DATA_DIR = "./data";
const DATA_PATH = `${DATA_DIR}/R_75_15m.csv`; // Must contain: time,open,high,low,close
const SWING_SIZE = 3;               // Bars left/right to confirm a swing
const MIN_IMPULSE_CANDLES = 2;      // Minimum impulsive candles between swings
const MIN_LEG_PTS = 0;              // Optional: min distance in price units
const DEBUG_PRINT = true;           // Toggle console output

// === UTIL: Swing High/Low ===
function isSwingHigh(candles, i, size) {
    if (i < size || i >= candles.length - size) return false;
    const hi = candles[i].high;
    for (let k = i - size; k <= i + size; k++) if (candles[k].high > hi) return false;
    return true;
}
function isSwingLow(candles, i, size) {
    if (i < size || i >= candles.length - size) return false;
    const lo = candles[i].low;
    for (let k = i - size; k <= i + size; k++) if (candles[k].low < lo) return false;
    return true;
}

// === Load Candle Data ===
function loadDataFromCSV(filePath) {
    return new Promise((resolve, reject) => {
        const rows = [];
        fs.createReadStream(filePath)
            .pipe(csv())
            .on("data", (r) =>
                rows.push({
                    time: r.time,
                    open: parseFloat(r.open),
                    high: parseFloat(r.high),
                    low: parseFloat(r.low),
                    close: parseFloat(r.close),
                })
            )
            .on("end", () => resolve(rows))
            .on("error", reject);
    });
}

// === Detect Raw Swings ===
function detectRawSwings(candles) {
    const swings = [];
    for (let i = SWING_SIZE; i < candles.length - SWING_SIZE; i++) {
        if (isSwingHigh(candles, i, SWING_SIZE))
            swings.push({ type: "H", index: i, price: candles[i].high, time: candles[i].time });
        if (isSwingLow(candles, i, SWING_SIZE))
            swings.push({ type: "L", index: i, price: candles[i].low, time: candles[i].time });
    }
    swings.sort((a, b) => a.index - b.index);
    return swings;
}

// === BOS + CHoCH Detector ===
function detectBOSFromSwings(swings, candles) {
    const events = [];
    let lastHighSeen = null;
    let lastLowSeen = null;
    let currentTrend = null; // "bullish" | "bearish"

    for (let i = 0; i < swings.length; i++) {
        const s = swings[i];

        // === Bullish BOS or CHoCH ===
        if (s.type === "H") {
            if (lastHighSeen && s.price > lastHighSeen.price) {
                let prevLow = null;
                for (let j = i - 1; j >= 0; j--) {
                    if (swings[j].type === "L") {
                        prevLow = swings[j];
                        break;
                    }
                }
                if (prevLow) {
                    const startIdx = prevLow.index;
                    const endIdx = s.index;
                    const startPrice = prevLow.price;
                    const endPrice = s.price;
                    const legPts = endPrice - startPrice;

                    let dirCandles = 0;
                    for (let k = startIdx + 1; k <= endIdx; k++) {
                        if (candles[k].close > candles[k - 1].close) dirCandles++;
                    }

                    const isImpulsive = dirCandles >= MIN_IMPULSE_CANDLES || legPts >= MIN_LEG_PTS;
                    if (isImpulsive) {
                        const eventType = currentTrend === "bearish" ? "CHoCH_UP" : "BOS_UP";
                        events.push({
                            type: eventType,
                            time: s.time,
                            startTime: candles[startIdx].time,
                            endTime: candles[endIdx].time,
                            startPrice,
                            endPrice,
                            legPts,
                            dirCandles,
                        });
                        currentTrend = "bullish";
                    }
                }
            }
            lastHighSeen = s;
        }

        // === Bearish BOS or CHoCH ===
        else if (s.type === "L") {
            if (lastLowSeen && s.price < lastLowSeen.price) {
                let prevHigh = null;
                for (let j = i - 1; j >= 0; j--) {
                    if (swings[j].type === "H") {
                        prevHigh = swings[j];
                        break;
                    }
                }
                if (prevHigh) {
                    const startIdx = prevHigh.index;
                    const endIdx = s.index;
                    const startPrice = prevHigh.price;
                    const endPrice = s.price;
                    const legPts = startPrice - endPrice;

                    let dirCandles = 0;
                    for (let k = startIdx + 1; k <= endIdx; k++) {
                        if (candles[k].close < candles[k - 1].close) dirCandles++;
                    }

                    const isImpulsive = dirCandles >= MIN_IMPULSE_CANDLES || legPts >= MIN_LEG_PTS;
                    if (isImpulsive) {
                        const eventType = currentTrend === "bullish" ? "CHoCH_DOWN" : "BOS_DOWN";
                        events.push({
                            type: eventType,
                            time: s.time,
                            startTime: candles[startIdx].time,
                            endTime: candles[endIdx].time,
                            startPrice,
                            endPrice,
                            legPts,
                            dirCandles,
                        });
                        currentTrend = "bearish";
                    }
                }
            }
            lastLowSeen = s;
        }
    }

    return events;
}

// === MAIN EXECUTION ===
(async function main() {
    const candles = await loadDataFromCSV(DATA_PATH);
    const swings = detectRawSwings(candles);
    const events = detectBOSFromSwings(swings, candles);

    if (DEBUG_PRINT) {
        console.log("📈 STRUCTURE EVENTS (" + events.length + " total):\n");
        for (const e of events) {
            console.log(
                `${e.time} | ${e.type.padEnd(10)} | ${e.startPrice.toFixed(2)} → ${e.endPrice.toFixed(2)} ` +
                `(${Math.abs(e.legPts).toFixed(2)} pts) | start=${e.startTime} | end=${e.endTime} | dirCandles=${e.dirCandles}`
            );
        }
    }
})();