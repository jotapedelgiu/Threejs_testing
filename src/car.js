import * as THREE from 'three'

// Controle arcade de carrinho de bate-bate.
//
// Hierarquia:
//   root  -> posição e direção (yaw) no mundo; frente = +Z local
//   body  -> inclinação visual (curva/aceleração), quique e balanço da batida
//   model -> o glTF, centralizado e girado para a frente apontar para +Z
//
// A velocidade tem duas partes: `speed`, ao longo da frente (o que o jogador
// controla), e `knock`, um empurrão em qualquer direção vindo das batidas, que
// vai morrendo sozinho. Assim uma batida pode jogar o carrinho de lado.

const GRAVITY = 25          // m/s² do quique (mais forte que o real: fica mais "cartoon")
const HOP_RESTITUTION = 0.35 // quanto do pulo sobra a cada quicada no chão
const WOBBLE_STIFFNESS = 70  // mola do balanço após a batida
const WOBBLE_DAMPING = 7

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
    bounciness: 0.9,  // elasticidade da batida (0 = gruda, 1 = quica tudo)
    knockDrag: 2.5,   // quão rápido o empurrão da batida acaba
    hop: 1,           // intensidade do pulinho e do balanço na batida
  }

  speed = 0
  yaw = 0
  spawn = new THREE.Vector3() // para onde o R (reset) leva o carrinho
  knock = new THREE.Vector3() // empurrão das batidas (m/s, mundo)
  velocity = new THREE.Vector3() // velocidade total (frente + empurrão)

  // Visual da batida
  hopY = 0
  hopVel = 0
  lean = { roll: 0, pitch: 0 }
  wobble = { roll: 0, pitch: 0, rollVel: 0, pitchVel: 0 }

  constructor(model) {
    this.root = new THREE.Group()
    this.body = new THREE.Group()
    this.root.add(this.body)
    this.body.add(model)
    this.forward = new THREE.Vector3(0, 0, 1)
    this.left = new THREE.Vector3(1, 0, 0) // +X local no mundo (lado esquerdo do carro)
  }

  reset() {
    this.speed = 0
    this.yaw = 0
    this.knock.set(0, 0, 0)
    this.velocity.set(0, 0, 0)
    this.root.position.copy(this.spawn)
    this.root.rotation.set(0, 0, 0)
  }

  /** Estado enviado pela rede para os outros jogadores. */
  getNetState() {
    return {
      x: this.root.position.x,
      z: this.root.position.z,
      yaw: this.yaw,
      vx: this.velocity.x,
      vz: this.velocity.z,
      y: this.body.position.y,
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
    this.updateAxes()

    // --- Movimento (frente + empurrão da batida) ----------------------------
    this.knock.multiplyScalar(Math.exp(-p.knockDrag * dt))
    this.velocity.copy(this.forward).multiplyScalar(this.speed).add(this.knock)
    this.root.position.addScaledVector(this.velocity, dt)

    // --- Inclinação visual --------------------------------------------------
    // Na curva o corpo tomba para fora; acelerando o bico levanta
    const accel = dt > 0 ? (this.speed - prevSpeed) / dt : 0
    const targetRoll = steer * speedFactor * 0.07 * p.lean
    const targetPitch = -THREE.MathUtils.clamp(accel / p.brake, -1, 1) * 0.05 * p.lean
    const k = 1 - Math.exp(-8 * dt)
    this.lean.roll += (targetRoll - this.lean.roll) * k
    this.lean.pitch += (targetPitch - this.lean.pitch) * k

    this.updateBump(dt)
    this.body.rotation.z = this.lean.roll + this.wobble.roll
    this.body.rotation.x = this.lean.pitch + this.wobble.pitch
    this.body.position.y = this.hopY
  }

  updateAxes() {
    this.forward.set(Math.sin(this.yaw), 0, Math.cos(this.yaw))
    this.left.set(Math.cos(this.yaw), 0, -Math.sin(this.yaw))
  }

  // Pulinho (gravidade + quicadas que perdem força) e balanço (mola amortecida)
  updateBump(dt) {
    if (this.hopY > 0 || this.hopVel > 0) {
      this.hopVel -= GRAVITY * dt
      this.hopY += this.hopVel * dt
      if (this.hopY <= 0) {
        this.hopY = 0
        this.hopVel = -this.hopVel * HOP_RESTITUTION
        if (this.hopVel < 0.6) this.hopVel = 0 // para de quicar
      }
    }
    const w = this.wobble
    w.rollVel += (-WOBBLE_STIFFNESS * w.roll - WOBBLE_DAMPING * w.rollVel) * dt
    w.pitchVel += (-WOBBLE_STIFFNESS * w.pitch - WOBBLE_DAMPING * w.pitchVel) * dt
    w.roll += w.rollVel * dt
    w.pitch += w.pitchVel * dt
  }

  /**
   * Sai da sobreposição com outro carrinho (só eu me mexo; o outro jogador
   * faz o mesmo do lado dele).
   * @param {THREE.Vector3} normal direção do outro para mim (unitária, no chão)
   * @param {number} depth quanto os dois estão sobrepostos (m)
   */
  separate(normal, depth) {
    this.root.position.addScaledVector(normal, depth)
  }

  /**
   * Impulso de uma batida entre massas iguais: quanto de velocidade cada um
   * recebe ao longo da normal (eu ao longo de `normal`, o outro ao contrário).
   * @param {THREE.Vector3} normal direção do outro para mim
   * @param {THREE.Vector3} otherVelocity velocidade do outro carrinho
   * @returns {number} 0 se já estão se afastando
   */
  collisionImpulse(normal, otherVelocity) {
    const approaching = this.velocity.clone().sub(otherVelocity).dot(normal)
    if (approaching >= 0) return 0
    return (-(1 + this.params.bounciness) * approaching) / 2
  }

  /** Soma uma variação de velocidade (m/s, mundo) vinda de uma batida. */
  applyImpulse(impulse) {
    this.velocity.add(impulse)
    // Reparte a nova velocidade: o que está na direção da frente vira `speed`,
    // o resto vira empurrão lateral
    this.speed = this.velocity.dot(this.forward)
    this.knock.copy(this.velocity).addScaledVector(this.forward, -this.speed)
    const strength = impulse.length()
    if (strength > 1e-6) this.bump(impulse.clone().divideScalar(strength), strength)
  }

  /** Pulinho + balanço proporcionais à força da batida. */
  bump(normal, strength) {
    const s = strength * this.params.hop
    this.hopVel = Math.max(this.hopVel, Math.min(s * 0.6, 5))
    // A base é empurrada ao longo da normal e o topo "fica para trás":
    // tomba para o lado oposto ao empurrão
    const side = normal.dot(this.left)      // empurrão para a esquerda (+X local)
    const front = normal.dot(this.forward)  // empurrão para a frente
    this.wobble.rollVel += side * s * 0.6
    this.wobble.pitchVel -= front * s * 0.6
  }
}
