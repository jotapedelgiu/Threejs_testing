import * as THREE from 'three'
import { FullScreenQuad } from 'three/examples/jsm/postprocessing/Pass.js'
import { FXAAShader } from 'three/examples/jsm/shaders/FXAAShader.js'

// Contorno em espaço de tela (pós-processamento).
//
// 1. Renderiza a cena normalmente num render target (cor).
// 2. Renderiza de novo com MeshNormalMaterial num segundo target que também
//    guarda a profundidade.
// 3. Um quad de tela cheia compara cada pixel com os vizinhos: se algum vizinho
//    está bem MAIS PERTO da câmera, este pixel está logo fora de uma silhueta
//    e vira contorno. O limite é relativo à distância, então desníveis
//    pequenos (sobrancelha/olho, nariz) não geram linha, mas a borda do corpo
//    contra o fundo ou um braço na frente do tronco geram.
// 4. Opcional: FXAA na imagem final, para suavizar o serrilhado do contorno.

export const outlineParams = {
  uOutlineColor: { value: new THREE.Color(0x000000) },
  uThickness: { value: 1.4 },        // em pixels CSS
  uDepthThreshold: { value: 0.001 }, // salto de profundidade relativo (0,1%)
  uNormalEdges: { value: false },    // linhas também em dobras (mudança de normal)
  uNormalThreshold: { value: 0.6 },
}

export const outlineOptions = {
  fxaa: true, // suavização (anti-aliasing) no final
}

const edgeShader = {
  vertexShader: /* glsl */ `
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = vec4(position.xy, 0.0, 1.0);
    }
  `,
  fragmentShader: /* glsl */ `
    #include <packing>

    uniform sampler2D tColor;
    uniform sampler2D tNormal;
    uniform sampler2D tDepth;
    uniform vec2 uResolution;
    uniform float uPixelRatio;
    uniform float cameraNear;
    uniform float cameraFar;
    uniform vec2 uTanHalfFov; // tan(fov/2) em x e y, para reconstruir a direção de visão

    uniform vec3 uOutlineColor;
    uniform float uThickness;
    uniform float uDepthThreshold;
    uniform bool uNormalEdges;
    uniform float uNormalThreshold;

    varying vec2 vUv;

    float linearDepth(vec2 uv) {
      float d = texture2D(tDepth, uv).x;
      return -perspectiveDepthToViewZ(d, cameraNear, cameraFar);
    }

    vec3 viewNormal(vec2 uv) {
      return texture2D(tNormal, uv).xyz * 2.0 - 1.0;
    }

    void main() {
      vec4 color = texture2D(tColor, vUv);
      float depth = linearDepth(vUv);
      vec3 normal = viewNormal(vUv);

      vec2 px = 1.0 / uResolution;
      float radius = max(uThickness * uPixelRatio, 0.0);

      // Superfícies vistas de raspão (ex.: chão perto do horizonte) mudam muito
      // de profundidade de um pixel para o outro sem ter borda nenhuma. O salto
      // esperado num plano é ~ (ângulo do pixel) * tan(ângulo de visão); o
      // limite cresce com ele para não pintar uma faixa preta no horizonte.
      bool isBackground = texture2D(tDepth, vUv).x >= 0.99999;
      vec3 viewDir = normalize(vec3((vUv * 2.0 - 1.0) * uTanHalfFov, -1.0));
      float cosV = clamp(abs(dot(normal, viewDir)), 0.02, 1.0);
      float tanV = sqrt(1.0 - cosV * cosV) / cosV;
      float pixelAngle = 2.0 * uTanHalfFov.y / uResolution.y;

      float edge = 0.0;
      // Dois anéis de 8 amostras (raio cheio e meio raio) para linhas grossas
      // não falharem em detalhes finos.
      for (int ring = 1; ring <= 2; ring++) {
        float r = radius * float(ring) * 0.5;
        for (int i = 0; i < 8; i++) {
          float a = float(i) * 0.78539816;
          vec2 uv = vUv + vec2(cos(a), sin(a)) * r * px;
          float d = linearDepth(uv);

          // Vizinho mais perto que eu => estou fora da silhueta dele
          float rel = (depth - d) / d;
          float grazing = isBackground ? 0.0 : 2.0 * r * pixelAngle * tanV;
          float threshold = uDepthThreshold + grazing;
          edge = max(edge, smoothstep(threshold, threshold * 1.5, rel));

          if (uNormalEdges && d <= depth * (1.0 + uDepthThreshold)) {
            float nd = 1.0 - dot(normal, viewNormal(uv));
            edge = max(edge, smoothstep(uNormalThreshold, uNormalThreshold + 0.1, nd));
          }
        }
      }

      gl_FragColor = vec4(mix(color.rgb, uOutlineColor, edge), 1.0);
      // Sai sempre em sRGB: o FXAA precisa da imagem já em espaço de tela
      // (perceptual) para medir o contraste, e a tela também espera sRGB.
      gl_FragColor = sRGBTransferOETF(gl_FragColor);
    }
  `,
}

export class ScreenOutline {
  constructor(renderer, scene, camera) {
    this.renderer = renderer
    this.scene = scene
    this.camera = camera

    // Sombras são atualizadas só no passe de cor, não no de normais
    renderer.shadowMap.autoUpdate = false

    this.colorTarget = this.createColorTarget()
    this.normalTarget = new THREE.WebGLRenderTarget(1, 1, {
      depthTexture: new THREE.DepthTexture(1, 1),
    })
    this.normalMaterial = new THREE.MeshNormalMaterial({ side: THREE.DoubleSide })
    // Objetos sem superfície (ex.: faíscas em linha) ficam fora do passe de
    // normais/profundidade: não ganham contorno nem escondem o que está atrás
    this.skipInNormalPass = []
    // Resultado do contorno (já em sRGB), entrada do FXAA
    this.edgeTarget = new THREE.WebGLRenderTarget(1, 1)

    this.fxaaQuad = new FullScreenQuad(
      new THREE.ShaderMaterial({
        uniforms: THREE.UniformsUtils.clone(FXAAShader.uniforms),
        vertexShader: FXAAShader.vertexShader,
        fragmentShader: FXAAShader.fragmentShader,
        depthTest: false,
        depthWrite: false,
      })
    )
    this.fxaaQuad.material.uniforms.tDiffuse.value = this.edgeTarget.texture

    this.quad = new FullScreenQuad(
      new THREE.ShaderMaterial({
        uniforms: {
          ...outlineParams,
          tColor: { value: this.colorTarget.texture },
          tNormal: { value: this.normalTarget.texture },
          tDepth: { value: this.normalTarget.depthTexture },
          uResolution: { value: new THREE.Vector2(1, 1) },
          uPixelRatio: { value: 1 },
          cameraNear: { value: camera.near },
          cameraFar: { value: camera.far },
          uTanHalfFov: { value: new THREE.Vector2(1, 1) },
        },
        ...edgeShader,
        depthTest: false,
        depthWrite: false,
      })
    )
    this.setSize()
  }

  // Cor da cena. MSAA (4 amostras) só sem FXAA: com o FXAA ligado as bordas
  // já são suavizadas no fim, e MSAA em ponto flutuante é caro em tela grande
  createColorTarget() {
    const size = this.size ?? new THREE.Vector2(1, 1)
    this.colorSamples = outlineOptions.fxaa ? 0 : 4
    return new THREE.WebGLRenderTarget(size.x, size.y, {
      type: THREE.HalfFloatType, // a cor fica linear aqui; 8 bits daria banding
      samples: this.colorSamples,
    })
  }

  // Troca o alvo de cor se o FXAA foi ligado/desligado no painel
  syncColorTarget() {
    if (this.colorSamples === (outlineOptions.fxaa ? 0 : 4)) return
    this.colorTarget.dispose()
    this.colorTarget = this.createColorTarget()
    this.quad.material.uniforms.tColor.value = this.colorTarget.texture
  }

  setSize() {
    const size = this.renderer.getDrawingBufferSize(new THREE.Vector2())
    this.size = size
    this.colorTarget.setSize(size.x, size.y)
    this.normalTarget.setSize(size.x, size.y)
    this.edgeTarget.setSize(size.x, size.y)
    this.fxaaQuad.material.uniforms.resolution.value.set(1 / size.x, 1 / size.y)
    const u = this.quad.material.uniforms
    u.uResolution.value.copy(size)
    u.uPixelRatio.value = this.renderer.getPixelRatio()
  }

  render() {
    const { renderer, scene, camera } = this
    this.syncColorTarget()
    const u = this.quad.material.uniforms
    u.cameraNear.value = camera.near
    u.cameraFar.value = camera.far
    const tanY = Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2)
    u.uTanHalfFov.value.set(tanY * camera.aspect, tanY)

    renderer.shadowMap.needsUpdate = true
    renderer.setRenderTarget(this.colorTarget)
    renderer.render(scene, camera)

    const background = scene.background
    scene.background = null
    scene.overrideMaterial = this.normalMaterial
    const skipped = this.skipInNormalPass.filter((o) => o.visible)
    for (const o of skipped) o.visible = false
    renderer.setRenderTarget(this.normalTarget)
    renderer.render(scene, camera)
    for (const o of skipped) o.visible = true
    scene.overrideMaterial = null
    scene.background = background

    if (outlineOptions.fxaa) {
      renderer.setRenderTarget(this.edgeTarget)
      this.quad.render(renderer)
      renderer.setRenderTarget(null)
      this.fxaaQuad.render(renderer)
    } else {
      renderer.setRenderTarget(null)
      this.quad.render(renderer)
    }
  }
}
