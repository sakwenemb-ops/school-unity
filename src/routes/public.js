const express = require('express');
const bcrypt = require('bcryptjs');
const { q, logActivity } = require('../db');
const { flash } = require('../middleware');
const { slugify, currencyCode, DEFAULT_CURRENCY } = require('../helpers');

const router = express.Router();

// naive in-memory login throttle: 10 attempts / 15 min per IP+email
const attempts = new Map();
function throttled(key) {
  const now = Date.now();
  const rec = attempts.get(key) || { n: 0, at: now };
  if (now - rec.at > 15 * 60 * 1000) { rec.n = 0; rec.at = now; }
  rec.n++;
  attempts.set(key, rec);
  return rec.n > 10;
}

function homeFor(user) {
  return user.role === 'superadmin' ? '/platform' : '/app';
}

router.get('/', (req, res) => {
  const plans = q.all('SELECT * FROM plans ORDER BY price_monthly');
  const stats = {
    schools: q.get("SELECT COUNT(*) n FROM schools WHERE status='active'").n,
    students: q.get('SELECT COUNT(*) n FROM students').n,
  };
  res.page('public/home', { title: 'School Unity — One platform for every school', plans, stats, layout: 'layouts/public' });
});

router.get('/signup', (req, res) => {
  if (req.user) return res.redirect(homeFor(req.user));
  const plans = q.all('SELECT * FROM plans ORDER BY price_monthly');
  res.page('public/signup', { title: 'Register your school', plans, form: { plan: req.query.plan || 'free', currency: DEFAULT_CURRENCY }, errors: [], layout: 'layouts/public' });
});

router.post('/signup', (req, res) => {
  const f = req.body;
  const plans = q.all('SELECT * FROM plans ORDER BY price_monthly');
  const errors = [];
  if (!f.school_name || f.school_name.trim().length < 3) errors.push('School name must be at least 3 characters.');
  if (!f.admin_name || !f.admin_name.trim()) errors.push('Your name is required.');
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(f.email || '')) errors.push('A valid email is required.');
  if (!f.password || f.password.length < 8) errors.push('Password must be at least 8 characters.');
  if (f.password !== f.password_confirm) errors.push('Passwords do not match.');
  if (!plans.find((p) => p.code === f.plan)) errors.push('Choose a valid plan.');
  if (q.get('SELECT id FROM users WHERE email = ?', f.email)) errors.push('An account with that email already exists.');
  if (errors.length) {
    delete f.password; delete f.password_confirm;
    return res.status(422).page('public/signup', { title: 'Register your school', plans, form: f, errors, layout: 'layouts/public' });
  }

  let slug = slugify(f.school_name);
  for (let i = 2; q.get('SELECT id FROM schools WHERE slug = ?', slug); i++) slug = slugify(f.school_name) + '-' + i;

  const trialEnds = new Date(Date.now() + 30 * 86400000).toISOString().slice(0, 10);
  const year = String(new Date().getFullYear());
  const userId = q.tx(() => {
    const school = q.run(
      `INSERT INTO schools (name,slug,email,phone,country,currency,plan,academic_year,current_term,trial_ends_at)
       VALUES (?,?,?,?,?,?,?,?,?,?)`,
      f.school_name.trim(), slug, f.email.trim(), f.phone, f.country, currencyCode(f.currency),
      f.plan, year, 'Term 1', f.plan === 'free' ? null : trialEnds
    );
    const sid = Number(school.lastInsertRowid);
    const user = q.run('INSERT INTO users (school_id,name,email,password_hash,role) VALUES (?,?,?,?,?)',
      sid, f.admin_name.trim(), f.email.trim(), bcrypt.hashSync(f.password, 10), 'admin');
    const uid = Number(user.lastInsertRowid);
    logActivity(sid, uid, 'Created the school account');
    return uid;
  });

  req.session.regenerate(() => {
    req.session.userId = userId;
    flash(req, 'success', 'Welcome to School Unity! Your school workspace is ready.');
    res.redirect('/app');
  });
});

router.get('/login', (req, res) => {
  if (req.user) return res.redirect(homeFor(req.user));
  res.page('public/login', { title: 'Sign in', email: '', error: null, layout: 'layouts/public' });
});

router.post('/login', (req, res) => {
  const email = (req.body.email || '').trim();
  if (throttled(req.ip + '|' + email.toLowerCase())) {
    return res.status(429).page('public/login', { title: 'Sign in', email, error: 'Too many attempts. Try again in 15 minutes.', layout: 'layouts/public' });
  }
  const user = q.get('SELECT * FROM users WHERE email = ?', email);
  if (!user || !bcrypt.compareSync(req.body.password || '', user.password_hash)) {
    return res.status(401).page('public/login', { title: 'Sign in', email, error: 'Incorrect email or password.', layout: 'layouts/public' });
  }
  if (!user.active) {
    return res.status(403).page('public/login', { title: 'Sign in', email, error: 'This account has been deactivated. Contact your school administrator.', layout: 'layouts/public' });
  }
  const returnTo = req.session.returnTo;
  req.session.regenerate(() => {
    req.session.userId = user.id;
    q.run("UPDATE users SET last_login = datetime('now') WHERE id = ?", user.id);
    res.redirect(returnTo && returnTo.startsWith('/') && !returnTo.startsWith('//') ? returnTo : homeFor(user));
  });
});

router.post('/logout', (req, res) => {
  req.session.destroy(() => res.redirect('/login'));
});

module.exports = router;
