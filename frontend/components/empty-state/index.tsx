import { View, Text } from '@tarojs/components'
import './index.scss'

export interface EmptyStateProps {
  icon?: string
  iconColor?: string
  title?: string
  hint?: string
  actionText?: string
  onAction?: () => void
}

// 统一空/错/加载态：icon + title + hint + action
// ponytail: 仅覆盖 plans/favorites 的完整模式；conversation-drawer 的紧凑
// drawer-state（纯文本+小重试按钮）与 chat 的欢迎页是不同视觉模式，未合并
export default function EmptyState({
  icon = '',
  iconColor = '',
  title = '',
  hint = '',
  actionText = '',
  onAction
}: EmptyStateProps) {
  return (
    <View className='empty-state'>
      {icon ? (
        <View className='empty-icon'>
          <Text
            className={`adwicon icon adwicon-${icon}`}
            style={iconColor ? `color: ${iconColor}` : ''}
          >
            {''}
          </Text>
        </View>
      ) : null}
      <Text className='empty-title'>{title}</Text>
      {hint ? <Text className='empty-hint'>{hint}</Text> : null}
      {actionText ? (
        <View className='empty-action btn btn-primary' onClick={onAction}>
          <Text>{actionText}</Text>
        </View>
      ) : null}
    </View>
  )
}
