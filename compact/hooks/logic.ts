// Reine Logik ohne $: Restzeit des Caches, Zahlen und Texte für das Band.

import type { Auto, Context, Limit, Round } from '../types'

const MINUTE = 60_000

/**
 * Wie lange der Cache nach der letzten Antwort hält. Im Abo (die Antwort meldet
 * Nutzungsfenster) eine Stunde, mit API-Schlüssel fünf Minuten.
 */
export function cacheTtlMs(limits: readonly Limit[]): number {
  return limits.length > 0 ? 60 * MINUTE : 5 * MINUTE
}

/** Restzeit in ms, 0, wenn der Cache kalt ist. */
export function cacheLeftMs(lastAnswerAt: number, now: number, ttlMs: number): number {
  if (lastAnswerAt <= 0) return 0

  return Math.max(0, lastAnswerAt + ttlMs - now)
}

/** 84300 → „84 Tsd.“, 1200000 → „1,2 Mio.“ */
export function tokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1).replace('.', ',')} Mio.`
  if (n >= 1_000) return `${Math.round(n / 1_000)} Tsd.`

  return String(n)
}

/** Restzeit als „47 min“ oder „unter 1 min“. */
export function minutes(ms: number): string {
  const m = Math.floor(ms / MINUTE)

  return m < 1 ? 'unter 1 min' : `${m} min`
}

const LIMIT_NAMES: Record<string, string> = {
  five_hour: '5 Std.',
  seven_day: '7 Tage',
  spend_limit: 'Budget',
}

export function limitText(limit: Limit): string {
  const name = LIMIT_NAMES[limit.kind] ?? limit.kind
  const value = String(limit.percentUsed).replace('.', ',')

  return `${name} ${value} %`
}

/** Ab hier lohnt ein neuer Chat oder eine Übergabe. */
export const CONTEXT_WARN = 70
/** Ab hier warnt das Band, dass der Cache bald kalt wird. */
export const CACHE_WARN_MS = 10 * MINUTE
/** Ab hier warnt das Band bei einem Nutzungsfenster. */
export const LIMIT_WARN = 80

export type Tone = 'normal' | 'warn'

export type Part = { text: string; tone: Tone }

export type Band = {
  context?: Part
  cache?: Part
  limits: Part[]
}

/** Was das Band zeigt. Ohne erste Antwort gibt es nichts zu zeigen. */
export function bandOf(
  context: Context | null,
  limits: readonly Limit[],
  lastAnswerAt: number,
  isRunning: boolean,
  now: number,
): Band {
  const band: Band = { limits: [] }
  if (context?.tokens !== undefined) {
    const percent = context.percent ?? Math.round((context.tokens / context.window) * 100)
    band.context = {
      text: `Kontext ${percent} % (${tokens(context.tokens)} von ${tokens(context.window)})${
        percent >= CONTEXT_WARN ? ', neuer Chat lohnt sich bald' : ''
      }`,
      tone: percent >= CONTEXT_WARN ? 'warn' : 'normal',
    }
  }
  if (isRunning) {
    band.cache = { text: 'Cache warm (läuft gerade)', tone: 'normal' }
  } else if (lastAnswerAt > 0) {
    const left = cacheLeftMs(lastAnswerAt, now, cacheTtlMs(limits))
    const size = context?.tokens !== undefined ? ` ${tokens(context.tokens)} Tokens` : ''
    band.cache =
      left > 0
        ? {
            text: `Cache warm noch ${minutes(left)}`,
            tone: left <= CACHE_WARN_MS ? 'warn' : 'normal',
          }
        : { text: `Cache kalt: die nächste Nachricht liest${size} neu ein`, tone: 'warn' }
  }
  band.limits = limits
    .filter(l => l.kind === 'five_hour' || l.kind === 'seven_day' || l.kind === 'spend_limit')
    .map(l => ({ text: limitText(l), tone: l.percentUsed >= LIMIT_WARN ? 'warn' : 'normal' }))

  return band
}

// ---- Session-Ende und Compact automatisch ----

/** Nach so viel Ruhe sichert der Chat seinen Stand (Abschluss-Prompt). */
export const CHECKPOINT_AFTER_MS = 50 * MINUTE
/** Nach so viel Ruhe komprimiert er sich (Compact, kein Clear). Der Cache hält 60 min. */
export const COMPACT_AFTER_MS = 55 * MINUTE
/** Ab diesem Kontextstand: sichern, dann sofort komprimieren. */
export const CONTEXT_LIMIT = 95

/** Die Zeiten der Automatik; im Testmodus (/session-automatik test) kurz. */
export type Timing = { checkpointMs: number; compactMs: number }
export const NORMAL: Timing = { checkpointMs: CHECKPOINT_AFTER_MS, compactMs: COMPACT_AFTER_MS }
/** Im Test kommt der Compact gleich nach der Antwort auf den Abschluss-Prompt. */
export const TEST: Timing = { checkpointMs: 2 * MINUTE, compactMs: 2 * MINUTE }

export function timingOf(a: Auto): Timing {
  return a.isTest ? TEST : NORMAL
}

/**
 * Kommt das Ende des Abschluss-Turns nie an (turn.complete verpasst), wird trotzdem
 * komprimiert, sobald so viel Zeit seit dem Abschluss-Prompt vergangen ist.
 */
export const CHECKPOINT_STALE_MS = 15 * MINUTE
/** So lange darf ein Compact dauern, bevor er als hängend gilt und neu versucht wird. */
export const COMPACT_TIMEOUT_MS = 10 * MINUTE
/** Nach so vielen gescheiterten Compacts zeigt der Mod einen Hinweis. */
export const COMPACT_MAX_FAILURES = 3
/** Hat die Uhr so lange nicht geschlagen, wird sie neu gestellt. */
export const CLOCK_STALE_MS = 3 * MINUTE

/** So viele Zeilen behält das Protokoll je Session (nur im Speicher, für /session-automatik). */
export const LOG_KEEP = 200

export type Step = 'none' | 'checkpoint-idle' | 'checkpoint-context' | 'checkpoint-resume' | 'compact'

/** Was die Automatik jetzt tun soll. Reine Entscheidung, ohne $. */
export function nextStep(a: Auto, now: number, isRunning: boolean, percent: number | undefined, hasDraft: boolean): Step {
  if (a.isOff || isRunning) return 'none'
  const t = timingOf(a)
  if (a.phase === 'active') {
    if ((percent ?? 0) >= CONTEXT_LIMIT) return 'checkpoint-context'
    // Nach einem Neustart nachholen, was der beendete Prozess nicht mehr geschafft hat.
    if (a.owed && !hasDraft) return 'checkpoint-resume'
    if (!hasDraft && a.idleSince > 0 && now - a.idleSince >= t.checkpointMs) return 'checkpoint-idle'

    return 'none'
  }
  if (a.phase === 'checkpoint') {
    if (a.checkpointDone) {
      if (a.reason === 'context' || a.reason === 'resume') return 'compact'
      if (!hasDraft && now - a.idleSince >= t.compactMs) return 'compact'
    } else if ((a.checkpointAt ?? 0) > 0 && now - (a.checkpointAt ?? 0) >= CHECKPOINT_STALE_MS) {
      return 'compact'
    }
  }
  // Ein angeforderter Compact, der nie ankam: noch einmal.
  if (a.phase === 'compacting' && (a.compactingSince ?? 0) > 0 && now - (a.compactingSince ?? 0) >= COMPACT_TIMEOUT_MS) {
    return 'compact'
  }

  return 'none'
}

/** Unter diesem Schlüssel hält der Mod je Session die Runde in `$.store` fest. */
export const ROUND_PREFIX = 'round:'
export function roundKey(sessionId: string): string {
  return `${ROUND_PREFIX}${sessionId}`
}

/** Runden, die so lange nicht mehr gespeichert wurden, gelten als erledigt und werden nicht mehr nachgeholt. */
export const ROUND_MAX_AGE_MS = 7 * 24 * 60 * MINUTE

/** Die Runde zum Speichern. */
export function roundOf(a: Auto, now: number): Round {
  return {
    phase: a.phase,
    idleSince: a.idleSince,
    reason: a.reason,
    checkpointDone: a.checkpointDone,
    checkpointAt: a.checkpointAt,
    isOff: a.isOff,
    owed: a.owed,
    savedAt: now,
  }
}

/**
 * Was beim Start einer Session aus der gespeicherten Runde wird. Die Desktop-App beendet ruhende
 * Chat-Prozesse bei Speicherdruck schon nach wenigen Minuten Ruhe, damit stirbt die Uhr. Undefined: nichts zu übernehmen.
 *
 * - compacted: bleibt erledigt.
 * - active mit Ruhe: die Uhr läuft ab der alten Ruhe weiter. Ist der Abschluss schon fällig, wird er
 *   nachgeholt (owed), mit Compact gleich danach. Kommt zuerst ein neuer Prompt, entfällt das: der Chat ist
 *   wieder in Gebrauch, und die normale Uhr beginnt nach der Antwort von vorn.
 * - checkpoint ohne Ende des Abschluss-Turns (Prozess mitten im Abschluss beendet): Abschluss noch einmal.
 * - checkpoint fertig oder compacting: der Compact steht noch aus.
 */
export function restoreRound(saved: unknown, now: number, t: Timing = NORMAL): Partial<Auto> | undefined {
  if (!saved || typeof saved !== 'object') return undefined
  const r = saved as Partial<Round>
  if (typeof r.phase !== 'string' || typeof r.idleSince !== 'number') return undefined
  if (typeof r.savedAt === 'number' && now - r.savedAt > ROUND_MAX_AGE_MS) return undefined
  const base = { isOff: r.isOff === true, failures: 0, compactingSince: undefined, checkpointAt: undefined }
  if (r.phase === 'compacted') return { ...base, phase: 'compacted', idleSince: 0, checkpointDone: false, reason: undefined, owed: false }
  if (r.phase === 'compacting' || (r.phase === 'checkpoint' && r.checkpointDone)) {
    return { ...base, phase: 'checkpoint', idleSince: r.idleSince, checkpointDone: true, reason: 'resume', owed: true }
  }
  if (r.phase === 'checkpoint' || r.phase === 'active') {
    if (r.idleSince <= 0 && r.phase === 'active') return { ...base, phase: 'active', idleSince: 0, checkpointDone: false, owed: r.owed === true }
    const isDue = r.phase === 'checkpoint' || r.owed === true || now - r.idleSince >= t.checkpointMs

    return { ...base, phase: 'active', idleSince: r.idleSince, checkpointDone: false, reason: undefined, owed: isDue }
  }

  return undefined
}

/** Lehnt die Engine $.session.compact ab, weil der Chat in der Desktop-App (SDK) läuft? */
export function isHeadlessRefusal(err: unknown): boolean {
  return /headless|not available/i.test(String(err))
}

/** Ist dieser Prompt der eigene Abschluss-Prompt des Mods? Der zählt nicht als Arbeit. */
export function isOwnPrompt(origin: { kind: string; name?: string } | undefined, plugin: string): boolean {
  return origin?.kind === 'plugin' && origin.name === plugin
}

/** Hängt eine Zeile ans Protokoll und behält die letzten LOG_KEEP. */
export function appendLog(lines: readonly string[], entry: Record<string, unknown>): string[] {
  return [...lines, JSON.stringify(entry)].slice(-LOG_KEEP)
}

/** Pflichtschritt in jedem Abschluss: Aufgaben nicht nur beschreiben, sondern abschließen. */
export const TASK_STATUS_STEP =
  'Pflicht: Setz jetzt den Status jeder Aufgabe dieser Session auf den echten Stand, in Atlas, falls dieses Projekt mit Atlas verbunden ist, sonst dort, wo es Aufgaben führt. ' +
  'Fertig heißt erledigt, ohne weitere Abnahme. Was nicht heute dran ist, wird zurückgestellt, mit Datum. ' +
  'Als in Arbeit bleibt nur, woran du sofort weiterarbeitest. Ausnahmen: Sicherheit, Kundendaten, Geld, Produktion, Nachrichten nach außen. ' +
  'Dokumentieren allein reicht nicht. '

/** Was der Chat vor jedem Compact sichert. */
const SAVE_STATE =
  'Sichere jetzt den Stand dieser Session, damit nach dem Compact nichts fehlt: was erledigt ist, was offen ist, ' +
  'die nächsten Schritte und wichtige Entscheidungen mit Wortlaut. Ist dieses Projekt mit Atlas verbunden, gehört der Stand an die Aufgaben in Atlas; ' +
  'sonst dorthin, wo das Projekt so etwas festhält (Aufgaben, Tickets, Notizen, Projektdateien). '

/** Hinweis für /session-automatik: wohin der gesicherte Stand am besten fließt. */
export const ATLAS_HINT =
  'Der Stand landet in Atlas, falls dein Projekt verbunden ist, sonst in den Aufgaben und Notizen des Projekts. Atlas: https://startandconnect.com/atlas'

export const CHECKPOINT_IDLE_TEXT =
  'Automatischer Session-Abschluss nach 50 Minuten Ruhe (Mod compact). ' +
  SAVE_STATE +
  TASK_STATUS_STEP +
  'Fang nichts Neues an und stell keine Rückfragen. Laufende Hintergrund-Prozesse lässt du laufen. ' +
  'In 5 Minuten komprimiert sich der Chat automatisch (Compact, kein Clear).'

export const CHECKPOINT_TEST_TEXT =
  'Testlauf der Session-Automatik (/session-automatik test): Antworte nur mit einem Satz, dass der Abschluss-Prompt angekommen ist, ' +
  'und tu sonst nichts. Gleich nach deiner Antwort komprimiert sich der Chat automatisch (Compact, kein Clear).'

export function checkpointResumeText(idleMinutes: number): string {
  return (
    `Automatischer Session-Abschluss, nachgeholt (Mod compact): Die App hatte diesen Chat nach ${idleMinutes} Minuten Ruhe beendet, ` +
    'bevor Abschluss und Compact liefen. ' +
    SAVE_STATE +
    TASK_STATUS_STEP +
    'Stell keine Rückfragen, laufende Hintergrund-Prozesse lässt du laufen. ' +
    'Gleich nach deiner Antwort komprimiert sich der Chat automatisch (Compact, kein Clear); danach machst du mit dem gesicherten Stand weiter.'
  )
}

export function checkpointContextText(percent: number): string {
  return (
    `Kontext bei ${percent} % (Grenze ${CONTEXT_LIMIT} %, Mod compact). ` +
    SAVE_STATE +
    TASK_STATUS_STEP +
    'Danach komprimiert sich der Chat automatisch (Compact, kein Clear); danach machst du mit dem gesicherten Stand weiter.'
  )
}

export const COMPACT_INSTRUCTIONS =
  'Behalte: die Aufgaben dieser Session mit Status und nächstem Schritt, offene Anfragen und worauf sie warten, ' +
  'laufende Hintergrund-Prozesse (Befehl, ID, worauf sie warten), letzte Absprachen und Entscheidungen des Nutzers mit Wortlaut, ' +
  'ob die Session bewusst beendet wurde oder weiterläuft.'

/** Für das Band: Minuten bis zum automatischen Abschluss in den letzten 10 Minuten, oder ein gescheiterter Compact. */
export function autoHint(a: Auto, now: number): Part | undefined {
  if (a.isOff) return undefined
  if ((a.failures ?? 0) >= COMPACT_MAX_FAILURES) {
    return { text: 'Automatischer Compact gescheitert: bitte /compact', tone: 'warn' }
  }
  if (a.phase === 'checkpoint' && a.checkpointDone) {
    const due = a.reason === 'context' || a.reason === 'resume' ? 0 : a.idleSince + timingOf(a).compactMs - now

    return { text: due > MINUTE ? `Compact in ${minutes(due)}, bitte nichts schreiben` : 'Compact gleich, bitte nichts schreiben', tone: 'warn' }
  }
  if (a.phase === 'compacting') return { text: 'Compact läuft', tone: 'warn' }
  if (a.phase !== 'active' || a.idleSince <= 0) return undefined
  const left = a.idleSince + timingOf(a).checkpointMs - now
  if (left > 10 * MINUTE || left <= 0) return undefined

  return { text: `Session-Abschluss in ${minutes(left)}${a.isTest ? ' (Test)' : ''}`, tone: 'warn' }
}
