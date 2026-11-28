# Study Partner

A voice-first study partner for students in Indian government schools. A student picks a home language (Hindi, Tamil, Telugu, Kannada or Malayalam), explains a concept by speaking, and gets a score, one thing to fix, and one follow-up question. Then they say one sentence in English. The app also runs spoken recall checks, a rapid-fire test, and an exam dashboard that tracks progress over time for each student.

Built for the Wispr Flow × Scaler "Build for Bharat" hackathon, Round 2 (theme: Inclusive education).

## Run it with one command

You need Docker. From this folder:

```
docker compose up --build
```

Then open http://localhost:3000.

The app starts with **no secret keys**. With no keys it runs in **demo mode**: answers are graded by keyword matching (including Hindi, Tamil, Telugu, Kannada and Malayalam key terms), and speech uses the browser's built-in recognition. The badge at the top shows which mode is active.

## Optional: Claude grading

Set `ANTHROPIC_API_KEY` in `.env` (copy `.env.example`). Grading then reads meaning in any mix of the home language and English. Your key stays on the server.

## Optional: Sarvam speech for regional languages

Sarvam's speech-to-text handles Indian languages and English mixed in one sentence. When a Sarvam key is set, the app records your voice and sends it to Sarvam through the server.

1. Create an account and get an API key at the Sarvam dashboard: https://dashboard.sarvam.ai
2. Check current prices and free credits: https://sarvam.ai/api-pricing
3. Read the speech-to-text reference: https://docs.sarvam.ai/api-reference-docs/speech-to-text/transcribe
4. Put the key in `.env` as `SARVAM_API_KEY=...` and run `docker compose up --build` again.

The badge then shows "Sarvam speech". The model defaults to `saaras:v4` and can be changed with `SARVAM_MODEL`. The key is read on the server only and is never sent to the browser.

## Students and progress

Each browser gets its own student id, kept in local storage. Progress, the exam plan, and the last language used are stored per student on the server (`data/progress.json`, kept between restarts through the Docker volume). Clearing browser storage starts a new student.

## What works

- Pick a home language. The app remembers the last one used.
- Explain a concept by voice (push-to-talk) or by typing. Low-confidence speech is not graded: the app shows what it heard and asks again. Did-you-mean checks flag near-miss key terms.
- Score, what you got right, the one thing to fix, a follow-up question, and the grounded source line.
- One English sentence after each explanation, checked for the key ideas.
- Spoken recall check, with a hint on failure.
- Rapid-fire test: weak and due concepts first, one question at a time, a score and review list.
- Continue: jumps to the next concept that is due.
- Review timing: concepts answered well come back less often; weak ones come back the next day.
- Exam setup by voice or text: class, subject, chapters, exam date, and preparation percentage. The app asks for anything missing.
- Dashboard: days left, syllabus coverage, pace, fluency (estimate), English readiness, readiness with a range (labelled as an estimate), review count, and a 14-day chart.

## Not built yet

- Mixed-language key terms are checked against a small list of regional words (`data/aliases.json`). Those translations need review by a Class 8 teacher before the pilot.
- The home screen layout is a first version. A redesign is planned.
- Voice has not been tested with real students. Test it in Chrome or Edge before you rely on it.

## Project layout

- `server.js`: the server, grading (demo and Claude), Sarvam speech proxy, spaced review, and dashboard. One npm dependency (pg, for the optional database).
- `data/class8-science.json`: the preloaded chapter. `data/aliases.json`: regional words for key terms.
- `public/`: the web app (HTML, CSS, plain JavaScript).
- `docker-compose.yml` and `Dockerfile`: the one-command setup.

## Optional: email sign-in

Students sign in with their email address. We send a one-time link, and the student taps it to confirm. Guests still work, with progress kept on one browser.

1. Create a Resend account and an API key (https://resend.com/api-keys).
2. Put the key in `.env` as `RESEND_API_KEY=...`. Set `MAIL_FROM` to a sender on your verified domain (see the Resend domain guide: https://resend.com/docs/dashboard/domains/introduction).
3. Restart the app. Without a key, the link is printed in the server log, which is for local testing only.

Only a hashed email address is stored, and each link works once and expires after 15 minutes. Until a domain is verified, Resend sends only to the account owner's address.
## Hosting the live link on Railway

1. Connect the GitHub repo to a new Railway project. Railway builds from the `Dockerfile`.
2. Add variables: `ANTHROPIC_API_KEY`, `SARVAM_API_KEY`, `GOOGLE_CLIENT_ID`. Leave any key out to run that feature in demo mode.
3. Attach a Railway volume at `/app/data`, so progress survives redeploys.
4. Set a spending limit on the Anthropic and Sarvam accounts before you share the link.


## For judges: demo sign-in

To try the app, enter any first name and email address on the sign-in page and tap **Send me a link**. You are signed in straight away, with no email to check. The live link runs with `DEMO_SIGNIN=true`. Real students, once the app is in pilot, use the email link instead.

## Study plan and syllabus

- The app includes every concept of NCERT Class 8 Science ("Curiosity", 13 chapters, 126 concepts) in `data/syllabus-class8-science.json`. The list follows each chapter's section headings and its "Snapshots" summary. The definitions are short paraphrases and have not been checked by a teacher. `tools/build-syllabus.js` rebuilds the file.
- In **Setup**, the student describes one or more exams by voice or text ("Class 8 science half-yearly on 28 December, chapters 5 to 10"). The app builds a plan that covers every concept in those chapters, keeps the last days before each exam for revision, and sets a daily number of new concepts. The plan is worked out fresh each day, so a missed day is spread over the days left.
- **Today** on the home screen starts a spoken session: the app explains a concept aloud, the explanation leaves the screen, the student explains it back from memory, answers one follow-up, and the session moves to the next concept.
- For other classes and subjects, the student names the chapters and Claude drafts the concept list (needs `ANTHROPIC_API_KEY`). Drafted lists are marked as AI-made.

## Voice

With `SARVAM_API_KEY` set, the app listens with Sarvam speech-to-text and speaks with Sarvam text-to-speech (`SARVAM_SPEAKER`, default `priya`). Without it, the app uses the browser's own speech features.

## Storage and sign-in settings

- `DATABASE_URL`: a Postgres connection string (for example from Neon). Progress is then kept in the database and survives restarts. Without it, progress is kept in `data/progress.json`.
- `SESSION_SECRET`: a long random string. Sign-ins then survive restarts.
- `DEMO_SIGNIN=true`: name and email sign you in with no email link. This is also the behaviour when no email key is set, so the app works with no keys at all.
