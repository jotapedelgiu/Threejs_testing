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
    focus: 0.55,      // 0 = meio do grupo, 1 = em cima do jogador
    safeZone: 0.6,    // fração do quadro onde o jogador pode ficar (1 = até a borda)
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
    this.focusPoint = new THREE.Vector3()
    this.flat = new THREE.Vector3()
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
   * Garante que o jogador fique na zona central do quadro (p.safeZone da
   * meia-largura/altura visível), deslocando o centro se preciso. Se o zoom
   * out já está no máximo, são os outros carros que saem do quadro.
   */
  keepInFrame(position) {
    const p = this.params
    const tanY = Math.tan(THREE.MathUtils.degToRad(p.fov) / 2)
    const tanX = tanY * this.camera.aspect
    const rel = this.rel.copy(position).setY(1).sub(this.center)
    const depth = this.distance - rel.dot(this.back)
    const limX = Math.max(0, depth * tanX * p.safeZone - p.margin)
    const limY = Math.max(0, depth * tanY * p.safeZone - p.margin)
    const x = rel.dot(this.right)
    const y = rel.dot(this.up)
    const overX = Math.abs(x) - limX
    const overY = Math.abs(y) - limY
    if (overX > 0) this.center.addScaledVector(this.right, Math.sign(x) * overX)
    if (overY > 0) {
      // Desloca no chão: a componente "up" projetada no plano XZ
      const flat = this.flat.copy(this.up).setY(0).normalize()
      this.center.addScaledVector(flat, Math.sign(y) * overY / Math.max(this.up.dot(flat), 0.1))
    }
    this.center.setY(0)
  }

  /**
   * @param {number} dt
   * @param {{ position: THREE.Vector3, velocity: THREE.Vector3 }[]} subjects
   * @param {{ position: THREE.Vector3 } | null} [focus] jogador: prioridade no enquadramento
   */
  update(dt, subjects, focus = null) {
    const p = this.params
    let count = 0
    for (const { position, velocity } of subjects) {
      if (count === MAX_POINTS) break
      this.points[count++].copy(position).addScaledVector(velocity, p.lookAhead).setY(1)
    }

    if (count) {
      // Centro: meio da caixa dos carros, puxado para o jogador
      this.box.makeEmpty()
      for (let i = 0; i < count; i++) this.box.expandByPoint(this.points[i])
      const target = this.box.getCenter(this.target).setY(0)
      if (focus && count > 1) {
        const f = this.focusPoint.copy(focus.position).setY(0)
        target.lerp(f, p.focus)
      }

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
        if (focus) this.keepInFrame(focus.position)
      }
    }

    this.camera.position.copy(this.center).addScaledVector(this.back, this.distance)
    this.camera.lookAt(this.center)
  }
}
