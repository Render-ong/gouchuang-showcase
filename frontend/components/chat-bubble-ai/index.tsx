import { View, Text, Button } from '@tarojs/components'
import Taro from '@tarojs/taro'
import { useState, useEffect, useMemo, type ReactNode } from 'react'
import MarkdownView from '../markdown-view'
import { toCopyText } from '../../utils/markdown'
import ActivityCard from '../activity-card'
import { setClipboardSafe } from '../../utils/cross-platform'
import { trackFavoritePending } from '../../services/favorites-sync'
import { loadIconFont } from '../../utils/icon-font'
import './index.scss'

// ponytail: 收藏存本地 storage（全量，做离线兜底）按 messageId 去重；
// 变更同时记 pending 队列，由 favorites-sync.ts 批量同步后端（跨设备拉回）
const FAVORITES_KEY = 'adw_favorites'
// 赞/踩反馈本地缓存：{ messageId: {messageId, feedback, aiText, createdAt} }
// 与 favorites 同策略——点按写 storage，登录后/冷启动由 feedback-sync.ts 批量上传后端
const FEEDBACK_KEY = 'adw_feedback'

export interface ThinkingStep {
  status: 'running' | 'done'
  label: string
  detail?: string
}

export interface Suggestion {
  id: string
  text: string
}

export interface ChatBubbleAiProps {
  text?: string
  messageId?: string | null
  // 流式输出时不显示操作按钮，完成后由父页传 true
  showActions?: boolean
  // 节点级思考进度数组
  thinking?: ThinkingStep[]
  // true=折叠为一行摘要；false=展开显示各步骤
  thinkingCollapsed?: boolean
  onThinkingToggle?: (messageId: string) => void
  onFavoriteChange?: (messageId: string, isFavorite: boolean) => void
  // 本轮 AI 回复提取的可采纳建议 [{id, text}]
  // ponytail: 建议类 intent 才有值，前端渲染勾选按钮，勾选后由父页累积到 acceptedSuggestions
  suggestions?: Suggestion[]
  // 本消息的建议勾选态快照（按 suggestion.id → bool），由父页下发
  // ponytail: 不在组件内部存勾选态——组件销毁/复用时状态丢失；统一由父页管理 + 下发
  checkedMap?: Record<string, boolean>
  // 勾选/取消建议时上抛：messageId + suggestion
  onSuggestionToggle?: (messageId: string, suggestion: Suggestion) => void
  // 需求提示句（"产品是根据您的需求匹配的…"），done 后由 chat 页从 text 剥离单独渲染醒目提示条
  needsTip?: string
  // 方案引导句（"点击方案卡片即可查看方案详情…"），done 后由 chat 页从 text 剥离单独渲染绿色提示条
  planTip?: string
  // 商家返现提示句（"若与商家达成合作…"），done 后由 chat 页从 text 剥离单独渲染紫色提示条
  merchantTip?: string
  // ponytail: 追问推荐——done 后异步推送的 follow_ups 事件更新，点击直接发送（不累积不采纳）
  // 与 suggestions 区别：suggestions 是"AI 给用户的建议"（勾选累积下轮提交），
  // followUps 是"用户可能问的问题"（点击即发，当作新用户输入）
  followUps?: string[]
  onFollowUpTap?: (text: string) => void
  // 活动卡片 id 列表：回复文本中 {{activity:id}} 占位符解析结果，done 后渲染在正文下方
  activityIds?: string[]
  children?: ReactNode
}

export default function ChatBubbleAi({
  text = '',
  messageId = '',
  showActions = false,
  thinking = [],
  thinkingCollapsed = false,
  onThinkingToggle,
  onFavoriteChange,
  suggestions = [],
  checkedMap = {},
  onSuggestionToggle,
  needsTip = '',
  planTip = '',
  merchantTip = '',
  followUps = [],
  onFollowUpTap,
  activityIds = [],
  children
}: ChatBubbleAiProps) {
  // 字体兜底（app.tsx 已在 tt 端启动时加载，此处幂等补齐——抖音端 app 期 loadFontFace
  // 偶发不生效，需页面上下文调用；操作栏图标最密集的组件就是它）
  useEffect(() => { if (process.env.TARO_ENV === 'tt') loadIconFont() }, [])
  const [isFavorite, setIsFavorite] = useState(false)
  // 赞/踩反馈状态：从本地缓存恢复（与收藏同策略，storage 按 messageId 存取，组件内部闭环）
  const [feedback, setFeedback] = useState('')

  useEffect(() => {
    if (!messageId) return
    const favorites = Taro.getStorageSync(FAVORITES_KEY) || []
    setIsFavorite(favorites.some((f: any) => f.messageId === messageId))
    const fbMap = Taro.getStorageSync(FEEDBACK_KEY) || {}
    setFeedback(fbMap[messageId] ? fbMap[messageId].feedback : '')
  }, [messageId])

  // ponytail: 父页下发的勾选态变化时，重算 hasChecked/checkedCount 给 UI 用
  const { hasChecked, checkedCount } = useMemo(() => {
    let count = 0
    if (checkedMap && typeof checkedMap === 'object') {
      for (const k in checkedMap) {
        if (checkedMap[k]) count++
      }
    }
    return { hasChecked: count > 0, checkedCount: count }
  }, [checkedMap])

  function onCopy() {
    if (!text) return
    // ponytail: 小程序端系统自带"内容已复制"toast；H5 端走 navigator.clipboard，需手动提示
    // 图片语法转「（图：alt）」——原文进剪贴板会把图床 URL 暴露给用户
    setClipboardSafe(toCopyText(text))
      .then(() => {
        if (process.env.TARO_ENV === 'h5') {
          Taro.showToast({ title: '已复制', icon: 'none', duration: 1000 })
        }
      })
      .catch(() => Taro.showToast({ title: '复制失败', icon: 'none' }))
  }

  function onThinkingTap() {
    if (onThinkingToggle && messageId) {
      onThinkingToggle(messageId)
    }
  }

  function onFavorite() {
    if (!messageId) {
      Taro.showToast({ title: '当前消息无法收藏', icon: 'none' })
      return
    }
    if (!text) return

    const favorites = Taro.getStorageSync(FAVORITES_KEY) || []
    const idx = favorites.findIndex((f: any) => f.messageId === messageId)
    let newIsFavorite: boolean
    if (idx >= 0) {
      favorites.splice(idx, 1)
      newIsFavorite = false
      Taro.showToast({ title: '已取消收藏', icon: 'none', duration: 1000 })
    } else {
      favorites.unshift({
        messageId,
        text,
        createdAt: Date.now()
      })
      newIsFavorite = true
      Taro.showToast({ title: '已收藏', icon: 'success', duration: 1000 })
    }
    Taro.setStorageSync(FAVORITES_KEY, favorites)
    // 记录待上传变更（app 层在登录/切后台/冷启动/退出登录时批量同步后端）
    trackFavoritePending(
      messageId,
      newIsFavorite,
      newIsFavorite ? { messageId, text, createdAt: Date.now() } : undefined
    )
    setIsFavorite(newIsFavorite)
    if (onFavoriteChange) onFavoriteChange(messageId, newIsFavorite)
  }

  // 赞/踩反馈：同向再点取消、反向切换；写本地缓存（feedback-sync 批量上报，协议同 mp）
  function onThumb(e: any) {
    const fb = (e.currentTarget.dataset && e.currentTarget.dataset.fb === 'up') ? 'up' : 'down'
    if (!messageId) {
      Taro.showToast({ title: '当前消息无法反馈', icon: 'none' })
      return
    }
    if (!text) return
    const map = Taro.getStorageSync(FEEDBACK_KEY) || {}
    const now = feedback === fb ? '' : fb
    if (now) {
      map[messageId] = { messageId, feedback: now, aiText: text, createdAt: Date.now() }
    } else {
      delete map[messageId]
    }
    if (Object.keys(map).length) Taro.setStorageSync(FEEDBACK_KEY, map)
    else Taro.removeStorageSync(FEEDBACK_KEY)
    setFeedback(now)
  }

  // 点击建议勾选按钮：上抛 messageId + suggestion（id/text）给父页
  // ponytail: 勾选态由父页管理（统一累积，下一条消息发送时提交）；组件只负责上抛事件
  function handleSuggestionToggle(sug: Suggestion) {
    if (!sug || !sug.id) return
    if (onSuggestionToggle && messageId) {
      onSuggestionToggle(messageId, sug)
    }
  }

  // ponytail: 建议条数限制 5 条（reasoner prompt 已要求，组件兜底切片防溢出）
  const displaySuggestions = suggestions.slice(0, 5)

  return (
    <View className='bubble-ai'>
      <View className='ai-avatar'>
        <Text className='adwicon ai-avatar-icon adwicon-robot'>{''}</Text>
      </View>
      <View className='bubble-ai-content'>
        {/* 思考过程流：放在头像右侧，折叠时与头像同行 */}
        {thinking.length > 0 && (
          <View
            className={`thinking-stream ${thinkingCollapsed ? 'collapsed' : ''}`}
            onClick={onThinkingTap}
          >
            <View className='thinking-stream-header'>
              <Text className={`thinking-stream-dot ${thinkingCollapsed ? '' : 'pulse'}`}>
                {''}
              </Text>
              <Text className='thinking-stream-title'>
                {thinkingCollapsed ? '已思考' : '正在思考'}
              </Text>
              {thinkingCollapsed && (
                <Text className='thinking-stream-count'>{thinking.length} 步</Text>
              )}
              <Text className='thinking-stream-chevron'>
                {thinkingCollapsed ? '▾' : '▴'}
              </Text>
            </View>
            {!thinkingCollapsed && (
              <View className='thinking-stream-body'>
                {thinking.map((step, idx) => (
                  <View key={idx} className={`thinking-step-item ${step.status}`}>
                    <View className='thinking-step-marker'>
                      {step.status === 'running' ? (
                        <View className='thinking-step-spinner' />
                      ) : (
                        <Text className='thinking-step-check'>✓</Text>
                      )}
                    </View>
                    <View className='thinking-step-content'>
                      <Text className='thinking-step-label'>{step.label}</Text>
                      {step.detail && (
                        <View className='thinking-step-detail'>{step.detail}</View>
                      )}
                    </View>
                  </View>
                ))}
              </View>
            )}
          </View>
        )}

        {/* ponytail: 流式输出时用纯 text，避免每个 token 都触发 markdown 全量解析卡死（尤其表格）。
             done 到达后 showActions=true，切换到 markdown-view 一次性渲染格式化内容。 */}
        {text && !showActions ? (
          <Text className='bubble-ai-text-raw'>{text}</Text>
        ) : text ? (
          <View className='bubble-ai-text'>
            <MarkdownView content={text} />
          </View>
        ) : null}

        {/* ponytail: 需求提示条——product_match/product_intro 的"产品是根据您的需求匹配的"固定提示
             done 后由 chat 页剥离到 needsTip 单独渲染，浅琥珀底 + 琥珀橙左竖线强调 */}
        {needsTip ? (
          <View className='needs-tip'>
            <Text className='needs-tip-text' userSelect selectable>{needsTip}</Text>
          </View>
        ) : null}

        {/* ponytail: 方案引导条——plan_generator 的"点击方案卡片即可查看方案详情"固定引导
             done 后由 chat 页剥离到 planTip 单独渲染，浅绿底 + 绿色左竖线强调 */}
        {planTip ? (
          <View className='plan-tip'>
            <Text className='plan-tip-text' userSelect selectable>{planTip}</Text>
          </View>
        ) : null}

        {/* ponytail: 商家返现提示条——merchant_match 推荐文案尾部固定句
             done 后由 chat 页剥离到 merchantTip 单独渲染，浅紫底 + 紫色左竖线强调 */}
        {merchantTip ? (
          <View className='merchant-tip'>
            <Text className='merchant-tip-text' userSelect selectable>{merchantTip}</Text>
          </View>
        ) : null}

        {children}

        {/* 活动卡片：回复文本中 {{activity:id}} 占位符解析结果，done 后渲染在正文下方 */}
        {showActions && activityIds.length > 0 && (
          <View className='activity-cards'>
            {activityIds.map((aid) => (
              <ActivityCard key={aid} activityId={aid} size='sm' />
            ))}
          </View>
        )}

        {/* 可采纳建议：仅在非流式 + 有建议时显示 */}
        {showActions && displaySuggestions.length > 0 && (
          <View className='suggestions-box'>
            <View className='suggestions-header'>
              <Text className='adwicon suggestions-icon adwicon-check'>{''}</Text>
              <Text className='suggestions-title'>可采纳的建议</Text>
            </View>
            <View className='suggestions-list'>
              {displaySuggestions.map((sug) => (
                <View
                  key={sug.id}
                  className={`suggestion-chip ${checkedMap[sug.id] ? 'checked' : ''}`}
                  onClick={() => handleSuggestionToggle(sug)}
                >
                  <View className='suggestion-checkbox'>
                    {checkedMap[sug.id] && (
                      <Text className='adwicon suggestion-check-icon adwicon-check'>{''}</Text>
                    )}
                  </View>
                  <Text className='suggestion-text'>{sug.text}</Text>
                </View>
              ))}
            </View>
            <View className='suggestions-hint'>
              {!hasChecked ? (
                <Text className='suggestions-hint-text'>勾选后将在下一条消息发送时采纳</Text>
              ) : (
                <Text className='suggestions-hint-text suggestions-hint-active'>
                  已勾选 {checkedCount} 条，发送消息时将一并采纳
                </Text>
              )}
            </View>
          </View>
        )}

        {/* ponytail: 追问推荐——done 后异步推送，点击直接发送（不累积不采纳，与 suggestions 语义不同）
             放在 suggestions 后：看完回复→可采纳建议→追问引导的视觉顺序 */}
        {showActions && followUps.length > 0 && (
          <View className='follow-ups-box'>
            <View className='follow-ups-list'>
              {followUps.map((fu, idx) => (
                <View
                  key={idx}
                  className='follow-up-chip'
                  hoverClass='follow-up-chip-hover'
                  onClick={() => onFollowUpTap && fu && onFollowUpTap(fu)}
                >
                  <Text className='follow-up-text'>{fu}</Text>
                  <Text className='adwicon follow-up-icon adwicon-paper-plane'>{''}</Text>
                </View>
              ))}
            </View>
          </View>
        )}

        {/* 操作按钮组：仅在非流式（已完成）且父组件允许时显示 */}
        {showActions && text && (
          <View className='bubble-actions'>
            <View className='actions-group actions-group-left'>
              <View className='action-btn' hoverClass='action-btn-hover' onClick={onCopy}>
                <Text className='adwicon action-icon adwicon-clipboard'>{''}</Text>
                <Text className='action-label'>复制</Text>
              </View>
              {/* 分享：button open-type="share" 触发页面 onShareAppMessage。
                   data-message-id 携带本条消息 id → 页面 useShareAppMessage 读 res.target.dataset 精确分享单条 AI 回复（cid+mid） */}
              <Button
                className='action-btn action-btn-share'
                openType='share'
                hoverClass='action-btn-hover'
                data-message-id={messageId}
                plain
              >
                <Text className='adwicon action-icon adwicon-share'>{''}</Text>
                <Text className='action-label'>分享</Text>
              </Button>
            </View>
            <View className='actions-group'>
              <View className='action-btn' hoverClass='action-btn-hover' onClick={onFavorite}>
                <Text
                  className={`adwicon action-icon adwicon-heart ${isFavorite ? 'is-favorited' : ''}`}
                >
                  {''}
                </Text>
                <Text className='action-label'>{isFavorite ? '已收藏' : '收藏'}</Text>
              </View>
              {/* 赞/踩反馈：本地缓存（adw_feedback），登录后/冷启动由 feedback-sync 批量上报后端 */}
              <View className='action-btn' hoverClass='action-btn-hover' onClick={onThumb} data-fb='up'>
                <Text className={`adwicon action-icon adwicon-thumb-up ${feedback === 'up' ? 'is-thumb-active' : ''}`}>{''}</Text>
                <Text className='action-label'>赞</Text>
              </View>
              <View className='action-btn thumb-down' hoverClass='action-btn-hover' onClick={onThumb} data-fb='down'>
                <Text className={`adwicon action-icon adwicon-thumb-down ${feedback === 'down' ? 'is-thumb-active' : ''}`}>{''}</Text>
                <Text className='action-label'>踩</Text>
              </View>
            </View>
          </View>
        )}
      </View>
    </View>
  )
}
