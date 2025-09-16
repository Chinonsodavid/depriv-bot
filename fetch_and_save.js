import WebSocket from "ws";
import fs from "fs";

// =================== CONFIG ===================
const API_URL = "wss://ws.derivws.com/websockets/v3?app_id=1089";
const SYMBOL = "R_75";
const START_EPOCH = Math.floor(new Date("2025-01-01T00:00:00Z").getTime() / 1000);
const END_EPOCH = Math.floor(new Date("2025-09-01T00:00:00Z").getTime() / 1000);
const CHUNK_DAYS = 30; // fetch data in 30-day blocks

// Timeframes (granularity in seconds)
const TIMEFRAMES = [
    { label: "5m", seconds: 300 },
    { label: "15m", seconds: 900 },
    { label: "1h", seconds: 3600 },
    { label: "2h", seconds: 7200 },
    { label: "4h", seconds: 14400 }
];

// Create CSV headers
for (const tf of TIMEFRAMES) {
    const file = `./data/R_75_${tf.label}.csv`;
    fs.writeFileSync(file, "epoch,open,high,low,close\n");
}
// ==============================================

const ws = new WebSocket(API_URL);
let currentTFIndex = 0;

ws.on("open", () => {
    console.log("✅ Connected to Deriv API");
    fetchNextChunk(TIMEFRAMES[currentTFIndex], START_EPOCH, 1);
});

function fetchNextChunk(tf, currentStart, chunkCount) {
    if (currentStart >= END_EPOCH) {
        console.log(`🎯 Finished ${tf.label} data.`);

        // Move to next timeframe
        currentTFIndex++;
        if (currentTFIndex < TIMEFRAMES.length) {
            const nextTF = TIMEFRAMES[currentTFIndex];
            console.log(`\n🔄 Starting ${nextTF.label} candles...\n`);
            fetchNextChunk(nextTF, START_EPOCH, 1);
        } else {
            console.log("🏁 All timeframes downloaded.");
            ws.close();
        }
        return;
    }

    const currentEnd = Math.min(
        currentStart + CHUNK_DAYS * 24 * 60 * 60,
        END_EPOCH
    );

    console.log(
        `📅 [${tf.label}] Chunk ${chunkCount}: ${formatDate(currentStart)} → ${formatDate(currentEnd)}`
    );

    const request = {
        ticks_history: SYMBOL,
        start: currentStart,
        end: currentEnd,
        granularity: tf.seconds,
        style: "candles",
    };

    ws.send(JSON.stringify(request));

    ws.once("message", (message) => {
        const data = JSON.parse(message);

        if (data.error) {
            console.error("❌ API Error:", data.error.message);
            setTimeout(() => fetchNextChunk(tf, currentStart, chunkCount), 2000);
            return;
        }

        const candles = data.candles || [];
        if (!candles.length) {
            console.warn("⚠️ No candles returned. Retrying...");
            setTimeout(() => fetchNextChunk(tf, currentStart, chunkCount), 2000);
            return;
        }

        const csvData =
            candles.map(
                (c) => `${c.epoch},${c.open},${c.high},${c.low},${c.close}`
            ).join("\n") + "\n";

        const file = `./data/R_75_${tf.label}.csv`;
        fs.appendFileSync(file, csvData);

        console.log(`✅ Saved ${candles.length} candles for ${tf.label}`);

        setTimeout(
            () => fetchNextChunk(tf, currentEnd + tf.seconds, chunkCount + 1),
            1000
        );
    });
}

function formatDate(epoch) {
    return new Date(epoch * 1000).toISOString().split("T")[0];
}
