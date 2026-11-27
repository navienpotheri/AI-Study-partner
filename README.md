# Study Partner

A voice-first study partner for students in Indian government schools. A student picks a home language (Hindi, Tamil, Telugu, Kannada or Malayalam), explains a concept by speaking, and gets a score, one thing to fix, and one follow-up question. The app also runs spoken recall checks and shows an exam dashboard.

Built for the Wispr Flow × Scaler "Build for Bharat" hackathon, Round 2 (theme: Inclusive education).

## Run it with one command

You need Docker. From this folder:

```
docker compose up --build
```

Then open http://localhost:3000.

The app starts with **no secret keys**. With no key it runs in **demo mode**: answers are graded by keyword matching against a preloaded Class 8 Science chapter (Cell: Structure and Functions). The badge at the top shows which mode is active.

## Turn on live Claude grading (optional)

1. Copy `.env.example` to `.env`.
2. Put your Anthropic API key in `ANTHROPIC_API_KEY`.
3. Run `docker compose up --build` again.

The badge now shows the Claude model. If a Claude call fails, the app falls back to demo grading for that answer, and the result says so. Your key stays on the server and is never sent to the browser.

## What works

- Pick a home language.
- Explain a concept by voice (push-to-talk) or by typing. Low-confidence speech is not graded: the app shows what it heard and asks again. After two failures it nudges you to type.
- Score, what you got right, the one thing to fix, and a follow-up question. Replies are spoken where the browser supports it.
- Spoken recall check, with a hint on failure.
- Exam dashboard: days left, coverage, mastery, retention, readiness with a range (labelled as an estimate), and a short plan.
- Progress is saved to `data/progress.json`, which is kept between restarts through the Docker volume.

## Not built yet

- Rapid-fire test (shown on the home screen as "next").
- Adaptive language switching and the exam-setup-by-voice flow.
- Recognition of mixed-language speech (speech recognition uses the home language only).
- Only one chapter is included.

## Notes on voice

Voice uses the browser's built-in speech recognition and speech synthesis. Support differs by browser: Chrome and Edge work best. Typing always works as a fallback.

## Project layout

- `server.js`: the server, grading (demo and Claude), and dashboard. No npm dependencies.
- `data/class8-science.json`: the preloaded chapter.
- `public/`: the web app (HTML, CSS, plain JavaScript).
- `docker-compose.yml` and `Dockerfile`: the one-command setup.
