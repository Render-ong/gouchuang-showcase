import { View, Text, ScrollView, Image } from '@tarojs/components'
import { useState, useEffect } from 'react'
import Taro from '@tarojs/taro'
import TopNav from '../../components/top-nav'
import ActivityCarousel from '../../components/activity-carousel'
import DetailSection from '../../components/detail-section'
import TagList from '../../components/tag-list'
import { get } from '../../services/request'
import { makePhoneCallSafe, setClipboardSafe } from '../../utils/cross-platform'
import { resolveImageUrl } from '../../utils/upload'
import './index.scss'

interface Merchant {
  id: string
  name?: string
  featured?: boolean
  rating?: number
  review_count?: number
  city?: string
  region?: string
  years?: number
  warranty_years?: number
  installer_type?: string
  response_hours?: number
  intro?: string
  services?: string[]
  advantages?: string[]
  address?: string
  latitude?: number
  longitude?: number
  matchReason?: string
  phone?: string
  photo?: string
  photos?: string[]
}

// 用户评价条目（星级已转 ★ 文本，图片已拼完整 URL）
interface ReviewItem {
  reviewId: string
  stars: string
  content?: string
  dateText?: string
  imageUrls: string[]
}

// 评价列表 60s TTL 模块级缓存：重复进入商家详情秒开，不重复拉评价
const _CACHE_TTL = 60 * 1000
const _reviewCache: Record<string, { data: any; time: number }> = {}

// 商家照片（门头照）绝对化：http 开头原样（快照已 normalize），/uploads/... 拼 origin；
// 与商家卡片同一 URL 命中 HTTP 缓存。photos（全部门头照，最新在前）供点击放大预览
function withPhotoUrl(m: any) {
  if (!m || !m.photo) return m
  const photos = (Array.isArray(m.photos) && m.photos.length ? m.photos : [m.photo])
    .map((u: string) => resolveImageUrl(u))
  return Object.assign({}, m, { photo: resolveImageUrl(m.photo), photos })
}

// ponytail: 通过 eventChannel 接收完整 merchant 对象，无需后端单条详情接口
// Taro 下用 eventChannel 等价方案：通过 storage 中转（页面间通信）
export default function MerchantDetailPage() {
  const [merchant, setMerchant] = useState<Merchant | null>(null)
  // 用户评价（仅审核通过的评价，默认折叠）
  const [reviewSummary, setReviewSummary] = useState<{ total?: number; avgRating?: number }>({})
  const [reviews, setReviews] = useState<ReviewItem[]>([])
  const [reviewsExpanded, setReviewsExpanded] = useState(false)

  useEffect(() => {
    // ponytail: Taro 不支持 eventChannel，改用 storage 中转
    // chat 页 navigateTo 前写 storage，详情页 onLoad 后读
    // 注意：不主动清除 storage，H5 刷新后仍能恢复数据
    const data = Taro.getStorageSync('merchant_detail_data')
    if (data) {
      setMerchant(withPhotoUrl(data))
      if (data.id) {
        loadReviews(data.id)
        // 拉最新资料覆盖快照（匹配时刻快照可能过期）；静默失败保留首屏快照
        // ponytail: storage 中转在跳转时已写入、网络返回更晚，最新数据总是后到覆盖，无竞态
        get(`/merchants/${data.id}`).then((res: any) => {
          if (res && res.Merchant) setMerchant(withPhotoUrl(res.Merchant))
        }).catch(() => { /* 静默失败：保留首屏快照 */ })
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // 门头照点击放大：全部门头照可左右滑动（最新在前），当前图定位
  function onPreviewPhoto() {
    const m: any = merchant || {}
    const urls = (Array.isArray(m.photos) && m.photos.length) ? m.photos : (m.photo ? [m.photo] : [])
    if (!urls.length) return
    Taro.previewImage({ urls, current: m.photo || urls[0] })
  }

  // ─── 用户评价（仅审核通过的评价）：60s TTL 缓存，重复进入秒开 ───

  function loadReviews(merchantId: string) {
    if (!merchantId) return
    const hit = _reviewCache[merchantId]
    if (hit && Date.now() - hit.time < _CACHE_TTL) {
      applyReviews(hit.data)
      return
    }
    get(`/merchants/${merchantId}/reviews`)
      .then((data: any) => {
        _reviewCache[merchantId] = { data, time: Date.now() }
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

  function onContact() {
    const m: Partial<Merchant> = merchant || {}
    if (!m.phone) {
      Taro.showModal({
        title: m.name || '联系商家',
        content: '该商家暂未提供联系电话，请稍后再试或咨询客服。',
        showCancel: false,
        confirmText: '知道了'
      })
      return
    }
    makePhoneCallSafe(m.phone).catch(() => { /* 用户取消拨号不提示 */ })
  }

  // 地址导航：有坐标走 openLocation（微信内置地图，右下角「导航」可拉起手机上已装的
  // 高德/百度/腾讯地图，目的地已填好）；无坐标降级复制地址自行搜索
  function onOpenMap() {
    const m: Partial<Merchant> = merchant || {}
    const address = (m.address || '').trim()
    const latitude = Number(m.latitude) || 0
    const longitude = Number(m.longitude) || 0
    if (latitude && longitude) {
      Taro.openLocation({
        latitude,
        longitude,
        name: m.name || '',
        address,
        scale: 18,
        fail: () => copyAddress(address)
      } as any)
      return
    }
    copyAddress(address)
  }

  function copyAddress(address: string) {
    if (!address) return
    setClipboardSafe(address)
      .then(() => Taro.showToast({ title: '地址已复制，可粘贴到地图App搜索', icon: 'none', duration: 2500 }))
      .catch(() => { /* 复制失败静默 */ })
  }

  return (
    <View className='detail-page'>
      <TopNav title='商家详情' showBack onBack={goBack} />

      {/* 活动轮播（无活动自动隐藏不占位） */}
      <ActivityCarousel position='merchant_detail' />
      {merchant ? (
        <>
          <ScrollView className='detail-scroll' scrollY enhanced showScrollbar={false}>
            <View className='detail-card'>
              {/* 头部：名称 + 精选标记 + 评分 + 评论数 + 地区 */}
              <View className='detail-header'>
                <View className='detail-logo'>
                  {/* 商家照片（门头照）：无则降级 Logo 占位 */}
                  {merchant.photo ? (
                    <Image className='logo-img' src={merchant.photo} mode='aspectFill' onClick={onPreviewPhoto} />
                  ) : (
                    <Text className='logo-text'>Logo</Text>
                  )}
                </View>
                <View className='detail-info'>
                  <View className='name-row'>
                    <Text className='detail-name'>{merchant.name}</Text>
                    {merchant.featured ? <Text className='featured-badge'>精选</Text> : null}
                  </View>
                  <View className='detail-meta'>
                    <View className='meta-rating'>
                      <Text className='adwicon meta-star adwicon-star'>{''}</Text>
                      <Text className='meta-rating-text'>{merchant.rating}</Text>
                      {merchant.review_count ? (
                        <Text className='meta-review'>{merchant.review_count}条评价</Text>
                      ) : null}
                    </View>
                    {merchant.region ? (
                      <View className='meta-region'>
                        <Text className='adwicon meta-loc adwicon-location'>{''}</Text>
                        <Text className='meta-region-text'>
                          {merchant.city ? merchant.city + ' · ' : ''}{merchant.region}
                        </Text>
                      </View>
                    ) : null}
                  </View>
                </View>
              </View>

              {/* 核心指标网格：经营年限 / 质保 / 安装团队 / 响应时长 */}
              <View className='metrics-grid'>
                {merchant.years ? (
                  <View className='metric'>
                    <View className='metric-value-row'>
                      <Text className='metric-value'>{merchant.years}</Text>
                      <Text className='metric-unit'>年</Text>
                    </View>
                    <Text className='metric-label'>经营年限</Text>
                  </View>
                ) : null}
                {merchant.warranty_years ? (
                  <View className='metric'>
                    <View className='metric-value-row'>
                      <Text className='metric-value'>{merchant.warranty_years}</Text>
                      <Text className='metric-unit'>年</Text>
                    </View>
                    <Text className='metric-label'>质保年限</Text>
                  </View>
                ) : null}
                {merchant.installer_type ? (
                  <View className='metric'>
                    <Text className='metric-value-text'>{merchant.installer_type}</Text>
                    <Text className='metric-label'>安装团队</Text>
                  </View>
                ) : null}
                {merchant.response_hours ? (
                  <View className='metric'>
                    <View className='metric-value-row'>
                      <Text className='metric-value'>{merchant.response_hours}</Text>
                      <Text className='metric-unit'>h</Text>
                    </View>
                    <Text className='metric-label'>响应时长</Text>
                  </View>
                ) : null}
              </View>

              <DetailSection title='商家简介' show={!!merchant.intro}>
                <Text className='section-text'>{merchant.intro}</Text>
              </DetailSection>

              <DetailSection title='服务项目' show={!!(merchant.services && merchant.services.length)}>
                <TagList tags={merchant.services} />
              </DetailSection>

              <DetailSection title='商家优势' show={!!(merchant.advantages && merchant.advantages.length)}>
                <TagList tags={merchant.advantages} variant='advantage' />
              </DetailSection>

              <DetailSection title='地址' show={!!merchant.address}>
                {/* 地址导航：有坐标走 openLocation（内置地图，可拉起高德/百度/腾讯），无坐标降级复制地址 */}
                <View
                  className='address-row'
                  hoverClass='address-row-hover'
                  hoverStayTime={80}
                  onClick={onOpenMap}
                >
                  <Text className='section-text address-text'>{merchant.address}</Text>
                  <View className='address-nav'>
                    <Text className='adwicon address-nav-icon adwicon-location'>{''}</Text>
                    <Text className='address-nav-text'>导航</Text>
                  </View>
                </View>
              </DetailSection>

              <DetailSection title='推荐理由' show={!!merchant.matchReason}>
                <Text className='section-text'>{merchant.matchReason}</Text>
              </DetailSection>

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
            </View>
          </ScrollView>

          <View className='detail-footer'>
            <View className='contact-btn' onClick={onContact}>
              <Text className='adwicon contact-icon adwicon-phone'>{''}</Text>
              <Text>联系商家</Text>
            </View>
          </View>
        </>
      ) : null}
    </View>
  )
}
