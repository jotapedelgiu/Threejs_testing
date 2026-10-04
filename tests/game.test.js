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
import { Orbs } from '../src/orbs.js'
import { pickLivery, LIVERIES, materialGroup, MATERIAL_GROUPS } from '../src/paint.js'
import { newLayout, shouldAdopt } from '../src/layout.js'
import { Presence } from '../src/presence.js'
import { newRoomCode, normalizeCode, cleanName, hostOf, CODE_LENGTH } from '../src/lobby.js'
import { TireWalls, placeTireWalls, prepareTireWall } from '../src/tireWalls.js'
import { distanceToSegment } from '../src/collision.js'
import { spawnPoints, cornerPoints, cornerIndex, chooseRespawn, yawToCenter } from '../src/spawns.js'

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
    o.update(9.1)
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

describe('Materiais do modelo', () => {
  const group = (name) => MATERIAL_GROUPS[materialGroup(name)]?.name

  test('nomes do Blender, com ou sem sufixo de cópia', () => {
    assert.equal(group('Body 1'), 'Carroceria (principal)')
    assert.equal(group('Body 1.001'), 'Carroceria (principal)')
    assert.equal(group('Special Metallic Car Paint.001'), 'Carroceria (secundária)')
    assert.equal(group('rubber base.002'), 'Borracha e assento')
    assert.equal(group('Procedural Leather.001'), 'Borracha e assento')
    assert.equal(group('Car chrome.001'), 'Metal e detalhes')
  })

  test('nomes genéricos "Material.xxx" só valem exatos', () => {
    assert.equal(group('Material.002'), 'Carroceria (secundária)')
    assert.equal(group('Material.001'), 'Borracha e assento')
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
