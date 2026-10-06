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
import { HP_SCALE, judgeHit, impactDamage, impactTier, tierOfDamage, DAMAGE, HitCooldown, RamLedger, PushChain, chainDamage, CHAIN_WINDOW, CHAIN_MAX, HEAD_ON_MIN, damageParams, Health, MAX_HEALTH, KO_TIME, RESPAWN_SHIELD } from '../src/damage.js'
import { validators } from '../src/protocol.js'
import { Orbs, orbCountFor } from '../src/orbs.js'
import { pickLivery, LIVERIES, materialGroup, MATERIAL_GROUPS } from '../src/paint.js'
import { newLayout, shouldAdopt } from '../src/layout.js'
import { Presence } from '../src/presence.js'
import { newRoomCode, normalizeCode, cleanName, hostOf, CODE_LENGTH } from '../src/lobby.js'
import { TireWalls, placeTireWalls, prepareTireWall } from '../src/tireWalls.js'
import { distanceToSegment } from '../src/collision.js'
import { spawnPoints, cornerPoints, cornerIndex, chooseRespawn, yawToCenter } from '../src/spawns.js'
import { UltimateDirector, UltimateSlot, StormStrikes, ShockwaveCast, MissileShot, ambushStrikes, ULTIMATES, ULT_KINDS, ULT_INTERVAL, ULT_WARNING, ULT_COOLDOWN, ULT_STORE_TIME, ULT_ITEMS, storeTimeFor } from '../src/ultimate.js'
import { levelFor, damageToLevelUp, damageScale, scaleDamage, maxHealthFor, MAX_LEVEL, xpForHit, xpForKill, xpForAssist, repeatScale, XP_EXTRA } from '../src/progression.js'
import { MedkitDirector, MEDKIT, ZoneHealing, placeNearFight, HEAL_RATE, maxZonesFor } from '../src/medkit.js'
import { BotBrain, BOT_SKILLS, headingTo, pathClear } from '../src/bots.js'
import { KillTracker, KILL_CREDIT, tallyDealtByLevel, tallyKills, tallyXp, tallyAssists, standings, winners, formatClock, newKills, MATCH_TIME } from '../src/match.js'
import { buildStats, buildReport, kda, LevelTimer, XpTimeline } from '../src/matchStats.js'

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

  test('balanceamento: curva acentuada, TURBO vale mais que uma PANCADA', () => {
    assert.ok(DAMAGE.strong >= DAMAGE.light * 2)
    assert.ok(DAMAGE.smash >= DAMAGE.strong * 2)
    assert.ok(DAMAGE.turbo > DAMAGE.smash * 1.5)
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

  test('de frente entre jogadores: os dois vindo um para cima do outro é empate, mesmo com velocidades diferentes', () => {
    const n = new THREE.Vector3(0, 0, -1)
    const fast = new THREE.Vector3(0, 0, 8), slowBack = new THREE.Vector3(0, 0, -3)
    assert.equal(judgeHit(n, fast, slowBack).role, 'aggressor', 'sem a regra, o mais rápido bate')
    const j = judgeHit(n, fast, slowBack, HEAD_ON_MIN)
    assert.equal(j.role, 'tie')
    assert.deepEqual([j.impact, j.theirs], [8, 3])
    assert.equal(judgeHit(n, fast, new THREE.Vector3(0, 0, -1), HEAD_ON_MIN).role, 'aggressor', 'o outro quase parado: continua sendo batida de um só')
    assert.equal(judgeHit(n, new THREE.Vector3(0, 0, 1), slowBack, HEAD_ON_MIN).role, 'victim', 'eu quase parado, ele vindo')
  })

  test('intervalo entre batidas do mesmo par', () => {
    const cd = new HitCooldown()
    assert.ok(cd.ready('x', 0))
    assert.ok(!cd.ready('x', 0.3))
    assert.ok(cd.ready('y', 0.3))
    assert.ok(cd.ready('x', 1))
  })

  test('ricochete: o dano é de quem empurrou, reduzido a cada repasse', () => {
    const b = new PushChain()
    assert.equal(b.ricochet('c', 0, 1, 0), null) // ninguém me empurrou
    b.pushed('a', 0, 1, 5, 0) // A empurrou B para +x
    assert.equal(b.ricochet('a', 1.2, 1, 0), null) // batendo em quem empurrou: a batida é minha
    assert.equal(b.ricochet('c', 1.2, 0, 1), null) // C fora do sentido do empurrão: batida minha
    assert.deepEqual(b.ricochet('c', 1.2, 1, 0.2), { owner: 'a', relay: 1 })
    assert.equal(b.ricochet('d', 1.3, 1, 0), null) // o ricochete vale uma vez só
    b.pushed('a', 0, 2, 5, 0)
    assert.equal(b.ricochet('c', 2.01 + CHAIN_WINDOW, 1, 0), null) // passou o embalo
    b.pushed('a', 0, 3, 0, 0)
    assert.equal(b.ricochet('c', 3.1, 0, 0), null) // só dano, sem empurrão: nada a repassar
    const c = new PushChain()
    c.pushed('a', 1, 4, 0, -3) // B (empurrado por A) acertou C
    assert.deepEqual(c.ricochet('d', 4.1, 0, -1), { owner: 'a', relay: 2 })
    const last = new PushChain()
    last.pushed('a', CHAIN_MAX, 5, 1, 0) // repasses demais: acaba a cadeia
    assert.equal(last.ricochet('e', 5.1, 1, 0), null)
    assert.ok(chainDamage(DAMAGE.smash, 1) < DAMAGE.smash)
    assert.ok(chainDamage(DAMAGE.smash, 2) < chainDamage(DAMAGE.smash, 1))
  })
})

describe('Protocolo de rede', () => {
  const state = { t: 1, x: 2, z: 3, yaw: 0, vx: 0, vz: 0, y: 0, roll: 0, pitch: 0, hp: 80, ko: false, colors: ['#ff0000', '#00ff00'] }

  test('mensagem de estado valida dmgBy/dmgTaken', () => {
    const s = validators.state({ ...state, dmgTaken: { 2: 50, x: 'lixo' }, dmgBy: { b: { 3: 40 }, c: 'lixo' } })
    assert.deepEqual(s.dmgTaken, { 2: 50 })
    assert.deepEqual(s.dmgBy, { b: { 3: 40 } })
    assert.deepEqual(validators.state(state).dmgBy, {}, 'sem o campo (build de produção): vazio')
  })

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
    assert.equal(validators.wall({ damage: 99999 }), null)
    assert.equal(validators.hit({ target: 'a', ix: 0, iz: 0, damage: DAMAGE.turbo }).damage, DAMAGE.turbo)
  })

  test('bots: lista do anfitrião com estado de cada um; bot inválido derruba a mensagem', () => {
    const out = validators.bots({ list: [{ id: 'bot-1', name: '  Bot   Pneu ', kind: 'hard', state }] })
    assert.equal(out.list[0].name, 'Bot Pneu')
    assert.equal(out.list[0].state.x, 2)
    assert.equal(validators.bots({ list: [{ id: 'player-1', name: 'x', kind: 'hard', state }] }), null) // não é bot
    assert.equal(validators.bots({ list: [{ id: 'bot-1', name: 'x', kind: 'god', state }] }), null)
    assert.equal(validators.bots({ list: [{ id: 'bot-1', name: 'x', kind: 'easy', state: { ...state, x: NaN } }] }), null)
    assert.equal(validators.bots({ list: Array(9).fill({ id: 'bot-1', name: 'x', kind: 'easy', state }) }), null)
  })

  test('hit.by: só id de bot (ninguém se passa por outro jogador)', () => {
    assert.equal(validators.hit({ target: 'a', ix: 0, iz: 0, damage: 5, by: 'bot-2' }).by, 'bot-2')
    assert.equal(validators.hit({ target: 'a', ix: 0, iz: 0, damage: 5, by: 'someone' }).by, null)
    assert.equal(validators.hit({ target: 'a', ix: 0, iz: 0, damage: 5 }).by, null)
  })

  test('hit.chain/relay: repasse limitado a CHAIN_MAX', () => {
    const out = validators.hit({ target: 'a', ix: 0, iz: 0, damage: 5, chain: 'p1', relay: 2 })
    assert.equal(out.chain, 'p1')
    assert.equal(out.relay, 2)
    assert.equal(validators.hit({ target: 'a', ix: 0, iz: 0, damage: 5, chain: 'p1', relay: 99 }).relay, 1)
    assert.equal(validators.hit({ target: 'a', ix: 0, iz: 0, damage: 5 }).relay, 0)
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
    assert.deepEqual([1, 2, 3, 4, 5, 6, 7, 8, 12].map(orbCountFor), [3, 4, 4, 5, 6, 7, 7, 8, 9])
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
    assert.equal(d.claimable().length, ULT_ITEMS, 'dois itens ao mesmo tempo')
    const [first, second, third] = d.claimable()
    assert.equal(first.kind, 'overcharge')
    assert.equal(new Set([first.kind, second.kind, third.kind]).size, 3, 'de tipos diferentes')
    assert.equal(new Set([first, second, third].map((i) => `${i.x},${i.z}`)).size, 3, 'em lugares diferentes')
    assert.ok(d.claim('ana', 0))
    assert.deepEqual(d.given, { n: 0, owner: 'ana', kind: 'overcharge' })
    assert.ok(!d.claim('beto', 0), 'um item, um dono')
    assert.equal(d.phase, 'waiting')
    assert.equal(d.n, 1)
    assert.ok(d.timer > ULT_INTERVAL - 1, 'o próximo vem um intervalo depois do primeiro que pegarem')
    assert.equal(d.claimable().length, 2, 'os outros continuam lá')
    assert.ok(d.claim('beto', 1), 'e dá para pegar depois')
    assert.deepEqual(d.given, { n: 1, owner: 'beto', kind: second.kind })
    assert.ok(d.claim('cadu', 2))
    assert.equal(d.claimable().length, 0)
    assert.equal(d.timer > ULT_INTERVAL - 1, true, 'pegar o segundo não reinicia a espera')
  })

  test('o item que sobrou some quando o próximo aviso começa', () => {
    const d = new UltimateDirector(() => 0)
    run(d, ULT_INTERVAL + 1)
    d.claim('ana', 0)
    run(d, ULT_INTERVAL - ULT_WARNING + 0.5)
    assert.equal(d.phase, 'warning')
    assert.equal(d.claimable().length, 0, 'no aviso os itens ainda não têm tipo')
    assert.ok(!d.claim('beto', 1))
  })

  test('o item aparece num lugar sorteado (sempre outro) e todos veem o mesmo', () => {
    const spots = [{ x: -10, z: 4 }, { x: 12, z: -6 }, { x: 3, z: 9 }, { x: -4, z: -8 }, { x: 8, z: 8 }, { x: -9, z: -3 }, { x: 0, z: 0 }]
    let i = 0
    const host = new UltimateDirector(() => [0, 0, 0.5, 0.99, 0.3][i++ % 5]), guest = new UltimateDirector()
    const seen = []
    for (let n = 0; n < 4; n++) {
      for (let t = 0; t < ULT_INTERVAL + 1 && host.phase !== 'available'; t += 0.1) host.update(0.1, true, spots)
      const places = host.claimable().map((p) => `${p.x},${p.z}`)
      assert.equal(places.length, ULT_ITEMS)
      assert.ok(host.claimable().every((p) => spots.some((q) => q.x === p.x && q.z === p.z)), 'dos lugares da lista')
      assert.equal(new Set(places).size, ULT_ITEMS, 'lugares diferentes entre si')
      assert.ok(guest.apply(host.snapshot()))
      assert.deepEqual(guest.claimable(), host.claimable(), 'o convidado vê os mesmos itens')
      seen.push(places)
      host.claim('ana', 0)
      host.claim('beto', 1)
      host.claim('cadu', 2)
    }
    assert.ok(seen.every((p, k) => k === 0 || p.every((x) => !seen[k - 1].includes(x))), 'nunca repete os lugares do ciclo anterior')
  })

  test('os itens ficam longe uns dos outros', () => {
    // Grade 5 x 3: o primeiro é o canto (-20,-10); os outros, os mais distantes dele e entre si
    const spots = []
    for (const z of [-10, 0, 10]) for (const x of [-20, -10, 0, 10, 20]) spots.push({ x, z })
    const d = new UltimateDirector(() => 0)
    run(d, ULT_INTERVAL + 1, true)
    d.reset()
    for (let t = 0; t < ULT_INTERVAL + 1; t += 0.1) d.update(0.1, true, spots)
    const items = d.claimable()
    assert.equal(items.length, ULT_ITEMS)
    const gaps = []
    for (let a = 0; a < items.length; a++) for (let b = a + 1; b < items.length; b++) gaps.push(Math.hypot(items[a].x - items[b].x, items[a].z - items[b].z))
    assert.ok(Math.min(...gaps) >= 20, `distâncias entre os itens: ${gaps.map((g) => g.toFixed(0))}`)
  })

  test('poucos lugares (só o centro): os itens ficam lado a lado, sem se sobrepor', () => {
    const d = new UltimateDirector(() => 0)
    run(d, ULT_INTERVAL + 1)
    const items = d.claimable()
    assert.equal(new Set(items.map((i) => `${i.x},${i.z}`)).size, ULT_ITEMS)
  })

  test('só o anfitrião muda de fase; os outros seguem o estado dele', () => {
    const host = new UltimateDirector(() => 0), guest = new UltimateDirector()
    run(guest, ULT_INTERVAL + 5, false)
    assert.equal(guest.phase, 'waiting', 'convidado não decide sozinho')
    run(host, ULT_INTERVAL + 1)
    host.claim('ana', 0)
    assert.ok(guest.apply(host.snapshot()))
    assert.equal(guest.given.owner, 'ana')
    assert.ok(!guest.apply({ ...host.snapshot(), n: -1 }), 'ciclo velho é ignorado')
  })

  test('inventário: guarda, usa quando quiser, 30 s de recarga', () => {
    const slot = new UltimateSlot()
    assert.ok(slot.canPickUp && !slot.ready)
    assert.ok(slot.give('overcharge'))
    assert.ok(!slot.canPickUp && !slot.give('overcharge'), 'uma vaga só')
    for (let t = 0; t < 20; t += 0.1) slot.update(0.1)
    assert.ok(slot.ready, 'guardado não estraga')
    assert.equal(slot.activate(), 'overcharge')
    assert.equal(slot.active, 'overcharge')
    assert.ok(slot.canPickUp, 'em uso libera a vaga')
    let ended = false
    for (let t = 0; t < ULTIMATES.overcharge.duration + 0.2; t += 0.1) ended = slot.update(0.1) || ended
    assert.ok(ended && !slot.active, 'o poder acaba sozinho')
    for (let t = 0; t < 10; t += 0.1) slot.update(0.1)
    slot.give('overcharge') // pegou outro no meio da recarga
    assert.ok(!slot.ready && slot.activate() === null, 'espera a recarga')
    for (let t = 0; t < ULT_COOLDOWN - 16; t += 0.1) slot.update(0.1)
    assert.ok(slot.ready, 'recarga acabou, ainda dentro do prazo')
  })

  test('guardado se perde se não usar a tempo; nunca dois poderes ao mesmo tempo', () => {
    assert.ok(ULT_STORE_TIME + ULTIMATES.overcharge.duration <= ULT_INTERVAL, 'usando no último instante, acaba antes do próximo item')
    const slot = new UltimateSlot()
    slot.give('overcharge')
    let event = null
    for (let t = 0; t < storeTimeFor('overcharge') - 0.5; t += 0.1) event = slot.update(0.1) ?? event
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
    assert.ok(all.every((h) => h.id === 'perto' && h.damage === ULTIMATES.overcharge.damage))
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
    assert.ok(validators.ult({ n: 2, phase: 'available', left: 0, items: [{ x: 1, z: 2, kind: 'overcharge' }, null], given: null }))
    assert.equal(validators.ult({ n: 2, phase: 'available', left: 0, items: [{ x: 1, z: 2, kind: 'overcharge' }, null] }).items[1], null)
    assert.equal(validators.ult({ n: 2, phase: 'available', left: 0, items: [{ x: 1, z: 2, kind: 'overcharge' }, { x: 1, z: 2, kind: 'missile' }, { x: 0, z: 0, kind: 'missile' }, { x: 5, z: 5, kind: 'missile' }] }), null, 'itens demais')
    assert.equal(validators.ult({ n: 2, phase: 'available', left: 0, items: [{ x: NaN, z: 2, kind: 'overcharge' }] }), null)
    assert.equal(validators.ult({ n: 2, phase: 'available', left: 0, items: [null, null] }), null, 'disponível sem nenhum item')
    const withGiven = validators.ult({ n: 3, phase: 'waiting', left: 60, items: [], given: { n: 2, owner: 'abc', kind: 'overcharge' } })
    assert.deepEqual(withGiven.given, { n: 2, owner: 'abc', kind: 'overcharge' })
    assert.equal(validators.ult({ n: 3, phase: 'waiting', left: 60, given: { n: 2, owner: 'abc', kind: 'hackeado' } }), null)
    assert.equal(validators.ult({ n: 2, phase: 'available', left: 0, items: [{ x: 0, z: 0, kind: 'hackeado' }] }), null, 'tipo desconhecido')
    assert.equal(validators.ult({ n: 2, phase: 'taken', left: 0 }), null)
    assert.deepEqual(validators.ultreq({ n: 3, op: 'claim' }), { n: 3, op: 'claim', i: 0 })
    assert.deepEqual(validators.ultreq({ n: 3, op: 'claim', i: 1 }), { n: 3, op: 'claim', i: 1 })
    assert.deepEqual(validators.ultreq({ n: 3, op: 'claim', i: 2 }), { n: 3, op: 'claim', i: 2 })
    assert.equal(validators.ultreq({ n: 3, op: 'claim', i: 7 }), null)
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

describe('Emboscada', () => {
  const spec = ULTIMATES.ambush

  test('invisível até o aviso; sem apertar E, o tempo acaba e bate', () => {
    assert.equal(spec.duration, spec.vanish + spec.windup)
    const slot = new UltimateSlot()
    slot.give('ambush')
    assert.equal(slot.activate(), 'ambush')
    assert.ok(slot.ghost)
    slot.update(spec.vanish - 0.1)
    assert.ok(slot.ghost, 'ainda invisível um pouco antes')
    slot.update(0.2)
    assert.ok(!slot.ghost && slot.active === 'ambush', 'aviso da batida: visível, poder ainda ativo')
    assert.equal(slot.update(spec.windup), 'ended')
    assert.ok(!slot.ghost)

  })

  test('encostou em alguém: reaparece e bate NA HORA (sem aviso); o poder acaba', () => {
    const slot = new UltimateSlot()
    slot.give('ambush')
    slot.activate()
    slot.update(1)
    assert.ok(slot.strike())
    assert.ok(!slot.ghost)
    assert.equal(slot.active, null)
    assert.ok(!slot.strike(), 'só bate uma vez')
    assert.equal(slot.update(spec.windup + 0.01), null, 'o fim do tempo não bate de novo')
  })

  test('nocaute cancela: o poder em uso acaba sem terminar', () => {
    const slot = new UltimateSlot()
    slot.give('ambush')
    slot.activate()
    slot.stop()
    assert.ok(!slot.ghost)
    assert.equal(slot.update(10), null)
  })

  test('batida de área: dano e stun em quem está no raio, sem empurrão; protegido não leva', () => {
    const hits = ambushStrikes(spec, 0, 0, [
      { id: 'dentro', x: spec.radius - 1, z: 0, immune: false },
      { id: 'fora', x: spec.radius + 3, z: 0, immune: false },
      { id: 'protegido', x: 1, z: 1, immune: true },
    ])
    assert.deepEqual(hits.map((h) => h.id), ['dentro', 'protegido'])
    const dentro = hits.find((h) => h.id === 'dentro')
    assert.equal(dentro.damage, spec.damage)
    assert.equal(dentro.stun, spec.stun)
    assert.ok(!('dx' in dentro) && !('push' in dentro))
    assert.deepEqual(hits.find((h) => h.id === 'protegido'), { id: 'protegido', damage: 0, stun: 0 })
  })

  test('protocolo: ghost no estado e slam na batida', () => {
    const base = { t: 1, x: 0, z: 0, yaw: 0, vx: 0, vz: 0, y: 0, roll: 0, pitch: 0 }
    assert.equal(validators.state({ ...base, ult: 'ambush', ghost: true }).ghost, true)
    assert.equal(validators.state({ ...base, ult: 'ambush', ghost: 'sim' }).ghost, false)
    assert.equal(validators.state({ ...base }).ghost, false)
    assert.equal(validators.hit({ target: 'a', ix: 0, iz: 0, damage: 24, stun: 1, slam: true }).slam, true)
    assert.equal(validators.hit({ target: 'a', ix: 0, iz: 0, damage: 24 }).slam, false)
  })

  test('cabe no intervalo do item', () => {
    assert.ok(storeTimeFor('ambush') + spec.duration <= ULT_INTERVAL)
    assert.ok(storeTimeFor('overcharge') > storeTimeFor('ambush'), 'a Emboscada não encurta o prazo dos outros')
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

  test('dentro do círculo a zona inteira: cura 50% da vida perdida', () => {
    const full = MAX_HEALTH
    const low = 0.2 * full, mid = 0.6 * full
    assert.ok(Math.abs(stayInside(low, MEDKIT.duration) - (low + MEDKIT.healOfMissing * (full - low))) <= 1 * HP_SCALE, `de ${low} foi para ${stayInside(low, MEDKIT.duration)}`)
    assert.ok(Math.abs(stayInside(mid, MEDKIT.duration) - (mid + MEDKIT.healOfMissing * (full - mid))) <= 1 * HP_SCALE)
    assert.ok(stayInside(low, MEDKIT.duration / 2) < stayInside(low, MEDKIT.duration), 'metade do tempo, menos cura')
    assert.equal(stayInside(full, MEDKIT.duration), full, 'vida cheia não passa da máxima')
    assert.ok(HEAL_RATE > 0.08 && HEAL_RATE < 0.095, '~8,7% do que falta por segundo')
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

  test('rajada de 5 mísseis de 10 de dano (50 no total, na escala original), com o carro parado durante ela', () => {
    assert.equal(spec.shots, 5)
    assert.equal(spec.shots * spec.damage, 50 * HP_SCALE)
    assert.ok((spec.shots - 1) * spec.shotInterval < spec.duration, 'o último sai antes do poder acabar')
    const slot = new UltimateSlot()
    slot.give('missile')
    assert.equal(slot.activate(), 'missile')
    assert.equal(slot.kind, null)
    assert.ok(slot.canPickUp)
    assert.equal(slot.cooldown, ULT_COOLDOWN)
    assert.equal(slot.active, 'missile')
    assert.equal(slot.activeLeft, spec.duration)
    assert.equal(slot.activate(), null, 'acabou')
  })

  test('o míssil guardado vence no prazo', () => {
    const slot = new UltimateSlot()
    slot.give('missile')
    let event = null
    for (let t = 0; t < storeTimeFor('missile') + 1; t += 0.1) event = slot.update(0.1) ?? event
    assert.equal(event, 'expired')
  })

  test('mensagem de batida do míssil', () => {
    assert.equal(validators.hit({ target: 'x', ix: 14, iz: 0, damage: 10, rocket: true }).rocket, true)
  })
})

describe('Partida (abates)', () => {
  test('6 minutos', () => {
    assert.equal(MATCH_TIME, 360)
    assert.equal(formatClock(300), '5:00')
    assert.equal(formatClock(59.2), '1:00')
    assert.equal(formatClock(9), '0:09')
    assert.equal(formatClock(-3), '0:00')
  })

  test('o abate vai para quem bateu por último (até 8 s antes)', () => {
    const k = new KillTracker()
    k.noteHit('ana', 10)
    k.noteHit('beto', 12)
    assert.equal(k.knockedOut(13), 'beto', 'o último que bateu')
    k.noteHit('ana', 20)
    assert.equal(k.knockedOut(20 + KILL_CREDIT + 1), null, 'faz tempo: ninguém leva')
    assert.equal(k.knockedOut(40), null, 'sem batida nenhuma: só morte')
    assert.deepEqual(k.koBy, { beto: 1 })
    assert.equal(k.deaths, 3)
  })

  test('assistência: quem bateu na janela mas não deu o abate', () => {
    const k = new KillTracker()
    k.noteHit('ana', 10)
    k.noteHit('caio', 11)
    k.noteHit('beto', 12)
    k.knockedOut(13)
    assert.deepEqual(k.koBy, { beto: 1 })
    assert.deepEqual(k.asBy, { ana: 1, caio: 1 })
    k.noteHit('ana', 20)
    k.noteHit('beto', 40)
    k.knockedOut(41)
    assert.deepEqual(k.asBy, { ana: 1, caio: 1 }, 'batida antiga não conta')
    assert.equal(tallyAssists([{ asBy: { ana: 1 } }, { asBy: { ana: 2 } }, {}]).get('ana'), 3)
  })

  test('empate em abates: mais assistências vence', () => {
    const ranked = standings([
      { id: 'a', name: 'Ana', kills: 2, assists: 1, deaths: 0 },
      { id: 'b', name: 'Beto', kills: 2, assists: 3, deaths: 5 },
    ])
    assert.deepEqual(ranked.map((p) => p.id), ['b', 'a'])
    assert.deepEqual(winners(ranked).map((p) => p.id), ['b'])
  })

  test('placar: soma o "quem me nocauteou" de todo mundo', () => {
    const tally = tallyKills([{ koBy: { ana: 2 } }, { koBy: { ana: 1, beto: 3 } }, { koBy: {} }, {}])
    assert.equal(tally.get('ana'), 3)
    assert.equal(tally.get('beto'), 3)
  })

  test('classificação: mais abates; empate decide por menos mortes; vitória dividida', () => {
    const ranked = standings([
      { id: 'a', name: 'Ana', kills: 3, deaths: 2 },
      { id: 'b', name: 'Beto', kills: 5, deaths: 4 },
      { id: 'c', name: 'Caio', kills: 3, deaths: 1 },
    ])
    assert.deepEqual(ranked.map((p) => p.id), ['b', 'c', 'a'])
    assert.deepEqual(winners(ranked).map((p) => p.id), ['b'])
    const tie = standings([{ id: 'a', name: 'Ana', kills: 2, deaths: 0 }, { id: 'b', name: 'Beto', kills: 2, deaths: 3 }])
    assert.deepEqual(winners(tie).map((p) => p.id), ['a', 'b'], 'mesmos abates: os dois vencem')
    assert.deepEqual(winners(standings([{ id: 'a', name: 'Ana', kills: 0, deaths: 0 }])), [], 'ninguém abateu: empate')
  })

  test('kill feed: só os abates novos desde o último estado', () => {
    assert.deepEqual(newKills({ ana: 1 }, { ana: 2, beto: 1 }), ['ana', 'beto'])
    assert.deepEqual(newKills({ ana: 2 }, { ana: 2 }), [])
    assert.deepEqual(newKills(undefined, { ana: 1 }), ['ana'])
  })

  test('mensagens: placar no estado e relógio validados', () => {
    const base = { t: 1, x: 0, z: 0, yaw: 0, vx: 0, vz: 0, y: 0, roll: 0, pitch: 0 }
    assert.deepEqual(validators.state({ ...base, deaths: 2, koBy: { ana: 2, beto: 0 } }).koBy, { ana: 2 })
    assert.deepEqual(validators.state({ ...base, koBy: 'hack' }).koBy, {})
    assert.deepEqual(validators.state({ ...base, koBy: { ana: -5 } }).koBy, {})
    assert.deepEqual(validators.match({ left: 120, over: false }), { left: 120, over: false })
    assert.equal(validators.match({ left: 'agora' }), null)
  })
})

describe('Progressão (níveis)', () => {
  test('o nível sobe com o XP acumulado: 120, depois 138, 156..., até 15', () => {
    assert.deepEqual([0, 119, 120, 257, 258, 413, 414, 1727, 1728, 3317, 3318, 9000].map(levelFor), [1, 1, 2, 2, 3, 3, 4, 9, 10, 14, 15, 15])
    assert.equal(MAX_LEVEL, 15)
    assert.equal(levelFor(undefined), 1)
    assert.equal(damageToLevelUp(1), 120)
    assert.equal(damageToLevelUp(2), 138)
  })

  test('o XP soma o xpBy de todas as vítimas', () => {
    const k = new KillTracker()
    k.noteXp('ana', 30)
    k.noteXp('ana', 20)
    k.noteXp(null, 40)
    k.noteXp('beto', 0)
    assert.deepEqual(k.xpBy, { ana: 50 })
    assert.equal(tallyXp([k, { xpBy: { ana: 70 } }, {}]).get('ana'), 120)
  })

  test('XP extra: bater em quem está acima rende mais, abaixo rende menos', () => {
    // o XP fica na escala original: dano / HP_SCALE
    const dealt = 20 * HP_SCALE
    assert.equal(xpForHit(dealt, 5, 5), 20, 'mesmo nível: só o dano')
    assert.equal(xpForHit(dealt, 5, 7), 30, '+2 níveis: x1,5')
    assert.equal(xpForHit(dealt, 5, 3), 10, '-2 níveis: x0,5 (mínimo)')
    assert.equal(xpForHit(dealt, 1, 10), 50, 'teto de x2,5')
    assert.equal(xpForHit(0, 1, 10), 0)
    assert.equal(xpForKill(5, 5), XP_EXTRA.kill)
    assert.equal(xpForKill(5, 7), 45)
    assert.equal(xpForAssist(5, 5), 12, 'assistência vale 40% do abate')
    assert.ok(xpForAssist(5, 7) < xpForKill(5, 7) && xpForAssist(5, 7) > xpForAssist(5, 5))
    assert.equal(xpForKill(10, 1), 15, 'piso do bônus de abate')
  })

  test('cair de novo para o mesmo atacante só trava dentro da janela (e se repeatFraction < 1)', () => {
    assert.equal(repeatScale(null), 1)
    assert.equal(repeatScale(XP_EXTRA.repeatWindow + 1), 1)
    assert.equal(repeatScale(5), XP_EXTRA.repeatFraction)
  })

  test('o tracker lembra quando cada atacante o abateu', () => {
    const k = new KillTracker()
    assert.equal(k.sinceKoBy('ana', 100), null)
    k.noteHit('ana', 100)
    k.knockedOut(101)
    assert.equal(k.sinceKoBy('ana', 110), 9)
    assert.equal(k.sinceKoBy('beto', 110), null)
  })

  test('cada nível dá mais dano e mais vida', () => {
    assert.equal(damageScale(1), 1)
    assert.equal(maxHealthFor(1), MAX_HEALTH)
    for (let l = 2; l <= MAX_LEVEL; l++) {
      assert.ok(damageScale(l) > damageScale(l - 1))
      assert.ok(maxHealthFor(l) > maxHealthFor(l - 1))
    }
    assert.equal(maxHealthFor(MAX_LEVEL), 1000, 'nível máximo: 1000 de vida')
    assert.equal(damageScale(MAX_LEVEL), 2)
    assert.equal(damageScale(10), 1.75)
    assert.equal(damageScale(20), damageScale(MAX_LEVEL), 'além do teto não ganha mais')
    // Favorece o meio: o ganho por nível sobe até o pico e cai depois
    const gain = (l) => maxHealthFor(l) - maxHealthFor(l - 1)
    assert.ok(gain(8) > gain(2) && gain(8) > gain(MAX_LEVEL), 'meio rende mais que começo e fim')
    assert.equal(scaleDamage(DAMAGE.smash, 1), DAMAGE.smash, 'nível 1 não muda o dano')
    assert.ok(scaleDamage(DAMAGE.light, 20) > DAMAGE.light)
    assert.equal(scaleDamage(0, 20), 0, 'sem dano continua sem dano')
    assert.ok(Number.isInteger(scaleDamage(DAMAGE.strong, 3)), 'dano vai inteiro pela rede')
  })

  test('o dano escalado ainda é validado pela rede e vira a faixa certa no texto', () => {
    const top = scaleDamage(DAMAGE.turbo, MAX_LEVEL)
    assert.ok(validators.hit({ target: 'a', ix: 0, iz: 0, damage: top }), 'cabe no limite do protocolo')
    for (const level of [1, 4, 20]) {
      const scale = damageScale(level)
      assert.equal(tierOfDamage(scaleDamage(DAMAGE.light, level), scale), 'light')
      assert.equal(tierOfDamage(scaleDamage(DAMAGE.strong, level), scale), 'strong')
      assert.equal(tierOfDamage(scaleDamage(DAMAGE.smash, level), scale), 'smash')
    }
  })

  test('subir de nível aumenta a vida máxima e dá a diferença de vida', () => {
    const h = new Health()
    h.damage(40 * HP_SCALE) // 60% da vida
    h.setMax(maxHealthFor(2))
    assert.equal(h.max, maxHealthFor(2))
    assert.equal(h.hp, 60 * HP_SCALE + (maxHealthFor(2) - MAX_HEALTH))
    const missing = h.max - h.hp
    assert.equal(h.heal(1000), missing, 'cura vai até a nova máxima')
    assert.equal(h.hp, h.max)
  })

  test('nocaute volta com a vida cheia do nível; reset volta ao nível 1', () => {
    const h = new Health()
    h.setMax(maxHealthFor(4))
    h.damage(1000)
    assert.ok(h.isKO)
    h.update(KO_TIME + 0.1)
    assert.equal(h.hp, maxHealthFor(4))
    h.reset()
    assert.equal(h.max, MAX_HEALTH)
    assert.equal(h.hp, MAX_HEALTH)
  })

  test('a zona de cura respeita a vida máxima maior', () => {
    const z = new ZoneHealing()
    let hp = 100
    const max = maxHealthFor(3)
    for (let t = 0; t < 8; t += 1 / 60) hp += z.update(1 / 60, hp, max)
    assert.ok(hp > 100 && hp <= max)
  })
})


describe('Bots: cérebro (bots.js)', () => {
  const world = (extra = {}) => ({
    enemies: [], orbs: [], heal: [], obstacles: [],
    halfX: 45, halfZ: 27.5, maxBoosts: 2, maxSpeed: 10, turnSpeed: 2.2, ...extra,
  })
  const enemy = (id, x, z, hp = 100, extra = {}) => ({ id, x, z, vx: 0, vz: 0, hp, maxHp: 100, ...extra })
  const me = (extra = {}) => ({ x: 0, z: 0, yaw: 0, yawRate: 0, speed: 8, hp: 100, maxHp: 100, boosts: 0, boosting: false, ...extra })
  const ult = (extra = {}) => ({ stored: null, ready: false, active: null, storedLeft: 0, ...extra })
  // random fixo: mira sem erro sorteado (0,5 → offset 0)
  const brain = (kind = 'hard') => new BotBrain(kind, () => 0.5)
  // Decide de novo agora (sem esperar o tempo de reação)
  const decide = (b, self, w) => {
    b.thinkTimer = 0
    return b.think(DT, self, w)
  }
  // Simula um carro de verdade dirigido pelo bot
  const selfOf = (car) => {
    const p = car.root.position
    return { x: p.x, z: p.z, yaw: car.yaw, yawRate: car.yawRate, speed: car.velocity.length(), hp: 100, maxHp: 100, boosts: 0, boosting: false }
  }

  test('headingTo segue a frente do carro (sin, cos)', () => {
    assert.ok(Math.abs(headingTo(0, 0, 0, 5)) < 1e-9)
    assert.ok(Math.abs(headingTo(0, 0, 5, 0) - Math.PI / 2) < 1e-9)
  })

  describe('decisão (notas de utilidade)', () => {
    test('briga com o inimigo mais perto; ignora nocauteado e protegido', () => {
      const b = brain()
      decide(b, me(), world({ enemies: [enemy('ko', 0, 3, 100, { ko: true }), enemy('sh', 0, 4, 100, { shield: true }), enemy('far', 0, 30), enemy('near', 0, 10)] }))
      assert.equal(b.targetId, 'near')
      assert.equal(b.mode, 'fight')
    })

    test('fica no alvo atual, a não ser que outro seja bem melhor', () => {
      const b = brain('normal')
      decide(b, me(), world({ enemies: [enemy('a', 0, 10)] }))
      decide(b, me(), world({ enemies: [enemy('a', 0, 10), enemy('b', 0, 8)] }))
      assert.equal(b.targetId, 'a') // 2 m mais perto não basta
      decide(b, me(), world({ enemies: [enemy('a', 0, 10), enemy('b', 0, 2)] }))
      assert.equal(b.targetId, 'b')
    })

    test('prefere alvo com pouca vida (garantir o abate)', () => {
      const b = brain('hard')
      decide(b, me(), world({ enemies: [enemy('full', 0, 10, 100), enemy('low', 0, 14, 10)] }))
      assert.equal(b.targetId, 'low')
    })

    test('pega esfera de boost perto; com o estoque cheio, ignora', () => {
      const w = world({ enemies: [enemy('e', 0, 30)], orbs: [{ x: 3, z: 3 }] })
      const b = brain()
      decide(b, me(), w)
      assert.equal(b.mode, 'orb')
      decide(b, me({ boosts: 2 }), w)
      assert.equal(b.mode, 'fight')
    })

    test('vida baixa: vai curar, para dentro da zona e volta para a briga curado', () => {
      const b = brain('normal')
      const w = world({ enemies: [enemy('e', 0, 5)], heal: [{ x: -15, z: 0, radius: 6 }] })
      const out = decide(b, me({ hp: 20 }), w)
      assert.equal(b.mode, 'heal')
      assert.ok(out.steer < -0.5) // a zona está em -x
      assert.equal(decide(b, me({ x: -15, hp: 20 }), w).throttle, 0)
      decide(b, me({ x: -15, hp: 90 }), w)
      assert.equal(b.mode, 'fight')
    })

    test('a dificuldade muda o quanto a cura vale: o fácil continua brigando', () => {
      const w = world({ enemies: [enemy('e', 0, 8)], heal: [{ x: -10, z: 0, radius: 6 }] })
      const normal = brain('normal')
      decide(normal, me({ hp: 40 }), w)
      assert.equal(normal.mode, 'heal')
      const easy = brain('easy')
      decide(easy, me({ hp: 40 }), w)
      assert.equal(easy.mode, 'fight')
    })

    test('ultimate no centro: larga a briga para pegar', () => {
      const b = brain('normal')
      const w = world({ enemies: [enemy('e', 20, 8)], ult: { phase: 'available', timer: 0 } })
      decide(b, me({ x: 20 }), w)
      assert.equal(b.mode, 'ult')
      decide(b, me({ x: 20, ult: ult({ stored: 'missile' }) }), w)
      assert.equal(b.mode, 'fight') // já tem um guardado: não pega outro
    })

    test('chega no centro antes do ultimate aparecer (posicionamento)', () => {
      const b = brain('normal')
      const soon = world({ enemies: [enemy('e', 20, 8)], ult: { phase: 'warning', timer: 3 } })
      decide(b, me({ x: 20 }), soon)
      assert.equal(b.mode, 'ult')
      const b2 = brain('normal')
      decide(b2, me({ x: 20 }), world({ enemies: [enemy('e', 20, 8)], ult: { phase: 'warning', timer: 9 } }))
      assert.equal(b2.mode, 'fight') // ainda falta muito: briga enquanto isso
    })

    test('foge de quem está com a Sobrecarga ligada', () => {
      const b = brain('normal')
      const out = decide(b, me(), world({ enemies: [enemy('storm', 6, 0, 100, { ult: 'overcharge' })] }))
      assert.equal(b.mode, 'evade')
      assert.ok(out.steer < 0) // o perigo está em +x: vira para -x
    })
  })

  describe('paciência: proporção briga x objetivos', () => {
    test('perseguindo sem acertar, desiste do alvo e vai para outro', () => {
      const b = brain('normal')
      const w = world({ enemies: [enemy('a', 0, 10), enemy('b', -20, 0)] })
      for (let t = 0; t < 1; t += DT) b.think(DT, me(), w)
      assert.equal(b.targetId, 'a')
      for (let t = 0; t < BOT_SKILLS.normal.chaseLimit + 0.5; t += DT) b.think(DT, me(), w)
      assert.equal(b.targetId, 'b')
    })

    test('acertando batidas, a paciência volta e ele continua no alvo', () => {
      const b = brain('normal')
      const w = world({ enemies: [enemy('a', 0, 10), enemy('b', -20, 0)] })
      for (let t = 0; t < BOT_SKILLS.normal.chaseLimit * 2; t += DT) {
        b.think(DT, me(), w)
        if (Math.round(t / DT) % 60 === 0) b.noteHit('a')
      }
      assert.equal(b.targetId, 'a')
    })

    test('stats: tempo em cada modo soma o tempo pensando', () => {
      const b = brain()
      for (let t = 0; t < 2; t += DT) b.think(DT, me(), world({ enemies: [enemy('a', 0, 10)] }))
      const total = Object.values(b.stats).reduce((a, x) => a + x, 0)
      assert.ok(Math.abs(total - 2) < 0.05)
      assert.ok(b.stats.fight > 1.5)
    })
  })

  describe('direção', () => {
    test('vira para o lado do alvo', () => {
      assert.ok(decide(brain(), me(), world({ enemies: [enemy('e', 10, 0)] })).steer > 0.5) // +x: yaw aumenta
      assert.ok(decide(brain(), me(), world({ enemies: [enemy('e', -10, 0)] })).steer < -0.5)
    })

    test('alvo perto e de lado: tira o pé para a curva caber (não orbita)', () => {
      assert.ok(decide(brain(), me({ speed: 9 }), world({ enemies: [enemy('e', 4, 1)] })).throttle <= 0)
      assert.equal(decide(brain(), me({ speed: 9 }), world({ enemies: [enemy('e', 0, 20)] })).throttle, 1)
    })

    test('órbita (alvo sempre de lado, perto): sai reto para abrir distância', () => {
      const b = brain()
      const w = world({ enemies: [enemy('e', 5, 0)] })
      let out
      for (let t = 0; t < 1.4; t += DT) out = b.think(DT, me({ speed: 5 }), w)
      assert.equal(b.mode, 'breakout')
      assert.deepEqual([out.throttle, out.steer], [1, 0])
    })

    test('desvia de um bastão no caminho', () => {
      const w = world({ enemies: [enemy('e', 0, 15)], obstacles: [{ a: [0, 3], b: [0, 3], r: 0.7 }] })
      assert.ok(Math.abs(decide(brain(), me(), w).steer) > 0.3)
      assert.ok(!pathClear(0, 0, 0, 5, w))
      assert.ok(pathClear(0, 0, 0.7, 5, w))
    })

    test('colado no alvo e parado: dá ré para pegar embalo', () => {
      const b = brain()
      const w = world({ enemies: [enemy('e', 0, 2.5)] })
      decide(b, me({ speed: 0.5 }), w)
      assert.equal(b.think(DT, me({ speed: 0.5 }), w).throttle, -1)
    })

    test('preso (acelerando sem sair do lugar): dá ré', () => {
      const b = brain()
      const w = world({ enemies: [enemy('e', 0, 20)] })
      let out
      for (let t = 0; t < 1.2; t += DT) out = b.think(DT, me({ speed: 0 }), w)
      assert.equal(out.throttle, -1)
    })
  })

  describe('boost e ultimate', () => {
    test('boost com o alvo alinhado e no alcance; nunca com ultimate guardado', () => {
      const w = world({ enemies: [enemy('e', 0, 8, 20)] })
      assert.ok(decide(brain('normal'), me({ boosts: 1 }), w).boost)
      assert.ok(!decide(brain('normal'), me({ boosts: 0 }), w).boost)
      assert.ok(!decide(brain('normal'), me({ boosts: 1 }), world({ enemies: [enemy('e', 0, 30)] })).boost) // longe
      assert.ok(!decide(brain('normal'), me({ boosts: 1, yaw: 1 }), w).boost) // fora da mira
      assert.ok(!decide(brain('normal'), me({ boosts: 1, ult: ult({ stored: 'missile' }) }), w).boost)
    })

    test('o difícil guarda o boost para o combo com a mureta', () => {
      assert.ok(!decide(brain('hard'), me({ boosts: 1 }), world({ enemies: [enemy('e', 0, 8)] })).boost)
      assert.ok(decide(brain('hard'), me({ z: 14, boosts: 1 }), world({ enemies: [enemy('e', 0, 22)] })).boost)
    })

    test('Sobrecarga: usa com alguém dentro da tempestade', () => {
      const ready = ult({ stored: 'overcharge', ready: true, storedLeft: 30 })
      assert.ok(decide(brain(), me({ ult: ready }), world({ enemies: [enemy('e', 0, 4)] })).ult)
      assert.ok(!decide(brain(), me({ ult: ready }), world({ enemies: [enemy('e', 0, 20)] })).ult)
    })

    test('Onda de choque e Míssil: só com alguém na mira', () => {
      for (const kind of ['shockwave', 'missile']) {
        const ready = ult({ stored: kind, ready: true, storedLeft: 30 })
        assert.ok(decide(brain(), me({ ult: ready }), world({ enemies: [enemy('e', 0, 12)] })).ult, kind)
        assert.ok(!decide(brain(), me({ ult: ready }), world({ enemies: [enemy('e', 12, 0)] })).ult, kind) // de lado
      }
    })

    test('ultimate em recarga não sai', () => {
      const cooling = ult({ stored: 'overcharge', ready: false, storedLeft: 30 })
      assert.ok(!decide(brain(), me({ ult: cooling }), world({ enemies: [enemy('e', 0, 4)] })).ult)
    })

    test('Míssil em uso: parado, girando para mirar no alvo', () => {
      const out = decide(brain(), me({ ult: ult({ active: 'missile' }) }), world({ enemies: [enemy('e', 10, 0)] }))
      assert.equal(out.throttle, 0)
      assert.ok(out.steer > 0.5)
    })
  })

  describe('dirigindo o carro de verdade', () => {
    test('alcança o alvo que está atrás dele', () => {
      const car = makeCar()
      car.yaw = Math.PI // de costas para o alvo
      car.root.rotation.y = car.yaw
      const w = world({ enemies: [enemy('e', 6, 18)] })
      const b = brain('normal')
      let closest = Infinity
      for (let t = 0; t < 6; t += DT) {
        car.update(DT, b.think(DT, selfOf(car), w))
        closest = Math.min(closest, Math.hypot(car.root.position.x - 6, car.root.position.z - 18))
      }
      assert.ok(closest < 2, `chegou a ${closest.toFixed(1)} m`)
    })

    test('contorna um bastão no meio do caminho sem encostar', () => {
      const car = makeCar()
      const w = world({ enemies: [enemy('e', 0, 20)], obstacles: [{ a: [0, 8], b: [0, 8], r: 0.7 }] })
      const b = brain('hard')
      let closestBat = Infinity
      for (let t = 0; t < 4; t += DT) {
        car.update(DT, b.think(DT, selfOf(car), w))
        closestBat = Math.min(closestBat, Math.hypot(car.root.position.x, car.root.position.z - 8))
      }
      assert.ok(closestBat > 1.2, `passou a ${closestBat.toFixed(2)} m do bastão`)
      assert.ok(car.root.position.z > 12)
    })

    test('alvo dando voltas em círculo perto: o bot encosta nele (não fica orbitando)', () => {
      // O alvo gira num círculo de 4 m de raio a 6 m/s, bem do lado do bot
      const car = makeCar()
      const b = brain('normal')
      const ω = 6 / 4
      let closest = Infinity
      for (let t = 0; t < 8; t += DT) {
        const target = enemy('e', 6 + 4 * Math.cos(ω * t), 4 * Math.sin(ω * t), 100, { vx: -6 * Math.sin(ω * t), vz: 6 * Math.cos(ω * t) })
        car.update(DT, b.think(DT, selfOf(car), world({ enemies: [target] })))
        if (t > 1) closest = Math.min(closest, Math.hypot(car.root.position.x - target.x, car.root.position.z - target.z))
      }
      assert.ok(closest < 2.2, `chegou a ${closest.toFixed(2)} m`)
    })

    test('dois bots perseguindo um ao outro se encontram (não giram em círculo)', () => {
      const a = makeCar(), c = makeCar()
      c.root.position.set(5, 0, 3)
      c.yaw = Math.PI / 2
      c.root.rotation.y = c.yaw
      const ba = brain('normal'), bc = brain('normal')
      let contacts = 0
      for (let t = 0; t < 10; t += DT) {
        const pa = a.root.position, pc = c.root.position
        const ea = enemy('c', pc.x, pc.z, 100, { vx: c.velocity.x, vz: c.velocity.z })
        const ec = enemy('a', pa.x, pa.z, 100, { vx: a.velocity.x, vz: a.velocity.z })
        a.update(DT, ba.think(DT, selfOf(a), world({ enemies: [ea] })))
        c.update(DT, bc.think(DT, selfOf(c), world({ enemies: [ec] })))
        // Batida: separa e troca o empurrão (como no jogo), conta o contato
        const hit = testCars(a.root.position, a.yaw, c.root.position, c.yaw, footprint)
        if (!hit) continue
        a.separate(hit.normal, hit.depth / 2)
        c.separate(hit.normal.clone().negate(), hit.depth / 2)
        const impulse = a.collisionImpulse(hit.normal, c.velocity)
        if (impulse <= 0) continue
        contacts++
        a.applyImpulse(hit.normal.clone().multiplyScalar(impulse))
        c.applyImpulse(hit.normal.clone().multiplyScalar(-impulse))
      }
      assert.ok(contacts >= 3, `${contacts} batidas em 10 s`)
    })
  })
})

describe('Batida de frente: o mesmo dano para os dois', () => {
  // Simula os dois lados: A (menor id) e B (maior id), cada um com o seu registro
  const pair = () => ({ a: new RamLedger(), b: new RamLedger() })
  const hit = (damage, mutual = false) => ({ damage, mutual })
  const A = { iAmLower: true }, B = { iAmLower: false }

  test('os dois acham que é empate: o dano do menor id vale para os dois', () => {
    const { a, b } = pair()
    const sent = a.sending('B', 10, 1, { tie: true })
    assert.deepEqual(sent, { damage: 10, mutual: true, selfApply: true })
    assert.equal(b.noteTie('A', 1), null)
    assert.deepEqual(b.received('A', hit(10, true), 1.1, B), { apply: 10, echo: null })
  })

  test('menor id acha que bateu e o maior id acha empate: o maior devolve o eco', () => {
    const { a, b } = pair()
    assert.deepEqual(a.sending('B', 15, 1, { tie: false }), { damage: 15, mutual: false, selfApply: false })
    assert.equal(b.noteTie('A', 1), null) // ainda não chegou
    assert.deepEqual(b.received('A', hit(15), 1.1, B), { apply: 15, echo: 15 })
    assert.deepEqual(a.received('B', hit(15, true), 1.2, A), { apply: 15, echo: null }, 'o menor id leva o mesmo')
  })

  test('mesma coisa se a batida chega antes de o maior id perceber o empate', () => {
    const { a, b } = pair()
    a.sending('B', 15, 1, { tie: false })
    assert.deepEqual(b.received('A', hit(15), 1.1, B), { apply: 15, echo: null })
    assert.equal(b.noteTie('A', 1.2), 15, 'eco assim que percebe o empate')
    assert.equal(b.noteTie('A', 1.3), null, 'só uma vez')
  })

  test('os dois acham que bateram: vale o dano do menor id para os dois', () => {
    const { a, b } = pair()
    a.sending('B', 15, 1, { tie: false })
    assert.deepEqual(a.received('B', hit(10), 1.1, A), { apply: 15, echo: null }, 'ignora o dano dele e leva o meu')
    assert.deepEqual(a.received('B', hit(10), 1.2, A), { apply: 0, echo: null }, 'só uma vez')
    assert.deepEqual(b.received('A', hit(15), 1.1, B), { apply: 15, echo: null }, 'o maior id leva o dano do menor')
  })

  test('o maior id bateu primeiro (chega antes): o menor repete o dano dele', () => {
    const { a } = pair()
    assert.deepEqual(a.received('B', hit(10), 1, A), { apply: 10, echo: null })
    assert.deepEqual(a.sending('B', 15, 1.1, { tie: false }), { damage: 10, mutual: true, selfApply: false })
  })

  test('batida só de um lado continua só de um lado; a janela expira', () => {
    const { a, b } = pair()
    assert.deepEqual(b.received('A', hit(15), 1, B), { apply: 15, echo: null })
    assert.deepEqual(a.received('B', hit(10), 1, A), { apply: 10, echo: null })
    const late = new RamLedger()
    late.sending('B', 15, 1, { tie: false })
    assert.deepEqual(late.received('B', hit(10), 5, A), { apply: 10, echo: null }, 'outra batida, bem depois')
  })
})

describe('Estatísticas de fim de partida (matchStats.js)', () => {
  const ranked = [
    { id: 'a', name: 'Ana', kills: 6, assists: 2, deaths: 2 },
    { id: 'b', name: 'Bo, "B"', kills: 1, assists: 0, deaths: 0 },
  ]

  test('KDA e taxas por minuto', () => {
    assert.equal(kda(6, 2, 2), 4)
    assert.equal(kda(1, 0, 0), 1, 'sem mortes não divide por zero')
    const [a] = buildStats(ranked, { seconds: 600, levelOf: () => 3 })
    assert.equal(a.kda, 4)
    assert.equal(a.killsPerMin, 0.6)
    assert.equal(a.deathsPerMin, 0.2)
    assert.equal(a.level, 3)
  })

  test('relatório: totais e balanceamento anexado', () => {
    const r = buildReport(buildStats(ranked, { seconds: 600 }), { seconds: 600, balance: { x: 1 } })
    assert.equal(r.totals.deaths, 2)
    assert.equal(r.totals.deathsPerMin, 0.2)
    assert.equal(r.totals.avgSecondsBetweenDeaths, 300)
    assert.deepEqual(r.balance, { x: 1 })
    assert.equal(r.players.length, 2)
  })

  test('tempo em cada nível; quem sai para de contar', () => {
    const t = new LevelTimer()
    t.update('a', 1, 0)
    t.update('a', 1, 40)
    t.update('a', 2, 50)
    t.update('a', 3, 80)
    t.update('a', 3, 100)
    assert.deepEqual(t.timesOf('a'), { 1: 50, 2: 30, 3: 20 })
    t.update('b', 1, 0)
    t.update('b', 1, 30) // saiu aqui
    assert.deepEqual(t.timesOf('b'), { 1: 30 })
    assert.deepEqual(t.timesOf('ninguem'), {})
    t.reset()
    assert.deepEqual(t.timesOf('a'), {})
  })

  test('XP ganho minuto a minuto', () => {
    const x = new XpTimeline()
    x.update('a', 0, 0)
    x.update('a', 50, 59)
    x.update('a', 80, 61) // virou o minuto: o 1º fecha com 50
    x.update('a', 200, 125) // pulou para o 3º minuto: o 2º fecha com 80
    assert.deepEqual(x.perMinute('a'), [50, 30, 120])
    assert.deepEqual(x.perMinute('ninguem'), [])
    x.reset()
    assert.deepEqual(x.perMinute('a'), [])
  })

  test('dano causado e recebido por nível entra no relatório, com vida e dano de cada batida', () => {
    const [a] = buildStats(ranked, {
      seconds: 600,
      levelOf: () => 2,
      xpOf: () => 300,
      levelTimesOf: () => ({ 1: 60, 2: 120 }),
      xpByMinuteOf: () => [100, 200],
      dealtOf: () => ({ 1: 40, 2: 100 }),
      takenOf: () => ({ 2: 70 }),
      hpAt: (l) => 500 + l,
      hitDamageAt: (l) => ({ light: 25 * l }),
    })
    assert.equal(a.xpPerMin, 30)
    assert.deepEqual(a.xpByMinute, [100, 200])
    assert.equal(a.damageDealt, 140)
    assert.equal(a.damageTaken, 70)
    assert.deepEqual(a.levels, {
      1: { seconds: 60, maxHp: 501, hitDamage: { light: 25 }, damageDealt: 40, damageTaken: 0 },
      2: { seconds: 120, maxHp: 502, hitDamage: { light: 50 }, damageDealt: 100, damageTaken: 70 },
    })
  })

  test('KillTracker guarda o dano por nível; a soma de todos dá o causado por jogador', () => {
    const a = new KillTracker(), b = new KillTracker()
    a.noteDealt('b', 3, 40)
    a.noteDealt('b', 3, 10)
    a.noteDealt('b', 4, 5)
    a.noteDealt(null, 1, 99) // parede: sem autor
    a.noteTaken(2, 50)
    a.noteTaken(2, 0)
    b.noteDealt('b', 3, 7)
    assert.deepEqual(a.dmgTaken, { 2: 50 })
    assert.deepEqual(a.dmgBy, { b: { 3: 50, 4: 5 } })
    assert.deepEqual(tallyDealtByLevel([a, b]).get('b'), { 3: 57, 4: 5 })
    a.reset()
    assert.deepEqual(a.dmgBy, {})
    assert.deepEqual(a.dmgTaken, {})
  })
})
