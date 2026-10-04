import * as THREE from 'three'
import { createToonMaterial } from './toon.js'
import { seededRandom } from './random.js'

// Esferas de boost flutuando pela arena.
//
// Sem servidor, todos precisam ver as esferas no mesmo lugar. Cada esfera
// ocupa um "slot" com um número de geração; a posição é sorteada por um
// gerador determinístico a partir de (semente do mapa, slot, geração), então
// todo mundo calcula o mesmo ponto. Quem pega uma esfera avisa a sala ({ slot, gen }) e
// todos avançam aquele slot para a geração seguinte, que reaparece em outro
// lugar depois de RESPAWN_DELAY.

const PICKUP_RADIUS = 1.9 // m do centro do carrinho
const RESPAWN_DELAY = 12  // s (boost forte: esferas mais raras; ~4 boosts por jogador por minuto)
const FLOAT_HEIGHT = 1.4

// Esferas no mapa: acompanham o número de jogadores, com teto para o mapa
// não lotar (2 + metade dos jogadores, entre 3 e 6)
const ORB_MIN = 3
const ORB_MAX = 6
export const orbCountFor = (players) => Math.min(ORB_MAX, Math.max(ORB_MIN, Math.round(2 + players / 2)))

export class Orbs {
  /**
   * @param {THREE.Scene} scene
   * @param {{
   *   seed: string, count: number, halfX: number, halfZ: number,
   *   anchors?: { x: number, z: number }[], anchorRange?: [number, number],
   * }} opts
   *   halfX/halfZ = metade da largura/profundidade da área onde podem aparecer.
   *   anchors = pontos de interesse (os bastões): cada esfera nasce a uma
   *   distância de anchorRange (mín., máx.) de um deles, sorteado. Sem
   *   anchors, aparece em qualquer lugar.
   */
  constructor(scene, { seed, count, halfX, halfZ, anchors = [], anchorRange = [2.5, 5.5] }) {
    this.seed = seed
    this.halfX = halfX
    this.halfZ = halfZ
    this.anchors = anchors
    this.anchorRange = anchorRange
    this.time = 0

    this.scene = scene
    this.geometry = new THREE.IcosahedronGeometry(0.6, 2)
    this.material = createToonMaterial({ color: '#9ff6ff', emissive: '#2a9fd6', glossiness: 10 })
    this.slots = []
    this.setCount(count)
  }

  /**
   * Quantas esferas ficam no mapa (acompanha o número de jogadores). Slots a
   * mais não são apagados, só "adormecem" (invisíveis e sem poder ser pegos):
   * se voltarem, a geração deles continua batendo com a dos outros jogadores.
   */
  setCount(count) {
    this.count = count
    while (this.slots.length < count) {
      const mesh = new THREE.Mesh(this.geometry, this.material)
      mesh.castShadow = true
      this.scene.add(mesh)
      const slot = { index: this.slots.length, gen: 0, readyAt: 0, mesh }
      this.place(slot)
      this.slots.push(slot)
    }
  }

  // Posição determinística do slot na geração atual
  place(slot) {
    const rand = seededRandom(`${this.seed}:${slot.index}:${slot.gen}`)
    let x, z
    if (this.anchors.length) {
      // Perto de um bastão: para pegar o boost é preciso chegar perto dos
      // espinhos, e quem vai buscar encontra quem também foi. Rodízio (slot +
      // geração): cada bastão tem esfera por perto e o ponto quente muda de
      // lugar a cada vez que a esfera reaparece
      const anchor = this.anchors[(slot.index + slot.gen) % this.anchors.length]
      const angle = rand() * Math.PI * 2
      const [min, max] = this.anchorRange
      const dist = min + rand() * (max - min)
      x = THREE.MathUtils.clamp(anchor.x + Math.cos(angle) * dist, -this.halfX, this.halfX)
      z = THREE.MathUtils.clamp(anchor.z + Math.sin(angle) * dist, -this.halfZ, this.halfZ)
    } else {
      x = (rand() * 2 - 1) * this.halfX
      z = (rand() * 2 - 1) * this.halfZ
    }
    slot.mesh.position.set(x, FLOAT_HEIGHT, z)
    slot.phase = rand() * Math.PI * 2
  }

  /** Mapa novo (outra semente e outros bastões): recomeça todas as esferas. */
  relayout(seed, anchors) {
    this.seed = seed
    this.anchors = anchors
    for (const slot of this.slots) {
      slot.gen = 0
      slot.readyAt = 0
      this.place(slot)
    }
  }

  isActive(slot) {
    return slot.index < this.count && this.time >= slot.readyAt
  }

  update(dt) {
    this.time += dt
    for (const slot of this.slots) {
      const active = this.isActive(slot)
      slot.mesh.visible = active
      if (!active) continue
      // Flutua e gira devagar
      slot.mesh.position.y = FLOAT_HEIGHT + Math.sin(this.time * 2.2 + slot.phase) * 0.25
      slot.mesh.rotation.y += dt * 1.5
      slot.mesh.rotation.x += dt * 0.7
    }
  }

  /** Esfera ativa que o carrinho está tocando, ou null. */
  findPickup(position) {
    for (const slot of this.slots) {
      if (!this.isActive(slot)) continue
      const dx = slot.mesh.position.x - position.x
      const dz = slot.mesh.position.z - position.z
      if (dx * dx + dz * dz < PICKUP_RADIUS * PICKUP_RADIUS) return slot
    }
    return null
  }

  /**
   * Marca o slot como pego (local ou vindo da rede). Ignora avisos antigos
   * (geração que já passou).
   * @returns {boolean} se a esfera foi pega agora
   */
  take(index, gen) {
    const slot = this.slots[index]
    if (!slot || gen !== slot.gen) return false
    slot.gen++
    slot.readyAt = this.time + RESPAWN_DELAY
    this.place(slot)
    return true
  }

  /** Estado para mandar a quem acabou de entrar na sala. */
  snapshot() {
    return this.slots.map((s) => ({ gen: s.gen, wait: Math.max(0, s.readyAt - this.time) }))
  }

  /** Aplica o estado recebido: vale sempre a geração mais nova. */
  merge(snapshot) {
    snapshot.forEach(({ gen, wait }, i) => {
      const slot = this.slots[i]
      if (!slot || gen <= slot.gen) return
      slot.gen = gen
      slot.readyAt = this.time + wait
      this.place(slot)
    })
  }
}
