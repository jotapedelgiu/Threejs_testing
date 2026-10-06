import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import * as THREE from 'three'
import { Car } from '../src/car.js'
import { RemoteCar } from '../src/remoteCar.js'
import { StateSender } from '../src/netSend.js'
import { DR, extrapolate, exceedsError } from '../src/deadReckoning.js'
import { validators } from '../src/protocol.js'

const snap = (t, extra = {}) => ({ t, x: 0, z: 0, yaw: 0, yawRate: 0, vx: 0, vz: 10, y: 0, roll: 0, pitch: 0, tp: 0, ...extra })

describe('Dead reckoning: modelo (deadReckoning.js)', () => {
  test('sem giro é uma reta; com giro a velocidade gira junto com o carro (arco)', () => {
    const line = extrapolate({ x: 1, z: 2, yaw: 0, vx: 0, vz: 10 }, 0.5)
    assert.deepEqual([line.x, line.z, line.vz], [1, 7, 10])
    // quarto de volta de um círculo de raio 5 m (10 m/s, w = 2 rad/s): acaba 5 m ao lado e 5 m à frente
    const arc = extrapolate({ x: 0, z: 0, yaw: 0, yawRate: 2, vx: 0, vz: 10 }, Math.PI / 4)
    assert.ok(Math.abs(arc.x - 5) < 1e-9 && Math.abs(arc.z - 5) < 1e-9, `(${arc.x}, ${arc.z})`)
    assert.ok(Math.abs(arc.vx - 10) < 1e-9 && Math.abs(arc.vz) < 1e-9, 'a velocidade girou 90°')
    assert.ok(Math.abs(arc.yaw - Math.PI / 2) < 1e-9)
  })

  test('exceedsError: dentro do limite não, fora sim', () => {
    const last = { t: 0, x: 0, z: 0, yaw: 0, yawRate: 0, vx: 0, vz: 10 }
    assert.equal(exceedsError(last, { t: 0.1, x: 0, z: 1.0 + DR.posEps / 2, yaw: 0 }), false)
    assert.equal(exceedsError(last, { t: 0.1, x: 0, z: 1.0 + DR.posEps * 2, yaw: 0 }), true)
    assert.equal(exceedsError(last, { t: 0.1, x: 0, z: 1.0, yaw: DR.yawEps * 2 }), true)
  })

  test('o modelo acompanha o carro de verdade: uma curva constante quase não tem erro', () => {
    const car = new Car(new THREE.Object3D())
    car.reset()
    // acelera em reta até a velocidade máxima, depois vira com o volante cheio
    for (let i = 0; i < 240; i++) car.update(1 / 60, { throttle: 1, steer: 0 })
    for (let i = 0; i < 120; i++) car.update(1 / 60, { throttle: 1, steer: 1 }) // o volante demora a chegar
    const s = { ...car.getNetState(), t: 0 }
    let worst = 0
    for (let i = 1; i <= 15; i++) { // 0,25 s à frente (o sinal de vida máximo)
      car.update(1 / 60, { throttle: 1, steer: 1 })
      const p = extrapolate(s, i / 60)
      worst = Math.max(worst, Math.hypot(p.x - car.root.position.x, p.z - car.root.position.z))
    }
    assert.ok(worst < 0.15, `erro de ${(worst * 100).toFixed(1)} cm em 0,25 s de curva`)
  })
})

describe('Dead reckoning: carro remoto (remoteCar.js)', () => {
  // localNow = t de quem manda: sem atraso de rede, e o carro é mostrado 0,1 s no passado
  const at = (r) => r + 0.1

  test('sem estado novo, extrapola com a velocidade do último', () => {
    const r = new RemoteCar(new THREE.Object3D())
    r.setState(snap(1), 1)
    r.sample(at(1.3))
    assert.ok(Math.abs(r.position.z - 3) < 1e-6, `z=${r.position.z}`)
    assert.equal(r.velocity.z, 10)
  })

  test('extrapola em arco com o giro e nunca além do limite', () => {
    const r = new RemoteCar(new THREE.Object3D())
    r.setState(snap(1, { yawRate: 2 }), 1)
    r.sample(at(1.5))
    const expected = extrapolate(snap(1, { yawRate: 2 }), 0.5)
    assert.ok(Math.abs(r.position.x - expected.x) < 1e-6 && Math.abs(r.position.z - expected.z) < 1e-6)
    assert.ok(Math.abs(r.yaw - expected.yaw) < 1e-6)
    // parou de chegar: congela em vez de sair voando
    r.sample(at(100))
    const frozen = extrapolate(snap(1, { yawRate: 2 }), DR.maxExtrapolation)
    assert.ok(Math.abs(r.position.x - frozen.x) < 1e-6 && Math.abs(r.position.z - frozen.z) < 1e-6)
  })

  test('quando o próximo estado já chegou, passa por ele (Hermite) em vez de extrapolar', () => {
    const r = new RemoteCar(new THREE.Object3D())
    r.setState(snap(0), 0)
    r.setState(snap(0.5, { z: 6, vz: 10 }), 0.5) // o carro acelerou no caminho: 6 m, não 5
    r.sample(at(0.25))
    assert.ok(r.position.z > 2.4 && r.position.z < 3.6, `no meio do trecho, entre os dois: ${r.position.z}`)
    r.sample(at(0.5))
    assert.ok(Math.abs(r.position.z - 6) < 0.01, `chega no estado novo: ${r.position.z}`)
  })

  test('estado novo fora do que vinha sendo desenhado não vira salto: o erro some aos poucos', () => {
    const r = new RemoteCar(new THREE.Object3D())
    r.setState(snap(0.5, { z: 5 }), 0.5)
    r.sample(at(0.95))
    const before = r.position.z // 5 + 10 * 0.45 = 9,5 m
    r.setState(snap(1.0, { z: 10.1 }), 1.0) // o modelo errou 10 cm: o dono mandou o estado real
    r.sample(at(1.0))
    assert.ok(Math.abs(r.position.z - (before + 0.5)) < 0.06, `sem salto: ${r.position.z} depois de ${before}`)
    r.sample(at(1.5))
    assert.ok(Math.abs(r.position.z - 15.1) < 0.01, `0,5 s depois já está na curva nova: ${r.position.z}`)
  })

  test('teletransporte limpa também o erro que estava sumindo', () => {
    const r = new RemoteCar(new THREE.Object3D())
    r.setState(snap(0), 0)
    r.sample(at(0.95))
    r.setState(snap(1.0, { z: 10.5 }), 1.0)
    r.sample(at(1.0))
    r.setState(snap(1.05, { x: 30, z: 0, tp: 1 }), 1.05) // volta do nocaute
    r.sample(at(1.05))
    assert.ok(Math.abs(r.position.x - 30) < 1e-6 && Math.abs(r.position.z) < 1e-6, `(${r.position.x}, ${r.position.z})`)
  })
})

// --- Integração: física real do carro -> emissor -> rede -> receptor ---------------------
describe('Dead reckoning: ponta a ponta com a física real do carro', () => {
  const DT = 1 / 60
  const LATENCY = 0.04
  const rng = (seed) => () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32)
  const wrap = (a) => Math.atan2(Math.sin(a), Math.cos(a))

  // Trajetória real: entradas de jogador, batidas e paredes
  function simulate(seed, seconds) {
    const rand = rng(seed)
    const car = new Car(new THREE.Object3D())
    car.reset()
    let steer = 0, steerLeft = 0, throttle = 1, throttleLeft = 0, hitLeft = 3
    const track = []
    for (let k = 0; k < seconds * 60; k++) {
      if ((steerLeft -= DT) <= 0) {
        const v = rand()
        steer = v < 0.4 ? 0 : v < 0.7 ? -1 : 1
        steerLeft = 0.3 + rand() * 1.1
      }
      if ((throttleLeft -= DT) <= 0) {
        const v = rand()
        throttle = v < 0.8 ? 1 : v < 0.9 ? 0 : -1
        throttleLeft = 0.5 + rand() * 2
      }
      if ((hitLeft -= DT) <= 0) {
        const a = rand() * Math.PI * 2
        const m = 3 + rand() * 6
        car.applyImpulse(new THREE.Vector3(Math.cos(a) * m, 0, Math.sin(a) * m))
        hitLeft = 2 + rand() * 5
      }
      car.update(DT, { throttle, steer })
      const p = car.root.position
      if (Math.abs(p.x) > 38) car.hitWall(new THREE.Vector3(-Math.sign(p.x), 0, 0), Math.abs(p.x) - 38)
      if (Math.abs(p.z) > 21) car.hitWall(new THREE.Vector3(0, 0, -Math.sign(p.z)), Math.abs(p.z) - 21)
      track.push({ t: k * DT, x: p.x, z: p.z, yaw: car.yaw, net: { ...car.getNetState(), t: k * DT, hp: 500 } })
    }
    return track
  }

  // Verdade no instante exato (interpola entre dois ticks: arredondar para o tick erraria até 8 cm a 10 m/s)
  const truthAt = (track, time) => {
    const f = time / DT
    const i = Math.floor(f)
    const a = track[i]
    const b = track[i + 1]
    if (!a || !b) return null
    const u = f - i
    return { x: a.x + (b.x - a.x) * u, z: a.z + (b.z - a.z) * u, yaw: a.yaw + wrap(b.yaw - a.yaw) * u }
  }

  test('~65% menos mensagens que 20 Hz, com erro pequeno em quem recebe', () => {
    let sent = 0, seconds = 0, errSum = 0, errMax = 0, yawSum = 0, n = 0
    for (const seed of [1, 2, 3]) {
      const track = simulate(seed, 90)
      const sender = new StateSender()
      const receiver = new RemoteCar(new THREE.Object3D())
      const inFlight = []
      seconds += track.length * DT
      for (let k = 0; k < track.length; k++) {
        const now = track[k].t
        if (k % 3 === 0) { // 20 Hz: o emissor decide
          const out = sender.build(track[k].net, now)
          if (out) {
            sent++
            inFlight.push({ at: now + LATENCY, state: validators.state(JSON.parse(JSON.stringify(out.state))) })
          }
        }
        while (inFlight.length && inFlight[0].at <= now) {
          const m = inFlight.shift()
          receiver.setState(m.state, m.at)
        }
        if (!receiver.hasState) continue
        receiver.sample(now)
        const truth = truthAt(track, now - LATENCY - 0.1)
        if (!truth || now < 3) continue
        const e = Math.hypot(receiver.position.x - truth.x, receiver.position.z - truth.z)
        errSum += e
        errMax = Math.max(errMax, e)
        yawSum += Math.abs(wrap(receiver.yaw - truth.yaw))
        n++
      }
    }
    const rate = sent / seconds
    assert.ok(rate < 9, `${rate.toFixed(1)} mensagens por segundo (antes: 20)`)
    assert.ok(errSum / n < 0.06, `erro médio ${(errSum / n * 100).toFixed(1)} cm`)
    assert.ok(errMax < 0.4, `erro máximo ${(errMax * 100).toFixed(0)} cm (bate com a batida: o modelo não prevê impacto)`)
    assert.ok(yawSum / n < 0.03, `erro médio de direção ${(yawSum / n * 57.3).toFixed(1)}°`)
  })
})
