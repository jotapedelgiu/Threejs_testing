// Regras de batida, dano e vida (a interface fica em hud.js). Sem dependência
// de navegador, então dá para testar no Node.
//
// Cada jogador tem MAX_HEALTH de vida. Toda batida tira vida de quem LEVOU,
// conforme a força de quem bateu. Quem resolve a batida é o agressor: só ele
// sabe a própria velocidade real no instante do impacto (pela rede, a vítima
// vê o agressor com atraso). Ele manda o empurrão e o dano; cada jogador é
// dono da própria vida e a desconta ao receber.

export const MIN_IMPULSE = 0.3  // m/s; empurrões menores que isso são só encostar
const HIT_COOLDOWN = 0.6        // s entre batidas do mesmo par
const TIE_MARGIN = 0.75         // m/s; diferença abaixo disso = os dois bateram
export const HEAD_ON_MIN = 2    // m/s; entre jogadores, os dois indo um para cima do outro assim = batida de frente

// Balanceamento (ver bate-bate_balanceamento.xlsx): com 100 de vida e a
// mistura típica de batidas, um nocaute leva ~36 s de briga (TTK alvo de
// arena arcade). A curva é acentuada: leve, FORTE e PANCADA seguem ~1:2,4:4,8
// (embalo vale muito); o TURBO vale mais que uma PANCADA e o combo TURBO +
// PAREDE tira quase metade da vida.
export const DAMAGE = {
  light: 5,
  strong: 12,
  smash: 24,
  turbo: 38, // batida com boost
  wall: 8,   // bater na parede logo depois de levar um TURBO
  spike: 6,  // bater num bastão com espinhos
}

export const SPIKE_MIN_SPEED = 2 // m/s contra o bastão para os espinhos machucarem

// Limites de força (m/s) medidos pela velocidade de QUEM BATEU indo na direção
// do outro. Referência: velocidade máxima ~9-10 m/s. Bem separados no tempo
// de embalo (~0,8 s, ~1,8 s e ~3,2 s): a PANCADA pede uns 15 m de reta.
export const damageParams = {
  minImpact: 2.5, // abaixo disso é raspão e não tira vida
  strong: 6,      // a partir daqui: FORTE
  smash: 8.5,     // a partir daqui: PANCADA
}

/** Faixa da batida pela força (m/s): 'light' | 'strong' | 'smash' | null (raspão). */
export function impactTier(impactSpeed) {
  if (impactSpeed < damageParams.minImpact) return null
  if (impactSpeed >= damageParams.smash) return 'smash'
  if (impactSpeed >= damageParams.strong) return 'strong'
  return 'light'
}

/** Dano pela força da batida (m/s); 0 = raspão. */
export function impactDamage(impactSpeed) {
  const tier = impactTier(impactSpeed)
  return tier ? DAMAGE[tier] : 0
}

/**
 * Faixa de um dano recebido pela rede (para escolher o texto na tela).
 * `scale` = multiplicador de dano do nível de quem bateu (progression.js)
 */
export function tierOfDamage(damage, scale = 1) {
  if (damage >= Math.round(DAMAGE.smash * scale)) return 'smash'
  if (damage >= Math.round(DAMAGE.strong * scale)) return 'strong'
  return 'light'
}

// Boost: batida com boost tira mais que a PANCADA e arremessa mais longe; se
// a vítima bater na parede logo depois, perde mais um pouco
export const BOOST_HIT_DAMAGE = DAMAGE.turbo
export const BOOST_PUSH = 1.5        // multiplica o empurrão na vítima
export const WALL_DAMAGE = DAMAGE.wall
export const WALL_DAMAGE_WINDOW = 2.5 // s depois da batida com boost
export const WALL_DAMAGE_MIN_SPEED = 2 // m/s batendo na parede

/**
 * Decide quem bateu, com as velocidades de antes da batida.
 * - 'aggressor': fui eu; resolvo a batida e mando o dano
 * - 'tie': os dois vieram com força parecida (ex.: de frente); cada um aplica
 *   só o próprio ricochete e ninguém leva dano
 * - 'victim': foi o outro; espero a mensagem dele com o empurrão e o dano
 * @param {THREE.Vector3} normal do outro para mim
 * @param {number} headOnMin se os dois vêm um para cima do outro com pelo menos
 *   isso (m/s), é batida de frente (empate) mesmo com velocidades diferentes:
 *   quem vê o outro com atraso erraria quem é o mais rápido
 * @returns {{ role: 'aggressor' | 'tie' | 'victim', impact: number, theirs: number }}
 *   impact = minha velocidade indo para cima do outro (a força da minha batida);
 *   theirs = a dele vindo para cima de mim
 */
export function judgeHit(normal, myVelocity, otherVelocity, headOnMin = Infinity) {
  const myPush = -myVelocity.dot(normal)      // eu indo para cima do outro
  const theirPush = otherVelocity.dot(normal) // o outro vindo para cima de mim
  const diff = myPush - theirPush
  const headOn = myPush >= headOnMin && theirPush >= headOnMin
  const role = headOn || Math.abs(diff) <= TIE_MARGIN ? 'tie' : diff > 0 ? 'aggressor' : 'victim'
  return { role, impact: myPush, theirs: theirPush }
}

/** Evita contar o mesmo choque várias vezes enquanto os carros se encostam. */
export class HitCooldown {
  last = new Map()
  ready(peerId, now) {
    if (this.recent(peerId, now)) return false
    this.last.set(peerId, now)
    return true
  }
  /** Já resolvi uma batida com esse jogador agora há pouco? */
  recent(peerId, now) {
    return now - (this.last.get(peerId) ?? -Infinity) < HIT_COOLDOWN
  }
}

// --- Batida em cadeia ----------------------------------------------------------
// Ricochete: quem foi arremessado e, no embalo do empurrão, acerta outro carro
// está só repassando o empurrão: o dano dessa batida conta para quem empurrou,
// reduzido a cada repasse. Assim ninguém "rouba" o abate por ter sido
// arremessado em alguém. Só vale logo depois do empurrão, batendo no sentido em
// que foi empurrado, e uma vez só (uma batida qualquer depois é dele mesmo).
export const CHAIN_WINDOW = 0.8  // s depois do empurrão em que a batida ainda é ricochete
export const CHAIN_ALIGN = 0.6   // cosseno mínimo entre o empurrão e a direção do outro carro (~53°)
export const CHAIN_FALLOFF = 0.6 // fração do dano que sobra a cada repasse
export const CHAIN_MAX = 3       // repasses no máximo

/** Dano de uma batida repassada `relay` vezes (1 = primeiro repasse). */
export function chainDamage(damage, relay) {
  return Math.round(damage * CHAIN_FALLOFF ** relay)
}

/** De quem foi o último empurrão que um carro levou (um por carro). */
export class PushChain {
  owner = null // quem empurrou primeiro (o dono do dano repassado)
  relay = 0    // repasses até chegar neste carro (0 = empurrão direto)
  at = -Infinity
  dx = 0       // sentido do empurrão (unitário, no chão)
  dz = 0

  /**
   * Levei um empurrão de `owner`, que já veio repassado `relay` vezes, no
   * sentido (dx, dz). Sem sentido (só dano, sem empurrão) não há ricochete.
   */
  pushed(owner, relay, now, dx, dz) {
    const length = Math.hypot(dx, dz)
    if (!owner || relay >= CHAIN_MAX || !(length > 1e-6)) return this.clear()
    this.owner = owner
    this.relay = relay
    this.at = now
    this.dx = dx / length
    this.dz = dz / length
  }

  /**
   * Bati em `targetId` agora (sem boost: com boost a batida é minha), que está
   * no sentido (toX, toZ). É ricochete se foi logo depois do empurrão e no
   * sentido dele; aí a batida é de quem empurrou e o ricochete se gasta.
   * @returns {{ owner: string, relay: number } | null} relay desta batida
   */
  ricochet(targetId, now, toX, toZ) {
    if (!this.owner || now - this.at >= CHAIN_WINDOW || targetId === this.owner) return null
    const length = Math.hypot(toX, toZ)
    if (!(length > 1e-6) || (this.dx * toX + this.dz * toZ) / length < CHAIN_ALIGN) return null
    const out = { owner: this.owner, relay: this.relay + 1 }
    this.clear()
    return out
  }

  clear() {
    this.owner = null
    this.relay = 0
    this.at = -Infinity
    this.dx = this.dz = 0
  }
}

/**
 * Batida de frente entre dois jogadores: os dois levam EXATAMENTE o mesmo dano.
 * Cada um vê o outro com atraso e pode julgar diferente (um acha que bateu, o
 * outro acha empate), então quem decide é sempre o jogador de menor id: o dano
 * dele vale para os dois. Quem tem o maior id só aceita o que chega.
 * - menor id (`sending`): se o outro já me bateu há pouco, repito o dano dele;
 *   senão uso o meu. Empate: o dano vai para os dois (`mutual`); batida só
 *   minha: vai normal e, se o outro também bater (ou ecoar), ele conta para os dois
 * - maior id (`received`/`noteTie`): aplico o que chegar; se eu julguei empate
 *   e o menor id bateu "normal" (achando que só ele bateu), devolvo o eco para
 *   ele levar o mesmo dano
 * `now` em segundos (tempo de simulação).
 */
export class RamLedger {
  static WINDOW = 0.8 // s: tempo para a batida do outro chegar pela rede
  sent = new Map()    // peerId -> { at, damage, applied }  (menor id: o que mandei)
  got = new Map()     // peerId -> { at, damage, echoed }   (batidas normais recebidas)
  ties = new Map()    // peerId -> { at }                   (maior id: julguei empate)

  recent(map, peerId, now) {
    const entry = map.get(peerId)
    return entry && now - entry.at < RamLedger.WINDOW ? entry : null
  }

  /**
   * Menor id mandando a batida contra `peerId`.
   * @returns {{ damage: number, mutual: boolean, selfApply: boolean }}
   *   selfApply = eu também levo esse dano agora
   */
  sending(peerId, damage, now, { tie }) {
    const got = this.recent(this.got, peerId, now)
    if (got) {
      this.got.delete(peerId)
      return { damage: got.damage, mutual: true, selfApply: false } // eu já levei o dano dele
    }
    this.sent.set(peerId, { at: now, damage, applied: tie })
    return { damage, mutual: tie, selfApply: tie }
  }

  /**
   * Maior id: julguei empate. @returns o dano a devolver (eco) se o menor id
   * já tinha me batido, senão null
   */
  noteTie(peerId, now) {
    this.ties.set(peerId, { at: now })
    const got = this.recent(this.got, peerId, now)
    if (!got || got.echoed) return null
    got.echoed = true
    return got.damage
  }

  /**
   * Chegou uma batida de `peerId` (jogador, não golpe de ultimate).
   * @returns {{ apply: number, echo: number | null }} dano que eu levo, e
   *   eco a devolver (só o maior id)
   */
  received(peerId, hit, now, { iAmLower }) {
    if (iAmLower) {
      if (hit.mutual) return { apply: hit.damage, echo: null } // o maior id ecoou a minha batida
      const sent = this.recent(this.sent, peerId, now)
      if (sent) {
        // Também bati nele: vale o meu dano, para os dois
        const apply = sent.applied ? 0 : sent.damage
        sent.applied = true
        return { apply, echo: null }
      }
      this.got.set(peerId, { at: now, damage: hit.damage })
      return { apply: hit.damage, echo: null }
    }
    // Maior id: levo o que chegar
    let echo = null
    if (!hit.mutual) {
      const entry = { at: now, damage: hit.damage, echoed: false }
      this.got.set(peerId, entry)
      if (this.recent(this.ties, peerId, now) !== null) {
        entry.echoed = true
        echo = hit.damage
      }
    }
    return { apply: hit.damage, echo }
  }
}

// --- Vida ---------------------------------------------------------------------
export const MAX_HEALTH = 100
export const KO_TIME = 2.5       // s fora de combate ao zerar a vida
export const RESPAWN_SHIELD = 2  // s sem levar dano depois de voltar

export class Health {
  max = MAX_HEALTH // sobe com o nível (progression.js)
  hp = MAX_HEALTH
  koTimer = 0     // > 0: nocauteado (não dirige)
  shieldTimer = 0 // > 0: acabou de voltar, não leva dano

  get isKO() {
    return this.koTimer > 0
  }

  get isShielded() {
    return this.shieldTimer > 0
  }

  /**
   * Tira vida. Nocauteado ou protegido não leva dano.
   * @returns {{ dealt: number, knockedOut: boolean }}
   */
  damage(amount) {
    if (this.isKO || this.isShielded || amount <= 0) return { dealt: 0, knockedOut: false }
    const dealt = Math.min(amount, this.hp)
    this.hp -= dealt
    const knockedOut = this.hp <= 0
    if (knockedOut) this.koTimer = KO_TIME
    return { dealt, knockedOut }
  }

  /** Recupera vida (nocauteado não). @returns quanto curou */
  heal(amount) {
    if (this.isKO || amount <= 0) return 0
    const healed = Math.min(amount, this.max - this.hp)
    this.hp += healed
    return healed
  }

  /**
   * Muda a vida máxima (subiu de nível). A vida ganha junto o que a máxima
   * cresceu; nocauteado, já volta com a nova cheia.
   */
  setMax(max) {
    if (max === this.max) return
    if (!this.isKO) this.hp = Math.max(1, Math.min(max, this.hp + max - this.max))
    this.max = max
  }

  /** Volta ao começo da partida: vida cheia de nível 1. */
  reset() {
    this.max = this.hp = MAX_HEALTH
    this.koTimer = this.shieldTimer = 0
  }

  /** @returns {boolean} true no passo em que o nocaute acaba (hora de voltar) */
  update(dt) {
    if (this.shieldTimer > 0) this.shieldTimer = Math.max(0, this.shieldTimer - dt)
    if (this.koTimer <= 0) return false
    this.koTimer -= dt
    if (this.koTimer > 0) return false
    this.koTimer = 0
    this.hp = this.max
    this.shieldTimer = RESPAWN_SHIELD
    return true
  }
}
