import { View, Text, Image } from '@tarojs/components'
import './index.scss'

export interface MerchantCardProps {
  // ponytail: 用 itemId 而非 id——对齐原生命名，事件回调仍以 id 为 key 外抛
  itemId?: string
  name?: string
  // 商家门头照完整 URL（无则降级 Logo 占位）；调用方负责绝对化
  photo?: string
  rating?: number
  matchReason?: string
  distance?: string
  phone?: string
  tags?: string[]
  // 质保年限（年）
  warrantyYears?: number
  // 安装商类型（如"官方安装"）
  installerType?: string
  // 经营年限（年）
  years?: number
  // ponytail: 对话页横滑卡片固定尺寸（fixed=true，内容省略，详情页看完整）；列表页自适应
  fixed?: boolean
  // 是否显示"评价商家"按钮（对话页推荐商家场景开启，方案弹层/详情页关闭——方案页已有评价入口）
  showReview?: boolean
  onContact?: (detail: { id: string; phone: string; name: string }) => void
  onReview?: (detail: { id: string; name: string }) => void
  onView?: (detail: { id: string }) => void
}

export default function MerchantCard({
  itemId = '',
  name = '',
  photo = '',
  rating = 0,
  matchReason = '',
  distance = '',
  phone = '',
  tags = [],
  warrantyYears = 0,
  installerType = '',
  years = 0,
  fixed = false,
  showReview = false,
  onContact,
  onReview,
  onView
}: MerchantCardProps) {
  return (
    <View
      className={`merchant-card ${fixed ? 'merchant-card-fixed' : ''}`}
      onClick={() => onView && onView({ id: itemId })}
    >
      <View className='merchant-header'>
        <View className='merchant-logo'>
          {/* 商家照片（门头照）：无则降级 Logo 占位 */}
          {photo ? (
            <Image className='logo-img' src={photo} mode='aspectFill' lazyLoad />
          ) : (
            <Text className='logo-text'>Logo</Text>
          )}
        </View>
        <View className='merchant-info'>
          <View className='merchant-name-row'>
            <Text className='merchant-name'>{name}</Text>
            {distance && (
              <View className='distance'>
                <Text className='adwicon distance-icon adwicon-location'>{''}</Text>
                <Text className='distance-text'>{distance}</Text>
              </View>
            )}
          </View>
          <View className='rating'>
            <Text className='adwicon star-icon adwicon-star'>{''}</Text>
            <Text className='rating-text'>{rating}</Text>
          </View>
        </View>
      </View>

      <View className='merchant-tags'>
        {(tags || []).slice(0, 3).map((tag, i) => (
          <View key={i} className='tag'>
            <Text className='tag-text'>{tag}</Text>
          </View>
        ))}
      </View>

      {(warrantyYears || installerType || years) ? (
        <View className='merchant-service'>
          {warrantyYears ? <Text className='service-text'>质保{warrantyYears}年</Text> : null}
          {warrantyYears && installerType ? <Text className='service-dot'>·</Text> : null}
          {installerType ? <Text className='service-text'>{installerType}</Text> : null}
          {(warrantyYears || installerType) && years ? <Text className='service-dot'>·</Text> : null}
          {years ? <Text className='service-text'>经营{years}年</Text> : null}
        </View>
      ) : null}

      <View className='match-reason'>
        <Text className='match-label'>匹配理由：</Text>
        <Text className='match-text'>{matchReason}</Text>
      </View>

      <View className='action-row'>
        {/* catchtap → stopPropagation：点按钮不冒泡到卡片 onView */}
        <View
          className={`contact-btn ${showReview ? 'action-half' : ''}`}
          onClick={(e) => {
            e.stopPropagation()
            onContact && onContact({ id: itemId, phone, name })
          }}
        >
          <Text className='adwicon contact-icon adwicon-phone'>{''}</Text>
          <Text>联系商家</Text>
        </View>
        {showReview ? (
          <View
            className='review-btn action-half'
            onClick={(e) => {
              e.stopPropagation()
              onReview && onReview({ id: itemId, name })
            }}
          >
            <Text className='adwicon contact-icon adwicon-edit'>{''}</Text>
            <Text>评价商家</Text>
          </View>
        ) : null}
      </View>
    </View>
  )
}
