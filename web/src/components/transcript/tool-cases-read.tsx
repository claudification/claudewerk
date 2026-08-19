/**
 * The `Read` tool row. Binary reads (an image, a PDF) and text reads answer
 * different questions, so they are two cases; what either one LOOKS like lives
 * in `read-binary.tsx` and `read-details.tsx`.
 */

import { BinaryDetails, type BinaryFile, BinarySummary } from './read-binary'
import { TextReadSummary } from './read-details'
import type { ToolCaseInput, ToolCaseResult } from './tool-case-types'
import { filePreview } from './tool-file-view'

interface ReadFile {
  content?: string
  filePath?: string
  numLines?: number
  startLine?: number
  totalLines?: number
}

export function renderRead({ input, result, toolUseResult }: ToolCaseInput): ToolCaseResult {
  const path = input.path as string
  const type = toolUseResult?.type ? String(toolUseResult.type) : ''

  if (type && type !== 'text') {
    const file = toolUseResult?.file as BinaryFile | undefined
    return {
      summary: <BinarySummary path={path} file={file} type={type} />,
      details: <BinaryDetails path={path} file={file} isImage={type === 'image'} />,
    }
  }

  const file = toolUseResult?.file as ReadFile | undefined
  const content = result || file?.content
  return {
    summary: (
      <TextReadSummary
        path={path}
        span={{
          startLine: file?.startLine ?? (input.offset as number | undefined),
          numLines: file?.numLines,
          totalLines: file?.totalLines,
        }}
      />
    ),
    details: content ? filePreview(path, content) : null,
  }
}
