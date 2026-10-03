import * as THREE from 'three'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import GUI from 'three/examples/jsm/libs/lil-gui.module.min.js'
import { toonify, toonMesh, toonGlobals, createToonMaterial } from './toon.js'
import { ScreenOutline, outlineParams, outlineOptions } from './outline.js'
import { Car } from './car.js'
import { readDriveInput, isDown } from './input.js'
import { joinArena } from './net.js'
import { RemoteCar } from './remoteCar.js'
import { measureFootprint, testCars, testArenaWalls } from './collision.js'
import { judgeHit, impactPoints, scoreParams, MIN_IMPULSE, HitCooldown, ScoreUI } from './score.js'
import { pickLivery } from './liveries.js'

const MODEL_URL = `${import.meta.env.BASE_URL}models/BumpyCar.glb`
// Valores do painel salvos pelo botão "Salvar configurações"
const SETTINGS_URL = `${import.meta.env.BASE_URL}settings.json`
const savedSettings = fetch(SETTINGS_URL, { cache: 'no-store' })
  .then((r) => (r.ok ? r.json() : null))
  .catch(() => null)
// Giro aplicado ao modelo para a frente do carrinho apontar para +Z
const MODEL_YAW = 0

// --- Renderer ---------------------------------------------------------------
const canvas = document.getElementById('scene')
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true })
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
renderer.setSize(window.innerWidth, window.innerHeight)
// Sem tone mapping: ACES dessatura e "achata" as faixas do toon
renderer.toneMapping = THREE.NoToneMapping
renderer.shadowMap.enabled = true
renderer.shadowMap.type = THREE.PCFShadowMap

// --- Cena e câmera ----------------------------------------------------------
const scene = new THREE.Scene()

// --- Fundo: degradê radial partindo do centro da tela -----------------------
// Desenhado num canvas do tamanho (proporcional) da tela, para o círculo
// ficar redondo, e usado como textura de fundo da cena.
const bgParams = { center: '#5b6b8c', edge: '#05060a', radius: 0.75 }
const bgCanvas = document.createElement('canvas')
const bgTexture = new THREE.CanvasTexture(bgCanvas)
bgTexture.colorSpace = THREE.SRGBColorSpace
scene.background = bgTexture

function updateBackground() {
  const w = (bgCanvas.width = Math.max(1, Math.round(window.innerWidth / 2)))
  const h = (bgCanvas.height = Math.max(1, Math.round(window.innerHeight / 2)))
  const ctx = bgCanvas.getContext('2d')
  // radius = 1 faz a cor da borda chegar exatamente nos cantos da tela
  const r = Math.max(1, (Math.hypot(w, h) / 2) * bgParams.radius)
  const g = ctx.createRadialGradient(w / 2, h / 2, 0, w / 2, h / 2, r)
  g.addColorStop(0, bgParams.center)
  g.addColorStop(1, bgParams.edge)
  ctx.fillStyle = g
  ctx.fillRect(0, 0, w, h)
  bgTexture.needsUpdate = true
}
updateBackground()

const camera = new THREE.PerspectiveCamera(35, window.innerWidth / window.innerHeight, 0.1, 300)

const outline = new ScreenOutline(renderer, scene, camera)
toonGlobals.uPixelRatio.value = renderer.getPixelRatio()

// --- Sol --------------------------------------------------------------------
const sun = new THREE.DirectionalLight(0xfff4dc, 1.0)
sun.castShadow = true
sun.shadow.mapSize.set(2048, 2048)
sun.shadow.bias = -0.0005
sun.shadow.normalBias = 0.02
// A câmera de sombra cobre só a área que a câmera está mostrando: anda junto
// com ela e cresce com o zoom (ver updateCamera)
const sc = sun.shadow.camera
sc.near = 1
sc.far = 160
scene.add(sun, sun.target)

const sunParams = { azimuth: 215, elevation: 50 }
const sunDistance = 70
let shadowHalfSize = 0
function setShadowArea(halfSize) {
  // Só atualiza quando muda bastante (recalcular a projeção todo frame é à toa)
  if (Math.abs(halfSize - shadowHalfSize) < 0.5) return
  shadowHalfSize = halfSize
  sc.left = sc.bottom = -halfSize
  sc.right = sc.top = halfSize
  sc.updateProjectionMatrix()
}
setShadowArea(12)

function updateSun() {
  const phi = THREE.MathUtils.degToRad(90 - sunParams.elevation)
  const theta = THREE.MathUtils.degToRad(sunParams.azimuth)
  sun.position.setFromSphericalCoords(sunDistance, phi, theta).add(sun.target.position)
}
updateSun()

// --- Arena -------------------------------------------------------------------
// Piso quadrado de ARENA_SIZE x ARENA_SIZE com uma mureta de borracha em volta.
// A grade (textura) dá referência de movimento; a cor vem do painel e
// multiplica a textura.
const ARENA_SIZE = 100
const ARENA_HALF = ARENA_SIZE / 2
const WALL_HEIGHT = 1
const WALL_THICKNESS = 1
const groundParams = { color: '#d8c9a3', grid: 0.12, tileSize: 2, wallColor: '#e8463c' }

const gridCanvas = document.createElement('canvas')
gridCanvas.width = gridCanvas.height = 256
const gridTexture = new THREE.CanvasTexture(gridCanvas)
gridTexture.colorSpace = THREE.SRGBColorSpace
gridTexture.wrapS = gridTexture.wrapT = THREE.RepeatWrapping
gridTexture.anisotropy = renderer.capabilities.getMaxAnisotropy()

function updateGrid() {
  const ctx = gridCanvas.getContext('2d')
  ctx.fillStyle = '#ffffff'
  ctx.fillRect(0, 0, 256, 256)
  const v = Math.round(255 * (1 - groundParams.grid))
  ctx.fillStyle = `rgb(${v},${v},${v})`
  ctx.fillRect(0, 0, 256, 6)
  ctx.fillRect(0, 0, 6, 256)
  gridTexture.repeat.setScalar(ARENA_SIZE / groundParams.tileSize)
  gridTexture.updateMatrix()
  gridTexture.needsUpdate = true
}
updateGrid()

const ground = toonMesh(new THREE.PlaneGeometry(ARENA_SIZE, ARENA_SIZE), { map: gridTexture, rim: 0 })
ground.rotation.x = -Math.PI / 2
ground.receiveShadow = true
scene.add(ground)
const updateGroundColor = () => ground.material.uniforms.uColor.value.set(groundParams.color)
updateGroundColor()

// Mureta: quatro blocos por fora do piso, com material compartilhado
const wallMaterial = createToonMaterial({ color: groundParams.wallColor, glossiness: 6 })
const wallLength = ARENA_SIZE + WALL_THICKNESS * 2
for (const [x, z, rotated] of [
  [0, ARENA_HALF + WALL_THICKNESS / 2, false],
  [0, -ARENA_HALF - WALL_THICKNESS / 2, false],
  [ARENA_HALF + WALL_THICKNESS / 2, 0, true],
  [-ARENA_HALF - WALL_THICKNESS / 2, 0, true],
]) {
  const wall = new THREE.Mesh(new THREE.BoxGeometry(wallLength, WALL_HEIGHT, WALL_THICKNESS), wallMaterial)
  wall.position.set(x, WALL_HEIGHT / 2, z)
  if (rotated) wall.rotation.y = Math.PI / 2
  wall.castShadow = wall.receiveShadow = true
  scene.add(wall)
}
const updateWallColor = () => wallMaterial.uniforms.uColor.value.set(groundParams.wallColor)

// --- Carrinho -----------------------------------------------------------------
let car = null
// Os IDs de material do glTF são agrupados em poucos materiais toon; cada
// grupo vira uma cor no painel. null = peças sem material no arquivo.
// IDs que não estiverem em nenhum grupo caem no primeiro.
const MATERIAL_GROUPS = [
  { name: 'Carroceria (principal)', color: '#2fd3b4', glossiness: 8, ids: [3] },
  { name: 'Carroceria (secundária)', color: '#f4f1e8', glossiness: 8, ids: [2, 12] },
  { name: 'Metal e detalhes', color: '#b8b8c0', glossiness: 10, ids: [0, 4, 6, 7, 8, 14, null] },
  { name: 'Borracha e assento', color: '#2a2a30', glossiness: 0, ids: [1, 5, 9, 10, 11, 13] },
]
const carMaterials = MATERIAL_GROUPS.map(({ name, color, glossiness }) => ({
  name,
  material: createToonMaterial({ color, glossiness, side: THREE.DoubleSide }),
}))

function loadModel(url) {
  return new GLTFLoader().loadAsync(url).then((gltf) => {
    toonify(gltf.scene, (source) => {
      const id = gltf.parser.associations.get(source)?.materials ?? null
      const group = Math.max(0, MATERIAL_GROUPS.findIndex((g) => g.ids.includes(id)))
      return carMaterials[group].material
    })
    return gltf.scene
  })
}

loadModel(MODEL_URL).then(
  (model) => {
    model.rotation.y = MODEL_YAW

    // Centraliza no plano XZ e apoia as rodas no chão (y = 0)
    const box = new THREE.Box3().setFromObject(model)
    const center = box.getCenter(new THREE.Vector3())
    model.position.set(-center.x, -box.min.y, -center.z)

    carTemplate = model.clone(true)
    car = new Car(model)
    // Cápsula de colisão medida pelo contorno do carro visto de cima (a
    // borracha da base é a parte mais larga), com o carro na origem
    car.root.updateMatrixWorld(true)
    carFootprint = measureFootprint(model)
    // Nasce num ponto aleatório perto do centro, para os jogadores não
    // aparecerem um em cima do outro
    const a = Math.random() * Math.PI * 2
    car.spawn.set(Math.cos(a) * 5, 0, Math.sin(a) * 5)
    car.reset()
    scene.add(car.root)
    startMultiplayer()
    buildCarPanel()
    buildMaterialsPanel()
    // Só agora todos os controles existem; aplica os valores salvos por cima
    savedSettings.then((s) => {
      if (s) gui.load(s)
      applyLivery(pickLivery())
    })
  },
  (err) => console.error('Erro ao carregar o modelo:', err)
)

// --- Multiplayer ----------------------------------------------------------------
// Sala vem da URL (?sala=nome); quem abrir o mesmo link cai na mesma arena.
const ROOM_ID = new URLSearchParams(location.search).get('sala') || 'arena'
const NET_SEND_INTERVAL = 1 / 20 // 20 pacotes por segundo
const netStatus = document.getElementById('net-status')
let carTemplate = null // cópia do modelo, para montar os carrinhos remotos
let carFootprint = null // cápsula de colisão (igual para todos os carrinhos)
let net = null
let netTimer = 0
const remoteCars = new Map() // peerId -> { car: RemoteCar, bodyMaterials, livery, score }

// --- Pintura (livery) -----------------------------------------------------------
// Sorteada ao entrar; pinta as duas carrocerias (principal e secundária)
let myLivery = null

function applyLivery(livery) {
  myLivery = livery
  carMaterials[0].material.uniforms.uColor.value.set(livery.primary)
  carMaterials[1].material.uniforms.uColor.value.set(livery.secondary)
  materialsFolder.controllers.forEach((c) => c.updateDisplay())
  liveryButton.name(`Sortear pintura (atual: ${livery.name})`)
}

function rerollLivery() {
  // Evita repetir a pintura atual e as dos outros jogadores da sala
  const taken = [myLivery?.name, ...[...remoteCars.values()].map((r) => r.livery)]
  applyLivery(pickLivery(taken))
}

function myBodyColors() {
  return carMaterials.slice(0, 2).map(({ material }) => '#' + material.uniforms.uColor.value.getHexString())
}

// Bolinha do placar com as duas cores da pintura
const swatch = ([a, b]) => `linear-gradient(135deg, ${a} 50%, ${b} 50%)`

// Pontuação: eu somo meus pontos quando acerto alguém; os dos outros chegam
// no estado de cada um (assim quem entra depois já vê)
let myScore = 0
const hitCooldown = new HitCooldown()
const scoreUI = new ScoreUI()
let scoreTimer = 0

function carPosition(peerId) {
  return peerId === net.selfId ? car.root.position : remoteCars.get(peerId)?.car.root.position
}

function renderScoreboard() {
  const players = [{ name: 'Você', color: swatch(myBodyColors()), score: myScore, isMe: true }]
  for (const [peerId, remote] of remoteCars) {
    players.push({
      name: `Jogador ${peerId.slice(0, 4).toUpperCase()}`,
      color: swatch(remote.bodyMaterials.map((m) => '#' + m.uniforms.uColor.value.getHexString())),
      score: remote.score,
      isMe: false,
    })
  }
  scoreUI.render(players)
}

function setNetStatus(peerCount) {
  const players = peerCount + 1
  netStatus.textContent = `Sala "${ROOM_ID}" · ${players} ${players === 1 ? 'jogador' : 'jogadores'}`
}

function createRemoteCar(peerId) {
  // Clona o modelo; as duas carrocerias ganham materiais próprios para ter a
  // pintura do outro jogador. Os demais materiais são compartilhados, então os
  // ajustes do painel valem para todos os carrinhos.
  const bodyMaterials = [0, 1].map(() =>
    createToonMaterial({ color: 0xffffff, glossiness: 8, side: THREE.DoubleSide })
  )
  const model = carTemplate.clone(true)
  model.traverse((o) => {
    if (!o.isMesh) return
    const i = [carMaterials[0].material, carMaterials[1].material].indexOf(o.material)
    if (i !== -1) o.material = bodyMaterials[i]
  })
  const remote = { car: new RemoteCar(model), bodyMaterials, livery: null, score: 0 }
  scene.add(remote.car.root)
  remoteCars.set(peerId, remote)
  return remote
}

function startMultiplayer() {
  setNetStatus(0)
  net = joinArena(ROOM_ID, {
    onPeersChange: setNetStatus,
    onPeerState(peerId, state) {
      const remote = remoteCars.get(peerId) ?? createRemoteCar(peerId)
      remote.car.setState(state)
      state.colors?.forEach((c, i) => remote.bodyMaterials[i].uniforms.uColor.value.set(c))
      // Mesma pintura que a minha: um dos dois sorteia de novo (o de ID menor
      // mantém, para os dois não trocarem ao mesmo tempo)
      if (state.livery !== remote.livery) {
        remote.livery = state.livery
        if (state.livery === myLivery?.name && net.selfId > peerId) rerollLivery()
      }
      remote.score = state.score ?? 0
    },
    onHit(hit, attackerId) {
      // Fui atingido: o empurrão calculado por quem bateu vale para mim. Se eu
      // também resolvi essa batida do meu lado (os dois se acharam
      // agressores), já apliquei o meu ricochete e ignoro o dele
      const now = performance.now() / 1000
      if (hit.target === net.selfId && !hitCooldown.recent(attackerId, now)) {
        hitCooldown.ready(attackerId, now)
        car.applyImpulse(new THREE.Vector3(hit.ix, 0, hit.iz))
      }
      const position = carPosition(attackerId)
      if (hit.points && position) scoreUI.popup(position, hit.points)
    },
    onPeerLeave(peerId) {
      const remote = remoteCars.get(peerId)
      if (!remote) return
      scene.remove(remote.car.root)
      remote.bodyMaterials.forEach((m) => m.dispose())
      remoteCars.delete(peerId)
    },
  })
}

function updateMultiplayer(dt) {
  if (!net) return
  for (const [peerId, { car: remote }] of remoteCars) {
    remote.update(dt)
    if (!remote.hasState) continue
    // Cada jogador resolve a batida só do próprio carrinho; o outro faz o
    // mesmo do lado dele, então o resultado fica simétrico
    const hit = testCars(car.root.position, car.yaw, remote.root.position, remote.yaw, carFootprint)
    if (!hit) continue
    car.separate(hit.normal, hit.depth)

    // Quem bateu resolve a batida: aplica o próprio ricochete, manda o
    // empurrão da vítima e soma os pontos. A vítima espera essa mensagem.
    // Empate (ex.: de frente): cada um aplica só o próprio ricochete.
    const judged = judgeHit(hit.normal, car.velocity, remote.velocity)
    if (judged.role === 'victim') continue
    const impulse = car.collisionImpulse(hit.normal, remote.velocity)
    if (impulse < MIN_IMPULSE || !hitCooldown.ready(peerId, performance.now() / 1000)) continue

    car.applyImpulse(hit.normal.clone().multiplyScalar(impulse))
    if (judged.role === 'tie') continue
    const points = impactPoints(judged.impact)
    net.sendHit({ target: peerId, ix: -hit.normal.x * impulse, iz: -hit.normal.z * impulse, points })
    if (points) {
      myScore += points
      scoreUI.popup(car.root.position, points)
    }
  }

  netTimer += dt
  if (netTimer >= NET_SEND_INTERVAL) {
    netTimer %= NET_SEND_INTERVAL
    net.sendState({ ...car.getNetState(), colors: myBodyColors(), livery: myLivery?.name, score: myScore })
  }

  scoreUI.update(dt, camera)
  scoreTimer += dt
  if (scoreTimer >= 0.25) {
    scoreTimer = 0
    renderScoreboard()
  }
}

// --- Câmera de grupo -------------------------------------------------------------
// Ângulo fixo (inclinação/rotação), mas o centro e a distância seguem todos os
// carrinhos: mira o meio da caixa que envolve os carros e se afasta o
// suficiente para todos caberem no quadro (com margem).
const camParams = {
  elevation: 45,
  azimuth: 180,
  fov: 35,
  minDistance: 22,   // zoom máximo (todos juntos ou jogando sozinho)
  maxDistance: 90,   // zoom out máximo
  margin: 4,         // folga em volta dos carros (m)
  lookAhead: 0.5,    // s: enquadra onde cada carro vai estar, não só onde está
  smoothing: 3,      // quanto maior, mais rápido a câmera acompanha
}
const cam = {
  center: new THREE.Vector3(),
  distance: camParams.minDistance,
  back: new THREE.Vector3(),  // do alvo para a câmera
  right: new THREE.Vector3(),
  up: new THREE.Vector3(),
  ready: false,
}
const camPoints = []
const tmpRel = new THREE.Vector3()

function updateCameraAxes() {
  const phi = THREE.MathUtils.degToRad(90 - camParams.elevation)
  const theta = THREE.MathUtils.degToRad(camParams.azimuth)
  cam.back.setFromSphericalCoords(1, phi, theta)
  // Mesma base que o camera.lookAt monta
  cam.right.crossVectors(THREE.Object3D.DEFAULT_UP, cam.back).normalize()
  cam.up.crossVectors(cam.back, cam.right)
  camera.fov = camParams.fov
  camera.updateProjectionMatrix()
}
updateCameraAxes()

// Pontos que precisam aparecer: cada carro, adiantado pela velocidade
function collectCameraPoints() {
  camPoints.length = 0
  const add = (position, velocity) =>
    camPoints.push(position.clone().addScaledVector(velocity, camParams.lookAhead).setY(1))
  if (car) add(car.root.position, car.velocity)
  for (const { car: remote } of remoteCars.values()) {
    if (remote.hasState) add(remote.root.position, remote.velocity)
  }
  return camPoints
}

function updateCamera(dt) {
  const points = collectCameraPoints()
  if (points.length) {
    // Centro: meio da caixa dos carros no chão
    const box = new THREE.Box3().setFromPoints(points)
    const center = box.getCenter(new THREE.Vector3()).setY(0)

    // Distância para cada ponto caber no quadro: a meia-largura visível a uma
    // profundidade z é z * tan(fov/2); o ponto fica a (d - rel·back) da câmera
    const tanY = Math.tan(THREE.MathUtils.degToRad(camParams.fov) / 2)
    const tanX = tanY * camera.aspect
    let distance = camParams.minDistance
    for (const p of points) {
      tmpRel.subVectors(p, center)
      const depthOffset = tmpRel.dot(cam.back)
      const x = Math.abs(tmpRel.dot(cam.right)) + camParams.margin
      const y = Math.abs(tmpRel.dot(cam.up)) + camParams.margin
      distance = Math.max(distance, x / tanX + depthOffset, y / tanY + depthOffset)
    }
    distance = Math.min(distance, camParams.maxDistance)

    if (!cam.ready) {
      cam.center.copy(center)
      cam.distance = distance
      cam.ready = true
    } else {
      const k = 1 - Math.exp(-camParams.smoothing * dt)
      cam.center.lerp(center, k)
      // Afasta rápido (ninguém sai do quadro), aproxima devagar (sem "respirar")
      const zoomRate = distance > cam.distance ? camParams.smoothing * 2 : camParams.smoothing * 0.4
      cam.distance += (distance - cam.distance) * (1 - Math.exp(-zoomRate * dt))
    }
  }

  camera.position.copy(cam.center).addScaledVector(cam.back, cam.distance)
  camera.lookAt(cam.center)

  // Sombra cobre a área visível em volta do centro
  sun.target.position.copy(cam.center)
  updateSun()
  setShadowArea(Math.max(12, cam.distance * 0.55))
}
updateCamera(0)

// --- GUI --------------------------------------------------------------------
const gui = new GUI({ title: 'Controles' })
const colorProxy = (uniform) => ({
  get value() { return '#' + uniform.value.getHexString() },
  set value(v) { uniform.value.set(v) },
})

// --- Salvar / restaurar -----------------------------------------------------
// "Salvar" grava todos os valores do painel em public/settings.json (só no
// `npm run dev`, via plugin do vite.config.js); o jogo carrega esse arquivo ao
// abrir. "Restaurar" volta aos valores escritos no código (não apaga o arquivo
// até você salvar de novo).
const settingsActions = {
  async save() {
    const button = saveButton
    try {
      const res = await fetch('/__settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(gui.save()),
      })
      if (!res.ok) throw new Error(await res.text())
      button.name('Salvo ✓')
    } catch (err) {
      console.error('Não foi possível salvar as configurações:', err)
      button.name('Erro ao salvar (veja o console)')
    }
    setTimeout(() => button.name('Salvar configurações'), 2000)
  },
  reset() {
    gui.reset()
  },
}
// Só faz sentido no servidor de desenvolvimento, que pode escrever o arquivo
const saveButton = gui.add(settingsActions, 'save').name('Salvar configurações')
gui.add(settingsActions, 'reset').name('Restaurar padrões do código')
if (!import.meta.env.DEV) saveButton.hide()

// Os controles do carrinho são criados depois do load, para o "valor
// inicial" (usado no Restaurar) ser o padrão real, e não 0
const carFolder = gui.addFolder('Carrinho')
function buildCarPanel() {
  carFolder.add(car.params, 'maxSpeed', 2, 30, 0.5).name('velocidade máx.')
  carFolder.add(car.params, 'acceleration', 1, 20, 0.5).name('aceleração')
  carFolder.add(car.params, 'accelCurve', 0.5, 6, 0.1).name('curva de aceleração')
  carFolder.add(car.params, 'throttleResponse', 0, 2, 0.05).name('resposta do pedal (s)')
  carFolder.add(car.params, 'turnSpeed', 0.5, 6, 0.1).name('giro')
  carFolder.add(car.params, 'steerResponse', 0, 1.5, 0.05).name('peso do volante (s)')
  carFolder.add(car.params, 'steerReturn', 0, 1, 0.05).name('volta do volante (s)')
  carFolder.add(car.params, 'turnInertia', 0, 0.6, 0.01).name('inércia do giro (s)')
  carFolder.add(car.params, 'lean', 0, 3, 0.1).name('inclinação')
  carFolder.add(car.params, 'bounciness', 0, 1.5, 0.05).name('elasticidade da batida')
  carFolder.add(car.params, 'wallBounce', 0, 1.2, 0.05).name('elasticidade da parede')
  carFolder.add(car.params, 'knockDrag', 0.5, 10, 0.1).name('freio do empurrão')
  carFolder.add(car.params, 'hop', 0, 3, 0.1).name('quique')
}
// Uma cor por grupo de material do carrinho
const materialsFolder = gui.addFolder('Materiais do carrinho')
materialsFolder.hide()
const liveryButton = materialsFolder.add({ reroll: () => rerollLivery() }, 'reroll').name('Sortear pintura')
function buildMaterialsPanel() {
  for (const { name, material } of carMaterials) {
    materialsFolder.addColor(colorProxy(material.uniforms.uColor), 'value').name(name)
  }
  materialsFolder.show()
}
const scoreFolder = gui.addFolder('Pontuação (força em m/s)')
scoreFolder.add(scoreParams, 'minImpact', 0, 9, 0.1).name('mínimo para pontuar')
scoreFolder.add(scoreParams, 'strong', 0, 12, 0.1).name('FORTE (×2) a partir de')
scoreFolder.add(scoreParams, 'smash', 0, 12, 0.1).name('PANCADA (×3) a partir de')
const camFolder = gui.addFolder('Câmera')
camFolder.add(camParams, 'elevation', 10, 90, 1).name('inclinação (°)').onChange(updateCameraAxes)
camFolder.add(camParams, 'azimuth', 0, 360, 1).name('rotação (°)').onChange(updateCameraAxes)
camFolder.add(camParams, 'fov', 10, 90, 1).name('campo de visão').onChange(updateCameraAxes)
camFolder.add(camParams, 'minDistance', 5, 60, 0.5).name('distância mínima')
camFolder.add(camParams, 'maxDistance', 20, 150, 1).name('distância máxima')
camFolder.add(camParams, 'margin', 0, 15, 0.5).name('margem (m)')
camFolder.add(camParams, 'lookAhead', 0, 2, 0.05).name('antecipação (s)')
camFolder.add(camParams, 'smoothing', 0.5, 10, 0.1).name('suavidade (inv.)')
const groundFolder = gui.addFolder('Chão')
groundFolder.addColor(groundParams, 'color').name('cor').onChange(updateGroundColor)
groundFolder.add(groundParams, 'grid', 0, 0.6, 0.01).name('grade').onChange(updateGrid)
groundFolder.add(groundParams, 'tileSize', 0.5, 10, 0.5).name('tamanho do quadrado').onChange(updateGrid)
groundFolder.addColor(groundParams, 'wallColor').name('cor da mureta').onChange(updateWallColor)
const bgFolder = gui.addFolder('Fundo')
bgFolder.addColor(bgParams, 'center').name('cor do centro').onChange(updateBackground)
bgFolder.addColor(bgParams, 'edge').name('cor da borda').onChange(updateBackground)
bgFolder.add(bgParams, 'radius', 0.1, 2, 0.01).name('raio').onChange(updateBackground)
const shading = gui.addFolder('Sombreamento')
shading.add(toonGlobals.uThreshold, 'value', -0.5, 0.5, 0.01).name('limite luz/sombra')
shading.add(toonGlobals.uSoftness, 'value', 0.001, 0.3, 0.001).name('suavidade da faixa')
shading.addColor(colorProxy(toonGlobals.uShadowTint), 'value').name('tom da sombra')
shading.add(toonGlobals.uAmbient, 'value', 0, 1, 0.01).name('ambiente')
const rim = gui.addFolder('Rim light')
rim.add(toonGlobals.uRimStrength, 'value', 0, 2, 0.01).name('intensidade')
rim.add(toonGlobals.uRimThreshold, 'value', 0.3, 0.98, 0.01).name('espessura (inv.)')
const halftone = gui.addFolder('Retícula (quadrinhos)')
halftone.add(toonGlobals.uHalftone, 'value').name('ativar')
halftone.add(toonGlobals.uDotSpacing, 'value', 3, 24, 0.5).name('espaçamento (px)')
halftone.add(toonGlobals.uDotSize, 'value', 0.2, 1.5, 0.01).name('tamanho máximo')
const dotAngle = { get deg() { return THREE.MathUtils.radToDeg(toonGlobals.uDotAngle.value) }, set deg(v) { toonGlobals.uDotAngle.value = THREE.MathUtils.degToRad(v) } }
halftone.add(dotAngle, 'deg', 0, 90, 1).name('ângulo da grade')
halftone.add(toonGlobals.uDotDeep, 'value', 0, 1, 0.01).name('início da sombra densa')
halftone.add(toonGlobals.uDotTint, 'value', 0, 1, 0.01).name('tom azulado')
halftone.addColor(colorProxy(toonGlobals.uDotColor), 'value').name('cor da tinta')
const outlineFolder = gui.addFolder('Contorno')
outlineFolder.add(outlineParams.uThickness, 'value', 0, 8, 0.1).name('espessura (px)')
outlineFolder.add(outlineOptions, 'fxaa').name('suavização (FXAA)')
outlineFolder.add(outlineParams.uDepthThreshold, 'value', 0.001, 0.2, 0.001).name('sensibilidade (prof.)')
outlineFolder.add(outlineParams.uNormalEdges, 'value').name('linhas em dobras')
outlineFolder.add(outlineParams.uNormalThreshold, 'value', 0.05, 1.5, 0.01).name('limite das dobras')
outlineFolder.addColor(colorProxy(outlineParams.uOutlineColor), 'value').name('cor')
const sunFolder = gui.addFolder('Sol')
sunFolder.add(sunParams, 'azimuth', 0, 360, 1).name('azimute').onChange(updateSun)
sunFolder.add(sunParams, 'elevation', -89, 89, 1).name('elevação').onChange(updateSun)

// Pastas de visual começam fechadas para o painel não tomar a tela
for (const f of [bgFolder, shading, rim, halftone, outlineFolder, sunFolder]) f.close()

// --- Loop -------------------------------------------------------------------
let last = performance.now()

function tick(now) {
  // dt limitado: ao voltar de outra aba não dá um "pulo" gigante
  const dt = Math.min((now - last) / 1000, 0.05)
  last = now

  if (car) {
    if (isDown('KeyR')) car.reset()
    car.update(dt, readDriveInput())
    // Paredes da arena (só ricochete, não pontua)
    for (const { normal, depth } of testArenaWalls(car.root.position, car.yaw, carFootprint, ARENA_HALF)) {
      car.hitWall(normal, depth)
    }

    updateMultiplayer(dt)
  }
  updateCamera(dt)

  outline.render()
  requestAnimationFrame(tick)
}
requestAnimationFrame(tick)

// --- Resize -----------------------------------------------------------------
window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight
  camera.updateProjectionMatrix()
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
  renderer.setSize(window.innerWidth, window.innerHeight)
  outline.setSize()
  updateBackground()
  toonGlobals.uPixelRatio.value = renderer.getPixelRatio()
})
