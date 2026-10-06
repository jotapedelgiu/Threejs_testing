import * as THREE from 'three'
import { RemoteCar } from './remoteCar.js'
import { createToonMaterial } from './toon.js'
import { readColors, writeColors, setBoostGlow, setUltimateGlow } from './paint.js'
import { Presence } from './presence.js'
import { newKills } from './match.js'

// Jogadores remotos: um RemoteCar por peer, com pintura própria, placar e
// estado de boost. Cria o carro no primeiro estado recebido e remove quando o
// peer sai.

export class RemotePlayers {
  /**
   * @param {THREE.Scene} scene
   * @param {THREE.Object3D} template modelo do carro já com materiais toon
   * @param {THREE.Material[]} paintedMaterials os materiais da carroceria
   *   (principal, secundária) do template, que cada jogador pinta do seu jeito
   */
  constructor(scene, template, paintedMaterials) {
    this.scene = scene
    this.template = template
    this.paintedMaterials = paintedMaterials
    this.players = new Map() // peerId -> { car, bodyMaterials, livery, hp, ko, shield, boosting }
  }

  get(peerId) {
    return this.players.get(peerId)
  }

  values() {
    return this.players.values()
  }

  entries() {
    return this.players.entries()
  }

  create(peerId) {
    // Clona o modelo; as carrocerias ganham materiais próprios para ter a
    // pintura do outro jogador. Os demais materiais são compartilhados, então
    // os ajustes do painel valem para todos os carrinhos.
    const bodyMaterials = this.paintedMaterials.map(() =>
      createToonMaterial({ color: 0xffffff, glossiness: 8, side: THREE.DoubleSide })
    )
    const model = this.template.clone(true)
    model.traverse((o) => {
      if (!o.isMesh) return
      const i = this.paintedMaterials.indexOf(o.material)
      if (i !== -1) o.material = bodyMaterials[i]
    })
    const player = {
      car: new RemoteCar(model), bodyMaterials, livery: null,
      hp: 0, ko: false, shield: false, boosting: false, ult: null, ghost: false,
      koBy: {}, asBy: {}, xpBy: {}, dmgBy: {}, dmgTaken: {}, deaths: 0,
      presence: new Presence(), // some no nocaute, reaparece com "pop"
    }
    this.scene.add(player.car.root)
    this.players.set(peerId, player)
    return player
  }

  /**
   * Aplica um estado recebido (já validado em protocol.js).
   * @returns o jogador e se a pintura mudou
   */
  applyState(peerId, state, localNow) {
    const player = this.players.get(peerId) ?? this.create(peerId)
    player.car.setState(state, localNow)
    if (state.colors) writeColors(player.bodyMaterials, state.colors)
    player.hp = state.hp
    const knockedOut = state.ko && !player.ko // acabou de ser nocauteado
    player.ko = state.ko
    player.shield = state.shield
    player.boosting = state.boosting
    const ultStarted = state.ult && !player.ult // acabou de ativar o ultimate
    // Emboscada que acabou sem nocaute: a batida de área acabou de cair
    const slammed = player.ult === 'ambush' && !state.ult && !state.ko
    player.ult = state.ult
    player.ghost = state.ghost === true
    // Mísseis novos (o primeiro estado só marca a contagem: não relança os antigos)
    const missilesFired = player.ms === undefined ? 0 : Math.max(0, state.ms - player.ms)
    player.ms = state.ms
    // Placar: quem o nocauteou desde o último estado (para o kill feed)
    // (campo ausente = não mudou desde o último estado; netSend.js)
    const killedBy = newKills(player.koBy, state.koBy ?? player.koBy)
    for (const field of ['koBy', 'asBy', 'xpBy', 'dmgBy', 'dmgTaken', 'deaths']) {
      if (state[field] !== undefined) player[field] = state[field]
    }
    const liveryChanged = state.livery !== undefined && state.livery !== player.livery
    if (state.livery !== undefined) player.livery = state.livery
    return { player, liveryChanged, knockedOut, ultStarted, slammed, missilesFired, killedBy }
  }

  remove(peerId) {
    const player = this.players.get(peerId)
    if (!player) return
    this.scene.remove(player.car.root)
    player.bodyMaterials.forEach((m) => m.dispose())
    this.players.delete(peerId)
  }

  /** Posiciona todos os carros remotos no instante `localNow` (interpolação). */
  sample(localNow) {
    for (const { car } of this.players.values()) {
      if (car.hasState) car.sample(localNow)
    }
  }

  /**
   * Brilho da carroceria: pulsando com o ultimate, azul no boost. O do boost
   * só mexe nos materiais quando liga/desliga (dirty flag).
   * @param {number} pulse 0..1 (pulsação do brilho do ultimate)
   */
  updateGlow(pulse) {
    for (const p of this.players.values()) {
      if (p.ult && !p.ko) {
        setUltimateGlow(p.bodyMaterials, pulse)
        p.glow = 'ult'
        continue
      }
      const glow = p.boosting ? 'boost' : null
      if (glow === p.glow) continue
      p.glow = glow
      setBoostGlow(p.bodyMaterials, !!glow)
    }
  }

  /** Some/aparece (nocaute) de cada carro remoto. */
  updatePresence(dt) {
    for (const p of this.players.values()) p.presence.apply(p.car.root, p.presence.update(dt, !p.ko && !p.ghost))
  }

  liveries() {
    return [...this.players.values()].map((p) => p.livery)
  }

  colors(player) {
    return readColors(player.bodyMaterials)
  }
}
