// Extraído do main.js (seção "Zona de cura"). As regras continuam as mesmas; o que ainda mora
// no main.js (carro, rede, HUD...) chega por `ctx` (getters/setters ligados às variáveis do main.js).
import { MEDKIT, maxZonesFor, placeNearFight } from './medkit.js'

export function createHealZone(ctx) {
  let medResend = 0 // anfitrião: reenvia o estado de tempos em tempos
  let healShown = 0 // cura acumulada ainda não mostrada ("+N VIDA" a cada 1 s)
  let healPopupTimer = 0

  function broadcastMedkit() {
    ctx.net.sendMedkit(ctx.medkit.snapshot())
    medResend = 0
  }

  function announceMedkit() {
    ctx.announce('💊 HEALING ZONE!', `stay inside: up to ${Math.round(MEDKIT.healOfMissing * 100)}% of missing HP in ${MEDKIT.duration}s`, 'heal')
  }

  // Carros na arena (eu e os outros, bonecos incluídos), com a vida
  function playersWithHp() {
    const players = []
    if (!ctx.health.isKO) players.push({ x: ctx.car.root.position.x, z: ctx.car.root.position.z, hp: ctx.health.hp })
    for (const p of ctx.remotes.values()) {
      if (p.car.hasState && !p.ko) players.push({ x: p.car.root.position.x, z: p.car.root.position.z, hp: p.hp })
    }
    return players
  }

  // Perto da briga: centro a poucos metros de `target` (o ferido daquela briga)
  function placeMedkit(target) {
    return placeNearFight(ctx.medkitSpots, [target])
  }

  // Quantos na sala (no campo de testes, os bonecos contam)
  const playerCount = () => 1 + ctx.roster.size + Math.max(ctx.dummies.size, ctx.netBots.size)

  // Passo fixo: o anfitrião sorteia; eu curo enquanto estou dentro
  function updateMedkit(dt) {
    const host = ctx.amHost()
    const hurt = playersWithHp().filter((p) => p.hp <= MEDKIT.lowHp)
    const born = ctx.medkit.update(dt, host, { hurt, place: placeMedkit, maxZones: maxZonesFor(playerCount()) })
    if (born) {
      if (born.length) announceMedkit()
      broadcastMedkit()
    }
    if (host && (medResend += dt) >= 2) broadcastMedkit()

    const pos = ctx.car.root.position
    const inside = !ctx.health.isKO && ctx.medkit.contains(pos.x, pos.z)
    ctx.playerHud.health.root.classList.toggle('healing', inside)
    if (!inside) {
      ctx.zoneHeal.carry = 0
    } else {
      healShown += ctx.health.heal(ctx.zoneHeal.update(dt, ctx.health.hp, ctx.health.max))
    }
    // "+N VIDA" uma vez por segundo, somando o que curou
    healPopupTimer += dt
    if (healPopupTimer >= 1) {
      healPopupTimer = 0
      if (healShown > 0) ctx.scoreUI.popup(pos, 'heal', healShown)
      healShown = 0
    }
  }

  // 3, 2, 1, JÁ! (carros parados até o fim)
  function updateCountdown(dt) {
    if (ctx.game.phase === 'countdown') {
      ctx.game.countdown -= dt
      ctx.menu.showCount(Math.ceil(ctx.game.countdown))
      if (ctx.game.countdown <= 0) ctx.game.phase = 'playing'
    } else if (ctx.game.goTimer < ctx.GO_SHOW_TIME) {
      ctx.game.goTimer += dt
      if (ctx.game.goTimer >= ctx.GO_SHOW_TIME) ctx.menu.showCount(null)
    }
  }

  return { announceMedkit, placeMedkit, playersWithHp, updateCountdown, updateMedkit }
}
