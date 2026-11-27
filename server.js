// Voice-first study partner: a small Node server with no npm dependencies.
// Runs in demo mode (no key needed) or Claude mode (ANTHROPIC_API_KEY set).

const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 3000;
const PUBLIC_DIR = path.join(__dirname, 'public');
const DATA_DIR = path.join(__dirname, 'data');
const PROGRESS_FILE = process.env.PROGRESS_FILE || path.join(DATA_DIR, 'progress.json');
const API_KEY = (process.env.ANTHROPIC_API_KEY || '').trim();
const MODEL = process.env.CLAUDE_MODEL || 'claude-haiku-5-5';
const RECALL_PASS = 70;
const CHAPTER_SOURCE =
  'NCERT Class 8 Science, Chapter 8: Cell - Structure and Functions (check against your textbook edition)';
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

const chapter = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'class8-science.json'), 'utf8'));

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
};

// ---------- progress storage ----------

function loadProgress() {
  try {
    return JSON.parse(fs.readFileSync(PROGRESS_FILE, 'utf8'));
  } catch (err) {
    return { attempts: [] };
  }
}

function saveProgress(progress) {
  try {
    fs.mkdirSync(path.dirname(PROGRESS_FILE), { recursive: true });
    fs.writeFileSync(PROGRESS_FILE, JSON.stringify(progress, null, 2));
  } catch (err) {
    console.error('Could not save progress:', err.message);
  }
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

function findConcept(conceptId) {
  return chapter.concepts.find((c) => c.id === conceptId);
}

function clampScore(n) {
  return Math.max(0, Math.min(100, Math.round(n)));
}

function daysUntil(isoDate) {
  const ms = new Date(isoDate + 'T00:00:00+05:30') - Date.now();
  return Math.max(0, Math.ceil(ms / 86400000));
}

// ---------- demo grading (no key, deterministic) ----------

function demoGradeExplain(concept, answer) {
  const text = String(answer || '').toLowerCase();
  const { hits, maybe } = fuzzyTerms(text, concept.keyTerms);
  const missing = concept.keyTerms.filter((t) => !text.includes(t.toLowerCase()));
  const trap = concept.misconceptions.find((m) =>
    m.triggers.some((t) => text.includes(t.toLowerCase()))
  );

  let score = (hits.length / concept.keyTerms.length) * 100;
  if (trap) score -= 20;

  return {
    score: clampScore(score),
    gotRight: hits.length
      ? `You named ${hits.slice(0, 3).join(', ')}. Good.`
      : 'You made a start. Keep going.',
    fix: trap
      ? trap.correction
      : missing.length
        ? `Add the idea of ${missing[0]}.`
        : 'Nothing to fix. Well done.',
    followUp: trap ? trap.followUp : concept.followUp,
    didYouMean: maybe,
    source: 'demo',
  };
}

function demoGradeRecall(concept, answer) {
  const text = String(answer || '').toLowerCase();
  const { hits, maybe } = fuzzyTerms(text, concept.keyTerms);
  const missing = concept.keyTerms.filter((t) => !text.includes(t.toLowerCase()));
  const score = clampScore((hits.length / concept.keyTerms.length) * 100);
  return {
    score,
    passed: score >= RECALL_PASS,
    missing,
    hint: score >= RECALL_PASS ? '' : concept.hint,
    didYouMean: maybe,
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

async function claudeGradeExplain(concept, answer, language) {
  const system =
    'You are a patient older sibling tutoring an Indian government school student in Class 8 Science. ' +
    `The student explains in ${language}; exam terms are in English. Grade the MEANING, never the ` +
    'pronunciation or grammar. Never give the answer directly; guide them. Reply ONLY with JSON: ' +
    '{"score":0-100,"gotRight":"one short sentence","fix":"the specific misconception or missing idea, one short sentence",' +
    '"followUp":"one question that targets the misconception, under 20 words"}. Keep every sentence short.';
  const user =
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
  const user =
    `Concept: ${concept.name}\nKey terms: ${concept.keyTerms.join(', ')}\n` +
    `Student said: """${answer}"""`;
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

// ---------- learner memory, review, rapid-fire, did-you-mean ----------

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

// Exact matches count. A word one letter away from a key term is only flagged: the app asks "Did you mean...?"
function fuzzyTerms(text, terms) {
  const lower = text.toLowerCase();
  const words = lower.match(/[a-z]+/g) || [];
  const hits = [];
  const maybe = [];
  for (const term of terms) {
    const t = term.toLowerCase();
    if (lower.includes(t)) {
      hits.push(term);
      continue;
    }
    const termWords = t.split(' ').filter((w) => w.length >= 4);
    const near = words.find((w) => w.length >= 4 && termWords.some((tw) => levenshtein(w, tw) === 1));
    if (near) maybe.push({ term, heard: near });
  }
  return { hits, maybe };
}

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
  const order = [...new Set([...weak, ...due, ...rest])];
  return order.slice(0, 5);
}

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
    'Extract exam details from a student\'s spoken description. Reply ONLY with JSON: ' +
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

// ---------- dashboard ----------

function average(list) {
  return list.length ? list.reduce((s, n) => s + Number(n || 0), 0) / list.length : 0;
}

function buildDashboard(progress) {
  const attempts = progress.attempts;
  const exam = progress.exam || {};
  const explains = attempts.filter((a) => a.type === 'explain');
  const recalls = attempts.filter((a) => a.type === 'recall');
  const practised = new Set(explains.map((a) => a.conceptId));
  const total = chapter.concepts.length;

  const bestByConcept = {};
  for (const a of explains) {
    bestByConcept[a.conceptId] = Math.max(bestByConcept[a.conceptId] || 0, a.score);
  }
  const mastery = Math.round(average(Object.values(bestByConcept)));
  const retention = recalls.length
    ? Math.round((recalls.filter((a) => a.passed).length / recalls.length) * 100)
    : 0;

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
    todayPlan: chapter.concepts
      .filter((c) => !practised.has(c.id))
      .map((c) => `Explain: ${c.name}`)
      .concat(chapter.concepts.filter((c) => (bestByConcept[c.id] || 0) < RECALL_PASS).map((c) => `Recall: ${c.name}`))
      .slice(0, 5),
    due: dueConcepts(progress).length,
    history: dailyHistory(explains),
    mode: API_KEY ? 'claude' : 'demo',
  };
}

// ---------- routes ----------

async function handleApi(req, res, url) {
  if (req.method === 'GET' && url.pathname === '/api/status') {
    return sendJson(res, 200, { mode: API_KEY ? 'claude' : 'demo', model: API_KEY ? MODEL : null });
  }

  if (req.method === 'GET' && url.pathname === '/api/chapter') {
    return sendJson(res, 200, {
      title: chapter.title,
      examDate: chapter.examDate,
      concepts: chapter.concepts.map((c) => ({ id: c.id, name: c.name, definition: c.definition })),
    });
  }

  if (req.method === 'POST' && url.pathname === '/api/explain') {
    const body = await readJsonBody(req);
    const concept = findConcept(body.conceptId);
    if (!concept) return sendJson(res, 404, { error: 'Unknown concept' });
    const answer = String(body.answer || '').slice(0, 2000);
    if (!answer.trim()) return sendJson(res, 400, { error: 'Empty answer' });

    const language = String(body.language || 'Hindi');
    let result;
    if (API_KEY) {
      try {
        result = await claudeGradeExplain(concept, answer, language);
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
    const lower = answer.toLowerCase();
    const termsHit = concept.keyTerms.filter((t) => lower.includes(t.toLowerCase()));
    const progress = loadProgress();
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
      termsHit,
    });
    updateMemory(progress, concept.id, result.score);
    result.languageMode = languageMode(progress, concept.id);
    saveProgress(progress);
    return sendJson(res, 200, result);
  }

  if (req.method === 'POST' && url.pathname === '/api/recall') {
    const body = await readJsonBody(req);
    const concept = findConcept(body.conceptId);
    if (!concept) return sendJson(res, 404, { error: 'Unknown concept' });
    const answer = String(body.answer || '').slice(0, 2000);
    if (!answer.trim()) return sendJson(res, 400, { error: 'Empty answer' });

    const language = String(body.language || 'Hindi');
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

    const progress = loadProgress();
    progress.attempts.push({ type: 'recall', conceptId: concept.id, score: result.score, passed: result.passed, at: Date.now() });
    updateMemory(progress, concept.id, result.score);
    saveProgress(progress);
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

    const progress = loadProgress();
    progress.exam = { ...parsed, setAt: Date.now() };
    saveProgress(progress);
    return sendJson(res, 200, {
      parsed,
      missing: [],
      saved: true,
      source,
      message: `Saved. ${daysUntil(parsed.examDate)} days to go.`,
    });
  }

  if (req.method === 'GET' && url.pathname === '/api/due') {
    const due = dueConcepts(loadProgress()).map((c) => ({ id: c.id, name: c.name }));
    return sendJson(res, 200, { due });
  }

  if (req.method === 'GET' && url.pathname === '/api/rapid-fire') {
    const ids = rapidFireQueue(loadProgress());
    return sendJson(res, 200, { questions: ids.map((id) => ({ conceptId: id, name: findConcept(id).name })) });
  }

  if (req.method === 'GET' && url.pathname === '/api/dashboard') {
    return sendJson(res, 200, buildDashboard(loadProgress()));
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
  console.log(`Study partner running on port ${PORT} in ${API_KEY ? 'Claude' : 'demo'} mode`);
});
