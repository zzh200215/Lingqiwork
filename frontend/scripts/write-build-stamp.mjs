// build 末尾跑（package.json: `vite build && node scripts/write-build-stamp.mjs`）：
// 给 dist 盖一个章——哪个 commit、什么时候构建的。后端启动时比对 git HEAD，
// 落后了就在日志里喊一声。起因是真实事故：改完 Layout 忘了重新 build，
// 对着浏览器验收半天找不到新功能，最后发现看的是旧包。
import { execSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')

let commit = ''
try {
  commit = execSync('git rev-parse HEAD', { cwd: root, encoding: 'utf8' }).trim()
} catch {
  // 不在 git 里（zip 下载、浅克隆没装 git）也要盖章：at 至少能说明包是什么时候出的
}

const dist = resolve(root, 'frontend', 'dist')
mkdirSync(dist, { recursive: true })
const stamp = { commit, at: new Date().toISOString() }
writeFileSync(resolve(dist, '.wb-build.json'), JSON.stringify(stamp, null, 2) + '\n')
console.log('build stamp:', commit ? commit.slice(0, 10) : '(no git)', stamp.at)
