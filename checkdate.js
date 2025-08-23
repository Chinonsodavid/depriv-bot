// fix_csv_dates.js
import fs from "fs";
import path from "path";

// ===== CONFIG =====
const CSV_FOLDER = "./data"; // folder where your CSVs are
const FILES = ["R_75_5m.csv", "R_75_15m.csv", "R_75_1h.csv", "R_75_2h.csv"];
const TARGET_YEAR = 2024; // shift candles to 2024

// ===== HELPER =====
function shiftEpochToYear(epoch, targetYear) {
    const d = new Date(epoch * 1000);
    const yearDiff = targetYear - d.getUTCFullYear();
    d.setUTCFullYear(targetYear);
    return Math.floor(d.getTime() / 1000);
}

FILES.forEach(file => {
    const filePath = path.join(CSV_FOLDER, file);
    if (!fs.existsSync(filePath)) {
        console.log(`❌ File not found: ${filePath}`);
        return;
    }

    const lines = fs.readFileSync(filePath, "utf8").trim().split("\n");
    const header = lines.shift(); // save header

    const candles = lines.map(line => {
        const [epoch, open, high, low, close] = line.split(",").map(Number);
        return {
            epoch: shiftEpochToYear(epoch, TARGET_YEAR),
            open,
            high,
            low,
            close,
        };
    });

    // sort ascending by epoch
    candles.sort((a, b) => a.epoch - b.epoch);

    // rebuild CSV
    const newCSV = [
        header,
        ...candles.map(c => `${c.epoch},${c.open},${c.high},${c.low},${c.close}`)
    ].join("\n");

    fs.writeFileSync(filePath, newCSV);
    console.log(`✅ Sorted & shifted: ${filePath} | Total candles: ${candles.length}`);
});

console.log("\nAll CSVs are fixed and ready for backtesting!");
