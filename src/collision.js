import * as THREE from 'three'

// Colisão carrinho x carrinho no plano do chão (XZ). Cada carrinho é uma
// cápsula: um segmento ao longo da frente com um raio em volta, que encaixa
// bem no formato oval do bate-bate.

/**
 * Mede o "pé" do carrinho (contorno visto de cima), em coordenadas locais do
 * root. Chamar com o carrinho na origem e sem rotação.
 * @returns {{ radius: number, halfLength: number, offsetX: number, offsetZ: number }}
 */
export function measureFootprint(object) {
  const box = new THREE.Box3().setFromObject(object)
  const size = box.getSize(new THREE.Vector3())
  const center = box.getCenter(new THREE.Vector3())
  const radius = Math.min(size.x, size.z) / 2
  return {
    radius,
    // Parte reta do segmento: comprimento total menos as duas pontas redondas
    halfLength: Math.max(size.z / 2 - radius, 0),
    offsetX: center.x,
    offsetZ: center.z,
  }
}

const tmpA0 = new THREE.Vector2()
const tmpA1 = new THREE.Vector2()
const tmpB0 = new THREE.Vector2()
const tmpB1 = new THREE.Vector2()

// Pontas do segmento da cápsula no mundo (x, z)
function capsuleSegment(position, yaw, fp, out0, out1) {
  const fx = Math.sin(yaw), fz = Math.cos(yaw) // frente
  const lx = Math.cos(yaw), lz = -Math.sin(yaw) // +X local
  const cx = position.x + lx * fp.offsetX + fx * fp.offsetZ
  const cz = position.z + lz * fp.offsetX + fz * fp.offsetZ
  out0.set(cx + fx * fp.halfLength, cz + fz * fp.halfLength)
  out1.set(cx - fx * fp.halfLength, cz - fz * fp.halfLength)
}

// Pontos mais próximos entre dois segmentos 2D (Ericson, Real-Time Collision
// Detection, 5.1.9). Escreve em outP (no segmento p) e outQ (no segmento q).
function closestPointsSegments(p0, p1, q0, q1, outP, outQ) {
  const d1x = p1.x - p0.x, d1y = p1.y - p0.y
  const d2x = q1.x - q0.x, d2y = q1.y - q0.y
  const rx = p0.x - q0.x, ry = p0.y - q0.y
  const a = d1x * d1x + d1y * d1y
  const e = d2x * d2x + d2y * d2y
  const f = d2x * rx + d2y * ry
  let s, t
  if (a <= 1e-9 && e <= 1e-9) {
    s = t = 0
  } else if (a <= 1e-9) {
    s = 0
    t = THREE.MathUtils.clamp(f / e, 0, 1)
  } else {
    const c = d1x * rx + d1y * ry
    if (e <= 1e-9) {
      t = 0
      s = THREE.MathUtils.clamp(-c / a, 0, 1)
    } else {
      const b = d1x * d2x + d1y * d2y
      const denom = a * e - b * b
      s = denom > 1e-9 ? THREE.MathUtils.clamp((b * f - c * e) / denom, 0, 1) : 0
      t = (b * s + f) / e
      if (t < 0) {
        t = 0
        s = THREE.MathUtils.clamp(-c / a, 0, 1)
      } else if (t > 1) {
        t = 1
        s = THREE.MathUtils.clamp((b - c) / a, 0, 1)
      }
    }
  }
  outP.set(p0.x + d1x * s, p0.y + d1y * s)
  outQ.set(q0.x + d2x * t, q0.y + d2y * t)
}

const closestA = new THREE.Vector2()
const closestB = new THREE.Vector2()

/**
 * Testa a cápsula A contra a B.
 * @returns {{ normal: THREE.Vector3, depth: number } | null} normal de B para A
 */
export function testCars(posA, yawA, posB, yawB, fp) {
  capsuleSegment(posA, yawA, fp, tmpA0, tmpA1)
  capsuleSegment(posB, yawB, fp, tmpB0, tmpB1)
  closestPointsSegments(tmpA0, tmpA1, tmpB0, tmpB1, closestA, closestB)

  const dx = closestA.x - closestB.x
  const dz = closestA.y - closestB.y
  const dist = Math.hypot(dx, dz)
  const depth = fp.radius * 2 - dist
  if (depth <= 0) return null

  // Centros praticamente no mesmo ponto: empurra pela diferença de posição
  const normal = dist > 1e-6
    ? new THREE.Vector3(dx / dist, 0, dz / dist)
    : new THREE.Vector3(posA.x - posB.x || 1, 0, posA.z - posB.z).normalize()
  return { normal, depth }
}

/**
 * Testa o carrinho contra as paredes de uma arena quadrada centrada na
 * origem (de -half a +half em X e Z).
 * @returns {{ normal: THREE.Vector3, depth: number }[]} uma entrada por parede
 *   tocada; a normal aponta para dentro da arena
 */
export function testArenaWalls(position, yaw, fp, half) {
  capsuleSegment(position, yaw, fp, tmpA0, tmpA1)
  const hits = []
  // Para cada eixo, a ponta do segmento mais perto de cada parede decide
  for (const [axis, key] of [['x', 'x'], ['z', 'y']]) {
    const max = Math.max(tmpA0[key], tmpA1[key]) + fp.radius
    const min = Math.min(tmpA0[key], tmpA1[key]) - fp.radius
    if (max > half) hits.push({ normal: new THREE.Vector3(axis === 'x' ? -1 : 0, 0, axis === 'z' ? -1 : 0), depth: max - half })
    if (min < -half) hits.push({ normal: new THREE.Vector3(axis === 'x' ? 1 : 0, 0, axis === 'z' ? 1 : 0), depth: -half - min })
  }
  return hits
}
