import * as THREE from 'three'
import { createToonMaterial } from './toon.js'
import { MEDKIT } from './medkit.js'

// Visual da zona de cura: círculo vermelho no chão (borda pulsando e
// preenchimento que vai apagando conforme o tempo acaba) e, no meio, um
// comprimido de remédio (metade vermelha, metade branca) inclinado, flutuando
// e girando. Só desenho; as regras ficam em medkit.js.

const RADIUS = 0.42
const HALF = 0.55   // comprimento da parte reta de cada metade
const TILT = 0.5    // rad de inclinação

// Metade de cápsula (meia esfera + cilindro), em pé, com a base em y = 0
function halfCapsule() {
  const points = []
  for (let i = 0; i <= 10; i++) {
    const a = (i / 10) * (Math.PI / 2)
    points.push(new THREE.Vector2(Math.sin(a) * RADIUS, HALF + Math.cos(a) * RADIUS))
  }
  points.push(new THREE.Vector2(RADIUS, 0))
  return new THREE.LatheGeometry(points, 28)
}

export class MedkitView {
  constructor(scene) {
    this.time = 0
    this.root = new THREE.Group()
    this.root.visible = false

    // Pivô inclinado; a cápsula gira em volta do próprio eixo dentro dele, e
    // o pivô gira em volta do eixo vertical (a inclinação "passeia")
    this.tilt = new THREE.Group()
    this.tilt.rotation.z = TILT
    this.pill = new THREE.Group()
    const geometry = halfCapsule()
    const red = new THREE.Mesh(geometry, createToonMaterial({ color: '#e8233a', emissive: '#5a0010', glossiness: 12 }))
    const white = new THREE.Mesh(geometry, createToonMaterial({ color: '#f4f1e8', glossiness: 12 }))
    white.rotation.x = Math.PI // a outra metade, virada para baixo
    for (const m of [red, white]) {
      m.castShadow = true
      this.pill.add(m)
    }
    this.tilt.add(this.pill)
    this.root.add(this.tilt)

    // Círculo da zona: borda + preenchimento
    const flat = (geometry, opacity) => {
      const m = new THREE.Mesh(geometry, new THREE.MeshBasicMaterial({
        color: '#ff3d55', transparent: true, opacity, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
      }))
      m.rotation.x = -Math.PI / 2
      m.position.y = 0.04
      this.root.add(m)
      return m
    }
    this.ring = flat(new THREE.RingGeometry(MEDKIT.radius - 0.35, MEDKIT.radius, 72), 0.8)
    this.fill = flat(new THREE.CircleGeometry(MEDKIT.radius, 72), 0.15)
    scene.add(this.root)
  }

  /** Malhas que o contorno deve ignorar (transparentes). */
  get meshes() {
    return [this.ring, this.fill]
  }

  /** @param {{ x: number, z: number, timer: number } | null} at a zona (null = nenhuma); timer = s restantes */
  update(dt, at) {
    this.root.visible = !!at
    if (!at) return
    this.time += dt
    const t = this.time
    this.root.position.set(at.x, 0, at.z)
    this.tilt.position.y = 1.5 + Math.sin(t * 2.2) * 0.22
    this.tilt.rotation.y = t * 1.2 // a inclinação gira em volta
    this.pill.rotation.y = t * 4   // e a cápsula gira no próprio eixo
    const pulse = 0.5 + 0.5 * Math.sin(t * 5)
    const left = Math.max(0, Math.min(1, at.timer / MEDKIT.duration)) // 1 → 0
    this.ring.scale.setScalar(1 + 0.03 * pulse)
    this.ring.material.opacity = 0.45 + 0.4 * pulse
    this.fill.material.opacity = 0.06 + 0.16 * left // apaga conforme o tempo acaba
    // Nos 2 s finais a borda pisca: está acabando
    this.ring.visible = at.timer > 2 || Math.sin(t * 25) > 0
  }
}
