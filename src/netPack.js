// Empacotamento binário do estado "enxuto" (netSend.js: sem campos lentos), que
// é mais de 95% do tráfego: 30 bytes em vez de ~115 de JSON. O resto (estado
// completo, hit, hello...) continua em JSON. Sem dependências de navegador, para
// poder ser testado no Node.
//
// Cada mensagem do Trystero já carrega 36 bytes de cabeçalho, então o corpo
// pequeno + uma só mensagem para todos os bots é o que mais pesa na conta.
//
// Formato de um estado (little-endian, 30 bytes):
//    0 u8  flags: 1 boosting, 2 ko, 4 shield, 8 ghost
//    1 u8  ult: 0 = nenhum, senão 1 + índice em ULT_KINDS
//    2 u32 t em ms
//    6 i16 x (cm)   8 i16 z (cm)   10 i16 yaw (1e-4 rad, normalizado a ±pi)
//   12 i16 vx (cm/s) 14 i16 vz (cm/s)
//   16 i16 y (mm)  18 i16 roll (1e-4 rad)  20 i16 pitch (1e-4 rad)
//   22 u16 hp  24 u16 tp  26 u16 ms  28 i16 yawRate (1e-3 rad/s)
// Lista de bots: u8 (bit 7 = lista completa, resto = quantos) e, para cada um:
// u16 número do bot ("bot-N") + estado.
// Valor fora do que cabe (arena gigante, contador estourado...): pack devolve
// null e quem chama manda o JSON de sempre.

import { ULT_KINDS } from './ultimate.js'

export const MOVE_BYTES = 30
const BOT_BYTES = 2 + MOVE_BYTES
const MAX_BOTS = 8 // igual a protocol.js
const BOT_ID = /^bot-(\d{1,5})$/

const I16 = { min: -32768, max: 32767 }
const COMPLETE = 0x80
const fitsI16 = (v) => v >= I16.min && v <= I16.max
const fitsU16 = (v) => v >= 0 && v <= 0xffff
const wrapAngle = (a) => Math.atan2(Math.sin(a), Math.cos(a))

/** Escreve o estado em `dv` a partir de `o`. @returns false se algum valor não couber. */
function writeMove(dv, o, s) {
  const ult = s.ult ? ULT_KINDS.indexOf(s.ult) + 1 : 0
  const t = Math.round(s.t * 1000)
  const f = {
    x: Math.round(s.x * 100), z: Math.round(s.z * 100), yaw: Math.round(wrapAngle(s.yaw) * 1e4),
    vx: Math.round(s.vx * 100), vz: Math.round(s.vz * 100), y: Math.round(s.y * 1000),
    roll: Math.round(s.roll * 1e4), pitch: Math.round(s.pitch * 1e4), yawRate: Math.round((s.yawRate ?? 0) * 1e3),
  }
  const hp = Math.round(s.hp)
  const tp = s.tp ?? 0
  const ms = s.ms ?? 0
  if (!Object.values(f).every(fitsI16) || !(t >= 0 && t <= 0xffffffff) || ult < 0 || (s.ult && ult === 0)) return false
  if (!fitsU16(hp) || !fitsU16(tp) || !fitsU16(ms) || !Number.isInteger(tp) || !Number.isInteger(ms)) return false
  dv.setUint8(o, (s.boosting ? 1 : 0) | (s.ko ? 2 : 0) | (s.shield ? 4 : 0) | (s.ghost ? 8 : 0))
  dv.setUint8(o + 1, ult)
  dv.setUint32(o + 2, t, true)
  dv.setInt16(o + 6, f.x, true)
  dv.setInt16(o + 8, f.z, true)
  dv.setInt16(o + 10, f.yaw, true)
  dv.setInt16(o + 12, f.vx, true)
  dv.setInt16(o + 14, f.vz, true)
  dv.setInt16(o + 16, f.y, true)
  dv.setInt16(o + 18, f.roll, true)
  dv.setInt16(o + 20, f.pitch, true)
  dv.setUint16(o + 22, hp, true)
  dv.setUint16(o + 24, tp, true)
  dv.setUint16(o + 26, ms, true)
  dv.setInt16(o + 28, f.yawRate, true)
  return true
}

function readMove(dv, o) {
  const flags = dv.getUint8(o)
  const ult = dv.getUint8(o + 1)
  return {
    t: dv.getUint32(o + 2, true) / 1000,
    x: dv.getInt16(o + 6, true) / 100,
    z: dv.getInt16(o + 8, true) / 100,
    yaw: dv.getInt16(o + 10, true) / 1e4,
    vx: dv.getInt16(o + 12, true) / 100,
    vz: dv.getInt16(o + 14, true) / 100,
    y: dv.getInt16(o + 16, true) / 1000,
    roll: dv.getInt16(o + 18, true) / 1e4,
    pitch: dv.getInt16(o + 20, true) / 1e4,
    yawRate: dv.getInt16(o + 28, true) / 1e3,
    hp: dv.getUint16(o + 22, true),
    tp: dv.getUint16(o + 24, true),
    ms: dv.getUint16(o + 26, true),
    boosting: (flags & 1) !== 0,
    ko: (flags & 2) !== 0,
    shield: (flags & 4) !== 0,
    ghost: (flags & 8) !== 0,
    ult: ult === 0 ? null : ULT_KINDS[ult - 1] ?? null,
  }
}

const viewOf = (bytes) => new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)

/** Estado enxuto -> ArrayBuffer (ou null: manda em JSON). */
export function packMove(state) {
  const buffer = new ArrayBuffer(MOVE_BYTES)
  return writeMove(new DataView(buffer), 0, state) ? buffer : null
}

/** Bytes recebidos -> estado (ainda sem validar: protocol.js: validators.move), ou null. */
export function unpackMove(bytes) {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength !== MOVE_BYTES) return null
  return readMove(viewOf(bytes), 0)
}

/**
 * Lista de bots enxutos [{ id, state }] -> ArrayBuffer (ou null: manda em JSON).
 * `complete`: a lista tem todos os bots (quem não está nela saiu).
 */
export function packBots(list, complete = false) {
  if (list.length > MAX_BOTS) return null
  const buffer = new ArrayBuffer(1 + list.length * BOT_BYTES)
  const dv = new DataView(buffer)
  dv.setUint8(0, list.length | (complete ? COMPLETE : 0))
  for (const [i, { id, state }] of list.entries()) {
    const match = BOT_ID.exec(id)
    const n = match ? Number(match[1]) : -1
    if (!fitsU16(n)) return null
    const o = 1 + i * BOT_BYTES
    dv.setUint16(o, n, true)
    if (!writeMove(dv, o + 2, state)) return null
  }
  return buffer
}

/** Bytes recebidos -> { list: [{ id, state }], complete } (ainda sem validar: protocol.js: validators.botMoves), ou null. */
export function unpackBots(bytes) {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength < 1) return null
  const dv = viewOf(bytes)
  const head = dv.getUint8(0)
  const count = head & ~COMPLETE
  if (count > MAX_BOTS || bytes.byteLength !== 1 + count * BOT_BYTES) return null
  const list = []
  for (let i = 0; i < count; i++) {
    const o = 1 + i * BOT_BYTES
    list.push({ id: `bot-${dv.getUint16(o, true)}`, state: readMove(dv, o + 2) })
  }
  return { list, complete: (head & COMPLETE) !== 0 }
}
