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

// Temporários reaproveitados (a física roda 60x por segundo: nada de `new` aqui)
const tmpImpulse = new THREE.Vector3()
const tmpDir = new THREE.Vector3()

// Move `value` em direção a `target` no máximo `step` (sem passar do alvo)
const approach = (value, target, step) =>
  value < target ? Math.min(value + step, target) : Math.max(value - step, target)

export class Car {
  params = {
    maxSpeed: 10,     // m/s para frente
    reverseSpeed: 4,  // m/s de ré
    acceleration: 5,  // m/s² na arrancada (diminui perto da velocidade máxima)
    accelCurve: 1.5,  // quanto a aceleração cai perto do máximo (menor = cai mais cedo)
    throttleResponse: 0.6, // s para o pedal chegar a 100% (motor "enchendo")
    brake: 20,        // desaceleração ao inverter o sentido
    drag: 4,          // desaceleração sem acelerar
    turnSpeed: 2.2,   // rad/s com velocidade máxima
    steerResponse: 0.4,    // s para o volante ir do centro até o fim (peso do volante)
    steerReturn: 0.25,     // s para o volante voltar ao centro ao soltar
    turnInertia: 0.15,     // s para a rotação do carro acompanhar o volante
    spinInPlace: 0.6, // fração do giro disponível parado (bate-bate gira no lugar)
    lean: 1,          // intensidade da inclinação visual
    bounciness: 0.95, // elasticidade da batida (0 = gruda, 1 = quica tudo; > 1 cria energia)
    wallBounce: 0.6,  // elasticidade da batida na parede da arena
    knockDrag: 2.2,   // quão rápido o empurrão da batida acaba (menor = desliza mais)
    hop: 1.2,         // intensidade do pulinho e do balanço na batida
    boostSpeed: 1.8,  // velocidade do boost, em múltiplos da velocidade máxima
    boostDuration: 0.8, // s
  }

  speed = 0
  yaw = 0
  pedal = 0   // -1..1, segue o W/S com atraso (throttleResponse)
  boostTime = 0 // s restantes de boost
  wheel = 0   // -1..1, posição do volante (segue A/D com atraso)
  yawRate = 0 // rad/s, com inércia
  spawn = new THREE.Vector3() // para onde o R (reset) leva o carrinho
  spawnYaw = 0                // e virado para onde
  // Conta os teletransportes (reset/volta do nocaute). Vai pela rede: quem vê
  // o carro sabe que foi um salto e não um movimento, e não interpola
  teleports = 0
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
    this.yaw = this.spawnYaw
    this.pedal = 0
    this.wheel = 0
    this.yawRate = 0
    this.boostTime = 0
    this.knock.set(0, 0, 0)
    this.velocity.set(0, 0, 0)
    this.root.position.copy(this.spawn)
    this.root.rotation.set(0, this.spawnYaw, 0)
    this.teleports++
    // Sem isso, o quadro seguinte desenharia o carro no meio do caminho entre
    // a posição antiga e a nova (interpolação do desenho)
    this.prev = this.capturePose(this.prev)
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
      boosting: this.isBoosting,
      tp: this.teleports,
    }
  }

  /** Posição no mundo (o root do carro). */
  get position() {
    return this.root.position
  }

  get isBoosting() {
    return this.boostTime > 0
  }

  /** Arrancada: na hora vai para a velocidade de boost, na direção da frente. */
  boost() {
    this.boostTime = this.params.boostDuration
    this.speed = Math.max(this.speed, this.params.maxSpeed * this.params.boostSpeed)
  }

  endBoost() {
    this.boostTime = 0
  }

  update(dt, { throttle, steer }) {
    const p = this.params
    const prevSpeed = this.speed

    // --- Pedal: o motor leva um tempo para chegar à potência total ----------
    // Soltar o pedal é mais rápido que pisar
    const pedalRate = throttle === 0 ? 2 : 1
    this.pedal = approach(this.pedal, throttle, (pedalRate * dt) / Math.max(p.throttleResponse, 1e-3))

    // --- Velocidade ---------------------------------------------------------
    if (this.pedal !== 0) {
      const opposing = Math.sign(this.speed) === -Math.sign(this.pedal)
      if (opposing) {
        // Pedal contra o movimento atual: freia (mais forte)
        this.speed += this.pedal * p.brake * dt
      } else {
        // Curva de aceleração: forte na arrancada, cai perto da velocidade máxima
        const limit = this.pedal > 0 ? p.maxSpeed : p.reverseSpeed
        const ratio = Math.min(Math.abs(this.speed) / limit, 1)
        const taper = 1 - Math.pow(ratio, p.accelCurve)
        this.speed += this.pedal * p.acceleration * taper * dt
      }
    }
    if (throttle === 0) {
      const drop = Math.min(Math.abs(this.speed), p.drag * dt)
      this.speed -= Math.sign(this.speed) * drop
    }
    // Teto de velocidade: durante o boost fica no máximo do boost; depois, a
    // velocidade que sobrar acima do normal vai caindo (sem tranco)
    this.boostTime = Math.max(0, this.boostTime - dt)
    if (this.isBoosting) {
      this.speed = Math.max(this.speed, p.maxSpeed * p.boostSpeed)
    } else if (this.speed > p.maxSpeed) {
      this.speed = Math.max(p.maxSpeed, this.speed - p.drag * 2 * dt)
    }
    this.speed = Math.max(this.speed, -p.reverseSpeed)

    // --- Direção: volante pesado + rotação com inércia ----------------------
    // Virando para o mesmo lado (ou saindo do centro) usa steerResponse;
    // soltando ou invertendo, o volante volta pelo steerReturn
    const turningIn = steer !== 0 && Math.sign(steer) !== -Math.sign(this.wheel)
    const wheelTime = turningIn ? p.steerResponse : p.steerReturn
    this.wheel = approach(this.wheel, steer, dt / Math.max(wheelTime, 1e-3))

    const speedFactor = Math.min(Math.abs(this.speed) / (p.maxSpeed * 0.4), 1)
    const turnAmount = Math.max(speedFactor, p.spinInPlace)
    // De ré o volante inverte, como num carro de verdade
    const dir = this.speed < -0.01 ? -1 : 1
    const targetYawRate = this.wheel * p.turnSpeed * turnAmount * dir
    this.yawRate += (targetYawRate - this.yawRate) * (1 - Math.exp(-dt / Math.max(p.turnInertia, 1e-3)))
    this.yaw += this.yawRate * dt

    this.root.rotation.y = this.yaw
    this.updateAxes()

    // --- Movimento (frente + empurrão da batida) ----------------------------
    this.knock.multiplyScalar(Math.exp(-p.knockDrag * dt))
    this.velocity.copy(this.forward).multiplyScalar(this.speed).add(this.knock)
    this.root.position.addScaledVector(this.velocity, dt)

    // --- Inclinação visual --------------------------------------------------
    // Na curva o corpo tomba para fora; acelerando o bico levanta
    const accel = dt > 0 ? (this.speed - prevSpeed) / dt : 0
    const targetRoll = this.wheel * speedFactor * 0.07 * p.lean
    const targetPitch = -THREE.MathUtils.clamp(accel / p.brake, -1, 1) * 0.05 * p.lean
    const k = 1 - Math.exp(-8 * dt)
    this.lean.roll += (targetRoll - this.lean.roll) * k
    this.lean.pitch += (targetPitch - this.lean.pitch) * k

    this.updateBump(dt)
    this.body.rotation.z = this.lean.roll + this.wobble.roll
    this.body.rotation.x = this.lean.pitch + this.wobble.pitch
    this.body.position.y = this.hopY
  }

  // --- Desenho interpolado ------------------------------------------------
  // A física roda em passos fixos (ver o loop em main.js). Para não tremer em
  // telas de 120/144 Hz, o carro é desenhado entre o passo anterior e o atual
  // (Fiedler, "Fix Your Timestep"). beginRender troca a pose pela interpolada
  // e endRender devolve a pose da simulação.

  /** Chamar antes de cada passo de física. */
  savePrevious() {
    this.prev = this.capturePose(this.prev)
  }

  capturePose(out = {}) {
    out.x = this.root.position.x
    out.z = this.root.position.z
    out.yaw = this.yaw
    out.y = this.body.position.y
    out.roll = this.body.rotation.z
    out.pitch = this.body.rotation.x
    return out
  }

  setPose(p) {
    this.root.position.x = p.x
    this.root.position.z = p.z
    this.root.rotation.y = p.yaw
    this.body.position.y = p.y
    this.body.rotation.z = p.roll
    this.body.rotation.x = p.pitch
  }

  beginRender(alpha) {
    if (!this.prev) return
    this.current = this.capturePose(this.current)
    const a = this.prev, b = this.current, l = THREE.MathUtils.lerp
    this.renderPose ??= {}
    const r = this.renderPose
    r.x = l(a.x, b.x, alpha)
    r.z = l(a.z, b.z, alpha)
    r.yaw = a.yaw + (b.yaw - a.yaw) * alpha
    r.y = l(a.y, b.y, alpha)
    r.roll = l(a.roll, b.roll, alpha)
    r.pitch = l(a.pitch, b.pitch, alpha)
    this.setPose(r)
  }

  endRender() {
    if (this.current) this.setPose(this.current)
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
    const approaching = this.velocity.dot(normal) - otherVelocity.dot(normal)
    if (approaching >= 0) return 0
    return (-(1 + this.params.bounciness) * approaching) / 2
  }

  /**
   * Batida na parede (massa infinita): sai de dentro dela e ricocheteia.
   * @param {THREE.Vector3} normal aponta para dentro da arena
   * @returns {number} velocidade com que bateu na parede (0 = só encostou)
   */
  hitWall(normal, depth) {
    this.separate(normal, depth)
    const into = this.velocity.dot(normal) // < 0: indo para dentro da parede
    if (into > -0.3) return 0 // encostando de leve: só desliza
    this.endBoost()
    this.applyImpulse(tmpImpulse.copy(normal).multiplyScalar(-(1 + this.params.wallBounce) * into))
    return -into
  }

  /** Para na hora (ex.: lançando a Onda de choque). Batidas ainda empurram. */
  halt() {
    this.speed = 0
    this.pedal = 0
    this.knock.set(0, 0, 0)
    this.velocity.set(0, 0, 0)
    this.endBoost()
  }

  /** Soma uma variação de velocidade (m/s, mundo) vinda de uma batida. */
  applyImpulse(impulse) {
    this.velocity.add(impulse)
    // Reparte a nova velocidade: o que está na direção da frente e cabe na
    // faixa normal de direção (ré máxima até velocidade máxima) vira `speed`;
    // todo o resto (lateral e o excesso) vira empurrão, que desliza e vai
    // morrendo sozinho. Sem isso, um empurrão de frente seria cortado para a
    // velocidade de ré na hora.
    const p = this.params
    const top = p.maxSpeed * (this.isBoosting ? p.boostSpeed : 1)
    this.speed = THREE.MathUtils.clamp(this.velocity.dot(this.forward), -p.reverseSpeed, top)
    this.knock.copy(this.velocity).addScaledVector(this.forward, -this.speed)
    const strength = impulse.length()
    if (strength > 1e-6) this.bump(tmpDir.copy(impulse).divideScalar(strength), strength)
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
