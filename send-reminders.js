/**
 * KMBSC Payment Reminder Script
 * ------------------------------
 * Fetches data from Firebase RTDB (kmbsc path), figures out the current
 * month for each group, finds members who haven't paid yet, and sends
 * them a WhatsApp reminder via Twilio.
 *
 * Required environment variables (set as GitHub Actions secrets):
 *   FIREBASE_DB_URL          e.g. https://kmbsc-chit-default-rtdb.asia-southeast1.firebasedatabase.app
 *   FIREBASE_API_KEY         Firebase Web API key
 *   FIREBASE_AUTH_EMAIL      Email of a Firebase Authentication user with read access
 *   FIREBASE_AUTH_PASSWORD   Password for that user
 *   TWILIO_ACCOUNT_SID
 *   TWILIO_AUTH_TOKEN
 *   TWILIO_WHATSAPP_FROM     e.g. whatsapp:+14155238886
 */

const https = require('https');

const FIREBASE_DB_URL = process.env.FIREBASE_DB_URL;
const FIREBASE_API_KEY = process.env.FIREBASE_API_KEY;
const FIREBASE_AUTH_EMAIL = process.env.FIREBASE_AUTH_EMAIL;
const FIREBASE_AUTH_PASSWORD = process.env.FIREBASE_AUTH_PASSWORD;
const TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID;
const TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN;
const TWILIO_WHATSAPP_FROM = process.env.TWILIO_WHATSAPP_FROM;

if (
  !FIREBASE_DB_URL ||
  !FIREBASE_API_KEY ||
  !FIREBASE_AUTH_EMAIL ||
  !FIREBASE_AUTH_PASSWORD ||
  !TWILIO_ACCOUNT_SID ||
  !TWILIO_AUTH_TOKEN ||
  !TWILIO_WHATSAPP_FROM
) {
  console.error('Missing one or more required environment variables.');
  process.exit(1);
}

const MONTH_NAMES = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

// ---- Helpers -------------------------------------------------------------

function fetchJson(url) {
  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      let data = '';
      res.on('data', (chunk) => (data += chunk));
      res.on('end', () => {
        try {
          resolve(JSON.parse(data));
        } catch (err) {
          reject(err);
        }
      });
    }).on('error', reject);
  });
}

function postJson(url, payload) {
  const body = JSON.stringify(payload);
  return new Promise((resolve, reject) => {
    const req = https.request(
      url,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
        },
      },
      (res) => {
        let data = '';
        res.on('data', (chunk) => (data += chunk));
        res.on('end', () => {
          try {
            resolve({ status: res.statusCode, json: JSON.parse(data) });
          } catch (err) {
            reject(err);
          }
        });
      }
    );
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

// Signs in with Firebase Auth (email/password) and returns an ID token
async function getFirebaseIdToken() {
  const url = `https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${FIREBASE_API_KEY}`;
  const result = await postJson(url, {
    email: FIREBASE_AUTH_EMAIL,
    password: FIREBASE_AUTH_PASSWORD,
    returnSecureToken: true,
  });

  if (result.status !== 200 || !result.json.idToken) {
    throw new Error(`Firebase Auth sign-in failed: ${JSON.stringify(result.json)}`);
  }

  return result.json.idToken;
}
function postForm(url, formObj) {
  const body = Object.entries(formObj)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join('&');

  const auth = Buffer.from(`${TWILIO_ACCOUNT_SID}:${TWILIO_AUTH_TOKEN}`).toString('base64');

  return new Promise((resolve, reject) => {
    const req = https.request(
      url,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'Content-Length': Buffer.byteLength(body),
          Authorization: `Basic ${auth}`,
        },
      },
      (res) => {
        let data = '';
        res.on('data', (chunk) => (data += chunk));
        res.on('end', () => resolve({ status: res.statusCode, body: data }));
      }
    );
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

// Mirrors getCurrentMonthNum() logic from the KMBSC app
function getCurrentMonthNum(group) {
  const now = new Date();
  const nowAbsMonth = now.getFullYear() * 12 + now.getMonth(); // 0 = Jan
  const startAbsMonth = (group.startYear || 2026) * 12 + (group.startMonth || 0);
  const diff = nowAbsMonth - startAbsMonth + 1; // month 1 = startMonth
  return diff;
}

function monthLabel(group, monthNum) {
  const monIdx = ((group.startMonth || 0) + monthNum - 1) % 12;
  const yr = (group.startYear || 2026) + Math.floor(((group.startMonth || 0) + monthNum - 1) / 12);
  return `${MONTH_NAMES[monIdx]} ${yr}`;
}

function monthAmount(group, monthNum) {
  // group.amount is a flat per-month value in this schema; fall back gracefully
  return group.amount || 0;
}

// Convert a plain 10-digit Indian number into Twilio WhatsApp format
function toWhatsAppNumber(phone) {
  if (!phone) return null;
  const digits = String(phone).replace(/\D/g, '');
  if (digits.length === 10) return `whatsapp:+91${digits}`;
  if (digits.length === 12 && digits.startsWith('91')) return `whatsapp:+${digits}`;
  if (digits.length === 11 && digits.startsWith('0')) return `whatsapp:+91${digits.slice(1)}`;
  return `whatsapp:+${digits}`; // best-effort fallback
}

function buildMessage(memberName, groupName, monthText, amount) {
  return (
    `வணக்கம் ${memberName},\n` +
    `KMBSC ${groupName} - ${monthText} மாத contribution ₹${amount} இன்னும் pay ஆகவில்லை.\n` +
    `தயவுசெய்து விரைவில் pay செய்யவும்.\n` +
    `- KMBSC TEAM`
  );
}

// ---- Main -----------------------------------------------------------------

async function main() {
  console.log('Signing in to Firebase Auth...');
  const idToken = await getFirebaseIdToken();
  console.log('Signed in successfully.');

  console.log('Fetching KMBSC data from Firebase...');
  const data = await fetchJson(`${FIREBASE_DB_URL}/kmbsc.json?auth=${idToken}`);

  if (!data || !data.groups) {
    console.log('No data found at kmbsc path. Exiting.');
    return;
  }

  const groups = data.groups || [];
  const members = data.members || {};
  const payments = data.payments || {};

  const sendUrl = `https://api.twilio.com/2010-04-01/Accounts/${TWILIO_ACCOUNT_SID}/Messages.json`;

  let totalSent = 0;
  let totalFailed = 0;

  for (let gi = 0; gi < groups.length; gi++) {
    const group = groups[gi];
    if (!group) continue;

    const currentMonth = getCurrentMonthNum(group);
    if (currentMonth < 1 || currentMonth > (group.months || 11)) {
      console.log(`Group ${gi} (${group.name}): current month ${currentMonth} is out of range, skipping.`);
      continue;
    }

    const monthText = monthLabel(group, currentMonth);
    const amount = monthAmount(group, currentMonth);
    const groupMembers = members[gi] || {};
    const groupPayments = (payments[gi] && payments[gi][currentMonth]) || {};

    console.log(`\nGroup ${gi} (${group.name}) — ${monthText}`);

    for (const mid of Object.keys(groupMembers)) {
      const member = groupMembers[mid];
      if (!member || !member.name) continue;

      const paymentRecord = groupPayments[mid];
      const isPaid = paymentRecord && paymentRecord.paid;

      if (isPaid) {
        console.log(`  ✓ ${member.name} — already paid`);
        continue;
      }

      const toNumber = toWhatsAppNumber(member.phone);
      if (!toNumber) {
        console.log(`  ⚠ ${member.name} — no phone number, skipping`);
        continue;
      }

      const messageBody = buildMessage(member.name, group.name, monthText, paymentRecord ? paymentRecord.amount : amount);

      try {
        const result = await postForm(sendUrl, {
          From: TWILIO_WHATSAPP_FROM,
          To: toNumber,
          Body: messageBody,
        });

        if (result.status >= 200 && result.status < 300) {
          console.log(`  ➜ Reminder sent to ${member.name} (${toNumber})`);
          totalSent++;
        } else {
          console.log(`  ✗ Failed for ${member.name} (${toNumber}): ${result.status} ${result.body}`);
          totalFailed++;
        }
      } catch (err) {
        console.log(`  ✗ Error sending to ${member.name}: ${err.message}`);
        totalFailed++;
      }
    }
  }

  console.log(`\nDone. Sent: ${totalSent}, Failed: ${totalFailed}`);
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
