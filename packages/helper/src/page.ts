/** Minimal ball page. One transcript, one input, and a draggable circle. */
export const ballHtml = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <title>dsh-orb</title>
  <style>
    html, body { margin: 0; height: 100%; background: transparent; overflow: hidden; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
    #root { position: relative; width: 100%; height: 100%; }
    #panel { display: none; position: absolute; left: 10px; right: 10px; top: 10px; bottom: 78px; flex-direction: column; border-radius: 16px; background: rgba(18, 22, 28, 0.94); color: #f4f7fb; box-shadow: 0 10px 30px rgba(0, 0, 0, 0.28); overflow: hidden; }
    body.expanded #panel { display: flex; }
    #who { padding: 10px 12px 0; font-size: 12px; color: #9aa6b2; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    #log { flex: 1; overflow: auto; padding: 8px 12px; font-size: 13px; line-height: 1.45; }
    .user { margin: 8px 0; color: #d6e6ff; white-space: pre-wrap; }
    .assistant { margin: 8px 0; white-space: pre-wrap; }
    .tool { margin: 8px 0; color: #8fd6b5; }
    #status { padding: 0 12px 8px; min-height: 16px; font-size: 12px; color: #9aa6b2; }
    form { display: flex; gap: 8px; padding: 0 12px 12px; }
    input { flex: 1; border: 0; border-radius: 10px; padding: 8px 10px; background: #0f141b; color: white; }
    button.send { border: 0; border-radius: 10px; background: #1d6fe8; color: white; padding: 0 12px; }
    button.send:disabled, input:disabled { opacity: 0.6; }
    #ball { position: absolute; right: 8px; bottom: 8px; width: 56px; height: 56px; border: 0; border-radius: 50%; padding: 0; background: radial-gradient(circle at 35% 30%, #b9e4ff, #1d6fe8 58%, #0b2a55); box-shadow: 0 8px 18px rgba(0, 0, 0, 0.35); cursor: grab; }
    #ball:focus-visible { outline: 2px solid white; outline-offset: 2px; }
  </style>
</head>
<body>
  <div id="root">
    <div id="panel">
      <div id="who">Orb</div>
      <div id="log"></div>
      <div id="status"></div>
      <form id="form">
        <input id="text" maxlength="4000" placeholder="让 Computer Use 操作这台电脑" autocomplete="off">
        <button class="send" type="submit">发送</button>
      </form>
    </div>
    <button id="ball" type="button" aria-label="悬浮球"></button>
  </div>
  <script>
    const orb = window.dshOrb
    const who = document.getElementById('who')
    const log = document.getElementById('log')
    const status = document.getElementById('status')
    const form = document.getElementById('form')
    const input = document.getElementById('text')
    const ball = document.getElementById('ball')
    let expanded = false
    let dragging = false
    let moved = false
    let lastX = 0
    let lastY = 0

    function setExpanded(next) {
      expanded = next
      document.body.classList.toggle('expanded', expanded)
      orb.setExpanded(expanded)
      if (expanded) input.focus()
    }

    function addLine(role, text) {
      const row = document.createElement('div')
      row.className = role
      row.textContent = role === 'tool' ? '工具 ' + text : text
      log.appendChild(row)
      log.scrollTop = log.scrollHeight
    }

    orb.onSession((id) => { who.textContent = 'Orb · ' + id })
    orb.session().then((id) => { if (id) who.textContent = 'Orb · ' + id })
    orb.onLine((line) => {
      if (!line || typeof line.text !== 'string') return
      if (line.role === 'status') {
        status.textContent = line.text
        const busy = line.text === '正在执行'
        input.disabled = busy
        form.querySelector('button').disabled = busy
        return
      }
      addLine(line.role, line.text)
    })

    form.addEventListener('submit', (event) => {
      event.preventDefault()
      const text = input.value.trim()
      if (!text || input.disabled) return
      input.value = ''
      orb.send(text)
    })

    ball.addEventListener('pointerdown', (event) => {
      dragging = true
      moved = false
      lastX = event.screenX
      lastY = event.screenY
      ball.setPointerCapture(event.pointerId)
    })
    ball.addEventListener('pointermove', (event) => {
      if (!dragging) return
      const dx = event.screenX - lastX
      const dy = event.screenY - lastY
      if (Math.abs(dx) + Math.abs(dy) > 3) moved = true
      lastX = event.screenX
      lastY = event.screenY
      if (moved) orb.moveBy(dx, dy)
    })
    ball.addEventListener('pointerup', () => {
      dragging = false
      if (!moved) setExpanded(!expanded)
    })
  </script>
</body>
</html>
`
