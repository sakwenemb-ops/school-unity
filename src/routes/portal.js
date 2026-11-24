// Student self-service portal.
const express = require('express');
const { q } = require('../db');
const { requireRole, flash } = require('../middleware');
const { feeSummary, gradeFor, money } = require('../helpers');
const { reportCard } = require('./academics');
const onlinePayments = require('../online-payments');

const router = express.Router();
router.use('/me', requireRole('student'));

function me(req) {
  return q.get('SELECT s.*, c.name class_name, c.section FROM students s LEFT JOIN classes c ON c.id=s.class_id WHERE s.id=? AND s.school_id=?', req.user.student_id, req.school.id);
}

router.get('/me/profile', (req, res) => {
  const s = me(req);
  if (!s) return res.page('app/empty-portal', { title: 'My profile' });
  res.page('app/portal/profile', { title: 'My profile', s });
});

router.get('/me/attendance', (req, res) => {
  const s = me(req);
  if (!s) return res.page('app/empty-portal', { title: 'My attendance' });
  const summary = q.get(`SELECT COUNT(*) total, SUM(status='present') present, SUM(status='absent') absent, SUM(status='late') late, SUM(status='excused') excused FROM attendance WHERE student_id=?`, s.id);
  const records = q.all('SELECT date, status FROM attendance WHERE student_id=? ORDER BY date DESC LIMIT 60', s.id);
  res.page('app/portal/attendance', { title: 'My attendance', s, summary, records });
});

router.get('/me/results', (req, res) => {
  const s = me(req);
  if (!s) return res.page('app/empty-portal', { title: 'My results' });
  const exams = q.all(`SELECT e.*, AVG(g.score) avg, COUNT(g.id) subjects FROM exams e JOIN grades g ON g.exam_id=e.id AND g.student_id=?
    WHERE e.school_id=? GROUP BY e.id ORDER BY e.id DESC`, s.id, req.school.id);
  res.page('app/portal/results', { title: 'My results', s, exams, gradeFor });
});

router.get('/me/results/:eid', (req, res) => {
  const data = reportCard(req, req.user.student_id, req.params.eid);
  if (!data) return res.status(404).render('error', { title: 'Not found', message: 'Report not found.' });
  res.render('app/report-card', data);
});

router.get('/me/fees', (req, res) => {
  const s = me(req);
  if (!s) return res.page('app/empty-portal', { title: 'My fees' });
  const fees = feeSummary(req.school, s);
  const items = q.all('SELECT * FROM fee_items WHERE school_id=? AND term=? AND academic_year=? AND (class_id IS NULL OR class_id=?) ORDER BY name',
    req.school.id, req.school.current_term, req.school.academic_year, s.class_id);
  const payments = q.all('SELECT * FROM payments WHERE student_id=? AND school_id=? ORDER BY paid_on DESC', s.id, req.school.id);
  const online = q.all("SELECT * FROM online_payments WHERE kind='fee' AND student_id=? AND school_id=? AND status!='complete' AND created_at >= datetime('now','-30 day') ORDER BY id DESC LIMIT 5", s.id, req.school.id);
  const step = 1 / 10 ** onlinePayments.fractionDigits(req.school.currency);
  res.page('app/portal/fees', { title: 'My fees', s, fees, items, payments, online, step });
});

// Pay school fees online through Notch Pay (mobile money / card).
router.post('/me/fees/pay', async (req, res, next) => {
  try {
    const s = me(req);
    if (!s) return res.redirect('/app/me/fees');
    if (!onlinePayments.enabled()) {
      flash(req, 'error', "Online payment isn't available yet. Please pay at the school office.");
      return res.redirect('/app/me/fees');
    }
    const currency = req.school.currency;
    const fees = feeSummary(req.school, s);
    const balance = onlinePayments.roundAmount(Math.max(0, fees.balance), currency);
    const amount = onlinePayments.roundAmount(req.body.amount, currency);
    const phone = String(req.body.phone || '').replace(/[^\d+]/g, '');
    if (!(balance > 0)) flash(req, 'error', 'You have no fee balance to pay for this term.');
    else if (!(amount > 0) || amount > balance) flash(req, 'error', `Enter an amount between ${money(1 / 10 ** onlinePayments.fractionDigits(currency), currency)} and ${money(balance, currency)}.`);
    else if (phone && !/^\+?\d{8,15}$/.test(phone)) flash(req, 'error', 'Enter a valid mobile money number, e.g. +237 6XX XX XX XX.');
    else {
      try {
        const ref = await onlinePayments.startCheckout(req, {
          kind: 'fee', studentId: s.id, term: req.school.current_term, year: req.school.academic_year, amount, currency, phone,
          description: `${req.school.name} fees: ${s.first_name} ${s.last_name} (${s.admission_no}), ${req.school.current_term} ${req.school.academic_year}`,
        });
        return res.redirect(303, '/pay/go/' + ref);
      } catch (e) {
        console.error('Notch Pay checkout failed:', e.message);
        flash(req, 'error', 'We could not start the payment: ' + e.message);
      }
    }
    res.redirect('/app/me/fees');
  } catch (e) { next(e); }
});

module.exports = router;
