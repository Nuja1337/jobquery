// Sample data for demo mode (the Vite dev server opened in a normal browser).
// None of this is real. Companies and people are made up.

import { DEFAULT_SETTINGS } from '@shared/defaults'
import type {
  AnalyticsReport,
  AnswerBankEntry,
  Application,
  ApplicationOutcome,
  ApplicationStatus,
  Company,
  DocumentRecord,
  EventRecord,
  FitAssessment,
  FitBucket,
  FormField,
  Job,
  LintReport,
  PreferenceSuggestion,
  PreparedAnswer,
  Profile,
  ProviderInfo,
  RunRecord,
  SavedSearch,
  Settings,
  SourceKind
} from '@shared/types'

const MIN = 60_000
const HOUR = 60 * MIN
const DAY = 24 * HOUR

export const iso = (msAgo: number): string => new Date(Date.now() - msAgo).toISOString()

/** Small deterministic generator so charts look the same on every reload. */
export function seeded(seed: number): () => number {
  let s = seed >>> 0
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0
    return s / 4294967296
  }
}

export const DEMO_PROVIDER_ID = 'prov_demo'

export function initialProviders(): ProviderInfo[] {
  return [
    { id: DEMO_PROVIDER_ID, kind: 'anthropic', label: 'Claude', baseUrl: null, hasKey: true, createdAt: iso(40 * DAY) },
    { id: 'prov_local', kind: 'ollama', label: 'Local Ollama', baseUrl: 'http://localhost:11434/v1', hasKey: false, createdAt: iso(12 * DAY) }
  ]
}

export function initialSettings(onboardingDone: boolean): Settings {
  const s: Settings = structuredClone(DEFAULT_SETTINGS)
  s.onboardingDone = onboardingDone
  if (onboardingDone) {
    s.routing = {
      triage: { providerId: DEMO_PROVIDER_ID, model: 'claude-haiku-5-5' },
      writing: { providerId: DEMO_PROVIDER_ID, model: 'claude-sonnet-5-5' },
      extraction: { providerId: DEMO_PROVIDER_ID, model: 'claude-haiku-5-5' }
    }
    s.preferences = {
      ...s.preferences,
      targetTitles: ['Senior Frontend Engineer', 'Full-Stack Engineer', 'Product Engineer'],
      includeKeywords: ['react', 'typescript', 'design systems'],
      excludeTitleKeywords: ['intern', 'junior'],
      excludeDescriptionKeywords: ['security clearance'],
      locations: ['Berlin', 'Remote (EU)'],
      remote: ['remote', 'hybrid'],
      seniority: ['senior', 'staff'],
      minSalary: 90000,
      salaryCurrency: 'USD',
      excludedCompanies: ['Acme Staffing'],
      maxPostingAgeDays: 30
    }
    s.autopilot = { ...s.autopilot, enabled: true, intervalHours: 6, autoPrepare: true }
    s.writing = { ...s.writing, bannedPhrases: ['rockstar', 'wear many hats'], styleNotes: 'Dry humor is fine. No exclamation marks.' }
  }
  return s
}

// ---------------------------------------------------------------------------
// Profile and documents
// ---------------------------------------------------------------------------

export function demoProfile(): Profile {
  return {
    fullName: 'Alex Rivera',
    email: 'alex.rivera@example.com',
    phone: '+49 151 5550 0142',
    location: 'Berlin, Germany',
    links: {
      linkedin: 'https://linkedin.com/in/alexrivera-demo',
      github: 'https://github.com/alexrivera-demo',
      portfolio: 'https://alexrivera.example.com',
      website: '',
      other: []
    },
    headline: 'Frontend engineer who builds design systems and data-heavy interfaces',
    summary:
      'Eight years building web apps in React and TypeScript. I have led the frontend for two small product teams and I like the part of the job where design and code meet.',
    yearsExperience: 8,
    workAuthorization: { authorizedCountries: ['Germany', 'Spain'], needsSponsorship: false, notes: 'EU citizen.' },
    experience: [
      {
        company: 'Fieldstone Analytics',
        title: 'Senior Frontend Engineer',
        location: 'Berlin',
        start: '2021-03',
        end: 'present',
        highlights: [
          'Rebuilt the dashboard in React and TypeScript, which cut load time from 6s to 1.8s.',
          'Created a shared component library used by four teams.',
          'Mentored three engineers, two of whom were promoted.'
        ]
      },
      {
        company: 'Pixelbarn',
        title: 'Frontend Engineer',
        location: 'Remote',
        start: '2018-02',
        end: '2021-02',
        highlights: ['Shipped a checkout flow that lifted conversion by 9 percent.', 'Moved the codebase from JavaScript to TypeScript.']
      }
    ],
    education: [{ school: 'Universidad de Sevilla', degree: 'BSc', field: 'Computer Science', start: '2012', end: '2016' }],
    skills: ['React', 'TypeScript', 'Node.js', 'GraphQL', 'Design systems', 'Accessibility', 'Playwright', 'PostgreSQL'],
    certifications: ['AWS Cloud Practitioner'],
    languages: ['English (fluent)', 'Spanish (native)', 'German (B1)'],
    projects: [
      {
        name: 'Tablecloth',
        description: 'Open source data grid for React with virtual scrolling.',
        url: 'https://github.com/alexrivera-demo/tablecloth',
        highlights: ['1.2k GitHub stars', 'Used in two production apps I know of']
      }
    ],
    facts: [
      { question: 'What is your notice period?', answer: 'Four weeks.' },
      { question: 'What are your salary expectations?', answer: 'Between 95,000 and 110,000 EUR, depending on scope.' }
    ],
    notesForAi: 'Do not mention my current employer by name in cover letters. Stress design systems work and mentoring.',
    voice: {
      summary:
        'Plain and direct. Short sentences mixed with a few longer ones. Uses concrete numbers and rarely uses adjectives. Occasional dry humor.',
      formality: 'neutral',
      avgSentenceWords: 14,
      traits: ['concrete numbers', 'first person', 'dry humor', 'no filler'],
      signaturePhrases: ['which cut load time', 'I like the part where', 'worth a conversation'],
      avoid: ['exclamation marks', 'passionate', 'thrilled', 'leverage'],
      builtFrom: ['doc_sample1', 'doc_sample2'],
      builtAt: iso(9 * DAY)
    }
  }
}

export function initialDocuments(): Array<DocumentRecord & { text: string }> {
  const resumeText = `Alex Rivera\nBerlin, Germany\n\nSenior Frontend Engineer, Fieldstone Analytics (2021 to present)\n- Rebuilt the dashboard in React and TypeScript, cutting load time from 6s to 1.8s.\n- Created a shared component library used by four teams.\n\nFrontend Engineer, Pixelbarn (2018 to 2021)\n- Shipped a checkout flow that lifted conversion by 9 percent.\n\nSkills: React, TypeScript, Node.js, GraphQL, Accessibility`
  return [
    { id: 'doc_resume1', kind: 'resume', name: 'Alex_Rivera_Resume_2026.pdf', filePath: 'C:\\Users\\Demo\\Documents\\Alex_Rivera_Resume_2026.pdf', mime: 'application/pdf', url: null, textPreview: resumeText.slice(0, 240), textLength: resumeText.length, isPrimary: true, createdAt: iso(40 * DAY), text: resumeText },
    { id: 'doc_resume2', kind: 'resume', name: 'Alex_Rivera_Resume_Design_Systems.docx', filePath: 'C:\\Users\\Demo\\Documents\\Alex_Rivera_Resume_Design_Systems.docx', mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', url: null, textPreview: 'Alex Rivera. Design systems focus.', textLength: 1840, isPrimary: false, createdAt: iso(22 * DAY), text: 'Alex Rivera. Design systems focus. (Demo text.)' },
    { id: 'doc_sample1', kind: 'writing_sample', name: 'Blog post: why we dropped CSS-in-JS.md', filePath: 'C:\\Users\\Demo\\Documents\\css-in-js.md', mime: 'text/markdown', url: null, textPreview: 'We moved off CSS-in-JS last spring. It took two sprints and removed 40 kB from the bundle.', textLength: 5210, isPrimary: false, createdAt: iso(30 * DAY), text: 'We moved off CSS-in-JS last spring. It took two sprints and removed 40 kB from the bundle. (Demo text.)' },
    { id: 'doc_sample2', kind: 'writing_sample', name: 'Email to the team about the migration.txt', filePath: 'C:\\Users\\Demo\\Documents\\migration-email.txt', mime: 'text/plain', url: null, textPreview: 'Short version: the migration is done. Longer version below.', textLength: 1320, isPrimary: false, createdAt: iso(30 * DAY), text: 'Short version: the migration is done. Longer version below. (Demo text.)' },
    { id: 'doc_cl1', kind: 'cover_letter_sample', name: 'Cover letter for Pixelbarn.docx', filePath: 'C:\\Users\\Demo\\Documents\\cl-pixelbarn.docx', mime: null, url: null, textPreview: 'Hello, I read your post about the checkout rebuild and had a few thoughts.', textLength: 1710, isPrimary: false, createdAt: iso(30 * DAY), text: 'Hello, I read your post about the checkout rebuild and had a few thoughts. (Demo text.)' },
    { id: 'doc_port1', kind: 'portfolio', name: 'alexrivera.example.com', filePath: null, mime: null, url: 'https://alexrivera.example.com', textPreview: 'Portfolio: Tablecloth, a data grid for React.', textLength: 980, isPrimary: false, createdAt: iso(30 * DAY), text: 'Portfolio: Tablecloth, a data grid for React. (Demo text.)' }
  ]
}

export function initialBank(): AnswerBankEntry[] {
  return [
    { id: 'ans1', question: 'Are you legally authorized to work in the EU?', answer: 'Yes. I am an EU citizen and need no sponsorship.', kind: 'fact', timesUsed: 14, updatedAt: iso(20 * DAY) },
    { id: 'ans2', question: 'What is your notice period?', answer: 'Four weeks.', kind: 'fact', timesUsed: 9, updatedAt: iso(20 * DAY) },
    { id: 'ans3', question: 'Why do you want to work here?', answer: 'Start with one specific thing the company ships that I have used or read about, then connect it to a project of mine with a number attached. Keep it to three sentences.', kind: 'template', timesUsed: 6, updatedAt: iso(6 * DAY) }
  ]
}

export function initialCompanies(): Company[] {
  const c = (name: string, ats: Company['ats'], token: string | null, url: string, watch = true, blocked = false): Company => ({
    id: `co_${name.toLowerCase().replace(/\W+/g, '')}`,
    name,
    ats,
    atsToken: token,
    careersUrl: url,
    watch,
    blocked,
    notes: '',
    createdAt: iso(20 * DAY)
  })
  return [
    c('Northwind Labs', 'greenhouse', 'northwindlabs', 'https://boards.greenhouse.io/northwindlabs'),
    c('Fieldnote', 'ashby', 'fieldnote', 'https://jobs.ashbyhq.com/fieldnote'),
    c('Kestrel Data', 'lever', 'kestrel', 'https://jobs.lever.co/kestrel'),
    c('Orbital Freight', 'greenhouse', 'orbitalfreight', 'https://boards.greenhouse.io/orbitalfreight', false),
    c('Acme Staffing', 'unknown', null, 'https://acmestaffing.example.com/careers', false, true)
  ]
}

export function initialSearches(): SavedSearch[] {
  return [
    { id: 'ss1', source: 'remotive', label: 'Remotive: software dev', params: { category: 'software-dev', search: 'frontend' }, enabled: true, lastRunAt: iso(3 * HOUR) },
    { id: 'ss2', source: 'remoteok', label: 'RemoteOK: react', params: { tag: 'react' }, enabled: true, lastRunAt: iso(3 * HOUR) },
    { id: 'ss3', source: 'hn_whoishiring', label: 'HN Who is Hiring', params: { query: 'typescript' }, enabled: false, lastRunAt: iso(9 * DAY) },
    { id: 'ss4', source: 'adzuna', label: 'Adzuna: Berlin frontend', params: { app_id: 'demo-app-id', app_key: 'demo-app-key', country: 'de', what: 'frontend engineer', where: 'Berlin' }, enabled: true, lastRunAt: iso(5 * HOUR) }
  ]
}

// ---------------------------------------------------------------------------
// Jobs
// ---------------------------------------------------------------------------

function bucketOf(score: number): FitBucket {
  if (score >= 85) return 'perfect'
  if (score >= 70) return 'great'
  if (score >= 60) return 'good'
  return 'weak'
}

export function makeFit(score: number, summary: string, matches: string[], gaps: string[], dealbreakers: string[], keywords: string[]): FitAssessment {
  return { score, bucket: bucketOf(score), summary, matches, gaps, dealbreakers, seniorityFit: score > 50 ? 'match' : 'over', keywords }
}

interface JobSeed {
  n: number
  company: string
  title: string
  location: string | null
  remote: Job['remote']
  salary?: [number, number, string?]
  source: SourceKind
  ats?: Job['ats']
  posted: number
  discovered: number
  stage: Job['stage']
  prescore: number | null
  fit?: FitAssessment
  filterReason?: string
  starred?: boolean
  dismiss?: { reason: string | null; tags: string[] }
  desc?: string
}

const DESC = (title: string, company: string, extra: string): string =>
  `${company} is hiring a ${title}.\n\nAbout the role\nYou will work with a small product team to ship features end to end. ${extra}\n\nWhat we are looking for\n- 5+ years of professional experience\n- Strong TypeScript and React\n- Comfort working with designers and product managers\n- Clear written communication\n\nNice to have\n- Experience with design systems\n- Experience with data-heavy interfaces\n\nWhat we offer\n- Remote-friendly team across Europe\n- Equity and a learning budget\n- 28 days of paid leave\n`

const SEEDS: JobSeed[] = [
  {
    n: 1, company: 'Northwind Labs', title: 'Senior Frontend Engineer', location: 'Remote (EU)', remote: 'remote', salary: [110000, 140000], source: 'greenhouse', ats: 'greenhouse',
    posted: 2 * DAY, discovered: 20 * HOUR, stage: 'ready', prescore: 82, starred: true,
    fit: makeFit(92, 'Your design systems and TypeScript background lines up with almost every requirement. The team size and remote setup match what you asked for.',
      ['8 years of React and TypeScript', 'Built a shared component library', 'Mentoring experience', 'Remote within the EU'], ['No mention of GraphQL subscriptions'], [], ['design systems', 'TypeScript', 'accessibility', 'component library']),
    desc: DESC('Senior Frontend Engineer', 'Northwind Labs', 'You will own the design system and lead frontend work on the analytics product.')
  },
  {
    n: 2, company: 'Lumen Health', title: 'Staff Software Engineer, Platform', location: 'Berlin, Germany (hybrid)', remote: 'hybrid', salary: [125000, 155000, 'EUR'], source: 'ashby', ats: 'ashby',
    posted: 3 * DAY, discovered: 26 * HOUR, stage: 'ready', prescore: 74,
    fit: makeFit(88, 'Strong match on seniority and location. The platform scope is wider than your recent work, mainly on the backend side.',
      ['Based in Berlin', 'Staff-level scope with mentoring', 'TypeScript across the stack'], ['Kubernetes experience', 'On-call rotation'], [], ['platform', 'TypeScript', 'GDPR', 'mentoring'])
  },
  {
    n: 3, company: 'Orbital Freight', title: 'Full-Stack Engineer', location: 'Remote', remote: 'remote', salary: [95000, 120000], source: 'greenhouse', ats: 'greenhouse',
    posted: 4 * DAY, discovered: 2 * DAY, stage: 'shortlisted', prescore: 69, starred: true,
    fit: makeFit(79, 'Good overlap on the frontend and Node.js. The role leans backend more than you prefer.', ['Node.js and PostgreSQL', 'React frontend work', 'Remote'], ['Logistics domain', 'Go services'], [], ['Node.js', 'PostgreSQL', 'logistics'])
  },
  {
    n: 4, company: 'Fieldnote', title: 'Senior Product Engineer', location: 'Remote (Europe)', remote: 'remote', salary: [100000, 130000], source: 'ashby', ats: 'ashby',
    posted: 5 * DAY, discovered: 2 * DAY, stage: 'shortlisted', prescore: 77,
    fit: makeFit(76, 'The product-engineer scope fits. Pay is at the low end of what you want.', ['Product ownership', 'React and TypeScript', 'Small team'], ['Rust in the sync engine'], [], ['product engineer', 'React', 'local-first'])
  },
  {
    n: 5, company: 'Kestrel Data', title: 'Data Platform Engineer', location: 'Remote (EU)', remote: 'remote', salary: [105000, 135000], source: 'lever', ats: 'lever',
    posted: 6 * DAY, discovered: 3 * DAY, stage: 'shortlisted', prescore: 55,
    fit: makeFit(71, 'Your frontend background helps on the internal tools part. Most of the role is pipelines and warehouses.', ['TypeScript', 'GraphQL'], ['Airflow', 'dbt', 'Snowflake'], [], ['data platform', 'Airflow', 'dbt'])
  },
  {
    n: 6, company: 'Paperplane', title: 'Frontend Engineer', location: 'Austin, TX (onsite)', remote: 'onsite', salary: [115000, 135000], source: 'remotive', posted: 8 * DAY, discovered: 3 * DAY, stage: 'shortlisted', prescore: 61,
    fit: makeFit(64, 'The role matches your skills. It is onsite in Austin, which does not match your location setting.', ['React', 'TypeScript'], ['Onsite five days a week', 'US work authorization'], ['Requires US work authorization'], ['React', 'onsite'])
  },
  {
    n: 7, company: 'Brightloop', title: 'Engineering Manager, Growth', location: 'Remote', remote: 'remote', salary: [130000, 160000], source: 'remoteok', posted: 9 * DAY, discovered: 4 * DAY, stage: 'shortlisted', prescore: 58,
    fit: makeFit(62, 'You have mentoring experience, but not direct management of a team of eight.', ['Mentoring', 'Growth experiments'], ['Direct reports', 'Hiring experience'], [], ['engineering manager', 'growth'])
  },
  {
    n: 8, company: 'Tidewater Systems', title: 'Backend Engineer (Go)', location: 'Remote (US)', remote: 'remote', salary: [120000, 150000], source: 'greenhouse', ats: 'greenhouse', posted: 12 * DAY, discovered: 4 * DAY, stage: 'scored', prescore: 40,
    fit: makeFit(41, 'Almost all of the role is Go and distributed systems. Little overlap with your frontend work.', ['Backend interest'], ['Go', 'Distributed systems', 'Kafka'], ['US only'], ['Go', 'Kafka'])
  },
  {
    n: 9, company: 'Halcyon', title: 'Principal Engineer', location: 'Remote', remote: 'remote', salary: [180000, 220000], source: 'lever', ats: 'lever', posted: 14 * DAY, discovered: 5 * DAY, stage: 'scored', prescore: 36,
    fit: makeFit(38, 'The role asks for 12+ years and company-wide architecture ownership. That is above your level today.', ['TypeScript'], ['12+ years', 'Architecture ownership across 40 engineers'], [], ['principal', 'architecture'])
  },
  {
    n: 10, company: 'Mosaic Pay', title: 'Senior Engineer, Payments', location: 'London, UK', remote: 'hybrid', salary: [70000, 85000, 'GBP'], source: 'greenhouse', ats: 'greenhouse', posted: 10 * DAY, discovered: 5 * DAY, stage: 'filtered_out', prescore: null,
    filterReason: 'Listed maximum salary is below your minimum of $90,000.'
  },
  {
    n: 11, company: 'Quarry', title: 'Junior Web Developer', location: 'Remote', remote: 'remote', source: 'arbeitnow', posted: 3 * DAY, discovered: 2 * DAY, stage: 'filtered_out', prescore: null,
    filterReason: 'Title contains "junior", which you excluded.'
  },
  {
    n: 12, company: 'Cobalt Retail', title: 'Senior React Developer', location: 'Madrid, Spain', remote: 'hybrid', salary: [60000, 78000, 'EUR'], source: 'adzuna', posted: 4 * DAY, discovered: 2 * DAY, stage: 'prescored_out', prescore: 9,
    filterReason: 'Keyword overlap 9 is below your minimum of 15.'
  },
  {
    n: 13, company: 'Juniper AI', title: 'Frontend Engineer, Product', location: 'Remote (EU)', remote: 'remote', salary: [95000, 120000], source: 'greenhouse', ats: 'greenhouse', posted: 1 * DAY, discovered: 5 * HOUR, stage: 'new', prescore: 71,
    desc: DESC('Frontend Engineer, Product', 'Juniper AI', 'You will build the interface for an AI research assistant.')
  },
  {
    n: 14, company: 'Ember & Oak', title: 'Senior Software Engineer', location: 'Berlin', remote: 'onsite', source: 'adzuna', posted: 2 * DAY, discovered: 5 * HOUR, stage: 'new', prescore: 48
  },
  {
    n: 15, company: 'Dovetail Works', title: 'Senior Software Engineer', location: 'Remote', remote: 'remote', salary: [70000, 80000], source: 'remotive', posted: 15 * DAY, discovered: 6 * DAY, stage: 'dismissed', prescore: 52,
    fit: makeFit(66, 'Fits your skills, pay is below your minimum.', ['React'], ['Pay'], [], ['React']), dismiss: { reason: 'Pay is too low for the scope.', tags: ['pay too low'] }
  },
  {
    n: 16, company: 'Ironbark', title: 'Frontend Engineer', location: 'Remote (EU)', remote: 'remote', salary: [90000, 110000], source: 'greenhouse', ats: 'greenhouse', posted: 25 * DAY, discovered: 16 * DAY, stage: 'applied', prescore: 70,
    fit: makeFit(81, 'Strong match on React and TypeScript.', ['React', 'TypeScript', 'Remote'], ['Storybook experience'], [], ['React', 'TypeScript'])
  },
  {
    n: 17, company: 'Sable Studio', title: 'Senior Frontend Engineer', location: 'Lisbon, Portugal', remote: 'hybrid', salary: [85000, 105000, 'EUR'], source: 'lever', ats: 'lever', posted: 22 * DAY, discovered: 14 * DAY, stage: 'applied', prescore: 66,
    fit: makeFit(74, 'Good fit. Lisbon is a move but remote days are flexible.', ['React', 'Design systems'], ['Relocation'], [], ['design systems'])
  },
  {
    n: 18, company: 'Meridian', title: 'Full-Stack Engineer', location: 'Remote', remote: 'remote', salary: [100000, 125000], source: 'remoteok', posted: 26 * DAY, discovered: 18 * DAY, stage: 'applied', prescore: 64,
    fit: makeFit(72, 'Matches the stack and the pay range.', ['Node.js', 'React'], ['Ruby experience'], [], ['Node.js'])
  },
  {
    n: 19, company: 'Pinecrest', title: 'Software Engineer, Web', location: 'Remote (EU)', remote: 'remote', salary: [92000, 112000], source: 'ashby', ats: 'ashby', posted: 20 * DAY, discovered: 12 * DAY, stage: 'applied', prescore: 71,
    fit: makeFit(83, 'Strong match.', ['React', 'TypeScript', 'Accessibility'], [], [], ['accessibility'])
  },
  {
    n: 20, company: 'Alder & Co', title: 'Senior Engineer', location: 'Remote', remote: 'remote', salary: [105000, 130000], source: 'greenhouse', ats: 'greenhouse', posted: 33 * DAY, discovered: 24 * DAY, stage: 'applied', prescore: 60,
    fit: makeFit(69, 'Good fit on skills.', ['TypeScript'], ['Domain: insurance'], [], ['TypeScript'])
  },
  {
    n: 21, company: 'Foxglove', title: 'Lead Frontend Engineer', location: 'Berlin', remote: 'hybrid', salary: [115000, 140000, 'EUR'], source: 'ashby', ats: 'ashby', posted: 30 * DAY, discovered: 22 * DAY, stage: 'applied', prescore: 78,
    fit: makeFit(90, 'Close to a perfect match: lead scope, Berlin, design systems.', ['Berlin', 'Design systems', 'Leading a small team'], [], [], ['design systems', 'lead'])
  }
]

export function initialJobs(): Job[] {
  return SEEDS.map((s) => {
    const fit = s.fit ?? null
    const id = `job_${s.n}`
    const job: Job = {
      id,
      source: s.source,
      company: s.company,
      title: s.title,
      location: s.location,
      remote: s.remote,
      salaryMin: s.salary?.[0] ?? null,
      salaryMax: s.salary?.[1] ?? null,
      salaryCurrency: s.salary ? (s.salary[2] ?? 'USD') : null,
      url: `https://jobs.example.com/${s.company.toLowerCase().replace(/\W+/g, '-')}/${s.n}`,
      ats: s.ats ?? 'unknown',
      postedAt: iso(s.posted),
      discoveredAt: iso(s.discovered),
      stage: s.stage,
      filterReason: s.filterReason ?? null,
      prescore: s.prescore,
      fitScore: fit?.score ?? null,
      fitBucket: fit?.bucket ?? null,
      fitSummary: fit?.summary ?? null,
      starred: s.starred ?? false,
      applicationId: null,
      externalId: `ext-${s.n}`,
      applyUrl: `https://jobs.example.com/${s.company.toLowerCase().replace(/\W+/g, '-')}/${s.n}/apply`,
      description: s.desc ?? DESC(s.title, s.company, 'Details are in the posting.'),
      employmentType: 'Full-time',
      fit,
      dismissReason: s.dismiss?.reason ?? null,
      dismissTags: s.dismiss?.tags ?? [],
      dupOf: null,
      updatedAt: iso(s.discovered)
    }
    return job
  })
}

// ---------------------------------------------------------------------------
// Applications
// ---------------------------------------------------------------------------

export function emptyLint(): LintReport {
  return { score: 100, issues: [], stats: { words: 0, sentences: 0, avgSentenceWords: 0, sentenceLengthStdDev: 0, paragraphs: 0 } }
}

const COVER_LETTER = (company: string, role: string): string =>
  `Hello ${company} team,\n\nI read the posting for the ${role} role and it reads like a description of the last three years of my work. At Fieldstone Analytics I rebuilt our dashboard in React and TypeScript, which cut load time from six seconds to under two. I also built the component library that four teams now share.\n\nWhat I would bring to ${company} is the habit of treating design and code as one conversation. I like sitting with a designer on Monday and shipping the result on Friday. I have also mentored three engineers, and two of them were promoted last year.\n\nI would be glad to talk about how I could help. My resume is attached and my portfolio is at alexrivera.example.com.\n\nBest,\nAlex`

const FLAWED_LETTER = (company: string, role: string): string =>
  `Dear Hiring Manager,\n\nI am thrilled to apply for the ${role} position at ${company}! I am passionate about leveraging cutting-edge technology to build seamless user experiences — and I believe my journey makes me a perfect fit.\n\nIn today's fast-paced world, I am not just a developer, but a problem solver who delves into every challenge. I would love to bring my skills to your team.\n\nSincerely,\nAlex Rivera`

export const FIELDS: FormField[] = [
  { key: 'first_name', label: 'First name', type: 'text', required: true, options: [], placeholder: null, maxLength: null, fileHint: null },
  { key: 'email', label: 'Email', type: 'email', required: true, options: [], placeholder: null, maxLength: null, fileHint: null },
  { key: 'phone', label: 'Phone', type: 'tel', required: false, options: [], placeholder: null, maxLength: null, fileHint: null },
  { key: 'linkedin', label: 'LinkedIn profile', type: 'url', required: false, options: [], placeholder: null, maxLength: null, fileHint: null },
  { key: 'resume', label: 'Resume', type: 'file', required: true, options: [], placeholder: null, maxLength: null, fileHint: 'resume' },
  { key: 'work_auth', label: 'Are you legally authorized to work in the country this role is based in?', type: 'radio', required: true, options: ['Yes', 'No'], placeholder: null, maxLength: null, fileHint: null },
  { key: 'why_us', label: 'Why do you want to work here?', type: 'textarea', required: true, options: [], placeholder: null, maxLength: 800, fileHint: null },
  { key: 'salary', label: 'What are your salary expectations?', type: 'text', required: true, options: [], placeholder: null, maxLength: null, fileHint: null },
  { key: 'source', label: 'How did you hear about us?', type: 'select', required: false, options: ['Job board', 'Referral', 'Company website', 'Social media', 'Other'], placeholder: null, maxLength: null, fileHint: null },
  { key: 'skills', label: 'Which of these have you used in production?', type: 'checkboxes', required: false, options: ['React', 'TypeScript', 'GraphQL', 'Go', 'Rust', 'Kubernetes'], placeholder: null, maxLength: null, fileHint: null },
  { key: 'start_date', label: 'Earliest start date', type: 'date', required: false, options: [], placeholder: null, maxLength: null, fileHint: null },
  { key: 'gender', label: 'Gender (voluntary)', type: 'select', required: false, options: ['Woman', 'Man', 'Non-binary', 'Decline to self-identify'], placeholder: null, maxLength: null, fileHint: null },
  { key: 'privacy', label: 'I agree to the privacy policy', type: 'checkbox', required: true, options: [], placeholder: null, maxLength: null, fileHint: null }
]

export function makeAnswers(variant: 'clean' | 'flagged' | 'two_flags', company: string): PreparedAnswer[] {
  const base = (f: FormField, value: string, source: PreparedAnswer['source'], confidence: number, extra: Partial<PreparedAnswer> = {}): PreparedAnswer => ({
    fieldKey: f.key, label: f.label, type: f.type, required: f.required, options: f.options, value, source, confidence, needsUser: false, note: null, lint: null, ...extra
  })
  const F = (key: string): FormField => FIELDS.find((f) => f.key === key) as FormField
  return [
    base(F('first_name'), 'Alex', 'profile', 1),
    base(F('email'), 'alex.rivera@example.com', 'profile', 1),
    base(F('phone'), '+49 151 5550 0142', 'profile', 1),
    base(F('linkedin'), 'https://linkedin.com/in/alexrivera-demo', 'profile', 1),
    base(F('resume'), 'C:\\Users\\Demo\\Documents\\Alex_Rivera_Resume_2026.pdf', 'file', 1),
    base(F('work_auth'), 'Yes', 'answer_bank', 0.95),
    base(F('why_us'), `${company} builds the tools I would want to use myself. I have spent three years on dashboards and a shared component library, and this role looks like the same problem at a larger scale.`, 'ai', 0.78, {
      lint: { score: 91, issues: [{ rule: 'sentence-length', severity: 'low', message: 'Both sentences are about the same length.', match: null, index: null, suggestion: 'Add one short sentence.' }], stats: { words: 38, sentences: 2, avgSentenceWords: 19, sentenceLengthStdDev: 1.5, paragraphs: 1 } }
    }),
    variant === 'clean'
      ? base(F('salary'), 'Between 95,000 and 110,000 EUR, depending on scope.', 'answer_bank', 0.9)
      : base(F('salary'), '', 'ai', 0.2, { needsUser: true, note: 'Your saved salary range is in EUR and this posting lists USD. Check the number before submitting.' }),
    base(F('source'), 'Job board', 'ai', 0.6),
    base(F('skills'), JSON.stringify(['React', 'TypeScript', 'GraphQL']), 'profile', 0.9),
    variant === 'two_flags'
      ? base(F('start_date'), '', 'ai', 0.1, { needsUser: true, note: 'Your notice period is four weeks, but I cannot pick a date for you.' })
      : base(F('start_date'), '', 'ai', 0.5),
    base(F('gender'), 'Decline to self-identify', 'settings', 1),
    base(F('privacy'), 'true', 'settings', 1)
  ]
}

interface AppSeed {
  id: string
  jobId: string
  status: ApplicationStatus
  outcome: ApplicationOutcome
  mode: Application['submitMode']
  variant: 'clean' | 'flagged' | 'two_flags'
  letter: 'good' | 'flawed'
  submittedDaysAgo?: number
  outcomeDaysAgo?: number
  notes?: string
}

export const APP_SEEDS: AppSeed[] = [
  { id: 'app_1', jobId: 'job_1', status: 'ready', outcome: 'none', mode: null, variant: 'clean', letter: 'good' },
  { id: 'app_2', jobId: 'job_2', status: 'needs_attention', outcome: 'none', mode: null, variant: 'flagged', letter: 'flawed' },
  { id: 'app_3', jobId: 'job_16', status: 'submitted', outcome: 'interview', mode: 'assist', variant: 'clean', letter: 'good', submittedDaysAgo: 12, outcomeDaysAgo: 5, notes: 'Phone screen done. Technical interview on Thursday.' },
  { id: 'app_4', jobId: 'job_17', status: 'submitted', outcome: 'none', mode: 'auto', variant: 'clean', letter: 'good', submittedDaysAgo: 2 },
  { id: 'app_5', jobId: 'job_18', status: 'submitted', outcome: 'rejected', mode: 'assist', variant: 'clean', letter: 'good', submittedDaysAgo: 14, outcomeDaysAgo: 8 },
  { id: 'app_6', jobId: 'job_19', status: 'submitted', outcome: 'screen', mode: 'manual', variant: 'clean', letter: 'good', submittedDaysAgo: 5, outcomeDaysAgo: 1 },
  { id: 'app_7', jobId: 'job_20', status: 'submitted', outcome: 'ghosted', mode: 'auto', variant: 'clean', letter: 'good', submittedDaysAgo: 20 },
  { id: 'app_8', jobId: 'job_21', status: 'submitted', outcome: 'offer', mode: 'assist', variant: 'clean', letter: 'good', submittedDaysAgo: 18, outcomeDaysAgo: 2, notes: 'Offer: 128k EUR. Reply by Friday.' }
]

export function initialApplications(jobs: Job[]): Application[] {
  return APP_SEEDS.map((s) => {
    const job = jobs.find((j) => j.id === s.jobId) as Job
    job.applicationId = s.id
    const answers = makeAnswers(s.variant, job.company)
    const letter = s.letter === 'good' ? COVER_LETTER(job.company, job.title) : FLAWED_LETTER(job.company, job.title)
    return {
      id: s.id,
      jobId: s.jobId,
      company: job.company,
      title: job.title,
      fitScore: job.fitScore,
      fitBucket: job.fitBucket,
      status: s.status,
      outcome: s.outcome,
      submitMode: s.mode,
      flaggedCount: answers.filter((a) => a.needsUser).length,
      guessCount: 0,
      submittedAt: s.submittedDaysAgo != null ? iso(s.submittedDaysAgo * DAY) : null,
      outcomeAt: s.outcomeDaysAgo != null ? iso(s.outcomeDaysAgo * DAY) : null,
      createdAt: iso((s.submittedDaysAgo ?? 1) * DAY + 3 * HOUR),
      updatedAt: iso((s.outcomeDaysAgo ?? s.submittedDaysAgo ?? 0) * DAY),
      coverLetter: letter,
      coverLetterLint: s.letter === 'good' ? { score: 94, issues: [], stats: { words: 118, sentences: 8, avgSentenceWords: 14.8, sentenceLengthStdDev: 5.2, paragraphs: 4 } } : flawedLint(),
      answers,
      formFields: FIELDS,
      resumeDocId: 'doc_resume1',
      confirmation: s.status === 'submitted' ? 'Thanks for applying. We will be in touch.' : null,
      screenshotPath: s.status === 'submitted' ? `C:\\Users\\Demo\\AppData\\Roaming\\JobPilot\\screenshots\\${s.id}.png` : null,
      submitClickedAt: null,
      error: null,
      notes: s.notes ?? ''
    }
  })
}

export function flawedLint(): LintReport {
  return {
    score: 52,
    issues: [
      { rule: 'banned-phrase', severity: 'high', message: '"thrilled" is a common AI giveaway.', match: 'thrilled', index: 22, suggestion: 'Say what you actually liked about the role.' },
      { rule: 'banned-phrase', severity: 'high', message: '"leveraging" is a common AI giveaway.', match: 'leveraging', index: 113, suggestion: 'Use "using".' },
      { rule: 'em-dash', severity: 'medium', message: 'Em dash used as a pause.', match: '—', index: 190, suggestion: 'Use a period or a comma.' },
      { rule: 'exclamation', severity: 'medium', message: 'Exclamation mark. Your voice profile avoids them.', match: '!', index: 62, suggestion: null },
      { rule: 'not-x-but-y', severity: 'medium', message: 'The "not just X, but Y" pattern.', match: 'not just a developer, but a problem solver', index: 262, suggestion: 'State the one thing you are.' }
    ],
    stats: { words: 74, sentences: 4, avgSentenceWords: 18.5, sentenceLengthStdDev: 3.1, paragraphs: 3 }
  }
}

// ---------------------------------------------------------------------------
// Events, suggestions, runs
// ---------------------------------------------------------------------------

export function initialEvents(): EventRecord[] {
  const e = (n: number, ago: number, type: EventRecord['type'], jobId: string | null, message: string): EventRecord => ({ id: `ev_${n}`, at: iso(ago), type, jobId, message, data: null })
  return [
    e(1, 8 * MIN, 'run_finished', null, 'Run finished: 31 found, 2 new, 1 scored, 1 prepared.'),
    e(2, 9 * MIN, 'prepared', 'job_2', 'Prepared an application for Staff Software Engineer, Platform at Lumen Health. One answer needs you.'),
    e(3, 11 * MIN, 'shortlisted', 'job_2', 'Lumen Health, Staff Software Engineer, Platform scored 88 (perfect fit).'),
    e(4, 14 * MIN, 'filtered', 'job_10', 'Mosaic Pay, Senior Engineer, Payments filtered out. Listed maximum salary is below your minimum.'),
    e(5, 15 * MIN, 'discovered', 'job_13', 'Found Frontend Engineer, Product at Juniper AI on Greenhouse.'),
    e(6, 16 * MIN, 'run_started', null, 'Run started by the schedule.'),
    e(7, 5 * HOUR, 'prepared', 'job_1', 'Prepared an application for Senior Frontend Engineer at Northwind Labs.'),
    e(8, 5 * HOUR + 2 * MIN, 'shortlisted', 'job_1', 'Northwind Labs, Senior Frontend Engineer scored 92 (perfect fit).'),
    e(9, 1 * DAY, 'outcome', 'job_16', 'Ironbark moved to Interview.'),
    e(10, 2 * DAY, 'submitted', 'job_17', 'Submitted the application to Sable Studio automatically.'),
    e(11, 2 * DAY + HOUR, 'dismissed', 'job_15', 'You dismissed Senior Software Engineer at Dovetail Works (pay too low).'),
    e(12, 3 * DAY, 'submit_failed', 'job_20', 'Could not submit to Alder & Co. The form asked for a login.'),
    e(13, 3 * DAY + HOUR, 'budget_stop', null, 'Stopped scoring at the daily budget of $1.00.'),
    e(14, 4 * DAY, 'scored', 'job_8', 'Tidewater Systems, Backend Engineer (Go) scored 41. Archived as not a fit.'),
    e(15, 4 * DAY + HOUR, 'error', null, 'The Remotive request timed out. It will retry on the next run.')
  ]
}

export function initialSuggestions(): PreferenceSuggestion[] {
  return [
    { id: 'sug1', message: 'You dismissed 4 jobs as too senior. Exclude "principal" from titles to skip them before scoring.', evidence: 4, patch: { preferences: { excludeTitleKeywords: ['intern', 'junior', 'principal'] } } },
    { id: 'sug2', message: 'You dismissed 3 onsite roles as not remote. Remove "onsite" from your accepted work styles.', evidence: 3, patch: { preferences: { remote: ['remote', 'hybrid'] } } }
  ]
}

export function initialRuns(): RunRecord[] {
  const stats = { discovered: 31, newJobs: 2, duplicates: 4, filteredOut: 12, prescoredOut: 13, scored: 1, shortlisted: 1, prepared: 1, submitted: 0, errors: 0, costUsd: 0.021, tokens: 14200, stoppedForBudget: false }
  return [
    { id: 'run_1', trigger: 'schedule', startedAt: iso(16 * MIN), finishedAt: iso(8 * MIN), stats, error: null },
    { id: 'run_2', trigger: 'schedule', startedAt: iso(6 * HOUR + 16 * MIN), finishedAt: iso(6 * HOUR + 4 * MIN), stats: { ...stats, discovered: 44, newJobs: 7, scored: 6, shortlisted: 3, costUsd: 0.083, tokens: 61000 }, error: null }
  ]
}

// ---------------------------------------------------------------------------
// Analytics
// ---------------------------------------------------------------------------

export function buildAnalytics(rangeDays: number): AnalyticsReport {
  const rnd = seeded(42)
  const daily: AnalyticsReport['daily'] = []
  for (let i = rangeDays - 1; i >= 0; i--) {
    const d = new Date(Date.now() - i * DAY)
    const weekend = d.getDay() === 0 || d.getDay() === 6
    const discovered = Math.round((weekend ? 6 : 14) + rnd() * 12)
    const submitted = weekend ? Math.round(rnd() * 1.4) : Math.round(rnd() * 3.4)
    const costUsd = Math.round((0.03 + rnd() * 0.22 + submitted * 0.05) * 1000) / 1000
    daily.push({ date: d.toISOString().slice(0, 10), discovered, submitted, costUsd, tokens: Math.round(costUsd * 260_000) })
  }
  const sum = (f: (x: AnalyticsReport['daily'][number]) => number): number => daily.reduce((a, d) => a + f(d), 0)
  const discovered = sum((d) => d.discovered)
  const submitted = sum((d) => d.submitted)
  const filteredOut = Math.round(discovered * 0.34)
  const prescoredOut = Math.round(discovered * 0.31)
  const duplicates = Math.round(discovered * 0.08)
  const scored = discovered - filteredOut - prescoredOut - duplicates
  const shortlisted = Math.round(scored * 0.52)
  const prepared = Math.round(submitted * 1.3)
  const responses = Math.round(submitted * 0.31)
  const interviews = Math.round(submitted * 0.14)
  const offers = Math.max(rangeDays >= 30 ? 1 : 0, Math.round(submitted * 0.03))
  const totalCost = sum((d) => d.costUsd)
  const totalTokens = sum((d) => d.tokens)
  const skippedFree = filteredOut + prescoredOut + duplicates
  const k = rangeDays / 30
  const scale = (n: number): number => Math.max(1, Math.round(n * k))
  const outcomes = <T extends string>(rows: Array<[T, number, number, number]>): Array<{ submitted: number; responses: number; interviews: number } & Record<'k', T>> =>
    rows.map(([key, s, r, i]) => ({ k: key, submitted: scale(s), responses: Math.min(scale(r), scale(s)), interviews: Math.min(scale(i), scale(r)) }))
  return {
    rangeDays,
    funnel: { discovered, filteredOut, prescoredOut, duplicates, scored, shortlisted, dismissed: Math.round(shortlisted * 0.22), prepared, submitted, responses, interviews, offers },
    daily,
    outcomesByBucket: outcomes<FitBucket>([['perfect', 6, 4, 3], ['great', 14, 5, 2], ['good', 12, 2, 0], ['weak', 2, 0, 0]]).map((r) => ({ bucket: r.k, submitted: r.submitted, responses: r.responses, interviews: r.interviews })),
    outcomesBySource: outcomes<SourceKind>([['greenhouse', 12, 5, 2], ['ashby', 7, 3, 2], ['lever', 6, 1, 0], ['remoteok', 5, 1, 0], ['remotive', 4, 1, 1], ['adzuna', 3, 0, 0]]).map((r) => ({ source: r.k, submitted: r.submitted, responses: r.responses, interviews: r.interviews })),
    costByTask: [
      { task: 'triage', costUsd: totalCost * 0.22, tokens: Math.round(totalTokens * 0.5), calls: scale(310) },
      { task: 'cover_letter', costUsd: totalCost * 0.38, tokens: Math.round(totalTokens * 0.18), calls: scale(41) },
      { task: 'answers', costUsd: totalCost * 0.2, tokens: Math.round(totalTokens * 0.14), calls: scale(48) },
      { task: 'revise', costUsd: totalCost * 0.1, tokens: Math.round(totalTokens * 0.08), calls: scale(22) },
      { task: 'form_map', costUsd: totalCost * 0.06, tokens: Math.round(totalTokens * 0.07), calls: scale(40) },
      { task: 'extract_profile', costUsd: totalCost * 0.02, tokens: Math.round(totalTokens * 0.02), calls: 2 },
      { task: 'voice', costUsd: totalCost * 0.02, tokens: Math.round(totalTokens * 0.01), calls: 1 }
    ],
    costByModel: [
      { model: 'claude-sonnet-5-5', costUsd: totalCost * 0.68, tokens: Math.round(totalTokens * 0.34), calls: scale(112) },
      { model: 'claude-haiku-5-5', costUsd: totalCost * 0.3, tokens: Math.round(totalTokens * 0.64), calls: scale(352) },
      { model: 'llama3.1:8b', costUsd: 0, tokens: Math.round(totalTokens * 0.02), calls: scale(9) }
    ],
    scoreDistribution: [
      { range: '0-19', count: scale(6) }, { range: '20-39', count: scale(18) }, { range: '40-59', count: scale(34) },
      { range: '60-69', count: scale(22) }, { range: '70-79', count: scale(19) }, { range: '80-89', count: scale(11) }, { range: '90-100', count: scale(4) }
    ],
    topGaps: [
      { key: 'Kubernetes', count: scale(14) }, { key: 'Go', count: scale(11) }, { key: 'GraphQL subscriptions', count: scale(8) },
      { key: 'Storybook', count: scale(7) }, { key: 'Rust', count: scale(5) }, { key: 'Terraform', count: scale(4) }
    ],
    topMatches: [
      { key: 'React', count: scale(63) }, { key: 'TypeScript', count: scale(58) }, { key: 'Design systems', count: scale(31) },
      { key: 'Accessibility', count: scale(22) }, { key: 'Node.js', count: scale(19) }, { key: 'Mentoring', count: scale(12) }
    ],
    dismissReasons: [{ key: 'too senior', count: scale(7) }, { key: 'pay too low', count: scale(5) }, { key: 'not remote', count: scale(4) }, { key: 'wrong industry', count: scale(3) }, { key: 'wrong tech stack', count: scale(2) }],
    filterReasons: [
      { key: 'Salary below your minimum', count: scale(41) }, { key: 'Title contains an excluded keyword', count: scale(33) }, { key: 'Posting older than 30 days', count: scale(21) },
      { key: 'Location does not match', count: scale(18) }, { key: 'Excluded company', count: scale(6) }
    ],
    tokenSavings: {
      jobsSkippedFree: skippedFree,
      estimatedTokensSaved: skippedFree * 1800,
      estimatedUsdSaved: Math.round(skippedFree * 1800 * 0.0000006 * 1000) / 1000,
      cacheHits: scale(86)
    },
    averages: { costPerApplicationUsd: submitted > 0 ? totalCost / submitted : null, hoursDiscoveryToApply: 31.5, daysToFirstResponse: 4.2 }
  }
}

export const MODEL_LISTS: Record<string, string[]> = {
  anthropic: ['claude-haiku-5-5', 'claude-sonnet-5-5', 'claude-opus-5-5', 'claude-haiku-4-5', 'claude-sonnet-4-6'],
  openai: ['gpt-5', 'gpt-5-mini', 'gpt-5-nano'],
  gemini: ['gemini-2.5-pro', 'gemini-2.5-flash', 'gemini-2.5-flash-lite'],
  openrouter: ['anthropic/claude-sonnet-5-5', 'openai/gpt-5-mini', 'meta-llama/llama-3.3-70b-instruct'],
  ollama: ['llama3.1:8b', 'qwen2.5:14b', 'mistral:7b'],
  openai_compatible: ['default']
}
