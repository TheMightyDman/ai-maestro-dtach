import { execFile } from 'child_process'
import type { ExecFileOptions } from 'child_process'
import { promisify } from 'util'

const execFileAsync = promisify(execFile)

export const SESSION_NAME_PATTERN = /^[A-Za-z0-9_-]+$/

export function normalizeSessionName(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null
  }

  const trimmed = value.trim()
  if (!SESSION_NAME_PATTERN.test(trimmed)) {
    return null
  }

  return trimmed
}

export interface RunTmuxOptions extends ExecFileOptions {
  allowCodes?: number[]
  timeoutMs?: number
}

export interface TmuxResult {
  stdout: string
  stderr: string
  code: number | null
}

export async function runTmuxCommand(args: string[], options: RunTmuxOptions = {}): Promise<TmuxResult> {
  const { allowCodes = [], timeoutMs, ...execOptions } = options

  try {
    const { stdout = '', stderr = '' } = (await execFileAsync('tmux', args, {
      encoding: 'utf8',
      timeout: timeoutMs ?? 3000,
      maxBuffer: 2 * 1024 * 1024,
      ...execOptions
    })) as { stdout?: string; stderr?: string }

    return {
      stdout,
      stderr,
      code: 0
    }
  } catch (error) {
    const execError = error as NodeJS.ErrnoException & { stdout?: string; stderr?: string; code?: number | string }

    const numericCode = typeof execError.code === 'number'
      ? execError.code
      : typeof execError.code === 'string'
        ? Number.isFinite(Number(execError.code))
          ? Number(execError.code)
          : null
        : null

    if (numericCode !== null && allowCodes.includes(numericCode)) {
      return {
        stdout: execError.stdout ? execError.stdout.toString() : '',
        stderr: execError.stderr ? execError.stderr.toString() : '',
        code: numericCode
      }
    }

    const wrappedError = new Error(execError.message || 'tmux command failed')
    wrappedError.name = 'TmuxCommandError'
    ;(wrappedError as Error & { stdout?: string; stderr?: string; code?: number | null; cause?: unknown }).stdout = execError.stdout ? execError.stdout.toString() : undefined
    ;(wrappedError as Error & { stdout?: string; stderr?: string; code?: number | null; cause?: unknown }).stderr = execError.stderr ? execError.stderr.toString() : undefined
    ;(wrappedError as Error & { stdout?: string; stderr?: string; code?: number | null; cause?: unknown }).code = numericCode
    ;(wrappedError as Error & { stdout?: string; stderr?: string; code?: number | null; cause?: unknown }).cause = execError

    throw wrappedError
  }
}
