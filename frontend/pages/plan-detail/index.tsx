import { View, Text, Input, Textarea, ScrollView } from '@tarojs/components'
import { useState, useEffect } from 'react'
import Taro, { useShareAppMessage, useShareTimeline, useRouter } from '@tarojs/taro'
import TopNav from '../../components/top-nav'
import ActivityCarousel from '../../components/activity-carousel'
import DetailSection from '../../components/detail-section'
import TagList from '../../components/tag-list'
import MerchantCard from '../../components/merchant-card'
import { put, post, get } from '../../services/request'
import { onSharedInviter, saveInviteCred } from '../../services/invite'
import { useAuth } from '../../store/auth-context'
import { makePhoneCallSafe } from '../../utils/cross-platform'
import { resolveImageUrl } from '../../utils/upload'
import './index.scss'

// 商家卡片 photo 绝对化（方案快照存相对路径，与 chat 页同一缓存 URL）
function absPhoto(m: any) {
  return (m && m.photo) ? Object.assign({}, m, { photo: resolveImageUrl(m.photo) }) : m
}

// 用户需求快照（userRequirements）展示标签
// ponytail: 排除 room_type/area/glass_choice/opening_type——方案配置已在指标区展示，需求区只补对话中
// 提供的环境类需求（地区/预算/楼层/房屋类型/尺寸/环境/特殊需求/采纳建议），避免与指标区重复。
// 采纳建议（advice_context）是非枚举自由文本（如"选用EPDM胶条"），同样在需求区回显。
const REQ_LABELS: Record<string, string> = {
  location: '地区',
  floor: '楼层',
  budget: '预算',
  persona: '房屋类型',
  window_size: '窗户尺寸',
  environment: '环境',
  special_needs: '特殊需求',
  lifecycle: '需求阶段',
  advice_context: '采纳建议'
}

interface MerchantItem {
  id: string
  name?: string
  rating?: number
  phone?: string
  region?: string
  matchReason?: string
  tags?: string[]
  [key: string]: any
}

interface Plan {
  id: string
  title?: string
  status?: string
  tier?: string
  estimatedPrice?: number | string
  area?: string
  glassChoice?: string
  openingType?: string
  roomType?: string
  material?: string
  windowCount?: number | string
  desc?: string
  productName?: string
  priceRange?: string
  features?: string[]
  merchants?: MerchantItem[]
  userRequirements?: Record<string, any>
  [key: string]: any
}

interface PlanForm {
  title: string
  area: string
  glassChoice: string
  openingType: string
  material: string
  roomType: string
  windowCount: string
  desc: string
}

// 需求快照展示项构造：按 REQ_LABELS 顺序取非空值
function buildReqItems(userRequirements?: Record<string, any>): { label: string; value: string }[] {
  if (!userRequirements || typeof userRequirements !== 'object') return []
  const items: { label: string; value: string }[] = []
  Object.keys(REQ_LABELS).forEach((k) => {
    const v = userRequirements[k]
    if (v === undefined || v === null || v === '') return
    items.push({ label: REQ_LABELS[k], value: Array.isArray(v) ? v.join('、') : String(v) })
  })
  return items
}

function formatPrice(val: any): string {
  if (val === null || val === undefined || val === '') return ''
  const num = Number(val)
  if (isNaN(num)) return String(val)
  return num.toLocaleString('zh-CN')
}

export default function PlanDetailPage() {
  const router = useRouter()
  const { isLoggedIn, getUserId } = useAuth()
  const [plan, setPlan] = useState<Plan | null>(null)
  const [statusText, setStatusText] = useState('')
  const [formattedPrice, setFormattedPrice] = useState('')
  // 需求快照展示项 [{label, value}]
  const [reqItems, setReqItems] = useState<{ label: string; value: string }[]>([])
  // 编辑态
  const [editing, setEditing] = useState(false)
  const [saving, setSaving] = useState(false)
  const [form, setForm] = useState<PlanForm>({
    title: '',
    area: '',
    glassChoice: '',
    openingType: '',
    material: '',
    roomType: '',
    windowCount: '',
    desc: ''
  })

  useEffect(() => {
    // 分享卡片接收：path 带 pid（分享者的方案 id），免登录拉取展示
    const pid = router.params.pid
    if (pid) {
      get('/shares/plan-view', { pid })
        .then((res: any) => { if (res) loadPlan(res) })
        .catch(() => {
          Taro.showToast({ title: '内容已过期', icon: 'none' })
          setTimeout(() => Taro.navigateBack({ fail: () => { /* 已是首页则忽略 */ } }), 1200)
        })
      // 邀请归因：未登录用户经方案分享进入，暂存来源方案 pid（带时间戳，7 天内有效），
      // 注册登录时随请求带给后端反查方案归属
      if (!getUserId()) saveInviteCred('pid', pid)
    } else {
      // ponytail: Taro 不支持 eventChannel，改用 storage 中转
      // plans / chat 页 navigateTo 前写 plan_detail_data（完整 plan 对象，无需后端单条详情接口）
      const data = Taro.getStorageSync('plan_detail_data')
      if (data) {
        loadPlan(data)
        Taro.removeStorageSync('plan_detail_data')
      }
      // ponytail: 直开页面（非 navigateTo 带数据，如编译预览/异常路径）时兜底返回，避免白屏
      const timer = setTimeout(() => {
        if (!data) {
          Taro.showToast({ title: '方案数据加载失败', icon: 'none' })
          setTimeout(() => Taro.navigateBack({ fail: () => { /* 已是首页则忽略 */ } }), 800)
        }
      }, 1000)
      return () => clearTimeout(timer)
    }
    // 邀请归因（显式）：path 带 inviter 的接收端归因（pid 与 inviter 可同卡片并存），
    // 无条件暂存（老用户打开也计入加成），已登录立即上报，未登录等登录后上报
    onSharedInviter(router.params.inviter || '', isLoggedIn)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // 分享（右上角转发）：path 带 pid + inviter（与原生 plan-detail 同模式），好友打开
  // 分享链接即计入分享者当日加成，未登录好友注册后反查方案归属
  useShareAppMessage(() => {
    const inv = getUserId() ? `&inviter=${encodeURIComponent(getUserId())}` : ''
    // 无方案（加载中/已过期）→ 默认卡片
    if (!plan || !plan.id) {
      return {
        title: '门窗 AI 导购助手 - 问我任何门窗问题',
        path: `/pages/plan-detail/index${inv ? '?' + inv.slice(1) : ''}`
      }
    }
    const title = (plan.title || '我的门窗方案').slice(0, 24)
    // 埋点 fire-and-forget（plan_shared），管理端用户时间线可见
    post('/shares/plan-log', { plan_id: plan.id, title }).catch(() => {})
    return {
      title: `${title} · 来自好友分享的门窗方案`,
      path: `/pages/plan-detail/index?pid=${plan.id}${inv}`
    }
  })

  // 朋友圈分享：query 同样带 pid+inviter（好友从朋友圈点开落回本页走接收端链路）
  useShareTimeline(() => {
    const query = [
      plan && plan.id ? `pid=${plan.id}` : '',
      getUserId() ? `inviter=${encodeURIComponent(getUserId())}` : ''
    ].filter(Boolean).join('&')
    return {
      title: '门窗 AI 导购助手 - 问我任何门窗问题',
      query
    }
  })

  function loadPlan(p: Plan) {
    if (!p) return
    const statusMap: Record<string, string> = { draft: '草稿', submitted: '已提交', matched: '已匹配' }
    // 商家卡片 photo 绝对化（方案快照存相对路径，与 chat 页同一缓存 URL）
    const withPhoto: Plan = (p.merchants && p.merchants.length)
      ? Object.assign({}, p, { merchants: p.merchants.map(absPhoto) })
      : p
    setPlan(withPhoto)
    setStatusText(statusMap[p.status || ''] || p.status || '')
    setFormattedPrice(formatPrice(p.estimatedPrice))
    setReqItems(buildReqItems(p.userRequirements))
    setForm({
      title: p.title || '',
      area: p.area || '',
      glassChoice: p.glassChoice || '',
      openingType: p.openingType || '',
      material: p.material || '',
      roomType: p.roomType || '',
      windowCount: p.windowCount !== undefined && p.windowCount !== null ? String(p.windowCount) : '',
      desc: p.desc || ''
    })
    setEditing(false)
    setSaving(false)
  }

  function goBack() {
    Taro.navigateBack({ delta: 1 })
  }

  // ─── 编辑 ───

  function onStartEdit() {
    if (!plan) return
    // submitted 方案编辑前提示
    if (plan.status === 'submitted') {
      Taro.showModal({
        title: '编辑方案',
        content: '编辑后将重置为草稿状态，需要重新提交匹配商家，是否继续？',
        confirmColor: '#2563eb',
        success: (res) => {
          if (res.confirm) setEditing(true)
        }
      })
      return
    }
    setEditing(true)
  }

  function onCancelEdit() {
    setEditing(false)
  }

  function onFieldInput(field: keyof PlanForm, value: string) {
    setForm((prev) => ({ ...prev, [field]: value }))
  }

  function onSaveEdit() {
    if (!plan || !plan.id) return
    // ponytail: 只传非空字段，避免把空串覆盖成正式值（后端白名单 + None 过滤兜底，前端先剔一遍减少脏写）
    const payload: Record<string, string> = {}
    const f = form
    const keys: (keyof PlanForm)[] = ['title', 'area', 'glassChoice', 'openingType', 'material', 'roomType', 'windowCount', 'desc']
    keys.forEach((k) => {
      if (f[k] !== '' && f[k] !== null && f[k] !== undefined) payload[k] = String(f[k])
    })
    if (Object.keys(payload).length === 0) {
      Taro.showToast({ title: '未修改任何字段', icon: 'none' })
      return
    }
    setSaving(true)
    put(`/plans/${plan.id}`, payload)
      .then((res: any) => {
        setSaving(false)
        Taro.showToast({ title: '已保存', icon: 'success' })
        // 列表脏缓存标记：返回方案页时 onShow 强制拉后端，避免显示修改前的旧缓存
        Taro.setStorageSync('plans_dirty', true)
        // 后端返回更新后方案（area 变会重算预估价 + userRequirements 同步），直接刷新页面
        if (res && res.id) {
          loadPlan(res)
        } else if (plan) {
          loadPlan({ ...plan, ...payload })
        }
      })
      .catch((err: any) => {
        setSaving(false)
        Taro.showToast({ title: (err && err.message) || '保存失败', icon: 'none' })
      })
  }

  // ─── 提交匹配（draft → matched，复用 plans 页逻辑） ───

  function onSubmit() {
    if (!plan || !plan.id) return
    Taro.showModal({
      title: '提交方案',
      content: '提交后将为您匹配附近可承接该方案的商家，是否继续？',
      confirmColor: '#2563eb',
      success: (res) => {
        if (!res.confirm) return
        Taro.showLoading({ title: '提交中...', mask: true })
        post(`/plans/${plan.id}/submit`)
          .then((data: any) => {
            Taro.hideLoading()
            // 列表脏缓存标记：返回方案页时 onShow 强制拉后端，避免显示旧 draft 状态
            Taro.setStorageSync('plans_dirty', true)
            const merchants = (data && data.merchants) || []
            if (data && data.id) {
              loadPlan(data)
            } else if (plan) {
              loadPlan({ ...plan, status: 'submitted' })
            }
            if (!merchants.length) {
              Taro.showToast({ title: '已提交，暂无匹配商家', icon: 'none' })
            }
          })
          .catch((err: any) => {
            Taro.hideLoading()
            Taro.showToast({ title: (err && err.message) || '提交失败', icon: 'none' })
          })
      }
    })
  }

  // ─── 匹配商家卡片 ───

  function onMerchantContact(detail: { id: string; phone: string; name: string }) {
    const { phone } = detail
    if (!phone) {
      Taro.showToast({ title: '该商家暂无电话', icon: 'none' })
      return
    }
    makePhoneCallSafe(String(phone)).catch(() => { /* 用户取消拨号不提示 */ })
  }

  function onMerchantView(detail: { id: string }) {
    const { id } = detail
    const merchant = ((plan && plan.merchants) || []).find((m) => m.id === id) || {}
    // ponytail: Taro 不支持 eventChannel，改用 storage 中转（与 merchant-detail 页读法一致）
    Taro.setStorageSync('merchant_detail_data', merchant)
    Taro.navigateTo({ url: `/pages/merchant-detail/index?id=${id}` })
  }

  return (
    <View className='detail-page'>
      <TopNav title='方案详情' showBack onBack={goBack} />

      {/* 活动轮播（无活动自动隐藏不占位；放 scroll-view 外，与方案加载状态无关） */}
      <ActivityCarousel position='plan_detail' />

      {plan ? (
        <ScrollView className='detail-scroll' scrollY enhanced showScrollbar={false}>
          <View className='detail-card'>
            {/* 头部：标题 + 状态徽标 + 档次 */}
            <View className='detail-header'>
              <View className='name-row'>
                <Text className='detail-name'>{plan.title}</Text>
                <View className={`status-badge status-${plan.status}`}>
                  <Text className='status-text'>{statusText}</Text>
                </View>
              </View>
              {plan.tier ? <Text className='tier-tag'>{plan.tier}</Text> : null}
            </View>

            {/* 预估总价横幅 */}
            <View className='price-banner'>
              <Text className='price-label'>预估总价</Text>
              <Text className='price-value'>{formattedPrice ? `¥${formattedPrice}` : '待面积确认'}</Text>
            </View>

            {/* 查看态：核心配置指标 */}
            {!editing ? (
              <View className='metrics-grid'>
                {plan.area ? (
                  <View className='metric'>
                    <Text className='metric-value-text'>{plan.area}</Text>
                    <Text className='metric-label'>封窗面积</Text>
                  </View>
                ) : null}
                {plan.glassChoice ? (
                  <View className='metric'>
                    <Text className='metric-value-text'>{plan.glassChoice}</Text>
                    <Text className='metric-label'>玻璃</Text>
                  </View>
                ) : null}
                {plan.openingType ? (
                  <View className='metric'>
                    <Text className='metric-value-text'>{plan.openingType}</Text>
                    <Text className='metric-label'>开启方式</Text>
                  </View>
                ) : null}
                {plan.roomType ? (
                  <View className='metric'>
                    <Text className='metric-value-text'>{plan.roomType}</Text>
                    <Text className='metric-label'>房间类型</Text>
                  </View>
                ) : null}
                {plan.material ? (
                  <View className='metric'>
                    <Text className='metric-value-text'>{plan.material}</Text>
                    <Text className='metric-label'>主要材质</Text>
                  </View>
                ) : null}
                {plan.windowCount ? (
                  <View className='metric'>
                    <Text className='metric-value-text'>{plan.windowCount}</Text>
                    <Text className='metric-label'>门窗数量</Text>
                  </View>
                ) : null}
              </View>
            ) : (
              /* 编辑态：全字段自由文本输入 */
              <View className='plan-edit'>
                <View className='edit-row'>
                  <Text className='edit-label'>方案名称</Text>
                  <Input className='edit-input' value={form.title} onInput={(e) => onFieldInput('title', e.detail.value)} placeholder='如 阳台封窗方案' />
                </View>
                <View className='edit-row'>
                  <Text className='edit-label'>门窗数量</Text>
                  <Input className='edit-input' type='number' value={form.windowCount} onInput={(e) => onFieldInput('windowCount', e.detail.value)} placeholder='如 3' />
                </View>
                <View className='edit-row'>
                  <Text className='edit-label'>封窗面积</Text>
                  <Input className='edit-input' value={form.area} onInput={(e) => onFieldInput('area', e.detail.value)} placeholder='如 8平米（改后重算价）' />
                </View>
                <View className='edit-row'>
                  <Text className='edit-label'>主要材质</Text>
                  <Input className='edit-input' value={form.material} onInput={(e) => onFieldInput('material', e.detail.value)} placeholder='如 断桥铝' />
                </View>
                <View className='edit-row'>
                  <Text className='edit-label'>玻璃</Text>
                  <Input className='edit-input' value={form.glassChoice} onInput={(e) => onFieldInput('glassChoice', e.detail.value)} placeholder='如 Low-E玻璃、中空玻璃' />
                </View>
                <View className='edit-row'>
                  <Text className='edit-label'>开启方式</Text>
                  <Input className='edit-input' value={form.openingType} onInput={(e) => onFieldInput('openingType', e.detail.value)} placeholder='自由填写，如 平开、推拉、内开内倒' />
                </View>
                <View className='edit-row'>
                  <Text className='edit-label'>房间类型</Text>
                  <Input className='edit-input' value={form.roomType} onInput={(e) => onFieldInput('roomType', e.detail.value)} placeholder='如 主卧' />
                </View>
                <View className='edit-row edit-row-textarea'>
                  <Text className='edit-label'>方案说明</Text>
                  <Textarea className='edit-textarea' value={form.desc} onInput={(e) => onFieldInput('desc', e.detail.value)} placeholder='方案补充说明（可选）' />
                </View>
              </View>
            )}

            {/* 生成方案时的对话用户需求 */}
            <DetailSection title='对话中的需求' show={reqItems.length > 0}>
              {reqItems.map((item) => (
                <View className='req-row' key={item.label}>
                  <Text className='req-label'>{item.label}</Text>
                  <Text className='req-value'>{item.value}</Text>
                </View>
              ))}
            </DetailSection>

            {/* 产品信息 */}
            <DetailSection title='产品信息' show={!!plan.productName}>
              <Text className='section-text'>{plan.productName}</Text>
              {plan.priceRange ? <Text className='section-sub'>{plan.priceRange}</Text> : null}
              {plan.features && plan.features.length ? <TagList tags={plan.features} variant='advantage' /> : null}
            </DetailSection>

            {/* 方案说明（查看态，编辑态已包含在表单中） */}
            {!editing ? (
              <DetailSection title='方案说明' show={!!plan.desc}>
                <Text className='section-text'>{plan.desc}</Text>
              </DetailSection>
            ) : null}

            {/* 匹配商家（matched 方案 submit 时匹配结果） */}
            <DetailSection title='匹配商家' show={!!(plan.merchants && plan.merchants.length)}>
              <View className='merchant-list'>
                {(plan.merchants || []).map((item) => (
                  <MerchantCard
                    key={item.id}
                    itemId={item.id}
                    photo={item.photo}
                    name={item.name}
                    rating={item.rating}
                    phone={item.phone}
                    distance={item.region}
                    matchReason={item.matchReason}
                    tags={item.tags}
                    onContact={onMerchantContact}
                    onView={onMerchantView}
                  />
                ))}
              </View>
            </DetailSection>
          </View>
        </ScrollView>
      ) : null}

      {/* 底部操作栏 */}
      {plan && (editing || plan.status === 'draft' || plan.status === 'submitted') ? (
        <View className='detail-footer'>
          {editing ? (
            <>
              <View className='foot-btn foot-btn-ghost' onClick={onCancelEdit}>取消</View>
              <View className='foot-btn foot-btn-primary' onClick={onSaveEdit}>{saving ? '保存中...' : '保存'}</View>
            </>
          ) : plan.status === 'submitted' ? (
            <>
              <View className='foot-btn foot-btn-ghost' onClick={onStartEdit}>编辑（重置为草稿）</View>
              <View className='foot-btn foot-btn-primary' onClick={onSubmit}>重新提交</View>
            </>
          ) : (
            <>
              <View className='foot-btn foot-btn-ghost' onClick={onStartEdit}>编辑</View>
              <View className='foot-btn foot-btn-primary' onClick={onSubmit}>提交匹配</View>
            </>
          )}
        </View>
      ) : null}
    </View>
  )
}
