// Type declarations for @karte.bayern/micromap (core).
// Coordinates are [longitude, latitude]; pixels are [x, y] in the container.

declare namespace microMap {
  type LonLat = [number, number];
  type Point = [number, number];
  /** [west, south, east, north] or two corner coordinates. */
  type BoundsLike = [number, number, number, number] | [LonLat, LonLat];
  type Bounds = [number, number, number, number];
  type TileTemplate = string | ((z: number, x: number, y: number) => string);

  interface PreloadOptions {
    /** Extra tile rings around the viewport (0-8). */
    around?: number;
    /** Relative zoom offsets to warm, e.g. 1 for the next detail level. */
    zoom?: number | number[];
    direction?: { bearing: number; distance?: number; width?: number } | null;
    maxTiles?: number;
    delay?: number;
  }

  interface NavigationState {
    position?: LonLat | null;
    heading?: number | null;
    speed?: number;
    lookAhead?: number;
    follow?: boolean;
  }

  /** Sky and fog above the far row of a tilted view. */
  interface SkyOptions {
    skyColor?: string;
    horizonColor?: string;
    fogColor?: string;
    /** 0-1: height of the fog band. */
    fogBlend?: number;
  }

  interface MenuItem {
    label: string;
    onClick?: (event: Event) => void;
    disabled?: boolean;
    keepOpen?: boolean;
  }

  interface MapOptions {
    /** XYZ raster template, function, or false for a vector/overlay-only map. */
    tiles: TileTemplate | false;
    center?: LonLat;
    zoom?: number;
    minZoom?: number;
    maxZoom?: number;
    /** World size in pixels at zoom 0 (256 for XYZ rasters, 512 for MapLibre zoom levels). */
    tileSize?: number;
    bearing?: number;
    /** Perspective tilt in degrees, up to maxPitch. */
    pitch?: number;
    /** Default 60, at most 85. */
    maxPitch?: number;
    maxBounds?: BoundsLike;
    zoomSnap?: number;
    /** Trusted HTML; never pass unsanitised user input. */
    attribution?: string;
    ariaLabel?: string;
    crossOrigin?: string | null;
    referrerPolicy?: string;
    subdomains?: string;
    tileBuffer?: number;
    preload?: boolean | PreloadOptions;
    dragging?: boolean;
    scrollWheelZoom?: boolean;
    doubleClickZoom?: boolean;
    touchZoom?: boolean;
    keyboard?: boolean;
    inertia?: boolean;
    dragRotate?: boolean;
    pitchWithRotate?: boolean;
    touchRotate?: boolean;
    touchPitch?: boolean;
    bearingSnap?: number;
    zoomAnimation?: boolean;
    contextMenu?: (event: { point: Point; lonLat: LonLat; originalEvent: Event }) => Array<MenuItem | '-'> | null | undefined;
    boxSelect?: boolean;
    boxSelectKey?: 'shiftKey' | 'altKey' | 'ctrlKey' | 'metaKey';
    boxZoom?: boolean;
    navigation?: NavigationState;
    /** false disables the sky overlay. */
    sky?: SkyOptions | false;
  }

  interface CameraState {
    center: LonLat;
    zoom: number;
    minZoom: number;
    maxZoom: number;
    zoomSnap: number;
    bearing: number;
    pitch: number;
    width: number;
    height: number;
    tileSize: number;
    worldSize: number;
    maxPitch: number;
    fov: number;
    cameraDistance: number;
    horizonRow: number;
  }

  interface TileCoordinate { z: number; x: number; y: number; }

  interface CoverOptions {
    tileSize: number;
    zoom: number;
    /** Map centre in world units (0-1). */
    centerX: number;
    centerY: number;
    minZoom: number;
    maxZoom: number;
    buffer?: number;
    maxTiles?: number;
    lodBias?: number;
    minScale?: number;
    /** Include each tile's parent beneath it (default true). */
    underlay?: boolean;
  }

  /**
   * The perspective camera. "Raw" coordinates are map pixels at the current
   * zoom, measured from the map centre before rotation.
   */
  interface Camera {
    readonly width: number;
    readonly height: number;
    readonly pitch: number;
    readonly bearing: number;
    readonly fov: number;
    readonly distance: number;
    readonly sinPitch: number;
    readonly cosPitch: number;
    readonly cosBearing: number;
    readonly sinBearing: number;
    readonly farScale: number;
    /** Screen row above which only sky is drawn (0 when the ground fills the view). */
    readonly horizonRow: number;
    readonly farRow: number;
    /** Raw offset (and altitude in raw pixels) to [x, y, scale]. */
    project(dx: number, dy: number, dz?: number): [number, number, number];
    unproject(x: number, y: number): [number, number];
    /** Where the view ray through a pixel meets the plane at altitude dz; null above its horizon. */
    unprojectAt(x: number, y: number, dz: number): [number, number] | null;
    scaleAtRow(y: number): number;
    rowAtScale(scale: number): number;
    groundBox(minScale?: number): { x0: number; y0: number; x1: number; y1: number };
    cssTransform(): string;
    /** Level-of-detail quadtree cover of the visible ground. */
    cover(options: CoverOptions): TileCoordinate[];
  }

  interface MapEvent {
    type: string;
    target: MicroMap;
    center: LonLat;
    zoom: number;
    bearing: number;
    pitch: number;
    originalEvent?: Event;
    [key: string]: unknown;
  }

  interface PointerMapEvent extends MapEvent {
    point: Point;
    lonLat: LonLat;
  }

  interface Handler {
    enable(): Handler;
    disable(): Handler;
    isEnabled(): boolean;
  }

  interface MarkerHandle {
    element: HTMLElement;
    setLonLat(lonLat: LonLat): MarkerHandle;
    getLonLat(): LonLat;
    remove(): MicroMap;
  }

  interface RouteOptions {
    color?: string;
    width?: number;
    opacity?: number;
    outlineColor?: string;
    outlineWidth?: number;
    outlineOpacity?: number;
    lineCap?: string;
    lineJoin?: string;
    dashArray?: string;
    className?: string;
    zIndex?: number;
  }

  interface RouteHandle {
    element: SVGElement;
    setCoordinates(coordinates: LonLat[]): RouteHandle;
    getCoordinates(): LonLat[];
    setStyle(options: RouteOptions): RouteHandle;
    remove(): MicroMap;
  }

  interface MicroMap {
    dragPan: Handler;
    scrollZoom: Handler;
    doubleClickZoom: Handler;
    keyboard: Handler;
    boxZoom: Handler;
    dragRotate: Handler;
    touchPitch: Handler;
    touchZoomRotate: Handler & { enableRotation(): void; disableRotation(): void; isRotationEnabled(): boolean };

    setView(center: LonLat, zoom?: number): this;
    setCenter(center: LonLat): this;
    setZoom(zoom: number, around?: Point, duration?: number): this;
    setBearing(bearing: number): this;
    setPitch(pitch: number): this;
    fitBounds(bounds: BoundsLike, padding?: number | [number, number]): this;
    setMaxBounds(bounds: BoundsLike | null): this;
    setTiles(tiles: TileTemplate | false, options?: { subdomains?: string; crossOrigin?: string | null; referrerPolicy?: string }): this;
    panBy(offset: Point): this;
    setZoomRange(minZoom?: number | null, maxZoom?: number | null): this;
    setMinZoom(zoom?: number | null): this;
    setMaxZoom(zoom?: number | null): this;
    getMinZoom(): number;
    getMaxZoom(): number;
    setMaxPitch(pitch?: number | null): this;
    getMaxPitch(): number;
    setSky(sky: SkyOptions | false): this;
    getSky(): SkyOptions | false;

    getCenter(): LonLat;
    getZoom(): number;
    getBearing(): number;
    getPitch(): number;
    getBounds(): Bounds;
    getCameraState(): CameraState;
    getCamera(): Camera;
    project(lonLat: LonLat): Point;
    unproject(point: Point): LonLat;
    distanceTo(a: LonLat, b: LonLat): number;
    getContainer(): HTMLElement;

    loaded(): boolean;
    whenIdle(): Promise<MicroMap>;
    resize(): this;
    setPreload(options: boolean | PreloadOptions | null): this;
    preload(options?: boolean | PreloadOptions | null): this;
    getPreload(): PreloadOptions | null;
    setNavigation(state: NavigationState | null): this;
    getNavigation(): NavigationState | null;

    addMarker(lonLat: LonLat, options?: { element?: HTMLElement; className?: string; anchor?: Point; interactive?: boolean }): MarkerHandle | null;
    addRoute(coordinates: LonLat[], options?: RouteOptions): RouteHandle | null;
    openMenu(point: Point, items: Array<MenuItem | '-'>, options?: { className?: string }): { element: HTMLElement; close(): MicroMap } | null;
    closeMenu(): this;
    cancelBoxSelect(): this;

    on(type: string, handler: (event: PointerMapEvent) => void): this;
    once(type: string, handler: (event: PointerMapEvent) => void): this;
    off(type: string, handler?: (event: PointerMapEvent) => void): this;
    destroy(): void;
  }

  interface SearchOptions { keys?: string[]; limit?: number; }
}

declare function microMap(container: string | HTMLElement, options: microMap.MapOptions): microMap.MicroMap;

declare namespace microMap {
  /** Search application-owned records or a FeatureCollection by text. */
  function search<T>(data: T[] | { features: T[] }, query: string, options?: SearchOptions): T[];
  /** The perspective camera used by every map, for add-ons and tests. */
  function createCamera(state: { width: number; height: number; bearing?: number; pitch?: number; fov?: number }): Camera;
  /** MapLibre's vertical field of view in radians. */
  const FOV: number;
}

export = microMap;
