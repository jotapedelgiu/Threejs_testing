import { joinRoom, selfId } from 'trystero'
import { validators } from './protocol.js'

// Multiplayer peer-to-peer (WebRTC) via Trystero. Os navegadores se encontram
// por relays públicos do Nostr (gratuitos, sem conta) e depois trocam dados
// direto entre si. Cada jogador é dono do próprio carrinho e manda o estado
// dele para os outros; não há servidor de jogo.

// Identificador único do app: só se encontram peers com o mesmo appId
const APP_ID = 'jotapedelgiu-threejs-testing-batebate'
// Em quantos relays a sala é anunciada (padrão do Trystero: 5). São relays
// pequenos; se a rede de alguém não alcança os 5, ninguém se encontra. Os 5
// primeiros continuam os mesmos, então versões antigas ainda se acham.
const RELAY_REDUNDANCY = 12

// Os relays só servem para os navegadores se acharem; os dados vão direto
// (WebRTC), e só com STUN isso falha quando a rede de alguém não permite
// conexão direta (CGNAT, rede móvel, faculdade...): os dois entram na sala,
// mas nunca se veem. Um servidor TURN faz a ponte nesses casos. Vem do build
// (.env ou variáveis do deploy); sem VITE_TURN_URL fica só o STUN, como antes.
// VITE_TURN_URL aceita várias URLs separadas por vírgula.
const TURN_URL = import.meta.env.VITE_TURN_URL
const turnConfig = TURN_URL
  ? [{ urls: TURN_URL.split(',').map((u) => u.trim()), username: import.meta.env.VITE_TURN_USER, credential: import.meta.env.VITE_TURN_CREDENTIAL }]
  : undefined

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
 *   onLayout: (layout: { seed: string, since: number, orbs: object[] }, peerId: string) => void,
 *   onBat: (bat: { index: number, dx: number, dz: number, strength: number, damage: number }, peerId: string) => void,
 *   onHello: (hello: { name: string, since: number, phase: 'lobby' | 'playing' }, peerId: string) => void,
 *   onStart: (start: { seed: string, since: number }, peerId: string) => void,
 *   onUlt: (state: { n: number, phase: string, kind: string | null, left: number, given: object | null }, peerId: string) => void,
 *   onUltReq: (req: { n: number, op: 'claim' }, peerId: string) => void,
 *   onMedkit: (state: { v: number, zones: { id: number, x: number, z: number, left: number }[] }, peerId: string) => void,
 *   onMatch: (clock: { left: number, over: boolean }, peerId: string) => void,
 *   onBots: (bots: { list: { id: string, name: string, kind: string, state: object }[] }, peerId: string) => void,
 * }} handlers
 */
export function joinArena(roomId, handlers) {
  const room = joinRoom({ appId: APP_ID, relayConfig: { redundancy: RELAY_REDUNDANCY }, turnConfig }, roomId)
  const stateAction = room.makeAction('state')
  // Batida anunciada por quem bateu: empurrão (ix, iz) e dano que `target`
  // deve receber
  const hitAction = room.makeAction('hit')
  // Quem manda bateu na parede depois de levar um boost (para mostrar o dano)
  const wallAction = room.makeAction('wall')
  // Alguém pegou uma esfera de boost
  const pickupAction = room.makeAction('pickup')
  // Mapa da partida (semente) + estado das esferas, para quem acabou de entrar
  const layoutAction = room.makeAction('layout')
  // Alguém bateu num bastão com espinhos
  const batAction = room.makeAction('bat')
  // Sala de espera: nome/situação de cada um, e o anfitrião começando a partida
  const helloAction = room.makeAction('hello')
  const startAction = room.makeAction('start')
  // Ultimate: estado (do anfitrião) e pedidos ao anfitrião
  const ultAction = room.makeAction('ult')
  const ultReqAction = room.makeAction('ultreq')
  // Zona de cura: estado (do anfitrião)
  const medkitAction = room.makeAction('medkit')
  // Relógio da partida (do anfitrião)
  const matchAction = room.makeAction('match')
  // Bots da partida (do anfitrião, que simula todos)
  const botsAction = room.makeAction('bots')
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
  listen(layoutAction, validators.layout, handlers.onLayout)
  listen(batAction, validators.bat, handlers.onBat)
  listen(helloAction, validators.hello, handlers.onHello)
  listen(startAction, validators.start, handlers.onStart)
  listen(ultAction, validators.ult, handlers.onUlt)
  listen(ultReqAction, validators.ultreq, handlers.onUltReq)
  listen(medkitAction, validators.medkit, handlers.onMedkit)
  listen(matchAction, validators.match, handlers.onMatch)
  listen(botsAction, validators.bots, handlers.onBots)

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
    /** Anuncia que eu bati num bastão. */
    sendBat: broadcast(batAction),
    /** Manda o mapa da partida e o estado das esferas só para `peerId`. */
    sendLayout: (layout, peerId) => layoutAction.send(layout, { target: peerId }),
    /** Quem sou eu (nome, situação): para todos, ou só para `peerId`. */
    sendHello: (hello, peerId) => (peerId ? helloAction.send(hello, { target: peerId }) : broadcast(helloAction)(hello)),
    /** Anfitrião: começa a partida para todos com o mapa `start`. */
    sendStart: broadcast(startAction),
    /** Anfitrião: estado do ultimate, para todos ou só para `peerId`. */
    sendUlt: (state, peerId) => (peerId ? ultAction.send(state, { target: peerId }) : broadcast(ultAction)(state)),
    /** Pedido ao anfitrião (vai para todos; só ele responde). */
    sendUltReq: broadcast(ultReqAction),
    /** Anfitrião: estado da zona de cura, para todos ou só para `peerId`. */
    sendMedkit: (state, peerId) => (peerId ? medkitAction.send(state, { target: peerId }) : broadcast(medkitAction)(state)),
    /** Anfitrião: relógio da partida, para todos ou só para `peerId`. */
    sendMatch: (clock, peerId) => (peerId ? matchAction.send(clock, { target: peerId }) : broadcast(matchAction)(clock)),
    /** Anfitrião: estado dos bots para todos. */
    sendBots: broadcast(botsAction),
  }
}
