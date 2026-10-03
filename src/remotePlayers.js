import * as THREE from 'three'
import { RemoteCar } from './remoteCar.js'
import { createToonMaterial } from './toon.js'
import { readColors, writeColors, setBoostGlow } from './paint.js'

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
    this.players = new Map() // peerId -> { car, bodyMaterials, livery, score, boosting }
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
    const player = { car: new RemoteCar(model), bodyMaterials, livery: null, score: 0, boosting: false }
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
    player.score = state.score
    // Brilho só muda o uniform quando o boost liga/desliga (dirty flag)
    if (state.boosting !== player.boosting) {
      player.boosting = state.boosting
      setBoostGlow(player.bodyMaterials, state.boosting)
    }
    const liveryChanged = state.livery !== player.livery
    player.livery = state.livery
    return { player, liveryChanged }
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

  liveries() {
    return [...this.players.values()].map((p) => p.livery)
  }

  colors(player) {
    return readColors(player.bodyMaterials)
  }
}
