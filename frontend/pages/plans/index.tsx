import { View, Text, ScrollView } from '@tarojs/components'
import { useState, useCallback, useRef } from 'react'
import Taro, { useDidShow } from '@tarojs/taro'
import TopNav from '../../components/top-nav'
import ActivityCarousel from '../../components/activity-carousel'
import PlanCard from '../../components/plan-card'
import MerchantCard from '../../components/merchant-card'
import EmptyState from '../../components/empty-state'
import { useAuth } from '../../store/auth-context'
import { get, post, del } from '../../services/request'
import { makePhoneCallSafe } from '../../utils/cross-platform'
import { resolveImageUrl } from '../../utils/upload'

// 商家卡片 photo 绝对化（方案快照存相对路径，与 chat 页同一缓存 URL）
const absPhoto = (m: any) => (m && m.photo) ? Object.assign({}, m, { photo: resolveImageUrl(m.photo) }) : m
import './index.scss'

interface FilterItem {
  label: string
  value: string
}

const FILTERS: FilterItem[] = [
  { label: '全部', value: 'all' },
  { label: '草稿', value: 'draft' },
  { label: '已提交', value: 'submitted' },
  { label: '已匹配', value: 'matched' }
]

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

// ponytail: 完整透传后端 plan 字段（含 userRequirements/desc/features/tier/productName 等详情页所需字段），
// 只覆盖列表展示兜底值 + 格式化价格。曾裁剪为 10 字段导致详情页拿不到 userRequirements，需求区块为空。
interface PlanItem {
  id: string
  title?: string
  status?: string
  windowCount?: number
  estimatedPrice?: string
  material?: string
  area?: string
  glassChoice?: string
  openingType?: string
  roomType?: string
  merchants?: MerchantItem[]
  [key: string]: any
}

function formatPrice(val: any): string {
  if (val === null || val === undefined || val === '') return ''
  const num = Number(val)
  if (isNaN(num)) return String(val)
  return num.toLocaleString('zh-CN')
}

export default function PlansPage() {
  const { isLoggedIn } = useAuth()
  const [activeFilter, setActiveFilter] = useState('all')
  const [plans, setPlans] = useState<PlanItem[]>([])
  const [filteredPlans, setFilteredPlans] = useState<PlanItem[]>([])
  const [loading, setLoading] = useState(false)
  const loadingRef = useRef(false)
  const [error, setError] = useState('')
  // 匹配商家弹层
  const [showMerchantPopup, setShowMerchantPopup] = useState(false)
  const [popupPlanTitle, setPopupPlanTitle] = useState('')
  const [popupMerchants, setPopupMerchants] = useState<MerchantItem[]>([])

  const applyFilter = useCallback((value: string, list: PlanItem[]) => {
    const filtered = value === 'all' ? list : list.filter((p) => p.status === value)
    setActiveFilter(value)
    setFilteredPlans(filtered)
  }, [])

  const fetchPlans = useCallback(() => {
    loadingRef.current = true
    setLoading(true)
    setError('')
    get('/plans')
      .then((res: any) => {
        const items: any[] = (res && res.items) || []
        // ponytail: 字段名是 estimatedPrice（plan_generator 产出），早期前端误读 totalEstimate 导致价格始终为空
        const list: PlanItem[] = items.map((p) => ({
          ...p,
          title: p.title || '未命名方案',
          status: p.status || 'draft',
          estimatedPrice: formatPrice(p.estimatedPrice),
          // submit 时后端匹配到的商家列表（matched 状态非空，draft/submitted 为空数组）
          merchants: p.merchants || []
        }))
        loadingRef.current = false
        setPlans(list)
        setLoading(false)
        applyFilter(activeFilter, list)
        // ponytail: 更新本地缓存——下次 onShow 时 plans_dirty=false 就用缓存，不发请求
        Taro.setStorageSync('plans_cache', list)
      })
      .catch((err: any) => {
        loadingRef.current = false
        setLoading(false)
        setError((err && err.message) || '加载失败')
        setPlans([])
        setFilteredPlans([])
      })
  }, [activeFilter, applyFilter])

  useDidShow(() => {
    if (!isLoggedIn) {
      Taro.showModal({
        title: '需要登录',
        content: '登录并授权手机号后才能查看方案',
        confirmText: '去登录',
        showCancel: true,
        success: (res) => {
          if (res.confirm) {
            Taro.navigateTo({ url: '/pages/profile/index' })
          } else {
            Taro.navigateBack()
          }
        }
      })
      return
    }
    // ponytail: 缓存优先——plans_dirty 或无缓存时才拉后端，否则用 storage 缓存渲染
    // 方案列表体积小（<20KB），存 storage 持久化，避免每次切到方案页都发 GET /plans
    const cached = Taro.getStorageSync('plans_cache')
    if (Taro.getStorageSync('plans_dirty') || !cached) {
      Taro.removeStorageSync('plans_dirty')
      if (!loadingRef.current) fetchPlans()
    } else {
      // 用缓存渲染，不发请求
      loadingRef.current = false
      setLoading(false)
      setPlans(cached)
      applyFilter(activeFilter, cached)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  })

  function switchFilter(value: string) {
    applyFilter(value, plans)
  }

  function onViewPlan(id: string) {
    const plan = plans.find((p) => p.id === id)
    if (!plan) return
    // 方案详情页（含编辑），storage 中转完整 plan（列表接口已含全部字段 + merchants）
    // ponytail: 原生用 eventChannel.emit('plan:data')，Taro 改用 storage 中转
    Taro.setStorageSync('plan_detail_data', plan)
    Taro.navigateTo({ url: `/pages/plan-detail/index?id=${id}` })
  }

  function onSubmitPlan(id: string) {
    Taro.showModal({
      title: '提交方案',
      content: '提交后将为您匹配附近可承接该方案的商家，是否继续？',
      confirmColor: '#2563eb',
      success: (res) => {
        if (!res.confirm) return
        Taro.showLoading({ title: '提交中...', mask: true })
        post(`/plans/${id}/submit`)
          .then((res: any) => {
            Taro.hideLoading()
            // 提交时后端已匹配商家：有结果直接弹层展示，无结果提示（地区缺失等导致匹配为空）
            const merchants: MerchantItem[] = (res && res.merchants) || []
            if (merchants.length) {
              const plan = plans.find((p) => p.id === id)
              setPopupPlanTitle((res && res.title) || (plan && plan.title) || '方案')
              setPopupMerchants(merchants.map(absPhoto))
              setShowMerchantPopup(true)
            } else {
              Taro.showToast({ title: '已提交，暂无匹配商家', icon: 'none' })
            }
            fetchPlans()
          })
          .catch((err: any) => {
            Taro.hideLoading()
            Taro.showToast({
              title: (err && err.message) || '提交失败',
              icon: 'none'
            })
          })
      }
    })
  }

  // matched 方案：查看提交时匹配到的商家列表（弹层复用 merchant-card 组件）
  function onViewMerchants(id: string) {
    const plan = plans.find((p) => p.id === id)
    if (!plan) return
    if (!plan.merchants || !plan.merchants.length) {
      Taro.showToast({ title: '该方案暂无匹配商家', icon: 'none' })
      return
    }
    setPopupPlanTitle(plan.title || '方案')
    setPopupMerchants((plan.merchants || []).map(absPhoto))
    setShowMerchantPopup(true)
  }

  // matched 方案卡片"评价签约商家"按钮
  function onGoReview(id: string) {
    const plan = plans.find((p) => p.id === id)
    if (!plan) return
    if (!plan.merchants || !plan.merchants.length) {
      Taro.showToast({ title: '该方案暂无匹配商家', icon: 'none' })
      return
    }
    // 映射数据结构对齐 review-submit 期望：planId / merchants / title
    // ponytail: 原生用 eventChannel.emit('plan:data')，Taro 改用 storage 中转
    Taro.setStorageSync('review_submit_data', {
      planId: plan.id,
      merchants: plan.merchants,
      planTitle: plan.title
    })
    Taro.navigateTo({ url: '/pages/review-submit/index' })
  }

  function closeMerchantPopup() {
    setShowMerchantPopup(false)
  }

  // 弹层内商家"联系商家"：拨打电话
  function onMerchantContact(detail: { id: string; phone: string; name: string }) {
    const { phone } = detail
    if (!phone) {
      Taro.showToast({ title: '该商家暂无电话', icon: 'none' })
      return
    }
    makePhoneCallSafe(String(phone)).catch(() => { /* 用户取消拨号不提示 */ })
  }

  // 弹层内商家卡片点击：跳转详情页，storage 中转完整 merchant 对象（与 chat 页同模式）
  function onMerchantView(id: string) {
    const merchant = popupMerchants.find((m) => m.id === id) || {}
    closeMerchantPopup()
    Taro.setStorageSync('merchant_detail_data', merchant)
    Taro.navigateTo({ url: `/pages/merchant-detail/index?id=${id}` })
  }

  // 长按/按钮删除方案（与对话管理页长按删除交互一致）
  function onLongPressDelete(id: string) {
    const plan = plans.find((p) => p.id === id)
    if (!plan) return
    // 已匹配方案不可删（后端同样拦截并返回 100002，此处先提示避免无效请求）
    if (plan.status === 'matched') {
      Taro.showToast({ title: '已匹配的方案不可删除', icon: 'none' })
      return
    }
    Taro.showModal({
      title: '删除方案',
      content: `确定要删除方案"${plan.title}"吗？`,
      confirmColor: '#ef4444',
      success: (res) => {
        if (!res.confirm) return
        Taro.showLoading({ title: '删除中...', mask: true })
        del(`/plans/${id}`)
          .then(() => {
            Taro.hideLoading()
            Taro.showToast({ title: '已删除', icon: 'none', duration: 1000 })
            fetchPlans()
          })
          .catch((err: any) => {
            Taro.hideLoading()
            Taro.showToast({ title: (err && err.message) || '删除失败', icon: 'none' })
          })
      }
    })
  }

  function goBack() {
    Taro.navigateBack()
  }

  function goChat() {
    Taro.navigateBack()
  }

  const activeFilterLabel = activeFilter === 'all' ? '' : FILTERS.find((f) => f.value === activeFilter)?.label || ''

  return (
    <View className='page plans-page'>
      <TopNav title='我的方案' showBack onBack={goBack} />

      {/* 活动轮播（无活动自动隐藏不占位） */}
      <ActivityCarousel position='plans' />

      <View className='filter-bar'>
        {FILTERS.map((item) => (
          <View
            key={item.value}
            className={`filter-item ${activeFilter === item.value ? 'filter-item-active' : ''}`}
            onClick={() => switchFilter(item.value)}
          >
            <Text>{item.label}</Text>
          </View>
        ))}
      </View>

      <ScrollView className='plans-scroll' scrollY enhanced showScrollbar={false}>
        {loading ? (
          <EmptyState title='加载中...' />
        ) : error ? (
          <EmptyState icon='clipboard' title={error} actionText='重试' onAction={fetchPlans} />
        ) : filteredPlans.length === 0 ? (
          <EmptyState
            icon='clipboard'
            title={`暂无${activeFilterLabel}方案`}
            hint='去对话页与 AI 聊聊，获取专属门窗安装方案'
            actionText='去咨询'
            onAction={goChat}
          />
        ) : (
          <View className='plans-list'>
            {filteredPlans.map((item) => (
              <PlanCard
                key={item.id}
                itemId={item.id}
                title={item.title}
                status={item.status}
                windowCount={item.windowCount}
                estimatedPrice={item.estimatedPrice}
                material={item.material}
                area={item.area}
                glassChoice={item.glassChoice}
                openingType={item.openingType}
                roomType={item.roomType}
                onView={(d) => onViewPlan(d.id)}
                onSubmit={(d) => onSubmitPlan(d.id)}
                onViewMerchants={(d) => onViewMerchants(d.id)}
                onDelete={(d) => onLongPressDelete(d.id)}
                onLongPressDelete={(d) => onLongPressDelete(d.id)}
                onReview={(d) => onGoReview(d.id)}
              />
            ))}
          </View>
        )}

        <View className='bottom-safe' />
      </ScrollView>

      {/* 匹配商家弹层（matched 方案查看提交时匹配到的商家） */}
      {showMerchantPopup ? (
        <View className='merchant-popup-mask' onClick={closeMerchantPopup}>
          <View className='merchant-popup' catchMove onClick={() => {}}>
            <View className='popup-header'>
              <Text className='popup-title'>匹配商家 · {popupPlanTitle}</Text>
              <View className='popup-close' onClick={closeMerchantPopup}>
                <Text className='adwicon adwicon-xmark'>{''}</Text>
              </View>
            </View>
            <ScrollView className='popup-scroll' scrollY enhanced showScrollbar={false}>
              {popupMerchants.length === 0 ? (
                <View className='popup-empty'>
                  <Text>暂无匹配商家</Text>
                </View>
              ) : (
                <View className='popup-list'>
                  {popupMerchants.map((merchant) => (
                    <MerchantCard
                      key={merchant.id}
                      itemId={merchant.id}
                      photo={merchant.photo}
                      name={merchant.name}
                      rating={merchant.rating}
                      phone={merchant.phone}
                      distance={merchant.region}
                      matchReason={merchant.matchReason}
                      tags={merchant.tags}
                      warrantyYears={merchant.warranty_years}
                      installerType={merchant.installer_type}
                      years={merchant.years}
                      onContact={onMerchantContact}
                      onView={(d) => onMerchantView(d.id)}
                    />
                  ))}
                </View>
              )}
            </ScrollView>
          </View>
        </View>
      ) : null}
    </View>
  )
}
