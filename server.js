// School Unity — multi-tenant school management SaaS
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const session = require('express-session');
const SqliteStore = require('./src/session-store');
const helpers = require('./src/helpers');
const { loadUser, exposeFlash, csrf, requireAuth, requireSchool } = require('./src/middleware');
const onlinePayments = require('./src/online-payments');
const { q } = require('./src/db');

const app = express();
const PORT = process.env.PORT || 3000;
const isProd = process.env.NODE_ENV === 'production';

if (isProd && !process.env.SESSION_SECRET) {
  console.error('SESSION_SECRET must be set when NODE_ENV=production.');
  process.exit(1);
}

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
if (isProd) app.set('trust proxy', 1);
app.disable('x-powered-by');
Object.assign(app.locals, helpers, {
  appName: 'School Unity', showDemo: !isProd,
  onlinePaymentsEnabled: onlinePayments.enabled(), planStatus: onlinePayments.planStatus,
});

// Health check for the hosting platform: confirms the app is up and the database answers.
app.get('/healthz', (req, res) => {
  q.get('SELECT 1 AS ok');
  res.set('Cache-Control', 'no-store').json({ ok: true });
});

// Notch Pay webhook: server-to-server, so it sits before sessions and CSRF checks.
app.post('/webhooks/notchpay', express.json({ limit: '1mb' }), require('./src/routes/pay').webhook);

app.use((req, res, next) => {
  res.set({
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'same-origin',
    'Content-Security-Policy': "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self'; form-action 'self'; frame-ancestors 'none'",
  });
  next();
});
app.use(express.static(path.join(__dirname, 'public'), { maxAge: isProd ? '7d' : 0 }));
app.use(express.urlencoded({ extended: false, limit: '2mb' }));
app.use(session({
  store: new SqliteStore(),
  secret: process.env.SESSION_SECRET || crypto.createHash('sha256').update(__dirname + 'school-unity-dev').digest('hex'),
  resave: false,
  saveUninitialized: false,
  name: 'su.sid',
  cookie: { httpOnly: true, sameSite: 'lax', secure: isProd, maxAge: 8 * 60 * 60 * 1000 },
}));
app.use(loadUser);
app.use(exposeFlash);
app.use(csrf);

// res.page(view, locals): render a view inside a layout
app.use((req, res, next) => {
  res.page = (view, locals = {}) => {
    const layout = locals.layout || (req.user?.role === 'superadmin' ? 'layouts/platform' : 'layouts/app');
    res.render(view, locals, (err, body) => {
      if (err) return next(err);
      res.render(layout, { ...locals, body });
    });
  };
  next();
});

app.use('/', require('./src/routes/public'));
app.use('/', require('./src/routes/pay'));
app.use('/platform', requireAuth, require('./src/routes/platform'));
const school = [requireAuth, requireSchool];
app.use('/app', ...school, require('./src/routes/core'));
app.use('/app', ...school, require('./src/routes/people'));
app.use('/app', ...school, require('./src/routes/academics'));
app.use('/app', ...school, require('./src/routes/finance'));
app.use('/app', ...school, require('./src/routes/portal'));

app.use((req, res) => res.status(404).render('error', { title: 'Page not found', message: "The page you're looking for doesn't exist." }));
app.use((err, req, res, next) => { // eslint-disable-line no-unused-vars
  console.error(err);
  res.status(500).render('error', { title: 'Something went wrong', message: isProd ? 'An unexpected error occurred.' : err.message });
});

// First start on a fresh database (e.g. a new production deploy): create the platform
// owner from OWNER_EMAIL / OWNER_PASSWORD so someone can sign in. Demo data is never added here.
function ensurePlatformOwner() {
  if (q.get("SELECT id FROM users WHERE role='superadmin'")) return;
  const email = (process.env.OWNER_EMAIL || '').trim();
  const password = process.env.OWNER_PASSWORD || '';
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || password.length < 10) {
    console.warn('No platform owner account yet. Set OWNER_EMAIL and OWNER_PASSWORD (10+ characters) and restart, or run `npm run seed` for demo data.');
    return;
  }
  if (q.get('SELECT id FROM users WHERE email=?', email)) {
    console.warn(`OWNER_EMAIL ${email} already belongs to a school user; choose another address for the platform owner.`);
    return;
  }
  q.run("INSERT INTO users (name,email,password_hash,role) VALUES ('Platform Owner',?,?,'superadmin')", email, require('bcryptjs').hashSync(password, 10));
  console.log(`Created platform owner account ${email}.`);
}

if (require.main === module) {
  ensurePlatformOwner();
  if (isProd && !onlinePayments.enabled()) console.warn('NOTCHPAY_PUBLIC_KEY is not set: online fee payments and paid plan upgrades are switched off.');
  app.listen(PORT, () => console.log(`School Unity running at http://localhost:${PORT}`));
}
module.exports = app;
