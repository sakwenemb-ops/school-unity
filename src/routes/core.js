const express = require('express');
const bcrypt = require('bcryptjs');
const { q, logActivity } = require('../db');
const { flash, requireRole } = require('../middleware');
const { visibleClasses, teacherClassIds } = require('../access');
const { today, feeSummary } = require('../helpers');

const router = express.Router();
const adminOnly = requireRole('admin');

function audienceFilter(role) {
  if (role === 'teacher') return "audience IN ('all','teachers')";
  if (role === 'student') return "audience IN ('all','students')";
  return '1=1';
}

// ---------- Dashboard ----------
router.get('/', (req, res) => {
  const sid = req.school.id;
  const role = req.user.role;
  const announcements = q.all(`SELECT * FROM announcements WHERE school_id=? AND ${audienceFilter(role)} ORDER BY pinned DESC, id DESC LIMIT 4`, sid);
  const events = q.all('SELECT * FROM events WHERE school_id=? AND date >= ? ORDER BY date LIMIT 5', sid, today());

  if (role === 'student') {
    const student = q.get('SELECT s.*, c.name class_name, c.section FROM students s LEFT JOIN classes c ON c.id=s.class_id WHERE s.id=? AND s.school_id=?', req.user.student_id, sid);
    if (!student) return res.page('app/empty-portal', { title: 'Dashboard' });
    const att = q.get(`SELECT COUNT(*) total, SUM(status IN ('present','late')) present FROM attendance WHERE student_id=? AND school_id=?`, student.id, sid);
    const fees = feeSummary(req.school, student);
    const latestExam = q.get('SELECT e.* FROM exams e JOIN grades g ON g.exam_id=e.id WHERE g.student_id=? AND e.school_id=? ORDER BY e.id DESC LIMIT 1', student.id, sid);
    let results = [];
    if (latestExam) {
      results = q.all('SELECT sub.name subject, g.score FROM grades g JOIN subjects sub ON sub.id=g.subject_id WHERE g.exam_id=? AND g.student_id=? ORDER BY sub.name', latestExam.id, student.id);
    }
    return res.page('app/dashboard-student', { title: 'My dashboard', student, att, fees, latestExam, results, announcements, events });
  }

  if (role === 'teacher') {
    const classes = visibleClasses(req);
    const marked = new Set(q.all('SELECT DISTINCT class_id FROM attendance WHERE school_id=? AND date=?', sid, today()).map((r) => r.class_id));
    const subjects = q.all(
      `SELECT cs.*, sub.name subject_name, c.name class_name, c.section FROM class_subjects cs
       JOIN subjects sub ON sub.id=cs.subject_id JOIN classes c ON c.id=cs.class_id
       WHERE cs.school_id=? AND cs.teacher_id=? ORDER BY c.name, sub.name`, sid, req.user.teacher_id);
    return res.page('app/dashboard-teacher', { title: 'Dashboard', classes, marked, subjects, announcements, events });
  }

  // admin
  const stats = {
    students: q.get("SELECT COUNT(*) n FROM students WHERE school_id=? AND status='active'", sid).n,
    teachers: q.get("SELECT COUNT(*) n FROM teachers WHERE school_id=? AND status!='inactive'", sid).n,
    classes: q.get('SELECT COUNT(*) n FROM classes WHERE school_id=?', sid).n,
    subjects: q.get('SELECT COUNT(*) n FROM subjects WHERE school_id=?', sid).n,
  };
  const attToday = q.get(`SELECT COUNT(*) total, SUM(status IN ('present','late')) present FROM attendance WHERE school_id=? AND date=?`, sid, today());
  const expected = q.get(
    `SELECT COALESCE(SUM(fi.amount),0) t FROM students s JOIN fee_items fi ON fi.school_id=s.school_id
       AND fi.term=? AND fi.academic_year=? AND (fi.class_id IS NULL OR fi.class_id=s.class_id)
     WHERE s.school_id=? AND s.status='active'`, req.school.current_term, req.school.academic_year, sid).t;
  const collected = q.get('SELECT COALESCE(SUM(amount),0) t FROM payments WHERE school_id=? AND term=? AND academic_year=?', sid, req.school.current_term, req.school.academic_year).t;
  const gender = q.all("SELECT COALESCE(gender,'Unspecified') g, COUNT(*) n FROM students WHERE school_id=? AND status='active' GROUP BY g", sid);
  const perClass = q.all(
    `SELECT c.name || COALESCE(' ' || c.section,'') label, COUNT(s.id) n FROM classes c
     LEFT JOIN students s ON s.class_id=c.id AND s.status='active' WHERE c.school_id=? GROUP BY c.id ORDER BY c.name, c.section`, sid);
  const attTrend = q.all(
    `SELECT date, ROUND(100.0*SUM(status IN ('present','late'))/COUNT(*),1) pct FROM attendance
     WHERE school_id=? AND date >= date('now','-14 day') GROUP BY date ORDER BY date`, sid);
  const activity = q.all('SELECT a.*, u.name user_name FROM activity_log a LEFT JOIN users u ON u.id=a.user_id WHERE a.school_id=? ORDER BY a.id DESC LIMIT 8', sid);
  const onboarding = {
    classes: stats.classes > 0, subjects: stats.subjects > 0, teachers: stats.teachers > 0, students: stats.students > 0,
    fees: !!q.get('SELECT id FROM fee_items WHERE school_id=? LIMIT 1', sid),
  };
  res.page('app/dashboard-admin', { title: 'Dashboard', stats, attToday, expected, collected, gender, perClass, attTrend, activity, announcements, events, onboarding });
});

// ---------- Announcements ----------
router.get('/announcements', (req, res) => {
  const list = q.all(`SELECT a.*, u.name author FROM announcements a LEFT JOIN users u ON u.id=a.created_by
    WHERE a.school_id=? AND ${audienceFilter(req.user.role)} ORDER BY a.pinned DESC, a.id DESC`, req.school.id);
  res.page('app/announcements', { title: 'Announcements', list });
});

router.post('/announcements', adminOnly, (req, res) => {
  const { title, body, audience } = req.body;
  if (!title || !body || !['all', 'teachers', 'students'].includes(audience)) {
    flash(req, 'error', 'Title, message and audience are required.');
  } else {
    q.run('INSERT INTO announcements (school_id,title,body,audience,pinned,created_by) VALUES (?,?,?,?,?,?)',
      req.school.id, title.trim(), body.trim(), audience, req.body.pinned ? 1 : 0, req.user.id);
    logActivity(req.school.id, req.user.id, `Posted announcement "${title.trim()}"`);
    flash(req, 'success', 'Announcement published.');
  }
  res.redirect('/app/announcements');
});

router.post('/announcements/:id/delete', adminOnly, (req, res) => {
  q.run('DELETE FROM announcements WHERE id=? AND school_id=?', req.params.id, req.school.id);
  flash(req, 'success', 'Announcement deleted.');
  res.redirect('/app/announcements');
});

// ---------- Events / calendar ----------
router.get('/events', (req, res) => {
  const upcoming = q.all('SELECT * FROM events WHERE school_id=? AND date >= ? ORDER BY date', req.school.id, today());
  const past = q.all('SELECT * FROM events WHERE school_id=? AND date < ? ORDER BY date DESC LIMIT 20', req.school.id, today());
  res.page('app/events', { title: 'School calendar', upcoming, past });
});

router.post('/events', adminOnly, (req, res) => {
  if (!req.body.title || !/^\d{4}-\d{2}-\d{2}$/.test(req.body.date || '')) {
    flash(req, 'error', 'Event title and date are required.');
  } else {
    q.run('INSERT INTO events (school_id,title,date,description) VALUES (?,?,?,?)', req.school.id, req.body.title.trim(), req.body.date, req.body.description);
    flash(req, 'success', 'Event added to the calendar.');
  }
  res.redirect('/app/events');
});

router.post('/events/:id/delete', adminOnly, (req, res) => {
  q.run('DELETE FROM events WHERE id=? AND school_id=?', req.params.id, req.school.id);
  res.redirect('/app/events');
});

// ---------- School settings ----------
router.get('/settings', adminOnly, (req, res) => {
  const admins = q.all("SELECT id,name,email,last_login,active FROM users WHERE school_id=? AND role='admin' ORDER BY id", req.school.id);
  res.page('app/settings', { title: 'School settings', admins });
});

router.post('/settings', adminOnly, (req, res) => {
  const f = req.body;
  if (!f.name || !f.academic_year || !f.current_term) {
    flash(req, 'error', 'School name, academic year and term are required.');
    return res.redirect('/app/settings');
  }
  q.run(`UPDATE schools SET name=?, email=?, phone=?, address=?, motto=?, country=?, currency=?, academic_year=?, current_term=? WHERE id=?`,
    f.name.trim(), f.email, f.phone, f.address, f.motto, f.country, (f.currency || 'USD').toUpperCase().slice(0, 3), f.academic_year.trim(), f.current_term.trim(), req.school.id);
  logActivity(req.school.id, req.user.id, 'Updated school settings');
  flash(req, 'success', 'Settings saved.');
  res.redirect('/app/settings');
});

router.post('/settings/admins', adminOnly, (req, res) => {
  const { name, email, password } = req.body;
  if (!name || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email || '') || !password || password.length < 8) {
    flash(req, 'error', 'Name, valid email and an 8+ character password are required.');
  } else if (q.get('SELECT id FROM users WHERE email=?', email)) {
    flash(req, 'error', 'That email is already in use.');
  } else {
    q.run('INSERT INTO users (school_id,name,email,password_hash,role) VALUES (?,?,?,?,?)', req.school.id, name.trim(), email.trim(), bcrypt.hashSync(password, 10), 'admin');
    logActivity(req.school.id, req.user.id, `Added administrator ${name.trim()}`);
    flash(req, 'success', 'Administrator added.');
  }
  res.redirect('/app/settings');
});

router.post('/settings/admins/:id/toggle', adminOnly, (req, res) => {
  if (Number(req.params.id) === req.user.id) {
    flash(req, 'error', "You can't deactivate your own account.");
  } else {
    q.run("UPDATE users SET active = 1 - active WHERE id=? AND school_id=? AND role='admin'", req.params.id, req.school.id);
    flash(req, 'success', 'Administrator status updated.');
  }
  res.redirect('/app/settings');
});

// ---------- Billing / subscription ----------
router.get('/billing', adminOnly, (req, res) => {
  const plans = q.all('SELECT * FROM plans ORDER BY price_monthly');
  const usage = {
    students: q.get("SELECT COUNT(*) n FROM students WHERE school_id=? AND status='active'", req.school.id).n,
    teachers: q.get('SELECT COUNT(*) n FROM teachers WHERE school_id=?', req.school.id).n,
  };
  res.page('app/billing', { title: 'Plan & billing', plans, usage });
});

router.post('/billing', adminOnly, (req, res) => {
  const plan = q.get('SELECT * FROM plans WHERE code=?', req.body.plan);
  if (!plan) return res.redirect('/app/billing');
  const students = q.get("SELECT COUNT(*) n FROM students WHERE school_id=? AND status='active'", req.school.id).n;
  const teachers = q.get('SELECT COUNT(*) n FROM teachers WHERE school_id=?', req.school.id).n;
  if ((plan.student_limit != null && students > plan.student_limit) || (plan.teacher_limit != null && teachers > plan.teacher_limit)) {
    flash(req, 'error', `Your current usage exceeds the ${plan.name} plan limits.`);
  } else {
    q.run('UPDATE schools SET plan=? WHERE id=?', plan.code, req.school.id);
    logActivity(req.school.id, req.user.id, `Changed subscription to ${plan.name}`);
    flash(req, 'success', `You're now on the ${plan.name} plan.`);
  }
  res.redirect('/app/billing');
});

// ---------- My account ----------
router.get('/account', (req, res) => res.page('app/account', { title: 'My account' }));

router.post('/account/password', (req, res) => {
  const u = q.get('SELECT password_hash FROM users WHERE id=?', req.user.id);
  const { current, password, confirm } = req.body;
  if (!bcrypt.compareSync(current || '', u.password_hash)) flash(req, 'error', 'Current password is incorrect.');
  else if (!password || password.length < 8) flash(req, 'error', 'New password must be at least 8 characters.');
  else if (password !== confirm) flash(req, 'error', 'New passwords do not match.');
  else {
    q.run('UPDATE users SET password_hash=? WHERE id=?', bcrypt.hashSync(password, 10), req.user.id);
    flash(req, 'success', 'Password changed.');
  }
  res.redirect('/app/account');
});

module.exports = router;
