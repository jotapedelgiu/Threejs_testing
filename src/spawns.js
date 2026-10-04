// Onde cada jogador nasce. Sem dependências, para poder ser testado no Node.
//
// Início da partida: um canto da arena para cada jogador, pela ordem de
// chegada na sala (o 5º volta para o 1º canto, e assim por diante).
//
// Renascimento (depois do nocaute), no estilo dos deathmatch de FPS:
//  - Quake 3 (SelectRandomFurthestSpawnPoint): descarta os pontos onde alguém
//    está em cima ("telefrag"), ordena pela distância e sorteia entre a metade
//    melhor, então é longe sem ser previsível.
//  - Halo 3: cada ponto ganha uma nota; inimigos por perto e o lugar onde
//    você acabou de morrer baixam a nota.
// Aqui a nota é a distância até o inimigo mais próximo, mais um pouco da
// distância até onde morri; o último ponto usado fica de fora (nasce sempre
// num lugar diferente).

const SAFE_RADIUS = 6     // m: com alguém mais perto que isso, o ponto não serve
const ENEMY_CAP = 40      // m: mais longe que isso já está "vazio", tanto faz
const DEATH_WEIGHT = 0.5  // peso da distância até onde morri

/**
 * Pontos de nascimento da arena: grade 5 x 3 (os 4 cantos, meios das bordas,
 * miolo), sem os que caem em cima de obstáculos.
 * @param {number} rangeX metade da largura usada (centro dos pontos)
 * @param {number} rangeZ metade da profundidade usada
 * @param {(x: number, z: number) => boolean} isFree ponto livre de obstáculos?
 * @returns {{ x: number, z: number }[]}
 */
export function spawnPoints(rangeX, rangeZ, isFree = () => true) {
  const points = []
  for (const fz of [-1, 0, 1]) {
    for (const fx of [-1, -0.5, 0, 0.5, 1]) {
      const p = { x: fx * rangeX, z: fz * rangeZ }
      if (isFree(p.x, p.z)) points.push(p)
    }
  }
  return points
}

/** Os 4 cantos, na ordem em que os jogadores são distribuídos. */
export function cornerPoints(rangeX, rangeZ) {
  return [
    { x: -rangeX, z: -rangeZ },
    { x: rangeX, z: rangeZ },   // o 2º jogador fica no canto oposto ao 1º
    { x: rangeX, z: -rangeZ },
    { x: -rangeX, z: rangeZ },
  ]
}

/**
 * Canto de cada jogador: posição na ordem de chegada (desempate pelo id, igual
 * para todos).
 * @param {{ id: string, since: number }[]} members todos da sala, eu incluído
 */
export function cornerIndex(members, myId) {
  const order = [...members].sort((a, b) => a.since - b.since || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
  return Math.max(0, order.findIndex((m) => m.id === myId)) % 4
}

/**
 * Escolhe onde renascer.
 * @param {{ x: number, z: number }[]} points de spawnPoints
 * @param {{
 *   enemies: { x: number, z: number }[], // carros dos outros (os que estão na arena)
 *   death?: { x: number, z: number },   // onde morri
 *   last?: { x: number, z: number },    // onde nasci da última vez
 *   random?: () => number,
 * }} opts
 */
export function chooseRespawn(points, { enemies, death, last, random = Math.random }) {
  const nearestEnemy = (p) => enemies.reduce((best, e) => Math.min(best, Math.hypot(e.x - p.x, e.z - p.z)), Infinity)
  let options = points.map((p) => ({ p, enemy: nearestEnemy(p) }))
  // Alguém em cima: não serve (a não ser que nenhum sirva)
  const safe = options.filter((o) => o.enemy >= SAFE_RADIUS)
  if (safe.length) options = safe
  // Sempre um lugar diferente do último
  const fresh = options.filter((o) => !last || o.p.x !== last.x || o.p.z !== last.z)
  if (fresh.length) options = fresh
  if (!options.length) return null

  for (const o of options) {
    const awayFromDeath = death ? Math.min(Math.hypot(death.x - o.p.x, death.z - o.p.z), ENEMY_CAP) : 0
    o.score = Math.min(o.enemy, ENEMY_CAP) + DEATH_WEIGHT * awayFromDeath
  }
  options.sort((a, b) => b.score - a.score)
  // Sorteio entre a metade melhor (Quake 3)
  const top = Math.max(1, Math.ceil(options.length / 2))
  return options[Math.floor(random() * top)].p
}

/** Ângulo para o carro nascer olhando para o centro da arena. */
export function yawToCenter(x, z) {
  return Math.atan2(-x, -z)
}
