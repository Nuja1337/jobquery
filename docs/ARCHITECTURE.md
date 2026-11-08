# Architecture

## Why a desktop app

JobPilot runs on the user's computer as an Electron app. We weighed a web app and chose desktop for four reasons.

1. **Filling forms needs a real browser.** Greenhouse, Lever, Ashby and Workday forms are filled in the user's own Chrome or Edge, from their home connection, in a separate browser profile where they sign in to job sites once and stay signed in. A server would have to run headless browsers from a data center, which job sites flag and block, and it would have to hold every user's login sessions.
2. **The API key stays with its owner.** Keys are encrypted with the operating system's key store (DPAPI on Windows, Keychain on macOS, libsecret or KWallet on Linux) and are only read by the main process. When no key store is available, the key is only obscured on disk and the app tells the user so. A web app would either store everyone's keys on a server or keep them in browser storage.
3. **Resumes and answers are personal.** Work authorization, demographic answers and salary history never leave the machine except in the requests the user's own AI provider receives.
4. **No servers to pay for.** The user's key pays for the AI calls and their computer runs the browser, so the app can be free to run.

The trade-offs are an installer, no phone access and an autopilot that only runs while the app is open. The app closes to the system tray, can start when the user signs in and keeps the PC awake while it works, so staying open is the normal state. If a hosted version is ever wanted, the same core can sit behind a web UI with a browser extension doing the form filling.

## Layout

```
src/
  shared/      Types and the Api contract used by both processes
  main/        Electron main process (Node)
    db/        SQLite through node:sqlite, migrations, one repository per table
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
| Discover | free | Pulls postings from watched company boards that are due and from saved searches. A board is due when its `board_state.next_check_at` has passed: hourly after a shortlisted job turned up in the last 14 days, every 6 hours by default, daily after 60 quiet days, and later after failures. Greenhouse, Lever and Ashby boards are read with their ETag, so an unchanged board costs one request that answers 304. Requests are paced per host (1 a second, bursts of 3, `Retry-After` honored, a host that answers 429 twice is paused for 10 minutes). Each saved-search source is called at most once per its minimum gap. A posting that links to a readable company board makes that board watched, unless the company is blocked or the cap in Settings is reached |
| Dedupe | free | Board postings are keyed by board and posting id, so a renamed company isn't stored twice. The same posting on two boards is stored once (fingerprint of the full description) |
| Filter | free | Blocked companies, title and description words, target roles, seniority, location, remote, posting age, pay, visa, company cooldown |
| Pre-score | free | Keyword overlap between the profile and the posting. Low scores stop here |
| Fit score | cheap model | Score, summary, matches, gaps and dealbreakers. Below the shortlist line the job is archived as not a fit |
| Prepare | strong model | Reads the form, answers each field, writes the cover letter and open answers, runs the style check |
| Submit | free, unless new fields appear | Fills the form in the browser. Fields that only appear on the live form are answered then. The user clicks submit, or auto-submit does it within its limits |

### Continuous mode

By default autopilot runs one batch every `intervalHours`: discover, filter, score, prepare and submit in that order, with nothing overlapping. With `autopilot.mode = 'continuous'` the scheduler starts a `WorkLoop` (`src/main/pipeline/loop.ts`) instead and sets no timer. The loop runs four workers that each take small steps from the orchestrator (`discoverStep`, `filterStep`, `scoreStep`, `prepareStep`, `submitStep`), so prepare and submit overlap. Discover reads the boards and searches that are due (at most once a minute) and applies the free filters. Score takes 20 jobs at a time, prepare 2 jobs with 2 drafts at once, and submit fills `submitConcurrency` applications at once (1 to 3, never two for one form, and no more than the per-company limit for one company). A worker that finds nothing waits 30 seconds, doubling up to 5 minutes, and a worker that finds work wakes the next one. Batch runs from Run now are replaced by a wake-up while the loop is on.

A limit stops only the worker that hit it, and the others keep going.

| Limit | Source of the count | Pauses |
|---|---|---|
| Provider rate limit | The `Retry-After` the provider sent, else the daily limit | That AI worker until the wait ends, or until local midnight |
| Budget | `LlmService.budgetStatus()` | Only a paid stage, until local midnight. A free stage keeps going |
| No model set up | The routing in Settings | That worker until settings change |
| Three provider errors in a row | Counted across steps | That worker for 15 minutes |
| `budget.maxTriagePerDay` | Successful, uncached `triage` rows in `llm_calls` since local midnight. A free model scores several jobs in one row, so its count runs low | Score until midnight |
| `budget.maxPreparePerDay` | Applications created since local midnight, since a prepare creates the application first. Manual prepares count too | Prepare until midnight |
| `dailySubmitCap` and `hourlySubmitCap` | `applications.submitted_at` or `submit_clicked_at` since local midnight or the start of the clock hour | Submit until midnight or the next hour |
| Per-family hourly cap (Lever 15, others 60) | The same columns grouped by the job's `ats` | Only that family's applications are skipped |
| Three captchas in a row, or two sign-in walls, on one family | Attempt results in memory | That family for 2 hours, with one activity entry |

The submit caps and the family caps come from the database, so they hold across restarts. `perCompanyLimit` sets how many applications one company may get inside `companyCooldownDays`, counting both confirmed submissions and Submit clicks, in the free filter and again right before each send. The loop writes one `runs` row an hour (trigger `loop`) with that hour's counts, pushes `loop:status` when a worker changes state, and reports one `pipeline:progress` line for all four workers.

A job is scored once. Dismissed jobs, archived jobs and duplicates are never sent to the AI again. Editing the profile doesn't rescore jobs already scored. The user can rescore any job, and a posting that closes and comes back is scored against the current profile.

Postings a board no longer lists are closed. Saved searches can't tell when a posting is removed, so their jobs close after 30 days without being seen, and auto-prepare skips anything that old. A repost under a new id takes over the closed posting's score.

## Spending controls

- Each pipeline step has its own model, so high-volume scoring can run on a cheap model while writing uses a stronger one.
- An application costs about 5 model requests on a paid provider and about 3 on a free one. Scoring sends only what bears on fit (no facts, links or writing samples). On a free provider up to 5 jobs are scored per request, one request at a time. On a paid provider each job is its own request, four at a time. A job the reply leaves out fails on its own, and a reply that can't be read at all is retried one job per request. All the open answers of an application, and the cover letter when one is needed, are written in one request. Style revisions are one request per round for every text that failed. A cover letter is written only when the form requires one (or Settings says always).
- The stable parts of each prompt (instructions, then the profile) come first and are marked for provider prompt caching. Only the job changes between scoring calls.
- Every response is cached locally by a hash of the model, prompt version and inputs. A repeat request costs nothing.
- Each provider is marked free or paid. Free tiers and local models cost $0 in the ledger and never count toward the caps. Ollama starts as free. Any other address, even one on this computer, starts as paid, since it can be a proxy to a paid API. OpenRouter serves free and paid models through one key, so there only model ids ending in `:free` are free.
- Daily and monthly dollar caps are checked before every paid call. A run that hits a cap stops cleanly and says so, and free providers keep working.
- A provider can have a requests-per-minute and a requests-per-day limit. Calls are spaced to stay under the first. Reaching the second, or a 429 from the provider, pauses AI work until the next run. It doesn't count against the job.
- A job the model fails on three times (a reply that can't be read, or a refusal) is skipped until the profile, the scoring model or a provider changes, or the user scores it by hand. Errors from the provider itself, such as a stopped Ollama or a wrong key, don't count against the job, and scoring stops for the run after three of them.
- Cancelling a run also cancels calls still waiting for their turn under a rate limit.
- Every call is written to the `llm_calls` ledger with its tokens and cost, which feeds the analytics screen.

## Writing that reads like the person

1. The writing prompt carries the user's facts, notes, voice profile and writing samples, and tells the model to use only those facts. If an honest answer needs a fact the profile doesn't have, the model replies `NEEDS_INPUT` and the field is flagged for the user.
2. Each draft goes through a local linter (`src/main/writing/lint.ts`) that scores it against a list of stock phrases and patterns: template openers, dashes used as pauses, "not only X but Y", lists of three, filler words, uniform sentence length and more.
3. Drafts under the user's minimum score get a targeted revision with the specific problems listed, up to the revision limit. The best-scoring version is kept. When an application has several open answers, they are written in one request and the ones that fail the check are revised together in one request per round, each with its own problems. An answer the reply leaves out, or all of them when the reply can't be read, is written again on its own.

## Answering form fields

For each field the app tries, in order:

1. The application facts, then the rest of the profile and settings (name, contact, links, work authorization, sponsorship, EEO defaults). Free.
2. The user's saved answers. Free.
3. Guesses from the wording of the question and the profile (country, residence, education, past employment). Free.
4. One batched call to the reading model for the remaining short and multiple-choice fields.
5. The writing model with the style check for open-ended questions. All of an application's open questions go in one request, and so does a required cover letter.

**Application facts.** The onboarding interview and the Applying tab on the Profile page fill `profile.application` once: address and phone code, work authorization per country, salary per currency, notice period and start date, relocation and travel, years per skill, language levels, clearance, driver's license, over 18, references, GPA and how the person hears about jobs. `mapKnownField` calls `mapApplicationField` (`apply/applicationFacts.ts`) before the contact fields. Each branch answers from its fact, and an empty fact gives a flagged answer with a note that says where to add it, so nothing is guessed. If the person gave the same answer as a free-form profile fact, that fact answers instead of the flag. Details that matter:

- Salary uses the entry whose currency is named in the question, then the posting's currency, then the currency of the job's country (`util/geo.ts`). With no currency known, the only entry is used at lower confidence, and several entries are left for the person. `answerStyle` picks a number, a range or "Negotiable, depending on the full package." Number fields get digits only, and a negotiable answer never goes into one.
- The job's country comes from its location, or from the board's country when the location says Remote. The authorization entry for the country in the question, or else the job's country, decides "authorized to work in X", sponsorship and citizenship questions. Without an entry the older `workAuthorization` summary applies.
- Start date and notice period use the notice weeks from today. A date field gets the date in the format its placeholder shows, ISO by default. A past start date is never written.
- Years with a skill match `skillYears` through aliases (JS and JavaScript, Postgres and PostgreSQL, k8s and Kubernetes). Number fields get the number, selects get the matching bucket, text gets "N years". A skill without years is flagged with "Add your years with X in Profile." The total `yearsExperience` answers only a question that names no skill.
- Criminal history joins AI use, legal agreements and consent as a question only the person answers (`mustAskUser`). Autopilot sends a form with one of these only when `autopilot.sendSavedUserAnswers` is on.

A saved answer to a general question (why this company or role, about you, strengths, a project you are proud of) is not pasted as it is. It goes into the writing request as the person's own base answer, to keep its facts and wording and adapt a sentence or two to the company and role. The result keeps the answer bank as its source, carries the note "Adapted from your saved answer." and goes through the style check. If the model can't adapt it, the saved answer is used as it is. Settings can turn this off (`writing.adaptSavedAnswers`). Saved answers to other questions (salary, notice period, work authorization, AI use) are always used as they are and never sent to the model.

**Topics.** Each saved answer is classified when it is saved (`shared/questionTopics.ts`). The topic is one of why_company, about_you, why_role, strengths, weaknesses, project, salary_expectation, notice_period, start_date, relocation, authorization, sponsorship, ai_use_disclosure, criminal_history, references, heard_about and years. The scope is the currency for salary, the country for authorization and sponsorship, and the skill for years. `AnswerBankRepo.findBest` tries an exact match on the question first, then an answer with the same topic and scope, then the closest question by word overlap. A fact on a company-specific topic (why_company, why_role) is not reused by topic, because it names the first company. A template is. Answers saved before topics existed are still found by the word overlap, and get a topic the next time they are saved.

A cover letter field or upload that is optional is left blank, not flagged, and no letter is written for it. A required one gets a letter. A form that couldn't be read ahead of time gets no letter until the live form shows a cover-letter field.

Questions about how the applicant used AI, legal agreements, terms, attestations and consent boxes are never sent to the AI. A check runs before every other step, including Regenerate, and only the user's own saved answer can fill one. Auto-submit leaves a form with one of these questions unless Settings allows it: "Tick required privacy and truthfulness boxes" covers the consent and attestation boxes the app recognizes, and "Send my saved answers to questions only I answer" covers answers the person wrote themselves. A saved answer to one of these questions is reused only when the new question matches the saved one word for word, never by topic, so a saved "No" to a conviction question can't answer a consent question. The Submit button on the Review page sends them in every case, since the user has seen the answer there.

Salary, start date, notice period and legal history are filled only from facts the user gave, in the application facts or as free-form profile facts, and flagged otherwise.

Job postings reach the prompts as quoted data, and every prompt tells the model to ignore instructions inside a posting.

Greenhouse publishes each job's questions in its public API, so those applications are drafted without opening a browser. Other forms are read with a background browser while preparing, and read again live when filling. Answers are matched to the live form by field key, then by label.

## Submitting

- **Fill and let me submit** opens the visible browser, fills everything and leaves the final click to the user. The app watches for the confirmation page and records the submission.
- **Submit** fills and clicks submit, then waits for a confirmation. It only clicks when nothing is flagged, no AI answer is below the confidence line, and every answer was on the draft the user could review (whether it came from the profile, a saved answer or the AI). A captcha, a validation error or no confirmation turns the application into "needs attention" with the browser left open.
- **Auto-submit** (off by default) applies the same rules to applications at or above its fit score, under the daily cap, and re-checks each application right before sending it. It also leaves any form with a question only the user may answer. A dry-run setting makes Submit and auto-submit fill the form and stop before the click.

Autopilot leaves no tab behind. When it ends without a Submit click, whatever the reason, it saves a screenshot and closes the tab (unless Settings keeps the browser open). After a click with no confirmation the tab stays open for a person to check. A failure before any click, such as a browser that will not start or a page that will not load, puts the application back in the queue. It counts toward three tries, and the third failure leaves the application as "needs attention". A spending or rate limit puts it back without counting. A dry run by autopilot also returns the application to the queue, marked so the same form is not filled again until dry run is turned off.

An auto-submit run keeps going until the day's cap is reached by applications actually sent, not by applications tried. It skips an application when the company had one sent or clicked within the company cooldown (or earlier in the same run), or when another application for the same form address was already sent or clicked. It stops after two failures in a row that came from the browser, and it gives each application 15 minutes to fill.

The time of each automatic click is stored before the click happens. An application the app clicked Submit on is never clicked again automatically, and the click counts toward the daily cap, even if no confirmation was seen.

While filling, the app only clicks an "Apply" link or button to reach a form. It never clicks a button inside a form, since some sites label their final submit button "Apply". On later pages of a multi-page form it leaves fields that already hold something alone, so the user's own edits stay.

A confirmation only counts when its message wasn't on the page before the click and the form is gone or the page changed, so a job description that ends in "thanks for applying" can't pass for one. A move to a new address with the form gone also counts when the address says thank you, submitted, success, complete or confirmation, and doesn't point at an email check, a sign-in, an account or a profile step.

A screenshot is saved for each submission the app sees.

### Review

The Review page leads with exceptions, so a person can handle hundreds of applications a day without opening each one. `src/main/review/exceptions.ts` builds the report that `listExceptions` returns.

- **Needs you** groups every unanswered required question of an open application by topic and scope (`topicFor`), or by the normalized label when it has no topic. `answerGroup` writes one answer into every application in the group through the same `saveEdit` path as a single edit, so an application with nothing else flagged becomes ready. It can also save the answer to the answer bank with the topic and scope. A form that does not offer the typed choice is skipped and counted.
- **Couldn't send** groups needs-attention applications with no open question by the reason found in the error text (`src/shared/reviewReasons.ts`). `retryLater` puts passing failures (timeout, browser, a missing confirmation with no click) back in the queue. Anything the app clicked Submit on stays.
- **Sent** shows today's and the week's counts and five random applications from today. `reportWrongSubmission` turns auto-submit off, logs an event that raises a notification, and keeps the person's note on the application.
- **All** is the plain queue, best fit first, 50 to a page. `/review/:id` is still the detail view of one application.

## Running in the background

- **Tray.** With "keep running in the tray" on, the close button hides the window. The tray menu shows the autopilot state and the next run, and offers Open, Pause or Resume autopilot, Run now and Quit. Windows sign-out and the tray's Quit go through the normal shutdown, which waits for the database and the browser.
- **Start at sign-in.** A login item is registered only for the installed app, with a flag that keeps the window in the tray at startup.
- **Keep awake.** A power-save blocker is held while autopilot is on or a run is going, and released the moment neither is true. After the PC wakes, the scheduler re-arms so an overdue run starts within a minute.
- **Notifications.** A Windows notification is shown when a site wants a sign-in, when a captcha stopped an application, when the AI budget or a provider limit is reached, when a run sent applications, and when auto-submit was paused. Each kind is shown at most once every 30 minutes. Clicking one opens the window.
- **Process errors.** Unhandled errors in the main process are written to the events table and never shown as a dialog, so an unattended run is not blocked.

## Data

One SQLite file in the app's data folder holds everything, through Node's built-in `node:sqlite` in write-ahead-log mode, so a committed write is in the journal at once and survives an app crash, and nothing is rewritten in full. A power cut can lose the last moments before a checkpoint. The main tables are `jobs`, `applications`, `llm_calls`, `llm_cache`, `events`, `profile`, `documents`, `answer_bank`, `companies` and `board_state`. Uploaded files are copied into the data folder. Migrations live in `src/main/db/schema.ts` and run on startup.

Retention runs at startup and once a day (`src/main/db/retention.ts`). Jobs the free rules dropped more than 60 days ago, with no application and no score, are deleted along with their duplicate rows. Closed and archived jobs older than 60 days keep the first 2,000 characters of their description. Events older than 180 days are deleted except submissions and outcomes, cached AI responses go after 60 days and run records after 180. Screenshots older than 60 days are deleted at startup. Postings carry the id they have on their application system (`ats_job_id`), so the same posting found through a job site and on the company board is stored once.
