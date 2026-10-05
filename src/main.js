import * as THREE from 'three'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import Stats from 'three/examples/jsm/libs/stats.module.js'
import { toonify, toonGlobals, createToonMaterial } from './toon.js'
import { ScreenOutline } from './outline.js'
import { Background, Sun, Arena } from './environment.js'
import { GroupCamera } from './groupCamera.js'
import { ControlPanel } from './panel.js'
import { ScoreUI, PlayerHud, CarTags, ItemArrows, UltimateBanner, MatchClock, KillFeed } from './hud.js'
import { buildStats, buildReport, LevelTimer } from './matchStats.js'
import { KillTracker, MATCH_TIME, tallyKills, tallyXp, tallyAssists, standings, winners, formatClock } from './match.js'
import { levelFor, levelProgress, damageScale, scaleDamage, maxHealthFor, xpForHit, xpForKill, xpForAssist, repeatScale } from './progression.js'
import { FixedStepLoop } from './loop.js'
import { Car } from './car.js'
import { readDriveInput, isDown, wasPressed } from './input.js'
import { joinArena } from './net.js'
import { syncClock } from './clock.js'
import { RemotePlayers } from './remotePlayers.js'
import { measureFootprint, testCars, testArenaWalls } from './collision.js'
import { Orbs, orbCountFor } from './orbs.js'
import { SparkEffects, findPoleTip } from './sparks.js'
import { buildFunnyCar } from './shapes.js'
import { SpikedBats, extractProp, placeBats } from './bats.js'
import { TireWalls, placeTireWalls, prepareTireWall } from './tireWalls.js'
import { spawnPoints, cornerPoints, cornerIndex, chooseRespawn, yawToCenter } from './spawns.js'
import { distanceToSegment } from './collision.js'
import { newLayout, shouldAdopt } from './layout.js'
import { Presence } from './presence.js'
import { MenuUI } from './menu.js'
import { newRoomCode, normalizeCode, hostOf } from './lobby.js'
import { pickLivery, readColors, swatch, setBoostGlow, setUltimateGlow, MATERIAL_GROUPS, DEFAULT_GROUP, materialGroup } from './paint.js'
import { UltimateDirector, UltimateSlot, StormStrikes, ShockwaveCast, MissileShot, ambushStrikes, ULTIMATES, ULT_KINDS, ULT_PICKUP_RADIUS, storeTimeFor } from './ultimate.js'
import { UltimateView } from './ultimateView.js'
import { MedkitDirector, MEDKIT, ZoneHealing, placeNearFight, maxZonesFor } from './medkit.js'
import { MedkitView } from './medkitView.js'
import { TrainingDummy, TestPanel, localNet, DUMMY_SPOTS, TEST_SPAWN } from './testRange.js'
import { BotBrain, BOT_SKILLS, BOT_KINDS, BOT_NAMES } from './bots.js'
import {
  judgeHit, impactTier, tierOfDamage, DAMAGE, damageParams, MIN_IMPULSE, HEAD_ON_MIN, HitCooldown, RamLedger, Health, MAX_HEALTH,
  PushChain, chainDamage, CHAIN_FALLOFF, BOOST_PUSH, WALL_DAMAGE, WALL_DAMAGE_WINDOW, WALL_DAMAGE_MIN_SPEED, SPIKE_MIN_SPEED,
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
const BOOST_REACH = 0.25 // m: com boost o carro acerta um pouco antes de encostar
const BAT_RADIUS = 0.7  // m: corpo + boa parte dos espinhos
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
// Bots na partida online (bots.js): o anfitrião simula e manda o estado deles
// para a sala. A partida tem MATCH_CARS carros no total: os bots completam o que
// falta depois dos jogadores. Uma dificuldade por bot, nesta ordem
const MATCH_CARS = 8
const BOT_KINDS_ORDER = ['easy', 'normal', 'normal', 'hard', 'normal', 'hard', 'easy', 'normal']
const matchBots = (humans) => BOT_KINDS_ORDER.slice(0, Math.max(0, MATCH_CARS - humans))

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
  const humans = 1 + roster.size
  orbs.setCount(orbCountFor(testMode ? humans : Math.max(MATCH_CARS, humans)))
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
  onEndMatch: () => endMatch(),
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
// Partida (match.js): 6 min, ganha quem tiver mais abates. O placar sai do
// "quem me nocauteou" (koBy) de cada um; o relógio é do anfitrião
const kills = new KillTracker() // minhas mortes e quem me abateu
let matchLeft = MATCH_TIME      // s até acabar
let matchResend = 0             // anfitrião: reenvia o relógio de tempos em tempos
const departed = new Map()      // quem saiu no meio: { name, koBy, deaths } (os números ficam)
// Progressão (progression.js): o dano causado acumulado sobe o nível (mais
// dano e mais vida). O nível de todos sai do placar, recalculado a cada passo
let damageTally = new Map()     // id -> XP ganho
let myLevel = 1
const levelTimer = new LevelTimer() // só para o relatório de teste (matchStats.js)
let playTime = 0 // s de partida valendo (sem a contagem)
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
// Batida de frente entre jogadores: o dano é igual para os dois (damage.js)
const rams = new RamLedger()
// Batida entre carros (não golpe de ultimate nem de bot): entra na conta da batida de frente
const isRam = (hit) => !hit.by && !hit.chain && !hit.zap && !hit.rocket && !hit.blast && !hit.slam
// Quem me empurrou por último: se eu bater em alguém logo depois, o dano é dele (damage.js)
const pushChain = new PushChain()
const batCooldown = new HitCooldown() // por bastão: um choque não conta várias vezes
const tmpImpulse = new THREE.Vector3()

// --- Carregamento do carro -----------------------------------------------------
// Forma alternativa do carrinho (só local, não vai pela rede): ?forma na URL
const ALT_SHAPE = new URLSearchParams(location.search).has('forma')
const loadCarModel = ALT_SHAPE
  ? () => Promise.resolve({ scene: buildFunnyCar(carMaterials.map((m) => m.material)) })
  : () => new GLTFLoader().loadAsync(MODEL_URL)
loadCarModel().then(
  (gltf) => {
    const model = gltf.scene
    if (!ALT_SHAPE) toonify(model, (source) => {
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
    const poleMarker = model.getObjectByName('poleTip')
    poleTip = poleMarker ? car.body.worldToLocal(poleMarker.getWorldPosition(new THREE.Vector3())) : findPoleTip(model, car.body)
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
    ultView.setSpikeModel(template) // a Onda de choque são bastões saindo do chão
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
// vale sempre. `creditId`: de quem é o dano (em batida em cadeia, quem
// empurrou o carro que me acertou; senão o próprio `attackerId`)
function receiveHit(hit, attackerId, creditId = attackerId) {
  const now = loop.simTime
  if (!hitsSent.recent(attackerId, now)) {
    hitCooldown.ready(attackerId, now)
    car.applyImpulse(new THREE.Vector3(hit.ix, 0, hit.iz))
  }
  let damage = hit.damage
  if (isRam(hit)) {
    // Batida de frente: o dano que eu levo é o mesmo que o outro leva
    const ram = rams.received(attackerId, hit, now, { iAmLower: net.selfId < attackerId })
    damage = ram.apply
    if (ram.echo !== null) net.sendHit({ target: attackerId, ix: 0, iz: 0, damage: ram.echo, mutual: true })
    if (hit.mutual && damage) scoreUI.popup(car.root.position, tierOfDamage(damage), damage)
  }
  if (hit.boosted) boostedUntil = now + WALL_DAMAGE_WINDOW
  if (hit.blast) blastUntil = now + WALL_DAMAGE_WINDOW
  if (hit.stun && !health.isShielded) stunUntil = Math.max(stunUntil, now + hit.stun)
  if (!hit.mutual) pushChain.pushed(creditId, hit.relay ?? 0, now, hit.ix, hit.iz)
  kills.noteHit(creditId, now) // se eu cair (até de parede/espinho), o abate é dele
  takeDamage(damage, creditId)
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
    if (killer) for (const id of kills.assisters) kills.noteXp(id, Math.round(xpForAssist(levelOf(id), myLevel) * killRepeat))
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

// Começa já na tela inicial: até o jogador entrar numa sala, a hora já veio
const clockSynced = syncClock()

async function enterRoom(code, name) {
  await clockSynced // relógio errado = relays recusam e ninguém se conecta
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
  if (!testMode) clearMatchBots() // os da partida anterior saem
  for (const d of dummies.values()) {
    d.kills.reset()
    d.revive()
  }
  health.reset()
  damageTally = new Map()
  myLevel = 1
  levelTimer.reset()
  playTime = 0
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
  // Bots: quem cria é o anfitrião; nascem longe dos cantos (onde estão os jogadores)
  if (!testMode && !late && amHost()) {
    const humans = 1 + [...roster.values()].filter((r) => r.phase === 'lobby' || r.phase === 'playing').length
    matchBots(humans).forEach((kind, i) => addBot(kind, `bot-${i + 1}`, corners))
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
    onHit(hit, sender) {
      // Batida de um bot: o anfitrião manda, mas quem bateu foi o bot
      const attackerId = hit.by && sender === hostId() ? hit.by : sender
      // Batida em cadeia: quem bateu tinha sido empurrado; o dano é de quem empurrou
      const creditId = hit.chain ?? attackerId
      // Alguém acertou um bot que eu simulo (sou o anfitrião): aplico nele
      const bot = dummies.get(hit.target)
      if (bot && inMatch()) damageDummy(bot, hit, creditId)
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
        // Em cadeia, a faixa sai do dano antes da redução
        const full = hit.chain ? hit.damage / CHAIN_FALLOFF ** hit.relay : hit.damage
        scoreUI.popup(position, hit.boosted ? 'turbo' : tierOfDamage(full, damageScale(levelOf(creditId))), hit.damage)
      }
      if (hit.target === net.selfId && inMatch()) receiveHit(hit, attackerId, creditId)
    },
    // Bots da partida: o estado vem do anfitrião, como o de um jogador
    onBots({ list }, peerId) {
      if (!inMatch() || testMode || peerId !== hostId()) return
      if (botsHost !== peerId) clearMatchBots() // anfitrião novo: relógio novo, histórico novo
      botsHost = peerId
      const ids = new Set(list.map((b) => b.id))
      for (const id of netBots.keys()) {
        if (ids.has(id)) continue
        netBots.delete(id)
        remotes?.remove(id)
      }
      for (const { id, name, kind, state } of list) {
        netBots.set(id, { name, kind })
        handlePeerState(id, state)
      }
    },
    // Alguém bateu na parede depois de levar um boost (o dano já foi
    // descontado por ele; aqui é só para mostrar)
    onWall(wall, peerId) {
      const position = positionOf(peerId)
      if (wall.damage && position) scoreUI.popup(position, 'wall', wall.damage)
    },
  })

  // Minhas batidas em bots que eu mesmo simulo (sou o anfitrião) não voltam
  // pela rede: aplico aqui também
  const sendHit = net.sendHit
  net.sendHit = (hit) => {
    sendHit(hit)
    if (dummies.has(hit.target)) hitDummy(hit)
  }

  exposeDebug()
}

// Estado do carro de outro jogador (ou de um boneco do campo de testes)
function handlePeerState(peerId, state) {
  if (!remotes) return // carro ainda carregando
  const { player, liveryChanged, knockedOut, ultStarted, slammed, missilesFired: fired, killedBy } = remotes.applyState(peerId, state, performance.now() / 1000)
  // Kill feed: quem abateu esse jogador desde o último estado
  for (const killer of killedBy) killFeed.add(killer === net.selfId ? 'You' : playerName(killer), playerName(peerId), killer === net.selfId)
  if (knockedOut) scoreUI.popup(player.car.position, 'ko')
  if (slammed) showSlam(player.car.root.position)
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
// vítima espera essa mensagem). Empate (ex.: de frente): cada um aplica o
// próprio ricochete e os dois levam o MESMO dano (RamLedger: quem tem o menor
// id decide). Nocauteado não causa dano.
function collideCars(simTime, wallTime) {
  if (health.isKO) return // sumido no nocaute: ninguém bate em mim
  for (const [peerId, { car: remote, ko }] of remotes.entries()) {
    if (!remote.hasState || ko) continue // o outro está sumido
    remote.sample(wallTime)
    const dummy = dummies.get(peerId) // boneco/bot que eu simulo (campo de testes ou anfitrião)
    const boosting = car.isBoosting || dummy?.car.isBoosting
    const hit = testCars(car.root.position, car.yaw, remote.root.position, remote.yaw, footprint, boosting ? BOOST_REACH : 0)
    if (!hit) continue
    car.separate(hit.normal, hit.depth)
    // Emboscada: encostar em alguém invisível é a hora da batida de área (na
    // hora; o contato em si não vira batida normal)
    if (ultSlot.strike()) {
      slamAmbush()
      hitCooldown.ready(peerId, simTime)
      hitsSent.ready(peerId, simTime)
      continue
    }
    if (dummy?.ult?.strike()) {
      botSlam(dummy)
      dummy.hitCooldown.ready('eu', simTime)
      hitCooldown.ready(peerId, simTime)
      continue
    }

    // Entre jogadores, os dois vindo um para cima do outro é batida de frente (mesmo dano para os dois)
    const judged = judgeHit(hit.normal, car.velocity, remote.velocity, dummy ? Infinity : HEAD_ON_MIN)
    if (judged.role === 'victim') {
      // A força da batida é a dele vindo para cima de mim
      if (dummy) dummyHitsMe(dummy, hit.normal, remote.velocity.dot(hit.normal), simTime)
      continue
    }
    const impulse = car.collisionImpulse(hit.normal, remote.velocity)
    if (impulse < MIN_IMPULSE || !hitCooldown.ready(peerId, simTime)) continue

    // Com boost: tira mais, arremessa mais longe e o boost acaba na batida
    const boosted = car.isBoosting
    car.applyImpulse(tmpImpulse.copy(hit.normal).multiplyScalar(impulse))
    // Empate com um bot: ele também ricocheteia (um jogador faria isso do lado dele)
    if (judged.role === 'tie' && dummy?.isBot) dummy.car.applyImpulse(tmpImpulse.copy(hit.normal).multiplyScalar(-impulse))
    const evenTie = judged.role === 'tie' && !boosted
    const iAmLower = net.selfId < peerId
    if (evenTie) {
      if (dummy) continue // bots: sem dano no empate
      if (!iAmLower) {
        // O dano vem de quem tem o menor id; se ele já me bateu "normal", devolvo o eco
        const echo = rams.noteTie(peerId, simTime)
        if (echo !== null) net.sendHit({ target: peerId, ix: 0, iz: 0, damage: echo, mutual: true })
        continue
      }
    }
    // Sem dano se eu estou nocauteado ou se o outro está fora/protegido
    const target = remotes.get(peerId)
    const immune = health.isKO || target.ko || target.shield || (evenTie && health.isShielded)
    const tier = boosted ? 'turbo' : impactTier(evenTie ? (judged.impact + judged.theirs) / 2 : judged.impact)
    // Ricochete do empurrão que levei (sem boost): a batida é de quem me empurrou, reduzida
    const chain = boosted || evenTie ? null : pushChain.ricochet(peerId, simTime, -hit.normal.x, -hit.normal.z)
    // Empate: a média dos dois níveis, para o dano ser o mesmo para os dois
    const base = chain ? chainDamage(scaleDamage(DAMAGE[tier] ?? 0, levelOf(chain.owner)), chain.relay)
      : evenTie ? Math.round((scaleDamage(DAMAGE[tier] ?? 0, myLevel) + scaleDamage(DAMAGE[tier] ?? 0, levelOf(peerId))) / 2)
      : scaleDamage(DAMAGE[tier] ?? 0, myLevel)
    let damage = immune || !tier ? 0 : base
    let mutual = false
    if (!dummy && iAmLower && !chain) {
      const ram = rams.sending(peerId, damage, simTime, { tie: evenTie })
      damage = ram.damage
      mutual = ram.mutual
      if (ram.selfApply) {
        if (damage) scoreUI.popup(car.root.position, tier, damage)
        takeDamage(damage, peerId)
      }
    }
    const push = evenTie ? 0 : impulse * (boosted ? BOOST_PUSH : 1) // a vítima vai no sentido oposto
    net.sendHit({ target: peerId, ix: -hit.normal.x * push, iz: -hit.normal.z * push, damage, boosted, mutual, ...(chain && { chain: chain.owner, relay: chain.relay }) })
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
    ghost: ultSlot.ghost, // Emboscada: os outros param de me desenhar
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
    bots: BOT_KINDS.map((kind) => ({ kind, label: BOT_SKILLS[kind].label })),
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
      addBot,
      removeBots,
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
  if (d) damageDummy(d, hit, hit.chain ?? hit.by ?? net.selfId)
}

// Empurrão e dano num boneco/bot; o XP vai para `attackerId` (eu ou um bot)
function damageDummy(d, hit, attackerId) {
  const attacker = levelOf(attackerId)
  const victim = levelOf(d.id)
  const repeat = repeatScale(d.kills.sinceKoBy(attackerId, loop.simTime))
  d.receive(
    hit, loop.simTime, attackerId,
    (dealt) => Math.round(xpForHit(dealt, attacker, victim) * repeat),
    Math.round(xpForKill(attacker, victim) * repeat),
  )
}

// Boneco novo no primeiro lugar livre (sem boneco nem obstáculo)
function addDummy() {
  const taken = (s) => [...dummies.values()].some((d) => d.spot === s)
  const spot = DUMMY_SPOTS.find((s) => !taken(s) && isFree(s.x, s.z))
  if (!spot) return
  const n = [...dummies.values()].filter((d) => !d.isBot).length + 1
  // Física de carro de verdade (mesmos parâmetros do meu), sem modelo visível:
  // o desenho é o carro remoto, como o de qualquer jogador
  const body = new Car(new THREE.Object3D())
  body.params = car.params
  const dummy = new TrainingDummy(`boneco-${++dummySerial}`, n === 1 ? 'Training Dummy' : `Dummy ${n}`, body, spot)
  dummies.set(dummy.id, dummy)
}
let dummySerial = 0 // ids únicos (bots saem e entram)

// Bot novo (bots.js): nasce no ponto mais vazio, com pintura própria
// `avoid`: pontos ocupados além dos carros (ex.: cantos no início da partida)
function addBot(kind, id = `bot-${++dummySerial}`, avoid = []) {
  if (!car) return null
  const used = new Set([...dummies.values()].map((d) => d.botName))
  const botName = BOT_NAMES.find((n) => !used.has(n)) ?? `${dummies.size + 1}`
  const body = new Car(new THREE.Object3D())
  body.params = car.params
  const bot = new TrainingDummy(id, `Bot ${botName}`, body, { ...TEST_SPAWN, yaw: 0 })
  bot.botName = botName
  bot.brain = new BotBrain(kind)
  bot.ult = new UltimateSlot()
  bot.storm = new StormStrikes(ULTIMATES.overcharge)
  const paint = pickLivery([livery?.name, ...(remotes?.liveries() ?? []), ...[...dummies.values()].map((d) => d.livery)])
  bot.livery = paint.name
  bot.colors = [paint.primary, paint.secondary]
  dummies.set(bot.id, bot)
  placeBot(bot, avoid)
  return bot
}

// --- Bots nas partidas online -----------------------------------------------------
// O anfitrião simula os bots (dummies, como no campo de testes) e manda o
// estado deles 20x por segundo; os outros desenham como jogadores remotos e
// mandam as batidas neles para o anfitrião. Se o anfitrião sai, o próximo
// assume os bots de onde estavam (vida e placar incluídos).
const netBots = new Map() // bots de outro anfitrião: id -> { name, kind }
let botsHost = null       // de quem vêm os bots que estou vendo
let botsTimer = 0

function hostId() {
  const members = [{ id: net.selfId, since: joinedAt }]
  for (const [id, r] of roster) members.push({ id, since: r.since })
  return hostOf(members)
}

// Tira todos os bots (os que eu simulo e os que vêm da rede)
function clearMatchBots() {
  removeBots()
  for (const id of netBots.keys()) remotes?.remove(id)
  netBots.clear()
  botsHost = null
}

// Virei anfitrião com bots de outro na tela: passo a simular eles de onde estão
function adoptBots() {
  const seen = new Map([...netBots].map(([id, info]) => [id, { ...info, player: remotes.get(id) }]))
  netBots.clear()
  botsHost = null
  for (const [id, { kind, player }] of seen) {
    remotes.remove(id) // relógio de simulação novo (o meu): o desenho começa do zero
    const bot = addBot(kind, id)
    if (!bot || !player) continue
    const pos = player.car.root.position
    bot.car.spawn.set(pos.x, 0, pos.z)
    bot.car.spawnYaw = player.car.yaw
    bot.car.reset()
    bot.health.hp = Math.max(1, player.hp)
    Object.assign(bot.kills, { deaths: player.deaths ?? 0, koBy: { ...player.koBy }, asBy: { ...player.asBy }, xpBy: { ...player.xpBy } })
  }
}

// Passo fixo (partida online): o anfitrião simula e manda os bots
function updateMatchBots(dt, simTime, wallTime) {
  const host = amHost()
  if (host && !dummies.size && netBots.size) adoptBots()
  if (!host && dummies.size) removeBots() // achei que era o anfitrião, mas não sou
  if (!dummies.size) return
  updateDummies(dt, simTime)
  collideBotsWithPlayers(simTime, wallTime)
  botsTimer += dt
  if (botsTimer < NET_SEND_INTERVAL) return
  botsTimer %= NET_SEND_INTERVAL
  const list = []
  for (const d of dummies.values()) if (d.isBot) list.push({ id: d.id, name: d.name, kind: d.brain.kind, state: d.state(simTime) })
  net.sendBots({ list })
}

// Bot contra os outros jogadores (o meu carro já é tratado em collideCars).
// Como um jogador faria do lado dele: o bot só resolve quando é ele quem bate
// (manda o empurrão e o dano); se apanhou, o outro jogador manda a batida
function collideBotsWithPlayers(simTime, wallTime) {
  for (const [peerId, { car: remote, ko, shield }] of remotes.entries()) {
    if (dummies.has(peerId) || !remote.hasState || ko) continue
    remote.sample(wallTime)
    for (const bot of dummies.values()) {
      if (!bot.isBot || bot.health.isKO) continue
      const c = bot.car
      const hit = testCars(c.root.position, c.yaw, remote.root.position, remote.yaw, footprint, c.isBoosting ? BOOST_REACH : 0)
      if (!hit) continue
      c.separate(hit.normal, hit.depth)
      if (bot.ult.strike()) { // Emboscada: encostou invisível, bate na hora
        botSlam(bot)
        bot.hitCooldown.ready(peerId, simTime)
        continue
      }
      const judged = judgeHit(hit.normal, c.velocity, remote.velocity)
      if (judged.role === 'victim') continue
      const impulse = c.collisionImpulse(hit.normal, remote.velocity)
      if (impulse < MIN_IMPULSE || !bot.hitCooldown.ready(peerId, simTime)) continue
      const boosted = c.isBoosting
      c.applyImpulse(tmpImpulse.copy(hit.normal).multiplyScalar(impulse))
      if (judged.role === 'tie' && !boosted) continue
      const tier = boosted ? 'turbo' : impactTier(judged.impact)
      // Ricochete do bot arremessado no jogador: a batida é de quem empurrou o bot
      const chain = boosted ? null : bot.pushChain.ricochet(peerId, simTime, -hit.normal.x, -hit.normal.z)
      const base = chain ? chainDamage(scaleDamage(DAMAGE[tier] ?? 0, levelOf(chain.owner)), chain.relay) : scaleDamage(DAMAGE[tier] ?? 0, levelOf(bot.id))
      const damage = shield || !tier ? 0 : base
      const push = impulse * (boosted ? BOOST_PUSH : 1)
      net.sendHit({ target: peerId, ix: -hit.normal.x * push, iz: -hit.normal.z * push, damage, boosted, by: bot.id, ...(chain && { chain: chain.owner, relay: chain.relay }) })
      bot.brain.noteHit(peerId)
      if (boosted) c.endBoost()
      if (damage) scoreUI.popup(remote.root.position, tier, damage)
    }
  }
}

function removeBots() {
  for (const d of [...dummies.values()]) {
    if (!d.isBot) continue
    dummies.delete(d.id)
    remotes.remove(d.id)
  }
}

// Bot (re)nasce no ponto mais vazio, longe de onde caiu (spawns.js)
function placeBot(bot, avoid = []) {
  const enemies = [...avoid]
  if (!health.isKO) enemies.push({ x: car.root.position.x, z: car.root.position.z })
  for (const d of dummies.values()) if (d !== bot && !d.health.isKO) enemies.push({ x: d.x, z: d.z })
  for (const [id, p] of remotes.entries()) if (!dummies.has(id) && p.car.hasState && !p.ko) enemies.push({ x: p.car.root.position.x, z: p.car.root.position.z })
  const point = chooseRespawn(spawnSpots, { enemies, death: bot.deathSpot, last: bot.spot }) ?? TEST_SPAWN
  bot.spot = point
  bot.car.spawn.set(point.x, 0, point.z)
  bot.car.spawnYaw = yawToCenter(point.x, point.z)
  bot.car.reset()
}

// O que os bots "enxergam" da arena (bots.js: BotWorld), montado uma vez por passo
function botWorld() {
  const tireRadius = tireWalls?.radius ?? 0.7
  const tireHalf = Math.max(TIRE_HALF_LENGTH - tireRadius, 0)
  const obstacles = batSpots.map((b) => ({ a: [b.x, b.z], b: [b.x, b.z], r: BAT_RADIUS }))
  for (const w of tireSpots) {
    const dx = Math.cos(w.yaw) * tireHalf, dz = -Math.sin(w.yaw) * tireHalf
    obstacles.push({ a: [w.x - dx, w.z - dz], b: [w.x + dx, w.z + dz], r: tireRadius })
  }
  return {
    orbs: orbs.slots.filter((slot) => orbs.isActive(slot)).map((slot) => slot.mesh.position),
    heal: medkit.zones.map((z) => ({ x: z.x, z: z.z, radius: MEDKIT.radius })),
    obstacles,
    ult: { phase: ultimate.phase, timer: ultimate.timer, x: ultimate.x, z: ultimate.z },
    halfX: arena.halfX, halfZ: arena.halfZ,
    maxBoosts: MAX_BOOSTS, maxSpeed: car.params.maxSpeed, turnSpeed: car.params.turnSpeed,
  }
}

// Inimigos de um bot: eu, os outros jogadores e os outros bots (bonecos
// parados não interessam)
function botEnemies(bot) {
  const enemies = ultSlot.ghost ? [] : [{
    id: net.selfId, x: car.root.position.x, z: car.root.position.z, vx: car.velocity.x, vz: car.velocity.z,
    hp: health.hp, maxHp: health.max, ko: health.isKO, shield: health.isShielded, ult: ultSlot.active,
  }]
  for (const [id, p] of remotes.entries()) {
    if (dummies.has(id) || !p.car.hasState || p.ghost) continue
    const { position, velocity } = p.car
    enemies.push({ id, x: position.x, z: position.z, vx: velocity.x, vz: velocity.z, hp: p.hp, maxHp: maxHealthFor(levelOf(id)), ko: p.ko, shield: p.shield, ult: p.ult })
  }
  for (const d of dummies.values()) {
    if (d === bot || !d.isBot || d.ult?.ghost) continue
    enemies.push({
      id: d.id, x: d.x, z: d.z, vx: d.car.velocity.x, vz: d.car.velocity.z,
      hp: d.health.hp, maxHp: d.health.max, ko: d.health.isKO, shield: d.health.isShielded, ult: d.ult?.active,
    })
  }
  return enemies
}

// Bot dirige: o cérebro devolve pedal, volante e boost, como o teclado
function driveBot(bot, world, dt, simTime) {
  if (bot.health.isKO) return NO_INPUT
  // Pega esfera passando por cima (como eu)
  if (bot.boosts < MAX_BOOSTS) {
    const slot = orbs.findPickup(bot.car.root.position)
    if (slot) {
      net.sendPickup({ slot: slot.index, gen: slot.gen })
      orbs.take(slot.index, slot.gen)
      bot.boosts++
      scoreUI.popup(bot.car.root.position, 'pickup')
    }
  }
  if (phase !== 'playing') return NO_INPUT
  claimUltForBot(bot)
  // Atordoado, ou lançando a Onda de choque: parado
  if (simTime < bot.stunUntil || bot.ult.active === 'shockwave') return NO_INPUT
  const c = bot.car
  const slot = bot.ult
  const self = {
    x: bot.x, z: bot.z, yaw: c.yaw, yawRate: c.yawRate, speed: c.velocity.length(),
    hp: bot.health.hp, maxHp: bot.health.max, boosts: bot.boosts, boosting: c.isBoosting,
    ult: { stored: slot.kind, ready: slot.ready, active: slot.active, storedLeft: slot.storedLeft },
  }
  world.enemies = botEnemies(bot)
  const { throttle, steer, boost, ult } = bot.brain.think(dt, self, world)
  // Ultimate guardado ou em uso trava o boost (mesma regra do jogador)
  if (boost && bot.boosts > 0 && !c.isBoosting && !slot.kind && !slot.active) {
    bot.boosts--
    c.boost()
  }
  if (ult) castBotUlt(bot)
  return slot.active === 'missile' ? { throttle: 0, steer } : { throttle, steer }
}

// --- Ultimate dos bots -----------------------------------------------------------
// Mesmas regras do meu: pega no centro (o anfitrião concede), guarda, usa, e
// os golpes saem como os de um jogador (pela rede, com `by` = o bot). Quem
// simula é quem simula o bot (o anfitrião, ou eu no campo de testes)

// Bot passando no item: é dele (só o anfitrião concede)
function claimUltForBot(bot) {
  if (ultimate.phase !== 'available' || !bot.ult.canPickUp || !amHost()) return
  if (Math.hypot(bot.x - ultimate.x, bot.z - ultimate.z) >= ULT_PICKUP_RADIUS) return
  if (!ultimate.claim(bot.id)) return
  checkUltGiven()
  broadcastUlt()
}

function castBotUlt(bot) {
  const kind = bot.ult.activate()
  if (!kind) return
  const c = bot.car
  if (kind === 'overcharge') bot.storm.reset()
  if (kind === 'shockwave') {
    const dir = { x: Math.sin(c.yaw), z: Math.cos(c.yaw) }
    bot.shockCast = new ShockwaveCast(ULTIMATES.shockwave, { x: bot.x + dir.x * SHOCK_NOSE, z: bot.z + dir.z * SHOCK_NOSE }, dir)
    c.halt()
  }
  if (kind === 'missile') {
    c.halt()
    bot.missileShotsLeft = ULTIMATES.missile.shots
    bot.missileClock = 0
  }
}

// Alvos do ultimate de um bot: todos os outros carros (posições reais dos
// que eu simulo)
function botUltTargets(bot) {
  const list = []
  if (!health.isKO) list.push({ id: net.selfId, x: car.root.position.x, z: car.root.position.z, immune: health.isShielded })
  for (const d of dummies.values()) if (d !== bot && !d.health.isKO) list.push({ id: d.id, x: d.x, z: d.z, immune: d.health.isShielded })
  for (const [id, p] of remotes.entries()) {
    if (dummies.has(id) || !p.car.hasState || p.ko) continue
    list.push({ id, x: p.car.root.position.x, z: p.car.root.position.z, immune: p.shield })
  }
  return list
}

// Golpe do ultimate de um bot em `targetId`: vai pela rede como o de um
// jogador (bonecos/bots que eu simulo recebem na hora); se o alvo sou eu, aplico
function botUltHit(bot, targetId, hit, popup) {
  const full = { target: targetId, ...hit, by: bot.id }
  net.sendHit(full)
  if (targetId === net.selfId) receiveHit(full, bot.id)
  const position = positionOf(targetId) ?? dummies.get(targetId)?.car.root.position
  if (position) scoreUI.popup(position, popup, hit.damage)
  bot.brain.noteHit(targetId)
}

// Batida da Emboscada de um bot: dano + stun em quem estiver no círculo (o
// estouro aparece pelo estado dele, como o de um jogador)
function botSlam(bot) {
  const spec = ULTIMATES.ambush
  for (const h of ambushStrikes(spec, bot.x, bot.z, botUltTargets(bot))) {
    botUltHit(bot, h.id, { ix: 0, iz: 0, damage: scaleDamage(h.damage, levelOf(bot.id)), boosted: false, stun: h.stun, slam: true }, 'smash')
  }
}

// Passo fixo: relógio do inventário e os efeitos em andamento
function updateBotUltimate(bot, dt) {
  const slot = bot.ult
  if (bot.health.isKO) slot.stop()
  const wasAmbush = slot.active === 'ambush'
  if (slot.update(dt) === 'ended' && wasAmbush) botSlam(bot)
  if (slot.active !== 'shockwave') bot.shockCast = null
  if (slot.active !== 'missile') bot.missileShotsLeft = 0
  const scale = (damage) => scaleDamage(damage, levelOf(bot.id))
  if (bot.shockCast) {
    for (const h of bot.shockCast.update(dt, botUltTargets(bot))) {
      botUltHit(bot, h.id, { ix: h.dx * h.push, iz: h.dz * h.push, damage: scale(h.damage), boosted: true, blast: true }, 'blast')
    }
    if (bot.shockCast.done) bot.shockCast = null
  }
  // Rajada de mísseis: o contador vai no estado (todos lançam o míssil, eu
  // inclusive, em handlePeerState); o acerto é calculado em updateMissiles
  if (bot.missileShotsLeft > 0 && (bot.missileClock -= dt) <= 0) {
    bot.missileClock += ULTIMATES.missile.shotInterval
    bot.missileShotsLeft--
    bot.missilesFired++
  }
  if (slot.active !== 'overcharge') return
  const pos = bot.car.root.position
  for (const st of bot.storm.update(dt, pos.x, pos.z, botUltTargets(bot))) {
    const push = bot.storm.spec.push
    const to = positionOf(st.id) ?? dummies.get(st.id)?.car.root.position
    if (to) ultView.bolt(tmpBoltFrom.copy(pos).setY(2.6), tmpBoltTo.copy(to).setY(0.8))
    botUltHit(bot, st.id, { ix: st.dx * push, iz: st.dz * push, damage: scale(st.damage), boosted: false, stun: st.stun, zap: true }, st.stun ? 'stun' : 'zap')
  }
}

// Bonecos e bots: vida (volta do nocaute), direção dos bots e "estado pela
// rede" como um jogador
function updateDummies(dt, simTime) {
  const list = [...dummies.values()]
  const world = list.some((d) => d.isBot) ? botWorld() : null
  for (const d of list) {
    if (d.isBot && phase === 'playing') updateBotUltimate(d, dt)
    const input = d.isBot ? driveBot(d, world, dt, simTime) : NO_INPUT
    if (d.update(dt, input) && d.isBot) placeBot(d)
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
  // Boneco contra boneco: separa e troca o empurrão; se quem bateu é um bot,
  // a vítima leva dano (como numa batida entre jogadores)
  for (let i = 0; i < list.length; i++) {
    for (let j = i + 1; j < list.length; j++) {
      const a = list[i].car, b = list[j].car
      if (list[i].health.isKO || list[j].health.isKO) continue
      const hit = testCars(a.root.position, a.yaw, b.root.position, b.yaw, footprint, a.isBoosting || b.isBoosting ? BOOST_REACH : 0)
      if (!hit) continue
      a.separate(hit.normal, hit.depth / 2)
      b.separate(tmpImpulse.copy(hit.normal).negate(), hit.depth / 2)
      // Emboscada: quem estava invisível bate na hora (o contato não vira batida normal)
      const slamA = list[i].ult?.strike(), slamB = list[j].ult?.strike()
      if (slamA) botSlam(list[i])
      if (slamB) botSlam(list[j])
      if (slamA || slamB) {
        list[i].hitCooldown.ready(list[j].id, simTime)
        list[j].hitCooldown.ready(list[i].id, simTime)
        continue
      }
      const impulse = a.collisionImpulse(hit.normal, b.velocity)
      if (impulse <= 0) continue
      const judged = judgeHit(hit.normal, a.velocity, b.velocity) // antes do empurrão
      const bImpact = b.velocity.dot(hit.normal)
      a.applyImpulse(tmpImpulse.copy(hit.normal).multiplyScalar(impulse))
      b.applyImpulse(tmpImpulse.copy(hit.normal).multiplyScalar(-impulse))
      if (judged.role === 'aggressor') botHits(list[i], list[j], judged.impact, hit.normal, -1, simTime)
      if (judged.role === 'victim') botHits(list[j], list[i], bImpact, hit.normal, 1, simTime)
    }
  }
  for (const d of list) handlePeerState(d.id, d.state(simTime))
}

// Bot bateu em outro carro do campo (o empurrão normal já foi trocado): dano
// pela força da batida; com boost, TURBO e arremesso mais longe.
// `normal * side` aponta de quem bateu para a vítima. Boneco parado só causa
// dano no ricochete de um empurrão (batida em cadeia: o dano é de quem empurrou)
function botHits(atk, vic, impact, normal, side, simTime) {
  if (atk.hitCooldown.recent(vic.id, simTime)) return
  const boosted = atk.car.isBoosting
  const dx = normal.x * side, dz = normal.z * side
  const chain = boosted ? null : atk.pushChain.ricochet(vic.id, simTime, dx, dz)
  if (!atk.isBot && !chain) return
  atk.hitCooldown.ready(vic.id, simTime)
  const by = chain?.owner ?? atk.id
  const relay = chain?.relay ?? 0
  const tier = boosted ? 'turbo' : impactTier(impact)
  if (boosted) atk.car.endBoost()
  atk.brain?.noteHit(vic.id)
  if (!tier || vic.health.isShielded) {
    vic.pushChain.pushed(by, relay, simTime, dx, dz) // levou o empurrão mesmo sem dano
    return
  }
  const damage = chain ? chainDamage(scaleDamage(DAMAGE[tier], levelOf(by)), relay) : scaleDamage(DAMAGE[tier], levelOf(atk.id))
  const push = boosted ? impact * (BOOST_PUSH - 1) * side : 0
  damageDummy(vic, { ix: normal.x * push, iz: normal.z * push, damage, boosted, relay }, by)
  // O empurrão normal já foi trocado na física: o sentido dele vem da batida
  vic.pushChain.pushed(by, relay, simTime, dx, dz)
  scoreUI.popup(vic.car.root.position, tier, damage)
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
  // Bot com boost: arremessa mais longe, tira o TURBO e a mureta logo depois dói
  const boosted = d.car.isBoosting
  d.car.applyImpulse(tmpImpulse.copy(normal).multiplyScalar(-impulse))
  car.applyImpulse(tmpImpulse.copy(normal).multiplyScalar(impulse * (boosted ? BOOST_PUSH : 1)))
  // Arremessado em mim por alguém: a batida é de quem empurrou, reduzida
  // `normal` aponta do boneco para mim: é o sentido do ricochete dele e do meu empurrão
  const chain = boosted ? null : d.pushChain.ricochet(net.selfId, simTime, normal.x, normal.z)
  const by = chain?.owner ?? d.id
  pushChain.pushed(by, chain?.relay ?? 0, simTime, normal.x, normal.z)
  kills.noteHit(by, simTime) // se eu cair, o abate é dele
  d.brain?.noteHit(net.selfId)
  if (boosted) {
    d.car.endBoost()
    boostedUntil = simTime + WALL_DAMAGE_WINDOW
  }
  const tier = boosted ? 'turbo' : impactTier(impact)
  if (!tier || health.isShielded) return
  const damage = chain ? chainDamage(scaleDamage(DAMAGE[tier], levelOf(by)), chain.relay) : scaleDamage(DAMAGE[tier], levelOf(d.id))
  scoreUI.popup(car.root.position, tier, damage)
  takeDamage(damage, by)
}

// --- Ultimate ------------------------------------------------------------------------
const tmpBoltFrom = new THREE.Vector3()
const tmpBoltTo = new THREE.Vector3()
const stormTargets = []
const activeStorms = []
const stormPool = []
const activeSlams = []
const slamPool = []

const playerName = (peerId) =>
  dummies.get(peerId)?.name || netBots.get(peerId)?.name || roster.get(peerId)?.name || `Player ${peerId.slice(0, 4).toUpperCase()}`

// Ultimate guardado ou em uso trava o boost
const boostLocked = () => !!(ultSlot.kind || ultSlot.active)

// Com o ultimate em uso agora?
const isPowered = (id) => (id === net.selfId ? !!ultSlot.active : !!remotes?.get(id)?.ult)

// Anfitrião da sala (lobby.js): quem está há mais tempo. Decide o item do centro
function amHost() {
  return hostId() === net.selfId
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
    dummies.get(given.owner)?.ult?.give(given.kind) // um bot que eu simulo
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
    // O meu míssil (ou o de um bot que eu simulo) acerta quem estiver no
    // caminho (ele continua voando)
    const bot = owner !== mine && dummies.get(owner)?.isBot ? dummies.get(owner) : null
    for (const h of shot.update(dt, owner === mine ? ultTargets() : bot ? botUltTargets(bot) : [])) {
      if (bot) {
        botUltHit(bot, h.id, { ix: h.dx * h.push, iz: h.dz * h.push, damage: scaleDamage(h.damage, levelOf(bot.id)), boosted: false, rocket: true }, 'rocket')
        continue
      }
      const damage = scaleDamage(h.damage, myLevel)
      net.sendHit({ target: h.id, ix: h.dx * h.push, iz: h.dz * h.push, damage, boosted: false, rocket: true })
      scoreUI.popup(remotes.get(h.id).car.root.position, 'rocket', damage)
    }
  }
  // Bots no rastro de outro: lentos também
  for (const d of dummies.values()) {
    if (!d.isBot) continue
    if (!d.health.isKO && missiles.some((m) => m.owner !== d.id && m.shot.trailContains(d.x, d.z))) d.slowUntil = simTime + ULTIMATES.missile.slowLinger
    d.car.speedScale = simTime < (d.slowUntil ?? 0) ? ULTIMATES.missile.slow : 1
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
  if (ultimate.update(dt, host, medkitSpots)) broadcastUlt()
  // Anfitrião reenvia o estado a cada 2 s: corrige relógios e mensagens perdidas
  if (host && (ultResend += dt) >= 2) broadcastUlt()

  const pos = car.root.position
  // Pegar: vaga livre e passando no item (o pedido vai ao anfitrião)
  if (ultimate.phase === 'available' && ultSlot.canPickUp && !health.isKO && ultClaimed !== ultimate.n && Math.hypot(pos.x - ultimate.x, pos.z - ultimate.z) < ULT_PICKUP_RADIUS) {
    ultClaimed = ultimate.n
    if (!host) net.sendUltReq({ n: ultimate.n, op: 'claim' })
    else if (ultimate.claim(net.selfId)) {
      checkUltGiven()
      broadcastUlt()
    }
  }

  if (freeUltimate) {
    ultSlot.cooldown = 0
    if (ultSlot.kind) ultSlot.storedLeft = storeTimeFor(ultSlot.kind)
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
  const wasAmbush = ultSlot.active === 'ambush'
  const ended = ultSlot.update(dt)
  if (ended === 'expired') announce('⚡ ULT EXPIRED', 'not used in time', 'enemy')
  if (ended === 'ended' && wasAmbush) slamAmbush()

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

// Emboscada: o aviso acabou e eu bato em quem estiver no círculo (dano + stun,
// sem empurrão)
function slamAmbush() {
  const spec = ULTIMATES.ambush
  const pos = car.root.position
  for (const h of ambushStrikes(spec, pos.x, pos.z, ultTargets())) {
    const damage = scaleDamage(h.damage, myLevel)
    net.sendHit({ target: h.id, ix: 0, iz: 0, damage, boosted: false, stun: h.stun, slam: true })
    if (damage) scoreUI.popup(remotes.get(h.id).car.root.position, tierOfDamage(damage, damageScale(myLevel)), damage)
  }
  showSlam(pos)
}

// Invisível (Emboscada): para os outros o carro some de vez (state.ghost);
// para mim ele fica bem translúcido (com contorno, sem sombra). Os materiais são
// compartilhados com os carros dos outros, então o meu ganha cópias enquanto
// dura (e volta para os originais no fim)
const GHOST_OPACITY = 0.18
let ghostShown = false
function setGhostLook(on) {
  if (on === ghostShown) return
  ghostShown = on
  car.root.traverse((o) => {
    if (!o.isMesh || Array.isArray(o.material)) return
    if (on) {
      o.userData.solid = { material: o.material, castShadow: o.castShadow }
      const ghost = o.material.clone()
      ghost.transparent = true
      ghost.depthWrite = false
      if (ghost.uniforms?.uOpacity) ghost.uniforms.uOpacity.value = GHOST_OPACITY
      else ghost.opacity = GHOST_OPACITY
      o.material = ghost
      o.castShadow = false
    } else if (o.userData.solid) {
      o.material.dispose()
      o.material = o.userData.solid.material
      o.castShadow = o.userData.solid.castShadow
      delete o.userData.solid
    }
  })
}

// Escuridão (como a ult do Nocturne): alguém invisível na arena escurece a
// tela, com um pouco de visão em volta do meu carro. Para quem está invisível
// escurece menos (ele sabe onde está). Camada por cima da arena, embaixo do HUD
const darkness = document.createElement('div')
darkness.className = 'darkness'
renderer.domElement.after(darkness)
const tmpDark = new THREE.Vector3()
function updateDarkness() {
  let level = 0
  if (inMatch() && car && remotes) {
    for (const p of remotes.values()) if (p.ghost && !p.ko) level = 1
    if (ultSlot.ghost && !health.isKO) level = Math.max(level, 0.55)
  }
  darkness.style.opacity = level
  if (!level) return
  // Visão centrada no meu carro (onde ele está na tela)
  tmpDark.copy(car.root.position).project(camera)
  darkness.style.setProperty('--x', `${((tmpDark.x + 1) / 2) * 100}%`)
  darkness.style.setProperty('--y', `${((1 - tmpDark.y) / 2) * 100}%`)
}

// Estouro da batida (mais perto de mim, mais forte a tremida)
function showSlam(position) {
  const spec = ULTIMATES.ambush
  ultView.burst(position, spec.radius)
  const dist = Math.hypot(position.x - car.root.position.x, position.z - car.root.position.z)
  shake = Math.max(shake, 0.9 * Math.max(0, 1 - dist / (spec.radius * 4)))
}

// Desenho: feixe/item, círculos das tempestades, brilho e a faixa de aviso
function renderUltimate(dt) {
  activeSlams.length = 0
  const addSlam = (position) => {
    const s = (slamPool[activeSlams.length] ??= {})
    s.position = position
    s.radius = ULTIMATES.ambush.radius
    activeSlams.push(s)
  }
  if (ultSlot.active === 'ambush' && !ultSlot.ghost && !health.isKO) addSlam(car.root.position)
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
    if (p.ult === 'ambush' && !p.ghost) addSlam(p.car.root.position)
    enemyPowered ??= id
  }
  ultView.update(dt, { phase: ultimate.phase, x: ultimate.x, z: ultimate.z, storms: activeStorms, missiles: missileShots, slams: activeSlams })

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
    ultBanner.show({ title: `⚡ ULTIMATE IN ${left}`, sub: 'watch for the beam of light', tone: 'warn' })
  } else if (ultimate.phase === 'available') {
    const sub = ultSlot.canPickUp ? 'drive over it to grab it' : 'your ult slot is full'
    ultBanner.show({ title: `⚡ ${ULTIMATES[ultimate.kind].name} IS OUT!`, sub, tone: 'go' })
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
const playerCount = () => 1 + roster.size + Math.max(dummies.size, netBots.size)

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
    if (phase === 'playing') playTime += dt
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
      else updateMatchBots(dt, simTime, wallTime)
    }
  },

  render(dt, wallTime, alpha) {
    if (quality.showFps) fpsMeter.update()
    remotes?.sample(wallTime)
    remotes?.updatePresence(dt)
    if (car) presence.apply(car.root, presence.update(dt, !health.isKO))
    if (car) setGhostLook(ultSlot.ghost && !health.isKO)
    car?.beginRender(alpha) // pose interpolada entre os dois últimos passos
    groupCamera.update(dt, cameraSubjects(), car && inMatch() && !health.isKO ? car : null)
    applyShake(dt)
    if (car && inMatch()) sparks.update(dt, sparkEmitters())
    if (car && inMatch()) renderUltimate(dt)
    updateDarkness() // depois da câmera: a visão fica em cima do meu carro
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
  if (remotes) for (const { car: remote, ko, ghost } of remotes.values()) if (remote.hasState && !ko && !ghost) subjects.push(remote)
  if (ultimate.phase === 'available') {
    arenaCenter.position.set(ultimate.x, 0, ultimate.z)
    subjects.push(arenaCenter) // todo mundo vê onde está o item
  }
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
  if (ultimate.phase === 'available' && ultSlot.canPickUp) arrowList.push({ kind: 'ultimate', position: arrowCenter.set(ultimate.x, 0, ultimate.z) })
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
    add(peerId, isPowered(peerId) ? `⚡ ${tag}` : tag, player.hp, player.car.root.position, player.car.hasState && !player.ko && !player.ghost)
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
  if (import.meta.env.DEV && phase === 'playing') {
    levelTimer.update(net.selfId, level, playTime)
    for (const [id] of remotes.entries()) levelTimer.update(id, levelOf(id), playTime)
  }
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
  if (import.meta.env.DEV) saveMatchReport(ranked)
}

// Só no `npm run dev`: grava o relatório da partida em match-stats/ (vite.config.js)
function saveMatchReport(ranked) {
  const seconds = MATCH_TIME
  const stats = buildStats(ranked, { seconds, levelOf, xpOf: (id) => damageTally.get(id) ?? 0, levelTimesOf: (id) => levelTimer.timesOf(id) })
  const report = buildReport(stats, { seconds, balance: { DAMAGE, damageParams } })
  fetch('/__match-stats', { method: 'POST', body: JSON.stringify(report) })
    .then((r) => r.ok || console.error('match-stats:', r.status))
    .catch((err) => console.error('match-stats:', err))
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
