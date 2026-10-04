// Salas e sala de espera: código da sala, nome do jogador e quem é o
// anfitrião. Sem dependências, para poder ser testado no Node.
//
// Sem servidor, ninguém "é dono" da sala de verdade. O anfitrião (quem aperta
// "Começar") é quem está na sala HÁ MAIS TEMPO: quem criou chega primeiro, e
// se ele sair o próximo mais antigo assume. Todos calculam a mesma coisa a
// partir da lista de jogadores.

// Sem letras/números que se confundem ao ditar (O/0, I/1)
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
export const CODE_LENGTH = 4
export const CODE_MAX = 8
export const NAME_MAX = 16

/** Código novo de sala, ex.: "K7QX". */
export function newRoomCode(random = Math.random) {
  let code = ''
  for (let i = 0; i < CODE_LENGTH; i++) code += CODE_CHARS[Math.floor(random() * CODE_CHARS.length)]
  return code
}

/** Código digitado → formato da sala (maiúsculas, só letras e números). */
export function normalizeCode(text) {
  return String(text ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, CODE_MAX)
}

/** Nome digitado → nome mostrado (sem espaços sobrando, tamanho limitado). */
export function cleanName(text) {
  return String(text ?? '').replace(/\s+/g, ' ').trim().slice(0, NAME_MAX)
}

/**
 * Anfitrião da sala: o que entrou primeiro. Empate decide pelo id, para todos
 * chegarem à mesma resposta.
 * @param {{ id: string, since: number }[]} members
 */
export function hostOf(members) {
  let host = null
  for (const m of members) {
    if (!host || m.since < host.since || (m.since === host.since && m.id < host.id)) host = m
  }
  return host?.id ?? null
}
