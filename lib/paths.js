// lib/paths.js — 数据放哪、外部程序在哪
//
// 课程都在 ~/.dsh/dsh-tingdong/lessons/<id>/ 下：lesson.json（句子、翻译、讲解）、
// progress.json（每句的复习进度）、audio.mp3（压缩过的单声道音频，原文件拔掉移动硬盘也能听）。
// 环境变量 DSH_TINGDONG_HOME 可以换位置（测试用）。

import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { delimiter, join } from 'node:path'

export function dataRoot() {
  return process.env.DSH_TINGDONG_HOME || join(homedir(), '.dsh', 'dsh-tingdong')
}

export const lessonsDir = () => join(dataRoot(), 'lessons')
export const lessonDir = id => join(lessonsDir(), id)
export const uploadsDir = () => join(dataRoot(), 'uploads')

/** 课程 id：只允许字母数字和 -，防止路径穿越 */
export const ID_RE = /^[a-z0-9][a-z0-9-]{0,80}$/

/**
 * 找 ffmpeg：配置 > 环境变量 > PATH > 常见安装位置。
 * DSH 桌面版从 Dock 启动时 PATH 很短（没有 /opt/homebrew/bin），所以常见位置要自己找。
 */
export function findFfmpeg(configured) {
  const candidates = []
  if (configured) candidates.push(configured)
  if (process.env.FFMPEG_PATH) candidates.push(process.env.FFMPEG_PATH)
  const exe = process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg'
  for (const dir of String(process.env.PATH || '').split(delimiter)) if (dir) candidates.push(join(dir, exe))
  candidates.push(
    '/opt/homebrew/bin/ffmpeg',
    '/usr/local/bin/ffmpeg',
    '/usr/bin/ffmpeg',
    join(homedir(), 'bin', 'ffmpeg'),
    join(homedir(), '.local', 'bin', 'ffmpeg'),
    'C:\\ffmpeg\\bin\\ffmpeg.exe',
  )
  return candidates.find(p => existsSync(p)) || null
}

export const FFMPEG_HINT =
  '找不到 ffmpeg（解码 MP3、做磨耳朵音频要用）。Mac 上执行 brew install ffmpeg，Linux / VPS 上执行 sudo apt install ffmpeg；装在别处可以在插件配置里填 ffmpeg 的完整路径。'
