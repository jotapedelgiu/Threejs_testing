// Números aleatórios com semente: a mesma semente dá sempre a mesma sequência.
// Sem servidor, é assim que todos os jogadores da sala sorteiam as mesmas
// posições (esferas, bastões) sem precisar combinar pela rede.

// Hash de string (cyrb53) -> semente; mulberry32 -> números em [0, 1)
export function hashString(str) {
  let h1 = 0xdeadbeef, h2 = 0x41c6ce57
  for (let i = 0; i < str.length; i++) {
    const ch = str.charCodeAt(i)
    h1 = Math.imul(h1 ^ ch, 2654435761)
    h2 = Math.imul(h2 ^ ch, 1597334677)
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909)
  return h1 >>> 0
}
export function mulberry32(seed) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** Gerador de números em [0, 1) a partir de um texto (ex.: "sala:bastao:3"). */
export function seededRandom(seed) {
  return mulberry32(hashString(seed))
}
