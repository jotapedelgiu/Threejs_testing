import * as THREE from 'three'
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js'

// --- Renderer ---------------------------------------------------------------
const canvas = document.getElementById('scene')
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true })
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
renderer.setSize(window.innerWidth, window.innerHeight)
renderer.toneMapping = THREE.ACESFilmicToneMapping
renderer.toneMappingExposure = 1.0
renderer.shadowMap.enabled = true
renderer.shadowMap.type = THREE.PCFSoftShadowMap

// --- Cena e câmera ----------------------------------------------------------
const scene = new THREE.Scene()
scene.background = new THREE.Color(0x0b0d12)
scene.fog = new THREE.Fog(0x0b0d12, 8, 20)

const camera = new THREE.PerspectiveCamera(40, window.innerWidth / window.innerHeight, 0.1, 100)
camera.position.set(4, 2.5, 6)

const controls = new OrbitControls(camera, renderer.domElement)
controls.enableDamping = true
controls.target.set(0, 1, 0)
controls.minDistance = 3
controls.maxDistance = 12
controls.maxPolarAngle = Math.PI * 0.48

// --- Iluminação: IBL procedural + key light com sombra ----------------------
const pmrem = new THREE.PMREMGenerator(renderer)
scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture

const keyLight = new THREE.DirectionalLight(0xffffff, 2.0)
keyLight.position.set(3, 6, 4)
keyLight.castShadow = true
keyLight.shadow.mapSize.set(2048, 2048)
keyLight.shadow.camera.near = 1
keyLight.shadow.camera.far = 20
keyLight.shadow.radius = 4
scene.add(keyLight)

const rimLight = new THREE.PointLight(0x4f8cff, 30, 10)
rimLight.position.set(-3, 2, -3)
scene.add(rimLight)

// --- Objetos ----------------------------------------------------------------
// Peça central: torus knot metálico
const knot = new THREE.Mesh(
  new THREE.TorusKnotGeometry(0.7, 0.24, 256, 48),
  new THREE.MeshPhysicalMaterial({
    color: 0xd9b48f,
    metalness: 1.0,
    roughness: 0.22,
    clearcoat: 0.6,
    clearcoatRoughness: 0.15,
  })
)
knot.position.y = 1.2
knot.castShadow = true
scene.add(knot)

// Pedestal
const pedestal = new THREE.Mesh(
  new THREE.CylinderGeometry(1.1, 1.2, 0.15, 64),
  new THREE.MeshStandardMaterial({ color: 0x1c2030, roughness: 0.5, metalness: 0.2 })
)
pedestal.position.y = 0.075
pedestal.receiveShadow = true
pedestal.castShadow = true
scene.add(pedestal)

// Chão
const floor = new THREE.Mesh(
  new THREE.PlaneGeometry(40, 40),
  new THREE.MeshStandardMaterial({ color: 0x12151d, roughness: 0.85 })
)
floor.rotation.x = -Math.PI / 2
floor.receiveShadow = true
scene.add(floor)

// --- Loop -------------------------------------------------------------------
const clock = new THREE.Clock()

function tick() {
  const t = clock.getElapsedTime()

  knot.rotation.y = t * 0.4
  knot.rotation.x = Math.sin(t * 0.5) * 0.2
  knot.position.y = 1.2 + Math.sin(t * 1.2) * 0.06

  rimLight.position.x = Math.cos(t * 0.6) * 3
  rimLight.position.z = Math.sin(t * 0.6) * 3

  controls.update()
  renderer.render(scene, camera)
  requestAnimationFrame(tick)
}
tick()

// --- Resize -----------------------------------------------------------------
window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight
  camera.updateProjectionMatrix()
  renderer.setSize(window.innerWidth, window.innerHeight)
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
})
