// A stand-in for the Notch Pay API, used by the tests and for local demos without real keys.
// It mimics POST /payments/initialize and GET /payments/:reference, and serves a fake
// hosted checkout page with "Pay" / "Cancel" buttons. It never touches real money.
//
// Run it on its own:  node dev/fake-notchpay.js 4100
// then start School Unity with NOTCHPAY_PUBLIC_KEY=pk_test_fake NOTCHPAY_API_BASE=http://localhost:4100
const http = require('http');

function createFakeNotchPay({ key = 'pk_test_fake' } = {}) {
  const payments = new Map(); // trx reference -> transaction
  let seq = 0;
  let failNext = null;
  const find = (ref) => payments.get(ref) || [...payments.values()].find((t) => t.merchant_reference === ref);

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    const send = (code, body, type = 'application/json') => { res.writeHead(code, { 'content-type': type }); res.end(type === 'application/json' ? JSON.stringify(body) : body); };
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      // fake hosted checkout page
      const page = /^\/checkout\/([\w.]+)$/.exec(url.pathname);
      if (page) {
        const t = payments.get(page[1]);
        if (!t) return send(404, 'Unknown payment', 'text/plain');
        if (req.method === 'POST') {
          t.status = url.searchParams.get('action') === 'cancel' ? 'canceled' : 'complete';
          res.writeHead(302, { location: t.callback });
          return res.end();
        }
        return send(200, `<!doctype html><meta name="viewport" content="width=device-width"><title>Notch Pay (test stand-in)</title>
<body style="font-family:system-ui;background:#f4f4f7;display:grid;place-items:center;min-height:100vh;margin:0">
<div style="background:#fff;padding:28px;border-radius:14px;box-shadow:0 4px 24px #0001;max-width:380px;width:90%">
<p style="background:#fef3c7;color:#92400e;padding:8px 10px;border-radius:8px;font-size:13px;margin:0 0 16px">Test stand-in for Notch Pay. No real money moves.</p>
<h2 style="margin:0 0 4px">Pay ${t.amount.toLocaleString('en-US')} ${t.currency}</h2><p style="color:#555;margin:0 0 18px">${t.description.replace(/[<>&]/g, '')}</p>
<p style="color:#555;font-size:14px">Mobile money number: ${t.phone || '(enter on your phone)'}</p>
<form method="post" action="?action=pay"><button style="width:100%;padding:12px;border:0;border-radius:8px;background:#0f9d58;color:#fff;font-size:16px;margin-bottom:8px">Approve payment</button></form>
<form method="post" action="?action=cancel"><button style="width:100%;padding:12px;border:1px solid #ccc;border-radius:8px;background:#fff;font-size:16px">Cancel</button></form></div>`, 'text/html');
      }
      if (req.headers.authorization !== key) return send(401, { status: 'Unauthorized', message: 'Invalid API key', code: 401 });
      if (req.method === 'POST' && url.pathname === '/payments/initialize') {
        let b;
        try { b = JSON.parse(raw); } catch { return send(400, { message: 'Bad JSON' }); }
        if (failNext) { const m = failNext; failNext = null; return send(422, { message: m, code: 422 }); }
        if (!(b.amount > 0) || !b.currency || !b.email) return send(422, { message: 'The amount, currency and email fields are required.', code: 422 });
        const reference = `trx.test_${++seq}`;
        const t = { reference, merchant_reference: b.reference, amount: b.amount, currency: b.currency, status: 'pending', callback: b.callback, description: b.description || '', phone: b.phone || null, email: b.email };
        payments.set(reference, t);
        const base = `http://${req.headers.host}`;
        return send(201, { status: 'Accepted', message: 'Payment initialized', code: 201, transaction: { ...t }, authorization_url: `${base}/checkout/${reference}` });
      }
      const get = /^\/payments\/(.+)$/.exec(url.pathname);
      if (req.method === 'GET' && get) {
        const t = find(decodeURIComponent(get[1]));
        if (!t) return send(404, { message: 'Payment not found', code: 404 });
        return send(200, { code: 200, status: 'OK', transaction: { ...t } });
      }
      send(404, { message: 'Not found' });
    });
  });

  return {
    server,
    payments,
    find,
    setStatus(ref, status, extra = {}) { Object.assign(find(ref), { status }, extra); },
    failNextInitialize(message) { failNext = message; },
    listen: (port = 0) => new Promise((r) => server.listen(port, () => r(`http://127.0.0.1:${server.address().port}`))),
  };
}

module.exports = { createFakeNotchPay };

if (require.main === module) {
  const fake = createFakeNotchPay();
  fake.listen(Number(process.argv[2]) || 4100).then((u) => console.log(`Fake Notch Pay listening at ${u}`));
}
