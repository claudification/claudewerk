import type { PeriodRecapDoc, RecapSummary } from '@shared/protocol'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { RecapWriteupTab } from './recap-writeup-tab'

// Markdown pulls in CodeMirror/Mermaid -- stub it; we test the A/B controls.
vi.mock('@/components/markdown', () => ({
  Markdown: ({ children }: { children?: React.ReactNode }) => <div data-testid="md">{children}</div>,
}))

function doc(overrides: Partial<PeriodRecapDoc> = {}): PeriodRecapDoc {
  return {
    recapId: 'recap_1',
    projectUri: 'claude://default/p/foo',
    periodLabel: 'last_7',
    periodStart: 1715000000000,
    periodEnd: 1715600000000,
    timeZone: 'UTC',
    audience: 'human',
    status: 'done',
    progress: 100,
    inputChars: 1000,
    inputTokens: 300,
    outputTokens: 200,
    llmCostUsd: 0.6,
    createdAt: 1715600000000,
    model: 'anthropic/claude-opus-4.8',
    markdown: '# Write-up\n\nbody',
    ...overrides,
  }
}

function summary(overrides: Partial<RecapSummary> = {}): RecapSummary {
  return {
    id: 'recap_1',
    projectUri: 'claude://default/p/foo',
    periodLabel: 'last_7',
    periodStart: 1715000000000,
    periodEnd: 1715600000000,
    audience: 'human',
    status: 'done',
    createdAt: 1,
    llmCostUsd: 0.6,
    progress: 100,
    model: 'anthropic/claude-opus-4.8',
    ...overrides,
  }
}

afterEach(cleanup)

function openModal() {
  fireEvent.click(screen.getByText('Regenerate write-up…'))
}

describe('RecapWriteupTab', () => {
  test('button opens the modal; submitting regenerates with the recap model by default', () => {
    const onRegenerate = vi.fn()
    render(
      <RecapWriteupTab
        recap={doc()}
        siblings={[]}
        regenerating={false}
        onSelectFork={vi.fn()}
        onRegenerate={onRegenerate}
      />,
    )
    openModal()
    fireEvent.click(screen.getByText('Regenerate', { selector: 'button' }))
    expect(onRegenerate).toHaveBeenCalledWith(
      expect.objectContaining({
        model: 'anthropic/claude-opus-4.8',
        instructions: '',
        variantLabel: '',
        temperature: 0.2,
      }),
    )
  })

  test('changing the model in the modal then regenerating sends the chosen slug', () => {
    const onRegenerate = vi.fn()
    render(
      <RecapWriteupTab
        recap={doc()}
        siblings={[]}
        regenerating={false}
        onSelectFork={vi.fn()}
        onRegenerate={onRegenerate}
      />,
    )
    openModal()
    fireEvent.change(screen.getByLabelText('Model'), { target: { value: 'z-ai/glm-5.2' } })
    fireEvent.click(screen.getByText('Regenerate', { selector: 'button' }))
    expect(onRegenerate).toHaveBeenCalledWith(expect.objectContaining({ model: 'z-ai/glm-5.2' }))
  })

  test('the modal prefills the instructions the write-up was generated with', () => {
    render(
      <RecapWriteupTab
        recap={doc({ instructions: 'keep it upbeat' })}
        siblings={[]}
        regenerating={false}
        onSelectFork={vi.fn()}
        onRegenerate={vi.fn()}
      />,
    )
    openModal()
    const box = screen.getByPlaceholderText(/focus on the auth migration/) as HTMLTextAreaElement
    expect(box.value).toBe('keep it upbeat')
  })

  test('while regenerating the button is disabled and does not open the modal', () => {
    const onRegenerate = vi.fn()
    render(
      <RecapWriteupTab
        recap={doc()}
        siblings={[]}
        regenerating={true}
        onSelectFork={vi.fn()}
        onRegenerate={onRegenerate}
      />,
    )
    fireEvent.click(screen.getByText('Generating…'))
    expect(screen.queryByText('Tune & regenerate write-up')).toBeNull()
    expect(onRegenerate).not.toHaveBeenCalled()
  })

  test('fork switcher shows the variant name when set, else the model, and routes clicks', () => {
    const onSelectFork = vi.fn()
    render(
      <RecapWriteupTab
        recap={doc({ recapId: 'recap_1' })}
        siblings={[
          summary({ id: 'recap_1', model: 'anthropic/claude-opus-4.8' }),
          summary({ id: 'recap_2', model: 'z-ai/glm-5.2', variantLabel: 'Client-safe', createdAt: 2 }),
        ]}
        regenerating={false}
        onSelectFork={onSelectFork}
        onRegenerate={vi.fn()}
      />,
    )
    const switcher = within(screen.getByLabelText('Write-up variants'))
    fireEvent.click(switcher.getByText('Client-safe'))
    expect(onSelectFork).toHaveBeenCalledWith('recap_2')
  })

  test('no switcher when there is only one variant', () => {
    render(
      <RecapWriteupTab
        recap={doc()}
        siblings={[summary({ id: 'recap_1' })]}
        regenerating={false}
        onSelectFork={vi.fn()}
        onRegenerate={vi.fn()}
      />,
    )
    expect(screen.queryByLabelText('Write-up variants')).toBeNull()
  })
})
