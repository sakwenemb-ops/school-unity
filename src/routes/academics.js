const express = require('express');
const { q, logActivity } = require('../db');
const { flash, requireRole } = require('../middleware');
const { isAdmin, visibleClasses, canAccessClass, canGradeSubject } = require('../access');
const { today, gradeFor } = require('../helpers');

const router = express.Router();
const adminOnly = requireRole('admin');
const staffOnly = requireRole('admin', 'teacher');
const notFound = (res, what) => res.status(404).render('error', { title: 'Not found', message: `${what} not found.` });

const teachersOf = (req) => q.all("SELECT id, first_name || ' ' || last_name name FROM teachers WHERE school_id=? AND status!='inactive' ORDER BY first_name", req.school.id);
const teacherBelongs = (req, id) => !id || !!q.get('SELECT id FROM teachers WHERE id=? AND school_id=?', id, req.school.id);

// ================= CLASSES =================
router.get('/classes', staffOnly, (req, res) => {
  res.page('app/classes/index', { title: 'Classes', classes: visibleClasses(req), teachers: isAdmin(req) ? teachersOf(req) : [] });
});

router.post('/classes', adminOnly, (req, res) => {
  const f = req.body;
  if (!f.name?.trim()) flash(req, 'error', 'Class name is required.');
  else if (!teacherBelongs(req, f.class_teacher_id)) flash(req, 'error', 'Invalid teacher.');
  else {
    q.run('INSERT INTO classes (school_id,name,section,capacity,room,class_teacher_id) VALUES (?,?,?,?,?,?)',
      req.school.id, f.name.trim(), f.section?.trim(), f.capacity ? parseInt(f.capacity, 10) : null, f.room, f.class_teacher_id);
    logActivity(req.school.id, req.user.id, `Created class ${f.name.trim()} ${f.section || ''}`.trim());
    flash(req, 'success', 'Class created.');
  }
  res.redirect('/app/classes');
});

router.get('/classes/:id', staffOnly, (req, res) => {
  if (!canAccessClass(req, req.params.id)) return notFound(res, 'Class');
  const c = q.get("SELECT c.*, t.first_name || ' ' || t.last_name teacher_name FROM classes c LEFT JOIN teachers t ON t.id=c.class_teacher_id WHERE c.id=? AND c.school_id=?", req.params.id, req.school.id);
  const students = q.all("SELECT * FROM students WHERE class_id=? AND school_id=? AND status='active' ORDER BY first_name, last_name", c.id, req.school.id);
  const subjects = q.all(`SELECT cs.id, cs.subject_id, sub.name, sub.code, t.first_name || ' ' || t.last_name teacher_name, cs.teacher_id
    FROM class_subjects cs JOIN subjects sub ON sub.id=cs.subject_id LEFT JOIN teachers t ON t.id=cs.teacher_id
    WHERE cs.class_id=? ORDER BY sub.name`, c.id);
  const allSubjects = q.all('SELECT * FROM subjects WHERE school_id=? ORDER BY name', req.school.id).filter((s) => !subjects.find((x) => x.subject_id === s.id));
  const promoteTargets = q.all("SELECT id, name || COALESCE(' ' || section,'') label FROM classes WHERE school_id=? AND id!=? ORDER BY name, section", req.school.id, c.id);
  res.page('app/classes/show', { title: `${c.name} ${c.section || ''}`.trim(), c, students, subjects, allSubjects, promoteTargets, teachers: isAdmin(req) ? teachersOf(req) : [] });
});

router.post('/classes/:id', adminOnly, (req, res) => {
  const f = req.body;
  if (!f.name?.trim() || !teacherBelongs(req, f.class_teacher_id)) flash(req, 'error', 'Class name is required.');
  else {
    q.run('UPDATE classes SET name=?, section=?, capacity=?, room=?, class_teacher_id=? WHERE id=? AND school_id=?',
      f.name.trim(), f.section?.trim(), f.capacity ? parseInt(f.capacity, 10) : null, f.room, f.class_teacher_id, req.params.id, req.school.id);
    flash(req, 'success', 'Class updated.');
  }
  res.redirect('/app/classes/' + req.params.id);
});

router.post('/classes/:id/delete', adminOnly, (req, res) => {
  const c = q.get('SELECT * FROM classes WHERE id=? AND school_id=?', req.params.id, req.school.id);
  if (c) {
    q.run('DELETE FROM classes WHERE id=? AND school_id=?', c.id, req.school.id);
    logActivity(req.school.id, req.user.id, `Deleted class ${c.name} ${c.section || ''}`.trim());
    flash(req, 'success', 'Class deleted. Its students are now unassigned.');
  }
  res.redirect('/app/classes');
});

router.post('/classes/:id/subjects', adminOnly, (req, res) => {
  const c = q.get('SELECT id FROM classes WHERE id=? AND school_id=?', req.params.id, req.school.id);
  const sub = q.get('SELECT id FROM subjects WHERE id=? AND school_id=?', req.body.subject_id, req.school.id);
  if (!c || !sub || !teacherBelongs(req, req.body.teacher_id)) flash(req, 'error', 'Choose a valid subject.');
  else {
    q.run('INSERT INTO class_subjects (school_id,class_id,subject_id,teacher_id) VALUES (?,?,?,?) ON CONFLICT(class_id,subject_id) DO UPDATE SET teacher_id=excluded.teacher_id',
      req.school.id, c.id, sub.id, req.body.teacher_id);
    flash(req, 'success', 'Subject assigned to class.');
  }
  res.redirect('/app/classes/' + req.params.id);
});

router.post('/classes/:id/subjects/:csid', adminOnly, (req, res) => {
  if (!teacherBelongs(req, req.body.teacher_id)) flash(req, 'error', 'Invalid teacher.');
  else q.run('UPDATE class_subjects SET teacher_id=? WHERE id=? AND school_id=?', req.body.teacher_id, req.params.csid, req.school.id);
  res.redirect('/app/classes/' + req.params.id);
});

router.post('/classes/:id/subjects/:csid/delete', adminOnly, (req, res) => {
  q.run('DELETE FROM class_subjects WHERE id=? AND school_id=?', req.params.csid, req.school.id);
  flash(req, 'success', 'Subject removed from class.');
  res.redirect('/app/classes/' + req.params.id);
});

// Promote all active students of a class to another class (end of year).
router.post('/classes/:id/promote', adminOnly, (req, res) => {
  const from = q.get('SELECT * FROM classes WHERE id=? AND school_id=?', req.params.id, req.school.id);
  if (!from) return res.redirect('/app/classes');
  if (req.body.target === 'graduate') {
    const r = q.run("UPDATE students SET status='graduated' WHERE class_id=? AND school_id=? AND status='active'", from.id, req.school.id);
    flash(req, 'success', `${r.changes} students marked as graduated.`);
  } else {
    const to = q.get('SELECT * FROM classes WHERE id=? AND school_id=?', req.body.target, req.school.id);
    if (!to || to.id === from.id) { flash(req, 'error', 'Choose a different target class.'); return res.redirect('/app/classes/' + from.id); }
    const r = q.run("UPDATE students SET class_id=? WHERE class_id=? AND school_id=? AND status='active'", to.id, from.id, req.school.id);
    flash(req, 'success', `${r.changes} students promoted to ${to.name} ${to.section || ''}.`);
  }
  logActivity(req.school.id, req.user.id, `Promoted students from ${from.name} ${from.section || ''}`.trim());
  res.redirect('/app/classes/' + from.id);
});

// ================= SUBJECTS =================
router.get('/subjects', staffOnly, (req, res) => {
  const subjects = q.all(`SELECT s.*, (SELECT COUNT(*) FROM class_subjects cs WHERE cs.subject_id=s.id) class_count
    FROM subjects s WHERE s.school_id=? ORDER BY s.name`, req.school.id);
  res.page('app/subjects', { title: 'Subjects', subjects });
});

router.post('/subjects', adminOnly, (req, res) => {
  if (!req.body.name?.trim()) flash(req, 'error', 'Subject name is required.');
  else if (q.get('SELECT id FROM subjects WHERE school_id=? AND LOWER(name)=LOWER(?)', req.school.id, req.body.name.trim())) flash(req, 'error', 'That subject already exists.');
  else {
    q.run('INSERT INTO subjects (school_id,name,code) VALUES (?,?,?)', req.school.id, req.body.name.trim(), req.body.code?.trim().toUpperCase());
    flash(req, 'success', 'Subject added.');
  }
  res.redirect('/app/subjects');
});

router.post('/subjects/:id', adminOnly, (req, res) => {
  if (req.body.name?.trim()) q.run('UPDATE subjects SET name=?, code=? WHERE id=? AND school_id=?', req.body.name.trim(), req.body.code?.trim().toUpperCase(), req.params.id, req.school.id);
  res.redirect('/app/subjects');
});

router.post('/subjects/:id/delete', adminOnly, (req, res) => {
  q.run('DELETE FROM subjects WHERE id=? AND school_id=?', req.params.id, req.school.id);
  flash(req, 'success', 'Subject deleted.');
  res.redirect('/app/subjects');
});

// ================= ATTENDANCE =================
const ATT = ['present', 'absent', 'late', 'excused'];

router.get('/attendance', staffOnly, (req, res) => {
  const classes = visibleClasses(req);
  const date = /^\d{4}-\d{2}-\d{2}$/.test(req.query.date || '') ? req.query.date : today();
  const classId = req.query.class_id || (classes[0] && classes[0].id);
  let students = [];
  let cls = null;
  if (classId && canAccessClass(req, classId)) {
    cls = classes.find((c) => c.id === Number(classId));
    students = q.all(`SELECT s.id, s.admission_no, s.first_name, s.last_name, a.status FROM students s
      LEFT JOIN attendance a ON a.student_id=s.id AND a.date=? WHERE s.class_id=? AND s.school_id=? AND s.status='active' ORDER BY s.first_name, s.last_name`,
      date, classId, req.school.id);
  }
  const summary = q.all(`SELECT c.id, c.name, c.section, COUNT(a.id) marked, SUM(a.status IN ('present','late')) present
    FROM classes c LEFT JOIN attendance a ON a.class_id=c.id AND a.date=? WHERE c.school_id=? GROUP BY c.id ORDER BY c.name, c.section`, date, req.school.id)
    .filter((r) => classes.find((c) => c.id === r.id));
  res.page('app/attendance/index', { title: 'Attendance', classes, cls, students, date, summary });
});

router.post('/attendance', staffOnly, (req, res) => {
  const { class_id, date } = req.body;
  if (!canAccessClass(req, class_id) || !/^\d{4}-\d{2}-\d{2}$/.test(date || '')) {
    flash(req, 'error', 'Invalid class or date.');
    return res.redirect('/app/attendance');
  }
  if (date > today()) { flash(req, 'error', "You can't mark attendance for a future date."); return res.redirect(`/app/attendance?class_id=${class_id}&date=${date}`); }
  const students = q.all("SELECT id FROM students WHERE class_id=? AND school_id=? AND status='active'", class_id, req.school.id);
  let n = 0;
  q.tx(() => {
    for (const s of students) {
      const st = req.body['s_' + s.id];
      if (!ATT.includes(st)) continue;
      q.run(`INSERT INTO attendance (school_id,student_id,class_id,date,status,marked_by) VALUES (?,?,?,?,?,?)
             ON CONFLICT(student_id,date) DO UPDATE SET status=excluded.status, class_id=excluded.class_id, marked_by=excluded.marked_by`,
        req.school.id, s.id, class_id, date, st, req.user.id);
      n++;
    }
  });
  flash(req, 'success', `Attendance saved for ${n} students.`);
  res.redirect(`/app/attendance?class_id=${class_id}&date=${date}`);
});

router.get('/attendance/report', staffOnly, (req, res) => {
  const classes = visibleClasses(req);
  const classId = req.query.class_id || (classes[0] && classes[0].id);
  const to = /^\d{4}-\d{2}-\d{2}$/.test(req.query.to || '') ? req.query.to : today();
  const from = /^\d{4}-\d{2}-\d{2}$/.test(req.query.from || '') ? req.query.from : new Date(Date.now() - 29 * 86400000).toISOString().slice(0, 10);
  let rows = [];
  if (classId && canAccessClass(req, classId)) {
    rows = q.all(`SELECT s.id, s.admission_no, s.first_name, s.last_name, COUNT(a.id) total,
        SUM(a.status='present') present, SUM(a.status='absent') absent, SUM(a.status='late') late, SUM(a.status='excused') excused
      FROM students s LEFT JOIN attendance a ON a.student_id=s.id AND a.date BETWEEN ? AND ?
      WHERE s.class_id=? AND s.school_id=? AND s.status='active' GROUP BY s.id ORDER BY s.first_name, s.last_name`, from, to, classId, req.school.id);
  }
  res.page('app/attendance/report', { title: 'Attendance report', classes, classId: Number(classId), from, to, rows });
});

// ================= EXAMS & GRADES =================
router.get('/exams', staffOnly, (req, res) => {
  const exams = q.all(`SELECT e.*, (SELECT COUNT(DISTINCT student_id) FROM grades g WHERE g.exam_id=e.id) graded
    FROM exams e WHERE e.school_id=? ORDER BY e.academic_year DESC, e.id DESC`, req.school.id);
  res.page('app/exams/index', { title: 'Exams & results', exams });
});

router.post('/exams', adminOnly, (req, res) => {
  const f = req.body;
  const max = Number(f.max_score) || 100;
  if (!f.name?.trim() || !f.term?.trim() || !f.academic_year?.trim()) flash(req, 'error', 'Name, term and year are required.');
  else {
    q.run('INSERT INTO exams (school_id,name,term,academic_year,start_date,max_score) VALUES (?,?,?,?,?,?)',
      req.school.id, f.name.trim(), f.term.trim(), f.academic_year.trim(), f.start_date, max > 0 ? max : 100);
    logActivity(req.school.id, req.user.id, `Created exam ${f.name.trim()}`);
    flash(req, 'success', 'Exam created. You can now enter marks.');
  }
  res.redirect('/app/exams');
});

router.post('/exams/:id/delete', adminOnly, (req, res) => {
  q.run('DELETE FROM exams WHERE id=? AND school_id=?', req.params.id, req.school.id);
  flash(req, 'success', 'Exam and its marks deleted.');
  res.redirect('/app/exams');
});

const findExam = (req) => q.get('SELECT * FROM exams WHERE id=? AND school_id=?', req.params.id, req.school.id);

router.get('/exams/:id', staffOnly, (req, res) => {
  const exam = findExam(req);
  if (!exam) return notFound(res, 'Exam');
  const classes = visibleClasses(req).map((c) => {
    const subs = q.all(`SELECT cs.subject_id, sub.name, cs.teacher_id,
        (SELECT COUNT(*) FROM grades g JOIN students s ON s.id=g.student_id WHERE g.exam_id=? AND g.subject_id=cs.subject_id AND s.class_id=cs.class_id) entered
      FROM class_subjects cs JOIN subjects sub ON sub.id=cs.subject_id WHERE cs.class_id=? ORDER BY sub.name`, exam.id, c.id)
      .filter((s) => canGradeSubject(req, c.id, s.subject_id));
    return { ...c, subjects: subs };
  });
  res.page('app/exams/show', { title: exam.name, exam, classes });
});

router.get('/exams/:id/marks', staffOnly, (req, res) => {
  const exam = findExam(req);
  if (!exam) return notFound(res, 'Exam');
  const { class_id, subject_id } = req.query;
  if (!canAccessClass(req, class_id) || !canGradeSubject(req, class_id, subject_id)) return res.status(403).render('error', { title: 'Access denied', message: 'You cannot enter marks for this class/subject.' });
  const cls = q.get('SELECT * FROM classes WHERE id=? AND school_id=?', class_id, req.school.id);
  const subject = q.get('SELECT * FROM subjects WHERE id=? AND school_id=?', subject_id, req.school.id);
  if (!cls || !subject) return notFound(res, 'Class or subject');
  const students = q.all(`SELECT s.id, s.admission_no, s.first_name, s.last_name, g.score, g.remark FROM students s
    LEFT JOIN grades g ON g.student_id=s.id AND g.exam_id=? AND g.subject_id=?
    WHERE s.class_id=? AND s.school_id=? AND s.status='active' ORDER BY s.first_name, s.last_name`, exam.id, subject.id, cls.id, req.school.id);
  res.page('app/exams/marks', { title: 'Enter marks', exam, cls, subject, students });
});

router.post('/exams/:id/marks', staffOnly, (req, res) => {
  const exam = findExam(req);
  if (!exam) return notFound(res, 'Exam');
  const { class_id, subject_id } = req.body;
  if (!canAccessClass(req, class_id) || !canGradeSubject(req, class_id, subject_id) || !q.get('SELECT id FROM subjects WHERE id=? AND school_id=?', subject_id, req.school.id)) {
    return res.status(403).render('error', { title: 'Access denied', message: 'You cannot enter marks for this class/subject.' });
  }
  const students = q.all("SELECT id FROM students WHERE class_id=? AND school_id=? AND status='active'", class_id, req.school.id);
  let saved = 0; let invalid = 0;
  q.tx(() => {
    for (const s of students) {
      const raw = req.body['score_' + s.id];
      if (raw === undefined || raw === '') {
        q.run('DELETE FROM grades WHERE exam_id=? AND student_id=? AND subject_id=?', exam.id, s.id, subject_id);
        continue;
      }
      const score = Number(raw);
      if (isNaN(score) || score < 0 || score > exam.max_score) { invalid++; continue; }
      q.run(`INSERT INTO grades (school_id,exam_id,student_id,subject_id,score,remark) VALUES (?,?,?,?,?,?)
             ON CONFLICT(exam_id,student_id,subject_id) DO UPDATE SET score=excluded.score, remark=excluded.remark`,
        req.school.id, exam.id, s.id, subject_id, score, req.body['remark_' + s.id]);
      saved++;
    }
  });
  flash(req, invalid ? 'error' : 'success', `Saved ${saved} marks.` + (invalid ? ` ${invalid} were out of range (0–${exam.max_score}) and skipped.` : ''));
  res.redirect(`/app/exams/${exam.id}/marks?class_id=${class_id}&subject_id=${subject_id}`);
});

// Class broadsheet: students × subjects with totals and positions.
function broadsheet(schoolId, exam, classId) {
  const subjects = q.all('SELECT sub.id, sub.name, sub.code FROM class_subjects cs JOIN subjects sub ON sub.id=cs.subject_id WHERE cs.class_id=? ORDER BY sub.name', classId);
  const students = q.all("SELECT id, admission_no, first_name, last_name FROM students WHERE class_id=? AND school_id=? AND status='active' ORDER BY first_name", classId, schoolId);
  const grades = q.all('SELECT g.student_id, g.subject_id, g.score FROM grades g JOIN students s ON s.id=g.student_id WHERE g.exam_id=? AND s.class_id=?', exam.id, classId);
  const map = {};
  for (const g of grades) (map[g.student_id] ||= {})[g.subject_id] = g.score;
  const rows = students.map((s) => {
    const scores = map[s.id] || {};
    const vals = Object.values(scores);
    const total = vals.reduce((a, b) => a + b, 0);
    const avg = vals.length ? total / vals.length : null;
    return { ...s, scores, total, avg, pct: avg == null ? null : (avg / exam.max_score) * 100 };
  });
  const ranked = rows.filter((r) => r.avg != null).sort((a, b) => b.avg - a.avg);
  ranked.forEach((r, i) => { r.position = i > 0 && ranked[i - 1].avg === r.avg ? ranked[i - 1].position : i + 1; });
  const subjectAvg = Object.fromEntries(subjects.map((sub) => {
    const v = rows.map((r) => r.scores[sub.id]).filter((x) => x != null);
    return [sub.id, v.length ? v.reduce((a, b) => a + b, 0) / v.length : null];
  }));
  return { subjects, rows, ranked: ranked.length, subjectAvg };
}

router.get('/exams/:id/results', staffOnly, (req, res) => {
  const exam = findExam(req);
  if (!exam) return notFound(res, 'Exam');
  const classes = visibleClasses(req);
  const classId = req.query.class_id || (classes[0] && classes[0].id);
  let data = null; let cls = null;
  if (classId && canAccessClass(req, classId)) {
    cls = classes.find((c) => c.id === Number(classId));
    data = broadsheet(req.school.id, exam, classId);
  }
  res.page('app/exams/results', { title: `${exam.name} results`, exam, classes, cls, data, gradeFor });
});

// Printable report card (staff for any visible student; student portal uses /portal route)
function reportCard(req, studentId, examId) {
  const student = q.get('SELECT s.*, c.name class_name, c.section FROM students s LEFT JOIN classes c ON c.id=s.class_id WHERE s.id=? AND s.school_id=?', studentId, req.school.id);
  const exam = q.get('SELECT * FROM exams WHERE id=? AND school_id=?', examId, req.school.id);
  if (!student || !exam) return null;
  const grades = q.all('SELECT sub.name subject, sub.code, g.score, g.remark FROM grades g JOIN subjects sub ON sub.id=g.subject_id WHERE g.exam_id=? AND g.student_id=? ORDER BY sub.name', exam.id, student.id);
  let position = null; let classSize = null;
  if (student.class_id) {
    const b = broadsheet(req.school.id, exam, student.class_id);
    const me = b.rows.find((r) => r.id === student.id);
    position = me && me.position; classSize = b.ranked;
  }
  const att = q.get(`SELECT COUNT(*) total, SUM(status IN ('present','late')) present FROM attendance WHERE student_id=?`, student.id);
  return { student, exam, grades, position, classSize, att, gradeFor };
}

router.get('/students/:sid/report/:eid', staffOnly, (req, res) => {
  if (!isAdmin(req)) {
    const s = q.get('SELECT class_id FROM students WHERE id=? AND school_id=?', req.params.sid, req.school.id);
    if (!s || !canAccessClass(req, s.class_id)) return notFound(res, 'Report');
  }
  const data = reportCard(req, req.params.sid, req.params.eid);
  if (!data) return notFound(res, 'Report');
  res.render('app/report-card', data);
});

module.exports = router;
module.exports.reportCard = reportCard;
