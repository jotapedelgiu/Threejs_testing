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

// Limites de força (m/s) medidos pela velocidade de QUEM BATEU indo na direção
// do outro. Referência: a velocidade máxima padrão do carrinho é 9 m/s.
export const damageParams = {
  minImpact: 2.5, // abaixo disso é raspão e não tira vida
  strong: 5.5,    // a partir daqui: 2 de dano (FORTE)
  smash: 7.5,     // a partir daqui: 3 de dano (PANCADA; precisa de uns 3 s de embalo)
}

/** Dano pela força da batida (m/s); 0 = raspão. */
export function impactDamage(impactSpeed) {
  if (impactSpeed < damageParams.minImpact) return 0
  if (impactSpeed >= damageParams.smash) return 3
  if (impactSpeed >= damageParams.strong) return 2
  return 1
}

// Boost: batida com boost tira mais que a PANCADA e arremessa mais longe; se
// a vítima bater na parede logo depois, perde mais um pouco
export const BOOST_HIT_DAMAGE = 5
export const BOOST_PUSH = 1.5        // multiplica o empurrão na vítima
export const WALL_DAMAGE = 2
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
export const KO_TIME = 3         // s fora de combate ao zerar a vida
export const RESPAWN_SHIELD = 2  // s sem levar dano depois de voltar

export class Health {
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

  /** @returns {boolean} true no passo em que o nocaute acaba (hora de voltar) */
  update(dt) {
    if (this.shieldTimer > 0) this.shieldTimer = Math.max(0, this.shieldTimer - dt)
    if (this.koTimer <= 0) return false
    this.koTimer -= dt
    if (this.koTimer > 0) return false
    this.koTimer = 0
    this.hp = MAX_HEALTH
    this.shieldTimer = RESPAWN_SHIELD
    return true
  }
}
