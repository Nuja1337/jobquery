# JobPilot

A desktop app that finds jobs that fit you, writes your applications in your own voice with your own AI key, fills in the forms and keeps track of everything you've applied to.

You review each application and click Submit. If you trust it, auto-submit can do that part too, within limits you set.

## What it does

- **Finds jobs.** It reads public job boards from company career pages (Greenhouse, Lever, Ashby, SmartRecruiters, Workable) and job sites with open APIs (Remotive, RemoteOK, Arbeitnow, Hacker News "Who is hiring", Adzuna). You can also paste any job link.
- **Scores the fit.** Free rules drop jobs that break your preferences (location, remote, pay, seniority, title words, visa, companies you blocked). A keyword check drops weak matches. Only what's left goes to the AI, which scores the fit and explains the matches, gaps and dealbreakers.
- **Drafts the application.** It reads the form, fills the standard fields from your profile, and writes the cover letter and open-ended answers from your resume, notes and writing samples.
- **Checks the writing.** Every draft runs through a style check that flags stock phrases and patterns people associate with AI writing. Drafts that fail get revised before you see them, and the score shows next to the text.
- **Fills the form.** It opens the application in your own Chrome or Edge, in a separate browser profile where you sign in to job sites once, and fills it in. You press submit, or auto-submit does it.
- **Remembers everything.** Applied, dismissed and not-a-fit jobs are never scored again, so you don't pay twice to look at the same posting. You track replies, interviews and offers in the app.
- **Shows what's working.** It shows your reply rate by fit score and by source, what the AI cost per application, the skills that keep coming up as gaps, and how many tokens the free filters saved.

## Bring your own AI

Paste a key for any of these. Each step of the pipeline can use a different model, so high-volume fit scoring can run on a cheap model while writing uses a stronger one.

| Provider | Notes |
|---|---|
| Anthropic (Claude) | Suggested: Claude Haiku 5.5 for scoring, Claude Sonnet 5.5 for writing |
| OpenAI | |
| Google Gemini | Through Google's OpenAI-compatible endpoint |
| OpenRouter | Any model OpenRouter offers |
| Ollama | Local models, no key needed |
| Any OpenAI-compatible API | Groq, Together, DeepSeek, Mistral, LM Studio and others |

Your key stays on your computer. It's encrypted with your operating system's key store when one is available, and the app warns you when there isn't one. Daily and monthly spending caps stop all AI calls when they're reached.

## Why it's a desktop app

Filling a job application needs a real browser where you're signed in to the job sites, on your own internet connection. A web service would have to run browsers in a data center, which job sites block, and it would have to hold everyone's API keys and personal details. Running on your computer avoids all of that and means there's no server to pay for. [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) has the full reasoning and the trade-offs.

## Getting started

You need [Node.js](https://nodejs.org) 22.12 or later and Chrome or Edge.

```bash
git clone https://github.com/Nuja1337/jobpilot.git
cd jobpilot
npm install
npm run dev
```

The first launch walks you through setup. You add an AI provider, upload your resume, check the profile it reads from it, add writing samples and your preferences, and pick where to look for jobs. Then press **Run now**.

To build an installer:

```bash
npm run dist:win     # Windows (.exe)
npm run dist:mac     # macOS (.dmg)
npm run dist:linux   # Linux (.AppImage)
```

### Try it without a key

Demo mode runs the interface with sample data in a normal browser.

```bash
npx electron-vite dev --rendererOnly
```

Then open http://localhost:5173. Add `?onboarding=1` to see the first-run setup.

## How it keeps costs down

- Free rules and a keyword check run before any AI call, and postings that fail them never reach the AI.
- The same posting found on two sites, or reposted under a new id, is stored and scored once. Renaming a company you watch doesn't add its jobs again.
- A job is scored once. Editing your profile doesn't rescore the jobs you already have. New postings are scored against your current profile, and you can rescore any job from its page.
- The parts of each prompt that don't change (instructions and your profile) come first, so providers that support prompt caching charge less for them.
- Every AI answer is cached locally. Asking the same thing twice costs nothing.
- Short form fields are answered from your profile and saved answers before the AI is asked, and the ones left over go in a single batched call.
- Each job site is called at most as often as it allows. Remotive asks for no more than four calls a day, so all your Remotive searches share that limit.
- Each call's tokens and cost are logged, and the Analytics page shows where the money went.

## Applying responsibly

- Every fact in a draft comes from your profile, documents and notes. When an honest answer needs something the app doesn't know, the field is flagged for you instead of guessed.
- Some employers ask you not to use AI on applications, or to say whether you did. JobPilot never uses AI to answer those questions. It leaves them to you, and auto-submit never sends an application that has one, even when you saved your own answer for it. Read the employer's policy and respect it.
- Legal agreements, terms, attestations and consent boxes are handled the same way. Salary, start dates and legal history are only filled from facts you added to your profile. A saved answer of your own is reused on later forms. Demographic questions default to "decline to answer".
- Auto-submit is off by default. When on, it only submits applications at or above a fit score you choose, under a daily cap, and only when nothing is flagged, no answer is a low-confidence guess and every answer was on the draft you could review. It clicks Submit at most once per application. If no confirmation follows, the application waits for you.
- A dry-run setting makes every automatic submit, including the Submit button on the Review page, fill the form, take a screenshot and stop before the final click.
- Nothing counts as submitted until the page changes after the click and shows a new confirmation message or moves to a thank-you page, or until you mark it yourself. A screenshot is saved for each submission the app sees.
- Jobs come from public APIs meant for listing jobs. JobPilot doesn't scrape LinkedIn, Indeed or Glassdoor. RemoteOK and Remotive ask for a link back to their listings, and the app links each of their jobs to its page there.

## Your data

Everything lives in one SQLite file in the app's data folder, along with copies of your uploads, cover letter PDFs and submission screenshots. The only data that leaves your computer is what goes to your AI provider in each request and what you submit to employers. Settings has an export of everything except your API keys.

## Development

```bash
npm test             # unit and integration tests (vitest)
npm run typecheck    # TypeScript for the main process and the UI
npm run build        # typecheck, then build into out/
npm run smoke        # after a build: starts the real app and checks it end to end
```

The browser tests use your installed Chrome or Edge and are skipped if neither is found. `npm run smoke` needs the internet but no AI key.

```
src/
  shared/     Types and the Api contract shared by both processes
  main/       Electron main process: database, AI layer, writing, sources, pipeline, form filling
  preload/    The bridge the UI uses to call the main process
  renderer/   React UI
```

## Status

This is an early version. Known gaps:

- Workday and other sites that require an account and use multi-page forms work in "fill and let me submit" mode. The app fills each page as it appears, but auto-submit isn't reliable there yet.
- The Adzuna source follows Adzuna's documented format but hasn't been tested against the live API.
- Replies from employers are tracked by hand. Reading them from your inbox is planned.
- Tailoring the resume itself for each job is planned. Today the app tailors the cover letter and answers.
