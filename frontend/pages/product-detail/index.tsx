import { View, Text, ScrollView, Image } from '@tarojs/components'
import { useState, useEffect } from 'react'
import Taro, { useRouter } from '@tarojs/taro'
import TopNav from '../../components/top-nav'
import DetailSection from '../../components/detail-section'
import TagList from '../../components/tag-list'
import { get } from '../../services/request'
import { resolveProductImage, resolveProductCover, resolveImageUrl } from '../../utils/upload'
import './index.scss'

interface Product {
  id: string
  name?: string
  featured?: boolean
  brand?: string
  series?: string
  material?: string
  budget?: string
  price_range?: string
  concerns?: string[]
  intro?: string
  opening_types?: string[]
  glass_options?: string[]
  room_types?: string[]
  environment?: string[]
  images?: string[]
}

interface ReviewItem {
  reviewId: string
  stars: string
  content?: string
  dateText: string
  imageUrls: string[]
}

// 详情/评价 60s TTL 缓存：同一产品重复进入秒开（storage 首屏 + 缓存补全，不发请求）
// ponytail: 模块级 Map，页面进程存活期间有效；评价为审核制，提交后需过审才展示，60s 窗口无感知差异
const _CACHE_TTL = 60 * 1000
const _detailCache: Record<string, { product: Product; time: number }> = {}
const _reviewCache: Record<string, { data: any; time: number }> = {}

// ponytail: chat 页入口用 storage 中转完整产品对象（Taro 不支持 eventChannel）；
// 收藏页等裁剪数据场景仅传 id，按 id 异步拉取完整产品
export default function ProductDetailPage() {
  const router = useRouter()
  const [product, setProduct] = useState<Product | null>(null)
  const [imageUrls, setImageUrls] = useState<string[]>([])
  // 头部缩略图（第一张非 PDF 图），无图时回退文字占位（对齐原生 coverUrl）
  const [coverUrl, setCoverUrl] = useState('')
  // 用户评价（仅审核通过的评价，默认折叠）
  const [reviewSummary, setReviewSummary] = useState<{ total?: number; avgRating?: number }>({})
  const [reviews, setReviews] = useState<ReviewItem[]>([])
  const [reviewsExpanded, setReviewsExpanded] = useState(false)

  // 产品数据落屏（storage 首屏 / id 拉取两路共用）：详情图 URL 拼接
  function applyProduct(data: Product) {
    if (!data) return
    setProduct(data)
    // images 三种形态（拼接逻辑统一收敛到 utils/upload.resolveProductImage，与原生一致）：
    // CDN 完整 URL / 商家上传图绝对路径（"/uploads/..."，mount 在根）/ 平台详情图相对路径（mount 在 /api/v1/product-images）
    // PDF 是资料附件，image 组件渲染不了，跳过
    const urls = (data.images || [])
      .filter((p: string) => !/\.pdf(\?|$)/i.test(p))
      .map((p: string) => resolveProductImage(p))
    setImageUrls(urls)
    setCoverUrl(resolveProductCover(data.images || []))
  }

  useEffect(() => {
    // ponytail: Taro 不支持 eventChannel，改用 storage 中转
    // 注意：不主动清除 storage，H5 刷新后仍能恢复数据
    const data = Taro.getStorageSync('product_detail_data')
    if (data) applyProduct(data)
    // 收藏页等裁剪数据场景仅传 id：按 id 异步拉取完整产品覆盖首屏（对齐原生 options.id 分支）
    const id = (router.params && router.params.id) || ''
    if (id) {
      const hit = _detailCache[id]
      if (hit && Date.now() - hit.time < _CACHE_TTL) {
        applyProduct(hit.product)
      } else {
        get(`/products/${id}`)
          .then((d: any) => {
            if (d && d.id) {
              _detailCache[id] = { product: d, time: Date.now() }
              applyProduct(d)
            }
          })
          .catch(() => { /* 静默失败：保留首屏数据 */ })
      }
      loadReviews(id)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // ─── 用户评价（仅审核通过的评价）：60s TTL 缓存，重复进入秒开 ───

  function loadReviews(productId: string) {
    if (!productId) return
    const hit = _reviewCache[productId]
    if (hit && Date.now() - hit.time < _CACHE_TTL) {
      applyReviews(hit.data)
      return
    }
    get(`/products/${productId}/reviews`)
      .then((data: any) => {
        _reviewCache[productId] = { data, time: Date.now() }
        applyReviews(data)
      })
      .catch(() => { /* 静默失败不阻塞详情；无评价折叠显示"暂无评价" */ })
  }

  function applyReviews(data: any) {
    const summary = (data && data.summary) || {}
    const items: ReviewItem[] = summary.total
      ? mapReviews(data.items)
      : []
    setReviewSummary(summary)
    setReviews(items)
  }

  // 评价数据落屏：星级转文本、图片拼完整 URL、日期格式化
  function mapReviews(items: any[]): ReviewItem[] {
    return (items || []).map((r) => ({
      reviewId: r.reviewId,
      stars: '★★★★★'.slice(0, Math.max(1, Math.min(5, r.rating || 0))),
      content: r.content,
      dateText: r.createdAt ? formatDate(r.createdAt) : '',
      imageUrls: (r.images || []).map((p: string) => resolveImageUrl(p))
    }))
  }

  function formatDate(ts: number): string {
    const d = new Date(ts * 1000)
    const p = (n: number) => (n < 10 ? '0' + n : '' + n)
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
  }

  function toggleReviews() {
    setReviewsExpanded((v) => !v)
  }

  // 评价图预览（同组图左右滑动切换）
  function previewReviewImage(url: string, rindex: number) {
    const item = reviews[rindex]
    Taro.previewImage({ current: url, urls: item ? item.imageUrls : [url] })
  }

  function goBack() {
    Taro.navigateBack()
  }

  // 产品咨询：将产品存入 storage 临时传递 + 跳转聊天页开启新对话
  // ponytail: 原生用 globalData.consultProduct 一次性传递（eventChannel 不能跨 navigateBack→navigateTo），
  // Taro 改用 storage 中转，chat 页读取后清空，避免残留
  function onConsult() {
    if (!product) return
    Taro.setStorageSync('consult_product_data', product)
    Taro.navigateTo({ url: '/pages/chat/index?consult=1' })
  }

  // 点击详情图预览大图（支持左右滑动切换）
  function previewImage(url: string) {
    Taro.previewImage({
      current: url,
      urls: imageUrls
    })
  }

  return (
    <View className='detail-page'>
      <TopNav title='商品详情' showBack onBack={goBack} />

      {product ? (
        <ScrollView className='detail-scroll' scrollY enhanced showScrollbar={false}>
          <View className='detail-card'>
            {/* 头部：名称 + 精选标记 + 系列/材质/预算档 */}
            <View className='detail-header'>
              <View className='detail-logo'>
                {coverUrl ? (
                  <Image className='logo-img' src={coverUrl} mode='aspectFill' />
                ) : (
                  <Text className='logo-text'>产品</Text>
                )}
              </View>
              <View className='detail-info'>
                <View className='name-row'>
                  <Text className='detail-name'>{product.name}</Text>
                  {product.featured ? <Text className='featured-badge'>精选</Text> : null}
                </View>
                <View className='detail-meta'>
                  {product.brand ? <Text className='meta-chip'>{product.brand}</Text> : null}
                  {product.series ? <Text className='meta-chip'>{product.series}</Text> : null}
                  {product.material ? <Text className='meta-chip'>{product.material}</Text> : null}
                  {product.budget ? <Text className='meta-chip'>{product.budget}</Text> : null}
                </View>
              </View>
            </View>

            {/* 价格区间 */}
            {product.price_range ? (
              <View className='price-row'>
                <Text className='price-label'>参考价</Text>
                <Text className='price-value'>{product.price_range}</Text>
              </View>
            ) : null}

            {/* 产品特点（concerns） */}
            {product.concerns && product.concerns.length > 0 ? (
              <TagList tags={product.concerns} variant='advantage' />
            ) : null}

            {/* 关键指标 */}
            <View className='metrics-grid'>
              {product.material ? (
                <View className='metric'>
                  <Text className='metric-value-text'>{product.material}</Text>
                  <Text className='metric-label'>材质</Text>
                </View>
              ) : null}
              {product.series ? (
                <View className='metric'>
                  <Text className='metric-value-text'>{product.series}</Text>
                  <Text className='metric-label'>系列</Text>
                </View>
              ) : null}
              {product.budget ? (
                <View className='metric'>
                  <Text className='metric-value-text'>{product.budget}</Text>
                  <Text className='metric-label'>预算档</Text>
                </View>
              ) : null}
              {product.featured ? (
                <View className='metric'>
                  <Text className='metric-value-text'>精选</Text>
                  <Text className='metric-label'>平台推荐</Text>
                </View>
              ) : null}
            </View>

            {/* 产品简介 */}
            <DetailSection title='产品简介' show={!!product.intro}>
              <Text className='section-text'>{product.intro}</Text>
            </DetailSection>

            {/* 开启方式 */}
            <DetailSection title='开启方式' show={!!(product.opening_types && product.opening_types.length)}>
              <TagList tags={product.opening_types} />
            </DetailSection>

            {/* 玻璃配置 */}
            <DetailSection title='玻璃配置' show={!!(product.glass_options && product.glass_options.length)}>
              <TagList tags={product.glass_options} />
            </DetailSection>

            {/* 适用场景 */}
            <DetailSection title='适用场景' show={!!(product.room_types && product.room_types.length)}>
              <TagList tags={product.room_types} />
            </DetailSection>

            {/* 适配环境 */}
            <DetailSection title='适配环境' show={!!(product.environment && product.environment.length)}>
              <TagList tags={product.environment} />
            </DetailSection>
          </View>

          {/* 产品详情图：淘宝式长图，铺展在参数后面滑动查看（图片尺寸不一，widthFix 自适应高度） */}
          {imageUrls.length > 0 ? (
            <View className='detail-images'>
              {imageUrls.map((url) => (
                <Image
                  key={url}
                  className='detail-img'
                  src={url}
                  mode='widthFix'
                  lazyLoad
                  onClick={() => previewImage(url)}
                />
              ))}
            </View>
          ) : null}

          {/* 用户评价（仅审核通过的评价，默认折叠，点击头部展开；无评价折叠显示"暂无评价"） */}
          <View className='review-block'>
            <View className='review-header' hoverClass='review-header-hover' hoverStayTime={80} onClick={toggleReviews}>
              <Text className='review-title'>用户评价</Text>
              <Text className='review-meta'>
                {reviewSummary.total
                  ? `${reviewSummary.total}条 · 均分${reviewSummary.avgRating}分`
                  : '暂无评价'}
              </Text>
              <Text className={`adwicon review-arrow ${reviewsExpanded ? 'adwicon-chevron-up' : 'adwicon-chevron-down'}`}>{''}</Text>
            </View>
            {reviewsExpanded && reviews.length > 0 ? (
              <View className='review-list'>
                {reviews.map((item, rindex) => (
                  <View key={item.reviewId} className='review-item'>
                    <View className='review-item-head'>
                      <Text className='review-stars'>{item.stars}</Text>
                      <Text className='review-date'>{item.dateText}</Text>
                    </View>
                    {item.content ? <Text className='review-content'>{item.content}</Text> : null}
                    {item.imageUrls.length > 0 ? (
                      <View className='review-images'>
                        {item.imageUrls.map((url) => (
                          <Image
                            key={url}
                            className='review-img'
                            src={url}
                            mode='aspectFill'
                            lazyLoad
                            onClick={() => previewReviewImage(url, rindex)}
                          />
                        ))}
                      </View>
                    ) : null}
                  </View>
                ))}
              </View>
            ) : null}
          </View>
        </ScrollView>
      ) : null}

      {/* 底部固定操作栏：产品咨询按钮，点击跳转新对话注入该产品 */}
      <View className='detail-footer'>
        <View className='detail-footer-safe' />
        <View className='consult-btn' hoverClass='consult-btn-hover' hoverStayTime={80} onClick={onConsult}>
          <Text className='adwicon consult-btn-icon adwicon-robot'>{''}</Text>
          <Text className='consult-btn-label'>产品咨询</Text>
        </View>
      </View>
    </View>
  )
}
