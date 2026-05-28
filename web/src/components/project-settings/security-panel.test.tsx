import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SecurityPanel } from './security-panel'

vi.mock('@/components/settings/permission-rules-editor', () => ({
  PermissionRulesEditor: () => <div data-testid="permission-rules" />,
}))

afterEach(cleanup)

describe('SecurityPanel', () => {
  it('renders three trust level buttons', () => {
    render(<SecurityPanel project="proj-1" trustLevel="default" onTrustLevelChange={vi.fn()} />)
    expect(screen.getByText('Default')).toBeDefined()
    expect(screen.getByText('Open')).toBeDefined()
    expect(screen.getByText('Benevolent')).toBeDefined()
  })

  it('emits onTrustLevelChange when a different level button is clicked', () => {
    const onTrustLevelChange = vi.fn()
    render(<SecurityPanel project="proj-1" trustLevel="default" onTrustLevelChange={onTrustLevelChange} />)
    fireEvent.click(screen.getByText('Open'))
    expect(onTrustLevelChange).toHaveBeenCalledWith('open')
  })

  it('mounts the PermissionRulesEditor wired to the project prop', () => {
    render(<SecurityPanel project="proj-42" trustLevel="default" onTrustLevelChange={vi.fn()} />)
    expect(screen.getByTestId('permission-rules')).toBeDefined()
  })
})
