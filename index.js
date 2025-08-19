// index.js
require('dotenv').config();
const WebSocket = require('ws');

console.log("🔎 ENV check → APP_ID:", process.env.DERIV_APP_ID);
console.log("🔎 ENV check → API_TOKEN:", process.env.DERIV_API_TOKEN ? "✅ Present" : "❌ Missing");


const APP_ID = process.env.DERIV_APP_ID;
const API_TOKEN = process.env.DERIV_API_TOKEN;

// Prefer the Deriv host; if your network blocks it, you can try ws.binaryws.com
const WS_URL = `wss://ws.derivws.com/websockets/v3?app_id=${APP_ID}`;

const ws = new WebSocket(WS_URL);

ws.on('open', () => {
    console.log('✅ WebSocket connected');
    // Authorize
    ws.send(JSON.stringify({ authorize: API_TOKEN }));
});

ws.on('message', (msg) => {
    const data = JSON.parse(msg.toString());

    if (data.error) {
        console.error('❌ Error:', data.error);
        return;
    }

    if (data.msg_type === 'authorize') {
        const { loginid, balance, currency } = data.authorize;
        console.log(`🔐 Authorized as ${loginid} | Balance: ${balance} ${currency}`);

        // As a sanity check, request basic account info
        ws.send(JSON.stringify({ get_account_status: 1 }));
    }

    if (data.msg_type === 'get_account_status') {
        console.log('ℹ️ Account status OK. Connection + auth complete.');
        console.log('You’re ready for Step 2 (subscribe to V75 ticks).');
        // We won’t keep the socket open in Step 1; close after confirming auth.
        ws.close(1000);
    }
});

ws.on('close', (code) => {
    console.log(`🔌 WebSocket closed (${code})`);
});

ws.on('error', (err) => {
    console.error('🚨 WS error:', err.message);
});
