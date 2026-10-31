import { Db } from './db/database'
import { AnswerBankRepo } from './db/repos/answers'
import { ApplicationsRepo } from './db/repos/applications'
import { CompaniesRepo } from './db/repos/companies'
import { DocumentsRepo } from './db/repos/documents'
import { type Emit, EventsRepo } from './db/repos/events'
import { JobsRepo } from './db/repos/jobs'
import { ProfileRepo } from './db/repos/profile'
import { ProvidersRepo } from './db/repos/providers'
import { RunsRepo } from './db/repos/runs'
import { SearchesRepo } from './db/repos/searches'
import { SettingsRepo } from './db/repos/settings'
import { type ClientFactory, LlmService } from './llm/service'
import type { AppPaths } from './paths'
import type { KeyVault } from './secrets'

export type { Emit }

/** Everything the services share. One instance per app, or per test. */
export interface AppContext {
  db: Db
  paths: AppPaths
  vault: KeyVault
  emit: Emit
  settings: SettingsRepo
  providers: ProvidersRepo
  llm: LlmService
  profile: ProfileRepo
  documents: DocumentsRepo
  answers: AnswerBankRepo
  companies: CompaniesRepo
  searches: SearchesRepo
  jobs: JobsRepo
  applications: ApplicationsRepo
  events: EventsRepo
  runs: RunsRepo
  /** Writes the database to disk and closes it. */
  close(): void
}

export interface CreateContextOptions {
  /** Path of the database file, or null for an in-memory database (tests). */
  dbFile: string | null
  paths: AppPaths
  vault: KeyVault
  emit: Emit
  /** Replace the AI client, for tests. */
  clientFactory?: ClientFactory
}

export async function createContext(options: CreateContextOptions): Promise<AppContext> {
  const db = await Db.open(options.dbFile)
  const settings = new SettingsRepo(db)
  const providers = new ProvidersRepo(db, options.vault)
  const llm = new LlmService(db, settings, providers, options.clientFactory)
  return {
    db,
    paths: options.paths,
    vault: options.vault,
    emit: options.emit,
    settings,
    providers,
    llm,
    profile: new ProfileRepo(db),
    documents: new DocumentsRepo(db),
    answers: new AnswerBankRepo(db),
    companies: new CompaniesRepo(db),
    searches: new SearchesRepo(db),
    jobs: new JobsRepo(db),
    applications: new ApplicationsRepo(db),
    events: new EventsRepo(db, options.emit),
    runs: new RunsRepo(db),
    close: () => db.close()
  }
}
