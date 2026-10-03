import { joinRoom, selfId } from 'trystero'

// Multiplayer peer-to-peer (WebRTC) via Trystero. Os navegadores se encontram
// por relays públicos do Nostr (gratuitos, sem conta) e depois trocam dados
// direto entre si. Cada jogador é dono do próprio carrinho e manda o estado
// dele para os outros; não há servidor de jogo.

// Identificador único do app: só se encontram peers com o mesmo appId
const APP_ID = 'jotapedelgiu-threejs-testing-batebate'

/**
 * Entra numa sala da arena.
 * @param {string} roomId
 * @param {{
 *   onPeerState: (peerId: string, state: object) => void,
 *   onPeerLeave: (peerId: string) => void,
 *   onPeersChange: (count: number) => void,
 *   onHit: (hit: { target: string, ix: number, iz: number, points: number }, attackerId: string) => void,
 * }} handlers
 */
export function joinArena(roomId, { onPeerState, onPeerLeave, onPeersChange, onHit }) {
  const room = joinRoom({ appId: APP_ID }, roomId)
  const stateAction = room.makeAction('state')
  // Batida anunciada por quem bateu: empurrão (ix, iz) que `target` deve
  // receber e os pontos ganhos
  const hitAction = room.makeAction('hit')
  const peers = new Set()

  room.onPeerJoin = (peerId) => {
    peers.add(peerId)
    onPeersChange(peers.size)
  }
  room.onPeerLeave = (peerId) => {
    peers.delete(peerId)
    onPeerLeave(peerId)
    onPeersChange(peers.size)
  }
  stateAction.onMessage = (state, { peerId }) => onPeerState(peerId, state)
  hitAction.onMessage = (hit, { peerId }) => onHit(hit, peerId)

  // Sai da sala ao fechar a aba, para os outros removerem o carrinho na hora
  window.addEventListener('beforeunload', () => room.leave())

  return {
    selfId,
    /** Manda o estado do meu carrinho para todos da sala. */
    sendState: (state) => (peers.size ? stateAction.send(state) : undefined),
    /** Anuncia para todos que eu acertei `target`. */
    sendHit: (hit) => hitAction.send(hit),
  }
}
