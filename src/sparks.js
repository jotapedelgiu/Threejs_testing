import * as THREE from 'three'
import { LineSegments2 } from 'three/examples/jsm/lines/LineSegments2.js'
import { LineSegmentsGeometry } from 'three/examples/jsm/lines/LineSegmentsGeometry.js'
import { LineMaterial } from 'three/examples/jsm/lines/LineMaterial.js'

// Faíscas elétricas da haste do bate-bate: o contato com a grade do teto solta
// faíscas e pequenos arcos. Quanto mais rápido o carro, mais faíscas.
//
// Puramente visual (não passa pela rede): cada jogador desenha o efeito de
// todos os carros a partir da velocidade que já conhece.
//
// Desempenho: um pool fixo de partículas (Object Pool) e um único desenho para
// todas as faíscas de todos os carros (e outro para os arcos). Nada é criado
// a cada quadro; os buffers são escritos no lugar.
//
// As linhas são "fat lines" (LineSegments2): linhas comuns do WebGL têm 1 px
// e sumiriam com a câmera afastada.

const MAX_SPARKS = 600
const ARC_SEGMENTS = 7         // pedaços de cada raio
const MAX_ARCS = 16            // carros com arco ao mesmo tempo
const GRAVITY = 18             // m/s²
const STREAK = 0.05            // s: comprimento do risco (rastro da velocidade)

// Cores: amarelo de faísca estática. Cada faísca nasce quase branca e esfria
// para a cor do painel; o arco é a mesma cor, mais clara
const WHITE = new THREE.Color('#ffffff')
const tmpHot = new THREE.Color()
const tmpArc = new THREE.Color()

const tmpColor = new THREE.Color()
const tmpTip = new THREE.Vector3()

export class SparkEffects {
  params = {
    enabled: true,
    intensity: 1,   // multiplica a quantidade de faíscas
    arcs: 1,        // multiplica a frequência dos arcos
    width: 1.5,     // espessura das linhas, em pixels CSS
    color: '#ffd21f', // amarelo estático
  }

  constructor(scene) {
    // Pool de partículas (structure of arrays: dados contíguos, sem objetos)
    this.alive = 0
    this.pos = new Float32Array(MAX_SPARKS * 3)
    this.vel = new Float32Array(MAX_SPARKS * 3)
    this.age = new Float32Array(MAX_SPARKS)
    this.life = new Float32Array(MAX_SPARKS)

    this.sparkLines = this.createLines(MAX_SPARKS)
    this.arcLines = this.createLines(MAX_ARCS * ARC_SEGMENTS)
    scene.add(this.sparkLines.mesh, this.arcLines.mesh)
    this.arcCount = 0
  }

  createLines(capacity) {
    const geometry = new LineSegmentsGeometry()
    const positions = new Float32Array(capacity * 6)
    const colors = new Float32Array(capacity * 6)
    geometry.setPositions(positions)
    geometry.setColors(colors)
    geometry.instanceCount = 0
    const material = new LineMaterial({
      linewidth: this.params.width,
      vertexColors: true,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending, // brilho: cores somam
    })
    const mesh = new LineSegments2(geometry, material)
    mesh.frustumCulled = false // os buffers mudam todo quadro
    mesh.renderOrder = 10
    return {
      mesh,
      material,
      geometry,
      // Arrays de verdade por trás dos atributos, escritos direto
      positions: geometry.attributes.instanceStart.data.array,
      colors: geometry.attributes.instanceColorStart.data.array,
    }
  }

  /** Chamar ao criar e ao redimensionar (linhas grossas medem em pixels). */
  setSize(width, height, pixelRatio) {
    for (const l of [this.sparkLines, this.arcLines]) {
      l.material.resolution.set(width * pixelRatio, height * pixelRatio)
      l.material.linewidth = this.params.width * pixelRatio
    }
    this.pixelRatio = pixelRatio
  }

  /**
   * Avança as faíscas e emite novas para cada carro.
   * @param {number} dt
   * @param {{ tip: THREE.Vector3, body: THREE.Object3D, velocity: THREE.Vector3, power: number }[]} emitters
   *   tip = ponta da haste em coordenadas do body; power = 0 parado, 1 na
   *   velocidade máxima, mais que 1 com boost
   */
  update(dt, emitters) {
    const p = this.params
    for (const l of [this.sparkLines, this.arcLines]) {
      l.mesh.visible = p.enabled
      l.material.linewidth = p.width * (this.pixelRatio ?? 1)
    }
    if (!p.enabled) return

    // Cores do quadro (a cor do painel pode ter mudado)
    this.cool = (this.cool ??= new THREE.Color()).set(p.color)
    tmpHot.copy(this.cool).lerp(WHITE, 0.75)
    tmpArc.copy(this.cool).lerp(WHITE, 0.45)

    this.arcCount = 0
    for (const e of emitters) {
      // A pose do carro pode ter mudado neste quadro (interpolação, quique)
      e.body.updateWorldMatrix(true, false)
      const tip = e.body.localToWorld(tmpTip.copy(e.tip))
      this.emit(dt, tip, e.velocity, e.power)
      this.arc(tip, e.power)
    }
    this.simulate(dt)
    this.writeSparks()
    this.arcLines.geometry.instanceCount = this.arcCount * ARC_SEGMENTS
    this.arcLines.geometry.attributes.instanceStart.data.needsUpdate = true
    this.arcLines.geometry.attributes.instanceColorStart.data.needsUpdate = true
  }

  // Faíscas novas: quantidade cresce mais rápido que a velocidade (power^1.5)
  // e há um estalinho ocasional mesmo parado
  emit(dt, tip, carVelocity, power) {
    const rate = 150 * this.params.intensity * (0.03 + Math.pow(power, 1.5))
    // Número fracionário vira probabilidade (ex.: 0.3 faísca = 30% de chance)
    let count = rate * dt
    count = Math.floor(count) + (Math.random() < count % 1 ? 1 : 0)
    const speed = 2 + 5 * Math.min(power, 2)
    for (let n = 0; n < count && this.alive < MAX_SPARKS; n++) {
      const i = this.alive++
      // Direção aleatória para cima e para os lados; herda um pouco do
      // movimento do carro e espirra para trás dele
      const a = Math.random() * Math.PI * 2
      const up = 0.3 + Math.random() * 0.9
      const s = speed * (0.4 + Math.random() * 0.6)
      this.pos[i * 3] = tip.x
      this.pos[i * 3 + 1] = tip.y
      this.pos[i * 3 + 2] = tip.z
      this.vel[i * 3] = Math.cos(a) * s - carVelocity.x * 0.35
      this.vel[i * 3 + 1] = up * s
      this.vel[i * 3 + 2] = Math.sin(a) * s - carVelocity.z * 0.35
      this.age[i] = 0
      this.life[i] = 0.25 + Math.random() * 0.3
    }
  }

  simulate(dt) {
    let i = 0
    while (i < this.alive) {
      this.age[i] += dt
      if (this.age[i] >= this.life[i]) {
        // Morreu: o último vivo ocupa o lugar (remoção O(1), sem buracos)
        const last = --this.alive
        for (let k = 0; k < 3; k++) {
          this.pos[i * 3 + k] = this.pos[last * 3 + k]
          this.vel[i * 3 + k] = this.vel[last * 3 + k]
        }
        this.age[i] = this.age[last]
        this.life[i] = this.life[last]
        continue
      }
      this.vel[i * 3 + 1] -= GRAVITY * dt
      for (let k = 0; k < 3; k++) this.pos[i * 3 + k] += this.vel[i * 3 + k] * dt
      i++
    }
  }

  // Cada faísca vira um risco: da posição atual até um pouco atrás
  writeSparks() {
    const { positions, colors, geometry } = this.sparkLines
    for (let i = 0; i < this.alive; i++) {
      const o = i * 6
      for (let k = 0; k < 3; k++) {
        positions[o + k] = this.pos[i * 3 + k]
        positions[o + 3 + k] = this.pos[i * 3 + k] - this.vel[i * 3 + k] * STREAK
      }
      // Esfria de quase branco para amarelo e apaga no fim (aditivo: escuro = invisível)
      const t = this.age[i] / this.life[i]
      tmpColor.copy(tmpHot).lerp(this.cool, Math.min(t * 1.6, 1)).multiplyScalar(1 - t * t)
      colors[o] = colors[o + 3] = tmpColor.r
      colors[o + 1] = colors[o + 4] = tmpColor.g
      colors[o + 2] = colors[o + 5] = tmpColor.b
    }
    geometry.instanceCount = this.alive
    geometry.attributes.instanceStart.data.needsUpdate = true
    geometry.attributes.instanceColorStart.data.needsUpdate = true
  }

  // Raio em zigue-zague subindo da ponta da haste, piscando; aparece mais
  // vezes e fica maior com a velocidade
  arc(tip, power) {
    if (this.arcCount >= MAX_ARCS) return
    const chance = this.params.arcs * Math.min(0.08 + power * 0.35, 0.9)
    if (Math.random() > chance) return
    const { positions, colors } = this.arcLines
    const height = 0.35 + 0.6 * Math.min(power, 1.8) * (0.6 + Math.random() * 0.4)
    const jitter = 0.08 + 0.08 * Math.min(power, 1.8)
    const brightness = 0.6 + Math.random() * 0.4
    let x = tip.x, y = tip.y, z = tip.z
    for (let s = 0; s < ARC_SEGMENTS; s++) {
      const o = (this.arcCount * ARC_SEGMENTS + s) * 6
      const nx = tip.x + (Math.random() * 2 - 1) * jitter
      const ny = tip.y + (height * (s + 1)) / ARC_SEGMENTS
      const nz = tip.z + (Math.random() * 2 - 1) * jitter
      positions[o] = x; positions[o + 1] = y; positions[o + 2] = z
      positions[o + 3] = nx; positions[o + 4] = ny; positions[o + 5] = nz
      // Mais forte perto da haste
      const fade = brightness * (1 - (s / ARC_SEGMENTS) * 0.6)
      colors[o] = colors[o + 3] = tmpArc.r * fade
      colors[o + 1] = colors[o + 4] = tmpArc.g * fade
      colors[o + 2] = colors[o + 5] = tmpArc.b * fade
      x = nx; y = ny; z = nz
    }
    this.arcCount++
  }

  /** Objetos que o passe de contorno deve ignorar (linhas não têm normal). */
  get meshes() {
    return [this.sparkLines.mesh, this.arcLines.mesh]
  }
}

/**
 * Ponta da haste, em coordenadas do `body`. A haste sobe reta e, no alto,
 * pode fazer um gancho (no bate-bate ela dobra para trás); a ponta é o fim
 * desse gancho: entre os vértices do topo, o mais longe da haste vertical,
 * centralizado na espessura do tubo. Chamar com o carro na origem e sem
 * rotação.
 */
export function findPoleTip(model, body) {
  body.updateMatrixWorld(true)
  const inverse = new THREE.Matrix4().copy(body.matrixWorld).invert()
  const v = new THREE.Vector3()
  // Percorre todos os vértices em coordenadas do body (sem guardar todos:
  // o modelo tem centenas de milhares)
  const forEachVertex = (fn) => model.traverse((o) => {
    if (!o.isMesh) return
    const pos = o.geometry.getAttribute('position')
    const toBody = new THREE.Matrix4().multiplyMatrices(inverse, o.matrixWorld)
    for (let i = 0; i < pos.count; i++) fn(v.fromBufferAttribute(pos, i).applyMatrix4(toBody))
  })

  let top = -Infinity
  forEachVertex((p) => { if (p.y > top) top = p.y })
  // Só o topo interessa: guarda os vértices dos últimos 60 cm
  const near = []
  forEachVertex((p) => { if (p.y > top - 0.6) near.push(p.clone()) })

  // Eixo da haste vertical: média dos vértices um pouco abaixo do topo
  const shaft = near.filter((p) => p.y < top - 0.3)
  const axisX = shaft.reduce((sum, p) => sum + p.x, 0) / shaft.length
  const axisZ = shaft.reduce((sum, p) => sum + p.z, 0) / shaft.length
  const reach = (p) => Math.hypot(p.x - axisX, p.z - axisZ)

  // Ponta: o vértice do topo mais longe do eixo; depois a média dos vértices
  // em volta dela (centro do tubo, não a casca)
  const crown = near.filter((p) => p.y > top - 0.15)
  const far = crown.reduce((a, b) => (reach(b) > reach(a) ? b : a))
  const end = crown.filter((p) => p.distanceTo(far) < 0.06)
  return end.reduce((sum, p) => sum.add(p), new THREE.Vector3()).divideScalar(end.length)
}
