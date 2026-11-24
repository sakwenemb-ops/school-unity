// Super-admin console for the SaaS operator: manage tenant schools and plans.
const express = require('express');
const bcrypt = require('bcryptjs');
const { q } = require('../db');
const { flash, requireRole } = require('../middleware');

const router = express.Router();
router.use(requireRole('superadmin'));

router.get('/', (req, res) => {
  const stats = {
    schools: q.get('SELECT COUNT(*) n FROM schools').n,
    active: q.get("SELECT COUNT(*) n FROM schools WHERE status='active'").n,
    students: q.get('SELECT COUNT(*) n FROM students').n,
    teachers: q.get('SELECT COUNT(*) n FROM teachers').n,
    mrr: q.get("SELECT COALESCE(SUM(p.price_monthly),0) t FROM schools s JOIN plans p ON p.code=s.plan WHERE s.status='active'").t,
  };
  const byPlan = q.all(`SELECT p.code, p.name, COUNT(s.id) n FROM plans p LEFT JOIN schools s ON s.plan=p.code GROUP BY p.code ORDER BY p.price_monthly`);
  const recent = q.all('SELECT * FROM schools ORDER BY created_at DESC, id DESC LIMIT 5');
  res.page('platform/dashboard', { title: 'Platform overview', stats, byPlan, recent });
});

router.get('/schools', (req, res) => {
  const s = (req.query.q || '').trim();
  const schools = q.all(
    `SELECT s.*, p.name plan_name, p.price_monthly,
       (SELECT COUNT(*) FROM students st WHERE st.school_id=s.id) students,
       (SELECT COUNT(*) FROM teachers t WHERE t.school_id=s.id) teachers
     FROM schools s JOIN plans p ON p.code=s.plan
     WHERE (? IS NULL OR s.name LIKE ? OR s.email LIKE ?)
     ORDER BY s.created_at DESC, s.id DESC`, s || null, `%${s}%`, `%${s}%`);
  res.page('platform/schools', { title: 'Schools', schools });
});

router.get('/schools/:id', (req, res) => {
  const school = q.get('SELECT s.*, p.name plan_name FROM schools s JOIN plans p ON p.code=s.plan WHERE s.id=?', req.params.id);
  if (!school) return res.status(404).render('error', { title: 'Not found', message: 'School not found.' });
  const plans = q.all('SELECT * FROM plans ORDER BY price_monthly');
  const admins = q.all("SELECT id,name,email,last_login,active FROM users WHERE school_id=? AND role='admin'", school.id);
  const counts = {
    students: q.get('SELECT COUNT(*) n FROM students WHERE school_id=?', school.id).n,
    teachers: q.get('SELECT COUNT(*) n FROM teachers WHERE school_id=?', school.id).n,
    classes: q.get('SELECT COUNT(*) n FROM classes WHERE school_id=?', school.id).n,
    users: q.get('SELECT COUNT(*) n FROM users WHERE school_id=?', school.id).n,
  };
  const activity = q.all('SELECT a.*, u.name user_name FROM activity_log a LEFT JOIN users u ON u.id=a.user_id WHERE a.school_id=? ORDER BY a.id DESC LIMIT 15', school.id);
  const planPayments = q.all("SELECT op.*, p.name plan_name FROM online_payments op LEFT JOIN plans p ON p.code=op.plan_code WHERE op.school_id=? AND op.kind='plan' ORDER BY op.id DESC LIMIT 10", school.id);
  res.page('platform/school', { title: school.name, school, plans, admins, counts, activity, planPayments });
});

router.post('/schools/:id', (req, res) => {
  const { plan, status } = req.body;
  const paidUntil = (req.body.paid_until || '').trim();
  if (!q.get('SELECT code FROM plans WHERE code=?', plan) || !['active', 'suspended'].includes(status) || (paidUntil && !/^\d{4}-\d{2}-\d{2}$/.test(paidUntil))) {
    flash(req, 'error', 'Invalid plan, status or date.');
  } else {
    // paid_until lets the owner record payments taken outside Notch Pay (cash, bank transfer) or grant free time.
    q.run('UPDATE schools SET plan=?, status=?, paid_until=? WHERE id=?', plan, status, paidUntil || null, req.params.id);
    flash(req, 'success', 'School subscription updated.');
  }
  res.redirect('/platform/schools/' + req.params.id);
});

router.post('/schools/:id/reset-admin', (req, res) => {
  const admin = q.get("SELECT id FROM users WHERE id=? AND school_id=? AND role='admin'", req.body.user_id, req.params.id);
  if (!admin || !req.body.password || req.body.password.length < 8) {
    flash(req, 'error', 'Choose an admin and a password of at least 8 characters.');
  } else {
    q.run('UPDATE users SET password_hash=? WHERE id=?', bcrypt.hashSync(req.body.password, 10), admin.id);
    flash(req, 'success', 'Admin password reset.');
  }
  res.redirect('/platform/schools/' + req.params.id);
});

router.post('/schools/:id/delete', (req, res) => {
  const school = q.get('SELECT * FROM schools WHERE id=?', req.params.id);
  if (school && req.body.confirm === school.slug) {
    q.run('DELETE FROM schools WHERE id=?', school.id);
    flash(req, 'success', `${school.name} and all of its data were deleted.`);
    return res.redirect('/platform/schools');
  }
  flash(req, 'error', 'Type the school slug exactly to confirm deletion.');
  res.redirect('/platform/schools/' + req.params.id);
});

router.get('/plans', (req, res) => {
  const plans = q.all('SELECT p.*, (SELECT COUNT(*) FROM schools s WHERE s.plan=p.code) schools FROM plans p ORDER BY price_monthly');
  res.page('platform/plans', { title: 'Subscription plans', plans });
});

router.post('/plans/:code', (req, res) => {
  const lim = (v) => (v === '' || v == null ? null : Math.max(0, parseInt(v, 10)));
  q.run('UPDATE plans SET name=?, price_monthly=?, student_limit=?, teacher_limit=?, description=? WHERE code=?',
    req.body.name, Number(req.body.price_monthly) || 0, lim(req.body.student_limit), lim(req.body.teacher_limit), req.body.description, req.params.code);
  flash(req, 'success', 'Plan updated.');
  res.redirect('/platform/plans');
});

module.exports = router;
