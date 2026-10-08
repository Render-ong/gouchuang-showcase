// ponytail: 微信/QQ/JD 需要 getFuzzyLocation 权限声明（首登填地区）；
// 抖音 tt 不支持 permission 字段里的 desc 自定义，H5 端忽略此字段，均不声明。
// 注意：scope.userFuzzyLocation 不能写进 permission——基础库 2.32.3+ 工具直接报
// "unable to customize" 编译失败，getFuzzyLocation 授权弹窗文案由系统固定，声明 requiredPrivateInfos 即可
const isWechatLike = process.env.TARO_ENV !== 'tt' && process.env.TARO_ENV !== 'h5'
const platformConfig: Record<string, any> = {}
if (isWechatLike) {
  platformConfig.requiredPrivateInfos = ['getFuzzyLocation']
}

export default defineAppConfig({
  pages: [
    'pages/chat/index',
    'pages/plans/index',
    'pages/plan-detail/index',
    'pages/merchant-detail/index',
    'pages/product-detail/index',
    'pages/products/index',
    'pages/profile/index',
    'pages/account-security/index',
    'pages/favorites/index',
    'pages/agreement/index',
    'pages/review-eligible/index',
    'pages/review-submit/index',
    'pages/review-list/index',
    'pages/review-detail/index',
    'pages/user-info/index',
    'pages/feedback/index',
    'pages/activity-detail/index',
    'pages/install-record/index',
    'pages/oauthConfirm/index'
  ],
  subPackages: [
    {
      root: 'packages/merchant',
      pages: [
        'pages/center/index',
        'pages/apply/index',
        'pages/products/index',
        'pages/product-edit/index',
        'pages/leads/index',
        'pages/dashboard/index',
        'pages/reviews/index',
        'pages/install-customers/index',
        'pages/install-profile/index',
        'pages/install-item-edit/index'
      ]
    }
  ],
  window: {
    navigationStyle: 'default',
    backgroundColor: '#f8fafc',
    backgroundTextStyle: 'dark',
    enablePullDownRefresh: false
  },
  style: 'v2',
  lazyCodeLoading: 'requiredComponents',
  ...platformConfig
})
