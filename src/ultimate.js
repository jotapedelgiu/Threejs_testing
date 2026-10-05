// Ultimate: poderes bem fortes que aparecem em lugares aleatórios da arena a
// cada 30 s: TRÊS ao mesmo tempo, longe uns dos outros e de tipos diferentes, sorteados entre os tipos
// de ULTIMATES. Sem dependências, para poder ser
// testado no Node.
//
// Itens na arena: espera (30 s) → aviso nos últimos 10 s (os lugares já são
// sorteados e os feixes aparecem lá) → itens lá → alguém pega o primeiro →
// recomeça a espera (o outro continua lá até o próximo aviso). Quem pega
// guarda no inventário (UltimateSlot) e tem até ULT_STORE_TIME para usar,
// senão perde; depois de usar, tem 30 s de recarga.
//
// Sem servidor, o item é decidido pelo ANFITRIÃO da sala (lobby.js: quem está
// há mais tempo): só ele avança as fases e concede o item, e avisa a sala a
// cada mudança. Todos guardam uma cópia do estado e contam o tempo, então se
// o anfitrião sair o próximo continua de onde parou. Como só o anfitrião
// concede, um item nunca vai para dois jogadores. Usar o poder é com o dono:
// ele avisa a sala pelo estado do carro (protocol.js: state.ult).

export const ULT_INTERVAL = 30     // s entre um ultimate e o próximo
export const ULT_WARNING = 10      // s de aviso antes de aparecer
export const ULT_PICKUP_RADIUS = 2.5 // m do item para pegar
export const ULT_COOLDOWN = 30     // s depois de usar até poder usar outro (não passa do intervalo: o próximo item já pode ser usado)

const CENTER = [{ x: 0, z: 0 }] // sem lugares para sortear: o centro
export const ULT_ITEMS = 3        // itens de ultimate na arena a cada ciclo
const ITEM_GAP = 8                 // m entre os dois quando só há um lugar

/** Tipos de ultimate (o sorteio usa todos os desta lista). */
export const ULTIMATES = {
  // Sobrecarga, inspirada na ult do Kennen (LoL): tempestade elétrica em volta
  // do dono; raios periódicos em quem estiver dentro, e a cada 3 raios no
  // mesmo alvo ele fica atordoado
  overcharge: {
    name: 'OVERCHARGE',
    duration: 6,      // s
    radius: 8,        // m em volta do dono
    tick: 0.5,        // s entre raios
    damage: 5,        // por raio
    push: 3,          // m/s para fora do círculo, por raio
    marksToStun: 3,   // raios no mesmo alvo para atordoar
    stun: 1.25,       // s sem dirigir
    hint: 'get close: lightning every 0.5s',
    enemyHint: 'get out of the storm!',
  },
  // Onda de choque: faixa longa na frente do carro, na direção para onde ele
  // está virado ao apertar E. Primeiro a faixa aparece no chão (preparação:
  // dá para fugir), depois a onda percorre a faixa e arremessa para a frente
  // quem estiver nela (mais forte quanto mais perto). Quem usa fica PARADO o
  // tempo todo e pode levar dano. Conta como batida com boost: quem for parar
  // na mureta OU nos pneus leva o dano extra de PAREDE
  shockwave: {
    name: 'SHOCKWAVE',
    windup: 0.45,     // s de preparação (a faixa avisa no chão)
    travel: 0.55,     // s da onda ir do carro até o fim da faixa
    duration: 1,      // s parado (preparação + percurso)
    length: 22,       // m
    width: 6,         // m
    maxDamage: 40,    // colado no carro
    minDamage: 20,    // no fim da faixa
    maxPush: 34,      // m/s colado no carro
    minPush: 18,      // m/s no fim da faixa
    hint: 'aim and fire: you are rooted while it casts',
    enemyHint: 'get out of the line!',
  },
  // Míssil: rajada de 5 mísseis, um a cada `shotInterval`, na direção para
  // onde o carro está virado. Quem usa fica PARADO e só pode girar para mirar.
  // Cada míssil cruza o mapa em linha reta, passando por cima de tudo
  // (bastões, pneus, mureta); quem estiver no caminho leva dano e é empurrado
  // (ele continua voando). Atrás fica um rastro reto que deixa lento quem
  // passar por ele (menos quem atirou)
  missile: {
    name: 'MISSILE',
    shots: 5,         // mísseis por uso (5 × 10 = 50 de dano se todos acertarem)
    shotInterval: 0.7, // s entre um míssil e outro
    duration: 3.2,    // s parado (o último sai em 4 × shotInterval; o voo continua sozinho)
    speed: 45,        // m/s
    damage: 10,       // acerto direto, por míssil (0 = só o rastro)
    push: 5,          // m/s na direção do míssil
    hitRadius: 1.4,   // m em volta do míssil
    trailWidth: 1.4,  // m
    trailLife: 6,     // s que o rastro fica depois que o míssil chega na mureta
    slow: 0.45,       // velocidade máxima de quem está no rastro (fração)
    slowLinger: 0.8,  // s que a lentidão dura depois de sair do rastro
    hint: '5 missiles: rooted, steer to aim',
    enemyHint: 'missile incoming! stay off the trail',
  },
  // Emboscada: o dono some para os outros por `vanish` s e dirige invisível
  // (sem boost, como qualquer ultimate). Na primeira vez que encostar em outro
  // carro, reaparece e a batida de área sai na hora; se o tempo acabar sem
  // isso, um círculo no chão avisa todo mundo por `windup` s antes. A batida dá
  // dano e atordoa quem estiver dentro (sem empurrar)
  ambush: {
    name: 'AMBUSH',
    vanish: 15,       // s invisível
    windup: 0.5,      // s do aviso no chão até a batida
    duration: 15.5,   // s no total (vanish + windup)
    radius: 5,        // m em volta do dono
    damage: 35,       // entre a PANCADA (24) e o TURBO (38)
    stun: 1,          // s sem dirigir
    hint: 'invisible! ram someone to strike (or wait 15s)',
    enemyHint: 'someone is invisible! watch the ground',
  },
}
export const ULT_KINDS = Object.keys(ULTIMATES)

// Prazo para usar o guardado: até o próximo item aparecer, menos a duração do
// poder. Mesmo usando no último instante, o poder acaba quando o próximo item
// surge: nunca há dois ultimates ativos ao mesmo tempo
export const ULT_STORE_TIME = ULT_INTERVAL - Math.max(...ULT_KINDS.map((k) => ULTIMATES[k].duration))

/**
 * Prazo de cada tipo (o mesmo cálculo, só com a duração do próprio poder): a
 * Emboscada, bem mais longa, não encurta o prazo dos outros.
 */
export const storeTimeFor = (kind) => ULT_INTERVAL - ULTIMATES[kind].duration

export class UltimateDirector {
  constructor(random = Math.random) {
    this.random = random
    this.reset()
  }

  /** Começo da partida. */
  reset() {
    this.n = 0             // número do ciclo (mensagens de ciclos velhos são ignoradas)
    this.phase = 'waiting' // 'waiting' | 'warning' | 'available'
    // Itens da arena: ULT_ITEMS por ciclo, cada um { x, z, kind } (kind = null
    // no aviso) ou null se já foi pego. [] = nenhum. O que sobra de um ciclo
    // continua lá até o próximo aviso
    this.items = []
    this.lastSpots = []    // lugares do ciclo anterior (o próximo evita repetir)
    this.timer = ULT_INTERVAL // s até a próxima fase
    this.given = null      // último item entregue: { n, owner, kind }
  }

  /** Itens que dá para pegar agora: { index, x, z, kind }. */
  claimable() {
    const list = []
    this.items.forEach((item, index) => {
      if (item?.kind) list.push({ index, x: item.x, z: item.z, kind: item.kind })
    })
    return list
  }

  /** Estado para mandar pela rede. */
  snapshot() {
    return { n: this.n, phase: this.phase, left: Math.max(0, this.timer), items: this.items.map((i) => (i ? { ...i } : null)), given: this.given }
  }

  /** Estado recebido do anfitrião. @returns se foi aceito */
  apply(state) {
    if (state.n < this.n) return false
    this.n = state.n
    this.phase = state.phase
    this.timer = state.left
    this.items = state.items.map((i) => (i ? { ...i } : null))
    this.given = state.given
    return true
  }

  /**
   * Avança o relógio. Só o anfitrião muda de fase.
   * @param {{ x: number, z: number }[]} spots lugares possíveis para os itens
   * @returns true se a fase mudou (o anfitrião avisa a sala)
   */
  update(dt, isHost, spots = CENTER) {
    this.timer -= dt
    if (!isHost) return false
    if (this.phase === 'waiting' && this.timer <= ULT_WARNING) {
      this.phase = 'warning'
      this.place(spots) // o que sobrou do ciclo anterior some aqui
      return true
    }
    if (this.phase === 'warning' && this.timer <= 0) {
      this.phase = 'available'
      this.timer = 0
      // Ultimates de tipos diferentes (repete tipos só se faltarem)
      const pool = [...ULT_KINDS]
      for (const item of this.items) {
        const [kind] = pool.length ? pool.splice(Math.floor(this.random() * pool.length), 1) : ULT_KINDS
        item.kind = kind
      }
      return true
    }
    return false
  }

  // Sorteia os lugares dos próximos itens: o primeiro ao acaso; cada um dos
  // outros é o mais longe possível dos já escolhidos, então ficam espalhados
  // pela arena. Evita os do ciclo anterior, quando dá
  place(spots) {
    const fresh = spots.filter((p) => !this.lastSpots.some((q) => q.x === p.x && q.z === p.z))
    const options = [...(fresh.length >= ULT_ITEMS ? fresh : spots)]
    const picked = []
    if (options.length) picked.push(options.splice(Math.floor(this.random() * options.length), 1)[0])
    const nearest = (p) => Math.min(...picked.map((q) => Math.hypot(p.x - q.x, p.z - q.z)))
    while (picked.length < ULT_ITEMS && options.length) {
      let best = 0
      for (let i = 1; i < options.length; i++) if (nearest(options[i]) > nearest(options[best])) best = i
      picked.push(options.splice(best, 1)[0])
    }
    // Poucos lugares (ex.: só o centro): o resto fica ao lado do primeiro
    while (picked.length < ULT_ITEMS) {
      const first = picked[0] ?? CENTER[0]
      picked.push({ x: first.x + (first.x > 0 ? -ITEM_GAP : ITEM_GAP) * picked.length, z: first.z })
    }
    this.items = picked.map((p) => ({ x: p.x, z: p.z, kind: null }))
    this.lastSpots = picked.map((p) => ({ x: p.x, z: p.z }))
  }

  /**
   * Anfitrião: `id` passou num dos itens. Ele vai para esse jogador; o outro
   * continua lá. A espera do próximo ciclo começa no primeiro que for pego.
   * @returns se ganhou o item
   */
  claim(id, index = 0) {
    const item = this.items[index]
    if (!item?.kind) return false
    this.given = { n: this.n, owner: id, kind: item.kind }
    this.n++
    this.items[index] = null
    if (this.phase === 'available') {
      this.phase = 'waiting'
      this.timer = ULT_INTERVAL
    }
    if (this.items.every((i) => !i)) this.items = []
    return true
  }
}

/**
 * Inventário de ultimate de um jogador: uma vaga, o poder ativo e a recarga.
 * Cada jogador cuida do seu.
 */
export class UltimateSlot {
  constructor() {
    this.reset()
  }

  reset() {
    this.kind = null    // guardado, esperando para usar
    this.storedLeft = 0 // s até o guardado se perder
    this.active = null  // em uso agora
    this.activeLeft = 0 // s de poder que faltam
    this.cooldown = 0   // s até poder usar outro
  }

  /** Vaga livre (dá para pegar o item do centro). */
  get canPickUp() {
    return !this.kind
  }

  /** Dá para usar agora? */
  get ready() {
    return !!this.kind && !this.active && this.cooldown <= 0
  }

  /** Emboscada em uso e ainda invisível (antes do aviso da batida)? */
  get ghost() {
    return this.active === 'ambush' && this.activeLeft > ULTIMATES.ambush.windup
  }

  /**
   * Emboscada: o dono encostou em outro carro invisível. Reaparece e bate NA
   * HORA (sem o aviso no chão); o poder acaba. @returns se estava invisível
   * (hora da batida)
   */
  strike() {
    if (!this.ghost) return false
    this.stop()
    return true
  }

  give(kind) {
    if (this.kind) return false
    this.kind = kind
    this.storedLeft = storeTimeFor(kind)
    return true
  }

  /** Usa o guardado e começa a recarga. @returns o tipo ativado, ou null */
  activate() {
    if (!this.ready) return null
    const kind = this.kind
    this.cooldown = ULT_COOLDOWN
    this.active = kind
    this.activeLeft = ULTIMATES[kind].duration
    this.clearStored()
    return kind
  }

  clearStored() {
    this.kind = null
    this.storedLeft = 0
  }

  /** Nocaute: o poder em uso acaba (o guardado continua guardado). */
  stop() {
    this.active = null
    this.activeLeft = 0
  }

  /**
   * @returns 'ended' no passo em que o poder em uso acabou, 'expired' quando
   *   o guardado se perdeu (não usou a tempo), senão null
   */
  update(dt) {
    this.cooldown = Math.max(0, this.cooldown - dt)
    if (this.kind) {
      this.storedLeft -= dt
      if (this.storedLeft <= 0) {
        this.clearStored()
        return 'expired'
      }
    }
    if (!this.active) return null
    this.activeLeft -= dt
    if (this.activeLeft > 0) return null
    this.stop()
    return 'ended'
  }
}

/**
 * Raios da Sobrecarga, calculados pelo dono do poder: a cada `tick`, um raio
 * em cada alvo dentro do círculo; a cada `marksToStun` raios no mesmo alvo,
 * atordoa.
 */
export class StormStrikes {
  constructor(spec = ULTIMATES.overcharge) {
    this.spec = spec
    this.marks = new Map() // id -> raios recebidos
    this.clock = 0
  }

  reset() {
    this.marks.clear()
    this.clock = 0
  }

  /**
   * @param {{ id: string, x: number, z: number, immune: boolean }[]} targets
   *   immune = protegido (acabou de voltar do nocaute): leva o raio sem dano
   * @returns {{ id: string, damage: number, stun: number, dx: number, dz: number }[]}
   *   dx/dz = direção do dono para o alvo (para o empurrão)
   */
  update(dt, cx, cz, targets) {
    const strikes = []
    const { tick, radius, damage, marksToStun, stun } = this.spec
    this.clock += dt
    while (this.clock >= tick) {
      this.clock -= tick
      for (const t of targets) {
        const dx = t.x - cx, dz = t.z - cz
        const dist = Math.hypot(dx, dz)
        if (dist > radius) continue
        if (t.immune) {
          strikes.push({ id: t.id, damage: 0, stun: 0, dx: 0, dz: 0 })
          continue
        }
        const marks = (this.marks.get(t.id) ?? 0) + 1
        this.marks.set(t.id, marks)
        strikes.push({
          id: t.id,
          damage,
          stun: marks % marksToStun === 0 ? stun : 0,
          dx: dist > 1e-6 ? dx / dist : 1,
          dz: dist > 1e-6 ? dz / dist : 0,
        })
      }
    }
    return strikes
  }
}

const TARGET_RADIUS = 0.6 // m: meio carro; encostar na faixa já conta

/**
 * Batida de área da Emboscada, calculada pelo dono no instante em que o poder
 * acaba: todo alvo dentro do raio leva o dano e o atordoamento (sem empurrão).
 * @param {{ id: string, x: number, z: number, immune: boolean }[]} targets
 *   immune = protegido: é atordoado só se não estiver, e sem dano
 * @returns {{ id: string, damage: number, stun: number }[]}
 */
export function ambushStrikes(spec, cx, cz, targets) {
  const hits = []
  for (const t of targets) {
    if (Math.hypot(t.x - cx, t.z - cz) > spec.radius + TARGET_RADIUS) continue
    hits.push({ id: t.id, damage: t.immune ? 0 : spec.damage, stun: t.immune ? 0 : spec.stun })
  }
  return hits
}

/**
 * Uma Onda de choque em andamento: preparação, depois a frente da onda anda
 * pela faixa e acerta cada alvo quando passa por ele (uma vez só).
 */
export class ShockwaveCast {
  /**
   * @param {{ x: number, z: number }} origin frente do carro de quem usou
   * @param {{ x: number, z: number }} dir direção da faixa (unitária)
   */
  constructor(spec, origin, dir) {
    this.spec = spec
    this.origin = { x: origin.x, z: origin.z }
    this.dir = { x: dir.x, z: dir.z }
    this.time = 0
    this.hit = new Set()
  }

  /** Onde está a frente da onda (m ao longo da faixa); < 0 = ainda preparando. */
  get front() {
    const { windup, travel, length } = this.spec
    return this.time < windup ? -1 : Math.min(length, ((this.time - windup) / travel) * length)
  }

  get done() {
    return this.time >= this.spec.windup + this.spec.travel
  }

  /**
   * @param {{ id: string, x: number, z: number, immune: boolean }[]} targets
   *   immune = protegido: é arremessado, mas sem dano
   * @returns {{ id: string, damage: number, push: number, dx: number, dz: number }[]}
   *   dx/dz = direção do empurrão (a da faixa)
   */
  update(dt, targets) {
    this.time += dt
    const front = this.front
    if (front < 0) return []
    const { length, width, minDamage, maxDamage, minPush, maxPush } = this.spec
    const hits = []
    for (const t of targets) {
      if (this.hit.has(t.id)) continue
      const rx = t.x - this.origin.x, rz = t.z - this.origin.z
      const along = rx * this.dir.x + rz * this.dir.z // distância ao longo da faixa
      const side = Math.abs(rx * this.dir.z - rz * this.dir.x) // distância para o lado
      if (along < -TARGET_RADIUS || along > front + TARGET_RADIUS || side > width / 2 + TARGET_RADIUS) continue
      this.hit.add(t.id)
      const near = 1 - Math.min(Math.max(along, 0), length) / length // 1 colado, 0 no fim
      hits.push({
        id: t.id,
        damage: t.immune ? 0 : Math.round(minDamage + (maxDamage - minDamage) * near),
        push: minPush + (maxPush - minPush) * near,
        dx: this.dir.x,
        dz: this.dir.z,
      })
    }
    return hits
  }
}

/**
 * Um míssil em voo (e o rastro dele). Todos calculam o mesmo voo a partir de
 * onde e para onde ele saiu; o acerto direto é resolvido por quem atirou.
 */
export class MissileShot {
  /**
   * @param {{ x: number, z: number }} origin frente do carro de quem atirou
   * @param {{ x: number, z: number }} dir direção (unitária)
   * @param {number} halfX metade da largura da arena (até a mureta)
   * @param {number} halfZ metade da profundidade
   */
  constructor(spec, origin, dir, halfX, halfZ) {
    this.spec = spec
    this.origin = { x: origin.x, z: origin.z }
    this.dir = { x: dir.x, z: dir.z }
    // Até onde ele vai: o primeiro lado da arena que a reta encontra
    const reach = (o, d, half) => (d > 1e-9 ? (half - o) / d : d < -1e-9 ? (-half - o) / d : Infinity)
    this.length = Math.max(0, Math.min(reach(origin.x, dir.x, halfX), reach(origin.z, dir.z, halfZ)))
    this.time = 0
    this.hit = new Set()
  }

  /** m percorridos (a ponta do rastro). */
  get traveled() {
    return Math.min(this.length, this.time * this.spec.speed)
  }

  get flying() {
    return this.time * this.spec.speed < this.length
  }

  /** Rastro já sumiu (e o míssil já chegou)? */
  get expired() {
    return this.time >= this.length / this.spec.speed + this.spec.trailLife
  }

  /** Onde está o míssil agora. */
  get position() {
    const d = this.traveled
    return { x: this.origin.x + this.dir.x * d, z: this.origin.z + this.dir.z * d }
  }

  // Ponto em relação à reta: ao longo (m) e para o lado (m)
  local(x, z) {
    const rx = x - this.origin.x, rz = z - this.origin.z
    return { along: rx * this.dir.x + rz * this.dir.z, side: Math.abs(rx * this.dir.z - rz * this.dir.x) }
  }

  /**
   * Avança o voo. @returns quem o míssil atravessou neste passo (uma vez cada)
   * @param {{ id: string, x: number, z: number, immune: boolean }[]} targets
   */
  update(dt, targets = []) {
    const before = this.traveled
    this.time += dt
    if (before >= this.length) return []
    const after = this.traveled
    const hits = []
    for (const t of targets) {
      if (this.hit.has(t.id)) continue
      const { along, side } = this.local(t.x, t.z)
      const r = this.spec.hitRadius
      if (side > r || along < before - r || along > after + r) continue
      this.hit.add(t.id)
      hits.push({ id: t.id, damage: t.immune ? 0 : this.spec.damage, push: this.spec.push, dx: this.dir.x, dz: this.dir.z })
    }
    return hits
  }

  /** `x, z` está em cima do rastro (o trecho que o míssil já percorreu)? */
  trailContains(x, z) {
    if (this.expired) return false
    const { along, side } = this.local(x, z)
    return along >= -TARGET_RADIUS && along <= this.traveled + TARGET_RADIUS && side <= this.spec.trailWidth / 2 + TARGET_RADIUS
  }
}
