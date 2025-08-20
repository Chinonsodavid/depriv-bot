require('dotenv').config();
const WebSocket = require('ws');
const { RSI, BollingerBands, EMA } = require('technicalindicators');

const APP_ID = process.env.DERIV_APP_ID;
const API_TOKEN = process.env.DERIV_API_TOKEN;

const WS_URL = `wss://ws.derivws.com/websockets/v3?app_id=${APP_ID}`;
const ws = new WebSocket(WS_URL);

// Store price history
let priceHistory = [];

// Track current trade
let currentPosition = null; // { type: 'BUY' | 'SELL', entryPrice: number, entryTime: string }

ws.on('open', () => {
    console.log('✅ WebSocket connected');
    ws.send(JSON.stringify({ authorize: API_TOKEN }));
});

ws.on('message', (msg) => {
    const data = JSON.parse(msg.toString());

    if (data.error) {
        console.error('❌ Error:', data.error);
        return;
    }

    if (data.msg_type === 'authorize') {
        console.log(`🔐 Authorized as ${data.authorize.loginid} | Balance: ${data.authorize.balance} ${data.authorize.currency}`);
        ws.send(JSON.stringify({ ticks: "R_75", subscribe: 1 }));
    }

    if (data.msg_type === 'tick') {
        const price = data.tick.quote;
        const time = new Date(data.tick.epoch * 1000).toLocaleTimeString(); // Format time
        priceHistory.push(price);

        if (priceHistory.length > 500) priceHistory.shift();

        console.log(`📈 ${data.tick.symbol} | Price: ${price} | Time: ${time} | Count: ${priceHistory.length}`);

        if (priceHistory.length > 50) {
            calculateIndicators(priceHistory, price, time);
        }
    }
});

function calculateIndicators(prices, latestPrice, time) {
    const rsi = RSI.calculate({ values: prices, period: 14 }).slice(-1)[0];
    const bb = BollingerBands.calculate({ period: 20, values: prices, stdDev: 2 }).slice(-1)[0];
    const ema20 = EMA.calculate({ period: 20, values: prices }).slice(-1)[0];
    const ema50 = EMA.calculate({ period: 50, values: prices }).slice(-1)[0];

    console.log(
        `🔎 Indicators → RSI: ${rsi?.toFixed(2)} | BB Low: ${bb?.lower?.toFixed(2)} High: ${bb?.upper?.toFixed(2)} | EMA20: ${ema20?.toFixed(2)} | EMA50: ${ema50?.toFixed(2)}`
    );

    let signal = "⚪ HOLD";

    if (rsi && bb && ema20 && ema50) {
        if (rsi < 30 && latestPrice <= bb.lower && ema20 > ema50) {
            signal = "🔵 BUY";
        } else if (rsi > 70 && latestPrice >= bb.upper && ema20 < ema50) {
            signal = "🔴 SELL";
        }
    }

    handleTrade(signal, latestPrice, time);
}

function handleTrade(signal, price, time) {
    if (signal.includes("BUY")) {
        if (!currentPosition) {
            currentPosition = { type: "BUY", entryPrice: price, entryTime: time };
            console.log(`✅ ENTERED BUY at ${price} | Time: ${time}`);
        }
    } else if (signal.includes("SELL")) {
        if (!currentPosition) {
            currentPosition = { type: "SELL", entryPrice: price, entryTime: time };
            console.log(`✅ ENTERED SELL at ${price} | Time: ${time}`);
        }
    } else {
        // Example exit logic: Close position if profit condition met
        if (currentPosition) {
            const diff = price - currentPosition.entryPrice;
            const profit = currentPosition.type === "BUY" ? diff : -diff;

            if (Math.abs(profit) > 1) { // Example: close after 1 point move
                console.log(`✅ CLOSED ${currentPosition.type} | Entry: ${currentPosition.entryPrice} | Exit: ${price} | Profit: ${profit.toFixed(2)} | Time: ${time}`);
                currentPosition = null;
            }
        }
    }

    console.log(`🎯 Signal → ${signal}`);
}

ws.on('close', (code) => console.log(`🔌 WebSocket closed (${code})`));
ws.on('error', (err) => console.error('🚨 WS error:', err.message));
