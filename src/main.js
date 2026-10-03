import * as THREE from 'three'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import GUI from 'three/examples/jsm/libs/lil-gui.module.min.js'
import { toonify, toonMesh, toonGlobals, createToonMaterial } from './toon.js'
import { ScreenOutline, outlineParams, outlineOptions } from './outline.js'
import { Car } from './car.js'
import { readDriveInput, isDown } from './input.js'
import { joinArena } from './net.js'
import { RemoteCar } from './remoteCar.js'

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
// A câmera de sombra cobre só a área em volta do carrinho e anda junto com ele
const sc = sun.shadow.camera
sc.left = sc.bottom = -10
sc.right = sc.top = 10
sc.near = 0.5
sc.far = 50
scene.add(sun, sun.target)

const sunParams = { azimuth: 215, elevation: 50 }
const sunDistance = 20
function updateSun() {
  const phi = THREE.MathUtils.degToRad(90 - sunParams.elevation)
  const theta = THREE.MathUtils.degToRad(sunParams.azimuth)
  sun.position.setFromSphericalCoords(sunDistance, phi, theta).add(sun.target.position)
}
updateSun()

// --- Chão --------------------------------------------------------------------
// Plano grande com o material toon. A grade (textura) dá referência de
// movimento; a cor vem do painel e multiplica a textura.
const groundParams = { color: '#d8c9a3', grid: 0.12, tileSize: 2 }
const GROUND_SIZE = 400

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
  gridTexture.repeat.setScalar(GROUND_SIZE / groundParams.tileSize)
  gridTexture.updateMatrix()
  gridTexture.needsUpdate = true
}
updateGrid()

const ground = toonMesh(new THREE.PlaneGeometry(GROUND_SIZE, GROUND_SIZE), { map: gridTexture, rim: 0 })
ground.rotation.x = -Math.PI / 2
ground.receiveShadow = true
scene.add(ground)
const updateGroundColor = () => ground.material.uniforms.uColor.value.set(groundParams.color)
updateGroundColor()

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
    savedSettings.then((s) => s && gui.load(s))
  },
  (err) => console.error('Erro ao carregar o modelo:', err)
)

// --- Multiplayer ----------------------------------------------------------------
// Sala vem da URL (?sala=nome); quem abrir o mesmo link cai na mesma arena.
const ROOM_ID = new URLSearchParams(location.search).get('sala') || 'arena'
const NET_SEND_INTERVAL = 1 / 20 // 20 pacotes por segundo
const netStatus = document.getElementById('net-status')
let carTemplate = null // cópia do modelo, para montar os carrinhos remotos
let net = null
let netTimer = 0
const remoteCars = new Map() // peerId -> { car: RemoteCar, bodyMaterial }

function setNetStatus(peerCount) {
  const players = peerCount + 1
  netStatus.textContent = `Sala "${ROOM_ID}" · ${players} ${players === 1 ? 'jogador' : 'jogadores'}`
}

function myBodyColor() {
  return '#' + carMaterials[0].material.uniforms.uColor.value.getHexString()
}

function createRemoteCar(peerId) {
  // Clona o modelo; a carroceria principal ganha material próprio para ter
  // a cor do outro jogador. Os demais materiais são compartilhados, então os
  // ajustes do painel valem para todos os carrinhos.
  const bodyMaterial = createToonMaterial({ color: 0xffffff, glossiness: 8, side: THREE.DoubleSide })
  const model = carTemplate.clone(true)
  model.traverse((o) => {
    if (o.isMesh && o.material === carMaterials[0].material) o.material = bodyMaterial
  })
  const remote = { car: new RemoteCar(model), bodyMaterial }
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
      remote.bodyMaterial.uniforms.uColor.value.set(state.color)
    },
    onPeerLeave(peerId) {
      const remote = remoteCars.get(peerId)
      if (!remote) return
      scene.remove(remote.car.root)
      remote.bodyMaterial.dispose()
      remoteCars.delete(peerId)
    },
  })
}

function updateMultiplayer(dt) {
  if (!net) return
  netTimer += dt
  if (netTimer >= NET_SEND_INTERVAL) {
    netTimer %= NET_SEND_INTERVAL
    net.sendState({ ...car.getNetState(), color: myBodyColor() })
  }
  for (const { car: remote } of remoteCars.values()) remote.update(dt)
}

// --- Câmera de arena ------------------------------------------------------------
// Fixa, olhando o centro da arena de cima, inclinada (45° por padrão).
const camParams = { elevation: 45, azimuth: 180, distance: 32, fov: 35 }
const ARENA_CENTER = new THREE.Vector3(0, 0, 0)

function updateCamera() {
  const phi = THREE.MathUtils.degToRad(90 - camParams.elevation)
  const theta = THREE.MathUtils.degToRad(camParams.azimuth)
  camera.position.setFromSphericalCoords(camParams.distance, phi, theta).add(ARENA_CENTER)
  camera.lookAt(ARENA_CENTER)
  camera.fov = camParams.fov
  camera.updateProjectionMatrix()
}
updateCamera()

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
  carFolder.add(car.params, 'acceleration', 1, 40, 0.5).name('aceleração')
  carFolder.add(car.params, 'turnSpeed', 0.5, 6, 0.1).name('giro')
  carFolder.add(car.params, 'lean', 0, 3, 0.1).name('inclinação')
}
// Uma cor por grupo de material do carrinho
const materialsFolder = gui.addFolder('Materiais do carrinho')
materialsFolder.hide()
function buildMaterialsPanel() {
  for (const { name, material } of carMaterials) {
    materialsFolder.addColor(colorProxy(material.uniforms.uColor), 'value').name(name)
  }
  materialsFolder.show()
}
const camFolder = gui.addFolder('Câmera')
camFolder.add(camParams, 'elevation', 10, 90, 1).name('inclinação (°)').onChange(updateCamera)
camFolder.add(camParams, 'azimuth', 0, 360, 1).name('rotação (°)').onChange(updateCamera)
camFolder.add(camParams, 'distance', 5, 100, 0.5).name('distância').onChange(updateCamera)
camFolder.add(camParams, 'fov', 10, 90, 1).name('campo de visão').onChange(updateCamera)
const groundFolder = gui.addFolder('Chão')
groundFolder.addColor(groundParams, 'color').name('cor').onChange(updateGroundColor)
groundFolder.add(groundParams, 'grid', 0, 0.6, 0.01).name('grade').onChange(updateGrid)
groundFolder.add(groundParams, 'tileSize', 0.5, 10, 0.5).name('tamanho do quadrado').onChange(updateGrid)
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

    updateMultiplayer(dt)

    // Sol e área de sombra acompanham o carrinho
    sun.target.position.copy(car.root.position)
    updateSun()
  }

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
