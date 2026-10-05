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

// Balanceamento (ver bate-bate_balanceamento.xlsx): com 100 de vida e a
// mistura típica de batidas, um nocaute leva ~36 s de briga (TTK alvo de
// arena arcade). Os danos mantêm a proporção 1:2:3 entre leve, FORTE e
// PANCADA; o TURBO vale mais que uma PANCADA e o combo TURBO + PAREDE tira
// 1/3 da vida.
export const DAMAGE = {
  light: 5,
  strong: 10,
  smash: 15,
  turbo: 24, // batida com boost
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
 * @returns {{ role: 'aggressor' | 'tie' | 'victim', impact: number }} impact =
 *   minha velocidade indo para cima do outro (a força da minha batida)
 */
export function judgeHit(normal, myVelocity, otherVelocity) {
  const myPush = -myVelocity.dot(normal)      // eu indo para cima do outro
  const theirPush = otherVelocity.dot(normal) // o outro vindo para cima de mim
  const diff = myPush - theirPush
  const role = diff > TIE_MARGIN ? 'aggressor' : diff < -TIE_MARGIN ? 'victim' : 'tie'
  return { role, impact: myPush }
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
