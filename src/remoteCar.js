import * as THREE from 'three'

// Carrinho de outro jogador. Só desenha o que chega pela rede: a cada pacote
// guarda o estado alvo e, entre pacotes, continua andando na direção e
// velocidade recebidas (dead reckoning) e suaviza até ele. Assim o carrinho
// não "teleporta" mesmo recebendo só ~20 atualizações por segundo.

const MAX_EXTRAPOLATION = 0.25 // s sem pacote antes de parar de prever

export class RemoteCar {
  constructor(model) {
    this.root = new THREE.Group()
    this.body = new THREE.Group()
    this.root.add(this.body)
    this.body.add(model)

    this.target = { x: 0, z: 0, yaw: 0, speed: 0, roll: 0, pitch: 0 }
    this.sinceUpdate = 0
    this.hasState = false
  }

  setState(state) {
    Object.assign(this.target, state)
    this.sinceUpdate = 0
    if (!this.hasState) {
      // Primeiro pacote: aparece direto no lugar, sem deslizar da origem
      this.root.position.set(state.x, 0, state.z)
      this.root.rotation.y = state.yaw
      this.hasState = true
    }
  }

  update(dt) {
    if (!this.hasState) return
    const t = this.target

    // Prevê o movimento entre pacotes
    this.sinceUpdate += dt
    if (this.sinceUpdate < MAX_EXTRAPOLATION) {
      t.x += Math.sin(t.yaw) * t.speed * dt
      t.z += Math.cos(t.yaw) * t.speed * dt
    }

    const k = 1 - Math.exp(-12 * dt)
    this.root.position.x += (t.x - this.root.position.x) * k
    this.root.position.z += (t.z - this.root.position.z) * k

    // Interpola o ângulo pelo caminho mais curto (evita girar 350° ao invés de 10°)
    let dYaw = t.yaw - this.root.rotation.y
    dYaw = Math.atan2(Math.sin(dYaw), Math.cos(dYaw))
    this.root.rotation.y += dYaw * k

    this.body.rotation.z += (t.roll - this.body.rotation.z) * k
    this.body.rotation.x += (t.pitch - this.body.rotation.x) * k
  }
}
