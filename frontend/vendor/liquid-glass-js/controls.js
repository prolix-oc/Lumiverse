// Glass Controls System
window.glassControls = {
  edgeIntensity: 0.01,
  rimIntensity: 0.05,
  baseIntensity: 0.01,
  edgeDistance: 0.15,
  rimDistance: 0.8,
  baseDistance: 0.1,
  cornerBoost: 0.02,
  rippleEffect: 0.1,
  blurRadius: 5.0,
  tintOpacity: 0.2,
  warp: false,
  hideButtons: false
}

// Update all glass instances with new parameters
function updateAllGlassInstances() {
  Container.instances.forEach(instance => {
    if (instance.gl_refs && instance.gl_refs.gl) {
      const gl = instance.gl_refs.gl
      gl.useProgram(gl.getParameter(gl.CURRENT_PROGRAM))

      // Update blur radius
      if (instance.gl_refs.blurRadiusLoc) {
        gl.uniform1f(instance.gl_refs.blurRadiusLoc, window.glassControls.blurRadius)
      }

      // Update glass effect parameters
      if (instance.gl_refs.edgeIntensityLoc) {
        gl.uniform1f(instance.gl_refs.edgeIntensityLoc, window.glassControls.edgeIntensity)
      }
      if (instance.gl_refs.rimIntensityLoc) {
        gl.uniform1f(instance.gl_refs.rimIntensityLoc, window.glassControls.rimIntensity)
      }
      if (instance.gl_refs.baseIntensityLoc) {
        gl.uniform1f(instance.gl_refs.baseIntensityLoc, window.glassControls.baseIntensity)
      }
      if (instance.gl_refs.edgeDistanceLoc) {
        gl.uniform1f(instance.gl_refs.edgeDistanceLoc, window.glassControls.edgeDistance)
      }
      if (instance.gl_refs.rimDistanceLoc) {
        gl.uniform1f(instance.gl_refs.rimDistanceLoc, window.glassControls.rimDistance)
      }
      if (instance.gl_refs.baseDistanceLoc) {
        gl.uniform1f(instance.gl_refs.baseDistanceLoc, window.glassControls.baseDistance)
      }
      if (instance.gl_refs.cornerBoostLoc) {
        gl.uniform1f(instance.gl_refs.cornerBoostLoc, window.glassControls.cornerBoost)
      }
      if (instance.gl_refs.rippleEffectLoc) {
        gl.uniform1f(instance.gl_refs.rippleEffectLoc, window.glassControls.rippleEffect)
      }
      if (instance.gl_refs.warpLoc) {
        gl.uniform1f(instance.gl_refs.warpLoc, window.glassControls.warp ? 1.0 : 0.0)
      }
      if (instance.gl_refs.tintOpacityLoc) {
        // Use instance's own tintOpacity, but allow global control to override for demonstration
        const tintOpacity =
          instance === window.controlsContainer ? instance.tintOpacity : window.glassControls.tintOpacity
        gl.uniform1f(instance.gl_refs.tintOpacityLoc, tintOpacity)
      }

      // Force immediate re-render
      if (instance.render) {
        instance.render()
      }
    }
  })
}

// Set up slider event listeners
function setupControlSliders() {
  const sliders = [
    { id: 'edgeIntensity', prop: 'edgeIntensity', valueId: 'edgeValue' },
    { id: 'rimIntensity', prop: 'rimIntensity', valueId: 'rimValue' },
    { id: 'baseIntensity', prop: 'baseIntensity', valueId: 'baseValue' },
    { id: 'edgeDistance', prop: 'edgeDistance', valueId: 'edgeDistValue' },
    { id: 'rimDistance', prop: 'rimDistance', valueId: 'rimDistValue' },
    { id: 'baseDistance', prop: 'baseDistance', valueId: 'baseDistValue' },
    { id: 'cornerBoost', prop: 'cornerBoost', valueId: 'cornerValue' },
    { id: 'rippleEffect', prop: 'rippleEffect', valueId: 'rippleValue' },
    { id: 'blurRadius', prop: 'blurRadius', valueId: 'blurValue' },
    { id: 'tintOpacity', prop: 'tintOpacity', valueId: 'tintValue' }
  ]

  sliders.forEach(({ id, prop, valueId }) => {
    const slider = document.getElementById(id)
    const valueDisplay = document.getElementById(valueId)

    if (slider && valueDisplay) {
      slider.addEventListener('input', e => {
        const value = parseFloat(e.target.value)
        window.glassControls[prop] = value
        valueDisplay.textContent = value.toFixed(3)
        updateAllGlassInstances()
      })
    }
  })

  // Set up warp toggle checkbox
  const warpToggle = document.getElementById('warpToggle')
  if (warpToggle) {
    warpToggle.addEventListener('change', e => {
      window.glassControls.warp = e.target.checked
      updateAllGlassInstances()
    })
  }

  // Set up hide buttons toggle checkbox
  const hideButtonsToggle = document.getElementById('hideButtonsToggle')
  if (hideButtonsToggle) {
    hideButtonsToggle.addEventListener('change', e => {
      window.glassControls.hideButtons = e.target.checked
      toggleButtonsVisibility()
    })
  }

  // Set up randomize button
  const randomizeButton = document.getElementById('randomizeButton')
  if (randomizeButton) {
    randomizeButton.addEventListener('click', () => {
      randomizeGlassEffects()
    })
  }
}

// Function to randomize glass effect values for creative exploration
function randomizeGlassEffects() {
  // Generate random values within creative ranges (avoiding extremes)
  const randomValues = {
    edgeIntensity: 0.005 + Math.random() * 0.025, // 0.005 to 0.03
    rimIntensity: 0.02 + Math.random() * 0.13, // 0.02 to 0.15
    baseIntensity: 0.005 + Math.random() * 0.025, // 0.005 to 0.03
    edgeDistance: 0.1 + Math.random() * 0.3, // 0.1 to 0.4
    rimDistance: 0.3 + Math.random() * 1.2, // 0.3 to 1.5
    baseDistance: 0.08 + Math.random() * 0.17, // 0.08 to 0.25
    cornerBoost: 0.01 + Math.random() * 0.05, // 0.01 to 0.06
    rippleEffect: 0.05 + Math.random() * 0.25, // 0.05 to 0.3
    blurRadius: 2 + Math.random() * 10, // 2 to 12
    tintOpacity: 0.1 + Math.random() * 0.7, // 0.1 to 0.8
    warp: Math.random() < 0.3 // 30% chance
  }

  // Update global controls
  Object.assign(window.glassControls, randomValues)

  // Update all sliders and their display values
  Object.entries(randomValues).forEach(([key, value]) => {
    if (key === 'warp') {
      const checkbox = document.getElementById('warpToggle')
      if (checkbox) {
        checkbox.checked = value
      }
    } else {
      // Find corresponding slider and value display
      const sliderConfig = [
        { prop: 'edgeIntensity', id: 'edgeIntensity', valueId: 'edgeValue' },
        { prop: 'rimIntensity', id: 'rimIntensity', valueId: 'rimValue' },
        { prop: 'baseIntensity', id: 'baseIntensity', valueId: 'baseValue' },
        { prop: 'edgeDistance', id: 'edgeDistance', valueId: 'edgeDistValue' },
        { prop: 'rimDistance', id: 'rimDistance', valueId: 'rimDistValue' },
        { prop: 'baseDistance', id: 'baseDistance', valueId: 'baseDistValue' },
        { prop: 'cornerBoost', id: 'cornerBoost', valueId: 'cornerValue' },
        { prop: 'rippleEffect', id: 'rippleEffect', valueId: 'rippleValue' },
        { prop: 'blurRadius', id: 'blurRadius', valueId: 'blurValue' },
        { prop: 'tintOpacity', id: 'tintOpacity', valueId: 'tintValue' }
      ].find(config => config.prop === key)

      if (sliderConfig) {
        const slider = document.getElementById(sliderConfig.id)
        const valueDisplay = document.getElementById(sliderConfig.valueId)

        if (slider) {
          slider.value = value
        }
        if (valueDisplay) {
          valueDisplay.textContent = value.toFixed(3)
        }
      }
    }
  })

  // Apply the randomized values to all glass instances
  updateAllGlassInstances()

  console.log('🎲 Glass effects randomized!', randomValues)
}

// Function to toggle visibility of all glass buttons/containers
function toggleButtonsVisibility() {
  const demoLayout = document.getElementById('demo-layout')
  if (demoLayout) {
    demoLayout.style.display = window.glassControls.hideButtons ? 'none' : 'flex'
  }
}

// Create glass container for controls panel
function initializeControlsContainer() {
  window.controlsContainer = new Container({
    borderRadius: 12,
    type: 'rounded',
    tintOpacity: 0.7
  })

  // Get the existing controls wrapper and move existing content behind the glass
  const controlsWrapper = document.getElementById('glass-controls-container')
  const controlsContent = document.getElementById('controls-content')

  // Remove controls content from wrapper temporarily
  controlsWrapper.removeChild(controlsContent)

  // Add glass container to wrapper
  controlsWrapper.appendChild(window.controlsContainer.element)

  // Add controls content back on top of glass
  window.controlsContainer.element.appendChild(controlsContent)

  // Force the container to update its size based on CSS
  setTimeout(() => {
    window.controlsContainer.updateSizeFromDOM()
  }, 100)
}

// Mobile controls toggle functionality
function setupMobileToggle() {
  const toggleButton = document.getElementById('mobile-controls-toggle')
  const controlsContainer = document.getElementById('glass-controls-container')

  if (toggleButton && controlsContainer) {
    toggleButton.addEventListener('click', () => {
      const isVisible = controlsContainer.classList.contains('mobile-visible')

      if (isVisible) {
        // Hide controls
        controlsContainer.classList.remove('mobile-visible')
        toggleButton.classList.remove('active')
        toggleButton.setAttribute('aria-expanded', 'false')
      } else {
        // Show controls
        controlsContainer.classList.add('mobile-visible')
        toggleButton.classList.add('active')
        toggleButton.setAttribute('aria-expanded', 'true')
      }
    })

    // Close controls when clicking outside on mobile
    document.addEventListener('click', event => {
      // Only on mobile screens
      if (window.innerWidth <= 768) {
        const isVisible = controlsContainer.classList.contains('mobile-visible')
        const clickedInsideControls = controlsContainer.contains(event.target)
        const clickedToggleButton = toggleButton.contains(event.target)

        if (isVisible && !clickedInsideControls && !clickedToggleButton) {
          controlsContainer.classList.remove('mobile-visible')
          toggleButton.classList.remove('active')
          toggleButton.setAttribute('aria-expanded', 'false')
        }
      }
    })

    // Initialize toggle button accessibility
    toggleButton.setAttribute('aria-expanded', 'false')
  }
}

// Initialize controls system
function initializeControls() {
  initializeControlsContainer()
  setupControlSliders()
  setupMobileToggle()
}

// Auto-initialize when DOM is ready
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initializeControls)
} else {
  initializeControls()
}
