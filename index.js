// index.js
require('dotenv').config({ override: true });
const WebSocket = require('ws');
const { BollingerBands, EMA } = require('technicalindicators');

// ===== ENV & CONFIG =====
const APP_ID = process.env.DERIV_APP_ID;
const API_TOKEN = process.env.DERIV_API_TOKEN;
const SYMBOL = process.env.SYMBOL || 'R_75';

const RISK_PCT = parseFloat(process.env.RISK_PCT || '1.0') / 100; // e.g., 1.0 -> 0.01
const MAX_TRADES_PER_SESSION = parseInt(process.env.MAX_TRADES_PER_SESSION || '2', 10);
const LOSS_PAUSE_AFTER = parseInt(process.env.LOSS_PAUSE_AFTER || '2', 10);
const TRADE_DURATION_MIN = parseInt(process.env.TRADE_DURATION_MIN || '5', 10);
const HTF_EMA = parseInt(process.env.HTF_EMA || '50', 10); // e.g., 50 or 200
const BB_PERIOD = parseInt(process.env.BB_PERIOD || '20', 10);
const BB_STDDEV = 2;

if (!APP_ID) {
    console.error('❌ Missing DERIV_APP_ID in .env');
    process.exit(1);
}
if (!API_TOKEN || API_TOKEN.length < 10) {
    console.error('❌ DERIV_API_TOKEN looks invalid. Add a valid long token with Read/Trade permissions.');
    process.exit(1);
}

// ===== WEBSOCKET =====
const WS_URL = `wss://ws.derivws.com/websockets/v3?app_id=${APP_ID}`;
const ws = new WebSocket(WS_URL);

// ===== TIMEFRAMES =====
const TF = { '2H': 7200, '1H': 3600, '15M': 900, '5M': 300 };

// ===== BUFFERS =====
const candles = { '2H': [], '1H': [], '15M': [], '5M': [] };
const subRefToTF = new Map();
const loadedTFs = new Set();

// ===== SESSION / RISK STATE =====
let accountBalance = 10000;
let tradesThisSession = 0;
let consecutiveLosses = 0;
let pausedForSession = false;
let position = null; // current position

// ===== HEARTBEAT =====
let lastHeartbeat = 0;
const HEARTBEAT_INTERVAL = 5000; // 5s

// ===== UTILS =====
const nowStr = (epochSec) =>
    new Date((epochSec ?? Math.floor(Date.now() / 1000)) * 1000).toLocaleTimeString();
const fmt = (n, d = 4) => (typeof n === 'number' ? n.toFixed(d) : String(n));

function isBullishEngulf(curr, prev) {
    if (!curr || !prev) return false;
    const currBull = curr.close > curr.open;
    const prevBear = prev.close < prev.open;
    const bodyEngulf = curr.close >= prev.open && curr.open <= prev.close;
    return currBull && prevBear && bodyEngulf;
}

function isBearishEngulf(curr, prev) {
    if (!curr || !prev) return false;
    const currBear = curr.close < curr.open;
    const prevBull = prev.close > prev.open;
    const bodyEngulf = curr.open >= prev.close && curr.close <= prev.open;
    return currBear && prevBull && bodyEngulf;
}

function computeBB(closes, period = BB_PERIOD, stdDev = BB_STDDEV) {
    if (!closes || closes.length < period) return null;
    const out = BollingerBands.calculate({ values: closes, period, stdDev });
    return out.length ? out[out.length - 1] : null;
}

function computeEMA(closes, period) {
    if (!closes || closes.length < period) return null;
    const arr = EMA.calculate({ values: closes, period });
    return arr.length ? arr[arr.length - 1] : null;
}

// ===== HTF MODE DETECTION =====
function detectHTFSignal(tfName) {
    const buf = candles[tfName];
    if (!buf || buf.length < Math.max(BB_PERIOD, HTF_EMA) + 2) return null;
    const prev = buf[buf.length - 2];
    const curr = buf[buf.length - 1];
    const closes = buf.map(c => c.close);

    const bb = computeBB(closes, BB_PERIOD, BB_STDDEV);
    const ema = computeEMA(closes, HTF_EMA);
    if (!bb || !ema) return null;

    const overbought = curr.close >= bb.upper;
    const oversold = curr.close <= bb.lower;
    const bullEng = isBullishEngulf(curr, prev);
    const bearEng = isBearishEngulf(curr, prev);

    // Mean Reversion
    if (overbought && bearEng) return { tfName, mode: 'MR', bias: 'SHORT', bb, ema, htfCandle: curr };
    if (oversold && bullEng) return { tfName, mode: 'MR', bias: 'LONG', bb, ema, htfCandle: curr };

    // Continuation
    if (bullEng && curr.close > ema) return { tfName, mode: 'CONT', bias: 'LONG', bb, ema, htfCandle: curr };
    if (bearEng && curr.close < ema) return { tfName, mode: 'CONT', bias: 'SHORT', bb, ema, htfCandle: curr };

    return null;
}

// ===== ETF ALIGNMENT =====
function etfAlignedEngulf() {
    const tf15 = candles['15M'];
    const tf5 = candles['5M'];
    if (!tf15 || !tf5 || tf15.length < 2 || tf5.length < 2) return null;

    const [p15, c15] = [tf15[tf15.length - 2], tf15[tf15.length - 1]];
    const [p5, c5] = [tf5[tf5.length - 2], tf5[tf5.length - 1]];

    if (isBullishEngulf(c15, p15) && isBullishEngulf(c5, p5)) return 'LONG';
    if (isBearishEngulf(c15, p15) && isBearishEngulf(c5, p5)) return 'SHORT';
    return null;
}

// ===== EXECUTION =====
function tryEnterTrade(htfSig, etfBias) {
    if (!htfSig || !etfBias || pausedForSession || position || tradesThisSession >= MAX_TRADES_PER_SESSION) return;
    if (htfSig.bias !== etfBias) return;

    const last5 = candles['5M'][candles['5M'].length - 1];
    if (!last5) return;

    const entry = last5.close;
    const entryTime = nowStr(last5.epoch);
    const H = htfSig.htfCandle.high;
    const L = htfSig.htfCandle.low;

    let stop, target, module;
    if (htfSig.mode === 'MR') {
        module = 'MR';
        if (etfBias === 'LONG') {
            stop = Math.min(L, entry) - Math.abs(entry) * 0.0001;
            target = htfSig.bb.middle ?? (entry + (entry - stop));
        } else {
            stop = Math.max(H, entry) + Math.abs(entry) * 0.0001;
            target = htfSig.bb.middle ?? (entry - (stop - entry));
        }
    } else {
        module = 'CONT';
        if (etfBias === 'LONG') {
            stop = Math.min(L, entry) - Math.abs(entry) * 0.0001;
            target = entry + 2 * (entry - stop);
        } else {
            stop = Math.max(H, entry) + Math.abs(entry) * 0.0001;
            target = entry - 2 * (stop - entry);
        }
    }

    const riskPerTrade = accountBalance * RISK_PCT;
    const riskPerUnit = etfBias === 'LONG' ? (entry - stop) : (stop - entry);
    const qty = riskPerUnit > 0 ? riskPerTrade / riskPerUnit : 0;
    if (!isFinite(qty) || qty <= 0) return;

    position = { side: etfBias, entry, time: entryTime, stop, target, qty, module, htfRef: { tf: htfSig.tfName, epoch: htfSig.htfCandle.epoch } };
    tradesThisSession += 1;

    console.log(`✅ ENTER ${position.side} | Module: ${module} | Entry: ${fmt(entry)} | Stop: ${fmt(stop)} | Target: ${fmt(target)} | Qty: ${qty.toFixed(2)} | Time: ${entryTime}`);
}

// ===== MANAGEMENT & EXIT =====
function managePositionOn5mClose() {
    if (!position) return;
    const last5 = candles['5M'][candles['5M'].length - 1];
    if (!last5) return;
    const px = last5.close;
    const t = nowStr(last5.epoch);

    let exit = null;
    if (position.side === 'LONG') {
        if (px <= position.stop) exit = { price: position.stop, reason: 'STOP' };
        else if (px >= position.target) exit = { price: position.target, reason: 'TARGET' };
    } else {
        if (px >= position.stop) exit = { price: position.stop, reason: 'STOP' };
        else if (px <= position.target) exit = { price: position.target, reason: 'TARGET' };
    }

    if (exit) {
        const pnlPerUnit = position.side === 'LONG' ? exit.price - position.entry : position.entry - exit.price;
        const tradePnL = pnlPerUnit * position.qty;
        accountBalance += tradePnL;
        consecutiveLosses = tradePnL > 0 ? 0 : consecutiveLosses + 1;
        if (consecutiveLosses >= LOSS_PAUSE_AFTER) pausedForSession = true;

        console.log(`🏁 EXIT ${position.side} | Reason: ${exit.reason} | Entry: ${fmt(position.entry)} @ ${position.time} | Exit: ${fmt(exit.price)} @ ${t} | PnL: ${tradePnL.toFixed(2)} | Balance: ${accountBalance.toFixed(2)}`);
        if (pausedForSession) console.log(`⏸️  Paused for session (${LOSS_PAUSE_AFTER} consecutive losses).`);
        position = null;
    }
}

// ===== EVALUATION WITH HEARTBEAT =====
function readyToEvaluate() {
    const minHTF = Math.max(BB_PERIOD, HTF_EMA) + 2;
    const have2H = candles['2H'].length >= minHTF;
    const have1H = candles['1H'].length >= minHTF;
    const have15 = candles['15M'].length >= 2;
    const have5 = candles['5M'].length >= 2;
    return (have2H || have1H) && have15 && have5;
}

function evaluateSignalsWithHeartbeat() {
    if (!readyToEvaluate()) return;

    const now = Date.now();
    if (now - lastHeartbeat > HEARTBEAT_INTERVAL) {
        process.stdout.write('⏳ Checking for signal...\r');
        lastHeartbeat = now;
    }

    const htfName = candles['2H'].length >= Math.max(BB_PERIOD, HTF_EMA) + 2 ? '2H' : '1H';
    const htfSig = detectHTFSignal(htfName);
    const etfBias = etfAlignedEngulf();

    if (htfSig && etfBias && htfSig.bias === etfBias) {
        console.log(' '.repeat(50)); // clear heartbeat
        console.log(`📢 Signal Found! HTF: ${htfName} | Module: ${htfSig.mode} | Bias: ${htfSig.bias} | ETF Alignment: ${etfBias}`);
        tryEnterTrade(htfSig, etfBias);
    }
}

// ===== WEBSOCKET HANDLERS =====
ws.on('open', () => {
    console.log('✅ WebSocket connected');
    ws.send(JSON.stringify({ authorize: API_TOKEN }));
});

ws.on('unexpected-response', (_req, res) => {
    console.error(`🚫 Unexpected response: ${res.statusCode}`);
});

ws.on('message', (msg) => {
    try {
        const data = JSON.parse(msg.toString());
        if (data.error) return console.error('❌ Error:', data.error);

        if (data.msg_type === 'authorize') {
            const { loginid, balance, currency } = data.authorize;
            console.log(`🔐 Authorized as ${loginid} | Balance: ${balance} ${currency}`);
            subscribeAllTimeframes();
            return;
        }

        if (data.msg_type === 'candles' && data.candles?.length) {
            const gran = data.echo_req?.granularity;
            const tfName = Object.keys(TF).find(k => TF[k] === gran);
            if (!tfName) return;
            candles[tfName] = data.candles.map(c => ({ epoch: c.epoch, open: +c.open, high: +c.high, low: +c.low, close: +c.close }));
            if (data.subscription?.id) subRefToTF.set(data.subscription.id, tfName);
            loadedTFs.add(tfName);
            console.log(`📦 Loaded ${candles[tfName].length} candles for ${tfName} (${gran}s)`);
            evaluateSignalsWithHeartbeat();
            return;
        }

        if (data.msg_type === 'ohlc') {
            const subId = data.subscription?.id;
            const tfName = subRefToTF.get(subId);
            if (!tfName) return;
            const o = data.ohlc;
            const buf = candles[tfName];
            const last = buf[buf.length - 1];
            const newC = { epoch: o.open_time, open: +o.open, high: +o.high, low: +o.low, close: +o.close };

            if (last && last.epoch === newC.epoch) buf[buf.length - 1] = newC;
            else {
                buf.push(newC);
                if (buf.length > 1000) buf.shift();
                if (tfName === '5M') managePositionOn5mClose();
            }

            evaluateSignalsWithHeartbeat();
            return;
        }

        if (data.msg_type === 'buy') console.log('✅ Buy response:', data);

    } catch (e) {
        console.error('🚨 Failed to parse message:', e);
    }
});

ws.on('close', (code) => console.log(`🔌 WebSocket closed (${code})`));
ws.on('error', (err) => console.error('🚨 WS error:', err.message));

// ===== SUBSCRIPTIONS =====
function subscribeAllTimeframes() {
    const needed = Math.max(120, HTF_EMA + 10);
    Object.entries(TF).forEach(([name, gran]) => {
        const req = { ticks_history: SYMBOL, style: 'candles', count: needed, granularity: gran, end: 'latest', subscribe: 1 };
        ws.send(JSON.stringify(req));
        console.log(`🛰️  Subscribed ${name} (${gran}s) for ${SYMBOL} (count=${needed})`);
    });
}
