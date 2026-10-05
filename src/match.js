// Regra de vitória: partida de 6 minutos; ganha quem tiver mais abates (K.O.
// dados em outros jogadores). Sem dependências, para poder ser testado no Node.
//
// Quem leva o crédito do abate é quem causou dano por último na vítima (até
// KILL_CREDIT segundos antes do nocaute): batida, ultimate, ou arremessar a
// vítima contra a parede/espinhos. Nocaute sem ninguém por perto só conta
// como morte.
//
// Sem servidor, o placar é calculado por todos a partir do mesmo dado: cada
// jogador manda no estado do carro "quantas vezes fui nocauteado por quem"
// (koBy). Os abates de X = soma de koBy[X] de todo mundo. Mensagem perdida se
// corrige na próxima, e quem entra no meio recebe o histórico inteiro.

export const MATCH_TIME = 360 // s (6 min)
export const KILL_CREDIT = 8  // s: dano até esse tempo antes do nocaute dá o abate

/** Mortes e "quem me nocauteou", do ponto de vista da vítima. */
export class KillTracker {
  constructor() {
    this.reset()
  }

  reset() {
    this.deaths = 0
    this.koBy = {}        // id de quem abateu -> quantas vezes
    this.assisters = []   // quem levou assistência no último abate sofrido
    this.asBy = {}        // id de quem ajudou (bateu em mim, outro abateu) -> quantas vezes
    this.xpBy = {}        // id de quem bateu -> XP que ele ganhou em mim (vira nível dele)
    this.koAt = {}        // id de quem me abateu -> instante do último abate dele
    this.lastHit = null   // { by, at }: último dano recebido
    this.hits = {}        // id -> instante do último dano recebido dele
  }

  /** Levei dano de `by` no instante `now` (s). */
  noteHit(by, now) {
    if (!by) return
    this.lastHit = { by, at: now }
    this.hits[by] = now
  }

  /** `by` ganhou `xp` (inteiro) em cima de mim: golpe ou bônus de abate. */
  noteXp(by, xp) {
    if (by && xp > 0) this.xpBy[by] = (this.xpBy[by] ?? 0) + xp
  }

  /** Segundos desde o último abate de `by` em mim (null = nunca me abateu). */
  sinceKoBy(by, now) {
    return by in this.koAt ? now - this.koAt[by] : null
  }

  /**
   * Fui nocauteado. Quem bateu por último leva o abate; quem também bateu
   * dentro da janela leva uma assistência.
   * @returns quem leva o abate (ou null: ninguém por perto); quem levou
   *   assistência fica em `assisters` (para o bônus de XP)
   */
  knockedOut(now) {
    this.deaths++
    this.assisters = []
    const hit = this.lastHit
    const hits = this.hits
    this.lastHit = null
    this.hits = {}
    if (!hit || now - hit.at > KILL_CREDIT) return null
    this.koBy[hit.by] = (this.koBy[hit.by] ?? 0) + 1
    this.koAt[hit.by] = now
    for (const [id, at] of Object.entries(hits)) {
      if (id !== hit.by && now - at <= KILL_CREDIT) {
        this.asBy[id] = (this.asBy[id] ?? 0) + 1
        this.assisters.push(id)
      }
    }
    return hit.by
  }
}

/**
 * Abates de cada um, somando o koBy de todos os jogadores.
 * @param {Iterable<{ koBy: Record<string, number> }>} records
 * @returns {Map<string, number>}
 */
export function tallyKills(records) {
  return tally(records, 'koBy')
}

/** XP ganho por cada um, somando o xpBy de todos os jogadores. */
export function tallyXp(records) {
  return tally(records, 'xpBy')
}

/** Assistências de cada um, somando o asBy de todos os jogadores. */
export function tallyAssists(records) {
  return tally(records, 'asBy')
}

function tally(records, field) {
  const total = new Map()
  for (const record of records) {
    for (const [id, n] of Object.entries(record[field] ?? {})) total.set(id, (total.get(id) ?? 0) + n)
  }
  return total
}

/**
 * Classificação: mais abates primeiro; empate decide por mais assistências e
 * depois por menos mortes.
 * @param {{ id: string, name: string, kills: number, assists?: number, deaths: number }[]} players
 */
export function standings(players) {
  const assists = (p) => p.assists ?? 0
  return [...players].sort((a, b) => b.kills - a.kills || assists(b) - assists(a) || a.deaths - b.deaths || a.name.localeCompare(b.name))
}

/**
 * Quem venceu: mais abates; empate decide por assistências; ainda empatado =
 * vitória dividida. Ninguém com abate: ninguém venceu.
 */
export function winners(ranked) {
  const top = ranked[0]
  if (!top || top.kills === 0) return []
  const tied = ranked.filter((p) => p.kills === top.kills)
  const bestAssists = Math.max(...tied.map((p) => p.assists ?? 0))
  return tied.filter((p) => (p.assists ?? 0) === bestAssists)
}

/** "4:59" */
export function formatClock(seconds) {
  const s = Math.max(0, Math.ceil(seconds))
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

/**
 * Diferença entre dois koBy: quem abateu a vítima desde o estado anterior
 * (para o kill feed). @returns lista de ids, um por abate novo
 */
export function newKills(before = {}, after = {}) {
  const out = []
  for (const [id, n] of Object.entries(after)) {
    for (let i = before[id] ?? 0; i < n; i++) out.push(id)
  }
  return out
}
