//
// Links
// - https://docs.pretalx.org/api/fundamentals.html
//

import {
  PretalxService,
  PretalxSlot,
  PretalxTalk,
  PretalxTax,
  RedisService,
  SemaphoreService,
  trimEmail,
} from '@openlab/deconf-api-toolkit'
import {
  Session,
  SessionVisibility,
  SessionState,
  ScheduleRecord,
  Track,
  SessionType,
  Localised,
  Theme,
  LocalisedLink,
} from '@openlab/deconf-shared'

import { checkEnvObject, pluck } from 'valid-env'
import ms from 'ms'

import {
  AppConfig,
  createDebug,
  loadConfig,
  sha256Hash,
} from '../lib/module.js'

// TODO: migrate back to deconf version once updated
interface PretalxTax2 extends PretalxTax {
  id: number
}
interface PretalxTalk2 extends PretalxTalk {
  tag_ids?: number[]
  slot: PretalxSlot2 | null
}
interface PretalxSlot2 extends PretalxSlot {
  room_id: number
}

export interface FetchScheduleCommandOptions {}

//
// Constants
//

const debug = createDebug('cmd:scrape-pretalx')
const LOCK_MAX_DURATION_MS = ms('10m')
export const PRETALX_LOCK_KEY = 'pretalx/lock'

/** Setup to run the scrape command */
async function setup() {
  const env = checkEnvObject(
    pluck(process.env, 'PRETALX_API_TOKEN', 'REDIS_URL')
  )
  const config = await loadConfig()
  const store = new RedisService(env.REDIS_URL)
  const pretalx = new PretalxService({ env, store, config: config.pretalx })
  const semaphore = new SemaphoreService({ store })

  return { config, env, store, pretalx, semaphore }
}

async function teardown(store: RedisService) {
  await store.close()
}

//
// Data accessors
//
function dataCommand<T>(block: (pretalx: PretalxService) => Promise<T>) {
  return async () => {
    const { store, pretalx } = await setup()
    const result = await block(pretalx)
    console.log(JSON.stringify(result, null, 2))
    await teardown(store)
  }
}

export const pretalxDataCommands = {
  questions: dataCommand((p) => p.getQuestions()),
  event: dataCommand((p) => p.getEvent()),
  submissions: dataCommand(async (p) =>
    p.getSubmissions(submissionOptions(await loadConfig()))
  ),
  speakers: dataCommand(async (p) =>
    p.getSpeakers(speakerOptions(await loadConfig()))
  ),
  tags: dataCommand((p) => p.getTags()),
}

function submissionOptions(config: AppConfig) {
  return {
    questions: [
      config.pretalx.questions.recommendations,
      ...config.pretalx.questions.links,
    ],
  }
}

function speakerOptions(config: AppConfig) {
  return {
    questions: [
      config.pretalx.questions.pulsePhoto,
      config.pretalx.questions.affiliation,
    ],
  }
}

/** A CLI command to scrape pretalx, format content for deconf and put into redis */
export async function fetchScheduleCommand(
  options: FetchScheduleCommandOptions
) {
  debug('start')

  const { config, pretalx, store, semaphore } = await setup()
  const helpers = new PretalxHelpers(pretalx, config.pretalx)

  const hasLock = await semaphore.aquire(PRETALX_LOCK_KEY, LOCK_MAX_DURATION_MS)
  if (!hasLock) {
    throw new Error(`Failed to aquire lock`)
  }

  try {
    const submissions = await pretalx.getSubmissions(submissionOptions(config))
    const speakers = await pretalx.getSpeakers(speakerOptions(config))
    const tags = await pretalx.getTags()
    const activeSpeakers = new Set<string>()
    const speakerMap = new Map(speakers.map((s) => [s.code, s]))
    // const questions = await pretalx.getQuestions()
    // const speakerMap = new Map(speakers.map((s) => [s.code, s]))

    const schedule: Omit<ScheduleRecord, 'settings'> = {
      sessions: helpers.getSessions(submissions as any, pretalx),
      slots: pretalx.getDeconfSlots(submissions),
      speakers: pretalx.getDeconfSpeakers(
        speakers,
        config.pretalx.questions.affiliation
      ),
      themes: helpers.getThemes(tags as any[]),
      // tracks: config.tracks as Track[],
      tracks: helpers.getTracksFromRooms(submissions as any),
      types: config.sessionTypes.map((t) => helpers.createSessionType(t)),
    }

    for (const session of schedule.sessions) {
      // Remove -mozilla from language names
      session.hostLanguages = session.hostLanguages.map((locale) =>
        locale.replace('-mozilla', '')
      )
      if (session.state !== 'confirmed') continue

      for (const s of session.speakers) {
        const speaker = speakerMap.get(s)
        if (!speaker?.email) continue
        activeSpeakers.add(sha256Hash(trimEmail(speaker.email)))
      }
    }

    // Save to redis
    for (const [key, value] of Object.entries(schedule)) {
      await store.put(`schedule.${key}`, value)
    }
    await store.put('schedule.facilitators', Array.from(activeSpeakers))

    // Wait a little bit to hold the lock for longer
    // For example, if multiple containers are triggered at the same time
    // only 1 has to run
    await new Promise<void>((resolve) => setTimeout(() => resolve(), 1000))
  } finally {
    await semaphore.release(PRETALX_LOCK_KEY)
    await teardown(store)
  }
}

//
// Utilities
//

class PretalxHelpers {
  constructor(
    public pretalx: PretalxService,
    public config: AppConfig['pretalx']
  ) {}

  getSessions(submissions: PretalxTalk2[], pretalx: PretalxService): Session[] {
    const sessions = submissions.map((submission) => {
      // TODO: slots don't currently have ids
      const slot = submission.slot
        ? this.pretalx.getSlotId(submission.slot)
        : undefined

      const type = submission.submission_type_id?.toString()
      const track = submission.slot?.room_id?.toString()

      if (type === undefined || track === undefined) return null

      const themes: string[] = (submission.tag_ids ?? []).map((t) =>
        t.toString()
      )

      const recommendations = pretalx.getSessionLinks(submission, [
        this.config.questions.recommendations,
      ])

      const links = [
        ...pretalx.getSessionLinks(submission, this.config.questions.links),
        ...this.getLinks(submission),
      ]

      const hostLanguages = [submission.content_locale]
      if (
        this.config.aslTagId &&
        submission.tag_ids?.includes(this.config.aslTagId)
      ) {
        hostLanguages.push('asl')
      }
      if (
        this.config.ccTagId &&
        submission.tag_ids?.includes(this.config.ccTagId)
      ) {
        hostLanguages.push('cc')
      }

      return {
        id: this.pretalx.makeUnique(submission.code),
        type,
        title: { en: submission.title },
        slot,
        track,
        themes,
        coverImage: '',
        content: {
          en: submission.description,
        },
        links,
        hostLanguages,
        enableInterpretation: false,
        speakers: submission.speakers.map((s) => s.code),
        hostOrganisation: { en: '' },
        isRecorded: submission.do_not_record !== true,
        isOfficial: false,
        isFeatured: submission.is_featured,
        visibility: SessionVisibility.private,
        state: submission.state as SessionState,
        participantCap: null,

        proxyUrl: undefined,
        hideFromSchedule: false,

        recommendations,
      }
    })

    return sessions.filter((s) => Boolean(s)) as Session[]
  }

  getLinks(talk: PretalxTalk): LocalisedLink[] {
    return talk.resources
      .filter((r) => /^https?:\/\//.test(r.resource))
      .map((r) => ({
        type: 'url',
        url: r.resource,
        title: r.description,
        language: 'en',
      }))
  }

  getThemes(tags: PretalxTax2[]): Theme[] {
    return tags.map((tag) => ({
      id: tag.id.toString(),
      title: {
        en: tag.tag,
      },
    }))
  }

  getTracksFromRooms(submissions: PretalxTalk2[]) {
    const tracks = new Map<number, Track>()

    for (const submission of submissions) {
      if (!submission.slot?.room_id || tracks.has(submission.slot.room_id)) {
        continue
      }

      // TODO: check L10N when there is some data
      tracks.set(submission.slot.room_id, {
        id: submission.slot.room_id.toString(),
        title: submission.slot.room,
      })
    }

    return Array.from(tracks.values())
  }

  // createTrack({ id, title }: { id: number; title: Localised }): Track {
  //   return { id, title }
  //   return {
  //     id: input.id,
  //     title: input.title,
  //   }
  // }

  createSessionType(input: {
    id: string
    title: Localised
    icon: [string, string]
    layout: string
  }): SessionType {
    return {
      id: input.id,
      title: input.title,
      layout: input.layout,
      iconGroup: input.icon[0],
      iconName: input.icon[1],
    }
  }
}
