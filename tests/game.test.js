// Testes das regras do jogo (física, colisão, dano e vida, rede, esferas).
// Rodam no Node, sem navegador: `npm test`.
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import * as THREE from 'three'
import { Car } from '../src/car.js'
import { RemoteCar } from '../src/remoteCar.js'
import { measureFootprint, testCars, testArenaWalls } from '../src/collision.js'
import { judgeHit, impactDamage, HitCooldown, damageParams, Health, MAX_HEALTH, KO_TIME, RESPAWN_SHIELD } from '../src/damage.js'
import { validators } from '../src/protocol.js'
import { Orbs } from '../src/orbs.js'
import { pickLivery, LIVERIES } from '../src/paint.js'

const DT = 1 / 60
// Carro com o tamanho da base do bate-bate (~1,3 x 2,7 m)
const makeCar = () => new Car(new THREE.Mesh(new THREE.BoxGeometry(1.28, 0.5, 2.66)))
const footprint = (() => {
  const c = makeCar()
  c.root.updateMatrixWorld(true)
  return measureFootprint(c.body.children[0])
})()
const run = (car, seconds, input) => {
  for (let t = 0; t < seconds; t += DT) car.update(DT, input)
}

describe('Car: direção', () => {
  test('acelera com curva: demora mais para chegar perto do máximo', () => {
    const car = makeCar()
    run(car, 1, { throttle: 1, steer: 0 })
    const after1s = car.speed
    run(car, 3, { throttle: 1, steer: 0 })
    assert.ok(after1s > 1 && after1s < car.params.maxSpeed * 0.7, `1 s: ${after1s}`)
    assert.ok(car.speed > after1s && car.speed <= car.params.maxSpeed)
  })

  test('volante pesado: quase não gira no primeiro instante', () => {
    const car = makeCar()
    car.speed = 6
    run(car, 0.1, { throttle: 1, steer: 1 })
    assert.ok(Math.abs(car.yaw) < THREE.MathUtils.degToRad(3))
  })

  test('boost leva acima da velocidade máxima e depois volta aos poucos', () => {
    const car = makeCar()
    car.boost()
    assert.ok(car.isBoosting)
    assert.equal(car.speed, car.params.maxSpeed * car.params.boostSpeed)
    run(car, car.params.boostDuration + 0.05, { throttle: 1, steer: 0 })
    assert.ok(!car.isBoosting)
    assert.ok(car.speed > car.params.maxSpeed, 'sem tranco: a velocidade extra cai gradualmente')
  })
})

describe('Car: batidas', () => {
  test('empurrão de frente não é cortado para a velocidade de ré', () => {
    const car = makeCar()
    car.applyImpulse(new THREE.Vector3(0, 0, -15)) // carro olha para +Z, empurrão para trás
    const start = car.root.position.z
    run(car, 2, { throttle: 0, steer: 0 })
    assert.ok(start - car.root.position.z > 5, `andou ${start - car.root.position.z} m`)
  })

  test('batida dá pulinho e balanço', () => {
    const car = makeCar()
    car.applyImpulse(new THREE.Vector3(10, 0, 0))
    car.update(DT, { throttle: 0, steer: 0 })
    assert.ok(car.hopY > 0)
    assert.notEqual(car.wobble.roll, 0)
  })

  test('parede: ricocheteia e não atravessa', () => {
    const car = makeCar()
    car.spawn.set(0, 0, 40)
    car.reset()
    let hitSpeed = 0
    for (let t = 0; t < 5; t += DT) {
      car.update(DT, { throttle: 1, steer: 0 })
      for (const { normal, depth } of testArenaWalls(car.root.position, car.yaw, footprint, 50)) {
        hitSpeed = Math.max(hitSpeed, car.hitWall(normal, depth))
      }
      assert.ok(car.root.position.z + footprint.radius <= 50.001, 'não passa da parede')
    }
    assert.ok(hitSpeed > 3)
  })
})

describe('Colisão', () => {
  test('cápsulas encostadas colidem; separadas não', () => {
    const a = new THREE.Vector3(0, 0, 0)
    assert.ok(testCars(a, 0, new THREE.Vector3(0, 0, 2.5), 0, footprint))
    assert.equal(testCars(a, 0, new THREE.Vector3(0, 0, 3), 0, footprint), null)
    assert.equal(testCars(a, 0, new THREE.Vector3(1.4, 0, 0), 0, footprint), null)
  })

  test('normal aponta do outro para mim', () => {
    const hit = testCars(new THREE.Vector3(0, 0, 0), 0, new THREE.Vector3(0, 0, 2), 0, footprint)
    assert.ok(hit.normal.z < -0.99)
  })

  test('paredes: canto toca duas, centro nenhuma', () => {
    assert.equal(testArenaWalls(new THREE.Vector3(0, 0, 0), 0, footprint, 50).length, 0)
    assert.equal(testArenaWalls(new THREE.Vector3(49.6, 0, 48.9), 0, footprint, 50).length, 2)
  })
})

describe('Dano e vida', () => {
  test('dano pela força de quem bateu', () => {
    assert.equal(impactDamage(damageParams.minImpact - 0.1), 0)
    assert.equal(impactDamage(damageParams.minImpact), 1)
    assert.equal(impactDamage(damageParams.strong), 2)
    assert.equal(impactDamage(damageParams.smash), 3)
  })

  test('vida desce com o dano e não fica negativa', () => {
    const h = new Health()
    assert.equal(h.hp, MAX_HEALTH)
    h.damage(3)
    assert.equal(h.hp, MAX_HEALTH - 3)
    h.hp = 2
    const { dealt, knockedOut } = h.damage(5)
    assert.equal(dealt, 2)
    assert.ok(knockedOut && h.isKO && h.hp === 0)
  })

  test('nocauteado não leva dano; volta com vida cheia e protegido', () => {
    const h = new Health()
    h.hp = 1
    h.damage(1)
    assert.equal(h.damage(5).dealt, 0)
    let back = false
    for (let t = 0; t < KO_TIME + 0.1; t += DT) back = h.update(DT) || back
    assert.ok(back && !h.isKO && h.hp === MAX_HEALTH && h.isShielded)
    assert.equal(h.damage(5).dealt, 0, 'protegido logo depois de voltar')
    for (let t = 0; t < RESPAWN_SHIELD + 0.1; t += DT) h.update(DT)
    assert.equal(h.damage(5).dealt, 5)
  })

  test('agressor, vítima e empate', () => {
    const n = new THREE.Vector3(0, 0, -1) // do outro (à frente, +Z) para mim
    const still = new THREE.Vector3()
    const forward = new THREE.Vector3(0, 0, 6)
    assert.equal(judgeHit(n, forward, still).role, 'aggressor')
    assert.equal(judgeHit(n, still, new THREE.Vector3(0, 0, -6)).role, 'victim')
    assert.equal(judgeHit(n, forward, new THREE.Vector3(0, 0, -6)).role, 'tie')
  })

  test('intervalo entre batidas do mesmo par', () => {
    const cd = new HitCooldown()
    assert.ok(cd.ready('x', 0))
    assert.ok(!cd.ready('x', 0.3))
    assert.ok(cd.ready('y', 0.3))
    assert.ok(cd.ready('x', 1))
  })
})

describe('Protocolo de rede', () => {
  const state = { t: 1, x: 2, z: 3, yaw: 0, vx: 0, vz: 0, y: 0, roll: 0, pitch: 0, hp: 80, ko: false, colors: ['#ff0000', '#00ff00'] }

  test('estado válido passa', () => {
    const out = validators.state(state)
    assert.equal(out.x, 2)
    assert.deepEqual(out.colors, ['#ff0000', '#00ff00'])
  })

  test('NaN, tipos errados e lixo são descartados', () => {
    assert.equal(validators.state({ ...state, x: NaN }), null)
    assert.equal(validators.state({ ...state, vx: '5' }), null)
    assert.equal(validators.state(null), null)
    assert.equal(validators.hit({ target: 'a', ix: Infinity, iz: 0, damage: 1 }), null)
    assert.equal(validators.pickup({ slot: 1.5, gen: 0 }), null)
  })

  test('valores exagerados são limitados, HTML em cor/nome não passa', () => {
    assert.equal(validators.hit({ target: 'a', ix: 1e9, iz: 0, damage: 1 }).ix, 60)
    assert.equal(validators.state({ ...state, colors: ['red"><img src=x>', '#000000'] }).colors, null)
    assert.equal(validators.state({ ...state, hp: '<b>9</b>' }).hp, 0)
    assert.equal(validators.wall({ damage: 99 }), null)
  })
})

describe('Esferas', () => {
  const scene = new THREE.Scene()
  const make = (room) => new Orbs(scene, { roomId: room, count: 8, half: 44 })
  const positions = (o) => o.slots.map((s) => s.mesh.position.toArray().join()).join('|')

  test('mesma sala = mesmas posições; sala diferente = outras', () => {
    assert.equal(positions(make('a')), positions(make('a')))
    assert.notEqual(positions(make('a')), positions(make('b')))
  })

  test('pegar, aviso repetido ignorado, reaparece', () => {
    const o = make('a')
    assert.ok(o.take(2, 0))
    assert.ok(!o.take(2, 0))
    assert.ok(!o.isActive(o.slots[2]))
    o.update(6.1)
    assert.ok(o.isActive(o.slots[2]))
  })

  test('quem entra depois recebe o mesmo estado', () => {
    const a = make('a')
    a.take(1, 0)
    const late = make('a')
    late.merge(a.snapshot())
    assert.equal(positions(late), positions(a))
  })
})

describe('Carro remoto (interpolação)', () => {
  const snap = (t, z) => ({ t, x: 0, z, yaw: 0, vx: 0, vz: 10, y: 0, roll: 0, pitch: 0 })

  test('mostra o passado entre dois estados reais', () => {
    const r = new RemoteCar(new THREE.Object3D())
    // estados a cada 0,05 s chegando com 0,08 s de atraso
    for (let i = 0; i <= 10; i++) r.setState(snap(i * 0.05, i * 0.5), i * 0.05 + 0.08)
    r.sample(0.5 + 0.08) // agora: último estado é t=0.5; mostra ~t=0.4
    assert.ok(Math.abs(r.position.z - 4) < 0.1, `z=${r.position.z}`)
  })

  test('estado atrasado/repetido é ignorado', () => {
    const r = new RemoteCar(new THREE.Object3D())
    r.setState(snap(1, 5), 1)
    r.setState(snap(0.5, 99), 1.1)
    assert.equal(r.snapshots.length, 1)
  })
})

describe('Pintura', () => {
  test('evita as pinturas já em uso', () => {
    const taken = LIVERIES.slice(0, -1).map((l) => l.name)
    assert.equal(pickLivery(taken).name, LIVERIES.at(-1).name)
  })
})
