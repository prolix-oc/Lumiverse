// Get demo layout containers from HTML
const helloRow = document.querySelector('#hello-row')
const controlsRow = document.querySelector('#controls-row')
const containerRow = document.querySelector('#container-row')
const standaloneRow = document.querySelector('#standalone-row')

// Row 1: Hello button
const helloButton = new Button({
  text: 'Hello 🍏',
  size: '36',
  type: 'rounded',
  onClick: text => alert(`You clicked: ${text}`)
})
helloRow.appendChild(helloButton.element)

// Row 3: Control buttons (play, record, next)
const playButton = new Button({
  text: '▶',
  size: '32',
  type: 'circle',
  onClick: text => alert(`Play clicked!`)
})

const recordButton = new Button({
  text: '⏺',
  size: '32',
  type: 'circle',
  onClick: text => alert(`Record clicked!`)
})

const nextButton = new Button({
  text: '⏭',
  size: '32',
  type: 'circle',
  onClick: text => alert(`Next clicked!`)
})

controlsRow.appendChild(playButton.element)
controlsRow.appendChild(recordButton.element)
controlsRow.appendChild(nextButton.element)

// Row 4: Container with nested glass buttons (pill shape)
const buttonContainer = new Container({
  borderRadius: 24,
  type: 'pill'
})

const button1 = new Button({
  text: 'Click Me!',
  size: '24',
  type: 'pill',
  onClick: text => alert(`Button pressed: ${text}`)
})

const button2 = new Button({
  text: '✓',
  size: '24',
  type: 'circle',
  onClick: text => alert(`Glass button clicked: ${text}`)
})

// Add buttons to container (sets up nested glass automatically)
buttonContainer.addChild(button1)
buttonContainer.addChild(button2)
containerRow.appendChild(buttonContainer.element)

// Row 5: Standalone button
const standaloneButton = new Button({
  text: 'Standalone',
  size: '24',
  type: 'pill',
  onClick: text => alert(`Standalone button: ${text}`)
})
standaloneRow.appendChild(standaloneButton.element)

// Handle window resize - recapture page snapshot and update all glass instances
let resizeTimeout
window.addEventListener('resize', () => {
  // Debounce resize events to avoid excessive recapturing
  clearTimeout(resizeTimeout)
  resizeTimeout = setTimeout(() => {
    console.log('Window resized, recapturing page snapshot...')

    // Reset snapshot state
    Container.pageSnapshot = null
    Container.isCapturing = true
    Container.waitingForSnapshot = Container.instances.slice() // All instances need update

    // Recapture page snapshot
    html2canvas(document.body, {
      scale: 1,
      useCORS: true,
      allowTaint: true,
      backgroundColor: null,
      ignoreElements: function (element) {
        // Ignore all glass elements
        return (
          element.classList.contains('glass-container') ||
          element.classList.contains('glass-button') ||
          element.classList.contains('glass-button-text')
        )
      }
    })
      .then(snapshot => {
        console.log('Page snapshot recaptured after resize')
        Container.pageSnapshot = snapshot
        Container.isCapturing = false

        // Create new image and update all glass instances
        const img = new Image()
        img.src = snapshot.toDataURL()
        img.onload = () => {
          Container.instances.forEach(instance => {
            if (instance.gl_refs && instance.gl_refs.gl) {
              // Check if this is a nested glass button
              if (instance instanceof Button && instance.parent && instance.isNestedGlass) {
                // For nested glass buttons, reinitialize their texture to match parent's new size
                const gl = instance.gl_refs.gl
                const containerCanvas = instance.parent.canvas

                // Resize the button's texture to match new container canvas size
                gl.bindTexture(gl.TEXTURE_2D, instance.gl_refs.texture)
                gl.texImage2D(
                  gl.TEXTURE_2D,
                  0,
                  gl.RGBA,
                  containerCanvas.width,
                  containerCanvas.height,
                  0,
                  gl.RGBA,
                  gl.UNSIGNED_BYTE,
                  null
                )

                // Update texture size uniform to new container dimensions
                gl.uniform2f(instance.gl_refs.textureSizeLoc, containerCanvas.width, containerCanvas.height)

                // Update container size uniform for sampling calculations
                if (instance.gl_refs.containerSizeLoc) {
                  gl.uniform2f(instance.gl_refs.containerSizeLoc, instance.parent.width, instance.parent.height)
                }

                console.log(`Updated nested button texture: ${containerCanvas.width}x${containerCanvas.height}`)
              } else {
                // For standalone glass elements, update with new page snapshot
                const gl = instance.gl_refs.gl
                gl.bindTexture(gl.TEXTURE_2D, instance.gl_refs.texture)
                gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, img)

                // Update texture size uniform
                gl.uniform2f(instance.gl_refs.textureSizeLoc, img.width, img.height)
              }

              // Force re-render for all instances
              if (instance.render) {
                instance.render()
              }
            }
          })
        }

        // Clear waiting queue
        Container.waitingForSnapshot = []
      })
      .catch(error => {
        console.error('html2canvas error on resize:', error)
        Container.isCapturing = false
        Container.waitingForSnapshot = []
      })
  }, 300) // 300ms debounce delay
})
