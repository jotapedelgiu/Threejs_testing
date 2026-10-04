// Mapa da partida (posição dos bastões e, por tabela, das esferas).
//
// Cada partida tem um mapa novo, sorteado por uma semente. Sem servidor, quem
// decide é a sala: cada jogador gera uma semente ao entrar e, ao se conectar
// com outro, os dois comparam; vale a de quem está na sala HÁ MAIS TEMPO (o
// mapa que já estava rolando). Com isso quem chega adota o mapa existente, e
// quando todos saem a próxima partida começa com um mapa novo.

/** Semente nova para uma partida. */
export function newLayout() {
  const random = crypto.getRandomValues(new Uint32Array(2))
  return {
    seed: `${random[0].toString(36)}${random[1].toString(36)}`,
    since: Date.now(), // quando o mapa começou (ms); menor = mais antigo
  }
}

/**
 * Devo trocar o meu mapa pelo do outro jogador? Sim se o dele é mais antigo.
 * Empate (mesmo instante) decide pela semente, para os dois lados chegarem à
 * mesma conclusão.
 */
export function shouldAdopt(mine, theirs) {
  if (theirs.seed === mine.seed) return false
  if (theirs.since !== mine.since) return theirs.since < mine.since
  return theirs.seed < mine.seed
}
