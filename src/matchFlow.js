// Extraído do main.js (seção "Partida: relógio, placar e fim"). As regras continuam as mesmas; o que ainda mora
// no main.js (carro, rede, HUD...) chega por `ctx` (getters/setters ligados às variáveis do main.js).
import { MATCH_TIME, standings, tallyAssists, tallyDealtByLevel, tallyKills, tallyXp, winners } from './match.js'
import { buildReport, buildStats } from './matchStats.js'
import { damageScale, maxHealthFor, scaleDamage } from './progression.js'
import { newLayout } from './layout.js'

export function createMatchFlow(ctx) {
  // Abates de todos: soma o "quem me nocauteou" de todo mundo (inclusive de
  // quem já saiu)
  function currentKills() {
    return tallyKills([ctx.kills, ...ctx.remotes.values(), ...ctx.departed.values()])
  }

  // XP ganho por todos (base do nível)
  function currentXp() {
    return tallyXp([ctx.kills, ...ctx.remotes.values(), ...ctx.departed.values()])
  }

  function currentAssists() {
    return tallyAssists([ctx.kills, ...ctx.remotes.values(), ...ctx.departed.values()])
  }

  // Passo fixo: níveis de todos pelo placar; subi de nível = mais vida máxima
  // (a vida sobe junto) e aviso na tela. Os bonecos sobem do mesmo jeito
  function updateProgression() {
    ctx.damageTally = currentXp()
    const level = ctx.levelOf(ctx.net.selfId)
    if (level > ctx.game.myLevel) {
      ctx.health.setMax(maxHealthFor(level))
      ctx.scoreUI.popup(ctx.car.root.position, 'levelup', level)
      ctx.announce(`⬆ LEVEL ${level}!`, `damage x${damageScale(level).toFixed(1)} · max HP ${ctx.health.max}`, 'levelup')
    }
    ctx.game.myLevel = level
    if (import.meta.env.DEV && ctx.game.phase === 'playing') {
      ctx.levelTimer.update(ctx.net.selfId, level, ctx.game.playTime)
      ctx.xpTimeline.update(ctx.net.selfId, ctx.damageTally.get(ctx.net.selfId) ?? 0, ctx.game.playTime)
      for (const [id] of ctx.remotes.entries()) {
        ctx.levelTimer.update(id, ctx.levelOf(id), ctx.game.playTime)
        ctx.xpTimeline.update(id, ctx.damageTally.get(id) ?? 0, ctx.game.playTime)
      }
    }
    for (const d of ctx.dummies.values()) {
      d.level = ctx.levelOf(d.id)
      d.health.setMax(maxHealthFor(d.level))
    }
  }

  // Passo fixo: conta o tempo; o anfitrião acerta o relógio dos outros a cada 2 s
  function updateMatchClock(dt) {
    ctx.game.matchLeft -= dt
    const host = ctx.amHost()
    if (host && (ctx.game.matchResend += dt) >= 2) {
      ctx.game.matchResend = 0
      ctx.net.sendMatch({ left: Math.max(0, ctx.game.matchLeft), over: false })
    }
    if (ctx.game.matchLeft <= 0) endMatch()
  }

  // Fim: carros param, aparece quem venceu e o placar de todos
  function endMatch() {
    if (ctx.game.phase === 'over' || !ctx.inMatch()) return
    ctx.game.phase = 'over'
    ctx.game.matchLeft = 0
    if (ctx.amHost()) ctx.net.sendMatch({ left: 0, over: true })
    ctx.ultSlot.stop()
    ctx.car.speedScale = 1
    const tally = currentKills()
    const assists = currentAssists()
    const rows = [{ id: ctx.net.selfId, name: ctx.game.myName || 'You', kills: tally.get(ctx.net.selfId) ?? 0, assists: assists.get(ctx.net.selfId) ?? 0, deaths: ctx.kills.deaths, me: true }]
    for (const [peerId, p] of ctx.remotes.entries()) {
      rows.push({ id: peerId, name: ctx.playerName(peerId), kills: tally.get(peerId) ?? 0, assists: assists.get(peerId) ?? 0, deaths: p.deaths ?? 0, me: false })
    }
    for (const [peerId, p] of ctx.departed) rows.push({ id: peerId, name: `${p.name} (left)`, kills: tally.get(peerId) ?? 0, assists: assists.get(peerId) ?? 0, deaths: p.deaths, me: false })
    const ranked = standings(rows)
    ctx.menu.showResults(ranked, {
      winnerIds: new Set(winners(ranked).map((p) => p.id)),
      isHost: ctx.amHost(),
      onAgain: playAgain,
      onLeave: () => location.assign(location.pathname),
    })
    if (import.meta.env.DEV) saveMatchReport(ranked)
  }

  // Só no `npm run dev`: grava o relatório da partida em match-stats/ (vite.config.js)
  function saveMatchReport(ranked) {
    const seconds = MATCH_TIME
    // Dano por nível: quem bateu e quem apanhou publicam (estado de rede) o que sabem
    const records = [ctx.kills, ...ctx.remotes.values(), ...ctx.departed.values()]
    const dealt = tallyDealtByLevel(records)
    const stats = buildStats(ranked, {
      seconds, levelOf: ctx.levelOf, xpOf: (id) => ctx.damageTally.get(id) ?? 0, levelTimesOf: (id) => ctx.levelTimer.timesOf(id),
      xpByMinuteOf: (id) => ctx.xpTimeline.perMinute(id),
      dealtOf: (id) => dealt.get(id) ?? {},
      takenOf: (id) => (id === ctx.net.selfId ? ctx.kills.dmgTaken : (ctx.remotes.get(id) ?? ctx.departed.get(id))?.dmgTaken) ?? {},
      hpAt: maxHealthFor,
      hitDamageAt: (level) => Object.fromEntries(['light', 'strong', 'smash', 'turbo'].map((tier) => [tier, scaleDamage(DAMAGE[tier], level)])),
    })
    const report = buildReport(stats, { seconds, balance: { DAMAGE, damageParams, HP_SCALE } })
    fetch('/__match-stats', { method: 'POST', body: JSON.stringify(report) })
      .then((r) => r.ok || console.error('match-stats:', r.status))
      .catch((err) => console.error('match-stats:', err))
  }

  // Anfitrião: outra partida com mapa novo, placar zerado
  function playAgain() {
    if (ctx.game.phase !== 'over' || !ctx.amHost()) return
    const map = newLayout()
    ctx.net.sendStart(map)
    ctx.beginMatch(map)
  }

  return { currentAssists, currentKills, endMatch, updateMatchClock, updateProgression }
}
