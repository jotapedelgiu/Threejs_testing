import * as THREE from 'three'
import { LineSegments2 } from 'three/examples/jsm/lines/LineSegments2.js'
import { LineSegmentsGeometry } from 'three/examples/jsm/lines/LineSegmentsGeometry.js'
import { LineMaterial } from 'three/examples/jsm/lines/LineMaterial.js'
import { createToonMaterial } from './toon.js'
import { ULTIMATES } from './ultimate.js'

// Visual do ultimate (só desenho; as regras ficam em ultimate.js):
//  - feixe de luz no centro da arena: fraco no aviso, forte com o item lá
//  - o item (cristal elétrico girando) enquanto ninguém pegou
//  - o círculo da tempestade em volta de cada carro com a Sobrecarga ativa
//  - raios do dono até cada alvo atingido
//  - a Onda de choque: faixa no chão piscando (preparação) e a frente da
//    onda correndo por ela (disparo)

const ELECTRIC = new THREE.Color('#ffd21f')
const BOLT_SEGMENTS = 8
const MAX_BOLTS = 12
const BOLT_LIFE = 0.18 // s
const BEAM_HEIGHT = 40
const MAX_STORMS = 8 // ao mesmo tempo (um por jogador)
const MAX_WAVES = 4
const WAVE_FADE = 0.35 // s da faixa sumir depois que a onda chega ao fim
const WAVE_COLOR = new THREE.Color('#ffb347')
const tmpA = new THREE.Vector3()
const tmpB = new THREE.Vector3()

export class UltimateView {
  constructor(scene) {
    this.time = 0

    // Feixe + cristal no centro
    this.beacon = new THREE.Group()
    this.beamMaterial = new THREE.MeshBasicMaterial({
      color: ELECTRIC, transparent: true, opacity: 0, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
    })
    this.beam = new THREE.Mesh(new THREE.CylinderGeometry(1.1, 1.1, BEAM_HEIGHT, 24, 1, true), this.beamMaterial)
    this.beam.position.y = BEAM_HEIGHT / 2
    this.crystal = new THREE.Mesh(
      new THREE.OctahedronGeometry(0.9),
      createToonMaterial({ color: '#fff3a0', emissive: '#c79a00', glossiness: 10 }),
    )
    this.crystal.castShadow = true
    this.padMaterial = this.ringMaterial(0)
    this.pad = new THREE.Mesh(new THREE.RingGeometry(2.1, 2.5, 48), this.padMaterial)
    this.pad.rotation.x = -Math.PI / 2
    this.pad.position.y = 0.03
    this.beacon.add(this.beam, this.crystal, this.pad)
    scene.add(this.beacon)

    // Círculos das tempestades: um por carro com a Sobrecarga ativa
    this.stormMaterial = this.ringMaterial(0.8)
    this.stormFillMaterial = this.ringMaterial(0.08)
    const ringGeometry = new THREE.RingGeometry(0.94, 1, 72)
    const fillGeometry = new THREE.CircleGeometry(1, 72)
    this.stormMeshes = []
    this.storms = Array.from({ length: MAX_STORMS }, () => {
      const group = new THREE.Group()
      for (const m of [new THREE.Mesh(ringGeometry, this.stormMaterial), new THREE.Mesh(fillGeometry, this.stormFillMaterial)]) {
        m.rotation.x = -Math.PI / 2
        group.add(m)
        this.stormMeshes.push(m)
      }
      group.visible = false
      scene.add(group)
      return group
    })

    // Ondas de choque: cada uma é um grupo virado para a direção da faixa
    // (+Z local = para a frente), com: faixa de aviso, rastro (o que a onda
    // já percorreu) e a frente brilhante. Materiais próprios por onda
    // (a transparência muda conforme ela avança)
    const strip = (width, length) => {
      const g = new THREE.PlaneGeometry(width, length)
      g.rotateX(-Math.PI / 2)
      g.translate(0, 0, length / 2) // de z = 0 (carro) até z = length
      return g
    }
    this.waveMeshes = []
    this.waves = Array.from({ length: MAX_WAVES }, () => {
      const group = new THREE.Group()
      const mesh = (geometry, color) => {
        const m = new THREE.Mesh(geometry, this.ringMaterial(0))
        m.material.color.set(color)
        group.add(m)
        this.waveMeshes.push(m)
        return m
      }
      const parts = { group, warn: null, trail: null, front: null, edges: [], cast: null, age: Infinity }
      group.position.y = 0.06
      group.visible = false
      scene.add(group)
      parts.build = (spec) => {
        if (parts.spec === spec) return
        parts.spec = spec
        for (const m of [parts.warn, parts.trail, parts.front, ...parts.edges]) if (m) group.remove(m)
        parts.warn = mesh(strip(spec.width, spec.length), WAVE_COLOR)
        parts.trail = mesh(strip(spec.width, spec.length), '#fff2d6')
        parts.front = mesh(strip(spec.width, 1.2), '#ffffff')
        parts.edges = [-1, 1].map((side) => {
          const e = mesh(strip(0.25, spec.length), WAVE_COLOR)
          e.position.x = side * spec.width / 2
          return e
        })
      }
      parts.build(ULTIMATES.shockwave) // já no começo: o contorno lê a lista de malhas uma vez só
      return parts
    })

    // Raios: uma única malha de linhas grossas para todos
    const geometry = new LineSegmentsGeometry()
    geometry.setPositions(new Float32Array(MAX_BOLTS * BOLT_SEGMENTS * 6))
    geometry.instanceCount = 0
    this.boltMaterial = new LineMaterial({
      color: 0xfff6c0, linewidth: 4, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
    })
    this.boltLines = new LineSegments2(geometry, this.boltMaterial)
    this.boltLines.frustumCulled = false
    this.boltLines.renderOrder = 11
    this.boltPositions = geometry.attributes.instanceStart.data.array
    scene.add(this.boltLines)
    this.bolts = [] // { from, to, age }
  }

  ringMaterial(opacity) {
    return new THREE.MeshBasicMaterial({
      color: ELECTRIC, transparent: true, opacity, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
    })
  }

  /** Malhas que o contorno deve ignorar (transparentes / brilho). */
  get meshes() {
    return [this.beam, this.pad, this.boltLines, ...this.stormMeshes, ...this.waveMeshes]
  }

  /** Linhas grossas medem em pixels: chamar ao criar e ao redimensionar. */
  setSize(width, height, pixelRatio) {
    this.boltMaterial.resolution.set(width * pixelRatio, height * pixelRatio)
    this.boltMaterial.linewidth = 4 * pixelRatio
  }

  /**
   * Onda de choque saindo de `origin` na direção `yaw` (mesmo ângulo do
   * carro). `onLaunch` é chamado quando a preparação acaba e a onda sai.
   */
  shockwave(origin, yaw, spec, onLaunch) {
    const w = this.waves.reduce((oldest, x) => (x.age > oldest.age ? x : oldest))
    w.build(spec)
    w.age = 0
    w.launched = false
    w.onLaunch = onLaunch
    w.group.position.set(origin.x, 0.06, origin.z)
    w.group.rotation.y = yaw
    w.group.visible = true
  }

  /** Raio do ponto `from` até `to` (posições no mundo). */
  bolt(from, to) {
    if (this.bolts.length >= MAX_BOLTS) this.bolts.shift()
    this.bolts.push({ from: from.clone(), to: to.clone(), age: 0 })
  }

  /**
   * @param {number} dt
   * @param {{ phase: string, storms: { position: THREE.Vector3, radius: number }[] }} state
   *   storms = carros com a Sobrecarga ativa
   */
  update(dt, { phase, storms }) {
    this.time += dt
    const t = this.time

    // Centro: aviso = feixe fraco piscando; item lá = feixe forte + cristal
    const warning = phase === 'warning', available = phase === 'available'
    this.beacon.visible = warning || available
    this.beamMaterial.opacity = available ? 0.32 + 0.08 * Math.sin(t * 6) : warning ? 0.08 + 0.06 * Math.sin(t * 10) : 0
    this.padMaterial.opacity = available ? 0.8 : warning ? 0.35 : 0
    this.crystal.visible = available
    this.crystal.position.y = 1.6 + Math.sin(t * 2.5) * 0.25
    this.crystal.rotation.y = t * 2
    this.crystal.scale.setScalar(1 + 0.08 * Math.sin(t * 8))

    // Tempestades em volta de cada dono
    storms.forEach(({ position, radius }, i) => {
      const g = this.storms[i]
      if (!g) return
      g.visible = true
      g.position.set(position.x, 0.05, position.z)
      g.scale.setScalar(radius * (1 + 0.015 * Math.sin(t * 20)))
    })
    for (let i = storms.length; i < this.storms.length; i++) this.storms[i].visible = false
    this.stormMaterial.opacity = 0.55 + 0.35 * Math.abs(Math.sin(t * 9))

    this.updateWaves(dt)
    this.updateBolts(dt)
  }

  updateWaves(dt) {
    const t = this.time
    for (const w of this.waves) {
      if (!w.group.visible) continue
      w.age += dt
      const { windup, travel, length } = w.spec
      const end = windup + travel
      if (w.age >= end + WAVE_FADE) {
        w.group.visible = false
        continue
      }
      const fade = w.age > end ? 1 - (w.age - end) / WAVE_FADE : 1
      if (w.age < windup) {
        // Preparação: a faixa pisca cada vez mais rápido
        const k = w.age / windup
        const blink = 0.5 + 0.5 * Math.sin(t * (14 + 30 * k))
        w.warn.material.opacity = 0.12 + 0.2 * blink
        for (const e of w.edges) e.material.opacity = 0.5 + 0.4 * blink
        w.trail.material.opacity = 0
        w.front.material.opacity = 0
        continue
      }
      if (!w.launched) {
        w.launched = true
        w.onLaunch?.()
      }
      // Disparo: a frente corre pela faixa deixando um rastro claro
      const front = Math.min(1, (w.age - windup) / travel) * length
      w.warn.material.opacity = 0.1 * fade
      for (const e of w.edges) e.material.opacity = 0.7 * fade
      w.trail.scale.z = Math.max(front / length, 0.001)
      w.trail.material.opacity = 0.35 * fade
      w.front.position.z = Math.max(front - 0.6, 0)
      w.front.material.opacity = 0.95 * fade
    }
  }

  // Cada raio é uma linha quebrada, sorteada de novo a cada quadro (tremula)
  updateBolts(dt) {
    let alive = 0
    for (const b of this.bolts) {
      b.age += dt
      if (b.age < BOLT_LIFE) this.bolts[alive++] = b
    }
    this.bolts.length = alive
    const p = this.boltPositions
    let k = 0
    const a = tmpA, c = tmpB
    for (const b of this.bolts) {
      a.copy(b.from)
      const len = b.from.distanceTo(b.to)
      for (let i = 1; i <= BOLT_SEGMENTS; i++) {
        c.lerpVectors(b.from, b.to, i / BOLT_SEGMENTS)
        if (i < BOLT_SEGMENTS) {
          const j = len * 0.06
          c.x += (Math.random() - 0.5) * j
          c.y += (Math.random() - 0.5) * j
          c.z += (Math.random() - 0.5) * j
        }
        p[k++] = a.x; p[k++] = a.y; p[k++] = a.z
        p[k++] = c.x; p[k++] = c.y; p[k++] = c.z
        a.copy(c)
      }
    }
    this.boltLines.geometry.instanceCount = this.bolts.length * BOLT_SEGMENTS
    this.boltLines.geometry.attributes.instanceStart.data.needsUpdate = true
  }
}
