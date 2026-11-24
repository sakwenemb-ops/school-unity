// View + domain helpers shared by routes and templates.
const { q } = require('./db');

function gradeFor(pct) {
  if (pct == null || isNaN(pct)) return '-';
  if (pct >= 80) return 'A';
  if (pct >= 70) return 'B';
  if (pct >= 60) return 'C';
  if (pct >= 50) return 'D';
  if (pct >= 40) return 'E';
  return 'F';
}

function money(amount, currency = 'USD') {
  const n = Number(amount || 0);
  try {
    return new Intl.NumberFormat('en-US', { style: 'currency', currency }).format(n);
  } catch {
    return `${currency} ${n.toFixed(2)}`;
  }
}

function fmtDate(d) {
  if (!d) return '';
  const dt = new Date(d.length <= 10 ? d + 'T00:00:00' : d.replace(' ', 'T') + 'Z');
  if (isNaN(dt)) return d;
  return dt.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
}

function today() {
  return new Date().toISOString().slice(0, 10);
}

function slugify(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 50) || 'school';
}

function initials(name) {
  return String(name || '?').split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0].toUpperCase()).join('');
}

// Generates the next sequential code, e.g. ADM-2026-0007 / STF-0012
function nextCode(table, column, schoolId, prefix, pad = 4) {
  const rows = q.all(`SELECT ${column} AS c FROM ${table} WHERE school_id = ? AND ${column} LIKE ?`, schoolId, prefix + '%');
  let max = 0;
  for (const r of rows) {
    const n = parseInt(String(r.c).slice(prefix.length), 10);
    if (!isNaN(n) && n > max) max = n;
  }
  return prefix + String(max + 1).padStart(pad, '0');
}

// Fee summary for a student in the school's current term
function feeSummary(school, student) {
  const expected = q.get(
    `SELECT COALESCE(SUM(amount),0) AS t FROM fee_items WHERE school_id=? AND term=? AND academic_year=? AND (class_id IS NULL OR class_id=?)`,
    school.id, school.current_term, school.academic_year, student.class_id
  ).t;
  const paid = q.get(
    `SELECT COALESCE(SUM(amount),0) AS t FROM payments WHERE school_id=? AND student_id=? AND term=? AND academic_year=?`,
    school.id, student.id, school.current_term, school.academic_year
  ).t;
  return { expected, paid, balance: expected - paid };
}

function toCsv(rows, columns) {
  const esc = (v) => {
    const s = v == null ? '' : String(v);
    const safe = /^[=+\-@]/.test(s) ? "'" + s : s; // guard against CSV formula injection
    return /[",\n]/.test(safe) ? '"' + safe.replace(/"/g, '""') + '"' : safe;
  };
  const head = columns.map((c) => esc(c.label)).join(',');
  const body = rows.map((r) => columns.map((c) => esc(typeof c.value === 'function' ? c.value(r) : r[c.value])).join(','));
  return [head, ...body].join('\n');
}

module.exports = { gradeFor, money, fmtDate, today, slugify, initials, nextCode, feeSummary, toCsv };
