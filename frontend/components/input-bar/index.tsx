import { View, Text, Textarea, Image } from '@tarojs/components'
import { useState, useRef, useEffect, forwardRef, useImperativeHandle } from 'react'
import './index.scss'

export interface InputBarProps {
  disabled?: boolean
  sending?: boolean
  // 拍照看效果：待发送窗图 {path, uploading, fail}，null 隐藏
  pendingImage?: { path: string; uploading?: boolean; fail?: boolean } | null
  onSubmit?: (text: string) => void
  onStop?: () => void
  onCamera?: () => void
  onVoice?: () => void
  onRemoveImage?: () => void
}

export interface InputBarRef {
  // 拍照看效果：页面组装好提示词后程序化填入输入框（用户可再编辑）
  setText: (text: string) => void
}

const InputBar = forwardRef<InputBarRef, InputBarProps>(function InputBar({
  disabled = false,
  sending = false,
  pendingImage = null,
  onSubmit,
  onStop,
  onCamera,
  onVoice,
  onRemoveImage
}, ref) {
  // ponytail: 非受控模式——Taro React 受控 value 在中文 IME 下会打断拼音组合输入
  // 升级路径: Taro 若支持 compositionstart/end 事件，可回退受控模式获得实时 value 同步
  const textRef = useRef('')
  const [hasText, setHasText] = useState(false)
  const [resetKey, setResetKey] = useState(0)
  // ponytail: 停止按钮延迟 800ms 生效——停止键与发送键同位置瞬间互换，
  // 双击/连点的第二击会落在刚出现的停止键上误杀自己的请求（"一发消息就被停止"）。
  // 真实想停的用户 0.8s 后点照样生效。
  const [stopReady, setStopReady] = useState(false)
  const stopTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useImperativeHandle(ref, () => ({
    setText(text: string) {
      const v = text || ''
      textRef.current = v
      setHasText(v.trim().length > 0)
      setResetKey((k) => k + 1)
    }
  }))

  useEffect(() => {
    if (stopTimerRef.current) {
      clearTimeout(stopTimerRef.current)
      stopTimerRef.current = null
    }
    if (sending) {
      setStopReady(false)
      stopTimerRef.current = setTimeout(() => {
        setStopReady(true)
        stopTimerRef.current = null
      }, 800)
    } else {
      setStopReady(false)
    }
    return () => {
      if (stopTimerRef.current) {
        clearTimeout(stopTimerRef.current)
        stopTimerRef.current = null
      }
    }
  }, [sending])

  function onInput(e: any) {
    textRef.current = e.detail.value || ''
    setHasText(textRef.current.trim().length > 0)
  }

  function handleSubmit() {
    // sending 时不允许再提交
    if (disabled || sending) return
    const t = textRef.current.trim()
    if (!t) return
    if (onSubmit) onSubmit(t)
    textRef.current = ''
    setHasText(false)
    setResetKey((k) => k + 1) // 重置 Textarea 清空显示
  }

  return (
    <View className='input-bar'>
      {/* 拍照看效果 / 语音通话入口：白色胶囊并排悬浮在输入栏上方（事件外抛由页面接入） */}
      <View className='camera-row'>
        <View className={`camera-btn ${disabled ? 'camera-btn-off' : ''}`} onClick={onCamera}>
          <Text className='adwicon camera-icon adwicon-camera'>{''}</Text>
          <Text className='camera-text'>拍照看效果</Text>
        </View>
        <View className={`camera-btn voice-btn ${disabled ? 'camera-btn-off' : ''}`} onClick={onVoice}>
          <Text className='adwicon camera-icon adwicon-phone'>{''}</Text>
          <Text className='camera-text'>语音通话</Text>
        </View>
      </View>
      <View className='input-wrap'>
        {/* 待发送窗图缩略图（拍照看效果流程）：上传中遮罩 + 可移除 */}
        {pendingImage ? (
          <View className='pending-image-box'>
            <Image className='pending-image' src={pendingImage.path} mode='aspectFill' />
            {pendingImage.uploading ? (
              <View className='pending-image-mask'>上传中…</View>
            ) : pendingImage.fail ? (
              <View className='pending-image-mask pending-image-fail'>上传失败</View>
            ) : null}
            <View className='pending-image-remove' onClick={onRemoveImage}>
              <Text className='adwicon pending-image-remove-icon adwicon-close-filled'>{''}</Text>
            </View>
          </View>
        ) : null}
        <View className='input-row'>
          <Textarea
            key={resetKey}
            className='input-textarea'
            onInput={onInput}
            onConfirm={handleSubmit}
            placeholder='输入您的门窗需求...'
            placeholderClass='input-placeholder'
            maxlength={1000}
            autoHeight
            showConfirmBar={false}
          />
          <View className='action-box'>
            {/* ponytail: 停止按钮延迟 800ms 出现（stopReady）——与发送按钮同位置瞬间互换时，
                双击/连点的第二击会落在停止键上误杀自己的请求（表现为"一发消息就被停止"） */}
            {sending && stopReady ? (
              <View className='stop-overlay' onClick={onStop}>
                <View className='stop-icon-block' />
              </View>
            ) : sending ? (
              /* 延迟窗口内：同款外观但无事件绑定，连点第二击落空 */
              <View className='stop-overlay'>
                <View className='stop-icon-block' />
              </View>
            ) : (
              /* ponytail: 语音功能未上线，统一用发送按钮；无文字时灰态（handleSubmit 空文本会拦截） */
              <View
                className={`send-overlay ${hasText ? '' : 'send-disabled'}`}
                onClick={handleSubmit}
              >
                <Text className='adwicon send-icon adwicon-paper-plane'>{''}</Text>
              </View>
            )}
          </View>
        </View>
      </View>
      {/* 抖音端：输入栏下方居中灰字提示（原生导航栏只支持单行标题放不下，改放底部；微信端/H5 端不渲染） */}
      {process.env.TARO_ENV === 'tt' ? <View className='input-subnote'>内容由构窗AI生成</View> : null}
    </View>
  )
})

export default InputBar
