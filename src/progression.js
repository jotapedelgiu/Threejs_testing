import { MAX_HEALTH } from './damage.js'

// Progressão na partida: o XP (dano causado, mais bônus por diferença de nível
// e por abate) se acumula e sobe o nível (até MAX_LEVEL); cada nível dá mais
// dano e mais vida máxima. Assim quem não consegue abater também progride, e
// bater em quem está acima rende mais que bater em quem está abaixo. Sem dependências de navegador, para poder
// ser testado no Node.
//
// O nível sai do XP acumulado (match.js: tallyXp), que todos calculam igual a
// partir do xpBy de cada vítima (o XP que cada um ganhou batendo nela): quem
// apanha calcula o XP no instante do golpe, com os níveis que ela enxerga, e
// publica o total já pronto; assim ninguém precisa concordar sobre o nível
// "naquele instante". O nível só sobe (o XP não diminui) e volta ao 1 em cada
// partida nova.
//
// Quem bate escala o próprio dano antes de mandar (o agressor já resolve a
// batida; damage.js); cada um ajusta a própria vida máxima ao subir de nível.

export const MAX_LEVEL = 10

// Por nível acima do 1: +5% de dano e +5 de vida máxima
// (nível 10: 1,45x de dano e 145 de vida)
export const LEVEL_UP = {
  damage: 0.05,
  health: 5,
}

// XP para sair do nível 1 (120), do 2 (138), do 3 (156)...
export const LEVEL_DAMAGE_BASE = 120
export const LEVEL_DAMAGE_STEP = 18

// XP extra pela diferença de nível (alvo - atacante), calculado por quem leva o golpe:
//   golpe: dano x clamp(1 + perLevel x diferença, min, max)
//   abate: + kill x max(killMin, 1 + killPerLevel x diferença)
// Cair de novo para o mesmo atacante dentro de repeatWindow s rende só
// repeatFraction do XP (1 = sem trava; contra quem se deixa derrubar de propósito)
export const XP_EXTRA = {
  perLevel: 0.25,
  min: 0.5,
  max: 2.5,
  kill: 30,
  assistFraction: 0.4, // assistência vale essa fração do bônus de abate
  killPerLevel: 0.25,
  killMin: 0.5,
  repeatFraction: 1,
  repeatWindow: 30,
}

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v))

/** Multiplicador do XP de um golpe: bater em quem está acima rende mais. */
export const hitXpScale = (attackerLevel, victimLevel) =>
  clamp(1 + XP_EXTRA.perLevel * (victimLevel - attackerLevel), XP_EXTRA.min, XP_EXTRA.max)

/** XP (inteiro) que o atacante ganha por `dealt` de dano causado. */
export const xpForHit = (dealt, attackerLevel, victimLevel) =>
  dealt > 0 ? Math.round(dealt * hitXpScale(attackerLevel, victimLevel)) : 0

/** XP (inteiro) extra de quem abate. */
export const xpForKill = (attackerLevel, victimLevel) =>
  Math.round(XP_EXTRA.kill * Math.max(XP_EXTRA.killMin, 1 + XP_EXTRA.killPerLevel * (victimLevel - attackerLevel)))

/** XP (inteiro) extra de quem ajudou no abate: menos que o de quem abate. */
export const xpForAssist = (attackerLevel, victimLevel) => Math.round(xpForKill(attackerLevel, victimLevel) * XP_EXTRA.assistFraction)

/** Fração do XP quando a vítima já tinha caído para o mesmo atacante há `since` s (null = nunca). */
export const repeatScale = (since) =>
  since !== null && since < XP_EXTRA.repeatWindow ? XP_EXTRA.repeatFraction : 1

/** XP que falta ganhar para sair de `level` para o seguinte. */
export const damageToLevelUp = (level) => LEVEL_DAMAGE_BASE + LEVEL_DAMAGE_STEP * (level - 1)

/** Nível com `damage` de XP acumulado: 1 sem nenhum, até MAX_LEVEL. */
export function levelFor(damage = 0) {
  let level = 1
  let left = Math.max(0, damage)
  while (level < MAX_LEVEL && left >= damageToLevelUp(level)) {
    left -= damageToLevelUp(level)
    level++
  }
  return level
}

/** Progresso (0 a 1) rumo ao próximo nível com `damage` de XP acumulado; 1 no nível máximo. */
export function levelProgress(damage = 0) {
  const level = levelFor(damage)
  if (level >= MAX_LEVEL) return 1
  let spent = 0
  for (let l = 1; l < level; l++) spent += damageToLevelUp(l)
  return Math.min(1, Math.max(0, (damage - spent) / damageToLevelUp(level)))
}

/** Multiplicador de dano no nível. */
export const damageScale = (level) => 1 + LEVEL_UP.damage * (level - 1)

/** Dano de uma batida/ultimate de quem está em `level` (inteiro, como vai pela rede). */
export const scaleDamage = (base, level) => (base > 0 ? Math.round(base * damageScale(level)) : 0)

/** Vida máxima no nível. */
export const maxHealthFor = (level) => MAX_HEALTH + LEVEL_UP.health * (level - 1)
