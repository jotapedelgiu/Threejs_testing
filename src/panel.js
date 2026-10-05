import * as THREE from 'three'
import GUI from 'three/examples/jsm/libs/lil-gui.module.min.js'
import { toonGlobals } from './toon.js'
import { outlineParams, outlineOptions } from './outline.js'
import { bloomOptions } from './bloom.js'
import { damageParams } from './damage.js'

// Painel de controles (lil-gui). Os valores são guardados pelo NOME de cada
// controle: renomear um controle faz o valor salvo dele ser ignorado.
//
// "Salvar" grava tudo em public/settings.json (só no `npm run dev`, via plugin
// do vite.config.js); o jogo carrega esse arquivo ao abrir. "Restaurar" volta
// aos valores escritos no código.
//
// Fica escondido durante o jogo: abre/fecha com F2, ou já aberto com ?painel
// na URL. Escondido ou não, os valores salvos são aplicados do mesmo jeito.

const TOGGLE_KEY = 'F2'

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
   *   sparks: import('./sparks.js').SparkEffects,
   *   batPaint: { params: { base: string, spikes: string }, apply: () => void },
   *   tirePaint: { params: { color: string }, apply: () => void },
   *   quality: { maxPixelRatio: number, shadowSize: number, maxFps: number, showFps: boolean },
   *   onQualityChange: () => void,
   *   onRerollLivery: () => void,
   *   onEndMatch: () => void,
   * }} deps
   */
  constructor({ background, sun, arena, camera, sparks, batPaint, tirePaint, quality, onQualityChange, onRerollLivery, onEndMatch }) {
    const gui = (this.gui = new GUI({ title: 'Settings' }))
    if (!new URLSearchParams(location.search).has('painel')) gui.hide()
    window.addEventListener('keydown', (e) => {
      if (e.code !== TOGGLE_KEY || e.repeat) return
      e.preventDefault()
      this.toggle()
    })

    this.saveButton = gui.add({ save: () => this.save() }, 'save').name('Save settings')
    gui.add({ reset: () => gui.reset() }, 'reset').name('Reset to code defaults')
    // Só faz sentido no servidor de desenvolvimento, que pode escrever o arquivo
    if (!import.meta.env.DEV) this.saveButton.hide()

    // Só para testes: encerra a partida na hora (para ver o placar e baixar as
    // estatísticas sem esperar os 6 min). Some na versão publicada.
    if (import.meta.env.DEV) gui.add({ end: onEndMatch }, 'end').name('End match (test)')

    // Carrinho e materiais são preenchidos depois que o modelo carrega
    this.carFolder = gui.addFolder('Car')
    this.materialsFolder = gui.addFolder('Car materials')
    this.materialsFolder.hide()
    this.liveryButton = this.materialsFolder.add({ reroll: onRerollLivery }, 'reroll').name('Random livery')

    const damage = gui.addFolder('Damage (impact in m/s)')
    damage.add(damageParams, 'minImpact', 0, 9, 0.1).name('min. impact for damage')
    damage.add(damageParams, 'strong', 0, 12, 0.1).name('HEAVY from')
    damage.add(damageParams, 'smash', 0, 12, 0.1).name('CRITICAL from')

    const cam = gui.addFolder('Camera')
    const axes = () => camera.updateAxes()
    cam.add(camera.params, 'elevation', 10, 90, 1).name('pitch (°)').onChange(axes)
    cam.add(camera.params, 'azimuth', 0, 360, 1).name('yaw (°)').onChange(axes)
    cam.add(camera.params, 'fov', 10, 90, 1).name('field of view').onChange(axes)
    cam.add(camera.params, 'minDistance', 5, 60, 0.5).name('min. distance')
    cam.add(camera.params, 'maxDistance', 20, 150, 1).name('max. distance')
    cam.add(camera.params, 'margin', 0, 15, 0.5).name('margin (m)')
    cam.add(camera.params, 'lookAhead', 0, 2, 0.05).name('look-ahead (s)')
    cam.add(camera.params, 'smoothing', 0.5, 10, 0.1).name('smoothing (inv.)')

    // Mantém o nome "Chão" para não perder valores já salvos
    const ground = gui.addFolder('Floor')
    const colors = () => arena.updateColors()
    const grid = () => arena.updateGrid()
    ground.addColor(arena.params, 'color').name('color').onChange(colors)
    ground.add(arena.params, 'grid', 0, 0.6, 0.01).name('grid').onChange(grid)
    ground.add(arena.params, 'tileSize', 0.5, 10, 0.5).name('tile size').onChange(grid)
    ground.addColor(arena.params, 'wallColor').name('wall color').onChange(colors)

    const perf = gui.addFolder('Performance')
    perf.add(quality, 'maxPixelRatio', 0.5, 2, 0.25).name('max. resolution (pixel ratio)').onChange(onQualityChange)
    perf.add(quality, 'shadowSize', { low: 512, medium: 1024, high: 2048 }).name('shadow quality').onChange(onQualityChange)
    perf.add(quality, 'maxFps', { unlimited: 0, 30: 30, 60: 60, 120: 120, 144: 144 }).name('FPS limit').onChange(onQualityChange)
    perf.add(quality, 'showFps').name('show FPS').onChange(onQualityChange)

    const batFolder = gui.addFolder('Spiked posts')
    batFolder.addColor(batPaint.params, 'base').name('wood color').onChange(batPaint.apply)
    batFolder.addColor(batPaint.params, 'spikes').name('spike color').onChange(batPaint.apply)

    const tireFolder = gui.addFolder('Tires')
    tireFolder.addColor(tirePaint.params, 'color').name('color').onChange(tirePaint.apply)

    const sparkFolder = gui.addFolder('Sparks')
    sparkFolder.add(sparks.params, 'enabled').name('enabled')
    sparkFolder.add(sparks.params, 'intensity', 0, 4, 0.05).name('amount')
    sparkFolder.add(sparks.params, 'arcs', 0, 3, 0.05).name('electric arcs')
    sparkFolder.add(sparks.params, 'width', 1, 8, 0.5).name('thickness (px)')
    sparkFolder.addColor(sparks.params, 'color').name('color')

    const bg = gui.addFolder('Background')
    const redraw = () => background.redraw()
    bg.addColor(background.params, 'center').name('center color').onChange(redraw)
    bg.addColor(background.params, 'edge').name('edge color').onChange(redraw)
    bg.add(background.params, 'radius', 0.1, 2, 0.01).name('radius').onChange(redraw)

    const shading = gui.addFolder('Shading')
    shading.add(toonGlobals.uThreshold, 'value', -0.5, 0.5, 0.01).name('light/shadow threshold')
    shading.add(toonGlobals.uSoftness, 'value', 0.001, 0.3, 0.001).name('band softness')
    shading.addColor(colorProxy(toonGlobals.uShadowTint), 'value').name('shadow tint')
    shading.add(toonGlobals.uAmbient, 'value', 0, 1, 0.01).name('ambient')

    const rim = gui.addFolder('Rim light')
    rim.add(toonGlobals.uRimStrength, 'value', 0, 2, 0.01).name('intensity')
    rim.add(toonGlobals.uRimThreshold, 'value', 0.3, 0.98, 0.01).name('thickness (inv.)')

    const halftone = gui.addFolder('Halftone (comic)')
    halftone.add(toonGlobals.uHalftone, 'value').name('enabled')
    halftone.add(toonGlobals.uDotSpacing, 'value', 3, 24, 0.5).name('spacing (px)')
    halftone.add(toonGlobals.uDotSize, 'value', 0.2, 1.5, 0.01).name('max. size')
    const dotAngle = {
      get deg() { return THREE.MathUtils.radToDeg(toonGlobals.uDotAngle.value) },
      set deg(v) { toonGlobals.uDotAngle.value = THREE.MathUtils.degToRad(v) },
    }
    halftone.add(dotAngle, 'deg', 0, 90, 1).name('grid angle')
    halftone.add(toonGlobals.uDotDeep, 'value', 0, 1, 0.01).name('deep shadow start')
    halftone.add(toonGlobals.uDotTint, 'value', 0, 1, 0.01).name('blue tint')
    halftone.addColor(colorProxy(toonGlobals.uDotColor), 'value').name('ink color')

    const outline = gui.addFolder('Outline')
    outline.add(outlineParams.uThickness, 'value', 0, 8, 0.1).name('thickness (px)')
    outline.add(outlineOptions, 'fxaa').name('anti-aliasing (FXAA)')
    outline.add(outlineParams.uDepthThreshold, 'value', 0.001, 0.2, 0.001).name('depth sensitivity')
    outline.add(outlineParams.uNormalEdges, 'value').name('crease lines')
    outline.add(outlineParams.uNormalThreshold, 'value', 0.05, 1.5, 0.01).name('crease threshold')
    outline.addColor(colorProxy(outlineParams.uOutlineColor), 'value').name('color')

    const bloomFolder = gui.addFolder('Bloom')
    bloomFolder.add(bloomOptions, 'enabled').name('enabled')
    bloomFolder.add(bloomOptions, 'threshold', 0, 1, 0.01).name('threshold')
    bloomFolder.add(bloomOptions, 'knee', 0, 0.5, 0.01).name('softness')
    bloomFolder.add(bloomOptions, 'strength', 0, 2, 0.01).name('strength')
    bloomFolder.add(bloomOptions, 'radius', 0.5, 3, 0.05).name('spread')

    const sunFolder = gui.addFolder('Sun')
    const moveSun = () => sun.updatePosition()
    sunFolder.add(sun.params, 'azimuth', 0, 360, 1).name('azimuth').onChange(moveSun)
    sunFolder.add(sun.params, 'elevation', -89, 89, 1).name('elevation').onChange(moveSun)

    // Pastas de visual começam fechadas para o painel não tomar a tela
    for (const f of [bg, shading, rim, halftone, outline, bloomFolder, sunFolder]) f.close()
    this.preventFormRestore()
  }

  /**
   * Controles do carro. Criados depois do load, para o "valor inicial" (usado
   * no Restaurar) ser o padrão real.
   */
  addCarControls(params) {
    const f = this.carFolder
    f.add(params, 'maxSpeed', 2, 30, 0.5).name('top speed')
    f.add(params, 'acceleration', 1, 20, 0.5).name('acceleration')
    f.add(params, 'accelCurve', 0.5, 6, 0.1).name('acceleration curve')
    f.add(params, 'throttleResponse', 0, 2, 0.05).name('throttle response (s)')
    f.add(params, 'turnSpeed', 0.5, 6, 0.1).name('turn rate')
    f.add(params, 'steerResponse', 0, 1.5, 0.05).name('steering weight (s)')
    f.add(params, 'steerReturn', 0, 1, 0.05).name('steering return (s)')
    f.add(params, 'turnInertia', 0, 0.6, 0.01).name('turn inertia (s)')
    f.add(params, 'lean', 0, 3, 0.1).name('body lean')
    f.add(params, 'bounciness', 0, 1.5, 0.05).name('bump restitution')
    f.add(params, 'wallBounce', 0, 1.2, 0.05).name('wall restitution')
    f.add(params, 'knockDrag', 0.5, 10, 0.1).name('knockback friction')
    f.add(params, 'hop', 0, 3, 0.1).name('bounce')
  }

  /** Uma cor por grupo de material do carro. */
  addMaterialControls(materials) {
    for (const { name, material } of materials) {
      this.materialsFolder.addColor(colorProxy(material.uniforms.uColor), 'value').name(name)
    }
    this.materialsFolder.show()
    this.preventFormRestore()
  }

  /** Atualiza o painel depois de mudar cores por código (ex.: nova pintura). */
  showLivery(name) {
    this.materialsFolder.controllers.forEach((c) => c.updateDisplay())
    this.liveryButton.name(`Random livery (current: ${name})`)
  }

  /** Mostra/esconde o painel (F2). */
  toggle() {
    this.gui.show(this.gui._hidden)
  }

  load(settings) {
    this.gui.load(settings)
    this.preventFormRestore()
  }

  /**
   * Padrões do jogo: valores do código + o settings.json (o que todo jogador
   * recebe). Chamado antes de cada partida, para nenhum ajuste feito à mão
   * no painel (F2) vazar para a partida seguinte.
   */
  restoreGameDefaults(settings) {
    this.gui.reset()
    if (settings) this.gui.load(settings)
    this.preventFormRestore()
  }

  // O navegador pode "lembrar" caixinhas e campos de formulário ao reabrir
  // ou duplicar a aba; o painel não deve herdar nada disso
  preventFormRestore() {
    for (const input of this.gui.domElement.querySelectorAll('input')) input.autocomplete = 'off'
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
      button.name('Saved ✓')
    } catch (err) {
      console.error('Não foi possível salvar as configurações:', err)
      button.name('Save failed (see console)')
    }
    setTimeout(() => button.name('Save settings'), 2000)
  }
}
