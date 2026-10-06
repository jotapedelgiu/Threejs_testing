import * as THREE from 'three'
import { DR, extrapolate } from './deadReckoning.js'

// Carro de outro jogador, desenhado a partir dos estados recebidos.
//
// Os estados chegam só quando o dono precisa (dead reckoning: deadReckoning.js),
// às vezes com 0,25 s entre um e outro, então entre dois estados o carro é
// EXTRAPOLADO com o mesmo modelo que o dono usa para decidir mandar: velocidade
// que gira com o carro. Se o próximo estado já chegou, a posição passa por ele
// (spline de Hermite com as duas velocidades) em vez de extrapolar.
//
// Seguindo Gambetta ("Entity Interpolation") e Fiedler ("State
// Synchronization"): mostramos o carro INTERP_DELAY segundos no passado, com o
// horário de simulação de quem mandou (`t`). O atraso serve de buffer de jitter
// e dá tempo de o próximo estado chegar antes de o desenho precisar dele.
//
// Quando o desenho troca de trecho (chegou estado novo) a nova curva difere da
// anterior em até o limite do dead reckoning; essa diferença não vira salto:
// vira um erro que some em ERROR_SMOOTHING s.

const INTERP_DELAY = 0.1       // s no passado
const BUFFER_SECONDS = 2       // histórico guardado
const ERROR_SMOOTHING = 0.1    // s: constante de tempo com que o salto entre trechos some
const MAX_ERROR = 3            // m: erro maior que isso é salto de verdade (some na hora)

const lerp = THREE.MathUtils.lerp
const wrap = (a) => Math.atan2(Math.sin(a), Math.cos(a))

export class RemoteCar {
  constructor(model) {
    this.root = new THREE.Group()
    this.body = new THREE.Group()
    this.root.add(this.body)
    this.body.add(model)

    this.snapshots = [] // { t, x, z, yaw, yawRate, vx, vz, y, roll, pitch }, t crescente
    // Diferença entre o meu relógio e o de quem manda (inclui a latência)
    this.clockOffset = null
    // Velocidade no instante mostrado (usada na colisão do jogador local)
    this.velocity = new THREE.Vector3()
    this.hasState = false
    // Pose desenhada: trecho (a, b) do último quadro e erro que ainda está sumindo
    this.lastA = null
    this.lastB = null
    this.lastR = null
    this.error = { x: 0, z: 0, yaw: 0 }
    this.now = {}
    this.old = {}
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
    // Teletransporte (volta do nocaute, R): descarta o histórico, senão a
    // interpolação mostraria o carro deslizando pelo mapa até o lugar novo
    if (state.tp !== this.teleports) {
      this.teleports = state.tp
      snaps.length = 0
      this.lastA = this.lastB = this.lastR = null
      this.error.x = this.error.z = this.error.yaw = 0
    }
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
    const r = localNow - this.clockOffset - INTERP_DELAY

    // a = último estado que já "aconteceu" (t <= r); b = o seguinte, se já chegou
    let index = 0
    for (let i = snaps.length - 1; i >= 0; i--) {
      if (snaps[i].t <= r) {
        index = i
        break
      }
    }
    const a = snaps[index]
    const b = r >= a.t ? snaps[index + 1] ?? null : null

    const now = this.pose(a, b, r, this.now)
    const err = this.error
    // Trocou de trecho (chegou estado novo): a curva nova não bate com a que
    // vinha sendo desenhada; a diferença vira erro que some aos poucos
    if (this.lastA && (this.lastA !== a || this.lastB !== b)) {
      const old = this.pose(this.lastA, this.lastB, r, this.old)
      err.x += old.x - now.x
      err.z += old.z - now.z
      err.yaw += wrap(old.yaw - now.yaw)
      if (Math.hypot(err.x, err.z) > MAX_ERROR) err.x = err.z = err.yaw = 0
    }
    if (this.lastR !== null && r > this.lastR) {
      const k = Math.exp(-(r - this.lastR) / ERROR_SMOOTHING)
      err.x *= k
      err.z *= k
      err.yaw *= k
    }
    this.lastA = a
    this.lastB = b
    this.lastR = r

    this.root.position.set(now.x + err.x, 0, now.z + err.z)
    this.root.rotation.y = now.yaw + err.yaw
    this.body.position.y = now.y
    this.body.rotation.z = now.roll
    this.body.rotation.x = now.pitch
    this.velocity.set(now.vx, 0, now.vz)
  }

  /**
   * Pose no instante `r` (relógio de quem manda) a partir do trecho (a, b).
   * Com `b` (já chegou): Hermite; sem ele: extrapola de `a` com o modelo do
   * dead reckoning, no máximo DR.maxExtrapolation s.
   */
  pose(a, b, r, out) {
    if (b) {
      const h = b.t - a.t
      const u = THREE.MathUtils.clamp((r - a.t) / h, 0, 1)
      const u2 = u * u
      const u3 = u2 * u
      const h00 = 2 * u3 - 3 * u2 + 1
      const h10 = u3 - 2 * u2 + u
      const h01 = -2 * u3 + 3 * u2
      const h11 = u3 - u2
      out.x = h00 * a.x + h10 * h * a.vx + h01 * b.x + h11 * h * b.vx
      out.z = h00 * a.z + h10 * h * a.vz + h01 * b.z + h11 * h * b.vz
      out.yaw = a.yaw + wrap(b.yaw - a.yaw) * u
      out.vx = lerp(a.vx, b.vx, u)
      out.vz = lerp(a.vz, b.vz, u)
      out.y = lerp(a.y, b.y, u)
      out.roll = lerp(a.roll, b.roll, u)
      out.pitch = lerp(a.pitch, b.pitch, u)
      return out
    }
    extrapolate(a, THREE.MathUtils.clamp(r - a.t, 0, DR.maxExtrapolation), out)
    out.y = a.y
    out.roll = a.roll
    out.pitch = a.pitch
    return out
  }
}
