import * as THREE from 'three'
import { seededRandom } from './random.js'
import { SPRING, DAMPING, MAX_TILT, SQUASH_SPRING, SQUASH_DAMPING } from './bats.js'
import { testCarCapsule, distanceToSegment } from './collision.js'

// Paredes de pneus: obstáculos retos espalhados pela arena, alinhados aos
// eixos (giradas em múltiplos de 90°). O carro ricocheteia nelas como na
// mureta da arena.
//
// Posições: sorteadas pela semente do mapa da partida (layout.js), como os
// bastões; todos da sala calculam as mesmas paredes sem trocar mensagens.
// Para colisão, cada parede é uma cápsula: o segmento ao longo do comprimento
// com raio igual à metade da espessura.

const INTENSITY = 0.3 // mesma animação dos bastões, só que mais fraca (parede pesada)

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
    while (this.items.length > walls.length) this.scene.remove(this.items.pop().pivot)
    while (this.items.length < walls.length) {
      // pivot no pé da parede: a inclinação gira em torno da base (como nos bastões)
      const pivot = new THREE.Group()
      const object = this.model.clone(true)
      pivot.add(object)
      this.scene.add(pivot)
      this.items.push({
        pivot, object, a: new THREE.Vector2(), b: new THREE.Vector2(),
        tiltX: 0, tiltZ: 0, tiltVelX: 0, tiltVelZ: 0, squash: 0, squashVel: 0, lastKick: -Infinity,
      })
    }
    walls.forEach((w, i) => {
      const item = this.items[i]
      item.pivot.position.set(w.x, 0, w.z)
      item.object.rotation.y = w.yaw
      item.tiltX = item.tiltZ = item.tiltVelX = item.tiltVelZ = item.squash = item.squashVel = 0
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
    this.items.forEach(({ a, b }, index) => {
      const hit = testCarCapsule(position, yaw, fp, a, b, this.radius)
      if (hit) this.hits.push({ index, ...hit })
    })
    return this.hits
  }

  /**
   * Batida na parede: mesma física dos bastões (inclina para o lado oposto da
   * batida, volta oscilando, amassa), só que com intensidade reduzida.
   * @param {number} dirX direção do empurrão na parede (do carro para a parede)
   * @param {number} dirZ
   * @param {number} strength velocidade da batida (m/s)
   */
  kick(index, dirX, dirZ, strength) {
    const it = this.items[index]
    const now = performance.now()
    if (!it || strength < 1 || now - it.lastKick < 150) return
    it.lastKick = now
    const k = Math.min(strength, 25) * 0.35 * INTENSITY
    it.tiltVelX += dirZ * k
    it.tiltVelZ -= dirX * k
    it.squashVel -= Math.min(strength, 25) * 0.25 * INTENSITY
  }

  /** Animação (molas): chamar a cada quadro. */
  update(dt) {
    for (const it of this.items) {
      it.tiltVelX += (-SPRING * it.tiltX - DAMPING * it.tiltVelX) * dt
      it.tiltVelZ += (-SPRING * it.tiltZ - DAMPING * it.tiltVelZ) * dt
      it.tiltX = THREE.MathUtils.clamp(it.tiltX + it.tiltVelX * dt, -MAX_TILT, MAX_TILT)
      it.tiltZ = THREE.MathUtils.clamp(it.tiltZ + it.tiltVelZ * dt, -MAX_TILT, MAX_TILT)
      it.squashVel += (-SQUASH_SPRING * it.squash - SQUASH_DAMPING * it.squashVel) * dt
      it.squash += it.squashVel * dt
      it.pivot.rotation.x = it.tiltX
      it.pivot.rotation.z = it.tiltZ
      const s = THREE.MathUtils.clamp(1 + it.squash, 0.75, 1.25)
      it.object.scale.set(1 / Math.sqrt(s), s, 1 / Math.sqrt(s))
    }
  }

  /** Distância de um ponto do chão até a parede mais próxima (borda). */
  clearance(x, z) {
    let best = Infinity
    for (const { a, b } of this.items) best = Math.min(best, distanceToSegment(x, z, [a.x, a.y], [b.x, b.y]) - this.radius)
    return best
  }
}
