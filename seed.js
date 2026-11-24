// Seeds a platform super-admin and two demo schools with realistic data.
// Usage: npm run seed   (use --reset to wipe the database first)
const fs = require('fs');
const path = require('path');
if (process.argv.includes('--reset')) {
  const f = process.env.DB_FILE || path.join(__dirname, 'data', 'school-unity.db');
  for (const x of [f, f + '-wal', f + '-shm']) if (fs.existsSync(x)) fs.unlinkSync(x);
}
const bcrypt = require('bcryptjs');
const { q } = require('./src/db');

if (q.get("SELECT id FROM users WHERE role='superadmin'")) {
  console.log('Database already seeded. Run `npm run seed -- --reset` to start over.');
  process.exit(0);
}

const hash = (p) => bcrypt.hashSync(p, 10);
const pick = (arr, i) => arr[i % arr.length];
let rnd = 42;
const rand = () => ((rnd = (rnd * 16807) % 2147483647) / 2147483647);
const days = (n) => new Date(Date.now() - n * 86400000).toISOString().slice(0, 10);
const year = String(new Date().getFullYear());

q.run("INSERT INTO users (name,email,password_hash,role) VALUES ('Platform Owner','owner@schoolunity.app',?,'superadmin')", hash('owner12345'));

const FIRST_M = ['James', 'Brian', 'Kevin', 'Daniel', 'Samuel', 'Peter', 'David', 'Joseph', 'Michael', 'John', 'Allan', 'Victor', 'Collins', 'Eric'];
const FIRST_F = ['Mary', 'Grace', 'Faith', 'Joy', 'Mercy', 'Esther', 'Ruth', 'Sarah', 'Ann', 'Lucy', 'Diana', 'Agnes', 'Irene', 'Linda'];
const LAST = ['Okello', 'Mwangi', 'Banda', 'Phiri', 'Mensah', 'Ndlovu', 'Kamau', 'Otieno', 'Achieng', 'Mutua', 'Nakato', 'Musa', 'Boateng', 'Wanjiru', 'Tembo', 'Ochieng'];
const SUBJECTS = [['Mathematics', 'MAT'], ['English', 'ENG'], ['Science', 'SCI'], ['Social Studies', 'SST'], ['French', 'FRE'], ['ICT', 'ICT']];

function seedSchool({ name, slug, email, plan, currency, adminEmail, teacherEmail, studentEmail, classNames, perClass, teachers = 6 }) {
  const sid = Number(q.run(
    `INSERT INTO schools (name,slug,email,phone,address,motto,country,currency,plan,academic_year,current_term)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
    name, slug, email, '+237 233 42 00 00', '12 Unity Road, Douala', 'Learning together, growing together', 'Cameroon', currency, plan, year, 'Term 1').lastInsertRowid);
  // a paid plan starts with its current month already paid
  if (plan !== 'free') q.run('UPDATE schools SET paid_until=? WHERE id=?', days(-20), sid);
  const adminId = Number(q.run("INSERT INTO users (school_id,name,email,password_hash,role) VALUES (?,?,?,?,'admin')", sid, name.startsWith('Green') ? 'Margaret Wanjiru' : 'Peter Mensah', adminEmail, hash('admin12345')).lastInsertRowid);

  const subjectIds = SUBJECTS.map(([n, c]) => Number(q.run('INSERT INTO subjects (school_id,name,code) VALUES (?,?,?)', sid, n, c).lastInsertRowid));

  const teacherIds = [];
  for (let i = 0; i < teachers; i++) {
    const female = i % 2 === 1;
    const fn = female ? pick(FIRST_F, i + 3) : pick(FIRST_M, i + 5);
    const ln = pick(LAST, i * 3 + 1);
    const tid = Number(q.run(
      `INSERT INTO teachers (school_id,staff_no,first_name,last_name,gender,email,phone,qualification,specialization,hire_date,salary,status)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
      sid, 'STF-' + String(i + 1).padStart(4, '0'), fn, ln, female ? 'Female' : 'Male',
      i === 0 ? teacherEmail : `${fn}.${ln}.${slug}@example.com`.toLowerCase(), '+237 677 10 ' + String(1000 + i).slice(-4),
      pick(['B.Ed', 'M.Ed', 'Diploma in Education', 'B.Sc + PGDE'], i), SUBJECTS[i][0], days(400 + i * 90), 250000 + i * 25000, 'active').lastInsertRowid);
    teacherIds.push(tid);
    if (i === 0) q.run("INSERT INTO users (school_id,name,email,password_hash,role,teacher_id) VALUES (?,?,?,?,'teacher',?)", sid, `${fn} ${ln}`, teacherEmail, hash('teacher12345'), tid);
  }

  const classIds = classNames.map(([n, sec], i) => Number(q.run(
    'INSERT INTO classes (school_id,name,section,capacity,room,class_teacher_id) VALUES (?,?,?,?,?,?)',
    sid, n, sec, 40, 'Room ' + (101 + i), teacherIds[i % teacherIds.length]).lastInsertRowid));

  classIds.forEach((cid) => subjectIds.forEach((subId, j) => {
    q.run('INSERT INTO class_subjects (school_id,class_id,subject_id,teacher_id) VALUES (?,?,?,?)', sid, cid, subId, teacherIds[j % teacherIds.length]);
  }));

  // students
  let adm = 0; const studentIds = [];
  classIds.forEach((cid, ci) => {
    for (let k = 0; k < perClass; k++) {
      adm++;
      const female = rand() > 0.5;
      const fn = female ? pick(FIRST_F, Math.floor(rand() * 100)) : pick(FIRST_M, Math.floor(rand() * 100));
      const ln = pick(LAST, Math.floor(rand() * 100));
      const id = Number(q.run(
        `INSERT INTO students (school_id,admission_no,first_name,last_name,gender,dob,class_id,guardian_name,guardian_phone,guardian_relation,address,admission_date)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
        sid, `ADM-${year}-${String(adm).padStart(4, '0')}`, fn, ln, female ? 'Female' : 'Male',
        `${Number(year) - 7 - ci}-${String(1 + Math.floor(rand() * 12)).padStart(2, '0')}-${String(1 + Math.floor(rand() * 28)).padStart(2, '0')}`,
        cid, `${pick(FIRST_M.concat(FIRST_F), Math.floor(rand() * 28))} ${ln}`, '+237 6' + pick(['50', '70', '77', '90', '94'], adm) + ' ' + String(100000 + Math.floor(rand() * 899999)),
        pick(['Father', 'Mother', 'Guardian'], adm), 'P.O. Box ' + (100 + adm), days(200)).lastInsertRowid);
      studentIds.push({ id, cid });
      if (adm === 1) q.run("INSERT INTO users (school_id,name,email,password_hash,role,student_id) VALUES (?,?,?,?,'student',?)", sid, `${fn} ${ln}`, studentEmail, hash('student12345'), id);
    }
  });

  // attendance for the last 10 school days
  q.tx(() => {
    for (let d = 1; d <= 14; d++) {
      const date = new Date(Date.now() - d * 86400000);
      if ([0, 6].includes(date.getDay())) continue;
      const ds = date.toISOString().slice(0, 10);
      for (const s of studentIds) {
        const r = rand();
        q.run('INSERT INTO attendance (school_id,student_id,class_id,date,status,marked_by) VALUES (?,?,?,?,?,?)',
          sid, s.id, s.cid, ds, r < 0.85 ? 'present' : r < 0.93 ? 'absent' : r < 0.98 ? 'late' : 'excused', adminId);
      }
    }
  });

  // exams + grades
  const examId = Number(q.run('INSERT INTO exams (school_id,name,term,academic_year,start_date,max_score) VALUES (?,?,?,?,?,100)', sid, 'Mid-Term Exam', 'Term 1', year, days(20)).lastInsertRowid);
  q.run('INSERT INTO exams (school_id,name,term,academic_year,start_date,max_score) VALUES (?,?,?,?,?,100)', sid, 'End of Term Exam', 'Term 1', year, days(-30));
  q.tx(() => {
    for (const s of studentIds) {
      const ability = 45 + rand() * 45;
      for (const subId of subjectIds) {
        const score = Math.max(15, Math.min(100, Math.round(ability + (rand() - 0.5) * 30)));
        q.run('INSERT INTO grades (school_id,exam_id,student_id,subject_id,score) VALUES (?,?,?,?,?)', sid, examId, s.id, subId, score);
      }
    }
  });

  // fees
  q.run('INSERT INTO fee_items (school_id,name,amount,class_id,term,academic_year) VALUES (?,?,?,?,?,?)', sid, 'Tuition', 150000, null, 'Term 1', year);
  q.run('INSERT INTO fee_items (school_id,name,amount,class_id,term,academic_year) VALUES (?,?,?,?,?,?)', sid, 'Activity fee', 15000, null, 'Term 1', year);
  q.run('INSERT INTO fee_items (school_id,name,amount,class_id,term,academic_year) VALUES (?,?,?,?,?,?)', sid, 'Lab fee', 10000, classIds[classIds.length - 1], 'Term 1', year);
  for (const s of studentIds) {
    const r = rand();
    if (r < 0.15) continue;
    const amt = r < 0.55 ? 165000 : Math.round((40000 + rand() * 80000) / 5000) * 5000; // XAF
    q.run('INSERT INTO payments (school_id,student_id,amount,method,reference,term,academic_year,paid_on,recorded_by) VALUES (?,?,?,?,?,?,?,?,?)',
      sid, s.id, amt, pick(['Cash', 'Bank transfer', 'Mobile money'], s.id), 'TXN' + (10000 + s.id), 'Term 1', year, days(Math.floor(rand() * 40)), adminId);
  }

  q.run("INSERT INTO announcements (school_id,title,body,audience,pinned,created_by) VALUES (?,?,?,?,1,?)", sid,
    'Welcome back to Term 1', 'We are delighted to welcome all students and staff back. Classes begin promptly at 8:00 AM. Please ensure fees are cleared by the end of the month.', 'all', adminId);
  q.run("INSERT INTO announcements (school_id,title,body,audience,created_by) VALUES (?,?,?,?,?)", sid,
    'Staff meeting on Friday', 'All teaching staff are requested to attend a short meeting in the staff room on Friday at 3:30 PM to review mid-term results.', 'teachers', adminId);
  q.run('INSERT INTO events (school_id,title,date,description) VALUES (?,?,?,?)', sid, 'Parents & Teachers Day', days(-10), 'Meet teachers and review your child\'s progress.');
  q.run('INSERT INTO events (school_id,title,date,description) VALUES (?,?,?,?)', sid, 'Sports Day', days(-24), 'Annual inter-house athletics competition.');
  q.run('INSERT INTO events (school_id,title,date,description) VALUES (?,?,?,?)', sid, 'End of Term Exams begin', days(-30), '');
  q.run("INSERT INTO activity_log (school_id,user_id,action) VALUES (?,?,'Seeded demo data')", sid, adminId);
}

seedSchool({
  name: 'Greenfield Academy', slug: 'greenfield-academy', email: 'info@greenfield.example.com', plan: 'basic', currency: 'XAF',
  adminEmail: 'admin@greenfield.edu', teacherEmail: 'teacher@greenfield.edu', studentEmail: 'student@greenfield.edu',
  classNames: [['Grade 4', 'A'], ['Grade 4', 'B'], ['Grade 5', 'A'], ['Grade 6', 'A']], perClass: 14,
});
seedSchool({
  name: 'Riverside Primary School', slug: 'riverside-primary', email: 'hello@riverside.example.com', plan: 'free', currency: 'XAF',
  adminEmail: 'admin@riverside.edu', teacherEmail: 'teacher@riverside.edu', studentEmail: 'student@riverside.edu',
  classNames: [['Class 1', null], ['Class 2', null]], perClass: 10, teachers: 4,
});

console.log(`Seeded School Unity demo data:
  Platform owner : owner@schoolunity.app / owner12345
  School admin   : admin@greenfield.edu / admin12345   (also admin@riverside.edu)
  Teacher        : teacher@greenfield.edu / teacher12345
  Student        : student@greenfield.edu / student12345`);
