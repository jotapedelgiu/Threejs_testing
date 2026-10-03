import * as THREE from 'three'
import { toonMesh, createToonMaterial } from './toon.js'

// Cenário: fundo em degradê, sol com sombra e a arena (piso + mureta).

// --- Fundo: degradê radial partindo do centro da tela -----------------------
// Desenhado num canvas do tamanho (proporcional) da tela, para o círculo
// ficar redondo, e usado como textura de fundo da cena.
export class Background {
  params = { center: '#5b6b8c', edge: '#05060a', radius: 0.75 }

  constructor(scene) {
    this.canvas = document.createElement('canvas')
    this.texture = new THREE.CanvasTexture(this.canvas)
    this.texture.colorSpace = THREE.SRGBColorSpace
    scene.background = this.texture
    this.redraw()
  }

  /** Chamar ao mudar as cores ou o tamanho da janela. */
  redraw() {
    const w = (this.canvas.width = Math.max(1, Math.round(window.innerWidth / 2)))
    const h = (this.canvas.height = Math.max(1, Math.round(window.innerHeight / 2)))
    const ctx = this.canvas.getContext('2d')
    // radius = 1 faz a cor da borda chegar exatamente nos cantos da tela
    const r = Math.max(1, (Math.hypot(w, h) / 2) * this.params.radius)
    const g = ctx.createRadialGradient(w / 2, h / 2, 0, w / 2, h / 2, r)
    g.addColorStop(0, this.params.center)
    g.addColorStop(1, this.params.edge)
    ctx.fillStyle = g
    ctx.fillRect(0, 0, w, h)
    this.texture.needsUpdate = true
  }
}

// --- Sol ----------------------------------------------------------------------
// A área de sombra cobre só o que a câmera mostra: anda junto com o alvo e
// cresce com o zoom (follow).
export class Sun {
  params = { azimuth: 215, elevation: 50 }
  distance = 70

  constructor(scene) {
    this.light = new THREE.DirectionalLight(0xfff4dc, 1.0)
    this.light.castShadow = true
    this.light.shadow.mapSize.set(2048, 2048)
    this.light.shadow.bias = -0.0005
    this.light.shadow.normalBias = 0.02
    const sc = this.light.shadow.camera
    sc.near = 1
    sc.far = 160
    scene.add(this.light, this.light.target)
    this.shadowHalfSize = 0
    this.follow(new THREE.Vector3(), 12)
  }

  /** Recalcula a posição a partir de azimute/elevação (chamar ao mudar params). */
  updatePosition() {
    const phi = THREE.MathUtils.degToRad(90 - this.params.elevation)
    const theta = THREE.MathUtils.degToRad(this.params.azimuth)
    this.light.position.setFromSphericalCoords(this.distance, phi, theta).add(this.light.target.position)
  }

  /** Centra a luz e a área de sombra em `target`, cobrindo ±halfSize metros. */
  follow(target, halfSize) {
    this.light.target.position.copy(target)
    this.updatePosition()
    // Projeção só é refeita quando a área muda bastante (dirty check)
    if (Math.abs(halfSize - this.shadowHalfSize) < 0.5) return
    this.shadowHalfSize = halfSize
    const sc = this.light.shadow.camera
    sc.left = sc.bottom = -halfSize
    sc.right = sc.top = halfSize
    sc.updateProjectionMatrix()
  }
}

// --- Arena --------------------------------------------------------------------
// Piso quadrado com uma mureta de borracha em volta. A grade (textura) dá
// referência de movimento; a cor vem do painel e multiplica a textura.
const WALL_HEIGHT = 1
const WALL_THICKNESS = 1
const GRID_TEXTURE_SIZE = 256

export class Arena {
  params = { color: '#d8c9a3', grid: 0.12, tileSize: 2, wallColor: '#e8463c' }

  constructor(scene, renderer, size) {
    this.size = size
    this.half = size / 2

    this.gridCanvas = document.createElement('canvas')
    this.gridCanvas.width = this.gridCanvas.height = GRID_TEXTURE_SIZE
    this.gridTexture = new THREE.CanvasTexture(this.gridCanvas)
    this.gridTexture.colorSpace = THREE.SRGBColorSpace
    this.gridTexture.wrapS = this.gridTexture.wrapT = THREE.RepeatWrapping
    this.gridTexture.anisotropy = renderer.capabilities.getMaxAnisotropy()
    this.updateGrid()

    this.ground = toonMesh(new THREE.PlaneGeometry(size, size), { map: this.gridTexture, rim: 0 })
    this.ground.rotation.x = -Math.PI / 2
    this.ground.receiveShadow = true
    scene.add(this.ground)

    // Mureta: quatro blocos por fora do piso, com material compartilhado
    this.wallMaterial = createToonMaterial({ color: this.params.wallColor, glossiness: 6 })
    const length = size + WALL_THICKNESS * 2
    const offset = this.half + WALL_THICKNESS / 2
    const geometry = new THREE.BoxGeometry(length, WALL_HEIGHT, WALL_THICKNESS)
    this.walls = [[0, offset, false], [0, -offset, false], [offset, 0, true], [-offset, 0, true]].map(([x, z, rotated]) => {
      const wall = new THREE.Mesh(geometry, this.wallMaterial)
      wall.position.set(x, WALL_HEIGHT / 2, z)
      if (rotated) wall.rotation.y = Math.PI / 2
      wall.castShadow = wall.receiveShadow = true
      scene.add(wall)
      return wall
    })

    // Peças paradas: a matriz é calculada uma vez, não a cada quadro
    for (const o of [this.ground, ...this.walls]) {
      o.updateMatrix()
      o.matrixAutoUpdate = false
    }
    this.updateColors()
  }

  updateGrid() {
    const ctx = this.gridCanvas.getContext('2d')
    const s = GRID_TEXTURE_SIZE
    ctx.fillStyle = '#ffffff'
    ctx.fillRect(0, 0, s, s)
    const v = Math.round(255 * (1 - this.params.grid))
    ctx.fillStyle = `rgb(${v},${v},${v})`
    ctx.fillRect(0, 0, s, 6)
    ctx.fillRect(0, 0, 6, s)
    this.gridTexture.repeat.setScalar(this.size / this.params.tileSize)
    this.gridTexture.updateMatrix()
    this.gridTexture.needsUpdate = true
  }

  updateColors() {
    this.ground.material.uniforms.uColor.value.set(this.params.color)
    this.wallMaterial.uniforms.uColor.value.set(this.params.wallColor)
  }
}
