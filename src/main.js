import * as THREE from 'three'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import { toonify, toonGlobals, createToonMaterial } from './toon.js'
import { ScreenOutline } from './outline.js'
import { Background, Sun, Arena } from './environment.js'
import { GroupCamera } from './groupCamera.js'
import { ControlPanel } from './panel.js'
import { ScoreUI, PlayerHud } from './hud.js'
import { FixedStepLoop } from './loop.js'
import { Car } from './car.js'
import { readDriveInput, isDown, wasPressed } from './input.js'
import { joinArena } from './net.js'
import { RemotePlayers } from './remotePlayers.js'
import { measureFootprint, testCars, testArenaWalls } from './collision.js'
import { Orbs } from './orbs.js'
import { SparkEffects, findPoleTip } from './sparks.js'
import { pickLivery, readColors, swatch, setBoostGlow } from './paint.js'
import {
  judgeHit, impactDamage, MIN_IMPULSE, HitCooldown, Health,
  BOOST_HIT_DAMAGE, BOOST_PUSH, WALL_DAMAGE, WALL_DAMAGE_WINDOW, WALL_DAMAGE_MIN_SPEED,
} from './damage.js'

// Ponto de entrada: monta as peças (cena, câmera, painel, rede) e contém as
// regras da partida (batidas, boost, vida). Cada sistema vive no seu módulo.

const MODEL_URL = `${import.meta.env.BASE_URL}models/BumpyCar.glb`
// Valores do painel salvos pelo botão "Salvar configurações"
const SETTINGS_URL = `${import.meta.env.BASE_URL}settings.json`
// Sala vem da URL (?sala=nome); quem abrir o mesmo link cai na mesma arena
const ROOM_ID = new URLSearchParams(location.search).get('sala') || 'arena'
const ARENA_SIZE = 100
const NET_SEND_INTERVAL = 1 / 20 // estados por segundo para os outros jogadores
const MAX_BOOSTS = 3
const SPAWN_RADIUS = 5        // nascimento ao entrar, perto do centro
const RESPAWN_MARGIN = 10     // volta do nocaute em qualquer ponto da arena, longe da borda
const NO_INPUT = { throttle: 0, steer: 0 }

// Os IDs de material do glTF são agrupados em poucos materiais toon; cada
// grupo vira uma cor no painel. null = peças sem material no arquivo. IDs que
// não estiverem em nenhum grupo caem no primeiro. Os dois primeiros grupos
// são a carroceria, pintada pela livery de cada jogador.
const MATERIAL_GROUPS = [
  { name: 'Carroceria (principal)', color: '#2fd3b4', glossiness: 8, ids: [3] },
  { name: 'Carroceria (secundária)', color: '#f4f1e8', glossiness: 8, ids: [2, 12] },
  { name: 'Metal e detalhes', color: '#b8b8c0', glossiness: 10, ids: [0, 4, 6, 7, 8, 14, null] },
  { name: 'Borracha e assento', color: '#2a2a30', glossiness: 0, ids: [1, 5, 9, 10, 11, 13] },
]

const savedSettings = fetch(SETTINGS_URL, { cache: 'no-store' })
  .then((r) => (r.ok ? r.json() : null))
  .catch(() => null)

// --- Renderer, cena, câmera -------------------------------------------------
const renderer = new THREE.WebGLRenderer({ canvas: document.getElementById('scene'), antialias: true })
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
renderer.setSize(window.innerWidth, window.innerHeight)
renderer.toneMapping = THREE.NoToneMapping // ACES dessatura e "achata" as faixas do toon
renderer.shadowMap.enabled = true
renderer.shadowMap.type = THREE.PCFShadowMap

const scene = new THREE.Scene()
const camera = new THREE.PerspectiveCamera(35, window.innerWidth / window.innerHeight, 0.1, 300)
const outline = new ScreenOutline(renderer, scene, camera)
toonGlobals.uPixelRatio.value = renderer.getPixelRatio()

const background = new Background(scene)
const sun = new Sun(scene)
const arena = new Arena(scene, renderer, ARENA_SIZE)
const groupCamera = new GroupCamera(camera)
const scoreUI = new ScoreUI()
const playerHud = new PlayerHud(MAX_BOOSTS)
const orbs = new Orbs(scene, { roomId: ROOM_ID, count: 8, half: arena.half - 6 })
const sparks = new SparkEffects(scene)
sparks.setSize(window.innerWidth, window.innerHeight, renderer.getPixelRatio())
outline.skipInNormalPass.push(...sparks.meshes)
const panel = new ControlPanel({ background, sun, arena, camera: groupCamera, sparks, onRerollLivery: rerollLivery })
const netStatus = document.getElementById('net-status')

// --- Estado da partida ---------------------------------------------------------
const carMaterials = MATERIAL_GROUPS.map(({ name, color, glossiness }) => ({
  name,
  material: createToonMaterial({ color, glossiness, side: THREE.DoubleSide }),
}))
const bodyMaterials = carMaterials.slice(0, 2).map((m) => m.material) // carroceria pintável

let car = null          // meu carrinho (Car)
let footprint = null    // cápsula de colisão, igual para todos os carrinhos
let poleTip = null      // ponta da haste (onde saem as faíscas), em coordenadas do body
let remotes = null      // RemotePlayers
let net = null          // conexão com a sala
let livery = null       // minha pintura
const health = new Health() // minha vida (cada jogador é dono da própria)
let boosts = 0
let glowing = false     // brilho do boost aplicado nos materiais (dirty flag)
let netTimer = 0
// Levei uma batida com boost há pouco: se bater na parede até `until`,
// perco mais vida
let boostedUntil = 0
const hitCooldown = new HitCooldown()
// Batidas que EU anunciei como agressor (para não aplicar o empurrão do outro
// por cima, quando os dois se acharam agressores da mesma batida)
const hitsSent = new HitCooldown()
const tmpImpulse = new THREE.Vector3()

// --- Carregamento do carro -----------------------------------------------------
new GLTFLoader().loadAsync(MODEL_URL).then(
  (gltf) => {
    const model = gltf.scene
    toonify(model, (source) => {
      const id = gltf.parser.associations.get(source)?.materials ?? null
      const group = Math.max(0, MATERIAL_GROUPS.findIndex((g) => g.ids.includes(id)))
      return carMaterials[group].material
    })

    // Centraliza no plano XZ e apoia as rodas no chão (y = 0)
    const box = new THREE.Box3().setFromObject(model)
    const center = box.getCenter(new THREE.Vector3())
    model.position.set(-center.x, -box.min.y, -center.z)

    remotes = new RemotePlayers(scene, model.clone(true), bodyMaterials)
    car = new Car(model)
    // Cápsula de colisão: contorno do carro visto de cima, com ele na origem
    car.root.updateMatrixWorld(true)
    footprint = measureFootprint(model)
    poleTip = findPoleTip(model, car.body)
    // Nasce num ponto aleatório perto do centro (jogadores não nascem juntos)
    const angle = Math.random() * Math.PI * 2
    car.spawn.set(Math.cos(angle) * SPAWN_RADIUS, 0, Math.sin(angle) * SPAWN_RADIUS)
    car.reset()
    scene.add(car.root)

    panel.addCarControls(car.params)
    panel.addMaterialControls(carMaterials)
    startMultiplayer()
    // Só agora todos os controles existem; aplica os valores salvos e depois
    // sorteia a pintura (senão o arquivo salvo sobrescreveria as cores)
    savedSettings.then((settings) => {
      if (settings) panel.load(settings)
      applyLivery(pickLivery())
    })
  },
  (err) => console.error('Erro ao carregar o modelo:', err)
)

// --- Pintura -----------------------------------------------------------------------
function applyLivery(next) {
  livery = next
  bodyMaterials[0].uniforms.uColor.value.set(next.primary)
  bodyMaterials[1].uniforms.uColor.value.set(next.secondary)
  panel.showLivery(next.name)
}

function rerollLivery() {
  // Evita repetir a pintura atual e as dos outros jogadores da sala
  applyLivery(pickLivery([livery?.name, ...(remotes?.liveries() ?? [])]))
}

// --- Rede ----------------------------------------------------------------------------
function setNetStatus(peerCount) {
  const players = peerCount + 1
  netStatus.textContent = `Sala "${ROOM_ID}" · ${players} ${players === 1 ? 'jogador' : 'jogadores'}`
}

// Fui atingido: o empurrão e o dano calculados por quem bateu valem para mim.
// O empurrão só é ignorado se eu também anunciei essa batida como agressor
// (os dois se acharam agressores): aí já apliquei o meu ricochete. O dano
// vale sempre.
function receiveHit(hit, attackerId) {
  const now = loop.simTime
  if (!hitsSent.recent(attackerId, now)) {
    hitCooldown.ready(attackerId, now)
    car.applyImpulse(new THREE.Vector3(hit.ix, 0, hit.iz))
  }
  if (hit.boosted) boostedUntil = now + WALL_DAMAGE_WINDOW
  takeDamage(hit.damage)
}

function takeDamage(amount) {
  const { knockedOut } = health.damage(amount)
  if (knockedOut) {
    scoreUI.popup(car.root.position, 'ko')
    car.endBoost()
  }
}

// Volta do nocaute num ponto aleatório da arena, com a vida cheia
function respawn() {
  const range = arena.half - RESPAWN_MARGIN
  car.spawn.set((Math.random() * 2 - 1) * range, 0, (Math.random() * 2 - 1) * range)
  car.reset()
}

function positionOf(peerId) {
  return peerId === net.selfId ? car.root.position : remotes.get(peerId)?.car.root.position
}

function startMultiplayer() {
  setNetStatus(0)
  // Tudo que chega aqui já foi validado (protocol.js)
  net = joinArena(ROOM_ID, {
    onPeersChange: setNetStatus,
    // Quem chega recebe onde estão as esferas
    onPeerJoin: (peerId) => net.sendOrbs(orbs.snapshot(), peerId),
    onOrbs: (snapshot) => orbs.merge(snapshot),
    onPickup: ({ slot, gen }) => orbs.take(slot, gen),
    onPeerLeave: (peerId) => remotes.remove(peerId),
    onPeerState(peerId, state) {
      const { player, liveryChanged, knockedOut } = remotes.applyState(peerId, state, performance.now() / 1000)
      if (knockedOut) scoreUI.popup(player.car.position, 'ko')
      // Mesma pintura que a minha: um dos dois sorteia de novo (o de ID menor
      // mantém, para os dois não trocarem ao mesmo tempo)
      if (liveryChanged && state.livery === livery?.name && net.selfId > peerId) rerollLivery()
    },
    onHit(hit, attackerId) {
      // O dano aparece em cima de quem levou a batida, para todo mundo ver
      const position = positionOf(hit.target)
      if (hit.damage && position) scoreUI.popup(position, hit.boosted ? 'turbo' : hit.damage)
      if (hit.target === net.selfId) receiveHit(hit, attackerId)
    },
    // Alguém bateu na parede depois de levar um boost (o dano já foi
    // descontado por ele; aqui é só para mostrar)
    onWall(wall, peerId) {
      const position = positionOf(peerId)
      if (wall.damage && position) scoreUI.popup(position, 'wall')
    },
  })

  // Só no `npm run dev`: acesso pelo console do navegador para depuração
  if (import.meta.env.DEV) window.__game = { net, get car() { return car }, health, remotes, orbs, loop, sparks, camera }
}

// --- Regras da partida (rodam no passo fixo) -------------------------------------
function updateBoost() {
  // Pegar esfera (com o inventário cheio, passa direto e ela fica lá)
  if (boosts < MAX_BOOSTS) {
    const slot = orbs.findPickup(car.root.position)
    if (slot) {
      const gen = slot.gen
      orbs.take(slot.index, gen)
      boosts++
      net?.sendPickup({ slot: slot.index, gen })
      scoreUI.popup(car.root.position, 'pickup')
    }
  }
  // Usar boost
  if (wasPressed('Space') && boosts > 0 && !car.isBoosting) {
    boosts--
    car.boost()
  }
  // Brilho: só mexe nos materiais quando liga/desliga
  if (car.isBoosting !== glowing) {
    glowing = car.isBoosting
    setBoostGlow(bodyMaterials, glowing)
  }
}

// Paredes da arena: ricochete; se eu levei uma batida com boost há pouco e
// fui parar na parede, perco mais vida
function collideWalls(simTime) {
  for (const { normal, depth } of testArenaWalls(car.root.position, car.yaw, footprint, arena.half)) {
    const wallSpeed = car.hitWall(normal, depth)
    if (simTime < boostedUntil && wallSpeed >= WALL_DAMAGE_MIN_SPEED) {
      boostedUntil = 0
      net?.sendWall({ damage: WALL_DAMAGE })
      scoreUI.popup(car.root.position, 'wall')
      takeDamage(WALL_DAMAGE)
    }
  }
}

// Batidas contra os outros. Cada jogador resolve só o próprio carrinho; quem
// bateu aplica o próprio ricochete e manda o empurrão e o dano da vítima (a
// vítima espera essa mensagem). Empate (ex.: de frente): cada um aplica só o
// próprio ricochete e ninguém leva dano. Nocauteado não causa dano.
function collideCars(simTime, wallTime) {
  for (const [peerId, { car: remote }] of remotes.entries()) {
    if (!remote.hasState) continue
    remote.sample(wallTime)
    const hit = testCars(car.root.position, car.yaw, remote.root.position, remote.yaw, footprint)
    if (!hit) continue
    car.separate(hit.normal, hit.depth)

    const judged = judgeHit(hit.normal, car.velocity, remote.velocity)
    if (judged.role === 'victim') continue
    const impulse = car.collisionImpulse(hit.normal, remote.velocity)
    if (impulse < MIN_IMPULSE || !hitCooldown.ready(peerId, simTime)) continue

    // Com boost: tira mais, arremessa mais longe e o boost acaba na batida
    const boosted = car.isBoosting
    car.applyImpulse(tmpImpulse.copy(hit.normal).multiplyScalar(impulse))
    if (judged.role === 'tie' && !boosted) continue
    // Sem dano se eu estou nocauteado ou se o outro está fora/protegido
    const target = remotes.get(peerId)
    const immune = health.isKO || target.ko || target.shield
    const damage = immune ? 0 : boosted ? BOOST_HIT_DAMAGE : impactDamage(judged.impact)
    const push = impulse * (boosted ? BOOST_PUSH : 1) // a vítima vai no sentido oposto
    net.sendHit({ target: peerId, ix: -hit.normal.x * push, iz: -hit.normal.z * push, damage, boosted })
    hitsSent.ready(peerId, simTime)
    if (boosted) car.endBoost()
    if (damage) scoreUI.popup(remote.root.position, boosted ? 'turbo' : damage)
  }
}

function sendState(dt, simTime) {
  netTimer += dt
  if (netTimer < NET_SEND_INTERVAL) return
  netTimer %= NET_SEND_INTERVAL
  net.sendState({
    ...car.getNetState(),
    t: simTime,
    colors: readColors(bodyMaterials),
    livery: livery?.name,
    hp: health.hp,
    ko: health.isKO,
    shield: health.isShielded,
  })
}

// --- Loop -------------------------------------------------------------------------
// Passo fixo para tudo que muda o estado do jogo; desenho separado (loop.js)
const loop = new FixedStepLoop({
  step(dt, simTime, wallTime) {
    orbs.update(dt)
    if (!car) return
    car.savePrevious()
    if (health.update(dt)) respawn()
    if (isDown('KeyR') && !health.isKO) car.reset()
    if (!health.isKO) updateBoost()
    // Nocauteado não dirige, mas ainda pode ser empurrado
    car.update(dt, health.isKO ? NO_INPUT : readDriveInput())
    collideWalls(simTime)
    if (net) {
      collideCars(simTime, wallTime)
      sendState(dt, simTime)
    }
  },

  render(dt, wallTime, alpha) {
    remotes?.sample(wallTime)
    car?.beginRender(alpha) // pose interpolada entre os dois últimos passos
    groupCamera.update(dt, cameraSubjects())
    if (car) sparks.update(dt, sparkEmitters())
    sun.follow(groupCamera.center, Math.max(12, groupCamera.distance * 0.55))
    scoreUI.update(dt, camera) // depois da câmera: "+N" no lugar certo deste quadro
    if (car) {
      playerHud.render({
        hp: health.hp,
        ko: health.isKO,
        shielded: health.isShielded,
        koTimer: health.koTimer,
        boosts,
        boosting: car.isBoosting,
      })
      renderScoreboard(dt)
    }
    outline.render()
    car?.endRender()
  },
})
loop.start()

// Carros que a câmera precisa enquadrar (lista reaproveitada a cada quadro)
const subjects = []
function cameraSubjects() {
  subjects.length = 0
  if (car) subjects.push(car)
  if (remotes) for (const { car: remote } of remotes.values()) if (remote.hasState) subjects.push(remote)
  return subjects
}

// Haste de cada carro soltando faíscas conforme a velocidade (objetos
// reaproveitados a cada quadro)
const emitters = []
const emitterPool = []
function sparkEmitters() {
  emitters.length = 0
  const add = (body, velocity, boosting) => {
    const e = (emitterPool[emitters.length] ??= {})
    e.tip = poleTip
    e.body = body
    e.velocity = velocity
    // 0 parado, 1 na velocidade máxima; o boost passa disso
    e.power = velocity.length() / car.params.maxSpeed + (boosting ? 0.5 : 0)
    emitters.push(e)
  }
  add(car.body, car.velocity, car.isBoosting)
  for (const { car: remote, boosting } of remotes.values()) {
    if (remote.hasState) add(remote.body, remote.velocity, boosting)
  }
  return emitters
}

let scoreboardTimer = 0
function renderScoreboard(dt) {
  scoreboardTimer += dt
  if (scoreboardTimer < 0.25) return // 4x por segundo basta
  scoreboardTimer = 0
  const players = [{ name: 'Você', color: swatch(readColors(bodyMaterials)), hp: health.hp, ko: health.isKO, isMe: true }]
  for (const [peerId, player] of remotes.entries()) {
    players.push({
      name: `Jogador ${peerId.slice(0, 4).toUpperCase()}`,
      color: swatch(remotes.colors(player)),
      hp: player.hp,
      ko: player.ko,
      isMe: false,
    })
  }
  scoreUI.render(players)
}

// --- Resize -----------------------------------------------------------------------
window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight
  camera.updateProjectionMatrix()
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
  renderer.setSize(window.innerWidth, window.innerHeight)
  outline.setSize()
  background.redraw()
  toonGlobals.uPixelRatio.value = renderer.getPixelRatio()
  sparks.setSize(window.innerWidth, window.innerHeight, renderer.getPixelRatio())
})
