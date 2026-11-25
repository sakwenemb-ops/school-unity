// Minimal Notch Pay API client (https://notchpay.co), matching the calls made by
// Notch Pay's official JavaScript SDK (npm "notchpay.js"):
//   POST /payments/initialize   start a payment, returns { transaction, authorization_url }
//   GET  /payments/{reference}  fetch a payment and its current status
// Requests are authenticated with the account's public key in the Authorization header.
// Sandbox keys (pk_test...) create test payments; live keys take real money.
// Verified against the Notch Pay sandbox: initialize returns { transaction: { reference: "trx...",
// merchant_reference, status: "pending" }, authorization_url }, and GET /payments/{trx reference}
// returns { transaction: { status } } with status pending | processing | complete | failed | canceled | expired.
const { notchpay } = require('./config');

class NotchPayError extends Error {
  constructor(message, status) {
    super(message);
    this.name = 'NotchPayError';
    this.status = status;
  }
}

async function call(method, path, body) {
  if (!notchpay.publicKey) throw new NotchPayError('Notch Pay is not configured (NOTCHPAY_PUBLIC_KEY is missing).');
  let res;
  try {
    res = await fetch(notchpay.apiBase + path, {
      method,
      headers: { Authorization: notchpay.publicKey, Accept: 'application/json', ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(20000),
    });
  } catch (e) {
    throw new NotchPayError(`Could not reach Notch Pay (${e.cause?.code || e.name}).`);
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const detail = data.message || (data.errors && Object.values(data.errors).flat().join(' ')) || `HTTP ${res.status}`;
    throw new NotchPayError(`Notch Pay refused the request: ${detail}`, res.status);
  }
  return data;
}

// Starts a hosted checkout. Returns { providerReference, checkoutUrl }.
async function initializePayment({ amount, currency, email, phone, name, reference, description, callback }) {
  const data = await call('POST', '/payments/initialize', {
    amount, currency, email, phone: phone || undefined, name: name || undefined, reference, description, callback,
  });
  const checkoutUrl = data.authorization_url || data.transaction?.authorization_url;
  const safe = typeof checkoutUrl === 'string' && (/^https:\/\//.test(checkoutUrl) || (!notchpay.apiBase.startsWith('https:') && /^http:\/\//.test(checkoutUrl)));
  if (!safe) throw new NotchPayError('Notch Pay did not return a checkout link.');
  return { providerReference: data.transaction?.reference || null, checkoutUrl };
}

// Maps Notch Pay's payment status onto ours: complete | failed | canceled | expired | pending.
function normaliseStatus(s) {
  const v = String(s || '').toLowerCase();
  if (/^(complete|completed|success|successful|paid)$/.test(v)) return 'complete';
  if (/cancel/.test(v)) return 'canceled';
  if (/expire/.test(v)) return 'expired';
  if (/fail|reject|declin|refus/.test(v)) return 'failed';
  return 'pending';
}

// Fetches a payment from Notch Pay. Returns { status, amount, currency, raw }.
async function fetchPayment(reference) {
  const data = await call('GET', '/payments/' + encodeURIComponent(reference));
  const trx = data.transaction || data.data || data;
  return { status: normaliseStatus(trx.status), amount: Number(trx.amount), currency: String(trx.currency || '').toUpperCase(), raw: trx };
}

module.exports = { initializePayment, fetchPayment, normaliseStatus, NotchPayError, enabled: () => Boolean(notchpay.publicKey) };
