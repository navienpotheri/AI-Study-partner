// Voice-first study partner: a small Node server with no npm dependencies.
// Modes: demo (no keys needed) and Claude grading (ANTHROPIC_API_KEY set).
// Speech: browser recognition by default; Sarvam speech-to-text when SARVAM_API_KEY is set.

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = process.env.PORT || 3000;
const PUBLIC_DIR = path.join(__dirname, 'public');
const DATA_DIR = path.join(__dirname, 'data');
const PROGRESS_FILE = process.env.PROGRESS_FILE || path.join(DATA_DIR, 'progress.json');
const API_KEY = (process.env.ANTHROPIC_API_KEY || '').trim();
const MODEL = process.env.CLAUDE_MODEL || 'claude-haiku-5-5';
const SARVAM_KEY = (process.env.SARVAM_API_KEY || '').trim();
const SARVAM_MODEL = process.env.SARVAM_MODEL || 'saaras:v4';
// Email sign-in is optional. Without RESEND_API_KEY the app runs as a guest, and sign-in links are logged to the console for local testing.
const RESEND_API_KEY = (process.env.RESEND_API_KEY || '').trim();
// Demo sign-in: name and email sign the student in at once, with no link. For judges and testing only.
// It is also used when no email service is set up, so the app is usable with no keys at all.
const DEMO_SIGNIN = /^(1|true)$/i.test(process.env.DEMO_SIGNIN || '') || !RESEND_API_KEY;
const MAIL_FROM = process.env.MAIL_FROM || 'Study Partner <onboarding@resend.dev>';
const SESSION_DAYS = 30;
const LINK_MINUTES = 15;
const pendingLinks = new Map(); // hash of one-time token -> { emailHash, name, expires }
const sendLimits = new Map(); // email hash -> timestamps of recent requests
// token -> { studentId, name, createdAt }. Only a hashed Google id is kept; no email is stored.
const sessions = new Map();
const RECALL_PASS = 70;
const MAX_AUDIO_BYTES = 8 * 1024 * 1024;
const CHAPTER_SOURCE =
  'NCERT Class 8 Science, Chapter 8: Cell - Structure and Functions (check against your textbook edition)';
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const LANGUAGES = ['Hindi', 'Tamil', 'Telugu', 'Kannada', 'Malayalam'];
const LANG_CODES = { Hindi: 'hi-IN', Tamil: 'ta-IN', Telugu: 'te-IN', Kannada: 'kn-IN', Malayalam: 'ml-IN', English: 'en-IN' };

const chapter = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'class8-science.json'), 'utf8'));
// The built-in syllabus: every concept of NCERT Class 8 Science, chapter by chapter (see tools/build-syllabus.js).
const syllabus = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'syllabus-class8-science.json'), 'utf8'));
const ALL_CONCEPTS = syllabus.chapters.flatMap((ch) =>
  ch.concepts.map((c) => ({ ...c, chapter: ch.number, chapterTitle: ch.title }))
);
const DATABASE_URL = (process.env.DATABASE_URL || '').trim();
// Regional-language words for each key term. Matching accepts them as correct. Needs teacher review.
const aliases = readOptionalJson(path.join(DATA_DIR, 'aliases.json'), {});

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
};

function readOptionalJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    return fallback;
  }
}

// ---------- progress storage, one record per student ----------

// Progress lives in memory while the server runs. It is saved to Postgres when DATABASE_URL is set
// (so it survives restarts and deploys), and to a local file otherwise.
const store = { students: {}, pool: null, kind: 'file' };

async function initStorage() {
  if (DATABASE_URL) {
    try {
      const { Pool } = require('pg');
      const pool = new Pool({ connectionString: DATABASE_URL, max: 3 });
      await pool.query(
        'create table if not exists students (id text primary key, data jsonb not null, updated_at timestamptz not null default now())'
      );
      const { rows } = await pool.query('select id, data from students');
      for (const row of rows) store.students[row.id] = row.data;
      store.pool = pool;
      store.kind = 'database';
      return;
    } catch (err) {
      console.error('Database is not reachable, so progress is kept in a local file:', err.message);
    }
  }
  store.students = readOptionalJson(PROGRESS_FILE, { students: {} }).students || {};
}

function loadProgress(studentId) {
  const saved = store.students[studentId];
  return saved ? JSON.parse(JSON.stringify(saved)) : { attempts: [] };
}

function saveProgress(studentId, progress) {
  store.students[studentId] = progress;
  if (store.pool) {
    store.pool
      .query(
        'insert into students (id, data, updated_at) values ($1, $2, now()) on conflict (id) do update set data = excluded.data, updated_at = now()',
        [studentId, JSON.stringify(progress)]
      )
      .catch((err) => console.error('Could not save progress to the database:', err.message));
    return;
  }
  try {
    fs.mkdirSync(path.dirname(PROGRESS_FILE), { recursive: true });
    fs.writeFileSync(PROGRESS_FILE, JSON.stringify({ students: store.students }, null, 2));
  } catch (err) {
    console.error('Could not save progress:', err.message);
  }
}

// Sessions are signed tokens, so they survive a restart or redeploy as long as SESSION_SECRET stays the same.
const SESSION_SECRET = process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex');

function makeToken(data) {
  const body = Buffer.from(JSON.stringify(data)).toString('base64url');
  const sig = crypto.createHmac('sha256', SESSION_SECRET).update(body).digest('base64url');
  return `${body}.${sig}`;
}

function sessionFrom(req) {
  const token = String(req.headers['x-session'] || '');
  const [body, sig] = token.split('.');
  if (!body || !sig) return null;
  const expected = crypto.createHmac('sha256', SESSION_SECRET).update(body).digest('base64url');
  if (sig.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
  let session;
  try {
    session = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
  } catch (err) {
    return null;
  }
  if (Date.now() - session.createdAt > SESSION_DAYS * 86400000) return null;
  return session;
}

// A signed-in student is identified by their Google account (hashed). Guests use a browser-held id.
function studentIdFrom(req) {
  const session = sessionFrom(req);
  if (session) return session.studentId;
  const raw = String(req.headers['x-student-id'] || '');
  return /^[A-Za-z0-9-]{8,64}$/.test(raw) ? raw : 'guest';
}

function sha256(text) {
  return crypto.createHash('sha256').update(text).digest('hex');
}

function baseUrl(req) {
  const proto = req.headers['x-forwarded-proto'] || 'http';
  return `${proto}://${req.headers.host}`;
}

// Sends the confirmation link through Resend. With no key, the link goes to the console (local testing only).
async function sendSignInEmail(to, link) {
  if (!RESEND_API_KEY) {
    console.log(`[sign-in link, local testing only] ${link}`);
    return false;
  }
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${RESEND_API_KEY}` },
    body: JSON.stringify({
      from: MAIL_FROM,
      to: [to],
      subject: 'Confirm your Study Partner sign-in',
      html: `<p>Tap the link to confirm and start studying:</p>
             <p><a href="${link}">Confirm my sign-in</a></p>
             <p>The link works once and expires in ${LINK_MINUTES} minutes. If you did not ask for it, ignore this email.</p>`,
    }),
  });
  if (!res.ok) {
    // Log Resend's reason (never the key). The student sees only a generic message.
    const reason = await res.text().catch(() => '');
    console.error(`Resend rejected the email with status ${res.status}: ${reason}`);
    throw new Error(`Email sending failed with status ${res.status}`);
  }
  return true;
}

function withinSendLimit(emailHash) {
  const now = Date.now();
  const recent = (sendLimits.get(emailHash) || []).filter((t) => now - t < 10 * 60000);
  if (recent.length >= 3) return false;
  recent.push(now);
  sendLimits.set(emailHash, recent);
  return true;
}

// ---------- helpers ----------

function sendJson(res, status, body) {
  res.writeHead(status, { 'Content-Type': MIME['.json'], 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', (chunk) => {
      raw += chunk;
      if (raw.length > 100000) {
        reject(new Error('Request too large'));
        req.destroy();
      }
    });
    req.on('end', () => {
      try {
        resolve(raw ? JSON.parse(raw) : {});
      } catch (err) {
        reject(new Error('Body must be JSON'));
      }
    });
    req.on('error', reject);
  });
}

function readRawBody(req, maxBytes) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > maxBytes) {
        reject(new Error('Audio too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function findConcept(conceptId, progress) {
  return (progress ? conceptsFor(progress) : ALL_CONCEPTS).find((c) => c.id === conceptId);
}

function sourceFor(concept) {
  return typeof concept.chapter === 'number'
    ? `${syllabus.book}, Chapter ${concept.chapter}: ${concept.chapterTitle}`
    : `${concept.chapterTitle} (concept list drafted by AI; check with your textbook)`;
}

function clampScore(n) {
  return Math.max(0, Math.min(100, Math.round(n)));
}

// Demo feedback names what is missing, in plain words. No numbers are shown to the student.
function demoFeedback(concept, score, hits, missing) {
  const name = concept.name.toLowerCase();
  if (score >= 85) return `You explained ${name} clearly. You are good to go.`;
  if (hits.length) return `You have the main idea. Now add ${missing[0] || 'the last key point'}, and say it again.`;
  return `Start again: say in your own words what ${name} is.`;
}

// Scores stay inside the app. Students see a plain phrase, never a number.
function phraseFor(score) {
  if (score >= 85) return 'You sound very confident. You are good to go.';
  if (score >= 60) return "You're getting there. Revise the part that is still missing.";
  return 'You need to study more on this. Try it again slowly.';
}

function average(list) {
  return list.length ? list.reduce((s, n) => s + Number(n || 0), 0) / list.length : 0;
}

function daysUntil(isoDate) {
  const ms = new Date(isoDate + 'T00:00:00+05:30') - Date.now();
  return Math.max(0, Math.ceil(ms / 86400000));
}

// ---------- term matching: English key terms and regional aliases ----------

function levenshtein(a, b) {
  const rows = Array.from({ length: a.length + 1 }, (_, i) => [i]);
  for (let j = 1; j <= b.length; j++) rows[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      rows[i][j] = Math.min(
        rows[i - 1][j] + 1,
        rows[i][j - 1] + 1,
        rows[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)
      );
    }
  }
  return rows[a.length][b.length];
}

// A key term counts if it appears in English or as any regional alias.
// A word one letter away from an English key term is only flagged, so the app can ask "Did you mean...?".
function matchTerms(text, concept) {
  const lower = String(text || '').toLowerCase();
  const words = lower.match(/[a-z]+/g) || [];
  const conceptAliases = aliases[concept.id] || {};
  const hits = [];
  const maybe = [];
  for (const term of concept.keyTerms) {
    const candidates = [term, ...(conceptAliases[term] || [])].map((s) => s.toLowerCase());
    if (candidates.some((c) => lower.includes(c))) {
      hits.push(term);
      continue;
    }
    const termWords = term.toLowerCase().split(' ').filter((w) => w.length >= 4);
    const near = words.find((w) => w.length >= 4 && termWords.some((tw) => levenshtein(w, tw) === 1));
    if (near) maybe.push({ term, heard: near });
  }
  return { hits, maybe };
}

// ---------- demo grading (no key, deterministic) ----------

function demoGradeExplain(concept, answer) {
  const text = String(answer || '').toLowerCase();
  const { hits, maybe } = matchTerms(answer, concept);
  const missing = concept.keyTerms.filter((t) => !hits.includes(t));
  const trap = concept.misconceptions.find((m) => m.triggers.some((t) => text.includes(t.toLowerCase())));

  let score = (hits.length / concept.keyTerms.length) * 100;
  if (trap) score -= 20;

  return {
    score: clampScore(score),
    gotRight: hits.length ? `You named ${hits.slice(0, 3).join(', ')}. Good.` : 'You made a start. Keep going.',
    fix: trap ? trap.correction : missing.length ? `Add the idea of ${missing[0]}.` : 'Nothing to fix. Well done.',
    followUp: trap ? trap.followUp : concept.followUp,
    feedback: demoFeedback(concept, clampScore(score), hits, missing),
    didYouMean: maybe,
    source: 'demo',
  };
}

function demoGradeRecall(concept, answer) {
  const { hits, maybe } = matchTerms(answer, concept);
  const missing = concept.keyTerms.filter((t) => !hits.includes(t));
  const score = clampScore((hits.length / concept.keyTerms.length) * 100);
  return {
    score,
    passed: score >= RECALL_PASS,
    missing,
    hint: score >= RECALL_PASS ? '' : concept.hint,
    feedback: phraseFor(score),
    didYouMean: maybe,
    source: 'demo',
  };
}

// English practice: one sentence in English. Checks that key ideas are named in English.
function demoGradeEnglish(concept, sentence) {
  const lower = String(sentence || '').toLowerCase();
  const hits = concept.keyTerms.filter((t) => lower.includes(t.toLowerCase()));
  const score = clampScore((hits.length / concept.keyTerms.length) * 100);
  return {
    score,
    gotRight: hits.length ? `Good. You used ${hits.join(', ')} in English.` : 'Good try. Keep the English simple.',
    fix: hits.length < concept.keyTerms.length ? `Next, add the idea of ${concept.keyTerms.find((t) => !hits.includes(t))}.` : 'Clear and complete.',
    source: 'demo',
  };
}

// ---------- Claude grading (needs ANTHROPIC_API_KEY) ----------

async function claudeJson(system, user, maxTokens = 500) {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: maxTokens,
      system,
      messages: [{ role: 'user', content: user }],
    }),
  });
  if (!res.ok) {
    throw new Error(`Claude request failed with status ${res.status}`);
  }
  const data = await res.json();
  const text = (data.content || []).map((b) => b.text || '').join('');
  return JSON.parse(text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1));
}

async function claudeGradeExplain(concept, answer, language, lastQuestion) {
  const system =
    'You are a warm older sibling tutoring an Indian government school student in Class 8 Science, by voice. ' +
    `The student explains in ${language}; exam terms may be in English. Grade the MEANING, never the ` +
    'pronunciation or grammar. Accept key terms in either language. Never give the answer directly; guide them. ' +
    `Write "feedback" and "followUp" the way people really talk in ${language}: simple everyday spoken words in ${language} script, ` +
    'with science words kept in English. They will be read aloud, so use short sentences and no symbols. ' +
    'Reply ONLY with JSON: {"score":0-100,"feedback":"one honest, kind sentence on how the explanation went, with no numbers",' +
    '"gotRight":"one short sentence","fix":"the specific misconception or missing idea, one short sentence",' +
    '"followUp":"one question that targets the misconception, under 20 words"}. Keep every sentence short.';
  const user =
    (lastQuestion ? `Your last question to the student (they may be answering it): ${lastQuestion}\n` : '') +
    `Concept: ${concept.name}\n` +
    `Reference definition (for you only, do not reveal): ${concept.definition}\n` +
    `Key terms: ${concept.keyTerms.join(', ')}\n` +
    `Known misconceptions: ${concept.misconceptions.map((m) => m.correction).join(' | ')}\n` +
    `Student said: """${answer}"""`;
  const result = await claudeJson(system, user);
  return { ...result, score: clampScore(result.score), source: 'claude' };
}

async function claudeGradeRecall(concept, answer, language) {
  const system =
    'You check whether a student recited a definition correctly. Flag MISSING or WRONG key terms only, ' +
    'never word-for-word differences. Accept terms in either the home language or English. ' +
    `The student speaks ${language}. Reply ONLY with JSON: ` +
    '{"score":0-100,"missing":["key terms missing or wrong"],"hint":"one hint in the home language with English terms, under 20 words"}.';
  const user = `Concept: ${concept.name}\nKey terms: ${concept.keyTerms.join(', ')}\nStudent said: """${answer}"""`;
  const result = await claudeJson(system, user);
  const score = clampScore(result.score);
  return {
    score,
    passed: score >= RECALL_PASS,
    missing: result.missing || [],
    hint: score >= RECALL_PASS ? '' : result.hint || concept.hint,
    source: 'claude',
  };
}

// ---------- Sarvam speech-to-text (needs SARVAM_API_KEY) ----------

async function sarvamTranscribe(audio, contentType, languageCode) {
  // iPhones record MP4 audio, so the file name must match the real format, or Sarvam rejects it.
  const type = String(contentType || 'audio/webm').split(';')[0].trim();
  const extension = /mp4|m4a|aac/.test(type) ? 'mp4' : /ogg/.test(type) ? 'ogg' : /wav/.test(type) ? 'wav' : 'webm';
  const form = new FormData();
  form.append('file', new Blob([audio], { type }), `speech.${extension}`);
  form.append('model', SARVAM_MODEL);
  form.append('mode', 'codemix'); // keeps English words in English alongside the regional language
  form.append('language_code', languageCode);
  const res = await fetch('https://api.sarvam.ai/speech-to-text', {
    method: 'POST',
    headers: { 'api-subscription-key': SARVAM_KEY },
    body: form,
  });
  if (!res.ok) {
    // Log Sarvam's reason (never the key) so the logs show what to fix.
    const reason = await res.text().catch(() => '');
    console.error(`Sarvam request failed with status ${res.status}: ${reason.slice(0, 300)}`);
    throw new Error(`Sarvam request failed with status ${res.status}`);
  }
  const data = await res.json();
  return {
    transcript: data.transcript || '',
    language: data.language_code || languageCode,
    probability: data.language_probability ?? null,
  };
}

// ---------- Sarvam text-to-speech: the app's own voice (needs SARVAM_API_KEY) ----------

const SARVAM_TTS_MODEL = process.env.SARVAM_TTS_MODEL || 'bulbul:v3';
const SARVAM_SPEAKER = process.env.SARVAM_SPEAKER || 'priya';

async function sarvamSpeak(text, languageCode) {
  const res = await fetch('https://api.sarvam.ai/text-to-speech', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'api-subscription-key': SARVAM_KEY },
    body: JSON.stringify({
      text,
      language_code: languageCode,
      model: SARVAM_TTS_MODEL,
      speaker: SARVAM_SPEAKER,
      output_audio_codec: 'mp3',
    }),
  });
  if (!res.ok) {
    const reason = await res.text().catch(() => '');
    console.error(`Sarvam voice failed with status ${res.status}: ${reason.slice(0, 300)}`);
    throw new Error(`Sarvam voice failed with status ${res.status}`);
  }
  const data = await res.json();
  return Buffer.from((data.audios || []).join(''), 'base64');
}

// ---------- exam setup (by voice or text) ----------

// Demo parser: reads the common phrasing from a spoken description. Claude mode uses claudeParseExam.
function parseExamDemo(text) {
  const t = text.toLowerCase();
  const cls = t.match(/class\s*(\d{1,2})/);
  const subjects = { science: 'Science', maths: 'Maths', math: 'Maths', english: 'English', social: 'Social Science' };
  const subjectKey = Object.keys(subjects).find((k) => t.includes(k));
  const chapters = t.match(/chapters?\s*(\d{1,2})\s*(?:to|-|through|till)\s*(\d{1,2})/);
  const date = t.match(/(\d{1,2})(?:st|nd|rd|th)?\s+(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*/);
  const pct = t.match(/(\d{1,3})\s*(?:%|percent)/);

  let examDate = null;
  if (date) {
    const month = MONTHS.indexOf(date[2]);
    const now = new Date();
    let year = now.getFullYear();
    if (new Date(year, month, Number(date[1])) < now) year += 1;
    examDate = `${year}-${String(month + 1).padStart(2, '0')}-${String(date[1]).padStart(2, '0')}`;
  }

  return {
    class: cls ? Number(cls[1]) : null,
    subject: subjectKey ? subjects[subjectKey] : null,
    chapters: chapters ? [Number(chapters[1]), Number(chapters[2])] : null,
    examDate,
    preparedPct: pct ? Number(pct[1]) : null,
  };
}

async function claudeParseExam(text) {
  const system =
    "Extract exam details from a student's spoken description. Reply ONLY with JSON: " +
    '{"class":number|null,"subject":string|null,"chapters":[from,to]|null,"topics":["chapter or topic names, if the student named any"]|null,' +
    '"examDate":"YYYY-MM-DD"|null,"preparedPct":number|null}. ' +
    `Today is ${todayKey()}; a date with no year means the next such date. Use null for anything not stated. Do not guess.`;
  return claudeJson(system, text);
}

function examQuestions(parsed) {
  const questions = [];
  if (!parsed.class) questions.push('Which class is it?');
  if (!parsed.subject) questions.push('Which subject?');
  if (!parsed.chapters && !(parsed.topics && parsed.topics.length)) questions.push('Which chapters does the exam cover?');
  if (!parsed.examDate) questions.push('When is the exam?');
  return questions;
}

// ---------- learner memory, review, rapid-fire, adaptive language ----------

// Spaced review: a correct answer doubles the wait, a hesitant one keeps it, a failure resets it to one day.
function updateMemory(progress, conceptId, score) {
  progress.memory = progress.memory || {};
  // The first time a concept is explained well enough, note the day. The plan counts it as learned.
  progress.learnedOn = progress.learnedOn || {};
  if (score >= LEARNED_SCORE && !progress.learnedOn[conceptId]) progress.learnedOn[conceptId] = todayKey();
  const prev = progress.memory[conceptId] || { interval: 1 };
  const correct = score >= 85;
  const hesitant = score >= 60 && score < 85;
  const interval = correct ? Math.max(1, prev.interval * 2) : hesitant ? Math.max(1, prev.interval) : 1;
  progress.memory[conceptId] = {
    interval,
    lastResult: correct ? 'correct' : hesitant ? 'hesitant' : 'failed',
    lastScore: score,
    nextReview: Date.now() + interval * 86400000,
  };
}

// ---------- exams, scope and the study plan ----------

const LEARNED_SCORE = 60;

function todayKey() {
  // The study day follows Indian time.
  return new Date(Date.now() + 5.5 * 3600000).toISOString().slice(0, 10);
}

function conceptsFor(progress) {
  return ALL_CONCEPTS.concat(progress.custom || []);
}

function isLearned(memory, id) {
  return Boolean(memory[id] && memory[id].lastScore >= LEARNED_SCORE);
}

// Exams still ahead, soonest first. With no exam set up, a small demo exam on Chapter 2 is used.
function examsOf(progress) {
  const upcoming = (progress.exams || []).filter((e) => e.examDate >= todayKey());
  if (upcoming.length) return upcoming.sort((a, b) => a.examDate.localeCompare(b.examDate));
  return [{
    id: 'demo',
    isDefault: true,
    class: 8,
    subject: 'Science',
    chapters: [2, 2],
    examDate: chapter.examDate,
    conceptIds: ALL_CONCEPTS.filter((c) => c.chapter === 2).map((c) => c.id),
  }];
}

// Every concept the student must know, in the order to learn it: soonest exam first, then book order.
function scopeConcepts(progress) {
  const byId = new Map(conceptsFor(progress).map((c) => [c.id, c]));
  const seen = new Set();
  const list = [];
  for (const exam of examsOf(progress)) {
    for (const id of exam.conceptIds) {
      if (seen.has(id) || !byId.has(id)) continue;
      seen.add(id);
      list.push(byId.get(id));
    }
  }
  return list;
}

// The plan is worked out fresh each day, so a missed day is caught up automatically:
// what is still unlearned is spread over the learning days left before each exam.
// The last days before an exam (up to five) are kept for revision.
function buildPlan(progress) {
  const memory = progress.memory || {};
  const scope = scopeConcepts(progress);
  const byId = new Map(scope.map((c) => [c.id, c]));
  const counted = new Set();
  let stillToLearn = 0;
  let quota = 0;

  const exams = examsOf(progress).map((exam) => {
    const daysLeft = daysUntil(exam.examDate);
    const revisionDays = Math.min(5, Math.floor(daysLeft * 0.2));
    const learnDays = Math.max(1, daysLeft - revisionDays);
    for (const id of exam.conceptIds) {
      if (counted.has(id) || !byId.has(id)) continue;
      counted.add(id);
      if (!isLearned(memory, id)) stillToLearn += 1;
    }
    const needPerDay = Math.ceil(stillToLearn / learnDays);
    quota = Math.max(quota, needPerDay);
    const ids = exam.conceptIds.filter((id) => byId.has(id));
    return {
      id: exam.id,
      isDefault: Boolean(exam.isDefault),
      generated: Boolean(exam.generated),
      class: exam.class,
      subject: exam.subject,
      chapters: exam.chapters || null,
      topics: exam.topics || null,
      examDate: exam.examDate,
      daysLeft,
      revisionDays,
      total: ids.length,
      learned: ids.filter((id) => isLearned(memory, id)).length,
      needPerDay,
    };
  });

  const unlearned = scope.filter((c) => !isLearned(memory, c.id));
  const learnedToday = Object.values(progress.learnedOn || {}).filter((day) => day === todayKey()).length;
  const learnNow = unlearned.slice(0, Math.max(0, quota - learnedToday));
  const reviewNow = scope
    .filter((c) => isLearned(memory, c.id) && memory[c.id].nextReview <= Date.now())
    .slice(0, 5);
  const item = (c, kind) => ({ conceptId: c.id, name: c.name, chapter: c.chapter, kind });

  // A day-by-day view of what is left, at today's pace.
  const days = [];
  let cursor = 0;
  for (let d = 0; cursor < unlearned.length && d < 120; d += 1) {
    const take = d === 0 ? learnNow.length : quota;
    const slice = unlearned.slice(cursor, cursor + take);
    cursor += take;
    if (!slice.length) continue;
    const date = new Date(Date.now() + 5.5 * 3600000 + d * 86400000).toISOString().slice(0, 10);
    days.push({ day: d + 1, date, concepts: slice.map((c) => c.name), chapter: slice[0].chapter });
  }

  return {
    exams,
    quota,
    learnedToday,
    today: learnNow.map((c) => item(c, 'learn')).concat(reviewNow.map((c) => item(c, 'review'))),
    days,
    totals: { total: scope.length, learned: scope.length - unlearned.length },
    heavy: quota > 8,
    hasExam: !exams[0].isDefault,
  };
}

// A short spoken summary of the plan.
function planSummary(plan) {
  const first = plan.exams[0];
  const left = plan.totals.total - plan.totals.learned;
  const todayNames = plan.today.filter((t) => t.kind === 'learn').slice(0, 3).map((t) => t.name).join(', ');
  return (
    `Your ${first.subject} exam is in ${first.daysLeft} days. ` +
    `There are ${left} concepts left to learn. That is ${plan.quota} a day. ` +
    (plan.heavy ? 'That is a heavy plan, so start today. ' : '') +
    (todayNames ? `Today we start with ${todayNames}.` : 'You are done for today.')
  );
}

// Concepts for an exam on the built-in syllabus, by chapter range.
function builtInConceptIds(parsed) {
  if (parsed.class !== 8 || !/science/i.test(parsed.subject || '') || !parsed.chapters) return null;
  const [from, to] = parsed.chapters;
  const ids = ALL_CONCEPTS.filter((c) => c.chapter >= from && c.chapter <= to).map((c) => c.id);
  return ids.length ? ids : null;
}

// For any other class or subject, Claude drafts the concept list from the chapter names the student gives.
async function claudeDraftConcepts(parsed) {
  const system =
    `List what a Class ${parsed.class} student in India must know for a ${parsed.subject} exam on the given chapters. ` +
    'Give 5 to 9 concepts for each chapter, covering the whole chapter. Reply ONLY with JSON: ' +
    '{"chapters":[{"title":"...","concepts":[{"name":"...","definition":"one or two plain sentences","keyTerms":["three","short","terms"],"followUp":"one short question"}]}]}';
  const result = await claudeJson(system, `Chapters: ${parsed.topics.join('; ')}`, 6000);
  const stamp = Date.now().toString(36);
  return (result.chapters || []).flatMap((ch, ci) =>
    (ch.concepts || []).map((c, i) => ({
      id: `x${stamp}-${ci}-${i}`,
      name: String(c.name || '').slice(0, 80),
      definition: String(c.definition || '').slice(0, 400),
      keyTerms: (c.keyTerms || []).slice(0, 4).map((t) => String(t).slice(0, 40)),
      hint: `Think about these words: ${(c.keyTerms || []).slice(0, 2).join(' and ')}.`,
      followUp: String(c.followUp || 'Can you give an example?').slice(0, 200),
      misconceptions: [],
      chapter: String(ch.title || parsed.subject).slice(0, 60),
      chapterTitle: String(ch.title || parsed.subject).slice(0, 60),
    }))
  );
}

function dueConcepts(progress) {
  const memory = progress.memory || {};
  return scopeConcepts(progress).filter((c) => isLearned(memory, c.id) && memory[c.id].nextReview <= Date.now());
}

// Adaptive language: home language first, then mixed, then English, as the student's English share rises.
function languageMode(progress, conceptId) {
  const recent = (progress.attempts || [])
    .filter((a) => a.type === 'explain' && a.conceptId === conceptId && a.meta)
    .slice(-3);
  if (!recent.length) return 'home';
  const share = average(recent.map((a) => a.meta.englishShare));
  return share < 0.3 ? 'home' : share < 0.7 ? 'mixed' : 'english';
}

// Rapid-fire: weak and due concepts first, then the rest in a varied order.
function rapidFireQueue(progress) {
  const memory = progress.memory || {};
  const scope = scopeConcepts(progress);
  const weak = scope.filter((c) => memory[c.id] && memory[c.id].lastResult !== 'correct').map((c) => c.id);
  const due = dueConcepts(progress).map((c) => c.id);
  // Concepts already studied come before ones not yet started.
  const studied = scope.filter((c) => memory[c.id]).map((c) => c.id).sort(() => Math.random() - 0.5);
  const rest = scope.map((c) => c.id);
  return [...new Set([...weak, ...due, ...studied, ...rest])].slice(0, 5);
}

// Daily history for the dashboard chart: one point per day, the last 14 days with answers.
function dailyHistory(explains) {
  const days = {};
  for (const a of explains) {
    const day = new Date(a.at).toISOString().slice(0, 10);
    (days[day] = days[day] || []).push(a.score);
  }
  return Object.keys(days)
    .sort()
    .slice(-14)
    .map((day) => ({ day, answers: days[day].length, avgScore: Math.round(average(days[day])) }));
}

// ---------- dashboard ----------

function buildDashboard(progress) {
  const attempts = progress.attempts;
  const plan = buildPlan(progress);
  const scope = scopeConcepts(progress);
  const memory = progress.memory || {};
  const explains = attempts.filter((a) => a.type === 'explain');
  const recalls = attempts.filter((a) => a.type === 'recall');
  const englishPractice = attempts.filter((a) => a.type === 'english');
  const total = scope.length;
  const learned = plan.totals.learned;

  const bestByConcept = {};
  for (const a of explains) {
    bestByConcept[a.conceptId] = Math.max(bestByConcept[a.conceptId] || 0, a.score);
  }
  const scopeScores = scope.filter((c) => bestByConcept[c.id] !== undefined).map((c) => bestByConcept[c.id]);
  const mastery = Math.round(average(scopeScores));
  const retention = recalls.length ? Math.round((recalls.filter((a) => a.passed).length / recalls.length) * 100) : 0;

  // Confidence: concepts not yet practised count as zero, so it only rises as the syllabus is covered.
  const readiness = Math.round(scope.reduce((s, c) => s + (bestByConcept[c.id] || 0), 0) / Math.max(1, total));
  // The range narrows as more explanations are graded (about 1/sqrt(n), kept between 5 and 30 points).
  const spread = Math.max(5, Math.min(30, Math.round(40 / Math.sqrt(explains.length + 1))));

  const first = plan.exams[0];
  const weekAgo = Date.now() - 7 * 86400000;
  const learnedThisWeek = Object.values(progress.learnedOn || {}).filter((d) => new Date(d).getTime() >= weekAgo).length;

  // Fluency: filler words and response delay from the browser's timing. Estimate only.
  const withMeta = explains.filter((a) => a.meta);
  const fluency = withMeta.length
    ? clampScore(
        100 -
          average(withMeta.map((a) => a.meta.fillers)) * 10 -
          Math.max(0, average(withMeta.map((a) => a.meta.responseMs)) / 1000 - 3) * 5
      )
    : null;
  // English readiness: share of each answer's words that are English.
  const englishReadiness = explains.length
    ? Math.round(average(explains.map((a) => (a.meta ? a.meta.englishShare : 0))) * 100)
    : null;
  const termsLearned = new Set(explains.flatMap((a) => a.termsHit || [])).size;

  const strong = scope.filter((c) => (bestByConcept[c.id] || 0) >= 85).map((c) => c.name);
  const weak = scope.filter((c) => bestByConcept[c.id] !== undefined && bestByConcept[c.id] < LEARNED_SCORE).map((c) => c.name);
  const chaptersLeft = new Set(scope.filter((c) => !isLearned(memory, c.id)).map((c) => c.chapter)).size;

  return {
    chapter: plan.exams.map((e) => `${e.subject}, Class ${e.class}`).join(' · '),
    exam: { class: first.class, subject: first.subject, preparedPct: null },
    exams: plan.exams,
    examDate: first.examDate,
    daysLeft: first.daysLeft,
    coverage: { practised: learned, total, pct: Math.round((learned / Math.max(1, total)) * 100), chaptersLeft },
    mastery,
    retention,
    fluency,
    englishReadiness,
    englishPractice: englishPractice.length,
    termsLearned,
    pace: { needPerDay: plan.quota, actualPerDay: Math.round((learnedThisWeek / 7) * 10) / 10 },
    readiness: {
      score: readiness,
      low: Math.max(0, readiness - spread),
      high: Math.min(100, readiness + spread),
      label: 'Estimate, not a guarantee.',
    },
    due: plan.today.length,
    history: dailyHistory(explains),
    todayPlan: plan.today.map((t) => `${t.kind === 'learn' ? 'Learn' : 'Review'}: ${t.name}`),
    strong: strong.slice(0, 5),
    weak: weak.slice(0, 5),
    lastLanguage: progress.lastLanguage || null,
    mode: API_KEY ? 'claude' : 'demo',
  };
}
// ---------- routes ----------

async function handleApi(req, res, url) {
  const studentId = studentIdFrom(req);

  if (req.method === 'GET' && url.pathname === '/api/status') {
    return sendJson(res, 200, {
      mode: API_KEY ? 'claude' : 'demo',
      model: API_KEY ? MODEL : null,
      stt: SARVAM_KEY ? 'sarvam' : 'browser',
      tts: SARVAM_KEY ? 'sarvam' : 'browser',
      storage: store.kind,
      sttModel: SARVAM_KEY ? SARVAM_MODEL : null,
      languages: LANGUAGES,
    });
  }

  if (req.method === 'GET' && url.pathname === '/api/config') {
    return sendJson(res, 200, { signInReady: true, emailReady: Boolean(RESEND_API_KEY) });
  }

  if (req.method === 'GET' && url.pathname === '/api/me') {
    const progress = loadProgress(studentId);
    const session = sessionFrom(req);
    return sendJson(res, 200, {
      studentId,
      signedIn: Boolean(session),
      name: session ? session.name : null,
      lastLanguage: progress.lastLanguage || null,
      examSet: Boolean((progress.exams || []).length),
    });
  }

  // Step 1: the student enters an email and first name. We email a one-time link.
  if (req.method === 'POST' && url.pathname === '/api/auth/request') {
    const body = await readJsonBody(req);
    const email = String(body.email || '').trim().toLowerCase().slice(0, 120);
    const name = String(body.name || '').trim().slice(0, 30) || 'Student';
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return sendJson(res, 400, { error: 'Enter a valid email address.' });
    const emailHash = sha256(email);
    if (DEMO_SIGNIN) {
      const demoToken = makeToken({ studentId: `d-${emailHash.slice(0, 24)}`, name, createdAt: Date.now() });
      return sendJson(res, 200, { token: demoToken, name, demo: true });
    }
    if (!withinSendLimit(emailHash)) {
      return sendJson(res, 429, { error: 'Too many links requested. Wait ten minutes and try again.' });
    }
    const token = crypto.randomBytes(24).toString('hex');
    pendingLinks.set(sha256(token), { emailHash, name, expires: Date.now() + LINK_MINUTES * 60000 });
    try {
      await sendSignInEmail(email, `${baseUrl(req)}/?verify=${token}`);
    } catch (err) {
      console.error(err.message);
      return sendJson(res, 502, { error: 'We could not send the email. Try again in a few minutes.' });
    }
    return sendJson(res, 200, { sent: true, emailReady: Boolean(RESEND_API_KEY) });
  }

  // Step 2: the student taps the link, and the page sends the token here. The token works once.
  if (req.method === 'POST' && url.pathname === '/api/auth/verify') {
    const body = await readJsonBody(req);
    const key = sha256(String(body.token || ''));
    const pending = pendingLinks.get(key);
    pendingLinks.delete(key);
    if (!pending || pending.expires < Date.now()) {
      return sendJson(res, 401, { error: 'This link has expired or was already used. Request a new one.' });
    }
    const sessionToken = makeToken({
      studentId: `e-${pending.emailHash.slice(0, 24)}`,
      name: pending.name,
      createdAt: Date.now(),
    });
    return sendJson(res, 200, { token: sessionToken, name: pending.name });
  }

  if (req.method === 'POST' && url.pathname === '/api/auth/logout') {
    sessions.delete(String(req.headers['x-session'] || ''));
    return sendJson(res, 200, { ok: true });
  }

  if (req.method === 'GET' && url.pathname === '/api/chapter') {
    const progress = loadProgress(studentId);
    const exams = examsOf(progress);
    return sendJson(res, 200, {
      title: exams.map((e) => `${e.subject}, Class ${e.class}`).join(' · '),
      examDate: exams[0].examDate,
      concepts: scopeConcepts(progress).map((c) => ({ id: c.id, name: c.name, definition: c.definition, chapter: c.chapter })),
    });
  }

  if (req.method === 'POST' && url.pathname === '/api/transcribe') {
    if (!SARVAM_KEY) return sendJson(res, 404, { error: 'Sarvam is not configured. Use browser speech.' });
    const audio = await readRawBody(req, MAX_AUDIO_BYTES);
    if (!audio.length) return sendJson(res, 400, { error: 'No audio received' });
    const requested = url.searchParams.get('lang') || 'Hindi';
    const languageCode = LANG_CODES[requested] || 'unknown';
    try {
      const result = await sarvamTranscribe(audio, req.headers['content-type'], languageCode);
      return sendJson(res, 200, result);
    } catch (err) {
      console.error(err.message);
      return sendJson(res, 502, { error: 'Speech service unavailable. Try again or type your answer.' });
    }
  }

  if (req.method === 'POST' && url.pathname === '/api/explain') {
    const body = await readJsonBody(req);
    const concept = findConcept(body.conceptId, loadProgress(studentId));
    if (!concept) return sendJson(res, 404, { error: 'Unknown concept' });
    const answer = String(body.answer || '').slice(0, 2000);
    if (!answer.trim()) return sendJson(res, 400, { error: 'Empty answer' });

    const language = LANGUAGES.includes(body.language) ? body.language : 'Hindi';
    let result;
    if (API_KEY) {
      try {
        result = await claudeGradeExplain(concept, answer, language, String(body.followUp || '').slice(0, 300));
      } catch (err) {
        console.error(err.message);
        result = { ...demoGradeExplain(concept, answer), source: 'demo-fallback' };
      }
    } else {
      result = demoGradeExplain(concept, answer);
    }

    // Grounded feedback: name the concept and its source so the student can see where it comes from.
    result.citation = { concept: concept.name, source: sourceFor(concept) };

    const meta = body.meta && typeof body.meta === 'object' ? body.meta : {};
    const progress = loadProgress(studentId);
    progress.attempts.push({
      type: 'explain',
      conceptId: concept.id,
      score: result.score,
      at: Date.now(),
      language,
      meta: {
        responseMs: Number(meta.responseMs) || 0,
        fillers: Number(meta.fillers) || 0,
        englishShare: Math.min(1, Math.max(0, Number(meta.englishShare) || 0)),
      },
      termsHit: matchTerms(answer, concept).hits,
    });
    progress.lastLanguage = language;
    updateMemory(progress, concept.id, result.score);
    result.languageMode = languageMode(progress, concept.id);
    saveProgress(studentId, progress);
    // Tell the app what comes next in today's plan, so the session can move on by voice.
    const todayLeft = buildPlan(progress).today.filter((t) => t.conceptId !== concept.id);
    result.learned = isLearned(progress.memory, concept.id);
    result.next = todayLeft[0] || null;
    result.leftToday = todayLeft.length;
    return sendJson(res, 200, result);
  }

  // The app's voice: turns a reply into speech with Sarvam, so it sounds natural in Indian languages.
  if (req.method === 'POST' && url.pathname === '/api/speak') {
    if (!SARVAM_KEY) return sendJson(res, 404, { error: 'Voice service is not configured.' });
    const body = await readJsonBody(req);
    const text = String(body.text || '').trim().slice(0, 700);
    if (!text) return sendJson(res, 400, { error: 'Nothing to say' });
    try {
      const audio = await sarvamSpeak(text, LANG_CODES[body.language] || 'en-IN');
      res.writeHead(200, { 'Content-Type': 'audio/mpeg', 'Cache-Control': 'no-store' });
      return res.end(audio);
    } catch (err) {
      return sendJson(res, 502, { error: 'Voice service unavailable.' });
    }
  }

  // Learn first: the app explains the concept aloud before the student explains it back.
  if (req.method === 'GET' && url.pathname === '/api/learn') {
    const concept = findConcept(url.searchParams.get('conceptId'), loadProgress(studentId));
    if (!concept) return sendJson(res, 404, { error: 'Unknown concept' });
    const requested = url.searchParams.get('language');
    const language = LANGUAGES.includes(requested) ? requested : 'Hindi';
    const memory = loadProgress(studentId).memory || {};
    const learned = Boolean(memory[concept.id] && memory[concept.id].lastResult === 'correct');
    let say = learned
      ? `You know ${concept.name}. Explain it to me in your own words.`
      : `${concept.definition} Now you explain it to me, in your own words.`;
    let lang = 'English';
    if (API_KEY) {
      try {
        const system =
          `You are a warm older sibling helping a Class 8 student who speaks ${language} at home. ` +
          `Speak the way people really talk in ${language}: simple everyday spoken words in ${language} script, never formal textbook language. ` +
          'Keep science words in English. This will be read aloud, so use short sentences and no lists or symbols. ' +
          (learned
            ? 'The student already knows this concept. In one sentence, ask them to explain it in their own words. '
            : 'Explain the concept in two or three short sentences with one everyday example, then ask the student to explain it back in their own words. ') +
          'Reply ONLY with JSON: {"text":"..."}';
        const result = await claudeJson(system, `Concept: ${concept.name}. Reference: ${concept.definition}`);
        if (result.text) {
          say = result.text;
          lang = language;
        }
      } catch (err) {
        console.error(err.message);
      }
    }
    return sendJson(res, 200, { say, lang, learned, source: lang === 'English' ? 'demo' : 'claude' });
  }

  if (req.method === 'POST' && url.pathname === '/api/english') {
    const body = await readJsonBody(req);
    const concept = findConcept(body.conceptId, loadProgress(studentId));
    if (!concept) return sendJson(res, 404, { error: 'Unknown concept' });
    const sentence = String(body.sentence || '').slice(0, 500);
    if (!sentence.trim()) return sendJson(res, 400, { error: 'Empty sentence' });
    const result = demoGradeEnglish(concept, sentence);
    const progress = loadProgress(studentId);
    progress.attempts.push({ type: 'english', conceptId: concept.id, score: result.score, at: Date.now() });
    saveProgress(studentId, progress);
    return sendJson(res, 200, result);
  }

  if (req.method === 'POST' && url.pathname === '/api/recall') {
    const body = await readJsonBody(req);
    const concept = findConcept(body.conceptId, loadProgress(studentId));
    if (!concept) return sendJson(res, 404, { error: 'Unknown concept' });
    const answer = String(body.answer || '').slice(0, 2000);
    if (!answer.trim()) return sendJson(res, 400, { error: 'Empty answer' });

    const language = LANGUAGES.includes(body.language) ? body.language : 'Hindi';
    let result;
    if (API_KEY) {
      try {
        result = await claudeGradeRecall(concept, answer, language);
      } catch (err) {
        console.error(err.message);
        result = { ...demoGradeRecall(concept, answer), source: 'demo-fallback' };
      }
    } else {
      result = demoGradeRecall(concept, answer);
    }

    const progress = loadProgress(studentId);
    progress.attempts.push({ type: 'recall', conceptId: concept.id, score: result.score, passed: result.passed, at: Date.now() });
    updateMemory(progress, concept.id, result.score);
    saveProgress(studentId, progress);
    return sendJson(res, 200, result);
  }

  if (req.method === 'POST' && url.pathname === '/api/exam-setup') {
    const body = await readJsonBody(req);
    const text = String(body.text || '').slice(0, 1000);
    if (!text.trim()) return sendJson(res, 400, { error: 'Empty description' });

    let parsed;
    let source = 'demo';
    if (API_KEY) {
      try {
        parsed = await claudeParseExam(text);
        source = 'claude';
      } catch (err) {
        console.error(err.message);
        parsed = parseExamDemo(text);
        source = 'demo-fallback';
      }
    } else {
      parsed = parseExamDemo(text);
    }

    const missing = examQuestions(parsed);
    if (missing.length) {
      return sendJson(res, 200, { parsed, missing, saved: false, source, message: 'A few details are missing.', say: missing[0] });
    }
    if (parsed.examDate < todayKey()) {
      return sendJson(res, 200, { parsed, missing: ['When is the exam? That date has passed.'], saved: false, source, message: 'That date has passed.', say: 'That date has passed. When is the exam?' });
    }

    const progress = loadProgress(studentId);
    let conceptIds = builtInConceptIds(parsed);
    let generated = false;
    if (!conceptIds) {
      // Not in the built-in syllabus: draft the concept list from the chapter names, if the AI key is set.
      const hasTopics = parsed.topics && parsed.topics.length;
      if (!API_KEY) {
        const message = 'Without the AI key, I can plan Class 8 Science, chapters 1 to 13. Other classes and subjects need the AI key.';
        return sendJson(res, 200, { parsed, missing: [], saved: false, source, message, say: message });
      }
      if (!hasTopics) {
        const ask = 'Tell me the names of the chapters in this exam, so I can list every concept.';
        return sendJson(res, 200, { parsed, missing: [ask], saved: false, source, message: 'I need the chapter names.', say: ask });
      }
      try {
        const drafted = await claudeDraftConcepts(parsed);
        if (!drafted.length) throw new Error('No concepts drafted');
        progress.custom = (progress.custom || []).concat(drafted);
        conceptIds = drafted.map((c) => c.id);
        generated = true;
      } catch (err) {
        console.error(err.message);
        const message = 'I could not build the concept list just now. Please try again.';
        return sendJson(res, 200, { parsed, missing: [], saved: false, source, message, say: message });
      }
    }

    // One exam per subject and date: describing it again replaces it. Other exams are kept.
    const id = `${String(parsed.subject).toLowerCase()}-${parsed.class}-${parsed.examDate}`;
    progress.exams = (progress.exams || []).filter((e) => e.id !== id);
    progress.exams.push({
      id,
      class: parsed.class,
      subject: parsed.subject,
      chapters: generated ? null : parsed.chapters,
      topics: generated ? parsed.topics : null,
      examDate: parsed.examDate,
      preparedPct: parsed.preparedPct ?? null,
      conceptIds,
      generated,
      setAt: Date.now(),
    });
    saveProgress(studentId, progress);
    const plan = buildPlan(progress);
    const say = planSummary(plan);
    return sendJson(res, 200, { parsed, missing: [], saved: true, source, message: say, say, plan });
  }

  if (req.method === 'POST' && url.pathname === '/api/exam-remove') {
    const body = await readJsonBody(req);
    const progress = loadProgress(studentId);
    progress.exams = (progress.exams || []).filter((e) => e.id !== String(body.id || ''));
    saveProgress(studentId, progress);
    return sendJson(res, 200, { plan: buildPlan(progress) });
  }

  if (req.method === 'GET' && url.pathname === '/api/plan') {
    const plan = buildPlan(loadProgress(studentId));
    return sendJson(res, 200, { ...plan, say: planSummary(plan) });
  }

  if (req.method === 'GET' && url.pathname === '/api/due') {
    // Kept for older pages: today's items from the plan.
    const due = buildPlan(loadProgress(studentId)).today.map((t) => ({ id: t.conceptId, name: t.name }));
    return sendJson(res, 200, { due });
  }

  if (req.method === 'GET' && url.pathname === '/api/rapid-fire') {
    const progress = loadProgress(studentId);
    const ids = rapidFireQueue(progress);
    return sendJson(res, 200, { questions: ids.map((id) => ({ conceptId: id, name: findConcept(id, progress).name })) });
  }

  if (req.method === 'GET' && url.pathname === '/api/dashboard') {
    return sendJson(res, 200, buildDashboard(loadProgress(studentId)));
  }

  return sendJson(res, 404, { error: 'Not found' });
}

function serveStatic(req, res, url) {
  const requested = url.pathname === '/' ? '/index.html' : url.pathname;
  const filePath = path.normalize(path.join(PUBLIC_DIR, requested));
  // Stop path traversal: the resolved file must stay inside public/.
  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    return res.end('Forbidden');
  }
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      return res.end('Not found');
    }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(filePath)] || 'application/octet-stream' });
    res.end(data);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  try {
    if (url.pathname.startsWith('/api/')) {
      await handleApi(req, res, url);
    } else {
      serveStatic(req, res, url);
    }
  } catch (err) {
    console.error(err);
    if (!res.headersSent) sendJson(res, 400, { error: err.message });
  }
});

initStorage().then(() => {
  server.listen(PORT, () => {
    console.log(
      `Study partner on port ${PORT}. Grading: ${API_KEY ? 'Claude' : 'demo'}. Speech: ${SARVAM_KEY ? 'Sarvam' : 'browser'}. Progress: ${store.kind}.`
    );
  });
});
