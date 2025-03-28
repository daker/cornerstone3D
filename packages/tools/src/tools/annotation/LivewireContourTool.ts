import { vec3 } from 'gl-matrix';
import {
  getEnabledElement,
  utilities as csUtils,
  VolumeViewport,
  utilities,
  triggerEvent,
  eventTarget,
} from '@cornerstonejs/core';
import type { Types } from '@cornerstonejs/core';

import { removeAnnotation } from '../../stateManagement/annotation/annotationState';
import {
  drawHandles as drawHandlesSvg,
  drawLinkedTextBox as drawLinkedTextBoxSvg,
} from '../../drawingSvg';
import { state } from '../../store/state';
import { Events, KeyboardBindings, ChangeTypes } from '../../enums';
import { resetElementCursor } from '../../cursors/elementCursor';
import type {
  EventTypes,
  ToolHandle,
  PublicToolProps,
  ToolProps,
  SVGDrawingHelper,
  TextBoxHandle,
} from '../../types';
import getMouseModifierKey from '../../eventDispatchers/shared/getMouseModifier';
import * as math from '../../utilities/math';
import triggerAnnotationRenderForViewportIds from '../../utilities/triggerAnnotationRenderForViewportIds';
import findHandlePolylineIndex from '../../utilities/contours/findHandlePolylineIndex';
import type { LivewireContourAnnotation } from '../../types/ToolSpecificAnnotationTypes';
import { ContourWindingDirection } from '../../types/ContourAnnotation';
import {
  triggerAnnotationModified,
  triggerContourAnnotationCompleted,
} from '../../stateManagement/annotation/helpers/state';

import { LivewireScissors } from '../../utilities/livewire/LivewireScissors';
import { LivewirePath } from '../../utilities/livewire/LiveWirePath';
import { getViewportIdsWithToolToRender } from '../../utilities/viewportFilters';
import ContourSegmentationBaseTool from '../base/ContourSegmentationBaseTool';
import type { AnnotationStyle } from '../../types/AnnotationStyle';
import type { AnnotationModifiedEventDetail } from '../../types/EventTypes';
import { getTextBoxCoordsCanvas } from '../../utilities/drawing';
import { getCalibratedLengthUnitsAndScale, throttle } from '../../utilities';

const CLICK_CLOSE_CURVE_SQR_DIST = 10 ** 2; // px

class LivewireContourTool extends ContourSegmentationBaseTool {
  public static toolName = 'LivewireContour';

  protected scissors: LivewireScissors;
  /** The scissors from the next handle, used for editing */
  protected scissorsNext: LivewireScissors;

  _throttledCalculateCachedStats: Function;
  editData: {
    annotation: LivewireContourAnnotation;
    viewportIdsToRender: Array<string>;
    handleIndex?: number;
    movingTextBox?: boolean;
    newAnnotation?: boolean;
    hasMoved?: boolean;
    lastCanvasPoint?: Types.Point2;
    confirmedPath?: LivewirePath;
    currentPath?: LivewirePath;
    /** The next path segment, on the other side of the handle */
    confirmedPathNext?: LivewirePath;
    closed?: boolean;
    worldToSlice?: (point: Types.Point3) => Types.Point2;
    sliceToWorld?: (point: Types.Point2) => Types.Point3;
    originalPath?: Types.Point3[];
    contourHoleProcessingEnabled?: boolean;
  } | null;
  isDrawing: boolean;
  isHandleOutsideImage = false;

  constructor(
    toolProps: PublicToolProps = {},
    defaultToolProps: ToolProps = {
      supportedInteractionTypes: ['Mouse', 'Touch'],
      configuration: {
        getTextLines: defaultGetTextLines,
        calculateStats: true,
        preventHandleOutsideImage: false,
        /**
         * Specify which modifier key is used to add a hole to a contour. The
         * modifier must be pressed when the first point of a new contour is added.
         */
        contourHoleAdditionModifierKey: KeyboardBindings.Shift,

        /**
         * Configuring this to a value larger than 0 will snap handles to nearby
         * livewire points, within the given rectangle surrounding the clicked point.
         * If set to 0, then the exact clicked point will be used instead, which may
         * not be an edge and can result in jagged outlines.
         * The unit is image pixels (index).
         */
        snapHandleNearby: 2,

        /**
         * Interpolation is only available for segmentation versions of these
         * tools.  To use it on the segmentation tools, set enabled to true,
         * and create two livewire contours in the same segment index, separated
         * by at least one slice.
         */
        interpolation: {
          enabled: false,

          /**
           * Set the nearestEdge to snap interpolated handles to an edge within
           * the given number of pixels.  Setting to 0 disables snap to pixel
           * for interpolation and the interpolated point will be used directly.
           * Setting to too large a value may result in many points outside the contour
           * being chosen.
           */
          nearestEdge: 2,
          /**
           * Set to true to show the interpolated polyline, which can be useful
           * when understanding the nearest edge and
           */
          showInterpolationPolyline: false,
        },

        /**
         * The polyline may get processed in order to reduce the number of points
         * for better performance and storage.
         */
        decimate: {
          enabled: false,
          /** A maximum given distance 'epsilon' to decide if a point should or
           * shouldn't be added the resulting polyline which will have a lower
           * number of points for higher `epsilon` values.
           */
          epsilon: 0.1,
        },

        actions: {
          cancelInProgress: {
            method: 'cancelInProgress',
            bindings: [
              {
                key: 'Escape',
              },
            ],
          },
        },
      },
    }
  ) {
    super(toolProps, defaultToolProps);
    this._throttledCalculateCachedStats = throttle(
      this._calculateCachedStats,
      100,
      { trailing: true }
    );
  }

  protected setupBaseEditData(
    worldPos,
    element,
    annotation,
    nextPos?,
    contourHoleProcessingEnabled?
  ) {
    const enabledElement = getEnabledElement(element);
    const { viewport } = enabledElement;

    this.isDrawing = true;

    const viewportImageData = viewport.getImageData();
    const { imageData: vtkImageData } = viewportImageData;
    let worldToSlice: (point: Types.Point3) => Types.Point2;
    let sliceToWorld: (point: Types.Point2) => Types.Point3;
    let width;
    let height;
    let scalarData;

    if (!(viewport instanceof VolumeViewport)) {
      width = viewportImageData.dimensions[0];
      height = viewportImageData.dimensions[1];

      // Method only to simplify the code making stack and volume viewports code
      // similar and avoiding `if(stack)/else` whenever a coordinate needs to be
      // transformed because `worldToSlice` in this case returns the same IJK
      // coordinate from index space.
      worldToSlice = (point: Types.Point3) => {
        const ijkPoint = csUtils.transformWorldToIndex(vtkImageData, point);
        return [ijkPoint[0], ijkPoint[1]];
      };

      // Method only to simplify the code making stack and volume viewports code
      // similar and avoiding `if(stack)/else` whenever a coordinate needs to be
      // transformed because `sliceToWorld` in this case receives the same IJK
      // coordinate from index space.
      sliceToWorld = (point: Types.Point2) =>
        csUtils.transformIndexToWorld(vtkImageData, [point[0], point[1], 0]);
      scalarData = viewportImageData.scalarData;
    } else if (viewport instanceof VolumeViewport) {
      const sliceImageData = csUtils.getCurrentVolumeViewportSlice(viewport);
      const { sliceToIndexMatrix, indexToSliceMatrix } = sliceImageData;

      worldToSlice = (point: Types.Point3) => {
        const ijkPoint = csUtils.transformWorldToIndex(vtkImageData, point);
        const slicePoint = vec3.transformMat4(
          [0, 0, 0],
          ijkPoint,
          indexToSliceMatrix
        );

        return [slicePoint[0], slicePoint[1]];
      };

      sliceToWorld = (point: Types.Point2) => {
        const ijkPoint = vec3.transformMat4(
          [0, 0, 0],
          [point[0], point[1], 0],
          sliceToIndexMatrix
        ) as Types.Point3;

        return csUtils.transformIndexToWorld(vtkImageData, ijkPoint);
      };

      scalarData = sliceImageData.scalarData;
      width = sliceImageData.width;
      height = sliceImageData.height;
    } else {
      throw new Error('Viewport not supported');
    }
    scalarData = csUtils.convertToGrayscale(scalarData, width, height);
    const { voiRange } = viewport.getProperties();
    const startPos = worldToSlice(worldPos);

    this.scissors = LivewireScissors.createInstanceFromRawPixelData(
      scalarData as Float32Array,
      width,
      height,
      voiRange
    );
    if (nextPos) {
      this.scissorsNext = LivewireScissors.createInstanceFromRawPixelData(
        scalarData as Float32Array,
        width,
        height,
        voiRange
      );
      this.scissorsNext.startSearch(worldToSlice(nextPos));
    }

    // Scissors always start at the startPos for both editing handles and
    // for initial rendering
    this.scissors.startSearch(startPos);

    const newAnnotation = !nextPos;

    const confirmedPath = new LivewirePath();
    const currentPath = new LivewirePath();
    const currentPathNext = newAnnotation ? undefined : new LivewirePath();

    confirmedPath.addPoint(startPos);
    confirmedPath.addControlPoint(startPos);

    const viewportIdsToRender = getViewportIdsWithToolToRender(
      element,
      this.getToolName()
    );

    const lastCanvasPoint = viewport.worldToCanvas(worldPos);

    this.editData = {
      annotation,
      viewportIdsToRender,
      newAnnotation,
      hasMoved: false,
      lastCanvasPoint,
      confirmedPath,
      currentPath,
      confirmedPathNext: currentPathNext,
      closed: false,
      handleIndex:
        this.editData?.handleIndex ?? annotation.handles?.activeHandleIndex,
      worldToSlice,
      sliceToWorld,
      contourHoleProcessingEnabled,
    };
  }

  /**
   * Based on the current position of the mouse and the current imageId to create
   * a CircleROI Annotation and stores it in the annotationManager
   *
   * @param evt -  EventTypes.NormalizedMouseEventType
   * @returns The annotation object.
   *
   */
  addNewAnnotation(
    evt: EventTypes.InteractionEventType
  ): LivewireContourAnnotation {
    const eventDetail = evt.detail;
    const { currentPoints, element } = eventDetail;
    const { world: worldPos } = currentPoints;
    const annotation = this.createAnnotation(evt);
    const contourHoleProcessingEnabled =
      getMouseModifierKey(evt.detail.event) ===
      this.configuration.contourHoleAdditionModifierKey;

    this.setupBaseEditData(
      worldPos,
      element,
      annotation,
      undefined,
      contourHoleProcessingEnabled
    );
    this.addAnnotation(annotation, element);

    this._activateDraw(element);
    evt.preventDefault();
    triggerAnnotationRenderForViewportIds(this.editData.viewportIdsToRender);

    return annotation;
  }

  /**
   * It returns if the canvas point is near the provided annotation in the provided
   * element or not. A proximity is passed to the function to determine the
   * proximity of the point to the annotation in number of pixels.
   *
   * @param element - HTML Element
   * @param annotation - Annotation
   * @param canvasCoords - Canvas coordinates
   * @param proximity - Proximity to tool to consider
   * @returns Boolean, whether the canvas point is near tool
   */
  isPointNearTool = (
    element: HTMLDivElement,
    annotation: LivewireContourAnnotation,
    canvasCoords: Types.Point2,
    proximity: number
  ): boolean => {
    const enabledElement = getEnabledElement(element);
    const { viewport } = enabledElement;
    const proximitySquared = proximity * proximity;
    const canvasPoints = annotation.data.contour.polyline.map((p) =>
      viewport.worldToCanvas(p)
    );

    let startPoint = canvasPoints[canvasPoints.length - 1];

    for (let i = 0; i < canvasPoints.length; i++) {
      const endPoint = canvasPoints[i];
      const distanceToPointSquared = math.lineSegment.distanceToPointSquared(
        startPoint,
        endPoint,
        canvasCoords
      );

      if (distanceToPointSquared <= proximitySquared) {
        return true;
      }

      startPoint = endPoint;
    }

    return false;
  };

  toolSelectedCallback = (
    evt: EventTypes.InteractionEventType,
    annotation: LivewireContourAnnotation
  ): void => {
    const eventDetail = evt.detail;
    const { element } = eventDetail;

    annotation.highlighted = true;

    const viewportIdsToRender = getViewportIdsWithToolToRender(
      element,
      this.getToolName()
    );

    this.editData = {
      annotation,
      viewportIdsToRender,
      movingTextBox: false,
    };

    const enabledElement = getEnabledElement(element);
    const { renderingEngine } = enabledElement;

    this._activateModify(element);
    triggerAnnotationRenderForViewportIds(viewportIdsToRender);
    evt.preventDefault();
  };

  handleSelectedCallback = (
    evt: EventTypes.InteractionEventType,
    annotation: LivewireContourAnnotation,
    handle: ToolHandle
  ): void => {
    const eventDetail = evt.detail;
    const { element } = eventDetail;
    const { data } = annotation;

    annotation.highlighted = true;

    let movingTextBox = false;
    let handleIndex;

    if ((handle as TextBoxHandle).worldPosition) {
      movingTextBox = true;
    } else {
      const { points } = data.handles;

      handleIndex = points.findIndex((p) => p === handle);
    }

    // Find viewports to render on drag.
    const viewportIdsToRender = getViewportIdsWithToolToRender(
      element,
      this.getToolName()
    );

    this.editData = {
      annotation,
      viewportIdsToRender,
      handleIndex,
      movingTextBox,
    };
    this._activateModify(element);

    const enabledElement = getEnabledElement(element);
    const { renderingEngine } = enabledElement;

    triggerAnnotationRenderForViewportIds(viewportIdsToRender);

    evt.preventDefault();
  };

  _endCallback = (
    evt: EventTypes.InteractionEventType,
    clearAnnotation = false
  ): void => {
    const eventDetail = evt.detail;
    const { element } = eventDetail;

    const {
      annotation,
      viewportIdsToRender,
      newAnnotation,
      contourHoleProcessingEnabled,
    } = this.editData;
    const { data } = annotation;

    this.doneEditMemo();

    data.handles.activeHandleIndex = null;

    this._deactivateModify(element);
    this._deactivateDraw(element);

    resetElementCursor(element);

    const enabledElement = getEnabledElement(element);

    if (
      (this.isHandleOutsideImage &&
        this.configuration.preventHandleOutsideImage) ||
      clearAnnotation
    ) {
      removeAnnotation(annotation.annotationUID);
      this.clearEditData();
      triggerAnnotationRenderForViewportIds(viewportIdsToRender);
      return;
    }

    triggerAnnotationRenderForViewportIds(viewportIdsToRender);

    const changeType = newAnnotation
      ? ChangeTypes.Completed
      : ChangeTypes.HandlesUpdated;

    this.triggerChangeEvent(
      annotation,
      enabledElement,
      changeType,
      contourHoleProcessingEnabled
    );
    this.clearEditData();
  };

  protected clearEditData() {
    this.editData = null;
    this.scissors = null;
    this.scissorsNext = null;
    this.isDrawing = false;
  }

  /**
   * Triggers an annotation complete or modified event based on changeType.
   */
  triggerChangeEvent = (
    annotation: LivewireContourAnnotation,
    enabledElement: Types.IEnabledElement,
    changeType = ChangeTypes.StatsUpdated,
    contourHoleProcessingEnabled = false
  ): void => {
    if (changeType === ChangeTypes.Completed) {
      triggerContourAnnotationCompleted(
        annotation,
        contourHoleProcessingEnabled
      );
    } else {
      triggerAnnotationModified(
        annotation,
        enabledElement.viewport.element,
        changeType
      );
    }
  };

  private _mouseDownCallback = (evt: EventTypes.InteractionEventType): void => {
    const doubleClick = evt.type === Events.MOUSE_DOUBLE_CLICK;
    const {
      annotation,
      viewportIdsToRender,
      worldToSlice,
      sliceToWorld,
      newAnnotation,
    } = this.editData;

    if (this.editData.closed) {
      return;
    }

    const eventDetail = evt.detail;
    const { element } = eventDetail;
    const { currentPoints } = eventDetail;
    const { canvas: canvasPos, world: worldPosOriginal } = currentPoints;
    let worldPos = worldPosOriginal;
    const enabledElement = getEnabledElement(element);
    const { viewport, renderingEngine } = enabledElement;
    const controlPoints = this.editData.currentPath.getControlPoints();
    let closePath = controlPoints.length >= 2 && doubleClick;

    // There is a new point being added/changed, and we want that in a separate
    // memo to allow undoing it, so need to call the done edit an extra time here.
    this.doneEditMemo();
    this.createMemo(element, annotation, {
      newAnnotation: newAnnotation && controlPoints.length === 1,
    });

    // Check if user clicked on the first point to close the curve
    if (controlPoints.length >= 2) {
      const closestHandlePoint = {
        index: -1,
        distSquared: Infinity,
      };

      // Check if there is a control point close to the cursor
      for (let i = 0, len = controlPoints.length; i < len; i++) {
        const controlPoint = controlPoints[i];
        const worldControlPoint = sliceToWorld(controlPoint);
        const canvasControlPoint = viewport.worldToCanvas(worldControlPoint);

        const distSquared = math.point.distanceToPointSquared(
          canvasPos,
          canvasControlPoint
        );

        if (
          distSquared <= CLICK_CLOSE_CURVE_SQR_DIST &&
          distSquared < closestHandlePoint.distSquared
        ) {
          closestHandlePoint.distSquared = distSquared;
          closestHandlePoint.index = i;
        }
      }

      if (closestHandlePoint.index === 0) {
        closePath = true;
      }
    }

    const { snapHandleNearby } = this.configuration;
    // Snap the handles as they get created, but not during edit
    if (snapHandleNearby && !this.editData.closed) {
      const currentPath = new LivewirePath();
      const snapPoint = this.scissors.findMinNearby(
        worldToSlice(worldPosOriginal),
        1
      );
      const pathPoints = this.scissors.findPathToPoint(snapPoint);
      currentPath.addPoints(pathPoints);
      currentPath.prependPath(this.editData.confirmedPath);
      worldPos = sliceToWorld(snapPoint);
      this.editData.currentPath = currentPath;
    }

    this.editData.closed = this.editData.closed || closePath;
    this.editData.confirmedPath = this.editData.currentPath;

    // Add the current cursor position as a new control point after clicking
    const lastPoint = this.editData.currentPath.getLastPoint();

    this.editData.confirmedPath.addControlPoint(lastPoint);
    annotation.data.handles.points.push(sliceToWorld(lastPoint));

    // Start a new search starting at the last control point
    this.scissors.startSearch(worldToSlice(worldPos));

    annotation.invalidated = true;
    triggerAnnotationRenderForViewportIds(viewportIdsToRender);

    if (this.editData.closed) {
      // Update the annotation because `editData` will be set to null
      this.updateAnnotation(this.editData.confirmedPath);
      this._endCallback(evt);
    }

    evt.preventDefault();
  };

  private _mouseMoveCallback = (evt: EventTypes.InteractionEventType): void => {
    const { element, currentPoints } = evt.detail;
    const { world: worldPos, canvas: canvasPos } = currentPoints;
    const { renderingEngine } = getEnabledElement(element);
    const viewportIdsToRender = getViewportIdsWithToolToRender(
      element,
      this.getToolName()
    );

    this.editData.lastCanvasPoint = canvasPos;

    const { width: imgWidth, height: imgHeight } = this.scissors;
    const { worldToSlice } = this.editData;
    const slicePoint: Types.Point2 = worldToSlice(worldPos);

    // Check if the point is inside the bounding box
    if (
      slicePoint[0] < 0 ||
      slicePoint[1] < 0 ||
      slicePoint[0] >= imgWidth ||
      slicePoint[1] >= imgHeight
    ) {
      return;
    }

    const pathPoints = this.scissors.findPathToPoint(slicePoint);
    const currentPath = new LivewirePath();
    currentPath.addPoints(pathPoints);

    // Merge the "confirmed" path that goes from the first control point to the
    // last one with the current path that goes from the last control point to
    // the cursor point
    currentPath.prependPath(this.editData.confirmedPath);

    // Store the new path
    this.editData.currentPath = currentPath;

    triggerAnnotationRenderForViewportIds(viewportIdsToRender);
    evt.preventDefault();
  };

  public editHandle(
    worldPos: Types.Point3,
    element,
    annotation: LivewireContourAnnotation,
    handleIndex: number
  ) {
    const { data } = annotation;
    const { points: handlePoints } = data.handles;
    const { length: numHandles } = handlePoints;
    const previousHandle =
      handlePoints[(handleIndex - 1 + numHandles) % numHandles];
    const nextHandle = handlePoints[(handleIndex + 1) % numHandles];

    if (!this.editData?.confirmedPathNext) {
      this.setupBaseEditData(previousHandle, element, annotation, nextHandle);
      const { polyline } = data.contour;
      const confirmedPath = new LivewirePath();
      const confirmedPathNext = new LivewirePath();
      const { worldToSlice } = this.editData;
      const previousIndex = findHandlePolylineIndex(
        annotation,
        handleIndex - 1
      );
      const nextIndex = findHandlePolylineIndex(annotation, handleIndex + 1);
      if (nextIndex === -1 || previousIndex === -1) {
        throw new Error(
          `Can't find handle index ${nextIndex === -1 && nextHandle} ${
            previousIndex === -1 && previousHandle
          }`
        );
      }
      if (handleIndex === 0) {
        // For this case, the next/previous indices are swapped, and the
        // path data gets inserted in between the newly generated data, so
        // handle this case specially
        confirmedPathNext.addPoints(
          polyline.slice(nextIndex + 1, previousIndex).map(worldToSlice)
        );
      } else {
        confirmedPath.addPoints(
          polyline.slice(0, previousIndex + 1).map(worldToSlice)
        );
        confirmedPathNext.addPoints(
          polyline.slice(nextIndex, polyline.length).map(worldToSlice)
        );
      }
      this.editData.confirmedPath = confirmedPath;
      this.editData.confirmedPathNext = confirmedPathNext;
    }
    const { editData, scissors } = this;
    const { worldToSlice, sliceToWorld } = editData;

    const { activeHandleIndex } = data.handles;
    if (activeHandleIndex === null || activeHandleIndex === undefined) {
      data.handles.activeHandleIndex = handleIndex;
    } else if (activeHandleIndex !== handleIndex) {
      throw new Error(
        `Trying to edit a different handle than the one currently being edited ${handleIndex}!==${data.handles.activeHandleIndex}`
      );
    }
    const slicePos = worldToSlice(worldPos);
    if (
      slicePos[0] < 0 ||
      slicePos[0] >= scissors.width ||
      slicePos[1] < 0 ||
      slicePos[1] >= scissors.height
    ) {
      // Find path to point hangs if the position is outside the image data
      return;
    }
    handlePoints[handleIndex] = sliceToWorld(slicePos);

    const pathPointsLeft = scissors.findPathToPoint(slicePos);
    const pathPointsRight = this.scissorsNext.findPathToPoint(slicePos);
    const currentPath = new LivewirePath();

    // Merge the "confirmed" path that goes from the first control point to the
    // last one with the current path that goes from the last control point to
    // the cursor point
    currentPath.prependPath(editData.confirmedPath);
    if (handleIndex !== 0) {
      currentPath.addPoints(pathPointsLeft);
    }
    currentPath.addPoints(pathPointsRight.reverse());
    currentPath.appendPath(editData.confirmedPathNext);
    if (handleIndex === 0) {
      currentPath.addPoints(pathPointsLeft);
    }

    // Store the new path
    editData.currentPath = currentPath;

    annotation.invalidated = true;
    editData.hasMoved = true;
    editData.closed = true;
  }

  private _dragCallback = (evt: EventTypes.InteractionEventType): void => {
    this.isDrawing = true;
    const eventDetail = evt.detail;
    const { element } = eventDetail;

    const {
      annotation,
      viewportIdsToRender,
      movingTextBox,
      handleIndex,
      newAnnotation,
    } = this.editData;
    this.createMemo(element, annotation, { newAnnotation });
    const { data } = annotation;

    if (movingTextBox) {
      // Drag mode - moving text box
      const { deltaPoints } = eventDetail as EventTypes.MouseDragEventDetail;
      const worldPosDelta = deltaPoints.world;

      const { textBox } = data.handles;
      const { worldPosition } = textBox;

      worldPosition[0] += worldPosDelta[0];
      worldPosition[1] += worldPosDelta[1];
      worldPosition[2] += worldPosDelta[2];

      textBox.hasMoved = true;
    } else if (handleIndex === undefined) {
      console.warn('Drag annotation not implemented');
    } else {
      // Move mode - after double click, and mouse move to draw
      const { currentPoints } = eventDetail;
      const worldPos = currentPoints.world;
      this.editHandle(worldPos, element, annotation, handleIndex);
    }

    this.editData.hasMoved = true;

    const enabledElement = getEnabledElement(element);
    const { renderingEngine } = enabledElement;

    triggerAnnotationRenderForViewportIds(viewportIdsToRender);
  };

  cancel = (element: HTMLDivElement) => {
    // If it is not in mid-draw or mid-modify
    if (!this.isDrawing) {
      return;
    }

    this.isDrawing = false;
    this._deactivateDraw(element);
    this._deactivateModify(element);
    resetElementCursor(element);

    const { annotation, viewportIdsToRender, newAnnotation } = this.editData;

    if (newAnnotation) {
      removeAnnotation(annotation.annotationUID);
    }

    triggerAnnotationRenderForViewportIds(viewportIdsToRender);

    this.doneEditMemo();
    this.scissors = null;
    return annotation.annotationUID;
  };

  private _activateModify = (element) => {
    state.isInteractingWithTool = true;

    element.addEventListener(Events.MOUSE_UP, this._endCallback);
    element.addEventListener(Events.MOUSE_DRAG, this._dragCallback);
    element.addEventListener(Events.MOUSE_CLICK, this._endCallback);

    element.addEventListener(Events.TOUCH_END, this._endCallback);
    element.addEventListener(Events.TOUCH_DRAG, this._dragCallback);
    element.addEventListener(Events.TOUCH_TAP, this._endCallback);
  };

  private _deactivateModify = (element) => {
    state.isInteractingWithTool = false;

    element.removeEventListener(Events.MOUSE_UP, this._endCallback);
    element.removeEventListener(Events.MOUSE_DRAG, this._dragCallback);
    element.removeEventListener(Events.MOUSE_CLICK, this._endCallback);

    element.removeEventListener(Events.TOUCH_END, this._endCallback);
    element.removeEventListener(Events.TOUCH_DRAG, this._dragCallback);
    element.removeEventListener(Events.TOUCH_TAP, this._endCallback);
  };

  private _activateDraw = (element) => {
    state.isInteractingWithTool = true;

    element.addEventListener(Events.MOUSE_MOVE, this._mouseMoveCallback);
    element.addEventListener(Events.MOUSE_DOWN, this._mouseDownCallback);
    element.addEventListener(
      Events.MOUSE_DOUBLE_CLICK,
      this._mouseDownCallback
    );

    element.addEventListener(Events.TOUCH_TAP, this._mouseDownCallback);
  };

  private _deactivateDraw = (element) => {
    state.isInteractingWithTool = false;

    element.removeEventListener(Events.MOUSE_MOVE, this._mouseMoveCallback);
    element.removeEventListener(Events.MOUSE_DOWN, this._mouseDownCallback);
    element.removeEventListener(
      Events.MOUSE_DOUBLE_CLICK,
      this._mouseDownCallback
    );

    element.removeEventListener(Events.TOUCH_TAP, this._mouseDownCallback);
  };

  public renderAnnotation(
    enabledElement: Types.IEnabledElement,
    svgDrawingHelper: SVGDrawingHelper
  ): boolean {
    // Update the annotation that is in editData (being edited)
    this.updateAnnotation(this.editData?.currentPath);

    return super.renderAnnotation(enabledElement, svgDrawingHelper);
  }

  protected isContourSegmentationTool(): boolean {
    // Disable contour segmentation behavior because it shall be activated only
    // for LivewireContourSegmentationTool
    return false;
  }

  protected createAnnotation(evt: EventTypes.InteractionEventType) {
    const contourSegmentationAnnotation = super.createAnnotation(evt);
    const { world: worldPos } = evt.detail.currentPoints;

    const annotation = <LivewireContourAnnotation>csUtils.deepMerge(
      contourSegmentationAnnotation,
      {
        data: {
          handles: {
            points: [[...worldPos]],
          },
        },
      }
    );
    return annotation;
  }

  /**
   * Clears any in progress edits, mostly used to get rid of accidentally started
   * contours that happen on clicking not quite the right handle point.
   * Eventually this is to be replaced with a proper undo, once that framework
   * is available.
   */
  public cancelInProgress(element, config, evt) {
    if (!this.editData) {
      this.undo();
      return;
    }
    this._endCallback(evt, true);
  }

  /**
   * Render an annotation instance
   * @param renderContext - Render context that contains the annotation, enabledElement, etc.
   * @returns True if the annotation is rendered or false otherwise
   */
  protected renderAnnotationInstance(renderContext: {
    enabledElement: Types.IEnabledElement;
    targetId: string;
    annotation: LivewireContourAnnotation;
    annotationStyle: AnnotationStyle;
    svgDrawingHelper: SVGDrawingHelper;
  }): boolean {
    const {
      annotation,
      enabledElement,
      svgDrawingHelper,
      annotationStyle,
      targetId,
    } = renderContext;

    const { viewport } = enabledElement;
    const { element } = viewport;
    const { worldToCanvas } = viewport;
    const { annotationUID, data, highlighted } = annotation;
    const { handles } = data;
    const newAnnotation = this.editData?.newAnnotation;
    const { lineWidth, lineDash, color } = annotationStyle;

    // Render the first control point only when the annotation is drawn for the
    // first time to make it easier to know where the user needs to click to
    // to close the ROI.
    if (
      highlighted ||
      (newAnnotation &&
        annotation.annotationUID === this.editData?.annotation?.annotationUID)
    ) {
      const handleGroupUID = '0';
      const canvasHandles = handles.points.map(worldToCanvas);

      drawHandlesSvg(
        svgDrawingHelper,
        annotationUID,
        handleGroupUID,
        canvasHandles,
        {
          color,
          lineDash,
          lineWidth,
        }
      );
    }

    // Let the base class render the contour
    super.renderAnnotationInstance(renderContext);

    if (
      !data.cachedStats[targetId] ||
      (data.cachedStats[targetId] as Record<string, unknown>)?.areaUnit === null
    ) {
      data.cachedStats[targetId] = {
        Modality: null,
        area: null,
        areaUnit: null,
      };

      this._calculateCachedStats(annotation, element);
    } else if (annotation.invalidated) {
      this._throttledCalculateCachedStats(annotation, element);
    }

    this._renderStats(
      annotation,
      viewport,
      svgDrawingHelper,
      annotationStyle.textbox
    );

    return true;
  }

  private _calculateCachedStats = (
    annotation: LivewireContourAnnotation,
    element: HTMLDivElement
  ) => {
    if (!this.configuration.calculateStats) {
      return;
    }
    const data = annotation.data;

    if (!data.contour.closed) {
      return;
    }

    const enabledElement = getEnabledElement(element);
    const { viewport, renderingEngine } = enabledElement;
    const { cachedStats } = data;
    const { polyline: points } = data.contour;
    const targetIds = Object.keys(cachedStats);

    for (let i = 0; i < targetIds.length; i++) {
      const targetId = targetIds[i];
      const image = this.getTargetImageData(targetId);

      if (!image) {
        continue;
      }

      const { metadata } = image;
      const canvasCoordinates = points.map((p) => viewport.worldToCanvas(p));

      const canvasPoint = canvasCoordinates[0];
      const originalWorldPoint = viewport.canvasToWorld(canvasPoint);
      const deltaXPoint = viewport.canvasToWorld([
        canvasPoint[0] + 1,
        canvasPoint[1],
      ]);
      const deltaYPoint = viewport.canvasToWorld([
        canvasPoint[0],
        canvasPoint[1] + 1,
      ]);

      const deltaInX = vec3.distance(originalWorldPoint, deltaXPoint);
      const deltaInY = vec3.distance(originalWorldPoint, deltaYPoint);

      const { imageData } = image;
      const { scale, areaUnit } = getCalibratedLengthUnitsAndScale(
        image,
        () => {
          const {
            maxX: canvasMaxX,
            maxY: canvasMaxY,
            minX: canvasMinX,
            minY: canvasMinY,
          } = math.polyline.getAABB(canvasCoordinates);

          const topLeftBBWorld = viewport.canvasToWorld([
            canvasMinX,
            canvasMinY,
          ]);

          const topLeftBBIndex = utilities.transformWorldToIndex(
            imageData,
            topLeftBBWorld
          );

          const bottomRightBBWorld = viewport.canvasToWorld([
            canvasMaxX,
            canvasMaxY,
          ]);

          const bottomRightBBIndex = utilities.transformWorldToIndex(
            imageData,
            bottomRightBBWorld
          );

          return [topLeftBBIndex, bottomRightBBIndex];
        }
      );
      let area = math.polyline.getArea(canvasCoordinates) / scale / scale;

      // Convert from canvas_pixels ^2 to mm^2
      area *= deltaInX * deltaInY;

      cachedStats[targetId] = {
        Modality: metadata.Modality,
        area,
        areaUnit: areaUnit,
      };
    }

    const invalidated = annotation.invalidated;
    annotation.invalidated = false;

    // Dispatching annotation modified only if it was invalidated
    if (invalidated) {
      this.triggerAnnotationModified(
        annotation,
        enabledElement,
        ChangeTypes.StatsUpdated
      );
    }

    return cachedStats;
  };

  private _renderStats = (
    annotation,
    viewport,
    svgDrawingHelper,
    textboxStyle
  ) => {
    const data = annotation.data;
    const targetId = this.getTargetId(viewport);

    if (!data.contour.closed || !textboxStyle.visibility) {
      return;
    }

    const textLines = this.configuration.getTextLines(data, targetId);
    if (!textLines || textLines.length === 0) {
      return;
    }

    const canvasCoordinates = data.handles.points.map((p) =>
      viewport.worldToCanvas(p)
    );
    if (!data.handles.textBox.hasMoved) {
      const canvasTextBoxCoords = getTextBoxCoordsCanvas(canvasCoordinates);

      data.handles.textBox.worldPosition =
        viewport.canvasToWorld(canvasTextBoxCoords);
    }

    const textBoxPosition = viewport.worldToCanvas(
      data.handles.textBox.worldPosition
    );

    const textBoxUID = 'textBox';
    const boundingBox = drawLinkedTextBoxSvg(
      svgDrawingHelper,
      annotation.annotationUID ?? '',
      textBoxUID,
      textLines,
      textBoxPosition,
      canvasCoordinates,
      {},
      textboxStyle
    );

    const { x: left, y: top, width, height } = boundingBox;

    data.handles.textBox.worldBoundingBox = {
      topLeft: viewport.canvasToWorld([left, top]),
      topRight: viewport.canvasToWorld([left + width, top]),
      bottomLeft: viewport.canvasToWorld([left, top + height]),
      bottomRight: viewport.canvasToWorld([left + width, top + height]),
    };
  };

  triggerAnnotationModified = (
    annotation: LivewireContourAnnotation,
    enabledElement: Types.IEnabledElement,
    changeType = ChangeTypes.StatsUpdated
  ): void => {
    const { viewportId, renderingEngineId } = enabledElement;
    const eventType = Events.ANNOTATION_MODIFIED;
    const eventDetail: AnnotationModifiedEventDetail = {
      annotation,
      viewportId,
      renderingEngineId,
      changeType,
    };

    triggerEvent(eventTarget, eventType, eventDetail);
  };

  protected updateAnnotation(livewirePath: LivewirePath) {
    if (!this.editData || !livewirePath) {
      return;
    }

    const { annotation, sliceToWorld, worldToSlice, closed, newAnnotation } =
      this.editData;
    let { pointArray: imagePoints } = livewirePath;

    if (imagePoints.length > 1) {
      imagePoints = [...imagePoints, imagePoints[0]];
    }

    // Save the annotation in clockwise winding direction only after closing it
    // because reversing the handle points may cause some weird issues
    const targetWindingDirection =
      newAnnotation && closed ? ContourWindingDirection.Clockwise : undefined;

    this.updateContourPolyline(
      annotation,
      {
        points: imagePoints,
        closed,
        targetWindingDirection,
      },
      {
        canvasToWorld: sliceToWorld,
        worldToCanvas: worldToSlice,
      }
    );
  }
}

export default LivewireContourTool;

function defaultGetTextLines(data, targetId): string[] {
  const cachedVolumeStats = data.cachedStats[targetId];
  const { area, areaUnit } = cachedVolumeStats;
  const textLines: string[] = [];

  if (area) {
    const areaLine = `Area: ${csUtils.roundNumber(area)} ${areaUnit}`;

    textLines.push(areaLine);
  }

  return textLines;
}
