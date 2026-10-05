import * as THREE from 'three'
import { LineSegments2 } from 'three/examples/jsm/lines/LineSegments2.js'
import { LineSegmentsGeometry } from 'three/examples/jsm/lines/LineSegmentsGeometry.js'
import { LineMaterial } from 'three/examples/jsm/lines/LineMaterial.js'
import { createToonMaterial } from './toon.js'
import { ULTIMATES } from './ultimate.js'

// Visual do ultimate (só desenho; as regras ficam em ultimate.js):
//  - feixe de luz onde o item vai estar: fraco no aviso, forte com o item lá
//  - o item (cristal elétrico girando) enquanto ninguém pegou
//  - o círculo da tempestade em volta de cada carro com a Sobrecarga ativa
//  - raios do dono até cada alvo atingido
//  - a Onda de choque: faixa no chão piscando (preparação) e, no disparo, 3
//    bastões de espinhos que saem do chão e correm pela faixa empurrando quem
//    estiver nela (afundam de volta no fim)
//  - o Míssil voando e o rastro reto (verde, como a lentidão do LoL) que deixa
//    lento, com contorno nas bordas e na ponta

const ELECTRIC = new THREE.Color('#ffd21f')
const BOLT_SEGMENTS = 8
const MAX_BOLTS = 12
const BOLT_LIFE = 0.18 // s
const BEAM_HEIGHT = 40
const MAX_STORMS = 8 // ao mesmo tempo (um por jogador)
const MAX_WAVES = 4
const MAX_MISSILES = 4
const TRAIL_COLOR = '#4cff6a'
const TRAIL_FADE = 1.5 // s finais em que o rastro vai sumindo
const WAVE_FADE = 0.35 // s da faixa sumir depois que a onda chega ao fim
const WAVE_COLOR = new THREE.Color('#ffb347')
const SLAM_COLOR = '#b86bff' // Emboscada
const MAX_BURSTS = 4
const BURST_LIFE = 0.45 // s do estouro abrir e sumir
const SPIKES = 3           // bastões lado a lado na faixa
const SPIKE_RISE = 0.14     // s para um bastão sair do chão
const SPIKE_STAGGER = 0.05  // s: o do meio sai primeiro, os dos lados logo depois
const SPIKE_LEAN = 0.35     // rad: inclinados para a frente, empurrando
const SPIKE_SPIN = 9        // rad/s girando enquanto correm
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

    // Emboscada: círculo de aviso no chão enquanto o dono reaparece, e o
    // estouro da batida (anel que se abre e some)
    this.slamMaterial = this.ringMaterial(0.8)
    this.slamFillMaterial = this.ringMaterial(0.08)
    for (const m of [this.slamMaterial, this.slamFillMaterial]) m.color.set(SLAM_COLOR)
    this.slamMeshes = []
    this.slams = Array.from({ length: MAX_STORMS }, () => {
      const group = new THREE.Group()
      for (const m of [new THREE.Mesh(ringGeometry, this.slamMaterial), new THREE.Mesh(fillGeometry, this.slamFillMaterial)]) {
        m.rotation.x = -Math.PI / 2
        group.add(m)
        this.slamMeshes.push(m)
      }
      group.visible = false
      scene.add(group)
      return group
    })
    this.bursts = Array.from({ length: MAX_BURSTS }, () => {
      const mesh = new THREE.Mesh(ringGeometry, this.ringMaterial(0))
      mesh.material.color.set(SLAM_COLOR)
      mesh.rotation.x = -Math.PI / 2
      mesh.visible = false
      scene.add(mesh)
      this.slamMeshes.push(mesh)
      return { mesh, age: Infinity, radius: 1 }
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
      const parts = { group, warn: null, trail: null, front: null, edges: [], spikes: [], cast: null, age: Infinity }
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

    // Mísseis: o projétil e o rastro. Por enquanto o míssil é uma cápsula;
    // para usar um modelo, troque o conteúdo de `missileMesh()` (o modelo
    // deve apontar para +Z, que é a direção do voo)
    this.trailMeshes = []
    this.missiles = Array.from({ length: MAX_MISSILES }, () => {
      const group = new THREE.Group()
      const { trailWidth } = ULTIMATES.missile
      const flat = (geometry, x) => {
        const m = new THREE.Mesh(geometry, this.ringMaterial(0))
        m.material.color.set(TRAIL_COLOR)
        m.position.set(x, 0.05, 0)
        group.add(m)
        this.trailMeshes.push(m)
        return m
      }
      const trail = flat(strip(trailWidth, 1), 0)
      // Contorno: duas bordas que acompanham o comprimento + a ponta
      const edges = [-1, 1].map((side) => flat(strip(0.22, 1), side * trailWidth / 2))
      const cap = flat(strip(trailWidth + 0.22, 0.22), 0)
      const missile = missileMesh()
      missile.position.y = 1.2
      group.add(missile)
      group.visible = false
      scene.add(group)
      return { group, trail, edges, cap, missile }
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

  /**
   * Modelo do bastão de espinhos (o mesmo da arena, pé no chão e centrado):
   * vira a frente da Onda de choque. Sem ele, a frente é uma faixa brilhante.
   */
  setSpikeModel(template) {
    const box = new THREE.Box3().setFromObject(template)
    this.spikeHeight = box.max.y - box.min.y
    for (const w of this.waves) {
      for (const s of w.spikes) w.group.remove(s.pivot)
      w.spikes = Array.from({ length: SPIKES }, (_, i) => {
        // pivot no pé: a inclinação gira em torno da base
        const pivot = new THREE.Group()
        const model = template.clone(true)
        model.rotation.y = Math.random() * Math.PI * 2
        pivot.add(model)
        pivot.visible = false
        w.group.add(pivot)
        return { pivot, model, delay: i === (SPIKES - 1) / 2 ? 0 : SPIKE_STAGGER }
      })
    }
  }

  /** Malhas que o contorno deve ignorar (transparentes / brilho). */
  get meshes() {
    return [this.beam, this.pad, this.boltLines, ...this.stormMeshes, ...this.slamMeshes, ...this.waveMeshes, ...this.trailMeshes]
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

  /** Estouro da batida da Emboscada em `position`, abrindo até `radius`. */
  burst(position, radius) {
    const b = this.bursts.reduce((oldest, x) => (x.age > oldest.age ? x : oldest))
    b.age = 0
    b.radius = radius
    b.mesh.position.set(position.x, 0.08, position.z)
    b.mesh.visible = true
  }

  /** Raio do ponto `from` até `to` (posições no mundo). */
  bolt(from, to) {
    if (this.bolts.length >= MAX_BOLTS) this.bolts.shift()
    this.bolts.push({ from: from.clone(), to: to.clone(), age: 0 })
  }

  /**
   * @param {number} dt
   * @param {{ phase: string, storms: { position: THREE.Vector3, radius: number }[], missiles: import('./ultimate.js').MissileShot[] }} state
   *   storms = carros com a Sobrecarga ativa; missiles = mísseis voando ou com rastro
   */
  update(dt, { phase, x = 0, z = 0, storms, missiles = [], slams = [] }) {
    this.time += dt
    const t = this.time
    this.beacon.position.set(x, 0, z)

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
    const stormBlink = 0.5 + 0.5 * Math.sin(t * 30) // pisca rápido, como a faixa da onda de choque
    this.stormMaterial.opacity = 0.5 + 0.4 * stormBlink
    this.stormFillMaterial.opacity = 0.12 + 0.2 * stormBlink

    // Emboscada: círculo de aviso piscando rápido em cada dono reaparecendo
    slams.forEach(({ position, radius }, i) => {
      const g = this.slams[i]
      if (!g) return
      g.visible = true
      g.position.set(position.x, 0.05, position.z)
      g.scale.setScalar(radius)
    })
    for (let i = slams.length; i < this.slams.length; i++) this.slams[i].visible = false
    const slamBlink = 0.5 + 0.5 * Math.sin(t * 40)
    this.slamMaterial.opacity = 0.5 + 0.45 * slamBlink
    this.slamFillMaterial.opacity = 0.12 + 0.25 * slamBlink
    for (const b of this.bursts) {
      if (!b.mesh.visible) continue
      b.age += dt
      if (b.age >= BURST_LIFE) {
        b.mesh.visible = false
        continue
      }
      const k = b.age / BURST_LIFE
      b.mesh.scale.setScalar(b.radius * (0.3 + 0.7 * k))
      b.mesh.material.opacity = 0.95 * (1 - k)
    }

    this.updateWaves(dt)
    this.updateMissiles(missiles)
    this.updateBolts(dt)
  }

  updateMissiles(shots) {
    this.missiles.forEach((m, i) => {
      const shot = shots[i]
      m.group.visible = !!shot
      if (!shot) return
      m.group.position.set(shot.origin.x, 0, shot.origin.z)
      m.group.rotation.y = Math.atan2(shot.dir.x, shot.dir.z)
      const traveled = shot.traveled
      m.missile.visible = shot.flying
      m.missile.position.z = traveled
      m.missile.rotation.z = this.time * 12 // gira no próprio eixo
      const length = Math.max(traveled, 0.001)
      m.trail.scale.z = length
      for (const e of m.edges) e.scale.z = length
      m.cap.position.z = Math.max(traveled - 0.22, 0)
      // Rastro: forte enquanto existe, sumindo nos segundos finais
      const left = shot.length / shot.spec.speed + shot.spec.trailLife - shot.time
      const fade = Math.min(1, left / TRAIL_FADE)
      m.trail.material.opacity = 0.3 * fade * (0.85 + 0.15 * Math.sin(this.time * 8))
      for (const e of [...m.edges, m.cap]) e.material.opacity = 0.9 * fade
    })
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
        for (const s of w.spikes) s.pivot.visible = false
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
      // Com os bastões, a frente são eles (a faixa brilhante só sem o modelo)
      w.front.material.opacity = w.spikes.length ? 0 : 0.95 * fade
      this.poseSpikes(w, dt, front, w.age - windup, w.age - end)
    }
  }

  // Bastões da Onda de choque: saem do chão (com um pulinho) no começo da
  // faixa, correm com a frente da onda inclinados para a frente, girando, e
  // afundam de volta quando ela chega ao fim. `since` = s desde o disparo;
  // `after` = s desde o fim do percurso (< 0 = ainda correndo)
  poseSpikes(w, dt, front, since, after) {
    const height = this.spikeHeight
    const spacing = w.spec.width / SPIKES
    w.spikes.forEach((s, i) => {
      const t = since - s.delay
      s.pivot.visible = t > 0
      if (t <= 0) return
      // Subida com passada do ponto (easeOutBack) e descida linear no fim
      const k = Math.min(1, t / SPIKE_RISE)
      const rise = 1 + 2.2 * (k - 1) ** 3 + 1.2 * (k - 1) ** 2
      const sink = after > 0 ? Math.min(1, after / WAVE_FADE) : 0
      const up = Math.min(rise, 1.15) * (1 - sink)
      s.pivot.position.set((i - (SPIKES - 1) / 2) * spacing, -height * (1 - up), front)
      s.pivot.rotation.x = SPIKE_LEAN * k * (1 - sink) // topo para +Z: empurrando
      s.model.rotation.y += SPIKE_SPIN * (1 - sink) * dt
    })
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

// Míssil provisório: cápsula laranja brilhante deitada, apontando para +Z
function missileMesh() {
  const mesh = new THREE.Mesh(
    new THREE.CapsuleGeometry(0.35, 1.6, 6, 16).rotateX(Math.PI / 2),
    createToonMaterial({ color: '#ff8a2a', emissive: '#7a2a00', glossiness: 10 }),
  )
  mesh.castShadow = true
  return mesh
}
