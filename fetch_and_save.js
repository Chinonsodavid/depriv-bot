import WebSocket from "ws";
import fs from "fs";

const API_URL = "wss://ws.derivws.com/websockets/v3?app_id=1089";
const SYMBOL = "R_75";
const TIMEFRAME = { label: "5m", seconds: 300 }; // Only 5M
const START_EPOCH = 1704067200; // Jan 1, 2024
const END_EPOCH = 1735689599;   // Dec 31, 2024
const CHUNK_DAYS = 30;           // Fetch 30-day chunks

const OUTPUT_FILE = `./data/R_75_${TIMEFRAME.label}.csv`;
fs.writeFileSync(OUTPUT_FILE, "epoch,open,high,low,close\n");

const ws = new WebSocket(API_URL);

ws.on("open", () => {
    console.log("✅ Connected to Deriv API");
    fetchNextChunk(START_EPOCH, 1);
});

function fetchNextChunk(currentStart, chunkCount) {
    if (currentStart >= END_EPOCH) {
        console.log(`🎯 Finished ${TIMEFRAME.label} data.`);
        ws.close();
        return;
    }

    const currentEnd = Math.min(currentStart + CHUNK_DAYS * 24 * 60 * 60, END_EPOCH);
    console.log(`📅 [${TIMEFRAME.label}] Chunk ${chunkCount}: ${formatDate(currentStart)} → ${formatDate(currentEnd)}`);

    const request = {
        ticks_history: SYMBOL,
        start: currentStart,
        end: currentEnd,
        granularity: TIMEFRAME.seconds,
        style: "candles"
    };

    ws.send(JSON.stringify(request));

    ws.once("message", (message) => {
        const data = JSON.parse(message);

        if (data.error) {
            console.error("❌ API Error:", data.error.message);
            setTimeout(() => fetchNextChunk(currentStart, chunkCount), 2000);
            return;
        }

        const candles = data.candles || [];
        if (!candles.length) {
            console.warn("⚠️ No candles returned. Retrying...");
            setTimeout(() => fetchNextChunk(currentStart, chunkCount), 2000);
            return;
        }

        const csvData = candles.map(c => `${c.epoch},${c.open},${c.high},${c.low},${c.close}`).join("\n") + "\n";
        fs.appendFileSync(OUTPUT_FILE, csvData);

        console.log(`✅ Saved ${candles.length} candles for ${TIMEFRAME.label}`);
        setTimeout(() => fetchNextChunk(currentEnd + TIMEFRAME.seconds, chunkCount + 1), 1000);
    });
}

function formatDate(epoch) {
    return new Date(epoch * 1000).toISOString().split("T")[0];
}
