import * as THREE from 'three'

// Pintura dos carrinhos: liveries (pares de cores), leitura das cores atuais e
// o brilho do boost. Vale para o meu carro e para os carros remotos.

// Pinturas: duas cores análogas (vizinhas no círculo cromático) para a
// carroceria principal e a secundária. A secundária é um pouco mais clara para
// as duas partes se separarem bem no toon.
export const LIVERIES = [
  { name: 'Blaze', primary: '#e63946', secondary: '#f4a261' },
  { name: 'Ocean', primary: '#1d6fd8', secondary: '#2ec4b6' },
  { name: 'Lime', primary: '#5fae1e', secondary: '#f2d43d' },
  { name: 'Grape', primary: '#7b2cbf', secondary: '#e056a0' },
  { name: 'Sunset', primary: '#ff6b00', secondary: '#ffc300' },
  { name: 'Mint', primary: '#1f9e63', secondary: '#38d1d6' },
  { name: 'Coral', primary: '#e5386d', secondary: '#ff8a5c' },
  { name: 'Midnight', primary: '#3a3dce', secondary: '#a066e8' },
  { name: 'Turquoise', primary: '#14b89a', secondary: '#4fb3f0' },
]

/** Sorteia uma pintura, evitando os nomes em `taken` sempre que possível. */
export function pickLivery(taken = []) {
  const free = LIVERIES.filter((l) => !taken.includes(l.name))
  const pool = free.length ? free : LIVERIES
  return pool[Math.floor(Math.random() * pool.length)]
}

/** Cores atuais (hex) de uma lista de materiais toon. */
export function readColors(materials) {
  return materials.map((m) => '#' + m.uniforms.uColor.value.getHexString())
}

/** Aplica cores (hex) nos materiais, só onde mudou. */
export function writeColors(materials, colors) {
  materials.forEach((m, i) => {
    if (colors[i] && readColors([m])[0] !== colors[i].toLowerCase()) m.uniforms.uColor.value.set(colors[i])
  })
}

/** Fundo da bolinha do placar com as duas cores da pintura. */
export const swatch = ([a, b]) => `linear-gradient(135deg, ${a} 50%, ${b} 50%)`

// Brilho da carroceria enquanto o boost está ativo
const BOOST_GLOW = new THREE.Color('#3fd0ff').multiplyScalar(0.45)
const NO_GLOW = new THREE.Color(0x000000)

export function setBoostGlow(materials, on) {
  for (const m of materials) m.uniforms.uEmissive.value.copy(on ? BOOST_GLOW : NO_GLOW)
}

// Ultimate ativo: carroceria pulsando em amarelo elétrico
const ULT_GLOW = new THREE.Color('#ffd21f')
/** @param {number} pulse 0..1 */
export function setUltimateGlow(materials, pulse) {
  for (const m of materials) m.uniforms.uEmissive.value.copy(ULT_GLOW).multiplyScalar(0.25 + 0.35 * pulse)
}

// --- Materiais do modelo --------------------------------------------------------
// Os materiais do glTF são agrupados em poucos materiais toon; cada grupo vira
// uma cor no painel. O agrupamento é pelo NOME do material no Blender (os IDs
// mudam a cada exportação), ignorando o sufixo que o Blender põe em cópias
// ("Body 1.001" conta como "Body 1"). Nomes genéricos ("Material.002") são
// listados exatos. Material que não estiver em nenhum grupo cai em
// DEFAULT_GROUP. Os dois primeiros grupos são a carroceria, pintada pela
// livery de cada jogador.
export const MATERIAL_GROUPS = [
  { name: 'Body (primary)', color: '#3a3dce', glossiness: 8, materials: ['Body 1'] },
  {
    name: 'Body (secondary)', color: '#a066e8', glossiness: 8,
    materials: ['Special Metallic Car Paint', 'Material.005', 'Material.002'], // .005/.002: retrovisor
  },
  {
    name: 'Metal & trim', color: '#0000ff', glossiness: 10,
    materials: ['Car chrome', 'Brushed Aluminum 2', 'glass', 'Iron Touched', 'iron.001', 'Red light'],
  },
  {
    name: 'Rubber & seat', color: '#2a2a30', glossiness: 0,
    materials: ['rubber base', 'Elastic Rubber', 'Material.001', 'HL Bulb Glow', 'HL Bulb Glow.001', 'Procedural Leather'],
  },
]
export const DEFAULT_GROUP = 2 // metal e detalhes
const withoutCopySuffix = (name) => name.replace(/\.\d{3}$/, '')

/** Índice do grupo de um material pelo nome (exato primeiro, depois sem sufixo). */
export function materialGroup(name) {
  const exact = MATERIAL_GROUPS.findIndex((g) => g.materials.includes(name))
  if (exact !== -1) return exact
  const base = withoutCopySuffix(name)
  return MATERIAL_GROUPS.findIndex((g) => g.materials.some((m) => withoutCopySuffix(m) === base && !/^Material$/.test(base)))
}
