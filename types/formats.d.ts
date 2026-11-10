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
    format?: 'geojson' | 'topojson' | 'geojson-seq' | 'osm';
    /** Named TopoJSON object(s); omitted selects all objects. */
    object?: string | string[];
    maxFeatures?: number;
    maxCoordinates?: number;
    /** Include untagged OSM nodes that are otherwise only geometry helpers. */
    includeUntaggedNodes?: boolean;
    /** Invalid records/elements throw unless supplied; index starts at one. */
    onError?: (error: Error, recordIndex: number) => void;
  }
  function parse(input: unknown, options?: Options): FeatureCollection;
  function topojson(input: unknown, options?: Options): FeatureCollection;
  function geojsonSeq(input: string, options?: Options): FeatureCollection;
  function osm(input: unknown, options?: Options): FeatureCollection;
}
export = formats;
