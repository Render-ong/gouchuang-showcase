import { View, Text, Image } from '@tarojs/components'
import './index.scss'

export interface ProductCardProps {
  name?: string
  series?: string
  budget?: string
  material?: string
  priceRange?: string
  // 缩略图（第一张非 PDF 产品图，调用方 resolveProductCover 计算）
  cover?: string
  intro?: string
  concerns?: string[]
  roomTypes?: string[]
  openingTypes?: string[]
  glassOptions?: string[]
  selected?: boolean
  // ponytail: readonly 模式——用户气泡内嵌产品咨询卡时用，隐藏勾选+底部提示+点击进详情，宽度自适应
  readonly?: boolean
  // ponytail: 用 (msgIndex, pIdx) 索引定位，对齐原生工程事件签名（绕开小程序 id 内置属性冲突）
  msgIndex?: number
  pIdx?: number
  onToggle?: (detail: { selected: boolean; msgIndex: number; pIdx: number }) => void
  // 查看详情：整卡点击触发，点勾选不冒泡；readonly 模式下不响应
  onDetail?: (detail: { msgIndex: number; pIdx: number }) => void
}

export default function ProductCard({
  name = '',
  series = '',
  budget = '',
  material = '',
  priceRange = '',
  cover = '',
  intro = '',
  concerns = [],
  openingTypes = [],
  selected = false,
  readonly = false,
  msgIndex = -1,
  pIdx = -1,
  onToggle,
  onDetail
}: ProductCardProps) {
  // catchtap → stopPropagation：点勾选不冒泡到卡片 onDetail
  function handleToggle(e) {
    e.stopPropagation()
    if (readonly) return
    onToggle && onToggle({ selected: !selected, msgIndex, pIdx })
  }

  // 卡片主体点击进详情；readonly 模式下不响应
  function handleDetail() {
    if (readonly) return
    onDetail && onDetail({ msgIndex, pIdx })
  }

  return (
    <View
      className={`product-card ${selected ? 'product-card-selected' : ''} ${readonly ? 'product-card-readonly' : ''}`}
      onClick={handleDetail}
    >
      <View className='product-card-header'>
        {/* 缩略图：第一张非 PDF 产品图，无图不占位、布局退回纯文字 */}
        {cover ? <Image className='card-thumb' src={cover} mode='aspectFill' lazyLoad /> : null}
        <View className='header-main'>
          <Text className='product-name'>{name}</Text>
          <View className='product-meta'>
            <Text className='meta-series'>{series}</Text>
            {budget ? <Text className='meta-dot'>·</Text> : null}
            {budget ? <Text className='meta-budget'>{budget}</Text> : null}
            {material ? <Text className='meta-dot'>·</Text> : null}
            {material ? <Text className='meta-material'>{material}</Text> : null}
          </View>
        </View>
        {/* 右上角勾选按钮：点勾选不触发详情；未选显示浅色 ✓ 引导可勾选；readonly 模式隐藏 */}
        {!readonly ? (
          <View
            className={`select-indicator ${selected ? 'is-selected' : ''}`}
            onClick={handleToggle}
          >
            <Text className={`select-check ${selected ? 'is-checked' : ''}`}>✓</Text>
          </View>
        ) : null}
      </View>

      <View className='product-price-row'>
        <Text className='product-price'>{priceRange}</Text>
      </View>

      {/* 只展示前 4 个特点标签 + 前 2 个开启方式标签，超出省略（完整信息在商品详情页） */}
      {((concerns && concerns.length) || (openingTypes && openingTypes.length)) ? (
        <View className='product-tags'>
          {(concerns || []).slice(0, 4).map((tag, i) => (
            <Text key={`c-${i}`} className='product-tag'>{tag}</Text>
          ))}
          {(openingTypes || []).slice(0, 2).map((tag, i) => (
            <Text key={`o-${i}`} className='product-tag tag-opening'>{tag}</Text>
          ))}
        </View>
      ) : null}

      {/* 产品简介：标题 + 最多两行正文，超出省略（完整信息在商品详情页） */}
      {intro ? (
        <View className='product-intro-block'>
          <Text className='intro-label'>产品简介</Text>
          <Text className='intro-text'>{intro}</Text>
        </View>
      ) : null}

      {/* 底部操作提示：readonly 模式隐藏 */}
      {!readonly ? (
        <View className='product-select-hint'>
          <Text>{selected ? '已勾选（再点右上角 ✓ 取消）' : '点卡片看详情 · 点右上角 ✓ 勾选'}</Text>
        </View>
      ) : null}
    </View>
  )
}
