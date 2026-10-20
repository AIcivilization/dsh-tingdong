# 听懂 · dsh-tingdong

把英文有声读物（MP3）变成听力课，练到**听到英文就知道是什么意思**。
[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（dsh）插件，也能脱离 DSH 单独用。

## 它做什么

1. **导入**：选一个 MP3（或整个文件夹），本机识别出每一句英文和它的起止时间。
   识别用的是 DSH 自带语音输入的同一套模型（SenseVoice + Silero VAD），音频不上传；用过 DSH 语音输入就不用再下载。
2. **讲解**：用你在 DSH 里选的大模型逐句校对英文（修正识别错误，如 "resna tuning" → "resonant tuning"）、
   翻成口语化中文、挑出生词（带音标）、写一句「听音提示」（哪里连读、弱读、吞音），再写全篇概述和关键术语表。
3. **练习**（右侧栏「听懂」页签，或手机浏览器直接打开）：

| 模式 | 做法 |
| --- | --- |
| 今日学习 | 首页一个按钮：所有课里该复习的句子 + 每天 10 句新句子串成一组；显示连续学习天数、今天学了几句、约几分钟、最近 7 天 |
| 精听 | 每句先**只听不看**猜意思 → 看英文找出没听出来的词（**点任意一个词看意思**）→ 看中文和生词 → 再听一遍 → 自评「没听懂 / 半懂 / 听懂了」 |
| 复习 | 间隔重复，三种考法：**自评**、**选意思**（只听声音，三选一）、**听写**（打出来，逐词标出没听出来的）。没听懂的一分钟后再来，听懂的隔 10 分钟、1 天、3 天、7 天…再考；7 天后还能听懂算掌握。可以只练「收藏」或「难句」 |
| 磨耳朵 | 不用动手：每句放 1–4 遍，停几秒让你想意思，再接下一句；字幕可以逐步显示（第 1 遍不看字 → 第 2 遍英文 → 想的时候中文）。做成一段真正的音频，**锁屏也能一直放**，耳机线控切句，也能下载 |
| 连续听 | 一句接一句不停地播，英文 / 中文字幕分别开关；最后关掉字幕整篇听 |
| 词汇 | 全篇关键术语、每句的生词、你查过的词，点一下听原句 |

**导出**（每课的「导出」页签）：

- **中文配音（音频）**：可以下载 **MP3** 或无损 **FLAC**（44.1 kHz / 16 位，和合成出来的原始音频同源，不是 MP3 转的）。把英文换成中文配音，只有中文、没有背景音，每句中文从对应英文开始的时刻开始说，总长和原音频一样（也可以对齐「原声·去空白」）。比空档长的句子自动读快一点（最快 1.6 倍），不会挤到下一句。两种语音可选：
  - **本地 Kokoro**：离线，55 个普通话女声、45 个普通话男声，每个都能先试听；第一次用时下载约 147 MB 模型
  - **微软 Edge**：晓晓、云希、云扬等 14 种（含台湾、粤语、方言），要联网。插件调用开源工具 [edge-tts](https://github.com/rany2/edge-tts)，点「安装 Edge 语音组件」会装进插件自己的 Python 虚拟环境（需要电脑上有 Python 3）。文字会发到微软的服务器；这不是微软公开的正式接口，可能失效
- **文字**：双语 / 英文 / 中文字幕（SRT）、双语歌词 LRC（Walkman 等播放器滚动显示）、**录音稿**（每句的开始时间、英文时长、可用时长和中英对照，照着自己录中文配音）、表格 CSV。时间可按原音频或「原声·去空白」

卡片右上角 ☆ 收藏，复习和磨耳朵里可以只练收藏的
- **改句子**：识别偶尔认错字、切错句，卡片右上角 ✎ 可以改英文 / 中文、和下一句合并、拆成两句、重新讲解、标为非讲话
- **换设备接着学**：学到第几句、选的哪种声音、复习进度都存在服务器上
- **手机**：按钮加大，左右滑动换句，评分按钮固定在底部，锁屏界面和耳机线控可以播放 / 暂停 / 换句

**声音**：同一课可以换声音听，在课程页上方切换，每种都能下载成 MP3 放到手机上：

| 声音 | 说明 |
| --- | --- |
| 原声（完整） | 原始音频，含背景音乐和长空白 |
| 原声·去空白 | 只留讲话，句间停 0.7 秒。34 分钟的引导冥想剩 11 分 40 秒 |
| 原声·压背景 | 同上，再滤掉低沉的双耳节拍和高频噪声 |
| 系统朗读 | macOS 自带语音读校对后的英文；在系统设置里下载「高级 / 增强」英文语音后会自动用上 |
| Kokoro 朗读 | 离线神经网络语音（11 种美式 / 英式男女声，可调语速），第一次用时下载约 103 MB 模型 |

新导入的课会自动生成两条原声轨，朗读的声音在「概览 → 声音」里点「生成」。

电脑快捷键：空格 重听 · 回车 下一步 · 1/2/3 评分 · ←/→ 上一句/下一句 · S 变速（1× / 0.85× / 0.7×）· L 单句循环

在 DSH 对话里也可以直接说：「把 /Volumes/…/CD4 导入听懂」「我这课哪些句子总听不懂？给我讲讲」——插件给 AI 注册了 `tingdong_import`、`tingdong_lessons`、`tingdong_sentences` 三个工具。

**更新 / 卸载**：在 DSH 的「设置 → 听懂」里。打开时自动查 npm 上有没有新版本；有就出现「更新到 vX」，点一下由 DSH 的插件管理器装好（和插件市场同一套机制），重启 DSH 生效。「卸载」会先确认，只移除插件，课程和学习进度留在 `~/.dsh/dsh-tingdong`。学习面板首页标题旁显示版本号，有新版本时会提醒。

## 安装

需要 [ffmpeg](https://ffmpeg.org)（解码 MP3）：Mac 上 `brew install ffmpeg`。

装进 DSH（把 `desktop` 换成你的 profile 名；先完全退出 DSH）：

```bash
dsh plugin --profile desktop add /path/to/dsh-go
```

重新打开 DSH，在对话页打开右侧栏，选「听懂 · 英文听力」。设置里的「听懂」分区会显示 ffmpeg、识别模型、翻译模型是否就绪。

### 可选配置

在 profile 的 `cordis.patch.yml` 里：

```yaml
- id: dsh-tingdong
  config:
    provider: dsh-model-workbuddy-ai   # 翻译用的模型；不填就用 DSH 的默认模型
    model: workbuddy-ai/deepseek-v4.1-flash-sg
    ffmpeg: /opt/homebrew/bin/ffmpeg   # 找不到 ffmpeg 时填
    threads: 2                         # 识别线程数
```

## 用手机学（VPS）

在电脑上做课（识别、翻译、生成声音都很吃 CPU），发到 VPS 上的 DSH，手机浏览器打开学习：

1. VPS 上装好 DSH（比如用 [dsh-vps](https://github.com/AIcivilization/dsh-vps)），也装上本插件：
   `dsh plugin --profile web add dsh-tingdong`（以运行 DSH 的用户执行，再重启 DSH）。VPS 上不需要 ffmpeg。
2. 电脑上的「听懂」首页底部「手机学习（VPS）」：选 SSH 主机（`~/.ssh/config` 里的，要能用钥匙免密码登录）→「查找 VPS 上的 DSH」→ 选一个。
3. 点「全部发送到 VPS」，或在每课「管理」里单独发送。只发课程内容和声音，**不会覆盖 VPS 上的学习进度**。
4. 手机打开 `https://<你的域名>/api-dsh-tingdong/panel`（首页会显示这个地址），可以「添加到主屏幕」当 App 用。

发送走 SSH（tar 流解到 VPS 上 DSH 用户的 `~/.dsh/dsh-tingdong/lessons/`），不经过网页登录门。

## 不开 DSH 也能用

```bash
node bin/dsh-tingdong.js import "/Volumes/kuozhan/门罗/CD4"     # 整个文件夹，每个音频一课
node bin/dsh-tingdong.js serve                                   # 打开 http://127.0.0.1:4810
node bin/dsh-tingdong.js list
node bin/dsh-tingdong.js voices all --track kokoro --voice am_michael   # 批量生成声音轨
```

命令行版的模型：`--base-url / --api-key / --model`，或环境变量 `TINGDONG_BASE_URL / TINGDONG_API_KEY / TINGDONG_MODEL`（任何 OpenAI 兼容接口）；都没给就用本机的 dsh-model 网关。

## 数据

都在 `~/.dsh/dsh-tingdong/lessons/<课程>/`：`lesson.json`（句子、翻译、讲解、查过的词）、`progress.json`（复习进度、学到第几句、选的声音、收藏）、`audio.mp3`（压缩成 64 kbps 单声道，原文件所在的移动硬盘拔掉也能听）、`tracks/`（各种声音和它们的时间表）。
模型在 `~/.dsh/dsh-tingdong/models/`（Kokoro 英文、Kokoro 中文）；Edge 语音组件在 `~/.dsh/dsh-tingdong/edge-tts/`；识别模型优先复用 DSH 语音输入下好的。
DSH 插件和命令行版共用这份数据。

## 实测

Hemi-Sync Gateway Wave IV「Adventure 1 (One Year Patterning)」，34 分钟 MP3（大段音乐 + 引导语）：
识别 16 秒（M 系列 Mac，4 线程），切出 96 句，模型判出 6 处音乐里的杂音并跳过；DeepSeek 翻译讲解约 1 分钟。

## 开发

```bash
npm install
npm test
```

- `lib/asr-worker.js` 识别子进程（sherpa-onnx 是同步推理，放在 DSH 主进程里会卡界面）
- `lib/translate.js` 校对 + 翻译 + 生词 + 听音提示；缺句自动缩小批次重试，失败的留空，之后可「补全翻译」
- `lib/tracks.js` 声音轨：原声按句截取拼接；朗读交给 `lib/tts-worker.js` 子进程（Kokoro / macOS say），`lib/pcm.js` 统一拼接编码并出时间表
- `lib/srs.js` 间隔复习；`lib/store.js` 原子写入的 JSON 存储；`lib/today.js` 今日学习（按用户时区算日期）
- `lib/export.js` 文字导出；`lib/edge.js` Edge 语音组件（edge-tts）的安装和调用
- `lib/drill.js` 磨耳朵音频；`lib/lookup.js` 点词查意思、重新讲解；`lib/vps.js` 经 SSH 发送到 VPS
- `plugin/` DSH 宿主端（路由、AI 工具）和界面入口（右侧栏、设置）；路由先过 DSH 的 `connection.requestRejection()` 登录校验
- `web/` 学习面板（原生 JS 模块，无构建）：`panel.js` 路由和首页 · `study.js` 精听、复习、今日学习 · `listen.js` 连续听、磨耳朵、词汇 · `edit.js` 改句子、查词 · `core.js` 播放器和公共状态
