import { View, Text } from '@tarojs/components'
import './index.scss'

const STATUS_MAP: Record<string, string> = {
  draft: '草稿',
  submitted: '已提交',
  matched: '已匹配'
}

export interface PlanCardProps {
  // ponytail: 用 itemId 而非 id——事件回调仍以 id 为 key
  itemId?: string
  title?: string
  status?: string
  windowCount?: number | string
  estimatedPrice?: string
  material?: string
  // ─── 手动修改用：可编辑字段（对齐后端 _MODIFIABLE_FIELDS 白名单） ───
  area?: string
  glassChoice?: string
  openingType?: string
  roomType?: string
  isCompact?: boolean
  onView?: (detail: { id: string }) => void
  onSubmit?: (detail: { id: string }) => void
  // matched 状态：查看该方案提交时匹配到的商家列表
  onViewMerchants?: (detail: { id: string }) => void
  // 长按卡片删除方案（与对话管理页长按删除交互一致）
  onLongPressDelete?: (detail: { id: string }) => void
  // 显式删除按钮（方案页操作区，比长按更易发现；确认逻辑在页面层）
  onDelete?: (detail: { id: string }) => void
  // 评价签约商家（matched 方案）
  onReview?: (detail: { id: string }) => void
}

export default function PlanCard({
  itemId = '',
  title = '',
  status = 'draft',
  windowCount = '',
  estimatedPrice = '',
  material = '',
  area = '',
  isCompact = false,
  onView,
  onSubmit,
  onViewMerchants,
  onLongPressDelete,
  onDelete,
  onReview
}: PlanCardProps) {
  const statusText = STATUS_MAP[status || 'draft'] || status

  return (
    <View
      className={`plan-card ${isCompact ? 'plan-card-compact' : ''}`}
      onLongPress={() => onLongPressDelete && onLongPressDelete({ id: itemId })}
    >
      <View className='plan-card-header'>
        <Text className='plan-title'>{title}</Text>
        <View className={`status-badge status-${status}`}>
          <Text className='status-text'>{statusText}</Text>
        </View>
      </View>

      <View className='plan-info'>
        <View className='info-row'>
          <Text className='info-label'>门窗数量</Text>
          <Text className='info-value'>{windowCount || '—'} 樘</Text>
        </View>
        <View className='info-row'>
          <Text className='info-label'>封窗面积</Text>
          <Text className='info-value'>{area || '—'}</Text>
        </View>
        <View className='info-row'>
          <Text className='info-label'>主要材质</Text>
          <Text className='info-value'>{material || '—'}</Text>
        </View>
        <View className='info-row info-row-price'>
          <Text className='info-label'>预估总价</Text>
          <Text className='info-price'>{estimatedPrice ? '¥' + estimatedPrice : '待面积确认'}</Text>
        </View>
      </View>

      {!isCompact && (
        <View className='plan-actions'>
          <View
            className='action-btn action-btn-ghost'
            onClick={() => onView && onView({ id: itemId })}
          >
            查看详情
          </View>
          {status === 'draft' ? (
            <View
              className='action-btn action-btn-primary'
              onClick={() => onSubmit && onSubmit({ id: itemId })}
            >
              提交匹配
            </View>
          ) : null}
          {status === 'matched' ? (
            <>
              <View
                className='action-btn action-btn-primary'
                onClick={() => onViewMerchants && onViewMerchants({ id: itemId })}
              >
                查看匹配商家
              </View>
              <View
                className='action-btn action-btn-ghost'
                onClick={() => onReview && onReview({ id: itemId })}
              >
                评价签约商家
              </View>
            </>
          ) : null}
          {status !== 'matched' ? (
            <View
              className='action-btn action-btn-danger'
              onClick={() => onDelete && onDelete({ id: itemId })}
            >
              删除
            </View>
          ) : null}
        </View>
      )}
    </View>
  )
}
