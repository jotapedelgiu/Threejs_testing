// Testes das regras do jogo (física, colisão, dano e vida, rede, esferas).
// Rodam no Node, sem navegador: `npm test`.
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import * as THREE from 'three'
import { Car } from '../src/car.js'
import { RemoteCar } from '../src/remoteCar.js'
import { measureFootprint, testCars, testArenaWalls, testCarCircle } from '../src/collision.js'
import { SpikedBats, placeBats, extractProp } from '../src/bats.js'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import { readFileSync } from 'node:fs'
import { judgeHit, impactDamage, impactTier, tierOfDamage, DAMAGE, HitCooldown, damageParams, Health, MAX_HEALTH, KO_TIME, RESPAWN_SHIELD } from '../src/damage.js'
import { validators } from '../src/protocol.js'
import { Orbs, orbCountFor } from '../src/orbs.js'
import { pickLivery, LIVERIES, materialGroup, MATERIAL_GROUPS } from '../src/paint.js'
import { newLayout, shouldAdopt } from '../src/layout.js'
import { Presence } from '../src/presence.js'
import { newRoomCode, normalizeCode, cleanName, hostOf, CODE_LENGTH } from '../src/lobby.js'
import { TireWalls, placeTireWalls, prepareTireWall } from '../src/tireWalls.js'
import { distanceToSegment } from '../src/collision.js'
import { spawnPoints, cornerPoints, cornerIndex, chooseRespawn, yawToCenter } from '../src/spawns.js'
import { UltimateDirector, UltimateSlot, StormStrikes, ShockwaveCast, MissileShot, ULTIMATES, ULT_KINDS, ULT_INTERVAL, ULT_WARNING, ULT_COOLDOWN, ULT_STORE_TIME } from '../src/ultimate.js'
import { MedkitDirector, MEDKIT, ZoneHealing, placeNearFight, HEAL_RATE, maxZonesFor } from '../src/medkit.js'

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

  test('paredes de arena retangular (largura e profundidade diferentes)', () => {
    // 90 x 55: perto da parede do fundo (z = 27,5), longe das laterais (x = 45)
    const hits = testArenaWalls(new THREE.Vector3(30, 0, 26.5), 0, footprint, 45, 27.5)
    assert.equal(hits.length, 1)
    assert.ok(hits[0].normal.z < 0, 'empurra de volta para dentro')
    assert.equal(testArenaWalls(new THREE.Vector3(30, 0, 0), 0, footprint, 45, 27.5).length, 0)
  })
})

describe('Dano e vida', () => {
  test('dano pela força de quem bateu', () => {
    assert.equal(impactDamage(damageParams.minImpact - 0.1), 0)
    assert.equal(impactDamage(damageParams.minImpact), DAMAGE.light)
    assert.equal(impactDamage(damageParams.strong), DAMAGE.strong)
    assert.equal(impactDamage(damageParams.smash), DAMAGE.smash)
  })

  test('balanceamento: proporção 1:2:3, TURBO vale 2 PANCADAS', () => {
    assert.equal(DAMAGE.strong, DAMAGE.light * 2)
    assert.equal(DAMAGE.smash, DAMAGE.light * 3)
    assert.equal(DAMAGE.turbo, DAMAGE.smash * 2)
  })

  test('faixa do dano recebido pela rede (texto na tela)', () => {
    assert.equal(impactTier(damageParams.smash), 'smash')
    assert.equal(tierOfDamage(DAMAGE.light), 'light')
    assert.equal(tierOfDamage(DAMAGE.strong), 'strong')
    assert.equal(tierOfDamage(DAMAGE.smash), 'smash')
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
    assert.equal(validators.wall({ damage: 999 }), null)
    assert.equal(validators.hit({ target: 'a', ix: 0, iz: 0, damage: DAMAGE.turbo }).damage, DAMAGE.turbo)
  })
})

describe('Esferas', () => {
  const scene = new THREE.Scene()
  const make = (room) => new Orbs(scene, { seed: room, count: 8, halfX: 39, halfZ: 21 })
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
    o.update(11.9)
    assert.ok(!o.isActive(o.slots[2]), 'ainda esperando (12 s)')
    o.update(0.2)
    assert.ok(o.isActive(o.slots[2]))
  })

  test('quantidade acompanha os jogadores, com teto', () => {
    assert.deepEqual([1, 2, 3, 4, 5, 6, 7, 8, 12].map(orbCountFor), [3, 3, 4, 4, 5, 5, 6, 6, 6])
  })

  test('menos jogadores: esferas a mais adormecem e voltam com a mesma geração', () => {
    const o = make('a')
    o.setCount(5)
    assert.equal(o.count, 5)
    o.update(0.1)
    assert.ok(o.isActive(o.slots[4]))
    o.take(4, 0)
    o.setCount(3)
    o.update(20)
    assert.ok(!o.isActive(o.slots[4]) && !o.slots[4].mesh.visible, 'adormecida')
    assert.equal(o.findPickup(o.slots[3].mesh.position), null, 'não dá para pegar')
    o.setCount(5)
    assert.equal(o.slots[4].gen, 1, 'mesma geração de antes (bate com os outros)')
    assert.ok(o.isActive(o.slots[4]))
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

describe('Materiais do modelo', () => {
  const group = (name) => MATERIAL_GROUPS[materialGroup(name)]?.name

  test('nomes do Blender, com ou sem sufixo de cópia', () => {
    assert.equal(group('Body 1'), 'Body (primary)')
    assert.equal(group('Body 1.001'), 'Body (primary)')
    assert.equal(group('Special Metallic Car Paint.001'), 'Body (secondary)')
    assert.equal(group('rubber base.002'), 'Rubber & seat')
    assert.equal(group('Procedural Leather.001'), 'Rubber & seat')
    assert.equal(group('Car chrome.001'), 'Metal & trim')
  })

  test('nomes genéricos "Material.xxx" só valem exatos', () => {
    assert.equal(group('Material.002'), 'Body (secondary)')
    assert.equal(group('Material.001'), 'Rubber & seat')
    assert.equal(materialGroup('Material.009'), -1) // desconhecido: cai no padrão
  })
})

describe('Bastões com espinhos', () => {
  test('posições: mesma sala = mesmas; longe do centro e espaçadas', () => {
    const a = placeBats('sala', 4, 38, 20, 12, 12)
    assert.deepEqual(a, placeBats('sala', 4, 38, 20, 12, 12))
    assert.notDeepEqual(a, placeBats('outra', 4, 38, 20, 12, 12))
    assert.equal(a.length, 4)
    for (const p of a) {
      assert.ok(Math.hypot(p.x, p.z) >= 12, 'fora da área de nascimento')
      assert.ok(Math.abs(p.x) <= 38 && Math.abs(p.z) <= 20, 'dentro da arena retangular')
      for (const q of a) if (q !== p) assert.ok(Math.hypot(p.x - q.x, p.z - q.z) >= 12)
    }
  })

  test('colisão carro × poste', () => {
    const car = new THREE.Vector3(0, 0, 0)
    assert.ok(testCarCircle(car, 0, footprint, 0, 1.9, 0.7), 'de frente (frente do carro a 1,33 m + raio 0,7)')
    assert.equal(testCarCircle(car, 0, footprint, 0, 2.1, 0.7), null, 'logo além do alcance')
    assert.ok(testCarCircle(car, 0, footprint, 1.2, 0, 0.7), 'de lado')
    assert.equal(testCarCircle(car, 0, footprint, 3, 3, 0.7), null)
    const hit = testCarCircle(car, 0, footprint, 0, 1.9, 0.7)
    assert.ok(hit.normal.z < -0.99, 'normal do poste para o carro')
  })

  test('ricochete: tomba para o lado da batida e volta ao repouso', () => {
    const scene = new THREE.Scene()
    const bats = new SpikedBats(scene, new THREE.Object3D(), { positions: placeBats('r', 1, 38, 20, 10, 10), radius: 0.7 })
    bats.kick(0, 0, 1, 10) // empurrão para +Z
    bats.update(DT * 6)
    const b = bats.bats[0]
    assert.ok(b.tiltX > 0.05, 'topo foi para +Z')
    for (let t = 0; t < 4; t += DT) bats.update(DT)
    assert.ok(Math.abs(b.tiltX) < 0.01 && Math.abs(b.tiltZ) < 0.01, 'voltou a ficar em pé')
  })

  test('mensagem de rede do bastão', () => {
    assert.ok(validators.bat({ index: 2, dx: 0.6, dz: -0.8, strength: 7, damage: 6 }))
    assert.equal(validators.bat({ index: 2, dx: 5, dz: 0, strength: 7, damage: 6 }).dx, 1)
    assert.equal(validators.bat({ index: -1, dx: 0, dz: 0, strength: 7, damage: 6 }), null)
  })

  test('arquivo real: separa só as peças do bastão, em pé e no chão', async () => {
    const file = readFileSync(new URL('../public/models/Bastao.glb', import.meta.url))
    const buffer = file.buffer.slice(file.byteOffset, file.byteOffset + file.byteLength)
    const gltf = await new Promise((res, rej) => new GLTFLoader().parse(buffer, '', res, rej))
    const prop = extractProp(gltf.scene, 'Bastao')
    assert.ok(prop.children.length >= 1, 'achou as peças pelo nome do material')
    assert.ok(prop.children.every((m) => m.material.name.startsWith('Bastao')))
    const box = new THREE.Box3().setFromObject(prop)
    assert.ok(Math.abs(box.min.y) < 0.01, 'pé no chão')
    assert.ok(box.max.y > 1, 'em pé (mais alto que largo)')
  })

  test('esferas nascem perto dos bastões (fora dos espinhos), iguais para a sala', () => {
    const scene = new THREE.Scene()
    const anchors = placeBats('sala', 4, 38, 20, 12, 12)
    const make = () => new Orbs(scene, { seed: 'sala', count: 5, halfX: 42, halfZ: 24, anchors, anchorRange: [2.5, 5.5] })
    const a = make(), b = make()
    for (const [i, slot] of a.slots.entries()) {
      const p = slot.mesh.position
      const nearest = Math.min(...anchors.map((q) => Math.hypot(p.x - q.x, p.z - q.z)))
      assert.ok(nearest >= 2.4 && nearest <= 5.6, `esfera ${i} a ${nearest.toFixed(2)} m do bastão`)
      assert.ok(p.equals(b.slots[i].mesh.position), 'mesma posição para todos')
    }
    // Todo bastão tem pelo menos uma esfera por perto
    for (const q of anchors) {
      assert.ok(a.slots.some((slot) => Math.hypot(slot.mesh.position.x - q.x, slot.mesh.position.z - q.z) <= 5.6))
    }
    // Pegou: reaparece perto de um bastão também
    a.take(0, 0)
    const p = a.slots[0].mesh.position
    assert.ok(Math.min(...anchors.map((q) => Math.hypot(p.x - q.x, p.z - q.z))) <= 5.6)
  })
})

describe('Mapa da partida', () => {
  test('cada partida sorteia uma semente diferente', () => {
    const seeds = new Set(Array.from({ length: 50 }, () => newLayout().seed))
    assert.equal(seeds.size, 50)
  })

  test('a sala converge para o mapa mais antigo (os dois lados concordam)', () => {
    const old = { seed: 'aaa', since: 1000 }, recent = { seed: 'bbb', since: 2000 }
    assert.ok(shouldAdopt(recent, old), 'quem chegou depois adota')
    assert.ok(!shouldAdopt(old, recent), 'quem já estava mantém')
    const x = { seed: 'x', since: 5 }, y = { seed: 'y', since: 5 }
    assert.notEqual(shouldAdopt(x, y), shouldAdopt(y, x), 'empate: só um dos dois troca')
    assert.ok(!shouldAdopt(old, { ...old }), 'mesmo mapa: nada muda')
  })

  test('mapa novo move os bastões e recomeça as esferas em volta deles', () => {
    const scene = new THREE.Scene()
    const spotsA = placeBats('mapa-a', 5, 38, 20, 12, 12), spotsB = placeBats('mapa-b', 5, 38, 20, 12, 12)
    assert.notDeepEqual(spotsA, spotsB)
    const bats = new SpikedBats(scene, new THREE.Object3D(), { positions: spotsA, radius: 0.7 })
    const orbs = new Orbs(scene, { seed: 'mapa-a', count: 5, halfX: 42, halfZ: 24, anchors: spotsA })
    orbs.take(0, 0)
    bats.setPositions(spotsB)
    orbs.relayout('mapa-b', spotsB)
    assert.deepEqual(bats.bats.map((b) => ({ x: b.x, z: b.z })), spotsB)
    assert.ok(orbs.slots.every((s) => s.gen === 0 && orbs.isActive(s)), 'esferas recomeçam')
    for (const s of orbs.slots) {
      const near = Math.min(...spotsB.map((q) => Math.hypot(s.mesh.position.x - q.x, s.mesh.position.z - q.z)))
      assert.ok(near <= 5.6, 'em volta dos bastões novos')
    }
  })

  test('mensagem de mapa: semente vazia ou esferas inválidas são descartadas', () => {
    assert.ok(validators.layout({ seed: 'abc', since: 123, orbs: [{ gen: 1, wait: 2 }] }))
    assert.equal(validators.layout({ seed: '', since: 123, orbs: [] }), null)
    assert.equal(validators.layout({ seed: 'abc', since: 123, orbs: [{ gen: -1, wait: 0 }] }), null)
  })
})

describe('Nocaute: sumir e reaparecer', () => {
  const snap = (t, x, tp) => ({ t, x, z: 0, yaw: 0, vx: 0, vz: 0, y: 0, roll: 0, pitch: 0, tp })

  test('carro remoto: teletransporte vai direto, sem deslizar pelo mapa', () => {
    const r = new RemoteCar(new THREE.Object3D())
    for (let i = 0; i <= 10; i++) r.setState(snap(i * 0.05, 0, 0), i * 0.05 + 0.05)
    // Volta do nocaute: aparece em x = 30 (tp mudou)
    r.setState(snap(0.55, 30, 1), 0.6)
    for (const now of [0.6, 0.62, 0.65, 0.7]) {
      r.sample(now)
      assert.equal(r.position.x, 30, `em t=${now} já está no lugar novo, sem passar pelo meio`)
    }
  })

  test('meu carro: reset não deixa o quadro seguinte interpolado', () => {
    const car = makeCar()
    car.savePrevious()
    car.spawn.set(20, 0, 0)
    const before = car.teleports
    car.reset()
    car.beginRender(0.5) // meio caminho entre o passo anterior e o atual
    assert.equal(car.root.position.x, 20)
    car.endRender()
    assert.equal(car.teleports, before + 1, 'conta o teletransporte (vai pela rede)')
  })

  test('presença: some no nocaute e reaparece com um "pop"', () => {
    const p = new Presence()
    let s = 1
    for (let t = 0; t < 0.4; t += DT) s = p.update(DT, false)
    assert.equal(s, 0, 'sumiu')
    let peak = 0
    for (let t = 0; t < 0.6; t += DT) peak = Math.max(peak, (s = p.update(DT, true)))
    assert.ok(peak > 1.03, 'passa um pouco do tamanho (pop)')
    assert.ok(Math.abs(s - 1) < 0.02, 'assenta no tamanho normal')
  })
})

describe('Sala de espera', () => {
  test('código de sala: 4 caracteres sem letras ambíguas', () => {
    for (let i = 0; i < 200; i++) {
      const code = newRoomCode()
      assert.equal(code.length, CODE_LENGTH)
      assert.match(code, /^[A-HJ-NP-Z2-9]+$/)
    }
  })

  test('código digitado vira o mesmo código da sala', () => {
    assert.equal(normalizeCode(' k7-qx '), 'K7QX')
    assert.equal(normalizeCode(null), '')
    assert.equal(normalizeCode('abcdefghijkl').length, 8)
  })

  test('nome limpo e limitado', () => {
    assert.equal(cleanName('  Zé   da  Silva '), 'Zé da Silva')
    assert.equal(cleanName('x'.repeat(40)).length, 16)
  })

  test('anfitrião é quem chegou primeiro; se ele sai, o próximo assume', () => {
    const members = [{ id: 'b', since: 200 }, { id: 'a', since: 100 }, { id: 'c', since: 300 }]
    assert.equal(hostOf(members), 'a')
    assert.equal(hostOf(members.filter((m) => m.id !== 'a')), 'b')
    assert.equal(hostOf([{ id: 'y', since: 5 }, { id: 'x', since: 5 }]), 'x', 'empate: todos concordam')
  })

  test('mensagens hello/start validadas', () => {
    assert.deepEqual(validators.hello({ name: '  Ana \n Paula ', since: 10, phase: 'lobby' }), { name: 'Ana Paula', since: 10, phase: 'lobby' })
    assert.equal(validators.hello({ name: 'x'.repeat(100), since: 1, phase: 'playing' }).name.length, 16)
    assert.equal(validators.hello({ name: 'a', since: 1, phase: 'hackeando' }), null)
    assert.equal(validators.hello({ name: 'a', phase: 'lobby' }), null)
    assert.deepEqual(validators.start({ seed: 'abc', since: 5 }), { seed: 'abc', since: 5 })
    assert.equal(validators.start({ seed: '', since: 5 }), null)
  })
})

describe('Paredes de pneus', () => {
  const bats = placeBats('mapa', 5, 38, 20, 12, 12)
  const opts = { count: 6, halfX: 39, halfZ: 21.5, halfLength: 2.9, keepClear: 10, avoid: bats, avoidDistance: 8, spacing: 7 }
  const ends = (w) => {
    const dx = Math.cos(w.yaw) * 2.9, dz = -Math.sin(w.yaw) * 2.9
    return [[w.x - dx, w.z - dz], [w.x + dx, w.z + dz]]
  }

  test('mesmo mapa = mesmas paredes; ângulos retos; dentro da arena', () => {
    const a = placeTireWalls('mapa', opts), b = placeTireWalls('mapa', opts)
    assert.deepEqual(a, b)
    assert.equal(a.length, 6)
    assert.notDeepEqual(placeTireWalls('outro', opts), a)
    for (const w of a) {
      const quarter = w.yaw / (Math.PI / 2)
      assert.ok(Math.abs(quarter - Math.round(quarter)) < 1e-9, 'múltiplo de 90°')
      for (const [x, z] of ends(w)) assert.ok(Math.abs(x) <= 39 + 1e-9 && Math.abs(z) <= 21.5 + 1e-9, 'inteira dentro da área')
    }
  })

  test('longe do centro, dos bastões e umas das outras', () => {
    const walls = placeTireWalls('mapa', opts)
    for (const [i, w] of walls.entries()) {
      const [a, b] = ends(w)
      assert.ok(distanceToSegment(0, 0, a, b) >= 10, 'centro livre')
      for (const bat of bats) assert.ok(distanceToSegment(bat.x, bat.z, a, b) >= 8, 'longe do bastão')
      for (const other of walls.slice(i + 1)) {
        const [c, d] = ends(other)
        assert.ok(distanceToSegment(c[0], c[1], a, b) >= 7 - 1e-9 && distanceToSegment(a[0], a[1], c, d) >= 7 - 1e-9, 'dá para passar entre elas')
      }
    }
  })

  test('o carro bate e ricocheteia na parede', () => {
    const scene = new THREE.Scene()
    const walls = new TireWalls(scene, new THREE.Object3D(), { walls: [{ x: 0, z: 5, yaw: 0 }], segmentHalf: 2.2, radius: 0.68 })
    assert.equal(walls.testCar(new THREE.Vector3(0, 0, 0), 0, footprint).length, 0, 'longe: nada')
    const hits = walls.testCar(new THREE.Vector3(1, 0, 3.5), 0, footprint) // de frente para a parede
    assert.equal(hits.length, 1)
    assert.ok(hits[0].normal.z < -0.9, 'empurra de volta (para -z)')
    assert.ok(hits[0].depth > 0)
    const car = makeCar()
    car.root.position.set(1, 0, 3.5)
    car.velocity.set(0, 0, 8)
    car.hitWall(hits[0].normal, hits[0].depth)
    assert.ok(car.velocity.z < 0, 'voltou')
    assert.ok(walls.clearance(0, 0) > 3 && walls.clearance(0, 5) < 0)
  })

  test('arquivo real: comprimento no eixo X, no chão e centralizado', async () => {
    const file = readFileSync(new URL('../public/models/TireWall.glb', import.meta.url))
    const buffer = file.buffer.slice(file.byteOffset, file.byteOffset + file.byteLength)
    const gltf = await new Promise((res, rej) => new GLTFLoader().parse(buffer, '', res, rej))
    const { model, halfLength, radius } = prepareTireWall(gltf.scene)
    assert.ok(Math.abs(halfLength - 2.9) < 0.15, `metade do comprimento ${halfLength.toFixed(2)} ≈ TIRE_HALF_LENGTH`)
    assert.ok(radius > 0.3 && radius < 1)
    const box = new THREE.Box3().setFromObject(model)
    assert.ok(Math.abs(box.min.y) < 0.01, 'no chão')
    assert.ok(Math.abs(box.min.x + box.max.x) < 0.01 && Math.abs(box.min.z + box.max.z) < 0.01, 'centralizada')
  })
})

describe('Pontos de nascimento', () => {
  const points = spawnPoints(39, 22.5)
  const corners = cornerPoints(39, 22.5)

  test('cada jogador num canto, pela ordem de chegada (todos concordam)', () => {
    const members = [{ id: 'c', since: 30 }, { id: 'a', since: 10 }, { id: 'b', since: 20 }, { id: 'd', since: 40 }, { id: 'e', since: 50 }]
    const idx = members.map((m) => cornerIndex(members, m.id))
    assert.deepEqual(idx, [2, 0, 1, 3, 0], 'a=1º, b=2º, c=3º, d=4º; o 5º volta ao 1º canto')
    assert.equal(new Set(idx.slice(0, 4)).size, 4, '4 jogadores, 4 cantos diferentes')
    const [first, second] = corners
    assert.ok(first.x === -second.x && first.z === -second.z, '2 jogadores: cantos opostos')
  })

  test('nasce olhando para o centro', () => {
    for (const c of corners) {
      const yaw = yawToCenter(c.x, c.z)
      const fx = Math.sin(yaw), fz = Math.cos(yaw)
      const toCenter = Math.hypot(c.x, c.z)
      assert.ok(Math.abs(fx - -c.x / toCenter) < 1e-9 && Math.abs(fz - -c.z / toCenter) < 1e-9)
    }
  })

  test('pontos em cima de obstáculos ficam de fora', () => {
    assert.equal(points.length, 15)
    const free = spawnPoints(39, 22.5, (x, z) => !(x === 0 && z === 0))
    assert.equal(free.length, 14)
    assert.ok(!free.some((p) => p.x === 0 && p.z === 0))
  })

  test('renasce longe dos inimigos e nunca em cima de alguém', () => {
    const enemies = [{ x: -39, z: -22.5 }, { x: -19.5, z: 0 }]
    for (let i = 0; i < 50; i++) {
      const p = chooseRespawn(points, { enemies })
      const nearest = Math.min(...enemies.map((e) => Math.hypot(e.x - p.x, e.z - p.z)))
      assert.ok(nearest >= 20, `ponto a ${nearest.toFixed(1)} m do inimigo mais próximo`)
    }
  })

  test('nunca no mesmo ponto da última vez, e varia entre os melhores', () => {
    const last = { x: 39, z: 22.5 }
    const seen = new Set()
    for (let i = 0; i < 200; i++) {
      const p = chooseRespawn(points, { enemies: [], death: { x: 0, z: 0 }, last })
      assert.ok(p.x !== last.x || p.z !== last.z)
      seen.add(`${p.x},${p.z}`)
    }
    assert.ok(seen.size >= 3, 'sorteia entre a metade melhor, não sempre o mesmo')
  })

  test('sozinho: longe de onde morreu', () => {
    for (let i = 0; i < 50; i++) {
      const p = chooseRespawn(points, { enemies: [], death: { x: 39, z: 22.5 } })
      assert.ok(Math.hypot(p.x - 39, p.z - 22.5) > 30)
    }
  })

  test('mapa sorteado deixa os cantos livres', () => {
    for (const seed of ['a', 'b', 'c', 'd', 'e']) {
      const bats = placeBats(seed, 5, 38, 20.5, 12, 12, corners, 7)
      for (const c of corners) for (const b of bats) assert.ok(Math.hypot(b.x - c.x, b.z - c.z) >= 7)
      const walls = placeTireWalls(seed, { count: 6, halfX: 39, halfZ: 21.5, halfLength: 2.9, keepClear: 10, avoid: [...bats, ...corners], avoidDistance: 8, spacing: 7 })
      for (const w of walls) {
        const dx = Math.cos(w.yaw) * 2.9, dz = -Math.sin(w.yaw) * 2.9
        for (const c of corners) assert.ok(distanceToSegment(c.x, c.z, [w.x - dx, w.z - dz], [w.x + dx, w.z + dz]) >= 8)
      }
    }
  })
})

describe('Ultimate', () => {
  const run = (d, seconds, host = true) => {
    let changes = 0
    for (let t = 0; t < seconds; t += 0.1) if (d.update(0.1, host)) changes++
    return changes
  }

  test('item do centro: espera → aviso → no centro → alguém pega → espera de novo', () => {
    const d = new UltimateDirector(() => 0)
    run(d, ULT_INTERVAL - ULT_WARNING - 0.5)
    assert.equal(d.phase, 'waiting')
    run(d, 1)
    assert.equal(d.phase, 'warning', 'aviso nos últimos 10 s')
    run(d, ULT_WARNING)
    assert.equal(d.phase, 'available')
    assert.equal(d.kind, 'overcharge')
    assert.ok(d.claim('ana'))
    assert.deepEqual(d.given, { n: 0, owner: 'ana', kind: 'overcharge' })
    assert.ok(!d.claim('beto'), 'um item, um dono')
    assert.equal(d.phase, 'waiting')
    assert.equal(d.n, 1)
    assert.ok(d.timer > ULT_INTERVAL - 1, 'o próximo vem 1 min depois de pegarem')
  })

  test('só o anfitrião muda de fase; os outros seguem o estado dele', () => {
    const host = new UltimateDirector(() => 0), guest = new UltimateDirector()
    run(guest, ULT_INTERVAL + 5, false)
    assert.equal(guest.phase, 'waiting', 'convidado não decide sozinho')
    run(host, ULT_INTERVAL + 1)
    host.claim('ana')
    assert.ok(guest.apply(host.snapshot()))
    assert.equal(guest.given.owner, 'ana')
    assert.ok(!guest.apply({ ...host.snapshot(), n: -1 }), 'ciclo velho é ignorado')
  })

  test('inventário: guarda, usa quando quiser, 1 min de recarga', () => {
    const slot = new UltimateSlot()
    assert.ok(slot.canPickUp && !slot.ready)
    assert.ok(slot.give('overcharge'))
    assert.ok(!slot.canPickUp && !slot.give('overcharge'), 'uma vaga só')
    for (let t = 0; t < 30; t += 0.1) slot.update(0.1)
    assert.ok(slot.ready, 'guardado não estraga')
    assert.equal(slot.activate(), 'overcharge')
    assert.equal(slot.active, 'overcharge')
    assert.ok(slot.canPickUp, 'em uso libera a vaga')
    let ended = false
    for (let t = 0; t < ULTIMATES.overcharge.duration + 0.2; t += 0.1) ended = slot.update(0.1) || ended
    assert.ok(ended && !slot.active, 'o poder acaba sozinho')
    for (let t = 0; t < 30; t += 0.1) slot.update(0.1)
    slot.give('overcharge') // pegou outro no meio da recarga
    assert.ok(!slot.ready && slot.activate() === null, 'espera a recarga')
    for (let t = 0; t < ULT_COOLDOWN - 30; t += 0.1) slot.update(0.1)
    assert.ok(slot.ready, 'recarga acabou, ainda dentro do prazo')
  })

  test('guardado se perde se não usar a tempo; nunca dois poderes ao mesmo tempo', () => {
    assert.ok(ULT_STORE_TIME + ULTIMATES.overcharge.duration <= ULT_INTERVAL, 'usando no último instante, acaba antes do próximo item')
    const slot = new UltimateSlot()
    slot.give('overcharge')
    let event = null
    for (let t = 0; t < ULT_STORE_TIME - 0.5; t += 0.1) event = slot.update(0.1) ?? event
    assert.equal(event, null)
    assert.ok(slot.ready, 'ainda dá para usar')
    for (let t = 0; t < 1; t += 0.1) event = slot.update(0.1) ?? event
    assert.equal(event, 'expired')
    assert.equal(slot.kind, null, 'perdeu')
    assert.ok(slot.canPickUp, 'vaga livre para o próximo')
  })

  test('nocaute encerra o poder em uso, mas não o guardado', () => {
    const slot = new UltimateSlot()
    slot.give('overcharge')
    slot.activate()
    slot.give('overcharge')
    slot.stop()
    assert.equal(slot.active, null)
    assert.equal(slot.kind, 'overcharge')
  })

  test('Sobrecarga: raio a cada 0,5 s em quem está no círculo; 3º raio atordoa', () => {
    const s = new StormStrikes(ULTIMATES.overcharge)
    const targets = [{ id: 'perto', x: 5, z: 0, immune: false }, { id: 'longe', x: 20, z: 0, immune: false }]
    const all = []
    for (let t = 0; t < 1.6; t += 0.1) all.push(...s.update(0.1, 0, 0, targets))
    assert.equal(all.length, 3, '3 raios em 1,5 s')
    assert.ok(all.every((h) => h.id === 'perto' && h.damage === 5))
    assert.deepEqual(all.map((h) => h.stun), [0, 0, 1.25])
    assert.ok(all[0].dx > 0.99, 'empurra para fora do círculo')
  })

  test('Sobrecarga: protegido leva o raio sem dano nem marca', () => {
    const s = new StormStrikes(ULTIMATES.overcharge)
    const hits = s.update(0.5, 0, 0, [{ id: 'p', x: 1, z: 0, immune: true }])
    assert.equal(hits.length, 1)
    assert.equal(hits[0].damage, 0)
    assert.equal(s.marks.get('p'), undefined)
  })

  test('mensagens do ultimate validadas', () => {
    assert.ok(validators.ult({ n: 2, phase: 'available', kind: 'overcharge', left: 0, given: null }))
    const withGiven = validators.ult({ n: 3, phase: 'waiting', kind: null, left: 60, given: { n: 2, owner: 'abc', kind: 'overcharge' } })
    assert.deepEqual(withGiven.given, { n: 2, owner: 'abc', kind: 'overcharge' })
    assert.equal(validators.ult({ n: 3, phase: 'waiting', left: 60, given: { n: 2, owner: 'abc', kind: 'hackeado' } }), null)
    assert.equal(validators.ult({ n: 2, phase: 'available', kind: 'hackeado', left: 0 }), null, 'tipo desconhecido')
    assert.equal(validators.ult({ n: 2, phase: 'taken', left: 0 }), null)
    assert.deepEqual(validators.ultreq({ n: 3, op: 'claim' }), { n: 3, op: 'claim' })
    assert.equal(validators.ultreq({ n: 3, op: 'roubar' }), null)
    const hit = validators.hit({ target: 'x', ix: 1, iz: 0, damage: 5, stun: 99, zap: true })
    assert.equal(hit.stun, 3, 'atordoamento limitado')
    assert.equal(hit.zap, true)
    const state = validators.state({ t: 1, x: 0, z: 0, yaw: 0, vx: 0, vz: 0, y: 0, roll: 0, pitch: 0, ult: 'overcharge' })
    assert.equal(state.ult, 'overcharge')
    assert.equal(validators.state({ t: 1, x: 0, z: 0, yaw: 0, vx: 0, vz: 0, y: 0, roll: 0, pitch: 0, ult: 'deus' }).ult, null)
  })

})

describe('Onda de choque', () => {
  const spec = ULTIMATES.shockwave
  // Carro na origem apontando para +x; faixa de 0 a 22 m em x, 6 m de largura
  const cast = () => new ShockwaveCast(spec, { x: 0, z: 0 }, { x: 1, z: 0 })
  const targets = [
    { id: 'perto', x: 2, z: 0, immune: false },
    { id: 'longe', x: 20, z: 1, immune: false },
    { id: 'do lado', x: 10, z: 6, immune: false },
    { id: 'atras', x: -5, z: 0, immune: false },
    { id: 'protegido', x: 5, z: -2, immune: true },
  ]
  const runAll = (c) => {
    const hits = []
    for (let t = 0; t < spec.windup + spec.travel + 0.2; t += 1 / 60) hits.push(...c.update(1 / 60, targets))
    return Object.fromEntries(hits.map((h) => [h.id, h]))
  }

  test('acerta só quem está na faixa na frente do carro', () => {
    const hits = runAll(cast())
    assert.ok(hits.perto && hits.longe && hits.protegido)
    assert.ok(!hits['do lado'], 'fora da largura')
    assert.ok(!hits.atras, 'atrás do carro')
  })

  test('preparação primeiro: nada antes da onda sair (dá para fugir)', () => {
    const c = cast()
    let early = []
    for (let t = 0; t < spec.windup - 0.02; t += 1 / 60) early.push(...c.update(1 / 60, targets))
    assert.equal(early.length, 0)
  })

  test('a onda anda: o perto é atingido antes do longe, e cada um uma vez só', () => {
    const c = cast()
    const order = []
    for (let t = 0; t < spec.windup + spec.travel + 0.2; t += 1 / 60) {
      for (const h of c.update(1 / 60, targets)) order.push(h.id)
    }
    assert.ok(order.indexOf('perto') < order.indexOf('longe'))
    assert.equal(order.length, new Set(order).size, 'sem repetir')
    assert.ok(c.done)
  })

  test('mais perto = mais dano e arremesso; empurra na direção da faixa', () => {
    const hits = runAll(cast())
    assert.ok(hits.perto.damage > hits.longe.damage)
    assert.ok(hits.perto.damage <= spec.maxDamage && hits.longe.damage >= spec.minDamage)
    assert.ok(hits.perto.push > hits.longe.push)
    assert.deepEqual([hits.perto.dx, hits.perto.dz], [1, 0])
    assert.equal(hits.protegido.damage, 0, 'protegido: só o arremesso')
  })

  test('quem usa fica parado o tempo todo da onda', () => {
    assert.ok(Math.abs(spec.duration - (spec.windup + spec.travel)) < 1e-9)
    assert.ok(ULT_KINDS.includes('shockwave') && ULT_KINDS.includes('overcharge'))
    assert.ok(ULT_STORE_TIME + Math.max(...ULT_KINDS.map((k) => ULTIMATES[k].duration)) <= ULT_INTERVAL)
  })
})

describe('Zona de cura', () => {
  // place: centro 5 m ao lado do ferido daquela briga
  const place = (t) => ({ x: t.x + 5, z: t.z })
  const run = (d, seconds, hurt, { host = true, maxZones = 1 } = {}) => {
    for (let t = 0; t < seconds; t += 0.1) d.update(0.1, host, { hurt, place, maxZones })
  }
  // Fica `seconds` dentro da zona começando com `hp`; devolve a vida final
  const stayInside = (hp, seconds) => {
    const z = new ZoneHealing()
    for (let t = 0; t < seconds - 1e-9; t += 1 / 60) hp += z.update(1 / 60, hp)
    return hp
  }
  const ferido = { x: -30, z: 0, hp: 20 }

  test('só aparece com alguém de vida baixa, e é rara', () => {
    const yes = new MedkitDirector(() => 0)
    run(yes, 30, [])
    assert.ok(!yes.active, 'todo mundo bem: nada')
    run(yes, MEDKIT.checkEvery + 0.1, [ferido])
    assert.equal(yes.zones.length, 1)
    assert.deepEqual([yes.zones[0].x, yes.zones[0].z], [-25, 0], 'perto do ferido')
    const no = new MedkitDirector(() => 0.99)
    run(no, 60, [ferido])
    assert.ok(!no.active, 'depende do sorteio')
  })

  test('dura alguns segundos; a região espera o intervalo; só o anfitrião decide', () => {
    const d = new MedkitDirector(() => 0)
    run(d, MEDKIT.checkEvery + 0.1, [ferido])
    run(d, MEDKIT.duration + 1, [ferido], { host: false })
    assert.ok(d.active, 'convidado não muda nada')
    run(d, 0.2, [ferido])
    assert.ok(!d.active, 'acabou')
    run(d, MEDKIT.gap - 1, [ferido])
    assert.ok(!d.active, 'mesma briga: intervalo')
    run(d, MEDKIT.checkEvery + 1.2, [ferido])
    assert.ok(d.active, 'depois do intervalo, outra')
  })

  test('duas brigas longe uma da outra: duas zonas (com jogadores suficientes)', () => {
    const outraBriga = { x: 30, z: 10, hp: 25 }
    const d = new MedkitDirector(() => 0)
    run(d, MEDKIT.checkEvery * 3, [ferido, outraBriga], { maxZones: 2 })
    assert.equal(d.zones.length, 2)
    const [a, b] = d.zones
    assert.ok(Math.hypot(a.x - b.x, a.z - b.z) > MEDKIT.separation, 'uma em cada briga')
    const pouca = new MedkitDirector(() => 0)
    run(pouca, MEDKIT.checkEvery * 3, [ferido, outraBriga], { maxZones: 1 })
    assert.equal(pouca.zones.length, 1, 'sala pequena: uma só')
  })

  test('mesma briga: nunca duas zonas lado a lado', () => {
    const vizinho = { x: -26, z: 3, hp: 15 }
    const d = new MedkitDirector(() => 0)
    run(d, MEDKIT.checkEvery * 3, [ferido, vizinho], { maxZones: 2 })
    assert.equal(d.zones.length, 1)
  })

  test('zonas por quantidade de jogadores', () => {
    assert.deepEqual([1, 4, 5, 6, 10, 20].map(maxZonesFor), [1, 1, 1, 2, 2, 2])
  })

  test('dentro do círculo a zona inteira: cura 90% da vida perdida', () => {
    assert.ok(Math.abs(stayInside(20, MEDKIT.duration) - (20 + 0.9 * 80)) <= 1, `de 20 foi para ${stayInside(20, MEDKIT.duration)}`)
    assert.ok(Math.abs(stayInside(60, MEDKIT.duration) - (60 + 0.9 * 40)) <= 1)
    assert.ok(stayInside(20, MEDKIT.duration / 2) < stayInside(20, MEDKIT.duration), 'metade do tempo, menos cura')
    assert.equal(stayInside(100, MEDKIT.duration), 100, 'vida cheia não passa de 100')
    assert.ok(HEAL_RATE > 0.25 && HEAL_RATE < 0.33, '~29% do que falta por segundo')
  })

  test('aparece perto da briga: a poucos metros de quem tem menos vida', () => {
    const grid = []
    for (let x = -39; x <= 39; x += 5.6) for (let z = -22.5; z <= 22.5; z += 5.6) grid.push({ x, z })
    const hurt = { x: -10, z: 2, hp: 20 }, attacker = { x: -4, z: 2, hp: 90 }
    for (let i = 0; i < 50; i++) {
      const p = placeNearFight(grid, [attacker, hurt])
      const dw = Math.hypot(p.x - hurt.x, p.z - hurt.z)
      assert.ok(dw >= 2.5 && dw <= 9, `centro a ${dw.toFixed(1)} m do ferido`)
    }
    const d = new MedkitDirector()
    d.spawn({ x: 0, z: 0 })
    assert.ok(d.contains(MEDKIT.radius - 0.1, 0) && !d.contains(MEDKIT.radius + 0.1, 0))
  })

  test('mensagem da zona validada', () => {
    assert.ok(validators.medkit({ v: 3, zones: [{ id: 1, x: 3, z: 4, left: 8 }, { id: 2, x: -20, z: 0, left: 5 }] }))
    assert.equal(validators.medkit({ v: 3, zones: [{ id: 1, x: NaN, z: 4, left: 8 }] }), null)
    assert.equal(validators.medkit({ v: 3, zones: Array(9).fill({ id: 1, x: 0, z: 0, left: 1 }) }), null, 'zonas demais')
  })

})

describe('Míssil', () => {
  const spec = ULTIMATES.missile
  // Saindo de x = -40 para +x numa arena de ±45 × ±27,5
  const shoot = () => new MissileShot(spec, { x: -40, z: 0 }, { x: 1, z: 0 }, 45, 27.5)
  const fly = (s, seconds, targets = []) => {
    const hits = []
    for (let t = 0; t < seconds; t += 1 / 60) hits.push(...s.update(1 / 60, targets))
    return hits
  }

  test('cruza o mapa em linha reta até a mureta', () => {
    const s = shoot()
    assert.ok(Math.abs(s.length - 85) < 1e-9)
    fly(s, s.length / spec.speed + 0.1)
    assert.ok(!s.flying)
    assert.ok(Math.abs(s.position.x - 45) < 1e-6)
    const diagonal = new MissileShot(spec, { x: 0, z: 0 }, { x: Math.SQRT1_2, z: Math.SQRT1_2 }, 45, 27.5)
    assert.ok(Math.abs(diagonal.length - 27.5 * Math.SQRT2) < 1e-6, 'para no primeiro lado que encontrar')
  })

  test('atravessa quem está no caminho (uma vez cada) e continua', () => {
    const s = shoot()
    const targets = [
      { id: 'a', x: -20, z: 0.5, immune: false },
      { id: 'b', x: 10, z: -1, immune: false },
      { id: 'longe', x: 0, z: 8, immune: false },
    ]
    const hits = fly(s, 3, targets)
    assert.deepEqual(hits.map((h) => h.id), ['a', 'b'])
    assert.equal(hits[0].damage, spec.damage)
    assert.deepEqual([hits[0].dx, hits[0].dz], [1, 0], 'empurra na direção do míssil')
  })

  test('rastro: só onde o míssil já passou, e some depois', () => {
    const s = shoot()
    fly(s, 0.5) // ~22 m percorridos
    assert.ok(s.trailContains(-30, 1))
    assert.ok(!s.trailContains(10, 0), 'ainda não chegou ali')
    assert.ok(!s.trailContains(-30, 4), 'fora da largura')
    fly(s, s.length / spec.speed + spec.trailLife)
    assert.ok(s.expired && !s.trailContains(-30, 0))
  })

  test('lentidão: o carro não passa da fração da velocidade máxima', () => {
    const c = makeCar()
    c.speedScale = spec.slow
    run(c, 6, { throttle: 1, steer: 0 })
    assert.ok(c.speed <= c.params.maxSpeed * spec.slow + 0.01, `velocidade ${c.speed.toFixed(2)}`)
    c.speedScale = 1
    run(c, 6, { throttle: 1, steer: 0 })
    assert.ok(c.speed > c.params.maxSpeed * 0.9, 'sem lentidão volta ao normal')
  })

  test('2 mísseis por item: o 2º não espera a recarga; depois a vaga libera', () => {
    const slot = new UltimateSlot()
    slot.give('missile')
    assert.equal(slot.charges, 2)
    assert.equal(slot.activate(), 'missile')
    assert.equal(slot.kind, 'missile', 'ainda tem 1 guardado')
    assert.ok(!slot.canPickUp, 'não pega outro item enquanto tiver míssil')
    assert.equal(slot.cooldown, ULT_COOLDOWN, 'a recarga começa no 1º tiro')
    assert.ok(!slot.ready, 'intervalo entre tiros')
    for (let t = 0; t < spec.duration + 0.05; t += 0.05) slot.update(0.05)
    assert.ok(slot.ready && slot.cooldown > 50, '2º tiro liberado mesmo com a recarga correndo')
    assert.equal(slot.activate(), 'missile')
    assert.equal(slot.kind, null)
    assert.ok(slot.canPickUp)
    assert.equal(slot.activate(), null, 'acabaram')
  })

  test('o míssil que sobrou também vence no prazo', () => {
    const slot = new UltimateSlot()
    slot.give('missile')
    slot.activate()
    let event = null
    for (let t = 0; t < ULT_STORE_TIME + 1; t += 0.1) event = slot.update(0.1) ?? event
    assert.equal(event, 'expired')
    assert.equal(slot.charges, 0)
  })

  test('mensagem de batida do míssil', () => {
    assert.equal(validators.hit({ target: 'x', ix: 14, iz: 0, damage: 20, rocket: true }).rocket, true)
  })
})
