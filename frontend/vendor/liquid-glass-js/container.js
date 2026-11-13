class Container {
  static instances = []
  static pageSnapshot = null
  static isCapturing = false
  static waitingForSnapshot = []

  constructor(options = {}) {
    this.width = 0 // Will be set from DOM
    this.height = 0 // Will be set from DOM
    this.borderRadius = options.borderRadius || 48
    this.type = options.type || 'rounded' // "rounded", "circle", or "pill"
    this.tintOpacity = options.tintOpacity !== undefined ? options.tintOpacity : 0.2

    this.canvas = null
    this.element = null
    this.gl = null
    this.gl_refs = {}
    this.webglInitialized = false
    this.children = [] // Child buttons/components

    // Add to instances
    Container.instances.push(this)

    // Initialize
    this.init()
  }

  addChild(child) {
    this.children.push(child)
    child.parent = this

    // Add child's element to container
    if (child.element && this.element) {
      this.element.appendChild(child.element)
    }

    // If child is a button, set up nested glass
    if (child instanceof Button) {
      child.setupAsNestedGlass()
    }

    // Update container size based on actual DOM size
    this.updateSizeFromDOM()

    return child
  }

  removeChild(child) {
    const index = this.children.indexOf(child)
    if (index > -1) {
      this.children.splice(index, 1)
      child.parent = null

      if (child.element && this.element.contains(child.element)) {
        this.element.removeChild(child.element)
      }

      // Update container size after removing child
      this.updateSizeFromDOM()
    }
  }

  updateSizeFromDOM() {
    // Wait for next frame to ensure DOM layout is complete
    requestAnimationFrame(() => {
      const rect = this.element.getBoundingClientRect()
      let newWidth = Math.ceil(rect.width)
      let newHeight = Math.ceil(rect.height)

      // Apply type-specific sizing logic
      if (this.type === 'circle') {
        // For circles, ensure perfect square
        const size = Math.max(newWidth, newHeight)
        newWidth = size
        newHeight = size
        this.borderRadius = size / 2 // 50% for perfect circle

        // Force exact square dimensions
        this.element.style.width = size + 'px'
        this.element.style.height = size + 'px'
        this.element.style.borderRadius = this.borderRadius + 'px'
      } else if (this.type === 'pill') {
        // For pills, border radius is half the height
        this.borderRadius = newHeight / 2
        this.element.style.borderRadius = this.borderRadius + 'px'
      }

      if (newWidth !== this.width || newHeight !== this.height) {
        this.width = newWidth
        this.height = newHeight

        // Update canvas size to match actual DOM size
        this.canvas.width = newWidth
        this.canvas.height = newHeight
        this.canvas.style.width = newWidth + 'px'
        this.canvas.style.height = newHeight + 'px'
        this.canvas.style.borderRadius = this.borderRadius + 'px'

        // Update WebGL viewport if initialized
        if (this.gl_refs.gl) {
          this.gl_refs.gl.viewport(0, 0, newWidth, newHeight)
          this.gl_refs.gl.uniform2f(this.gl_refs.resolutionLoc, newWidth, newHeight)
          this.gl_refs.gl.uniform1f(this.gl_refs.borderRadiusLoc, this.borderRadius)
        }

        // Update any nested glass children when container size changes
        this.children.forEach(child => {
          if (child instanceof Button && child.isNestedGlass && child.gl_refs.gl) {
            const gl = child.gl_refs.gl

            // Update child's texture to match new container size
            gl.bindTexture(gl.TEXTURE_2D, child.gl_refs.texture)
            gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, newWidth, newHeight, 0, gl.RGBA, gl.UNSIGNED_BYTE, null)

            // Update child's uniforms
            gl.uniform2f(child.gl_refs.textureSizeLoc, newWidth, newHeight)
            if (child.gl_refs.containerSizeLoc) {
              gl.uniform2f(child.gl_refs.containerSizeLoc, newWidth, newHeight)
            }
          }
        })
      }
    })
  }

  init() {
    this.createElement()
    this.setupCanvas()

    // Get initial size from DOM
    this.updateSizeFromDOM()

    // Handle page snapshot
    if (Container.pageSnapshot) {
      // Snapshot already exists, initialize immediately
      this.initWebGL()
    } else if (Container.isCapturing) {
      // Snapshot in progress, add to waiting queue
      Container.waitingForSnapshot.push(this)
    } else {
      // Start snapshot process
      Container.isCapturing = true
      Container.waitingForSnapshot.push(this)
      this.capturePageSnapshot()
    }
  }

  createElement() {
    // Create wrapper element with CSS class
    this.element = document.createElement('div')
    this.element.className = 'glass-container'

    // Add type-specific classes
    if (this.type === 'circle') {
      this.element.classList.add('glass-container-circle')
    } else if (this.type === 'pill') {
      this.element.classList.add('glass-container-pill')
    }

    this.element.style.borderRadius = this.borderRadius + 'px'

    // Create canvas (will be sized after DOM layout)
    this.canvas = document.createElement('canvas')
    this.canvas.style.borderRadius = this.borderRadius + 'px'
    this.canvas.style.position = 'absolute'
    this.canvas.style.top = '0'
    this.canvas.style.left = '0'
    this.canvas.style.width = '100%'
    this.canvas.style.height = '100%'
    this.canvas.style.boxShadow = '0 25px 50px rgba(0, 0, 0, 0.25)'
    this.canvas.style.zIndex = '-1' // Canvas behind children

    this.element.appendChild(this.canvas)
  }

  setupCanvas() {
    this.gl = this.canvas.getContext('webgl', { preserveDrawingBuffer: true })
    if (!this.gl) {
      console.error('WebGL not supported')
      return
    }
  }

  getPosition() {
    // Get actual screen position using getBoundingClientRect
    const rect = this.canvas.getBoundingClientRect()
    return {
      x: rect.left + rect.width / 2,
      y: rect.top + rect.height / 2
    }
  }

  capturePageSnapshot() {
    console.log('Capturing page snapshot...')
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
        console.log('Page snapshot captured')
        Container.pageSnapshot = snapshot
        Container.isCapturing = false

        // Initialize WebGL for all waiting containers
        const waitingContainers = Container.waitingForSnapshot.slice()
        Container.waitingForSnapshot = []

        waitingContainers.forEach(container => {
          if (!container.webglInitialized) {
            container.initWebGL()
          }
        })
      })
      .catch(error => {
        console.error('html2canvas error:', error)
        Container.isCapturing = false
        Container.waitingForSnapshot = []
      })
  }

  initWebGL() {
    if (!Container.pageSnapshot || !this.gl) return

    const img = new Image()
    img.src = Container.pageSnapshot.toDataURL()
    img.onload = () => {
      this.setupShader(img)
      this.webglInitialized = true
    }
  }

  setupShader(image) {
    const gl = this.gl

    const vsSource = `
    attribute vec2 a_position;
    attribute vec2 a_texcoord;
    varying vec2 v_texcoord;

    void main() {
      gl_Position = vec4(a_position, 0, 1);
      v_texcoord = a_texcoord;
    }
  `

    const fsSource = `
    precision mediump float;
    uniform sampler2D u_image;
    uniform vec2 u_resolution;
      uniform vec2 u_textureSize;
      uniform float u_scrollY;
      uniform float u_pageHeight;
      uniform float u_viewportHeight;
      uniform float u_blurRadius;
      uniform float u_borderRadius;
      uniform vec2 u_containerPosition;
      uniform float u_warp;
      uniform float u_edgeIntensity;
      uniform float u_rimIntensity;
      uniform float u_baseIntensity;
      uniform float u_edgeDistance;
      uniform float u_rimDistance;
      uniform float u_baseDistance;
      uniform float u_cornerBoost;
      uniform float u_rippleEffect;
      uniform float u_tintOpacity;
    varying vec2 v_texcoord;

      // Function to calculate distance from rounded rectangle edge
      float roundedRectDistance(vec2 coord, vec2 size, float radius) {
        vec2 center = size * 0.5;
        vec2 pixelCoord = coord * size;
        vec2 toCorner = abs(pixelCoord - center) - (center - radius);
        float outsideCorner = length(max(toCorner, 0.0));
        float insideCorner = min(max(toCorner.x, toCorner.y), 0.0);
        return (outsideCorner + insideCorner - radius);
      }
      
      // Function to calculate distance from circle edge (negative inside, positive outside)
      float circleDistance(vec2 coord, vec2 size, float radius) {
        vec2 center = vec2(0.5, 0.5);
        vec2 pixelCoord = coord * size;
        vec2 centerPixel = center * size;
        float distFromCenter = length(pixelCoord - centerPixel);
        return distFromCenter - radius;
      }
      
      // Check if this is a pill (border radius is approximately 50% of height AND width > height)
      bool isPill(vec2 size, float radius) {
        float heightRatioDiff = abs(radius - size.y * 0.5);
        bool radiusMatchesHeight = heightRatioDiff < 2.0;
        bool isWiderThanTall = size.x > size.y + 4.0; // Must be significantly wider
        return radiusMatchesHeight && isWiderThanTall;
      }
      
      // Check if this is a circle (border radius is approximately 50% of smaller dimension AND roughly square)
      bool isCircle(vec2 size, float radius) {
        float minDim = min(size.x, size.y);
        bool radiusMatchesMinDim = abs(radius - minDim * 0.5) < 1.0;
        bool isRoughlySquare = abs(size.x - size.y) < 4.0; // Width and height are similar
        return radiusMatchesMinDim && isRoughlySquare;
      }
      
      // Function to calculate distance from pill edge (capsule shape)
      float pillDistance(vec2 coord, vec2 size, float radius) {
        vec2 center = size * 0.5;
        vec2 pixelCoord = coord * size;
        
        // Proper capsule: line segment with radius
        // The capsule axis runs horizontally from (radius, center.y) to (size.x - radius, center.y)
        vec2 capsuleStart = vec2(radius, center.y);
        vec2 capsuleEnd = vec2(size.x - radius, center.y);
        
        // Project point onto the capsule axis (line segment)
        vec2 capsuleAxis = capsuleEnd - capsuleStart;
        float capsuleLength = length(capsuleAxis);
        
        if (capsuleLength > 0.0) {
          vec2 toPoint = pixelCoord - capsuleStart;
          float t = clamp(dot(toPoint, capsuleAxis) / dot(capsuleAxis, capsuleAxis), 0.0, 1.0);
          vec2 closestPointOnAxis = capsuleStart + t * capsuleAxis;
          return length(pixelCoord - closestPointOnAxis) - radius;
        } else {
          // Degenerate case: just a circle
          return length(pixelCoord - center) - radius;
        }
      }

    void main() {
        vec2 coord = v_texcoord;
        
        // Calculate which area of the page should be visible through the container
        float scrollY = u_scrollY;
        vec2 containerSize = u_resolution;
        vec2 textureSize = u_textureSize;
        
        // Container position in viewport coordinates
        vec2 containerCenter = u_containerPosition + vec2(0.0, scrollY);
        
        // Convert container coordinates to page coordinates
        vec2 containerOffset = (coord - 0.5) * containerSize;
        vec2 pagePixel = containerCenter + containerOffset;
        
        // Convert to texture coordinate (0 to 1)
        vec2 textureCoord = pagePixel / textureSize;
        
        // Glass refraction effects
        float distFromEdgeShape;
        vec2 shapeNormal; // Normal vector pointing away from shape surface
        
        if (isPill(u_resolution, u_borderRadius)) {
          distFromEdgeShape = -pillDistance(coord, u_resolution, u_borderRadius);
          
          // Calculate normal for pill shape
          vec2 center = vec2(0.5, 0.5);
          vec2 pixelCoord = coord * u_resolution;
          vec2 capsuleStart = vec2(u_borderRadius, center.y * u_resolution.y);
          vec2 capsuleEnd = vec2(u_resolution.x - u_borderRadius, center.y * u_resolution.y);
          vec2 capsuleAxis = capsuleEnd - capsuleStart;
          float capsuleLength = length(capsuleAxis);
          
          if (capsuleLength > 0.0) {
            vec2 toPoint = pixelCoord - capsuleStart;
            float t = clamp(dot(toPoint, capsuleAxis) / dot(capsuleAxis, capsuleAxis), 0.0, 1.0);
            vec2 closestPointOnAxis = capsuleStart + t * capsuleAxis;
            vec2 normalDir = pixelCoord - closestPointOnAxis;
            shapeNormal = length(normalDir) > 0.0 ? normalize(normalDir) : vec2(0.0, 1.0);
          } else {
            shapeNormal = normalize(coord - center);
          }
        } else if (isCircle(u_resolution, u_borderRadius)) {
          distFromEdgeShape = -circleDistance(coord, u_resolution, u_borderRadius);
          vec2 center = vec2(0.5, 0.5);
          shapeNormal = normalize(coord - center);
        } else {
          distFromEdgeShape = -roundedRectDistance(coord, u_resolution, u_borderRadius);
      vec2 center = vec2(0.5, 0.5);
          shapeNormal = normalize(coord - center);
        }
        distFromEdgeShape = max(distFromEdgeShape, 0.0);
        
        float distFromLeft = coord.x;
        float distFromRight = 1.0 - coord.x;
        float distFromTop = coord.y;
        float distFromBottom = 1.0 - coord.y;
        float distFromEdge = distFromEdgeShape / min(u_resolution.x, u_resolution.y);
        
        // Smooth glass refraction using shape-aware normal
        float normalizedDistance = distFromEdge * min(u_resolution.x, u_resolution.y);
        float baseIntensity = 1.0 - exp(-normalizedDistance * u_baseDistance);
        float edgeIntensity = exp(-normalizedDistance * u_edgeDistance);
        float rimIntensity = exp(-normalizedDistance * u_rimDistance);
        
        // Apply center warping only if warp is enabled, keep edge and rim effects always
        float baseComponent = u_warp > 0.5 ? baseIntensity * u_baseIntensity : 0.0;
        float totalIntensity = baseComponent + edgeIntensity * u_edgeIntensity + rimIntensity * u_rimIntensity;
        
        vec2 baseRefraction = shapeNormal * totalIntensity;
        
        float cornerProximityX = min(distFromLeft, distFromRight);
        float cornerProximityY = min(distFromTop, distFromBottom);
        float cornerDistance = max(cornerProximityX, cornerProximityY);
        float cornerNormalized = cornerDistance * min(u_resolution.x, u_resolution.y);
        
        float cornerBoost = exp(-cornerNormalized * 0.3) * u_cornerBoost;
        vec2 cornerRefraction = shapeNormal * cornerBoost;
        
        vec2 perpendicular = vec2(-shapeNormal.y, shapeNormal.x);
        float rippleEffect = sin(distFromEdge * 25.0) * u_rippleEffect * rimIntensity;
        vec2 textureRefraction = perpendicular * rippleEffect;
        
        vec2 totalRefraction = baseRefraction + cornerRefraction + textureRefraction;
        textureCoord += totalRefraction;
        
        // Gaussian blur
        vec4 color = vec4(0.0);
        vec2 texelSize = 1.0 / u_textureSize;
        float sigma = u_blurRadius / 2.0;
        vec2 blurStep = texelSize * sigma;
        
        float totalWeight = 0.0;
        
        for(float i = -6.0; i <= 6.0; i += 1.0) {
          for(float j = -6.0; j <= 6.0; j += 1.0) {
            float distance = length(vec2(i, j));
            if(distance > 6.0) continue;
            
            float weight = exp(-(distance * distance) / (2.0 * sigma * sigma));
            
            vec2 offset = vec2(i, j) * blurStep;
            color += texture2D(u_image, textureCoord + offset) * weight;
            totalWeight += weight;
          }
        }
        
        color /= totalWeight;
        
        // Simple vertical gradient
        float gradientPosition = coord.y;
        vec3 topTint = vec3(1.0, 1.0, 1.0);
        vec3 bottomTint = vec3(0.7, 0.7, 0.7);
        vec3 gradientTint = mix(topTint, bottomTint, gradientPosition);
        vec3 tintedColor = mix(color.rgb, gradientTint, u_tintOpacity);
        color = vec4(tintedColor, color.a);
        
        // Sampled gradient
        vec2 viewportCenter = containerCenter;
        float topY = (viewportCenter.y - containerSize.y * 0.4) / textureSize.y;
        float midY = viewportCenter.y / textureSize.y;
        float bottomY = (viewportCenter.y + containerSize.y * 0.4) / textureSize.y;
        
        vec3 topColor = vec3(0.0);
        vec3 midColor = vec3(0.0);
        vec3 bottomColor = vec3(0.0);
        
        float sampleCount = 0.0;
        for(float x = 0.0; x < 1.0; x += 0.05) {
          for(float yOffset = -5.0; yOffset <= 5.0; yOffset += 1.0) {
            vec2 topSample = vec2(x, topY + yOffset * texelSize.y);
            vec2 midSample = vec2(x, midY + yOffset * texelSize.y);
            vec2 bottomSample = vec2(x, bottomY + yOffset * texelSize.y);
            
            topColor += texture2D(u_image, topSample).rgb;
            midColor += texture2D(u_image, midSample).rgb;
            bottomColor += texture2D(u_image, bottomSample).rgb;
            sampleCount += 1.0;
          }
        }
        
        topColor /= sampleCount;
        midColor /= sampleCount;
        bottomColor /= sampleCount;
        
        vec3 sampledGradient;
        if (gradientPosition < 0.1) {
          sampledGradient = topColor;
        } else if (gradientPosition > 0.9) {
          sampledGradient = bottomColor;
        } else {
          float transitionPos = (gradientPosition - 0.1) / 0.8;
          if (transitionPos < 0.5) {
            float t = transitionPos * 2.0;
            sampledGradient = mix(topColor, midColor, t);
          } else {
            float t = (transitionPos - 0.5) * 2.0;
            sampledGradient = mix(midColor, bottomColor, t);
          }
        }
        
        vec3 finalTinted = mix(color.rgb, sampledGradient, u_tintOpacity * 0.3);
        color = vec4(finalTinted, color.a);
        
        // Shape mask (rounded rectangle, circle, or pill)
        float maskDistance;
        if (isPill(u_resolution, u_borderRadius)) {
          maskDistance = pillDistance(coord, u_resolution, u_borderRadius);
        } else if (isCircle(u_resolution, u_borderRadius)) {
          maskDistance = circleDistance(coord, u_resolution, u_borderRadius);
        } else {
          maskDistance = roundedRectDistance(coord, u_resolution, u_borderRadius);
        }
        float mask = 1.0 - smoothstep(-1.0, 1.0, maskDistance);
        
        gl_FragColor = vec4(color.rgb, mask);
      }
    `

    const program = this.createProgram(gl, vsSource, fsSource)
    if (!program) return

    gl.useProgram(program)

    // Set up geometry
    const positionBuffer = gl.createBuffer()
    gl.bindBuffer(gl.ARRAY_BUFFER, positionBuffer)
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, -1, 1, 1, -1, 1, 1]), gl.STATIC_DRAW)

    const texcoordBuffer = gl.createBuffer()
    gl.bindBuffer(gl.ARRAY_BUFFER, texcoordBuffer)
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([0, 1, 1, 1, 0, 0, 0, 0, 1, 1, 1, 0]), gl.STATIC_DRAW)

    // Get locations
    const positionLoc = gl.getAttribLocation(program, 'a_position')
    const texcoordLoc = gl.getAttribLocation(program, 'a_texcoord')
    const resolutionLoc = gl.getUniformLocation(program, 'u_resolution')
    const textureSizeLoc = gl.getUniformLocation(program, 'u_textureSize')
    const scrollYLoc = gl.getUniformLocation(program, 'u_scrollY')
    const pageHeightLoc = gl.getUniformLocation(program, 'u_pageHeight')
    const viewportHeightLoc = gl.getUniformLocation(program, 'u_viewportHeight')
    const blurRadiusLoc = gl.getUniformLocation(program, 'u_blurRadius')
    const borderRadiusLoc = gl.getUniformLocation(program, 'u_borderRadius')
    const containerPositionLoc = gl.getUniformLocation(program, 'u_containerPosition')
    const warpLoc = gl.getUniformLocation(program, 'u_warp')
    const edgeIntensityLoc = gl.getUniformLocation(program, 'u_edgeIntensity')
    const rimIntensityLoc = gl.getUniformLocation(program, 'u_rimIntensity')
    const baseIntensityLoc = gl.getUniformLocation(program, 'u_baseIntensity')
    const edgeDistanceLoc = gl.getUniformLocation(program, 'u_edgeDistance')
    const rimDistanceLoc = gl.getUniformLocation(program, 'u_rimDistance')
    const baseDistanceLoc = gl.getUniformLocation(program, 'u_baseDistance')
    const cornerBoostLoc = gl.getUniformLocation(program, 'u_cornerBoost')
    const rippleEffectLoc = gl.getUniformLocation(program, 'u_rippleEffect')
    const tintOpacityLoc = gl.getUniformLocation(program, 'u_tintOpacity')
    const imageLoc = gl.getUniformLocation(program, 'u_image')

    // Create texture
    const texture = gl.createTexture()
    gl.bindTexture(gl.TEXTURE_2D, texture)
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, image)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)

    // Store references
    this.gl_refs = {
      gl,
      texture,
      textureSizeLoc,
      scrollYLoc,
      positionLoc,
      texcoordLoc,
      resolutionLoc,
      pageHeightLoc,
      viewportHeightLoc,
      blurRadiusLoc,
      borderRadiusLoc,
      containerPositionLoc,
      warpLoc,
      edgeIntensityLoc,
      rimIntensityLoc,
      baseIntensityLoc,
      edgeDistanceLoc,
      rimDistanceLoc,
      baseDistanceLoc,
      cornerBoostLoc,
      rippleEffectLoc,
      tintOpacityLoc,
      imageLoc,
      positionBuffer,
      texcoordBuffer
    }

    // Set up viewport and attributes
    gl.viewport(0, 0, this.canvas.width, this.canvas.height)
    gl.clearColor(0, 0, 0, 0)

    gl.bindBuffer(gl.ARRAY_BUFFER, positionBuffer)
    gl.enableVertexAttribArray(positionLoc)
    gl.vertexAttribPointer(positionLoc, 2, gl.FLOAT, false, 0, 0)

    gl.bindBuffer(gl.ARRAY_BUFFER, texcoordBuffer)
    gl.enableVertexAttribArray(texcoordLoc)
    gl.vertexAttribPointer(texcoordLoc, 2, gl.FLOAT, false, 0, 0)

    // Set uniforms
    gl.uniform2f(resolutionLoc, this.canvas.width, this.canvas.height)
    gl.uniform2f(textureSizeLoc, image.width, image.height)
    gl.uniform1f(blurRadiusLoc, window.glassControls?.blurRadius || 5.0)
    gl.uniform1f(borderRadiusLoc, this.borderRadius)
    gl.uniform1f(warpLoc, this.warp ? 1.0 : 0.0)
    gl.uniform1f(edgeIntensityLoc, window.glassControls?.edgeIntensity || 0.01)
    gl.uniform1f(rimIntensityLoc, window.glassControls?.rimIntensity || 0.05)
    gl.uniform1f(baseIntensityLoc, window.glassControls?.baseIntensity || 0.01)
    gl.uniform1f(edgeDistanceLoc, window.glassControls?.edgeDistance || 0.15)
    gl.uniform1f(rimDistanceLoc, window.glassControls?.rimDistance || 0.8)
    gl.uniform1f(baseDistanceLoc, window.glassControls?.baseDistance || 0.1)
    gl.uniform1f(cornerBoostLoc, window.glassControls?.cornerBoost || 0.02)
    gl.uniform1f(rippleEffectLoc, window.glassControls?.rippleEffect || 0.1)
    gl.uniform1f(tintOpacityLoc, this.tintOpacity)

    // Set initial position (will be updated in render loop)
    const position = this.getPosition()
    gl.uniform2f(containerPositionLoc, position.x, position.y)

    const pageHeight = Math.max(document.body.scrollHeight, document.documentElement.scrollHeight)
    const viewportHeight = window.innerHeight
    gl.uniform1f(pageHeightLoc, pageHeight)
    gl.uniform1f(viewportHeightLoc, viewportHeight)

    gl.activeTexture(gl.TEXTURE0)
    gl.bindTexture(gl.TEXTURE_2D, texture)
    gl.uniform1i(imageLoc, 0)

    // Start rendering
    this.startRenderLoop()
  }

  startRenderLoop() {
    const render = () => {
      if (!this.gl_refs.gl) return

      const gl = this.gl_refs.gl
      gl.clear(gl.COLOR_BUFFER_BIT)

      // Update scroll position
      const scrollY = window.pageYOffset || document.documentElement.scrollTop
      gl.uniform1f(this.gl_refs.scrollYLoc, scrollY)

      // Update container position (in case it moved)
      const position = this.getPosition()
      gl.uniform2f(this.gl_refs.containerPositionLoc, position.x, position.y)

      gl.drawArrays(gl.TRIANGLES, 0, 6)
    }

    render()

    const handleScroll = () => render()
    window.addEventListener('scroll', handleScroll, { passive: true })

    // Store render function for external calls
    this.render = render
  }

  createProgram(gl, vsSource, fsSource) {
    const vs = this.compileShader(gl, gl.VERTEX_SHADER, vsSource)
    const fs = this.compileShader(gl, gl.FRAGMENT_SHADER, fsSource)
    if (!vs || !fs) return null

    const program = gl.createProgram()
    gl.attachShader(program, vs)
    gl.attachShader(program, fs)
    gl.linkProgram(program)

    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      console.error('Program link error:', gl.getProgramInfoLog(program))
      return null
    }

    return program
  }

  compileShader(gl, type, source) {
    const shader = gl.createShader(type)
    gl.shaderSource(shader, source)
    gl.compileShader(shader)
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
      console.error('Shader compile error:', gl.getShaderInfoLog(shader))
      return null
    }
    return shader
  }
}
