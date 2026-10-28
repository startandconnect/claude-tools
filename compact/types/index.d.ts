export type Context = {
  /** Eingabe-Tokens der letzten Antwort: so viel liest jede Nachricht. */
  tokens?: number
  /** Größe des Kontextfensters des Modells. */
  window: number
  percent?: number
}

export type Limit = {
  /** five_hour, seven_day oder spend_limit. */
  kind: string
  percentUsed: number
  resetsAt?: string
}

/**
 * Automatik für Session-Ende und Compact. active: normale Arbeit; checkpoint: Abschluss-Prompt
 * geschickt; compacting: Compact läuft; compacted: fertig, bis der nächste Prompt kommt.
 */
export type Auto = {
  phase: 'active' | 'checkpoint' | 'compacting' | 'compacted'
  /** Ende der letzten Antwort auf einen Prompt, der nicht von der Automatik kam. */
  idleSince: number
  /** idle: 50 min Ruhe; context: 95 %; resume: nach einem Neustart nachgeholt (Compact gleich danach). */
  reason?: 'idle' | 'context' | 'resume'
  /** Der Abschluss-Turn ist zu Ende. */
  checkpointDone: boolean
  /** /session-automatik schaltet sie für diese Session ab. */
  isOff: boolean
  /** Wann der Abschluss-Prompt geschickt wurde. */
  checkpointAt?: number
  /** Compacts, die in dieser Runde gescheitert sind. */
  failures?: number
  /** /session-automatik test: Abschluss nach 2 min, Compact nach 4 min. */
  isTest?: boolean
  /** Seit wann der laufende Compact angefordert ist. */
  compactingSince?: number
  /**
   * Wie der Compact ausgelöst wird: direkt ($.session.compact) oder als Befehl /compact
   * ($.command.run). In der Desktop-App (SDK) geht nur der Befehl.
   */
  via?: 'session' | 'command'
  /**
   * Die App hat den Prozess beendet, bevor Abschluss und Compact fertig waren. Beim
   * nächsten Start nachholen: sobald der Chat ruht, Abschluss-Prompt und gleich danach Compact.
   */
  owed?: boolean
}

/** Was der Mod je Session auf der Platte festhält, damit ein Neustart der App die Runde nicht verliert. */
export type Round = {
  phase: Auto['phase']
  idleSince: number
  reason?: Auto['reason']
  checkpointDone: boolean
  checkpointAt?: number
  isOff: boolean
  owed?: boolean
  savedAt: number
}

declare module 'claude-code' {
  interface PluginState {
    'compact': {
      context: Context | null
      limits: Limit[]
      /** Ende der letzten Antwort des Hauptchats; ab da läuft der Cache ab. */
      lastAnswerAt: number
      isRunning: boolean
      now: number
      isHidden: boolean
      auto: Auto
    }
  }
}
