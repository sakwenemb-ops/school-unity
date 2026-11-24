// Notch Pay checkout hand-off, return page and webhook.
const express = require('express');
const { q } = require('../db');
const { flash, requireAuth } = require('../middleware');
const { money, fmtDate } = require('../helpers');
const payments = require('../online-payments');

const router = express.Router();

// Same-origin hand-off page that forwards the browser to Notch Pay's hosted checkout.
// (Redirecting straight from a form POST to another site is blocked by our CSP form-action rule.)
router.get('/pay/go/:reference', requireAuth, (req, res) => {
  const row = q.get("SELECT * FROM online_payments WHERE reference=? AND initiated_by=? AND status='pending'", req.params.reference, req.user.id);
  if (!row || !row.checkout_url) {
    flash(req, 'error', 'That payment link has expired. Please start the payment again.');
    return res.redirect('/app');
  }
  res.render('pay/redirect', { title: 'Redirecting to Notch Pay', url: row.checkout_url, row });
});

function outcome(row) {
  const amount = money(row.amount, row.currency);
  if (row.status === 'complete') {
    if (row.kind === 'plan') {
      const s = q.get('SELECT s.paid_until, p.name FROM schools s JOIN plans p ON p.code=s.plan WHERE s.id=?', row.school_id);
      return { type: 'success', message: `Payment of ${amount} received. Your ${s.name} plan is paid until ${fmtDate(s.paid_until)}.` };
    }
    return { type: 'success', message: `Payment of ${amount} received. Thank you! It has been added to the fee statement.` };
  }
  if (row.status === 'pending') {
    return { type: 'info', message: `Your payment of ${amount} is still being processed. If your phone asked you to approve it, do that now; then use "Check status" to refresh.` };
  }
  return { type: 'error', message: `The payment of ${amount} was not completed (${row.status}). No money was taken. You can try again.` };
}

// Notch Pay sends the payer back here after checkout. Also used by the "Check status" links.
router.get('/pay/return/:reference', async (req, res, next) => {
  let row = q.get('SELECT * FROM online_payments WHERE reference=?', req.params.reference);
  if (!row) return res.status(404).render('error', { title: 'Payment not found', message: 'We could not find that payment.' });
  let result;
  try {
    row = await payments.refresh(row);
    result = outcome(row);
  } catch (e) {
    console.error('Notch Pay status check failed:', e.message);
    result = { type: 'error', message: 'We could not confirm the payment with Notch Pay right now. If you paid, it will appear shortly; use "Check status" to try again.' };
  }
  try {
    if (req.user && req.user.school_id === row.school_id) {
      flash(req, result.type, result.message);
      const dest = row.kind === 'plan' ? '/app/billing' : req.user.role === 'student' ? '/app/me/fees' : '/app/fees';
      return res.redirect(dest);
    }
    res.render('pay/result', { title: result.type === 'success' ? 'Payment received' : 'Payment status', result, row });
  } catch (e) { next(e); }
});

// Notch Pay webhook. The payload only tells us which payment changed; we confirm its status
// with Notch Pay's API before crediting, so a forged call can't mark anything as paid.
async function webhook(req, res) {
  const b = req.body || {};
  const d = b.data || {};
  const row = payments.findByAnyReference([d.reference, d.merchant_reference, d.trxref, d.transaction?.reference, d.transaction?.merchant_reference, b.reference, b.merchant_reference]);
  if (!row) return res.status(200).json({ received: true, matched: false });
  try {
    const updated = await payments.refresh(row);
    res.status(200).json({ received: true, status: updated.status });
  } catch (e) {
    console.error('Notch Pay webhook verification failed:', e.message);
    res.status(503).json({ received: false }); // ask Notch Pay to retry later
  }
}

module.exports = router;
module.exports.webhook = webhook;
