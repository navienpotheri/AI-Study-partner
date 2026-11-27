// Study Partner front end. Plain JavaScript, no build step.
// Voice uses the browser's speech APIs where available; typing is always available.

const LANG_CODES = {
  Hindi: 'hi-IN',
  Tamil: 'ta-IN',
  Telugu: 'te-IN',
  Kannada: 'kn-IN',
  Malayalam: 'ml-IN',
};
const CONFIDENCE_FLOOR = 0.5;   // below this, do not grade; ask the student to repeat
const MAX_VOICE_FAILURES = 2;   // after this many, nudge toward typing

const state = {
  language: 'Hindi',
  stt: 'browser',
  concepts: [],
  explain: { conceptId: null, failures: 0 },
  recall: { conceptId: null, failures: 0 },
  setup: { conceptId: null, failures: 0 },
  rapid: { conceptId: null, failures: 0, queue: [], index: 0, scores: [] },
};

const $ = (id) => document.getElementById(id);

// Each browser gets its own student id, so progress and the dashboard follow that student across sessions.
const STUDENT_ID = (() => {
  try {
    let id = localStorage.getItem('studyPartnerId');
    if (!id || !/^[A-Za-z0-9-]{8,64}$/.test(id)) {
      id = (crypto.randomUUID ? crypto.randomUUID() : `s-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`);
      localStorage.setItem('studyPartnerId', id);
    }
    return id;
  } catch (err) {
    return 'guest-local';
  }
})();

const nativeFetch = window.fetch.bind(window);
window.fetch = (input, opts = {}) => {
  const url = typeof input === 'string' ? input : input.url;
  if (url.startsWith('/api/')) {
    const session = localStorage.getItem('studyPartnerSession');
    const headers = { ...(opts.headers || {}), 'x-student-id': STUDENT_ID };
    if (session) headers['x-session'] = session;
    opts = { ...opts, headers };
  }
  return nativeFetch(input, opts);
};

// ---------- screens ----------

function show(screen) {
  if (screen === 'continue') return continueStudy();
  document.querySelectorAll('.tabbar button').forEach((b) => b.classList.toggle('active', b.dataset.go === screen));
  document.body.classList.toggle('no-tabs', screen === 'signin');
  document.body.classList.toggle('fullscreen', screen === 'explain');
  if (screen === 'home') renderHome();
  document.querySelectorAll('.screen').forEach((s) => s.classList.toggle('active', s.id === `screen-${screen}`));
  if (screen === 'dashboard') loadDashboard();
  window.scrollTo(0, 0);
}

document.addEventListener('click', (event) => {
  const target = event.target.closest('[data-go]');
  if (target && !target.disabled) show(target.dataset.go);
});

// ---------- speech ----------

const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;

function speak(text) {
  if (!('speechSynthesis' in window) || !text) return;
  const utterance = new SpeechSynthesisUtterance(text);
  utterance.lang = LANG_CODES[state.language] || 'en-IN';
  utterance.rate = 0.95;
  window.speechSynthesis.cancel();
  window.speechSynthesis.speak(utterance);
}

// Push-to-talk: the mic listens only while the button is held.
function attachPushToTalk(prefix) {
  if (state.stt === 'sarvam' && window.MediaRecorder && navigator.mediaDevices) {
    return attachSarvamPushToTalk(prefix);
  }
  const mic = $(`${prefix}-mic`);
  if (!Recognition) {
    mic.disabled = true;
    mic.title = 'Voice is not supported in this browser. Type instead.';
    $(`${prefix}-status`).textContent = 'Voice is not supported here. Please type your answer.';
    return;
  }

  const recognizer = new Recognition();
  recognizer.lang = LANG_CODES[state.language] || 'en-IN';
  recognizer.interimResults = false;
  recognizer.continuous = false;
  recognizer.maxAlternatives = 1;

  let heard = null;
  recognizer.onresult = (event) => {
    const best = event.results[0][0];
    heard = { text: best.transcript, confidence: typeof best.confidence === 'number' ? best.confidence : 1 };
  };
  recognizer.onerror = () => { heard = null; };
  recognizer.onend = () => {
    mic.classList.remove('listening');
    mic.classList.remove('busy');
    handleHeard(prefix, heard);
    heard = null;
  };

  const start = (event) => {
    event.preventDefault();
    heard = null;
    recognizer.lang = LANG_CODES[state.language] || 'en-IN';
    mic.classList.add('listening');
    $(`${prefix}-status`).textContent = 'Listening… let go when you finish.';
    try { recognizer.start(); } catch (err) { /* already started */ }
  };
  const stop = () => {
    if (!mic.classList.contains('listening')) return;
    $(`${prefix}-status`).textContent = 'Processing…';
    mic.classList.add('busy');
    try { recognizer.stop(); } catch (err) { /* ignore */ }
  };

  mic.addEventListener('pointerdown', start);
  mic.addEventListener('pointerup', stop);
  mic.addEventListener('pointerleave', stop);
}

// Low confidence means we do not grade. We show what was heard and ask again.
function handleHeard(prefix, heard) {
  const status = $(`${prefix}-status`);
  const heardLine = $(`${prefix}-heard`);
  const mode = state[prefix];

  if (!heard || !heard.text.trim() || heard.confidence < CONFIDENCE_FLOOR) {
    mode.failures += 1;
    status.textContent = "I didn't catch that, please say it again.";
    heardLine.textContent = heard && heard.text ? `I heard: "${heard.text}"` : '';
    speak("I didn't catch that, please say it again.");
    if (mode.failures >= MAX_VOICE_FAILURES) {
      status.textContent = 'Having trouble? Type your answer below.';
      $(`${prefix}-text`).focus();
    }
    return;
  }

  mode.failures = 0;
  heardLine.textContent = `You said: "${heard.text}"`;
  status.textContent = '';
  submitAnswer(prefix, heard.text);
}

// ---------- chapter and chips ----------

async function loadChapter() {
  const res = await fetch('/api/chapter');
  const chapter = await res.json();
  state.concepts = chapter.concepts;
  $('chapter-title').textContent = chapter.title;
  renderChips('explain');
  renderChips('recall');
}

function renderChips(prefix) {
  const wrap = $(`${prefix === 'explain' ? 'explain' : 'recall'}-chips`);
  wrap.innerHTML = '';
  state.concepts.forEach((concept, index) => {
    const button = document.createElement('button');
    button.textContent = concept.name;
    button.addEventListener('click', () => selectConcept(prefix, concept.id));
    wrap.appendChild(button);
    if (index === 0 && !state[prefix].conceptId) selectConcept(prefix, concept.id);
  });
}

function selectConcept(prefix, conceptId) {
  state[prefix].conceptId = conceptId;
  state[prefix].failures = 0;
  state[prefix].promptedAt = Date.now();
  document.querySelectorAll(`#${prefix}-chips button`).forEach((b) => {
    b.classList.toggle('selected', b.textContent === state.concepts.find((c) => c.id === conceptId).name);
  });
  $(`${prefix}-result`).hidden = true;
  $(`${prefix}-status`).textContent = '';
  $(`${prefix}-heard`).textContent = '';
  if (prefix === 'explain') {
    $('explain-prompt').textContent = `Explain "${conceptName(conceptId)}" in your own words.`;
    $('hero-name').textContent = conceptName(conceptId);
  } else {
    $('recall-prompt').textContent = `Say the definition of "${conceptName(conceptId)}" from memory.`;
  }
}

function conceptName(conceptId) {
  const concept = state.concepts.find((c) => c.id === conceptId);
  return concept ? concept.name : '';
}

// ---------- submitting answers ----------

async function submitAnswer(prefix, text) {
  if (prefix === 'setup') return submitSetup(text);
  if (prefix === 'rapid') return submitRapid(text);
  const conceptId = state[prefix].conceptId;
  const endpoint = prefix === 'explain' ? '/api/explain' : '/api/recall';
  const status = $(`${prefix}-status`);
  status.textContent = 'Thinking…';
  try {
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        conceptId,
        answer: text,
        language: state.language,
        meta: prefix === 'explain' ? speechMeta(text, state[prefix].promptedAt) : undefined,
      }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Request failed');
    status.textContent = '';
    if (prefix === 'explain') renderExplain(data);
    else renderRecall(data);
  } catch (err) {
    status.textContent = `Something went wrong: ${err.message}`;
  }
}

function renderExplain(result) {
  const box = $('explain-result');
  box.hidden = false;
  box.innerHTML = `
    <div class="score">${result.score}/100</div>
    <p class="good">${escapeHtml(result.gotRight)}</p>
    <p class="fix">${escapeHtml(result.fix)}</p>
    <p><strong>${escapeHtml(result.followUp)}</strong></p>
    ${result.citation ? `<p class="note">Based on: ${escapeHtml(result.citation.concept)}, ${escapeHtml(result.citation.source)}</p>` : ''}
    ${didYouMeanHtml(result)}
    ${result.languageMode ? `<p class="note">Next answer, speak in: ${languageLabel(result.languageMode)}</p>` : ''}
    <p class="note">${result.source === 'claude' ? 'Graded by Claude.' : 'Demo mode: graded by keywords, no AI key set.'}</p>`;
  box.insertAdjacentHTML('beforeend', englishBoxHtml());
  speak(`${result.gotRight} ${result.fix} ${result.followUp}`);
}

function renderRecall(result) {
  const box = $('recall-result');
  box.hidden = false;
  const missing = result.missing && result.missing.length
    ? `<p class="fix">Missing: ${escapeHtml(result.missing.join(', '))}</p>`
    : '';
  const hint = result.passed
    ? '<p class="good">Well recalled. Keep it fresh.</p>'
    : `<p class="fix">Hint: ${escapeHtml(result.hint || '')}</p>`;
  box.innerHTML = `
    <div class="score">${result.score}/100</div>
    ${missing}${hint}${didYouMeanHtml(result)}
    <p class="note">${result.source === 'claude' ? 'Graded by Claude.' : 'Demo mode: graded by keywords, no AI key set.'}</p>`;
  speak(result.passed ? 'Well recalled.' : `Hint. ${result.hint || ''}`);
}

function escapeHtml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// Typed answers go through the same path as spoken ones.
$('explain-form').addEventListener('submit', (event) => {
  event.preventDefault();
  const text = $('explain-text').value.trim();
  if (!text) return;
  $('explain-text').value = '';
  submitAnswer('explain', text);
});
$('recall-form').addEventListener('submit', (event) => {
  event.preventDefault();
  const text = $('recall-text').value.trim();
  if (!text) return;
  $('recall-text').value = '';
  submitAnswer('recall', text);
});

// ---------- dashboard ----------

async function loadDashboard() {
  const res = await fetch('/api/dashboard');
  const d = await res.json();
  renderExtra(d);
  $('d-days').textContent = d.daysLeft;
  $('d-due').textContent = d.due;
  $('d-coverage').textContent = `${d.coverage.practised}/${d.coverage.total}`;
  $('d-mastery').textContent = `${d.mastery}%`;
  $('d-retention').textContent = `${d.retention}%`;
  $('d-readiness').textContent = `${d.readiness.score}`;
  $('d-range').textContent = `Likely between ${d.readiness.low} and ${d.readiness.high}. ${d.readiness.label}`;
  const plan = $('d-plan');
  plan.innerHTML = '';
  (d.todayPlan.length ? d.todayPlan : ['All caught up. Try a recall check.']).forEach((item) => {
    const li = document.createElement('li');
    li.textContent = item;
    plan.appendChild(li);
  });
}

// ---------- speech timing and fluency ----------

const FILLER_WORDS = ['um', 'uh', 'umm', 'hmm', 'ah', 'like', 'matlab', 'toh', 'arre'];

// Timing and word counts for fluency and English readiness. Measured on the transcript, not the audio.
function speechMeta(text, promptedAt) {
  const words = String(text).toLowerCase().split(/\s+/).filter(Boolean);
  const fillers = words.filter((w) => FILLER_WORDS.includes(w.replace(/[^a-z]/g, ''))).length;
  const english = words.filter((w) => /^[a-z']+$/.test(w)).length;
  return {
    responseMs: promptedAt ? Date.now() - promptedAt : 0,
    fillers,
    englishShare: words.length ? english / words.length : 0,
  };
}

// ---------- exam setup ----------

function insertExamScreen() {
  document.querySelector('main').insertAdjacentHTML('beforeend', `
    <section id="screen-setup" class="screen">
      <button class="back" data-go="home">&larr; Back</button>
      <h2>Set up my exam</h2>
      <label class="field">
        <span>Your home language (chosen once)</span>
        <select id="language">
          <option>Hindi</option>
          <option>Tamil</option>
          <option>Telugu</option>
          <option>Kannada</option>
          <option>Malayalam</option>
        </select>
      </label>
      <h3>Set up my exam</h3>
      <p class="prompt">Tell me about your exam, in your own words. For example: "I have a quarterly science exam on 12 December, we use this textbook, chapters 3 to 7, and I have prepared about 40 percent."</p>
      <button id="setup-mic" class="mic" aria-label="Hold to speak">&#127897;</button>
      <p class="status" id="setup-status"></p>
      <p class="heard" id="setup-heard"></p>
      <form id="setup-form" class="textform">
        <input id="setup-text" type="text" placeholder="Or type here" autocomplete="off">
        <button type="submit">Save</button>
      </form>
      <div id="setup-result" class="result" hidden></div>
    </section>`);
  document.getElementById('setup-form').addEventListener('submit', (event) => {
    event.preventDefault();
    const input = document.getElementById('setup-text');
    const text = input.value.trim();
    if (!text) return;
    input.value = '';
    submitSetup(text);
  });
  document.querySelector('main').insertAdjacentHTML('beforeend', `
    <section id="screen-rapid" class="screen">
      <button class="back" data-go="home">&larr; Back</button>
      <h2>Rapid-fire test</h2>
      <p class="muted">One question at a time. Weak and due concepts come first.</p>
      <button id="rapid-start" class="big">Start</button>
      <p class="muted" id="rapid-progress"></p>
      <p class="prompt" id="rapid-prompt"></p>
      <button id="rapid-mic" class="mic" aria-label="Hold to speak">&#127897;</button>
      <p class="status" id="rapid-status"></p>
      <p class="heard" id="rapid-heard"></p>
      <form id="rapid-form" class="textform">
        <input id="rapid-text" type="text" placeholder="Or type here" autocomplete="off">
        <button type="submit">Check</button>
      </form>
      <div id="rapid-result" class="result" hidden></div>
    </section>`);
  document.getElementById('rapid-start').addEventListener('click', startRapid);
  document.getElementById('rapid-form').addEventListener('submit', (event) => {
    event.preventDefault();
    const input = document.getElementById('rapid-text');
    const text = input.value.trim();
    if (!text) return;
    input.value = '';
    submitRapid(text);
  });
  attachPushToTalk('setup');
  attachPushToTalk('rapid');
}

async function submitSetup(text) {
  const status = $('setup-status');
  const box = $('setup-result');
  status.textContent = 'Reading your exam…';
  try {
    const res = await fetch('/api/exam-setup', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text, language: state.language }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Request failed');
    status.textContent = '';
    box.hidden = false;
    if (data.missing.length) {
      box.innerHTML = `<p class="fix">${escapeHtml(data.message)}</p>
        <ul>${data.missing.map((q) => `<li>${escapeHtml(q)}</li>`).join('')}</ul>
        <p class="note">Say or type the full description again, with the missing details.</p>`;
      speak(data.missing[0]);
    } else {
      box.innerHTML = `<p class="good">${escapeHtml(data.message)}</p>
        ${data.saved ? '<button data-go="dashboard">See my plan</button>' : ''}
        <p class="note">${data.source === 'claude' ? 'Read by Claude.' : 'Read in demo mode (pattern matching).'}</p>`;
      speak(data.message);
    }
  } catch (err) {
    status.textContent = `Something went wrong: ${err.message}`;
  }
}

function renderExtra(d) {
  let card = document.getElementById('extra-card');
  if (!card) {
    card = document.createElement('div');
    card.id = 'extra-card';
    card.className = 'card';
    document.getElementById('screen-dashboard').appendChild(card);
  }
  const show = (value, suffix = '') => (value === null || value === undefined ? 'not measured yet' : `${value}${suffix}`);
  card.innerHTML = `
    <h3>Plan details</h3>
    <ul>
      <li>Syllabus covered: ${d.coverage.pct}% (${d.coverage.practised} of ${d.coverage.total} concepts). Chapters left: ${d.coverage.chaptersLeft}.</li>
      <li>Pace needed: ${d.pace.needPerDay} concepts a day. Your pace this week: ${d.pace.actualPerDay} a day.</li>
      <li>Fluency (estimate): ${show(d.fluency, '/100')}</li>
      <li>English readiness: ${show(d.englishReadiness, '% of words in English')}</li>
      <li>English terms used so far: ${d.termsLearned}</li>
      <li>Due for review today: ${d.due} concept${d.due === 1 ? '' : 's'}.</li>
      <li>${sparklineSvg(d.history)}</li>
      <li>Last 14 days: ${d.history.length ? d.history.map((h) => `${h.day.slice(5)} ${h.answers} answer${h.answers === 1 ? '' : 's'}, avg ${h.avgScore}`).join(' · ') : 'no answers yet'}</li>
      <li>${escapeHtml(d.exam.subject)}, Class ${d.exam.class}, ${d.daysLeft} days left${d.exam.preparedPct !== null ? `. You said you are ${d.exam.preparedPct}% prepared.` : '.'}</li>
    </ul>`;
}

// ---------- Email sign-in: type email and name, tap the link we send ----------

async function setupAuth() {
  $('signin-form').addEventListener('submit', requestSignIn);
  $('guest-btn').addEventListener('click', () => {
    localStorage.setItem('studyPartnerGuest', '1');
    show('home');
  });

  // The student may have arrived from the confirmation link.
  const token = new URLSearchParams(location.search).get('verify');
  if (token) {
    try {
      const res = await nativeFetch('/api/auth/verify', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-student-id': STUDENT_ID },
        body: JSON.stringify({ token }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      localStorage.setItem('studyPartnerSession', data.token);
    } catch (err) {
      $('signin-note').textContent = err.message;
    }
    history.replaceState(null, '', '/');
  }

  const me = await (await fetch('/api/me')).json().catch(() => ({}));
  if (me.signedIn) {
    $('auth').innerHTML = `<p>Signed in as <strong>${escapeHtml(me.name)}</strong></p><button id="signout" class="link">Sign out</button>`;
    $('signout').addEventListener('click', signOut);
    show('home');
    return;
  }
  $('auth').innerHTML = '<p class="muted">Guest: your progress is kept on this browser.</p><button id="signin-go" class="link">Sign in with email</button>';
  $('signin-go').addEventListener('click', () => show('signin'));
  show(localStorage.getItem('studyPartnerGuest') ? 'home' : 'signin');
}

async function requestSignIn(event) {
  event.preventDefault();
  const note = $('signin-note');
  note.textContent = 'Sending…';
  try {
    const res = await nativeFetch('/api/auth/request', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-student-id': STUDENT_ID },
      body: JSON.stringify({ email: $('signin-email').value, name: $('signin-name').value }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Could not send the link');
    note.textContent = data.emailReady
      ? 'Check your inbox. Tap the link within 15 minutes.'
      : 'Email is not set up on this server. The link was printed in the server log.';
  } catch (err) {
    note.textContent = err.message;
  }
}

async function signOut() {
  const token = localStorage.getItem('studyPartnerSession');
  localStorage.removeItem('studyPartnerSession');
  await nativeFetch('/api/auth/logout', { method: 'POST', headers: { 'x-session': token || '' } }).catch(() => {});
  location.reload();
}

// ---------- home: at-a-glance strip and the Continue card ----------

async function renderHome() {
  try {
    const [d, due] = await Promise.all([
      fetch('/api/dashboard').then((r) => r.json()),
      fetch('/api/due').then((r) => r.json()),
    ]);
    const next = due.due[0] || state.concepts[0];
    $('hero-name').textContent = next ? next.name : 'Start with any concept';
  } catch (err) {
    $('hero-name').textContent = 'Start studying';
  }
}

// ---------- continue, rapid-fire, did-you-mean ----------

async function continueStudy() {
  const res = await fetch('/api/due');
  const data = await res.json();
  const next = data.due[0] || state.concepts[0];
  if (next) selectConcept('explain', next.id);
  show('explain');
}

function didYouMeanHtml(result) {
  if (!result.didYouMean || !result.didYouMean.length) return '';
  return result.didYouMean
    .map((m) => `<p class="fix">Did you mean "${escapeHtml(m.term)}"? I heard "${escapeHtml(m.heard)}".</p>`)
    .join('');
}

function languageLabel(mode) {
  const labels = {
    home: `${state.language}`,
    mixed: `${state.language} with English exam terms`,
    english: 'English, with exam terms',
  };
  return labels[mode] || state.language;
}

async function startRapid() {
  const res = await fetch('/api/rapid-fire');
  const data = await res.json();
  Object.assign(state.rapid, { queue: data.questions, index: 0, scores: [], failures: 0 });
  $('rapid-start').hidden = true;
  askRapid();
}

function askRapid() {
  const r = state.rapid;
  $('rapid-result').hidden = true;
  $('rapid-status').textContent = '';
  $('rapid-heard').textContent = '';
  if (r.index >= r.queue.length) return rapidSummary();
  const q = r.queue[r.index];
  $('rapid-progress').textContent = `Question ${r.index + 1} of ${r.queue.length}`;
  $('rapid-prompt').textContent = `Say the definition of "${q.name}" from memory.`;
  speak(`Question ${r.index + 1}. Say the definition of ${q.name}.`);
}

async function submitRapid(text) {
  const r = state.rapid;
  const q = r.queue[r.index];
  if (!q) return;
  const status = $('rapid-status');
  status.textContent = 'Checking…';
  try {
    const res = await fetch('/api/recall', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ conceptId: q.conceptId, answer: text, language: state.language }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Request failed');
    status.textContent = '';
    r.scores.push({ name: q.name, score: data.score, passed: data.passed });
    const box = $('rapid-result');
    box.hidden = false;
    box.innerHTML = `
      <div class="score">${data.score}/100</div>
      <p class="${data.passed ? 'good' : 'fix'}">${data.passed ? 'Good, that is right.' : escapeHtml(`Almost. ${data.hint || ''}`)}</p>
      ${didYouMeanHtml(data)}
      <button id="rapid-next">Next</button>`;
    speak(data.passed ? 'Good, that is right.' : `Almost. ${data.hint || ''}`);
    document.getElementById('rapid-next').addEventListener('click', () => {
      r.index += 1;
      askRapid();
    });
  } catch (err) {
    status.textContent = `Something went wrong: ${err.message}`;
  }
}

function rapidSummary() {
  const r = state.rapid;
  const avg = r.scores.length ? Math.round(r.scores.reduce((s, x) => s + x.score, 0) / r.scores.length) : 0;
  const review = r.scores.filter((x) => !x.passed).map((x) => x.name);
  $('rapid-prompt').textContent = '';
  $('rapid-progress').textContent = 'Test complete.';
  $('rapid-start').hidden = false;
  const box = $('rapid-result');
  box.hidden = false;
  box.innerHTML = `
    <div class="score">${avg}/100</div>
    <p>${review.length ? `Review: ${escapeHtml(review.join(', '))}.` : 'Nothing to review. Well done.'}</p>
    <p class="note">Scores are kept, and review times adjust to how you did.</p>`;
  speak(review.length ? `Review ${review.join(', ')}.` : 'Nothing to review. Well done.');
}

// ---------- Sarvam recording (used when the server has a Sarvam key) ----------

function attachSarvamPushToTalk(prefix) {
  const mic = $(`${prefix}-mic`);
  let recorder = null;
  let chunks = [];

  const start = async (event) => {
    event.preventDefault();
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      chunks = [];
      recorder = new MediaRecorder(stream);
      recorder.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
      recorder.onstop = () => {
        stream.getTracks().forEach((t) => t.stop());
        transcribe(prefix, new Blob(chunks, { type: recorder.mimeType || 'audio/webm' }));
      };
      recorder.start();
      mic.classList.add('listening');
      $(`${prefix}-status`).textContent = 'Listening… let go when you finish.';
    } catch (err) {
      $(`${prefix}-status`).textContent = 'The microphone is blocked. Please type your answer.';
    }
  };
  const stop = () => {
    if (!recorder || recorder.state !== 'recording') return;
    mic.classList.remove('listening');
    mic.classList.add('busy');
    $(`${prefix}-status`).textContent = 'Processing…';
    recorder.stop();
  };

  mic.addEventListener('pointerdown', start);
  mic.addEventListener('pointerup', stop);
  mic.addEventListener('pointerleave', stop);
}

async function transcribe(prefix, blob) {
  const mic = $(`${prefix}-mic`);
  const status = $(`${prefix}-status`);
  try {
    const res = await fetch(`/api/transcribe?lang=${encodeURIComponent(state.language)}`, {
      method: 'POST',
      headers: { 'content-type': blob.type || 'audio/webm' },
      body: blob,
    });
    const data = await res.json();
    mic.classList.remove('busy');
    if (!res.ok) throw new Error(data.error || 'Speech failed');
    handleHeard(prefix, { text: data.transcript, confidence: data.probability ?? 1 });
  } catch (err) {
    mic.classList.remove('busy');
    status.textContent = err.message;
  }
}

// ---------- English practice: one sentence in English after each explanation ----------

function englishBoxHtml() {
  return `
    <div class="english-box">
      <p class="note">Now say the same idea in one English sentence. Use the exam words.</p>
      <form id="english-form" class="textform">
        <input id="english-text" type="text" placeholder="One English sentence" autocomplete="off">
        <button type="submit">Check</button>
      </form>
      <div id="english-result"></div>
    </div>`;
}

document.addEventListener('submit', async (event) => {
  if (event.target.id !== 'english-form') return;
  event.preventDefault();
  const input = $('english-text');
  const sentence = input.value.trim();
  if (!sentence) return;
  input.value = '';
  const out = $('english-result');
  out.innerHTML = '<p class="status">Checking…</p>';
  try {
    const res = await fetch('/api/english', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ conceptId: state.explain.conceptId, sentence }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Request failed');
    out.innerHTML = `<p class="good">${escapeHtml(data.gotRight)}</p><p class="fix">${escapeHtml(data.fix)}</p>`;
    speak(`${data.gotRight} ${data.fix}`);
  } catch (err) {
    out.innerHTML = `<p class="fix">Something went wrong: ${escapeHtml(err.message)}</p>`;
  }
});

// ---------- dashboard chart: small, phone-width, one line for the last 14 days ----------

function sparklineSvg(history) {
  if (!history || !history.length) {
    return '<span class="muted">Answer a few questions to see your chart.</span>';
  }
  const width = 300;
  const height = 80;
  const step = history.length > 1 ? width / (history.length - 1) : 0;
  const points = history.map((h, i) => {
    const x = history.length > 1 ? i * step : width / 2;
    const y = height - 10 - (h.avgScore / 100) * (height - 20);
    return { x: x.toFixed(1), y: y.toFixed(1), label: `${h.day}: ${h.avgScore}` };
  });
  const line = points.map((p) => `${p.x},${p.y}`).join(' ');
  const dots = points.map((p) => `<circle cx="${p.x}" cy="${p.y}" r="3"><title>${escapeHtml(p.label)}</title></circle>`).join('');
  return `
    <div class="chart">
      <div class="muted">Average score by day, last ${history.length} day${history.length === 1 ? '' : 's'}</div>
      <svg viewBox="0 0 ${width} ${height}" width="100%" height="${height}" role="img" aria-label="Average score by day">
        <polyline fill="none" stroke="var(--accent)" stroke-width="2" points="${line}" />
        ${dots}
      </svg>
    </div>`;
}

// ---------- start ----------

// The language is chosen once, on the Setup page, and remembered.
document.addEventListener('change', (event) => {
  if (event.target.id !== 'language') return;
  state.language = event.target.value;
  localStorage.setItem('studyPartnerLanguage', state.language);
});

(async function init() {
  try {
    const res = await fetch('/api/status');
    const status = await res.json();
    state.stt = status.stt;
    const grading = status.mode === 'claude' ? `Claude · ${status.model}` : 'demo mode';
    const speech = status.stt === 'sarvam' ? 'Sarvam speech' : 'browser speech';
    $('mode-badge').textContent = `${grading} · ${speech}`;
  } catch (err) {
    $('mode-badge').textContent = 'offline';
  }
  setupAuth();
  try {
    const me = await (await fetch('/api/me')).json();
    if (me.lastLanguage) state.language = me.lastLanguage;
  } catch (err) {
    // Keep the default language if the server is unreachable.
  }
  insertExamScreen();
  $('language').value = state.language;
  await loadChapter();
  attachPushToTalk('explain');
  attachPushToTalk('recall');
})();
