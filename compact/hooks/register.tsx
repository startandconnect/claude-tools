import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, SessionContextUsage, SessionRateLimit } from 'claude-code'

import type { Auto, Limit } from '../types'
import {
  ATLAS_HINT,
  CHECKPOINT_IDLE_TEXT,
  CHECKPOINT_TEST_TEXT,
  CLOCK_STALE_MS,
  COMPACT_INSTRUCTIONS,
  COMPACT_MAX_FAILURES,
  COMPACT_TIMEOUT_MS,
  ROUND_PREFIX,
  ROUND_MAX_AGE_MS,
  appendLog,
  autoHint,
  bandOf,
  checkpointContextText,
  checkpointResumeText,
  isHeadlessRefusal,
  isOwnPrompt,
  nextStep,
  restoreRound,
  roundKey,
  roundOf,
} from './logic'
import type { Part } from './logic'

const context = atom({ plugin: 'compact', key: 'context' } as const, null)
const limits = atom({ plugin: 'compact', key: 'limits' } as const, [])
const lastAnswerAt = atom({ plugin: 'compact', key: 'lastAnswerAt' } as const, 0)
const isRunning = atom({ plugin: 'compact', key: 'isRunning' } as const, false)
const now = atom({ plugin: 'compact', key: 'now' } as const, 0)
const isHidden = atom({ plugin: 'compact', key: 'isHidden' } as const, false)
const AUTO_START: Auto = { phase: 'active', idleSince: 0, checkpointDone: false, isOff: false }
const auto = atom({ plugin: 'compact', key: 'auto' } as const, AUTO_START)

const ME = 'compact'

/** Die Automatik läuft in jeder Session; beim Start gesetzt. */
let isAutoHere = false
/** Seit wann ein Uhr-Schlag handelt (0: keiner). Verhindert, dass zwei gleichzeitig handeln. */
let actingSince = 0
/** Der letzte Uhr-Schlag. Bleibt er aus, wird die Uhr neu gestellt. */
let lastTickAt = 0
let timer: { cancel: () => void } | undefined
/** Das Protokoll dieser Session, je Zeile ein JSON-Objekt, nur im Speicher. */
let logLines: string[] = []
let lastHeartbeat = 0

type $ = EngineInterface

/** Der Mod beobachtet nur. Scheitert ein Hook, läuft das Ereignis trotzdem durch. */
const passThrough = <E, R>(_$: unknown, e: E, next: (e: E) => R): R => next(e)

async function takeUsage($: $, ctx: SessionContextUsage, rates: readonly SessionRateLimit[]): Promise<void> {
  await update($, context, () => ({ tokens: ctx.tokens, window: ctx.window, percent: ctx.percent }))
  const list: Limit[] = rates.map(r => ({ kind: r.kind, percentUsed: r.percentUsed, resetsAt: r.resetsAt }))
  // Ohne neue Meldung bleiben die alten Fenster stehen.
  if (list.length > 0) {
    await update($, limits, () => list)
  }
}

/** Merkt sich eine Zeile fürs Protokoll (nur im Speicher). */
async function log($: $, entry: Record<string, unknown>): Promise<void> {
  try {
    logLines = appendLog(logLines, { at: new Date(await $.clock.now()).toISOString(), ...entry })
  } catch {
    // Kein Protokoll ist besser als eine gestörte Automatik.
  }
}

/** Wartet höchstens ms auf p; danach 'timeout'. */
async function within<T>($: $, ms: number, p: Promise<T>): Promise<T | 'timeout'> {
  return Promise.race([p, $.clock.sleep(ms).then(() => 'timeout' as const)])
}

/**
 * Ändert die Runde und hält sie in $.store fest: Beendet die App den Prozess,
 * übernimmt der nächste Start die Runde, statt bei null anzufangen.
 */
async function setAuto($: $, fn: (v: Auto) => Auto): Promise<Auto> {
  const next = await update($, auto, fn)
  if (isAutoHere) await saveRound($, next).catch(() => undefined)

  return next
}

let lastRound = ''
async function saveRound($: $, a: Auto): Promise<void> {
  const round = roundOf(a, await $.clock.now())
  const signature = JSON.stringify({ ...round, savedAt: 0 })
  if (signature === lastRound) return
  await $.store.set(roundKey(await $.session.id()), round)
  lastRound = signature
}

/** Entfernt Runden, die seit einer Woche nicht mehr gespeichert wurden. */
async function pruneRounds($: $, at: number): Promise<void> {
  for (const key of await $.store.keys()) {
    if (!key.startsWith(ROUND_PREFIX)) continue
    const r = (await $.store.get(key)) as { savedAt?: number } | undefined
    if (typeof r?.savedAt !== 'number' || at - r.savedAt > ROUND_MAX_AGE_MS) await $.store.delete(key)
  }
}

/** Die gespeicherte Runde dieser Session, oder undefined. */
async function loadRound($: $): Promise<unknown> {
  try {
    return await $.store.get(roundKey(await $.session.id()))
  } catch {
    return undefined
  }
}

/** Stellt die Uhr (neu). Ein alter Timer wird vorher gestoppt. */
function startClock($: $, why: string): void {
  timer?.cancel()
  lastTickAt = Date.now()
  timer = $.clock.every(30_000, async () => {
    const tick = await $.clock.now()
    lastTickAt = tick
    await update($, now, () => tick)
    if (isAutoHere) await autoTick($, tick).catch(err => log($, { event: 'tick-error', error: String(err) }))
  })
  void log($, { event: 'clock', why })
}

/** Aus jedem Hook: Hat die Uhr zu lange nicht geschlagen, wird sie neu gestellt. */
async function keepClock($: $): Promise<void> {
  if (!isAutoHere || !timer) return
  const at = await $.clock.now()
  if (at - lastTickAt > CLOCK_STALE_MS) startClock($, `stale ${Math.round((at - lastTickAt) / 1000)} s`)
}

/** Ein Compact ist durch: Runde abschließen. Aus dem Ergebnis von $.session.compact oder aus dem session.compact-Hook. */
async function compactDone($: $, how: Record<string, unknown>): Promise<void> {
  const before = await read($, auto)
  await setAuto($, (v: Auto): Auto => ({
    ...v,
    phase: 'compacted',
    idleSince: 0,
    checkpointDone: false,
    reason: undefined,
    failures: 0,
    checkpointAt: undefined,
    compactingSince: undefined,
    owed: false,
    // Der Testmodus gilt für genau einen Durchlauf; danach wieder 50/55 min.
    isTest: false,
  }))
  if (before.phase === 'compacting') void $.ui.toast(before.isTest ? 'Test: Session komprimiert.' : 'Session gesichert und komprimiert.')
  await log($, { event: 'compact-done', was: before.phase, ...how })
}

async function compactFailed($: $, outcome: string): Promise<void> {
  const after = await setAuto($, (v: Auto): Auto =>
    v.phase === 'compacting' ? { ...v, phase: 'checkpoint', checkpointDone: true, compactingSince: undefined, failures: (v.failures ?? 0) + 1 } : v,
  )
  await log($, { event: 'compact-failed', outcome, failures: after.failures, via: after.via })
  if ((after.failures ?? 0) === COMPACT_MAX_FAILURES) {
    void $.ui.toast('Automatischer Compact scheitert. Bitte /compact eingeben (nicht /clear).')
  }
}

/**
 * Komprimiert die Session. Direkt geht es nur im Terminal; in der Desktop-App (SDK) lehnt die Engine
 * $.session.compact ab („runs inside a turn (a /compact prompt)“). Dort läuft es als Befehl /compact.
 */
async function compact($: $, a: Auto, at: number): Promise<void> {
  let via = a.via ?? 'session'
  if (a.phase === 'compacting') await compactFailed($, 'kein Compact angekommen')
  await setAuto($, (v: Auto): Auto => ({ ...v, phase: 'compacting', compactingSince: at, via }))
  await log($, { event: 'compact-start', via, checkpointDone: a.checkpointDone })
  if (via === 'session') {
    try {
      const done = await within($, COMPACT_TIMEOUT_MS, $.session.compact({ instructions: COMPACT_INSTRUCTIONS }))
      if (done === 'timeout') return compactFailed($, 'timeout')
      if (done.skip !== undefined) return compactFailed($, `skip: ${done.skip}`)

      return compactDone($, { via, tokensBefore: done.tokensBefore, tokensAfter: done.tokensAfter })
    } catch (err) {
      if (!isHeadlessRefusal(err)) return compactFailed($, `error: ${String(err)}`)
      via = 'command'
      await setAuto($, (v: Auto): Auto => ({ ...v, via }))
      await log($, { event: 'compact-via', via, why: String(err) })
    }
  }
  // Als Befehl /compact, wie vom Nutzer getippt (ein Prompt „/compact …“ lehnt die Engine ab). Fertig ist es,
  // wenn der session.compact-Hook das Compact sieht; bleibt es aus, kommt nach COMPACT_TIMEOUT_MS der nächste Versuch.
  try {
    await $.command.run({ command: 'compact', args: COMPACT_INSTRUCTIONS })
    await log($, { event: 'compact-command-sent' })
  } catch (err) {
    await compactFailed($, `command: ${String(err)}`)
  }
}

/** Ein Uhr-Schlag der Automatik: Abschluss-Prompt schicken oder komprimieren. */
async function autoTick($: $, at: number): Promise<void> {
  if (actingSince > 0) {
    // Ein hängender Schlag darf die Automatik nicht für immer sperren.
    if (at - actingSince < COMPACT_TIMEOUT_MS + 60_000) return
    await log($, { event: 'acting-stale', since: new Date(actingSince).toISOString() })
  }
  actingSince = at
  try {
    const a = await read($, auto)
    const ctx = await read($, context)
    const running = await read($, isRunning)
    const box = await within($, 5_000, $.prompt.read())
    const draft = box !== 'timeout' && box.text.trim().length > 0
    const step = nextStep(a, at, running, ctx?.percent, draft)
    if (step !== 'none' || at - lastHeartbeat >= 10 * 60_000) {
      lastHeartbeat = at
      await log($, { event: 'tick', step, phase: a.phase, idleSince: a.idleSince, checkpointDone: a.checkpointDone, running, draft, percent: ctx?.percent, isTest: a.isTest, failures: a.failures ?? 0, promptRead: box === 'timeout' ? 'timeout' : 'ok' })
    }
    if (step === 'checkpoint-idle' || step === 'checkpoint-context' || step === 'checkpoint-resume') {
      const reason = step === 'checkpoint-idle' ? 'idle' : step === 'checkpoint-context' ? 'context' : 'resume'
      await setAuto($, (v: Auto): Auto => ({ ...v, phase: 'checkpoint', reason, checkpointDone: false, checkpointAt: at }))
      const text =
        reason === 'context'
          ? checkpointContextText(Math.round(ctx?.percent ?? 0))
          : reason === 'resume'
            ? checkpointResumeText(Math.max(0, Math.floor((at - (a.idleSince || at)) / 60_000)))
            : a.isTest
              ? CHECKPOINT_TEST_TEXT
              : CHECKPOINT_IDLE_TEXT
      void $.prompt
        .submit({ text })
        .then(() => log($, { event: 'checkpoint-sent', reason }))
        .catch(async err => {
          await log($, { event: 'checkpoint-error', error: String(err) })
          await setAuto($, (v: Auto): Auto => ({ ...v, phase: 'active' }))
        })
    } else if (step === 'compact') {
      await compact($, a, at)
    }
  } finally {
    actingSince = 0
  }
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const started = await next(e)
    const at = await $.clock.now()
    await update($, now, () => at)
    try {
      const usage = await $.session.usage()
      await takeUsage($, usage.context, usage.rateLimits)
    } catch {
      // Noch keine Zahlen: das Band wartet auf die erste Antwort.
    }
    await $.command.register({
      name: 'cache-anzeige',
      description: 'Blendet das Band mit Kontext, Cache und Nutzung ein oder aus',
    })
    // Nur die Uhr fürs Band; es wird nichts abgefragt und nichts gesendet.
    await $.command.register({
      name: 'session-automatik',
      description: 'Zeigt den Stand der Session-Automatik (läuft von selbst); test, normal, aus, an',
    })
    isAutoHere = true
    // Die Uhr fürs Band und für die Automatik. Gesendet wird nur der eigene Abschluss-Prompt.
    startClock($, 'session.start')
    if (isAutoHere) {
      // Hat die App den Prozess beendet, übernimmt der neue die gespeicherte Runde.
      await pruneRounds($, at).catch(() => undefined)
      // Nur in einem frischen Prozess: nach einem Neuladen des Mods hält $.state die Runde noch.
      const current = await read($, auto)
      const isFresh = current.phase === 'active' && current.idleSince === 0 && current.checkpointAt === undefined
      const saved = isFresh ? await loadRound($) : undefined
      const restored = restoreRound(saved, at)
      // Ohne Terminal (Desktop-App, SDK) nimmt die Engine $.session.compact nicht an: gleich /compact als Befehl.
      const a = await setAuto($, (v: Auto): Auto => ({ ...v, ...restored, isTest: false, via: v.via ?? (e.isInteractive ? 'session' : 'command') }))
      await log($, { event: 'start', cwd: e.cwd, surface: e.surface, isInteractive: e.isInteractive, auto: a, ...(restored ? { restored: saved } : {}) })
    }

    return started
  })

  on('command.run', { command: 'session-automatik' }, async ($, e) => {
    const arg = (e.args ?? '').trim()
    if (arg === 'test' || arg === 'normal') {
      const isTest = arg === 'test'
      const at = await $.clock.now()
      // Der Test zählt ab jetzt, auch wenn die letzte Antwort länger her ist.
      await setAuto($, (v: Auto): Auto => ({ ...v, isTest, isOff: false, failures: 0, ...(isTest && v.phase === 'active' ? { idleSince: at } : {}) }))
      await log($, { event: 'mode', mode: arg })

      return {
        text: isTest
          ? 'Testmodus: Abschluss-Prompt nach 2 min Ruhe, Compact gleich nach der Antwort darauf. Bis zum Toast nichts schreiben. Zurück mit /session-automatik normal.'
          : 'Normalbetrieb: Abschluss nach 50 min Ruhe, Compact nach 55 min oder bei 95 % Kontext.',
      }
    }
    if (arg === 'aus' || arg === 'an') {
      const a = await setAuto($, (v: Auto): Auto => ({ ...v, isOff: arg === 'aus' }))
      await log($, { event: 'mode', mode: arg })

      return {
        text: a.isOff
          ? 'Automatischer Session-Abschluss und Compact für diese Session aus. Wieder an mit /session-automatik an.'
          : 'Automatischer Session-Abschluss (50 min Ruhe) und Compact (55 min oder 95 % Kontext) an.',
      }
    }
    // Ohne Zusatz nur der Stand: die Automatik läuft in ~/claude von selbst, der Befehl schaltet nichts um.
    const a = await read($, auto)
    const at = await $.clock.now()
    const state = a.isOff
        ? 'aus für diese Session'
        : `an${a.isTest ? ' (Test: 2/4 min)' : ' (50/55 min)'}, Phase ${a.phase}${a.idleSince > 0 && a.phase === 'active' ? `, ruhig seit ${Math.floor((at - a.idleSince) / 60_000)} min` : ''}`

    return {
      text: `Session-Automatik: ${state}. Uhr zuletzt vor ${Math.round((at - lastTickAt) / 1000)} s. Letzte Ereignisse: ${logLines.slice(-3).map(l => (JSON.parse(l) as { event?: string }).event).join(', ') || '(noch keine)'}. Befehle: /session-automatik test | normal | aus | an. ${ATLAS_HINT}`,
    }
  })

  // Jeder Prompt, der nicht von der Automatik selbst kommt, ist Arbeit: die Automatik beginnt von vorn.
  // Auch ein nach einem Neustart nachzuholender Abschluss (owed) entfällt: der Chat ist wieder in Gebrauch,
  // nach der Antwort ist der Cache warm, und die normale Uhr (50/55 min) übernimmt.
  // Den eigenen Abschluss-Prompt sieht dieser Hook auch (die Engine lässt nur den aufrufenden Hook aus,
  // und der Aufruf kommt aus der Uhr): er darf die Runde nicht zurücksetzen, sonst kommt nie ein Compact.
  on('prompt.submit', async ($, e, next) => {
    if (!isOwnPrompt(e.origin, ME)) {
      const before = await read($, auto).catch(() => undefined)
      await setAuto($, (v: Auto): Auto =>
        v.phase === 'compacting' ? { ...v, owed: false } : { ...v, phase: 'active', checkpointDone: false, reason: undefined, checkpointAt: undefined, failures: 0, owed: false },
      ).catch(() => undefined)
      if (isAutoHere && before && before.phase !== 'active') void log($, { event: 'reset', by: e.origin?.kind ?? 'unknown', was: before.phase })
    }
    await keepClock($).catch(() => undefined)

    return next(e)
  }).catch(passThrough)

  // Jedes Compact (von Hand, Engine, Automatik) schließt die Runde ab.
  on('session.compact', async ($, e, next) => {
    const result = await next(e)
    if (e.agentId === undefined && e.trigger !== 'precompute' && result.skip === undefined) {
      await compactDone($, { trigger: e.trigger, tokensBefore: result.tokensBefore, tokensAfter: result.tokensAfter }).catch(() => undefined)
    }

    return result
  }).catch(passThrough)

  // Nur fürs Protokoll: Warum der Prozess endet (die App beendet ruhende Chats bei Speicherdruck).
  on('session.end', async ($, e, next) => {
    if (isAutoHere) {
      const a = await read($, auto).catch(() => undefined)
      await within($, 300, log($, { event: 'end', reason: e.reason, phase: a?.phase, idleSince: a?.idleSince }))
    }

    return next(e)
  }).catch(passThrough)

  on('command.run', { command: 'cache-anzeige' }, async $ => {
    const hidden = await update($, isHidden, v => !v)

    return { text: hidden ? 'Band ausgeblendet.' : 'Band eingeblendet.' }
  })

  on('session.measure', async ($, e, next) => {
    const measured = await next(e)
    await takeUsage($, e.context, e.rateLimits).catch(() => undefined)

    return measured
  }).catch(passThrough)

  on('turn.start', async ($, e, next) => {
    if (e.agentId === undefined) await update($, isRunning, () => true).catch(() => undefined)

    return next(e)
  }).catch(passThrough)

  // Der Cache läuft ab dem Ende der letzten Antwort des Hauptchats.
  on('turn.complete', async ($, e, next) => {
    const done = await next(e)
    if (e.agentId === undefined) {
      const at = await $.clock.now()
      await update($, lastAnswerAt, () => at)
      await update($, now, () => at)
      await update($, isRunning, () => false)
      // Ruhe zählt ab dem Ende einer echten Antwort; der Abschluss-Turn zählt nicht als Arbeit.
      const a = await setAuto($, (v: Auto): Auto =>
        v.phase === 'active' ? { ...v, idleSince: at } : v.phase === 'checkpoint' ? { ...v, checkpointDone: true } : v,
      )
      if (isAutoHere && a.phase !== 'active') void log($, { event: 'turn-complete', phase: a.phase, checkpointDone: a.checkpointDone, reason: e.reason })
      await keepClock($).catch(() => undefined)
    }

    return done
  }).catch(passThrough)

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey || (await read($, isHidden))) return next(e)
    const band = bandOf(
      await read($, context),
      await read($, limits),
      await read($, lastAnswerAt),
      await read($, isRunning),
      (await read($, now)) || Date.now(),
    )
    const hint = isAutoHere ? autoHint(await read($, auto), (await read($, now)) || Date.now()) : undefined
    const parts = [band.context, band.cache, hint, ...band.limits].filter((p): p is Part => p !== undefined)
    if (parts.length === 0) return next(e)
    const { Box, Text } = $.ui.resolve(e)

    return (
      <Box flexDirection="row" flexWrap="wrap">
        {parts.map((part, i) => (
          <Text key={`part:${i}`} dimColor={part.tone === 'normal'} color={part.tone === 'warn' ? 'warning' : undefined}>
            {i > 0 ? ' · ' : ''}
            {part.text}
          </Text>
        ))}
      </Box>
    )
  })
}
