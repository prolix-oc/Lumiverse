import { createWarmDisplayMeasurementQueue } from '../../../frontend/src/components/chat/warmDisplayMeasurement'
import { shouldAdjustMessageListScrollOnResize } from '../../../frontend/src/components/chat/messageListScrollAdjust'

// A minimal position-based virtual list, using real browser scroll clamping
// and ResizeObserver. Only the virtualizer adapter and display resolver are
// mocked; both production policy functions are exercised directly.
const wait = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms))
const check = (condition: unknown, message: string) => { if (!condition) throw new Error(message) }

async function runWarmDisplayReflow() {
  const results: string[] = []
  for (const mode of ['restore', 'shorter', 'above', 'below', 'removed', 'restart', 'disposed', 'bounded', 'streaming'] as const) {
    const scroll = document.createElement('div')
    scroll.style.cssText = 'width:100%;height:800px;overflow:auto;overflow-anchor:none;position:relative'
    const space = document.createElement('div')
    space.style.cssText = 'position:relative;overflow-anchor:none;height:29412px'
    const row = document.createElement('article')
    row.style.cssText = 'position:absolute;top:18500px;width:100%;height:10464px'
    const body = document.createElement('div')
    row.append(body); space.append(row); scroll.append(space); document.body.append(scroll)
    let size = 10464
    let calls = 0
    const initial = mode === 'above' ? 18000 : mode === 'below' ? 29000 : 26361
    // Provide sufficient following content to test compensation for a row
    // wholly above the reader without an unrelated native range clamp.
    const baseHeight = mode === 'below' ? 33000 : 29412
    space.style.height = `${baseHeight}px`
    scroll.scrollTop = initial
    const expectedOffset = scroll.scrollTop
    const resize = (next: number) => {
      if (next === size) return
      const delta = next - size
      const adjust = shouldAdjustMessageListScrollOnResize({
        delta, itemStart: 18500, itemEnd: 18500 + size, scrollOffset: scroll.scrollTop,
        scrollDirection: 'forward', hasMeasuredSize: true, isPinned: false,
        isStreamingTail: false, isProgrammaticContentReflow: true, isWarmDisplayReflow: true,
      })
      const offset = scroll.scrollTop
      size = next
      space.style.height = `${baseHeight + size - 10464}px`
      if (adjust) scroll.scrollTop = offset + delta
      calls++
    }
    const queue = createWarmDisplayMeasurementQueue(r => resize(r.offsetHeight))
    const observer = new ResizeObserver(() => {
      if (row.isConnected) resize(queue.measure(row) ?? row.offsetHeight)
    })
    observer.observe(row)
    try {
      await wait(30)
      body.setAttribute('data-display-pending', '')
      queue.begin(row, size)
      await wait(40)
      check(size === 10464, `${mode}: pending changed measured geometry`)
      body.removeAttribute('data-display-pending')
      row.style.height = '1241px'
      // MessageContent deliberately omits displayReady when regeneration
      // takes ownership of an in-flight display pass. Measurements must still
      // notice the removed pending marker and eventually release the hold.
      if (mode !== 'streaming') queue.ready(row)
      await wait(25)
      row.style.height = '6351px'
      await wait(80)
      check(size === 10464 && scroll.scrollTop === expectedOffset, `${mode}: intermediate collapse moved the viewport`)
      if (mode === 'removed') {
        row.remove()
        await wait(260)
        check(calls === 0, 'detached row committed stale measurement')
      } else if (mode === 'restart') {
        body.setAttribute('data-display-pending', '')
        queue.begin(row, size)
        await wait(250)
        check(calls === 0, 'prior completion committed during new pending pass')
        body.removeAttribute('data-display-pending')
        row.style.height = '10464px'
        queue.ready(row)
        await wait(260)
        check(size === 10464 && calls === 0 && queue.measure(row) === undefined, 'restart did not settle')
      } else if (mode === 'disposed') {
        observer.disconnect()
        queue.dispose()
        await wait(260)
        check(calls === 0 && queue.measure(row) === undefined, 'disposed queue retained a stale completion')
      } else if (mode === 'bounded') {
        // Persistent incremental media growth cannot indefinitely retain the
        // original geometry. Continue changing size beyond the cap.
        for (let index = 0; index < 9; index++) {
          row.style.height = `${9400 + index}px`
          await wait(100)
        }
        check(queue.measure(row) === undefined && calls > 0, 'quiet window exceeded maximum')
      } else if (mode === 'streaming') {
        row.style.height = '11000px'
        await wait(400)
        check(size === 11000 && queue.measure(row) === undefined,
          'regeneration without displayReady retained stale geometry')
      } else {
        const final = mode === 'restore' ? 10464 : 9864
        row.style.height = `${final}px`
        await wait(260)
        check(size === final, `${mode}: final geometry not published (${size})`)
        check(queue.measure(row) === undefined, `${mode}: stale reservation`)
        const offset = mode === 'below' ? expectedOffset - 600 : expectedOffset
        check(Math.abs(scroll.scrollTop - offset) <= 1, `${mode}: expected scroll ${offset}, got ${scroll.scrollTop}`)
        check(calls === (mode === 'restore' ? 0 : 1), `${mode}: unexpected intermediate model commits (${calls})`)
      }
      results.push(mode)
    } finally {
      observer.disconnect(); queue.dispose(); scroll.remove()
    }
  }
  return results
}
Object.assign(window, { runWarmDisplayReflow })
