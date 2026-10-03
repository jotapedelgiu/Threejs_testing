// Pontuação: só as regras (a interface fica em hud.js). Sem dependência de
// navegador, então dá para testar no Node.
//
// Regra: toda batida vale 1 ponto para quem BATEU, multiplicado pela força.
// Quem resolve a batida é o agressor: só ele sabe a própria velocidade real no
// instante do impacto. Pela rede, a vítima vê o agressor com atraso e, quando
// percebe o contato, ele já ricocheteou e parece estar parado.

export const MIN_IMPULSE = 0.3  // m/s; empurrões menores que isso são só encostar
const HIT_COOLDOWN = 0.6        // s entre batidas do mesmo par
const TIE_MARGIN = 0.75         // m/s; diferença abaixo disso = os dois bateram

// Limites de força (m/s) medidos pela velocidade de QUEM BATEU indo na direção
// do outro. Referência: a velocidade máxima padrão do carrinho é 9 m/s.
export const scoreParams = {
  minImpact: 2.5, // abaixo disso é raspão e não pontua
  strong: 5.5,    // a partir daqui: +2 FORTE!
  smash: 7.5,     // a partir daqui: +3 PANCADA! (precisa de uns 3 s de embalo)
}

/** Pontos pela força da batida (m/s); 0 = raspão. */
export function impactPoints(impactSpeed) {
  if (impactSpeed < scoreParams.minImpact) return 0
  if (impactSpeed >= scoreParams.smash) return 3
  if (impactSpeed >= scoreParams.strong) return 2
  return 1
}

/**
 * Decide quem bateu, com as velocidades de antes da batida.
 * - 'aggressor': fui eu; resolvo a batida e ganho os pontos
 * - 'tie': os dois vieram com força parecida (ex.: de frente); cada um aplica
 *   só o próprio ricochete e ninguém pontua
 * - 'victim': foi o outro; espero a mensagem dele com o meu empurrão
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

// Boost: batida com boost vale mais que a PANCADA e arremessa mais longe; se
// a vítima bater na parede logo depois, quem deu o boost ganha um bônus
export const BOOST_HIT_POINTS = 5
export const BOOST_PUSH = 1.5       // multiplica o empurrão na vítima
export const WALL_BONUS_POINTS = 2
export const WALL_BONUS_WINDOW = 2.5 // s depois da batida com boost
export const WALL_BONUS_MIN_SPEED = 2 // m/s batendo na parede
