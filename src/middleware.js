const crypto = require('crypto');
const { q } = require('./db');

// Loads the logged-in user + their school (tenant) on every request.
function loadUser(req, res, next) {
  res.locals.user = null;
  res.locals.school = null;
  const uid = req.session.userId;
  if (uid) {
    const user = q.get('SELECT id,school_id,name,email,role,teacher_id,student_id,active FROM users WHERE id = ?', uid);
    if (!user || !user.active) {
      delete req.session.userId;
    } else {
      req.user = user;
      res.locals.user = user;
      if (user.school_id) {
        const school = q.get(
          `SELECT s.*, p.name AS plan_name, p.student_limit, p.teacher_limit, p.price_monthly
           FROM schools s JOIN plans p ON p.code = s.plan WHERE s.id = ?`, user.school_id);
        req.school = school;
        res.locals.school = school;
      }
    }
  }
  next();
}

function flash(req, type, message) {
  req.session.flash = req.session.flash || [];
  req.session.flash.push({ type, message });
}

function exposeFlash(req, res, next) {
  res.locals.flash = req.session.flash || [];
  delete req.session.flash;
  res.locals.path = req.path;
  res.locals.query = req.query;
  next();
}

// Simple synchronizer-token CSRF protection.
function csrf(req, res, next) {
  if (!req.session.csrf) req.session.csrf = crypto.randomBytes(24).toString('hex');
  res.locals.csrf = req.session.csrf;
  if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) {
    const token = req.body?._csrf || req.get('x-csrf-token');
    if (!token || token !== req.session.csrf) {
      return res.status(403).render('error', { title: 'Session expired', message: 'Your form session expired. Please go back, refresh and try again.', user: req.user });
    }
  }
  next();
}

function requireAuth(req, res, next) {
  if (!req.user) {
    req.session.returnTo = req.originalUrl;
    return res.redirect('/login');
  }
  next();
}

// Restrict a route to specific roles.
const requireRole = (...roles) => (req, res, next) => {
  if (!req.user) return res.redirect('/login');
  if (!roles.includes(req.user.role)) {
    return res.status(403).render('error', { title: 'Access denied', message: "You don't have permission to view this page." });
  }
  next();
};

// Every school route needs an active tenant.
function requireSchool(req, res, next) {
  if (!req.school) return res.redirect(req.user?.role === 'superadmin' ? '/platform' : '/login');
  if (req.school.status === 'suspended') {
    return res.status(403).render('error', {
      title: 'School suspended',
      message: `${req.school.name}'s School Unity account is suspended. Please contact School Unity support to restore access.`,
    });
  }
  next();
}

module.exports = { loadUser, flash, exposeFlash, csrf, requireAuth, requireRole, requireSchool };
