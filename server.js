// server.js
const express = require('express');
const bodyParser = require('body-parser');
const cors = require('cors');
const WebSocket = require('ws');
const { v4: uuidv4 } = require('uuid');

const app = express();
app.use(cors());
app.use(bodyParser.json());

// Map clientId -> { token, wsToDeriv, subs: Set }
const clients = new Map();

// Deriv WS endpoint (v3). Optionnel: remplacer app_id si tu as un app_id.
const DERIV_WS = 'wss://ws.binaryws.com/websockets/v3?app_id=1089&l=EN';

// Create a Deriv WS for a token and store it
function createDerivConnection(clientId, token) {
  const ws = new WebSocket(DERIV_WS);

  ws.on('open', () => {
    // authorize
    ws.send(JSON.stringify({ authorize: token }));
  });

  ws.on('message', (msg) => {
    try {
      const data = JSON.parse(msg);
      // forward all messages to any SSE subscribers for this client
      const client = clients.get(clientId);
      if (client && client.sseResponses) {
        const arr = Array.from(client.sseResponses);
        arr.forEach(res => {
          res.write(`data: ${JSON.stringify(data)}\n\n`);
        });
      }
    } catch (e) {
      console.error('Parse message error', e);
    }
  });

  ws.on('close', () => {
    const client = clients.get(clientId);
    if (client) client.wsToDeriv = null;
  });

  ws.on('error', (err) => {
    console.error('Deriv WS error:', err.message || err);
  });

  return ws;
}

// 1) Create connection (POST token) -> returns clientId
app.post('/connect', (req, res) => {
  const { token } = req.body;
  if (!token) return res.status(400).json({ error: 'token required' });

  const clientId = uuidv4();
  const wsToDeriv = createDerivConnection(clientId, token);
  clients.set(clientId, { token, wsToDeriv, sseResponses: new Set(), subs: new Set() });

  res.json({ clientId });
});

// 2) SSE endpoint for pushing Deriv messages for clientId
app.get('/events/:clientId', (req, res) => {
  const clientId = req.params.clientId;
  const client = clients.get(clientId);
  if (!client) return res.status(404).end('client not found');

  // setup SSE
  res.set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive'
  });
  res.flushHeaders();

  // keep connection alive
  res.write('retry: 2000\n\n');

  client.sseResponses.add(res);

  req.on('close', () => {
    client.sseResponses.delete(res);
  });
});

// 3) subscribe ticks: POST /subscribe { clientId, symbol }
// This will send a 'ticks' request to Deriv WS
app.post('/subscribe', (req, res) => {
  const { clientId, symbol } = req.body;
  if (!clientId || !symbol) return res.status(400).json({ error: 'clientId and symbol required' });

  const client = clients.get(clientId);
  if (!client) return res.status(404).json({ error: 'client not found' });

  const id = `ticks_${symbol}_${Date.now()}`;
  client.subs.add(id);
  const payload = { ticks: symbol, subscribe: 1 };
  client.wsToDeriv.send(JSON.stringify(payload));
  res.json({ ok: true, id });
});

// 4) unsubscribe: POST /unsubscribe { clientId, symbol }
app.post('/unsubscribe', (req, res) => {
  const { clientId, symbol } = req.body;
  const client = clients.get(clientId);
  if (!client) return res.status(404).json({ error: 'client not found' });

  client.wsToDeriv.send(JSON.stringify({ forget: `ticks:${symbol}` }));
  res.json({ ok: true });
});

// 5) place trade: POST /buy { clientId, contract_type, amount, symbol, duration, duration_unit, basis }
// Example contract_type: "CALL" or "PUT" for binary options (or adapt to Deriv's contract schema)
app.post('/buy', async (req, res) => {
  const body = req.body;
  const { clientId } = body;
  if (!clientId) return res.status(400).json({ error: 'clientId required' });

  const client = clients.get(clientId);
  if (!client) return res.status(404).json({ error: 'client not found' });

  // Build purchase/trade request — adapt fields as needed for Deriv contract
  // This example uses "buy" approach for contract proposal (very simplified).
  // In production you typically request a contract proposal then buy using 'buy'.
  const buyRequest = {
    buy: 1,
    price: body.amount || 1,
    parameters: {
      contract_type: body.contract_type || 'CALL',
      symbol: body.symbol || 'R_100',
      duration: body.duration || 5,
      duration_unit: body.duration_unit || 's',
      basis: body.basis || 'payout'
    }
  };

  try {
    client.wsToDeriv.send(JSON.stringify(buyRequest));
    // We will return OK — actual results come back through SSE stream
    res.json({ ok: true, note: 'buy request sent; watch SSE for result' });
  } catch (err) {
    console.error('Buy send error', err);
    res.status(500).json({ error: 'failed to send buy' });
  }
});

// 6) disconnect and cleanup
app.post('/disconnect', (req, res) => {
  const { clientId } = req.body;
  const client = clients.get(clientId);
  if (client) {
    try { client.wsToDeriv.terminate(); } catch(e){}
    // close SSE responses
    if (client.sseResponses) client.sseResponses.forEach(r => r.end());
    clients.delete(clientId);
  }
  res.json({ ok: true });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('Deriv proxy listening on', PORT));
