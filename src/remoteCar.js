import * as THREE from 'three'

// Carro de outro jogador, desenhado por interpolação de estados recebidos.
//
// Seguindo Gambetta ("Entity Interpolation") e Fiedler ("State
// Synchronization"): extrapolar (prever) falha justamente nas batidas, que
// mudam a direção de repente. Então guardamos os estados recebidos num buffer,
// cada um com o horário de simulação de quem mandou (`t`), e mostramos o carro
// INTERP_DELAY segundos no passado, sempre entre dois estados reais. O atraso
// também serve de buffer de jitter: pacotes que chegam embolados (ou em rajada,
// quando a aba do outro estava em segundo plano) são tocados no ritmo certo.

const INTERP_DELAY = 0.1       // s no passado
const MAX_EXTRAPOLATION = 0.15 // s além do último estado (só se faltar pacote)
const BUFFER_SECONDS = 2       // histórico guardado

const lerp = THREE.MathUtils.lerp
// Interpola ângulo pelo caminho mais curto (evita girar 350° em vez de 10°)
function lerpAngle(a, b, t) {
  const d = Math.atan2(Math.sin(b - a), Math.cos(b - a))
  return a + d * t
}

export class RemoteCar {
  constructor(model) {
    this.root = new THREE.Group()
    this.body = new THREE.Group()
    this.root.add(this.body)
    this.body.add(model)

    this.snapshots = [] // { t, x, z, yaw, vx, vz, y, roll, pitch }, t crescente
    // Diferença entre o meu relógio e o de quem manda (inclui a latência)
    this.clockOffset = null
    // Velocidade no instante mostrado (usada na colisão do jogador local)
    this.velocity = new THREE.Vector3()
    this.hasState = false
  }

  get yaw() {
    return this.root.rotation.y
  }

  /** Posição no mundo (o root do carro). */
  get position() {
    return this.root.position
  }

  /**
   * @param {object} state estado recebido, com `t` = relógio de simulação de quem mandou (s)
   * @param {number} localNow meu relógio (s)
   */
  setState(state, localNow) {
    const snaps = this.snapshots
    if (snaps.length && state.t <= snaps[snaps.length - 1].t) return // atrasado/repetido
    snaps.push(state)
    while (snaps.length > 2 && snaps[0].t < state.t - BUFFER_SECONDS) snaps.shift()

    // Estimativa do deslocamento de relógio: o menor atraso visto é o mais
    // confiável; sobe devagar se a latência aumentar de verdade
    const sample = localNow - state.t
    if (this.clockOffset === null || sample < this.clockOffset) this.clockOffset = sample
    else this.clockOffset += (sample - this.clockOffset) * 0.02

    if (!this.hasState) {
      this.hasState = true
      this.sample(localNow)
    }
  }

  /** Posiciona o carro no instante (localNow - atraso), no relógio de quem manda. */
  sample(localNow) {
    const snaps = this.snapshots
    if (!snaps.length) return
    const t = localNow - this.clockOffset - INTERP_DELAY

    const newest = snaps[snaps.length - 1]
    if (t >= newest.t) {
      // Faltou pacote: anda um pouco com a última velocidade e depois espera
      this.apply(newest, newest, 0, Math.min(t - newest.t, MAX_EXTRAPOLATION))
      return
    }
    let a = snaps[0]
    let b = snaps[0]
    let alpha = 0
    for (let i = snaps.length - 1; i > 0; i--) {
      if (snaps[i - 1].t <= t) {
        a = snaps[i - 1]
        b = snaps[i]
        alpha = (t - a.t) / (b.t - a.t)
        break
      }
    }
    this.apply(a, b, THREE.MathUtils.clamp(alpha, 0, 1), 0)
  }

  apply(a, b, alpha, extrapolate) {
    const vx = lerp(a.vx, b.vx, alpha)
    const vz = lerp(a.vz, b.vz, alpha)
    this.root.position.set(lerp(a.x, b.x, alpha) + vx * extrapolate, 0, lerp(a.z, b.z, alpha) + vz * extrapolate)
    this.root.rotation.y = lerpAngle(a.yaw, b.yaw, alpha)
    this.body.position.y = lerp(a.y, b.y, alpha)
    this.body.rotation.z = lerp(a.roll, b.roll, alpha)
    this.body.rotation.x = lerp(a.pitch, b.pitch, alpha)
    this.velocity.set(vx, 0, vz)
  }
}
