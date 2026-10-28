import { describe, expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'
import type { Engine } from 'claude-code/testing'

import {
  CHECKPOINT_IDLE_TEXT,
  CHECKPOINT_TEST_TEXT,
  COMPACT_INSTRUCTIONS,
  TASK_STATUS_STEP,
  checkpointContextText,
  checkpointResumeText,
  isHeadlessRefusal,
  isOwnPrompt,
  nextStep,
  restoreRound,
  roundKey,
} from './logic'

const MIN = 60_000
const T0 = 1_000_000_000
const HERE = { cwd: '/home/nutzer/projekt', surface: 'desktop', isInteractive: true } as const
/** So startet ein Chat in der Desktop-App: über das SDK, ohne Terminal. */
const DESKTOP = { ...HERE, surface: null, isInteractive: false } as const
const done = { answer: 'ok', durationMs: 1, isAborted: false, turnId: 't', reason: 'answer' } as const

type Seen = {
  prompts: string[]
  compacts: (string | undefined)[]
  draft: string
  /** Was session.compact antwortet: ok, skip, hang (nie), throw. */
  compactMode: 'ok' | 'skip' | 'hang' | 'throw' | 'headless'
  commands: string[]
  toasts: string[]
  /** $.store: was der Mod festhält und beim nächsten Start liest. */
  store: Map<string, unknown>
}

const SID = 'sitzung-1'
const ROUND = roundKey(SID)

function engine(on: On): { clock: ReturnType<typeof mock.clock>; seen: Seen } {
  const seen: Seen = { prompts: [], compacts: [], draft: '', compactMode: 'ok', toasts: [], commands: [], store: new Map() }
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('session.usage', () => ({ value: { startedAt: T0, context: { window: 1_000_000 }, rateLimits: [] } }))
  on('command.register', (_$, e) => ({ value: { command: e.name } }))
  on('session.measure', (_$, e) => ({ changed: e.changed }))
  on('turn.start', (_$, e) => ({ turnId: e.turnId }))
  on('turn.complete', (_$, e) => ({ text: e.answer }))
  on('prompt.read', () => ({ value: { text: seen.draft, cursor: 0 } }) as never)
  on('ui.toast', (_$, e) => {
    seen.toasts.push((e as { text: string }).text)

    return { value: undefined } as never
  })
  on('session.id', () => ({ value: SID }) as never)
  on('store.set', (_$, e) => {
    seen.store.set(e.key, JSON.parse(JSON.stringify(e.value)))

    return { value: undefined } as never
  })
  on('store.get', (_$, e) => ({ value: seen.store.get(e.key) }) as never)
  on('store.keys', () => ({ value: [...seen.store.keys()] }) as never)
  on('store.delete', (_$, e) => {
    seen.store.delete(e.key)

    return { value: undefined } as never
  })
  on('prompt.submit', (_$, e) => {
    if (e.origin?.kind === 'plugin') seen.prompts.push(e.text)

    return { text: e.text }
  })
  on('command.run', { command: 'compact' }, async ($, e) => {
    seen.commands.push(e.args)

    return { text: '' }
  })
  on('session.compact', (_$, e) => {
    seen.compacts.push(e.instructions)
    if (seen.compactMode === 'skip') return { skip: 'nein' }
    if (seen.compactMode === 'throw') throw new Error('turn running')
    if (seen.compactMode === 'hang') return new Promise(() => undefined) as never
    if (seen.compactMode === 'headless') {
      throw new Error('$.session.compact: not available in a headless (-p / SDK) session yet: compaction here runs inside a turn (a /compact prompt)')
    }

    return { messages: [{ role: 'user', text: 'Zusammenfassung', toolUses: [] }] } as never
  })

  return { clock: mock.clock(on, { now: T0 }), seen }
}

/** Ein Turn des Hauptchats, wie ihn die Engine meldet. */
async function turn($: Engine): Promise<void> {
  await $.turn.start({ text: 'x', turnId: 't' })
  await $.turn.complete(done)
}

describe('Entscheidung', () => {
  const base = { phase: 'active', idleSince: T0, checkpointDone: false, isOff: false } as const
  test('50 min Ruhe: Abschluss, 55 min: Compact, 95 %: sofort', async () => {
    expect(nextStep(base, T0 + 49 * MIN, false, 10, false)).toBe('none')
    expect(nextStep(base, T0 + 50 * MIN, false, 10, false)).toBe('checkpoint-idle')
    expect(nextStep(base, T0 + 50 * MIN, true, 10, false)).toBe('none')
    expect(nextStep(base, T0 + 50 * MIN, false, 10, true)).toBe('none')
    const cp = { ...base, phase: 'checkpoint', reason: 'idle', checkpointDone: true } as const
    expect(nextStep(cp, T0 + 54 * MIN, false, 10, false)).toBe('none')
    expect(nextStep(cp, T0 + 55 * MIN, false, 10, false)).toBe('compact')
    expect(nextStep({ ...cp, checkpointDone: false }, T0 + 56 * MIN, false, 10, false)).toBe('none')
    expect(nextStep(base, T0 + 1 * MIN, false, 95, false)).toBe('checkpoint-context')
    expect(nextStep({ ...cp, reason: 'context' }, T0 + 2 * MIN, false, 96, false)).toBe('compact')
    expect(nextStep({ ...base, isOff: true }, T0 + 60 * MIN, false, 99, false)).toBe('none')
    expect(nextStep({ ...base, phase: 'compacted' }, T0 + 60 * MIN, false, 99, false)).toBe('none')
  })

  test('Abschluss-Turn kommt nie an: nach 15 min trotzdem Compact', async () => {
    const cp = { ...base, phase: 'checkpoint', reason: 'idle', checkpointDone: false, checkpointAt: T0 + 50 * MIN } as const
    expect(nextStep(cp, T0 + 64 * MIN, false, 10, false)).toBe('none')
    expect(nextStep(cp, T0 + 65 * MIN, false, 10, false)).toBe('compact')
  })

  test('Testmodus: 2 min, Compact gleich danach', async () => {
    const t = { ...base, isTest: true } as const
    expect(nextStep(t, T0 + 2 * MIN, false, 10, false)).toBe('checkpoint-idle')
    expect(nextStep({ ...t, phase: 'checkpoint', checkpointDone: true }, T0 + 2 * MIN + 10_000, false, 10, false)).toBe('compact')
  })

  test('eigener Prompt erkannt', async () => {
    expect(isOwnPrompt({ kind: 'plugin', name: 'compact' }, 'compact')).toBe(true)
    expect(isOwnPrompt({ kind: 'plugin', name: 'agenten' }, 'compact')).toBe(false)
    expect(isOwnPrompt({ kind: 'composer' }, 'compact')).toBe(false)
    expect(isOwnPrompt(undefined, 'compact')).toBe(false)
  })
})

describe('Automatik in der Session', () => {
  test('Ruhe: nach 50 min Abschluss-Prompt, nach 55 min Compact, danach Ruhe', async ($, on) => {
    const { clock, seen } = engine(on)
    await $.session.start(HERE)
    await turn($)
    await clock.advance(49 * MIN)
    expect(seen.prompts).toEqual([])
    await clock.advance(1 * MIN)
    expect(seen.prompts).toEqual([CHECKPOINT_IDLE_TEXT])
    await turn($) // der Abschluss-Turn
    await clock.advance(4 * MIN)
    expect(seen.compacts).toEqual([])
    await clock.advance(1 * MIN)
    expect(seen.compacts).toEqual([COMPACT_INSTRUCTIONS])
    await clock.advance(120 * MIN)
    expect(seen.prompts.length).toBe(1)
    expect(seen.compacts.length).toBe(1)
  })

  test('Der Nutzer schreibt nach dem Abschluss: kein Compact, die Uhr beginnt neu', async ($, on) => {
    const { clock, seen } = engine(on)
    await $.session.start(HERE)
    await turn($)
    await clock.advance(50 * MIN)
    await turn($)
    await clock.advance(2 * MIN)
    await $.prompt.submit({ text: 'weiter', origin: { kind: 'composer' } } as never)
    await turn($)
    await clock.advance(10 * MIN)
    expect(seen.compacts).toEqual([])
    await clock.advance(40 * MIN)
    expect(seen.prompts.length).toBe(2)
  })

  test('95 % Kontext: sichern, dann sofort komprimieren', async ($, on) => {
    const { clock, seen } = engine(on)
    await $.session.start(HERE)
    await $.session.measure({ context: { tokens: 960_000, window: 1_000_000, percent: 96 }, rateLimits: [], changed: ['context'] })
    await turn($)
    await clock.advance(1 * MIN)
    expect(seen.prompts.length).toBe(1)
    expect(seen.prompts[0]).toMatch(/Kontext bei 96 %/)
    await turn($)
    await clock.advance(1 * MIN)
    expect(seen.compacts).toEqual([COMPACT_INSTRUCTIONS])
  })

  test('Entwurf im Eingabefeld hält den Abschluss an', async ($, on) => {
    const { clock, seen } = engine(on)
    seen.draft = 'ich schreibe gerade'
    await $.session.start(HERE)
    await turn($)
    await clock.advance(60 * MIN)
    expect(seen.prompts).toEqual([])
  })

  test('läuft in jedem Ordner', async ($, on) => {
    const { clock, seen } = engine(on)
    await $.session.start({ ...HERE, cwd: '/tmp' })
    await turn($)
    await clock.advance(51 * MIN)
    expect(seen.prompts.length).toBe(1)
  })

  test('/session-automatik schaltet ab', async ($, on) => {
    const { clock, seen } = engine(on)
    await $.session.start(HERE)
    await $.command.run({ command: 'session-automatik', args: '' } as never)
    await turn($)
    await clock.advance(50 * MIN)
    // Ohne Zusatz nur der Stand: die Automatik bleibt an.
    expect(seen.prompts.length).toBe(1)
  })

  test('/session-automatik aus schaltet ab', async ($, on) => {
    const { clock, seen } = engine(on)
    await $.session.start(HERE)
    await $.command.run({ command: 'session-automatik', args: 'aus' } as never)
    await turn($)
    await clock.advance(60 * MIN)
    expect(seen.prompts).toEqual([])
    expect(seen.compacts).toEqual([])
  })

  test('Compact wird abgelehnt: neu versuchen, nach 3 Fehlschlägen Hinweis', async ($, on) => {
    const { clock, seen } = engine(on)
    seen.compactMode = 'skip'
    await $.session.start(HERE)
    await turn($)
    await clock.advance(50 * MIN)
    await turn($)
    await clock.advance(5 * MIN)
    expect(seen.compacts.length).toBe(1)
    await clock.advance(1 * MIN)
    expect(seen.compacts.length).toBe(3)
    expect(seen.toasts.some(t => t.includes('/compact'))).toBe(true)
    seen.compactMode = 'ok'
    await clock.advance(1 * MIN)
    expect(seen.compacts.length).toBe(4)
    await clock.advance(60 * MIN)
    expect(seen.compacts.length).toBe(4)
  })

  test('Compact wirft (Turn lief): beim nächsten Schlag noch einmal', async ($, on) => {
    const { clock, seen } = engine(on)
    seen.compactMode = 'throw'
    await $.session.start(HERE)
    await turn($)
    await clock.advance(50 * MIN)
    await turn($)
    await clock.advance(5 * MIN)
    seen.compactMode = 'ok'
    await clock.advance(1 * MIN)
    expect(seen.compacts.length).toBe(2)
    await clock.advance(60 * MIN)
    expect(seen.compacts.length).toBe(2)
  })

  test('Compact hängt: die Automatik bleibt nicht stehen', async ($, on) => {
    const { clock, seen } = engine(on)
    seen.compactMode = 'hang'
    await $.session.start(HERE)
    await turn($)
    await clock.advance(50 * MIN)
    await turn($)
    await clock.advance(5 * MIN)
    expect(seen.compacts.length).toBe(1)
    seen.compactMode = 'ok'
    await clock.advance(11 * MIN)
    expect(seen.compacts.length).toBe(2)
  })

  test('der eigene Abschluss-Prompt setzt die Runde nicht zurück', async ($, on) => {
    const { clock, seen } = engine(on)
    await $.session.start(HERE)
    await turn($)
    await clock.advance(50 * MIN)
    expect(seen.prompts.length).toBe(1)
    // So meldet die Engine den Prompt des Mods auch dessen eigenem prompt.submit-Hook.
    await $.prompt.submit({ text: CHECKPOINT_IDLE_TEXT, origin: { kind: 'plugin', name: 'compact' } } as never)
    await turn($)
    await clock.advance(5 * MIN)
    expect(seen.compacts).toEqual([COMPACT_INSTRUCTIONS])
  })

  test('/session-automatik test: Abschluss nach 2 min, Compact gleich danach', async ($, on) => {
    const { clock, seen } = engine(on)
    await $.session.start(HERE)
    await turn($)
    await $.command.run({ command: 'session-automatik', args: 'test' } as never)
    await clock.advance(2 * MIN)
    expect(seen.prompts).toEqual([CHECKPOINT_TEST_TEXT])
    await turn($)
    await clock.advance(30_000)
    expect(seen.compacts).toEqual([COMPACT_INSTRUCTIONS])
  })

  test('Desktop-App: /compact als Befehl statt direkt', async ($, on) => {
    const { clock, seen } = engine(on)
    seen.compactMode = 'headless'
    await $.session.start(DESKTOP)
    await turn($)
    await clock.advance(50 * MIN)
    await turn($)
    await clock.advance(5 * MIN)
    expect(seen.commands).toEqual([COMPACT_INSTRUCTIONS])
    expect(seen.compacts).toEqual([])
    // Die Engine führt /compact aus: ein Compact, das durch den Hook des Mods läuft.
    seen.compactMode = 'ok'
    await $.session.compact({ instructions: COMPACT_INSTRUCTIONS, messages: [{ role: 'user', text: 'x', toolUses: [] }] } as never)
    expect(seen.toasts).toContain('Session gesichert und komprimiert.')
    await clock.advance(60 * MIN)
    expect(seen.commands.length).toBe(1)
    // Die nächste Runde läuft genauso.
    await $.prompt.submit({ text: 'weiter', origin: { kind: 'composer' } } as never)
    await turn($)
    await clock.advance(50 * MIN)
    await turn($)
    await clock.advance(5 * MIN)
    expect(seen.commands.length).toBe(2)
  })

  test('Desktop-App: kommt nach dem Befehl kein Compact, nach 10 min noch einmal', async ($, on) => {
    const { clock, seen } = engine(on)
    seen.compactMode = 'headless'
    await $.session.start(DESKTOP)
    await turn($)
    await clock.advance(50 * MIN)
    await turn($)
    await clock.advance(5 * MIN)
    expect(seen.commands.length).toBe(1)
    await clock.advance(9 * MIN)
    expect(seen.commands.length).toBe(1)
    await clock.advance(2 * MIN)
    expect(seen.commands.length).toBe(2)
  })

  test('Ablehnung der Engine erkannt', async () => {
    expect(isHeadlessRefusal(new Error('HooksError: compact: $.session.compact: not available in a headless (-p / SDK) session yet'))).toBe(true)
    expect(isHeadlessRefusal(new Error('a turn is running'))).toBe(false)
  })
})

/** So hätte der beendete Prozess die Runde hinterlassen. */
function saved(round: Record<string, unknown>): string {
  return JSON.stringify({ checkpointDone: false, isOff: false, savedAt: T0, ...round })
}

describe('Neustart durch die App', () => {
  test('die Runde liegt nach jedem Turn im Speicher', async ($, on) => {
    const { clock, seen } = engine(on)
    await $.session.start(DESKTOP)
    await clock.advance(1 * MIN)
    await turn($)
    const round = ((seen.store.get(ROUND) ?? {}) as Record<string, unknown>)
    expect(round.phase).toBe('active')
    expect(round.idleSince).toBe(T0 + 1 * MIN)
  })

  test('Prozess nach 10 min Ruhe beendet: die Uhr läuft ab der alten Ruhe weiter', async ($, on) => {
    const { clock, seen } = engine(on)
    seen.compactMode = 'headless'
    seen.store.set(ROUND, JSON.parse(saved({ phase: 'active', idleSince: T0 - 10 * MIN })))
    await $.session.start(DESKTOP)
    await clock.advance(39 * MIN)
    expect(seen.prompts).toEqual([])
    await clock.advance(1 * MIN)
    expect(seen.prompts).toEqual([CHECKPOINT_IDLE_TEXT])
    await turn($)
    await clock.advance(5 * MIN)
    expect(seen.commands).toEqual([COMPACT_INSTRUCTIONS])
  })

  test('Neustart ohne Prompt, Abschluss überfällig: sofort Abschluss, gleich danach Compact', async ($, on) => {
    const { clock, seen } = engine(on)
    seen.compactMode = 'headless'
    seen.store.set(ROUND, JSON.parse(saved({ phase: 'active', idleSince: T0 - 80 * MIN })))
    await $.session.start(DESKTOP)
    await clock.advance(30_000)
    expect(seen.prompts).toEqual([checkpointResumeText(80)])
    await turn($)
    await clock.advance(30_000)
    expect(seen.commands).toEqual([COMPACT_INSTRUCTIONS])
    // Die Engine führt /compact aus; danach ist die Runde erledigt, auch auf der Platte.
    seen.compactMode = 'ok'
    await $.session.compact({ instructions: COMPACT_INSTRUCTIONS, messages: [{ role: 'user', text: 'x', toolUses: [] }] } as never)
    expect(((seen.store.get(ROUND) ?? {}) as Record<string, unknown>).phase).toBe('compacted')
    await clock.advance(120 * MIN)
    expect(seen.prompts.length).toBe(1)
    expect(seen.commands.length).toBe(1)
  })

  test('Neustart durch eine Nachricht: nichts nachholen, die normale Uhr beginnt nach der Antwort', async ($, on) => {
    const { clock, seen } = engine(on)
    seen.compactMode = 'headless'
    seen.store.set(ROUND, JSON.parse(saved({ phase: 'active', idleSince: T0 - 53 * MIN })))
    await $.session.start(DESKTOP)
    await $.prompt.submit({ text: 'Nachricht vom Nutzer', origin: { kind: 'user' } } as never)
    await $.turn.start({ text: 'x', turnId: 't' })
    await clock.advance(2 * MIN)
    await $.turn.complete(done)
    expect(((seen.store.get(ROUND) ?? {}) as Record<string, unknown>).owed).toBe(false)
    await clock.advance(49 * MIN)
    expect(seen.prompts).toEqual([])
    await clock.advance(2 * MIN)
    expect(seen.prompts.length).toBe(1)
    expect(seen.prompts[0]).not.toContain('nachgeholt')
  })

  test('Neustart mitten im Compact, dann eine Nachricht: kein nachgeholter Abschluss', async ($, on) => {
    const { clock, seen } = engine(on)
    seen.store.set(ROUND, JSON.parse(saved({ phase: 'checkpoint', reason: 'idle', checkpointDone: true, idleSince: T0 - 60 * MIN })))
    await $.session.start(DESKTOP)
    await $.prompt.submit({ text: 'Nachricht aus einem anderen Chat', origin: { kind: 'peer' } } as never)
    await $.turn.start({ text: 'x', turnId: 't' })
    await $.turn.complete(done)
    await clock.advance(10 * MIN)
    expect(seen.prompts).toEqual([])
    expect(seen.commands).toEqual([])
  })

  test('Prozess mitten im Abschluss beendet: Abschluss noch einmal, dann Compact', async ($, on) => {
    const { clock, seen } = engine(on)
    seen.compactMode = 'headless'
    seen.store.set(ROUND, JSON.parse(saved({ phase: 'checkpoint', reason: 'idle', idleSince: T0 - 51 * MIN, checkpointAt: T0 - 1 * MIN })))
    await $.session.start(DESKTOP)
    await clock.advance(30_000)
    expect(seen.prompts.length).toBe(1)
    await turn($)
    await clock.advance(30_000)
    expect(seen.commands).toEqual([COMPACT_INSTRUCTIONS])
  })

  test('schon komprimiert: nach dem Neustart passiert nichts', async ($, on) => {
    const { clock, seen } = engine(on)
    seen.store.set(ROUND, JSON.parse(saved({ phase: 'compacted', idleSince: 0 })))
    await $.session.start(DESKTOP)
    await clock.advance(180 * MIN)
    expect(seen.prompts).toEqual([])
    expect(seen.commands).toEqual([])
    expect(seen.compacts).toEqual([])
  })

  test('aus bleibt aus', async ($, on) => {
    const { clock, seen } = engine(on)
    seen.store.set(ROUND, JSON.parse(saved({ phase: 'active', idleSince: T0 - 80 * MIN, isOff: true })))
    await $.session.start(DESKTOP)
    await clock.advance(60 * MIN)
    expect(seen.prompts).toEqual([])
  })

  test('jeder Abschluss verlangt den echten Aufgabenstatus', async () => {
    for (const text of [CHECKPOINT_IDLE_TEXT, checkpointResumeText(60), checkpointContextText(95)]) {
      expect(text).toContain(TASK_STATUS_STEP)
    }
    expect(TASK_STATUS_STEP).toContain('Fertig heißt erledigt')
    expect(TASK_STATUS_STEP).toContain('zurückgestellt, mit Datum')
    expect(TASK_STATUS_STEP).toContain('in Atlas, falls dieses Projekt mit Atlas verbunden ist')
    expect(CHECKPOINT_IDLE_TEXT).toContain('Aufgaben in Atlas')
    expect(CHECKPOINT_TEST_TEXT).not.toContain(TASK_STATUS_STEP)
  })

  test('alte Runden anderer Sessions werden aufgeräumt', async ($, on) => {
    const { seen } = engine(on)
    seen.store.set('round:alt', { phase: 'active', idleSince: 1, savedAt: T0 - 8 * 24 * 60 * MIN })
    seen.store.set('round:frisch', { phase: 'active', idleSince: 1, savedAt: T0 - 60 * MIN })
    seen.store.set('anderes', 1)
    await $.session.start(DESKTOP)
    expect(seen.store.has('round:alt')).toBe(false)
    expect(seen.store.has('round:frisch')).toBe(true)
    expect(seen.store.has('anderes')).toBe(true)
  })

  test('Übernahme der Runde', async () => {
    expect(restoreRound(undefined, T0)).toBe(undefined)
    expect(restoreRound({ phase: 'active', idleSince: T0 - 80 * MIN, savedAt: T0 - 8 * 24 * 60 * MIN }, T0)).toBe(undefined)
    expect(restoreRound({ phase: 'active', idleSince: T0 - 20 * MIN, savedAt: T0 }, T0)?.owed).toBe(false)
    expect(restoreRound({ phase: 'active', idleSince: T0 - 50 * MIN, savedAt: T0 }, T0)?.owed).toBe(true)
    expect(restoreRound({ phase: 'compacting', idleSince: T0 - 60 * MIN, savedAt: T0 }, T0)).toEqual(
      expect.objectContaining({ phase: 'checkpoint', checkpointDone: true, reason: 'resume' }),
    )
  })
})
