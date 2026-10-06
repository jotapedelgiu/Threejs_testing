// Sequência de abates (double, triple, quadra, penta kill): abater vários sem
// morrer no meio rende XP extra, maior a cada abate da sequência. Sem
// dependências de navegador, para poder ser testado no Node.
//
// Como o XP de abate é calculado pela vítima (progression.js), cada cliente
// acompanha a sequência de todo mundo a partir dos abates que enxerga (os seus,
// o koBy dos outros e os bonecos/bots), e a vítima soma o bônus ao XP que o
// abatedor ganha nela. A sequência zera ao morrer (por qualquer causa) e a
// cada partida nova.

// XP extra pelo abate de número N da sequência (índice = N); do 6º em diante
// vale o mesmo que o penta
export const STREAK_XP = [0, 0, 40, 80, 130, 200]

// Nome do aviso (a partir de 6 abates vira "N KILLS")
export const STREAK_NAMES = { 2: 'DOUBLE KILL', 3: 'TRIPLE KILL', 4: 'QUADRA KILL', 5: 'PENTA KILL' }

/** XP (inteiro) extra pelo abate de número `streak` da sequência (0 se for o primeiro). */
export const xpForStreak = (streak) => STREAK_XP[Math.min(Math.max(0, streak), STREAK_XP.length - 1)] ?? 0

/** Nome do aviso da sequência (null se for só um abate). */
export const streakName = (streak) => (streak < 2 ? null : STREAK_NAMES[streak] ?? `${streak} KILLS`)

export class StreakTracker {
  constructor() {
    this.counts = new Map() // id -> abates seguidos sem morrer
  }

  reset() {
    this.counts.clear()
  }

  /** Abates seguidos de `id` agora. */
  count(id) {
    return this.counts.get(id) ?? 0
  }

  /**
   * `killer` abateu `victim`: a sequência de um sobe, a do outro zera.
   * @returns a sequência de `killer` já com este abate
   */
  kill(killer, victim) {
    this.counts.delete(victim)
    const n = this.count(killer) + 1
    this.counts.set(killer, n)
    return n
  }

  /** `id` morreu sem crédito de ninguém (parede, espinho, ...): zera a sequência. */
  died(id) {
    this.counts.delete(id)
  }
}
