import { describe, expect, mock, test } from 'claude-code/testing'
import type { On, SessionMeasureInput } from 'claude-code'

import { bandOf, cacheLeftMs, cacheTtlMs, limitText, tokens } from './logic'

const ME = 'compact'
const MIN = 60_000
const T0 = 1_000_000_000

const BAND = {
  plugin: ME,
  component: 'AbovePrompt',
  props: {
    hasSurvey: false,
    isWorking: false,
    maxRows: 3,
    bodyColumns: 100,
    scroll: { offset: 0, bodyRows: 3 },
    view: {},
  },
} as const
const START = { cwd: '/tmp', surface: 'desktop', isInteractive: true } as const
const ABO = [
  { kind: 'five_hour', percentUsed: 23.5 },
  { kind: 'seven_day', percentUsed: 61 },
]

function engine(on: On): ReturnType<typeof mock.clock> {
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('session.usage', () => ({
    value: { startedAt: T0, context: { window: 200_000 }, rateLimits: [] },
  }))
  on('command.register', (_$, e) => ({ value: { command: e.name } }))
  on('session.measure', (_$, e) => ({ changed: e.changed }))
  on('turn.start', (_$, e) => ({ turnId: e.turnId }))
  // Was die Engine ohne das Band zeigt: hier nichts.
  on('ui.render', { component: 'AbovePrompt' }, ($, e) => {
    const { Box } = $.ui.resolve(e)

    return <Box key="engine" />
  })
  on('turn.complete', (_$, e) => ({ text: e.answer }))

  return mock.clock(on, { now: T0 })
}

const done = { answer: 'ok', durationMs: 1, isAborted: false, turnId: 't', reason: 'answer' } as const

describe('Logik', () => {
  test('Cache hält im Abo eine Stunde, sonst fünf Minuten', async () => {
    expect(cacheTtlMs(ABO)).toBe(60 * MIN)
    expect(cacheTtlMs([])).toBe(5 * MIN)
    expect(cacheLeftMs(T0, T0 + 13 * MIN, 60 * MIN)).toBe(47 * MIN)
    expect(cacheLeftMs(T0, T0 + 61 * MIN, 60 * MIN)).toBe(0)
  })

  test('Zahlen auf Deutsch', async () => {
    expect(tokens(84_300)).toBe('84 Tsd.')
    expect(tokens(1_200_000)).toBe('1,2 Mio.')
    expect(limitText({ kind: 'five_hour', percentUsed: 23.5 })).toBe('5 Std. 23,5 %')
  })

  test('warnt bei vollem Kontext, kaltem Cache und hoher Nutzung', async () => {
    const ctx = { tokens: 150_000, window: 200_000, percent: 75 }
    const band = bandOf(ctx, [{ kind: 'seven_day', percentUsed: 85 }], T0, false, T0 + 61 * MIN)
    expect(band.context).toEqual({ text: 'Kontext 75 % (150 Tsd. von 200 Tsd.), neuer Chat lohnt sich bald', tone: 'warn' })
    expect(band.cache).toEqual({ text: 'Cache kalt: die nächste Nachricht liest 150 Tsd. Tokens neu ein', tone: 'warn' })
    expect(band.limits).toEqual([{ text: '7 Tage 85 %', tone: 'warn' }])
  })

  test('vor der ersten Antwort zeigt das Band nichts', async () => {
    expect(bandOf(null, [], 0, false, T0)).toEqual({ limits: [] })
  })
})

describe('Band', () => {
  test('zählt nach der Antwort herunter und wird kalt', async ($, on) => {
    const clock = engine(on)
    await $.session.start(START)
    await $.session.measure({
      context: { tokens: 84_000, window: 200_000, percent: 42 },
      rateLimits: ABO,
      changed: ['context', 'rateLimits'],
    })
    await $.turn.start({ text: 'los', turnId: 't' })

    let ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
    expect(await ui.find({ type: 'Text', text: /Cache warm \(läuft gerade\)/ })).toBeDefined()
    await ui.unmount()

    await $.turn.complete(done)
    await clock.advance(13 * MIN)
    for (const surface of ['terminal', 'desktop'] as const) {
      const one = await $.ui.mount({ ...BAND, surface })
      expect(await one.find({ type: 'Text', text: /Kontext 42 % \(84 Tsd\. von 200 Tsd\.\)/ })).toBeDefined()
      expect(await one.find({ type: 'Text', text: /Cache warm noch 4[67] min/ })).toBeDefined()
      expect(await one.find({ type: 'Text', text: /5 Std\. 23,5 %/ })).toBeDefined()
      await one.unmount()
    }

    await clock.advance(50 * MIN)
    ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
    expect(await ui.find({ type: 'Text', text: /Cache kalt: die nächste Nachricht liest 84 Tsd\. Tokens neu ein/ })).toBeDefined()
    await ui.unmount()
  })

  test('Subagenten setzen die Uhr nicht', async ($, on) => {
    engine(on)
    await $.session.start(START)
    await $.turn.complete({ ...done, agentId: 'sub-1' })
    const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
    expect(await ui.find({ type: 'Text', text: /Cache/ })).toBeUndefined()
    await ui.unmount()
  })

  test('/cache-anzeige blendet aus', async ($, on) => {
    engine(on)
    await $.session.start(START)
    await $.turn.complete(done)
    await $.command.run({ command: 'cache-anzeige', args: '' } as never)
    const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
    expect(await ui.find({ type: 'Text', text: /Cache/ })).toBeUndefined()
    await ui.unmount()
  })
})
