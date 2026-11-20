import { playChatChromeMotion } from '@/lib/chatChromeMotion'
import chat from '@/components/chat/ChatView.module.css'
import list from '@/components/chat/MessageList.module.css'
import input from '@/components/chat/InputArea.module.css'
import app from '@/App.module.css'
import '@/theme/variables.css'

const params = new URLSearchParams(location.search)
const initialDirection = params.get('direction') === 'leave' ? 'leave' : 'enter'
const shell = params.get('shell') || 'browser'
if (shell === 'native-ios') document.documentElement.setAttribute('data-tauri-mobile', 'ios')
if (shell === 'pwa-ios') document.documentElement.setAttribute('data-ios-pwa', '')
if (params.get('glass') !== '0') document.documentElement.setAttribute('data-glass', '')
document.documentElement.style.setProperty('--app-shell-height', `${innerHeight}px`)
let root: HTMLElement
let cancelPlayback: (() => void) | undefined
function mount(direction: 'enter' | 'leave') {
  cancelPlayback?.()
  document.body.innerHTML = `<div class="${app.app}"><main class="${app.main}">
    <div class="${chat.container}"><div class="${chat.body}">
      <div class="${chat.chatColumn}"><div id="chat" class="${chat.chatColumnInner}">
        <div data-component="MessageList" class="${list.list}"><div class="${list.virtualSpace}" style="height:1800px">
          ${Array.from({ length: 25 }, (_, index) => `<div data-item-type="message" class="${list.virtualRow}"
            style="top:${index * 72}px;height:64px"><p>Chat bubble ${index}</p></div>`).join('')}
        </div></div>
        <div data-component="InputArea" class="${input.container}"><textarea>Composer</textarea></div>
      </div></div>
    </div></div>
  </main></div>`
  root = document.getElementById('chat')!
  if (direction === 'enter') root.setAttribute('data-chat-chrome-entering', '')
  root.querySelector('[data-component="MessageList"]')!.scrollTop = 900
}
mount(initialDirection)
let nativeAnimationCalls = 0
const nativeAnimate = Element.prototype.animate
Element.prototype.animate = function (...args: Parameters<Element['animate']>) {
  nativeAnimationCalls++
  return nativeAnimate.apply(this, args)
}

Object.assign(window, {
  motionFixture: {
    completedAt: 0,
    mount,
    get nativeAnimationCalls() { return nativeAnimationCalls },
    play(blockMs: number, direction: 'enter' | 'leave' = initialDirection) {
      this.completedAt = 0
      root.removeAttribute('data-chat-chrome-entering')
      if (direction === 'leave') root.setAttribute('data-chat-chrome-leaving', '')
      cancelPlayback = playChatChromeMotion(root, direction, () => {
        this.completedAt = performance.now()
      })
      // Simulate rendering work that prevents the first animation frame from
      // being presented before a click-based 220ms navigation timer expires.
      const until = performance.now() + blockMs
      while (performance.now() < until) { /* intentional rendering load */ }
    },
  },
})
