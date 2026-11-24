// Role-based scoping inside a tenant.
const { q } = require('./db');

const isAdmin = (req) => req.user && req.user.role === 'admin';

// Classes a teacher may work with: those they lead or teach a subject in.
function teacherClassIds(req) {
  if (!req.user.teacher_id) return [];
  return q.all(
    `SELECT id FROM classes WHERE school_id=? AND class_teacher_id=?
     UNION SELECT class_id FROM class_subjects WHERE school_id=? AND teacher_id=?`,
    req.school.id, req.user.teacher_id, req.school.id, req.user.teacher_id
  ).map((r) => r.id);
}

// Classes visible to the current user (admin: all).
function visibleClasses(req) {
  const all = q.all(
    `SELECT c.*, t.first_name || ' ' || t.last_name AS teacher_name,
       (SELECT COUNT(*) FROM students s WHERE s.class_id=c.id AND s.status='active') AS student_count
     FROM classes c LEFT JOIN teachers t ON t.id=c.class_teacher_id
     WHERE c.school_id=? ORDER BY c.name, c.section`, req.school.id);
  if (isAdmin(req)) return all;
  const ids = new Set(teacherClassIds(req));
  return all.filter((c) => ids.has(c.id));
}

function canAccessClass(req, classId) {
  if (isAdmin(req)) return !!q.get('SELECT id FROM classes WHERE id=? AND school_id=?', classId, req.school.id);
  if (req.user.role === 'teacher') return teacherClassIds(req).includes(Number(classId));
  return false;
}

// Can the user enter marks for subject in class?
function canGradeSubject(req, classId, subjectId) {
  if (isAdmin(req)) return true;
  if (req.user.role !== 'teacher') return false;
  const cls = q.get('SELECT class_teacher_id FROM classes WHERE id=? AND school_id=?', classId, req.school.id);
  if (cls && cls.class_teacher_id === req.user.teacher_id) return true;
  return !!q.get('SELECT id FROM class_subjects WHERE class_id=? AND subject_id=? AND teacher_id=? AND school_id=?',
    classId, subjectId, req.user.teacher_id, req.school.id);
}

module.exports = { isAdmin, teacherClassIds, visibleClasses, canAccessClass, canGradeSubject };
