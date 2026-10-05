import * as THREE from 'three'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import Stats from 'three/examples/jsm/libs/stats.module.js'
import { toonify, toonGlobals, createToonMaterial } from './toon.js'
import { ScreenOutline } from './outline.js'
import { Background, Sun, Arena } from './environment.js'
import { GroupCamera } from './groupCamera.js'
import { ControlPanel } from './panel.js'
import { ScoreUI, PlayerHud, CarTags, ItemArrows, UltimateBanner, MatchClock, KillFeed } from './hud.js'
import { KillTracker, MATCH_TIME, tallyKills, tallyXp, tallyAssists, standings, winners, formatClock } from './match.js'
import { levelFor, levelProgress, damageScale, scaleDamage, maxHealthFor, xpForHit, xpForKill, repeatScale } from './progression.js'
import { FixedStepLoop } from './loop.js'
import { Car } from './car.js'
import { readDriveInput, isDown, wasPressed } from './input.js'
import { joinArena } from './net.js'
import { RemotePlayers } from './remotePlayers.js'
import { measureFootprint, testCars, testArenaWalls } from './collision.js'
import { Orbs, orbCountFor } from './orbs.js'
import { SparkEffects, findPoleTip } from './sparks.js'
import { SpikedBats, extractProp, placeBats } from './bats.js'
import { TireWalls, placeTireWalls, prepareTireWall } from './tireWalls.js'
import { spawnPoints, cornerPoints, cornerIndex, chooseRespawn, yawToCenter } from './spawns.js'
import { distanceToSegment } from './collision.js'
import { newLayout, shouldAdopt } from './layout.js'
import { Presence } from './presence.js'
import { MenuUI } from './menu.js'
import { newRoomCode, normalizeCode, hostOf } from './lobby.js'
import { pickLivery, readColors, swatch, setBoostGlow, setUltimateGlow, MATERIAL_GROUPS, DEFAULT_GROUP, materialGroup } from './paint.js'
import { UltimateDirector, UltimateSlot, StormStrikes, ShockwaveCast, MissileShot, ULTIMATES, ULT_KINDS, ULT_PICKUP_RADIUS, ULT_STORE_TIME } from './ultimate.js'
import { UltimateView } from './ultimateView.js'
import { MedkitDirector, MEDKIT, ZoneHealing, placeNearFight, maxZonesFor } from './medkit.js'
import { MedkitView } from './medkitView.js'
import { TrainingDummy, TestPanel, localNet, DUMMY_SPOTS, TEST_SPAWN } from './testRange.js'
import {
  judgeHit, impactTier, tierOfDamage, DAMAGE, MIN_IMPULSE, HitCooldown, Health, MAX_HEALTH,
  BOOST_PUSH, WALL_DAMAGE, WALL_DAMAGE_WINDOW, WALL_DAMAGE_MIN_SPEED, SPIKE_MIN_SPEED,
} from './damage.js'

// Ponto de entrada: monta as peças (cena, câmera, painel, rede) e contém as
// regras da partida (batidas, boost, vida). Cada sistema vive no seu módulo.

const MODEL_URL = `${import.meta.env.BASE_URL}models/BumpyCar.glb`
// Valores do painel salvos pelo botão "Salvar configurações"
const SETTINGS_URL = `${import.meta.env.BASE_URL}settings.json`
// Link de convite: ?room=CÓDIGO abre o menu já com o código da sala
// (?sala= é o nome antigo do parâmetro: links velhos continuam valendo)
const INVITE_CODE = normalizeCode(new URLSearchParams(location.search).get('room') ?? new URLSearchParams(location.search).get('sala'))
const COUNTDOWN = 3 // s de "3, 2, 1" antes de liberar os carros
const GO_SHOW_TIME = 0.8 // s que o "JÁ!" fica na tela
// Arena retangular: lado maior em X (horizontal na tela, combina com a câmera)
const ARENA_WIDTH = 90  // m em X
const ARENA_DEPTH = 55  // m em Z
const NET_SEND_INTERVAL = 1 / 20 // estados por segundo para os outros jogadores
const MAX_BOOSTS = 2 // estoque de boosts (turbo é forte: precisa ser raro)
// Bastões com espinhos
const BAT_URL = `${import.meta.env.BASE_URL}models/Bastao.glb`
const BAT_COUNT = 7
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
  maxFps: 60, // 0 = sem limite
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
const itemArrows = new ItemArrows() // setas na borda da tela para boosts e ultimate fora da vista
const ultBanner = new UltimateBanner()
const matchClock = new MatchClock()
const killFeed = new KillFeed()
const ultView = new UltimateView(scene)
const medViews = Array.from({ length: MEDKIT.maxZones }, () => new MedkitView(scene)) // uma por zona
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
// Lugares para a cápsula de vida: grade fina (~6 m), fora de obstáculos e do
// centro (lá aparece o ultimate)
const medkitPoints = () => {
  const points = []
  for (let x = -SPAWN_RANGE_X; x <= SPAWN_RANGE_X + 0.01; x += SPAWN_RANGE_X / 7) {
    for (let z = -SPAWN_RANGE_Z; z <= SPAWN_RANGE_Z + 0.01; z += SPAWN_RANGE_Z / 4) {
      if (Math.hypot(x, z) > 6 && isFree(x, z)) points.push({ x, z })
    }
  }
  return points
}
let medkitSpots = medkitPoints()
const orbs = new Orbs(scene, {
  seed: layout.seed, count: orbCountFor(1), halfX: arena.halfX - 3, halfZ: arena.halfZ - 3,
  anchors: batSpots, anchorRange: ORB_NEAR_BAT,
})

// Esferas conforme quantos estão na sala (eu + os outros): todos contam igual
function updateOrbCount() {
  orbs.setCount(orbCountFor(1 + roster.size))
}

// Troca para o mapa de outro jogador (o dele é mais antigo)
function adoptLayout(next) {
  layout = { seed: next.seed, since: next.since }
  batSpots = placeLayoutBats(layout.seed)
  bats?.setPositions(batSpots)
  tireSpots = placeLayoutTires(layout.seed, batSpots)
  tireWalls?.setWalls(tireSpots)
  spawnSpots = spawnPoints(SPAWN_RANGE_X, SPAWN_RANGE_Z, isFree)
  medkitSpots = medkitPoints()
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
outline.skipInNormalPass.push(...ultView.meshes)
for (const v of medViews) outline.skipInNormalPass.push(...v.meshes)
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
let glowing = null      // brilho aplicado nos materiais: 'boost', 'ult' ou null (dirty flag)
// Ultimate (ultimate.js): item do centro (o anfitrião decide), meu inventário
// e meus raios
const ultimate = new UltimateDirector()
const ultSlot = new UltimateSlot()
const storm = new StormStrikes(ULTIMATES.overcharge)
let ultClaimed = -1     // ciclo em que já pedi o item (não pede de novo)
let ultGot = -1         // último item entregue que já vi (anúncio e inventário)
let ultResend = 0       // anfitrião: reenvia o estado de tempos em tempos
let stunUntil = 0       // atordoado (sem dirigir) até este instante da simulação
let ultNews = null      // anúncio rápido na faixa: { title, sub, tone, until }
// Zona de cura (medkit.js): o anfitrião decide quando e onde aparece; cada
// um cura a própria vida enquanto está dentro
const medkit = new MedkitDirector()
const zoneHeal = new ZoneHealing()
let medResend = 0       // anfitrião: reenvia o estado de tempos em tempos
// Partida (match.js): 10 min, ganha quem tiver mais abates. O placar sai do
// "quem me nocauteou" (koBy) de cada um; o relógio é do anfitrião
const kills = new KillTracker() // minhas mortes e quem me abateu
let matchLeft = MATCH_TIME      // s até acabar
let matchResend = 0             // anfitrião: reenvia o relógio de tempos em tempos
const departed = new Map()      // quem saiu no meio: { name, koBy, deaths } (os números ficam)
// Progressão (progression.js): o dano causado acumulado sobe o nível (mais
// dano e mais vida). O nível de todos sai do placar, recalculado a cada passo
let damageTally = new Map()     // id -> XP ganho
let myLevel = 1
const levelOf = (id) => levelFor(damageTally.get(id) ?? 0)
let healShown = 0       // cura acumulada ainda não mostrada ("+N VIDA" a cada 1 s)
let healPopupTimer = 0
let netTimer = 0
// Levei uma batida com boost há pouco: se bater na parede até `until`,
// perco mais vida
let boostedUntil = 0
let blastUntil = 0 // idem, depois da Onda de choque (aí os pneus também doem)
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
  netStatus.textContent = `Room ${roomCode} · ${players} ${players === 1 ? 'player' : 'players'}`
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
  if (hit.blast) blastUntil = now + WALL_DAMAGE_WINDOW
  if (hit.stun && !health.isShielded) stunUntil = Math.max(stunUntil, now + hit.stun)
  kills.noteHit(attackerId, now) // se eu cair (até de parede/espinho), o abate é dele
  takeDamage(hit.damage, attackerId)
}

// `by`: quem causou o dano (rende XP a ele, pelos níveis que eu enxergo no
// instante do golpe); parede/espinho não têm
function takeDamage(amount, by = null) {
  const now = loop.simTime
  const attacker = by ? levelOf(by) : 0
  const repeat = by ? repeatScale(kills.sinceKoBy(by, now)) : 1
  const { dealt, knockedOut } = health.damage(amount)
  kills.noteXp(by, Math.round(xpForHit(dealt, attacker, myLevel) * repeat))
  if (knockedOut) {
    scoreUI.popup(car.root.position, 'ko')
    const killRepeat = repeatScale(kills.sinceKoBy(kills.lastHit?.by, now)) // antes de registrar este abate
    const killer = kills.knockedOut(now)
    if (killer) kills.noteXp(killer, Math.round(xpForKill(levelOf(killer), myLevel) * killRepeat))
    if (killer) killFeed.add(playerName(killer), 'You')
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
  onTest: enterTestRange,
})

function enterRoom(code, name) {
  roomCode = code
  myName = name
  joinedAt = Date.now()
  phase = 'lobby'
  // O endereço vira o link de convite (mantém ?painel, ?fps...)
  const params = new URLSearchParams(location.search)
  params.delete('sala')
  params.set('room', code)
  history.replaceState(null, '', `${location.pathname}?${params}`)
  menu.showLobby(code, `${location.origin}${location.pathname}?room=${code}`)
  startMultiplayer()
  refreshLobby()
}

const hello = () => ({ name: myName, since: joinedAt, phase: inMatch() ? 'playing' : 'lobby' })

function refreshLobby() {
  if (phase !== 'lobby') return
  const members = [{ id: net.selfId, name: myName, since: joinedAt, me: true }]
  for (const [id, r] of roster) members.push({ id, name: r.name || 'Player', since: r.since, me: false })
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
  updateOrbCount()
  phase = 'countdown'
  countdown = COUNTDOWN
  goTimer = 0
  menu.close()
  scene.add(car.root)
  deathSpot = null
  lastSpawn = null
  ultimate.reset()
  ultSlot.reset()
  storm.reset()
  // Placar e relógio do zero (também em "Play again")
  kills.reset()
  matchLeft = MATCH_TIME
  departed.clear()
  for (const p of remotes.values()) {
    p.koBy = {}
    p.asBy = {}
    p.xpBy = {}
    p.deaths = 0
  }
  for (const d of dummies.values()) {
    d.kills.reset()
    d.revive()
  }
  health.reset()
  damageTally = new Map()
  myLevel = 1
  boosts = 0
  ultClaimed = ultGot = -1
  ultNews = null
  medkit.reset()
  zoneHeal.carry = 0
  stunUntil = 0
  missiles.length = 0
  slowUntil = 0
  if (testMode) {
    spawnAt(TEST_SPAWN) // de frente para os bonecos
    if (!dummies.size) addDummy()
  } else if (late) {
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
      if (inMatch() && amHost()) net.sendUlt(ultimate.snapshot(), peerId)
      if (inMatch() && amHost()) net.sendMedkit(medkit.snapshot(), peerId)
      if (inMatch() && amHost()) net.sendMatch({ left: matchLeft, over: phase === 'over' }, peerId)
    },
    // Ultimate: o estado vem do anfitrião; pedidos só o anfitrião atende
    onUlt(state) {
      if (!inMatch() || (amHost() && state.n <= ultimate.n)) return
      if (ultimate.apply(state)) checkUltGiven()
    },
    // Zona de cura: o estado vem do anfitrião
    onMedkit(state) {
      if (!inMatch() || (amHost() && state.v <= medkit.v)) return
      if (medkit.apply(state)?.length) announceMedkit()
    },
    onUltReq(req, peerId) {
      if (!inMatch() || !amHost() || req.n !== ultimate.n) return
      if (ultimate.claim(peerId)) {
        checkUltGiven()
        broadcastUlt()
      }
    },
    onHello(info, peerId) {
      roster.set(peerId, info)
      refreshLobby()
      updateOrbCount()
    },
    onStart(map) {
      if (phase === 'lobby' || phase === 'over') beginMatch(map) // "Play again" também
    },
    // Relógio da partida: vale o do anfitrião
    onMatch(clock) {
      if (phase !== 'playing' || amHost()) return
      if (clock.over) endMatch()
      else if (Math.abs(clock.left - matchLeft) > 0.5) matchLeft = clock.left
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
      // Quem sai no meio continua no placar (os abates que deu e levou ficam)
      const gone = remotes?.get(peerId)
      if (gone && inMatch()) departed.set(peerId, { name: playerName(peerId), koBy: gone.koBy ?? {}, asBy: gone.asBy ?? {}, xpBy: gone.xpBy ?? {}, deaths: gone.deaths ?? 0 })
      roster.delete(peerId)
      remotes?.remove(peerId)
      refreshLobby() // se o anfitrião saiu, outro assume
      updateOrbCount()
    },
    onPeerState: handlePeerState,
    onHit(hit, attackerId) {
      // O dano aparece em cima de quem levou a batida, para todo mundo ver
      const position = positionOf(hit.target)
      if (hit.zap) {
        // Raio da Sobrecarga: desenha o raio do dono até o alvo
        const from = positionOf(attackerId)
        if (from && position) ultView.bolt(tmpBoltFrom.copy(from).setY(2.6), tmpBoltTo.copy(position).setY(0.8))
        if (position) scoreUI.popup(position, hit.stun ? 'stun' : 'zap', hit.damage)
      } else if (hit.rocket) {
        if (position) scoreUI.popup(position, 'rocket', hit.damage) // míssil
      } else if (hit.blast) {
        if (position) scoreUI.popup(position, 'blast', hit.damage) // Onda de choque
      } else if (hit.damage && position) {
        scoreUI.popup(position, hit.boosted ? 'turbo' : tierOfDamage(hit.damage, damageScale(levelOf(attackerId))), hit.damage)
      }
      if (hit.target === net.selfId && inMatch()) receiveHit(hit, attackerId)
    },
    // Alguém bateu na parede depois de levar um boost (o dano já foi
    // descontado por ele; aqui é só para mostrar)
    onWall(wall, peerId) {
      const position = positionOf(peerId)
      if (wall.damage && position) scoreUI.popup(position, 'wall', wall.damage)
    },
  })

  exposeDebug()
}

// Estado do carro de outro jogador (ou de um boneco do campo de testes)
function handlePeerState(peerId, state) {
  if (!remotes) return // carro ainda carregando
  const { player, liveryChanged, knockedOut, ultStarted, missilesFired: fired, killedBy } = remotes.applyState(peerId, state, performance.now() / 1000)
  // Kill feed: quem abateu esse jogador desde o último estado
  for (const killer of killedBy) killFeed.add(killer === net.selfId ? 'You' : playerName(killer), playerName(peerId), killer === net.selfId)
  if (knockedOut) scoreUI.popup(player.car.position, 'ko')
  // Mísseis que ele disparou (contador no estado: não se perde nenhum)
  for (let i = 0; i < fired; i++) launchMissile(player.car.root.position, state.yaw, peerId)
  if (ultStarted) {
    const spec = ULTIMATES[state.ult]
    announce(`⚡ ${playerName(peerId)} ACTIVATED ${spec.name}!`, spec.enemyHint, 'enemy')
    if (state.ult === 'shockwave') showShockwave(player.car.root.position, state.yaw)
  }
  // Mesma pintura que a minha: um dos dois sorteia de novo (o de ID menor
  // mantém, para os dois não trocarem ao mesmo tempo)
  if (liveryChanged && state.livery && state.livery === livery?.name && net.selfId > peerId) rerollLivery()
}

// Só no `npm run dev`: acesso pelo console do navegador para depuração
function exposeDebug() {
  if (import.meta.env.DEV) window.__game = { kills, match: { get left() { return matchLeft }, set left(v) { matchLeft = v } }, launchMissile, missiles, get boosts() { return boosts }, medkit, dummies, ultimate, ultSlot, get stunned() { return loop.simTime < stunUntil }, net, get car() { return car }, get bats() { return bats }, get tireWalls() { return tireWalls }, health, get remotes() { return remotes }, orbs, loop, sparks, camera, renderer, outline, scene, menu, roster, toonGlobals, get phase() { return phase } }
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
  // Com ultimate na mão (guardado ou em uso), o boost fica travado: os dois
  // juntos davam nocaute garantido. As esferas continuam indo para o estoque
  if (wasPressed('Space') && boosts > 0 && !car.isBoosting && !boostLocked()) {
    boosts--
    car.boost()
  }
}

// Paredes da arena: ricochete; se eu levei uma batida com boost há pouco e
// fui parar na parede, perco mais vida
function collideWalls(simTime) {
  for (const { normal, depth } of testArenaWalls(car.root.position, car.yaw, footprint, arena.halfX, arena.halfZ)) {
    hitWall(normal, depth, simTime)
  }
  // Paredes de pneus: mesmo ricochete, mas pneu amortece: o combo do turbo
  // não dói aqui, só o da Onda de choque (sumido no nocaute, atravessa)
  if (tireWalls && !health.isKO) {
    for (const { index, normal, depth } of tireWalls.testCar(car.root.position, car.yaw, footprint)) hitWall(normal, depth, simTime, true, index)
  }
}

function hitWall(normal, depth, simTime, tires = false, index = -1) {
  const wallSpeed = car.hitWall(normal, depth)
  if (tires) tireWalls.kick(index, -normal.x, -normal.z, wallSpeed)
  const combo = tires ? simTime < blastUntil : simTime < boostedUntil
  if (combo && wallSpeed >= WALL_DAMAGE_MIN_SPEED) {
    boostedUntil = blastUntil = 0 // o dano extra conta uma vez só
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
    if (judged.role === 'victim') {
      const dummy = testMode && dummies.get(peerId)
      if (dummy) dummyHitsMe(dummy, hit.normal, judged.impact, simTime)
      continue
    }
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
    const damage = immune || !tier ? 0 : scaleDamage(DAMAGE[tier], myLevel)
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
    ult: ultSlot.active,
    ms: missilesFired,
    deaths: kills.deaths,
    koBy: kills.koBy,
    asBy: kills.asBy,
    xpBy: kills.xpBy,
  })
}

// --- Campo de testes -------------------------------------------------------------------
// Partida só minha, sem rede, com bonecos parados (testRange.js)
let testMode = false
let freeUltimate = false // ultimate sem recarga e sem prazo
const dummies = new Map() // id -> TrainingDummy

function enterTestRange(name) {
  testMode = true
  myName = name
  joinedAt = Date.now()
  roomCode = 'TESTE'
  phase = 'lobby'
  net = localNet(hitDummy) // nada sai do computador; batidas vão para os bonecos
  netStatus.textContent = 'Practice range · solo'
  new TestPanel({
    ultimates: ULT_KINDS.map((kind) => ({ kind, name: ULTIMATES[kind].name })),
    onFreeToggle: (on) => (freeUltimate = on),
    actions: {
      giveUltimate(kind) {
        ultSlot.clearStored() // troca o guardado pelo escolhido
        ultSlot.give(kind)
        announce(`⚡ ${ULTIMATES[kind].name} READY`, 'press E to use', 'mine')
      },
      resetCooldown: () => (ultSlot.cooldown = 0),
      spawnItem() {
        if (ultimate.phase !== 'available') ultimate.timer = Math.min(ultimate.timer, 0.01)
      },
      addDummy,
      spawnMedkit() {
        // Perto de quem tem menos vida (eu ou um boneco)
        const players = playersWithHp()
        if (!players.length) return
        const spot = placeMedkit(players.reduce((a, b) => (b.hp < a.hp ? b : a)))
        if (!spot) return
        medkit.spawn(spot)
        announceMedkit()
      },
      reviveDummies: () => dummies.forEach((d) => d.revive()),
      heal() {
        health.hp = health.max
        health.koTimer = 0
      },
      hurt: () => takeDamage(30),
      fillBoosts: () => (boosts = MAX_BOOSTS),
      exit: () => location.assign(location.pathname),
      endMatch: () => endMatch(),
    },
  })
  exposeDebug()
  beginMatch(newLayout())
}

// Batida "mandada" para um boneco: aplica direto nele
function hitDummy(hit) {
  const d = dummies.get(hit.target)
  if (!d) return
  const attacker = levelOf(net.selfId)
  const victim = levelOf(d.id)
  const repeat = repeatScale(d.kills.sinceKoBy(net.selfId, loop.simTime))
  d.receive(
    hit, loop.simTime, net.selfId,
    (dealt) => Math.round(xpForHit(dealt, attacker, victim) * repeat),
    Math.round(xpForKill(attacker, victim) * repeat),
  )
}

// Boneco novo no primeiro lugar livre (sem boneco nem obstáculo)
function addDummy() {
  const taken = (s) => [...dummies.values()].some((d) => d.spot === s)
  const spot = DUMMY_SPOTS.find((s) => !taken(s) && isFree(s.x, s.z))
  if (!spot) return
  const n = dummies.size + 1
  // Física de carro de verdade (mesmos parâmetros do meu), sem modelo visível:
  // o desenho é o carro remoto, como o de qualquer jogador
  const body = new Car(new THREE.Object3D())
  body.params = car.params
  const dummy = new TrainingDummy(`boneco-${n}`, n === 1 ? 'Training Dummy' : `Dummy ${n}`, body, spot)
  dummies.set(dummy.id, dummy)
}

// Bonecos: vida (volta do nocaute) e "estado pela rede" como um jogador
function updateDummies(dt, simTime) {
  const list = [...dummies.values()]
  for (const d of list) {
    d.update(dt)
    if (d.health.isKO) continue
    collideDummy(d, simTime)
    // Zona de cura vale para eles também
    if (medkit.contains(d.x, d.z)) {
      d.zoneHeal ??= new ZoneHealing()
      const healed = d.health.heal(d.zoneHeal.update(dt, d.health.hp, d.health.max))
      d.healShown = (d.healShown ?? 0) + healed
    }
    if ((d.healTimer = (d.healTimer ?? 0) + dt) >= 1) {
      if (d.healShown) scoreUI.popup(d.car.root.position, 'heal', d.healShown)
      d.healTimer = d.healShown = 0
    }
  }
  // Boneco contra boneco: separa e troca o empurrão (sem dano)
  for (let i = 0; i < list.length; i++) {
    for (let j = i + 1; j < list.length; j++) {
      const a = list[i].car, b = list[j].car
      if (list[i].health.isKO || list[j].health.isKO) continue
      const hit = testCars(a.root.position, a.yaw, b.root.position, b.yaw, footprint)
      if (!hit) continue
      a.separate(hit.normal, hit.depth / 2)
      b.separate(tmpImpulse.copy(hit.normal).negate(), hit.depth / 2)
      const impulse = a.collisionImpulse(hit.normal, b.velocity)
      if (impulse <= 0) continue
      a.applyImpulse(tmpImpulse.copy(hit.normal).multiplyScalar(impulse))
      b.applyImpulse(tmpImpulse.copy(hit.normal).multiplyScalar(-impulse))
    }
  }
  for (const d of list) handlePeerState(d.id, d.state(simTime))
}

// Mureta, pneus e bastões, como o meu carro (com o combo turbo + mureta e
// o dano dos espinhos)
function collideDummy(d, simTime) {
  const c = d.car, pos = c.root.position
  const damage = (amount, kind) => {
    if (d.hurt(amount, simTime).dealt) scoreUI.popup(pos, kind, amount)
  }
  const wall = (normal, depth, tires, index) => {
    const speed = c.hitWall(normal, depth)
    if (tires) tireWalls.kick(index, -normal.x, -normal.z, speed)
    const combo = tires ? simTime < d.blastUntil : simTime < d.boostedUntil
    if (combo && speed >= WALL_DAMAGE_MIN_SPEED) {
      d.boostedUntil = d.blastUntil = 0
      damage(WALL_DAMAGE, 'wall')
    }
  }
  for (const { normal, depth } of testArenaWalls(pos, c.yaw, footprint, arena.halfX, arena.halfZ)) wall(normal, depth, false)
  if (tireWalls) for (const { index, normal, depth } of tireWalls.testCar(pos, c.yaw, footprint)) wall(normal, depth, true, index)
  const hit = bats?.testCar(pos, c.yaw, footprint)
  if (!hit) return
  c.separate(hit.normal, hit.depth)
  const into = -c.velocity.dot(hit.normal)
  if (into < 0.3) return
  c.applyImpulse(tmpImpulse.copy(hit.normal).multiplyScalar((1 + BAT_BOUNCE) * into))
  if (!d.batCooldown.ready(hit.index, simTime)) return
  bats.kick(hit.index, -hit.normal.x, -hit.normal.z, into)
  if (into >= SPIKE_MIN_SPEED) damage(DAMAGE.spike, 'spike')
}

// O boneco veio para cima de mim (eu sou a vítima): ele resolve a batida,
// como faria um jogador de verdade
function dummyHitsMe(d, normal, impact, simTime) {
  const impulse = d.car.collisionImpulse(tmpImpulse.copy(normal).negate(), car.velocity)
  if (impulse < MIN_IMPULSE || !d.hitCooldown.ready('eu', simTime)) return
  d.car.applyImpulse(tmpImpulse.copy(normal).multiplyScalar(-impulse))
  car.applyImpulse(tmpImpulse.copy(normal).multiplyScalar(impulse))
  kills.noteHit(d.id, simTime) // se eu cair, o abate é dele
  const tier = impactTier(impact)
  if (!tier || health.isShielded) return
  const damage = scaleDamage(DAMAGE[tier], levelOf(d.id))
  scoreUI.popup(car.root.position, tier, damage)
  takeDamage(damage, d.id)
}

// --- Ultimate ------------------------------------------------------------------------
const tmpBoltFrom = new THREE.Vector3()
const tmpBoltTo = new THREE.Vector3()
const stormTargets = []
const activeStorms = []
const stormPool = []

const playerName = (peerId) =>
  dummies.get(peerId)?.name || roster.get(peerId)?.name || `Player ${peerId.slice(0, 4).toUpperCase()}`

// Ultimate guardado ou em uso trava o boost
const boostLocked = () => !!(ultSlot.kind || ultSlot.active)

// Com o ultimate em uso agora?
const isPowered = (id) => (id === net.selfId ? !!ultSlot.active : !!remotes?.get(id)?.ult)

// Anfitrião da sala (lobby.js): quem está há mais tempo. Decide o item do centro
function amHost() {
  const members = [{ id: net.selfId, since: joinedAt }]
  for (const [id, r] of roster) members.push({ id, since: r.since })
  return hostOf(members) === net.selfId
}

function broadcastUlt() {
  net.sendUlt(ultimate.snapshot())
  ultResend = 0
}

// Anúncio rápido na faixa do topo (some sozinho)
function announce(title, sub, tone) {
  ultNews = { title, sub, tone, until: performance.now() + 2500 }
}

// O anfitrião entregou um item: se foi para mim, vai para o inventário
function checkUltGiven() {
  const given = ultimate.given
  if (!given || given.n <= ultGot) return
  ultGot = given.n
  const name = ULTIMATES[given.kind].name
  if (given.owner === net.selfId) {
    ultSlot.give(given.kind)
    scoreUI.popup(car.root.position, 'ultget')
    announce(`⚡ YOU GOT ${name}!`, `use it within ${Math.round(ultSlot.storedLeft)}s or lose it${ultSlot.cooldown > 0 ? ' (unlocks after cooldown)' : ' · press E'} · boost locked`, 'mine')
  } else {
    announce(`⚡ ${playerName(given.owner)} GOT ${name}`, 'watch out', 'enemy')
  }
}

// Alvos dos ultimates: todos os outros carros na arena (jogadores e bonecos)
function ultTargets() {
  stormTargets.length = 0
  for (const [id, p] of remotes.entries()) {
    if (!p.car.hasState || p.ko) continue
    stormTargets.push({ id, x: p.car.root.position.x, z: p.car.root.position.z, immune: p.shield })
  }
  return stormTargets
}

// Onda de choque: explosão única. Conta como batida com boost (boosted): quem
// for arremessado contra a mureta leva o dano extra de PAREDE
// Míssil: cruza o mapa em linha reta; o rastro deixa lento quem passa
// (menos quem atirou). Todos simulam o mesmo voo; o acerto direto é de quem
// atirou. Lista: { shot, owner }
const missiles = []
const missileShots = [] // só os MissileShot, para o desenho (reaproveitada)
let slowUntil = 0       // lento até este instante da simulação
let missileShotsLeft = 0 // mísseis que faltam na rajada
let missileClock = 0     // s até o próximo
let missilesFired = 0   // vai no estado do carro: os outros lançam um a cada aumento

function launchMissile(carPosition, yaw, owner) {
  const dir = { x: Math.sin(yaw), z: Math.cos(yaw) }
  const origin = { x: carPosition.x + dir.x * SHOCK_NOSE, z: carPosition.z + dir.z * SHOCK_NOSE }
  missiles.push({ shot: new MissileShot(ULTIMATES.missile, origin, dir, arena.halfX, arena.halfZ), owner })
}

function updateMissiles(dt, simTime) {
  const mine = net.selfId
  for (const { shot, owner } of missiles) {
    // O meu míssil acerta quem estiver no caminho (ele continua voando)
    for (const h of shot.update(dt, owner === mine ? ultTargets() : [])) {
      const damage = scaleDamage(h.damage, myLevel)
      net.sendHit({ target: h.id, ix: h.dx * h.push, iz: h.dz * h.push, damage, boosted: false, rocket: true })
      scoreUI.popup(remotes.get(h.id).car.root.position, 'rocket', damage)
    }
  }
  for (let i = missiles.length - 1; i >= 0; i--) if (missiles[i].shot.expired) missiles.splice(i, 1)
  missileShots.length = 0
  for (const m of missiles) missileShots.push(m.shot)

  // Em cima do rastro de outro: lento (e mais um pouco depois de sair)
  const pos = car.root.position
  const onTrail = !health.isKO && missiles.some((m) => m.owner !== mine && m.shot.trailContains(pos.x, pos.z))
  const wasSlow = simTime < slowUntil
  if (onTrail) slowUntil = simTime + ULTIMATES.missile.slowLinger
  const slow = simTime < slowUntil
  car.speedScale = slow ? ULTIMATES.missile.slow : 1
  if (slow && !wasSlow) scoreUI.popup(pos, 'slow')
}

// Faixa na frente do carro, na direção para onde ele aponta. O carro para e
// fica sem controle até a onda acabar (ultSlot.active), e pode levar dano
let shockCast = null
const SHOCK_NOSE = 1.4 // m do centro do carro até onde a faixa começa

function fireShockwave() {
  const yaw = car.yaw
  const dir = { x: Math.sin(yaw), z: Math.cos(yaw) }
  const pos = car.root.position
  const origin = { x: pos.x + dir.x * SHOCK_NOSE, z: pos.z + dir.z * SHOCK_NOSE }
  shockCast = new ShockwaveCast(ULTIMATES.shockwave, origin, dir)
  car.halt()
  showShockwave(pos, yaw)
}

// Faixa de aviso + onda; a tela treme quando a onda sai (mais perto de mim, mais forte)
function showShockwave(carPosition, yaw) {
  const spec = ULTIMATES.shockwave
  const origin = { x: carPosition.x + Math.sin(yaw) * SHOCK_NOSE, z: carPosition.z + Math.cos(yaw) * SHOCK_NOSE }
  ultView.shockwave(origin, yaw, spec, () => {
    const dist = Math.hypot(origin.x - car.root.position.x, origin.z - car.root.position.z)
    shake = Math.max(shake, 1.2 * Math.max(0, 1 - dist / (spec.length * 1.5)))
  })
}

// Tremida da câmera: deslocamento aleatório que morre rápido (a câmera é
// reposicionada todo quadro, então não acumula)
let shake = 0
function applyShake(dt) {
  if (shake < 0.01) return
  camera.position.x += (Math.random() - 0.5) * shake
  camera.position.y += (Math.random() - 0.5) * shake
  camera.position.z += (Math.random() - 0.5) * shake
  shake *= Math.exp(-7 * dt)
}

// Passo fixo: relógio do item, pegar no centro, usar (E) e os raios
function updateUltimate(dt, stunned) {
  const host = amHost()
  if (ultimate.update(dt, host)) broadcastUlt()
  // Anfitrião reenvia o estado a cada 2 s: corrige relógios e mensagens perdidas
  if (host && (ultResend += dt) >= 2) broadcastUlt()

  const pos = car.root.position
  // Pegar: vaga livre e passando no centro (o pedido vai ao anfitrião)
  if (ultimate.phase === 'available' && ultSlot.canPickUp && !health.isKO && ultClaimed !== ultimate.n && Math.hypot(pos.x, pos.z) < ULT_PICKUP_RADIUS) {
    ultClaimed = ultimate.n
    if (!host) net.sendUltReq({ n: ultimate.n, op: 'claim' })
    else if (ultimate.claim(net.selfId)) {
      checkUltGiven()
      broadcastUlt()
    }
  }

  if (freeUltimate) {
    ultSlot.cooldown = 0
    if (ultSlot.kind) ultSlot.storedLeft = ULT_STORE_TIME
  }
  // Usar o guardado
  if (wasPressed('KeyE') && ultSlot.ready && !health.isKO && !stunned) {
    const kind = ultSlot.activate()
    announce(`⚡ ${ULTIMATES[kind].name}!`, ULTIMATES[kind].hint, 'mine')
    if (kind === 'overcharge') storm.reset()
    if (kind === 'shockwave') fireShockwave()
    if (kind === 'missile') {
      car.halt()
      missileShotsLeft = ULTIMATES.missile.shots
      missileClock = 0
    }
  }
  if (ultSlot.active !== 'missile') missileShotsLeft = 0 // (nocaute cancela o resto da rajada)
  // Rajada: um míssil a cada intervalo, para onde o carro está virado agora
  if (missileShotsLeft > 0 && (missileClock -= dt) <= 0) {
    missileClock += ULTIMATES.missile.shotInterval
    missileShotsLeft--
    launchMissile(car.root.position, car.yaw, net.selfId)
    missilesFired++
  }
  if (health.isKO) ultSlot.stop() // nocauteado: o poder em uso acaba
  if (ultSlot.active !== 'shockwave') shockCast = null // (cancela a onda no meio)
  if (ultSlot.update(dt) === 'expired') announce('⚡ ULT EXPIRED', 'not used in time', 'enemy')

  // Onda de choque: a frente anda pela faixa e acerta quem estiver nela
  if (shockCast) {
    for (const h of shockCast.update(dt, ultTargets())) {
      const damage = scaleDamage(h.damage, myLevel)
      net.sendHit({ target: h.id, ix: h.dx * h.push, iz: h.dz * h.push, damage, boosted: true, blast: true })
      scoreUI.popup(remotes.get(h.id).car.root.position, 'blast', damage)
    }
    if (shockCast.done) shockCast = null
  }

  if (ultSlot.active !== 'overcharge') return
  // Raios em quem estiver no círculo
  for (const s of storm.update(dt, pos.x, pos.z, ultTargets())) {
    const target = remotes.get(s.id)
    const push = storm.spec.push
    const damage = scaleDamage(s.damage, myLevel)
    net.sendHit({ target: s.id, ix: s.dx * push, iz: s.dz * push, damage, boosted: false, stun: s.stun, zap: true })
    ultView.bolt(tmpBoltFrom.copy(pos).setY(2.6), tmpBoltTo.copy(target.car.root.position).setY(0.8))
    scoreUI.popup(target.car.root.position, s.stun ? 'stun' : 'zap', damage)
  }
}

// Desenho: feixe/item, círculos das tempestades, brilho e a faixa de aviso
function renderUltimate(dt) {
  activeStorms.length = 0
  const addStorm = (position, kind) => {
    const s = (stormPool[activeStorms.length] ??= {})
    s.position = position
    s.radius = ULTIMATES[kind].radius
    activeStorms.push(s)
  }
  if (ultSlot.active === 'overcharge' && !health.isKO) addStorm(car.root.position, ultSlot.active)
  let enemyPowered = null
  for (const [id, p] of remotes.entries()) {
    if (!p.ult || p.ko || !p.car.hasState) continue
    if (p.ult === 'overcharge') addStorm(p.car.root.position, p.ult)
    enemyPowered ??= id
  }
  ultView.update(dt, { phase: ultimate.phase, storms: activeStorms, missiles: missileShots })

  // Brilho da carroceria: pulsa com o ultimate; azul no boost
  const pulse = 0.5 + 0.5 * Math.sin(performance.now() / 70)
  if (ultSlot.active && !health.isKO) {
    setUltimateGlow(bodyMaterials, pulse)
    glowing = 'ult'
  } else {
    const glow = car.isBoosting ? 'boost' : null
    if (glow !== glowing) {
      glowing = glow
      setBoostGlow(bodyMaterials, !!glow)
    }
  }
  remotes.updateGlow(pulse)
  playerHud.health.root.classList.toggle('stunned', loop.simTime < stunUntil)

  // Faixa no topo: anúncio recente > meu poder > poder de outro > item do centro
  const now = performance.now()
  const left = Math.max(0, Math.ceil(ultimate.timer))
  if (ultNews && now < ultNews.until) {
    ultBanner.show(ultNews)
  } else if (ultSlot.active) {
    ultBanner.show({ title: `⚡ ${ULTIMATES[ultSlot.active].name}! ${Math.ceil(ultSlot.activeLeft)}`, tone: 'mine' })
  } else if (enemyPowered) {
    const spec = ULTIMATES[remotes.get(enemyPowered).ult]
    ultBanner.show({ title: `⚡ ${playerName(enemyPowered)} · ${spec.name}`, sub: spec.enemyHint, tone: 'enemy' })
  } else if (ultimate.phase === 'warning') {
    ultBanner.show({ title: `⚡ ULTIMATE IN ${left}`, sub: 'at the center of the arena', tone: 'warn' })
  } else if (ultimate.phase === 'available') {
    const sub = ultSlot.canPickUp ? 'drive over it to grab it' : 'your ult slot is full'
    ultBanner.show({ title: `⚡ ${ULTIMATES[ultimate.kind].name} AT THE CENTER!`, sub, tone: 'go' })
  } else {
    ultBanner.show(null)
  }
}

// --- Zona de cura ----------------------------------------------------------------------
function broadcastMedkit() {
  net.sendMedkit(medkit.snapshot())
  medResend = 0
}

function announceMedkit() {
  announce('💊 HEALING ZONE!', `stay inside: up to ${Math.round(MEDKIT.healOfMissing * 100)}% of missing HP in ${MEDKIT.duration}s`, 'heal')
}

// Carros na arena (eu e os outros, bonecos incluídos), com a vida
function playersWithHp() {
  const players = []
  if (!health.isKO) players.push({ x: car.root.position.x, z: car.root.position.z, hp: health.hp })
  for (const p of remotes.values()) {
    if (p.car.hasState && !p.ko) players.push({ x: p.car.root.position.x, z: p.car.root.position.z, hp: p.hp })
  }
  return players
}

// Perto da briga: centro a poucos metros de `target` (o ferido daquela briga)
function placeMedkit(target) {
  return placeNearFight(medkitSpots, [target])
}

// Quantos na sala (no campo de testes, os bonecos contam)
const playerCount = () => 1 + roster.size + (testMode ? dummies.size : 0)

// Passo fixo: o anfitrião sorteia; eu curo enquanto estou dentro
function updateMedkit(dt) {
  const host = amHost()
  const hurt = playersWithHp().filter((p) => p.hp <= MEDKIT.lowHp)
  const born = medkit.update(dt, host, { hurt, place: placeMedkit, maxZones: maxZonesFor(playerCount()) })
  if (born) {
    if (born.length) announceMedkit()
    broadcastMedkit()
  }
  if (host && (medResend += dt) >= 2) broadcastMedkit()

  const pos = car.root.position
  const inside = !health.isKO && medkit.contains(pos.x, pos.z)
  playerHud.health.root.classList.toggle('healing', inside)
  if (!inside) {
    zoneHeal.carry = 0
  } else {
    healShown += health.heal(zoneHeal.update(dt, health.hp, health.max))
  }
  // "+N VIDA" uma vez por segundo, somando o que curou
  healPopupTimer += dt
  if (healPopupTimer >= 1) {
    healPopupTimer = 0
    if (healShown > 0) scoreUI.popup(pos, 'heal', healShown)
    healShown = 0
  }
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
  getMaxFps: () => quality.maxFps,
  step(dt, simTime, wallTime) {
    orbs.update(dt)
    if (!car || !inMatch()) return // (fim de partida também: tudo para atrás do resultado)
    updateCountdown(dt)
    if (phase === 'playing' && !testMode) updateMatchClock(dt)
    const playing = phase === 'playing'
    car.savePrevious()
    if (health.update(dt)) respawn()
    if (net) updateProgression()
    if (playing && isDown('KeyR') && !health.isKO) car.reset()
    const stunned = simTime < stunUntil
    if (playing && !health.isKO && !stunned) updateBoost()
    // Nocauteado, atordoado ou na contagem não dirige, mas ainda pode ser empurrado
    // Lançando a Onda de choque: parado no lugar (ainda pode ser empurrado)
    // Míssil: parado também, mas pode girar para mirar
    const rooted = ultSlot.active === 'shockwave'
    const aiming = ultSlot.active === 'missile'
    const drive = !playing || health.isKO || stunned || rooted ? NO_INPUT : aiming ? { throttle: 0, steer: readDriveInput().steer } : readDriveInput()
    car.update(dt, drive)
    collideWalls(simTime)
    collideBats(simTime)
    if (net) {
      collideCars(simTime, wallTime)
      if (playing) updateUltimate(dt, stunned)
      if (playing) updateMedkit(dt)
      if (playing) updateMissiles(dt, simTime)
      sendState(dt, simTime)
      if (testMode) updateDummies(dt, simTime)
    }
  },

  render(dt, wallTime, alpha) {
    if (quality.showFps) fpsMeter.update()
    remotes?.sample(wallTime)
    remotes?.updatePresence(dt)
    if (car) presence.apply(car.root, presence.update(dt, !health.isKO))
    car?.beginRender(alpha) // pose interpolada entre os dois últimos passos
    groupCamera.update(dt, cameraSubjects())
    applyShake(dt)
    if (car && inMatch()) sparks.update(dt, sparkEmitters())
    if (car && inMatch()) renderUltimate(dt)
    medViews.forEach((view, i) => view.update(dt, inMatch() ? medkit.zones[i] ?? null : null))
    matchClock.show(inMatch() && !testMode ? formatClock(matchLeft) : null, matchLeft <= 30)
    bats?.update(dt)
    tireWalls?.update(dt)
    sun.follow(groupCamera.center, Math.max(12, groupCamera.distance * 0.55))
    scoreUI.update(dt, camera) // depois da câmera: "+N" no lugar certo deste quadro
    if (car && inMatch()) carTags.update(camera, carTagSubjects())
    if (car && inMatch() && !health.isKO) itemArrows.update(camera, car.root.position, arrowItems())
    else itemArrows.hide()
    if (car && inMatch()) {
      playerHud.render({
        hp: health.hp,
        maxHp: health.max,
        level: myLevel,
        levelProgress: levelProgress(damageTally.get(net.selfId) ?? 0),
        ko: health.isKO,
        shielded: health.isShielded,
        koTimer: health.koTimer,
        boosts,
        boosting: car.isBoosting,
        boostLocked: boostLocked(),
        ult: {
          stored: ultSlot.kind && ULTIMATES[ultSlot.kind].name,
          ready: ultSlot.ready,
          charges: 1,
          storedLeft: ultSlot.storedLeft,
          active: ultSlot.active && ULTIMATES[ultSlot.active].name,
          activeLeft: ultSlot.activeLeft,
          cooldown: ultSlot.cooldown,
        },
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
const arenaCenter = { position: new THREE.Vector3(), velocity: new THREE.Vector3() }
function cameraSubjects() {
  if (!inMatch()) return arenaView
  subjects.length = 0
  if (car && !health.isKO) subjects.push(car)
  if (remotes) for (const { car: remote, ko } of remotes.values()) if (remote.hasState && !ko) subjects.push(remote)
  if (ultimate.phase === 'available') subjects.push(arenaCenter) // todo mundo vê onde está o item
  return subjects
}

// Haste de cada carro soltando faíscas conforme a velocidade (objetos
// reaproveitados a cada quadro)
const emitters = []
const emitterPool = []
function sparkEmitters() {
  emitters.length = 0
  const add = (body, velocity, boosting, powered) => {
    const e = (emitterPool[emitters.length] ??= {})
    e.tip = poleTip
    e.body = body
    e.velocity = velocity
    // 0 parado, 1 na velocidade máxima; o boost passa disso; o ultimate, muito
    e.power = velocity.length() / car.params.maxSpeed + (boosting ? 0.5 : 0) + (powered ? 2.5 : 0)
    emitters.push(e)
  }
  if (!health.isKO) add(car.body, car.velocity, car.isBoosting, isPowered(net.selfId))
  for (const [peerId, { car: remote, boosting, ko }] of remotes.entries()) {
    if (remote.hasState && !ko) add(remote.body, remote.velocity, boosting, isPowered(peerId))
  }
  return emitters
}

// Etiquetas dos carros (objetos reaproveitados a cada quadro). Somem no
// nocaute junto com o carro
const tagSubjects = []
const tagPool = []
// Itens que ganham seta (lista reaproveitada a cada quadro)
const arrowList = []
const arrowCenter = new THREE.Vector3()
function arrowItems() {
  arrowList.length = 0
  if (!boostLocked()) {
    for (const slot of orbs.slots) if (orbs.isActive(slot)) arrowList.push({ kind: 'boost', position: slot.mesh.position })
  }
  if (ultimate.phase === 'available' && ultSlot.canPickUp) arrowList.push({ kind: 'ultimate', position: arrowCenter })
  return arrowList
}

function carTagSubjects() {
  tagSubjects.length = 0
  const add = (id, name, hp, position, visible) => {
    const s = (tagPool[tagSubjects.length] ??= {})
    s.id = id
    s.name = name
    s.hp = hp
    s.maxHp = maxHealthFor(levelOf(id))
    s.position = position
    s.visible = visible
    s.powered = isPowered(id)
    tagSubjects.push(s)
  }
  add(net.selfId, '', health.hp, car.root.position, !health.isKO) // o meu: só a barra
  for (const [peerId, player] of remotes.entries()) {
    const name = playerName(peerId)
    const tag = `${name} · Lv${levelOf(peerId)}`
    add(peerId, isPowered(peerId) ? `⚡ ${tag}` : tag, player.hp, player.car.root.position, player.car.hasState && !player.ko)
  }
  return tagSubjects
}

let scoreboardTimer = 0
function renderScoreboard(dt) {
  const open = isDown('Tab') && inMatch()
  scoreUI.setVisible(open)
  if (!open) return
  scoreboardTimer += dt
  if (scoreboardTimer < 0.25) return // 4x por segundo basta
  scoreboardTimer = 0
  const tally = currentKills()
  const assists = currentAssists()
  const players = [{ name: myName || 'You', color: swatch(readColors(bodyMaterials)), hp: health.hp, maxHp: health.max, level: myLevel, ko: health.isKO, isMe: true, kills: tally.get(net.selfId) ?? 0, assists: assists.get(net.selfId) ?? 0, deaths: kills.deaths }]
  for (const [peerId, player] of remotes.entries()) {
    players.push({
      name: playerName(peerId),
      color: swatch(remotes.colors(player)),
      hp: player.hp,
      maxHp: maxHealthFor(levelOf(peerId)),
      level: levelOf(peerId),
      ko: player.ko,
      isMe: false,
      kills: tally.get(peerId) ?? 0,
      assists: assists.get(peerId) ?? 0,
      deaths: player.deaths ?? 0,
    })
  }
  scoreUI.render(players)
}

// --- Partida: relógio, placar e fim --------------------------------------------------------
// Abates de todos: soma o "quem me nocauteou" de todo mundo (inclusive de
// quem já saiu)
function currentKills() {
  return tallyKills([kills, ...remotes.values(), ...departed.values()])
}

// XP ganho por todos (base do nível)
function currentXp() {
  return tallyXp([kills, ...remotes.values(), ...departed.values()])
}

function currentAssists() {
  return tallyAssists([kills, ...remotes.values(), ...departed.values()])
}

// Passo fixo: níveis de todos pelo placar; subi de nível = mais vida máxima
// (a vida sobe junto) e aviso na tela. Os bonecos sobem do mesmo jeito
function updateProgression() {
  damageTally = currentXp()
  const level = levelOf(net.selfId)
  if (level > myLevel) {
    health.setMax(maxHealthFor(level))
    scoreUI.popup(car.root.position, 'levelup', level)
    announce(`⬆ LEVEL ${level}!`, `damage x${damageScale(level).toFixed(1)} · max HP ${health.max}`, 'levelup')
  }
  myLevel = level
  for (const d of dummies.values()) d.health.setMax(maxHealthFor(levelOf(d.id)))
}

// Passo fixo: conta o tempo; o anfitrião acerta o relógio dos outros a cada 2 s
function updateMatchClock(dt) {
  matchLeft -= dt
  const host = amHost()
  if (host && (matchResend += dt) >= 2) {
    matchResend = 0
    net.sendMatch({ left: Math.max(0, matchLeft), over: false })
  }
  if (matchLeft <= 0) endMatch()
}

// Fim: carros param, aparece quem venceu e o placar de todos
function endMatch() {
  if (phase === 'over' || !inMatch()) return
  phase = 'over'
  matchLeft = 0
  if (amHost()) net.sendMatch({ left: 0, over: true })
  ultSlot.stop()
  car.speedScale = 1
  const tally = currentKills()
  const assists = currentAssists()
  const rows = [{ id: net.selfId, name: myName || 'You', kills: tally.get(net.selfId) ?? 0, assists: assists.get(net.selfId) ?? 0, deaths: kills.deaths, me: true }]
  for (const [peerId, p] of remotes.entries()) {
    rows.push({ id: peerId, name: playerName(peerId), kills: tally.get(peerId) ?? 0, assists: assists.get(peerId) ?? 0, deaths: p.deaths ?? 0, me: false })
  }
  for (const [peerId, p] of departed) rows.push({ id: peerId, name: `${p.name} (left)`, kills: tally.get(peerId) ?? 0, assists: assists.get(peerId) ?? 0, deaths: p.deaths, me: false })
  const ranked = standings(rows)
  menu.showResults(ranked, {
    winnerIds: new Set(winners(ranked).map((p) => p.id)),
    isHost: amHost(),
    onAgain: playAgain,
    onLeave: () => location.assign(location.pathname),
  })
}

// Anfitrião: outra partida com mapa novo, placar zerado
function playAgain() {
  if (phase !== 'over' || !amHost()) return
  const map = newLayout()
  net.sendStart(map)
  beginMatch(map)
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
  ultView.setSize(window.innerWidth, window.innerHeight, renderer.getPixelRatio())
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
