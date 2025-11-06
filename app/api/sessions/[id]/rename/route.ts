import { NextResponse } from 'next/server'

export const dynamic = 'force-dynamic'

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  // dtach: Session renaming is not supported with dtach
  // Renaming would require killing the dtach process and recreating with new socket
  // This is a complex operation and not commonly used, so it's disabled for now
  //
  // Future enhancement: Could implement by:
  // 1. Read current scrollback
  // 2. Create new session with new name
  // 3. Replay scrollback to new session
  // 4. Delete old session
  // 5. Reconnect clients to new session
  //
  // For now, users should create a new session with the desired name

  return NextResponse.json(
    {
      error: 'Session renaming is not supported with dtach-backed sessions',
      hint: 'Please create a new session with the desired name and delete the old one'
    },
    { status: 501 } // 501 Not Implemented
  )
}
