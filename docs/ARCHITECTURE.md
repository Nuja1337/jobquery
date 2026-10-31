# Architecture

## Why a desktop app

JobPilot runs on the user's computer as an Electron app. We weighed a web app and chose desktop for four reasons.

1. **Filling forms needs a real browser.** Greenhouse, Lever, Ashby and Workday forms are filled in the user's own Chrome or Edge, from their home connection, in a separate browser profile where they sign in to job sites once and stay signed in. A server would have to run headless browsers from a data center, which job sites flag and block, and it would have to hold every user's login sessions.
2. **The API key stays with its owner.** Keys are encrypted with the operating system's key store (DPAPI on Windows, Keychain on macOS, libsecret or KWallet on Linux) and are only read by the main process. When no key store is available, the key is only obscured on disk and the app tells the user so. A web app would either store everyone's keys on a server or keep them in browser storage.
3. **Resumes and answers are personal.** Work authorization, demographic answers and salary history never leave the machine except in the requests the user's own AI provider receives.
4. **No servers to pay for.** The user's key pays for the AI calls and their computer runs the browser, so the app can be free to run.

The trade-offs are an installer, updates the user has to download, no phone access and an autopilot that only runs while the app is open. If a hosted version is ever wanted, the same core can sit behind a web UI with a browser extension doing the form filling.

## Layout

```
src/
  shared/      Types and the Api contract used by both processes
  main/        Electron main process (Node)
    db/        SQLite through sql.js, migrations, one repository per table
    llm/       Provider clients, model routing, budgets, response cache, cost ledger
    writing/   Prompts, the style linter and the draft, check, revise loop
    sources/   Job sources (public ATS APIs and job board APIs)
    pipeline/  Dedupe, free filters, keyword pre-score, AI fit scoring, the run orchestrator
    apply/     Form reading, answer mapping, filling, submitting, cover letter PDFs
    profile/   Resume and sample import, profile extraction, voice analysis
    ipc.ts     Implements the Api contract on top of the services
  preload/     Exposes window.bridge (call + on) to the renderer, nothing else
  renderer/    React UI
```

The renderer can't touch Node, the filesystem or the keys. It calls `window.bridge.call(method, ...args)`, which maps one to one onto the `Api` interface in `src/shared/api.ts`.

## The pipeline

Each run moves jobs through these stages. The early stages cost nothing, so most jobs never reach the AI.

| Stage | Cost | What happens |
|---|---|---|
| Discover | free | Pulls postings from watched company boards and saved searches. Each source is called at most once per its minimum gap |
| Dedupe | free | Board postings are keyed by board and posting id, so a renamed company isn't stored twice. The same posting on two boards is stored once (fingerprint of the full description) |
| Filter | free | Blocked companies, title and description words, target roles, seniority, location, remote, posting age, pay, visa, company cooldown |
| Pre-score | free | Keyword overlap between the profile and the posting. Low scores stop here |
| Fit score | cheap model | Score, summary, matches, gaps and dealbreakers. Below the shortlist line the job is archived as not a fit |
| Prepare | strong model | Reads the form, answers each field, writes the cover letter and open answers, runs the style check |
| Submit | free, unless new fields appear | Fills the form in the browser. Fields that only appear on the live form are answered then. The user clicks submit, or auto-submit does it within its limits |

A job is scored once. Dismissed jobs, archived jobs and duplicates are never sent to the AI again. Editing the profile doesn't rescore jobs already scored. The user can rescore any job, and a posting that closes and comes back is scored against the current profile.

Postings a board no longer lists are closed. Saved searches can't tell when a posting is removed, so their jobs close after 30 days without being seen, and auto-prepare skips anything that old. A repost under a new id takes over the closed posting's score.

## Spending controls

- Each pipeline step has its own model, so high-volume scoring can run on a cheap model while writing uses a stronger one.
- The stable parts of each prompt (instructions, then the profile) come first and are marked for provider prompt caching. Only the job changes between scoring calls.
- Every response is cached locally by a hash of the model, prompt version and inputs. A repeat request costs nothing.
- Daily and monthly dollar caps are checked before every call. A run that hits a cap stops cleanly and says so.
- Every call is written to the `llm_calls` ledger with its tokens and cost, which feeds the analytics screen.

## Writing that reads like the person

1. The writing prompt carries the user's facts, notes, voice profile and writing samples, and tells the model to use only those facts. If an honest answer needs a fact the profile doesn't have, the model replies `NEEDS_INPUT` and the field is flagged for the user.
2. Each draft goes through a local linter (`src/main/writing/lint.ts`) that scores it against a list of stock phrases and patterns: template openers, dashes used as pauses, "not only X but Y", lists of three, filler words, uniform sentence length and more.
3. Drafts under the user's minimum score get a targeted revision with the specific problems listed, up to the revision limit. The best-scoring version is kept.

## Answering form fields

For each field the app tries, in order:

1. The profile and settings (name, contact, links, work authorization, sponsorship, EEO defaults). Free.
2. The user's saved answers. Free.
3. One batched call to the reading model for the remaining short and multiple-choice fields.
4. The writing model with the style check for open-ended questions.

Questions about how the applicant used AI, legal agreements, terms, attestations and consent boxes are never sent to the AI. A check runs before every other step, including Regenerate, and only the user's own saved answer can fill one. Auto-submit never sends a form with one of these questions, even when a saved answer filled it.

Salary, start date and legal history are filled only from facts the user added to the profile, and flagged otherwise.

Job postings reach the prompts as quoted data, and every prompt tells the model to ignore instructions inside a posting.

Greenhouse publishes each job's questions in its public API, so those applications are drafted without opening a browser. Other forms are read with a background browser while preparing, and read again live when filling. Answers are matched to the live form by field key, then by label.

## Submitting

- **Fill and let me submit** opens the visible browser, fills everything and leaves the final click to the user. The app watches for the confirmation page and records the submission.
- **Submit** fills and clicks submit, then waits for a confirmation. It only clicks when nothing is flagged, no AI answer is below the confidence line, every answer was on the draft the user could review (whether it came from the profile, a saved answer or the AI) and no question is one the user must answer. A captcha, a validation error or no confirmation turns the application into "needs attention" with the browser left open.
- **Auto-submit** (off by default) applies the same rules to applications at or above its fit score, under the daily cap, and re-checks each application right before sending it. A dry-run setting makes Submit and auto-submit fill the form and stop before the click.

The time of each automatic click is stored before the click happens. An application the app clicked Submit on is never clicked again automatically, and the click counts toward the daily cap, even if no confirmation was seen.

While filling, the app only clicks an "Apply" link or button to reach a form. It never clicks a button inside a form, since some sites label their final submit button "Apply". On later pages of a multi-page form it leaves fields that already hold something alone, so the user's own edits stay.

A confirmation only counts when its message wasn't on the page before the click and the form is gone or the page changed, so a job description that ends in "thanks for applying" can't pass for one. A move to a new address with the form gone also counts when the address says thank you, submitted, success, complete or confirmation, and doesn't point at an email check, a sign-in, an account or a profile step.

A screenshot is saved for each submission the app sees.

## Data

One SQLite file in the app's data folder holds everything. The main tables are `jobs`, `applications`, `llm_calls`, `llm_cache`, `events`, `profile`, `documents` and `answer_bank`. Uploaded files are copied into the data folder. Migrations live in `src/main/db/schema.ts` and run on startup.
