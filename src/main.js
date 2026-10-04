import * as THREE from 'three'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import Stats from 'three/examples/jsm/libs/stats.module.js'
import { toonify, toonGlobals, createToonMaterial } from './toon.js'
import { ScreenOutline } from './outline.js'
import { Background, Sun, Arena } from './environment.js'
import { GroupCamera } from './groupCamera.js'
import { ControlPanel } from './panel.js'
import { ScoreUI, PlayerHud, CarTags } from './hud.js'
import { FixedStepLoop } from './loop.js'
import { Car } from './car.js'
import { readDriveInput, isDown, wasPressed } from './input.js'
import { joinArena } from './net.js'
import { RemotePlayers } from './remotePlayers.js'
import { measureFootprint, testCars, testArenaWalls } from './collision.js'
import { Orbs } from './orbs.js'
import { SparkEffects, findPoleTip } from './sparks.js'
import { SpikedBats, extractProp, placeBats } from './bats.js'
import { TireWalls, placeTireWalls, prepareTireWall } from './tireWalls.js'
import { spawnPoints, cornerPoints, cornerIndex, chooseRespawn, yawToCenter } from './spawns.js'
import { distanceToSegment } from './collision.js'
import { newLayout, shouldAdopt } from './layout.js'
import { Presence } from './presence.js'
import { MenuUI } from './menu.js'
import { newRoomCode, normalizeCode, hostOf } from './lobby.js'
import { pickLivery, readColors, swatch, setBoostGlow, MATERIAL_GROUPS, DEFAULT_GROUP, materialGroup } from './paint.js'
import {
  judgeHit, impactTier, tierOfDamage, DAMAGE, MIN_IMPULSE, HitCooldown, Health,
  BOOST_PUSH, WALL_DAMAGE, WALL_DAMAGE_WINDOW, WALL_DAMAGE_MIN_SPEED, SPIKE_MIN_SPEED,
} from './damage.js'

// Ponto de entrada: monta as peças (cena, câmera, painel, rede) e contém as
// regras da partida (batidas, boost, vida). Cada sistema vive no seu módulo.

const MODEL_URL = `${import.meta.env.BASE_URL}models/BumpyCar.glb`
// Valores do painel salvos pelo botão "Salvar configurações"
const SETTINGS_URL = `${import.meta.env.BASE_URL}settings.json`
// Link de convite: ?sala=CÓDIGO abre o menu já com o código da sala
const INVITE_CODE = normalizeCode(new URLSearchParams(location.search).get('sala'))
const COUNTDOWN = 3 // s de "3, 2, 1" antes de liberar os carros
const GO_SHOW_TIME = 0.8 // s que o "JÁ!" fica na tela
// Arena retangular: lado maior em X (horizontal na tela, combina com a câmera)
const ARENA_WIDTH = 90  // m em X
const ARENA_DEPTH = 55  // m em Z
const NET_SEND_INTERVAL = 1 / 20 // estados por segundo para os outros jogadores
const MAX_BOOSTS = 2 // estoque de boosts (turbo é forte: precisa ser raro)
// Bastões com espinhos
const BAT_URL = `${import.meta.env.BASE_URL}models/Bastao.glb`
const BAT_COUNT = 5
const BAT_RADIUS = 0.7   // m: corpo + boa parte dos espinhos
const BAT_BOUNCE = 1     // ricochete do carro no bastão (espinho repele forte)
const BAT_KEEP_CLEAR = 12 // m livres no centro, onde os carros nascem
const BAT_SPACING = 12   // m mínimos entre bastões
// Paredes de pneus (obstáculos retos, girados em múltiplos de 90°)
const TIRE_URL = `${import.meta.env.BASE_URL}models/TireWall.glb`
const TIRE_COUNT = 6
const TIRE_HALF_LENGTH = 2.9 // m: metade do comprimento do modelo (5,76 m), fixo para o sorteio ser igual em todos
const TIRE_KEEP_CLEAR = 10   // m livres no centro
const TIRE_FROM_BATS = 8     // m de qualquer bastão (as esferas nascem em volta deles)
const TIRE_SPACING = 7       // m entre paredes: sempre dá para passar entre elas
const TIRE_COLOR = '#2b2b30' // borracha
const ORB_COUNT = 5
const ORB_NEAR_BAT = [2.5, 5.5] // m do centro do bastão: perto, mas fora dos espinhos
// Pontos de nascimento (spawns.js): cantos no início, os mais vazios depois
const SPAWN_INSET_X = 6       // m dos cantos até a mureta
const SPAWN_INSET_Z = 5
const SPAWN_CLEAR = 7         // m livres em volta dos cantos (bastões e pneus não ficam ali)
const NO_INPUT = { throttle: 0, steer: 0 }

const savedSettings = fetch(SETTINGS_URL, { cache: 'no-store' })
  .then((r) => (r.ok ? r.json() : null))
  .catch(() => null)

// --- Renderer, cena, câmera -------------------------------------------------
const renderer = new THREE.WebGLRenderer({ canvas: document.getElementById('scene'), antialias: true })
// Qualidade (pasta Desempenho no painel). Resolução: em telas de alta
// densidade (notebook com zoom de 150%, 4K) o pós-processamento roda em muito
// mais pixels; limitar a 1,5 alivia bastante com pouca diferença visual.
const quality = {
  maxPixelRatio: 1.5,
  shadowSize: 1024,
  showFps: new URLSearchParams(location.search).has('fps'),
}
renderer.setPixelRatio(Math.min(window.devicePixelRatio, quality.maxPixelRatio))
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
const arena = new Arena(scene, renderer, ARENA_WIDTH, ARENA_DEPTH)
const groupCamera = new GroupCamera(camera)
const scoreUI = new ScoreUI()
const playerHud = new PlayerHud(MAX_BOOSTS)
const carTags = new CarTags() // nome e vida presos a cada carro
// Mapa da partida: posições dos bastões sorteadas por uma semente nova a cada
// partida; ao conectar com outros, a sala adota o mapa mais antigo (layout.js).
// As esferas nascem em volta dos bastões.
let layout = newLayout()
const SPAWN_RANGE_X = arena.halfX - SPAWN_INSET_X
const SPAWN_RANGE_Z = arena.halfZ - SPAWN_INSET_Z
const corners = cornerPoints(SPAWN_RANGE_X, SPAWN_RANGE_Z)
const placeLayoutBats = (seed) => placeBats(seed, BAT_COUNT, arena.halfX - 7, arena.halfZ - 7, BAT_KEEP_CLEAR, BAT_SPACING, corners, SPAWN_CLEAR)
let batSpots = placeLayoutBats(layout.seed)
const placeLayoutTires = (seed, avoid) => placeTireWalls(seed, {
  count: TIRE_COUNT, halfX: arena.halfX - 6, halfZ: arena.halfZ - 6, halfLength: TIRE_HALF_LENGTH,
  keepClear: TIRE_KEEP_CLEAR, avoid: [...avoid, ...corners], avoidDistance: TIRE_FROM_BATS, spacing: TIRE_SPACING,
})
let tireSpots = placeLayoutTires(layout.seed, batSpots)
// Pontos de nascimento deste mapa: só os que não caem em cima de obstáculos
const isFree = (x, z) =>
  batSpots.every((b) => Math.hypot(b.x - x, b.z - z) >= 5) &&
  tireSpots.every((w) => {
    const dx = Math.cos(w.yaw) * TIRE_HALF_LENGTH, dz = -Math.sin(w.yaw) * TIRE_HALF_LENGTH
    return distanceToSegment(x, z, [w.x - dx, w.z - dz], [w.x + dx, w.z + dz]) >= 4
  })
let spawnSpots = spawnPoints(SPAWN_RANGE_X, SPAWN_RANGE_Z, isFree)
const orbs = new Orbs(scene, {
  seed: layout.seed, count: ORB_COUNT, halfX: arena.halfX - 3, halfZ: arena.halfZ - 3,
  anchors: batSpots, anchorRange: ORB_NEAR_BAT,
})

// Troca para o mapa de outro jogador (o dele é mais antigo)
function adoptLayout(next) {
  layout = { seed: next.seed, since: next.since }
  batSpots = placeLayoutBats(layout.seed)
  bats?.setPositions(batSpots)
  tireSpots = placeLayoutTires(layout.seed, batSpots)
  tireWalls?.setWalls(tireSpots)
  spawnSpots = spawnPoints(SPAWN_RANGE_X, SPAWN_RANGE_Z, isFree)
  orbs.relayout(layout.seed, batSpots)
}
const sparks = new SparkEffects(scene)
// Materiais dos bastões (cores no painel)
const batPaint = {
  params: { base: '#e8463c', spikes: '#ffffff' },
  base: createToonMaterial({ color: '#e8463c', glossiness: 4, side: THREE.DoubleSide }),
  spikes: createToonMaterial({ color: '#ffffff', glossiness: 12, side: THREE.DoubleSide }),
  apply() {
    this.base.uniforms.uColor.value.set(this.params.base)
    this.spikes.uniforms.uColor.value.set(this.params.spikes)
  },
}
batPaint.apply = batPaint.apply.bind(batPaint)
let bats = null
// Material das paredes de pneus (cor no painel)
const tirePaint = {
  params: { color: TIRE_COLOR },
  material: createToonMaterial({ color: TIRE_COLOR, glossiness: 0 }), // borracha: sem brilho
  apply() {
    this.material.uniforms.uColor.value.set(this.params.color)
  },
}
tirePaint.apply = tirePaint.apply.bind(tirePaint)
let tireWalls = null
sparks.setSize(window.innerWidth, window.innerHeight, renderer.getPixelRatio())
outline.skipInNormalPass.push(...sparks.meshes)
const panel = new ControlPanel({
  background, sun, arena, camera: groupCamera, sparks, batPaint, tirePaint, quality,
  onQualityChange: applyQuality, onRerollLivery: rerollLivery,
})
const netStatus = document.getElementById('net-status')
// Medidor de FPS: liga no painel (Desempenho) ou com ?fps na URL
const fpsMeter = new Stats()
fpsMeter.dom.style.cssText = 'position:fixed;left:24px;top:auto;bottom:150px;z-index:10;cursor:pointer'
document.body.append(fpsMeter.dom)

// --- Estado da partida ---------------------------------------------------------
const carMaterials = MATERIAL_GROUPS.map(({ name, color, glossiness }) => ({
  name,
  material: createToonMaterial({ color, glossiness, side: THREE.DoubleSide }),
}))
const bodyMaterials = carMaterials.slice(0, 2).map((m) => m.material) // carroceria pintável

// Fases: 'menu' (tela inicial) → 'lobby' (sala de espera) → 'countdown'
// (3, 2, 1) → 'playing'
let phase = 'menu'
let roomCode = ''
let myName = ''
let joinedAt = 0        // quando entrei na sala (ms): decide o anfitrião
const roster = new Map() // peerId -> { name, since, phase } (de cada 'hello')
let countdown = 0       // s restantes da contagem
let goTimer = 0         // s desde o "JÁ!"
let pendingStart = null // partida começou antes do carro terminar de carregar
let deathSpot = null    // onde fui nocauteado (renasço longe dali)
let lastSpawn = null    // onde nasci da última vez (renasço em outro lugar)
const inMatch = () => phase === 'countdown' || phase === 'playing'

let car = null          // meu carrinho (Car)
let footprint = null    // cápsula de colisão, igual para todos os carrinhos
const presence = new Presence() // meu carro some no nocaute e reaparece com "pop"
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
const batCooldown = new HitCooldown() // por bastão: um choque não conta várias vezes
const tmpImpulse = new THREE.Vector3()

// --- Carregamento do carro -----------------------------------------------------
new GLTFLoader().loadAsync(MODEL_URL).then(
  (gltf) => {
    const model = gltf.scene
    toonify(model, (source) => {
      const name = source.name.trim()
      const group = materialGroup(name)
      if (group === -1) console.warn(`Material "${name}" sem grupo; usando "${MATERIAL_GROUPS[DEFAULT_GROUP].name}"`)
      return carMaterials[group === -1 ? DEFAULT_GROUP : group].material
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
    car.reset() // a posição de verdade é escolhida quando a partida começa

    panel.addCarControls(car.params)
    panel.addMaterialControls(carMaterials)
    // O carro só entra na arena quando a partida começa, mas os shaders dele
    // são preparados agora (no menu): senão a primeira imagem da partida
    // trava e o atraso "come" a contagem
    renderer.compile(car.root, camera, scene)
    if (pendingStart) beginMatch(pendingStart.map, pendingStart.late)
    else refreshLobby()
    // Só agora todos os controles existem; aplica os valores salvos e depois
    // sorteia a pintura (senão o arquivo salvo sobrescreveria as cores)
    savedSettings.then((settings) => {
      // Igual ao "Restaurar padrões" + settings.json: ignora qualquer valor
      // que o navegador tenha devolvido para o painel ao reabrir a aba
      panel.restoreGameDefaults(settings)
      applyLivery(pickLivery())
    })
  },
  (err) => console.error('Erro ao carregar o modelo:', err)
)

// --- Bastões --------------------------------------------------------------------------
// O arquivo pode trazer outras coisas da cena; só as peças com material
// "Bastao-..." viram o bastão
new GLTFLoader().loadAsync(BAT_URL).then(
  (gltf) => {
    // Primeiro separa as peças (pelo nome do material original), depois troca
    // os materiais pelos toon (que não têm o nome do Blender)
    const template = extractProp(gltf.scene, 'Bastao')
    toonify(template, (source) => (source.name.startsWith('Bastao-espinhos') ? batPaint.spikes : batPaint.base))
    bats = new SpikedBats(scene, template, { positions: batSpots, radius: BAT_RADIUS })
  },
  (err) => console.error('Erro ao carregar o bastão:', err)
)

// --- Paredes de pneus -----------------------------------------------------------------
new GLTFLoader().loadAsync(TIRE_URL).then(
  (gltf) => {
    toonify(gltf.scene, () => tirePaint.material)
    const { model, radius, segmentHalf } = prepareTireWall(gltf.scene)
    tireWalls = new TireWalls(scene, model, { walls: tireSpots, segmentHalf, radius })
  },
  (err) => console.error('Erro ao carregar a parede de pneus:', err)
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
  netStatus.textContent = `Sala ${roomCode} · ${players} ${players === 1 ? 'jogador' : 'jogadores'}`
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
    deathSpot = { x: car.root.position.x, z: car.root.position.z }
  }
}

// Põe o carro num ponto de nascimento, virado para o centro da arena
function spawnAt(point) {
  lastSpawn = point
  car.spawn.set(point.x, 0, point.z)
  car.spawnYaw = yawToCenter(point.x, point.z)
  car.reset()
}

// Volta do nocaute (vida cheia) no ponto mais vazio, longe de onde morri e
// nunca no mesmo ponto da última vez (spawns.js)
function respawn() {
  const enemies = []
  for (const { car: remote, ko } of remotes.values()) {
    if (remote.hasState && !ko) enemies.push({ x: remote.root.position.x, z: remote.root.position.z })
  }
  const point = chooseRespawn(spawnSpots, { enemies, death: deathSpot, last: lastSpawn })
  if (point) spawnAt(point)
  else car.reset()
}

function positionOf(peerId) {
  return peerId === net.selfId ? car?.root.position : remotes?.get(peerId)?.car.root.position
}

// --- Sala de espera e início da partida ------------------------------------------------
const menu = new MenuUI({
  inviteCode: INVITE_CODE,
  onCreate: (name) => enterRoom(newRoomCode(), name),
  onJoin: (name, code) => enterRoom(code, name),
  onStart: hostStart,
  // Sair: volta para a tela inicial do zero (a conexão fecha junto)
  onLeave: () => location.assign(location.pathname),
})

function enterRoom(code, name) {
  roomCode = code
  myName = name
  joinedAt = Date.now()
  phase = 'lobby'
  // O endereço vira o link de convite (mantém ?painel, ?fps...)
  const params = new URLSearchParams(location.search)
  params.set('sala', code)
  history.replaceState(null, '', `${location.pathname}?${params}`)
  menu.showLobby(code, `${location.origin}${location.pathname}?sala=${code}`)
  startMultiplayer()
  refreshLobby()
}

const hello = () => ({ name: myName, since: joinedAt, phase: inMatch() ? 'playing' : 'lobby' })

function refreshLobby() {
  if (phase !== 'lobby') return
  const members = [{ id: net.selfId, name: myName, since: joinedAt, me: true }]
  for (const [id, r] of roster) members.push({ id, name: r.name || 'Jogador', since: r.since, me: false })
  const host = hostOf(members)
  members.sort((a, b) => a.since - b.since)
  menu.setRoster(members.map((m) => ({ ...m, host: m.id === host })), { isHost: host === net.selfId, ready: !!car })
}

// Anfitrião apertou "Começar": sorteia o mapa e começa para todos
function hostStart() {
  if (phase !== 'lobby' || !car) return
  const map = newLayout()
  net.sendStart(map)
  beginMatch(map)
}

// Começa a partida (aqui e em quem recebeu o 'start'): mapa da partida,
// carro na arena e contagem
// late = entrei com a partida já rolando
function beginMatch(map, late = false) {
  if (!car) {
    pendingStart = { map, late } // ainda carregando o carro: começa assim que terminar
    return
  }
  pendingStart = null
  // Toda partida começa com os controles nos padrões do jogo (código +
  // settings.json); a pintura sorteada continua a mesma
  savedSettings.then((settings) => {
    panel.restoreGameDefaults(settings)
    if (livery) applyLivery(livery)
  })
  adoptLayout(map)
  phase = 'countdown'
  countdown = COUNTDOWN
  goTimer = 0
  menu.close()
  scene.add(car.root)
  deathSpot = null
  lastSpawn = null
  if (late) {
    respawn() // os cantos podem estar ocupados: vai para o lugar mais vazio
  } else {
    const members = [{ id: net.selfId, since: joinedAt }]
    for (const [id, r] of roster) if (r.phase === 'lobby' || r.phase === 'playing') members.push({ id, since: r.since })
    spawnAt(corners[cornerIndex(members, net.selfId)])
  }
  presence.scale = 0 // aparece com "pop"
  net.sendHello(hello()) // agora estou jogando
}

function startMultiplayer() {
  setNetStatus(0)
  // Tudo que chega aqui já foi validado (protocol.js)
  net = joinArena(`batebate-${roomCode}`, {
    onPeersChange: setNetStatus,
    // Quem chega recebe quem eu sou e, se a partida já começou, o mapa dela e
    // onde estão as esferas (e entra direto na partida)
    onPeerJoin(peerId) {
      net.sendHello(hello(), peerId)
      if (inMatch()) net.sendLayout({ ...layout, orbs: orbs.snapshot() }, peerId)
    },
    onHello(info, peerId) {
      roster.set(peerId, info)
      refreshLobby()
    },
    onStart(map) {
      if (phase === 'lobby') beginMatch(map)
    },
    onLayout(theirs) {
      if (phase === 'lobby') {
        // Cheguei com a partida rolando: entro nela
        beginMatch(theirs, true)
      } else if (shouldAdopt(layout, theirs)) {
        adoptLayout(theirs)
      }
      // Mesmo mapa (o meu ou o que acabei de adotar): aplica as esferas dele
      if (theirs.seed === layout.seed) orbs.merge(theirs.orbs)
    },
    onPickup: ({ slot, gen }) => orbs.take(slot, gen),
    // Alguém bateu num bastão: mesmo ricochete aqui, e o dano em cima dele
    onBat(bat, peerId) {
      bats?.kick(bat.index, bat.dx, bat.dz, bat.strength)
      const position = positionOf(peerId)
      if (bat.damage && position) scoreUI.popup(position, 'spike', bat.damage)
    },
    onPeerLeave(peerId) {
      roster.delete(peerId)
      remotes?.remove(peerId)
      refreshLobby() // se o anfitrião saiu, outro assume
    },
    onPeerState(peerId, state) {
      if (!remotes) return // carro ainda carregando
      const { player, liveryChanged, knockedOut } = remotes.applyState(peerId, state, performance.now() / 1000)
      if (knockedOut) scoreUI.popup(player.car.position, 'ko')
      // Mesma pintura que a minha: um dos dois sorteia de novo (o de ID menor
      // mantém, para os dois não trocarem ao mesmo tempo)
      if (liveryChanged && state.livery === livery?.name && net.selfId > peerId) rerollLivery()
    },
    onHit(hit, attackerId) {
      // O dano aparece em cima de quem levou a batida, para todo mundo ver
      const position = positionOf(hit.target)
      if (hit.damage && position) scoreUI.popup(position, hit.boosted ? 'turbo' : tierOfDamage(hit.damage), hit.damage)
      if (hit.target === net.selfId && inMatch()) receiveHit(hit, attackerId)
    },
    // Alguém bateu na parede depois de levar um boost (o dano já foi
    // descontado por ele; aqui é só para mostrar)
    onWall(wall, peerId) {
      const position = positionOf(peerId)
      if (wall.damage && position) scoreUI.popup(position, 'wall', wall.damage)
    },
  })

  // Só no `npm run dev`: acesso pelo console do navegador para depuração
  if (import.meta.env.DEV) window.__game = { net, get car() { return car }, get bats() { return bats }, get tireWalls() { return tireWalls }, health, get remotes() { return remotes }, orbs, loop, sparks, camera, renderer, outline, scene, menu, roster, toonGlobals, get phase() { return phase } }
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
  for (const { normal, depth } of testArenaWalls(car.root.position, car.yaw, footprint, arena.halfX, arena.halfZ)) {
    hitWall(normal, depth, simTime)
  }
  // Paredes de pneus: mesmo ricochete (sumido no nocaute, atravessa)
  if (tireWalls && !health.isKO) {
    for (const { normal, depth } of tireWalls.testCar(car.root.position, car.yaw, footprint)) hitWall(normal, depth, simTime)
  }
}

function hitWall(normal, depth, simTime) {
  const wallSpeed = car.hitWall(normal, depth)
  if (simTime < boostedUntil && wallSpeed >= WALL_DAMAGE_MIN_SPEED) {
    boostedUntil = 0
    net?.sendWall({ damage: WALL_DAMAGE })
    scoreUI.popup(car.root.position, 'wall', WALL_DAMAGE)
    takeDamage(WALL_DAMAGE)
  }
}

// Bastões com espinhos: o carro ricocheteia, o bastão balança e os espinhos
// tiram vida (se a batida tiver força). Cada jogador resolve o próprio carro e
// avisa a sala para os outros verem a animação.
function collideBats(simTime) {
  if (!bats || health.isKO) return // sumido no nocaute
  const hit = bats.testCar(car.root.position, car.yaw, footprint)
  if (!hit) return
  car.separate(hit.normal, hit.depth)
  const into = -car.velocity.dot(hit.normal) // velocidade indo contra o bastão
  if (into < 0.3) return // só encostando
  car.endBoost()
  car.applyImpulse(tmpImpulse.copy(hit.normal).multiplyScalar((1 + BAT_BOUNCE) * into))
  if (!batCooldown.ready(hit.index, simTime)) return
  const dx = -hit.normal.x, dz = -hit.normal.z // do carro para o bastão
  bats.kick(hit.index, dx, dz, into)
  const hurts = into >= SPIKE_MIN_SPEED && !health.isKO && !health.isShielded
  const damage = hurts ? DAMAGE.spike : 0
  net?.sendBat({ index: hit.index, dx, dz, strength: into, damage })
  if (damage) {
    scoreUI.popup(car.root.position, 'spike', damage)
    takeDamage(damage)
  }
}

// Batidas contra os outros. Cada jogador resolve só o próprio carrinho; quem
// bateu aplica o próprio ricochete e manda o empurrão e o dano da vítima (a
// vítima espera essa mensagem). Empate (ex.: de frente): cada um aplica só o
// próprio ricochete e ninguém leva dano. Nocauteado não causa dano.
function collideCars(simTime, wallTime) {
  if (health.isKO) return // sumido no nocaute: ninguém bate em mim
  for (const [peerId, { car: remote, ko }] of remotes.entries()) {
    if (!remote.hasState || ko) continue // o outro está sumido
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
    const tier = boosted ? 'turbo' : impactTier(judged.impact)
    const damage = immune || !tier ? 0 : DAMAGE[tier]
    const push = impulse * (boosted ? BOOST_PUSH : 1) // a vítima vai no sentido oposto
    net.sendHit({ target: peerId, ix: -hit.normal.x * push, iz: -hit.normal.z * push, damage, boosted })
    hitsSent.ready(peerId, simTime)
    if (boosted) car.endBoost()
    if (damage) scoreUI.popup(remote.root.position, tier, damage)
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

// 3, 2, 1, JÁ! (carros parados até o fim)
function updateCountdown(dt) {
  if (phase === 'countdown') {
    countdown -= dt
    menu.showCount(Math.ceil(countdown))
    if (countdown <= 0) phase = 'playing'
  } else if (goTimer < GO_SHOW_TIME) {
    goTimer += dt
    if (goTimer >= GO_SHOW_TIME) menu.showCount(null)
  }
}

// --- Loop -------------------------------------------------------------------------
// Passo fixo para tudo que muda o estado do jogo; desenho separado (loop.js)
const loop = new FixedStepLoop({
  step(dt, simTime, wallTime) {
    orbs.update(dt)
    if (!car || !inMatch()) return
    updateCountdown(dt)
    const playing = phase === 'playing'
    car.savePrevious()
    if (health.update(dt)) respawn()
    if (playing && isDown('KeyR') && !health.isKO) car.reset()
    if (playing && !health.isKO) updateBoost()
    // Nocauteado (ou na contagem) não dirige, mas ainda pode ser empurrado
    car.update(dt, !playing || health.isKO ? NO_INPUT : readDriveInput())
    collideWalls(simTime)
    collideBats(simTime)
    if (net) {
      collideCars(simTime, wallTime)
      sendState(dt, simTime)
    }
  },

  render(dt, wallTime, alpha) {
    if (quality.showFps) fpsMeter.update()
    remotes?.sample(wallTime)
    remotes?.updatePresence(dt)
    if (car) presence.apply(car.root, presence.update(dt, !health.isKO))
    car?.beginRender(alpha) // pose interpolada entre os dois últimos passos
    groupCamera.update(dt, cameraSubjects())
    if (car && inMatch()) sparks.update(dt, sparkEmitters())
    bats?.update(dt)
    sun.follow(groupCamera.center, Math.max(12, groupCamera.distance * 0.55))
    scoreUI.update(dt, camera) // depois da câmera: "+N" no lugar certo deste quadro
    if (car && inMatch()) carTags.update(camera, carTagSubjects())
    if (car && inMatch()) {
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
applyQuality()
loop.start()

// Carros que a câmera precisa enquadrar (lista reaproveitada a cada quadro)
const subjects = []
// Fora da partida a câmera mostra a arena inteira (dois cantos parados)
const arenaView = [
  { position: new THREE.Vector3(-arena.halfX * 0.7, 0, -arena.halfZ * 0.7), velocity: new THREE.Vector3() },
  { position: new THREE.Vector3(arena.halfX * 0.7, 0, arena.halfZ * 0.7), velocity: new THREE.Vector3() },
]
function cameraSubjects() {
  if (!inMatch()) return arenaView
  subjects.length = 0
  if (car && !health.isKO) subjects.push(car)
  if (remotes) for (const { car: remote, ko } of remotes.values()) if (remote.hasState && !ko) subjects.push(remote)
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
  if (!health.isKO) add(car.body, car.velocity, car.isBoosting)
  for (const { car: remote, boosting, ko } of remotes.values()) {
    if (remote.hasState && !ko) add(remote.body, remote.velocity, boosting)
  }
  return emitters
}

// Etiquetas dos carros (objetos reaproveitados a cada quadro). Somem no
// nocaute junto com o carro
const tagSubjects = []
const tagPool = []
function carTagSubjects() {
  tagSubjects.length = 0
  const add = (id, name, hp, position, visible) => {
    const s = (tagPool[tagSubjects.length] ??= {})
    s.id = id
    s.name = name
    s.hp = hp
    s.position = position
    s.visible = visible
    tagSubjects.push(s)
  }
  add(net.selfId, '', health.hp, car.root.position, !health.isKO) // o meu: só a barra
  for (const [peerId, player] of remotes.entries()) {
    const name = roster.get(peerId)?.name || `Jogador ${peerId.slice(0, 4).toUpperCase()}`
    add(peerId, name, player.hp, player.car.root.position, player.car.hasState && !player.ko)
  }
  return tagSubjects
}

let scoreboardTimer = 0
function renderScoreboard(dt) {
  scoreboardTimer += dt
  if (scoreboardTimer < 0.25) return // 4x por segundo basta
  scoreboardTimer = 0
  const players = [{ name: 'Você', color: swatch(readColors(bodyMaterials)), hp: health.hp, ko: health.isKO, isMe: true }]
  for (const [peerId, player] of remotes.entries()) {
    players.push({
      name: roster.get(peerId)?.name || `Jogador ${peerId.slice(0, 4).toUpperCase()}`,
      color: swatch(remotes.colors(player)),
      hp: player.hp,
      ko: player.ko,
      isMe: false,
    })
  }
  scoreUI.render(players)
}

// --- Tamanho da tela e qualidade -----------------------------------------------------
// Tudo que depende da resolução: renderer, contorno, fundo, retícula, faíscas
function applyQuality() {
  camera.aspect = window.innerWidth / window.innerHeight
  camera.updateProjectionMatrix()
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, quality.maxPixelRatio))
  renderer.setSize(window.innerWidth, window.innerHeight)
  outline.setSize()
  background.redraw()
  toonGlobals.uPixelRatio.value = renderer.getPixelRatio()
  sparks.setSize(window.innerWidth, window.innerHeight, renderer.getPixelRatio())
  sun.setShadowResolution(quality.shadowSize)
  fpsMeter.dom.style.display = quality.showFps ? '' : 'none'
}
window.addEventListener('resize', applyQuality)
// Página devolvida pela memória do navegador (voltar/reabrir aba) não
// recarrega: os controles voltam aos padrões do jogo do mesmo jeito
window.addEventListener('pageshow', (e) => {
  if (!e.persisted) return
  savedSettings.then((settings) => {
    panel.restoreGameDefaults(settings)
    if (livery) applyLivery(livery)
  })
})
