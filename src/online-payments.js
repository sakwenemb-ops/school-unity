// Online payments through Notch Pay: student fees and school subscription plans.
//
// Flow: startCheckout() records a pending row and asks Notch Pay for a hosted checkout
// page. The payer completes it there (MTN MoMo, Orange Money, card). Notch Pay then sends
// the payer back to /pay/return/<reference> and also calls /webhooks/notchpay. Neither of
// those is trusted on its own: refresh() always asks Notch Pay for the payment's real
// status before crediting anything, and crediting happens at most once per checkout.
const crypto = require('crypto');
const { q, logActivity } = require('./db');
const notchpay = require('./notchpay');
const { PUBLIC_URL } = require('./config');
const { today } = require('./helpers');

const PLAN_PERIOD_DAYS = 30;

function fractionDigits(currency) {
  try { return new Intl.NumberFormat('en', { style: 'currency', currency }).resolvedOptions().maximumFractionDigits; } catch { return 2; }
}

// Rounds an amount to what the currency allows (XAF has no decimals).
function roundAmount(amount, currency) {
  const f = 10 ** fractionDigits(currency);
  return Math.round(Number(amount) * f) / f;
}

function baseUrl(req) {
  return PUBLIC_URL || `${req.protocol}://${req.get('host')}`;
}

function addDays(dateStr, n) {
  const d = new Date(dateStr + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

// Creates a pending checkout and returns its reference. Throws NotchPayError if Notch Pay refuses.
async function startCheckout(req, { kind, studentId = null, planCode = null, term = null, year = null, amount, currency, phone, description }) {
  const reference = `SU${kind === 'fee' ? 'F' : 'P'}-${crypto.randomBytes(6).toString('hex').toUpperCase()}`;
  const row = q.run(
    `INSERT INTO online_payments (school_id,kind,student_id,plan_code,term,academic_year,amount,currency,reference,phone,email,initiated_by)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
    req.school.id, kind, studentId, planCode, term, year, amount, currency, reference, phone, req.user.email, req.user.id);
  try {
    const out = await notchpay.initializePayment({
      amount, currency, email: req.user.email, phone, name: req.user.name, reference, description,
      callback: `${baseUrl(req)}/pay/return/${reference}`,
    });
    q.run('UPDATE online_payments SET provider_reference=?, checkout_url=? WHERE id=?', out.providerReference, out.checkoutUrl, row.lastInsertRowid);
    return reference;
  } catch (e) {
    q.run("UPDATE online_payments SET status='failed' WHERE id=?", row.lastInsertRowid);
    throw e;
  }
}

// Applies a confirmed payment exactly once. Returns true if this call credited it.
function credit(row) {
  return q.tx(() => {
    const claimed = q.run("UPDATE online_payments SET status='complete', completed_at=datetime('now') WHERE id=? AND status!='complete'", row.id);
    if (!claimed.changes) return false;
    const ref = row.provider_reference || row.reference;
    if (row.kind === 'fee') {
      const st = row.student_id && q.get('SELECT id FROM students WHERE id=? AND school_id=?', row.student_id, row.school_id);
      if (st) {
        const p = q.run(
          `INSERT INTO payments (school_id,student_id,amount,method,reference,term,academic_year,paid_on,note,recorded_by)
           VALUES (?,?,?,?,?,?,?,?,?,NULL)`,
          row.school_id, st.id, row.amount, 'Notch Pay', ref, row.term, row.academic_year, today(), `Paid online (${row.reference})`);
        q.run('UPDATE online_payments SET payment_id=? WHERE id=?', p.lastInsertRowid, row.id);
      }
      logActivity(row.school_id, row.initiated_by, `Online fee payment ${row.reference} received`);
    } else {
      activatePlan(row.school_id, row.plan_code, row.initiated_by, row.reference);
    }
    return true;
  });
}

// Puts a school on a plan for one more period: extends the current paid period when
// renewing the same plan, otherwise starts a new period today. Returns the new paid-until date.
function activatePlan(schoolId, planCode, userId, reference) {
  const school = q.get('SELECT plan, paid_until FROM schools WHERE id=?', schoolId);
  const from = school.plan === planCode && school.paid_until && school.paid_until > today() ? school.paid_until : today();
  const until = addDays(from, PLAN_PERIOD_DAYS);
  q.run('UPDATE schools SET plan=?, paid_until=?, trial_ends_at=NULL WHERE id=?', planCode, until, schoolId);
  const plan = q.get('SELECT name FROM plans WHERE code=?', planCode);
  logActivity(schoolId, userId, `Paid for the ${plan?.name || planCode} plan until ${until} (${reference})`);
  return until;
}

// Asks Notch Pay for the checkout's real status and records it. Returns the updated row.
async function refresh(row) {
  if (row.status === 'complete') return row;
  const remote = await notchpay.fetchPayment(row.provider_reference || row.reference);
  if (remote.status === 'complete') {
    const amountOk = remote.amount + 1e-9 >= row.amount && (!remote.currency || remote.currency === row.currency);
    if (amountOk) credit(row);
    else console.error(`Notch Pay payment ${row.reference} is complete but for ${remote.amount} ${remote.currency}, expected ${row.amount} ${row.currency}; not credited.`);
  } else if (remote.status !== 'pending') {
    q.run("UPDATE online_payments SET status=? WHERE id=? AND status='pending'", remote.status, row.id);
  }
  return q.get('SELECT * FROM online_payments WHERE id=?', row.id);
}

// Finds a checkout from any reference Notch Pay might send back (ours or theirs).
function findByAnyReference(refs) {
  for (const r of refs.filter((x) => typeof x === 'string' && x)) {
    const row = q.get('SELECT * FROM online_payments WHERE reference=? OR provider_reference=?', r, r);
    if (row) return row;
  }
  return null;
}

// Paid-plan coverage: the date a paid plan is paid (or on trial) until, and whether it has lapsed.
function planStatus(school) {
  if (!school || !school.price_monthly) return { paid: false };
  const until = school.paid_until || school.trial_ends_at || null;
  const daysLeft = until ? Math.round((new Date(until + 'T00:00:00Z') - new Date(today() + 'T00:00:00Z')) / 86400000) : null;
  return { paid: true, until, onTrial: !school.paid_until && !!school.trial_ends_at, daysLeft, expired: daysLeft != null && daysLeft < 0 };
}

module.exports = { startCheckout, refresh, credit, activatePlan, findByAnyReference, roundAmount, fractionDigits, planStatus, enabled: notchpay.enabled, PLAN_PERIOD_DAYS };
