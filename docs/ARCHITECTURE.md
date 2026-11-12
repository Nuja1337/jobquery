# Architecture

## Why a desktop app

JobQuery runs on the user's computer as an Electron app. We weighed a web app and chose desktop for four reasons.

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
| Filter | free | Blocked companies, title and description words, target roles, seniority, location, remote, employment type, posting age, pay, visa, company cooldown. [Targeting](#targeting) has the details |
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

A job is scored once. Dismissed jobs, archived jobs and duplicates are never sent to the AI again. Editing the profile doesn't rescore jobs already scored. The user can rescore any job, and a posting that closes and comes back is scored against the current profile. The one exception is the rescore described under [Targeting](#targeting).

Postings a board no longer lists are closed. Saved searches can't tell when a posting is removed, so their jobs close after 30 days without being seen, and auto-prepare skips anything that old. A repost under a new id takes over the closed posting's score.

### Targeting

- **Posting text.** `trimDescription` (`src/main/util/text.ts`) shortens a posting for the prompts one line at a time. It drops boilerplate such as equal-opportunity statements and privacy notices, and it never drops a line that mentions requirements, years, a degree, clearance, citizenship, location, relocation, on-site, hybrid, remote, visas or sponsorship. When more than half of the text would go, it keeps the full text. A posting that is still over budget keeps its Requirements, Qualifications, Location and Responsibilities sections ahead of About and Benefits, in their original order. `fitWholeSentences` in the same file cuts text at a sentence end for the writing code.
- **Titles and levels.** Engineer, developer, programmer, SDE and SWE count as one role noun in a title match, and gameplay matches game. "Distributed" and "Remote Sensing" in a title no longer read as remote. Seniority is read from the title, including Snr as senior, Architect as staff, co-op and apprentice as intern, and level numbers and L, P and IC levels. Himalayas, Personio and The Muse state a level or a minimum number of years, and the app stores them on the job (`seniority`, `min_years`) and uses them.
- **Locations.** A location that lists several cities is split into places. A city the app does not know passes the filter and is left to scoring.
- **Sponsorship.** A posting that says it does not sponsor fails the filter only when the owner needs sponsorship for that job. Whether the owner needs it is read per country from the work authorization entries, and the wording check matches "we do not offer visa sponsorship" but not "visa sponsorship is available".
- **Pay and pre-score.** The pay parser skips bonus and relocation ranges. The keyword pre-score needs a real match with the profile, not one shared title word.
- **Employment type and relocation.** `preferences.employmentTypes` filters jobs by full time, part time, contract and the other types. An empty list means any, and a job whose type is unknown passes. When the owner is willing to relocate, the relocation places count as acceptable locations.
- **Fit view.** The profile view sent to the scoring model (`renderProfile('fit')`) adds authorization per country with visa type, expiry and whether the permit allows any employer, relocation and its places, language levels and clearance. A fact the owner has not answered reads "not stated", never "no". The triage prompt version is `triage-v3`.
- **One-time rescore.** Migration 11 marked shortlisted jobs, and jobs with a ready application that was not sent, in `jobs.rescore_pending`, because earlier scores came from cut-down postings. The score step scores these again, shares the daily limit with new jobs and clears the mark when the new score is saved. Sent, closed and dismissed jobs are left alone.

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
3. Drafts under the user's minimum score, or with a blocking issue, get a targeted revision with the specific problems listed, up to the revision limit. The best-scoring version is kept. When an application has several open answers, they are written in one request and the ones that fail the check are revised together in one request per round, each with its own problems. An answer the reply leaves out, or all of them when the reply can't be read, is written again on its own.

### Gates before a text goes out

- **Blocking issues.** `blockingIssues` (`lint.ts`) lists the high-severity phrases plus em dashes, "not X but Y" and "it's not X, it's Y" formulas, placeholders, markdown, emoji and stock openers. A text passes when its score reaches `minLintScore` and nothing blocks it, so a high score no longer covers a tell. Template openers such as "passionate about" and "excited about the opportunity" are high severity.
- **Revision.** Both loops (one text, and the batch of open answers) revise when the score is low, a blocking issue exists, the text is not grounded or the text is too long. The best version is kept.
- **Grounding.** Three checks hold a text against the posting and the profile. It must name enough from the posting, it must not mostly repeat the resume, and its numbers and names must appear in the profile or the posting. These issues are medium severity. They cost no score, but they feed the revision and put the text below the auto-send confidence. A question about the employer or the role needs a detail from the posting. Resume shorthand counts as known when the profile or the posting uses the other form (`UE5` and "Unreal Engine 5", `Switch` and "Nintendo Switch", `K8s` and "Kubernetes", and similar groups in `ALIAS_GROUPS`). Years and months worked out from the profile's experience dates, rounded down or up, count as supported numbers.
- **Confidence.** An open answer is 0.85 when it passes and is grounded, and 0.6 otherwise. A letter pasted into a text field is 0.9 when it passes and 0.6 otherwise, with the lint report attached.
- **Held letters.** A cover letter that still fails the style check or the grounding check after its revisions is held (`lettersCheckPasses`, `letterHeld`). An optional letter upload is dropped and the application goes on. A required upload or text box keeps the application in "needs attention" with a note that names the top issue. `saveEdit` checks an edited letter again against the posting's allowed terms and the grounding source, and only an edit that passes releases the application. Regenerate and Refresh resume answers go through `saveEdit`, so they move the status. The submit step checks the letter again before an auto-submit (`recheckLetter`, no model call), so an application that was ready before the hold existed is held too. The owner can still send a held letter from the Review page. A held letter keeps the application out of the ready queue, and "Retry later" skips it.
- **Allowed terms.** A term on the banned list that the posting or the profile uses in its plain sense, such as "test harness", comes off the list in the prompt and in the linter.
- **Per-question instructions.** The form reader keeps the form's own instruction for a question in `FormField.hint`, taken from the text after the required marker, the placeholder, `aria-describedby` or the Greenhouse description. `parseLimits` reads word and character limits from the label or the hint, and the stricter of those and the field's `maxLength` applies. "No more than 200 words" and "do not go over 300 words" are upper limits. A word limit under 15 is checked as a word count only and sets no character cap. A hint that forbids links ("no links please") means no link is added and none is flagged as missing. A dropdown prompt such as "Select..." and text that only lists the field's options are not kept as a hint. The hint reaches the prompt as quoted data.
- **Fitting to the box.** The prompt states the size, "About N words, under M characters", and a revision over the limit is told to shorten and keep the sentence that answers the question. A last resort cuts at whole sentences (`fitWholeSentences`). When not even the first sentence fits, the answer is flagged and no fragment is sent. A saved answer or a model answer over the limit is fitted the same way or flagged, a cover letter in a text box with a limit is written to that limit, and an existing letter that is too long flags the field.
- **Optional boxes.** An optional open box such as "Additional information", and a one-line catch-all box such as "Notes", is left blank unless a saved answer exists. Regenerate, or guidance from the owner, counts as asking for text.
- **NEEDS_INPUT** is matched anywhere in a reply, also written "NEEDS INPUT:" or inside bold marks.

## Answering form fields

For each field the app tries, in order:

1. Questions only the person answers (AI use, legal terms, consent, criminal history). Only the person's exact saved answer fills them (`mustAskUser`).
2. Self-identification questions, the demographic gate. They come from Settings, the form's decline option or the person's exact saved answer, and never from the AI. Details follow below.
3. Known fields. The application facts (`apply/applicationFacts.ts`, `apply/availabilityFacts.ts`), then the rest of the profile and settings (name, contact, links, work authorization, sponsorship). Free. When a rule has no answer it flags the question, and the person's saved answer to the same question clears the flag. Salary, authorization, sponsorship and start dates are the exceptions. A saved salary has no currency unless the question names one, a start date goes stale, and an authorization or sponsorship answer was written for one country, so it counts only when the label names exactly one country.
4. The user's saved answers. Free.
5. Guesses from the wording of the question and the profile (country, residence, education, past employment). Free.
6. The willingness families (`apply/questionFamilies.ts`). A question about working on site, hybrid or remote, commuting, schedule, overtime, hours, employment type, a drug test, a background or credit check, export control or an immigration case that no rule answered never reaches the AI. A required one is flagged with a note and an optional one is left blank.
7. One batched call to the reading model for the remaining short and multiple-choice fields. Its context lists the stated facts (`renderApplicationFacts`), and an unanswered fact reads "not stated". The system prompt tells the model to flag a willingness question unless a stated fact answers it.
8. The writing model with the style check for open-ended questions. All of an application's open questions go in one request, and so does a required cover letter.

**Application facts.** The onboarding interview and the Applying tab on the Profile page fill `profile.application` once: address and phone code, work authorization per country, salary per currency, notice period and start date, relocation and travel, years per skill, language levels, clearance, driver's license, over 18, references, GPA and how the person hears about jobs, along with the work and availability facts listed below. `mapKnownField` calls `mapApplicationField` (`apply/applicationFacts.ts`) before the contact fields. Each branch answers from its fact, and an empty fact gives a flagged answer with a note that says where to add it, so nothing is guessed. If the person gave the same answer as a free-form profile fact, that fact answers instead of the flag. Details that matter:

- Salary uses the entry whose currency is named in the question, then the posting's currency, then the currency of the job's country (`util/geo.ts`). With no currency known, the only entry is used at lower confidence, and several entries are left for the person. `answerStyle` picks a number, a range or "Negotiable, depending on the full package." Number fields get digits only, and a negotiable answer never goes into one.
- The job's country comes from its location. A location that names no country, such as Remote, leaves it unknown, and the app does not read it from the board. The authorization entry for the country in the question, or else the job's country, decides "authorized to work in X", sponsorship and citizenship questions. When the person has per-country entries and the country cannot be told, the question is flagged instead of answered from the older `workAuthorization` summary. That summary applies only when the person has no entries.
- Start date and notice period use the notice weeks from today. A date field gets the date in the format its placeholder shows, ISO by default. A past start date is never written.
- Years with a skill match `skillYears` through aliases (JS and JavaScript, Postgres and PostgreSQL, k8s and Kubernetes). Number fields get the number, selects get the matching bucket, text gets "N years". A skill without years is flagged with "Add your years with X in Profile." The total `yearsExperience` answers only a question that names no skill and no kind of work. A question about the games industry, AAA, shipped titles, console, leading a team or managing people reads the experience facts below, and is flagged when that fact is empty.
- Criminal history joins AI use, legal agreements and consent as a question only the person answers (`mustAskUser`). Autopilot sends a form with one of these only when `autopilot.sendSavedUserAnswers` is on.
- Fact guards keep a fact from answering a question that asks something else. A saved fact such as "Background check: Yes" does not answer "Have you ever failed a background check?", because a label with a polarity word the fact lacks (ever, failed, refused, not, never, convicted, terminated, denied) is refused, and a match needs a close overlap in both directions. "Are you authorized to work in the US and will you require sponsorship?" is two questions and is flagged. A compound age question ("18 or older and authorized to work") steps aside so the authorization or license rule answers the rest. "North America", "Latin America" and "South America" name several countries and are flagged. "Highest degree completed" skips entries that are in progress or expected, and a plain "Degree" is flagged when the latest entry is still in progress. A start-date or notice question reads the number of days, weeks or months in the label and compares it, with "longer than" and "more than" inverted. Relocating at the person's own expense is flagged.
- Salary above the posted range. When the person's target is above the posted maximum, the posted maximum is sent if the person's minimum fits under it. Otherwise the question is flagged.
- Commute. "Can you commute to X?" is Yes when relocation is on and X passes the relocation places list, or when X is in the commutable cities.

**Work and availability facts.** These live in `profile.application` and are edited on the Profile page under Applying, and in onboarding, which has a "Work and availability" step. `null` means not answered. A question that needs an unanswered fact is flagged with a note that says where to add it. The filters and the form answers are separate stores. A filter that defaults to "all" never becomes a Yes on a form.

| Fact | Where it is edited | Questions it answers |
|---|---|---|
| `workArrangement` (remote, hybrid, on site, most office days a week, commutable cities) | Applying, "Work arrangement and commute" | On site, in the office N days, hybrid, commuting |
| `employment` (types, hours per week, currently employed, desired title) | Work and availability, "Employment and hours" and "Current job and pay" | Full time, contract, 40 hours, "currently employed", "desired position" |
| `employment.currentPay` (decline, or an amount with currency and period) | "Current job and pay" | "Current salary" |
| `schedule` (evenings, weekends, nights, on call, overtime, time zones) | "Schedule" | Shifts, crunch, time-zone overlap |
| `screening` (background check, drug test, credit check) | "Background screening" | Willingness wording only. "Have you ever failed" and consent wording stay with the person |
| `education` (highest completed, enrolled, expected graduation, fields, related fields) | Applying, "Education details" | Highest level, "Bachelor's in computer science or related", enrolled, graduation date |
| `experience` (years in professional software, games industry, leading a team and managing people, shipped and AAA titles, platforms) | Applying, "Experience details" | Games industry, AAA, led a team, console |
| `citizenships`, `exportControlUsPerson`, `clearanceEligible` | Applying, "Work authorization" and "Other questions forms ask" | Dual citizenship, U.S. person under ITAR or export control, able to obtain a clearance |
| `authorization[]` additions: visa type (F-1 OPT, STEM OPT, H-1B, TN, other), expiry, any employer | Applying, "Work authorization" rows, one per country | OPT, H-1B, TN, "authorized for any employer", immigration case |
| `profile.name` (first, middle, last, preferred, pronunciation) | Profile page, "Name", prefilled from the full name | First, middle, last and preferred name. A profile without it splits the full name at the first space |
| `preferences.employmentTypes` | Settings, Job preferences, and onboarding | Job filter only |

A saved answer to a general question (why this company or role, about you, strengths, a project you are proud of) is not pasted as it is. It goes into the writing request as the person's own base answer, to keep its facts and wording and adapt a sentence or two to the company and role. The result keeps the answer bank as its source, carries the note "Adapted from your saved answer." and goes through the style check. If the model can't adapt it, the saved answer is used as it is. Settings can turn this off (`writing.adaptSavedAnswers`). Saved answers to other questions (salary, notice period, work authorization, AI use) are always used as they are and never sent to the model.

**Topics.** Each saved answer is classified when it is saved (`shared/questionTopics.ts`). The topic is one of why_company, about_you, why_role, strengths, weaknesses, project, salary_expectation, notice_period, start_date, relocation, authorization, sponsorship, ai_use_disclosure, criminal_history, references, heard_about and years. The scope is the currency for salary, the country for authorization and sponsorship, and the skill for years. `AnswerBankRepo.findBest` tries an exact match on the question first, then an answer with the same topic and scope, then the closest question by word overlap. A fact on a company-specific topic (why_company, why_role) is not reused by topic, because it names the first company. A template is. Answers saved before topics existed are still found by the word overlap, and get a topic the next time they are saved.

A cover letter field or upload that is optional is left blank, not flagged, and no letter is written for it. A required one gets a letter. A form that couldn't be read ahead of time gets no letter until the live form shows a cover-letter field.

Questions about how the applicant used AI, legal agreements, terms, attestations and consent boxes are never sent to the AI. A check runs before every other step, including Regenerate, and only the user's own saved answer can fill one. Auto-submit leaves a form with one of these questions unless Settings allows it: "Tick required privacy and truthfulness boxes" covers the consent and attestation boxes the app recognizes, and "Send my saved answers to questions only I answer" covers answers the person wrote themselves. A saved answer to one of these questions is reused only when the new question matches the saved one word for word, never by topic, so a saved "No" to a conviction question can't answer a consent question. The Submit button on the Review page sends them in every case, since the user has seen the answer there.

**Self-identification.** `demographicFamily` (`apply/demographics.ts`) decides whether a field is a voluntary self-identification question. It counts a field only when the label uses self-identification wording or is a short label such as "Race", "Gender" or "Veteran status", and only for choice, checkbox and short text, date and number fields. A text area never counts. Words such as race condition, data race, debug, players, accessibility, ESRB and rating rule a label out. The families are gender, pronouns, transgender, sexual orientation, LGBTQ, race, Hispanic or Latino, veteran, military service, military spouse, disability and age, plus the UK and EU ones below.

The answer comes from the setting, then the form's decline option, then the person's exact saved answer. When none applies, an optional field stays blank and a required one is flagged. The check runs right after the question-only-the-person-answers check, so the answer bank, the inferred rules and the model never see these fields, and Regenerate is hidden for them (`rule: 'demographic'`). An accommodation question goes to the person and never gets the disability setting. Autopilot may still send a form with a live-only field answered this way, because the answer came from Settings.

A decline option is found by wording such as "prefer not to say", "decline to state", "do not want to answer" and "no answer". An option that also states a status, such as "I identify as a protected veteran, but choose not to self-identify the classification", is never picked as a decline, and when more than one candidate is left the field is left for the person. Age questions decline unless the person entered a birth year in Settings. Age bands and "40 or older" then come from the birth year.

**Settings, version 2.** `settings.eeo` (`src/shared/eeo.ts`) stores stable ids, never option text, so the form's wording can change without a migration. An empty list or `decline` means the form's decline option.

- US: gender (and text for self-describe), transgender, Hispanic or Latino, race (a list, with "Two or More Races" derived from two or more picks), veteran status with its four categories, military service, military spouse, disability, sexual orientation, LGBTQ and pronouns. Hispanic or Latino is answered before race, because Greenhouse shows Race only after it.
- UK and EU: the ONS ethnic group and subgroup, religion, caring responsibilities, the four Social Mobility Commission questions (main household earner's occupation, school type, free school meals and a parent's degree), and neurodivergence. Marital status and pregnancy always get the decline option.
- Migration. `normalizeEeo` reads the raw stored row before it is merged over the defaults, because the defaults already carry a version and would hide an old row. A row without a version holds free text, and it is converted, so `{gender: 'Male', veteran: 'No'}` becomes `{gender: 'man', veteran: 'not_protected'}`. Text it cannot map becomes `self_describe` with the text kept. The Settings card is "Self-identification" (`DiversityCard`).

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

### Filling

- **Control types.** Ashby's yes/no buttons are read as a radio field with Yes and No, clicked, and checked through `aria-pressed`. Lever's location box is a combobox that is filled from its suggestion list. Radio and checkbox groups that are all hidden (a display:none survey) are skipped.
- **Read-back.** After each fill the app reads the committed state and fails the field with a reason when it differs. It checks the text value and length (a value cut at `maxlength` shows up as a failure), a select's label, a react-select display, `aria-pressed`, the checked state and the file name.
- **Location suggestions.** When the wanted region or country matches no suggestion, the app picks none instead of the closest city. Athens, GA is never filled as Athens, Alabama. A suggestion whose region matches is accepted even when the city name differs.
- **Resume upload.** The resume uploads as "First Last - Resume.pdf" with its real extension, whatever the file is named on disk. The field's `accept` list is read, and a resume type the field does not take is refused.
- **Passes.** An answer can reveal fields (choosing "Other" asks what is meant). In auto mode, dry run included, the form is read again after the first fill, at most twice more, and what showed up is answered and filled. Assist mode leaves that to the person and the watcher. Dropdown options are read only for fresh, unmatched fields, never on watcher passes and never while a text box has the focus.
- **Final check.** Right before the click, auto mode reads the form once more. A required field that is still empty becomes a problem, and a problem means no click.
- **Fields only the live form has.** The app writes answers for them on the live form, and by default they block auto-submit. A live-only answer is allowed to auto-submit when it came from the person's settings or profile rules (`source` is `profile` or `settings`, or the demographic rule reading Settings). An answer written by the AI, or reused from the answer bank, on a live-only field still blocks it.

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


### Documents

- A resume must be a PDF or a Word (.docx) file, because it is attached to applications as it is. The app refuses other types.
- The first resume becomes the primary one. After a later upload the app asks "Use as primary?" and the answer decides which file applications use. "Read my resume" names the file it reads.
- Each application records the resume it will use in `resume_doc_id`. Deleting a resume that a sent application used removes the record from the list and keeps the file, so the application can still be traced to it.
- The first portfolio link added under Documents fills `profile.links.portfolio` when that is empty.
- The cover letter PDF has a `<title>`, clickable links for LinkedIn, GitHub and the portfolio, and the company name without a legal suffix ("Riot Games, Inc." becomes "Riot Games").
- Preparing the same job twice at once is not run twice. The second call waits for the first and returns its result.

## Scale and diagnostics

### Indexes

The applications table has indexes on `submitted_at`, `created_at` and `submit_clicked_at` (migration 12). The counts the loop and the daily cap read are range counts on those columns. "Sent today" counts a confirmed send and a Submit click that saw no confirmation, so it used to be one `OR` query that SQLite could not answer from one index. `countSubmittedSince` now runs two counts, one on each column, and the second skips rows the first already counted. The result is the same as the `OR` query, and a test compares them on a seeded database.

The submit step reads that count once before it walks the ready applications, and again after each attempt. Nothing else can change it between two candidates, so skipped candidates no longer run the query. The loop status keeps its day counts for 3 seconds and drops them when a step ends, when a step fails, and when the loop starts or stops. A manual submit shows up within that window.

### Database copy

Settings has a "Save a copy of the database" button. It asks for a file name and writes a copy with `VACUUM INTO`, which gives a consistent file while the app keeps running (`src/main/db/exportDb.ts`). The copy is written to a temporary file next to the target, cleaned, and then moved into place. The app refuses to write to the live database file, its `-wal` and `-shm` files, or any path that resolves to them.

API keys are stored in the database, encrypted with the operating system's key store (`providers.api_key_enc`), so the copy would carry them. The copy has them set to null, and the credentials in saved searches (Adzuna's app id and key) are blanked. Freed pages are overwritten and the file is compacted, so the old values are not left in the bytes. After restoring a copy, enter the provider keys again. The older "Export data" button still writes a JSON file.

### Log file

The app writes a log file in the data folder, `logs/jobquery.log`. It rotates at 2 MB and keeps 4 files (`jobquery.1.log` to `jobquery.3.log` are the older ones), so it never grows past about 8 MB. Each line has a time, a level and a message. It holds every activity event (type, job id and message), the app version and database version at startup, errors nobody caught, and failed database copies. Event data, prompts, documents and answers are never written to it.

Before a line is written, text after names such as `key`, `token`, `password` and `app_id`, bearer tokens, cookie and authorization headers, known key formats and any unbroken run of 40 or more characters are replaced with `[removed]`. Write failures are ignored, so a full disk does not stop a run. The updater still logs only to the console.
