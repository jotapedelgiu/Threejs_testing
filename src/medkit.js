import { MAX_HEALTH } from './damage.js'

// Zona de cura: círculo no chão que aparece perto da briga quando alguém está
// com a vida baixa e dura alguns segundos. Quem estiver dentro recupera uma
// % fixa da vida que falta, por segundo; ficando o tempo todo, recupera
// MEDKIT.healOfMissing (90%) da vida perdida. Todos que estiverem dentro curam,
// então ninguém "rouba" a cura de ninguém. Sem dependências de navegador,
// para poder ser testado no Node.
//
// Com muitos jogadores pode haver duas brigas longe uma da outra: aí cabem
// duas zonas (uma por briga, nunca lado a lado).
//
// Como o item do ultimate (ultimate.js), quem decide QUANDO e ONDE é o
// ANFITRIÃO da sala; cada jogador cura a própria vida enquanto está dentro.

export const MEDKIT = {
  lowHp: 35,          // alguém com vida <= isso libera o sorteio
  checkEvery: 3,      // s entre sorteios enquanto alguém está com vida baixa
  chance: 0.3,        // chance de aparecer a cada sorteio
  gap: 25,            // s depois de uma zona acabar até poder aparecer outra NAQUELA região
  duration: 8,        // s que a zona fica no chão
  radius: 6,          // m
  healOfMissing: 0.9, // ficando a zona inteira dentro, cura 90% da vida perdida
  nearWeakest: [3, 8], // m: o centro da zona fica a essa distância de quem tem menos vida
  separation: 25,     // m: briga "coberta" por uma zona (ativa ou recém-acabada)
  playersPerZone: 5,  // 1 zona até 5 jogadores, 2 de 6 a 10...
  maxZones: 2,
}

/** Quantas zonas podem existir ao mesmo tempo com `players` na sala. */
export const maxZonesFor = (players) => Math.min(MEDKIT.maxZones, Math.max(1, Math.ceil(players / MEDKIT.playersPerZone)))

// % da vida que falta curada por segundo. Curando sempre a mesma fração do
// que falta, depois de `duration` segundos sobra e^(-taxa·t); para sobrar
// 10%: taxa = -ln(1 - 0,9) / duração (≈ 0,29 por segundo em 8 s)
export const HEAL_RATE = -Math.log(1 - MEDKIT.healOfMissing) / MEDKIT.duration

/**
 * Cura de um jogador dentro da zona. A vida é inteira; o que sobra de fração
 * fica guardado para o próximo passo.
 */
export class ZoneHealing {
  carry = 0

  /** @returns quanto curar agora (inteiro) */
  update(dt, hp) {
    this.carry += HEAL_RATE * (MAX_HEALTH - hp) * dt
    const whole = Math.floor(this.carry)
    this.carry -= whole
    return Math.min(whole, MAX_HEALTH - hp)
  }
}

/**
 * Onde a zona aparece: perto da briga, com o centro a MEDKIT.nearWeakest de
 * quem tem menos vida (ele precisa se mexer um pouco; quem está batendo nele
 * também pode entrar). Sorteia entre os melhores lugares.
 * @param {{ x: number, z: number }[]} points lugares possíveis (livres de obstáculos)
 * @param {{ x: number, z: number, hp: number }[]} players carros na arena
 * @returns {{ x: number, z: number } | null}
 */
export function placeNearFight(points, players, random = Math.random) {
  if (!points.length || !players.length) return null
  const weakest = players.reduce((a, b) => (b.hp < a.hp ? b : a))
  const [near, far] = MEDKIT.nearWeakest
  const ideal = (near + far) / 2
  const options = points.map((p) => {
    const dw = Math.hypot(p.x - weakest.x, p.z - weakest.z)
    return { p, off: dw < near ? (near - dw) * 2 : dw > far ? dw - far : Math.abs(dw - ideal) * 0.1 }
  })
  options.sort((a, b) => a.off - b.off)
  const top = Math.min(options.length, 6)
  return options[Math.floor(random() * top)].p
}

export class MedkitDirector {
  constructor(random = Math.random) {
    this.random = random
    this.reset()
  }

  reset() {
    this.v = 0          // versão do estado (mensagens velhas são ignoradas)
    this.nextId = 0
    this.zones = []     // { id, x, z, timer } (timer = s até acabar)
    this.recent = []    // zonas que acabaram há pouco: { x, z, timer } (intervalo daquela região)
    this.check = MEDKIT.checkEvery
  }

  get active() {
    return this.zones.length > 0
  }

  snapshot() {
    return { v: this.v, zones: this.zones.map(({ id, x, z, timer }) => ({ id, x, z, left: Math.max(0, timer) })) }
  }

  /** Estado recebido do anfitrião. @returns as zonas novas (para anunciar), ou null se for velho */
  apply(state) {
    if (state.v < this.v) return null
    const known = new Set(this.zones.map((z) => z.id))
    this.v = state.v
    this.zones = state.zones.map(({ id, x, z, left }) => ({ id, x, z, timer: left }))
    this.nextId = Math.max(this.nextId, ...this.zones.map((z) => z.id + 1))
    return this.zones.filter((z) => !known.has(z.id))
  }

  /**
   * Avança o relógio. Só o anfitrião decide.
   * @param {{
   *   hurt: { x: number, z: number, hp: number }[],  // carros com vida baixa
   *   place: (target: { x: number, z: number, hp: number }) => ({ x: number, z: number } | null),
   *   maxZones: number,
   * }} world
   * @returns as zonas que apareceram agora, ou null se nada mudou (o anfitrião avisa a sala)
   */
  update(dt, isHost, { hurt, place, maxZones }) {
    for (const z of this.zones) z.timer -= dt
    for (const r of this.recent) r.timer -= dt
    if (!isHost) return null
    let changed = false
    // Zonas que acabaram: a região delas espera o intervalo
    for (const z of this.zones) if (z.timer <= 0) this.recent.push({ x: z.x, z: z.z, timer: MEDKIT.gap })
    if (this.zones.some((z) => z.timer <= 0)) {
      this.zones = this.zones.filter((z) => z.timer > 0)
      changed = true
    }
    this.recent = this.recent.filter((r) => r.timer > 0)

    let born = []
    this.check -= dt
    if (this.check <= 0) {
      this.check = MEDKIT.checkEvery
      // Feridos numa briga que ainda não tem zona (nem teve há pouco)
      const covered = (p) => [...this.zones, ...this.recent].some((z) => Math.hypot(p.x - z.x, p.z - z.z) < MEDKIT.separation)
      const open = hurt.filter((p) => !covered(p))
      if (open.length && this.zones.length < maxZones && this.random() < MEDKIT.chance) {
        const target = open.reduce((a, b) => (b.hp < a.hp ? b : a))
        const spot = place(target)
        if (spot) born = [this.spawn(spot)]
      }
    }
    if (born.length) changed = true
    if (changed) this.v++
    return changed ? born : null
  }

  /** Põe uma zona agora em `spot` (também usado pelo campo de testes). */
  spawn(spot) {
    const zone = { id: this.nextId++, x: spot.x, z: spot.z, timer: MEDKIT.duration }
    this.zones.push(zone)
    this.v++
    return zone
  }

  /** A zona ativa em que `x, z` está, ou null. */
  zoneAt(x, z) {
    return this.zones.find((zone) => Math.hypot(x - zone.x, z - zone.z) <= MEDKIT.radius) ?? null
  }

  /** `x, z` está dentro de alguma zona ativa? */
  contains(x, z) {
    return !!this.zoneAt(x, z)
  }
}
