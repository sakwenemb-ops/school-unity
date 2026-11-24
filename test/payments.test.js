// Online payments through Notch Pay, exercised against a local stand-in for the Notch Pay API.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const os = require('os');
const fs = require('fs');
const { execFileSync } = require('child_process');
const { createFakeNotchPay } = require('../dev/fake-notchpay');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'su-pay-'));
const fake = createFakeNotchPay({ key: 'pk_test_fake' });
let app; let q; let server; let base;

before(async () => {
  const fakeBase = await fake.listen();
  Object.assign(process.env, { DB_FILE: path.join(dir, 'test.db'), NOTCHPAY_PUBLIC_KEY: 'pk_test_fake', NOTCHPAY_API_BASE: fakeBase });
  execFileSync(process.execPath, ['--no-warnings', path.join(__dirname, '..', 'seed.js')], { env: process.env });
  app = require('../server');
  ({ q } = require('../src/db'));
  await new Promise((r) => { server = app.listen(0, () => { base = `http://127.0.0.1:${server.address().port}`; r(); }); });
});
after(() => { server.close(); fake.server.close(); fs.rmSync(dir, { recursive: true, force: true }); });

function client() {
  let cookie = '';
  const req = async (method, url, form, json) => {
    const headers = { cookie };
    let body;
    if (form) { headers['content-type'] = 'application/x-www-form-urlencoded'; body = new URLSearchParams(form).toString(); }
    if (json) { headers['content-type'] = 'application/json'; body = JSON.stringify(json); }
    const res = await fetch(base + url, { method, headers, body, redirect: 'manual' });
    for (const c of res.headers.getSetCookie?.() || []) cookie = c.split(';')[0];
    return { status: res.status, location: res.headers.get('location'), text: await res.text() };
  };
  const c = {
    get: (u) => req('GET', u),
    webhook: (payload) => req('POST', '/webhooks/notchpay', null, payload),
    async post(u, form = {}) {
      let token;
      for (const p of ['/app/account', '/platform/plans']) {
        token = /name="_csrf" value="([^"]+)"/.exec((await req('GET', p)).text)?.[1];
        if (token) break;
      }
      return req('POST', u, { _csrf: token, ...form });
    },
    async login(email, password) {
      const page = await req('GET', '/login');
      const token = /name="_csrf" value="([^"]+)"/.exec(page.text)[1];
      const r = await req('POST', '/login', { _csrf: token, email, password });
      assert.equal(r.status, 302, `login ${email}`);
    },
    async flash(u) { const r = await req('GET', u); return /class="alert alert-(\w+)" role="status">([^<]*)/.exec(r.text)?.slice(1) || []; },
  };
  return c;
}

const studentRow = () => q.get("SELECT s.* FROM students s JOIN users u ON u.student_id=s.id WHERE u.email='student@greenfield.edu'");
const paymentsFor = (sid) => q.all("SELECT * FROM payments WHERE student_id=? AND method='Notch Pay'", sid);
const today = () => new Date().toISOString().slice(0, 10);
const plusDays = (d, n) => { const x = new Date(d + 'T00:00:00Z'); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };

// Gives the demo student an outstanding balance of 165,000 XAF to pay.
function resetStudentBalance() {
  const s = studentRow();
  q.run('DELETE FROM payments WHERE student_id=?', s.id);
  return s;
}

test('student pays fees online; payment is credited once, after Notch Pay confirms it', async () => {
  const s = resetStudentBalance();
  const c = client();
  await c.login('student@greenfield.edu', 'student12345');
  const page = await c.get('/app/me/fees');
  assert.match(page.text, /Pay online/);
  assert.match(page.text, /name="amount"[^>]*step="1"[^>]*value="165000"/);

  const start = await c.post('/app/me/fees/pay', { amount: '50000', phone: '+237 670 00 00 00' });
  assert.equal(start.status, 303);
  const ref = /^\/pay\/go\/(SUF-[0-9A-F]{12})$/.exec(start.location)?.[1];
  assert.ok(ref, start.location);
  const row = q.get('SELECT * FROM online_payments WHERE reference=?', ref);
  assert.equal(row.status, 'pending');
  assert.equal(row.amount, 50000);
  assert.equal(row.currency, 'XAF');
  assert.equal(row.phone, '+237670000000');
  const trx = fake.find(ref);
  assert.equal(trx.callback, `${base}/pay/return/${ref}`);
  assert.equal(trx.email, 'student@greenfield.edu');

  // hand-off page forwards to the hosted checkout
  const go = await c.get('/pay/go/' + ref);
  assert.equal(go.status, 200);
  assert.ok(go.text.includes(`url=${row.checkout_url}`));

  // back from checkout before the payer approved on their phone: nothing credited yet
  let back = await c.get('/pay/return/' + ref);
  assert.equal(back.location, '/app/me/fees');
  assert.equal(paymentsFor(s.id).length, 0);
  assert.match((await c.flash('/app/me/fees'))[1], /still being processed/);

  // a forged webhook can't mark it paid: Notch Pay still says pending
  await c.webhook({ event: 'payment.complete', data: { reference: trx.reference, status: 'complete' } });
  assert.equal(paymentsFor(s.id).length, 0);

  // Notch Pay confirms; the webhook credits it, and repeat callbacks don't double-credit
  fake.setStatus(ref, 'complete');
  const wh = await c.webhook({ event: 'payment.complete', data: { reference: trx.reference, merchant_reference: ref } });
  assert.equal(wh.status, 200);
  back = await c.get('/pay/return/' + ref);
  assert.equal(back.location, '/app/me/fees');
  await c.webhook({ event: 'payment.complete', data: { reference: trx.reference } });
  const paid = paymentsFor(s.id);
  assert.equal(paid.length, 1, 'credited exactly once');
  assert.equal(paid[0].amount, 50000);
  assert.equal(paid[0].reference, trx.reference);
  assert.equal(paid[0].term, 'Term 1');
  assert.equal(q.get('SELECT status FROM online_payments WHERE reference=?', ref).status, 'complete');

  const after = await c.get('/app/me/fees');
  assert.match(after.text, /FCFA\s115,000/, 'balance reduced');
  // admin sees it with a receipt
  const a = client();
  await a.login('admin@greenfield.edu', 'admin12345');
  assert.match((await a.get('/app/fees/payments')).text, new RegExp(trx.reference.replace('.', '\\.')));
  assert.match((await a.get(`/app/fees/payments/${paid[0].id}/receipt`)).text, /Notch Pay \(online payment\)/);
});

test('rejects bad amounts and handles cancelled, mismatched and refused payments', async () => {
  const s = resetStudentBalance();
  const c = client();
  await c.login('student@greenfield.edu', 'student12345');
  for (const amount of ['0', '-5', '165001', 'abc']) {
    const r = await c.post('/app/me/fees/pay', { amount });
    assert.equal(r.location, '/app/me/fees', `amount ${amount}`);
  }
  assert.equal(q.get("SELECT COUNT(*) n FROM online_payments WHERE student_id=? AND status='pending'", s.id).n, 0);

  // payer cancels on Notch Pay
  let ref = /SUF-\w+/.exec((await c.post('/app/me/fees/pay', { amount: '1000' })).location)[0];
  fake.setStatus(ref, 'canceled');
  await c.get('/pay/return/' + ref);
  assert.equal(q.get('SELECT status FROM online_payments WHERE reference=?', ref).status, 'canceled');
  assert.equal(paymentsFor(s.id).length, 0);

  // Notch Pay reports less money than was asked for: not credited
  ref = /SUF-\w+/.exec((await c.post('/app/me/fees/pay', { amount: '20000' })).location)[0];
  fake.setStatus(ref, 'complete', { amount: 200 });
  await c.get('/pay/return/' + ref);
  assert.equal(paymentsFor(s.id).length, 0);

  // Notch Pay refuses to start the payment
  fake.failNextInitialize('The phone field must be a valid number.');
  const r = await c.post('/app/me/fees/pay', { amount: '1000' });
  assert.equal(r.location, '/app/me/fees');
  assert.match((await c.flash('/app/me/fees'))[1], /could not start the payment: Notch Pay refused the request: The phone field/);

  // another user can't use someone else's checkout link; unknown references are ignored
  const other = client();
  await other.login('admin@greenfield.edu', 'admin12345');
  ref = /SUF-\w+/.exec((await c.post('/app/me/fees/pay', { amount: '1000' })).location)[0];
  assert.equal((await other.get('/pay/go/' + ref)).location, '/app');
  assert.equal((await other.webhook({ data: { reference: 'trx.nope' } })).status, 200);
  assert.equal((await other.get('/pay/return/SUF-000000000000')).status, 404);
});

test('school pays for a plan through Notch Pay; renewal extends the paid period', async () => {
  const sid = q.get("SELECT id FROM schools WHERE slug='riverside-primary'").id;
  const c = client();
  await c.login('admin@riverside.edu', 'admin12345');
  const billing = await c.get('/app/billing');
  assert.match(billing.text, /billed monthly in XAF through Notch Pay/);

  let r = await c.post('/app/billing', { plan: 'basic' });
  assert.equal(r.status, 303);
  let ref = /SUP-\w+/.exec(r.location)[0];
  assert.equal(fake.find(ref).amount, 25000);
  assert.equal(fake.find(ref).currency, 'XAF');
  assert.equal(q.get('SELECT plan FROM schools WHERE id=?', sid).plan, 'free', 'not upgraded before paying');

  fake.setStatus(ref, 'complete');
  r = await c.get('/pay/return/' + ref);
  assert.equal(r.location, '/app/billing');
  let school = q.get('SELECT plan, paid_until FROM schools WHERE id=?', sid);
  assert.equal(school.plan, 'basic');
  assert.equal(school.paid_until, plusDays(today(), 30));
  assert.match((await c.flash('/app/billing'))[1], /Growth plan is paid until/);

  // renew early: adds 30 days on top of the current period
  ref = /SUP-\w+/.exec((await c.post('/app/billing', { plan: 'basic' })).location)[0];
  fake.setStatus(ref, 'complete');
  await c.webhook({ data: { merchant_reference: ref } });
  school = q.get('SELECT plan, paid_until FROM schools WHERE id=?', sid);
  assert.equal(school.paid_until, plusDays(today(), 60));
  const page = await c.get('/app/billing');
  assert.equal((page.text.match(/>Paid</g) || []).length, 2, 'both payments listed');

  // expired plan: banner on every admin page
  q.run('UPDATE schools SET paid_until=? WHERE id=?', plusDays(today(), -2), sid);
  assert.match((await c.get('/app/students')).text, /plan\s+ended on/);

  // the platform owner sees the payments and can record an offline one
  const o = client();
  await o.login('owner@schoolunity.app', 'owner12345');
  assert.match((await o.get(`/platform/schools/${sid}`)).text, /SUP-/);
  await o.post(`/platform/schools/${sid}`, { plan: 'basic', status: 'active', paid_until: '2030-01-31' });
  assert.equal(q.get('SELECT paid_until FROM schools WHERE id=?', sid).paid_until, '2030-01-31');

  // downgrading to the free plan is immediate
  await c.post('/app/billing', { plan: 'free' });
  assert.deepEqual({ ...q.get('SELECT plan, paid_until FROM schools WHERE id=?', sid) }, { plan: 'free', paid_until: null });
});
