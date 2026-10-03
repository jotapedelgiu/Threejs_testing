import * as THREE from 'three'

// Controle arcade de carrinho de bate-bate.
//
// Hierarquia:
//   root  -> posição e direção (yaw) no mundo; frente = +Z local
//   body  -> inclinação visual (curva/aceleração) e quiquinho
//   model -> o glTF, centralizado e girado para a frente apontar para +Z

export class Car {
  params = {
    maxSpeed: 9,      // m/s para frente
    reverseSpeed: 4,  // m/s de ré
    acceleration: 9,
    brake: 20,        // desaceleração ao inverter o sentido
    drag: 4,          // desaceleração sem acelerar
    turnSpeed: 2.4,   // rad/s com velocidade máxima
    spinInPlace: 0.6, // fração do giro disponível parado (bate-bate gira no lugar)
    lean: 1,          // intensidade da inclinação visual
  }

  speed = 0
  yaw = 0
  spawn = new THREE.Vector3() // para onde o R (reset) leva o carrinho

  constructor(model) {
    this.root = new THREE.Group()
    this.body = new THREE.Group()
    this.root.add(this.body)
    this.body.add(model)
    this.forward = new THREE.Vector3(0, 0, 1)
  }

  reset() {
    this.speed = 0
    this.yaw = 0
    this.root.position.copy(this.spawn)
    this.root.rotation.set(0, 0, 0)
  }

  /** Estado enviado pela rede para os outros jogadores. */
  getNetState() {
    return {
      x: this.root.position.x,
      z: this.root.position.z,
      yaw: this.yaw,
      speed: this.speed,
      roll: this.body.rotation.z,
      pitch: this.body.rotation.x,
    }
  }

  update(dt, { throttle, steer }) {
    const p = this.params
    const prevSpeed = this.speed

    // --- Velocidade ---------------------------------------------------------
    if (throttle !== 0) {
      // Acelerando contra o movimento atual usa o freio (mais forte)
      const opposing = Math.sign(this.speed) === -throttle
      this.speed += throttle * (opposing ? p.brake : p.acceleration) * dt
    } else {
      const drop = Math.min(Math.abs(this.speed), p.drag * dt)
      this.speed -= Math.sign(this.speed) * drop
    }
    this.speed = THREE.MathUtils.clamp(this.speed, -p.reverseSpeed, p.maxSpeed)

    // --- Direção ------------------------------------------------------------
    const speedFactor = Math.min(Math.abs(this.speed) / (p.maxSpeed * 0.4), 1)
    const turnAmount = Math.max(speedFactor, p.spinInPlace)
    // De ré o volante inverte, como num carro de verdade
    const dir = this.speed < -0.01 ? -1 : 1
    this.yaw += steer * p.turnSpeed * turnAmount * dir * dt

    this.root.rotation.y = this.yaw
    this.forward.set(Math.sin(this.yaw), 0, Math.cos(this.yaw))
    this.root.position.addScaledVector(this.forward, this.speed * dt)

    // --- Inclinação visual --------------------------------------------------
    const accel = dt > 0 ? (this.speed - prevSpeed) / dt : 0
    // Na curva o corpo tomba para fora; acelerando o bico levanta
    const targetRoll = steer * speedFactor * 0.07 * p.lean
    const targetPitch = -THREE.MathUtils.clamp(accel / p.brake, -1, 1) * 0.05 * p.lean
    const k = 1 - Math.exp(-8 * dt)
    this.body.rotation.z += (targetRoll - this.body.rotation.z) * k
    this.body.rotation.x += (targetPitch - this.body.rotation.x) * k
  }
}
