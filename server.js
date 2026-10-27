// Load local env files (created by `neon deploy`) if they exist. Online hosts use real env vars.
for (const f of ['.env.local', '.env']) { try { process.loadEnvFile(f); } catch {} }

const express = require('express');
const fs = require('fs/promises');
const path = require('path');
const { Pool } = require('pg');

const app = express();
const PORT = process.env.PORT || 3000;
const ADMIN_KEY = process.env.ADMIN_KEY || 'change-me';
const DATABASE_URL = process.env.DATABASE_URL;
const DATA_FILE = path.join(__dirname, 'data', 'responses.json');

// Online: answers go to a Postgres database (DATABASE_URL is set).
// On your own computer: answers go to data/responses.json.
const pool = DATABASE_URL ? new Pool({ connectionString: DATABASE_URL }) : null;

if (DATABASE_URL && ADMIN_KEY === 'change-me') {
  console.error('Set a strong ADMIN_KEY before going online.');
  process.exit(1);
}

async function init() {
  if (!pool) return;
  await pool.query(`
    CREATE TABLE IF NOT EXISTS responses (
      id SERIAL PRIMARY KEY,
      submitted_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      nationality TEXT NOT NULL,
      age INT NOT NULL,
      problem1 TEXT NOT NULL,
      problem2 TEXT NOT NULL,
      problem3 TEXT NOT NULL
    )`);
}

async function saveEntry(e) {
  if (pool) {
    await pool.query(
      `INSERT INTO responses (nationality, age, problem1, problem2, problem3)
       VALUES ($1, $2, $3, $4, $5)`,
      [e.nationality, e.age, ...e.problems]);
    return;
  }
  let all = [];
  try { all = JSON.parse(await fs.readFile(DATA_FILE, 'utf8')); } catch {}
  all.push({ submittedAt: new Date().toISOString(), ...e });
  await fs.mkdir(path.dirname(DATA_FILE), { recursive: true });
  await fs.writeFile(DATA_FILE, JSON.stringify(all, null, 2));
}

async function readAll() {
  if (pool) {
    const { rows } = await pool.query('SELECT * FROM responses ORDER BY id');
    return rows.map(r => ({
      submittedAt: r.submitted_at.toISOString(),
      nationality: r.nationality,
      age: r.age,
      problems: [r.problem1, r.problem2, r.problem3]
    }));
  }
  try { return JSON.parse(await fs.readFile(DATA_FILE, 'utf8')); } catch { return []; }
}

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

app.post('/api/submit', async (req, res) => {
  const { nationality, age, problem1, problem2, problem3 } = req.body || {};
  const ageNum = Number(age);

  if (!nationality || !problem1 || !problem2 || !problem3 ||
      !Number.isInteger(ageNum) || ageNum < 1 || ageNum > 120) {
    return res.status(400).json({ error: 'Please fill in every question correctly.' });
  }

  try {
    await saveEntry({
      nationality: String(nationality).trim().slice(0, 100),
      age: ageNum,
      problems: [problem1, problem2, problem3].map(p => String(p).trim().slice(0, 300))
    });
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server problem, please try again.' });
  }
});

// /api/responses?key=YOUR_KEY   (add &format=csv for Excel)
app.get('/api/responses', async (req, res) => {
  if (req.query.key !== ADMIN_KEY) return res.status(401).send('Wrong key');
  const all = await readAll();

  if (req.query.format === 'csv') {
    const q = v => `"${String(v).replace(/"/g, '""')}"`;
    const rows = all.map(r =>
      [r.submittedAt, r.nationality, r.age, ...r.problems].map(q).join(','));
    res.type('text/csv').send(
      ['Date,Nationality,Age,Problem 1,Problem 2,Problem 3', ...rows].join('\n'));
  } else {
    res.json(all);
  }
});

init()
  .then(() => app.listen(PORT, () => console.log(`Running at http://localhost:${PORT}`)))
  .catch(err => { console.error('Startup failed:', err.message); process.exit(1); });
