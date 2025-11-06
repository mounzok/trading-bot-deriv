<!-- Ajouter ce bloc sur ton site (head ou body) -->
<script>
/*
Simple frontend pour :
- demander token (démo ou réel)
- se connecter au backend (POST /connect)
- ouvrir EventSource sur /events/:clientId
- s'abonner à un symbol et recevoir ticks
- calculer RSI simple et déclencher buy via /buy
*/

const BACKEND = 'https://mounzok.github.io/trading-bot-deriv/'; // <-- remplacer par l'URL du serveur (ex: https://deriv-proxy.onrender.com)

let clientId = null;
let mode = 'demo'; // 'demo' or 'real'
let symbol = 'R_100';
let ticksBuffer = [];

// Utils indicateur RSI simple (closing prices)
function computeRSI(closes, period = 14) {
  if (closes.length < period + 1) return null;
  let gains = 0, losses = 0;
  for (let i = closes.length - period; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1];
    if (diff >= 0) gains += diff;
    else losses += Math.abs(diff);
  }
  const avgGain = gains / period;
  const avgLoss = losses / period;
  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - (100 / (1 + rs));
}

async function connect(token) {
  const res = await fetch(`${BACKEND}/connect`, {
    method: 'POST',
    headers: {'Content-Type': 'application/json'},
    body: JSON.stringify({ token })
  });
  const data = await res.json();
  if (data.clientId) {
    clientId = data.clientId;
    initEventSource();
    return true;
  } else {
    console.error('connect error', data);
    return false;
  }
}

function initEventSource() {
  const es = new EventSource(`${BACKEND}/events/${clientId}`);
  es.onmessage = (e) => {
    const payload = JSON.parse(e.data);
    // handle ticks
    if (payload.ticks) {
      const tick = payload.ticks;
      const price = parseFloat(tick.quote);
      ticksBuffer.push(price);
      if (ticksBuffer.length > 200) ticksBuffer.shift();

      // compute RSI every tick
      const rsi = computeRSI(ticksBuffer, 14);
      console.log('tick', tick, 'RSI', rsi);

      // display simple UI update (if exist)
      const el = document.getElementById('deriv-tick');
      if (el) el.textContent = `Symbol ${tick.symbol} - quote ${tick.quote} - RSI ${rsi ? rsi.toFixed(2) : 'n/a'}`;

      // Example automatic rule: buy CALL if RSI < 30, buy PUT if RSI > 70
      if (rsi !== null) {
        if (rsi < 30) {
          tryAutoBuy('CALL', 1);
        } else if (rsi > 70) {
          tryAutoBuy('PUT', 1);
        }
      }
    }

    // other messages (authorize, buy_result...)
    if (payload.error) console.warn('Deriv error', payload.error);
  };
}

let lastBuy = 0;
async function tryAutoBuy(contract_type, amount) {
  // rate-limit buys (avoid spamming)
  const now = Date.now();
  if (now - lastBuy < 5000) return;
  lastBuy = now;

  // POST /buy
  await fetch(`${BACKEND}/buy`, {
    method: 'POST',
    headers: {'Content-Type': 'application/json'},
    body: JSON.stringify({
      clientId,
      contract_type,
      amount,
      symbol,
      duration: 5,
      duration_unit: 's',
      basis: 'payout'
    })
  });
  console.log('Auto buy requested', contract_type);
}

// UI helpers
function createSimpleUI() {
  const div = document.createElement('div');
  div.innerHTML = `
    <div id="deriv-ui" style="position:fixed;right:10px;bottom:10px;
      background:rgba(255,255,255,0.95);padding:10px;border:1px solid #ccc;
      font-family:Arial;font-size:13px;z-index:9999;">
      <div>
        <select id="mode-select">
          <option value="demo">Démo</option>
          <option value="real">Réel</option>
        </select>
      </div>
      <div style="margin-top:6px;">
        Token: <input id="token-input" style="width:220px"/>
        <button id="btn-connect">Connect</button>
      </div>
      <div style="margin-top:6px;">
        Symbole: <input id="symbol-input" value="R_100" style="width:120px"/>
        <button id="btn-sub">Subscribe</button>
      </div>
      <div id="deriv-tick" style="margin-top:8px;">no data</div>
    </div>
  `;
  document.body.appendChild(div);

  document.getElementById('btn-connect').onclick = async () => {
    const token = document.getElementById('token-input').value.trim();
    if (!token) return alert('token required');
    const ok = await connect(token);
    if (ok) alert('connected, watch logs and UI');
  };

  document.getElementById('btn-sub').onclick = async () => {
    symbol = document.getElementById('symbol-input').value.trim();
    await fetch(`${BACKEND}/subscribe`, {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({ clientId, symbol })
    });
  };
}

createSimpleUI();
</script>
