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
export function testCars(posA, yawA, posB, yawB, fp, reach = 0) {
  capsuleSegment(posA, yawA, fp, tmpA0, tmpA1)
  capsuleSegment(posB, yawB, fp, tmpB0, tmpB1)
  closestPointsSegments(tmpA0, tmpA1, tmpB0, tmpB1, closestA, closestB)

  const dx = closestA.x - closestB.x
  const dz = closestA.y - closestB.y
  const dist = Math.hypot(dx, dz)
  // `reach` (m): alcance extra de quem está com boost; acerta um pouco antes de
  // encostar, e a separação continua só pela sobreposição de verdade
  const overlap = fp.radius * 2 - dist
  if (overlap + reach <= 0) return null
  const depth = Math.max(overlap, 0)

  // Centros praticamente no mesmo ponto: empurra pela diferença de posição
  const normal = dist > 1e-6
    ? new THREE.Vector3(dx / dist, 0, dz / dist)
    : new THREE.Vector3(posA.x - posB.x || 1, 0, posA.z - posB.z).normalize()
  return { normal, depth }
}

// Normais das quatro paredes (apontam para dentro da arena). Só leitura.
const WALL_NORMALS = {
  maxX: new THREE.Vector3(-1, 0, 0),
  minX: new THREE.Vector3(1, 0, 0),
  maxZ: new THREE.Vector3(0, 0, -1),
  minZ: new THREE.Vector3(0, 0, 1),
}
// Resultado reaproveitado: no máximo duas paredes ao mesmo tempo (num canto)
const wallHits = [{ normal: null, depth: 0 }, { normal: null, depth: 0 }]
const wallResult = []

/**
 * Testa o carrinho contra as paredes de uma arena retangular centrada na
 * origem (de -halfX a +halfX e de -halfZ a +halfZ). Roda todo passo, então não
 * aloca: o array devolvido é reaproveitado e só vale até a próxima chamada.
 * @returns {{ normal: THREE.Vector3, depth: number }[]} uma entrada por parede
 *   tocada; a normal aponta para dentro da arena
 */
export function testArenaWalls(position, yaw, fp, halfX, halfZ = halfX) {
  capsuleSegment(position, yaw, fp, tmpA0, tmpA1)
  wallResult.length = 0
  const add = (normal, depth) => {
    const hit = wallHits[wallResult.length]
    hit.normal = normal
    hit.depth = depth
    wallResult.push(hit)
  }
  // Em cada eixo, a ponta do segmento mais perto de cada parede decide (a
  // cápsula é estreita, então nunca toca as duas paredes do mesmo eixo)
  const maxX = Math.max(tmpA0.x, tmpA1.x) + fp.radius
  const minX = Math.min(tmpA0.x, tmpA1.x) - fp.radius
  const maxZ = Math.max(tmpA0.y, tmpA1.y) + fp.radius
  const minZ = Math.min(tmpA0.y, tmpA1.y) - fp.radius
  if (maxX > halfX) add(WALL_NORMALS.maxX, maxX - halfX)
  else if (minX < -halfX) add(WALL_NORMALS.minX, -halfX - minX)
  if (maxZ > halfZ) add(WALL_NORMALS.maxZ, maxZ - halfZ)
  else if (minZ < -halfZ) add(WALL_NORMALS.minZ, -halfZ - minZ)
  return wallResult
}

/**
 * Testa o carrinho contra um poste redondo (cilindro em pé) no ponto (cx, cz).
 * @returns {{ normal: THREE.Vector3, depth: number } | null} normal do poste para o carro
 */
export function testCarCircle(position, yaw, fp, cx, cz, radius) {
  capsuleSegment(position, yaw, fp, tmpA0, tmpA1)
  // Ponto do segmento da cápsula mais perto do centro do poste
  const sx = tmpA1.x - tmpA0.x, sz = tmpA1.y - tmpA0.y
  const lenSq = sx * sx + sz * sz
  const t = lenSq > 1e-9 ? THREE.MathUtils.clamp(((cx - tmpA0.x) * sx + (cz - tmpA0.y) * sz) / lenSq, 0, 1) : 0
  const px = tmpA0.x + sx * t, pz = tmpA0.y + sz * t
  const dx = px - cx, dz = pz - cz
  const dist = Math.hypot(dx, dz)
  const depth = fp.radius + radius - dist
  if (depth <= 0) return null
  const normal = dist > 1e-6 ? new THREE.Vector3(dx / dist, 0, dz / dist) : new THREE.Vector3(1, 0, 0)
  return { normal, depth }
}

/**
 * Distância de um ponto (px, pz) até o segmento a–b no chão.
 * @param {[number, number]} a
 * @param {[number, number]} b
 */
export function distanceToSegment(px, pz, a, b) {
  const sx = b[0] - a[0], sz = b[1] - a[1]
  const lenSq = sx * sx + sz * sz
  const t = lenSq > 1e-9 ? THREE.MathUtils.clamp(((px - a[0]) * sx + (pz - a[1]) * sz) / lenSq, 0, 1) : 0
  return Math.hypot(px - (a[0] + sx * t), pz - (a[1] + sz * t))
}

/**
 * Testa o carrinho contra uma cápsula parada (segmento a–b com raio), ex.:
 * uma parede de pneus.
 * @param {THREE.Vector2} a ponta do segmento (x, z)
 * @param {THREE.Vector2} b
 * @returns {{ normal: THREE.Vector3, depth: number } | null} normal da cápsula para o carro
 */
export function testCarCapsule(position, yaw, fp, a, b, radius) {
  capsuleSegment(position, yaw, fp, tmpA0, tmpA1)
  closestPointsSegments(tmpA0, tmpA1, a, b, closestA, closestB)
  const dx = closestA.x - closestB.x
  const dz = closestA.y - closestB.y
  const dist = Math.hypot(dx, dz)
  const depth = fp.radius + radius - dist
  if (depth <= 0) return null
  const normal = dist > 1e-6 ? new THREE.Vector3(dx / dist, 0, dz / dist) : new THREE.Vector3(1, 0, 0)
  return { normal, depth }
}
