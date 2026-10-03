import { joinRoom, selfId } from 'trystero'
import { validators } from './protocol.js'

// Multiplayer peer-to-peer (WebRTC) via Trystero. Os navegadores se encontram
// por relays públicos do Nostr (gratuitos, sem conta) e depois trocam dados
// direto entre si. Cada jogador é dono do próprio carrinho e manda o estado
// dele para os outros; não há servidor de jogo.

// Identificador único do app: só se encontram peers com o mesmo appId
const APP_ID = 'jotapedelgiu-threejs-testing-batebate'

// Liga o recebimento de uma ação ao handler, validando antes
function listen(action, validate, handler) {
  action.onMessage = (data, { peerId }) => {
    const clean = validate(data)
    if (clean) handler(clean, peerId)
  }
}

/**
 * Entra numa sala da arena.
 * @param {string} roomId
 * @param {{
 *   onPeerJoin: (peerId: string) => void,
 *   onPeerState: (peerId: string, state: object) => void,
 *   onPeerLeave: (peerId: string) => void,
 *   onPeersChange: (count: number) => void,
 *   onHit: (hit: { target: string, ix: number, iz: number, damage: number, boosted: boolean }, attackerId: string) => void,
 *   onWall: (wall: { damage: number }, peerId: string) => void,
 *   onPickup: (pickup: { slot: number, gen: number }, peerId: string) => void,
 *   onOrbs: (snapshot: object[], peerId: string) => void,
 * }} handlers
 */
export function joinArena(roomId, handlers) {
  const room = joinRoom({ appId: APP_ID }, roomId)
  const stateAction = room.makeAction('state')
  // Batida anunciada por quem bateu: empurrão (ix, iz) que `target` deve
  // receber e os pontos ganhos
  const hitAction = room.makeAction('hit')
  // Quem manda bateu na parede depois de levar um boost (para mostrar o dano)
  const wallAction = room.makeAction('wall')
  // Alguém pegou uma esfera de boost
  const pickupAction = room.makeAction('pickup')
  // Estado das esferas, mandado para quem acabou de entrar
  const orbsAction = room.makeAction('orbs')
  const peers = new Set()

  room.onPeerJoin = (peerId) => {
    peers.add(peerId)
    handlers.onPeerJoin(peerId)
    handlers.onPeersChange(peers.size)
  }
  room.onPeerLeave = (peerId) => {
    peers.delete(peerId)
    handlers.onPeerLeave(peerId)
    handlers.onPeersChange(peers.size)
  }
  listen(stateAction, validators.state, (state, peerId) => handlers.onPeerState(peerId, state))
  listen(hitAction, validators.hit, handlers.onHit)
  listen(wallAction, validators.wall, handlers.onWall)
  listen(pickupAction, validators.pickup, handlers.onPickup)
  listen(orbsAction, validators.orbs, handlers.onOrbs)

  // Sai da sala ao fechar a aba, para os outros removerem o carrinho na hora
  window.addEventListener('beforeunload', () => room.leave())

  // Só manda se tiver alguém na sala
  const broadcast = (action) => (data) => (peers.size ? action.send(data) : undefined)

  return {
    selfId,
    /** Manda o estado do meu carrinho para todos da sala. */
    sendState: broadcast(stateAction),
    /** Anuncia para todos que eu acertei `target`. */
    sendHit: broadcast(hitAction),
    /** Anuncia que eu bati na parede depois de levar um boost. */
    sendWall: broadcast(wallAction),
    /** Anuncia que eu peguei a esfera { slot, gen }. */
    sendPickup: broadcast(pickupAction),
    /** Manda o estado das esferas só para `peerId`. */
    sendOrbs: (snapshot, peerId) => orbsAction.send(snapshot, { target: peerId }),
  }
}
