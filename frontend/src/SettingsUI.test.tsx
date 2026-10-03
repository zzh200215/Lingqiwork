// 设置中心共享件（SettingsUI）的钉子（2026-10-02 设置中心改版）：
// 这套件是十一个分区共用的表单语言，钉三条规矩——
// 开关是 button[role=switch]（不是原生 checkbox）、抽屉 Esc/遮罩都能退、
// 行结构是「左标题+说明，右控件」。分区页面不起整页渲染（各页要拉一堆端点），
// 与 SettingsPage.tools.test.tsx 同一形状：只钉件本身。
// 本仓没有挂 jest-dom：断言一律用原生 attribute / null 判断。
import { describe, expect, it, vi, afterEach } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { useState } from 'react'
import { askConfirm, ConfirmHost, Drawer, SettingGroup, SettingRow, SettingSwitch } from './SettingsUI'

afterEach(cleanup)

describe('SettingSwitch', () => {
  function Harness({ onChange }: { onChange: (v: boolean) => void }) {
    const [on, setOn] = useState(false)
    return (
      <SettingSwitch
        checked={on}
        onChange={(v) => {
          setOn(v)
          onChange(v)
        }}
        ariaLabel="混合检索"
      />
    )
  }

  it('是 role=switch 的按钮，不是原生 checkbox；点它翻转并上报新值', () => {
    const onChange = vi.fn()
    render(<Harness onChange={onChange} />)
    const sw = screen.getByRole('switch', { name: '混合检索' })
    expect(sw.tagName).toBe('BUTTON')
    expect(sw.getAttribute('aria-checked')).toBe('false')
    fireEvent.click(sw)
    expect(onChange).toHaveBeenCalledWith(true)
    expect(screen.getByRole('switch', { name: '混合检索' }).getAttribute('aria-checked')).toBe('true')
  })

  it('disabled 时不响应点击', () => {
    const onChange = vi.fn()
    render(<SettingSwitch checked={false} disabled onChange={onChange} ariaLabel="x" />)
    fireEvent.click(screen.getByRole('switch', { name: 'x' }))
    expect(onChange).not.toHaveBeenCalled()
  })
})

describe('Drawer', () => {
  it('关闭时什么都不画；打开时是对话框，Esc 与遮罩都能关', () => {
    const onClose = vi.fn()
    const { container, rerender } = render(
      <Drawer open={false} onClose={onClose} title="添加 Provider">
        <p>body</p>
      </Drawer>
    )
    expect(container.firstChild).toBeNull()

    rerender(
      <Drawer open onClose={onClose} title="添加 Provider">
        <p>body</p>
      </Drawer>
    )
    expect(screen.getByRole('dialog', { name: '添加 Provider' })).not.toBeNull()

    fireEvent.keyDown(window, { key: 'Escape' })
    expect(onClose).toHaveBeenCalledTimes(1)

    // 遮罩：data-settings-drawer 容器里的第一层就是遮罩
    const overlay = container.querySelector('[data-settings-drawer] > div') as HTMLElement
    fireEvent.click(overlay)
    expect(onClose).toHaveBeenCalledTimes(2)
  })
})

describe('SettingRow / SettingGroup', () => {
  it('行：左标题与说明，右控件；htmlFor 让标题成为 label', () => {
    render(
      <SettingRow title="RAG 检索片段数" description="控制每次查询最多带回多少相关片段。" htmlFor="k">
        <input id="k" />
      </SettingRow>
    )
    const label = screen.getByText('RAG 检索片段数')
    expect(label.tagName).toBe('LABEL')
    expect(label.getAttribute('for')).toBe('k')
    expect(screen.getByText('控制每次查询最多带回多少相关片段。')).not.toBeNull()
  })

  it('组：标题进 data-settings-group，说明可读', () => {
    render(
      <SettingGroup title="知识检索" description="控制 AI 如何从知识库中获取信息。">
        <SettingRow title="混合检索">
          <span>ctl</span>
        </SettingRow>
      </SettingGroup>
    )
    expect(document.querySelector('[data-settings-group="知识检索"]')).not.toBeNull()
    expect(screen.getByText('控制 AI 如何从知识库中获取信息。')).not.toBeNull()
  })
})

describe('askConfirm + ConfirmHost（替代 window.confirm）', () => {
  it('确认 → resolve(true)；取消 → resolve(false)；Esc 与遮罩都等于取消', async () => {
    render(<ConfirmHost />)
    let answer: boolean | null = null
    void askConfirm({ title: '删除该 provider？', confirmLabel: '删除' }).then((v) => {
      answer = v
    })
    // 弹窗出现（alertdialog，标题即问题）
    const dialog = await waitFor(() => {
      const d = screen.getByRole('alertdialog', { name: '删除该 provider？' })
      expect(document.querySelector('[data-confirm-ok]')).not.toBeNull()
      return d
    })
    expect(dialog).not.toBeNull()

    // 确认按钮 → true
    fireEvent.click(document.querySelector('[data-confirm-ok]') as HTMLElement)
    await waitFor(() => expect(answer).toBe(true))
    expect(screen.queryByRole('alertdialog')).toBeNull()

    // 再问一次，这次 Esc → false
    let second: boolean | null = null
    void askConfirm({ title: '第二个问题？' }).then((v) => {
      second = v
    })
    await screen.findByRole('alertdialog', { name: '第二个问题？' })
    fireEvent.keyDown(window, { key: 'Escape' })
    await waitFor(() => expect(second).toBe(false))

    // 第三次：遮罩点击 → false
    let third: boolean | null = null
    void askConfirm({ title: '第三个问题？' }).then((v) => {
      third = v
    })
    await screen.findByRole('alertdialog', { name: '第三个问题？' })
    const overlay = document.querySelector('[data-settings-confirm] > div') as HTMLElement
    fireEvent.click(overlay)
    await waitFor(() => expect(third).toBe(false))
  })
})
