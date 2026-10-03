import * as THREE from 'three'
import { createToonMaterial } from './toon.js'

// Esferas de boost flutuando pela arena.
//
// Sem servidor, todos precisam ver as esferas no mesmo lugar. Cada esfera
// ocupa um "slot" com um número de geração; a posição é sorteada por um
// gerador determinístico a partir de (sala, slot, geração), então todo mundo
// calcula o mesmo ponto. Quem pega uma esfera avisa a sala ({ slot, gen }) e
// todos avançam aquele slot para a geração seguinte, que reaparece em outro
// lugar depois de RESPAWN_DELAY.

const PICKUP_RADIUS = 1.9 // m do centro do carrinho
const RESPAWN_DELAY = 6   // s
const FLOAT_HEIGHT = 1.4

// Hash de string (cyrb53) -> semente; mulberry32 -> números em [0, 1)
function hashString(str) {
  let h1 = 0xdeadbeef, h2 = 0x41c6ce57
  for (let i = 0; i < str.length; i++) {
    const ch = str.charCodeAt(i)
    h1 = Math.imul(h1 ^ ch, 2654435761)
    h2 = Math.imul(h2 ^ ch, 1597334677)
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909)
  return h1 >>> 0
}
function mulberry32(seed) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

export class Orbs {
  /**
   * @param {THREE.Scene} scene
   * @param {{ roomId: string, count: number, half: number }} opts
   *   half = metade do lado da área onde as esferas podem aparecer
   */
  constructor(scene, { roomId, count, half }) {
    this.roomId = roomId
    this.half = half
    this.time = 0

    const geometry = new THREE.IcosahedronGeometry(0.6, 2)
    this.material = createToonMaterial({ color: '#9ff6ff', emissive: '#2a9fd6', glossiness: 10 })

    this.slots = Array.from({ length: count }, (_, i) => {
      const mesh = new THREE.Mesh(geometry, this.material)
      mesh.castShadow = true
      scene.add(mesh)
      const slot = { index: i, gen: 0, readyAt: 0, mesh }
      this.place(slot)
      return slot
    })
  }

  // Posição determinística do slot na geração atual
  place(slot) {
    const rand = mulberry32(hashString(`${this.roomId}:${slot.index}:${slot.gen}`))
    slot.mesh.position.set((rand() * 2 - 1) * this.half, FLOAT_HEIGHT, (rand() * 2 - 1) * this.half)
    slot.phase = rand() * Math.PI * 2
  }

  isActive(slot) {
    return this.time >= slot.readyAt
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
