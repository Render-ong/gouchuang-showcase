// 语音通话全屏层：纯动效/交互组件（对齐原生端 components/voice-call）。
// 数据来源：直接订阅 utils/voice-session（state/volume/usertext/agenttext），
// 页面只负责 visible 开关与挂断收尾（onHangup 外抛），组件自包含可复用。
//
// 声波条设计：15 根圆头竖条。
// 静息（无声音）时高度按圆弧包络分布（sqrt(1-x²)），视觉上组成一个圆形；
// 有声音（用户说话/AI播报）时在圆弧基础上按音量拉伸起伏，圆"打散"成波。
import { useState, useRef, useEffect } from 'react'
import { View, Text, ScrollView } from '@tarojs/components'
import { on, off, getState, setAgentSpeaking, toggleMute, interrupt, STATUS_TEXT } from '../../utils/voice-session'
import { createTypeWriter } from '../../utils/type-writer'
import './index.scss'

// Agent 思考期过渡话术（Thinking 态打字机显示，随机轮换；纯显示不进 TTS 零成本）。
// 不带省略号——tsx 里 agentThinking 控制呼吸"…"动画元素拼接
const HINT_PHRASES = [
  '等我思考一下', '我先看看资料', '让我想想哈', '稍等，马上来',
  '我想想怎么说', '翻翻资料中', '马上就好', '我想想啊'
]

const BAR_N = 15
// 色谱连续过渡：相邻柱 hue 相差 5°，静息时整排是自然的紫→蓝→青渐变；
// 说话时 hueShift 随音量累加旋转，颜色随跳动流动（不固定）
const HUE_BASE = 195   // 青
const HUE_SPAN = 70    // 跨度到 265°（紫）

interface Bar {
  h: number
  c1: string
  c2: string
}

// 静息圆弧包络：x∈[-0.9,0.9]，高度 = 圆的弦长 ×280 —— 无声音时整排组成圆形侧影
function barBase(i: number): number {
  const half = (BAR_N - 1) / 2
  const x = (i - half) / half * 0.9
  return Math.round(Math.sqrt(Math.max(0, 1 - x * x)) * 280)
}

// level∈[0,1] + hueShift → 每根条 {h 高度, c1/c2 HSL 渐变}。
// 静息：纯圆弧包络（圆形侧影）；有声音：每根条乘独立随机系数——
// 录音电平那种高低错落的频谱感（k 随音量增大，越大声越"炸开"）
function buildBars(level: number, hueShift: number): Bar[] {
  const bars: Bar[] = []
  const k = Math.min(1, level * 1.4)
  for (let i = 0; i < BAR_N; i++) {
    const base = barBase(i)
    const hue = HUE_BASE + (i / (BAR_N - 1)) * HUE_SPAN + hueShift
    const r = 0.25 + Math.random() * 0.75
    bars.push({
      h: Math.round(base * (1 - k) + (24 + r * 250) * k),
      c1: `hsl(${Math.round(hue)}, 72%, 74%)`,
      c2: `hsl(${Math.round(hue) + 28}, 65%, 52%)`
    })
  }
  return bars
}

interface VoiceCallProps {
  visible: boolean
  onHangup: () => void
}

export default function VoiceCall({ visible, onHangup }: VoiceCallProps) {
  const [statusText, setStatusText] = useState('')
  const [muted, setMuted] = useState(false)
  // AI 播报中：显示打断按钮（半双工无语音打断，需手动）
  const [speaking, setSpeaking] = useState(false)
  const [liveText, setLiveText] = useState('')   // 通道实时转写（usertext 中间态）
  const [agentText, setAgentText] = useState('') // AI 回复流式大字（打字机已上屏前缀）
  const [agentThinking, setAgentThinking] = useState(false)
  const [voiceBars, setVoiceBars] = useState<Bar[]>(() => buildBars(0, 0))
  const [agentAnchorId, setAgentAnchorId] = useState('')

  const hueShiftRef = useRef(0)
  const typerRef = useRef<ReturnType<typeof createTypeWriter> | null>(null)
  const anchorNRef = useRef(0)

  useEffect(() => {
    hueShiftRef.current = 0
    const typer = createTypeWriter((shown) => {
      anchorNRef.current += 1
      setAgentText(shown)
      setAgentAnchorId('vc-agent-end-' + anchorNRef.current)
    }, 50)
    typerRef.current = typer

    const onState = (s: string) => {
      setStatusText(STATUS_TEXT[s] || '')
      setMuted(s === 'muted')
      setSpeaking(s === 'speaking')
    }
    // 音量 → 声波条高度 + 色谱旋转（voice-session 已 50ms 节流）。
    // 用户说话：麦克风真实音量；AI 播报：session 的模拟脉动——两路都走 volume 事件。
    const onVolume = (v: number) => {
      hueShiftRef.current += v * 7
      setVoiceBars(buildBars(v, hueShiftRef.current))
    }
    // 中间态实时显示，final 后文字进对话页、清空本地
    const onUserText = (d: any) => {
      setLiveText(d && d.final ? '' : (d && d.text) || '')
    }
    // AI 回复流式大字：A2A 逐句下发无字级间隔，直接上屏是整句蹦出——
    // 经打字机插值（50ms/字）逐字上屏，追赶式：目标变长续打、覆盖式（新一轮）重打
    const onAgentText = (d: any) => {
      if (!d || !d.text) return
      setAgentThinking(false) // 真实回复首帧：灭省略号
      typer.push(d.text)
    }
    // Agent 状态联动：
    // 1. Responding（播报中）→ 进入 speaking：亮打断按钮 + 波柱脉动
    // 2. Listening（回到待听）→ 退出 speaking：收尾播放、停脉动
    // 3. Thinking → 随机过渡话术 + 呼吸省略号（纯显示，零 TTS 成本）
    const onAgentState = (s: string) => {
      if (!s) return
      const up = s.toUpperCase()
      if (up.indexOf('RESPONDING') >= 0) {
        setAgentSpeaking(true)
        return
      }
      if (up.indexOf('LISTENING') >= 0) {
        setAgentSpeaking(false)
        return
      }
      if (up.indexOf('THINKING') >= 0) {
        setAgentThinking((prev) => {
          if (prev) return prev // 已在思考态：本轮话术已显示
          typer.push(HINT_PHRASES[Math.floor(Math.random() * HINT_PHRASES.length)])
          return true
        })
      }
    }
    const onError = () => {
      setStatusText(STATUS_TEXT.error)
    }
    on('state', onState)
    on('volume', onVolume)
    on('usertext', onUserText)
    on('agenttext', onAgentText)
    on('agentstate', onAgentState)
    on('error', onError)
    return () => {
      typer.reset()
      off('state', onState)
      off('volume', onVolume)
      off('usertext', onUserText)
      off('agenttext', onAgentText)
      off('agentstate', onAgentState)
      off('error', onError)
    }
  }, [])

  // 打开时同步一次当前状态快照（session 先于组件启动的场景）；
  // 开/关都清打字机：关闭后必须停定时器，否则隐藏态仍每 50ms 空转
  useEffect(() => {
    typerRef.current && typerRef.current.reset()
    if (visible) {
      setStatusText(STATUS_TEXT[getState()] || '')
      setMuted(false)
      // speaking 也要同步：上次关闭时若正播报，残留 true 会让新一轮通话
      // 一打开就显示打断按钮（实际没在播报）
      setSpeaking(getState() === 'speaking')
      setLiveText('')
      setAgentText('')
      setAgentThinking(false)
      setVoiceBars(buildBars(0, hueShiftRef.current))
    }
  }, [visible])

  function onMuteTap() {
    toggleMute() // state 事件回写 muted 态
  }

  function onInterruptTap() {
    interrupt() // 播报期打断：发 RequestToSpeak + 本地立即静默
  }

  if (!visible) return null

  return (
    <View className='vc-mask'>
      {/* 中央声波条：15 根圆头竖条，静息排成圆形，随音量起伏 */}
      <View className='vc-wave'>
        {voiceBars.map((bar, i) => (
          <View
            key={i}
            className='vc-wave-bar'
            style={`height: ${bar.h}rpx; background: linear-gradient(180deg, ${bar.c1}, ${bar.c2});`}
          />
        ))}
      </View>

      {/* 通道实时转写（用户说话中间态，紧贴柱下方） */}
      {liveText ? <View className='vc-live-text'>{liveText}</View> : null}

      {/* AI 回复流式大字：柱下方打字机逐字上屏，超出滑动查看。
          思考话术后接呼吸省略号（agentThinking） */}
      {agentText ? (
        <ScrollView className='vc-agent-text' scrollY scrollIntoView={agentAnchorId} scrollWithAnimation>
          <View className='vc-agent-inner'>
            <View className='vc-agent-text-content'>
              {agentText}
              {agentThinking ? <Text className='vc-ellipsis'>…</Text> : null}
            </View>
            <View id={agentAnchorId} />
          </View>
        </ScrollView>
      ) : null}

      {/* 状态提示：三点动画 + 文案 */}
      <View className='vc-status'>
        <View className='vc-dots'>
          <View className='vc-dot' />
          <View className='vc-dot' />
          <View className='vc-dot' />
        </View>
        <Text className='vc-status-text'>{statusText}</Text>
      </View>

      {/* 底部操作：静音 + 打断 + 挂断。
          打断按钮常驻（不播报时置灰）：可见性若依赖 speaking 状态，一旦事件丢失
          按钮就整个消失，用户以为功能不存在——常驻+置灰更可靠 */}
      <View className='vc-actions'>
        <View
          className={`vc-btn ${muted ? 'vc-btn-muted' : ''}`}
          onClick={onMuteTap}
        >
          <Text className='adwicon vc-btn-icon adwicon-microphone'>{''}</Text>
        </View>
        <View
          className={`vc-btn vc-btn-interrupt ${speaking ? '' : 'vc-btn-interrupt-off'}`}
          onClick={onInterruptTap}
        >
          <Text className='adwicon vc-btn-icon adwicon-warning'>{''}</Text>
        </View>
        <View className='vc-btn' onClick={onHangup}>
          <Text className='adwicon vc-btn-icon vc-icon-hangup adwicon-xmark'>{''}</Text>
        </View>
      </View>

      <View className='vc-safe-bottom' />
    </View>
  )
}
