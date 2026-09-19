/** 零柒的一声「啵」——WebAudio 现场合成，零素材。
 *
 *  右下角挂件与桌面壳的零柒小窗（`pet.html`）摸的都是同一只宠物，出的是同一声。
 *  开关记在 localStorage `pet:blip`（默认开）；没有 AudioContext 的环境（测试、
 *  被自动播放策略拦下）就安静——摸不出声不算错。
 */

let ctx: AudioContext | null = null

export function blipOn(): boolean {
  try {
    return localStorage.getItem('pet:blip') !== '0'
  } catch {
    return true
  }
}

export function setBlipOn(on: boolean): void {
  try {
    localStorage.setItem('pet:blip', on ? '1' : '0')
  } catch {
    /* 无痕模式记不了就算了 */
  }
}

export function playBlip(): void {
  if (!blipOn()) return
  try {
    const Ctx =
      window.AudioContext ??
      (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
    if (!Ctx) return
    ctx ??= new Ctx()
    if (ctx.state === 'suspended') void ctx.resume()
    const t0 = ctx.currentTime
    const osc = ctx.createOscillator()
    const gain = ctx.createGain()
    osc.type = 'sine'
    osc.frequency.setValueAtTime(520, t0)
    osc.frequency.exponentialRampToValueAtTime(780, t0 + 0.09)
    gain.gain.setValueAtTime(0.12, t0)
    gain.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.16)
    osc.connect(gain)
    gain.connect(ctx.destination)
    osc.start(t0)
    osc.stop(t0 + 0.18)
  } catch {
    /* 没声就不出声 */
  }
}
