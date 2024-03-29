import {
  assertStruct,
  ContentRepository,
  ContentService,
  ProcessRepoOptions,
  RedisService,
} from '@openlab/deconf-api-toolkit'
import { readFile } from 'fs/promises'
import path from 'path'
import { checkEnvObject, pluck } from 'valid-env'
import {
  ConferenceConfigStruct,
  BlockedStruct,
  loadConfig,
  createDebug,
} from '../lib/module.js'

const debug = createDebug('cmd:fetch-content')

export interface FetchContentCommandOptions {
  branch: string
  reuse: boolean
  repoPath: string | null
  local: boolean
}

// TODO: should this be a deconf config?
class CustomContentRepo extends ContentRepository {
  constructor(public local: boolean) {
    super({})
  }
  async updateLocalRepo(dir: string, url: string, branch: string) {
    if (this.local) return
    super.updateLocalRepo(dir, url, branch)
    // Skip pulling from the local repo
  }
}

export async function fetchContentCommand(options: FetchContentCommandOptions) {
  const env = checkEnvObject(
    pluck(process.env, 'REDIS_URL', 'CONTENT_REPO_REMOTE')
  )

  const store = new RedisService(env.REDIS_URL)
  const contentRepo = new CustomContentRepo(options.local)
  const config = await loadConfig()
  const cmd = new ContentService({ store, contentRepo })

  const opts: ProcessRepoOptions = {
    remote: env.CONTENT_REPO_REMOTE,
    branch: options.branch,
    reuseDirectory: options.reuse ? 'content' : undefined,
    contentKeys: config.content.keys,
    languages: ['en', 'es'],
  }

  if (options.local) {
    debug('local mode')
    opts.reuseDirectory = '..'
  }

  // `repoPath` is the new way, pass an existing repo to fetch from
  if (options.repoPath) {
    opts.reuseDirectory = options.repoPath
  }

  await cmd.processRepository(opts, async function* (directory) {
    // Fetch data
    const config = JSON.parse(
      await readFile(path.join(directory, 'content', 'settings.json'), 'utf8')
    )
    if (config.startDate) config.startDate = new Date(config.startDate)
    if (config.endDate) config.endDate = new Date(config.endDate)

    const blocked = JSON.parse(
      await readFile(path.join(directory, 'content', 'blocked.json'), 'utf8')
    )

    assertStruct(config, ConferenceConfigStruct)
    assertStruct(blocked, BlockedStruct)

    yield

    // Save data
    await store.put('schedule.settings', config)
    await store.put('schedule.blocked', blocked)
  })

  await store.close()
}
