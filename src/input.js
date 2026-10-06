import { readPad } from './gamepad.js'

// Estado do teclado por código físico da tecla (KeyW, ArrowUp...), então
// funciona igual em qualquer layout (ABNT, US, AZERTY...).
const pressed = new Set()
// Teclas apertadas desde a última leitura (sem contar a repetição automática)
const justPressed = new Set()

window.addEventListener('keydown', (e) => {
  // Não rouba as teclas quando o foco está num campo da GUI
  if (e.target instanceof HTMLInputElement) return
  pressed.add(e.code)
  if (!e.repeat) justPressed.add(e.code)
  if (e.code.startsWith('Arrow') || e.code === 'Space' || e.code === 'Tab') e.preventDefault()
})
window.addEventListener('keyup', (e) => pressed.delete(e.code))
// Solta tudo ao trocar de aba, senão a tecla fica "presa"
window.addEventListener('blur', () => {
  pressed.clear()
  justPressed.clear()
})

// Controle: lido por polling (a Gamepad API não tem eventos de botão), no máximo
// a cada POLL_MS (getGamepads aloca um array). Os botões viram os mesmos códigos
// do teclado, então wasPressed/isDown funcionam igual para os dois.
const POLL_MS = 8
let pad = { throttle: 0, steer: 0, codes: [] }
let padCodes = new Set()
let lastPoll = -Infinity

function pollPad() {
  const now = performance.now()
  if (now - lastPoll < POLL_MS || !navigator.getGamepads) return
  lastPoll = now
  let connected
  for (const p of navigator.getGamepads()) if (p?.connected) { connected = p; break }
  const next = readPad(connected)
  // Borda de subida do botão = "acabou de apertar" (como o keydown sem repeat)
  for (const code of next.codes) if (!padCodes.has(code)) justPressed.add(code)
  pad = next
  padCodes = new Set(next.codes)
}

export function isDown(...codes) {
  pollPad()
  return codes.some((c) => pressed.has(c) || padCodes.has(c))
}

/** Eixos de direção: throttle (W/S ou gatilhos) e steer (A/D ou stick), de -1 a 1. */
export function readDriveInput() {
  pollPad()
  const throttle = (isDown('KeyW', 'ArrowUp') ? 1 : 0) - (isDown('KeyS', 'ArrowDown') ? 1 : 0)
  const steer = (isDown('KeyA', 'ArrowLeft') ? 1 : 0) - (isDown('KeyD', 'ArrowRight') ? 1 : 0)
  // O teclado vale quando está em uso; senão, o analógico
  return { throttle: throttle || pad.throttle, steer: steer || pad.steer }
}

/** true uma única vez por toque na tecla (ex.: Espaço para usar o boost). */
export function wasPressed(code) {
  pollPad()
  return justPressed.delete(code)
}
