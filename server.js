const express = require('express');
const Database = require('better-sqlite3');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

const app = express();
const db = new Database('nudge.db');
const JWT_SECRET = process.env.JWT_SECRET || 'dev-secret-change-in-prod';

app.use(express.json());
app.use(express.static('.'));

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    email TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS categories (
    id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    name TEXT NOT NULL,
    color TEXT NOT NULL DEFAULT '#9ca3af',
    PRIMARY KEY (id, user_id),
    FOREIGN KEY (user_id) REFERENCES users(id)
  );
  CREATE TABLE IF NOT EXISTS reminders (
    id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    message TEXT NOT NULL,
    time TEXT NOT NULL,
    completions TEXT NOT NULL DEFAULT '[]',
    category_id TEXT NOT NULL DEFAULT 'general',
    PRIMARY KEY (id, user_id),
    FOREIGN KEY (user_id) REFERENCES users(id)
  );
`);

// Column migrations
try { db.exec(`ALTER TABLE reminders ADD COLUMN category_id TEXT NOT NULL DEFAULT 'general'`); } catch { /* already exists */ }
try { db.exec(`ALTER TABLE reminders ADD COLUMN recurrence TEXT DEFAULT NULL`); } catch { /* already exists */ }
try { db.exec(`ALTER TABLE reminders ADD COLUMN recurrence_config TEXT DEFAULT NULL`); } catch { /* already exists */ }
try { db.exec(`ALTER TABLE reminders ADD COLUMN created_at TEXT DEFAULT NULL`); } catch { /* already exists */ }

function auth(req, res, next) {
  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer ')) return res.status(401).json({ error: 'Unauthorized' });
  try {
    req.user = jwt.verify(header.slice(7), JWT_SECRET);
    next();
  } catch {
    res.status(401).json({ error: 'Invalid token' });
  }
}

app.post('/auth/register', (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password) return res.status(400).json({ error: 'Email and password required' });
  if (password.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters' });

  const hash = bcrypt.hashSync(password, 10);
  const id = Date.now().toString(36) + Math.random().toString(36).slice(2);
  try {
    db.prepare('INSERT INTO users (id, email, password_hash, created_at) VALUES (?, ?, ?, ?)').run(
      id, email.toLowerCase().trim(), hash, new Date().toISOString()
    );
    const token = jwt.sign({ id, email: email.toLowerCase().trim() }, JWT_SECRET, { expiresIn: '30d' });
    res.json({ token, email: email.toLowerCase().trim() });
  } catch (e) {
    if (e.message.includes('UNIQUE')) return res.status(409).json({ error: 'Email already in use' });
    res.status(500).json({ error: 'Server error' });
  }
});

app.post('/auth/login', (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password) return res.status(400).json({ error: 'Email and password required' });
  const user = db.prepare('SELECT * FROM users WHERE email = ?').get(email.toLowerCase().trim());
  if (!user || !bcrypt.compareSync(password, user.password_hash)) {
    return res.status(401).json({ error: 'Invalid email or password' });
  }
  const token = jwt.sign({ id: user.id, email: user.email }, JWT_SECRET, { expiresIn: '30d' });
  res.json({ token, email: user.email });
});

app.get('/categories', auth, (req, res) => {
  const rows = db.prepare('SELECT * FROM categories WHERE user_id = ?').all(req.user.id);
  res.json(rows);
});

app.put('/categories/:id', auth, (req, res) => {
  const { name, color } = req.body || {};
  if (!name || !color) return res.status(400).json({ error: 'name and color required' });
  db.prepare(`
    INSERT INTO categories (id, user_id, name, color) VALUES (?, ?, ?, ?)
    ON CONFLICT(id, user_id) DO UPDATE SET name=excluded.name, color=excluded.color
  `).run(req.params.id, req.user.id, name, color);
  res.json({ ok: true });
});

app.delete('/categories/:id', auth, (req, res) => {
  db.prepare('DELETE FROM categories WHERE id = ? AND user_id = ?').run(req.params.id, req.user.id);
  db.prepare(`UPDATE reminders SET category_id = 'general' WHERE category_id = ? AND user_id = ?`).run(req.params.id, req.user.id);
  res.json({ ok: true });
});

app.get('/reminders', auth, (req, res) => {
  const rows = db.prepare('SELECT * FROM reminders WHERE user_id = ?').all(req.user.id);
  res.json(rows.map((r) => ({
    ...r,
    completions: JSON.parse(r.completions || '[]'),
    recurrence_config: r.recurrence_config ? JSON.parse(r.recurrence_config) : null,
  })));
});

app.put('/reminders/:id', auth, (req, res) => {
  const { message, time, completions, category_id, recurrence, recurrence_config, created_at } = req.body || {};
  if (!message || !time) return res.status(400).json({ error: 'message and time required' });
  db.prepare(`
    INSERT INTO reminders (id, user_id, message, time, completions, category_id, recurrence, recurrence_config, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id, user_id) DO UPDATE SET
      message=excluded.message, time=excluded.time, completions=excluded.completions,
      category_id=excluded.category_id, recurrence=excluded.recurrence,
      recurrence_config=excluded.recurrence_config, created_at=excluded.created_at
  `).run(
    req.params.id, req.user.id, message, time,
    JSON.stringify(completions || []),
    category_id || 'general',
    recurrence || null,
    recurrence_config ? JSON.stringify(recurrence_config) : null,
    created_at || null
  );
  res.json({ ok: true });
});

app.delete('/reminders/:id', auth, (req, res) => {
  db.prepare('DELETE FROM reminders WHERE id = ? AND user_id = ?').run(req.params.id, req.user.id);
  res.json({ ok: true });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Nudge running at http://localhost:${PORT}`));
