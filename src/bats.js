import * as THREE from 'three'
import { seededRandom } from './random.js'
import { testCarCircle } from './collision.js'

// Bastões com espinhos: obstáculos parados em pontos aleatórios da arena. O
// carro que bate ricocheteia e perde vida; o bastão balança como um poste com
// mola (tomba para o lado oposto da batida e volta oscilando), gira um pouco e
// dá uma "amassadinha".
//
// Posições: sorteadas pela semente do mapa da partida (layout.js), então todos
// os jogadores da sala veem os bastões nos mesmos lugares. A animação é
// avisada pela rede para os outros verem o mesmo ricochete.

const SPRING = 55       // rigidez da mola que endireita o bastão
const DAMPING = 4.5     // amortecimento (menor = balança mais vezes)
const MAX_TILT = 0.6    // rad: inclinação máxima
const SQUASH_SPRING = 140
const SQUASH_DAMPING = 9

export class SpikedBats {
  /**
   * @param {THREE.Scene} scene
   * @param {THREE.Object3D} template modelo do bastão (base no chão, centrado)
   * @param {{
   *   positions: { x: number, z: number }[], // de placeBats (iguais para a sala toda)
   *   radius: number,                        // raio de colisão (corpo + espinhos)
   * }} opts
   */
  constructor(scene, template, { positions, radius }) {
    this.radius = radius
    this.bats = positions.map(({ x, z }) => {
      // pivot no pé do bastão: a inclinação gira em torno da base
      const pivot = new THREE.Group()
      pivot.position.set(x, 0, z)
      const model = template.clone(true)
      model.rotation.y = Math.random() * Math.PI * 2 // só visual
      pivot.add(model)
      scene.add(pivot)
      return {
        x, z, pivot, model,
        tiltX: 0, tiltZ: 0, tiltVelX: 0, tiltVelZ: 0, // inclinação (rad) e velocidade
        spin: 0,                                       // giro extra (rad/s), decai
        squash: 0, squashVel: 0,                       // achatamento vertical
      }
    })
  }

  /** Mapa novo: leva os bastões para outras posições (mesma quantidade). */
  setPositions(positions) {
    this.bats.forEach((b, i) => {
      const p = positions[i]
      if (!p) return
      b.x = p.x
      b.z = p.z
      b.pivot.position.set(p.x, 0, p.z)
      b.tiltX = b.tiltZ = b.tiltVelX = b.tiltVelZ = b.spin = b.squash = b.squashVel = 0
    })
  }

  /**
   * Batida do MEU carro contra algum bastão.
   * @returns {{ index: number, normal: THREE.Vector3, depth: number } | null}
   *   normal = do bastão para o carro
   */
  testCar(position, yaw, footprint) {
    for (let i = 0; i < this.bats.length; i++) {
      const b = this.bats[i]
      const hit = testCarCircle(position, yaw, footprint, b.x, b.z, this.radius)
      if (hit) return { index: i, ...hit }
    }
    return null
  }

  /**
   * Faz o bastão ricochetear.
   * @param {number} dirX direção do empurrão no bastão (do carro para o bastão)
   * @param {number} dirZ
   * @param {number} strength velocidade da batida (m/s)
   */
  kick(index, dirX, dirZ, strength) {
    const b = this.bats[index]
    if (!b) return
    const k = Math.min(strength, 25) * 0.35
    // Topo vai na direção do empurrão: rotation.x positivo leva o topo para
    // +Z e rotation.z positivo leva o topo para -X
    b.tiltVelX += dirZ * k
    b.tiltVelZ -= dirX * k
    b.spin += (Math.random() < 0.5 ? -1 : 1) * Math.min(strength, 25) * 0.6
    b.squashVel -= Math.min(strength, 25) * 0.25
  }

  /** Animação (molas): chamar a cada quadro. */
  update(dt) {
    for (const b of this.bats) {
      b.tiltVelX += (-SPRING * b.tiltX - DAMPING * b.tiltVelX) * dt
      b.tiltVelZ += (-SPRING * b.tiltZ - DAMPING * b.tiltVelZ) * dt
      b.tiltX = THREE.MathUtils.clamp(b.tiltX + b.tiltVelX * dt, -MAX_TILT, MAX_TILT)
      b.tiltZ = THREE.MathUtils.clamp(b.tiltZ + b.tiltVelZ * dt, -MAX_TILT, MAX_TILT)
      b.squashVel += (-SQUASH_SPRING * b.squash - SQUASH_DAMPING * b.squashVel) * dt
      b.squash += b.squashVel * dt
      b.spin *= Math.exp(-2.5 * dt)

      b.pivot.rotation.x = b.tiltX
      b.pivot.rotation.z = b.tiltZ
      b.model.rotation.y += b.spin * dt
      // Achata na batida e estica de volta (volume mais ou menos constante)
      const s = THREE.MathUtils.clamp(1 + b.squash, 0.75, 1.25)
      b.model.scale.set(1 / Math.sqrt(s), s, 1 / Math.sqrt(s))
    }
  }

  get count() {
    return this.bats.length
  }
}

/**
 * Sorteia posições longe do centro e espaçadas entre si. Determinístico: a
 * mesma semente (mapa da partida, ver layout.js) gera sempre as mesmas posições.
 * @returns {{ x: number, z: number }[]}
 */
export function placeBats(seed, count, halfX, halfZ, keepClear, spacing, avoid = [], avoidDistance = 0) {
  const rand = seededRandom(`${seed}:bastoes`)
  const placed = []
  for (let tries = 0; placed.length < count && tries < count * 200; tries++) {
    const x = (rand() * 2 - 1) * halfX
    const z = (rand() * 2 - 1) * halfZ
    if (Math.hypot(x, z) < keepClear) continue
    if (placed.some((p) => Math.hypot(p.x - x, p.z - z) < spacing)) continue
    if (avoid.some((p) => Math.hypot(p.x - x, p.z - z) < avoidDistance)) continue
    placed.push({ x, z })
  }
  return placed
}

/**
 * Monta o modelo do bastão a partir de um glTF, pegando só as peças cujo
 * material começa com `prefix` (o arquivo pode vir com outras coisas da cena).
 * Põe o pé no chão e o centro em (0, 0).
 */
export function extractProp(root, prefix) {
  root.updateMatrixWorld(true)
  const prop = new THREE.Group()
  root.traverse((o) => {
    if (!o.isMesh || !o.material.name.startsWith(prefix)) return
    const mesh = new THREE.Mesh(o.geometry, o.material)
    o.matrixWorld.decompose(mesh.position, mesh.quaternion, mesh.scale)
    mesh.castShadow = mesh.receiveShadow = true
    prop.add(mesh)
  })
  const box = new THREE.Box3().setFromObject(prop)
  const center = box.getCenter(new THREE.Vector3())
  for (const m of prop.children) m.position.sub(new THREE.Vector3(center.x, box.min.y, center.z))
  return prop
}
