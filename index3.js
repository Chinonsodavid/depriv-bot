import fs from "fs";
import path from "path";
import csv from "csv-parser";

const DATA_PATH = "data/R_75_15m.csv";
const SWING_SIZE = 3;

// ----------- Detect swing highs and lows -----------
const isSwingHigh = (candles, i, size) => {
    if (i < size || i >= candles.length - size) return false;
    const hi = candles[i].high;
    for (let k = i - size; k <= i + size; k++) if (candles[k].high > hi) return false;
    return true;
};

const isSwingLow = (candles, i, size) => {
    if (i < size || i >= candles.length - size) return false;
    const lo = candles[i].low;
    for (let k = i - size; k <= i + size; k++) if (candles[k].low < lo) return false;
    return true;
};

// ----------- CSV Loader (convert epoch → ISO time) -----------
function loadDataFromCSV(filePath) {
    return new Promise((resolve, reject) => {
        const rows = [];
        fs.createReadStream(filePath)
            .pipe(csv())
            .on("data", (r) => {
                const epoch = parseInt(r.epoch); // ⬅️ use the 'epoch' column
                const timeISO = new Date(epoch * 1000).toISOString(); // ⬅️ convert to readable date

                rows.push({
                    time: timeISO, // ⬅️ store readable timestamp
                    open: parseFloat(r.open),
                    high: parseFloat(r.high),
                    low: parseFloat(r.low),
                    close: parseFloat(r.close),
                });
            })
            .on("end", () => resolve(rows))
            .on("error", (err) => reject(err));
    });
}

// ----------- BOS + CHoCH detection -----------
function detectBOSFromSwings(swings, candles) {
    const events = [];
    let lastHighSeen = null;
    let lastLowSeen = null;
    let currentTrend = null;

    for (let i = 0; i < swings.length; i++) {
        const s = swings[i];
        const candle = candles[s.index];

        // ==== BULLISH BOS ====
        if (s.type === "H") {
            if (lastHighSeen) {
                const prevCandle = candles[lastHighSeen.index];
                const prevBodyHigh = Math.max(prevCandle.open, prevCandle.close);
                const prevWickHigh = prevCandle.high;
                const curBodyLow = Math.min(candle.open, candle.close);

                const brokeBody = curBodyLow > prevBodyHigh && candle.close > prevWickHigh;
                if (brokeBody) {
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
                        const endPrice = candle.high;
                        const legPts = endPrice - startPrice;
                        const eventType = currentTrend === "bearish" ? "CHoCH_UP" : "BOS_UP";

                        events.push({
                            timestamp: candle.time, // 🕒 readable timestamp
                            type: eventType,
                            startPrice,
                            endPrice,
                            legPts,
                        });
                        currentTrend = "bullish";
                    }
                }
            }
            lastHighSeen = s;
        }

        // ==== BEARISH BOS ====
        else if (s.type === "L") {
            if (lastLowSeen) {
                const prevCandle = candles[lastLowSeen.index];
                const prevBodyLow = Math.min(prevCandle.open, prevCandle.close);
                const prevWickLow = prevCandle.low;
                const curBodyHigh = Math.max(candle.open, candle.close);

                const brokeBody = curBodyHigh < prevBodyLow && candle.close < prevWickLow;
                if (brokeBody) {
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
                        const endPrice = candle.low;
                        const legPts = startPrice - endPrice;
                        const eventType = currentTrend === "bullish" ? "CHoCH_DOWN" : "BOS_DOWN";

                        events.push({
                            timestamp: candle.time, // 🕒 readable timestamp
                            type: eventType,
                            startPrice,
                            endPrice,
                            legPts,
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

// ----------- Swing detection -----------
function detectSwings(candles) {
    const swings = [];
    for (let i = SWING_SIZE; i < candles.length - SWING_SIZE; i++) {
        if (isSwingHigh(candles, i, SWING_SIZE))
            swings.push({ type: "H", index: i, price: candles[i].high });
        if (isSwingLow(candles, i, SWING_SIZE))
            swings.push({ type: "L", index: i, price: candles[i].low });
    }
    return swings;
}

// ----------- Main -----------
(async function main() {
    try {
        const candles = await loadDataFromCSV(DATA_PATH);
        const swings = detectSwings(candles);
        const events = detectBOSFromSwings(swings, candles);

        console.log(`📊 BOS/CHoCH Detection Results`);
        console.log(`Generated: ${new Date().toLocaleString()}`);
        console.log(`Source: ${DATA_PATH}`);
        console.log(`Detected Events: ${events.length}\n`);

        for (const e of events) {
            console.log(
                `${e.timestamp} | ${e.type.padEnd(11)} | ${e.startPrice.toFixed(
                    2
                )} → ${e.endPrice.toFixed(2)} (${e.legPts.toFixed(2)} pts)`
            );
        }
    } catch (err) {
        console.error("Error:", err);
    }
})();
