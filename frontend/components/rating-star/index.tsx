import { View, Text } from '@tarojs/components'
import './index.scss'

// 评分星星：可交互打分（readonly=false）或只读展示（readonly=true，评价列表用）
export interface RatingStarProps {
  /** 当前评分 0-5 */
  value?: number
  /** 只读模式（true 时不可点击，用于评价列表展示） */
  readonly?: boolean
  /** 点 star 回调，detail 与原生 triggerEvent('change') 的 e.detail 一致 */
  onChange?: (detail: { value: number }) => void
}

const STARS = [1, 2, 3, 4, 5]

export default function RatingStar({ value = 0, readonly = false, onChange }: RatingStarProps) {
  function onTap(val: number) {
    if (readonly) return
    if (onChange) onChange({ value: val })
  }

  return (
    <View className='rating-star'>
      {STARS.map((item) => (
        <View
          key={item}
          className={`star ${item <= value ? 'star-active' : ''}`}
          onClick={() => onTap(item)}
        >
          <Text className='adwicon adwicon-star'>{''}</Text>
        </View>
      ))}
    </View>
  )
}
