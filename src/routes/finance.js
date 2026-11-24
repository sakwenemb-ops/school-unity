const express = require('express');
const { q, logActivity } = require('../db');
const { flash, requireRole } = require('../middleware');
const { today, toCsv } = require('../helpers');

const router = express.Router();
router.use('/fees', requireRole('admin'));
const METHODS = ['Cash', 'Bank transfer', 'Mobile money', 'Card', 'Cheque'];

router.get('/fees', (req, res) => {
  const s = req.school;
  const items = q.all(`SELECT fi.*, c.name class_name, c.section FROM fee_items fi LEFT JOIN classes c ON c.id=fi.class_id
    WHERE fi.school_id=? AND fi.term=? AND fi.academic_year=? ORDER BY fi.class_id IS NOT NULL, c.name, fi.name`, s.id, s.current_term, s.academic_year);
  const classes = q.all('SELECT * FROM classes WHERE school_id=? ORDER BY name, section', s.id);
  const classId = req.query.class_id || '';
  const filter = req.query.filter || '';
  let balances = q.all(`SELECT st.id, st.admission_no, st.first_name, st.last_name, st.class_id, c.name class_name, c.section, st.guardian_phone,
      (SELECT COALESCE(SUM(amount),0) FROM fee_items fi WHERE fi.school_id=st.school_id AND fi.term=? AND fi.academic_year=? AND (fi.class_id IS NULL OR fi.class_id=st.class_id)) expected,
      (SELECT COALESCE(SUM(amount),0) FROM payments p WHERE p.student_id=st.id AND p.term=? AND p.academic_year=?) paid
    FROM students st LEFT JOIN classes c ON c.id=st.class_id
    WHERE st.school_id=? AND st.status='active' AND (? IS NULL OR st.class_id=?) ORDER BY c.name, st.first_name`,
    s.current_term, s.academic_year, s.current_term, s.academic_year, s.id, classId || null, classId || null);
  balances.forEach((b) => { b.balance = b.expected - b.paid; });
  const totals = balances.reduce((t, b) => ({ expected: t.expected + b.expected, paid: t.paid + b.paid, balance: t.balance + Math.max(0, b.balance) }), { expected: 0, paid: 0, balance: 0 });
  if (filter === 'owing') balances = balances.filter((b) => b.balance > 0);
  if (filter === 'cleared') balances = balances.filter((b) => b.balance <= 0);
  res.page('app/fees/index', { title: 'Fees', items, classes, balances, totals, classId, filter });
});

router.post('/fees/items', (req, res) => {
  const f = req.body;
  const amount = Number(f.amount);
  if (!f.name?.trim() || !(amount > 0)) flash(req, 'error', 'Fee name and a positive amount are required.');
  else if (f.class_id && !q.get('SELECT id FROM classes WHERE id=? AND school_id=?', f.class_id, req.school.id)) flash(req, 'error', 'Invalid class.');
  else {
    q.run('INSERT INTO fee_items (school_id,name,amount,class_id,term,academic_year) VALUES (?,?,?,?,?,?)',
      req.school.id, f.name.trim(), amount, f.class_id, req.school.current_term, req.school.academic_year);
    logActivity(req.school.id, req.user.id, `Added fee item ${f.name.trim()}`);
    flash(req, 'success', 'Fee item added for ' + req.school.current_term + '.');
  }
  res.redirect('/app/fees');
});

router.post('/fees/items/:id/delete', (req, res) => {
  q.run('DELETE FROM fee_items WHERE id=? AND school_id=?', req.params.id, req.school.id);
  flash(req, 'success', 'Fee item removed.');
  res.redirect('/app/fees');
});

router.get('/fees/payments', (req, res) => {
  const from = req.query.from || '';
  const to = req.query.to || '';
  const payments = q.all(`SELECT p.*, s.first_name, s.last_name, s.admission_no, u.name recorded_by_name FROM payments p
    JOIN students s ON s.id=p.student_id LEFT JOIN users u ON u.id=p.recorded_by
    WHERE p.school_id=? AND (? IS NULL OR p.paid_on >= ?) AND (? IS NULL OR p.paid_on <= ?) ORDER BY p.paid_on DESC, p.id DESC LIMIT 300`,
    req.school.id, from || null, from || null, to || null, to || null);
  const total = payments.reduce((a, p) => a + p.amount, 0);
  if (req.query.format === 'csv') {
    const csv = toCsv(payments, [
      { label: 'Receipt', value: (p) => 'RCT-' + String(p.id).padStart(6, '0') }, { label: 'Date', value: 'paid_on' },
      { label: 'Admission No', value: 'admission_no' }, { label: 'Student', value: (p) => p.first_name + ' ' + p.last_name },
      { label: 'Amount', value: 'amount' }, { label: 'Method', value: 'method' }, { label: 'Reference', value: 'reference' },
      { label: 'Term', value: 'term' }, { label: 'Year', value: 'academic_year' },
    ]);
    return res.set('Content-Type', 'text/csv').attachment(`payments-${today()}.csv`).send(csv);
  }
  res.page('app/fees/payments', { title: 'Payments', payments, total, from, to });
});

router.get('/fees/pay', (req, res) => {
  const students = q.all("SELECT s.id, s.admission_no, s.first_name, s.last_name, c.name class_name, c.section FROM students s LEFT JOIN classes c ON c.id=s.class_id WHERE s.school_id=? AND s.status='active' ORDER BY s.first_name", req.school.id);
  res.page('app/fees/pay', { title: 'Record payment', students, methods: METHODS, studentId: req.query.student_id, date: today() });
});

router.post('/fees/payments', (req, res) => {
  const f = req.body;
  const amount = Number(f.amount);
  const st = q.get('SELECT id FROM students WHERE id=? AND school_id=?', f.student_id, req.school.id);
  if (!st || !(amount > 0) || !/^\d{4}-\d{2}-\d{2}$/.test(f.paid_on || '')) {
    flash(req, 'error', 'Choose a student, a positive amount and a valid date.');
    return res.redirect('/app/fees/pay' + (f.student_id ? '?student_id=' + encodeURIComponent(f.student_id) : ''));
  }
  const r = q.run(`INSERT INTO payments (school_id,student_id,amount,method,reference,term,academic_year,paid_on,note,recorded_by) VALUES (?,?,?,?,?,?,?,?,?,?)`,
    req.school.id, st.id, amount, METHODS.includes(f.method) ? f.method : 'Cash', f.reference, req.school.current_term, req.school.academic_year, f.paid_on, f.note, req.user.id);
  logActivity(req.school.id, req.user.id, `Recorded payment RCT-${String(r.lastInsertRowid).padStart(6, '0')}`);
  flash(req, 'success', 'Payment recorded.');
  res.redirect('/app/fees/payments/' + r.lastInsertRowid + '/receipt');
});

router.get('/fees/payments/:id/receipt', (req, res) => {
  const p = q.get(`SELECT p.*, s.first_name, s.last_name, s.admission_no, c.name class_name, c.section, u.name recorded_by_name, s.class_id
    FROM payments p JOIN students s ON s.id=p.student_id LEFT JOIN classes c ON c.id=s.class_id LEFT JOIN users u ON u.id=p.recorded_by
    WHERE p.id=? AND p.school_id=?`, req.params.id, req.school.id);
  if (!p) return res.status(404).render('error', { title: 'Not found', message: 'Receipt not found.' });
  const expected = q.get('SELECT COALESCE(SUM(amount),0) t FROM fee_items WHERE school_id=? AND term=? AND academic_year=? AND (class_id IS NULL OR class_id=?)', req.school.id, p.term, p.academic_year, p.class_id).t;
  const paid = q.get('SELECT COALESCE(SUM(amount),0) t FROM payments WHERE student_id=? AND term=? AND academic_year=? AND id<=?', p.student_id, p.term, p.academic_year, p.id).t;
  res.render('app/fees/receipt', { p, expected, paid, balance: expected - paid });
});

router.post('/fees/payments/:id/delete', (req, res) => {
  const r = q.run('DELETE FROM payments WHERE id=? AND school_id=?', req.params.id, req.school.id);
  if (r.changes) logActivity(req.school.id, req.user.id, `Voided payment RCT-${String(req.params.id).padStart(6, '0')}`);
  flash(req, 'success', 'Payment voided.');
  res.redirect('/app/fees/payments');
});

module.exports = router;
