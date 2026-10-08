// 抖音端对话页自定义导航栏（menu 按钮与平台胶囊同行，对齐微信端布局）。
// ⚠️ 抖音「自定义页面结构」能力未过审时配 custom 会阻碍代码包上传（官方配置文档明确），
// 故本文件必须与 src/services/config.ts 的 TT_NAV_CUSTOM_APPROVED 同值——能力过审后两处一起改 true。
// 页面配置在构建期独立求值，不能 import 运行时代码（会拉入 Taro 运行时），只能字面量重复。
const TT_NAV_CUSTOM_APPROVED = false
const isTT = process.env.TARO_ENV === 'tt'

export default definePageConfig({
  navigationStyle: isTT && TT_NAV_CUSTOM_APPROVED ? 'custom' : 'default',
  backgroundColor: '#f8fafc',
  navigationBarTitleText: '构窗AI',
  // Taro React 下 useShareAppMessage/useShareTimeline 生效前提（缺了转发走默认卡片，inviter 不带上）
  enableShareAppMessage: true,
  enableShareTimeline: true
})
