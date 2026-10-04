import * as THREE from 'three'
import { seededRandom } from './random.js'
import { testCarCapsule, distanceToSegment } from './collision.js'

// Paredes de pneus: obstáculos retos espalhados pela arena, alinhados aos
// eixos (giradas em múltiplos de 90°). O carro ricocheteia nelas como na
// mureta da arena.
//
// Posições: sorteadas pela semente do mapa da partida (layout.js), como os
// bastões; todos da sala calculam as mesmas paredes sem trocar mensagens.
// Para colisão, cada parede é uma cápsula: o segmento ao longo do comprimento
// com raio igual à metade da espessura.

/**
 * Sorteia as paredes do mapa.
 * @param {string} seed semente do mapa
 * @param {{
 *   count: number, halfX: number, halfZ: number, // área (centro de cada parede)
 *   halfLength: number,                          // metade do comprimento da parede
 *   keepClear: number,                           // raio livre no centro (nascimento)
 *   avoid: { x: number, z: number }[],           // bastões
 *   avoidDistance: number,                       // distância mínima até eles
 *   spacing: number,                             // distância mínima entre paredes
 * }} opts
 * @returns {{ x: number, z: number, yaw: number }[]}
 */
export function placeTireWalls(seed, { count, halfX, halfZ, halfLength, keepClear, avoid, avoidDistance, spacing }) {
  const rand = seededRandom(`${seed}:pneus`)
  const placed = []
  for (let tries = 0; placed.length < count && tries < count * 300; tries++) {
    const yaw = Math.floor(rand() * 4) * (Math.PI / 2) // 0°, 90°, 180° ou 270°
    const alongX = Math.round(Math.cos(yaw)) !== 0 // comprimento no eixo X?
    // A parede inteira cabe na área (não encosta na mureta)
    const limitX = halfX - (alongX ? halfLength : 0)
    const limitZ = halfZ - (alongX ? 0 : halfLength)
    const x = (rand() * 2 - 1) * limitX
    const z = (rand() * 2 - 1) * limitZ
    const wall = { x, z, yaw }
    const [a, b] = wallSegment(wall, halfLength)
    if (distanceToSegment(0, 0, a, b) < keepClear) continue
    if (avoid.some((p) => distanceToSegment(p.x, p.z, a, b) < avoidDistance)) continue
    if (placed.some((w) => segmentsTooClose(w, wall, halfLength, spacing))) continue
    placed.push(wall)
  }
  return placed
}

// Pontas do segmento central da parede, no chão: [[x, z], [x, z]]
function wallSegment({ x, z, yaw }, halfLength) {
  const dx = Math.cos(yaw) * halfLength, dz = -Math.sin(yaw) * halfLength
  return [[x - dx, z - dz], [x + dx, z + dz]]
}

// Paredes perto demais (amostra pontos de uma contra o segmento da outra:
// suficiente para segmentos curtos e alinhados aos eixos)
function segmentsTooClose(w1, w2, halfLength, spacing) {
  const [a1, b1] = wallSegment(w1, halfLength)
  const [a2, b2] = wallSegment(w2, halfLength)
  for (let i = 0; i <= 8; i++) {
    const t = i / 8
    if (distanceToSegment(a1[0] + (b1[0] - a1[0]) * t, a1[1] + (b1[1] - a1[1]) * t, a2, b2) < spacing) return true
    if (distanceToSegment(a2[0] + (b2[0] - a2[0]) * t, a2[1] + (b2[1] - a2[1]) * t, a1, b1) < spacing) return true
  }
  return false
}

/**
 * Mede a parede pelo modelo (comprimento no eixo X local) e centraliza o
 * modelo na origem com a base no chão.
 * @returns {{ halfLength: number, radius: number }} para a cápsula de colisão
 */
export function prepareTireWall(template) {
  const box = new THREE.Box3().setFromObject(template)
  const size = box.getSize(new THREE.Vector3())
  const center = box.getCenter(new THREE.Vector3())
  template.position.set(-center.x, -box.min.y, -center.z)
  const wrapper = new THREE.Group()
  wrapper.add(template)
  const radius = size.z / 2
  return { model: wrapper, halfLength: size.x / 2, radius, segmentHalf: Math.max(size.x / 2 - radius, 0) }
}

export class TireWalls {
  /**
   * @param {THREE.Scene} scene
   * @param {THREE.Object3D} model de prepareTireWall
   * @param {{ walls: { x: number, z: number, yaw: number }[], segmentHalf: number, radius: number }} opts
   */
  constructor(scene, model, { walls, segmentHalf, radius }) {
    this.scene = scene
    this.model = model
    this.segmentHalf = segmentHalf
    this.radius = radius
    this.items = []
    this.hits = []
    this.setWalls(walls)
  }

  /** Mapa novo: outras paredes (cria/remove meshes conforme a quantidade). */
  setWalls(walls) {
    while (this.items.length > walls.length) this.scene.remove(this.items.pop().object)
    while (this.items.length < walls.length) {
      const object = this.model.clone(true)
      this.scene.add(object)
      this.items.push({ object, a: new THREE.Vector2(), b: new THREE.Vector2() })
    }
    walls.forEach((w, i) => {
      const item = this.items[i]
      item.object.position.set(w.x, 0, w.z)
      item.object.rotation.y = w.yaw
      const dx = Math.cos(w.yaw) * this.segmentHalf, dz = -Math.sin(w.yaw) * this.segmentHalf
      item.a.set(w.x - dx, w.z - dz)
      item.b.set(w.x + dx, w.z + dz)
    })
  }

  /**
   * Batidas do MEU carro contra as paredes. O array devolvido é reaproveitado
   * (vale até a próxima chamada).
   * @returns {{ normal: THREE.Vector3, depth: number }[]} normal da parede para o carro
   */
  testCar(position, yaw, fp) {
    this.hits.length = 0
    for (const { a, b } of this.items) {
      const hit = testCarCapsule(position, yaw, fp, a, b, this.radius)
      if (hit) this.hits.push(hit)
    }
    return this.hits
  }

  /** Distância de um ponto do chão até a parede mais próxima (borda). */
  clearance(x, z) {
    let best = Infinity
    for (const { a, b } of this.items) best = Math.min(best, distanceToSegment(x, z, [a.x, a.y], [b.x, b.y]) - this.radius)
    return best
  }
}
