import * as THREE from 'three'
import GUI from 'three/examples/jsm/libs/lil-gui.module.min.js'
import { toonGlobals } from './toon.js'
import { outlineParams, outlineOptions } from './outline.js'
import { scoreParams } from './score.js'

// Painel de controles (lil-gui). Os valores são guardados pelo NOME de cada
// controle: renomear um controle faz o valor salvo dele ser ignorado.
//
// "Salvar" grava tudo em public/settings.json (só no `npm run dev`, via plugin
// do vite.config.js); o jogo carrega esse arquivo ao abrir. "Restaurar" volta
// aos valores escritos no código.

// Liga um controle de cor a um uniform (THREE.Color)
const colorProxy = (uniform) => ({
  get value() { return '#' + uniform.value.getHexString() },
  set value(v) { uniform.value.set(v) },
})

export class ControlPanel {
  /**
   * @param {{
   *   background: import('./environment.js').Background,
   *   sun: import('./environment.js').Sun,
   *   arena: import('./environment.js').Arena,
   *   camera: import('./groupCamera.js').GroupCamera,
   *   onRerollLivery: () => void,
   * }} deps
   */
  constructor({ background, sun, arena, camera, onRerollLivery }) {
    const gui = (this.gui = new GUI({ title: 'Controles' }))

    this.saveButton = gui.add({ save: () => this.save() }, 'save').name('Salvar configurações')
    gui.add({ reset: () => gui.reset() }, 'reset').name('Restaurar padrões do código')
    // Só faz sentido no servidor de desenvolvimento, que pode escrever o arquivo
    if (!import.meta.env.DEV) this.saveButton.hide()

    // Carrinho e materiais são preenchidos depois que o modelo carrega
    this.carFolder = gui.addFolder('Carrinho')
    this.materialsFolder = gui.addFolder('Materiais do carrinho')
    this.materialsFolder.hide()
    this.liveryButton = this.materialsFolder.add({ reroll: onRerollLivery }, 'reroll').name('Sortear pintura')

    const score = gui.addFolder('Pontuação (força em m/s)')
    score.add(scoreParams, 'minImpact', 0, 9, 0.1).name('mínimo para pontuar')
    score.add(scoreParams, 'strong', 0, 12, 0.1).name('FORTE (×2) a partir de')
    score.add(scoreParams, 'smash', 0, 12, 0.1).name('PANCADA (×3) a partir de')

    const cam = gui.addFolder('Câmera')
    const axes = () => camera.updateAxes()
    cam.add(camera.params, 'elevation', 10, 90, 1).name('inclinação (°)').onChange(axes)
    cam.add(camera.params, 'azimuth', 0, 360, 1).name('rotação (°)').onChange(axes)
    cam.add(camera.params, 'fov', 10, 90, 1).name('campo de visão').onChange(axes)
    cam.add(camera.params, 'minDistance', 5, 60, 0.5).name('distância mínima')
    cam.add(camera.params, 'maxDistance', 20, 150, 1).name('distância máxima')
    cam.add(camera.params, 'margin', 0, 15, 0.5).name('margem (m)')
    cam.add(camera.params, 'lookAhead', 0, 2, 0.05).name('antecipação (s)')
    cam.add(camera.params, 'smoothing', 0.5, 10, 0.1).name('suavidade (inv.)')

    // Mantém o nome "Chão" para não perder valores já salvos
    const ground = gui.addFolder('Chão')
    const colors = () => arena.updateColors()
    const grid = () => arena.updateGrid()
    ground.addColor(arena.params, 'color').name('cor').onChange(colors)
    ground.add(arena.params, 'grid', 0, 0.6, 0.01).name('grade').onChange(grid)
    ground.add(arena.params, 'tileSize', 0.5, 10, 0.5).name('tamanho do quadrado').onChange(grid)
    ground.addColor(arena.params, 'wallColor').name('cor da mureta').onChange(colors)

    const bg = gui.addFolder('Fundo')
    const redraw = () => background.redraw()
    bg.addColor(background.params, 'center').name('cor do centro').onChange(redraw)
    bg.addColor(background.params, 'edge').name('cor da borda').onChange(redraw)
    bg.add(background.params, 'radius', 0.1, 2, 0.01).name('raio').onChange(redraw)

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
    const dotAngle = {
      get deg() { return THREE.MathUtils.radToDeg(toonGlobals.uDotAngle.value) },
      set deg(v) { toonGlobals.uDotAngle.value = THREE.MathUtils.degToRad(v) },
    }
    halftone.add(dotAngle, 'deg', 0, 90, 1).name('ângulo da grade')
    halftone.add(toonGlobals.uDotDeep, 'value', 0, 1, 0.01).name('início da sombra densa')
    halftone.add(toonGlobals.uDotTint, 'value', 0, 1, 0.01).name('tom azulado')
    halftone.addColor(colorProxy(toonGlobals.uDotColor), 'value').name('cor da tinta')

    const outline = gui.addFolder('Contorno')
    outline.add(outlineParams.uThickness, 'value', 0, 8, 0.1).name('espessura (px)')
    outline.add(outlineOptions, 'fxaa').name('suavização (FXAA)')
    outline.add(outlineParams.uDepthThreshold, 'value', 0.001, 0.2, 0.001).name('sensibilidade (prof.)')
    outline.add(outlineParams.uNormalEdges, 'value').name('linhas em dobras')
    outline.add(outlineParams.uNormalThreshold, 'value', 0.05, 1.5, 0.01).name('limite das dobras')
    outline.addColor(colorProxy(outlineParams.uOutlineColor), 'value').name('cor')

    const sunFolder = gui.addFolder('Sol')
    const moveSun = () => sun.updatePosition()
    sunFolder.add(sun.params, 'azimuth', 0, 360, 1).name('azimute').onChange(moveSun)
    sunFolder.add(sun.params, 'elevation', -89, 89, 1).name('elevação').onChange(moveSun)

    // Pastas de visual começam fechadas para o painel não tomar a tela
    for (const f of [bg, shading, rim, halftone, outline, sunFolder]) f.close()
  }

  /**
   * Controles do carro. Criados depois do load, para o "valor inicial" (usado
   * no Restaurar) ser o padrão real.
   */
  addCarControls(params) {
    const f = this.carFolder
    f.add(params, 'maxSpeed', 2, 30, 0.5).name('velocidade máx.')
    f.add(params, 'acceleration', 1, 20, 0.5).name('aceleração')
    f.add(params, 'accelCurve', 0.5, 6, 0.1).name('curva de aceleração')
    f.add(params, 'throttleResponse', 0, 2, 0.05).name('resposta do pedal (s)')
    f.add(params, 'turnSpeed', 0.5, 6, 0.1).name('giro')
    f.add(params, 'steerResponse', 0, 1.5, 0.05).name('peso do volante (s)')
    f.add(params, 'steerReturn', 0, 1, 0.05).name('volta do volante (s)')
    f.add(params, 'turnInertia', 0, 0.6, 0.01).name('inércia do giro (s)')
    f.add(params, 'lean', 0, 3, 0.1).name('inclinação')
    f.add(params, 'bounciness', 0, 1.5, 0.05).name('elasticidade da batida')
    f.add(params, 'wallBounce', 0, 1.2, 0.05).name('elasticidade da parede')
    f.add(params, 'knockDrag', 0.5, 10, 0.1).name('freio do empurrão')
    f.add(params, 'hop', 0, 3, 0.1).name('quique')
  }

  /** Uma cor por grupo de material do carro. */
  addMaterialControls(materials) {
    for (const { name, material } of materials) {
      this.materialsFolder.addColor(colorProxy(material.uniforms.uColor), 'value').name(name)
    }
    this.materialsFolder.show()
  }

  /** Atualiza o painel depois de mudar cores por código (ex.: nova pintura). */
  showLivery(name) {
    this.materialsFolder.controllers.forEach((c) => c.updateDisplay())
    this.liveryButton.name(`Sortear pintura (atual: ${name})`)
  }

  load(settings) {
    this.gui.load(settings)
  }

  async save() {
    const button = this.saveButton
    try {
      const res = await fetch('/__settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(this.gui.save()),
      })
      if (!res.ok) throw new Error(await res.text())
      button.name('Salvo ✓')
    } catch (err) {
      console.error('Não foi possível salvar as configurações:', err)
      button.name('Erro ao salvar (veja o console)')
    }
    setTimeout(() => button.name('Salvar configurações'), 2000)
  }
}
