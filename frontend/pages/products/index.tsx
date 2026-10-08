import { View, Text, Input, ScrollView } from '@tarojs/components'
import type { ITouchEvent } from '@tarojs/components'
import { useState, useEffect, useRef, useCallback } from 'react'
import Taro, { useDidShow } from '@tarojs/taro'
import TopNav from '../../components/top-nav'
import ProductGridCard from '../../components/product-grid-card'
import EmptyState from '../../components/empty-state'
import ActivityCarousel from '../../components/activity-carousel'
import { get, post } from '../../services/request'
import { resolveProductImage } from '../../utils/upload'
import './index.scss'

/**
 * API 契约（后端已实现）：
 *
 * GET /api/v1/products
 *   query: { category?, keyword?, sort?, material[], price_range?, featured?, page, page_size }
 *   resp:  { code:0, data:{ items: Product[], total, has_more } }
 *
 * POST /api/v1/products/{id}/favorite
 *   body:  { favorited: boolean }
 *   resp:  { code:0, data:{} }
 *
 * Product 字段对齐 catalog.db products 表（concerns/images 已展平为数组）：
 * { id, name, series, material, category, budget, price_range, concerns[], featured, intro, images[], brand }
 */

const PAGE_SIZE = 6
const SEARCH_DEBOUNCE = 350
// 骨架屏占位数据（首次加载时渲染 6 个骨架卡）
const SKELETON_CARDS = [1, 2, 3, 4, 5, 6]

const CATEGORIES = ['全部', '系统窗', '推拉窗', '平开窗']
const SORT_OPTIONS = [
  { key: 'comprehensive', label: '综合' },
  { key: 'price_asc', label: '价格升序' },
  { key: 'price_desc', label: '价格降序' }
]
const MATERIAL_OPTIONS = ['断桥铝', '铝合金', '塑钢']
// 价格双滑块：0=不限下限，SLIDER_MAX=不限上限
// ponytail: step 100 元步进
const SLIDER_MAX = 5000
const SLIDER_STEP = 100

interface Product {
  id: string
  name: string
  series: string
  material: string
  category: string
  budget: string
  price_range: string
  concerns: string[]
  featured: boolean
  brand: string
  intro: string
  images: string[]
  // 后端返回的封面 URL（第一张非 PDF 图，CDN 绝对地址或 /uploads 相对路径）
  cover?: string
}

// 列表项 = 产品 + 收藏态 + 封面图 URL
interface ProductListItem extends Product {
  favorited: boolean
  coverImage: string
}

// 已提交的查询条件（搜索/分类/排序/筛选确定后的组合），变化即触发重新加载
interface QueryState {
  keyword: string
  category: string
  sort: string
  materials: string[]
  priceMin: number
  priceMax: number
  featured: boolean
}

const INITIAL_QUERY: QueryState = {
  keyword: '',
  category: '全部',
  sort: 'comprehensive',
  materials: [],
  priceMin: 0,
  priceMax: SLIDER_MAX,
  featured: false
}

export default function ProductsPage() {
  // 输入框即时值（防抖后才提交到 query）
  const [keywordInput, setKeywordInput] = useState('')
  const [query, setQuery] = useState<QueryState>(INITIAL_QUERY)

  // 列表
  const [list, setList] = useState<ProductListItem[]>([])
  const [totalCount, setTotalCount] = useState(0)
  const [loading, setLoading] = useState(false)
  const [loadingMore, setLoadingMore] = useState(false)
  const [hasMore, setHasMore] = useState(true)
  const [error, setError] = useState('')
  const [refreshing, setRefreshing] = useState(false)

  // 筛选面板临时状态（面板内编辑，确定后才提交到 query）
  const [filterVisible, setFilterVisible] = useState(false)
  const [tempMaterials, setTempMaterials] = useState<string[]>([])
  const [tempPriceMin, setTempPriceMin] = useState(0)
  const [tempPriceMax, setTempPriceMax] = useState(SLIDER_MAX)
  const [tempFeatured, setTempFeatured] = useState(false)

  // 非渲染类可变状态统一挂 ref
  const pageRef = useRef(1)
  const fetchTokenRef = useRef(0)
  const searchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  // 后端收藏 ID 列表（登录态，fetchFavIds 维护）+ 上次拉取时间（60s 节流）
  const favIdsRef = useRef<string[]>([])
  const lastFavFetchRef = useRef(0)
  // 双滑块：轨道矩形 + 活动滑块；temp 价格镜像一份到 ref，touchmove 高频更新时读最新值避免闭包陈旧
  const trackRectRef = useRef<{ left: number; width: number } | null>(null)
  const activeThumbRef = useRef<'left' | 'right' | null>(null)
  const tempPriceRef = useRef({ min: 0, max: SLIDER_MAX })

  // 是否有搜索/筛选条件（用于空态文案区分）
  const hasQuery = !!(query.keyword.trim() ||
    query.materials.length ||
    query.priceMin > 0 || query.priceMax < SLIDER_MAX ||
    query.featured ||
    query.category !== '全部')

  // 筛选角标数量（材质/价格/精选三类，命中计 1）
  const filterCount = (query.materials.length ? 1 : 0) +
    (query.priceMin > 0 || query.priceMax < SLIDER_MAX ? 1 : 0) +
    (query.featured ? 1 : 0)

  const buildCoverImage = useCallback((product: Product): string => {
    // 对齐原生：后端已把 cover/images 解析成 URL（CDN 绝对地址或 /uploads 相对路径），
    // 绝对地址直接用，相对值才拼服务根；旧缓存（无 cover 字段）回退首字占位
    return resolveProductImage(product.cover || '')
  }, [])

  const isFav = (id: string): boolean => {
    // 后端收藏优先（登录态），未登录/拉取失败时本地 storage 兜底（对齐原生 _isFav）
    if ((Taro.getStorageSync('token') || '') && favIdsRef.current) {
      return favIdsRef.current.indexOf(id) >= 0
    }
    const favs: string[] = Taro.getStorageSync('product_favs') || []
    return favs.indexOf(id) >= 0
  }

  // 登录态拉后端收藏 ID（60s 节流）：进页/返回刷新角标，拉完刷新已渲染列表
  function fetchFavIds() {
    if (!Taro.getStorageSync('token')) return
    const now = Date.now()
    if (now - lastFavFetchRef.current < 60 * 1000) return
    lastFavFetchRef.current = now
    get('/products/favorites')
      .then((data: any) => {
        favIdsRef.current = (data && data.items) || []
        if (!list.length) return
        setList((prev) => prev.map((p) => ({ ...p, favorited: isFav(p.id) })))
      })
      .catch(() => { /* 静默失败，角标走本地兜底 */ })
  }

  useDidShow(() => {
    fetchFavIds()
  })

  const applyTempMin = (v: number) => {
    tempPriceRef.current.min = v
    setTempPriceMin(v)
  }

  const applyTempMax = (v: number) => {
    tempPriceRef.current.max = v
    setTempPriceMax(v)
  }

  const fetchPage = useCallback((q: QueryState) => {
    const isFirst = pageRef.current === 1
    const token = fetchTokenRef.current

    // 构造 query 参数：分类/关键词/排序/材质/价格/精选/分页
    const params: Record<string, any> = {
      page: pageRef.current,
      page_size: PAGE_SIZE,
      sort: q.sort
    }
    if (q.category && q.category !== '全部') params.category = q.category
    const kw = (q.keyword || '').trim()
    if (kw) params.keyword = kw
    if (q.materials.length) params.material = q.materials.join(',')
    // 价格区间：priceMin>0 传下限，priceMax<SLIDER_MAX 传上限（===SLIDER_MAX 不传=5000+）
    if (q.priceMin > 0) params.price_min = q.priceMin
    if (q.priceMax < SLIDER_MAX) params.price_max = q.priceMax
    if (q.featured) params.featured = true

    get('/products', params)
      .then((data: any) => {
        // 竞态保护：token 不匹配说明已被新请求取代，丢弃本次结果
        if (token !== fetchTokenRef.current) return
        const items: any[] = (data && data.items) || []
        const pageItems: ProductListItem[] = items.map((p) => ({
          ...p,
          favorited: isFav(p.id),
          coverImage: buildCoverImage(p)
        }))
        setList((prev) => (isFirst ? pageItems : prev.concat(pageItems)))
        // 首页列表进缓存：收藏页未登录态用它做产品详情兜底（与原生 products_cache 同 key）
        if (isFirst) Taro.setStorageSync('products_cache', { items: pageItems, time: Date.now() })
        setTotalCount((data && data.total) || 0)
        setLoading(false)
        setLoadingMore(false)
        setHasMore(!!(data && data.has_more))
        setRefreshing(false)
      })
      .catch((err: any) => {
        if (token !== fetchTokenRef.current) return
        setLoading(false)
        setLoadingMore(false)
        setRefreshing(false)
        setError((err && err.message) || '加载失败，请重试')
      })
  }, [buildCoverImage])

  const loadProducts = useCallback((q: QueryState) => {
    pageRef.current = 1
    fetchTokenRef.current += 1
    setLoading(true)
    setError('')
    fetchPage(q)
  }, [fetchPage])

  // 已提交查询条件变化 → 重新加载（含首次挂载，对应原生 onLoad 的 loadProducts）
  useEffect(() => {
    loadProducts(query)
  }, [query, loadProducts])

  // ponytail: 页面卸载时清掉防抖 timer，避免回调操作已销毁的页面
  useEffect(() => () => {
    if (searchTimerRef.current) clearTimeout(searchTimerRef.current)
  }, [])

  // 同值更新时保持引用不变，避免 useEffect 重复触发加载
  const updateQuery = useCallback((partial: Partial<QueryState>) => {
    setQuery((prev) => {
      const next = { ...prev, ...partial }
      return JSON.stringify(next) === JSON.stringify(prev) ? prev : next
    })
  }, [])

  // ─── 搜索 ───

  function onKeywordInput(e: any) {
    const v = e.detail.value
    setKeywordInput(v)
    // ponytail: 防抖 350ms，停止输入后自动搜索（淘宝式即时搜索体验）
    if (searchTimerRef.current) clearTimeout(searchTimerRef.current)
    searchTimerRef.current = setTimeout(() => {
      updateQuery({ keyword: v })
    }, SEARCH_DEBOUNCE)
  }

  function onSearch() {
    // 确认键 / 搜索按钮：立即搜索，跳过防抖
    if (searchTimerRef.current) {
      clearTimeout(searchTimerRef.current)
      searchTimerRef.current = null
    }
    updateQuery({ keyword: keywordInput })
  }

  function onClearKeyword() {
    setKeywordInput('')
    if (searchTimerRef.current) {
      clearTimeout(searchTimerRef.current)
      searchTimerRef.current = null
    }
    updateQuery({ keyword: '' })
  }

  // ─── 分类 / 排序 ───

  function onCategoryTap(cat: string) {
    if (cat === query.category) return
    updateQuery({ category: cat })
  }

  function onSortTap(key: string) {
    if (key === query.sort) return
    updateQuery({ sort: key })
  }

  // ─── 筛选面板 ───

  // 测量滑块轨道矩形（touchmove 时换算坐标用）
  function measureTrack(cb: () => void) {
    Taro.createSelectorQuery()
      .select('#priceSliderTrack')
      .boundingClientRect((rect: any) => {
        if (rect) trackRectRef.current = { left: rect.left, width: rect.width }
        cb()
      })
      .exec()
  }

  function openFilter() {
    // 打开面板时把当前已选条件复制到 temp，面板内编辑 temp，确定后才提交
    setFilterVisible(true)
    setTempMaterials(query.materials.slice())
    applyTempMin(query.priceMin)
    applyTempMax(query.priceMax)
    setTempFeatured(query.featured)
    // ponytail: 面板滑入动画结束后测量轨道宽度，touchmove 时换算坐标用
    setTimeout(() => {
      measureTrack(() => { /* 预热测量，结果存 ref */ })
    }, 300)
  }

  function closeFilter() {
    setFilterVisible(false)
  }

  function onMaterialToggle(mat: string) {
    setTempMaterials((prev) => {
      const idx = prev.indexOf(mat)
      return idx >= 0 ? prev.filter((m) => m !== mat) : prev.concat([mat])
    })
  }

  // ─── 价格双滑块 ───
  // 所有触摸由轨道容器统一处理：按下取最近滑块，拖动跟随
  // ponytail: 不在 thumb 上单独绑事件，靠坐标判断最近滑块，规避 catch 冒泡歧义

  // 触摸点离哪个滑块更近
  function nearestThumb(e: ITouchEvent): 'left' | 'right' {
    const rect = trackRectRef.current!
    const x = e.touches[0].clientX - rect.left
    const ratio = Math.max(0, Math.min(1, x / rect.width))
    const touchVal = ratio * SLIDER_MAX
    const leftDist = Math.abs(touchVal - tempPriceRef.current.min)
    const rightDist = Math.abs(touchVal - tempPriceRef.current.max)
    return leftDist <= rightDist ? 'left' : 'right'
  }

  // 按 activeThumb 更新对应值，钳制不交叉
  function updateSliderValue(e: ITouchEvent) {
    const rect = trackRectRef.current
    if (!rect) return
    const x = e.touches[0].clientX - rect.left
    const ratio = Math.max(0, Math.min(1, x / rect.width))
    let value = Math.round((ratio * SLIDER_MAX) / SLIDER_STEP) * SLIDER_STEP
    if (activeThumbRef.current === 'left') {
      value = Math.min(value, tempPriceRef.current.max - SLIDER_STEP)
      value = Math.max(value, 0)
      applyTempMin(value)
    } else {
      value = Math.max(value, tempPriceRef.current.min + SLIDER_STEP)
      value = Math.min(value, SLIDER_MAX)
      applyTempMax(value)
    }
  }

  function onSliderTouchStart(e: ITouchEvent) {
    // 每次按下重新测量轨道，避免面板内滚动后 trackRect 失效
    measureTrack(() => {
      if (!trackRectRef.current) return
      activeThumbRef.current = nearestThumb(e)
      updateSliderValue(e)
    })
  }

  function onSliderTouchMove(e: ITouchEvent) {
    if (!trackRectRef.current || !activeThumbRef.current) return
    updateSliderValue(e)
  }

  function onSliderTouchEnd() {
    activeThumbRef.current = null
  }

  // 价格输入框（失焦时校验，避免输入过程频繁更新导致光标跳动）
  function onPriceMinBlur(e: any) {
    let v = parseInt(e.detail.value, 10)
    if (isNaN(v) || v < 0) v = 0
    v = Math.round(v / SLIDER_STEP) * SLIDER_STEP
    v = Math.min(v, tempPriceRef.current.max - SLIDER_STEP)
    v = Math.max(v, 0)
    applyTempMin(v)
  }

  function onPriceMaxBlur(e: any) {
    let v = parseInt(e.detail.value, 10)
    if (isNaN(v) || v < 0) v = SLIDER_MAX
    v = Math.round(v / SLIDER_STEP) * SLIDER_STEP
    v = Math.max(v, tempPriceRef.current.min + SLIDER_STEP)
    v = Math.min(v, SLIDER_MAX)
    applyTempMax(v)
  }

  function onFeaturedToggle() {
    setTempFeatured((prev) => !prev)
  }

  function onFilterReset() {
    setTempMaterials([])
    applyTempMin(0)
    applyTempMax(SLIDER_MAX)
    setTempFeatured(false)
  }

  // 空态「清除筛选」：清掉所有已提交的筛选条件 + 关键词，重新加载
  function onClearFilters() {
    setKeywordInput('')
    updateQuery({ keyword: '', materials: [], priceMin: 0, priceMax: SLIDER_MAX, featured: false })
  }

  function onFilterConfirm() {
    setFilterVisible(false)
    updateQuery({
      materials: tempMaterials.slice(),
      priceMin: tempPriceMin,
      priceMax: tempPriceMax,
      featured: tempFeatured
    })
  }

  // ─── 刷新 / 加载更多 ───

  function onRefresh() {
    setRefreshing(true)
    loadProducts(query)
  }

  function onLoadMore() {
    if (loadingMore || !hasMore) return
    setLoadingMore(true)
    pageRef.current += 1
    fetchPage(query)
  }

  // ─── 详情 / 收藏 ───

  function onProductDetail(detail: { itemId: string }) {
    const product = list.find((p) => p.id === detail.itemId)
    if (!product) return
    // ponytail: Taro 不支持 eventChannel，改用 storage 中转（与 product-detail 页读法一致）
    Taro.setStorageSync('product_detail_data', product)
    Taro.navigateTo({ url: `/pages/product-detail/index?id=${product.id}` })
  }

  function onProductFavorite(detail: { itemId: string; favorited: boolean }) {
    const { itemId, favorited } = detail

    // 更新列表中对应产品的收藏态
    setList((prev) => prev.map((p) => (p.id === itemId ? { ...p, favorited } : p)))

    if (Taro.getStorageSync('token')) {
      // 登录态：收藏落库（跨设备同步），失败回滚角标
      post(`/products/${itemId}/favorite`, { favorited })
        .then(() => {
          const idx = favIdsRef.current.indexOf(itemId)
          if (favorited && idx < 0) favIdsRef.current.push(itemId)
          if (!favorited && idx >= 0) favIdsRef.current.splice(idx, 1)
          Taro.showToast({ title: favorited ? '已收藏' : '已取消', icon: 'none', duration: 800 })
        })
        .catch(() => {
          setList((prev) => prev.map((p) => (p.id === itemId ? { ...p, favorited: !favorited } : p)))
          Taro.showToast({ title: '操作失败，请重试', icon: 'none', duration: 800 })
        })
      return
    }

    // 未登录兜底：本地 storage（换设备不同步，登录后收藏走后端）
    const favs: string[] = Taro.getStorageSync('product_favs') || []
    const newFavs = favorited
      ? (favs.indexOf(itemId) < 0 ? favs.concat([itemId]) : favs)
      : favs.filter((id) => id !== itemId)
    Taro.setStorageSync('product_favs', newFavs)
    Taro.showToast({ title: favorited ? '已收藏' : '已取消', icon: 'none', duration: 800 })
  }

  function goBack() {
    Taro.navigateBack({ delta: 1 })
  }

  return (
    <View className='page products-page'>
      <TopNav title='产品中心' showBack onBack={goBack} />

      {/* 活动轮播（无活动自动隐藏不占位，投放位管理端配置） */}
      <ActivityCarousel position='products' />

      {/* 搜索栏 */}
      <View className='search-bar'>
        <View className='search-input-wrap'>
          <Input
            className='search-input'
            value={keywordInput}
            placeholder='搜索门窗产品'
            placeholderClass='search-placeholder'
            confirmType='search'
            onInput={onKeywordInput}
            onConfirm={onSearch}
          />
          {keywordInput ? (
            <View className='search-clear' onClick={(e) => { e.stopPropagation(); onClearKeyword() }}>
              <Text className='adwicon search-clear-icon adwicon-xmark'>{''}</Text>
            </View>
          ) : null}
        </View>
        <View className={`search-btn ${keywordInput ? 'search-btn-active' : ''}`} onClick={onSearch}>搜索</View>
      </View>

      {/* 分类 tabs（横向滚动） */}
      <ScrollView className='cat-tabs' scrollX enhanced showScrollbar={false}>
        {CATEGORIES.map((cat) => (
          <View
            key={cat}
            className={`cat-tab ${query.category === cat ? 'cat-tab-active' : ''}`}
            onClick={() => onCategoryTap(cat)}
          >{cat}</View>
        ))}
      </ScrollView>

      {/* 排序栏 + 筛选入口 + 结果计数 */}
      <View className='sort-bar'>
        <View className='sort-left'>
          {SORT_OPTIONS.map((item) => (
            <View
              key={item.key}
              className={`sort-item ${query.sort === item.key ? 'sort-item-active' : ''}`}
              onClick={() => onSortTap(item.key)}
            >{item.label}</View>
          ))}
        </View>
        <View className='sort-right'>
          {!loading && list.length > 0 ? <Text className='result-count'>共{totalCount}款</Text> : null}
          <View className={`filter-btn ${filterCount > 0 ? 'filter-btn-active' : ''}`} onClick={openFilter}>
            <Text className='adwicon filter-btn-icon adwicon-filter'>{''}</Text>
            <Text className='filter-btn-label'>筛选</Text>
            {filterCount > 0 ? <View className='filter-badge'>{filterCount}</View> : null}
          </View>
        </View>
      </View>

      {/* 产品网格（滚动区） */}
      <ScrollView
        className='products-scroll'
        scrollY
        enhanced
        showScrollbar={false}
        refresherEnabled
        refresherTriggered={refreshing}
        onRefresherRefresh={onRefresh}
        onScrollToLower={onLoadMore}
      >
        {/* 骨架屏（首次加载） */}
        {loading && list.length === 0 ? (
          <View className='products-grid'>
            {SKELETON_CARDS.map((n) => (
              <View className='grid-item skeleton-item' key={n}>
                <View className='skeleton-card'>
                  <View className='skeleton-cover skeleton-shimmer' />
                  <View className='skeleton-body'>
                    <View className='skeleton-line skeleton-shimmer' style='width: 80%' />
                    <View className='skeleton-line skeleton-shimmer' style='width: 60%' />
                    <View className='skeleton-line skeleton-shimmer' style='width: 50%' />
                  </View>
                </View>
              </View>
            ))}
          </View>
        ) : error ? (
          /* 错误态 */
          <View className='state-wrap'>
            <Text className='state-text'>{error}</Text>
            <View className='state-retry' onClick={() => loadProducts(query)}>重试</View>
          </View>
        ) : list.length === 0 ? (
          /* 空态：区分有搜索/筛选条件 vs 无条件 */
          <EmptyState
            icon='box-open'
            iconColor='var(--primary)'
            title={hasQuery ? '没有找到相关产品' : '暂无产品'}
            hint={hasQuery ? '换个关键词或调整筛选条件试试' : '后续会上架更多门窗产品'}
            actionText={hasQuery ? '清除筛选' : ''}
            onAction={onClearFilters}
          />
        ) : (
          <>
            <View className='products-grid'>
              {list.map((item) => (
                <View className='grid-item' key={item.id}>
                  <ProductGridCard
                    itemId={item.id}
                    name={item.name}
                    series={item.series}
                    material={item.material}
                    priceRange={item.price_range}
                    coverImage={item.coverImage}
                    concerns={item.concerns}
                    featured={item.featured}
                    favorited={item.favorited}
                    onDetail={onProductDetail}
                    onFavorite={onProductFavorite}
                  />
                </View>
              ))}
            </View>

            {/* 加载更多 */}
            <View className='load-more'>
              {loadingMore ? (
                <View className='load-more-loading'>
                  <View className='loading-dot' />
                  <View className='loading-dot' />
                  <View className='loading-dot' />
                </View>
              ) : !hasMore ? (
                <Text className='load-more-text no-more'>没有更多了</Text>
              ) : null}
            </View>
          </>
        )}

        <View className='bottom-safe' />
      </ScrollView>

      {/* 筛选面板（底部弹出） */}
      {filterVisible ? (
        <View className='filter-overlay' onClick={closeFilter}>
          <View className='filter-panel' onClick={(e) => e.stopPropagation()}>
            <View className='filter-header'>
              <Text className='filter-title'>筛选</Text>
              <View className='filter-close' onClick={closeFilter}>
                <Text className='adwicon filter-close-icon adwicon-xmark'>{''}</Text>
              </View>
            </View>

            <ScrollView className='filter-body' scrollY>
              {/* 材质（多选） */}
              <View className='filter-section'>
                <Text className='filter-section-title'>材质</Text>
                <View className='filter-chips'>
                  {MATERIAL_OPTIONS.map((mat) => (
                    <View
                      key={mat}
                      className={`filter-chip ${tempMaterials.indexOf(mat) >= 0 ? 'filter-chip-active' : ''}`}
                      onClick={() => onMaterialToggle(mat)}
                    >{mat}</View>
                  ))}
                </View>
              </View>

              {/* 价格区间（双滑块 + 输入） */}
              <View className='filter-section'>
                <Text className='filter-section-title'>价格区间</Text>
                <View className='price-slider'>
                  {/* 当前值显示 */}
                  <View className='price-values'>
                    <Text className='price-value'>¥{tempPriceMin}</Text>
                    <Text className='price-value-dash'>—</Text>
                    <Text className='price-value'>¥{tempPriceMax}</Text>
                    <Text className='price-value-unit'>元/㎡</Text>
                  </View>
                  {/* 轨道 + 双滑块（触摸统一由轨道处理） */}
                  <View
                    className='slider-track'
                    id='priceSliderTrack'
                    onTouchStart={onSliderTouchStart}
                    onTouchMove={onSliderTouchMove}
                    onTouchEnd={onSliderTouchEnd}
                  >
                    <View className='slider-rail' />
                    <View
                      className='slider-fill'
                      style={`left: ${(tempPriceMin / SLIDER_MAX) * 100}%; width: ${((tempPriceMax - tempPriceMin) / SLIDER_MAX) * 100}%;`}
                    />
                    <View className='slider-thumb' style={`left: ${(tempPriceMin / SLIDER_MAX) * 100}%;`} />
                    <View className='slider-thumb' style={`left: ${(tempPriceMax / SLIDER_MAX) * 100}%;`} />
                  </View>
                  {/* 输入框（失焦校验） */}
                  <View className='price-inputs'>
                    <View className='price-input-wrap'>
                      <Text className='price-input-prefix'>¥</Text>
                      <Input
                        className='price-input'
                        type='number'
                        value={String(tempPriceMin)}
                        placeholder='最低'
                        placeholderClass='price-input-ph'
                        onBlur={onPriceMinBlur}
                      />
                    </View>
                    <Text className='price-input-dash'>—</Text>
                    <View className='price-input-wrap'>
                      <Text className='price-input-prefix'>¥</Text>
                      <Input
                        className='price-input'
                        type='number'
                        value={String(tempPriceMax)}
                        placeholder='最高'
                        placeholderClass='price-input-ph'
                        onBlur={onPriceMaxBlur}
                      />
                    </View>
                    <Text className='price-input-unit'>元/㎡</Text>
                  </View>
                </View>
              </View>

              {/* 仅看精选（开关） */}
              <View className='filter-section'>
                <View className='filter-switch-row' onClick={onFeaturedToggle}>
                  <Text className='filter-section-title'>仅看精选</Text>
                  <View className={`filter-switch ${tempFeatured ? 'filter-switch-on' : ''}`}>
                    <View className='filter-switch-thumb' />
                  </View>
                </View>
              </View>
            </ScrollView>

            <View className='filter-footer'>
              <View className='filter-footer-btn filter-reset-btn' onClick={onFilterReset}>重置</View>
              <View className='filter-footer-btn filter-confirm-btn' onClick={onFilterConfirm}>确定</View>
            </View>
          </View>
        </View>
      ) : null}
    </View>
  )
}
