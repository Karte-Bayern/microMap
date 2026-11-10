declare namespace formats {
  interface Geometry {
    type: 'Point' | 'MultiPoint' | 'LineString' | 'MultiLineString' | 'Polygon' | 'MultiPolygon' | 'GeometryCollection';
    coordinates?: unknown;
    geometries?: Geometry[];
    [key: string]: unknown;
  }
  interface Feature {
    type: 'Feature';
    id?: string | number;
    properties: Record<string, unknown> | null;
    geometry: Geometry | null;
    [key: string]: unknown;
  }
  interface FeatureCollection {
    type: 'FeatureCollection';
    features: Feature[];
    [key: string]: unknown;
  }
  interface Options {
    format?: 'geojson' | 'topojson' | 'geojson-seq';
    /** Named TopoJSON object(s); omitted selects all objects. */
    object?: string | string[];
    maxFeatures?: number;
    maxCoordinates?: number;
    /** Invalid sequence records throw unless this callback is supplied. */
    onError?: (error: Error, recordIndex: number) => void;
  }
  function parse(input: unknown, options?: Options): FeatureCollection;
  function topojson(input: unknown, options?: Options): FeatureCollection;
  function geojsonSeq(input: string, options?: Options): FeatureCollection;
}
export = formats;
