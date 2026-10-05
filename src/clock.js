// Corrige o relógio de quem está com a hora do PC errada. Os relays do Nostr
// recusam eventos com horário fora da janela deles ("created_at too early",
// "ephemeral event expired"), e aí o Trystero nunca acha ninguém na sala; o
// `since` da sala de espera (quem é o anfitrião) também depende da hora. A
// hora certa vem do cabeçalho Date do próprio servidor que serve o jogo.

// Diferença tolerada antes de corrigir (ms); o cabeçalho Date só tem segundos
const MAX_SKEW = 5000
const TIMEOUT = 3000

/**
 * Busca a hora do servidor e, se o relógio local estiver longe dela, passa
 * `Date.now()` a devolver a hora corrigida (o Trystero usa `Date.now()`).
 * @returns {Promise<number>} diferença aplicada em ms (0 se não precisou ou falhou)
 */
export async function syncClock() {
  try {
    const sent = Date.now()
    const res = await fetch(location.href, { method: 'HEAD', cache: 'no-store', signal: AbortSignal.timeout(TIMEOUT) })
    const received = Date.now()
    const server = Date.parse(res.headers.get('date'))
    if (Number.isNaN(server)) return 0
    // O servidor carimbou a hora em algum ponto da ida e volta: usa o meio
    const offset = server + 500 - (sent + received) / 2
    if (Math.abs(offset) < MAX_SKEW) return 0
    const localNow = Date.now.bind(Date)
    Date.now = () => localNow() + offset
    console.warn(`Relógio do computador ${offset > 0 ? 'atrasado' : 'adiantado'} ${Math.round(Math.abs(offset) / 1000)}s; corrigido para o multiplayer.`)
    return offset
  } catch {
    return 0
  }
}
