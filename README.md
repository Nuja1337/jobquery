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

Use a free option or a paid key, whichever you prefer. Each step of the pipeline can use a different model, so fit scoring can run on a free or cheap model while writing uses a stronger one.

**Free**

| Provider | Notes |
|---|---|
| Google Gemini (free tier) | You don't need a card. Use a key from a Google project without billing, since a billed key is charged for each call and JobPilot treats it as free. Google may use free-tier requests to improve its products, and people may read them. This doesn't apply in the European Economic Area, Switzerland or the UK |
| Groq (free tier) | You don't need a card. It runs fast open models with daily limits |
| OpenRouter free models | Pick models whose names end in `:free`. You get about 50 requests a day until you've bought credits, and any other model on OpenRouter is paid |
| Mistral (free plan) | You don't need a card. Mistral may use free-plan requests to train its models |
| Ollama or LM Studio | Models run on your own computer. They're free and private, but they need a fairly strong computer |

**Paid**

| Provider | Notes |
|---|---|
| Anthropic (Claude) | Suggested: Claude Haiku 5.5 for scoring, Claude Sonnet 5.5 for writing |
| OpenAI | |
| Google Gemini with billing turned on | Google doesn't use paid-tier data to improve its products |
| OpenRouter | Any model OpenRouter offers, paid from credits you buy |
| Any OpenAI-compatible API | Together, DeepSeek, Fireworks and others |

A ChatGPT or Claude subscription doesn't include API use, so a paid key is billed separately by its provider.

JobPilot spaces out its requests to stay under a free tier's per-minute and per-day limits. When a provider says the limit is reached, it pauses and carries on with the next run.

Your key stays on your computer. It's encrypted with your operating system's key store when one is available, and the app warns you when there isn't one.

## Costs and billing

Your AI provider bills you directly, and JobPilot isn't responsible for any charges from your provider.

- A free tier costs nothing while billing is off for the key. A key with billing turned on gets charged for each call, even if you marked it free in JobPilot.
- JobPilot's costs and budgets are estimates from published prices, so your bill can be higher. Providers change their prices, so check the prices in Settings against your provider's price page.
- JobPilot stops making paid calls when its estimate reaches your daily or monthly budget. A call that is already running can go a little over. A budget of 0 means no limit, and free and local providers don't count toward budgets.
- Set a spend limit with your provider too.

Each provider below has a price page and a place to check usage or set a limit.

- **Groq.** [Prices](https://groq.com/pricing) and [limits](https://console.groq.com/settings/limits). On a paid Groq plan, you can set a spend limit under Settings, Billing, Limits in the Groq console.
- **OpenRouter.** [Prices](https://openrouter.ai/models) and [keys](https://openrouter.ai/settings/keys). OpenRouter bills from credits you buy ahead, and you can set a credit limit on the key so it can't spend more than you choose.
- **Anthropic.** [Prices](https://platform.claude.com/docs/en/about-claude/pricing) and [limits](https://platform.claude.com/settings/limits). Set a monthly spend limit on the Limits page of the Claude Console.
- **OpenAI.** [Prices](https://platform.openai.com/docs/pricing) and [billing](https://platform.openai.com/settings/organization/billing/overview). OpenAI bills from credits you buy ahead. Auto recharge is on by default, so turn it off if you don't want OpenAI to buy more credits on its own.
- **Google Gemini with billing turned on.** [Prices](https://ai.google.dev/gemini-api/docs/pricing) and [spend](https://aistudio.google.com/spend). Set a monthly spend cap on the Spend page in AI Studio. Google says spending can run past the cap for about 10 minutes.

The Gemini free tier has a [price page](https://ai.google.dev/gemini-api/docs/pricing) and a [usage page](https://aistudio.google.com/usage), and Mistral has a [price page](https://mistral.ai/pricing).

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

[docs/RELEASING.md](docs/RELEASING.md) covers publishing a build so installed copies can update.

### Try it without a key

Demo mode runs the interface with sample data in a normal browser. It doesn't open the app or touch your real data.

```bash
npm run demo
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

## Updates

Installed copies of JobPilot look for new versions on GitHub. They check about 10 seconds after the app opens and then every 4 hours, while "Check for updates automatically" is on in Settings, Updates. A check you start yourself works either way.

- **Windows and the Linux AppImage.** A new version downloads in the background and installs the next time JobPilot closes. The top bar shows "Restart to update" if you would rather install it right away. JobPilot saves your work, closes, installs and opens again.
- **macOS.** The app isn't signed yet, and macOS won't install unsigned updates. JobPilot shows "Update available" instead, which opens the download page, and you install the new version yourself.
- **Development builds and other Linux installs.** These can't update themselves. Settings, Updates says so and links to the download page when there is one.

Updates keep your data. Your jobs, profile, settings and API keys stay where they are. [Privacy](#privacy) says what a check sends.

## Your data

Everything lives in one SQLite file in the app's data folder, along with copies of your uploads, cover letter PDFs and submission screenshots. Settings has an export of everything except your API keys. [Privacy](#privacy) lists what leaves your computer.

## Privacy

JobPilot has no account, server or tracking of its own. It doesn't send telemetry or crash reports. The list below covers everything that leaves your computer.

- **Your AI provider.** Each AI call goes straight to the provider you chose, with your key. Depending on the step, it can include the job posting, your profile, the text of your resume, your notes, your writing samples and the questions on an application form. With Ollama or LM Studio on this computer, none of it leaves. Read your provider's data policy, because a free tier may use what you send to train its models.
- **Job sources.** To find jobs, JobPilot asks the public job APIs you turned on for postings, and sends the company names, search words and places you set up. It identifies itself as JobPilot in the request. For Adzuna it sends your own Adzuna app ID and key.
- **Pages you give it.** When you paste a job link or add a portfolio link, JobPilot loads that page to read its text.
- **Update checks.** JobPilot asks GitHub whether a newer version exists, and on Windows and Linux downloads it if there is one. GitHub sees your IP address and the version you run, as with any download. No account or personal data is sent. You can turn automatic checks off under Settings, Updates.
- **Employers.** To read or fill an application, JobPilot opens the form in your own Chrome or Edge, like a visit you made yourself. For Greenhouse jobs it can read the form from Greenhouse's public API first. What you fill in goes to the employer only when you submit, or when auto-submit does it for you.

Links in the app open in your default browser, and only when you click them.

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
- Free tiers change their limits often. The limits in each free preset are cautious starting points, and you can change them in Settings.

## Disclaimer

JobPilot is provided as is, without warranty. You're responsible for charges from your AI providers, for everything sent to employers in your name, and for following the terms of the job sites and AI providers you use. JobPilot isn't affiliated with any AI provider or job board. Their names are trademarks of their owners.
