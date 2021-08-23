import * as cornerstone3D from '../../cornerstone-render/src/index'
import * as csTools3d from '../src/index'

const {
  cache,
  RenderingEngine,
  VIEWPORT_TYPE,
  ORIENTATION,
  Utilities,
  eventTarget,
  registerImageLoader,
  unregisterAllImageLoaders,
  metaData,
  EVENTS,
  getEnabledElement,
  createAndCacheVolume,
  registerVolumeLoader,
} = cornerstone3D

const {
  ProbeTool,
  ToolGroupManager,
  getToolState,
  removeToolState,
  CornerstoneTools3DEvents,
} = csTools3d

const {
  fakeImageLoader,
  fakeMetaDataProvider,
  fakeVolumeLoader,
  createNormalizedMouseEvent,
} = Utilities.testUtils

const renderingEngineUID = 'RENDERING_ENGINE_UID'

const scene1UID = 'SCENE_1'
const viewportUID = 'VIEWPORT'

const AXIAL = 'AXIAL'

const DOMElements = []

const volumeId = `fakeVolumeLoader:volumeURI_100_100_10_1_1_1_0`

function createCanvas(renderingEngine, viewportType, width, height) {
  // TODO: currently we need to have a parent div on the canvas with
  // position of relative for the svg layer to be set correctly
  const viewportPane = document.createElement('div')
  viewportPane.style.position = 'relative'
  viewportPane.style.width = `${width}px`
  viewportPane.style.height = `${height}px`

  document.body.appendChild(viewportPane)

  const canvas = document.createElement('canvas')

  canvas.style.position = 'absolute'
  canvas.style.width = '100%'
  canvas.style.height = '100%'
  viewportPane.appendChild(canvas)

  DOMElements.push(canvas)
  DOMElements.push(viewportPane)

  renderingEngine.setViewports([
    {
      sceneUID: scene1UID,
      viewportUID: viewportUID,
      type: viewportType,
      canvas: canvas,
      defaultOptions: {
        background: [1, 0, 1], // pinkish background
        orientation: ORIENTATION[AXIAL],
      },
    },
  ])
  return canvas
}

describe('Cornerstone Tools: ', () => {
  beforeEach(function () {
    csTools3d.init()
    csTools3d.addTool(ProbeTool, {})
    cache.purgeCache()
    this.stackToolGroup = ToolGroupManager.createToolGroup('stack')
    this.stackToolGroup.addTool('Probe', {
      configuration: { volumeUID: volumeId }, // Only for volume viewport
    })
    this.stackToolGroup.setToolActive('Probe', {
      bindings: [{ mouseButton: 1 }],
    })

    this.renderingEngine = new RenderingEngine(renderingEngineUID)
    registerImageLoader('fakeImageLoader', fakeImageLoader)
    registerVolumeLoader('fakeVolumeLoader', fakeVolumeLoader)
    metaData.addProvider(fakeMetaDataProvider, 10000)
  })

  afterEach(function () {
    csTools3d.destroy()
    eventTarget.reset()
    cache.purgeCache()
    this.renderingEngine.destroy()
    metaData.removeProvider(fakeMetaDataProvider)
    unregisterAllImageLoaders()
    ToolGroupManager.destroyToolGroupById('stack')

    DOMElements.forEach((el) => {
      if (el.parentNode) {
        el.parentNode.removeChild(el)
      }
    })
  })

  it('Should successfully click to put a probe tool on a canvas - 512 x 128', function (done) {
    const canvas = createCanvas(
      this.renderingEngine,
      VIEWPORT_TYPE.STACK,
      512,
      128
    )

    const imageId1 = 'fakeImageLoader:imageURI_64_64_10_5_1_1_0'
    const vp = this.renderingEngine.getViewport(viewportUID)

    const addEventListenerForAnnotationRendered = () => {
      canvas.addEventListener(
        CornerstoneTools3DEvents.ANNOTATION_RENDERED,
        () => {
          // Can successfully add probe tool to toolStateManager
          const enabledElement = getEnabledElement(canvas)
          const probeToolState = getToolState(enabledElement, 'Probe')
          expect(probeToolState).toBeDefined()
          expect(probeToolState.length).toBe(1)

          const probeToolData = probeToolState[0]
          expect(probeToolData.metadata.referencedImageId).toBe(
            imageId1.split(':')[1]
          )
          expect(probeToolData.metadata.toolName).toBe('Probe')
          expect(probeToolData.data.invalidated).toBe(false)

          const data = probeToolData.data.cachedStats
          const targets = Array.from(Object.keys(data))
          expect(targets.length).toBe(1)

          // The world coordinate is on the white bar so value is 255
          expect(data[targets[0]].value).toBe(255)

          removeToolState(canvas, probeToolData)
          done()
        }
      )
    }

    canvas.addEventListener(EVENTS.IMAGE_RENDERED, () => {
      const index1 = [11, 20, 0]

      const { vtkImageData } = vp.getImageData()

      const {
        pageX: pageX1,
        pageY: pageY1,
        clientX: clientX1,
        clientY: clientY1,
        worldCoord: worldCoord1,
      } = createNormalizedMouseEvent(vtkImageData, index1, canvas, vp)

      // Mouse Down
      let evt = new MouseEvent('mousedown', {
        target: canvas,
        buttons: 1,
        pageX: pageX1,
        pageY: pageY1,
        clientX: clientX1,
        clientY: clientY1,
      })
      canvas.dispatchEvent(evt)

      // Mouse Up instantly after
      evt = new MouseEvent('mouseup')

      // Since there is tool rendering happening for any mouse event
      // we just attach a listener before the last one -> mouse up
      addEventListenerForAnnotationRendered()
      document.dispatchEvent(evt)
    })

    this.stackToolGroup.addViewports(
      this.renderingEngine.uid,
      undefined,
      vp.uid
    )

    try {
      vp.setStack([imageId1], 0)
      this.renderingEngine.render()
    } catch (e) {
      done.fail(e)
    }
  })

  it('Should successfully click to put two probe tools on a canvas - 256 x 256', function (done) {
    const canvas = createCanvas(
      this.renderingEngine,
      VIEWPORT_TYPE.STACK,
      256,
      256
    )

    const imageId1 = 'fakeImageLoader:imageURI_64_64_10_5_1_1_0'
    const vp = this.renderingEngine.getViewport(viewportUID)

    const addEventListenerForAnnotationRendered = () => {
      canvas.addEventListener(
        CornerstoneTools3DEvents.ANNOTATION_RENDERED,
        () => {
          // Can successfully add probe tool to toolStateManager
          const enabledElement = getEnabledElement(canvas)
          const probeToolState = getToolState(enabledElement, 'Probe')
          expect(probeToolState).toBeDefined()
          expect(probeToolState.length).toBe(2)

          const firstProbeToolData = probeToolState[0]
          expect(firstProbeToolData.metadata.referencedImageId).toBe(
            imageId1.split(':')[1]
          )
          expect(firstProbeToolData.metadata.toolName).toBe('Probe')
          expect(firstProbeToolData.data.invalidated).toBe(false)

          let data = firstProbeToolData.data.cachedStats
          let targets = Array.from(Object.keys(data))
          expect(targets.length).toBe(1)

          // The world coordinate is on the white bar so value is 255
          expect(data[targets[0]].value).toBe(255)

          // Second click
          const secondProbeToolData = probeToolState[1]
          expect(secondProbeToolData.metadata.toolName).toBe('Probe')
          expect(secondProbeToolData.data.invalidated).toBe(false)

          data = secondProbeToolData.data.cachedStats
          targets = Array.from(Object.keys(data))
          expect(targets.length).toBe(1)

          // The world coordinate is on the white bar so value is 255
          expect(data[targets[0]].value).toBe(0)

          //
          removeToolState(canvas, firstProbeToolData)
          removeToolState(canvas, secondProbeToolData)

          done()
        }
      )
    }

    canvas.addEventListener(EVENTS.IMAGE_RENDERED, () => {
      const index1 = [11, 20, 0] // 255
      const index2 = [20, 20, 0] // 0

      const { vtkImageData } = vp.getImageData()

      const {
        pageX: pageX1,
        pageY: pageY1,
        clientX: clientX1,
        clientY: clientY1,
        worldCoord: worldCoord1,
      } = createNormalizedMouseEvent(vtkImageData, index1, canvas, vp)

      const {
        pageX: pageX2,
        pageY: pageY2,
        clientX: clientX2,
        clientY: clientY2,
        worldCoord: worldCoord2,
      } = createNormalizedMouseEvent(vtkImageData, index2, canvas, vp)

      // Mouse Down
      let evt1 = new MouseEvent('mousedown', {
        target: canvas,
        buttons: 1,
        pageX: pageX1,
        pageY: pageY1,
        clientX: clientX1,
        clientY: clientY1,
      })
      canvas.dispatchEvent(evt1)

      // Mouse Up instantly after
      evt1 = new MouseEvent('mouseup')
      document.dispatchEvent(evt1)

      // Mouse Down
      let evt2 = new MouseEvent('mousedown', {
        target: canvas,
        buttons: 1,
        pageX: pageX2,
        pageY: pageY2,
        clientX: clientX2,
        clientY: clientY2,
      })
      canvas.dispatchEvent(evt2)

      // Mouse Up instantly after
      evt2 = new MouseEvent('mouseup')

      addEventListenerForAnnotationRendered()
      document.dispatchEvent(evt2)
    })

    this.stackToolGroup.addViewports(
      this.renderingEngine.uid,
      undefined,
      vp.uid
    )

    try {
      vp.setStack([imageId1], 0)
      this.renderingEngine.render()
    } catch (e) {
      done.fail(e)
    }
  })

  it('Should successfully click to put a probe tool on a canvas - 256 x 512', function (done) {
    const canvas = createCanvas(
      this.renderingEngine,
      VIEWPORT_TYPE.STACK,
      256,
      512
    )

    const imageId1 = 'fakeImageLoader:imageURI_256_256_100_100_1_1_0'
    const vp = this.renderingEngine.getViewport(viewportUID)

    const addEventListenerForAnnotationRendered = () => {
      canvas.addEventListener(
        CornerstoneTools3DEvents.ANNOTATION_RENDERED,
        () => {
          // Can successfully add probe tool to toolStateManager
          const enabledElement = getEnabledElement(canvas)
          const probeToolState = getToolState(enabledElement, 'Probe')
          expect(probeToolState).toBeDefined()
          expect(probeToolState.length).toBe(1)

          const probeToolData = probeToolState[0]
          expect(probeToolData.metadata.referencedImageId).toBe(
            imageId1.split(':')[1]
          )
          expect(probeToolData.metadata.toolName).toBe('Probe')
          expect(probeToolData.data.invalidated).toBe(false)

          const data = probeToolData.data.cachedStats
          const targets = Array.from(Object.keys(data))
          expect(targets.length).toBe(1)

          // The world coordinate is on the white bar so value is 255
          expect(data[targets[0]].value).toBe(255)

          removeToolState(canvas, probeToolData)
          done()
        }
      )
    }

    canvas.addEventListener(EVENTS.IMAGE_RENDERED, () => {
      const index1 = [150, 100, 0] // 255

      const { vtkImageData } = vp.getImageData()

      const {
        pageX: pageX1,
        pageY: pageY1,
        clientX: clientX1,
        clientY: clientY1,
        worldCoord: worldCoord1,
      } = createNormalizedMouseEvent(vtkImageData, index1, canvas, vp)

      // Mouse Down
      let evt = new MouseEvent('mousedown', {
        target: canvas,
        buttons: 1,
        pageX: pageX1,
        pageY: pageY1,
        clientX: clientX1,
        clientY: clientY1,
      })
      canvas.dispatchEvent(evt)

      // Mouse Up instantly after
      evt = new MouseEvent('mouseup')

      addEventListenerForAnnotationRendered()
      document.dispatchEvent(evt)
    })

    this.stackToolGroup.addViewports(
      this.renderingEngine.uid,
      undefined,
      vp.uid
    )

    try {
      vp.setStack([imageId1], 0)
      this.renderingEngine.render()
    } catch (e) {
      done.fail(e)
    }
  })

  it('Should successfully click to put a probe tool on a canvas - 256 x 512', function (done) {
    const canvas = createCanvas(
      this.renderingEngine,
      VIEWPORT_TYPE.STACK,
      256,
      512
    )

    const imageId1 = 'fakeImageLoader:imageURI_64_64_10_5_1_1_0'
    const vp = this.renderingEngine.getViewport(viewportUID)

    const addEventListenerForAnnotationRendered = () => {
      canvas.addEventListener(
        CornerstoneTools3DEvents.ANNOTATION_RENDERED,
        () => {
          // Can successfully add probe tool to toolStateManager
          const enabledElement = getEnabledElement(canvas)
          const probeToolState = getToolState(enabledElement, 'Probe')
          expect(probeToolState).toBeDefined()
          expect(probeToolState.length).toBe(1)

          const probeToolData = probeToolState[0]
          expect(probeToolData.metadata.referencedImageId).toBe(
            imageId1.split(':')[1]
          )
          expect(probeToolData.metadata.toolName).toBe('Probe')
          expect(probeToolData.data.invalidated).toBe(false)

          const data = probeToolData.data.cachedStats
          const targets = Array.from(Object.keys(data))
          expect(targets.length).toBe(1)

          // The world coordinate is on the white bar so value is 255
          expect(data[targets[0]].value).toBe(0)

          removeToolState(canvas, probeToolData)
          done()
        }
      )
    }

    canvas.addEventListener(EVENTS.IMAGE_RENDERED, () => {
      const index1 = [35, 35, 0] // 0

      const { vtkImageData } = vp.getImageData()

      const {
        pageX: pageX1,
        pageY: pageY1,
        clientX: clientX1,
        clientY: clientY1,
        worldCoord: worldCoord1,
      } = createNormalizedMouseEvent(vtkImageData, index1, canvas, vp)

      // Mouse Down
      let evt = new MouseEvent('mousedown', {
        target: canvas,
        buttons: 1,
        pageX: pageX1,
        pageY: pageY1,
        clientX: clientX1,
        clientY: clientY1,
      })
      canvas.dispatchEvent(evt)

      // Mouse Up instantly after
      evt = new MouseEvent('mouseup')

      addEventListenerForAnnotationRendered()
      document.dispatchEvent(evt)
    })

    this.stackToolGroup.addViewports(
      this.renderingEngine.uid,
      undefined,
      vp.uid
    )

    try {
      vp.setStack([imageId1], 0)
      this.renderingEngine.render()
    } catch (e) {
      done.fail(e)
    }
  })

  it('Should successfully create a prob tool on a canvas with mouse drag in a Volume viewport - 512 x 128', function (done) {
    const canvas = createCanvas(
      this.renderingEngine,
      VIEWPORT_TYPE.ORTHOGRAPHIC,
      512,
      128
    )

    const vp = this.renderingEngine.getViewport(viewportUID)

    const addEventListenerForAnnotationRendered = () => {
      canvas.addEventListener(
        CornerstoneTools3DEvents.ANNOTATION_RENDERED,
        () => {
          const enabledElement = getEnabledElement(canvas)
          const probeToolState = getToolState(enabledElement, 'Probe')
          // Can successfully add Length tool to toolStateManager
          expect(probeToolState).toBeDefined()
          expect(probeToolState.length).toBe(1)

          const probeToolData = probeToolState[0]
          expect(probeToolData.metadata.toolName).toBe('Probe')
          expect(probeToolData.data.invalidated).toBe(false)

          const data = probeToolData.data.cachedStats
          const targets = Array.from(Object.keys(data))
          expect(targets.length).toBe(1)

          expect(data[targets[0]].value).toBe(255)

          removeToolState(canvas, probeToolData)
          done()
        }
      )
    }

    canvas.addEventListener(EVENTS.IMAGE_RENDERED, () => {
      const index1 = [50, 50, 4]

      const { vtkImageData } = vp.getImageData()

      const {
        pageX: pageX1,
        pageY: pageY1,
        clientX: clientX1,
        clientY: clientY1,
        worldCoord: worldCoord1,
      } = createNormalizedMouseEvent(vtkImageData, index1, canvas, vp)

      // Mouse Down
      let evt = new MouseEvent('mousedown', {
        target: canvas,
        buttons: 1,
        clientX: clientX1,
        clientY: clientY1,
        pageX: pageX1,
        pageY: pageY1,
      })
      canvas.dispatchEvent(evt)

      // Mouse Up instantly after
      evt = new MouseEvent('mouseup')

      addEventListenerForAnnotationRendered()
      document.dispatchEvent(evt)
    })

    this.stackToolGroup.addViewports(
      this.renderingEngine.uid,
      undefined,
      vp.uid
    )

    try {
      createAndCacheVolume(volumeId, { imageIds: [] }).then(() => {
        const ctScene = this.renderingEngine.getScene(scene1UID)
        ctScene.setVolumes([{ volumeUID: volumeId }])
        ctScene.render()
      })
    } catch (e) {
      done.fail(e)
    }
  })

  it('Should successfully create a length tool and select AND move it', function (done) {
    const canvas = createCanvas(
      this.renderingEngine,
      VIEWPORT_TYPE.STACK,
      256,
      256
    )

    const imageId1 = 'fakeImageLoader:imageURI_64_64_10_5_1_1_0'
    const vp = this.renderingEngine.getViewport(viewportUID)

    let p2

    const addEventListenerForAnnotationRendered = () => {
      canvas.addEventListener(
        CornerstoneTools3DEvents.ANNOTATION_RENDERED,
        () => {
          const enabledElement = getEnabledElement(canvas)
          const probeToolState = getToolState(enabledElement, 'Probe')
          // Can successfully add Length tool to toolStateManager
          expect(probeToolState).toBeDefined()
          expect(probeToolState.length).toBe(1)

          const probeToolData = probeToolState[0]
          expect(probeToolData.metadata.referencedImageId).toBe(
            imageId1.split(':')[1]
          )
          expect(probeToolData.metadata.toolName).toBe('Probe')
          expect(probeToolData.data.invalidated).toBe(false)

          const data = probeToolData.data.cachedStats
          const targets = Array.from(Object.keys(data))
          expect(targets.length).toBe(1)

          // We expect the probeTool which was original on 255 strip should be 0 now
          expect(data[targets[0]].value).toBe(0)

          const handles = probeToolData.data.handles.points

          expect(handles[0]).toEqual(p2)

          removeToolState(canvas, probeToolData)
          done()
        }
      )
    }

    canvas.addEventListener(EVENTS.IMAGE_RENDERED, () => {
      const index1 = [11, 20, 0] // 255
      const index2 = [40, 40, 0] // 0

      const { vtkImageData } = vp.getImageData()

      const {
        pageX: pageX1,
        pageY: pageY1,
        clientX: clientX1,
        clientY: clientY1,
        worldCoord: worldCoord1,
      } = createNormalizedMouseEvent(vtkImageData, index1, canvas, vp)

      const {
        pageX: pageX2,
        pageY: pageY2,
        clientX: clientX2,
        clientY: clientY2,
        worldCoord: worldCoord2,
      } = createNormalizedMouseEvent(vtkImageData, index2, canvas, vp)
      p2 = worldCoord2

      // Mouse Down
      let evt = new MouseEvent('mousedown', {
        target: canvas,
        buttons: 1,
        clientX: clientX1,
        clientY: clientY1,
        pageX: pageX1,
        pageY: pageY1,
      })
      canvas.dispatchEvent(evt)

      // Mouse Up instantly after
      evt = new MouseEvent('mouseup')
      document.dispatchEvent(evt)

      // Grab the probe tool again
      evt = new MouseEvent('mousedown', {
        target: canvas,
        buttons: 1,
        clientX: clientX1,
        clientY: clientY1,
        pageX: pageX1,
        pageY: pageY1,
      })
      canvas.dispatchEvent(evt)

      // Mouse move to put the end somewhere else
      evt = new MouseEvent('mousemove', {
        target: canvas,
        buttons: 1,
        clientX: clientX2,
        clientY: clientY2,
        pageX: pageX2,
        pageY: pageY2,
      })
      document.dispatchEvent(evt)

      evt = new MouseEvent('mouseup')

      addEventListenerForAnnotationRendered()
      document.dispatchEvent(evt)
    })

    this.stackToolGroup.addViewports(
      this.renderingEngine.uid,
      undefined,
      vp.uid
    )

    try {
      vp.setStack([imageId1], 0)
      this.renderingEngine.render()
    } catch (e) {
      done.fail(e)
    }
  })
})