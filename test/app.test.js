// End-to-end tests: boots the app on a throwaway DB seeded with demo data.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const os = require('os');
const fs = require('fs');
const { execFileSync } = require('child_process');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'su-test-'));
process.env.DB_FILE = path.join(dir, 'test.db');
execFileSync(process.execPath, ['--no-warnings', path.join(__dirname, '..', 'seed.js')], { env: process.env });
const app = require('../server');
const { q } = require('../src/db');

let server; let base;
before(() => new Promise((r) => { server = app.listen(0, () => { base = `http://127.0.0.1:${server.address().port}`; r(); }); }));
after(() => { server.close(); fs.rmSync(dir, { recursive: true, force: true }); });

function client() {
  let cookie = '';
  const req = async (method, url, form) => {
    const headers = { cookie };
    let body;
    if (form) { headers['content-type'] = 'application/x-www-form-urlencoded'; body = new URLSearchParams(form).toString(); }
    const res = await fetch(base + url, { method, headers, body, redirect: 'manual' });
    const set = res.headers.getSetCookie?.() || [];
    for (const c of set) cookie = c.split(';')[0];
    return { status: res.status, location: res.headers.get('location'), text: await res.text() };
  };
  const c = {
    get: (u) => req('GET', u),
    async csrf() { const r = await req('GET', '/login'); return /name="_csrf" value="([^"]+)"/.exec(r.text)?.[1]; },
    async post(u, form = {}) {
      let token;
      for (const p of ['/app/account', '/platform/plans', '/login']) {
        const page = await req('GET', p);
        token = /name="_csrf" value="([^"]+)"/.exec(page.text)?.[1];
        if (token) break;
      }
      return req('POST', u, { _csrf: token, ...form });
    },
    async login(email, password) {
      const token = await c.csrf();
      const r = await req('POST', '/login', { _csrf: token, email, password });
      assert.equal(r.status, 302, `login ${email}`);
      return r;
    },
  };
  return c;
}

const ok = (r, u) => { assert.equal(r.status, 200, `${u} → ${r.status}`); assert.ok(!r.text.includes('Something went wrong'), u); };
const gf = () => q.get("SELECT id FROM schools WHERE slug='greenfield-academy'").id;

test('public pages render', async () => {
  const c = client();
  for (const u of ['/', '/login', '/signup']) ok(await c.get(u), u);
  assert.equal((await c.get('/app')).location, '/login');
});

test('rejects bad login and missing CSRF', async () => {
  const c = client();
  const token = await c.csrf();
  const bad = await fetch(base + '/login', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'email=x@y.z&password=nope', redirect: 'manual' });
  assert.equal(bad.status, 403);
  assert.ok(token);
});

test('school admin can use every module', async () => {
  const c = client();
  const r = await c.login('admin@greenfield.edu', 'admin12345');
  assert.equal(r.location, '/app');
  const sid = gf();
  const student = q.get('SELECT id FROM students WHERE school_id=? LIMIT 1', sid).id;
  const teacher = q.get('SELECT id FROM teachers WHERE school_id=? LIMIT 1', sid).id;
  const cls = q.get('SELECT id FROM classes WHERE school_id=? LIMIT 1', sid).id;
  const exam = q.get('SELECT id FROM exams WHERE school_id=? LIMIT 1', sid).id;
  const sub = q.get('SELECT subject_id FROM class_subjects WHERE class_id=? LIMIT 1', cls).subject_id;
  const pay = q.get('SELECT id FROM payments WHERE school_id=? LIMIT 1', sid).id;
  const pages = ['/app', '/app/students', '/app/students?q=a&gender=Female', '/app/students/new', '/app/students/import', `/app/students/${student}`, `/app/students/${student}/edit`,
    '/app/teachers', '/app/teachers/new', `/app/teachers/${teacher}`, `/app/teachers/${teacher}/edit`, '/app/classes', `/app/classes/${cls}`, '/app/subjects',
    '/app/attendance', `/app/attendance?class_id=${cls}`, '/app/attendance/report', '/app/exams', `/app/exams/${exam}`, `/app/exams/${exam}/marks?class_id=${cls}&subject_id=${sub}`,
    `/app/exams/${exam}/results?class_id=${cls}`, `/app/students/${student}/report/${exam}`, '/app/fees', '/app/fees?filter=owing', '/app/fees/payments', '/app/fees/pay',
    `/app/fees/payments/${pay}/receipt`, '/app/announcements', '/app/events', '/app/settings', '/app/billing', '/app/account'];
  for (const u of pages) ok(await c.get(u), u);
  const csv = await c.get('/app/students/export.csv');
  assert.ok(csv.text.startsWith('Admission No,'));

  // create flows
  let res = await c.post('/app/classes', { name: 'Grade 7', section: 'Z', capacity: '30' });
  assert.equal(res.status, 302);
  const newCls = q.get("SELECT id FROM classes WHERE school_id=? AND name='Grade 7'", sid).id;
  res = await c.post('/app/subjects', { name: 'Music', code: 'mus' });
  const music = q.get("SELECT id, code FROM subjects WHERE school_id=? AND name='Music'", sid);
  assert.equal(music.code, 'MUS');
  await c.post(`/app/classes/${newCls}/subjects`, { subject_id: music.id, teacher_id: teacher });
  res = await c.post('/app/students', { admission_no: 'T-001', first_name: 'Test', last_name: 'Pupil', gender: 'Female', class_id: newCls, create_login: '1', login_email: 'pupil@test.edu', login_password: 'pupil12345' });
  assert.equal(res.status, 302, res.text.slice(0, 300));
  const pupil = q.get("SELECT id FROM students WHERE admission_no='T-001'").id;
  res = await c.post('/app/attendance', { class_id: newCls, date: new Date().toISOString().slice(0, 10), ['s_' + pupil]: 'late' });
  assert.equal(q.get('SELECT status FROM attendance WHERE student_id=?', pupil).status, 'late');
  await c.post(`/app/exams/${exam}/marks`, { class_id: newCls, subject_id: music.id, ['score_' + pupil]: '88' });
  assert.equal(q.get('SELECT score FROM grades WHERE student_id=?', pupil).score, 88);
  await c.post(`/app/exams/${exam}/marks`, { class_id: newCls, subject_id: music.id, ['score_' + pupil]: '500' });
  assert.equal(q.get('SELECT score FROM grades WHERE student_id=?', pupil).score, 88, 'out of range score rejected');
  res = await c.post('/app/fees/payments', { student_id: pupil, amount: '120', paid_on: '2026-01-15', method: 'Cash' });
  assert.match(res.location, /\/receipt$/);
  res = await c.post('/app/students/import', { csv: 'first_name,last_name,gender,class\nAmina,Ali,F,Grade 7 Z\nBad,,M,\nJo,Doe,M,Nonexistent' });
  assert.match(res.text, /1 students imported/);
  assert.match(res.text, /2 rows skipped/);
  await c.post('/app/announcements', { title: 'Hello', body: 'World', audience: 'students' });
  await c.post('/app/teachers', { staff_no: 'STF-9999', first_name: 'New', last_name: 'Teach', email: 'newteach@test.edu', create_login: '1', password: 'teach12345' });
  assert.ok(q.get("SELECT id FROM users WHERE email='newteach@test.edu' AND role='teacher'"));

  // new student can sign in to the portal and sees their own data
  const p = client();
  await p.login('pupil@test.edu', 'pupil12345');
  for (const u of ['/app', '/app/me/profile', '/app/me/attendance', '/app/me/results', `/app/me/results/${exam}`, '/app/me/fees', '/app/announcements']) ok(await p.get(u), u);
  assert.match((await p.get('/app/me/fees')).text, /FCFA\s120</); // XAF has no decimals
});

test('tenant isolation: another school cannot see Greenfield data', async () => {
  const c = client();
  await c.login('admin@riverside.edu', 'admin12345');
  const sid = gf();
  const student = q.get('SELECT id FROM students WHERE school_id=? LIMIT 1', sid).id;
  const teacher = q.get('SELECT id FROM teachers WHERE school_id=? LIMIT 1', sid).id;
  const cls = q.get('SELECT id FROM classes WHERE school_id=? LIMIT 1', sid).id;
  const exam = q.get('SELECT id FROM exams WHERE school_id=? LIMIT 1', sid).id;
  const pay = q.get('SELECT id FROM payments WHERE school_id=? LIMIT 1', sid).id;
  for (const u of [`/app/students/${student}`, `/app/teachers/${teacher}`, `/app/classes/${cls}`, `/app/exams/${exam}`, `/app/fees/payments/${pay}/receipt`, `/app/students/${student}/report/${exam}`]) {
    assert.equal((await c.get(u)).status, 404, u);
  }
  await c.post(`/app/students/${student}/delete`);
  assert.ok(q.get('SELECT id FROM students WHERE id=?', student), 'cross-tenant delete blocked');
  const list = await c.get('/app/students');
  assert.ok(!list.text.includes('ADM-' + new Date().getFullYear() + '-0050'));
  // free plan limit: Riverside has 20 students, limit 50 -> fine; teacher limit 5, has 4
  ok(await c.get('/app/teachers/new'), 'teacher new');
});

test('teacher and student role restrictions', async () => {
  const t = client();
  await t.login('teacher@greenfield.edu', 'teacher12345');
  ok(await t.get('/app'), 'teacher dash');
  ok(await t.get('/app/students'), 'teacher students');
  ok(await t.get('/app/attendance'), 'teacher attendance');
  for (const u of ['/app/teachers', '/app/fees', '/app/settings', '/app/billing', '/app/students/new', '/platform']) assert.equal((await t.get(u)).status, 403, u);

  const s = client();
  await s.login('student@greenfield.edu', 'student12345');
  for (const u of ['/app/students', '/app/teachers', '/app/attendance', '/app/exams', '/app/fees']) assert.equal((await s.get(u)).status, 403, u);
  const ann = await s.get('/app/announcements');
  assert.ok(!ann.text.includes('Staff meeting on Friday'), 'teacher-only announcement hidden from students');
});

test('platform owner manages schools; suspension blocks a school', async () => {
  const c = client();
  const r = await c.login('owner@schoolunity.app', 'owner12345');
  assert.equal(r.location, '/platform');
  for (const u of ['/platform', '/platform/schools', `/platform/schools/${gf()}`, '/platform/plans']) ok(await c.get(u), u);
  assert.equal((await c.get('/app')).location, '/platform');

  const riv = q.get("SELECT id FROM schools WHERE slug='riverside-primary'").id;
  const admin = client();
  await admin.login('admin@riverside.edu', 'admin12345');
  ok(await admin.get('/app'), 'riverside before suspension');

  await c.post(`/platform/schools/${riv}`, { plan: 'basic', status: 'suspended' });
  assert.equal(q.get('SELECT status FROM schools WHERE id=?', riv).status, 'suspended');
  const blocked = await admin.get('/app/students');
  assert.equal(blocked.status, 403);
  assert.match(blocked.text, /suspended/);

  await c.post(`/platform/schools/${riv}`, { plan: 'free', status: 'active' });
  ok(await admin.get('/app/students'), 'riverside restored');

  // school admins cannot reach the platform console
  assert.equal((await admin.get('/platform')).status, 403);
});

test('self-service signup creates an isolated school workspace', async () => {
  const c = client();
  const res = await c.post('/signup', { school_name: 'Hilltop High', admin_name: 'Ada Admin', email: 'ada@hilltop.edu', password: 'hilltop123', password_confirm: 'hilltop123', plan: 'free', currency: 'ugx' });
  assert.equal(res.status, 302);
  assert.equal(res.location, '/app');
  const dash = await c.get('/app');
  ok(dash, 'new dashboard');
  assert.match(dash.text, /Get your school set up/);
  const school = q.get("SELECT * FROM schools WHERE slug='hilltop-high'");
  assert.equal(school.currency, 'UGX');
  assert.equal(q.get('SELECT COUNT(*) n FROM students WHERE school_id=?', school.id).n, 0);
  const dup = await client().post('/signup', { school_name: 'Hilltop High', admin_name: 'X', email: 'ada@hilltop.edu', password: 'hilltop123', password_confirm: 'hilltop123', plan: 'free' });
  assert.equal(dup.status, 422, 'duplicate email rejected');
  // currency defaults to XAF when left blank or invalid
  await client().post('/signup', { school_name: 'Lycee Bonaberi', admin_name: 'Y', email: 'y@bonaberi.cm', password: 'bonaberi123', password_confirm: 'bonaberi123', plan: 'free', currency: '' });
  assert.equal(q.get("SELECT currency FROM schools WHERE slug='lycee-bonaberi'").currency, 'XAF');
  assert.match((await client().get('/signup')).text, /name="currency"[^>]*value="XAF"/);
});

test('demo mode (no Notch Pay key): paid plans switch without payment, health check answers', async () => {
  assert.deepEqual(await (await fetch(base + '/healthz')).json(), { ok: true });
  const c = client();
  await c.login('admin@riverside.edu', 'admin12345');
  const billing = await c.get('/app/billing');
  assert.match(billing.text, /Demo mode/);
  assert.match(billing.text, /FCFA\s25,000/);
  await c.post('/app/billing', { plan: 'basic' });
  const s = q.get("SELECT plan, paid_until FROM schools WHERE slug='riverside-primary'");
  assert.equal(s.plan, 'basic');
  assert.ok(s.paid_until > new Date().toISOString().slice(0, 10));
  await c.post('/app/billing', { plan: 'free' });
  assert.equal(q.get("SELECT plan FROM schools WHERE slug='riverside-primary'").plan, 'free');
  // students see that online payment isn't available
  const st = client();
  await st.login('student@greenfield.edu', 'student12345');
  assert.match((await st.get('/app/me/fees')).text, /Online payment isn(&#39;|')t available yet/);
});
