import { View, Text, Image } from '@tarojs/components'
import Taro from '@tarojs/taro'
import ProductCard from '../product-card'
import './index.scss'

// 产品咨询引用：用户消息携带的产品引用（后端 product_ref，price_range 为 snake_case）
export interface ProductRef {
  name?: string
  series?: string
  material?: string
  budget?: string
  price_range?: string
  concerns?: string[]
  intro?: string
}

export interface ChatBubbleUserProps {
  text?: string
  messageId?: string
  // 产品咨询入口：渲染为紧凑产品卡片（只读，无交互）
  productRef?: ProductRef | null
  // 拍照看效果：用户上传的窗图（本地临时路径或历史恢复 CDN URL，点击预览大图）
  image?: string
}

export default function ChatBubbleUser({ text = '', productRef = null, image = '' }: ChatBubbleUserProps) {
  return (
    <View className='bubble-user'>
      <View className='bubble-user-content'>
        {/* 拍照看效果：用户上传的窗图（点击预览大图） */}
        {image ? (
          <Image
            className='bubble-image'
            src={image}
            mode='widthFix'
            lazyLoad
            onClick={() => Taro.previewImage({ urls: [image] })}
          />
        ) : null}
        {/* 产品咨询卡片：复用 product-card 组件 readonly 模式，隐藏勾选+底部提示 */}
        {productRef ? (
          <ProductCard
            name={productRef.name}
            series={productRef.series}
            material={productRef.material}
            budget={productRef.budget}
            priceRange={productRef.price_range}
            concerns={productRef.concerns}
            intro={productRef.intro}
            readonly
          />
        ) : null}
        <Text className='bubble-text' userSelect selectable>
          {text}
        </Text>
      </View>
    </View>
  )
}
