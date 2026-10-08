import { View, Text, ScrollView, Image } from '@tarojs/components'
import { useState, useRef, useEffect } from 'react'
import Taro, { useDidHide, useDidShow, useShareAppMessage, useShareTimeline, useRouter } from '@tarojs/taro'
import TopNav from '../../components/top-nav'
import InputBar, { type InputBarRef } from '../../components/input-bar'
import ChatBubbleUser from '../../components/chat-bubble-user'
import ChatBubbleAi, { type ThinkingStep, type Suggestion } from '../../components/chat-bubble-ai'
import PlanCard from '../../components/plan-card'
import ProductCard from '../../components/product-card'
import MerchantCard from '../../components/merchant-card'
import MarkdownView from '../../components/markdown-view'
import ConversationDrawer, { type ConversationDrawerRef } from '../../components/conversation-drawer'
import SlotsDrawer, { type SlotsDrawerRef } from '../../components/slots-drawer'
import ActivityCarousel from '../../components/activity-carousel'
import { useAuth } from '../../store/auth-context'
import { get, post, put, patch, del } from '../../services/request'
import { streamChat, type StreamTask } from '../../services/stream'
import { onSharedInviter } from '../../services/invite'
import { TT_NAV_CUSTOM_APPROVED } from '../../services/config'
import { uploadImage, resolveProductCover } from '../../utils/upload'
import ProductPicker, { type PickerProduct } from '../../components/product-picker'
import VoiceCall from '../../components/voice-call'
import * as voiceSession from '../../utils/voice-session'
import { makePhoneCallSafe } from '../../utils/cross-platform'
import { resolveImageUrl } from '../../utils/upload'
import * as logger from '../../utils/logger'
import './index.scss'

// 商家卡片数据：photo 绝对化（http 开头原样，/uploads/... 拼 origin）。
// 多位置（卡片/详情/中心）共用同一 URL 命中 HTTP 缓存
function normalizeMerchants(merchants: any[] | null) {
  if (!merchants) return null
  return merchants.map((m) => (m && m.photo) ? Object.assign({}, m, { photo: resolveImageUrl(m.photo) }) : m)
}

// 槽位名 → 中文标签映射，用于 follow_up pills 展示
// ponytail: 升级为后端下发 followUpOptions 时删除此 map
const SLOT_LABELS: Record<string, string> = {
  material: '材质',
  region: '城市',
  budget: '预算',
  area: '面积',
  windowType: '窗型',
  count: '数量'
}

// ponytail: 快捷按钮引导语，每个 mode 多套随机选一条
// 设计：半开放式，明确触发对应 intent，但不锁死话题，用户可追问改方向
const GUIDE_TEXTS: Record<string, string[]> = {
  knowledge: [
    '我想了解门窗选购的相关知识',
    '断桥铝和系统窗有什么区别？',
    '门窗安装有哪些常见的坑要避开？',
    '门窗的隔热隔音性能怎么看？'
  ],
  purchase: [
    '我想定制门窗，帮我出个方案',
    '我家要换窗户，帮我规划一下配置',
    '帮我推荐一套适合家用的门窗方案',
    '我想给新房选门窗，应该怎么搭配？'
  ],
  merchant: [
    '帮我推荐门窗商家',
    '附近有没有靠谱的门窗安装商家？',
    '我想找本地的门窗定制商家',
    '帮我匹配几家能承接安装的门窗店'
  ]
}

// ponytail: 固定提示句剥离模式——done 时从 text 剥离，单独渲染醒目提示条（需浅色醒目样式）
// 与后端固定常量一一对应（NEEDS_REMINDER / plan_generator 引导句），LLM 不会生成这些句，不会误伤正文
const TIP_PATTERNS: { key: 'needsTip' | 'planTip' | 'merchantTip'; tip?: string; re: RegExp }[] = [
  // 需求提示（浅琥珀）：product_match / product_intro 的产品匹配引导。
  // tip 固定话术（保留 💡）：兼容剥离旧后端输出，提示条统一显示
  { key: 'needsTip', tip: '💡 产品是根据您的需求匹配的，您可以点击左下角的需求按钮查看当前已记录的需求，便于确认或调整。', re: /💡?\s*产品是根据您的需求匹配的，您可以点击左下角的需求按钮查看当前已记录的需求，便于确认或调整。?/ },
  // 方案引导（绿色）：plan_generator 生产方案后的引导文案
  { key: 'planTip', re: /点击方案卡片即可查看方案详情。如需调整方案，可在方案详情页中编辑，也可以说『方案1的玻璃换成Low-E玻璃』或补充面积\/开启方式，我会自动更新。?/ },
  // 商家评价返现提示（紫色）：merchant_match 推荐文案尾部固定句。
  // tip 固定新话术：兼容剥离旧后端（未重启）输出的旧文案，紫条统一显示新句
  { key: 'merchantTip', tip: '与商家达成合作后，至平台上传对商家的评价，可获单笔补贴数百元至数千元，大额订单上不封顶。', re: /⭐?\s*(若与商家达成合作，可至平台上传对商家的评价，可获至高\s*5000\s*元返现|与商家达成合作后，至平台上传对商家的评价，可获单笔补贴数百元至数千元，大额订单上不封顶)。?/ }
]

// 活动占位符剥离：{{activity:id}} → 从显示文本移除 + 收集 id（保序去重）
// 尾部半截占位符（流式跨 chunk）同样隐藏，避免 {{activ 闪现。
// 与原生端 chat.js _stripActivityRefs 同实现
const ACTIVITY_RE = /\{\{activity:([A-Za-z0-9]+)\}\}/g
const ACTIVITY_PARTIAL_RE = /\{\{[^}]*$/

function stripActivityRefs(text: string): { text: string; ids: string[] } {
  const ids: string[] = []
  const stripped = String(text || '')
    .replace(ACTIVITY_RE, (_m: string, id: string) => {
      if (ids.indexOf(id) < 0) ids.push(id)
      return ''
    })
    .replace(ACTIVITY_PARTIAL_RE, '')
  return { text: stripped, ids }
}

interface PlanItem {
  id: string
  title?: string
  status?: string
  windowCount?: number
  totalEstimate?: string
  estimatedPrice?: string
  material?: string
  area?: string
  [key: string]: any
}

interface ProductItem {
  id: string
  name?: string
  series?: string
  budget?: string
  material?: string
  price_range?: string
  intro?: string
  concerns?: string[]
  room_types?: string[]
  opening_types?: string[]
  glass_options?: string[]
  selected?: boolean
  [key: string]: any
}

interface MerchantItem {
  id: string
  name?: string
  rating?: number
  matchReason?: string
  region?: string
  phone?: string
  tags?: string[]
  warranty_years?: number
  installer_type?: string
  years?: number
  [key: string]: any
}

interface FollowUpPill {
  slot: string
  label: string
}

interface Message {
  role: 'user' | 'ai'
  text: string
  contentType?: string
  messageId?: string
  loading?: boolean
  streaming?: boolean
  thinking?: ThinkingStep[]
  thinkingCollapsed?: boolean
  // ponytail: 用户消息的产品咨询卡片（从 product-detail「产品咨询」跳转注入）
  productRef?: ProductItem | null
  // 固定提示句剥离结果（done 时计算）：需求提示 / 方案引导 / 商家返现
  needsTip?: string
  planTip?: string
  merchantTip?: string
  plans?: PlanItem[] | null
  merchants?: MerchantItem[] | null
  products?: ProductItem[] | null
  selectedProductIds?: string[] | null
  missingSlots?: string[]
  followUpPills?: FollowUpPill[]
  // 后端 reasoner 从 draft 提取的可采纳建议，透传给 chat-bubble-ai 渲染勾选按钮
  // ponytail: 建议类 intent 才有值，其他 contentType（plans/merchants/products）一般为空；
  //           用 [] 兜底而非 null，避免组件渲染空判断
  suggestions?: Suggestion[]
  // ponytail: followUps 由 done 后异步 follow_ups 事件推送，done 时恒为 []（与 suggestions 对称）
  followUps?: string[]
  // 本消息的建议勾选态快照（按 suggestion.id → bool），由本页管理 + 下发
  checkedMap?: Record<string, boolean>
  // ─── 拍照看效果消息恢复字段（后端 _merge_preview_messages 实时下发状态） ───
  // 用户窗图（user 消息）/ 任务状态 / 结果图 URL / 产品名 / 生图任务 id
  image?: string
  status?: string
  resultImage?: string
  productName?: string
  taskId?: string
  // 活动轮播卡片 id 列表（文本占位符剥离时收集，渲染 ActivityCarousel）
  activityIds?: string[]
}

// 建议勾选态：{ messageId: { suggestionId: true } }
type SuggestionChecks = Record<string, Record<string, boolean>>

export default function ChatPage() {
  const { isLoggedIn, getUserId } = useAuth()
  const router = useRouter()
  const [hasStarted, setHasStarted] = useState(false)
  const [drawerVisible, setDrawerVisible] = useState(false)
  const [slotsDrawerVisible, setSlotsDrawerVisible] = useState(false)
  const [scrollIntoView, setScrollIntoView] = useState('')
  const [messages, setMessages] = useState<Message[]>([])
  const [conversationId, setConversationId] = useState('')
  const [sending, setSending] = useState(false)
  // 分享卡片：接收者打开分享链接（cid+mid）时展示分享者转发的那条 AI 回复，可关闭
  const [shareCard, setShareCard] = useState<string | null>(null)

  // ─── 活动轮播抽屉 ───
  const [drawerExpanded, setDrawerExpanded] = useState(true)
  // 乐观初始：先展示抽屉，保证 swiper 在有高度容器里初始化；无活动时 ready 事件后收起
  const [hasActivities, setHasActivities] = useState(true)
  // 首页轮播实际渲染模式，由组件 onModeChange 更新；先按 card（较高）乐观展示防裁切
  const [activityCardMode, setActivityCardMode] = useState<'card' | 'banner'>('card')

  // ponytail: chat-bubble-ai 的分享按钮 open-type="share" 需页面级配置。
  // 分享按钮带 data-message-id，微信端此回调的 res.target.dataset.messageId 携带本条消息 id →
  // 精确分享单条 AI 回复（cid+mid），右上角菜单转发（无 target）或消息未完成（无 messageId）→ 默认小程序卡片。
  // 所有分享 path 统一带 inviter（openid 来自 JWT，服务端可校验）：好友打开分享链接
  // （不论新老用户）即计入分享者当日加成（invite_bonus）
  useShareAppMessage((res: any) => {
    const ds = (res && res.target && res.target.dataset) || {}
    const mid = ds.messageId || ''
    const cid = cidRef.current
    const inv = getUserId() ? `inviter=${encodeURIComponent(getUserId())}` : ''
    if (!mid || !cid) {
      return {
        title: '门窗 AI 导购助手 - 问我任何门窗问题',
        path: `/pages/chat/index${inv ? '?' + inv : ''}`
      }
    }
    // 从本地消息列表取该条 text 做标题摘要（去 markdown 符号，取前 24 字）
    const msg = messagesRef.current.find((m) => m.messageId === mid)
    const summary = ((msg && msg.text) || '').replace(/[#*`\n\r]/g, ' ').trim().slice(0, 24)
    // title 随埋点上报，存 target_name 供管理端时间线展示
    post('/shares/log', { conversation_id: cid, message_id: mid, title: summary }).catch(() => {})
    return {
      title: summary || '来自好友分享的门窗咨询',
      path: `/pages/chat/index?cid=${cid}&mid=${mid}${inv ? '&' + inv : ''}`
    }
  })

  // 朋友圈分享：query 同样带 inviter（好友从朋友圈点开落回本页，router.params.inviter
  // 走与转发相同的接收端归因链路），否则朋友圈打开不计入
  useShareTimeline(() => {
    const oid = getUserId()
    return {
      title: '门窗 AI 导购助手 - 问我任何门窗问题',
      query: oid ? `inviter=${encodeURIComponent(oid)}` : ''
    }
  })

  // ponytail: 这些是跨渲染的命令式状态，React 下用 ref 持有
  const streamTaskRef = useRef<StreamTask | null>(null)
  const draftTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const pendingDraftRef = useRef('')
  const abortedRef = useRef(false)  // 用户主动中止标志，防止 request fail 回调覆盖「（已停止）」
  const messagesRef = useRef<Message[]>([])
  const cidRef = useRef('')
  const drawerRef = useRef<ConversationDrawerRef>(null)
  const slotsDrawerRef = useRef<SlotsDrawerRef>(null)
  // 建议勾选态：累积在本页实例内，不持久化（用户直接关闭=放弃勾选，类似未发送草稿）；
  // 切换会话时清空，避免串台；发送消息时取所有 messageId 的勾选项汇总成 accepted_suggestions 提交
  const suggestionChecksRef = useRef<SuggestionChecks>({})
  // ponytail: 已提交的勾选建议 id 集合（`msgId:sid`），避免重复提交；勾选态保留视觉但不再提交
  const submittedChecksRef = useRef<Record<string, boolean>>({})
  // ponytail: 发送时间窗口限流——10 秒内最多 3 条，防快速切换会话+发消息绕过 sending 标志刷 token
  const sendTimestampsRef = useRef<number[]>([])
  // ponytail: 本轮有新输入才触发画像总结（替代旧 5min 防抖，详见 flushProfileSummary）
  const hasNewInputRef = useRef(false)
  // ponytail: 产品选中防抖同步——1s 内连续点击只发一次请求；flush 时机见 _flushProductSync
  const productSyncTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const productSyncMsgIdxRef = useRef<number | null>(null)
  // ponytail: 用户触摸滚动区后暂停自动滚动（_userScrolling=true）
  const userScrollingRef = useRef(false)
  // 产品咨询入口：从 product-detail 页「产品咨询」按钮跳转来
  // ponytail: Taro 无 globalData/eventChannel，用 storage 'consult_product_data' 中转，一次性读取后清空
  const consultProductRef = useRef<ProductItem | null>(null)
  // ─── 拍照看效果：待发窗图 {path(本地临时/CDN), url(上传后 CDN)} + 目标产品 ───
  const previewImageRef = useRef<{ path: string; url: string } | null>(null)
  const previewProductRef = useRef<PickerProduct | null>(null)
  // ponytail: 生图任务轮询定时器（3s 间隔，5min 超时）；会话切换/组件卸载时停止
  const previewTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  // 轮询世代号：clearTimeout 拦不住在飞请求的回调——回调在页面隐藏后到达仍会排新定时器
  //（旧链复活 + 恢复时双轮询）。停止/开新链时递增，失效链的 tick 与回调直接自灭
  const previewPollGenRef = useRef(0)
  // 重试防抖锁：sending 要等 POST 返回才置 true，飞行中连点会双发 /retry 双扣额度
  const previewRetryBusyRef = useRef(false)
  // 生图二次编辑态：编辑按钮把结果图入输入栏时标记来源任务，发送走 /preview/{id}/edit
  const editingTaskIdRef = useRef('')
  // 产品选择弹窗 state + 输入栏 ref（程序化填充提示词）
  const inputBarRef = useRef<InputBarRef>(null)
  const [pendingImage, setPendingImage] = useState<{ path: string; uploading?: boolean; fail?: boolean } | null>(null)
  const [pickerVisible, setPickerVisible] = useState(false)
  const [pickerProducts, setPickerProducts] = useState<PickerProduct[]>([])
  const [selectedProductId, setSelectedProductId] = useState('')
  // 语音通话全屏层开关（通话组件自订阅 voice-session，页面只管开关与文字入流）
  const [voiceCallVisible, setVoiceCallVisible] = useState(false)
  // 语音轮次气泡索引跟踪（-1=待开新气泡）：usertext 中间态更新同一用户气泡，
  // final 后下一条开新气泡；agenttext 流式替换同一 AI 气泡
  const voiceUserIdxRef = useRef(-1)
  const voiceAiIdxRef = useRef(-1)
  // ponytail: 活动占位符剥离——原始文本（未剥离 {{activity:id}}）累积在此，
  // 显示文本每次 flush 从全量 raw 重新剥离（占位符可能跨 chunk 断开）
  const streamRawRef = useRef('')
  // 流式阶段收集到的活动 id（done 时 finalize 兜底用）
  const streamActivityIdsRef = useRef<string[]>([])
  // 活动抽屉手势起点（onDrawerTouchStart/Move/End）
  const drawerTouchRef = useRef<{ x: number; y: number; moved: boolean } | null>(null)

  // 同步 ref：回调里读最新值，避免闭包陈旧
  useEffect(() => { messagesRef.current = messages }, [messages])
  useEffect(() => { cidRef.current = conversationId }, [conversationId])

  // ponytail: 不再预创建空会话——首次发消息时才调后端创建，避免每次打开应用堆积空对话
  // 预拉后端结构化画像（换设备登录时本地 storage 可能为空）
  useEffect(() => {
    setConversationId('')
    const userId = getUserId()
    if (!userId) return
    const local = Taro.getStorageSync('user_profile') || {}
    if (Object.keys(local).length > 0) return
    get('/user/profile')
      .then((res: any) => {
        const profile = (res && res.profile) || {}
        if (Object.keys(profile).length > 0) {
          Taro.setStorageSync('user_profile', profile)
        }
      })
      .catch(() => {
        logger.error('load_profile', { page: 'chat' })
      })

    // 产品咨询入口：?consult=1 时读取 product-detail 写入的产品对象，跳过空状态等用户输入
    // ponytail: 仅首次 sendMessage 时注入到用户消息 + 后端请求，之后清空
    if (router.params.consult === '1') {
      const p = Taro.getStorageSync('consult_product_data')
      if (p) {
        consultProductRef.current = p
        Taro.removeStorageSync('consult_product_data')
        setHasStarted(true)
      }
    }

    // 分享卡片接收：path 带 cid+mid（分享者的会话/消息 id，非本人会话，不设为 conversationId）
    // 免登录拉取该条内容，弹层展示，用户关闭后正常用页面
    const sharedCid = router.params.cid
    const sharedMid = router.params.mid
    if (sharedCid && sharedMid) {
      get('/shares/view', { cid: sharedCid, mid: sharedMid })
        .then((res: any) => {
          const text = (res && res.text) || ''
          if (text) setShareCard(text)
        })
        .catch((err: any) => {
          Taro.showToast({ title: (err && err.message) || '分享内容加载失败', icon: 'none', duration: 2000 })
        })
      // 邀请归因：未登录用户经分享进入，暂存来源会话 cid（带时间戳，7 天内有效），
      // 注册登录时随请求带给后端反查邀请人
      if (!getUserId()) {
        Taro.setStorageSync('adw_invite_cid', { cid: sharedCid, ts: Date.now() })
      }
    }
    // 邀请归因（显式）：分享/转发 path 带 inviter=openid 的兜底来源，
    // 无条件暂存（老用户打开也计入加成），已登录立即上报，未登录等登录后上报
    onSharedInviter(router.params.inviter || '', isLoggedIn)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // 触发后端画像摘要（会话结束触发）
  // ponytail: 两层闸门——hasNewInputRef（本轮有新输入）+ 后端 turn_count 闸门
  // hasNewInputRef 替代了旧的5min防抖：发过请求后置 false，下次自动拦住，不需要防抖。
  // 旧防抖反而有害：onHide 防抖内 return → 画像不及时写入 → 用户切到 profile 页看到旧画像。
  // 写入成功后标记 profile_dirty，让 profile 页 useDidShow 时知道需要刷新缓存。
  function flushProfileSummary() {
    const cid = cidRef.current
    const userId = getUserId()
    if (!cid || !userId) return
    // 本轮无新输入（用户只打开会话看了看没发消息）→ 不发请求
    if (!hasNewInputRef.current) return
    // 标记已提交——hasNewInputRef=false 后不会再发，不需要防抖
    // 失败不恢复：网络失败概率低，用户下次发新消息会重新置位触发总结
    hasNewInputRef.current = false
    // 不阻塞页面退出，失败静默
    post('/user/profile/summarize', { conversation_id: cid })
      .then(() => {
        // 画像已变更，标记 profile 页需要刷新缓存
        Taro.setStorageSync('profile_dirty', true)
      })
      .catch(() => {
        // 静默失败：网络异常/会话状态不存在等，下次发新消息会重新触发
      })
  }

  // 发消息前 flush 产品选中状态——确保后端拿到最新 selected_products 再生成方案
  function flushProductSync() {
    if (!productSyncTimerRef.current) return
    clearTimeout(productSyncTimerRef.current)
    productSyncTimerRef.current = null
    syncSelectedProducts()
  }

  // 页面隐藏/销毁触发画像摘要 + 产品选中 flush（用户切走但页面未销毁）
  useDidHide(() => {
    flushProductSync()
    flushProfileSummary()
    logger.flush()
    // 生图轮询定时器随页面隐藏回收（定时器全局，不随页面销毁；任务在后端继续跑，
    // useDidShow 切回时经 resumePendingPreview 恢复）——合规"及时回收定时器"
    stopPreviewPolling()
    // 通话中切后台：直接挂断（后台录音被系统挂起，续上状态不可靠，简单收敛）
    if (voiceSession.getState() !== 'idle') {
      voiceSession.stop()
      setVoiceCallVisible(false)
    }
  })
  useEffect(() => {
    return () => {
      // onUnload 等价：组件卸载
      abortStream()
      if (draftTimerRef.current) {
        clearTimeout(draftTimerRef.current)
        draftTimerRef.current = null
      }
      // 生图轮询定时器回收：卸载后回调不得再执行
      stopPreviewPolling()
      flushProductSync()
      flushProfileSummary()
      logger.flush()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  function requireLogin(): boolean {
    if (!isLoggedIn) {
      Taro.showModal({
        title: '需要登录',
        content: '登录并授权手机号后才能继续使用对话、方案等功能',
        confirmText: '去登录',
        showCancel: true,
        success: (res) => {
          if (res.confirm) {
            Taro.navigateTo({ url: '/pages/profile/index' })
          }
        }
      })
      return false
    }
    return true
  }

  // 空状态大 logo 点击 → 产品中心（与抽屉「产品中心」入口同一目标页）
  function goProducts() {
    Taro.navigateTo({ url: '/pages/products/index' })
  }

  // ponytail: 三个快捷按钮点击即发送引导语，每个 mode 多套随机选一条
  function startChat(mode: string) {
    if (!requireLogin()) return
    const texts = GUIDE_TEXTS[mode] || GUIDE_TEXTS.knowledge
    // ponytail: 随机选一条，Math.random 够用（无需密码学随机）
    const guideText = texts[Math.floor(Math.random() * texts.length)]
    setHasStarted(true)
    // 复用 sendMessage 走完整对话链路（创建会话、流式输出、持久化）
    sendMessage(guideText)
  }

  // ─── 拍照看效果：选图 → 上传 → 选产品 → 提示词填充 → 发送生图 ───

  // 生图额度预检 → 开相机。超限弹提示不开相机（后端 limitMessage 成品文案原样展示）。
  // 实时查不缓存——后端是本地 SQLite count 查询，且避免"分享加成刚生效但缓存还是旧余量"的误判；
  // 查询失败/超时不拦（create_task 端点 100101 兜底）
  function onCameraTap() {
    if (!requireLogin()) return
    // ponytail: quota 预检走 request 封装（自动鉴权/错误处理）
    get('/preview/quota')
      .then((d: any) => {
        // 严格判 number：响应异常（缺字段/旧版）时放行，由 create_task 的 100101 兜底，
        // 不能因解析不出余量就把用户挡在相机外（宁漏拦不误拦）
        if (d && typeof d.remaining === 'number' && d.remaining <= 0) {
          Taro.showModal({
            title: '今日生成次数已用完',
            content: (d && d.limitMessage) || '今天的生成次数已用完，明天再来生成吧～',
            showCancel: false,
            confirmText: '知道了'
          })
          return
        }
        openCamera()
      })
      .catch(() => openCamera())
  }

  function openCamera() {
    // 先本地展示（uploading 遮罩），上传成功后打开产品选择弹窗
    const onPicked = (filePath: string) => {
      previewImageRef.current = { path: filePath, url: '' }
      setPendingImage({ path: filePath, uploading: true })
      uploadImage(filePath, '', '/preview/upload').then((url) => {
        // 上传期间图已被移除 → 丢弃结果
        if (!previewImageRef.current || previewImageRef.current.path !== filePath) return
        previewImageRef.current.url = url
        setPendingImage({ path: filePath })
        setPickerVisible(true)
        buildPickerProducts()
      }).catch((err: any) => {
        if (!previewImageRef.current || previewImageRef.current.path !== filePath) return
        setPendingImage({ path: filePath, fail: true })
        Taro.showToast({ title: (err && err.message) || '上传失败，请重试', icon: 'none' })
      })
    }
    const failBack = () => {
      // chooseMedia 低版本/H5 不可用时降级 chooseImage（选图能力更老更全）
      Taro.chooseImage({
        count: 1,
        sizeType: ['compressed'],
        success: (res) => {
          const p = res.tempFilePaths && res.tempFilePaths[0]
          if (p) onPicked(p)
        }
      }).catch(() => {})
    }
    Taro.chooseMedia({
      count: 1,
      mediaType: ['image'],
      sourceType: ['camera', 'album'],
      sizeType: ['compressed'],
      success: (res) => {
        const file = res.tempFiles && res.tempFiles[0] as any
        if (file && file.tempFilePath) onPicked(file.tempFilePath)
      },
      fail: failBack
    } as any)
    // 注意：Taro 未 Promise 化 chooseMedia（返回 undefined），不能再链 .catch —— 回调已覆盖
  }

  // 产品选定：组装提示词注入输入框（用户可再编辑，发送时才开生图）
  function onPickerSelect(product: PickerProduct) {
    if (!product || !previewImageRef.current) return
    previewProductRef.current = product
    setPickerVisible(false)
    setSelectedProductId(product.id)
    // 价格不进提示词：对生图无语义贡献，数字文本反而可能被模型渲染成画面文字伪影
    // 结构保持是本功能核心：明确"除窗户外全部保持原图"——任何"呈现xx状态"类描述
    // （如精装修完成状态）都会触发模型重新装修房间/整图重渲染
    const prompt = `把照片里的窗户换成「${product.name}」。`
      + '除窗户本身外，画面其余部分必须与原图完全一致：'
      + '保持房间布局、墙面地板、家具陈设、窗外景物、光照与拍摄视角不变，'
      + '仅替换窗户区域为该产品样式，不改变、不添加、不删除任何其他内容。'
    if (inputBarRef.current) inputBarRef.current.setText(prompt)
    logger.log('preview_pick', { productId: product.id })
  }

  function onPickerClose() {
    // 未选产品关弹窗 = 取消本次拍照看效果（清图清态）。
    // 不保留图片：留了也没有重新打开弹窗的入口，用户发消息会掉进 LLM 链路丢图。
    clearPreviewState()
  }

  // 弹窗内「去产品中心」：关弹窗但保留待发图（回来后发送时护栏会重开弹窗引导选品）
  function onPickerGoProducts() {
    setPickerVisible(false)
    Taro.navigateTo({ url: '/pages/products/index' })
  }

  // ─── 语音通话：入口 → 全屏通话层 → 文字实时入对话流 ───

  // 闭包读最新值（事件回调在 voice-session 单例里，state 捕获会陈旧）
  const voiceCallVisibleRef = useRef(false)
  useEffect(() => { voiceCallVisibleRef.current = voiceCallVisible }, [voiceCallVisible])

  // 每日对话轮数超限提示框（语音 bind 预检 4290 / 语音轮播完 limit 事件共用）。
  // msg 为后端下发的成品文案（按加成状态两档），前端原样展示；无 msg 兜底旧文案
  function showLimitModal(msg?: string) {
    Taro.showModal({
      title: '今日对话已达上限',
      content: msg || '今天聊的太多了，休息下，明天再来聊吧。把小程序分享给好友，好友打开你的分享链接，每天可多聊 20 轮、多生成 2 张效果图哦～（点 AI 回复下方的分享按钮转发即可）',
      showCancel: false,
      confirmText: '知道了'
    })
  }

  // 通话中每轮 AI 回复结束 / 挂断时：拉服务端权威消息全量替换 live 纯文本气泡。
  // 语音轮的卡片（products/plans/merchants/followUpPills）与 markdown 强调原文
  // 都已由 response_builder 落 ui_messages（与文本链路同一结构），替换后渲染一致。
  function refreshVoiceMessages() {
    const cid = cidRef.current
    if (!cid) return
    // 消息接口不返回 updatedAt，回写缓存用 convs_meta 本地值——先推进保持自洽，
    // 否则下次进会话命中旧缓存卡片丢失（drawer 下次拉列表用服务端真实时间覆盖）
    const convsMeta = Taro.getStorageSync('convs_meta') || {}
    convsMeta[cid] = Date.now()
    Taro.setStorageSync('convs_meta', convsMeta)
    loadMessages(cid)
  }

  // voice-session 文字/错误事件 → 对话流（挂载订阅一次，卸载 off + 停止会话）
  useEffect(() => {
    // ASR 识别文本：中间态实时更新同一气泡，final 后下一条开新气泡
    const onVoiceUser = (d: any) => {
      if (!d || !d.text) return
      setMessages((prev) => {
        const msgs = prev.slice()
        const idx = voiceUserIdxRef.current
        if (idx >= 0 && msgs[idx] && msgs[idx].role === 'user') {
          msgs[idx] = { ...msgs[idx], text: d.text }
        } else {
          msgs.push({ role: 'user', text: d.text })
          voiceUserIdxRef.current = msgs.length - 1
        }
        return msgs
      })
      setHasStarted(true)
      if (d.final) voiceUserIdxRef.current = -1
      scrollToBottom()
    }
    // Agent 回复文本：流式替换同一 AI 气泡，final 解除 streaming。
    // 套件 dialog 文本默认全量下发（incremental_response=false），中间态替换不拼接，
    // 拼接会导致文本按 1+2+3… 重复膨胀；打断收尾空文本只解除 streaming 不清内容
    const onVoiceAgent = (d: any) => {
      if (!d) return
      setMessages((prev) => {
        const msgs = prev.slice()
        const idx = voiceAiIdxRef.current
        if (idx >= 0 && msgs[idx] && msgs[idx].role === 'ai') {
          const patch: any = {}
          if (d.text) patch.text = d.text
          if (d.final) patch.streaming = false
          msgs[idx] = { ...msgs[idx], ...patch }
        } else {
          msgs.push({
            role: 'ai', text: d.text || '', contentType: 'text', messageId: '',
            loading: false, streaming: !d.final, thinking: [], thinkingCollapsed: false,
            suggestions: [], followUps: [], checkedMap: {}
          })
          voiceAiIdxRef.current = msgs.length - 1
        }
        return msgs
      })
      setHasStarted(true)
      if (d.final) {
        voiceAiIdxRef.current = -1
        // 本轮 AI 回复完（final 且有文本）：response_builder 落库先于 agenttext final，
        // 此时服务端 ui_messages 已含本轮——拉权威消息同步卡片/强调渲染。
        // 打断收尾的空文本 final 不拉（被打断轮未落库，保留 live 半句，挂断兜底自愈）
        if (d.text) refreshVoiceMessages()
      }
      scrollToBottom()
    }
    // bind 失败/录音失败（授权拒绝、机型不支持）：自动收通话层并提示（session 已自行复位）
    const onVoiceError = (msg: any) => {
      if (!voiceCallVisibleRef.current) return
      setVoiceCallVisible(false)
      const s = typeof msg === 'string' ? msg : ''
      if (s.indexOf('auth') >= 0) {
        // 授权拒绝单独引导去设置——小程序拒绝一次后不再弹授权框，无引导则永远失败
        Taro.showModal({
          title: '需要麦克风权限',
          content: '开启麦克风权限后即可语音通话',
          confirmText: '去设置',
          success: (r) => {
            if (r.confirm && (Taro.openSetting as any)) Taro.openSetting().catch(() => {})
          }
        })
      } else if (s.indexOf('今天聊的太多') >= 0) {
        // bind 预检拒绝（4290）：error 事件只透传 message 字符串，按文案共同前缀判定。
        // 弹提示框而非 toast，文案用后端下发的成品（加成状态两档）
        showLimitModal(s)
      } else {
        // === 临时调试：错误来源（bind 失败/录音失败/服务端中断）在 voice-session 已打日志，此处补页面侧兜底 ===
        try { console.error('[voice] page error:', s || msg) } catch (e) { /* 忽略 */ }
        Taro.showToast({ title: '语音通话接通失败', icon: 'none' })
      }
    }
    // 语音轮数超限：拒绝文案播完自动收起通话层（voice-session limit 事件）后弹提示框
    const onVoiceLimit = (msg: any) => {
      if (!voiceCallVisibleRef.current) return
      setVoiceCallVisible(false)
      showLimitModal(typeof msg === 'string' ? msg : '')
    }
    voiceSession.on('usertext', onVoiceUser)
    voiceSession.on('agenttext', onVoiceAgent)
    voiceSession.on('error', onVoiceError)
    voiceSession.on('limit', onVoiceLimit)
    return () => {
      voiceSession.off('usertext', onVoiceUser)
      voiceSession.off('agenttext', onVoiceAgent)
      voiceSession.off('error', onVoiceError)
      voiceSession.off('limit', onVoiceLimit)
      voiceSession.stop()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // 语音通话入口：直接拨打（当前无会话）先建一个新对话——通话内容落在可见会话里
  function onVoiceTap() {
    if (!requireLogin()) return
    if (voiceCallVisibleRef.current) return
    // 语音轮次气泡索引复位（每通电话从新气泡开始）
    voiceUserIdxRef.current = -1
    voiceAiIdxRef.current = -1
    // 通话是全新交互上下文：恢复自动滚动（触摸暂停态若带入，通话文字不会滚到底部）
    userScrollingRef.current = false
    // 同步置 ref（state 渲染提交前的窗口期内 bind 若极速失败，onVoiceError 仍能正确收层）
    voiceCallVisibleRef.current = true
    setVoiceCallVisible(true)
    // 语音轮次写进同一会话，挂断后/重进仍连续可见
    const launchVoice = (cid: string) => {
      cidRef.current = cid
      setConversationId(cid)
      setHasStarted(true)
      voiceSession.start({ conversationId: cid })
    }
    const existingCid = cidRef.current
    if (existingCid) {
      launchVoice(existingCid)
      return
    }
    post('/conversations', { title: '语音通话' })
      .then((res: any) => {
        const cid = (res && res.id) || ('local-' + Date.now())
        Taro.setStorageSync('convs_dirty', true)
        launchVoice(cid)
      })
      .catch(() => launchVoice('local-' + Date.now()))
  }

  // 挂断（通话组件 hangup 事件）：关全屏层 + 释放录音；拉服务端权威消息兜底自愈
  // （打断轮等未同步的内容）
  function onVoiceHangup() {
    voiceSession.stop()
    setVoiceCallVisible(false)
    refreshVoiceMessages()
  }

  // 组装产品选择列表：当前对话推荐过的产品优先（去重保序，最多 5 款），
  // 不足 5 款从产品库匹配补足（类目/材质与已推荐产品相近者优先）。
  // tag 角标区分来源：对话推荐 = 本轮对话推荐过；为你匹配 = 产品库按需求匹配补足
  function buildPickerProducts() {
    const seen: Record<string, boolean> = {}
    const rec: PickerProduct[] = []
    for (const m of messagesRef.current) {
      if (!m.products) continue
      for (const p of m.products) {
        if (p && p.id && !seen[p.id]) {
          seen[p.id] = true
          rec.push({
            id: p.id,
            name: p.name || '',
            price_range: (p as any).price_range || (p as any).priceRange || '',
            category: p.category || '',
            material: p.material || '',
            tag: '对话推荐',
            coverImage: p.coverUrl || resolveProductCover(p.images || [])
          })
        }
        if (rec.length >= 5) break
      }
      if (rec.length >= 5) break
    }
    const need = 5 - rec.length
    if (need <= 0) {
      setPickerProducts(rec)
      return
    }
    // 不足 5 款 → 产品库补足（综合序 + 类目/材质相近加权）
    get('/products', { page: 1, page_size: 30 }).then((data: any) => {
      // 弹窗已关闭（用户取消）→ 不再回填
      const items = (data && data.items) || []
      const refCat = rec.length ? rec[0].category : ''
      const refMat = rec.length ? rec[0].material : ''
      const score = (p: any) => (refCat && p.category === refCat ? 2 : 0) + (refMat && p.material === refMat ? 1 : 0)
      const fill = items
        .filter((p: any) => p && p.id && !seen[p.id])
        .sort((a: any, b: any) => score(b) - score(a))
        .slice(0, need)
        .map((p: any) => ({
          id: p.id,
          name: p.name || '',
          price_range: p.price_range || '',
          category: p.category || '',
          material: p.material || '',
          tag: '为你匹配',
          coverImage: resolveProductCover(p.images || [])
        }))
      setPickerProducts(rec.concat(fill))
    }).catch(() => {
      setPickerProducts(rec)
    })
  }

  // 移除待发送窗图（清空预览态，提示词保留由用户自行决定）
  function onRemoveImage() {
    editingTaskIdRef.current = ''   // 编辑拉起的底图被移除 → 退出编辑态，防误走编辑端点
    previewImageRef.current = null
    previewProductRef.current = null
    setPendingImage(null)
    setSelectedProductId('')
  }

  // 清空拍照看效果全部预览态（发送消费后 / 切换会话 / 重置会话）
  function clearPreviewState() {
    editingTaskIdRef.current = ''
    previewImageRef.current = null
    previewProductRef.current = null
    if (inputBarRef.current) inputBarRef.current.setText('')
    setPendingImage(null)
    setPickerVisible(false)
    setSelectedProductId('')
  }

  // 停止生图轮询（会话切换/重置/卸载时调用；任务在后端继续跑，切回可从历史恢复）
  function stopPreviewPolling() {
    previewPollGenRef.current++  // 失效在飞链：隐藏后到达的响应不得再排定时器
    if (previewTimerRef.current) {
      clearTimeout(previewTimerRef.current)
      previewTimerRef.current = null
    }
  }

  // 发送生图请求：用户消息带图 + AI 效果图占位 → POST /preview/render → 轮询任务状态
  function sendPreview(text: string) {
    const img = previewImageRef.current!
    const product = previewProductRef.current!
    const userMsg: Message = { role: 'user', text, image: img.path }
    const aiMsg: Message = {
      role: 'ai', contentType: 'preview_result', text: '正在生成效果图…',
      status: 'processing', resultImage: '', productName: product.name || '',
      taskId: '',  // render 成功后回填，轮询据此精确匹配占位消息
      loading: false, streaming: false,
      thinking: [], suggestions: [], followUps: [], checkedMap: {}
    }
    userScrollingRef.current = false
    const next = [...messagesRef.current, userMsg, aiMsg]
    setMessages(next)
    messagesRef.current = next
    setHasStarted(true)
    setSending(true)
    scrollToBottom()
    // 预览态消费即清（含 pendingImage/pickerVisible/输入框提示词）
    clearPreviewState()

    // 任务创建失败 → 撤回刚插入的两条消息 + toast 原因（额度/过期等，占位无 taskId 无操作入口）
    const fail = (msg: string) => {
      const msgs = messagesRef.current
      if (msgs.length >= 2 && msgs[msgs.length - 1].contentType === 'preview_result') {
        const remain = msgs.slice(0, -2)
        setMessages(remain)
        messagesRef.current = remain
      }
      setSending(false)
      Taro.showToast({ title: msg, icon: 'none' })
    }

    const doRender = (cid: string) => {
      post('/preview/render', {
        conversation_id: cid,
        product_id: product.id,
        image_url: img.url,
        prompt: text
      }).then((res: any) => {
        if (res && res.taskId) {
          patchMsgByTaskIdPlaceholder(res.taskId, cid)
          // 消息缓存失效：后端 merge 列表已含 preview 任务，旧缓存缺这两条消息
          Taro.removeStorageSync(`conv_messages_${cid}`)
          pollPreview(res.taskId, cid)
        } else {
          fail('生成任务创建失败，请稍后再试')
        }
      }).catch((err: any) => {
        fail((err && err.message) || '生成任务创建失败，请稍后再试')
      })
    }

    const cid = cidRef.current
    if (cid) {
      doRender(cid)
    } else {
      // 延迟创建会话（与 sendMessage 同口径）；标题区分拍照会话，列表中可辨识
      post('/conversations', { title: '拍照看效果' })
        .then((res: any) => {
          const newCid = (res && res.id) || ('local-' + Date.now())
          setConversationId(newCid)
          cidRef.current = newCid
          Taro.setStorageSync('convs_dirty', true)
          doRender(newCid)
        })
        .catch(() => fail('会话创建失败，请稍后再试'))
    }
  }

  // 把 taskId 回填到尾部占位 preview 消息（render 刚成功，占位必在尾部）
  function patchMsgByTaskIdPlaceholder(taskId: string, _cid: string) {
    const msgs = messagesRef.current
    for (let i = msgs.length - 1; i >= 0; i--) {
      const m = msgs[i]
      if (m.contentType === 'preview_result' && m.status === 'processing' && !m.taskId) {
        const next = msgs.slice()
        next[i] = { ...m, taskId }
        setMessages(next)
        messagesRef.current = next
        return
      }
    }
  }

  // 轮询效果图任务状态（3s 间隔，最长 5 分钟；结果已持久化，切会话/超时后切回仍可从历史恢复）
  // ponytail: 按 taskId 精确匹配占位消息——防"停止后连发两个 preview"时旧轮询写错新消息
  function pollPreview(taskId: string, cid: string) {
    const gen = ++previewPollGenRef.current  // 开新链：旧链（含在飞回调）一并失效
    if (previewTimerRef.current) {
      clearTimeout(previewTimerRef.current)
      previewTimerRef.current = null
    }
    const started = Date.now()
    const updateMsg = (taskIdKey: string, patch: Partial<Message>) => {
      const msgs = messagesRef.current
      for (let i = msgs.length - 1; i >= 0; i--) {
        const m = msgs[i]
        if (m.contentType === 'preview_result' && m.taskId === taskIdKey) {
          const next = msgs.slice()
          next[i] = { ...m, ...patch }
          setMessages(next)
          messagesRef.current = next
          return true
        }
      }
      return false
    }
    const tick = () => {
      if (gen !== previewPollGenRef.current) return  // 链已失效（隐藏/切会话/被新链取代）
      // 会话已切走 → 停止本页轮询（切回时后端 messages 合并返回最新状态）
      if (cidRef.current !== cid) return
      get(`/preview/${taskId}`).then((task: any) => {
        if (gen !== previewPollGenRef.current) return  // 在飞期间链失效：不得再排定时器
        if (task && task.status === 'done' && task.resultImage) {
          const hit = updateMsg(taskId, {
            status: 'done',
            resultImage: task.resultImage,
            text: '效果图已生成，图片仅保留 7 天，建议保存到手机。'
          })
          setSending(false)
          if (hit) {
            Taro.removeStorageSync(`conv_messages_${cid}`)  // 缓存失效：后端已合并 preview 消息，切回重拉
            Taro.showToast({ title: '生成完成，记得保存效果图', icon: 'none' })
            // 效果图持久化到用户目录（按 taskId 命名）：后端 7 天清理后历史会话仍可看
            persistPreviewImage(taskId, task.resultImage)
            scrollToBottom()
          }
          return
        }
        if (task && task.status === 'failed') {
          updateMsg(taskId, { status: 'failed', text: '效果图生成失败，请重新拍照再试一次。' })
          setSending(false)
          Taro.removeStorageSync(`conv_messages_${cid}`)
          return
        }
        if (Date.now() - started > 5 * 60 * 1000) {
          updateMsg(taskId, { status: 'failed', text: '生成超时，可稍后切回本会话查看结果。' })
          setSending(false)
          return
        }
        previewTimerRef.current = setTimeout(tick, 3000)
      }).catch(() => {
        if (gen !== previewPollGenRef.current) return  // 链已失效：不续期
        // 网络抖动：延长间隔继续轮询（任务在后端继续跑），同样受 5 分钟总时长约束；
        // 超限置 failed（保留 taskId 供重试/切回恢复），否则消息永远停在生成中
        if (Date.now() - started > 5 * 60 * 1000) {
          updateMsg(taskId, { status: 'failed', text: '网络不稳定，生成结果查询超时，请重试或稍后切回查看。' })
          setSending(false)
          return
        }
        previewTimerRef.current = setTimeout(tick, 5000)
      })
    }
    previewTimerRef.current = setTimeout(tick, 3000)
  }

  // 切回会话/重进小程序：恢复 processing 中的生图轮询（任务在后端继续跑，不因切走而断）。
  // 无需判断任务新鲜度：后端 _recover_stale_processing 保证 processing = 真在跑，
  // 轮询第一 tick 必得终态（done/failed），不会空转。
  function resumePendingPreview() {
    const cid = cidRef.current
    if (!cid) return
    for (let i = messagesRef.current.length - 1; i >= 0; i--) {
      const m = messagesRef.current[i]
      if (m.contentType === 'preview_result' && m.status === 'processing' && m.taskId) {
        setSending(true)
        pollPreview(m.taskId, cid)
        break  // 单飞行：sending 锁语义决定同时最多一个在飞，取最新一条即可
      }
    }
  }

  // 效果图失败/超时 → 一键重试（后端复用原图/产品/提示词重建新任务，历史失败记录保留）
  function onPreviewRetry(taskId: string) {
    // _retryBusy 同步置位：sending 要等 POST 返回才置 true，飞行中连点会双发
    // /retry → 双建任务双扣生图额度
    if (!taskId || sending || previewRetryBusyRef.current) return
    previewRetryBusyRef.current = true
    const cid = cidRef.current
    post(`/preview/${taskId}/retry`).then((res: any) => {
      previewRetryBusyRef.current = false
      const newId = res && res.taskId
      if (!newId) return
      const msgs = messagesRef.current
      for (let i = msgs.length - 1; i >= 0; i--) {
        const m = msgs[i]
        if (m.contentType === 'preview_result' && m.taskId === taskId) {
          const next = msgs.slice()
          next[i] = { ...m, taskId: newId, status: 'processing', text: '正在重新生成效果图，约需 1~2 分钟…' }
          setMessages(next)
          messagesRef.current = next
          break
        }
      }
      Taro.removeStorageSync(`conv_messages_${cid}`)  // 缓存失效：新任务已入库，切回重拉
      setSending(true)
      pollPreview(newId, cid)
    }).catch((err: any) => {
      previewRetryBusyRef.current = false
      Taro.showToast({ title: (err && err.message) || '重试失败，请稍后再试', icon: 'none' })
    })
  }

  // 效果图大图预览
  function onPreviewImageTap(url: string) {
    if (url) Taro.previewImage({ urls: [url] })
  }

  // ─── 效果图本地持久化（weapp/tt）：下载 → copyFile 到 USER_DATA_PATH。
  // saveFile 路径不可控，copyFile 按 taskId 固定命名，历史恢复时按名查找。
  // 失败静默保留 URL——在线时仍可看，仅过期后不可看。
  // ponytail: H5 无用户目录文件系统，跳过持久化/恢复（URL 过期即不可看，浏览器端可接受）
  function previewLocalPath(taskId: string) {
    return `${Taro.env.USER_DATA_PATH}/preview_${taskId}.jpg`
  }

  function persistPreviewImage(taskId: string, url: string) {
    if (process.env.TARO_ENV === 'h5') return
    if (!taskId || !url || url.indexOf('http') !== 0) return
    const fs = Taro.getFileSystemManager()
    const localPath = previewLocalPath(taskId)
    Taro.downloadFile({
      url,
      success: (res: any) => {
        if (res.statusCode !== 200) return
        fs.copyFile({
          srcPath: res.tempFilePath,
          destPath: localPath,
          success: () => trimPreviewLocalFiles(fs),
          fail: () => {}  // 磁盘满等：回落 URL 展示
        })
      },
      fail: () => {}
    })
  }

  // 本地持久化图 LRU 上限（40 张 ≈ 7 天 TTL 窗口满负荷 + 余量）：超限删最旧（mtime 排序），
  // 防用户目录（200MB 限额）被写满。失败静默——清理是尽力而为。
  // taskId 形如 pv-xxx，文件名 preview_pv-xxx.jpg，trim 按 preview_pv- 前缀圈定本功能文件
  function trimPreviewLocalFiles(fs: any) {
    try {
      const dir = Taro.env.USER_DATA_PATH
      const files = (fs.readdirSync(dir) as string[]).filter((f) => f.indexOf('preview_pv-') === 0)
      if (files.length <= 40) return
      const statted = files
        .map((f) => {
          const st = fs.statSync(`${dir}/${f}`)
          const t = st.lastModifiedTime
          return { f, t: t instanceof Date ? t.getTime() : Number(t) || 0 }
        })
        .sort((a, b) => a.t - b.t)
      statted.slice(0, statted.length - 40).forEach(({ f }) => {
        try { fs.unlinkSync(`${dir}/${f}`) } catch (e) {}
      })
    } catch (e) {}
  }

  // 历史消息恢复：效果图消息按 taskId 查本地持久化文件（在 restoreFromCache 同步 messagesRef 后调用）
  // ① 后端图还在（http URL）→ 换本地路径（省流量/防 CDN 故障）
  // ② 后端已清理（expired / resultImage 空）但本地有文件 → 恢复为 done+本地路径（本地储存的核心价值）
  function restorePreviewLocalImages() {
    if (process.env.TARO_ENV === 'h5') return
    const fs = Taro.getFileSystemManager()
    let changed = false
    const next = messagesRef.current.map((m) => {
      if (m.contentType !== 'preview_result' || !m.taskId) return m
      const isUrl = !!m.resultImage && m.resultImage.indexOf('http') === 0
      const backendGone = !isUrl  // 空 URL = 后端已清理（expired 后端置空）
      if (!isUrl && !(m.status === 'expired' || (m.status === 'done' && !m.resultImage))) {
        return m  // processing/failed 等中间态不处理
      }
      const localPath = previewLocalPath(m.taskId)
      try {
        fs.accessSync(localPath)
      } catch (e) {
        return m  // 本地也没有（清缓存/换设备）→ 保持后端返回的过期文案
      }
      changed = true
      if (backendGone) {
        return { ...m, status: 'done', resultImage: localPath, text: '效果图（仅本机可见，如需长期保存请存到相册）' }
      }
      return { ...m, resultImage: localPath }
    })
    if (changed) {
      setMessages(next)
      messagesRef.current = next
    }
  }

  // 编辑已生成效果图：把结果图加入输入栏作为底图，用户在输入栏输入提示词发送后
  // 走编辑链路（/preview/{id}/edit 以结果图为底图再次生图，计一次当日额度）。
  // 复用拍照的待发图机制（pendingImage 缩略图 + input-bar 输入），不发独立编辑弹窗。
  function onEditPreviewImage(taskId: string, url: string) {
    if (!taskId || !url || sending) return
    editingTaskIdRef.current = taskId                 // 标记编辑态，sendMessage 分流走编辑
    previewImageRef.current = { path: url, url }      // 结果图入输入栏（url 即底图）
    setPendingImage({ path: url })                    // 缩略图显示在输入栏
    if (inputBarRef.current) inputBarRef.current.setText('')
  }

  function editPreview(taskId: string, text: string) {
    // 底图 URL 在清态前取出：live 用户消息带图，与历史 merge（srcImage 必显）保持一致
    const baseImage = (previewImageRef.current && previewImageRef.current.path) || ''
    editingTaskIdRef.current = ''   // 编辑态已消费，清除防残留
    clearPreviewState()             // 清 pendingImage/输入栏（发送时消费完即清）
    const userMsg: Message = { role: 'user', text: `编辑：${text}`, image: baseImage }
    const aiMsg: Message = {
      role: 'ai', contentType: 'preview_result', text: '正在基于上次效果图编辑…',
      status: 'processing', resultImage: '', productName: '', taskId: '',
      loading: false, streaming: false,
      thinking: [], suggestions: [], followUps: [], checkedMap: {}
    }
    userScrollingRef.current = false
    const next = [...messagesRef.current, userMsg, aiMsg]
    setMessages(next)
    messagesRef.current = next
    setSending(true)
    scrollToBottom()
    // 任务创建失败 → 撤回刚插入的两条消息 + toast 原因（额度/过期等，占位无 taskId 无操作入口）
    const fail = (msg: string) => {
      const msgs = messagesRef.current
      if (msgs.length >= 2 && msgs[msgs.length - 1].contentType === 'preview_result') {
        const remain = msgs.slice(0, -2)
        setMessages(remain)
        messagesRef.current = remain
      }
      setSending(false)
      Taro.showToast({ title: msg, icon: 'none' })
    }
    const cid = cidRef.current
    if (!cid) { fail('会话不存在，请重新进入'); return }
    post(`/preview/${taskId}/edit`, { prompt: text }).then((res: any) => {
      if (res && res.taskId) {
        patchMsgByTaskIdPlaceholder(res.taskId, cid)
        Taro.removeStorageSync(`conv_messages_${cid}`)  // 缓存失效：新任务已入库，切回重拉
        pollPreview(res.taskId, cid)
      } else {
        fail((res && res.message) || '编辑任务创建失败，请稍后再试')
      }
    }).catch((err: any) => fail((err && err.message) || '编辑任务创建失败，请稍后再试'))
  }

  // 效果图保存到相册（图片 7 天后服务端清理，本地保存是唯一持久方式）。
  // 网络 URL 先下载（临时文件），再存相册。
  function onSavePreviewImage(url: string) {
    if (!url) return
    // ponytail: H5 无相册 API，新窗口打开图片由用户自行保存（长按/右键）
    if (process.env.TARO_ENV === 'h5') {
      if (url) window.open(url, '_blank')
      return
    }
    const save = (filePath: string) => {
      Taro.saveImageToPhotosAlbum({
        filePath,
        success: () => Taro.showToast({ title: '已保存到相册', icon: 'success' }),
        fail: (err: any) => {
          // 相册权限被拒 → 引导去设置开启；其他失败按普通失败提示
          if (err && (err.errMsg || '').indexOf('auth') >= 0) {
            Taro.showModal({
              title: '需要相册权限',
              content: '请在设置中允许保存图片到相册',
              confirmText: '去设置',
              success: (r) => { if (r.confirm) Taro.openSetting() }
            })
          } else {
            Taro.showToast({ title: '保存失败，请重试', icon: 'none' })
          }
        }
      })
    }
    if (url.indexOf('http') !== 0) {
      save(url)  // 本地临时文件直接存
      return
    }
    Taro.downloadFile({
      url,
      success: (res: any) => {
        if (res.statusCode !== 200) {
          Taro.showToast({ title: '保存失败，请重试', icon: 'none' })
          return
        }
        save(res.tempFilePath)
      },
      fail: () => Taro.showToast({ title: '下载失败，请重试', icon: 'none' })
    })
  }

  function resetChat() {
    abortStream()
    // 重置=脱离当前会话，先 flush 产品选中 + 总结旧会话偏好（cid 仍是旧值，须在此之前 flush）
    flushProductSync()
    flushProfileSummary()
    if (draftTimerRef.current) {
      clearTimeout(draftTimerRef.current)
      draftTimerRef.current = null
    }
    pendingDraftRef.current = ''
    // ponytail: 重置会话清空勾选态 + 已提交记录（不跨会话保留）
    suggestionChecksRef.current = {}
    submittedChecksRef.current = {}
    userScrollingRef.current = false  // 恢复自动滚动
    stopPreviewPolling()  // 停生图轮询（任务在后端继续跑，切回可从历史恢复）
    clearPreviewState()   // 拍照看效果预览态不跨会话
    setHasStarted(false)
    setDrawerVisible(false)
    setSlotsDrawerVisible(false)
    setMessages([])
    messagesRef.current = []
    setSending(false)
    setConversationId('')
    cidRef.current = ''
  }

  function sendMessage(text: string) {
    if (!requireLogin()) return
    if (sending) return

    // 拍照看效果分流：有 pending 图一律走生图链路，绝不掉进 LLM（防"有图无产品"时图片被静默丢弃）。
    // ponytail: 置于 10s 限流之前——生图有自己的每日配额且 sending 锁保证单飞行；
    // 上传中/失败时连点发送不应消耗限流名额，否则真实提示会被"发送过于频繁"掩盖
    if (previewImageRef.current) {
      if (!text || !text.trim()) return
      // 二次编辑分流：编辑态（结果图作底图）走 /preview/{id}/edit，不要求重新选产品/上传
      if (editingTaskIdRef.current) {
        editPreview(editingTaskIdRef.current, text.trim())
        return
      }
      const img = previewImageRef.current
      if (!img.url) {
        Taro.showToast({
          title: (pendingImage && pendingImage.fail)
            ? '图片上传失败，请移除后重新拍摄' : '图片还在上传中，请稍候',
          icon: 'none'
        })
        return
      }
      if (!previewProductRef.current) {
        Taro.showToast({ title: '请先选择要安装的产品', icon: 'none' })
        setPickerVisible(true)
        buildPickerProducts()
        return
      }
      sendPreview(text.trim())
      return
    }

    // ponytail: 时间窗口限流——10 秒内最多 3 条，防快速切换会话+发消息绕过 sending 标志刷 LLM token
    const now = Date.now()
    sendTimestampsRef.current = sendTimestampsRef.current.filter((t) => now - t < 10000)
    if (sendTimestampsRef.current.length >= 3) {
      Taro.showToast({ title: '发送过于频繁，请稍候', icon: 'none' })
      return
    }
    sendTimestampsRef.current.push(now)

    if (!text || !text.trim()) return

    // ponytail: 标记本轮有新输入——flushProfileSummary 据此决定是否发请求
    // 避免用户只打开历史会话看了看没发消息，切换走时发无意义请求
    hasNewInputRef.current = true
    // ponytail: 发消息前 flush 产品选中状态——确保后端拿到最新 selected_products 再生成方案
    flushProductSync()

    const userMsg: Message = { role: 'user', text }
    // 产品咨询入口：首次发送时把产品信息挂到用户消息上（渲染产品卡片）
    // ponytail: consultProductRef 来自 storage consult_product_data，仅首次发送注入，之后清空
    const consultProduct = consultProductRef.current
    if (consultProduct) {
      userMsg.productRef = consultProduct
    }
    logger.log('send_message', { conversationId: cidRef.current, textLength: text.length })
    // 占位 AI 消息，contentType 默认 text，后续 onDone 时按真实 contentType 更新
    const aiMsg: Message = {
      role: 'ai',
      text: '',
      contentType: 'text',
      messageId: '',  // 占位，done 事件到达后由 finalizeAiMessage 填入真实 id
      loading: true,
      streaming: true,
      thinking: [],
      thinkingCollapsed: false,
      // ponytail: 占位即给空数组/空对象，避免 null/undefined 传给组件触发类型警告
      suggestions: [],
      followUps: [],
      checkedMap: {}
    }
    // 新回复开始：先恢复自动滚动（上一轮用户触摸可能已暂停），再追加消息并滚动到底
    userScrollingRef.current = false
    const next = [...messagesRef.current, userMsg, aiMsg]
    setMessages(next)
    messagesRef.current = next
    setHasStarted(true)
    setSending(true)
    scrollToBottom()

    // 重置增量缓冲和中止标志
    pendingDraftRef.current = ''
    abortedRef.current = false

    // 收集本轮勾选采纳的建议（用户在上一条 AI 回复下方勾选的 suggestions）
    // ponytail: 勾选态不持久——发消息时取走即清空；若用户不发消息直接关闭，勾选态放弃（类似未发送草稿）
    const acceptedSuggestions = collectAcceptedSuggestions()
    // ponytail: 收集弹窗里待回传的删除操作（本地累积，发消息时一起提交，避免多次 PATCH）
    const slotsUpdate = slotsDrawerRef.current ? slotsDrawerRef.current.getPendingSlots() : {}
    const hasSlotsUpdate = Object.keys(slotsUpdate).length > 0

    // 长期画像：每次请求都带，后端在新会话时 merge 进 accumulated_slots（已有会话忽略）
    // ponytail: 每次传无副作用，省去"是否首条消息"的状态判断
    const userProfile = Taro.getStorageSync('user_profile') || {}
    // user_id 不再随请求传，后端从 JWT 注入 openid 到 state.user_id（供 profile_summarizer 写回）
    // userId 仍用于本地判空守卫（如 flushProfileSummary 的 if (!cid || !userId) return）
    const existingCid = cidRef.current

    const launchStream = (cid: string) => {
      // 产品咨询入口：携带 consult_product_id，后端 intent_parser 据此路由到产品介绍节点
      // ponytail: 仅首次发送携带（consultProductRef 在 launchStream 后清空），后续消息走正常对话流
      const consultPayload = consultProduct ? { consult_product_id: consultProduct.id } : {}
      streamTaskRef.current = streamChat(
        // ponytail: accepted_suggestions 仅在有勾选时携带，避免空数组占字段
        // ponytail: slots_update 携带弹窗里待回传的删除操作（{key: value|null}，null=删除）
        Object.assign(
          { text, conversation_id: cid, user_profile: userProfile },
          acceptedSuggestions.length ? { accepted_suggestions: acceptedSuggestions } : {},
          hasSlotsUpdate ? { slots_update: slotsUpdate } : {},
          consultPayload
        ),
        {
          onMeta: (data) => {
            // 后端可能分配新 conversationId（本地降级时）
            if (data && data.conversationId && data.conversationId !== cid) {
              setConversationId(data.conversationId)
              cidRef.current = data.conversationId
            }
          },
          onThinking: (data) => {
            // 节点级思考进度：start 追加 running 步骤，end 更新为 done + detail
            if (!data || !data.node) return
            const msgs = messagesRef.current.slice()
            const last = msgs.length ? msgs[msgs.length - 1] : null
            if (!last || last.role !== 'ai' || !last.streaming) return

            const thinking = (last.thinking || []).slice()
            if (data.phase === 'start') {
              // ponytail: reasoner 重试（self_check 失败后回到 reasoner）时，
              // 清空已显示的草稿文本，避免新 draft 拼接到旧 draft 后面。
              if (data.node === 'reasoner' && last.text) {
                last.text = ''
              }
              thinking.push({
                node: data.node,
                label: data.label || '',
                detail: '',
                status: 'running'
              } as any)
            } else if (data.phase === 'end') {
              // 从后往前找第一个 running 状态的同名节点（处理 self_check 重试 reasoner 的场景）
              let idx = -1
              for (let i = thinking.length - 1; i >= 0; i--) {
                if ((thinking[i] as any).node === data.node && (thinking[i] as any).status === 'running') {
                  idx = i
                  break
                }
              }
              if (idx >= 0) {
                thinking[idx] = {
                  ...(thinking[idx] as any),
                  label: data.label || (thinking[idx] as any).label,
                  // 优先保留流式 draft 已写入的 detail；流式无内容时才用 end 事件的 detail
                  detail: (thinking[idx] as any).detail || data.detail || '',
                  status: 'done'
                } as any
              } else {
                // 未收到 start（如重连场景），补一条 done
                thinking.push({
                  node: data.node,
                  label: data.label || '',
                  detail: data.detail || '',
                  status: 'done'
                } as any)
              }
            }

            last.thinking = thinking as ThinkingStep[]
            last.loading = false  // 有思考进度就不再显示"正在思考中…"
            msgs[msgs.length - 1] = { ...last }
            setMessages(msgs)
            messagesRef.current = msgs
            scrollToBottom()
          },
          onDraft: (data) => {
            // reasoner 草稿的流式 token → 同时写入思考框 detail 和对话框 last.text
            // response_builder 直接透传 draft_answer，所以 draft 流式 = 最终回复流式
            if (!data || !data.text) return
            pendingDraftRef.current += data.text
            scheduleDraftFlush()
          },
          onDone: (data) => {
            flushDraft()
            finalizeAiMessage(data)
            setSending(false)
            streamTaskRef.current = null
            scrollToBottom()
            // ponytail: 发送成功后清空弹窗的待回传删除操作（已随本消息提交）
            if (hasSlotsUpdate && slotsDrawerRef.current) slotsDrawerRef.current.clearPending()
            // ponytail: 对话后后端 accumulated_slots 可能更新，刷新 drawer 的 slotList 缓存。
            // 不管可见不可见都刷新——不可见时刷新保证下次展开用最新数据（展开不发请求）。
            // force=true 绕过防刷——onDone 的刷新不能被 _fetching/500ms 跳过，否则缓存不更新。
            if (slotsDrawerRef.current) slotsDrawerRef.current.fetchSlots(undefined, true)
            // ponytail: 缓存优化——更新本地消息缓存 + 标记会话列表需刷新
            // 1. 消息缓存：切走再切回来不用重新拉
            // 2. convs_dirty：会话 updatedAt 变了，下次打开 drawer 刷新列表
            // 3. plans_dirty：生成了新方案时标记 plans 页需刷新
            const doneCid = cidRef.current
            if (doneCid) {
              const nowSec = Math.floor(Date.now() / 1000)
              Taro.setStorageSync(`conv_messages_${doneCid}`, { messages: messagesRef.current, updatedAt: nowSec })
              touchConvCacheLRU(doneCid)
              const meta = Taro.getStorageSync('convs_meta') || {}
              meta[doneCid] = nowSec
              Taro.setStorageSync('convs_meta', meta)
              Taro.setStorageSync('convs_dirty', true)
              if (data && data.plans && data.plans.length) {
                Taro.setStorageSync('plans_dirty', true)
              }
            }
          },
          // ponytail: done 事件后异步到达的建议列表（后端 _extract_suggestions_llm 不阻塞 done）
          // 用 messageId 找到对应消息，更新 suggestions 字段触发勾选按钮渲染
          // 校验 conversationId：用户可能已切换会话，旧会话的建议不应更新新会话的消息
          onSuggestions: (data) => {
            if (!data || !data.messageId || !data.suggestions) return
            if (cidRef.current !== cid) return
            const msgs = messagesRef.current.slice()
            for (let i = msgs.length - 1; i >= 0; i--) {
              if (msgs[i].role === 'ai' && msgs[i].messageId === data.messageId) {
                msgs[i] = { ...msgs[i], suggestions: data.suggestions, checkedMap: msgs[i].checkedMap || {} }
                setMessages(msgs)
                messagesRef.current = msgs
                scrollToBottom()
                return
              }
            }
          },
          // ponytail: done 事件后异步到达的追问推荐（后端 generate_follow_ups 不阻塞 done）
          // 用 messageId 找到对应消息，更新 followUps 字段触发追问卡片渲染
          // 校验 conversationId：用户可能已切换会话，旧会话的追问不应更新新会话的消息
          onFollowUps: (data) => {
            if (!data || !data.messageId || !data.followUps) return
            if (cidRef.current !== cid) return
            const msgs = messagesRef.current.slice()
            for (let i = msgs.length - 1; i >= 0; i--) {
              if (msgs[i].role === 'ai' && msgs[i].messageId === data.messageId) {
                msgs[i] = { ...msgs[i], followUps: data.followUps }
                setMessages(msgs)
                messagesRef.current = msgs
                scrollToBottom()
                return
              }
            }
          },
          onError: (err) => {
            // 用户主动中止会触发 request fail，忽略这次错误，避免覆盖「（已停止）」
            if (abortedRef.current) {
              streamTaskRef.current = null
              return
            }
            flushDraft()
            const tip = err && err.message ? err.message : '网络异常，请稍后重试'
            finalizeAiMessage({ reply: '出错了：' + tip, contentType: 'error' })
            setSending(false)
            streamTaskRef.current = null
            scrollToBottom()
          }
        }
      )
    }

    // ponytail: 延迟创建会话——conversationId 为空时先调后端创建，拿到 cid 再发流式请求
    // 已有 cid（历史会话续聊）直接发，不重复创建
    // ponytail: 勾选建议已被 acceptedSuggestions 带入请求；已采纳的建议保持勾选不清空，
    //           下轮继续累积新增勾选（后端处理 accepted_suggestions 幂等，重复提交无害）
    // 产品咨询：仅首次发送注入产品信息，launchStream 定义后清空，后续消息走正常对话流
    consultProductRef.current = null
    if (existingCid) {
      launchStream(existingCid)
    } else {
      post('/conversations', { title: '新对话' })
        .then((res: any) => {
          const cid = (res && res.id) || ('local-' + Date.now())
          setConversationId(cid)
          cidRef.current = cid
          // ponytail: 新建会话 → 标记列表需刷新（下次打开 drawer 会拉后端）
          Taro.setStorageSync('convs_dirty', true)
          launchStream(cid)
        })
        .catch(() => {
          const cid = 'local-' + Date.now()
          setConversationId(cid)
          cidRef.current = cid
          launchStream(cid)
        })
    }
  }

  // ─── 草稿增量拼接节流 ───
  // ponytail: 每 50ms 至多 flush 一次，避免每个 token 都 setState 卡顿
  // draft token 同时写入 thinking 的 running 步骤 detail 和对话框 last.text
  function scheduleDraftFlush() {
    if (draftTimerRef.current) return
    draftTimerRef.current = setTimeout(() => {
      draftTimerRef.current = null
      flushDraft()
    }, 50)
  }

  function flushDraft() {
    if (draftTimerRef.current) {
      clearTimeout(draftTimerRef.current)
      draftTimerRef.current = null
    }
    const draft = pendingDraftRef.current
    if (!draft) return
    pendingDraftRef.current = ''

    const msgs = messagesRef.current.slice()
    const lastIdx = msgs.length - 1
    if (lastIdx < 0) return
    const last = msgs[lastIdx]
    if (!last || last.role !== 'ai' || !last.streaming) return

    // 1. thinking running 步骤的 detail 追加 draft（思考面板）
    const thinking = (last.thinking || []).slice()
    for (let i = thinking.length - 1; i >= 0; i--) {
      if ((thinking[i] as any).status === 'running') {
        ;(thinking[i] as any).detail = ((thinking[i] as any).detail || '') + draft
        break
      }
    }
    // 2. 对话框文本流式追加
    // response_builder 直接透传 draft_answer 作为 final_answer，所以 draft 流式 = 最终回复流式。
    // self_check 重试时 onThinking 会清空 last.text，新 draft 重新流入，不会拼接旧内容。
    last.thinking = thinking as ThinkingStep[]
    last.text = (last.text || '') + draft
    // 3. loading 状态（首次 draft 到达时关闭"正在思考中…"）
    if (last.loading) last.loading = false
    msgs[lastIdx] = { ...last }
    setMessages(msgs)
    messagesRef.current = msgs
    scrollToBottom()
  }

  function extractLastDraft(msg: Message): string {
    if (!msg || !msg.thinking) return ''
    for (let i = msg.thinking.length - 1; i >= 0; i--) {
      const step = msg.thinking[i] as any
      if (step.node === 'reasoner' && step.detail) return step.detail
    }
    return ''
  }

  function finalizeAiMessage(data: any) {
    const msgs = messagesRef.current.slice()
    const last = msgs.length ? msgs[msgs.length - 1] : null
    if (!last || last.role !== 'ai') return

    // 后端 done 事件携带完整 reply（response_builder 的最终回复）+ contentType + messageId
    // ponytail: draft 已流式写入 last.text。response_builder 99% 透传 draft_answer，
    // 所以 reply === last.text 是常态 → 跳过 text 赋值，避免 markdown 重渲染闪烁。
    // 仅当 reply 不同时（如 full_recommend 追加了引用来源）才覆盖。
    let reply = data && data.reply
    if (reply === undefined || reply === null || reply === '') {
      const draftText = extractLastDraft(last)
      if (draftText) reply = draftText
    }
    const textAlreadyMatched = reply !== undefined && reply !== null && reply === last.text
    let text = textAlreadyMatched ? last.text : (reply !== undefined && reply !== null ? reply : (last.text || ''))
    const contentType = (data && data.contentType) || 'text'
    const messageId = (data && data.messageId) || last.messageId || ''
    const plans = (data && data.plans) || null
    const merchants = normalizeMerchants((data && data.merchants) || null)
    const missingSlots: string[] = (data && data.missingSlots) || []
    // 产品列表 + 选中状态（product-card 多选用）
    const products = (data && data.products) || null
    const selectedIds: string[] = (data && data.selectedProductIds) || []
    if (products) {
      products.forEach((p: ProductItem) => { p.selected = selectedIds.indexOf(p.id) >= 0 })
    }
    // 把槽位名映射为 {slot, label} 对，供渲染（pills 仅作信息提示，不再当用户输入）
    const followUpPills = missingSlots.map((s) => ({ slot: s, label: SLOT_LABELS[s] || s }))
    // 后端 reasoner 从 draft 提取的可采纳建议，透传给 chat-bubble-ai 渲染勾选按钮
    // ponytail: 建议类 intent 才有值，用 [] 兜底而非 null
    const suggestions: Suggestion[] = (data && data.suggestions) || []
    // ponytail: followUps 由 done 后异步 follow_ups 事件推送，done 时恒为 []（与 suggestions 对称）
    const followUps: string[] = (data && data.followUps) || []

    // ponytail: 防御性兜底：若 AI 消息最终 text 与上一条用户输入完全相同，
    // 说明服务端/前端出现污染，直接清空并提示，避免把用户问题当成回答展示。
    if (text && msgs.length >= 2) {
      const prev = msgs[msgs.length - 2]
      if (prev && prev.role === 'user' && prev.text === text) {
        console.warn('[chat] final answer equals user input, clearing. text=', text)
        text = '回答生成异常，请稍后重试。'
      }
    }

    // ponytail: 剥离固定提示句 → 单独渲染醒目提示条（needsTip 需求提示 / planTip 方案引导）。
    // 剥离后 text 只留正文，提示句以专属颜色提示条展示（参照 TIP_PATTERNS 注释）。
    const tips: Record<string, string> = {}
    if (text) {
      for (const { key, re, tip } of TIP_PATTERNS) {
        const m = text.match(re)
        if (m) {
          // tip 固定话术优先（剥离旧/新变体后统一显示新文案），否则显示剥离原文
          tips[key] = tip || m[0].replace(/\s+/g, ' ').trim()
          text = text.replace(re, '').replace(/\n{3,}/g, '\n\n').trim()
        }
      }
    }

    // 活动占位符：优先解析最终文本；流式阶段已收集的 id 兜底（reply 与 draft 不一致的极端场景）
    const act = stripActivityRefs(text)
    text = act.text

    const update: Message = {
      ...last,
      messageId,
      contentType,
      needsTip: tips.needsTip || '',
      planTip: tips.planTip || '',
      merchantTip: tips.merchantTip || '',
      plans,
      merchants,
      products,
      selectedProductIds: selectedIds.length ? selectedIds : null,
      missingSlots,
      followUpPills,
      suggestions,
      followUps,
      // 活动占位符：优先解析最终文本；流式阶段已收集的 id 兜底（reply 与 draft 不一致的极端场景）
      activityIds: act.ids.length ? act.ids : (streamActivityIdsRef.current || []),
      // checkedMap 从本页 suggestionChecksRef 取，保证用户勾选后能立即在 UI 上反馈
      // ponytail: 初始空对象，用户勾选后由 onSuggestionToggle 更新 suggestionChecksRef 再下发
      checkedMap: (suggestionChecksRef.current && messageId && suggestionChecksRef.current[messageId]) || {},
      loading: false,
      streaming: false,
      thinkingCollapsed: !!(last.thinking && last.thinking.length)
    }
    if (!textAlreadyMatched || text !== last.text) {
      update.text = text
    }
    msgs[msgs.length - 1] = update
    setMessages(msgs)
    messagesRef.current = msgs
  }

  // 切换思考面板折叠/展开
  function onThinkingToggle(msgId: string) {
    const msgs = messagesRef.current.slice()
    for (let i = msgs.length - 1; i >= 0; i--) {
      const m = msgs[i]
      if (m.role !== 'ai') continue
      if (msgId && m.messageId !== msgId) continue
      msgs[i] = { ...m, thinkingCollapsed: !m.thinkingCollapsed }
      setMessages(msgs)
      messagesRef.current = msgs
      return
    }
  }

  // 建议勾选切换：累积到 suggestionChecksRef，并 setMessages 触发组件重渲染
  // ponytail: 勾选态不存 storage——用户直接关闭=放弃（类似未发送草稿）；发下条消息时汇总提交
  function onSuggestionToggle(messageId: string, suggestion: Suggestion) {
    if (!messageId || !suggestion.id) return

    const msgChecks = { ...(suggestionChecksRef.current[messageId] || {}) }
    msgChecks[suggestion.id] = !msgChecks[suggestion.id]
    if (!msgChecks[suggestion.id]) delete msgChecks[suggestion.id]  // 取消勾选时移除
    suggestionChecksRef.current = {
      ...suggestionChecksRef.current,
      [messageId]: msgChecks
    }

    // 更新对应消息的 checkedMap，触发组件重算 hasChecked/checkedCount
    const msgs = messagesRef.current.slice()
    for (let i = msgs.length - 1; i >= 0; i--) {
      const m = msgs[i]
      if (m.role !== 'ai' || m.messageId !== messageId) continue
      // ponytail: 必须 spread 新对象，否则引用相同 setMessages 不触发更新
      msgs[i] = { ...m, checkedMap: { ...msgChecks } }
      setMessages(msgs)
      messagesRef.current = msgs
      return
    }
  }

  // 汇总所有消息的勾选建议文本（发送时调用）
  // ponytail: 跨消息累积——用户可能在多条 AI 回复中分别勾选，发送时一并提交。
  // 已提交的 id 记录在 submittedChecksRef，下次只收集新增勾选，避免重复提交；
  // UI 勾选态（checkedMap）不清空——已采纳的建议保持勾选视觉，用户知道哪些已录入需求。
  function collectAcceptedSuggestions(): string[] {
    const checks = suggestionChecksRef.current
    const accepted: string[] = []
    const msgs = messagesRef.current || []
    // 建立 messageId → suggestions 的索引，便于把勾选 id 映射回建议文本
    const sugMap: Record<string, string> = {}
    msgs.forEach((m) => {
      if (m.role === 'ai' && m.messageId && Array.isArray(m.suggestions)) {
        (m.suggestions || []).forEach((s) => {
          if (s && s.id) sugMap[`${m.messageId}:${s.id}`] = s.text
        })
      }
    })
    Object.keys(checks).forEach((msgId) => {
      const msgChecks = checks[msgId] || {}
      Object.keys(msgChecks).forEach((sid) => {
        if (msgChecks[sid]) {
          const key = `${msgId}:${sid}`
          // ponytail: 跳过已提交的——已采纳的建议不重复提交
          if (submittedChecksRef.current[key]) return
          const text = sugMap[key]
          if (text) {
            accepted.push(text)
            submittedChecksRef.current[key] = true
          }
        }
      })
    })
    // ponytail: 去重——suggestions 列表可能含同 text 不同 id，或跨消息同 text
    const unique = [...new Set(accepted)]
    // ponytail: 不清空 suggestionChecks / checkedMap——保持勾选视觉，
    // 已提交的 id 在 submittedChecks 标记，下次只收集新增勾选
    return unique
  }

  function stopGeneration() {
    abortStream()
    // 同时发停止信号给后端，终止链路 + 关闭 LLM 流省 token
    // ponytail: 后端可能已结束/会话不存在，triggered=false 也无妨，静默处理
    const cid = cidRef.current
    if (cid) {
      post('/chat/stop', { conversation_id: cid }).catch(() => {
        logger.error('stop_generation', { conversationId: cid })
      })
    }
    flushDraft()
    const msgs = messagesRef.current.slice()
    const last = msgs.length ? msgs[msgs.length - 1] : null
    if (last && last.role === 'ai' && last.streaming) {
      // ponytail: draft 流式已写入 last.text，中止时直接追加标记即可
      msgs[msgs.length - 1] = {
        ...last,
        text: (last.text || '') + '\n\n（已停止）',
        loading: false,
        streaming: false,
        thinkingCollapsed: !!(last.thinking && last.thinking.length)
      }
      setMessages(msgs)
      messagesRef.current = msgs
    }
    setSending(false)
  }

  // 标记中止：阻止 request fail 回调的 onError 在 abort 后触发副作用
  // 所有调用方（stop/reset/switch/unload）都需要这个语义
  function abortStream() {
    abortedRef.current = true
    if (streamTaskRef.current && typeof streamTaskRef.current.abort === 'function') {
      try { streamTaskRef.current.abort() } catch (e) { /* task 已销毁 */ }
    }
    streamTaskRef.current = null
  }

  // ─── 事件 ───

  function onPillTap(label: string) {
    // follow_up pills 仅作信息提示，点击引导用户在下方输入框补充对应信息
    // ponytail: 升级为后端下发 followUpOptions（带预设答案选项）后可改回快捷回复
    if (!label) return
    Taro.showToast({
      title: `请在下方输入框告知「${label}」`,
      icon: 'none',
      duration: 1500
    })
  }

  // ponytail: 追问卡片点击即发送——复用 startChat 的"直接调 sendMessage"模式，
  // 不回填输入框（追问是即点即发，不需要编辑）；sending 锁防止用户连点。
  function onFollowUpTap(text: string) {
    if (sending) return
    if (!text) return
    sendMessage(text)
  }

  // ponytail: 需求清单 drawer——左下角悬浮按钮触发，查看/增删 accumulated_slots
  function openSlotsDrawer() {
    if (!cidRef.current) return
    // ponytail: 两个 drawer 互斥——打开需求清单时关闭对话历史
    setSlotsDrawerVisible(true)
    setDrawerVisible(false)
  }

  function closeSlotsDrawer() {
    setSlotsDrawerVisible(false)
  }

  // ponytail: 方案卡片查看 → 方案详情页，storage 中转完整 plan 对象（含 userRequirements/merchants）
  function onPlanView(id: string) {
    if (!id) return
    // 从本地消息快照找完整 plan 对象
    const msgs = messagesRef.current || []
    let plan: PlanItem | null = null
    for (const msg of msgs) {
      const found = (msg.plans || []).find((p) => p.id === id)
      if (found) { plan = found; break }
    }
    if (!plan) {
      Taro.navigateTo({ url: '/pages/plans/index' })
      return
    }
    // ponytail: Taro 不支持 eventChannel，改用 storage 中转
    Taro.setStorageSync('plan_detail_data', plan)
    Taro.navigateTo({ url: `/pages/plan-detail/index?id=${id}` })
  }

  // ponytail: 提交方案——确认弹窗 → POST /plans/{id}/submit → 商家结果提示 + 标记列表脏缓存
  function onPlanSubmit(id: string) {
    if (!id) return
    Taro.showModal({
      title: '提交方案',
      content: '提交后将为您匹配附近可承接该方案的商家，是否继续？',
      confirmColor: '#2563eb',
      success: (res) => {
        if (!res.confirm) return
        Taro.showLoading({ title: '提交中...', mask: true })
        post(`/plans/${id}/submit`)
          .then((data: any) => {
            Taro.hideLoading()
            // 提交后后端已匹配商家（status=matched）；无 location 时商家为空（status=submitted）
            const merchants = (data && data.merchants) || []
            // 列表脏缓存标记：返回方案页时 useDidShow 强制拉后端，避免显示旧 draft 状态
            Taro.setStorageSync('plans_dirty', true)
            if (merchants.length) {
              Taro.showModal({
                title: '匹配成功',
                content: `已为您匹配 ${merchants.length} 家可承接商家，可在「方案」页查看详情。`,
                showCancel: false,
                confirmText: '知道了'
              })
            } else {
              Taro.showToast({ title: '已提交，暂无匹配商家', icon: 'none' })
            }
          })
          .catch((err: any) => {
            Taro.hideLoading()
            Taro.showToast({ title: (err && err.message) || '提交失败', icon: 'none' })
          })
      }
    })
  }

  // 产品卡片选择/取消：更新本地选中状态 + 防抖同步后端（plan_generator 生成方案的前置条件）
  // ponytail: 防抖 1s——用户连续点击多个卡片只发一次请求
  // 乐观更新：点击立即更新 UI，后端延迟同步（1s 内无新点击才发请求）
  // flush 时机：sendMessage/useDidHide/unmount/resetChat/switchToConversation 确保退出或发消息前必定同步
  function onProductToggle(detail: { selected: boolean; msgIndex: number; pIdx: number }) {
    const { msgIndex, pIdx, selected } = detail
    const msgs = messagesRef.current
    const msg = msgs[msgIndex]
    if (!msg || !msg.products || pIdx < 0 || pIdx >= msg.products.length) return

    const newProducts = msg.products.map((p, i) => i === pIdx ? { ...p, selected } : p)
    // 重建 selectedIds（不依赖 setState 同步性，避免时序歧义）
    const selectedIds = newProducts.filter((p) => p.selected).map((p) => p.id)
    msgs[msgIndex] = { ...msg, products: newProducts, selectedProductIds: selectedIds.length ? selectedIds : null }
    setMessages(msgs)
    messagesRef.current = msgs

    // ponytail: 防抖同步——1s 内连续点击只发一次请求
    if (productSyncTimerRef.current) clearTimeout(productSyncTimerRef.current)
    const cid = cidRef.current
    if (!cid) return
    productSyncMsgIdxRef.current = msgIndex  // 记录最近有产品卡片的消息索引
    productSyncTimerRef.current = setTimeout(() => {
      productSyncTimerRef.current = null
      syncSelectedProducts()
    }, 1000)
  }

  // 从最新 messages 重建 selectedIds 并同步后端（防抖回调 + flush 共用）
  function syncSelectedProducts() {
    const cid = cidRef.current
    if (!cid) return
    const msgIdx = productSyncMsgIdxRef.current
    if (msgIdx == null) return
    const msg = messagesRef.current[msgIdx]
    if (!msg || !msg.products) return
    const selectedIds = msg.products.filter((p) => p.selected).map((p) => p.id)
    put(`/conversations/${cid}/selected-products`, { product_ids: selectedIds })
      .catch(() => {
        logger.error('sync_selected_products', { conversationId: cid })
      })
  }

  function onMerchantContact(detail: { id: string; phone: string; name: string }) {
    const { id, phone, name } = detail
    logger.log('contact_merchant', { merchantId: id, hasPhone: !!phone })
    // 上报联系行为 → 作为无方案评价资格（fire-and-forget，失败不影响拨号）
    if (id) {
      post('/merchants/contact', { merchantId: id }).catch(() => {})
    }
    if (!phone) {
      Taro.showModal({
        title: name || '联系商家',
        content: '该商家暂未提供联系电话，请稍后再试或咨询客服。',
        showCancel: false,
        confirmText: '知道了'
      })
      return
    }
    // 跨端拨号：H5 用 tel: 协议，小程序用 Taro.makePhoneCall
    makePhoneCallSafe(phone).catch(() => { /* 用户取消拨号不提示 */ })
  }

  // 对话页商家卡片"评价商家"（无方案评价：联系过的商家可直接评价）
  function onMerchantReview(detail: { id: string; name: string }) {
    const { id, name } = detail
    if (!id) return
    // ponytail: Taro 不支持 eventChannel，改用 storage 中转
    Taro.setStorageSync('merchant_review_data', { merchantId: id, merchantName: name })
    Taro.navigateTo({ url: '/pages/review-submit/index' })
  }

  // 商家卡片点击 → 跳转详情页，storage 中转完整 merchant 对象（含 address/intro 等卡片未展示字段）
  // ponytail: 详情页数据本地传递，不埋导航日志（避免打开详情页触发日志上报请求）
  function onMerchantView(id: string) {
    if (!id) return
    const msg = messagesRef.current.find((m) => m.merchants && m.merchants.some((mc) => mc.id === id))
    const merchant = msg && msg.merchants && msg.merchants.find((mc) => mc.id === id)
    if (!merchant) return
    Taro.setStorageSync('merchant_detail_data', merchant)
    Taro.navigateTo({ url: `/pages/merchant-detail/index?id=${id}` })
  }

  // 产品卡片"详情"按钮 → 商品详情页，storage 中转完整 product 对象
  // ponytail: 详情页数据本地传递，不埋导航日志（避免打开详情页触发日志上报请求）
  function onProductDetail(detail: { msgIndex: number; pIdx: number }) {
    const { msgIndex, pIdx } = detail
    const msg = messagesRef.current[msgIndex]
    const product = msg && msg.products && msg.products[pIdx]
    if (!product) return
    Taro.setStorageSync('product_detail_data', product)
    Taro.navigateTo({ url: `/pages/product-detail/index?id=${product.id}` })
  }

  function openDrawer() {
    // 未登录拦截：对话历史需要 JWT 鉴权，未登录直接弹登录提示，避免 401 报错
    if (!requireLogin()) return
    // ponytail: 两个 drawer 互斥——打开对话历史时关闭需求清单
    setDrawerVisible(true)
    setSlotsDrawerVisible(false)
  }

  function closeDrawer() {
    setDrawerVisible(false)
  }

  function onDrawerSelect(id: string) {
    const hasContent = messagesRef.current.length > 0 || sending
    if (!hasContent) {
      switchToConversation(id)
      return
    }
    // ponytail: 切换会话会替换当前页面消息为另一个会话的历史；不会删除后端数据，只是页面状态切换
    Taro.showModal({
      title: '切换会话',
      content: '当前页面将切换到选中的历史会话，未发送的输入不会保留。',
      confirmText: '切换',
      confirmColor: '#2563eb',
      success: (res) => {
        if (!res.confirm) return
        switchToConversation(id)
      }
    })
  }

  function switchToConversation(id: string) {
    setDrawerVisible(false)
    abortStream()
    // 切换会话=脱离当前会话，先 flush 产品选中 + 总结旧会话偏好（cid 仍是旧值，fire-and-forget 不阻塞）
    flushProductSync()
    flushProfileSummary()
    userScrollingRef.current = false  // 切换会话恢复自动滚动
    stopPreviewPolling()  // 停生图轮询（任务在后端继续跑，切回可从历史恢复）
    clearPreviewState()   // 拍照看效果预览态不跨会话
    setHasStarted(true)
    setMessages([])
    messagesRef.current = []
    // 活动占位符剥离缓冲同步清空（脱离当前流式上下文）
    streamRawRef.current = ''
    streamActivityIdsRef.current = []
    setConversationId(id)
    cidRef.current = id
    setSending(false)
    // 拉取历史消息
    loadMessages(id)
  }

  function onDeleteConversation(id: string, title: string) {
    if (!id) return
    const titleText = title ? `「${title}」` : '该会话'
    Taro.showModal({
      title: '删除对话',
      content: `确定删除${titleText}吗？删除后无法恢复。`,
      confirmText: '删除',
      confirmColor: '#ef4444',
      success: (res) => {
        if (!res.confirm) return
        Taro.showLoading({ title: '删除中...', mask: true })
        del(`/conversations/${id}`)
          .then(() => {
            Taro.hideLoading()
            Taro.showToast({ title: '已删除', icon: 'none', duration: 1000 })
            // ponytail: 清本地消息缓存 + LRU 记录 + 标记列表需刷新
            Taro.removeStorageSync(`conv_messages_${id}`)
            const lru = Taro.getStorageSync('conv_messages_lru') || []
            const lruIdx = lru.indexOf(id)
            if (lruIdx >= 0) {
              lru.splice(lruIdx, 1)
              Taro.setStorageSync('conv_messages_lru', lru)
            }
            Taro.setStorageSync('convs_dirty', true)
            // 若删除的是当前会话，回到空状态
            if (id === cidRef.current) {
              abortStream()
              setConversationId('')
              cidRef.current = ''
              setHasStarted(false)
              setMessages([])
              messagesRef.current = []
              setSending(false)
              setDrawerVisible(false)
            } else {
              // 刷新抽屉列表：走 refresh（convs_dirty=true 会拉后端 + 清标记，避免下次重复拉）
              if (drawerRef.current) drawerRef.current.refresh()
            }
          })
          .catch((err: any) => {
            Taro.hideLoading()
            Taro.showToast({ title: (err && err.message) || '删除失败', icon: 'none' })
          })
      }
    })
  }

  // 重命名对话：抽屉组件已做非空/40 字校验，这里只调 API + 刷列表
  function onRenameConversation(id: string, title: string) {
    if (!id || !title) return
    Taro.showLoading({ title: '保存中...', mask: true })
    patch(`/conversations/${id}`, { title })
      .then(() => {
        Taro.hideLoading()
        Taro.showToast({ title: '已重命名', icon: 'none', duration: 1000 })
        Taro.setStorageSync('convs_dirty', true)
        // 同步本地缓存 items，抽屉下次秒开即为新名
        const cached = Taro.getStorageSync('convs_cache_items') || []
        const idx = cached.findIndex((c: any) => c.id === id)
        if (idx >= 0) {
          cached[idx] = { ...cached[idx], title }
          Taro.setStorageSync('convs_cache_items', cached)
        }
        if (drawerRef.current) drawerRef.current.refresh()
      })
      .catch((err: any) => {
        Taro.hideLoading()
        Taro.showToast({ title: (err && err.message) || '重命名失败', icon: 'none' })
      })
  }

  // ponytail: LRU 淘汰——保留最近 100 个会话的消息缓存，超限删最旧
  // 100 会话 ×30KB ≈ 3MB，远不到 storage 10MB 上限，留足余量给其他缓存
  function touchConvCacheLRU(cid: string) {
    const lru = Taro.getStorageSync('conv_messages_lru') || []
    const idx = lru.indexOf(cid)
    if (idx >= 0) lru.splice(idx, 1)
    lru.push(cid)
    while (lru.length > 100) {
      const oldCid = lru.shift()
      Taro.removeStorageSync(`conv_messages_${oldCid}`)
    }
    Taro.setStorageSync('conv_messages_lru', lru)
  }

  function loadMessages(convId: string) {
    // ponytail: 缓存优先——本地有消息缓存 + updatedAt 一致时直接用，不发请求
    // updatedAt 从 convs_meta 拿（drawer 拉会话列表时缓存）
    // 节省切换会话时的 /conversations/{id}/messages 请求（云托管按请求计费）
    const cacheKey = `conv_messages_${convId}`
    const cached = Taro.getStorageSync(cacheKey)
    const convsMeta = Taro.getStorageSync('convs_meta') || {}
    const serverUpdatedAt = convsMeta[convId] || 0

    const restoreFromCache = (msgs: Message[]) => {
      setMessages(msgs)
      messagesRef.current = msgs
      // 拍照看效果：效果图按 taskId 查本地持久化文件（URL 过期/被清理时仍可看）
      restorePreviewLocalImages()
      // ponytail: 切换会话清空勾选态 + 已提交记录，避免上一会话的勾选串台到新会话
      suggestionChecksRef.current = {}
      submittedChecksRef.current = {}
      scrollToBottom()
    }

    if (cached && cached.updatedAt === serverUpdatedAt && serverUpdatedAt > 0) {
      // ponytail: 旧版本缓存的消息缺 coverUrl（缩略图字段后加），命中时补算并回写缓存，只算缺失项
      let cacheDirty = false
      cached.messages.forEach((msg: Message) => {
        if (msg.products) {
          msg.products.forEach((p: ProductItem) => {
            if (p.coverUrl === undefined) {
              p.coverUrl = resolveProductCover(p.images)
              cacheDirty = true
            }
          })
        }
      })
      if (cacheDirty) Taro.setStorageSync(cacheKey, { messages: cached.messages, updatedAt: serverUpdatedAt })
      // 本地缓存 + updatedAt 一致 → 直接用，不发请求
      restoreFromCache(cached.messages)
      touchConvCacheLRU(convId)  // 更新 LRU 顺序
      return
    }

    // 无缓存 或 updatedAt 不一致 → 拉后端
    get(`/conversations/${convId}/messages`)
      .then((res: any) => {
        const items = (res && res.items) || []
        if (!items.length) return
        // ponytail: 后端 ui_messages 已包含完整前端结构（role/contentType/text/plans/merchants/followUpPills），
        // 直接复用，不再强制转 text，切换会话后卡片不丢失。
        const msgs: Message[] = items.map((msg: any) => {
          const role = msg.role === 'assistant' ? 'ai' : (msg.role === 'user' ? 'user' : msg.role)
          // 恢复产品选中状态（product-card 多选）
          const products = msg.products || null
          const selectedIds = msg.selectedProductIds || []
          if (products) {
            products.forEach((p: ProductItem) => {
              p.selected = selectedIds.indexOf(p.id) >= 0
              p.coverUrl = resolveProductCover(p.images)  // 卡片缩略图（第一张非 PDF 图）
            })
          }
          // ponytail: 历史消息文本仍含 {{activity:id}} 占位符（后端存原始 draft），
          // 恢复时同样剥离 + 解析出 activityIds 渲染卡片
          const restored = stripActivityRefs(msg.text !== undefined ? msg.text : (msg.content || ''))
          return {
            role,
            text: restored.text,
            // ponytail: 恢复产品咨询卡片（后端 ui_messages 存盘后切回不丢失）
            productRef: msg.productRef || null,
            contentType: msg.contentType || 'text',
            needsTip: msg.needsTip || '',
            planTip: msg.planTip || '',
            merchantTip: msg.merchantTip || '',
            plans: msg.plans || null,
            merchants: normalizeMerchants(msg.merchants),
            products,
            selectedProductIds: selectedIds.length ? selectedIds : null,
            missingSlots: msg.missingSlots || [],
            followUpPills: msg.followUpPills || [],
            // ponytail: 切换会话后恢复 suggestions/followUps 卡片（ui_messages 已存盘）；勾选态不持久，重置为空对象
            suggestions: msg.suggestions || [],
            followUps: msg.followUps || [],
            checkedMap: {},
            messageId: msg.messageId || '',
            thinking: msg.thinking || [],
            thinkingCollapsed: !!(msg.thinking && msg.thinking.length),
            loading: false,
            streaming: false,
            activityIds: restored.ids,
            // 拍照看效果消息恢复字段（后端 _merge_preview_messages 实时下发状态）
            image: msg.image || '',
            status: msg.status || '',
            resultImage: msg.resultImage || '',
            productName: msg.productName || '',
            taskId: msg.taskId || ''  // 本地持久化文件按 taskId 查找（restorePreviewLocalImages）
          }
        })
        restoreFromCache(msgs)
        // 拍照看效果：恢复 processing 中的生图轮询（任务在后端继续跑，不因切走而断）
        resumePendingPreview()
        // ponytail: 更新本地消息缓存——切走再切回来不用重新拉
        Taro.setStorageSync(cacheKey, { messages: msgs, updatedAt: serverUpdatedAt })
        touchConvCacheLRU(convId)  // 更新 LRU 顺序 + 淘汰超限缓存
      })
      .catch(() => {
        // 静默失败：网络异常等，会话仍可正常使用
      })
  }

  function onDrawerNav(path: string) {
    setDrawerVisible(false)
    Taro.navigateTo({ url: `/pages/${path}/index` })
  }

  function scrollToBottom() {
    // ponytail: 用户触摸过滚动区则暂停自动滚动（翻阅历史时不被拉回底部；
    // 也避免开发工具动画滚动期吞点击）。发新消息/切换会话时重置。
    if (userScrollingRef.current) return
    // ponytail: setState 是异步，用 nextTick 确保渲染后再滚动；
    // 再补一次延迟滚动，防止 thinking 面板展开后布局变化导致第一次滚动不到位。
    Taro.nextTick(() => {
      setScrollIntoView('bottom-anchor')
      setTimeout(() => setScrollIntoView('bottom-anchor'), 80)
    })
  }

  // 用户触摸聊天滚动区：暂停自动滚动（流式输出时可翻阅历史，不被拉回底部）
  function onChatTouch() {
    if (userScrollingRef.current) return
    userScrollingRef.current = true
  }

  // ─── 活动轮播抽屉 ───
  // 拉取完成（含失败无缓存）通知：无活动时收起抽屉容器
  function onActivitiesReady(detail: { hasItems: boolean; count: number }) {
    setHasActivities(!!(detail && detail.hasItems))
  }

  // 轮播实际渲染模式（banner 纯图 422 / card 图+文 542），抽屉高度跟随，避免裁掉卡片文字
  function onActivityCardMode(detail: { mode: 'card' | 'banner' }) {
    const mode = (detail && detail.mode) || 'card'
    setActivityCardMode((prev) => (prev === mode ? prev : mode))
  }

  function onDrawerTouchStart(e: any) {
    const touch = e.touches && e.touches[0]
    if (!touch) return
    drawerTouchRef.current = { x: touch.clientX, y: touch.clientY, moved: false }
  }

  function onDrawerTouchMove(e: any) {
    if (!drawerTouchRef.current) return
    const touch = e.touches && e.touches[0]
    if (!touch) return
    const deltaX = Math.abs(touch.clientX - drawerTouchRef.current.x)
    const deltaY = Math.abs(touch.clientY - drawerTouchRef.current.y)
    // 横向位移超过纵向 → 视为 swiper 横滑或其他水平操作，标记不再触发行程
    if (deltaX > deltaY && deltaX > 20) {
      drawerTouchRef.current.moved = true
    }
  }

  function onDrawerTouchEnd(e: any) {
    if (!drawerTouchRef.current) return
    if (drawerTouchRef.current.moved) { drawerTouchRef.current = null; return }
    const touch = e.changedTouches && e.changedTouches[0]
    if (!touch) return
    const deltaX = touch.clientX - drawerTouchRef.current.x
    const deltaY = touch.clientY - drawerTouchRef.current.y
    drawerTouchRef.current = null

    // 横向位移 > 纵向 → 忽略（swiper 横滑、按钮点击等）
    if (Math.abs(deltaX) > Math.abs(deltaY)) return
    // 点击（位移太小）不触发
    if (Math.abs(deltaY) < 30) return
    // 无活动时不响应手势
    if (!hasActivities) return

    if (deltaY < 0) {
      // 上滑 → 折叠（仅本次停留生效，不持久化——每次进首页默认展开）
      setDrawerExpanded(false)
    } else {
      // 下滑 → 展开
      setDrawerExpanded(true)
    }
  }

  // 每次回到首页（含 tab 切回）抽屉默认展开，与活动卡片会话级显隐语义一致
  useDidShow(() => {
    // 抖音端：隐藏原生导航栏左上角的「回首页」胶囊——平台控件，无法移动/改功能，
    // hideHomeButton 隐藏后左上角仅剩本页 menu 悬浮球。
    // ponytail: Taro 对该 API 的 promise 化包装在 fail 时始终 reject（即使传了 fail 回调），
    // 不接住会刷 unhandledRejection；本调用在无回首页按钮时必然失败，静默吞掉
    if (process.env.TARO_ENV === 'tt') {
      ;(Taro as any).hideHomeButton({ fail: () => {} })?.catch?.(() => {})
    }
    setDrawerExpanded(true)
    // 恢复被 useDidHide 回收的生图轮询（任务在后端继续跑；第一 tick 必得终态不空转）
    resumePendingPreview()
  })

  // 关闭分享卡片弹层
  function closeShareCard() {
    setShareCard(null)
  }

  return (
    <View className={`chat-page ${drawerVisible ? 'drawer-open' : ''}`}>
      <View className='chat-main'>
        {drawerVisible ? <View className='main-overlay' catchMove onClick={closeDrawer} /> : null}
        {slotsDrawerVisible ? <View className='main-overlay' catchMove onClick={closeSlotsDrawer} /> : null}

        <TopNav brand onMenu={openDrawer} onNewChat={resetChat} />

        {/* 抖音端：自定义导航栏权限未通过期间，原生导航栏由平台渲染，
            对话管理入口用左上角悬浮球（权限通过后 TT_NAV_CUSTOM_APPROVED=true 自动消失，换 TopNav） */}
        {process.env.TARO_ENV === 'tt' && !TT_NAV_CUSTOM_APPROVED ? (
          <View className='menu-fab' onClick={openDrawer}>
            <Text className='adwicon menu-fab-icon adwicon-bars'>{''}</Text>
          </View>
        ) : null}

        {/* 活动轮播抽屉（空状态时显示，顶部贴导航栏，左右贴屏幕边） */}
        {!hasStarted && hasActivities ? (
          <View
            className={`activity-drawer ${drawerExpanded ? (activityCardMode === 'card' ? 'expanded expanded-card' : 'expanded') : 'collapsed'}`}
            onTouchStart={onDrawerTouchStart}
            onTouchMove={onDrawerTouchMove}
            onTouchEnd={onDrawerTouchEnd}
          >
            <ActivityCarousel
              position='home'
              mode='banner'
              size='lg'
              closeable={false}
              displayMultipleItems={1}
              onReady={onActivitiesReady}
              onModeChange={onActivityCardMode}
            />
          </View>
        ) : null}

        <ScrollView
          className='chat-scroll'
          scrollY
          scrollWithAnimation
          scrollIntoView={scrollIntoView}
          onTouchStart={onChatTouch}
        >
          {!hasStarted ? (
            <View
              className={`empty-state ${drawerExpanded && hasActivities ? 'drawer-open' : ''}`}
              onTouchStart={onDrawerTouchStart}
              onTouchMove={onDrawerTouchMove}
              onTouchEnd={onDrawerTouchEnd}
            >
              <View className='brand-logo' hoverClass='brand-logo-hover' hoverStayTime={80} onClick={goProducts}>
                <Text className='adwicon brand-icon adwicon-house'>{''}</Text>
                <Text className='brand-logo-badge'>逛产品</Text>
              </View>
              <Text className='empty-title'>有什么可以帮您的？</Text>
              <View className='quick-pills'>
                <View className='quick-pill' onClick={() => startChat('knowledge')}>
                  <Text className='adwicon pill-icon adwicon-check'>{''}</Text>
                  <Text>知识咨询</Text>
                </View>
                <View className='quick-pill' onClick={() => startChat('purchase')}>
                  <Text className='adwicon pill-icon adwicon-bolt'>{''}</Text>
                  <Text>选购方案</Text>
                </View>
                <View className='quick-pill' onClick={() => startChat('merchant')}>
                  <Text className='adwicon pill-icon adwicon-shop'>{''}</Text>
                  <Text>找商家</Text>
                </View>
              </View>
              <Text className='empty-hint'>{'我可以帮您了解门窗知识、\n制定安装方案或推荐商家。'}</Text>
            </View>
          ) : (
            <View className='chat-messages'>
              {messages.map((item, index) => {
                if (item.role === 'user') {
                  return <ChatBubbleUser key={index} text={item.text} productRef={item.productRef} image={item.image} />
                }

                // AI 消息各 contentType 渲染分支
                const isText = item.contentType === 'text' || item.contentType === 'error' || !item.contentType
                const showText = item.loading && !item.text && (!item.thinking || !item.thinking.length)
                  ? '正在思考中…'
                  : item.text

                // 流式光标（streaming 且有 text 时显示）
                const cursor = item.streaming ? <View className='typing-cursor' /> : null

                // 思考/折叠/操作按钮/建议勾选/追问 共享 props
                const aiCommonProps = {
                  text: showText,
                  messageId: item.messageId,
                  showActions: !item.streaming,
                  thinking: item.thinking,
                  thinkingCollapsed: item.thinkingCollapsed,
                  onThinkingToggle,
                  suggestions: item.suggestions || [],
                  checkedMap: item.checkedMap || {},
                  onSuggestionToggle,
                  followUps: item.followUps || [],
                  onFollowUpTap,
                  activityIds: item.activityIds || []
                }

                if (isText) {
                  return (
                    <ChatBubbleAi key={index} {...aiCommonProps}>
                      {cursor}
                    </ChatBubbleAi>
                  )
                }

                if (item.contentType === 'preview_result') {
                  // 拍照看效果：AI 效果图消息（生成中/已生成/失败）；微信端用 touchstart 模拟按压文字态，
                  // Taro 端简化为直接点击图标（ponytail: H5/TT 按钮本有 hover 态）
                  return (
                    <ChatBubbleAi key={index} {...aiCommonProps} showActions={false}>
                      {item.status === 'done' && item.resultImage ? (
                        <View className='preview-result-card'>
                          <Image
                            className='preview-result-img'
                            src={item.resultImage}
                            mode='widthFix'
                            lazyLoad
                            onClick={() => onPreviewImageTap(item.resultImage!)}
                          />
                          <View className='preview-save-row'>
                            <Text className='preview-save-hint'>图片保留 7 天</Text>
                            <View className='preview-save-btn' onClick={() => onEditPreviewImage(item.taskId || '', item.resultImage!)}>
                              <Text className='adwicon preview-btn-icon adwicon-edit'>{''}</Text>
                            </View>
                            <View className='preview-save-btn' onClick={() => onSavePreviewImage(item.resultImage!)}>
                              <Text className='adwicon preview-btn-icon adwicon-plus'>{''}</Text>
                            </View>
                          </View>
                        </View>
                      ) : item.status === 'processing' ? (
                        <View className='preview-generating'>
                          <View className='preview-spinner' />
                          <Text className='preview-generating-text'>AI 正在生成效果图，约需 1~2 分钟</Text>
                        </View>
                      ) : item.status === 'failed' && item.taskId ? (
                        <View className='preview-failed-row'>
                          <View className='preview-retry-btn' onClick={() => onPreviewRetry(item.taskId!)}>重新生成</View>
                        </View>
                      ) : null}
                    </ChatBubbleAi>
                  )
                }

                if (item.contentType === 'follow_up') {
                  return (
                    <ChatBubbleAi key={index} {...aiCommonProps}>
                      {cursor}
                      {item.followUpPills && item.followUpPills.length > 0 ? (
                        <View className='follow-up-pills'>
                          {item.followUpPills.map((pill) => (
                            <View
                              key={pill.slot}
                              className='follow-up-pill'
                              onClick={() => onPillTap(pill.label)}
                            >
                              <Text>{pill.label}</Text>
                            </View>
                          ))}
                        </View>
                      ) : null}
                    </ChatBubbleAi>
                  )
                }

                if (item.contentType === 'plans' && item.plans) {
                  return (
                    <ChatBubbleAi key={index} {...aiCommonProps} planTip={item.planTip}>
                      {cursor}
                      <ScrollView className='plan-scroll' scrollX enableFlex>
                        <View className='plan-list'>
                          {item.plans.map((plan) => (
                            <PlanCard
                              key={plan.id}
                              itemId={plan.id}
                              title={plan.title}
                              status={plan.status}
                              windowCount={plan.windowCount}
                              estimatedPrice={plan.estimatedPrice || plan.totalEstimate}
                              material={plan.material}
                              area={plan.area}
                              isCompact
                              onView={(d) => onPlanView(d.id)}
                              onSubmit={(d) => onPlanSubmit(d.id)}
                            />
                          ))}
                        </View>
                      </ScrollView>
                    </ChatBubbleAi>
                  )
                }

                if (item.contentType === 'products' && item.products) {
                  return (
                    <ChatBubbleAi key={index} {...aiCommonProps} needsTip={item.needsTip}>
                      {cursor}
                      <ScrollView className='plan-scroll' scrollX enableFlex>
                        <View className='plan-list'>
                          {item.products.map((product, pIdx) => (
                            <ProductCard
                              key={product.id}
                              name={product.name}
                              series={product.series}
                              budget={product.budget}
                              material={product.material}
                              priceRange={product.price_range}
                              cover={product.coverUrl}
                              intro={product.intro}
                              concerns={product.concerns}
                              openingTypes={product.opening_types}
                              glassOptions={product.glass_options}
                              selected={product.selected}
                              msgIndex={index}
                              pIdx={pIdx}
                              onToggle={onProductToggle}
                              onDetail={onProductDetail}
                            />
                          ))}
                        </View>
                      </ScrollView>
                    </ChatBubbleAi>
                  )
                }

                if (item.contentType === 'merchants' && item.merchants) {
                  return (
                    <ChatBubbleAi key={index} {...aiCommonProps} merchantTip={item.merchantTip}>
                      {cursor}
                      <ScrollView className='plan-scroll' scrollX enableFlex>
                        <View className='plan-list'>
                          {item.merchants.map((merchant) => (
                            <MerchantCard
                              key={merchant.id}
                              itemId={merchant.id}
                              photo={merchant.photo}
                              name={merchant.name}
                              rating={merchant.rating}
                              matchReason={merchant.matchReason}
                              distance={merchant.region}
                              phone={merchant.phone}
                              tags={merchant.tags}
                              warrantyYears={merchant.warranty_years}
                              installerType={merchant.installer_type}
                              years={merchant.years}
                              fixed
                              showReview
                              onContact={onMerchantContact}
                              onReview={onMerchantReview}
                              onView={(d) => onMerchantView(d.id)}
                            />
                          ))}
                        </View>
                      </ScrollView>
                    </ChatBubbleAi>
                  )
                }

                // 兜底（含 knowledge 等）
                return (
                  <ChatBubbleAi key={index} {...aiCommonProps}>
                    {cursor}
                  </ChatBubbleAi>
                )
              })}

              <View id='bottom-anchor' className='bottom-anchor' />
            </View>
          )}
        </ScrollView>

        {/* ponytail: 需求清单入口——左下角悬浮按钮，仅已有会话且两个抽屉都关闭时显示 */}
        {conversationId && !drawerVisible && !slotsDrawerVisible ? (
          <View className='slots-fab' onClick={openSlotsDrawer}>
            <Text className='adwicon slots-fab-icon adwicon-list-check'>{''}</Text>
          </View>
        ) : null}
        <InputBar
          ref={inputBarRef}
          disabled={sending}
          sending={sending}
          pendingImage={pendingImage}
          onSubmit={sendMessage}
          onStop={stopGeneration}
          onCamera={onCameraTap}
          onRemoveImage={onRemoveImage}
          onVoice={onVoiceTap}
        />
        {/* 拍照看效果：产品选择弹窗（选品后组装提示词注入输入框） */}
        <ProductPicker
          visible={pickerVisible}
          products={pickerProducts}
          selectedId={selectedProductId}
          onSelect={onPickerSelect}
          onClose={onPickerClose}
          onGoProducts={onPickerGoProducts}
        />
        {/* 语音通话全屏层：动效自订阅 voice-session，页面只收挂断事件做收尾 */}
        <VoiceCall visible={voiceCallVisible} onHangup={onVoiceHangup} />
      </View>

      <View className='conversation-drawer'>
        <ConversationDrawer
          ref={drawerRef}
          visible={drawerVisible}
          onClose={closeDrawer}
          onNav={onDrawerNav}
          onSelect={onDrawerSelect}
          onRename={onRenameConversation}
          onDelete={onDeleteConversation}
          onNewChat={resetChat}
        />
      </View>

      <SlotsDrawer
        ref={slotsDrawerRef}
        visible={slotsDrawerVisible}
        conversationId={conversationId}
        onClose={closeSlotsDrawer}
      />

      {/* 分享卡片弹层：接收者打开分享链接时展示分享者转发的那条 AI 回复，可关闭 */}
      {shareCard ? (
        <View className='share-mask' onClick={closeShareCard}>
          <View className='share-card' catchMove>
            <View className='share-card-header'>
              <Text className='share-card-title'>来自好友分享</Text>
              <View className='share-card-close' onClick={closeShareCard}>
                <Text className='adwicon share-close-icon adwicon-close-filled'>{''}</Text>
              </View>
            </View>
            <ScrollView className='share-card-body' scrollY enhanced showScrollbar={false}>
              <MarkdownView content={shareCard} />
            </ScrollView>
            <View className='share-card-footer'>你也可以直接提问门窗问题</View>
          </View>
        </View>
      ) : null}
    </View>
  )
}
