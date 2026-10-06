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
// ATENÇÃO: tudo que começa com VITE_ vai para o JS público; usuário e senha do
// TURN ficam visíveis a quem abrir o jogo e podem ser usados por outros. Risco
// aceito enquanto não há backend; use uma conta TURN com limite de banda/custo
// (ou credenciais efêmeras da API REST do TURN, se um dia houver servidor).
const TURN_URL = import.meta.env.VITE_TURN_URL
const turnConfig = TURN_URL
  ? [{ urls: TURN_URL.split(',').map((u) => u.trim()), username: import.meta.env.VITE_TURN_USER, credential: import.meta.env.VITE_TURN_CREDENTIAL }]
  : undefined

// Cabeçalho que o Trystero põe em toda mensagem (nome da ação em 32 bytes + contador + flags)
const WIRE_HEADER = 36

// Mensagens descartadas por não passarem na validação, por ação (só no dev:
// __netStats().dropped). Sem isso, um formato que o transporte entrega diferente
// do esperado (ex.: ArrayBuffer em vez de Uint8Array) some sem deixar rastro.
const dropped = {}

// Liga o recebimento de uma ação ao handler, validando antes
function listen(name, action, validate, handler) {
  action.onMessage = (data, { peerId }) => {
    const clean = validate(data)
    if (clean) return handler(clean, peerId)
    if (import.meta.env.DEV) {
      dropped[name] = (dropped[name] ?? 0) + 1
      if (dropped[name] === 1) console.warn(`Multiplayer: mensagem "${name}" inválida descartada de ${peerId}`, data)
    }
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
 *   onJoinError?: (error: string, peerId: string) => void, // achou o outro nos relays mas a conexão direta falhou
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
 *   onBots: (bots: { list: { id: string, name: string | null, kind: string | null, state: object }[], complete: boolean }, peerId: string) => void, // name/kind null = os de antes; complete = a lista tem todos os bots
 * }} handlers
 */
export function joinArena(roomId, handlers) {
  const room = joinRoom({ appId: APP_ID, relayConfig: { redundancy: RELAY_REDUNDANCY }, turnConfig }, roomId, {
    // O Trystero não escreve essa falha no console: só avisa por aqui
    onJoinError: ({ error, peerId }) => {
      console.error(`Multiplayer: ${error}`)
      handlers.onJoinError?.(error, peerId)
    },
  })
  const stateAction = room.makeAction('state')
  // Estado enxuto em binário (netPack.js) e lista de bots enxuta em binário
  const moveAction = room.makeAction('mv')
  const botMovesAction = room.makeAction('bmv')
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
  listen('state', stateAction, validators.state, (state, peerId) => handlers.onPeerState(peerId, state))
  listen('move', moveAction, validators.move, (state, peerId) => handlers.onPeerState(peerId, state))
  listen('botMoves', botMovesAction, validators.botMoves, handlers.onBots)
  listen('hit', hitAction, validators.hit, handlers.onHit)
  listen('wall', wallAction, validators.wall, handlers.onWall)
  listen('pickup', pickupAction, validators.pickup, handlers.onPickup)
  listen('layout', layoutAction, validators.layout, handlers.onLayout)
  listen('bat', batAction, validators.bat, handlers.onBat)
  listen('hello', helloAction, validators.hello, handlers.onHello)
  listen('start', startAction, validators.start, handlers.onStart)
  listen('ult', ultAction, validators.ult, handlers.onUlt)
  listen('ultReq', ultReqAction, validators.ultreq, handlers.onUltReq)
  listen('medkit', medkitAction, validators.medkit, handlers.onMedkit)
  listen('match', matchAction, validators.match, handlers.onMatch)
  listen('bots', botsAction, validators.bots, handlers.onBots)

  // Sai da sala ao fechar a aba, para os outros removerem o carrinho na hora
  // (pagehide também dispara no celular, onde beforeunload quase nunca roda)
  window.addEventListener('pagehide', () => room.leave())

  // Consumo de rede (só no dev): bytes enviados contando o cabeçalho de 36 bytes de cada mensagem
  // do Trystero por destinatário; no console: __netStats(). Em dev o estado também leva dmgBy/dmgTaken
  // (relatório de partida), que a produção não manda: aqui o consumo sai um pouco maior que o real.
  const stats = { bytes: 0, messages: 0, since: performance.now() }
  if (import.meta.env.DEV) {
    window.__netStats = () => {
      const seconds = (performance.now() - stats.since) / 1000
      const out = { messages: stats.messages, KB: +(stats.bytes / 1024).toFixed(1), seconds: +seconds.toFixed(1), KBps: +(stats.bytes / 1024 / seconds).toFixed(2), dropped: { ...dropped } }
      stats.bytes = stats.messages = 0
      stats.since = performance.now()
      return out
    }
  }
  const sizeOf = (data) => (typeof data === 'string' ? data.length : data instanceof ArrayBuffer ? data.byteLength : JSON.stringify(data).length)

  // Só manda se tiver alguém na sala
  const broadcast = (action) => (data) => {
    if (!peers.size) return undefined
    if (import.meta.env.DEV) {
      stats.bytes += (sizeOf(data) + WIRE_HEADER) * peers.size
      stats.messages += peers.size
    }
    return action.send(data)
  }

  return {
    selfId,
    /** Manda o estado do meu carrinho para todos da sala. */
    sendState: broadcast(stateAction),
    /** Estado enxuto já empacotado (netPack.js: packMove). */
    sendMove: broadcast(moveAction),
    /** Lista de bots enxuta já empacotada (netPack.js: packBots). */
    sendBotMoves: broadcast(botMovesAction),
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
