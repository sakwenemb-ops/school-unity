// Persistent session store backed by the same SQLite database.
const session = require('express-session');
const { q } = require('./db');

class SqliteStore extends session.Store {
  constructor() {
    super();
    setInterval(() => q.run('DELETE FROM sessions WHERE expires < ?', Date.now()), 15 * 60 * 1000).unref();
  }
  expiry(sess) {
    const maxAge = sess?.cookie?.maxAge ?? 86400000;
    return Date.now() + maxAge;
  }
  get(sid, cb) {
    try {
      const row = q.get('SELECT data, expires FROM sessions WHERE sid = ?', sid);
      if (!row || row.expires < Date.now()) return cb(null, null);
      cb(null, JSON.parse(row.data));
    } catch (e) { cb(e); }
  }
  set(sid, sess, cb) {
    try {
      q.run('INSERT INTO sessions (sid,data,expires) VALUES (?,?,?) ON CONFLICT(sid) DO UPDATE SET data=excluded.data, expires=excluded.expires',
        sid, JSON.stringify(sess), this.expiry(sess));
      cb && cb(null);
    } catch (e) { cb && cb(e); }
  }
  destroy(sid, cb) {
    try { q.run('DELETE FROM sessions WHERE sid = ?', sid); cb && cb(null); } catch (e) { cb && cb(e); }
  }
  touch(sid, sess, cb) {
    try { q.run('UPDATE sessions SET expires = ? WHERE sid = ?', this.expiry(sess), sid); cb && cb(null); } catch (e) { cb && cb(e); }
  }
}

module.exports = SqliteStore;
