import * as THREE from 'three'
import { FullScreenQuad } from 'three/examples/jsm/postprocessing/Pass.js'

// Bloom barato, em LDR (a imagem já vem em sRGB do passe de contorno).
//
// 1. Prefiltro: pega só o que passa do limite de brilho, em METADE da resolução.
// 2. Cadeia de LEVELS níveis (1/2, 1/4, 1/8), cada um com blur gaussiano
//    separável (horizontal + vertical). Níveis menores dão o halo largo.
// 3. Composite: soma os níveis por cima da imagem final (blend aditivo).
//
// Tudo em alvos de 8 bits e baixa resolução: custa bem menos que o
// UnrealBloomPass, e combina com o visual toon (sem HDR).

export const bloomOptions = {
  enabled: true,
  threshold: 0.9, // luminância mínima (0-1) para entrar no bloom
  knee: 0.08,     // largura da transição acima do limite
  strength: 0.4,
  radius: 1,      // espalhamento do blur (multiplica o passo)
}

const LEVELS = 3

const vertexShader = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = vec4(position.xy, 0.0, 1.0);
  }
`

const prefilterFragment = /* glsl */ `
  uniform sampler2D tDiffuse;
  uniform float uThreshold;
  uniform float uKnee;
  varying vec2 vUv;
  void main() {
    vec3 c = texture2D(tDiffuse, vUv).rgb;
    // Luminância (não o maior canal): cores saturadas de toon não devem brilhar.
    // Só o EXCESSO acima do limite entra, para o halo vir só do que é muito claro.
    float l = dot(c, vec3(0.2126, 0.7152, 0.0722));
    float excess = smoothstep(uThreshold, uThreshold + uKnee, l);
    gl_FragColor = vec4(c * excess, 1.0);
  }
`

// Cópia simples (usada para descer de nível, com filtro bilinear)
const copyFragment = /* glsl */ `
  uniform sampler2D tDiffuse;
  varying vec2 vUv;
  void main() {
    gl_FragColor = vec4(texture2D(tDiffuse, vUv).rgb, 1.0);
  }
`

// Gaussiano de 9 amostras reduzido a 5 leituras usando o filtro bilinear
const blurFragment = /* glsl */ `
  uniform sampler2D tDiffuse;
  uniform vec2 uStep; // direção * tamanho do texel * raio
  varying vec2 vUv;
  void main() {
    vec3 sum = texture2D(tDiffuse, vUv).rgb * 0.2270270270;
    sum += texture2D(tDiffuse, vUv + uStep * 1.3846153846).rgb * 0.3162162162;
    sum += texture2D(tDiffuse, vUv - uStep * 1.3846153846).rgb * 0.3162162162;
    sum += texture2D(tDiffuse, vUv + uStep * 3.2307692308).rgb * 0.0702702703;
    sum += texture2D(tDiffuse, vUv - uStep * 3.2307692308).rgb * 0.0702702703;
    gl_FragColor = vec4(sum, 1.0);
  }
`

const compositeFragment = /* glsl */ `
  uniform sampler2D tBloom0;
  uniform sampler2D tBloom1;
  uniform sampler2D tBloom2;
  uniform float uStrength;
  varying vec2 vUv;
  void main() {
    vec3 b = texture2D(tBloom0, vUv).rgb
           + texture2D(tBloom1, vUv).rgb
           + texture2D(tBloom2, vUv).rgb;
    gl_FragColor = vec4(b * uStrength, 1.0);
  }
`

function makeQuad(fragmentShader, uniforms, extra = {}) {
  return new FullScreenQuad(
    new THREE.ShaderMaterial({
      uniforms,
      vertexShader,
      fragmentShader,
      depthTest: false,
      depthWrite: false,
      ...extra,
    })
  )
}

export class Bloom {
  constructor() {
    this.levelsA = []
    this.levelsB = []
    for (let i = 0; i < LEVELS; i++) {
      this.levelsA.push(new THREE.WebGLRenderTarget(1, 1))
      this.levelsB.push(new THREE.WebGLRenderTarget(1, 1))
    }

    this.prefilter = makeQuad(prefilterFragment, {
      tDiffuse: { value: null },
      uThreshold: { value: 0 },
      uKnee: { value: 0 },
    })
    this.copy = makeQuad(copyFragment, { tDiffuse: { value: null } })
    this.blur = makeQuad(blurFragment, {
      tDiffuse: { value: null },
      uStep: { value: new THREE.Vector2() },
    })
    // Soma por cima do que já está no destino
    this.composite = makeQuad(
      compositeFragment,
      {
        tBloom0: { value: this.levelsA[0].texture },
        tBloom1: { value: this.levelsA[1].texture },
        tBloom2: { value: this.levelsA[2].texture },
        uStrength: { value: 1 },
      },
      { blending: THREE.AdditiveBlending, transparent: true }
    )
  }

  setSize(width, height) {
    for (let i = 0; i < LEVELS; i++) {
      const w = Math.max(1, Math.floor(width / 2 ** (i + 1)))
      const h = Math.max(1, Math.floor(height / 2 ** (i + 1)))
      this.levelsA[i].setSize(w, h)
      this.levelsB[i].setSize(w, h)
    }
  }

  // Gera o halo a partir de `source` (textura sRGB já com contorno)
  build(renderer, source) {
    const pu = this.prefilter.material.uniforms
    pu.tDiffuse.value = source
    pu.uThreshold.value = bloomOptions.threshold
    pu.uKnee.value = bloomOptions.knee
    renderer.setRenderTarget(this.levelsA[0])
    this.prefilter.render(renderer)

    const bu = this.blur.material.uniforms
    for (let i = 0; i < LEVELS; i++) {
      const a = this.levelsA[i]
      const b = this.levelsB[i]
      if (i > 0) {
        this.copy.material.uniforms.tDiffuse.value = this.levelsA[i - 1].texture
        renderer.setRenderTarget(a)
        this.copy.render(renderer)
      }
      const r = bloomOptions.radius
      bu.tDiffuse.value = a.texture
      bu.uStep.value.set((1 / a.width) * r, 0)
      renderer.setRenderTarget(b)
      this.blur.render(renderer)
      bu.tDiffuse.value = b.texture
      bu.uStep.value.set(0, (1 / a.height) * r)
      renderer.setRenderTarget(a)
      this.blur.render(renderer)
    }
  }

  // Soma o halo no alvo atual (tela)
  add(renderer) {
    this.composite.material.uniforms.uStrength.value = bloomOptions.strength / LEVELS
    // render() limparia a tela antes (autoClear) e apagaria a imagem por baixo
    const autoClear = renderer.autoClear
    renderer.autoClear = false
    this.composite.render(renderer)
    renderer.autoClear = autoClear
  }
}
