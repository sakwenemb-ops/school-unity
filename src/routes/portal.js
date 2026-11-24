// Student self-service portal.
const express = require('express');
const { q } = require('../db');
const { requireRole } = require('../middleware');
const { feeSummary, gradeFor } = require('../helpers');
const { reportCard } = require('./academics');

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
  res.page('app/portal/fees', { title: 'My fees', s, fees, items, payments });
});

module.exports = router;
