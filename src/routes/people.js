const express = require('express');
const bcrypt = require('bcryptjs');
const { q, logActivity } = require('../db');
const { flash, requireRole } = require('../middleware');
const { isAdmin, visibleClasses, teacherClassIds, canAccessClass } = require('../access');
const { nextCode, feeSummary, toCsv, gradeFor, today } = require('../helpers');

const router = express.Router();
const adminOnly = requireRole('admin');
const staffOnly = requireRole('admin', 'teacher');
const GENDERS = ['Male', 'Female'];
const STUDENT_STATUS = ['active', 'graduated', 'transferred', 'suspended'];
const TEACHER_STATUS = ['active', 'on_leave', 'inactive'];
const validEmail = (e) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e || '');
const validDate = (d) => !d || /^\d{4}-\d{2}-\d{2}$/.test(d);

// ================= STUDENTS =================
function studentScope(req) {
  if (isAdmin(req)) return { sql: '', params: [] };
  const ids = teacherClassIds(req);
  if (!ids.length) return { sql: ' AND 0', params: [] };
  return { sql: ` AND s.class_id IN (${ids.map(() => '?').join(',')})`, params: ids };
}

function findStudent(req, id) {
  const scope = studentScope(req);
  return q.get(
    `SELECT s.*, c.name class_name, c.section FROM students s LEFT JOIN classes c ON c.id=s.class_id
     WHERE s.id=? AND s.school_id=?${scope.sql}`, id, req.school.id, ...scope.params);
}

function studentQuery(req) {
  const { q: term, class_id, status, gender } = req.query;
  const scope = studentScope(req);
  let where = 's.school_id=?' + scope.sql;
  const params = [req.school.id, ...scope.params];
  if (term) {
    where += " AND (s.first_name || ' ' || s.last_name LIKE ? OR s.admission_no LIKE ? OR s.guardian_name LIKE ? OR s.guardian_phone LIKE ?)";
    params.push(`%${term}%`, `%${term}%`, `%${term}%`, `%${term}%`);
  }
  if (class_id) { where += ' AND s.class_id=?'; params.push(class_id); }
  if (status) { where += ' AND s.status=?'; params.push(status); } else { where += " AND s.status='active'"; }
  if (gender) { where += ' AND s.gender=?'; params.push(gender); }
  return { where, params };
}

function validateStudent(f) {
  const errors = [];
  if (!f.first_name?.trim() || !f.last_name?.trim()) errors.push('First and last name are required.');
  if (f.gender && !GENDERS.includes(f.gender)) errors.push('Invalid gender.');
  if (!validDate(f.dob) || !validDate(f.admission_date)) errors.push('Dates must be valid.');
  if (f.guardian_email && !validEmail(f.guardian_email)) errors.push('Guardian email is invalid.');
  if (f.status && !STUDENT_STATUS.includes(f.status)) errors.push('Invalid status.');
  return errors;
}

function checkStudentLimit(req) {
  const lim = req.school.student_limit;
  if (lim == null) return null;
  const n = q.get("SELECT COUNT(*) n FROM students WHERE school_id=? AND status='active'", req.school.id).n;
  return n >= lim ? `Your ${req.school.plan_name} plan allows up to ${lim} active students. Upgrade your plan to add more.` : null;
}

function classBelongs(req, classId) {
  return !classId || !!q.get('SELECT id FROM classes WHERE id=? AND school_id=?', classId, req.school.id);
}

router.get('/students', staffOnly, (req, res) => {
  const { where, params } = studentQuery(req);
  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  const per = 25;
  const total = q.get(`SELECT COUNT(*) n FROM students s WHERE ${where}`, ...params).n;
  const students = q.all(
    `SELECT s.*, c.name class_name, c.section FROM students s LEFT JOIN classes c ON c.id=s.class_id
     WHERE ${where} ORDER BY s.first_name, s.last_name LIMIT ? OFFSET ?`, ...params, per, (page - 1) * per);
  res.page('app/students/index', { title: 'Students', students, classes: visibleClasses(req), total, page, pages: Math.ceil(total / per) || 1 });
});

router.get('/students/export.csv', staffOnly, (req, res) => {
  const { where, params } = studentQuery(req);
  const rows = q.all(`SELECT s.*, c.name || COALESCE(' '||c.section,'') class_label FROM students s LEFT JOIN classes c ON c.id=s.class_id WHERE ${where} ORDER BY s.first_name`, ...params);
  const csv = toCsv(rows, [
    { label: 'Admission No', value: 'admission_no' }, { label: 'First name', value: 'first_name' }, { label: 'Last name', value: 'last_name' },
    { label: 'Gender', value: 'gender' }, { label: 'Date of birth', value: 'dob' }, { label: 'Class', value: 'class_label' },
    { label: 'Guardian', value: 'guardian_name' }, { label: 'Guardian phone', value: 'guardian_phone' }, { label: 'Guardian email', value: 'guardian_email' },
    { label: 'Status', value: 'status' }, { label: 'Admitted', value: 'admission_date' },
  ]);
  res.set('Content-Type', 'text/csv').attachment(`students-${today()}.csv`).send(csv);
});

router.get('/students/new', adminOnly, (req, res) => {
  const limit = checkStudentLimit(req);
  if (limit) { flash(req, 'error', limit); return res.redirect('/app/students'); }
  const admission_no = nextCode('students', 'admission_no', req.school.id, `ADM-${req.school.academic_year}-`);
  res.page('app/students/form', { title: 'Admit student', s: { admission_no, admission_date: today(), status: 'active', class_id: req.query.class_id }, classes: visibleClasses(req), errors: [] });
});

router.post('/students', adminOnly, (req, res) => {
  const f = req.body;
  const errors = validateStudent(f);
  const limit = checkStudentLimit(req);
  if (limit) errors.push(limit);
  if (!f.admission_no?.trim()) errors.push('Admission number is required.');
  else if (q.get('SELECT id FROM students WHERE school_id=? AND admission_no=?', req.school.id, f.admission_no.trim())) errors.push('Admission number already exists.');
  if (!classBelongs(req, f.class_id)) errors.push('Invalid class.');
  if (f.create_login) {
    if (!validEmail(f.login_email)) errors.push('Portal login needs a valid email.');
    else if (q.get('SELECT id FROM users WHERE email=?', f.login_email)) errors.push('Portal login email is already in use.');
    if (!f.login_password || f.login_password.length < 8) errors.push('Portal password must be at least 8 characters.');
  }
  if (errors.length) return res.status(422).page('app/students/form', { title: 'Admit student', s: f, classes: visibleClasses(req), errors });

  const id = q.tx(() => {
    const r = q.run(
      `INSERT INTO students (school_id,admission_no,first_name,last_name,gender,dob,class_id,guardian_name,guardian_phone,guardian_email,guardian_relation,address,medical_notes,admission_date,status)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      req.school.id, f.admission_no.trim(), f.first_name.trim(), f.last_name.trim(), f.gender, f.dob, f.class_id, f.guardian_name, f.guardian_phone,
      f.guardian_email, f.guardian_relation, f.address, f.medical_notes, f.admission_date || today(), 'active');
    const sid = Number(r.lastInsertRowid);
    if (f.create_login) {
      q.run('INSERT INTO users (school_id,name,email,password_hash,role,student_id) VALUES (?,?,?,?,?,?)',
        req.school.id, `${f.first_name.trim()} ${f.last_name.trim()}`, f.login_email.trim(), bcrypt.hashSync(f.login_password, 10), 'student', sid);
    }
    return sid;
  });
  logActivity(req.school.id, req.user.id, `Admitted student ${f.first_name} ${f.last_name} (${f.admission_no})`);
  flash(req, 'success', 'Student admitted successfully.');
  res.redirect('/app/students/' + id);
});

router.get('/students/import', adminOnly, (req, res) => {
  res.page('app/students/import', { title: 'Import students', classes: visibleClasses(req), result: null });
});

router.post('/students/import', adminOnly, (req, res) => {
  const text = (req.body.csv || '').trim();
  const lines = text.split(/\r?\n/).filter((l) => l.trim());
  const result = { added: 0, errors: [] };
  if (lines.length < 2) {
    result.errors.push('Paste a header row and at least one student row.');
    return res.page('app/students/import', { title: 'Import students', classes: visibleClasses(req), result });
  }
  const parse = (line) => {
    const out = []; let cur = ''; let inQ = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (inQ) { if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++; } else if (ch === '"') inQ = false; else cur += ch; }
      else if (ch === '"') inQ = true; else if (ch === ',') { out.push(cur.trim()); cur = ''; } else cur += ch;
    }
    out.push(cur.trim());
    return out;
  };
  const header = parse(lines[0]).map((h) => h.toLowerCase().replace(/\s+/g, '_'));
  const classes = q.all("SELECT id, LOWER(name || COALESCE(' ' || section,'')) label, LOWER(name) name FROM classes WHERE school_id=?", req.school.id);
  const lim = req.school.student_limit;
  let count = q.get("SELECT COUNT(*) n FROM students WHERE school_id=? AND status='active'", req.school.id).n;

  q.tx(() => {
    lines.slice(1).forEach((line, idx) => {
      const vals = parse(line);
      const r = Object.fromEntries(header.map((h, i) => [h, vals[i] || '']));
      const rowNo = idx + 2;
      if (lim != null && count >= lim) { result.errors.push(`Row ${rowNo}: plan limit of ${lim} students reached.`); return; }
      if (r.gender) r.gender = r.gender[0].toUpperCase() === 'F' ? 'Female' : r.gender[0].toUpperCase() === 'M' ? 'Male' : '';
      const errs = validateStudent(r);
      if (errs.length) { result.errors.push(`Row ${rowNo}: ${errs.join(' ')}`); return; }
      let classId = req.body.class_id || null;
      if (r.class) {
        const c = classes.find((x) => x.label === r.class.toLowerCase() || x.name === r.class.toLowerCase());
        if (!c) { result.errors.push(`Row ${rowNo}: class "${r.class}" not found.`); return; }
        classId = c.id;
      }
      let adm = r.admission_no;
      if (!adm) adm = nextCode('students', 'admission_no', req.school.id, `ADM-${req.school.academic_year}-`);
      if (q.get('SELECT id FROM students WHERE school_id=? AND admission_no=?', req.school.id, adm)) { result.errors.push(`Row ${rowNo}: admission no ${adm} exists.`); return; }
      q.run(`INSERT INTO students (school_id,admission_no,first_name,last_name,gender,dob,class_id,guardian_name,guardian_phone,guardian_email,address,admission_date)
             VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
        req.school.id, adm, r.first_name.trim(), r.last_name.trim(), r.gender, r.dob, classId, r.guardian_name, r.guardian_phone, r.guardian_email, r.address, today());
      result.added++; count++;
    });
  });
  if (result.added) logActivity(req.school.id, req.user.id, `Imported ${result.added} students`);
  res.page('app/students/import', { title: 'Import students', classes: visibleClasses(req), result });
});

router.get('/students/:id', staffOnly, (req, res) => {
  const s = findStudent(req, req.params.id);
  if (!s) return res.status(404).render('error', { title: 'Not found', message: 'Student not found.' });
  const att = q.get(`SELECT COUNT(*) total, SUM(status='present') present, SUM(status='absent') absent, SUM(status='late') late, SUM(status='excused') excused
                     FROM attendance WHERE student_id=? AND school_id=?`, s.id, req.school.id);
  const recentAtt = q.all('SELECT date,status FROM attendance WHERE student_id=? ORDER BY date DESC LIMIT 10', s.id);
  const exams = q.all(
    `SELECT e.id, e.name, e.term, e.academic_year, e.max_score, COUNT(g.id) subjects, AVG(g.score) avg
     FROM exams e JOIN grades g ON g.exam_id=e.id AND g.student_id=? WHERE e.school_id=? GROUP BY e.id ORDER BY e.id DESC`, s.id, req.school.id);
  const fees = feeSummary(req.school, s);
  const payments = q.all('SELECT * FROM payments WHERE student_id=? AND school_id=? ORDER BY paid_on DESC, id DESC LIMIT 10', s.id, req.school.id);
  const login = q.get("SELECT id,email,active,last_login FROM users WHERE student_id=? AND role='student'", s.id);
  res.page('app/students/show', { title: `${s.first_name} ${s.last_name}`, s, att, recentAtt, exams, fees, payments, login, gradeFor });
});

router.get('/students/:id/edit', adminOnly, (req, res) => {
  const s = findStudent(req, req.params.id);
  if (!s) return res.status(404).render('error', { title: 'Not found', message: 'Student not found.' });
  res.page('app/students/form', { title: 'Edit student', s, classes: visibleClasses(req), errors: [] });
});

router.post('/students/:id', adminOnly, (req, res) => {
  const s = findStudent(req, req.params.id);
  if (!s) return res.status(404).render('error', { title: 'Not found', message: 'Student not found.' });
  const f = req.body;
  const errors = validateStudent(f);
  if (!f.admission_no?.trim()) errors.push('Admission number is required.');
  else if (q.get('SELECT id FROM students WHERE school_id=? AND admission_no=? AND id!=?', req.school.id, f.admission_no.trim(), s.id)) errors.push('Admission number already exists.');
  if (!classBelongs(req, f.class_id)) errors.push('Invalid class.');
  if (errors.length) return res.status(422).page('app/students/form', { title: 'Edit student', s: { ...f, id: s.id }, classes: visibleClasses(req), errors });
  q.run(`UPDATE students SET admission_no=?, first_name=?, last_name=?, gender=?, dob=?, class_id=?, guardian_name=?, guardian_phone=?, guardian_email=?,
         guardian_relation=?, address=?, medical_notes=?, admission_date=?, status=? WHERE id=? AND school_id=?`,
    f.admission_no.trim(), f.first_name.trim(), f.last_name.trim(), f.gender, f.dob, f.class_id, f.guardian_name, f.guardian_phone, f.guardian_email,
    f.guardian_relation, f.address, f.medical_notes, f.admission_date, f.status || 'active', s.id, req.school.id);
  q.run("UPDATE users SET name=?, active=? WHERE student_id=? AND role='student'", `${f.first_name.trim()} ${f.last_name.trim()}`, (f.status || 'active') === 'active' ? 1 : 0, s.id);
  logActivity(req.school.id, req.user.id, `Updated student ${f.first_name} ${f.last_name}`);
  flash(req, 'success', 'Student updated.');
  res.redirect('/app/students/' + s.id);
});

router.post('/students/:id/account', adminOnly, (req, res) => {
  const s = findStudent(req, req.params.id);
  if (!s) return res.redirect('/app/students');
  const existing = q.get("SELECT id FROM users WHERE student_id=? AND role='student'", s.id);
  const { email, password } = req.body;
  if (!password || password.length < 8) flash(req, 'error', 'Password must be at least 8 characters.');
  else if (existing) {
    q.run('UPDATE users SET password_hash=?, active=1 WHERE id=?', bcrypt.hashSync(password, 10), existing.id);
    flash(req, 'success', 'Portal password reset.');
  } else if (!validEmail(email)) flash(req, 'error', 'Valid email is required.');
  else if (q.get('SELECT id FROM users WHERE email=?', email)) flash(req, 'error', 'Email already in use.');
  else {
    q.run('INSERT INTO users (school_id,name,email,password_hash,role,student_id) VALUES (?,?,?,?,?,?)',
      req.school.id, `${s.first_name} ${s.last_name}`, email.trim(), bcrypt.hashSync(password, 10), 'student', s.id);
    flash(req, 'success', 'Student portal account created.');
  }
  res.redirect('/app/students/' + s.id);
});

router.post('/students/:id/delete', adminOnly, (req, res) => {
  const s = findStudent(req, req.params.id);
  if (s) {
    q.run('DELETE FROM students WHERE id=? AND school_id=?', s.id, req.school.id);
    logActivity(req.school.id, req.user.id, `Deleted student ${s.first_name} ${s.last_name} (${s.admission_no})`);
    flash(req, 'success', 'Student record deleted.');
  }
  res.redirect('/app/students');
});

// ================= TEACHERS =================
function validateTeacher(f) {
  const errors = [];
  if (!f.first_name?.trim() || !f.last_name?.trim()) errors.push('First and last name are required.');
  if (f.email && !validEmail(f.email)) errors.push('Email is invalid.');
  if (f.gender && !GENDERS.includes(f.gender)) errors.push('Invalid gender.');
  if (!validDate(f.hire_date)) errors.push('Hire date is invalid.');
  if (f.status && !TEACHER_STATUS.includes(f.status)) errors.push('Invalid status.');
  if (f.salary && isNaN(Number(f.salary))) errors.push('Salary must be a number.');
  return errors;
}

router.get('/teachers', adminOnly, (req, res) => {
  const term = (req.query.q || '').trim();
  const teachers = q.all(
    `SELECT t.*, (SELECT COUNT(*) FROM class_subjects cs WHERE cs.teacher_id=t.id) subject_count,
       (SELECT GROUP_CONCAT(c.name || COALESCE(' '||c.section,''), ', ') FROM classes c WHERE c.class_teacher_id=t.id) class_teacher_of,
       (SELECT u.id FROM users u WHERE u.teacher_id=t.id) user_id
     FROM teachers t WHERE t.school_id=? AND (? IS NULL OR t.first_name || ' ' || t.last_name LIKE ? OR t.staff_no LIKE ? OR t.email LIKE ?)
       AND (? IS NULL OR t.status=?)
     ORDER BY t.first_name, t.last_name`,
    req.school.id, term || null, `%${term}%`, `%${term}%`, `%${term}%`, req.query.status || null, req.query.status || null);
  res.page('app/teachers/index', { title: 'Teachers', teachers });
});

router.get('/teachers/export.csv', adminOnly, (req, res) => {
  const rows = q.all('SELECT * FROM teachers WHERE school_id=? ORDER BY first_name', req.school.id);
  const csv = toCsv(rows, [
    { label: 'Staff No', value: 'staff_no' }, { label: 'First name', value: 'first_name' }, { label: 'Last name', value: 'last_name' },
    { label: 'Gender', value: 'gender' }, { label: 'Email', value: 'email' }, { label: 'Phone', value: 'phone' },
    { label: 'Qualification', value: 'qualification' }, { label: 'Specialization', value: 'specialization' },
    { label: 'Hire date', value: 'hire_date' }, { label: 'Status', value: 'status' },
  ]);
  res.set('Content-Type', 'text/csv').attachment(`teachers-${today()}.csv`).send(csv);
});

function teacherLimit(req) {
  const lim = req.school.teacher_limit;
  if (lim == null) return null;
  const n = q.get('SELECT COUNT(*) n FROM teachers WHERE school_id=?', req.school.id).n;
  return n >= lim ? `Your ${req.school.plan_name} plan allows up to ${lim} teachers. Upgrade your plan to add more.` : null;
}

router.get('/teachers/new', adminOnly, (req, res) => {
  const limit = teacherLimit(req);
  if (limit) { flash(req, 'error', limit); return res.redirect('/app/teachers'); }
  res.page('app/teachers/form', { title: 'Add teacher', t: { staff_no: nextCode('teachers', 'staff_no', req.school.id, 'STF-'), hire_date: today(), status: 'active', create_login: '1' }, errors: [] });
});

router.post('/teachers', adminOnly, (req, res) => {
  const f = req.body;
  const errors = validateTeacher(f);
  const limit = teacherLimit(req);
  if (limit) errors.push(limit);
  if (!f.staff_no?.trim()) errors.push('Staff number is required.');
  else if (q.get('SELECT id FROM teachers WHERE school_id=? AND staff_no=?', req.school.id, f.staff_no.trim())) errors.push('Staff number already exists.');
  if (f.create_login) {
    if (!validEmail(f.email)) errors.push('A valid email is required to create a login.');
    else if (q.get('SELECT id FROM users WHERE email=?', f.email)) errors.push('That email already has a School Unity login.');
    if (!f.password || f.password.length < 8) errors.push('Login password must be at least 8 characters.');
  }
  if (errors.length) return res.status(422).page('app/teachers/form', { title: 'Add teacher', t: f, errors });
  const id = q.tx(() => {
    const r = q.run(`INSERT INTO teachers (school_id,staff_no,first_name,last_name,gender,email,phone,qualification,specialization,hire_date,salary,address,status)
                     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      req.school.id, f.staff_no.trim(), f.first_name.trim(), f.last_name.trim(), f.gender, f.email, f.phone, f.qualification, f.specialization,
      f.hire_date, f.salary === '' ? null : Number(f.salary), f.address, f.status || 'active');
    const tid = Number(r.lastInsertRowid);
    if (f.create_login) {
      q.run('INSERT INTO users (school_id,name,email,password_hash,role,teacher_id) VALUES (?,?,?,?,?,?)',
        req.school.id, `${f.first_name.trim()} ${f.last_name.trim()}`, f.email.trim(), bcrypt.hashSync(f.password, 10), 'teacher', tid);
    }
    return tid;
  });
  logActivity(req.school.id, req.user.id, `Added teacher ${f.first_name} ${f.last_name}`);
  flash(req, 'success', 'Teacher added.');
  res.redirect('/app/teachers/' + id);
});

function findTeacher(req, id) {
  return q.get('SELECT * FROM teachers WHERE id=? AND school_id=?', id, req.school.id);
}

router.get('/teachers/:id', adminOnly, (req, res) => {
  const t = findTeacher(req, req.params.id);
  if (!t) return res.status(404).render('error', { title: 'Not found', message: 'Teacher not found.' });
  const leads = q.all('SELECT * FROM classes WHERE class_teacher_id=? AND school_id=?', t.id, req.school.id);
  const subjects = q.all(`SELECT cs.id, sub.name subject, c.id class_id, c.name class_name, c.section FROM class_subjects cs
    JOIN subjects sub ON sub.id=cs.subject_id JOIN classes c ON c.id=cs.class_id WHERE cs.teacher_id=? AND cs.school_id=? ORDER BY c.name`, t.id, req.school.id);
  const login = q.get('SELECT id,email,active,last_login FROM users WHERE teacher_id=?', t.id);
  res.page('app/teachers/show', { title: `${t.first_name} ${t.last_name}`, t, leads, subjects, login });
});

router.get('/teachers/:id/edit', adminOnly, (req, res) => {
  const t = findTeacher(req, req.params.id);
  if (!t) return res.status(404).render('error', { title: 'Not found', message: 'Teacher not found.' });
  res.page('app/teachers/form', { title: 'Edit teacher', t, errors: [] });
});

router.post('/teachers/:id', adminOnly, (req, res) => {
  const t = findTeacher(req, req.params.id);
  if (!t) return res.status(404).render('error', { title: 'Not found', message: 'Teacher not found.' });
  const f = req.body;
  const errors = validateTeacher(f);
  if (!f.staff_no?.trim()) errors.push('Staff number is required.');
  else if (q.get('SELECT id FROM teachers WHERE school_id=? AND staff_no=? AND id!=?', req.school.id, f.staff_no.trim(), t.id)) errors.push('Staff number already exists.');
  if (errors.length) return res.status(422).page('app/teachers/form', { title: 'Edit teacher', t: { ...f, id: t.id }, errors });
  q.run(`UPDATE teachers SET staff_no=?, first_name=?, last_name=?, gender=?, email=?, phone=?, qualification=?, specialization=?, hire_date=?, salary=?, address=?, status=?
         WHERE id=? AND school_id=?`,
    f.staff_no.trim(), f.first_name.trim(), f.last_name.trim(), f.gender, f.email, f.phone, f.qualification, f.specialization, f.hire_date,
    f.salary === '' || f.salary == null ? null : Number(f.salary), f.address, f.status || 'active', t.id, req.school.id);
  q.run('UPDATE users SET name=?, active=? WHERE teacher_id=?', `${f.first_name.trim()} ${f.last_name.trim()}`, (f.status || 'active') === 'inactive' ? 0 : 1, t.id);
  logActivity(req.school.id, req.user.id, `Updated teacher ${f.first_name} ${f.last_name}`);
  flash(req, 'success', 'Teacher updated.');
  res.redirect('/app/teachers/' + t.id);
});

router.post('/teachers/:id/account', adminOnly, (req, res) => {
  const t = findTeacher(req, req.params.id);
  if (!t) return res.redirect('/app/teachers');
  const existing = q.get('SELECT id FROM users WHERE teacher_id=?', t.id);
  const { email, password } = req.body;
  if (!password || password.length < 8) flash(req, 'error', 'Password must be at least 8 characters.');
  else if (existing) {
    q.run('UPDATE users SET password_hash=?, active=1 WHERE id=?', bcrypt.hashSync(password, 10), existing.id);
    flash(req, 'success', 'Login password reset.');
  } else if (!validEmail(email)) flash(req, 'error', 'Valid email is required.');
  else if (q.get('SELECT id FROM users WHERE email=?', email)) flash(req, 'error', 'Email already in use.');
  else {
    q.run('INSERT INTO users (school_id,name,email,password_hash,role,teacher_id) VALUES (?,?,?,?,?,?)',
      req.school.id, `${t.first_name} ${t.last_name}`, email.trim(), bcrypt.hashSync(password, 10), 'teacher', t.id);
    flash(req, 'success', 'Teacher login created.');
  }
  res.redirect('/app/teachers/' + t.id);
});

router.post('/teachers/:id/delete', adminOnly, (req, res) => {
  const t = findTeacher(req, req.params.id);
  if (t) {
    q.run('DELETE FROM teachers WHERE id=? AND school_id=?', t.id, req.school.id);
    logActivity(req.school.id, req.user.id, `Removed teacher ${t.first_name} ${t.last_name}`);
    flash(req, 'success', 'Teacher removed.');
  }
  res.redirect('/app/teachers');
});

module.exports = router;
