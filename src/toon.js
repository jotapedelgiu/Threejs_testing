import * as THREE from 'three'

// --- Uniforms globais -------------------------------------------------------
// Compartilhados por referência entre todos os materiais toon, então mexer
// aqui (ex.: pela GUI) atualiza a cena inteira de uma vez.
export const toonGlobals = {
  uThreshold: { value: 0.0 },     // onde fica a fronteira luz/sombra (N·L)
  uSoftness: { value: 0.03 },     // largura da transição entre as faixas
  uShadowTint: { value: new THREE.Color(0x5a6aa8) }, // sombra azulada, nunca preta
  uSkyColor: { value: new THREE.Color(0xbfe3ff) },
  uGroundColor: { value: new THREE.Color(0x7a8a4a) },
  uAmbient: { value: 0.25 },
  uRimColor: { value: new THREE.Color(0xffffff) },
  uRimStrength: { value: 0.4 },
  uRimThreshold: { value: 0.78 }, // quanto maior, mais fino o rim
  uSpecColor: { value: new THREE.Color(0xffffff) },

  // Retícula estilo quadrinhos (pontos em espaço de tela nas sombras)
  uHalftone: { value: true },
  uDotColor: { value: new THREE.Color(0x15121c) },
  uDotSpacing: { value: 7.0 },      // distância entre pontos, em pixels CSS
  uDotSize: { value: 1.0 },         // diâmetro máximo em relação ao espaçamento (>0.71 os pontos se fundem)
  uDotAngle: { value: Math.PI / 4 },
  uDotDeep: { value: 0.35 },        // quão fundo na sombra os pontos chegam ao tamanho máximo
  uDotTint: { value: 0.2 },         // 0 = sombra só com pontos, 1 = mantém o tom azulado
  uPixelRatio: { value: 1 },
}

// --- Material toon ----------------------------------------------------------
const toonVertex = /* glsl */ `
  #include <common>
  #include <skinning_pars_vertex>
  #include <fog_pars_vertex>
  #include <shadowmap_pars_vertex>

  uniform mat3 uMapTransform;

  varying vec2 vUv;
  varying vec3 vNormal;
  varying vec3 vWorldNormal;
  varying vec3 vViewPosition;

  void main() {
    #include <beginnormal_vertex>
    #include <skinbase_vertex>
    #include <skinnormal_vertex>
    #include <defaultnormal_vertex>
    #include <begin_vertex>
    #include <skinning_vertex>
    #include <project_vertex>
    #include <worldpos_vertex>
    #include <shadowmap_vertex>
    #include <fog_vertex>

    vUv = (uMapTransform * vec3(uv, 1.0)).xy; // repeat/offset da textura
    vNormal = normalize(transformedNormal);
    vWorldNormal = normalize(mat3(modelMatrix) * objectNormal);
    vViewPosition = -mvPosition.xyz;
  }
`

const toonFragment = /* glsl */ `
  uniform vec3 uColor;
  #ifdef USE_TOON_MAP
    uniform sampler2D uMap;
  #endif
  uniform vec3 uEmissive;
  uniform float uOpacity;
  uniform float uRimAmount;
  uniform float uGlossiness;
  uniform float uThreshold;
  uniform float uSoftness;
  uniform vec3 uShadowTint;
  uniform vec3 uSkyColor;
  uniform vec3 uGroundColor;
  uniform float uAmbient;
  uniform vec3 uRimColor;
  uniform float uRimStrength;
  uniform float uRimThreshold;
  uniform vec3 uSpecColor;

  uniform bool uHalftone;
  uniform vec3 uDotColor;
  uniform float uDotSpacing;
  uniform float uDotSize;
  uniform float uDotAngle;
  uniform float uDotDeep;
  uniform float uDotTint;
  uniform float uPixelRatio;

  varying vec2 vUv;
  varying vec3 vNormal;
  varying vec3 vWorldNormal;
  varying vec3 vViewPosition;

  #include <common>
  #include <packing>
  #include <lights_pars_begin>
  #include <shadowmap_pars_fragment>
  #include <fog_pars_fragment>

  float band(float x, float edge) {
    return smoothstep(edge - uSoftness, edge + uSoftness, x);
  }

  // Grade de pontos redondos em pixels de tela, girada por angle. Retorna 1
  // dentro do ponto, 0 fora, com 1px de antialias. radius = 0 some o ponto.
  float halftoneDots(float angle, float spacing, float radius) {
    float c = cos(angle), s = sin(angle);
    vec2 p = mat2(c, -s, s, c) * gl_FragCoord.xy / spacing;
    float d = length(fract(p) - 0.5) * spacing; // distância ao centro da célula
    return (1.0 - smoothstep(radius - 0.5, radius + 0.5, d)) * clamp(radius, 0.0, 1.0);
  }

  void main() {
    // Em materiais DoubleSide a face de trás precisa da normal invertida
    float faceSign = gl_FrontFacing ? 1.0 : -1.0;
    vec3 N = normalize(vNormal) * faceSign;
    vec3 V = normalize(vViewPosition);

    vec3 baseColor = uColor;
    #ifdef USE_TOON_MAP
      baseColor *= texture2D(uMap, vUv).rgb;
    #endif

    vec3 lit = vec3(0.0);   // cor da luz que chega nas partes iluminadas
    vec3 lightTotal = vec3(0.0); // soma das luzes, ignorando sombra
    float shade = -1.0;     // N·L contínuo, com sombra projetada contando como escuro
    float litMask = 0.0;    // 0 = sombra, 1 = luz (já em faixas)
    float spec = 0.0;
    float rimMask = 0.0;

    #if NUM_DIR_LIGHTS > 0
      DirectionalLight dirLight;
      #if defined( USE_SHADOWMAP ) && NUM_DIR_LIGHT_SHADOWS > 0
        DirectionalLightShadow dirShadow;
      #endif

      #pragma unroll_loop_start
      for (int i = 0; i < NUM_DIR_LIGHTS; i++) {
        dirLight = directionalLights[ i ];
        vec3 L = dirLight.direction;
        float NdL = dot(N, L);

        float shadow = 1.0;
        #if defined( USE_SHADOWMAP ) && ( UNROLLED_LOOP_INDEX < NUM_DIR_LIGHT_SHADOWS )
          dirShadow = directionalLightShadows[ i ];
          shadow = receiveShadow ? getShadow( directionalShadowMap[ i ], dirShadow.shadowMapSize, dirShadow.shadowIntensity, dirShadow.shadowBias, dirShadow.shadowRadius, vDirectionalShadowCoord[ i ] ) : 1.0;
          shadow = smoothstep(0.45, 0.55, shadow); // sombra projetada também em faixa dura
        #endif

        lightTotal += dirLight.color;
        shade = max(shade, mix(-1.0, NdL, shadow));

        float m = band(NdL, uThreshold) * shadow;
        litMask = max(litMask, m);
        lit += dirLight.color * m;

        // Brilho especular em uma faixa só (Blinn-Phong quantizado)
        vec3 H = normalize(L + V);
        float s = pow(max(dot(N, H), 0.0), uGlossiness * uGlossiness);
        spec += smoothstep(0.5 - uSoftness, 0.5 + uSoftness, s) * m;

        // Rim aparece só no lado iluminado, como em BotW
        rimMask = max(rimMask, smoothstep(-0.1, 0.4, NdL) * shadow);
      }
      #pragma unroll_loop_end
    #endif

    // Ambiente hemisférico: céu por cima, grama por baixo
    float hemi = vWorldNormal.y * faceSign * 0.5 + 0.5;
    vec3 ambient = mix(uGroundColor, uSkyColor, hemi) * uAmbient;

    // Na sombra a cor base é multiplicada pelo tom azulado; na luz, pela luz
    vec3 shadowSide = baseColor * uShadowTint;
    if (uHalftone) {
      // Nos quadrinhos a sombra é a cor chapada + tinta; o tom azulado é opcional
      shadowSide = mix(baseColor * lightTotal * 0.85, shadowSide, uDotTint);
    }
    vec3 col = mix(shadowSide, baseColor * lit, litMask) + baseColor * ambient;

    // Rim light (fresnel em faixa)
    float fresnel = 1.0 - max(dot(N, V), 0.0);
    float rim = band(fresnel, uRimThreshold) * rimMask;
    col += uRimColor * rim * uRimStrength * uRimAmount;

    col += uSpecColor * spec * step(0.0, uGlossiness - 0.001) * 0.6;
    col += uEmissive; // luzes/lâmpadas: cor própria, ignora luz e sombra

    if (uHalftone) {
      float spacing = uDotSpacing * uPixelRatio;
      // Pontos nascem pequenos um pouco antes da fronteira luz/sombra...
      float a1 = 1.0 - smoothstep(uThreshold - 0.35, uThreshold + 0.05, shade);
      // ...e chegam ao tamanho máximo nas sombras profundas / projetadas
      float a2 = 1.0 - smoothstep(uThreshold - uDotDeep - 0.3, uThreshold - uDotDeep, shade);
      float amount = mix(a1 * 0.6, 1.0, a2);
      float radius = amount * uDotSize * spacing * 0.5;
      float ink = halftoneDots(uDotAngle, spacing, radius);
      col = mix(col, uDotColor, ink);
    }

    gl_FragColor = vec4(col, uOpacity);

    #include <tonemapping_fragment>
    #include <colorspace_fragment>
    #include <fog_fragment>
  }
`

/**
 * Material toon estilo Zelda.
 * @param {object} opts
 * @param {THREE.ColorRepresentation} opts.color cor base
 * @param {number} [opts.glossiness] 0 desliga o especular; ~6-12 dá um brilho pequeno
 * @param {THREE.Texture} [opts.map] textura de cor (base color)
 * @param {THREE.ColorRepresentation} [opts.emissive] cor emitida (não recebe sombra)
 * @param {number} [opts.rim] multiplicador do rim light (0 desliga; bom para chão)
 * @param {number} [opts.opacity] < 1 deixa o material transparente (ex.: vidro)
 * @param {THREE.Side} [opts.side]
 */
export function createToonMaterial({ color = 0xffffff, glossiness = 0, map = null, emissive = 0x000000, rim = 1, opacity = 1, side = THREE.FrontSide } = {}) {
  // Usa a matriz da própria textura (repeat/offset/rotation); quem mudar o
  // repeat depois precisa chamar texture.updateMatrix()
  if (map) map.updateMatrix()
  return new THREE.ShaderMaterial({
    uniforms: {
      ...THREE.UniformsUtils.merge([THREE.UniformsLib.lights, THREE.UniformsLib.fog]),
      ...toonGlobals,
      uColor: { value: new THREE.Color(color) },
      uMap: { value: map },
      uMapTransform: { value: map ? map.matrix : new THREE.Matrix3() },
      uRimAmount: { value: rim },
      uEmissive: { value: new THREE.Color(emissive) },
      uOpacity: { value: opacity },
      uGlossiness: { value: glossiness },
    },
    defines: map ? { USE_TOON_MAP: '' } : {},
    vertexShader: toonVertex,
    fragmentShader: toonFragment,
    lights: true,
    transparent: opacity < 1,
    depthWrite: opacity >= 1,
    fog: true,
    side,
  })
}

/** Cria um mesh com o material toon. */
export function toonMesh(geometry, opts = {}) {
  return new THREE.Mesh(geometry, createToonMaterial(opts))
}

/**
 * Troca os materiais de um modelo carregado (ex.: glTF) pelo toon,
 * aproveitando cor, textura e emissivo. Cada material de origem vira UM
 * material toon, compartilhado por todas as peças que o usavam; assim mudar
 * a cor dele muda todas as peças daquele ID.
 * @param {(source: THREE.Material) => THREE.Material | undefined} [materialFor]
 *   permite escolher o material toon de cada material de origem (ex.: agrupar
 *   vários IDs num só); se devolver undefined, converte o original
 * @returns {{ source: THREE.Material, material: THREE.ShaderMaterial }[]}
 */
export function toonify(root, materialFor = () => undefined) {
  const converted = new Map() // material de origem -> material toon
  root.traverse((mesh) => {
    if (!mesh.isMesh) return
    // Modelos exportados sem normais: calcula normais suaves
    if (!mesh.geometry.getAttribute('normal')) mesh.geometry.computeVertexNormals()
    const src = mesh.material
    if (!converted.has(src)) {
      const chosen = materialFor(src)
      if (chosen) converted.set(src, chosen)
    }
    if (!converted.has(src)) {
      // Vidro (transmission) ou transparente: o toon não refrata, só deixa translúcido
      const seeThrough = (src.transmission ?? 0) > 0 || (src.transparent && src.opacity < 1)
      converted.set(src, createToonMaterial({
        color: src.color ?? 0xffffff,
        map: src.map ?? null,
        // Intensidades HDR (ex.: 11) estourariam tudo sem tone mapping; limita a 1
        emissive: src.emissive
          ? src.emissive.clone().multiplyScalar(Math.min(src.emissiveIntensity ?? 1, 1))
          : 0x000000,
        opacity: seeThrough ? Math.min(src.opacity, 0.35) : 1,
        side: src.side,
      }))
    }
    mesh.material = converted.get(src)
    mesh.castShadow = true
    mesh.receiveShadow = true
  })
  for (const src of converted.keys()) src.dispose()
  return [...converted].map(([source, material]) => ({ source, material }))
}
