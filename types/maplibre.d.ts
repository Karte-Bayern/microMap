// Type declarations for @karte.bayern/micromap/maplibre: a MapLibre GL JS
// shaped API. Signatures follow MapLibre's where microMap implements them;
// unsupported features (terrain, globe) are accepted and ignored.

import microMap = require('./micromap');

declare namespace maplibre {
  type LngLatLike = LngLat | [number, number] | { lng: number; lat: number } | { lon: number; lat: number };
  type LngLatBoundsLike = LngLatBounds | [LngLatLike, LngLatLike] | [number, number, number, number];
  type PointLike = { x: number; y: number } | [number, number];
  type ControlPosition = 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right';
  type PaddingOptions = number | { top?: number; right?: number; bottom?: number; left?: number };
  type ExpressionSpecification = unknown[];
  type FilterSpecification = unknown[] | boolean;

  interface SourceSpecification {
    type: 'vector' | 'raster' | 'geojson' | 'raster-dem' | 'image' | 'video' | string;
    url?: string;
    tiles?: string[];
    tileSize?: number;
    minzoom?: number;
    maxzoom?: number;
    bounds?: [number, number, number, number];
    scheme?: 'xyz' | 'tms';
    attribution?: string;
    data?: GeoJSON | string;
    cluster?: boolean;
    clusterRadius?: number;
    clusterMaxZoom?: number;
    clusterMinPoints?: number;
    clusterProperties?: Record<string, unknown>;
    promoteId?: string | Record<string, string>;
    [key: string]: unknown;
  }

  interface LayerSpecification {
    id: string;
    type: 'background' | 'fill' | 'line' | 'symbol' | 'circle' | 'fill-extrusion' | 'raster' | 'heatmap' | 'hillshade' | string;
    source?: string;
    'source-layer'?: string;
    minzoom?: number;
    maxzoom?: number;
    filter?: FilterSpecification;
    layout?: Record<string, unknown>;
    paint?: Record<string, unknown>;
    metadata?: unknown;
  }

  interface SkySpecification {
    'sky-color'?: string;
    'horizon-color'?: string;
    'fog-color'?: string;
    'fog-ground-blend'?: number;
    'horizon-fog-blend'?: number;
    'sky-horizon-blend'?: number;
    'atmosphere-blend'?: number;
  }

  interface StyleSpecification {
    version: 8;
    name?: string;
    metadata?: unknown;
    center?: [number, number];
    zoom?: number;
    bearing?: number;
    pitch?: number;
    sources: Record<string, SourceSpecification>;
    sprite?: string | Array<{ id: string; url: string }>;
    glyphs?: string;
    sky?: SkySpecification;
    terrain?: unknown;
    projection?: { type: string };
    light?: unknown;
    layers: LayerSpecification[];
  }

  type GeoJSON = { type: string; [key: string]: unknown };

  interface MapGeoJSONFeature {
    type: 'Feature';
    id?: string | number;
    properties: Record<string, unknown>;
    geometry: { type: string; coordinates: unknown };
    source?: string;
    sourceLayer?: string;
    layer?: { id: string; type: string; 'source-layer'?: string };
    state?: Record<string, unknown>;
  }

  type RequestTransformFunction = (url: string, resourceType: 'Style' | 'Source' | 'Tile' | 'SpriteImage' | 'SpriteJSON' | 'Glyphs' | 'Image' | string) =>
    string | { url: string; headers?: Record<string, string>; credentials?: 'same-origin' | 'include' | 'omit' } | undefined | null;

  interface MapOptions {
    container: string | HTMLElement;
    style?: string | StyleSpecification;
    center?: LngLatLike;
    zoom?: number;
    bearing?: number;
    pitch?: number;
    minZoom?: number;
    maxZoom?: number;
    minPitch?: number;
    /** Default 60, at most 85. */
    maxPitch?: number;
    maxBounds?: LngLatBoundsLike;
    bounds?: LngLatBoundsLike;
    fitBoundsOptions?: FitBoundsOptions;
    interactive?: boolean;
    dragPan?: boolean;
    scrollZoom?: boolean;
    doubleClickZoom?: boolean;
    touchZoomRotate?: boolean;
    touchPitch?: boolean;
    keyboard?: boolean;
    boxZoom?: boolean;
    dragRotate?: boolean;
    pitchWithRotate?: boolean;
    bearingSnap?: number;
    attributionControl?: boolean | { compact?: boolean; customAttribution?: string | string[] };
    hash?: boolean | string;
    transformRequest?: RequestTransformFunction;
    /** Maximum device pixel ratio for rendering (default 2). */
    pixelRatio?: number;
    /** URL of a standalone microMap.vector.js or micromap.min.js for worker decoding. */
    workerUrl?: string;
    worker?: boolean;
    /** Use WebGL for 3D buildings when available (default true). */
    webgl?: boolean;
    /** fetch() replacement for every request. */
    fetch?: typeof fetch;
    ariaLabel?: string;
  }

  interface CameraOptions {
    center?: LngLatLike;
    zoom?: number;
    bearing?: number;
    pitch?: number;
    around?: LngLatLike;
  }

  interface AnimationOptions {
    duration?: number;
    easing?: (t: number) => number;
    animate?: boolean;
    essential?: boolean;
  }

  interface FitBoundsOptions extends AnimationOptions {
    padding?: PaddingOptions;
    maxZoom?: number;
    linear?: boolean;
  }

  interface FlyToOptions extends CameraOptions, AnimationOptions {
    curve?: number;
    speed?: number;
    maxDuration?: number;
  }

  interface MapMouseEvent {
    type: string;
    target: Map;
    point: { x: number; y: number } & [number, number];
    lngLat: { lng: number; lat: number } & [number, number];
    originalEvent?: Event;
    features?: MapGeoJSONFeature[];
  }

  interface MapLibreEvent {
    type: string;
    target: Map;
    [key: string]: unknown;
  }

  interface ErrorEvent extends MapLibreEvent { error: Error; sourceId?: string; }

  interface IControl {
    onAdd(map: Map): HTMLElement;
    onRemove?(map: Map): void;
    getDefaultPosition?(): ControlPosition;
  }

  class Map {
    constructor(options: MapOptions);

    // Style
    setStyle(style: string | StyleSpecification, options?: { transformStyle?: (previous: StyleSpecification | undefined, next: StyleSpecification) => StyleSpecification }): this;
    getStyle(): StyleSpecification;
    isStyleLoaded(): boolean;
    loaded(): boolean;
    areTilesLoaded(): boolean;
    isSourceLoaded(id: string): boolean;
    addSource(id: string, source: SourceSpecification): this;
    getSource(id: string): ({ setData?(data: GeoJSON): unknown; [key: string]: unknown }) | undefined;
    removeSource(id: string): this;
    addLayer(layer: LayerSpecification, beforeId?: string): this;
    getLayer(id: string): LayerSpecification | undefined;
    removeLayer(id: string): this;
    moveLayer(id: string, beforeId?: string): this;
    getLayersOrder(): string[];
    setPaintProperty(layerId: string, name: string, value: unknown): this;
    getPaintProperty(layerId: string, name: string): unknown;
    setLayoutProperty(layerId: string, name: string, value: unknown): this;
    getLayoutProperty(layerId: string, name: string): unknown;
    setFilter(layerId: string, filter?: FilterSpecification | null): this;
    getFilter(layerId: string): FilterSpecification | undefined;
    setLayerZoomRange(layerId: string, minzoom: number, maxzoom: number): this;
    setFeatureState(feature: { source: string; sourceLayer?: string; id: string | number }, state: Record<string, unknown>): this;
    getFeatureState(feature: { source: string; sourceLayer?: string; id: string | number }): Record<string, unknown>;
    removeFeatureState(feature: { source: string; sourceLayer?: string; id?: string | number }, key?: string): this;
    addImage(id: string, image: HTMLImageElement | ImageBitmap | ImageData | { width: number; height: number; data: Uint8Array | Uint8ClampedArray }, options?: { pixelRatio?: number; sdf?: boolean }): this;
    updateImage(id: string, image: unknown): this;
    removeImage(id: string): this;
    hasImage(id: string): boolean;
    listImages(): string[];
    loadImage(url: string): Promise<{ data: HTMLImageElement }>;
    queryRenderedFeatures(point?: PointLike, options?: { layers?: string[]; radius?: number }): MapGeoJSONFeature[];
    querySourceFeatures(sourceId: string, options?: { sourceLayer?: string; filter?: FilterSpecification }): MapGeoJSONFeature[];
    setSky(sky: SkySpecification | null): this;
    getSky(): microMap.SkyOptions | false;
    /** Accepted for compatibility; terrain is not rendered yet. */
    setTerrain(terrain: unknown): this;
    getTerrain(): null;
    setProjection(projection: { type: string }): this;
    getProjection(): { type: 'mercator' };
    setLight(light: unknown): this;

    // Camera
    getCenter(): LngLat;
    setCenter(center: LngLatLike): this;
    getZoom(): number;
    setZoom(zoom: number): this;
    getBearing(): number;
    setBearing(bearing: number): this;
    getPitch(): number;
    setPitch(pitch: number): this;
    getBounds(): LngLatBounds;
    getMaxBounds(): LngLatBounds | null;
    setMaxBounds(bounds?: LngLatBoundsLike | null): this;
    getMinZoom(): number;
    setMinZoom(zoom?: number | null): this;
    getMaxZoom(): number;
    setMaxZoom(zoom?: number | null): this;
    getMinPitch(): number;
    setMinPitch(pitch?: number | null): this;
    getMaxPitch(): number;
    setMaxPitch(pitch?: number | null): this;
    project(lngLat: LngLatLike): { x: number; y: number };
    unproject(point: PointLike): LngLat;
    jumpTo(options: CameraOptions): this;
    easeTo(options: CameraOptions & AnimationOptions): this;
    flyTo(options: FlyToOptions): this;
    panTo(center: LngLatLike, options?: AnimationOptions): this;
    panBy(offset: [number, number]): this;
    zoomTo(zoom: number, options?: AnimationOptions): this;
    zoomIn(options?: AnimationOptions): this;
    zoomOut(options?: AnimationOptions): this;
    rotateTo(bearing: number, options?: AnimationOptions): this;
    resetNorth(options?: AnimationOptions): this;
    resetNorthPitch(options?: AnimationOptions): this;
    snapToNorth(options?: AnimationOptions): this;
    fitBounds(bounds: LngLatBoundsLike, options?: FitBoundsOptions): this;
    cameraForBounds(bounds: LngLatBoundsLike, options?: FitBoundsOptions): { center: [number, number]; zoom: number; bearing: number; pitch: number };
    stop(): this;
    isMoving(): boolean;
    isZooming(): boolean;
    isRotating(): boolean;
    isEasing(): boolean;

    // DOM, controls, lifecycle
    getContainer(): HTMLElement;
    getCanvasContainer(): HTMLElement;
    getCanvas(): HTMLCanvasElement;
    resize(): this;
    triggerRepaint(): this;
    addControl(control: IControl, position?: ControlPosition): this;
    removeControl(control: IControl): this;
    hasControl(control: IControl): boolean;
    getPixelRatio(): number;
    /** The underlying microMap core. */
    getMap(): microMap.MicroMap;
    remove(): void;

    on(type: 'load' | 'idle' | 'style.load' | 'styledata' | 'sourcedata' | 'data' | 'render' | 'remove', listener: (event: MapLibreEvent) => void): this;
    on(type: 'error', listener: (event: ErrorEvent) => void): this;
    on(type: string, listener: (event: MapMouseEvent) => void): this;
    on(type: string, layerId: string, listener: (event: MapMouseEvent) => void): this;
    once(type: string, listener: (event: MapMouseEvent & MapLibreEvent) => void): this;
    once(type: string, layerId: string, listener: (event: MapMouseEvent) => void): this;
    once(type: string): Promise<MapLibreEvent>;
    off(type: string, listener?: (event: never) => void): this;
    off(type: string, layerId: string, listener?: (event: never) => void): this;

    dragPan: microMap.Handler;
    scrollZoom: microMap.Handler;
    doubleClickZoom: microMap.Handler;
    keyboard: microMap.Handler;
    boxZoom: microMap.Handler;
    dragRotate: microMap.Handler;
    touchPitch: microMap.Handler;
    touchZoomRotate: microMap.Handler;
  }

  class LngLat {
    constructor(lng: number, lat: number);
    lng: number;
    lat: number;
    wrap(): LngLat;
    toArray(): [number, number];
    distanceTo(other: LngLatLike): number;
    static convert(input: LngLatLike): LngLat;
  }

  class LngLatBounds {
    constructor(sw?: LngLatLike | [number, number, number, number] | [LngLatLike, LngLatLike], ne?: LngLatLike);
    setSouthWest(value: LngLatLike): this;
    setNorthEast(value: LngLatLike): this;
    extend(value: LngLatLike | LngLatBoundsLike): this;
    getCenter(): LngLat;
    getSouthWest(): LngLat;
    getNorthEast(): LngLat;
    getNorthWest(): LngLat;
    getSouthEast(): LngLat;
    getWest(): number;
    getSouth(): number;
    getEast(): number;
    getNorth(): number;
    toArray(): [[number, number], [number, number]];
    isEmpty(): boolean;
    contains(value: LngLatLike): boolean;
    static convert(input: LngLatBoundsLike): LngLatBounds;
  }

  interface MarkerOptions {
    element?: HTMLElement;
    color?: string;
    scale?: number;
    anchor?: 'center' | 'top' | 'bottom' | 'left' | 'right' | 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right';
    offset?: PointLike;
    draggable?: boolean;
    rotation?: number;
    rotationAlignment?: 'map' | 'viewport' | 'auto';
    className?: string;
    opacity?: number;
    title?: string;
  }

  class Marker {
    constructor(options?: MarkerOptions | HTMLElement);
    setLngLat(lngLat: LngLatLike): this;
    getLngLat(): LngLat;
    addTo(map: Map): this;
    remove(): this;
    getElement(): HTMLElement;
    setPopup(popup?: Popup | null): this;
    getPopup(): Popup | null;
    togglePopup(): this;
    setDraggable(draggable: boolean): this;
    isDraggable(): boolean;
    setOffset(offset: PointLike): this;
    getOffset(): [number, number];
    setRotation(rotation: number): this;
    getRotation(): number;
    setRotationAlignment(alignment: 'map' | 'viewport'): this;
    setOpacity(opacity: number): this;
    on(type: 'dragstart' | 'drag' | 'dragend' | 'click', listener: (event: { type: string; target: Marker }) => void): this;
    off(type: string, listener?: (event: never) => void): this;
  }

  interface PopupOptions {
    closeButton?: boolean;
    closeOnClick?: boolean;
    closeOnMove?: boolean;
    focusAfterOpen?: boolean;
    anchor?: MarkerOptions['anchor'];
    offset?: number | PointLike | Record<string, PointLike>;
    className?: string;
    maxWidth?: string;
  }

  class Popup {
    constructor(options?: PopupOptions);
    setLngLat(lngLat: LngLatLike): this;
    getLngLat(): LngLat;
    setText(text: string): this;
    setHTML(html: string): this;
    setDOMContent(node: Node): this;
    setMaxWidth(maxWidth: string): this;
    getMaxWidth(): string;
    setOffset(offset: PopupOptions['offset']): this;
    addClassName(name: string): this;
    removeClassName(name: string): this;
    toggleClassName(name: string): boolean | this;
    getElement(): HTMLElement;
    addTo(map: Map): this;
    isOpen(): boolean;
    remove(): this;
    on(type: 'open' | 'close', listener: (event: { type: string; target: Popup }) => void): this;
    off(type: string, listener?: (event: never) => void): this;
  }

  class NavigationControl implements IControl {
    constructor(options?: { showCompass?: boolean; showZoom?: boolean; visualizePitch?: boolean });
    onAdd(map: Map): HTMLElement;
    onRemove(map: Map): void;
  }

  class ScaleControl implements IControl {
    constructor(options?: { maxWidth?: number; unit?: 'metric' | 'imperial' | 'nautical' });
    onAdd(map: Map): HTMLElement;
    onRemove(map: Map): void;
    setUnit(unit: 'metric' | 'imperial' | 'nautical'): void;
  }

  class GeolocateControl implements IControl {
    constructor(options?: { positionOptions?: PositionOptions; trackUserLocation?: boolean; showUserLocation?: boolean; showAccuracyCircle?: boolean; fitBoundsOptions?: FitBoundsOptions });
    onAdd(map: Map): HTMLElement;
    onRemove(map: Map): void;
    trigger(): boolean;
  }

  class AttributionControl implements IControl {
    constructor(options?: { compact?: boolean; customAttribution?: string | string[] });
    onAdd(map: Map): HTMLElement;
    onRemove(map: Map): void;
  }

  class FullscreenControl implements IControl {
    constructor(options?: { container?: HTMLElement });
    onAdd(map: Map): HTMLElement;
    onRemove(map: Map): void;
  }

  type ProtocolLoader = (request: { url: string; type: 'json' | 'arrayBuffer' | string; headers?: unknown }, abortController: AbortController | null) =>
    Promise<{ data: unknown } | unknown>;

  const version: string;
  function getVersion(): string;
  function addProtocol(scheme: string, loader: ProtocolLoader): void;
  function removeProtocol(scheme: string): void;
  /** No-ops kept for drop-in compatibility. */
  function setWorkerUrl(url: string): void;
  function getWorkerUrl(): string;
  function setWorkerCount(count: number): void;
  function getWorkerCount(): number;
  function setMaxParallelImageRequests(count: number): void;
  function getMaxParallelImageRequests(): number;
  function setRTLTextPlugin(url: string, lazy?: boolean): Promise<void>;
  function getRTLTextPluginStatus(): string;
  function prewarm(): void;
  function clearPrewarmedResources(): void;
}

export = maplibre;
