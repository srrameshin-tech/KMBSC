/**
 * KMBSC weekly Firebase backup.
 * Signs in with the reminder service account, exports the kmbsc and
 * kmbscPrivate nodes, and writes a dated JSON snapshot into backups/.
 * Keeps the most recent 12 snapshots.
 */
const https = require('https');
const fs = require('fs');
const path = require('path');

const DB_URL = process.env.FIREBASE_DB_URL;
const API_KEY = process.env.FIREBASE_API_KEY;
const EMAIL = process.env.FIREBASE_AUTH_EMAIL;
const PASSWORD = process.env.FIREBASE_AUTH_PASSWORD;

if (!DB_URL || !API_KEY || !EMAIL || !PASSWORD) {
  console.error('Missing one or more required environment variables.');
  process.exit(1);
}

const KEEP = 12;

function getJson(url) {
  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      let d = '';
      res.on('data', (c) => (d += c));
      res.on('end', () => {
        try { resolve(JSON.parse(d)); } catch (e) { reject(e); }
      });
    }).on('error', reject);
  });
}

function postJson(url, payload) {
  const body = JSON.stringify(payload);
  return new Promise((resolve, reject) => {
    const req = https.request(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
    }, (res) => {
      let d = '';
      res.on('data', (c) => (d += c));
      res.on('end', () => {
        try { resolve({ status: res.statusCode, json: JSON.parse(d) }); } catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

async function main() {
  const auth = await postJson(
    `https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${API_KEY}`,
    { email: EMAIL, password: PASSWORD, returnSecureToken: true }
  );
  if (auth.status !== 200 || !auth.json.idToken) {
    throw new Error('Firebase sign-in failed: ' + JSON.stringify(auth.json));
  }
  const token = auth.json.idToken;
  console.log('Signed in.');

  const snapshot = { exportedAt: new Date().toISOString() };
  for (const node of ['kmbsc', 'kmbsc_private', 'kmbsc_admin']) {
    try {
      snapshot[node] = await getJson(`${DB_URL}/${node}.json?auth=${token}`);
      const n = snapshot[node] ? Object.keys(snapshot[node]).length : 0;
      console.log(`  ${node}: ${n} top-level key(s)`);
    } catch (e) {
      console.log(`  ${node}: could not read (${e.message})`);
      snapshot[node] = null;
    }
  }

  if (!snapshot.kmbsc) {
    console.error('kmbsc node came back empty — refusing to write an empty backup.');
    process.exit(1);
  }

  const dir = path.join(__dirname, 'backups');
  fs.mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().slice(0, 10);
  const file = path.join(dir, `kmbsc-${stamp}.json`);
  fs.writeFileSync(file, JSON.stringify(snapshot, null, 2));
  console.log('Wrote ' + file);

  const files = fs.readdirSync(dir).filter((f) => f.startsWith('kmbsc-') && f.endsWith('.json')).sort();
  while (files.length > KEEP) {
    const old = files.shift();
    fs.unlinkSync(path.join(dir, old));
    console.log('Pruned old snapshot ' + old);
  }
}

main().catch((e) => { console.error('Fatal:', e.message); process.exit(1); });
