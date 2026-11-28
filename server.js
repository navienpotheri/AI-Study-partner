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
const DEMO_SIGNIN = /^(1|true)$/i.test(process.env.DEMO_SIGNIN || '');
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

function loadAll() {
  const all = readOptionalJson(PROGRESS_FILE, { students: {} });
  all.students = all.students || {};
  return all;
}

function loadProgress(studentId) {
  return loadAll().students[studentId] || { attempts: [] };
}

function saveProgress(studentId, progress) {
  try {
    const all = loadAll();
    all.students[studentId] = progress;
    fs.mkdirSync(path.dirname(PROGRESS_FILE), { recursive: true });
    fs.writeFileSync(PROGRESS_FILE, JSON.stringify(all, null, 2));
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

function findConcept(conceptId) {
  return chapter.concepts.find((c) => c.id === conceptId);
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

async function claudeJson(system, user) {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 400,
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
    '{"class":number|null,"subject":string|null,"chapters":[from,to]|null,"examDate":"YYYY-MM-DD"|null,"preparedPct":number|null}. ' +
    'Use null for anything not stated. Do not guess.';
  return claudeJson(system, text);
}

function examQuestions(parsed) {
  const questions = [];
  if (!parsed.class) questions.push('Which class is it?');
  if (!parsed.subject) questions.push('Which subject?');
  if (!parsed.chapters) questions.push('Which chapters does the exam cover?');
  if (!parsed.examDate) questions.push('When is the exam?');
  if (parsed.preparedPct == null) questions.push('About how much have you prepared, in percent?');
  return questions;
}

// ---------- learner memory, review, rapid-fire, adaptive language ----------

// Spaced review: a correct answer doubles the wait, a hesitant one keeps it, a failure resets it to one day.
function updateMemory(progress, conceptId, score) {
  progress.memory = progress.memory || {};
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

function dueConcepts(progress) {
  const memory = progress.memory || {};
  const now = Date.now();
  return chapter.concepts.filter((c) => !memory[c.id] || memory[c.id].nextReview <= now);
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
  const weak = chapter.concepts.filter((c) => memory[c.id] && memory[c.id].lastResult !== 'correct').map((c) => c.id);
  const due = dueConcepts(progress).map((c) => c.id);
  const rest = chapter.concepts.map((c) => c.id).sort(() => Math.random() - 0.5);
  return [...new Set([...weak, ...due, ...rest])].slice(0, 5);
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
  const exam = progress.exam || {};
  const explains = attempts.filter((a) => a.type === 'explain');
  const recalls = attempts.filter((a) => a.type === 'recall');
  const englishPractice = attempts.filter((a) => a.type === 'english');
  const practised = new Set(explains.map((a) => a.conceptId));
  const total = chapter.concepts.length;

  const bestByConcept = {};
  for (const a of explains) {
    bestByConcept[a.conceptId] = Math.max(bestByConcept[a.conceptId] || 0, a.score);
  }
  const mastery = Math.round(average(Object.values(bestByConcept)));
  const retention = recalls.length ? Math.round((recalls.filter((a) => a.passed).length / recalls.length) * 100) : 0;

  // Readiness: unpractised concepts count as zero, as in the brief.
  const readiness = Math.round(chapter.concepts.reduce((s, c) => s + (bestByConcept[c.id] || 0), 0) / total);
  // The range narrows as more explanations are graded (about 1/sqrt(n), kept between 5 and 30 points).
  const spread = Math.max(5, Math.min(30, Math.round(40 / Math.sqrt(explains.length + 1))));

  const examDate = exam.examDate || chapter.examDate;
  const daysLeft = daysUntil(examDate);
  const weekAgo = Date.now() - 7 * 86400000;
  const practisedThisWeek = new Set(explains.filter((a) => a.at >= weekAgo).map((a) => a.conceptId)).size;

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

  const memory = progress.memory || {};
  const due = dueConcepts(progress);
  const todayPlan = chapter.concepts
    .filter((c) => !practised.has(c.id))
    .map((c) => `Explain: ${c.name}`)
    .concat(due.filter((c) => practised.has(c.id)).map((c) => `Review: ${c.name}`))
    .slice(0, 5);

  return {
    chapter: chapter.title,
    exam: { class: exam.class || 8, subject: exam.subject || 'Science', preparedPct: exam.preparedPct ?? null },
    examDate,
    daysLeft,
    coverage: {
      practised: practised.size,
      total,
      pct: Math.round((practised.size / total) * 100),
      chaptersLeft: practised.size === total ? 0 : 1,
    },
    mastery,
    retention,
    fluency,
    englishReadiness,
    englishPractice: englishPractice.length,
    termsLearned,
    pace: {
      needPerDay: Math.round(((total - practised.size) / Math.max(1, daysLeft)) * 10) / 10,
      actualPerDay: Math.round((practisedThisWeek / 7) * 10) / 10,
    },
    readiness: {
      score: readiness,
      low: Math.max(0, readiness - spread),
      high: Math.min(100, readiness + spread),
      label: 'Estimate, not a guarantee.',
    },
    due: due.length,
    history: dailyHistory(explains),
    todayPlan,
    lastLanguage: progress.lastLanguage || null,
    memoryCount: Object.keys(memory).length,
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
      examSet: Boolean(progress.exam),
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
    return sendJson(res, 200, {
      title: chapter.title,
      examDate: chapter.examDate,
      concepts: chapter.concepts.map((c) => ({ id: c.id, name: c.name, definition: c.definition })),
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
    const concept = findConcept(body.conceptId);
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
    result.citation = { concept: concept.name, source: CHAPTER_SOURCE };

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
    const concept = findConcept(url.searchParams.get('conceptId'));
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
    const concept = findConcept(body.conceptId);
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
    const concept = findConcept(body.conceptId);
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
    const supported = parsed.class === 8 && /science/i.test(parsed.subject || '');
    if (missing.length) {
      return sendJson(res, 200, { parsed, missing, saved: false, source, message: 'A few details are missing.' });
    }
    if (!supported) {
      return sendJson(res, 200, {
        parsed,
        missing: [],
        saved: false,
        source,
        message: 'This demo has Class 8 Science (Cell) only. Other subjects are next.',
      });
    }

    const progress = loadProgress(studentId);
    progress.exam = { ...parsed, setAt: Date.now() };
    saveProgress(studentId, progress);
    return sendJson(res, 200, {
      parsed,
      missing: [],
      saved: true,
      source,
      message: `Saved. ${daysUntil(parsed.examDate)} days to go.`,
    });
  }

  if (req.method === 'GET' && url.pathname === '/api/due') {
    const due = dueConcepts(loadProgress(studentId)).map((c) => ({ id: c.id, name: c.name }));
    return sendJson(res, 200, { due });
  }

  if (req.method === 'GET' && url.pathname === '/api/rapid-fire') {
    const ids = rapidFireQueue(loadProgress(studentId));
    return sendJson(res, 200, { questions: ids.map((id) => ({ conceptId: id, name: findConcept(id).name })) });
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

server.listen(PORT, () => {
  console.log(`Study partner on port ${PORT}. Grading: ${API_KEY ? 'Claude' : 'demo'}. Speech: ${SARVAM_KEY ? 'Sarvam' : 'browser'}.`);
});
