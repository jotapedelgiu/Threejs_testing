import * as THREE from 'three'

// Câmera de grupo: ângulo fixo (inclinação/rotação), mas o centro e a
// distância seguem todos os carrinhos. Mira o meio da caixa que envolve os
// carros e se afasta o suficiente para todos caberem no quadro, com margem.
//
// Roda a cada quadro, então não cria objetos: tudo é reaproveitado.

const MAX_POINTS = 16

export class GroupCamera {
  params = {
    elevation: 45,
    azimuth: 180,
    fov: 35,
    minDistance: 22,  // zoom máximo (todos juntos ou jogando sozinho)
    maxDistance: 90,  // zoom out máximo
    margin: 4,        // folga em volta dos carros (m)
    lookAhead: 0.5,   // s: enquadra onde cada carro vai estar, não só onde está
    smoothing: 3,     // quanto maior, mais rápido a câmera acompanha
  }

  center = new THREE.Vector3()
  distance = this.params.minDistance

  constructor(camera) {
    this.camera = camera
    this.back = new THREE.Vector3()  // do alvo para a câmera
    this.right = new THREE.Vector3()
    this.up = new THREE.Vector3()
    this.ready = false
    // Reaproveitados a cada quadro
    this.points = Array.from({ length: MAX_POINTS }, () => new THREE.Vector3())
    this.box = new THREE.Box3()
    this.target = new THREE.Vector3()
    this.rel = new THREE.Vector3()
    this.updateAxes()
  }

  /** Chamar ao mudar inclinação, rotação ou campo de visão. */
  updateAxes() {
    const p = this.params
    const phi = THREE.MathUtils.degToRad(90 - p.elevation)
    const theta = THREE.MathUtils.degToRad(p.azimuth)
    this.back.setFromSphericalCoords(1, phi, theta)
    // Mesma base que o camera.lookAt monta
    this.right.crossVectors(THREE.Object3D.DEFAULT_UP, this.back).normalize()
    this.up.crossVectors(this.back, this.right)
    this.camera.fov = p.fov
    this.camera.updateProjectionMatrix()
  }

  /**
   * @param {number} dt
   * @param {{ position: THREE.Vector3, velocity: THREE.Vector3 }[]} subjects
   */
  update(dt, subjects) {
    const p = this.params
    let count = 0
    for (const { position, velocity } of subjects) {
      if (count === MAX_POINTS) break
      this.points[count++].copy(position).addScaledVector(velocity, p.lookAhead).setY(1)
    }

    if (count) {
      // Centro: meio da caixa dos carros no chão
      this.box.makeEmpty()
      for (let i = 0; i < count; i++) this.box.expandByPoint(this.points[i])
      const target = this.box.getCenter(this.target).setY(0)

      // Distância para cada ponto caber no quadro: a meia-largura visível a
      // uma profundidade z é z * tan(fov/2); o ponto fica a (d - rel·back)
      const tanY = Math.tan(THREE.MathUtils.degToRad(p.fov) / 2)
      const tanX = tanY * this.camera.aspect
      let distance = p.minDistance
      for (let i = 0; i < count; i++) {
        const rel = this.rel.subVectors(this.points[i], target)
        const depthOffset = rel.dot(this.back)
        const x = Math.abs(rel.dot(this.right)) + p.margin
        const y = Math.abs(rel.dot(this.up)) + p.margin
        distance = Math.max(distance, x / tanX + depthOffset, y / tanY + depthOffset)
      }
      distance = Math.min(distance, p.maxDistance)

      if (!this.ready) {
        this.center.copy(target)
        this.distance = distance
        this.ready = true
      } else {
        this.center.lerp(target, 1 - Math.exp(-p.smoothing * dt))
        // Afasta rápido (ninguém sai do quadro), aproxima devagar (sem "respirar")
        const zoomRate = distance > this.distance ? p.smoothing * 2 : p.smoothing * 0.4
        this.distance += (distance - this.distance) * (1 - Math.exp(-zoomRate * dt))
      }
    }

    this.camera.position.copy(this.center).addScaledVector(this.back, this.distance)
    this.camera.lookAt(this.center)
  }
}
