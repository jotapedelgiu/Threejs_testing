// Estatísticas de fim de partida para conferir o balanceamento: K/D/A, KDA,
// abates e mortes por minuto, nível. Sem dependência de navegador (testável no
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
 *   levelTimesOf?: (id: string) => Record<number, number> }} opts
 */
export function buildStats(ranked, { seconds, levelOf = () => 1, xpOf = () => 0, levelTimesOf = () => ({}) }) {
  const minutes = Math.max(seconds, 1) / 60
  return ranked.map((p, i) => {
    const assists = p.assists ?? 0
    return {
      rank: i + 1,
      name: p.name,
      kills: p.kills,
      deaths: p.deaths,
      assists,
      kda: round(kda(p.kills, assists, p.deaths)),
      killsPerMin: round(p.kills / minutes),
      deathsPerMin: round(p.deaths / minutes),
      level: levelOf(p.id),
      xp: xpOf(p.id),
      secondsPerLevel: levelTimesOf(p.id),
    }
  })
}

const round = (n) => Math.round(n * 100) / 100

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
