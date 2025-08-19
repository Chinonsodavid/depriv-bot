// index.js
require('dotenv').config();
const WebSocket = require('ws');
const { RSI, BollingerBands, EMA } = require('technicalindicators');

const APP_ID = process.env.DERIV_APP_ID;
const API_TOKEN = process.env.DERIV_API_TOKEN;

const WS_URL = `wss://ws.derivws.com/websockets/v3?app_id=${APP_ID}`;
const ws = new WebSocket(WS_URL);

// Store price history
let priceHistory = [];

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

        // Subscribe to V75 ticks
        ws.send(JSON.stringify({ ticks: "R_75", subscribe: 1 }));
    }

    if (data.msg_type === 'tick') {
        const price = data.tick.quote;
        priceHistory.push(price);

        // Keep only the latest 500 prices
        if (priceHistory.length > 500) priceHistory.shift();

        console.log(`📈 ${data.tick.symbol} | Price: ${price} | Count: ${priceHistory.length}`);

        // Once we have enough data, calculate indicators
        if (priceHistory.length > 50) {
            calculateIndicators(priceHistory);
        }
    }
});

function calculateIndicators(prices) {
    const rsi = RSI.calculate({ values: prices, period: 14 }).slice(-1)[0];
    const bb = BollingerBands.calculate({ period: 20, values: prices, stdDev: 2 }).slice(-1)[0];
    const ema20 = EMA.calculate({ period: 20, values: prices }).slice(-1)[0];
    const ema50 = EMA.calculate({ period: 50, values: prices }).slice(-1)[0];

    console.log(`🔎 Indicators → RSI: ${rsi?.toFixed(2)} | BB Low: ${bb?.lower?.toFixed(2)} High: ${bb?.upper?.toFixed(2)} | EMA20: ${ema20?.toFixed(2)} | EMA50: ${ema50?.toFixed(2)}`);
}

ws.on('close', (code) => console.log(`🔌 WebSocket closed (${code})`));
ws.on('error', (err) => console.error('🚨 WS error:', err.message));
