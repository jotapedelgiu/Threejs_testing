// Dead reckoning: o MESMO modelo de extrapolação roda em quem manda (para saber
// quando uma mensagem é necessária) e em quem recebe (para desenhar o carro
// entre mensagens). O dono só manda um estado novo quando o modelo errou mais
// que um limite, ou depois de um tempo máximo sem mandar (Aronson, "Dead
// Reckoning: Latency Hiding for Networked Games"). Sem dependências de
// navegador, para poder ser testado no Node.
//
// O modelo é de 1ª ordem com giro: a velocidade gira junto com o carro (o carro
// anda em arco) à taxa `yawRate`. Em teste com a física real do carro, isso
// derruba de 20 para ~6 mensagens por segundo com erro médio de ~3 cm.
//
// Convenção do jogo: frente = (sen yaw, cos yaw), então girar `w` rad/s faz a
// velocidade girar com derivada w * (vz, -vx).

export const DR = {
  posEps: 0.08,           // m de erro de posição que obriga a mandar
  yawEps: 0.04,           // rad (~2,3°) de erro de direção que obriga a mandar
  rollEps: 0.06,          // rad de inclinação (só visual)
  yEps: 0.1,              // m de pulo (só visual)
  maxGap: 0.25,           // s: sem erro nenhum, ainda manda um sinal de vida
  maxExtrapolation: 0.6,  // s: quem recebe nunca extrapola além disso (parou de chegar: congela)
}

/**
 * Estado `s` ({ x, z, yaw, vx, vz, yawRate? }) daqui a `dt` segundos.
 * @param {object} [out] reaproveitado (a física roda a cada quadro: sem `new`)
 * @returns {{ x: number, z: number, yaw: number, vx: number, vz: number }}
 */
export function extrapolate(s, dt, out = {}) {
  const w = s.yawRate ?? 0
  if (Math.abs(w) < 1e-4) {
    out.x = s.x + s.vx * dt
    out.z = s.z + s.vz * dt
    out.vx = s.vx
    out.vz = s.vz
  } else {
    const sin = Math.sin(w * dt)
    const cos = Math.cos(w * dt)
    out.x = s.x + (s.vx * sin + s.vz * (1 - cos)) / w
    out.z = s.z + (s.vz * sin - s.vx * (1 - cos)) / w
    out.vx = s.vx * cos + s.vz * sin
    out.vz = s.vz * cos - s.vx * sin
  }
  out.yaw = s.yaw + w * dt
  return out
}

const wrap = (a) => Math.atan2(Math.sin(a), Math.cos(a))
const tmp = {}

/** O estado atual `now` fugiu do que os outros estão vendo (o modelo a partir de `last`)? */
export function exceedsError(last, now) {
  const p = extrapolate(last, now.t - last.t, tmp)
  return (
    Math.hypot(p.x - now.x, p.z - now.z) > DR.posEps ||
    Math.abs(wrap(p.yaw - now.yaw)) > DR.yawEps ||
    Math.abs((now.roll ?? 0) - (last.roll ?? 0)) > DR.rollEps ||
    Math.abs((now.pitch ?? 0) - (last.pitch ?? 0)) > DR.rollEps ||
    Math.abs((now.y ?? 0) - (last.y ?? 0)) > DR.yEps
  )
}
