import { View, Text, ScrollView, Image, RichText } from '@tarojs/components'
import Taro from '@tarojs/taro'
import { useMemo } from 'react'
import { parse, type InlineNode, type BlockNode } from '../../utils/markdown'
import { setClipboardSafe } from '../../utils/cross-platform'
import './index.scss'

// 链接点击：小程序不支持外链跳转，复制到剪贴板
// ponytail: 升级路径为 Taro.navigateTo + webview 内嵌白名单域名
function onLinkTap(url: string) {
  if (!url) return
  // 跨端剪贴板：H5 端 Taro.setClipboardData 部分支持，统一走 setClipboardSafe
  setClipboardSafe(url)
    .then(() => Taro.showToast({ title: '链接已复制', icon: 'none', duration: 1000 }))
    .catch(() => Taro.showToast({ title: '复制失败', icon: 'none' }))
}

// 公式节点渲染：
//   KaTeX 成功（html 非空）→ RichText 承载（rich-text 不能嵌在小程序 <text> 内，
//   React 版各内联容器本就是 <View>，故直接平级渲染即可，无需 mp 端的整块换模板机制）；
//   失败/含 svg → Unicode 近似文本（parse 时已生成），衬线字体让 _ / ^ 更易辨认。
// display=true（$$…$$ / \[…\]）走块级滚动容器：AI 常把 $$ 跟在句尾跨行输出，压行后公式落在
// 句子中间的行内通道里；display 公式本就该独占一行，且超宽时只有 scroll-view 能兜住。
function renderMathNode(n: Extract<InlineNode, { type: 'math' }>, key: string) {
  if (n.html) {
    if (n.display) {
      return (
        <ScrollView key={key} scrollX className='md-math-scroll'>
          <View className='md-math-block'>
            <RichText
              className={`md-math-rich md-math-rich-display ${n.tagged ? 'md-math-tagged' : ''}`}
              nodes={n.html}
            />
          </View>
        </ScrollView>
      )
    }
    return <RichText key={key} className='md-math-rich' nodes={n.html} />
  }
  return (
    <Text key={key} className={`md-math ${n.display ? 'md-math-display' : ''}`} userSelect>
      {n.text}
    </Text>
  )
}

function renderInline(nodes: InlineNode[], keyPrefix: string) {
  return nodes.map((n, i) => {
    const key = `${keyPrefix}-${i}`
    switch (n.type) {
      case 'text':
        return (
          <Text key={key} userSelect>
            {n.text}
          </Text>
        )
      case 'bold':
        return (
          <Text key={key} className='md-bold' userSelect>
            {n.text}
          </Text>
        )
      case 'italic':
        return (
          <Text key={key} className='md-italic' userSelect>
            {n.text}
          </Text>
        )
      case 'code':
        return (
          <Text key={key} className='md-code-inline' userSelect>
            {n.text}
          </Text>
        )
      case 'link':
        return (
          <Text
            key={key}
            className='md-link'
            userSelect
            onClick={() => onLinkTap(n.url)}
          >
            {n.text}
          </Text>
        )
      case 'cite':
        return (
          <Text key={key} className='md-cite' userSelect>
            {n.text}
          </Text>
        )
      case 'math':
        return renderMathNode(n, key)
    }
  })
}

export interface MarkdownViewProps {
  content?: string
  // 图片展示模式：thumb = 限高缩略图（聊天/收藏），full = 全宽自适应大图（活动详情运营内容）
  imageMode?: 'thumb' | 'full'
}

// ponytail: useMemo 缓存解析结果，流式更新时每个 delta 都会触发 prop 变化
export default function MarkdownView({ content = '', imageMode = 'thumb' }: MarkdownViewProps) {
  const nodes = useMemo(() => parse(content || ''), [content])
  const isFull = imageMode === 'full'

  // 图片点击：预览本条 markdown 内的全部图片（含图组内多图，可左右滑）
  // ponytail: 图集取自已解析节点，不额外拉接口；单图时 urls=[url] 保证 current 有效
  function onImageTap(url: string) {
    if (!url) return
    const urls: string[] = []
    nodes.forEach((n: BlockNode) => {
      if (n.type === 'image' && n.url) urls.push(n.url)
      else if (n.type === 'imageGroup') n.images.forEach((img) => img.url && urls.push(img.url))
    })
    Taro.previewImage({ current: url, urls: urls.length ? urls : [url] })
  }

  return (
    <View className='md-view'>
      {nodes.map((node, i) => {
        const key = `block-${i}`
        switch (node.type) {
          case 'heading':
            return (
              <View key={key} className={`md-h md-h${node.level}`}>
                {renderInline(node.inline, key)}
              </View>
            )
          case 'paragraph':
            return (
              <View key={key} className='md-p'>
                {renderInline(node.inline, key)}
              </View>
            )
          case 'blockquote':
            return (
              <View key={key} className='md-blockquote'>
                {renderInline(node.inline, key)}
              </View>
            )
          case 'list':
            return (
              <View key={key} className='md-list'>
                {node.items.map((item, iIdx) => (
                  <View key={`${key}-item-${iIdx}`} className='md-list-item'>
                    <Text className='md-list-marker'>
                      {node.ordered ? `${iIdx + 1}.` : '•'}
                    </Text>
                    <View className='md-list-text'>
                      {renderInline(item, `${key}-item-${iIdx}`)}
                    </View>
                  </View>
                ))}
              </View>
            )
          case 'table':
            return (
              <ScrollView key={key} scrollX className='md-table-scroll'>
                <View className='md-table'>
                  <View className='md-tr md-tr-head'>
                    {node.headers.map((cell, cIdx) => (
                      <View key={`${key}-th-${cIdx}`} className='md-th'>
                        {renderInline(cell, `${key}-th-${cIdx}`)}
                      </View>
                    ))}
                  </View>
                  {node.rows.map((row, rIdx) => (
                    <View
                      key={`${key}-tr-${rIdx}`}
                      className={`md-tr ${rIdx % 2 === 1 ? 'md-tr-alt' : ''}`}
                    >
                      {row.map((cell, cIdx) => (
                        <View key={`${key}-td-${rIdx}-${cIdx}`} className='md-td'>
                          {renderInline(cell, `${key}-td-${rIdx}-${cIdx}`)}
                        </View>
                      ))}
                    </View>
                  ))}
                </View>
              </ScrollView>
            )
          case 'image':
            return (
              <View
                key={key}
                className={`md-image-box ${isFull ? 'md-image-box-full' : ''}`}
                onClick={() => onImageTap(node.url)}
              >
                <Image
                  className='md-image'
                  src={node.url}
                  mode={isFull ? 'widthFix' : 'aspectFit'}
                  lazyLoad
                  showMenuByLongpress
                />
              </View>
            )
          case 'imageGroup':
            return (
              <View key={key} className='md-img-grid'>
                {node.images.map((img, gi) => (
                  <View
                    key={`${key}-img-${gi}`}
                    className='md-img-cell'
                    onClick={() => onImageTap(img.url)}
                  >
                    <Image
                      className={`md-img-thumb ${isFull ? 'md-img-thumb-full' : ''}`}
                      src={img.url}
                      mode={isFull ? 'widthFix' : 'aspectFit'}
                      lazyLoad
                      showMenuByLongpress
                    />
                    {/* 图题用 View 而非 Text：-webkit-line-clamp 多行截断在 View 上行为稳定 */}
                    {img.alt ? <View className='md-img-cap'>{img.alt}</View> : null}
                  </View>
                ))}
              </View>
            )
          case 'math':
            // 块级公式（$$...$$ / \[...\] 独占一行）→ 居中独立成行：
            // KaTeX 成功用 RichText，失败/含 svg 回落 Unicode 近似文本；
            // scroll-view 兜住超宽公式（长分式、多行 array），不再被屏幕裁掉
            return renderMathNode(node, key)
          case 'code':
            return (
              <View key={key} className='md-code-block'>
                <Text className='md-code-content' userSelect>
                  {node.content}
                </Text>
              </View>
            )
          case 'hr':
            return <View key={key} className='md-hr' />
        }
      })}
    </View>
  )
}
