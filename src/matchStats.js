// Estatísticas de fim de partida para conferir o balanceamento: K/D/A, KDA,
// abates e mortes por minuto, nível, XP por minuto e, para cada nível em que o
// jogador esteve: tempo, vida máxima, dano de cada batida, dano causado e dano
// recebido. Sem dependência de navegador (testável no
// Node). Só no `npm run dev` o main.js manda o relatório para a pasta
// match-stats/ (plugin do vite.config.js).

/** KDA = (abates + assistências) / mortes; sem mortes vale abates + assistências. */
export function kda(kills, assists, deaths) {
  return (kills + assists) / Math.max(1, deaths)
}

/**
 * Uma linha por jogador, na ordem do placar.
 * @param {{ id: string, name: string, kills: number, assists?: number, deaths: number }[]} ranked
 * @param {{ seconds: number, levelOf?: (id: string) => number, xpOf?: (id: string) => number,
 *   levelTimesOf?: (id: string) => Record<number, number>,
 *   xpByMinuteOf?: (id: string) => number[],
 *   dealtOf?: (id: string) => Record<number, number>, takenOf?: (id: string) => Record<number, number>,
 *   hpAt?: (level: number) => number, hitDamageAt?: (level: number) => object }} opts
 *   dealtOf/takenOf: dano causado/recebido por nível do próprio jogador
 */
export function buildStats(ranked, {
  seconds, levelOf = () => 1, xpOf = () => 0, levelTimesOf = () => ({}), xpByMinuteOf = () => [],
  dealtOf = () => ({}), takenOf = () => ({}), hpAt = () => null, hitDamageAt = () => null,
}) {
  const minutes = Math.max(seconds, 1) / 60
  return ranked.map((p, i) => {
    const assists = p.assists ?? 0
    const level = levelOf(p.id)
    const times = levelTimesOf(p.id), dealt = dealtOf(p.id), taken = takenOf(p.id)
    const sum = (o) => Object.values(o).reduce((n, v) => n + v, 0)
    return {
      rank: i + 1,
      name: p.name,
      kills: p.kills,
      deaths: p.deaths,
      assists,
      kda: round(kda(p.kills, assists, p.deaths)),
      killsPerMin: round(p.kills / minutes),
      deathsPerMin: round(p.deaths / minutes),
      level,
      xp: xpOf(p.id),
      xpPerMin: round(xpOf(p.id) / minutes),
      xpByMinute: xpByMinuteOf(p.id), // XP ganho em cada minuto de jogo (o último pode ser parcial)
      damageDealt: sum(dealt),
      damageTaken: sum(taken),
      secondsPerLevel: times,
      levels: levelDetails([...Object.keys(times), ...Object.keys(dealt), ...Object.keys(taken), level], { times, dealt, taken, hpAt, hitDamageAt }),
    }
  })
}

const round = (n) => Math.round(n * 100) / 100

/**
 * Um bloco por nível em que o jogador esteve: segundos, vida máxima, dano das
 * batidas (com o bônus do nível), dano causado e dano recebido nele.
 */
function levelDetails(keys, { times, dealt, taken, hpAt, hitDamageAt }) {
  const out = {}
  for (const level of [...new Set(keys.map(Number))].sort((a, b) => a - b)) {
    out[level] = {
      seconds: times[level] ?? 0,
      maxHp: hpAt(level),
      hitDamage: hitDamageAt(level),
      damageDealt: dealt[level] ?? 0,
      damageTaken: taken[level] ?? 0,
    }
  }
  return out
}

/**
 * XP ganho minuto a minuto. `update` é chamado a cada passo com o XP acumulado
 * e o tempo de partida; quem sai da partida para de ser atualizado (o XP dele
 * fica parado).
 */
export class XpTimeline {
  constructor() {
    this.entries = new Map() // id -> { minute, xp, marks }; marks[i] = XP acumulado ao fim do minuto i + 1
  }

  reset() {
    this.entries.clear()
  }

  update(id, xp, now) {
    const minute = Math.floor(now / 60)
    let e = this.entries.get(id)
    if (!e) {
      e = { minute: 0, xp: 0, marks: [] }
      this.entries.set(id, e)
    }
    while (e.minute < minute) { // virou o minuto: fecha com o XP de antes desta amostra
      e.marks.push(e.xp)
      e.minute++
    }
    e.xp = xp
  }

  /** XP ganho em cada minuto, do primeiro até o último visto. */
  perMinute(id) {
    const e = this.entries.get(id)
    if (!e) return []
    const total = [...e.marks, e.xp]
    return total.map((xp, i) => xp - (total[i - 1] ?? 0))
  }
}

/**
 * Quanto tempo (s) cada jogador ficou em cada nível. `update` é chamado a cada
 * passo com o nível atual e o tempo de partida; quem sai da partida para de
 * ser atualizado e o tempo dele para de contar.
 */
export class LevelTimer {
  constructor() {
    this.entries = new Map() // id -> { level, since, last, times }
  }

  reset() {
    this.entries.clear()
  }

  update(id, level, now) {
    const e = this.entries.get(id)
    if (!e) {
      this.entries.set(id, { level, since: now, last: now, times: {} })
      return
    }
    if (level !== e.level) {
      e.times[e.level] = (e.times[e.level] ?? 0) + (now - e.since)
      e.level = level
      e.since = now
    }
    e.last = now
  }

  /** { nível: segundos } até o último instante em que o jogador foi visto. */
  timesOf(id) {
    const e = this.entries.get(id)
    if (!e) return {}
    const times = { ...e.times, [e.level]: (e.times[e.level] ?? 0) + (e.last - e.since) }
    return Object.fromEntries(Object.entries(times).map(([lv, t]) => [lv, round(t)]))
  }
}

/** Relatório da partida: jogadores + totais (e o balanceamento usado, para comparar partidas). */
export function buildReport(stats, { seconds, balance = {} }) {
  const sum = (key) => stats.reduce((n, r) => n + r[key], 0)
  const deaths = sum('deaths')
  return {
    date: new Date().toISOString(),
    matchSeconds: Math.round(seconds),
    balance,
    totals: {
      players: stats.length,
      kills: sum('kills'),
      deaths,
      assists: sum('assists'),
      deathsPerMin: round(deaths / (Math.max(seconds, 1) / 60)),
      avgSecondsBetweenDeaths: deaths ? round(seconds / deaths) : null,
    },
    players: stats,
  }
}
