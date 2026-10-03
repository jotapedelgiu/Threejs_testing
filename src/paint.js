import * as THREE from 'three'

// Pintura dos carrinhos: liveries (pares de cores), leitura das cores atuais e
// o brilho do boost. Vale para o meu carro e para os carros remotos.

// Pinturas: duas cores análogas (vizinhas no círculo cromático) para a
// carroceria principal e a secundária. A secundária é um pouco mais clara para
// as duas partes se separarem bem no toon.
export const LIVERIES = [
  { name: 'Fogo', primary: '#e63946', secondary: '#f4a261' },
  { name: 'Oceano', primary: '#1d6fd8', secondary: '#2ec4b6' },
  { name: 'Limão', primary: '#5fae1e', secondary: '#f2d43d' },
  { name: 'Uva', primary: '#7b2cbf', secondary: '#e056a0' },
  { name: 'Pôr do sol', primary: '#ff6b00', secondary: '#ffc300' },
  { name: 'Menta', primary: '#1f9e63', secondary: '#38d1d6' },
  { name: 'Coral', primary: '#e5386d', secondary: '#ff8a5c' },
  { name: 'Noite', primary: '#3a3dce', secondary: '#a066e8' },
  { name: 'Turquesa', primary: '#14b89a', secondary: '#4fb3f0' },
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
